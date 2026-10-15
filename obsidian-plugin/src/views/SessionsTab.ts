import { Component, MarkdownRenderer, setIcon } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { ChatTab } from "./ChatTab";
import {
  fs, sessionsHost, type HostCatalog, type HostCatalogHost, type HostGitStatus, type HostResult, type HostSessionAccess,
  type HostSessionEvent, type HostSessionThread,
} from "../host";
import { readAgenticosJson, readProviderState, type SessionHost } from "../data/aosConfig";
import {
  DEFAULT_ACCESS, HOST_LABEL, accessLabel, catalogHost, choiceText, countsText, diffTotals, doneLine, fileCounts, fileStatusLabel,
  groupThreads, hostChoices, lastTurnUsd, mergeEvents, modelArg, relPath, sessionSpendToday, spendLine, statusSummary,
  threadAge, threadMeta, threadRows, toolResultText, turnChoices, turnElapsed, turnOpen, usdText, workingText, workspaceNames,
  type CatalogCommand, type PlanItem, type RememberedChoice, type ThreadRow,
} from "../data/agentSessions";
import { SPEND_LEDGER_PATH } from "../data/claudeAsk";
import { ago } from "../data/notifications";
import { rememberSessionChoice, sanitizeSessionChoice } from "../settingsDefaults";
import { AccessMenu } from "../ui/AccessMenu";
import { HostModelMenu, type HostModelValue } from "../ui/HostModelMenu";
import { SlashMenu } from "../ui/SlashMenu";

/** The list's first row: today's Q&A chat about the vault (ChatTab). */
const VAULT = "vault";
/** The reader while a new session is being written: the composer with its workspace, host and model menus. */
const NEW = "new";
/** After a turn ends, main records its spend and run before the thread reads as idle: the list looks again after these. */
const LIST_RECHECK_MS = [400, 1500, 4000];
/** A reply sent while main is still recording the last turn: tries again this often, this many times. */
const BUSY_RETRY_MS = 300;
const BUSY_RETRIES = 10;
/** The working line's clock. */
const TICK_MS = 1000;
/** A file's diff in the reader shows this many lines; the review drawer's shows them all. */
const DIFF_LINES = 400;
/** Claude Code's word for each change a Codex patch reports. */
const PATCH_VERB: Record<string, string> = { add: "Write", delete: "Delete", update: "Update" };
/** What a screen reader hears before each plan item: the box alone says it only by sight. */
const PLAN_STATE: Record<PlanItem["status"], string> = { done: "Done: ", active: "In progress: ", pending: "To do: " };

interface RepoCard {
  workspace: string;
  status: HostGitStatus | null;
  error: string | null;
  loading: boolean;
  /** The file whose diff the card shows, and that diff. */
  review: { file: string; text: string; truncated: boolean; error: string | null } | null;
  /** The commit message, prefilled from the thread's title; what the user typed survives a refresh. */
  message: string;
  result: { ok: boolean; text: string } | null;
  committing: boolean;
}

/** A file's current diff opened from a tool or patch line; null while it is read. */
type FileDiff = { text: string; truncated: boolean; error: string | null } | null;

/** The reader's parts that change after it is drawn. */
interface ReaderEls {
  top: HTMLElement;
  scroll: HTMLElement;
  timeline: HTMLElement;
  drawer: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  error: HTMLElement;
  status: HTMLElement;
  /** The running turn's `✻ Working…` line, which the clock updates in place. */
  working: HTMLElement | null;
}

/** What the timeline's rows need to know of their thread. */
interface RowContext {
  host: SessionHost;
  entry: HostCatalogHost | null;
  root: string | null;
  choices: Map<number, { model: string | null; effort: string | null }>;
}

/**
 * SESSIONS — agent sessions in the centre (spec 2026-10-07-unidex-sessions S10; spec 2026-10-07-sessions-ux U1, U2, U6–U8,
 * U10–U12). The rail tab keeps the id "chat", so links and Home still reach it. The list: New session, Vault (today's
 * chat about the vault, ChatTab, unchanged), then each workspace folder with its threads, and the day's session spend.
 * The reader, as Claude Code shows a session: `workspace / title`, the branch, Review changes and Stop above one centred
 * column; your prompts, the agent's text, its tool calls as `⏺ Verb(target)` lines with their `⎿` result, the turn's
 * plan, model changes and a footer per turn; the composer below it with the workspace, access and host-and-model menus,
 * `/` for the host's commands, and a status line. The app's main process runs every turn and keeps every thread; this
 * tab only names a workspace, a host, a prompt and the turn's model, effort and access (host.ts sessions and git).
 * Without them, Vault alone works.
 */
export class SessionsTab {
  private host: HTMLElement | null = null;
  private chat: ChatTab;
  private selected = VAULT;
  private threads: HostSessionThread[] = [];
  private listError: string | null = null;
  private listLoaded = false;
  private listSeq = 0;
  /** Each thread read; an older read that answers late is dropped. */
  private readSeq = 0;
  /** Today's session spend against sessions.perDayUsd; null when the ledger cannot be read. */
  private spend: { spent: number; cap: number } | null = null;
  /** The open thread, from the list or from the start/send that opened it. */
  private thread: HostSessionThread | null = null;
  private events: HostSessionEvent[] = [];
  /** Live events of the open thread that arrive while its file is being read; merged in when the read answers. */
  private pending: HostSessionEvent[] | null = null;
  private loading = false;
  /** Tool and patch lines opened to their input, result and diff. */
  private expanded = new Set<string>();
  private diffs = new Map<string, FileDiff>();
  private repo: RepoCard | null = null;
  /** Each repository read; an older read that answers late is dropped. */
  private repoSeq = 0;
  /** The Review changes drawer over the conversation. */
  private drawer = false;
  /** Each host's models and commands (U3); null until the app answers, when the menus show the aliases. */
  private catalog: HostCatalog | null = null;
  private catalogSeq = 0;
  /** A catalog read is on its way: a second mount does not ask again. */
  private catalogLoading = false;
  private refreshing = false;
  /** The new session's workspace. */
  private workspace = "";
  /** The workspace another tab opened Sessions on (reveal): the list shows only its threads until Show all, or until a
   *  thread elsewhere is open (spaces-redesign D12). */
  private scope: string | null = null;
  /** What reveal() asked to open, applied when the list it asked for answers. */
  private revealing: { thread: string | null } | null = null;
  /** The open thread's next turn: what the user picked for it, else what its last turn ran on (U6). */
  private next: { thread: string; model: string | null; effort: string | null; access: HostSessionAccess } | null = null;
  /** The new session's host, model and effort as last picked, until it starts: a custom id the catalog does not list
   *  stays on the chip, though remembered() would drop it from the settings' choice. */
  private draft: HostModelValue | null = null;
  private text = "";
  /** Messages whose send failed after the user moved to another thread (or off New session), kept for their return. */
  private unsent = new Map<string, { text: string; error: string }>();
  private composerError: string | null = null;
  private sending = false;
  private stopping: string | null = null;
  private md: Component | null = null;
  private unsubscribe: (() => void) | null = null;
  private timers = new Set<number>();
  private tick: number | null = null;
  private menus: { host: HostModelMenu; access: AccessMenu; slash: SlashMenu } | null = null;
  /** What the access chip last drew, so a redraw that would change nothing (and drop its focus) is skipped. */
  private accessShown = "";
  /** Whether the host and model chip was last told it is disabled (while a turn is being sent). */
  private hostDisabled = false;
  private el: { list: HTMLElement; reader: HTMLElement } | null = null;
  private r: ReaderEls | null = null;

  constructor(private plugin: AgenticOSPlugin, private wb: WorkbenchView) {
    this.chat = new ChatTab(plugin, wb, () => this.selected === VAULT);
  }

