import { Notice, TFile } from "obsidian";
import type { TAbstractFile } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { ConfirmModal } from "../ui/ConfirmModal";
import { readAgenticosJson, sessionHosts, invocationHint, SessionHost, claudeConfigDir as envClaudeConfigDir } from "../data/aosConfig";
import { AgentsCache, AGENTS_PATH, emptyAgents, readAgents, agentsStale } from "../data/agents";
import { AOS_CLI } from "../data/aosRun";
import { Team, TEAMS_DIR, readTeams, diskAdapter, teamCommand, envPrefix, touchesTeams, gateBadge, gateCards, orderTeams, pendingGates, boardColumns } from "../data/teams";
import { TeamRunner, teamRunner, teamFailure, presetsOf, Presets, ListJson, LIST_ARGS, INIT_ARGS, pauseArgs } from "../data/teamWriter";
import { TeamsCtx, TeamsUiState, TeamsView, Confirm, VIEWS, errorLine } from "./teams/ui";
import { renderBoard, renderGateCard } from "./teams/BoardPane";
import { renderRoster } from "./teams/RosterPane";
import { renderInteract } from "./teams/InteractPane";
import { renderManage } from "./teams/ManagePane";
import { env, shell } from "../host";

/** While the tab is showing it re-reads every TICK_MS (ages move on) and asks `aos team list` to sweep killed runs,
 *  and name the presets, once SWEEP_EVERY_MS has passed: a dispatcher that died silently is recorded within a minute. */
const TICK_MS = 30_000;
const SWEEP_EVERY_MS = 45_000;
/** A torn tail is an append in flight: read again shortly, a few times at most. */
const TORN_RETRY_MS = 400;
const TORN_RETRIES = 5;

/**
 * AGENT TEAMS — the vault's agent teams (spec 2026-09-28-agent-teams-design §4.4, D12): gates waiting on the user across
 * every team first ("Needs you"), then one team at a time as a Work board, Roster, Interact and Manage. The tab reads
 * persona/teams/ itself (src/data/teams.ts, by lib/teams.js's rules) and writes only through `aos team` (teamWriter.ts),
 * whose file events re-render it. A periodic `aos team list` sweeps runs whose dispatcher died, so a stale marker
 * does not show a member working forever. The rail badge counts pending gates; WorkbenchView keeps it current.
 */
export class AgentTeamsTab {
  private host: HTMLElement | null = null;
  private teams: Team[] = [];
  private loaded = false;
  private agents: AgentsCache = emptyAgents();
  private hosts: SessionHost[] = ["claude"];
  private presets: Presets | null = null;
  private runtimeNote: string | null = null;
  private readError: string | null = null;
  private ui: TeamsUiState = {
    team: null, view: "board", gateUsd: new Map(), budgetUsd: new Map(), openItem: null, showDone: new Set(), channelItem: null, drafts: new Map(), addPick: new Map(),
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
  private channelKey: string | null = null;
  private refocus: { sel: string; index: number } | null = null;

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
    if (this.tick === null) this.tick = window.setInterval(() => { if (this.wb.isTabActive("agent-teams")) void this.refresh(); }, TICK_MS);
    void this.refresh();
  }

  unmount(): void {
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
    if (this.tick !== null) { window.clearInterval(this.tick); this.tick = null; }
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
    // Talk, Redirect and Add a member read the agents list; ask for a fresh one when it is old, as the Agents tab does,
    // at most once a minute. Its file event re-reads it.
    if (agentsStale(this.agents) && Date.now() - this.agentsSyncAt > 60_000) {
      this.agentsSyncAt = Date.now();
      this.plugin.runBrainScript(AOS_CLI, ["agents", "sync"], () => this.schedule(), {
        env: { AOS_VAULT: this.plugin.vaultRoot(), AOS_CONFIG: path.join(this.plugin.claudeConfigDir(), "agenticos.json"), CLAUDE_CONFIG_DIR: this.plugin.claudeConfigDir() },
      });
    }
    this.hosts = sessionHosts(readAgenticosJson(this.plugin.claudeConfigDir()));
    this.loaded = true;
    if (teams) this.wb.setTeamsBadge(gateBadge(teams), seq);
    if (this.teams.some((t) => t.torn)) { if (this.tornRetries++ < TORN_RETRIES) this.schedule(TORN_RETRY_MS); } else this.tornRetries = 0;
    if (this.teams.length && Date.now() - this.sweepAt > SWEEP_EVERY_MS) void this.sweep();
    this.render();
  }

