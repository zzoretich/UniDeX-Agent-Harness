import { Notice, TFile } from "obsidian";
import type { TAbstractFile } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { RevealTarget, WorkbenchView } from "./WorkbenchView";
import { ConfirmModal } from "../ui/ConfirmModal";
import { readAgenticosJson, sessionHosts, SessionHost, claudeConfigDir as envClaudeConfigDir } from "../data/aosConfig";
import { AgentsCache, AGENTS_PATH, emptyAgents, readAgents, agentsStale, groupAgents, asOf } from "../data/agents";
import { AOS_CLI } from "../data/aosRun";
import { Team, TEAMS_DIR, readTeams, diskAdapter, teamCommand, envPrefix, touchesTeams, gateBadge, gateCards } from "../data/teams";
import { TeamRunner, teamRunner, teamFailure, presetsOf, Presets, ListJson, LIST_ARGS } from "../data/teamWriter";
import { FOLDED_BY_DEFAULT, NodeKey, TreeRow, pickNode, seatsOf, workspaceTree } from "../data/workspace";
import { sanitizeAgentWorkspace, type AgentWorkspaceChoice } from "../settingsDefaults";
import { TeamsCtx, TeamsUiState, Confirm } from "./teams/ui";
import { focusedRow, focusRow, foldTeams, renderTree } from "./workspace/Tree";
import { renderNeeds } from "./workspace/NeedsPane";
import { renderTeamPane, teamView } from "./workspace/TeamPane";
import { formatAgo } from "./RoutinesTab";
import { env, shell } from "../host";

/** While the tab is showing it re-reads every TICK_MS (ages move on) and asks `aos team list` to sweep killed runs,
 *  and name the presets, once SWEEP_EVERY_MS has passed: a dispatcher that died silently is recorded within a minute. */
const TICK_MS = 30_000;
const SWEEP_EVERY_MS = 45_000;
/** A torn tail is an append in flight: read again shortly, a few times at most. */
const TORN_RETRY_MS = 400;
const TORN_RETRIES = 5;
/** A stale agents cache asks for `aos agents sync` at most this often. */
const SYNC_EVERY_MS = 60_000;
const TAB = "agent-teams";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * AGENT WORKSPACE (spec 2026-11-12-agent-workspace-design D1-D5, D13, D16) — one tab for your agents and the teams
 * they sit in, in place of the Agents and Agent Teams tabs. Left, an org tree (workspace/Tree.ts over
 * data/workspace.ts): Needs you, the teams nested by parent with their members, the bench, plugin agents folded. Right,
 * the selected node. It reads persona/teams/ and brain/_index/agents.json itself and writes only through the runtime
 * (`aos team`, `aos agents`), whose file events re-render it; a periodic `aos team list` sweeps runs whose dispatcher
 * died. The rail keeps the id "agent-teams" (D3), and its badge counts pending gates; WorkbenchView keeps it current.
 */
export class AgentWorkspaceTab {
  private host: HTMLElement | null = null;
  private treeHost: HTMLElement | null = null;
  private teams: Team[] = [];
  private loaded = false;
  private agents: AgentsCache = emptyAgents();
  private hosts: SessionHost[] = ["claude"];
  private presets: Presets | null = null;
  private runtimeNote: string | null = null;
  private readError: string | null = null;
  /** The team panes' place in their team (TeamsCtx), for this tab instance only: the view shown (D6, Activity first) and
   *  each team's Activity pages among it. The files are the state. */
  private ui: TeamsUiState = {
    team: null, view: "activity", gateUsd: new Map(), budgetUsd: new Map(), openItem: null, showDone: new Set(), channelItem: null, drafts: new Map(), addPick: new Map(),
    activityPages: new Map(),
  };
  private busyKeys = new Set<string>();
  private errors = new Map<string, string>();
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;
  private tick: number | null = null;
  private tornRetries = 0;
  private sweepAt = 0;
  private sweeping = false;
  private agentsSyncAt = 0;
  private readGen = 0;
  private query = "";
  /** The channel last drawn ("<team>/<item filter>"), so a redraw of the same one keeps the reader's place in it. */
  private channelKey: string | null = null;
  /** Sections toggled away from their default, and folded teams (workspaceTree, foldTeams). */
  private folded = new Set<NodeKey>();
  private selected: NodeKey | null = null;
  /** How the tab was last brought up (D5), to settle once the files are read: a rail click (setTab) shows the saved
   *  node; a link (open) shows the node it names, else Needs you while a gate is pending. */
  private want: { via: "rail" | "link"; asked: NodeKey | null } | null = null;

