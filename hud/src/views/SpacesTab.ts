import { Component, MarkdownRenderer, Notice, TFile, canWrite, setIcon } from "obsidian";
import type { TAbstractFile } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { RevealTarget, WorkbenchView } from "./WorkbenchView";
import { LinkRepoModal } from "../ui/LinkRepoModal";
import { loadSnapshot, type Snapshot, type WorkspaceEntry } from "../data/snapshot";
import { indexMap, loadWorkspaceMap, type MapIndex, type WorkspaceMap } from "../data/workspaceMaps";
import { listDir, readPreview, type DirEntry, type PreviewResult } from "../data/workspaceFiles";
import { StaleTodoError, TODO_PATH, addTodo as addTodoLine, composeBody, editTodo, parseTodos, type Todo } from "../data/todos";
import { adapterOf as todoAdapter, applyTodoEdit } from "../data/todoWriter";
import { PROPOSALS_DIR, isProposalFile, parseProposal, type Proposal } from "../data/proposals";
import { parseMemoryMeta, type MemoryMeta } from "../data/memories";
import { readProviderState } from "../data/aosConfig";
import {
  KEBAB_RE, WS_RE, entryByName, flippingNotes, groupOf, linkedCounts, linkedFor, liveByWorkspace, manifestList, matchesQuery, movePlan,
  noteHoldsStatus, spaceList, todoLinkSuggestions, workspaceArgs, workspaceSlug, SESSIONS_OFF_TEXT,
  type Linked, type LinkedCounts, type LinkedSources, type LiveState, type LiveTerminalInput, type ManifestStatus, type ResumeRef,
} from "../data/spacesModel";
import { launchLine, placeOf, quickHost, repoValue, workspacePlace, type PlaceWorld, type TermHost, type TermHostChoice } from "../data/terminalLaunch";
import type { OutsideListRow } from "../data/hostSessions";
import { shortenCwd } from "../data/hostSessions";
import { sanitizeTerminalChoice } from "../settingsDefaults";
import { listen } from "../data/listen";
import type { TerminalSession } from "../data/terminalSession";
import { env, fs, sessionsHost, shell, type HostSessionThread } from "../host";
import {
  PROJECT_NOTES_DIR, entryAbs, entryPlace, freshUiState, keepPlace, panesFor, statusMenuItems, targetFor, threadSignature, threadsIn,
  verbsOff, watchFlags,
  type CloneState, type Flag, type HiddenFolder, type MenuItem, type Pane, type SpacesActions, type SpacesCtx, type SpacesUiState,
} from "./spaces/ui";
import { NewSpaceModal, cloneLine, newSpaceArgs, renameName, type NewSpaceRequest } from "../ui/spaces/NewSpaceModal";
import { DraftModal, draftBase } from "../ui/spaces/DraftModal";
import { LinkTodosModal, MoveConfirmModal, TodoForSpaceModal, WorkspacePickerModal } from "../ui/spaces/SpaceDialogs";
import { openPopover, type PopoverHandle } from "./spaces/Popover";
import { renderList, renderOutside } from "./spaces/ListPane";
import { renderDossier, renderViewTabs } from "./spaces/DossierPane";
import { renderPickup } from "./spaces/PickupCard";
import { renderOverview } from "./spaces/OverviewPane";
import { openFolders, renderFiles } from "./spaces/FilesPane";
import { renderPreview } from "./spaces/PreviewPane";
import { renderHistory } from "./spaces/HistoryPane";
import { renderLinked, renderRightFooter } from "./spaces/LinkedPane";

const ALL_FLAGS: readonly Flag[] = ["snapshot", "threads", "linked", "live", "world", "map", "listing"];
const ALL_PANES: readonly Pane[] = ["list", "centre", "right"];
/** A Sessions event that can start or end a turn (D26's live dot); the text and tool events of a running turn are not. */
const TURN_EVENTS = new Set(["prompt", "session", "done", "error"]);
/** The outside folders the user hid (collectors/hostSessions.js readHidden): `{schema: 1, paths: [...]}`. */
const HIDDEN_OUTSIDE_PATH = "brain/_index/workspaces-hidden.json";
/** How long a workspace a verb just made or renamed is waited for in the snapshot before it is selected. */
const SELECT_WAIT_MS = 60_000;
/** Archive, Restore and Rename move, rebuild BRAIN.md and rescan before they answer: on a large vault that outlasts the
 *  default 60 s, and a kill then would report a failure for a move that happened. */
const MOVE_TIMEOUT_MS = 180_000;
/** The most folders the Files tree reads at once (open ones and, under a filter, the ones holding a match). */
const MAX_LISTINGS = 400;
const DEBOUNCE_MS = 250;

/**
 * SPACES — where you pick a project back up (spec 2026-10-09-spaces-redesign, PR 2: D3–D10, D19). Three panes: the
 * list (spaces/ListPane), the dossier with its pick-up card and Overview · Files (DossierPane, PickupCard, OverviewPane,
 * FilesPane), and the right pane, HISTORY over LINKED (HistoryPane, LinkedPane) or the file preview while Files is open
 * (PreviewPane). This class is the orchestrator: it watches what the panes read (snapshot.json, the maps,
 * brain/_index/sessions/**, workspaces/x/workspace.md, TODO.md, persona/proposals/, brain/memory/projects/), the
 * terminal pool and the Sessions events, through one 250 ms debounce, reads only what changed, and redraws only the
 * panes that show it, keeping focus and scroll (the AgentTeamsTab pattern). It writes no workspace file itself: Resume,
 * Terminal and New session are Code terminals, map and regen are runtime scripts, and PR 3's actions (New, Adopt, Hide,
 * Archive, Restore, Rename, Pin, status, Draft, Link code folder; D13–D18) run named `aos workspace` verbs through the
 * spaces surface, every move after its confirmation (§6). + to-do and Link to-dos… go through the To-Do surface's
 * writer (D35).
 */