  private runner(): TeamRunner {
    const configDir = this.plugin.claudeConfigDir();
    // CLAUDE_CONFIG_DIR: `member add` finds agents in the folder this plugin is set to, not only the default one.
    return teamRunner({ node: this.plugin.nodeBin(), vault: this.plugin.vaultRoot(), configDir, env: { CLAUDE_CONFIG_DIR: configDir } });
  }

  /** `aos team list --json`: records any killed run (its file events re-render) and names the presets Manage offers. */
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

  private ctx(team: Team): TeamsCtx {
    return {
      app: this.plugin.app, teams: this.teams, team, agents: this.agents, hosts: this.hosts, presets: this.presets, now: new Date(), ui: this.ui,
      teamCmd: teamCommand(this.plugin.vaultRoot(), this.plugin.nodeBin()),
      hostEnv: this.hostEnv(),
      busy: (k) => this.busyKeys.has(k), error: (k) => this.errors.get(k) ?? null,
      act: (k, args, confirm) => this.act(k, args, confirm),
      term: (cmd, host) => { if (!this.wb.runInTerm(cmd, { host: host ?? "shell", origin: "Agent Teams" })) this.noTerminal(cmd); },
      render: () => this.render(),
      select: (id, view, item) => {
        if (id !== this.ui.team) { this.ui.channelItem = null; this.ui.openItem = null; }
        this.ui.team = id;
        if (view) this.ui.view = view;
        if (item !== undefined) this.ui.openItem = item;
        this.render();
      },
      openFile: (p) => this.openFile(p),
    };
  }

  // ── render ──

  private render(): void {
    if (!this.wb.isTabActive("agent-teams")) return;
    const host = this.host;
    if (!host) return;
    // A re-render (a post landing, a clock tick) keeps the scroll position and an unsent message's focus and caret.
    const scroller = this.wb.getContentHost();
    const top = scroller?.scrollTop ?? 0;
    const active = document.activeElement;
    const typing = active instanceof HTMLTextAreaElement && active.classList.contains("aos-at-msg") ? { start: active.selectionStart, end: active.selectionEnd } : null;
    // The channel follows new posts only when the reader is already at its end; reading further up, it stays put.
    const ch = host.querySelector<HTMLElement>(".aos-at-channel");
    const chKey = `${this.ui.team ?? ""}/${this.ui.channelItem ?? ""}`;
    const follow = !ch || this.channelKey !== chKey || ch.scrollHeight - ch.scrollTop - ch.clientHeight < 24;
    const chTop = ch?.scrollTop ?? 0;
    host.empty();
    host.addClass("aos-at");

    const cards = gateCards(this.teams);
    const head = host.createDiv({ cls: "aos-rt-head", attr: { "data-tour": "agent-teams-head" } });
    head.createSpan({ cls: "aos-rt-title", text: "Agent teams" });
    if (this.teams.length) head.createSpan({ cls: "aos-dim aos-rt-count", text: `${cards.length} gate${cards.length === 1 ? "" : "s"} waiting · ${this.teams.length} team${this.teams.length === 1 ? "" : "s"}` });
    if (this.runtimeNote) host.createDiv({ cls: "aos-rt-banner", text: this.runtimeNote });
    if (this.readError) host.createDiv({ cls: "aos-st-failure", text: `${this.readError}. The teams below are as last read.` });

    if (!this.loaded) return;
    if (!this.teams.length) { this.renderEmpty(host); return; }

    if (cards.length) {
      const needs = host.createEl("section", { cls: "aos-at-needs", attr: { "aria-label": "Gates waiting on you" } });
      needs.createDiv({ cls: "aos-at-needshead", text: `NEEDS YOU · ${cards.length}` });
      for (const c of cards) renderGateCard(needs, this.ctx(c.team), c, { showTeam: this.teams.length > 1 });
    }

    const order = orderTeams(this.teams);
    if (!this.teams.some((t) => t.id === this.ui.team)) this.ui.team = (order.find((x) => !x.team.error) ?? order[0]).team.id;
    const team = this.teams.find((t) => t.id === this.ui.team)!;
    if (this.teams.length > 1) this.renderTeamChips(host, order);
    this.renderTeam(host, team);

    if (scroller) scroller.scrollTop = top;
    const ch2 = host.querySelector<HTMLElement>(".aos-at-channel");
    if (ch2) ch2.scrollTop = follow ? ch2.scrollHeight : chTop;
    this.channelKey = ch2 ? chKey : null;
    if (this.refocus) {
      host.querySelectorAll<HTMLElement>(this.refocus.sel)[this.refocus.index]?.focus();
      this.refocus = null;
    }
    if (typing) {
      const box = host.querySelector<HTMLTextAreaElement>("textarea.aos-at-msg");
      if (box && !box.disabled) { box.focus(); box.setSelectionRange(typing.start, typing.end); }
    }
  }