  constructor(private plugin: AgenticOSPlugin, private wb: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const hit = (p: string) => touchesTeams(p) || p === AGENTS_PATH;
      const watch = (f: TAbstractFile, oldPath?: string) => { if (hit(f.path) || (oldPath !== undefined && hit(oldPath))) this.schedule(); };
      const vault = this.plugin.app.vault;
      this.wb.registerEvent(vault.on("modify", (f) => watch(f)));
      this.wb.registerEvent(vault.on("create", (f) => watch(f)));
      this.wb.registerEvent(vault.on("delete", (f) => watch(f)));
      this.wb.registerEvent(vault.on("rename", (f, oldPath) => watch(f, oldPath)));
    }
    if (this.tick === null) this.tick = window.setInterval(() => { if (this.wb.isTabActive(TAB)) void this.refresh(); }, TICK_MS);
    // setTab refreshes the tab right after mounting it.
    this.want = { via: "rail", asked: null };
  }

  unmount(): void {
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
    if (this.tick !== null) { window.clearInterval(this.tick); this.tick = null; }
  }

  /** Another tab is shown: the next visit settles its own node. */
  leave(): void { this.want = null; }

  /** What open() hands the tab after mounting it (D5): the node a link or Pulse names, or none. */
  reveal(t: RevealTarget): void {
    this.want = { via: "link", asked: t.node ?? null };
    if (this.loaded) this.render();
  }

  /** Shows a node and remembers it (settings.agentWorkspace.node). */
  select(node: NodeKey): void {
    this.setSelected(node, true);
    this.render();
  }

  private schedule(ms = 250): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => { this.refreshDebounce = null; void this.refresh(); }, ms);
  }

  async refresh(): Promise<void> {
    // Reads overlap (mount, file events, actions, the clock): only the newest one's result is applied, so a read that
    // started before a gate was approved can never bring the pending card back.
    const gen = ++this.readGen;
    const seq = this.wb.nextTeamsRead();
    let teams: Team[] | null = null;
    let err: string | null = null;
    try { teams = await readTeams(diskAdapter(this.plugin.vaultRoot())); } catch (e) { err = `${TEAMS_DIR} could not be read: ${e instanceof Error ? e.message : String(e)}`; }
    if (gen !== this.readGen) return;
    if (teams) this.teams = teams;
    this.readError = err;
    this.agents = readAgents(this.plugin.vaultRoot());
    this.hosts = sessionHosts(readAgenticosJson(this.plugin.claudeConfigDir()));
    this.loaded = true;
    if (teams) this.wb.setTeamsBadge(gateBadge(teams), seq);
    if (this.teams.some((t) => t.torn)) { if (this.tornRetries++ < TORN_RETRIES) this.schedule(TORN_RETRY_MS); } else this.tornRetries = 0;
    // The runtime is asked for anything only while the tab is shown: the agents list when it is old (at most once a
    // minute; its file event re-reads it), and the sweep.
    if (this.wb.isTabActive(TAB)) {
      if (agentsStale(this.agents) && Date.now() - this.agentsSyncAt > SYNC_EVERY_MS) this.syncAgents();
      if (this.teams.length && Date.now() - this.sweepAt > SWEEP_EVERY_MS) void this.sweep();
    }
    this.render();
  }

  // ── the runtime (every write spawns it; its file events re-render) ──

  private syncAgents(): void {
    this.agentsSyncAt = Date.now();
    this.plugin.runBrainScript(AOS_CLI, ["agents", "sync"], () => this.schedule(), {
      env: { AOS_VAULT: this.plugin.vaultRoot(), AOS_CONFIG: path.join(this.plugin.claudeConfigDir(), "agenticos.json"), CLAUDE_CONFIG_DIR: this.plugin.claudeConfigDir() },
    });
  }

  private runner(): TeamRunner {
    const configDir = this.plugin.claudeConfigDir();
    // CLAUDE_CONFIG_DIR: `member add` finds agents in the folder this plugin is set to, not only the default one.
    return teamRunner({ node: this.plugin.nodeBin(), vault: this.plugin.vaultRoot(), configDir, env: { CLAUDE_CONFIG_DIR: configDir } });
  }

  /** `aos team list --json`: records any killed run (its file events re-render) and names the presets the seats offer. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    this.sweepAt = Date.now();
    try {
      const r = await this.runner().json<ListJson>(LIST_ARGS);
      if (r.json) {
        this.presets = presetsOf(r.json);
        this.runtimeNote = null;
      } else {
        const f = teamFailure(r);
        this.runtimeNote = f.upgrade ? f.text : `aos team list failed: ${f.text}`;
      }
    } finally { this.sweeping = false; }
    this.schedule();   // re-read what the sweep recorded, without waiting for its file events
  }

  private async act(key: string, args: string[], confirm?: Confirm): Promise<boolean> {
    if (this.busyKeys.has(key)) return false;
    if (confirm && !(await ConfirmModal.ask(this.plugin.app, confirm.title, confirm.message, confirm.cta))) return false;
    this.busyKeys.add(key);
    this.errors.delete(key);
    this.render();
    let ok = false;
    try {
      const r = await this.runner().run(args);
      ok = r.code === 0;
      if (ok) { const line = r.stdout.trim().split("\n")[0]; if (line) new Notice(line); } else this.errors.set(key, teamFailure(r).text);
    } finally { this.busyKeys.delete(key); }
    await this.refresh();   // the vault event may lag the CLI's exit
    return ok;
  }

  /** No terminal session could start. A lead's next step or a redirect must not be lost after its decision is recorded,
   *  so the command goes to the clipboard and a notice that stays until dismissed names it. */
  private noTerminal(cmd: string): void {
    const say = (copied: boolean) => new Notice(`No terminal could start, so this did not run. Run it in a terminal${copied ? " (it is on the clipboard)" : ""}:\n${cmd}`, 0);
    const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clip) { say(false); return; }
    clip.writeText(cmd).then(() => say(true), () => say(false));
  }

  /** A vault-relative file of the teams' vault: in Obsidian when that is the open vault, else with the system's app. */
  private openFile(p: string): void {
    const base = (this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
    const f = base && path.resolve(base) === path.resolve(this.plugin.vaultRoot()) ? this.plugin.app.vault.getAbstractFileByPath(p) : null;
    if (f instanceof TFile) { void this.plugin.app.workspace.getLeaf("tab").openFile(f); return; }
    const abs = path.join(this.plugin.vaultRoot(), p);
    try {
      void shell.openPath(abs).then((err: string) => { if (err) new Notice(`Cannot open ${abs}: ${err}`); });
    } catch { new Notice(`Cannot open ${abs}`); }
  }

  /** The folder each host's session should use, as the runtime resolves it (lib/host.js), set on the command only when
   *  a new terminal would find another. */
  private hostEnv(): Record<SessionHost, string> {
    const envCodex = path.resolve(env.get("CODEX_HOME") || path.join(env.homedir(), ".codex"));
    const cfgCodex = readAgenticosJson(this.plugin.claudeConfigDir())?.hosts?.codex?.home;
    return {
      claude: envPrefix("CLAUDE_CONFIG_DIR", this.plugin.claudeConfigDir(), envClaudeConfigDir()),
      codex: envPrefix("CODEX_HOME", cfgCodex || envCodex, envCodex),
    };
  }

  /** What a team pane is handed (teams/ui.ts): the tab's state, its runtime calls and how to select. */
  private ctx(team: Team): TeamsCtx {
    return {
      app: this.plugin.app, teams: this.teams, team, agents: this.agents, hosts: this.hosts, presets: this.presets, now: new Date(), ui: this.ui,
      teamCmd: teamCommand(this.plugin.vaultRoot(), this.plugin.nodeBin()),
      hostEnv: this.hostEnv(),
      busy: (k) => this.busyKeys.has(k), error: (k) => this.errors.get(k) ?? null,
      act: (k, args, confirm) => this.act(k, args, confirm),
      term: (cmd, host) => { if (!this.wb.runInTerm(cmd, { host: host ?? "shell", origin: "Agent Workspace" })) this.noTerminal(cmd); },
      render: () => this.render(),
      select: (id, view, item) => {
        this.setSelected(`team:${id}`, true);
        if (view) this.ui.view = teamView(view);
        if (item !== undefined) this.ui.openItem = item;
        this.render();
        // A link that names an item (a gate card's id) opens its detail under the Items list: bring it into view.
        if (item) this.host?.querySelector<HTMLElement>(".aos-aw-pane .aos-at-detail")?.scrollIntoView({ block: "nearest" });
      },
      openFile: (p) => this.openFile(p),
    };
  }

  // ── selection ──

  private choice(): AgentWorkspaceChoice { return sanitizeAgentWorkspace(this.plugin.settings.agentWorkspace); }

  /** Items as a list or a board (D8), remembered in settings.agentWorkspace.items for every team. */
  private setItemsMode(items: AgentWorkspaceChoice["items"]): void {
    if (this.choice().items !== items) {
      this.plugin.settings.agentWorkspace = { ...this.choice(), items };
      void this.plugin.saveSettings();
    }
    this.render();
  }

  private setSelected(node: NodeKey, remember: boolean): void {
    if (node.startsWith("team:")) {
      const id = node.slice("team:".length);
      if (id !== this.ui.team) { this.ui.channelItem = null; this.ui.openItem = null; }
      this.ui.team = id;
    }
    this.selected = node;
    if (remember && this.choice().node !== node) {
      this.plugin.settings.agentWorkspace = { ...this.choice(), node };
      void this.plugin.saveSettings();
    }
  }

  /** Every node there is, every section open: what a saved or named node is looked up in (a fold only hides a row). */
  private wholeTree(): TreeRow[] { return workspaceTree(this.teams, this.agents, { query: "", folded: FOLDED_BY_DEFAULT }); }

  private isFolded(r: TreeRow): boolean {
    return r.kind === "section" ? FOLDED_BY_DEFAULT.has(r.key) !== this.folded.has(r.key) : this.folded.has(r.key);
  }

  private toggleFold(key: NodeKey): void {
    if (this.folded.has(key)) this.folded.delete(key); else this.folded.add(key);
  }

  /** Opens every section and team the node sits under, and drops a filter that hides it, so a named node is in view
   *  (a plugin agent's section starts folded). */
  private unfoldTo(key: NodeKey, whole: TreeRow[]): void {
    const i = whole.findIndex((r) => r.key === key);
    if (i < 0) return;
    let depth = whole[i].depth;
    for (let j = i - 1; j >= 0 && depth > 0; j--) {
      const r = whole[j];
      if (r.depth >= depth) continue;
      depth = r.depth;
      if (this.isFolded(r)) this.toggleFold(r.key);
    }
    if (this.query && !workspaceTree(this.teams, this.agents, { query: this.query, folded: this.folded }).some((r) => r.key === key)) this.query = "";
  }

  /** Settles which node shows (pickNode): once per visit, and again when the shown node is gone from the files. Showing
   *  a node is not picking it (D5, §4.2): only the node a link or Pulse names is remembered, as a click in the tree is.
   *  A link's Needs you, the first visit's default and a stand-in for a node that is gone show without being saved, so
   *  the next rail click still shows the user's own pick. */
  private settle(): void {
    const whole = this.wholeTree();
    const gates = gateCards(this.teams).length;
    const want = this.want;
    if (want) {
      this.want = null;
      if (want.asked) this.unfoldTo(want.asked, whole);
      const node = pickNode({ saved: this.choice().node, via: want.via, asked: want.asked, gates, tree: whole });
      this.setSelected(node, !!want.asked && node === want.asked);
    } else if (!this.selected || !whole.some((r) => r.key === this.selected)) {
      // The saved node may come back with the next read (a cache being rewritten).
      this.setSelected(pickNode({ saved: this.choice().node, via: "rail", asked: null, gates, tree: whole }), false);
    }
  }

  // ── render ──

  private render(): void {
    if (!this.wb.isTabActive(TAB)) return;
    const host = this.host;
    if (!host) return;
    // A redraw (a sync landing, a clock tick, a selection) keeps the filter's focus and caret, the row that has the
    // keyboard, and where the tree and the pane were scrolled to.
    const was = host.querySelector<HTMLInputElement>("input.aos-aw-filter");
    const caret = was && document.activeElement === was ? { start: was.selectionStart, end: was.selectionEnd } : null;
    const rowFocus = this.treeHost && host.contains(this.treeHost) ? focusedRow(this.treeHost) : null;
    const treeTop = this.treeHost?.scrollTop ?? 0;
    const oldPane = host.querySelector<HTMLElement>(".aos-aw-pane");
    const paneWas = oldPane ? { node: oldPane.dataset.node, top: oldPane.scrollTop } : null;
    // A control in the pane that had the keyboard (a view tab, an item row, "older") names itself with data-focus, to get
    // it back; an unsent message to the lead keeps its focus and caret.
    const active = host.ownerDocument.activeElement;
    const paneFocus = oldPane && active instanceof HTMLElement && oldPane.contains(active) ? active.closest<HTMLElement>("[data-focus]")?.dataset.focus ?? null : null;
    const typing = oldPane && active instanceof HTMLTextAreaElement && active.classList.contains("aos-at-msg") && oldPane.contains(active) ? { start: active.selectionStart, end: active.selectionEnd } : null;
    // The channel follows new posts only when the reader is already at its end; reading further up, it stays put.
    const ch = oldPane?.querySelector<HTMLElement>(".aos-at-channel") ?? null;
    const chKey = `${this.ui.team ?? ""}/${this.ui.channelItem ?? ""}`;
    const follow = !ch || this.channelKey !== chKey || ch.scrollHeight - ch.scrollTop - ch.clientHeight < 24;
    const chTop = ch?.scrollTop ?? 0;
    host.empty();
    this.treeHost = null;
    if (this.loaded) this.settle();

    const root = host.createDiv({ cls: "aos-aw" });
    this.renderHead(root);
    if (!this.loaded) return;

    const body = root.createDiv({ cls: "aos-aw-body" });
    const side = body.createEl("nav", { cls: "aos-aw-side", attr: { "aria-label": "Agent Workspace" } });
    const filter = side.createEl("input", { cls: "aos-aw-filter", attr: { type: "search", placeholder: "filter teams and agents…", "aria-label": "Filter teams and agents" } });
    filter.value = this.query;
    filter.addEventListener("input", () => { this.query = filter.value; this.drawTree(); });
    // ↓ from the filter goes into the tree.
    filter.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown") return;
      const first = this.treeHost?.querySelector<HTMLElement>(".aos-aw-row[tabindex]");
      if (first) { e.preventDefault(); first.focus(); }
    });
    this.treeHost = side.createDiv({ cls: "aos-aw-tree", attr: { "aria-label": "Teams and agents", "data-tour": "agent-workspace-tree" } });
    this.drawTree();

    const node = this.selected ?? "needs";
    const pane = body.createEl("section", { cls: "aos-aw-pane", attr: { "data-node": node } });
    this.renderPane(pane, node);

    this.treeHost.scrollTop = treeTop;
    if (paneWas && paneWas.node === node) pane.scrollTop = paneWas.top;
    const ch2 = pane.querySelector<HTMLElement>(".aos-at-channel");
    if (ch2) ch2.scrollTop = follow ? ch2.scrollHeight : chTop;
    this.channelKey = ch2 ? chKey : null;
    const box = typing && paneWas?.node === node ? pane.querySelector<HTMLTextAreaElement>("textarea.aos-at-msg") : null;
    if (caret) { filter.focus({ preventScroll: true }); filter.setSelectionRange(caret.start, caret.end); }
    else if (rowFocus) focusRow(this.treeHost, rowFocus);
    else if (box && typing && !box.disabled) { box.focus({ preventScroll: true }); box.setSelectionRange(typing.start, typing.end); }
    else if (paneFocus && paneWas?.node === node) {
      Array.from(pane.querySelectorAll<HTMLElement>("[data-focus]")).find((e) => e.dataset.focus === paneFocus)?.focus({ preventScroll: true });
    }
  }

  /** The header (D13): what there is, the sharing state, sync now and + New team, and what is wrong. */
  private renderHead(root: HTMLElement): void {
    const head = root.createDiv({ cls: "aos-aw-head", attr: { "data-tour": "agent-workspace-head" } });
    head.createSpan({ cls: "aos-aw-title", text: "Agent Workspace" });
    if (this.loaded) {
      const yours = groupAgents(this.agents.agents).yours.length;
      const running = this.teams.reduce((n, t) => n + (t.error ? 0 : t.live.length), 0);
      const gates = gateCards(this.teams).length;
      head.createSpan({ cls: "aos-aw-counts", text: [plural(yours, "agent"), plural(this.teams.length, "team"), `${running} running`, plural(gates, "gate")].join(" · ") });
      const at = asOf(this.agents);
      const sharing = this.agents.sync.on
        ? { text: `sharing on${at ? ` · as of ${formatAgo(at)}` : ""}`, title: "Each host's agents are copied into the other at the end of every session" }
        : this.agents.scannedAt
          ? { text: `sharing off — ${this.agents.sync.reason ?? "see aos agents"}`, title: "Each host keeps its own agents" }
          : { text: "not scanned yet — sync now builds the list", title: "" };
      head.createSpan({ cls: "aos-aw-sharing", text: sharing.text, attr: sharing.title ? { title: sharing.title, "data-tour": "agent-workspace-sharing" } : { "data-tour": "agent-workspace-sharing" } });
    }
    const acts = head.createDiv({ cls: "aos-aw-actions" });
    const sync = acts.createEl("button", { cls: "aos-aw-btn aos-aw-sync", text: "sync now", attr: { type: "button", "data-tour": "agent-workspace-sync", title: "aos agents sync: share each host's agents with the other and refresh this list" } });
    sync.addEventListener("click", () => this.syncAgents());
    // + New team (D14): its dialog is wired in a later step; the button holds its place.
    acts.createEl("button", { cls: "aos-aw-btn aos-aw-primary aos-aw-new", text: "+ New team", attr: { type: "button", title: "Make a team with a lead you pick" } });

    if (this.loaded && !this.agents.codexAgents.on && this.hosts.includes("codex")) {
      root.createDiv({ cls: "aos-aw-note is-warn", text: `${this.agents.codexAgents.reason ?? "Codex subagents are off"} — Codex will not spawn these agents until it is on` });
    }
    if (this.runtimeNote) root.createDiv({ cls: "aos-aw-note is-warn", text: this.runtimeNote });
    if (this.readError) root.createDiv({ cls: "aos-aw-note is-error", text: `${this.readError}. The teams below are as last read.` });
  }

  private drawTree(): void {
    const host = this.treeHost;
    if (!host) return;
    const rows = foldTeams(workspaceTree(this.teams, this.agents, { query: this.query, folded: this.folded }), this.folded, this.query);
    renderTree(host, rows, {
      selected: this.selected ?? "",
      onSelect: (k) => this.select(k),
      onFold: (k) => { this.toggleFold(k); this.drawTree(); },
      describe: (r) => {
        const t = r.kind === "team" ? this.teams.find((x) => `team:${x.id}` === r.key) : undefined;
        return t?.error ? `${t.errorFile ?? "TEAM.md"}: ${t.error}` : null;
      },
    });
  }

  /** The selected node: Needs you and a team have their panes (D5, D6; a team's Items, Channel and Settings, D8-D10); an
   *  agent's profile comes with its pane, until then a title and what the files say. */
  private renderPane(pane: HTMLElement, node: NodeKey): void {
    const title = (text: string) => pane.createEl("h2", { cls: "aos-aw-panetitle", text });
    const line = (text: string, cls = "aos-aw-paneline") => pane.createDiv({ cls, text });
    if (node === "needs") {
      renderNeeds(pane, (t) => this.ctx(t), this.teams);
      return;
    }
    if (node.startsWith("team:")) {
      const t = this.teams.find((x) => x.id === node.slice("team:".length));
      if (t) renderTeamPane(pane, this.ctx(t), this.ui.view, (v) => { this.ui.view = v; this.render(); }, { mode: this.choice().items, onMode: (m) => this.setItemsMode(m) });
      return;
    }
    if (node.startsWith("agent:")) {
      const a = this.agents.agents.find((x) => x.id === node.slice("agent:".length));
      if (!a) return;
      pane.setAttr("aria-label", a.name);
      title(a.name);
      if (a.description) line(a.description);
      const seats = seatsOf(this.teams, a.id);
      const yours = groupAgents([a]).yours.length > 0;
      line(seats.length ? `Seated in ${seats.map((s) => s.team.name || s.team.id).join(", ")}` : yours ? "On the bench: seated in no team" : `Listed from ${a.origin.plugin ?? "Codex's config.toml"}`, "aos-aw-paneline aos-aw-dim");
      return;
    }
    if (node.startsWith("member:")) {
      const [teamId, memberId] = node.slice("member:".length).split("/");
      const t = this.teams.find((x) => x.id === teamId);
      const m = t?.members.find((x) => x.id === memberId);
      if (!t || !m) return;
      pane.setAttr("aria-label", m.name || m.id);
      title(m.name || m.id);
      line(`${t.name || t.id} · ${m.role || "member"} · no agent: ${m.agent ? `${m.agent} is not one of your agents` : "its seat names none"}`, "aos-aw-paneline aos-aw-dim");
    }
  }
}