  mount(host: HTMLElement): void {
    this.host = host;
    const sh = sessionsHost();
    if (sh && !this.unsubscribe) this.unsubscribe = sh.sessions.onEvent((ev) => this.onEvent(ev.thread, ev.event));
    this.render();
    if (this.isThread(this.selected)) void this.openThread(this.selected);
    void this.loadList();
    if (!this.catalog && !this.catalogLoading) void this.loadCatalog(false);
  }

  async refresh(): Promise<void> {
    await this.loadList();
  }

  unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.clear();
    this.stopTick();
    this.destroyMenus();
    this.chat.unmount();
    this.md?.unload();
    this.md = null;
    this.el = null;
    this.r = null;
    this.host?.empty();
    this.host = null;
  }

  /**
   * Sessions on a workspace (spaces-redesign D12, WorkbenchView.open): the list shows only that workspace's threads,
   * with Show all, and `thread` opens when the list holds it. Without one (or when it is not an app thread, D32), the
   * newest thread there opens unless one of its threads is already open; with none, New session with the workspace
   * picked. Select only: nothing is sent or started.
   */
  reveal(target: { workspace?: string | null; thread?: string | null }): void {
    this.scope = target.workspace || null;
    this.revealing = { thread: target.thread || null };
    void this.loadList();
  }

  /** Applies a pending reveal() once the list has answered. */
  private applyReveal(): void {
    const r = this.revealing;
    if (!r) return;
    this.revealing = null;
    const t = r.thread ? this.threads.find((x) => x.id === r.thread) : undefined;
    if (t) {
      if (this.scope && t.workspace !== this.scope) this.scope = t.workspace;
      if (this.selected !== t.id) this.select(t.id);
      return;
    }
    if (!this.scope || !sessionsHost()) return;   // without the app's sessions there is no thread or New session to show
    if (this.thread && this.isThread(this.selected) && this.thread.workspace === this.scope) return;
    const newest = groupThreads(this.threads).find((g) => g.workspace === this.scope)?.threads[0];
    if (newest) { this.select(newest.id); return; }
    if (this.workspaces().includes(this.scope)) this.workspace = this.scope;
    this.select(NEW);
  }

  /** Shows every workspace's threads again. */
  private clearScope(): void {
    this.scope = null;
    this.renderList();
  }

  private active(): boolean { return this.wb.isTabActive("chat") && !!this.host; }
  private isThread(id: string): boolean { return id !== VAULT && id !== NEW; }

  // ── data ──

  private async loadList(): Promise<void> {
    const sh = sessionsHost();
    let found = false;
    if (sh) {
      const seq = ++this.listSeq;
      const [r] = await Promise.all([sh.sessions.list(), this.loadSpend()]);
      if (seq !== this.listSeq) return;   // a later look already answered
      this.listLoaded = true;
      if (r.ok) {
        this.threads = r.data;
        this.listError = null;
        const open = r.data.find((t) => t.id === this.selected);
        if (open) { found = !this.thread; this.thread = open; }
      } else {
        this.threads = [];
        this.listError = r.error;
      }
    }
    if (!this.active()) return;
    if (this.revealing) this.applyReveal();
    this.renderList();
    this.renderStatus();
    // A thread opened before the list knew it (just started elsewhere) gets its header and menus now.
    if (found) { this.renderHead(); this.renderTimeline(); this.syncMenus(); this.syncComposer(); }
  }

  /** Today's `session:*` rows of the spend ledger, as the runtime counts them against sessions.perDayUsd (spec §4.3). */
  private async loadSpend(): Promise<void> {
    const cap = this.plugin.systemConfig().sessions?.perDayUsd;
    if (typeof cap !== "number" || !Number.isFinite(cap)) { this.spend = null; return; }
    const file = path.join(this.plugin.vaultRoot(), SPEND_LEDGER_PATH);
    try {
      const raw = fs.existsSync(file) ? await fs.promises.readFile(file, "utf8") : "";
      this.spend = { spent: sessionSpendToday(raw, new Date()), cap };
    } catch { this.spend = null; }
  }

  private scheduleList(ms: number): void {
    const id = window.setTimeout(() => { this.timers.delete(id); void this.loadList(); }, ms);
    this.timers.add(id);
  }

  /** The hosts' models and commands: the app's cache, or the hosts again on the menu's ↻. */
  private async loadCatalog(refresh: boolean): Promise<void> {
    const sh = sessionsHost();
    if (!sh) return;
    const seq = ++this.catalogSeq;
    this.catalogLoading = true;
    if (refresh) { this.refreshing = true; this.menus?.host.update({ refreshing: true }); }
    let r: HostResult<HostCatalog> | null = null;
    try { r = await (refresh ? sh.sessions.catalog(true) : sh.sessions.catalog()); } catch { r = null; }
    if (seq !== this.catalogSeq) return;
    this.catalogLoading = false;
    this.refreshing = false;
    if (r?.ok) this.catalog = r.data;
    if (!this.active()) return;
    this.syncMenus();
    if (this.isThread(this.selected)) this.renderTimeline();   // the change markers and footers name models
    this.renderStatus();
  }

  /** Reads the thread's file, then keeps it current from live events. */
  private async openThread(id: string): Promise<void> {
    const sh = sessionsHost();
    if (!sh) return;
    const seq = ++this.readSeq;
    this.pending = [];
    this.loading = !this.events.length;
    if (this.active()) this.renderTimeline();
    const r = await sh.sessions.read(id);
    if (this.selected !== id || seq !== this.readSeq) return;
    const live = this.pending ?? [];
    this.pending = null;
    this.loading = false;
    if (r.ok) this.events = mergeEvents(r.data, live);
    else { this.events = mergeEvents(this.events, live); this.composerError = r.error; }
    // A done this tab did not hear (it was unmounted when it came) still ends the stop: the thread's file says so.
    if (this.stopping === id && !turnOpen(this.events)) this.stopping = null;
    if (!this.active()) return;
    this.renderHead();
    this.renderTimeline(true);
    this.syncComposer();
    if (!turnOpen(this.events)) void this.loadRepo();
  }

  private onEvent(thread: string, e: HostSessionEvent): void {
    // A stop lasts until its turn's done, wherever that thread is (open, being read, or not shown); a prompt is a new turn.
    if ((e.kind === "done" || e.kind === "prompt") && this.stopping === thread) this.stopping = null;
    if (thread === this.selected) {
      if (this.pending) this.pending.push(e);
      else {
        this.events.push(e);
        if (e.kind === "done") this.diffs.clear();   // the turn may have changed the files a line shows
        if (this.active()) {
          this.renderTimeline();
          if (e.kind === "prompt" || e.kind === "done") { this.renderHead(); this.syncComposer(); }
        }
        if (e.kind === "done") void this.loadRepo();
      }
    }
    if (e.kind === "done") for (const ms of LIST_RECHECK_MS) this.scheduleList(ms);
    else if (e.kind === "prompt" || !this.threads.some((t) => t.id === thread)) this.scheduleList(0);
  }

  /** The workspace's status (branch, files and their +/−). Read only between turns: git status may take the index lock
   *  that an agent's own git command needs. */
  private async loadRepo(): Promise<void> {
    const sh = sessionsHost();
    const t = this.thread;
    if (!sh || !t || this.selected !== t.id) return;
    // The same workspace's card is read again in place: a commit on its way keeps its card, and reads again when it ends.
    const prev = this.repo?.workspace === t.workspace ? this.repo : null;
    if (prev?.committing) return;
    const repo: RepoCard = prev ?? { workspace: t.workspace, status: null, error: null, loading: true, review: null, message: t.title, result: null, committing: false };
    repo.loading = true;
    repo.error = null;
    repo.review = null;
    if (!repo.message) repo.message = t.title;
    this.repo = repo;
    const seq = ++this.repoSeq;
    if (this.active()) this.renderDrawer();
    const r = await sh.git.status(t.workspace);
    if (this.selected !== t.id || this.repo !== repo || seq !== this.repoSeq) return;   // moved away, or a later read
    repo.loading = false;
    if (r.ok) repo.status = r.data;
    else repo.error = r.error;
    if (!this.active()) return;
    this.renderHead();
    this.renderDrawer();
    this.renderTimeline();   // edit lines show the files' +/−
    this.renderStatus();
  }

  private async loadDiff(file: string): Promise<void> {
    const sh = sessionsHost();
    const t = this.thread;
    if (!sh || !t) return;
    this.diffs.set(file, null);
    const r = await sh.git.diff(t.workspace, file);
    if (this.selected !== t.id || !this.diffs.has(file)) return;
    this.diffs.set(file, r.ok ? { text: r.data.text, truncated: r.data.truncated, error: null } : { text: "", truncated: false, error: r.error });
    if (this.active()) this.renderTimeline();
  }

  /** Folders under <vault>/workspaces, read as every other tab reads the vault. */
  private workspaces(): string[] {
    const dir = path.join(this.plugin.vaultRoot(), "workspaces");
    try {
      const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => {
        if (d.isDirectory()) return true;
        if (!d.isSymbolicLink()) return false;
        try { return fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { return false; }
      });
      return workspaceNames(dirs.map((d) => d.name));
    } catch { return []; }
  }

  /** The open thread's workspace folder: Claude names files absolutely, the reader shows them from here. */
  private workspaceRoot(): string | null {
    return this.thread ? path.join(this.plugin.vaultRoot(), "workspaces", this.thread.workspace) : null;
  }

  /** A file a line names, relative to its workspace, for git; null for one outside it. */
  private diffPath(file: string): string | null {
    const rel = relPath(file, this.workspaceRoot());
    return rel && !path.isAbsolute(rel) && !rel.startsWith("../") ? rel : null;
  }

  private repoStatus(): HostGitStatus | null {
    return this.repo && this.repo.workspace === this.thread?.workspace ? this.repo.status : null;
  }

  // ── the turn's choices (U6, U7, U12) ──

  /** The last choice on each host from the HUD's settings, each model kept only while the catalog still lists it (a
   *  host that did not answer lists only its aliases, so its stored model stays). */
  private remembered(): Record<SessionHost, RememberedChoice> {
    const c = sanitizeSessionChoice(this.plugin.settings.sessionChoice);
    const one = (h: SessionHost): RememberedChoice => {
      const entry = catalogHost(this.catalog, h);
      const model = c.models[h];
      return { model: !model || !entry?.ok || entry.models.some((m) => m.id === model) ? model : null, effort: c.efforts[h] };
    };
    return { claude: one("claude"), codex: one("codex") };
  }

  private nextTurn(): { model: string | null; effort: string | null; access: HostSessionAccess } | null {
    const t = this.thread;
    if (!t) return null;
    if (this.next?.thread !== t.id) this.next = { thread: t.id, model: t.model, effort: t.effort, access: t.access };
    return this.next;
  }

  /** What the host and model menu starts from: the remembered host and its choice, or the thread's next turn. */
  private menuValue(): HostModelValue {
    if (this.selected === NEW) {
      if (this.draft) return this.draft;
      const host = sanitizeSessionChoice(this.plugin.settings.sessionChoice).host;
      const rem = host ? this.remembered()[host] : null;
      return { host, model: rem?.model ?? null, effort: rem?.effort ?? null };
    }
    const n = this.nextTurn();
    return { host: this.thread?.host ?? null, model: n?.model ?? null, effort: n?.effort ?? null };
  }

  private accessValue(): HostSessionAccess {
    if (this.selected === NEW) return sanitizeSessionChoice(this.plugin.settings.sessionChoice).access;
    return this.nextTurn()?.access ?? DEFAULT_ACCESS;
  }

  private commands(host: SessionHost | null): CatalogCommand[] {
    return host ? catalogHost(this.catalog, host)?.commands ?? [] : [];
  }

  /** Stores the pick as the last choice (U12): a new session starts where the last one left off. */
  private remember(pick: { host: SessionHost; model?: string | null; effort?: string | null; access?: HostSessionAccess }): void {
    this.plugin.settings.sessionChoice = rememberSessionChoice(this.plugin.settings.sessionChoice, pick);
    void this.plugin.saveSettings();
  }

  private pickModel(v: HostModelValue): void {
    if (!v.host) return;
    if (this.selected === NEW) this.draft = v;
    else {
      const n = this.nextTurn();
      if (!n) return;
      n.model = v.model;
      n.effort = v.effort;
    }
    this.remember({ host: v.host, model: v.model, effort: v.effort });
    // The menu's host switch starts from each host's remembered choice: it hears this pick, or a switch back undoes it.
    this.menus?.host.update({ remembered: this.remembered() });
    this.syncAccess();
    this.menus?.slash.update(this.commands(v.host), v.host);
    this.renderStatus();
  }

  private pickAccess(level: HostSessionAccess): void {
    const host = this.menus?.host.value().host ?? null;
    if (this.selected !== NEW) {
      const n = this.nextTurn();
      if (n) n.access = level;
    }
    if (host) this.remember({ host, access: level });
    else {
      this.plugin.settings.sessionChoice = { ...sanitizeSessionChoice(this.plugin.settings.sessionChoice), access: level };
      void this.plugin.saveSettings();
    }
    this.accessShown = "";
    this.syncAccess();
    this.renderStatus();
  }

  // ── actions ──

  private select(id: string, keepText = false): void {
    if (id === this.selected && id !== NEW) return;
    this.selected = id;
    this.thread = this.isThread(id) ? this.threads.find((t) => t.id === id) ?? null : null;
    this.events = [];
    this.pending = null;
    this.expanded.clear();
    this.diffs.clear();
    this.repo = null;
    this.drawer = false;
    this.next = null;
    if (!keepText) this.text = "";
    this.composerError = null;
    // A message that failed while another thread was shown comes back with its error.
    const unsent = this.unsent.get(id);
    if (unsent) { this.unsent.delete(id); this.text = unsent.text; this.composerError = unsent.error; }
    this.renderList();
    this.renderReader();
    if (this.isThread(id)) void this.openThread(id);
  }

  /** The thread menu's New session on <other host>: in the same workspace, and the draft moves over with it. */
  private newSessionOn(host: SessionHost): void {
    if (this.thread) this.workspace = this.thread.workspace;
    this.draft = null;
    this.remember({ host });
    this.select(NEW, true);
    this.r?.input.focus();
  }

  private async submit(): Promise<void> {
    const sh = sessionsHost();
    const text = this.text.trim();
    if (!sh || !text || this.sending) return;
    let r: HostResult<HostSessionThread>;
    const isNew = this.selected === NEW;
    const pick = this.menus?.host.value() ?? { host: null, model: null, effort: null };
    if (isNew && !this.workspace) { this.composerError = "Choose a workspace first."; this.syncComposer(); return; }
    if (isNew && !pick.host) { this.composerError = "No host is ready to run this session."; this.syncComposer(); return; }
    // Focus goes back to the prompt after the send: Send itself is disabled while it sends, or replaced with the reader.
    const focused = !!this.r && (document.activeElement === this.r.input || document.activeElement === this.r.send);
    const raw = this.text;
    this.sending = true;
    this.composerError = null;
    this.syncComposer();
    const sent = this.selected;
    if (isNew) {
      const host = pick.host as SessionHost;
      r = await sh.sessions.start({ workspace: this.workspace, host, text, model: modelArg(host, pick.model), effort: pick.effort, access: this.accessValue() });
    } else {
      const thread = sent;
      // Every turn names its model, effort and access; an unchanged pick is the thread's last, so no marker comes of it.
      const n = this.nextTurn();
      const host = this.thread?.host;
      const opts = n && host ? { model: modelArg(host, n.model), effort: n.effort, access: n.access } : {};
      r = await sh.sessions.send({ thread, text, ...opts });
      // The last turn has ended here, but main may still be recording it (its spend and run row): try again shortly. The
      // request names the thread, so it goes on after the user moves away; only its own events say a turn now runs.
      for (let i = 0; i < BUSY_RETRIES && !r.ok && r.code === "EBUSY" && (this.selected !== thread || !turnOpen(this.events)); i++) {
        await new Promise((res) => window.setTimeout(res, BUSY_RETRY_MS));
        r = await sh.sessions.send({ thread, text, ...opts });
      }
    }
    this.sending = false;
    // The user may have moved to another thread while main answered: then the answer only updates the list.
    const here = isNew ? this.selected === NEW : this.selected === sent;
    if (!here && this.active()) this.syncComposer();   // its Send was off while this one was sending
    if (!r.ok) {
      if (!here) { this.unsent.set(sent, { text: raw, error: r.error }); return; }
      this.composerError = r.error;
      // The user left and came back while it sent: the composer was cleared on the way, the message comes back.
      if (!this.text) { this.text = raw; if (this.r) this.r.input.value = raw; }
      if (this.active()) { this.syncComposer(); if (focused) this.r?.input.focus(); }
      return;
    }
    const t = r.data;
    this.threads = [t, ...this.threads.filter((x) => x.id !== t.id)];
    if (!here) {
      if (this.active()) this.renderList();
    } else if (isNew) {
      this.text = "";
      this.draft = null;
      this.thread = t;
      this.selected = t.id;
      this.events = [];
      this.repo = null;
      this.next = { thread: t.id, model: t.model, effort: t.effort, access: t.access };
      if (this.active()) { this.renderList(); this.renderReader(); if (focused) this.r?.input.focus(); }
      void this.openThread(t.id);
    } else {
      this.text = "";
      // Main answers with the thread as its file stood before this prompt, so t's model, effort and access are the last
      // turn's: the next turn keeps what this one was sent with (this.next), or the chip would fall back and mark a change.
      this.thread = t;
      if (this.next?.thread !== t.id) this.next = { thread: t.id, model: t.model, effort: t.effort, access: t.access };
      if (this.active()) {
        if (this.r) this.r.input.value = "";
        this.menus?.slash.refresh();   // the cleared text is no command: an open `/` menu closes
        this.renderList();
        this.renderHead();
        this.renderDrawer();
        this.syncMenus();
        this.syncComposer();
        if (focused) this.r?.input.focus();
      }
    }
    this.scheduleList(0);
  }

  private stop(): void {
    const sh = sessionsHost();
    const t = this.thread;
    if (!sh || !t) return;
    this.stopping = t.id;
    sh.sessions.stop(t.id);
    this.renderHead();
    this.r?.working?.setText(this.workingLine());
  }

  /** Esc stops a running turn while focus is in the tab; the menus and the drawer keep their own Esc. */
  private onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229) return;   // the Esc that cancels an input method's candidate is the IME's
    if (!this.isThread(this.selected) || !turnOpen(this.events) || this.stopping === this.selected) return;
    e.preventDefault();
    this.stop();
  }

  private toggleTool(key: string, file: string | null): void {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else {
      this.expanded.add(key);
      if (file && !this.diffs.has(file)) void this.loadDiff(file);
    }
    this.renderTimeline();
  }

  /** Review changes: the repository card in a drawer over the conversation, read again as it opens. */
  private toggleDrawer(open = !this.drawer): void {
    this.drawer = open;
    if (open && !turnOpen(this.events)) void this.loadRepo();
    this.renderHead();
    this.renderDrawer();
    if (open) this.r?.drawer.querySelector<HTMLElement>(".aos-ss-drawerclose")?.focus();
    else this.r?.top.querySelector<HTMLElement>(".aos-ss-reviewbtn")?.focus();
  }

  private async review(file: string): Promise<void> {
    const sh = sessionsHost();
    const repo = this.repo;
    if (!sh || !repo) return;
    if (repo.review?.file === file) { repo.review = null; this.renderDrawer(); return; }
    repo.review = { file, text: "", truncated: false, error: null };
    this.renderDrawer();
    const r = await sh.git.diff(repo.workspace, file);
    if (this.repo !== repo || repo.review?.file !== file) return;
    repo.review = r.ok ? { file, text: r.data.text, truncated: r.data.truncated, error: null } : { file, text: "", truncated: false, error: r.error };
    if (this.active()) this.renderDrawer();
  }

  private async commit(): Promise<void> {
    const sh = sessionsHost();
    const repo = this.repo;
    if (!sh || !repo || repo.committing) return;
    // Main refuses a blank message too, but only as an argument that does not parse.
    if (!repo.message.trim()) { repo.result = { ok: false, text: "A commit needs a message." }; this.renderDrawer(); return; }
    repo.committing = true;
    repo.result = null;
    this.renderDrawer();
    const r = await sh.git.commit(repo.workspace, repo.message);
    repo.committing = false;
    // The user may have moved on: the result goes to the card now shown for that workspace, if one is.
    const card = this.repo?.workspace === repo.workspace ? this.repo : null;
    if (!card || (card !== repo && card.committing)) return;   // none, or it has a commit of its own on the way
    card.committing = false;
    card.result = r.ok ? { ok: true, text: `Committed ${r.data.commit.slice(0, 7)}` } : { ok: false, text: r.error };
    if (r.ok) { card.review = null; this.diffs.clear(); }
    // A read skipped while it committed happens now; never while a turn runs (git status may take the index lock).
    if (!turnOpen(this.events)) await this.loadRepo();
    else if (this.active()) this.renderDrawer();
  }

  // ── render ──

  private render(): void {
    if (!this.active()) return;
    const host = this.host as HTMLElement;
    this.destroyMenus();
    this.stopTick();
    host.empty();
    const root = host.createDiv({ cls: "aos-ss" });
    root.addEventListener("keydown", (e) => this.onKey(e));
    const list = root.createEl("aside", { cls: "aos-ss-list", attr: { "aria-label": "Sessions" } });
    const reader = root.createDiv({ cls: "aos-ss-reader" });
    this.el = { list, reader };
    this.renderList();
    this.renderReader();
  }

  private clickable(el: HTMLElement, go: () => void): void {
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }

  /** Redraws `el`, then gives focus back to the control that had it (by its data-focus key), so a live event does not
   *  pull focus out from under the keyboard. When that control is gone or disabled (Stop as it stops, Commit as it
   *  commits), focus goes to the first of `fallback` that can take it, not to the page. */
  private keepFocus(el: HTMLElement, draw: () => void, fallback: string[] = []): void {
    const now = document.activeElement;
    const key = now instanceof HTMLElement && el.contains(now) ? now.getAttribute("data-focus") : null;
    draw();
    if (!key) return;
    for (const k of [key, ...fallback]) {
      const target = el.querySelector<HTMLElement>(`[data-focus="${CSS.escape(k)}"]`);
      if (target && !target.matches(":disabled")) { target.focus(); return; }
    }
  }

  private renderList(): void {
    const list = this.el?.list;
    if (!list || !this.active()) return;
    this.keepFocus(list, () => {
      list.empty();
      const sh = sessionsHost();
      if (sh) {
        const b = list.createEl("button", { cls: `aos-ss-newbtn${this.selected === NEW ? " is-selected" : ""}`, attr: { type: "button", "data-focus": "new" } });
        const icon = b.createSpan({ cls: "aos-ss-newicon" });
        setIcon(icon, "square-pen");
        b.appendText("New session");
        b.addEventListener("click", () => this.select(NEW));
      }
      const on = this.selected === VAULT;
      const vault = list.createDiv({
        cls: `aos-ss-row aos-ss-vault${on ? " is-selected" : ""}`,
        attr: { "data-thread": VAULT, role: "button", tabindex: "0", title: "Questions about your notes", "data-focus": `row:${VAULT}`, ...(on ? { "aria-current": "true" } : {}) },
      });
      const book = vault.createSpan({ cls: "aos-ss-rowicon" });
      setIcon(book, "book-open");
      vault.createSpan({ cls: "aos-ss-title", text: "Vault" });
      this.clickable(vault, () => this.select(VAULT));

      const threads = list.createDiv({ cls: "aos-ss-threads", attr: { "data-tour": "sessions-threads" } });
      const note = (text: string) => threads.createDiv({ cls: "aos-ss-note", text });
      // A thread open in another workspace ends the scope, so the open thread is never missing from the list.
      if (this.scope && this.thread && this.isThread(this.selected) && this.thread.workspace !== this.scope) this.scope = null;
      const scope = this.scope;
      if (scope) {
        const bar = threads.createDiv({ cls: "aos-ss-note aos-ss-scope" });
        bar.createSpan({ cls: "aos-ss-scopetext", text: `Showing ${scope} only · ` });
        const all = bar.createEl("a", { cls: "aos-ss-scopeall", text: "Show all", href: "#", attr: { "data-focus": "scope-all" } });
        all.addEventListener("click", (e) => { e.preventDefault(); this.clearScope(); });
      }
      const groups = groupThreads(this.threads).filter((g) => !scope || g.workspace === scope);
      if (!sh) note("Workspace sessions run in the UniDeX app.");
      else if (this.listError) note(`Workspace sessions are unavailable: ${this.listError}.`);
      else if (!groups.length) {
        if (this.listLoaded) note(scope ? `No sessions in ${scope} yet. New session starts one.` : "No workspace sessions yet. New session starts one.");
      } else {
        for (const g of groups) {
          const group = threads.createDiv({ cls: "aos-ss-group", attr: { "data-workspace": g.workspace, role: "group", "aria-label": g.workspace } });
          const head = group.createDiv({ cls: "aos-ss-ws" });
          const folder = head.createSpan({ cls: "aos-ss-wsicon" });
          setIcon(folder, "folder");
          head.createSpan({ cls: "aos-ss-wsname", text: g.workspace });
          for (const t of g.threads) this.renderThreadRow(group, t);
        }
      }
      if (sh && this.spend) this.renderSpend(list, this.spend);
    });
  }

  /** The open thread's own events say whether its turn runs; the list's flag says it for the others. */
  private isRunning(t: HostSessionThread): boolean {
    return t.id === this.selected && this.events.length ? turnOpen(this.events) : t.running;
  }

  private renderThreadRow(parent: HTMLElement, t: HostSessionThread): void {
    const running = this.isRunning(t);
    const on = this.selected === t.id;
    const row = parent.createDiv({
      cls: `aos-ss-row aos-ss-thread${on ? " is-selected" : ""}${running ? " is-running" : ""}`,
      attr: {
        "data-thread": t.id, "data-host": t.host, role: "button", tabindex: "0", "data-focus": `row:${t.id}`,
        title: `${HOST_LABEL[t.host]} · ${threadMeta(t)} · ${ago(t.updated, new Date())}`, ...(on ? { "aria-current": "true" } : {}),
      },
    });
    row.createSpan({ cls: `aos-ss-hostdot is-${t.host}`, attr: { role: "img", title: HOST_LABEL[t.host], "aria-label": HOST_LABEL[t.host] } });
    row.createSpan({ cls: "aos-ss-title", text: t.title || "Untitled" });
    if (running) row.createSpan({ cls: "aos-ss-runmark", text: "●", attr: { role: "img", title: "Working", "aria-label": "Working" } });
    else row.createSpan({ cls: "aos-ss-age", text: threadAge(t.updated, new Date()) });
    this.clickable(row, () => this.select(t.id));
  }

  /** The list's foot: today's session spend against its cap, with a bar. */
  private renderSpend(list: HTMLElement, spend: { spent: number; cap: number }): void {
    const s = spendLine(spend.spent, spend.cap);
    const foot = list.createDiv({ cls: `aos-ss-spend${s.ratio >= 1 ? " is-over" : s.ratio >= 0.8 ? " is-high" : ""}` });
    const line = foot.createDiv({ cls: "aos-ss-spendline" });
    line.createSpan({ text: "Sessions today" });
    line.createSpan({ cls: "aos-ss-spendval", text: s.text });
    const pct = Math.round(s.ratio * 100);
    const bar = foot.createDiv({
      cls: "aos-ss-spendbar",
      attr: { role: "progressbar", "aria-label": "Session spend today", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) },
    });
    bar.createDiv({ cls: "aos-ss-spendfill" }).style.width = `${pct}%`;
  }

  private renderReader(): void {
    const list = this.el?.list;
    const reader = this.el?.reader;
    if (!list || !reader || !this.active()) return;
    this.destroyMenus();
    this.chat.detach();   // Vault's menus go with its DOM; its running question goes on
    this.stopTick();
    reader.empty();
    this.md?.unload();
    this.md = new Component();
    this.md.load();
    this.r = null;
    if (this.selected === VAULT) {
      reader.addClass("is-vault");
      this.chat.mount(reader.createDiv({ cls: "aos-ss-vaultchat" }));
      return;
    }
    reader.removeClass("is-vault");
    const top = reader.createDiv({ cls: "aos-ss-head aos-ss-top" });
    const body = reader.createDiv({ cls: "aos-ss-body" });
    const scroll = body.createDiv({ cls: "aos-ss-scroll" });
    const timeline = scroll.createDiv({ cls: "aos-ss-column aos-ss-timeline" });
    const drawer = body.createDiv({ cls: "aos-ss-drawer", attr: { id: "aos-ss-drawer", role: "region", "aria-label": "Review changes" } });
    drawer.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();   // Esc here closes the drawer; it does not stop the turn
      this.toggleDrawer(false);
    });
    const composer = this.buildComposer(reader.createDiv({ cls: "aos-ss-composer-wrap" }));
    this.r = { top, scroll, timeline, drawer, working: null, ...composer };
    this.renderHead();
    this.renderTimeline(true);
    this.renderDrawer();
    this.syncComposer();
  }

  /** The bar above the conversation: `workspace / title`, the branch, Review changes with its +/−, Stop while a turn runs. */
  private renderHead(): void {
    const top = this.r?.top;
    if (!top || !this.active()) return;
    this.keepFocus(top, () => {
      top.empty();
      if (this.selected === NEW) {
        top.createDiv({ cls: "aos-reader-title aos-ss-toptitle", text: "New session" });
        return;
      }
      const t = this.thread;
      const crumbs = top.createDiv({ cls: "aos-ss-crumbs" });
      // The workspace crumb opens it in Spaces (spaces-redesign D12): select only.
      const ws = t?.workspace ?? "";
      if (ws) {
        const link = crumbs.createEl("a", { cls: "aos-ss-crumb-ws is-link", text: ws, href: "#", attr: { title: `Open workspace ${ws} in Spaces`, "data-focus": "crumb-ws" } });
        link.addEventListener("click", (e) => { e.preventDefault(); this.wb.open({ tab: "spaces", workspace: ws }); });
      } else crumbs.createSpan({ cls: "aos-ss-crumb-ws", text: "" });
      crumbs.createSpan({ cls: "aos-ss-sep", text: "/" });
      crumbs.createSpan({ cls: "aos-ss-crumb-title", text: t?.title ?? "" });
      if (!t) return;
      const st = this.repoStatus();
      if (st?.branch) {
        const branch = top.createSpan({ cls: "aos-ss-topbranch", attr: { title: `Branch ${st.branch}` } });
        const icon = branch.createSpan({ cls: "aos-ss-topbranchicon" });
        setIcon(icon, "git-branch");
        branch.createSpan({ cls: "aos-ss-topbranchname", text: st.branch });
      }
      const review = top.createEl("button", {
        cls: `aos-ss-reviewbtn${this.drawer ? " is-open" : ""}`,
        attr: { type: "button", "aria-expanded": String(this.drawer), "aria-controls": "aos-ss-drawer", "data-focus": "review" },
      });
      review.createSpan({ text: "Review changes" });
      const totals = diffTotals(st);
      if (totals.files > totals.unknown) {
        review.createSpan({ cls: "aos-ss-plus", text: `+${totals.added}` });
        review.createSpan({ cls: "aos-ss-minus", text: `−${totals.removed}` });
      }
      review.addEventListener("click", () => this.toggleDrawer());
      if (turnOpen(this.events)) {
        const stopping = this.stopping === t.id;
        const stop = top.createEl("button", { cls: "aos-ss-stop", attr: { type: "button", title: "Stop this turn", "data-focus": "stop" } });
        stop.createSpan({ cls: "aos-ss-stoplabel", text: stopping ? "Stopping…" : "Stop" });
        if (!stopping) stop.createSpan({ cls: "aos-ss-kbd", text: "esc", attr: { "aria-hidden": "true" } });
        stop.disabled = stopping;
        stop.addEventListener("click", () => this.stop());
      }
    }, ["review"]);
  }

  private renderTimeline(toEnd = false): void {
    const r = this.r;
    if (!r || !this.active()) return;
    const { timeline: el, scroll } = r;
    const atEnd = toEnd || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
    this.keepFocus(el, () => {
      el.empty();
      r.working = null;
      if (this.selected === NEW) { this.renderIntro(el); return; }
      if (this.loading) { el.createDiv({ cls: "aos-ss-note", text: "Reading the thread…" }); return; }
      const host = this.thread?.host ?? "claude";
      const ctx: RowContext = { host, entry: catalogHost(this.catalog, host), root: this.workspaceRoot(), choices: turnChoices(this.events) };
      for (const row of threadRows(this.events, { host, catalog: ctx.entry, root: ctx.root })) this.renderRow(el, row, ctx);
      if (turnOpen(this.events)) r.working = el.createDiv({ cls: "aos-ss-working", text: this.workingLine() });
    });
    this.syncTick();
    if (atEnd) scroll.scrollTop = scroll.scrollHeight;
  }

  private renderIntro(el: HTMLElement): void {
    const intro = el.createDiv({ cls: "aos-ss-intro" });
    intro.createDiv({ cls: "aos-ss-introtitle", text: "Start a session in a workspace" });
    intro.createDiv({ cls: "aos-ss-introtext", text: "An agent works in a workspace folder, turn by turn; you review and commit what it changed." });
  }

  private workingLine(): string {
    return workingText(turnElapsed(this.events, new Date()), this.stopping === this.selected);
  }

  /** The working line's clock runs while that line is on screen, and stops with it (or the tab). */
  private syncTick(): void {
    if (!this.r?.working) { this.stopTick(); return; }
    if (this.tick !== null) return;
    this.tick = window.setInterval(() => {
      const w = this.r?.working;
      if (!w || !this.active()) { this.stopTick(); return; }
      w.setText(this.workingLine());
    }, TICK_MS);
  }

  private stopTick(): void {
    if (this.tick !== null) window.clearInterval(this.tick);
    this.tick = null;
  }

  private renderRow(el: HTMLElement, r: ThreadRow, ctx: RowContext): void {
    if (r.kind === "prompt") {
      el.createDiv({ cls: "aos-ss-prompt" }).createDiv({ cls: "aos-ss-bubble", text: r.text });
    } else if (r.kind === "text") {
      const body = el.createDiv({ cls: "aos-ss-text" });
      if (this.md) void MarkdownRenderer.renderMarkdown(r.text, body, `workspaces/${this.thread?.workspace ?? ""}`, this.md);
    } else if (r.kind === "tool") {
      this.renderTool(el, r);
    } else if (r.kind === "patch") {
      this.renderPatch(el, r, ctx);
    } else if (r.kind === "plan") {
      const card = el.createDiv({ cls: "aos-ss-plan" });
      card.createDiv({ cls: "aos-ss-planhead", text: "Plan" });
      const list = card.createEl("ul", { cls: "aos-ss-planlist" });
      for (const item of r.items) {
        const li = list.createEl("li", { cls: `aos-ss-planitem is-${item.status}`, attr: { "data-status": item.status } });
        li.createSpan({ cls: "aos-ss-planbox", text: item.status === "done" ? "☒" : "☐", attr: { "aria-hidden": "true" } });
        const text = li.createSpan({ cls: "aos-ss-plantext" });
        text.createSpan({ cls: "aos-ss-sronly", text: PLAN_STATE[item.status] });
        text.appendText(item.text);
      }
    } else if (r.kind === "change") {
      el.createDiv({ cls: "aos-ss-turnchange", attr: { "data-turn": String(r.turn) } }).createSpan({ cls: "aos-ss-turnchangetext", text: r.text });
    } else if (r.kind === "error") {
      el.createDiv({ cls: "aos-ss-error", text: r.message });
    } else {
      const c = ctx.choices.get(r.turn);
      const choice = c ? choiceText(ctx.host, ctx.entry, c.model, c.effort) : null;
      el.createDiv({ cls: `aos-ss-done${r.ok ? "" : " is-failed"}`, text: doneLine(r, choice) });
    }
  }

  /** `⏺ Verb(target)` and its `⎿` result; open, the full input and result and, for an edit, the file's diff (U10). */
  private renderTool(el: HTMLElement, r: Extract<ThreadRow, { kind: "tool" }>): void {
    const tone = r.result === null ? "is-pending" : r.result.ok ? "is-ok" : "is-failed";
    const open = this.expanded.has(r.key);
    const box = el.createDiv({ cls: `aos-ss-tool ${tone}${open ? " is-open" : ""}`, attr: { "data-kind": r.tool.toolKind || "other", "data-verb": r.verb } });
    const file = r.tool.toolKind === "edit" && r.tool.filePath ? this.diffPath(r.tool.filePath) : null;
    this.renderLine(box, r.verb, r.target, open, `tool:${r.key}`, () => this.toggleTool(r.key, file));
    const result = toolResultText(r, file ? fileCounts(this.repoStatus(), file) : null);
    if (result !== null) this.renderResult(box, result, r.result?.ok === false);
    if (!open) return;
    const body = box.createDiv({ cls: "aos-ss-toolbody" });
    if (r.tool.summary) body.createEl("pre", { cls: "aos-ss-toolin", text: r.tool.summary });
    if (r.result) {
      body.createDiv({ cls: "aos-ss-toolstate", text: r.result.ok ? "Result" : "Failed" });
      if (r.result.summary) body.createEl("pre", { cls: "aos-ss-toolout", text: r.result.summary });
    } else body.createDiv({ cls: "aos-ss-toolstate", text: "No result yet" });
    if (file) this.renderFileDiff(body, file);
  }

  /** A Codex patch as Claude Code shows edits: a line per file with its +/−, each opening to the file's diff. */
  private renderPatch(el: HTMLElement, r: Extract<ThreadRow, { kind: "patch" }>, ctx: RowContext): void {
    const box = el.createDiv({ cls: "aos-ss-patch" });
    r.files.forEach((f, i) => {
      const key = `patch:${r.turn}:${i}:${f.path}`;
      const open = this.expanded.has(key);
      const file = f.path ? this.diffPath(f.path) : null;
      const item = box.createDiv({ cls: `aos-ss-patchfile is-ok${open ? " is-open" : ""}`, attr: { "data-file": file ?? f.path, "data-change": f.change } });
      this.renderLine(item, PATCH_VERB[f.change] ?? "Update", relPath(f.path, ctx.root), open, key, () => this.toggleTool(key, file));
      const counts = file ? fileCounts(this.repoStatus(), file) : null;
      const c = counts ? countsText(counts) : "";
      this.renderResult(item, c ? `${c} · open to see the file's diff` : "Done", false);
      if (open && file) this.renderFileDiff(item.createDiv({ cls: "aos-ss-toolbody" }), file);
    });
  }

  private renderLine(box: HTMLElement, verb: string, target: string, open: boolean, key: string, toggle: () => void): void {
    const line = box.createEl("button", { cls: "aos-ss-toolline", attr: { type: "button", "aria-expanded": String(open), "data-focus": key } });
    line.createSpan({ cls: "aos-ss-verb", text: verb });
    if (target) line.createSpan({ cls: "aos-ss-target", text: `(${target})` });
    line.addEventListener("click", toggle);
  }

  /** The `⎿` line; an edit's `+a −b` in their colours. */
  private renderResult(box: HTMLElement, text: string, failed: boolean): void {
    const out = box.createDiv({ cls: `aos-ss-toolresult${failed ? " is-failed" : ""}` });
    const m = /^(\+\d+) (−\d+)( · .*)$/.exec(text);
    if (!m) { out.setText(text); return; }
    out.createSpan({ cls: "aos-ss-plus", text: m[1] });
    out.appendText(" ");
    out.createSpan({ cls: "aos-ss-minus", text: m[2] });
    out.appendText(m[3]);
  }

  /** The file's diff against HEAD now (git:diff), the same for both hosts: Codex names only the files it changed. */
  private renderFileDiff(parent: HTMLElement, file: string): void {
    const wrap = parent.createDiv({ cls: "aos-ss-filediff" });
    const d = this.diffs.get(file);
    if (d === undefined) void this.loadDiff(file);   // read again after a turn or a commit
    if (!d) { wrap.createDiv({ cls: "aos-ss-note", text: "Reading the file's diff…" }); return; }
    if (d.error) { wrap.createDiv({ cls: "aos-ss-error", text: d.error }); return; }
    if (!d.text.trim()) { wrap.createDiv({ cls: "aos-ss-note", text: "The file has no changes against HEAD." }); return; }
    this.renderDiff(wrap, d.text, d.truncated, DIFF_LINES);
  }

  private renderDiff(parent: HTMLElement, text: string, truncated: boolean, max = Infinity): void {
    const lines = text.replace(/\n$/, "").split("\n");
    const pre = parent.createEl("pre", { cls: "aos-ss-diff" });
    for (const line of lines.slice(0, max)) {
      const kind = /^(diff |index |--- |\+\+\+ )/.test(line) ? " is-meta" : line.startsWith("@@") ? " is-hunk" : line.startsWith("+") ? " is-add" : line.startsWith("-") ? " is-del" : "";
      pre.createSpan({ cls: `aos-ss-diffline${kind}`, text: line || " " });
    }
    if (lines.length > max) parent.createDiv({ cls: "aos-ss-note", text: `The first ${max} of ${lines.length} lines; Review changes shows them all.` });
    if (truncated) parent.createDiv({ cls: "aos-ss-note", text: "The diff is longer than this; only its first 2 MB are shown." });
  }

  /** The Review changes drawer: the repository card (what changed, each file's +/− and diff, the commit). */
  private renderDrawer(): void {
    const d = this.r?.drawer;
    if (!d || !this.active()) return;
    this.keepFocus(d, () => {
      d.empty();
      d.toggleClass("is-open", this.drawer);
      if (!this.drawer) return;
      const head = d.createDiv({ cls: "aos-ss-drawerhead" });
      head.createSpan({ cls: "aos-ss-drawertitle", text: "Review changes" });
      const close = head.createEl("button", { cls: "aos-ss-drawerclose", attr: { type: "button", "aria-label": "Close the review", title: "Close (esc)", "data-focus": "drawer-close" } });
      setIcon(close, "x");
      close.addEventListener("click", () => this.toggleDrawer(false));
      this.renderRepo(d.createDiv({ cls: "aos-ss-drawerbody" }));
    }, ["message", "drawer-close"]);
  }

  private renderRepo(el: HTMLElement): void {
    const r = this.repo;
    const running = turnOpen(this.events);
    if (!r) { el.createDiv({ cls: "aos-ss-note", text: running ? "The changes show when the turn ends." : "Reading the repository…" }); return; }
    const card = el.createDiv({ cls: "aos-ss-repo" });
    const head = card.createDiv({ cls: "aos-ss-repohead" });
    if (r.error) { head.createSpan({ cls: "aos-ss-reposum", text: r.error }); return; }
    if (!r.status) { head.createSpan({ cls: "aos-ss-reposum aos-dim", text: "Reading the repository…" }); return; }
    const st = r.status;
    head.createSpan({ cls: "aos-ss-reposum", text: st.repo ? statusSummary(st) : `workspaces/${r.workspace} is not a git repository, so there is nothing to review or commit` });
    if (st.branch) head.createSpan({ cls: "aos-ss-branch", text: st.branch });
    const totals = diffTotals(st);
    if (totals.files > totals.unknown) this.renderCounts(head, totals);
    if (r.result) card.createDiv({ cls: `aos-ss-commitresult ${r.result.ok ? "is-ok" : "is-failed"}`, text: r.result.text });
    if (!st.repo || !st.files.length) return;

    const files = card.createDiv({ cls: "aos-ss-files" });
    for (const f of st.files) {
      const on = r.review?.file === f.path;
      const row = files.createDiv({ cls: `aos-ss-file${on ? " is-open" : ""}`, attr: { "data-file": f.path } });
      row.createSpan({ cls: "aos-ss-change", text: fileStatusLabel(f.status) });
      row.createSpan({ cls: "aos-ss-path", text: f.path, attr: { title: f.path } });
      this.renderCounts(row, f);
      const b = row.createEl("button", { cls: "aos-ws-action aos-ss-review", text: on ? "Close" : "Review", attr: { type: "button", "data-focus": `review:${f.path}`, "aria-expanded": String(on) } });
      b.addEventListener("click", () => void this.review(f.path));
    }
    if (r.review) {
      const pane = card.createDiv({ cls: "aos-ss-diffwrap" });
      if (r.review.error) pane.createDiv({ cls: "aos-ss-error", text: r.review.error });
      else if (!r.review.text) pane.createDiv({ cls: "aos-dim", text: "Reading the diff…" });
      else this.renderDiff(pane, r.review.text, r.review.truncated);
    }
    if (running) { card.createDiv({ cls: "aos-ss-note", text: "The agent is still working: commit once the turn ends." }); return; }
    const form = card.createDiv({ cls: "aos-ss-commit" });
    const msg = form.createEl("input", { cls: "aos-ss-message", attr: { type: "text", "aria-label": "Commit message", spellcheck: "false", "data-focus": "message" } });
    msg.value = r.message;
    msg.addEventListener("input", () => { r.message = msg.value; });
    msg.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void this.commit(); } });
    const go = form.createEl("button", { cls: "mod-cta aos-ss-commitbtn", text: r.committing ? "Committing…" : "Commit", attr: { type: "button", "data-focus": "commit" } });
    go.disabled = r.committing || st.detached || st.merging;
    if (st.detached) form.createDiv({ cls: "aos-ss-note", text: "HEAD is detached: check out a branch to commit." });
    else if (st.merging) form.createDiv({ cls: "aos-ss-note", text: "A merge is in progress: finish it in a terminal." });
    go.addEventListener("click", () => void this.commit());
  }

  /** `+a −b` for a file or the whole status; "binary" for a file git counts no lines of. */
  private renderCounts(parent: HTMLElement, c: { added: number | null; removed: number | null }): void {
    const el = parent.createSpan({ cls: "aos-ss-counts" });
    if (c.added === null || c.removed === null) { el.addClass("is-binary"); el.setText("binary"); return; }
    el.createSpan({ cls: "aos-ss-plus", text: `+${c.added}` });
    el.createSpan({ cls: "aos-ss-minus", text: `−${c.removed}` });
  }

  /**
   * The composer, drawn once per reader: the prompt, a new session's workspace, the access chip, the host and model chip
   * (the host locked in a thread), Send, and the status line. syncComposer() and syncMenus() keep it current, so a live
   * event never takes the textarea's focus, an open menu or the caret.
   */
  private buildComposer(wrap: HTMLElement): Pick<ReaderEls, "input" | "send" | "error" | "status"> {
    const col = wrap.createDiv({ cls: "aos-ss-column" });
    const isNew = this.selected === NEW;
    const box = col.createDiv({ cls: "aos-ss-composer" });
    const input = box.createEl("textarea", { cls: "aos-ss-input", attr: { rows: "2", "aria-label": "Message" } });
    input.value = this.text;
    input.addEventListener("input", () => { this.text = input.value; });
    input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void this.submit(); }
    });
    const bar = box.createDiv({ cls: "aos-ss-toolbar" });
    const choices = hostChoices(readAgenticosJson(this.plugin.claudeConfigDir()), readProviderState(this.plugin.vaultRoot()));
    if (isNew) this.renderWorkspacePicker(bar);   // the workspace first, then what the agent may do in it
    const access = new AccessMenu(bar, { host: null, value: this.accessValue(), onChange: (level) => this.pickAccess(level) });
    bar.createSpan({ cls: "aos-ss-spacer" });
    const hostMenu = new HostModelMenu(bar, {
      mode: isNew ? "new" : "thread",
      catalog: this.catalog,
      choices,
      value: this.menuValue(),
      remembered: this.remembered(),
      refreshing: this.refreshing,
      onChange: (v) => this.pickModel(v),
      onRefresh: () => void this.loadCatalog(true),
      onNewSessionOn: isNew ? undefined : (h) => this.newSessionOn(h),
      usedModel: this.thread?.model,   // the thread's recorded model, tagged "used so far" when another is picked
    });
    const send = bar.createEl("button", { cls: "aos-ss-send", attr: { type: "button", "aria-label": "Send", title: "Send (⌘↵)" } });
    setIcon(send, "arrow-up");
    send.addEventListener("click", () => void this.submit());
    const host = hostMenu.value().host;
    const slash = new SlashMenu(input, box, { commands: this.commands(host), host: host ?? "claude" });
    this.menus = { host: hostMenu, access, slash };
    this.accessShown = "";
    this.hostDisabled = false;
    this.syncAccess();
    const error = col.createDiv({ cls: "aos-ss-composererror", attr: { role: "alert" } });
    const status = col.createDiv({ cls: "aos-ss-statusline" });
    return { input, send, error, status };
  }

  /** The new session's workspace: a chip around the folder names under workspaces/. */
  private renderWorkspacePicker(bar: HTMLElement): void {
    const names = this.workspaces();
    if (!names.includes(this.workspace)) this.workspace = names[0] ?? "";
    if (!names.length) { bar.createSpan({ cls: "aos-ss-note aos-ss-noworkspace", text: "No workspaces yet: add a folder under workspaces/." }); return; }
    const chip = bar.createEl("label", { cls: "aos-ss-wschip", attr: { title: "Workspace" } });
    const icon = chip.createSpan({ cls: "aos-ss-wschipicon" });
    setIcon(icon, "folder");
    const sel = chip.createEl("select", { cls: "dropdown aos-ss-workspace", attr: { "aria-label": "Workspace" } });
    for (const n of names) sel.createEl("option", { text: n, value: n });
    sel.value = this.workspace;
    sel.addEventListener("change", () => { this.workspace = sel.value; this.syncComposer(); });
  }

  /** Hands the menus the catalog, the remembered choices and the value they start from. */
  private syncMenus(): void {
    const m = this.menus;
    if (!m) return;
    this.hostDisabled = this.sending;
    m.host.update({ catalog: this.catalog, value: this.menuValue(), remembered: this.remembered(), refreshing: this.refreshing, disabled: this.sending, usedModel: this.thread?.model });
    const host = m.host.value().host;
    m.slash.update(this.commands(host), host ?? "claude");
    this.syncAccess();
  }

  /** The access chip follows the host (Codex's sandbox note) and the level; redrawn only when one of them changed. */
  private syncAccess(): void {
    const m = this.menus;
    if (!m) return;
    const host = m.host.value().host;
    const value = this.accessValue();
    const shown = `${host}|${value}|${this.sending}`;
    if (shown === this.accessShown) return;
    this.accessShown = shown;
    m.access.update({ host, value, disabled: this.sending });
  }

  private syncComposer(): void {
    const r = this.r;
    if (!r || !this.active()) return;
    const isNew = this.selected === NEW;
    const host = this.menus?.host.value().host ?? null;
    const running = !isNew && turnOpen(this.events);
    r.input.disabled = this.sending;
    r.input.setAttr("placeholder", isNew ? "What should the agent do?" : this.thread ? `Reply to ${HOST_LABEL[this.thread.host]}…   / for commands` : "Reply…");
    r.send.disabled = this.sending || running || (isNew && (!this.workspace || !host));
    r.send.toggleClass("is-busy", this.sending);
    r.error.setText(this.composerError ?? "");
    if (this.menus && this.hostDisabled !== this.sending) {
      this.hostDisabled = this.sending;
      this.menus.host.update({ disabled: this.sending });
    }
    this.syncAccess();
    this.renderStatus();
  }

  /** The mono line under the composer: the next turn's model · effort · access, the spend, the branch and files. */
  private renderStatus(): void {
    const el = this.r?.status;
    if (!el || !this.active()) return;
    el.empty();
    const v = this.menus?.host.value();
    if (v?.host) el.createSpan({ cls: "aos-ss-statuschoice", text: `${choiceText(v.host, catalogHost(this.catalog, v.host), v.model, v.effort)} · ${accessLabel(this.accessValue())}` });
    const thread = this.isThread(this.selected);
    const spend: string[] = [];
    const turn = thread ? lastTurnUsd(this.events) : null;
    if (turn) spend.push(`turn ${turn.estimated ? "≈" : ""}${usdText(turn.usd)}`);
    if (this.spend) spend.push(`today ${spendLine(this.spend.spent, this.spend.cap).text}`);
    if (spend.length) el.createSpan({ cls: "aos-ss-statusspend", text: spend.join(" · ") });
    const st = thread ? this.repoStatus() : null;
    if (st?.repo) {
      const n = st.files.length;
      el.createSpan({ cls: "aos-ss-statusrepo", text: `${st.branch ?? "detached HEAD"} · ${n} file${n === 1 ? "" : "s"}` });
    }
  }

  private destroyMenus(): void {
    this.menus?.slash.destroy();
    this.menus?.host.destroy();
    this.menus?.access.destroy();
    this.menus = null;
  }
}