export class SpacesTab {
  private host: HTMLElement | null = null;
  private els: { root: HTMLElement; list: HTMLElement; main: HTMLElement; centre: HTMLElement; right: HTMLElement } | null = null;
  private snapshot: Snapshot | null = null;
  private loaded = false;
  private ui: SpacesUiState = freshUiState();
  private map: WorkspaceMap | null = null;
  private index: MapIndex = indexMap(null);
  private mapFor: string | null | undefined = undefined;
  private listings = new Map<string, DirEntry[] | null>();
  private listingsFor: string | null = null;
  private threads: HostSessionThread[] = [];
  private live = new Map<string, LiveState>();
  private sources: LinkedSources = {};
  /** Each project note's frontmatter as last read, so Archive's and Restore's confirmations name only the notes whose
   *  status/ tag flips now (flippingNotes `holds`; spaces-redesign D17). */
  private noteFront = new Map<string, string>();
  private linkedBy = new Map<string, Linked>();
  private counts = new Map<string, LinkedCounts>();
  private envCache: { at: number; world: PlaceWorld; choices: TermHostChoice[]; provider: string; sessions: boolean } | null = null;
  private dirty = new Set<Flag>();
  private debounce: number | null = null;
  private loading = false;
  private listenersRegistered = false;
  private detach: Array<() => void> = [];
  private popover: PopoverHandle | null = null;
  private popoverAnchor: HTMLElement | null = null;
  private pendingPanes = new Set<Pane>();
  private pendingReveal: RevealTarget | null = null;
  /** After the next draw: bring the revealed thread, a right-pane section or the selected row into view; focus the
   *  element with this data-spc-key (leaving the outside list). */
  private after: { scroll: "target" | "history" | "linked" | null; row: boolean; top: boolean; focus: string | null } = { scroll: null, row: false, top: false, focus: null };
  /** What the right pane last drew (rightKey): while it is the preview, only a change of what it shows redraws it. */
  private rightDrawn: string | null = null;
  /** The last preview read, drawn at once by the next redraw of the same file (PreviewPane). */
  private previewCache: { abs: string; res: PreviewResult } | null = null;
  /** Owns what the preview's Markdown renderer attaches; loaded per mount. */
  private md: Component | null = null;
  /** Outside folders the user hid, for Unhide (read with the snapshot). */
  private hiddenOutside: HiddenFolder[] = [];
  /** Clones New space typed into a Code terminal, by workspace name (D15): the dossier offers Start <host> here. */
  private clones = new Map<string, { url: string; host: "claude" | "codex" | null }>();
  /** A workspace a verb made, renamed or restored: selected once the snapshot lists it. */
  private wantSelect: { name: string; until: number } | null = null;
  /** A verb that is running (one at a time from this tab). */
  private acting: string | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    // setTab() empties the content area without an unmount: a menu left open on the last visit is gone with it, and
    // must not hold back this mount's draws.
    this.pendingPanes.clear();
    this.els = null;
    this.rightDrawn = null;
    this.popover?.close(false);
    this.popover = null;
    this.md?.unload();
    this.md = new Component();
    this.md.load();
    this.registerVaultEvents();
    this.attachLive();
    host.empty();
    const root = host.createDiv({ cls: "aos-spc" });
    const list = root.createEl("aside", { cls: "aos-spc-list", attr: { "aria-label": "Workspaces" } });
    const main = root.createDiv({ cls: "aos-spc-main" });
    const centre = main.createEl("section", { cls: "aos-spc-centre", attr: { "aria-label": "Workspace", "data-spc-scroll": "centre" } });
    const right = main.createEl("aside", { cls: "aos-spc-right", attr: { "aria-label": "History and linked work", "data-spc-scroll": "right" } });
    this.els = { root, list, main, centre, right };
    this.draw(ALL_PANES);
  }

  unmount(): void {
    if (this.debounce !== null) { window.clearTimeout(this.debounce); this.debounce = null; }
    this.pendingPanes.clear();
    this.popover?.close(false);
    this.popover = null;
    this.md?.unload();
    this.md = null;
    for (const d of this.detach) d();
    this.detach = [];
    this.host?.empty();
    this.host = null;
    this.els = null;
  }

  /** Reads everything again (WorkbenchView.setTab calls this after mount). */
  async refresh(): Promise<void> {
    for (const f of ALL_FLAGS) this.dirty.add(f);
    this.envCache = null;
    await this.load();
  }

  /** The workspace whose dossier is open: what ⌘T starts next to while Spaces is shown (spec 2026-10-08-term-agent-deck T4). */
  selectedWorkspace(): string | null { return this.ui.selected; }

  /**
   * Spaces on a workspace (spaces-redesign D12: WorkbenchView.open and the agenticos://workbench link): selects
   * `workspace` (showing archived and _ folders when it is one), shows `pane` (overview or files in the centre; history
   * or linked in the right pane) and marks `thread` in History. Select only: it never resumes, opens a terminal,
   * drafts or runs a verb. A name the snapshot does not hold is ignored.
   */
  reveal(target: RevealTarget): void {
    this.pendingReveal = { ...target };
    this.kick(["select"]);
  }

  // ── events ──

  private registerVaultEvents(): void {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;
    const vault = this.plugin.app.vault;
    const on = (f: TAbstractFile, modify: boolean, old?: string) => {
      const flags = [...this.flagsFor(f.path, modify), ...(old !== undefined ? this.flagsFor(old, modify) : [])];
      if (flags.length) this.schedule(flags);
    };
    this.view.registerEvent(vault.on("modify", (f) => on(f, true)));
    this.view.registerEvent(vault.on("create", (f) => on(f, false)));
    this.view.registerEvent(vault.on("delete", (f) => on(f, false)));
    this.view.registerEvent(vault.on("rename", (f, old) => on(f, false, old)));
  }

  private flagsFor(p: string, modify: boolean): Flag[] {
    return watchFlags(p, { selected: this.ui.selected, selectedPath: this.entry()?.path ?? null, modify });
  }

  /** The terminal pool and the Sessions events, owned by this mount and removed in unmount() (spec 2026-09-24 D1). */
  private attachLive(): void {
    for (const d of this.detach) d();
    this.detach = [];
    const pool = this.plugin.terminalPool;
    if (pool) {
      const live = () => this.schedule(["live"]);
      this.detach.push(listen(pool, {
        "session-add": live, "session-remove": live, "session-exit": live,
        "session-update": (s: unknown) => { if ((s as TerminalSession | undefined)?.isExited) live(); },
      }));
    }
    const sh = sessionsHost();
    if (sh) this.detach.push(sh.sessions.onEvent((ev) => { if (TURN_EVENTS.has(ev.event.kind)) this.schedule(["threads"]); }));
  }

  private schedule(flags: Flag[]): void {
    if (!this.host || !this.view.isTabActive("spaces")) return;   // setTab's refresh() reads everything on the way back
    for (const f of flags) this.dirty.add(f);
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => { this.debounce = null; void this.load(); }, DEBOUNCE_MS);
  }

  /** A user action: read what it needs now, without the debounce. */
  private kick(flags: Flag[]): void {
    for (const f of flags) this.dirty.add(f);
    void this.load();
  }

  /** Reads one batch of flags at a time, in order: a flag raised while a read is running is read right after it. */
  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      while (this.dirty.size) {
        const flags = this.dirty;
        this.dirty = new Set();
        const panes = await this.apply(flags);
        this.draw(panes);
      }
    } finally { this.loading = false; }
  }

  private async apply(flags: Set<Flag>): Promise<Set<Pane>> {
    /** The flags whose data really changed; panesFor turns them into panes at the end, once the reads are in. */
    const changed = new Set(flags);
    const panes = new Set<Pane>();
    if (flags.has("snapshot") || flags.has("world")) this.envCache = null;
    if (flags.has("snapshot")) {
      let next: Snapshot | null = null;
      try { next = await loadSnapshot(this.plugin.app); } catch { next = null; }
      // A read that fails (an upgrade swapping files, a partial copy) keeps the last good scan, and with it the
      // selection, the Files state and the preview; only a vault that never had one reads as none.
      if (next || !this.snapshot) this.snapshot = next;
      this.loaded = true;
      this.hiddenOutside = await this.loadHiddenOutside();
      this.applyWantSelect();
    }
    if (flags.has("threads")) {
      // A re-list that reads the same (no thread came or went, none started or stopped) redraws nothing.
      const next = await this.listThreads();
      if (threadSignature(next) === threadSignature(this.threads)) changed.delete("threads");
      this.threads = next;
    }
    if (flags.has("linked")) this.sources = await this.loadSources();
    if (flags.has("snapshot") || flags.has("linked")) this.computeLinked();
    this.live = this.computeLive();

    const before = this.ui.selected;
    if (this.applyReveal()) for (const p of ALL_PANES) panes.add(p);
    this.ensureSelection();
    if (this.ui.selected !== before) {
      this.resetFiles();
      this.after.top = true;
      for (const p of ALL_PANES) panes.add(p);
      // A menu built for the last workspace would act on this one (a link or a rescan moved the selection): close it.
      this.closeMenu();
    }
    const sel = this.ui.selected;
    if (sel !== this.mapFor || flags.has("map")) {
      const map = sel ? await loadWorkspaceMap(this.plugin.app, sel) : null;
      // Another workspace was picked during the read: never draw it with this one's map; the next batch reads its own.
      if (sel !== this.ui.selected) { this.dirty.add("select"); return new Set(); }
      this.map = map;
      this.index = indexMap(this.map);
      this.mapFor = sel;
      panes.add("centre");
      panes.add("right");
    }
    if (sel !== this.listingsFor || flags.has("listing")) { this.listings = new Map(); this.listingsFor = sel; }
    if (this.ui.centre === "files") {
      await this.ensureListings();
      if (sel !== this.ui.selected) { this.dirty.add("select"); return new Set(); }
    }
    for (const p of panesFor(changed, { previewShown: this.ui.centre === "files", rightChanged: this.rightKey() !== this.rightDrawn })) panes.add(p);
    return panes;
  }

  /** What the right pane shows: the preview of a file of a workspace, or that workspace's History and Linked. */
  private rightKey(): string {
    const sel = this.ui.selected ?? "";
    return this.ui.centre === "files" ? `files:${sel}:${this.ui.files.preview ?? ""}` : `${this.ui.centre}:${sel}`;
  }

  // ── reads ──

  private async listThreads(): Promise<HostSessionThread[]> {
    try {
      const h = sessionsHost();
      const r = h ? await h.sessions.list() : null;
      return r?.ok ? r.data : [];
    } catch { return []; }   // no sessions host (plain Node)
  }

  /** What Linked reads (D27): TODO.md, the pending proposals and the project notes. */
  private async loadSources(): Promise<LinkedSources> {
    const a = this.plugin.app.vault.adapter;
    let todos: Todo[] = [];
    try { if (await a.exists(TODO_PATH)) todos = parseTodos(await a.read(TODO_PATH)); } catch { /* unreadable: none */ }
    const proposals: Proposal[] = [];
    try {
      const names = (await a.list(PROPOSALS_DIR)).files.map((f) => f.split("/").pop() ?? "").filter(isProposalFile);
      for (const n of names) { try { proposals.push(parseProposal(n, await a.read(`${PROPOSALS_DIR}/${n}`))); } catch { /* gone */ } }
    } catch { /* no persona/ yet */ }
    const memories: MemoryMeta[] = [];
    const front = new Map<string, string>();
    try {
      const files = (await a.list(PROJECT_NOTES_DIR)).files.filter((f) => f.endsWith(".md"));
      for (const f of files) {
        try {
          const text = await a.read(f);
          memories.push(parseMemoryMeta(f, text));
          front.set(f, /^---\r?\n[\s\S]*?\r?\n---/.exec(text)?.[0] ?? "");
        } catch { /* gone */ }
      }
    } catch { /* no project notes yet */ }
    this.noteFront = front;
    return { todos, proposals, memories };
  }

  private computeLinked(): void {
    this.linkedBy = new Map();
    this.counts = new Map();
    const opts = { vault: this.plugin.vaultRoot(), home: env.homedir() };
    for (const e of this.entries()) {
      const l = linkedFor(e, this.sources, opts);
      this.linkedBy.set(e.name, l);
      this.counts.set(e.name, linkedCounts(l));
    }
  }

  /** brain/_index/workspaces-hidden.json's paths, as stored (Unhide passes them back exactly). */
  private async loadHiddenOutside(): Promise<HiddenFolder[]> {
    let j: unknown = null;
    try {
      const a = this.plugin.app.vault.adapter;
      if (await a.exists(HIDDEN_OUTSIDE_PATH)) j = JSON.parse(await a.read(HIDDEN_OUTSIDE_PATH));
    } catch { return []; }
    const list: unknown[] = Array.isArray(j) ? j : j && typeof j === "object" && Array.isArray((j as { paths?: unknown }).paths) ? (j as { paths: unknown[] }).paths : [];
    const home = env.homedir();
    const out: HiddenFolder[] = [];
    for (const p of list) {
      const stored = typeof p === "string" ? p : p && typeof p === "object" && typeof (p as { path?: unknown }).path === "string" ? (p as { path: string }).path : null;
      if (!stored || out.some((h) => h.stored === stored)) continue;
      out.push({ stored, label: stored.startsWith("/") ? shortenCwd(stored, home) : stored });
    }
    return out;
  }

  /** Selects the workspace a verb made, renamed or restored, once the snapshot lists it (or gives up after a minute). */
  private applyWantSelect(): void {
    const w = this.wantSelect;
    if (!w) return;
    if (Date.now() > w.until) { this.wantSelect = null; return; }
    const e = entryByName(this.snapshot, w.name);
    if (!e) return;
    this.wantSelect = null;
    this.pendingReveal = { workspace: e.name };
  }

  /** D26: Code terminals placed in a workspace and Sessions threads mid-turn. */
  private computeLive(): Map<string, LiveState> {
    let terminals: LiveTerminalInput[] = [];
    try {
      let world: PlaceWorld | null = null;
      terminals = this.plugin.terminalPool.list().map((s) => ({ place: s.meta.place ?? placeOf(s.cwd, (world ??= this.env().world)), exited: s.isExited }));
    } catch { /* no terminals */ }
    return liveByWorkspace(this.threads.map((t) => ({ workspace: t.workspace, running: t.running })), terminals);
  }

  /** Listings for the Files tree: the root, every open folder below an open one, and the folders holding a match. */
  private async ensureListings(): Promise<void> {
    const e = this.entry();
    if (!e) return;
    const name = e.name;
    const root = entryAbs(e, this.plugin.vaultRoot());
    const open = openFolders({ ui: this.ui, index: this.index });
    const queue = [""];
    let n = 0;
    while (queue.length && n++ < MAX_LISTINGS) {
      const rel = queue.shift()!;
      let entries = this.listings.get(rel);
      if (entries === undefined) {
        try { entries = await listDir(rel ? path.join(root, rel) : root); } catch { entries = null; }
        if (this.listingsFor !== name) return;   // another workspace was picked meanwhile
        this.listings.set(rel, entries);
      }
      for (const d of entries ?? []) {
        if (!d.isDir) continue;
        const child = rel ? `${rel}/${d.name}` : d.name;
        if (open.has(child)) queue.push(child);
      }
    }
  }

  /** The world, the host choices and the provider: read from disk at most every two seconds, and again after a scan. */
  private env(): { world: PlaceWorld; choices: TermHostChoice[]; provider: string; sessions: boolean } {
    const c = this.envCache;
    if (c && Date.now() - c.at < 2000) return c;
    const launcher = this.plugin.termLauncher;
    let provider = "none";
    try { provider = readProviderState(this.plugin.vaultRoot())?.name ?? "none"; } catch { /* unreadable: none */ }
    const next = { at: Date.now(), world: launcher.world(), choices: launcher.choices(), provider, sessions: this.plugin.chatAvailable() };
    this.envCache = next;
    return next;
  }

  // ── selection ──

  private entries(): WorkspaceEntry[] {
    return (this.snapshot?.workspaces ?? []).filter((e): e is WorkspaceEntry => !!e && typeof e.name === "string" && !!e.name);
  }

  private entry(): WorkspaceEntry | null {
    const s = this.ui.selected;
    return s ? this.entries().find((e) => e.name === s) ?? null : null;
  }

  /** Keeps the selection while it is listed (a hidden one only while hidden ones show); else the first listed row. */
  private ensureSelection(): void {
    if (!this.loaded) return;
    const all = this.entries();
    const cur = all.find((e) => e.name === this.ui.selected);
    if (cur && (!cur.hidden || this.ui.showHidden)) return;
    const first = spaceList(all, { showHidden: this.ui.showHidden }).groups.flatMap((g) => g.entries)[0];
    this.ui.selected = first?.name ?? null;
  }

  private applyReveal(): boolean {
    const r = this.pendingReveal;
    if (!r || !this.loaded) return false;
    this.pendingReveal = null;
    const e = r.workspace ? entryByName(this.snapshot, r.workspace) : null;
    if (e) {
      if (e.hidden) this.ui.showHidden = true;
      // A typed filter that leaves the revealed workspace out would hide its row while its dossier shows: clear it.
      if (this.ui.query && !matchesQuery(e, this.ui.query)) this.ui.query = "";
      this.ui.groupOpen.set(groupOf(e), true);
      if (this.ui.selected !== e.name) { this.ui.selected = e.name; this.resetFiles(); this.after.top = true; }
      this.after.row = true;
    }
    if (r.pane === "overview" || r.pane === "files") this.ui.centre = r.pane;
    else if ((r.pane === "history" || r.pane === "linked" || r.thread) && this.ui.centre !== "overview") this.ui.centre = "overview";
    else if (e && this.ui.centre === "outside") this.ui.centre = "overview";
    this.ui.target.thread = r.thread ?? null;
    if (r.thread) { this.ui.history = "all"; this.after.scroll = "target"; }
    else if (r.pane === "history" || r.pane === "linked") this.after.scroll = r.pane;
    return true;
  }

  private resetFiles(): void {
    this.ui.files = { filter: "all", query: "", open: new Set(), preview: null };
  }

  // ── draw ──

  private ctx(): SpacesCtx {
    const en = this.env();
    const entry = this.entry();
    return {
      snapshot: this.snapshot, loaded: this.loaded, entries: this.entries(), entry, ui: this.ui, now: Date.now(),
      home: env.homedir(), vault: this.plugin.vaultRoot(), world: en.world, choices: en.choices, quick: this.quickAgent(en.choices),
      provider: en.provider, sessionsAvailable: en.sessions, live: this.live, counts: this.counts,
      linked: entry ? this.linkedBy.get(entry.name) ?? null : null,
      threads: this.threads, map: this.map, index: this.index, listings: this.listings,
      cachedPreview: (abs) => (this.previewCache?.abs === abs ? this.previewCache.res : null),
      renderMarkdown: (el, text, sourcePath) => {
        if (this.md) void MarkdownRenderer.renderMarkdown(text, el, sourcePath, this.md);
        else el.createEl("pre", { cls: "aos-spc-pre", text });
      },
      // The hint is the line a resume types (D7): the configured binary, and for Codex `-C <folder>`.
      resumeLine: (host, id, cwd) => {
        try { return launchLine(this.plugin.termLauncher.spec(host, { resume: { id }, cwd })); } catch { return null; }
      },
      setIcon: (el, id) => setIcon(el, id),
      act: this.actions(),
      todoWritable: this.todoWritable(),
      hiddenOutside: this.hiddenOutside,
      clone: entry ? this.cloneState(entry.name) : null,
    };
  }

  /** Whether the To-Do surface may write TODO.md: compat's canWrite asks the host's page policy (display only; main
   *  checks the write itself). */
  private todoWritable(): boolean {
    try { return canWrite(path.join(this.plugin.vaultRoot(), TODO_PATH)); } catch { return false; }
  }

  /** A clone typed into this workspace's folder, and whether its line has ended (its stubs step wrote workspace.md). */
  private cloneState(name: string): CloneState | null {
    const c = this.clones.get(name);
    if (!c) return null;
    let done = false;
    try { done = fs.existsSync(path.join(this.plugin.vaultRoot(), "workspaces", name, "workspace.md")); } catch { /* unreadable: not yet */ }
    return { url: c.url, host: c.host, done };
  }

  /** The agent ⌘T would start (the one last launched from the deck, else the first ready one), for Start in Code. */
  private quickAgent(choices: TermHostChoice[]): "claude" | "codex" | null {
    const q = quickHost(sanitizeTerminalChoice(this.plugin.settings.terminalChoice).host, choices).host;
    return q === "claude" || q === "codex" ? q : null;
  }

  private draw(panes: Iterable<Pane>): void {
    const set = new Set(panes);
    if (!set.size || !this.els || !this.view.isTabActive("spaces")) return;
    // An open menu stays: what changed under it is drawn when it closes.
    if (this.popover) { for (const p of set) this.pendingPanes.add(p); return; }
    const els = this.els;
    const ctx = this.ctx();
    els.main.toggleClass("is-outside", this.ui.centre === "outside");
    els.main.toggleClass("is-files", this.ui.centre === "files");
    for (const p of ALL_PANES) {
      if (!set.has(p)) continue;
      const el = els[p];
      keepPlace(el, () => { el.empty(); this.renderPane(p, el, ctx); }, [els.main, els.root]);
    }
    if (set.has("right")) this.rightDrawn = this.rightKey();
    this.afterDraw();
  }

  private renderPane(p: Pane, el: HTMLElement, ctx: SpacesCtx): void {
    const e = ctx.entry;
    if (p === "list") { renderList(el, ctx); return; }
    if (p === "centre") {
      if (!ctx.loaded) { el.createDiv({ cls: "aos-spc-empty aos-spc-pad", text: "Reading the vault's scan…" }); return; }
      if (ctx.ui.centre === "outside") { renderOutside(el, ctx); return; }
      if (!e) {
        el.createDiv({ cls: "aos-spc-empty aos-spc-pad", text: ctx.entries.length ? "Pick a workspace on the left." : "No workspaces yet: + New makes one in Code." });
        return;
      }
      renderDossier(el, ctx, e);
      renderPickup(el, ctx, e);
      renderViewTabs(el, ctx);
      const files = ctx.ui.centre === "files";
      const panel = el.createDiv({ cls: `aos-spc-body${files ? " is-files" : ""}`, attr: { id: "aos-spc-viewpanel", role: "tabpanel", "aria-label": files ? "Files" : "Overview" } });
      if (files) renderFiles(panel, ctx, e);
      else renderOverview(panel, ctx, e);
      return;
    }
    if (!ctx.loaded || !e || ctx.ui.centre === "outside") return;
    if (ctx.ui.centre === "files") { renderPreview(el, ctx, e); return; }
    renderHistory(el, ctx, e);
    renderLinked(el, ctx);
    renderRightFooter(el, ctx, e);
  }

  private afterDraw(): void {
    const els = this.els;
    if (!els) return;
    const a = this.after;
    this.after = { scroll: null, row: false, top: false, focus: null };
    if (a.top) {
      // Whichever element scrolls in this layout: the panes (wide), the dossier column (≤ 1100 px), the tab (≤ 760 px,
      // where only the dossier's top is brought back into view, the list above it left as it was).
      els.centre.scrollTop = 0;
      els.right.scrollTop = 0;
      els.main.scrollTop = 0;
      if (els.root.scrollTop > els.main.offsetTop) els.root.scrollTop = els.main.offsetTop;
    }
    if (a.focus) els.root.querySelector<HTMLElement>(`[data-spc-key="${a.focus}"]`)?.focus({ preventScroll: true });
    if (a.row) els.list.querySelector<HTMLElement>(".aos-spc-row.is-selected")?.scrollIntoView({ block: "nearest" });
    if (a.scroll === "target") els.right.querySelector<HTMLElement>(".aos-spc-hrow.is-target")?.scrollIntoView({ block: "nearest" });
    else if (a.scroll) {
      const h = els.right.querySelector<HTMLElement>(`#aos-spc-${a.scroll}-h`);
      h?.scrollIntoView({ block: "start" });
      h?.focus({ preventScroll: true });
    }
  }

  // ── actions ──

  private actions(): SpacesActions {
    return {
      select: (name) => this.select(name),
      reselect: () => this.kick(["select"]),
      redraw: (panes) => this.draw(panes),
      tree: () => this.kick(["tree"]),
      showOutside: (on, name) => {
        // Leaving the list keeps the keyboard's place: a Matches link lands on the workspace's title, Back on the
        // footer's "Outside workspaces (n)" (the focused button is gone with the list).
        if (!on && name) { this.after.focus = "title"; this.select(name); return; }
        this.ui.centre = on ? "outside" : "overview";
        this.after.top = true;
        if (!on) this.after.focus = "outside";
        this.draw(ALL_PANES);
      },
      newSpace: () => this.newSpace(),
      resume: (ref) => void this.resume(ref),
      newSession: (host) => void this.launch(host),
      terminal: () => void this.launch("shell"),
      finder: () => { const e = this.entry(); if (e) this.openPath(entryAbs(e, this.plugin.vaultRoot())); },
      revealInFinder: (abs) => { try { shell.showItemInFolder(abs); } catch { new Notice(`Cannot reveal ${abs}`); } },
      openPath: (abs) => this.openPath(abs),
      copy: (text) => this.copy(text),
      linkCodeFolder: () => this.linkCodeFolder(),
      openSessions: (thread) => {
        const e = this.entry();
        if (!this.view.open({ tab: "chat", workspace: e?.name ?? null, thread: thread ?? null })) new Notice(SESSIONS_OFF_TEXT);
      },
      openCode: () => { const e = this.entry(); this.view.open({ tab: "term", workspace: e?.name ?? null }); },
      openTab: (tab) => { this.view.open({ tab }); },
      openFile: (p) => void this.openFile(p),
      regen: () => {
        const e = this.entry();
        if (!e) return;
        new Notice(`Regenerating insight for ${e.name}…`);
        this.plugin.regenWorkspaceInsight(e.name);
      },
      mapNow: () => {
        const e = this.entry();
        if (e) this.plugin.runBrainScript("brain/scripts/map-workspace.js", [e.name], () => this.schedule(["map"]));
      },
      describeFile: (rel) => {
        const e = this.entry();
        if (e) this.plugin.runBrainScript("brain/scripts/map-workspace.js", [e.name, "--file", rel], () => this.schedule(["map"]));
      },
      menu: (anchor, items, label) => this.menu(anchor, items, label),
      readPreview: (abs) => readPreview(abs).then(
        (res) => { this.previewCache = { abs, res }; return res; },
        (err: unknown) => { if (this.previewCache?.abs === abs) this.previewCache = null; throw err; },
      ),
      statusMenu: () => this.statusMenu(),
      setStatus: (st) => void this.setStatus(st),
      togglePin: () => void this.togglePin(),
      rename: () => this.rename(),
      archive: () => this.archive(),
      restore: () => this.restore(),
      draft: () => this.draft(),
      adoptInto: (row, name) => this.adoptInto(row, name),
      linkFolder: (row, name) => void this.linkFolder(row, name),
      pickWorkspace: (mode, row) => this.pickWorkspace(mode, row),
      hide: (row) => void this.hide(row),
      unhide: (stored) => void this.unhide(stored),
      addTodo: () => this.addTodo(),
      linkTodos: () => this.linkTodos(),
      startHere: (host) => {
        const e = this.entry();
        if (!e) return;
        this.clones.delete(e.name);
        void this.launch(host);
      },
      dismissClone: () => { const e = this.entry(); if (e) { this.clones.delete(e.name); this.draw(["centre"]); } },
    };
  }

  private select(name: string): void {
    if (name === this.ui.selected && this.ui.centre !== "outside") return;
    if (this.ui.centre === "outside") { this.ui.centre = "overview"; this.after.top = true; }
    if (name !== this.ui.selected) { this.ui.selected = name; this.resetFiles(); this.ui.target.thread = null; this.after.top = true; }
    this.kick(["select"]);
  }

  /** Resume (D7, D31, D32): a Code terminal in the workspace's group, or the thread in Sessions; never the other host. */
  private async resume(ref: ResumeRef): Promise<void> {
    const e = this.entry();
    if (!e || e.name !== ref.workspace) return;
    const en = this.env();
    const t = targetFor({ snapshot: this.snapshot, choices: en.choices, world: en.world, sessionsAvailable: en.sessions }, e, ref);
    if (t.kind === "disabled") { new Notice(t.reason); return; }
    if (t.kind === "sessions") {
      if (!this.view.open({ tab: "chat", workspace: t.workspace, thread: t.thread })) new Notice(SESSIONS_OFF_TEXT);
      return;
    }
    try {
      // The place keeps the workspace, so the terminal joins ws:<name> in Code and the live dot holds (D7, D26).
      await this.view.launchTerminal(t.host, { picked: t.place, resume: { id: t.id }, origin: "Spaces" });
    } catch (err) {
      new Notice(`Resume unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A new session of `host`, or a shell, in the workspace's place (its linked code folder when it has one). */
  private async launch(host: TermHost): Promise<void> {
    const e = this.entry();
    if (!e) return;
    const where = entryPlace(e, this.env().world);
    if (!where.place) { new Notice(where.reason); return; }
    try {
      await this.view.launchTerminal(host, { picked: where.place, origin: "Spaces" });
    } catch (err) {
      new Notice(`Terminal unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private linkCodeFolder(): void {
    const e = this.entry();
    if (!e) return;
    const name = e.name;
    const current = this.env().world.links[name] ?? null;
    new LinkRepoModal(this.plugin.app, name, current, async (typed) => {
      const abs = await this.plugin.termLauncher.linkRepo(name, typed);
      new Notice(abs ? `${name} is linked to ${abs}` : `${name} is no longer linked`);
      this.envCache = null;
      this.kick(["world"]);
      this.rescan();
      return abs;
    }).open();
  }

  // ── PR 3: the workspace verbs (spaces-redesign D13–D18, D28, D29, D35) ──

  /** The scan again (a background spawn, BACKGROUND in surfaces.ts): what a verb changed shows in the list. */
  private rescan(): void {
    this.envCache = null;
    this.plugin.runBrainScript("brain/scripts/scan-vault.js", ["--quiet"], undefined, { quiet: true });
  }

  /** Runs `fn` unless another verb from this tab is still running; says which. */
  private async once<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.acting) { new Notice(`Wait: ${this.acting} is still running`); return null; }
    this.acting = what;
    try { return await fn(); } finally { this.acting = null; }
  }

  /** Folder names under workspaces/ and the names archived workspaces hold, for New space's and Rename's checks. */
  private names(): { existing: string[]; archived: string[] } {
    const all = this.entries();
    const existing = new Set<string>(this.env().world.workspaces);
    for (const e of all) if (!e.hidden) existing.add(e.name);
    return { existing: [...existing], archived: all.filter((e) => e.hiddenReason === "archived").map((e) => e.label || e.name.replace(/^_archive\//, "")) };
  }

  /** New space (D15): `new <slug> [--git] --pin` then the host in ws:<slug>; Clone: `new <slug> --empty`, then the
   *  clone line typed in a shell there, and no agent until the dossier's Start <host> here. */
  private newSpace(): void {
    const en = this.env();
    const { existing, archived } = this.names();
    new NewSpaceModal(this.plugin.app, {
      vault: this.plugin.vaultRoot(), home: env.homedir(), existing, archived, choices: en.choices,
      quick: this.plugin.termLauncher.quickHost().host,
      create: (req) => this.createSpace(req),
    }).open();
  }

  private async createSpace(req: NewSpaceRequest): Promise<string | null> {
    const launcher = this.plugin.termLauncher;
    let args: string[];
    try { args = newSpaceArgs(req.template, req.slug); } catch (e) { return e instanceof Error ? e.message : String(e); }
    const r = await this.once(`New space ${req.slug}`, () => launcher.verb<{ slug?: unknown; name?: unknown }>(args));
    if (!r) return "Another action is still running";
    if (!r.ok) return r.reason;
    // Only the slug the runtime answers, checked against KEBAB again, goes on to a terminal line (D15).
    const slug = String(r.json.slug ?? r.json.name ?? req.slug);
    if (!KEBAB_RE.test(slug)) return `aos workspace new answered a name Spaces will not use: ${JSON.stringify(slug.slice(0, 60))}`;
    this.wantSelect = { name: slug, until: Date.now() + SELECT_WAIT_MS };
    this.rescan();
    const place = workspacePlace(slug, launcher.world());
    try {
      if (req.template === "clone") {
        const line = cloneLine(req.url ?? "", slug);
        const { session } = await launcher.launch({ host: "shell", picked: place, origin: "Spaces" });
        session.write(`${line}\r`);
        // Only a clone that started gets the dossier's "Cloning …" card.
        this.clones.set(slug, { url: req.url ?? "", host: req.host === "shell" ? null : req.host });
      } else {
        // Code repo: `--git` made the repository; the typed `[ -e .git ] || git init -q` is a no-op then.
        await launcher.launch({ host: req.host, picked: place, gitInit: req.template === "code", origin: "Spaces" });
      }
    } catch (e) {
      new Notice(`${slug} was made, but no terminal opened: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    this.view.open({ tab: "term", workspace: slug });
    return null;
  }

  /** The status menu on the dossier's pill (D18), looked up again: a More item that opens it has just redrawn. */
  private statusMenu(): void {
    const e = this.entry();
    const anchor = this.els?.root.querySelector<HTMLElement>('[data-spc-key="status"]') ?? this.els?.root.querySelector<HTMLElement>('[data-spc-key="more"]');
    if (!e || !anchor || verbsOff(e, this.env().world)) return;
    this.menu(anchor, statusMenuItems(this.ctx(), e), "Status");
  }

  /** Patches the entry the page holds until the rescan lands, so the pill and the pin answer at once. */
  private patch(name: string, fn: (e: WorkspaceEntry) => void): void {
    const e = this.entries().find((x) => x.name === name);
    if (!e) return;
    fn(e);
    this.draw(ALL_PANES);
  }

  private async setStatus(status: ManifestStatus | ""): Promise<void> {
    const e = this.entry();
    if (!e || verbsOff(e, this.env().world)) return;
    const name = e.name;
    const r = await this.once("Set status", () => this.plugin.termLauncher.setManifest(name, { status }));
    if (!r) return;
    if (!r.ok) { new Notice(`Status not set: ${r.reason}`); return; }
    this.patch(name, (x) => {
      x.statusOverride = status || null;
      x.statusSource = status ? "manifest" : "derived";
      x.status = status || x.statusAuto || x.status;
    });
    new Notice(status ? `${name} is ${status}` : `${name}'s status is automatic again`);
    this.rescan();
  }

  private async togglePin(): Promise<void> {
    const e = this.entry();
    if (!e || verbsOff(e, this.env().world)) return;
    const name = e.name;
    const next = !e.pinned;
    const r = await this.once(next ? "Pin" : "Unpin", () => this.plugin.termLauncher.setManifest(name, { pinned: next }));
    if (!r) return;
    if (!r.ok) { new Notice(`${next ? "Pin" : "Unpin"}: ${r.reason}`); return; }
    this.patch(name, (x) => { x.pinned = next; });
    new Notice(next ? `${name} is pinned` : `${name} is unpinned`);
    this.rescan();
  }

  /** Rename (D17): the new name, then the confirmation of what moves; the folder, its map and its threads follow. */
  private rename(): void {
    const e = this.entry();
    if (!e || verbsOff(e, this.env().world)) return;
    const name = e.name;
    const threads = threadsIn(this.threads, name).length;
    const claudeThreads = (e.sessions?.recent ?? []).filter((r) => r && r.host === "claude" && r.kind !== "app").length;
    const ownRepo = e.git?.kind === "repo";
    const o = { vault: this.plugin.vaultRoot(), home: env.homedir(), ...this.names() };
    new MoveConfirmModal(this.plugin.app, {
      plan: movePlan("rename", e, { threads, to: "", claudeThreads, ownRepo }),
      rename: {
        value: KEBAB_RE.test(name) ? name : "",
        check: (typed) => renameName(typed, name, o),
        plan: (slug) => movePlan("rename", e, { threads, to: slug, claudeThreads, ownRepo }),
      },
      run: async (slug) => {
        if (!slug) return "Type the new name";
        const r = await this.once(`Rename ${name}`, () => this.plugin.termLauncher.verb(workspaceArgs.rename(name, slug), MOVE_TIMEOUT_MS));
        if (!r) return "Another action is still running";
        if (!r.ok) return r.reason;
        this.clones.delete(name);
        this.wantSelect = { name: slug, until: Date.now() + SELECT_WAIT_MS };
        new Notice(`Renamed ${name} to ${slug}`);
        this.rescan();
        return null;
      },
    }).open();
  }

  /** Archive (D17): into workspaces/_archive/, restorable; its threads stay listed, read-only until Restore. */
  private archive(): void {
    const e = this.entry();
    if (!e || verbsOff(e, this.env().world)) return;
    const name = e.name;
    const taken = !!entryByName(this.snapshot, `_archive/${name}`) || this.exists(path.join("workspaces", "_archive", name));
    // The notes Archive flips: linked by workspace: or slug, and holding status/active now (cli/workspace.js).
    const notes = flippingNotes(this.linkedBy.get(name), { holds: (p) => noteHoldsStatus(this.noteFront.get(p), "active") });
    const plan = movePlan("archive", e, { threads: threadsIn(this.threads, name).length, sessions: e.sessions?.total ?? 0, notes, archiveTaken: taken });
    new MoveConfirmModal(this.plugin.app, {
      plan,
      run: async () => {
        const r = await this.once(`Archive ${name}`, () => this.plugin.termLauncher.verb(workspaceArgs.archive(name), MOVE_TIMEOUT_MS));
        if (!r) return "Another action is still running";
        if (!r.ok) return r.reason;
        this.clones.delete(name);
        new Notice(`Archived ${name}: Show archived and _ folders lists it, and More › Restore… brings it back`);
        this.rescan();
        return null;
      },
    }).open();
  }

  /** Restore (D17): back to workspaces/<n> (the name Archive recorded, for a dated archive), its tags and threads with it. */
  private restore(): void {
    const e = this.entry();
    if (!e || e.hiddenReason !== "archived") return;
    const name = e.label || e.name.replace(/^_archive\//, "");
    // Archive's record in the archived workspace.md: the notes it flipped and the name it came from (cli/workspace.js).
    let md = "";
    try { md = fs.readFileSync(path.join(this.plugin.vaultRoot(), "workspaces", "_archive", name, "workspace.md"), "utf8"); } catch { /* none: nothing recorded */ }
    const from = manifestList(md, "archivedFrom")[0];
    const back = from && from !== name && WS_RE.test(from) ? from : name;
    const notes = flippingNotes(this.linkedBy.get(e.name), { only: manifestList(md, "archivedNotes"), holds: (p) => noteHoldsStatus(this.noteFront.get(p), "archived") });
    const plan = movePlan("restore", e, { threads: threadsIn(this.threads, back).length, notes, to: back });
    new MoveConfirmModal(this.plugin.app, {
      plan,
      run: async () => {
        let args: string[];
        try { args = workspaceArgs.restore(name); } catch (err) { return err instanceof Error ? err.message : String(err); }
        const r = await this.once(`Restore ${name}`, () => this.plugin.termLauncher.verb(args, MOVE_TIMEOUT_MS));
        if (!r) return "Another action is still running";
        if (!r.ok) return r.reason;
        const restored = typeof r.json.name === "string" && WS_RE.test(r.json.name) ? r.json.name : back;
        this.wantSelect = { name: restored, until: Date.now() + SELECT_WAIT_MS };
        new Notice(restored === name ? `Restored ${name}` : `Restored ${name} as ${restored}`);
        this.rescan();
        return null;
      },
    }).open();
  }

  /** Draft workspace.md (D13, D14): one model call on this click, reviewed before anything is written. */
  private draft(): void {
    const e = this.entry();
    if (!e || verbsOff(e, this.env().world)) return;
    const launcher = this.plugin.termLauncher;
    new DraftModal(this.plugin.app, {
      name: e.name, label: e.label || e.name, base: draftBase(e),
      run: (args, timeoutMs) => launcher.verb(args, timeoutMs),
      saved: () => { this.kick(["world"]); this.rescan(); },
    }).open();
  }

  /** Adopt into (D16): an alias in the workspace's workspace.md, after its confirmation; nothing moves. */
  private adoptInto(row: OutsideListRow, workspace: string): void {
    const e = entryByName(this.snapshot, workspace);
    if (!e || verbsOff(e, this.env().world)) return;
    const plan = movePlan("adopt", e, { threads: 0, sessions: row.total, folder: row.label });
    new MoveConfirmModal(this.plugin.app, {
      plan,
      run: async () => {
        let args: string[];
        try { args = workspaceArgs.adopt(row.cwd, workspace); } catch (err) { return err instanceof Error ? err.message : String(err); }
        const r = await this.once(`Adopt into ${workspace}`, () => this.plugin.termLauncher.verb(args));
        if (!r) return "Another action is still running";
        if (!r.ok) return r.reason;
        new Notice(`${row.label} is now an alias of ${workspace}: its sessions count there after the scan`);
        this.rescan();
        return null;
      },
    }).open();
  }

  /** Link as code folder of (D24): `repo:` through `aos workspace set`. */
  private async linkFolder(row: OutsideListRow, workspace: string): Promise<void> {
    const r = await this.once(`Link ${row.label}`, () => this.plugin.termLauncher.setManifest(workspace, { repo: repoValue(row.cwd, env.homedir()) }));
    if (!r) return;
    if (!r.ok) { new Notice(`Not linked: ${r.reason}`); return; }
    new Notice(`${workspace}'s code folder is ${row.label}: terminals there start in it`);
    this.kick(["world"]);
    this.rescan();
  }

  /** Adopt into… / Link as code folder of… for a folder whose name matches no workspace: pick it first. */
  private pickWorkspace(mode: "adopt" | "link", row: OutsideListRow): void {
    const world = this.env().world;
    const items = this.entries().filter((e) => !verbsOff(e, world) && (mode === "adopt" || !(e.git?.kind === "repo" && !e.repoPath)));
    if (!items.length) { new Notice(mode === "adopt" ? "No workspace to adopt it into" : "No workspace without a repository of its own"); return; }
    new WorkspacePickerModal(this.plugin.app, items, mode === "adopt" ? `Adopt ${row.label} into…` : `Link ${row.label} as the code folder of…`, (e) => {
      if (mode === "adopt") this.adoptInto(row, e.name);
      else void this.linkFolder(row, e.name);
    }, mode === "adopt" ? "adopt the folder into it (a confirmation follows; nothing moves)" : "make the folder its code folder").open();
  }

  private async hide(row: OutsideListRow): Promise<void> {
    let args: string[];
    try { args = workspaceArgs.hide(row.cwd); } catch (e) { new Notice(e instanceof Error ? e.message : String(e)); return; }
    const r = await this.once(`Hide ${row.label}`, () => this.plugin.termLauncher.verb(args));
    if (!r) return;
    if (!r.ok) { new Notice(`Not hidden: ${r.reason}`); return; }
    new Notice(`${row.label} is hidden: Unhide under Hidden brings it back`);
    // The entry as the runtime stored it (`~/…` under home), so Unhide passes back what workspaces-hidden.json holds.
    const stored = typeof r.json.path === "string" && r.json.path ? r.json.path : row.cwd;
    this.hiddenOutside = [...this.hiddenOutside.filter((h) => h.stored !== row.cwd && h.stored !== stored), { stored, label: row.label }];
    this.rescan();
  }

  private async unhide(stored: string): Promise<void> {
    let args: string[];
    try { args = workspaceArgs.unhide(stored); } catch (e) { new Notice(e instanceof Error ? e.message : String(e)); return; }
    const r = await this.once("Unhide", () => this.plugin.termLauncher.verb(args));
    if (!r) return;
    if (!r.ok) { new Notice(`Not unhidden: ${r.reason}`); return; }
    this.hiddenOutside = this.hiddenOutside.filter((h) => h.stored !== stored);
    this.draw(["list", "centre"]);
    this.rescan();
  }

  /** + to-do (D35): one line in TODO.md tagged #ws/<slug>, through the To-Do surface's writer. */
  private addTodo(): void {
    const e = this.entry();
    if (!e || e.hidden) return;
    const slug = workspaceSlug(e);
    new TodoForSpaceModal(this.plugin.app, e.label || e.name, slug, async (text) => {
      try {
        await applyTodoEdit(todoAdapter(this.plugin.app), (t) => addTodoLine(t, composeBody({ text, tags: [`ws/${slug}`] })));
      } catch (err) { return `TODO.md not written: ${err instanceof Error ? err.message : String(err)}`; }
      this.kick(["linked"]);
      return null;
    }).open();
  }

  /** Link to-dos… (D35): the untagged to-dos that name the workspace; one click each adds #ws/<slug> to that line. */
  private linkTodos(): void {
    const e = this.entry();
    if (!e || e.hidden) return;
    const slug = workspaceSlug(e);
    const others = this.entries().filter((x) => x !== e).map((x) => x.label || x.name);
    const items = todoLinkSuggestions(this.sources.todos ?? [], e, { vault: this.plugin.vaultRoot(), others });
    new LinkTodosModal(this.plugin.app, e.label || e.name, slug, items, async (sug) => {
      try {
        await applyTodoEdit(todoAdapter(this.plugin.app), (t) => editTodo(t ?? "", sug.todo.raw, `${sug.todo.body.trim()} #ws/${slug}`));
      } catch (err) {
        return err instanceof StaleTodoError ? "TODO.md changed since this list was made: open Link to-dos… again" : `TODO.md not written: ${err instanceof Error ? err.message : String(err)}`;
      }
      this.kick(["linked"]);
      return null;
    }).open();
  }

  /** Whether a vault path exists (the folder Archive would move onto). */
  private exists(rel: string): boolean {
    try { return fs.existsSync(path.join(this.plugin.vaultRoot(), rel)); } catch { return false; }
  }

  private menu(anchor: HTMLElement, items: MenuItem[], label: string): void {
    if (this.popover) {
      const same = this.popoverAnchor === anchor;
      this.popover.close(false);
      if (same) return;
    }
    if (!this.els) return;
    this.popoverAnchor = anchor;
    this.popover = openPopover(anchor, this.els.root, items, {
      label,
      onClose: (how) => {
        this.popover = null;
        this.popoverAnchor = null;
        if (how === "pointer") this.flushAfterPointer();
        else this.flushPending();
      },
    });
  }

  /** Closes an open menu without drawing what it held back (the caller draws every pane next). */
  private closeMenu(): void {
    if (!this.popover) return;
    this.pendingPanes.clear();
    this.popover.close(false);
  }

  /** Draws what changed while a menu was open. */
  private flushPending(): void {
    if (!this.pendingPanes.size) return;
    const p = [...this.pendingPanes];
    this.pendingPanes.clear();
    this.draw(p);
  }

  /**
   * A press elsewhere closed the menu on pointerdown: draw what it held back once that press's click has landed (or
   * after 300 ms, for a press that makes no click), so the control under the pointer is not replaced between
   * pointerdown and pointerup and the click that closed the menu still reaches it.
   */
  private flushAfterPointer(): void {
    if (!this.pendingPanes.size || !this.els) return;
    const doc = this.els.root.ownerDocument;
    let timer = 0;
    const go = (): void => {
      doc.removeEventListener("click", go);
      window.clearTimeout(timer);
      this.flushPending();
    };
    doc.addEventListener("click", go);
    timer = window.setTimeout(go, 300);
  }

  private openPath(abs: string): void {
    try {
      void shell.openPath(abs).then((err: string) => { if (err) new Notice(`Cannot open ${abs}: ${err}`); });
    } catch { new Notice(`Cannot open ${abs}`); }
  }

  /** Copy path (D5): "copy failed" where the app denies the clipboard (COVERAGE compat gap 1). */
  private copy(text: string): void {
    const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clip) { new Notice("copy failed"); return; }
    clip.writeText(text).then(() => new Notice("copied"), () => new Notice("copy failed"));
  }

  /** A vault file in the app's editor; anything else (a folder, a file outside the vault) with the system's app. */
  private async openFile(vaultPath: string): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(vaultPath);
    if (f instanceof TFile) { await this.plugin.app.workspace.getLeaf("tab").openFile(f); return; }
    this.openPath(path.join(this.plugin.vaultRoot(), vaultPath));
  }
}