  private renderTeamChips(host: HTMLElement, order: { team: Team; depth: number }[]): void {
    const bar = host.createDiv({ cls: "aos-at-teams", attr: { role: "tablist", "aria-label": "Teams" } });
    for (const { team: t, depth } of order) {
      const on = t.id === this.ui.team;
      const b = bar.createEl("button", { cls: `aos-at-teamchip${on ? " is-active" : ""}${t.disabled ? " is-paused" : ""}${t.error ? " is-broken" : ""}`, attr: { role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1", title: t.error ? `${t.errorFile ?? "TEAM.md"}: ${t.error}` : `${t.name}: lead ${t.lead}${t.disabled ? ", paused" : ""}` } });
      if (depth) b.createSpan({ cls: "aos-at-depth", text: "› ".repeat(depth) });
      b.createSpan({ text: t.name });
      const g = t.error ? 0 : pendingGates(t).length;
      if (g) b.createSpan({ cls: "aos-at-chipcount", text: String(g), attr: { "aria-label": `${g} gate${g === 1 ? "" : "s"} waiting` } });
      if (t.error) b.createSpan({ cls: "aos-at-chipmark", text: "!" });
      b.addEventListener("click", () => this.ctx(t).select(t.id));
    }
    this.tabKeys(bar, ".aos-at-teamchip");
  }

  /** A tablist's keys: arrows move to the previous or next tab and select it, Home and End to the ends. The selection
   *  re-renders the tab, so focus is put back on the tab at the same place afterwards. */
  private tabKeys(list: HTMLElement, sel: string): void {
    list.addEventListener("keydown", (e) => {
      const tabs = Array.from(list.querySelectorAll<HTMLElement>(sel));
      const i = tabs.indexOf(document.activeElement as HTMLElement);
      if (i < 0 || !tabs.length) return;
      const n = tabs.length;
      const j = { ArrowRight: (i + 1) % n, ArrowDown: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, ArrowUp: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
      if (j === undefined) return;
      e.preventDefault();
      this.refocus = { sel, index: j };
      tabs[j].click();
    });
  }

  private renderTeam(host: HTMLElement, t: Team): void {
    const section = host.createEl("section", { cls: "aos-at-team", attr: { "aria-label": `${t.name} team` } });
    const head = section.createDiv({ cls: "aos-at-teamhead" });
    head.createSpan({ cls: "aos-at-teamname", text: t.name });
    if (t.error) {
      const file = t.errorFile ?? "TEAM.md";
      const box = section.createDiv({ cls: "aos-st-failure" });
      box.createDiv({ text: `${TEAMS_DIR}/${t.id}/${file}: ${t.error}` });
      if (file === "TEAM.md" && !t.error.startsWith("could not be read")) {
        box.createDiv({ cls: "aos-dim", text: "The frontmatter allows key: value, inline [a, b] and {a: 1}, and one members: list of flat maps." });
      }
      const open = box.createEl("button", { cls: "aos-ws-action", text: `Open ${file}` });
      open.addEventListener("click", () => this.openFile(`${TEAMS_DIR}/${t.id}/${file}`));
      return;
    }
    const lead = t.members.find((m) => m.id === t.lead);
    head.createSpan({ cls: "aos-dim", text: [`lead ${lead?.name ?? (t.lead || "none")}`, `${t.members.length} member${t.members.length === 1 ? "" : "s"}`, `${t.board.filter((i) => i.status !== "done").length} open`].join(" · ") });
    if (t.state.length) {
      const st = section.createDiv({ cls: "aos-at-state" });
      for (const l of t.state) st.createDiv({ text: l });
    }
    for (const w of t.warnings) section.createDiv({ cls: "aos-at-error", text: w });
    if (t.skipped) section.createDiv({ cls: "aos-dim aos-at-hint", text: `${t.skipped} line${t.skipped === 1 ? "" : "s"} in this team's JSONL files could not be read and are skipped` });
    if (t.disabled) {
      const k = `pause:${t.id}`;
      const bar = section.createDiv({ cls: "aos-rt-banner aos-at-paused" });
      bar.createSpan({ text: "This team is paused: no seat can be dispatched until it resumes." });
      const r = bar.createEl("button", { cls: "aos-ws-action", text: this.busyKeys.has(k) ? "Resuming…" : "Resume" });
      r.disabled = this.busyKeys.has(k);
      r.addEventListener("click", () => void this.act(k, pauseArgs(t.id, false)));
      errorLine(section, this.errors.get(k) ?? null);
    }

    const tabs = section.createDiv({ cls: "aos-at-views", attr: { role: "tablist", "aria-label": `${t.name} views` } });
    const open = boardColumns(t).reduce((n, c) => n + c.items.length, 0);
    const count: Partial<Record<TeamsView, string>> = { board: open ? String(open) : "", roster: String(t.members.length) };
    for (const v of VIEWS) {
      const on = this.ui.view === v.id;
      const b = tabs.createEl("button", { cls: `aos-at-view${on ? " is-active" : ""}`, attr: { role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1", "data-tour": `agent-teams-view-${v.id}` } });
      b.createSpan({ text: v.label });
      if (count[v.id]) b.createSpan({ cls: "aos-dim aos-at-viewcount", text: count[v.id] });
      b.addEventListener("click", () => { this.ui.view = v.id; this.render(); });
    }
    this.tabKeys(tabs, ".aos-at-view");
    const pane = section.createDiv({ cls: `aos-at-pane aos-at-pane-${this.ui.view}`, attr: { role: "tabpanel" } });
    const ctx = this.ctx(t);
    if (this.ui.view === "board") renderBoard(pane, ctx);
    else if (this.ui.view === "roster") renderRoster(pane, ctx);
    else if (this.ui.view === "interact") renderInteract(pane, ctx);
    else renderManage(pane, ctx);
  }

  private renderEmpty(host: HTMLElement): void {
    const box = host.createDiv({ cls: "aos-at-empty" });
    box.createDiv({ cls: "aos-at-emptytitle", text: "No teams yet" });
    box.createDiv({ text: "A team is a lead agent and the seats it dispatches, working one board through stages. Each seat runs on Claude Code or Codex, a reviewer on the provider that did not build the work, and you decide the gates here." });
    const acts = box.createDiv({ cls: "aos-at-emptyacts" });
    const busy = this.busyKeys.has("init");
    const seed = acts.createEl("button", { cls: "mod-cta", text: busy ? "Seeding…" : "Seed the example team" });
    seed.disabled = busy;
    seed.addEventListener("click", () => void this.act("init", INIT_ARGS));
    acts.createSpan({ cls: "aos-dim", text: `It lands in ${TEAMS_DIR}/example/. Point each member at one of your agents in its TEAM.md. In a session: ${invocationHint("team", readAgenticosJson(this.plugin.claudeConfigDir()))}.` });
    errorLine(box, this.errors.get("init") ?? null);
  }
}
