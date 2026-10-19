// ui.ts — what the Spaces panes share (spaces-redesign D3–D10, D19; PR 3's actions D15–D18, D35): the context the tab
// hands each pane, the menus as data (Resume's, More's, the status menu, the outside list's adopt popover), the file
// events each pane redraws on, and small render helpers. Kept apart from SpacesTab.ts so the panes never
// import the tab (the views/teams pattern), and free of runtime imports from "obsidian" (the tab passes `icon`), so the
// pure parts load under node:test.
import * as path from "path";
import type { Snapshot, WorkspaceEntry } from "../../data/snapshot";
import type { Place, PlaceWorld, TermHostChoice } from "../../data/terminalLaunch";
import { workspacePlace } from "../../data/terminalLaunch";
import type { LinkedCounts, Linked, LiveState, ManifestStatus, ResumeRef, ResumeTarget, HistoryFilter, SpaceGroupKey, StatusPill } from "../../data/spacesModel";
import { lastThread } from "../../data/hostSessions";
import type { OutsideListRow } from "../../data/hostSessions";
import { WS_RE, newSessionRows, resumeTarget, sessionsLink, statusPill, SESSIONS_OFF_TEXT } from "../../data/spacesModel";
import type { FileFilter, MapIndex, WorkspaceMap } from "../../data/workspaceMaps";
import type { DirEntry, PreviewResult } from "../../data/workspaceFiles";
import type { HostSessionThread } from "../../host";
import { SNAPSHOT_PATH } from "../../data/snapshot";
import { MAPS_DIR } from "../../data/workspaceMaps";
import { TODO_PATH } from "../../data/todos";
import { PROPOSALS_DIR } from "../../data/proposals";

// ── state ──

/** The centre pane: the dossier's Overview or Files, or the outside list (D21; Adopt and Hide on its rows, D16). */
export type CentreView = "overview" | "files" | "outside";
export type Pane = "list" | "centre" | "right";

/** What the tab remembers between draws (the snapshot and the files are the state; this is the user's place in them). */
export interface SpacesUiState {
  selected: string | null;
  query: string;
  showHidden: boolean;
  /** A group the user opened or closed; otherwise the model's default (IDLE and the hidden group start closed, D4). */
  groupOpen: Map<SpaceGroupKey, boolean>;
  centre: CentreView;
  history: HistoryFilter;
  files: { filter: FileFilter; query: string; open: Set<string>; preview: string | null };
  /** What reveal() pointed at (D12): a thread to mark in History, a section of the right pane to bring into view. */
  target: { thread: string | null };
  /** The outside list draws every row, not the first ListPane.OUTSIDE_SHOWN of a group ("Show all n"). */
  outsideAll: boolean;
}

export function freshUiState(): SpacesUiState {
  return {
    selected: null, query: "", showHidden: false, groupOpen: new Map(), centre: "overview", history: "all",
    files: { filter: "all", query: "", open: new Set(), preview: null }, target: { thread: null }, outsideAll: false,
  };
}

/**
 * What a pane can ask the tab to do. Most only select or open (a terminal, a tab, a menu, the OS); PR 3's actions open
 * a dialog or run one `aos workspace` verb through the spaces surface (D28, D29), a move only after its confirmation.
 */
export interface SpacesActions {
  select(name: string): void;
  /** Check the selection against the list's rules again (the hidden toggle), then redraw every pane. */
  reselect(): void;
  /** Redraw panes from the state as it is (no read). */
  redraw(panes: Pane[]): void;
  /** Read what the Files tree needs (listings of the open folders), then redraw the centre and right panes. */
  tree(): void;
  /** Opens or closes the outside list; closing it with `select` selects that workspace (a Matches link). */
  showOutside(on: boolean, select?: string): void;
  /** New space (D15): the dialog; the tab runs `aos workspace new`. */
  newSpace(): void;
  resume(ref: ResumeRef): void;
  newSession(host: "claude" | "codex"): void;
  terminal(): void;
  finder(): void;
  revealInFinder(abs: string): void;
  openPath(abs: string): void;
  copy(text: string): void;
  linkCodeFolder(): void;
  openSessions(thread?: string | null): void;
  openCode(): void;
  openTab(tab: string): void;
  /** A vault-relative file: in the app's editor when it is a vault file, else with the system's app. */
  openFile(vaultPath: string): void;
  regen(): void;
  mapNow(): void;
  describeFile(rel: string): void;
  menu(anchor: HTMLElement, items: MenuItem[], label: string): void;
  /** Reads the head of a file for the preview; the result is kept for `SpacesCtx.cachedPreview`. */
  readPreview(abs: string): Promise<PreviewResult>;
  // ── PR 3 (D15–D18, D35) ──
  /** The status menu, opened on the dossier's pill (Set status… in More opens it there too). */
  statusMenu(): void;
  /** `aos workspace set <n> --set {"status": …}`: "" is Automatic (clears the override). */
  setStatus(status: ManifestStatus | ""): void;
  togglePin(): void;
  rename(): void;
  archive(): void;
  restore(): void;
  /** Draft workspace.md (D13). */
  draft(): void;
  /** The outside list's row: alias it into a workspace (D16), after its confirmation. */
  adoptInto(row: OutsideListRow, workspace: string): void;
  /** The outside list's row as a workspace's code folder (`repo:` through set, D24). */
  linkFolder(row: OutsideListRow, workspace: string): void;
  /** Adopt into… / Link as code folder of… for a folder whose name matches no workspace: the picker first. */
  pickWorkspace(mode: "adopt" | "link", row: OutsideListRow): void;
  hide(row: OutsideListRow): void;
  /** A stored hidden path, exactly as brain/_index/workspaces-hidden.json holds it. */
  unhide(stored: string): void;
  /** + to-do with #ws/<slug> (D35), through the To-Do surface's writer. */
  addTodo(): void;
  /** Link to-dos… (D35). */
  linkTodos(): void;
  /** After a clone line ends: start an agent in the fresh clone (D15: never on its own). */
  startHere(host: "claude" | "codex"): void;
  dismissClone(): void;
}

/** A clone New space typed into a Code terminal (D15): what the dossier offers once its line has ended. */
export interface CloneState {
  url: string;
  /** The host New space's "Open with" named; null for Terminal. */
  host: "claude" | "codex" | null;
  /** The line has ended: `aos workspace stubs --pin`, its last step, wrote workspace.md. */
  done: boolean;
}

/** A hidden outside folder (brain/_index/workspaces-hidden.json): the stored value Unhide passes, and how it reads. */
export interface HiddenFolder { stored: string; label: string }

/** What the tab hands each pane on a draw. */
export interface SpacesCtx {
  snapshot: Snapshot | null;
  loaded: boolean;
  /** Every entry the snapshot lists, hidden ones included (the list's rule hides them, D22). */
  entries: WorkspaceEntry[];
  /** The selected entry, or null. */
  entry: WorkspaceEntry | null;
  ui: SpacesUiState;
  now: number;
  home: string;
  vault: string;
  world: PlaceWorld;
  choices: TermHostChoice[];
  /** The agent host ⌘T would start (TerminalLauncher.quickHost: the one last launched, else the first ready one), or
   *  null when that is the shell or not ready; Start in Code starts it first (host parity: never Claude Code by order). */
  quick: "claude" | "codex" | null;
  /** The resolved model provider's name; "none" when there is none (D33). */
  provider: string;
  /** Whether the Sessions tab is shown (D32). */
  sessionsAvailable: boolean;
  live: Map<string, LiveState>;
  counts: Map<string, LinkedCounts>;
  linked: Linked | null;
  /** The app's Sessions threads (D32): "All n in Sessions" counts the selected workspace's. */
  threads: HostSessionThread[];
  map: WorkspaceMap | null;
  index: MapIndex;
  /** Listings of the Files tree by folder ("" the root); null for a folder that could not be read. */
  listings: Map<string, DirEntry[] | null>;
  /** The last preview read of `abs`, when there is one: drawn at once, so a redraw keeps the preview's scroll. */
  cachedPreview(abs: string): PreviewResult | null;
  /** The resume line a target types, for the hint (launchLine through TerminalLauncher.spec, D7); null when refused. */
  resumeLine(host: "claude" | "codex", id: string, cwd: string): string | null;
  /** Renders Markdown into `el` (compat's MarkdownRenderer: sanitized, raw HTML escaped), for the preview of a .md file;
   *  `sourcePath` is the file's vault path, which its relative links resolve against. */
  renderMarkdown(el: HTMLElement, text: string, sourcePath: string): void;
  /** Obsidian's setIcon (lucide ids). Named so, and called with a literal id, so `npm run check:compat` sees each icon. */
  setIcon(el: HTMLElement, id: string): void;
  act: SpacesActions;
  // ── PR 3 ──
  /** Whether the To-Do surface may write TODO.md (compat's canWrite; display only, main checks the write): + to-do and
   *  Link to-dos… are off with TODO_WRITES_OFF_TEXT otherwise (D35). */
  todoWritable: boolean;
  /** Outside folders the user hid, for Unhide (D16, D21). */
  hiddenOutside: HiddenFolder[];
  /** A clone typed into the selected workspace's folder (D15), or null. */
  clone: CloneState | null;
}

// ── file events → what to read again (the tab's watch list, Mechanics › PR 2 › Files and wiring) ──

/** What a file event means for the tab: which data to read again. */
export type Flag = "snapshot" | "map" | "threads" | "world" | "linked" | "listing" | "live" | "tree" | "select";

export const SESSIONS_DIR = "brain/_index/sessions";
export const PROJECT_NOTES_DIR = "brain/memory/projects";
const under = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`);

/**
 * The flags a vault event on `p` raises. `selectedPath` is the selected entry's folder ("workspaces/<name>"):
 * a file made, removed or renamed there changes the Files tree (`listing`; a modify does not). `modify` is false for
 * create, delete and rename.
 */
export function watchFlags(p: string, o: { selected: string | null; selectedPath: string | null; modify: boolean }): Flag[] {
  const out: Flag[] = [];
  if (p === SNAPSHOT_PATH) out.push("snapshot");
  if (o.selected && p === `${MAPS_DIR}/${o.selected}.json`) out.push("map");
  // A thread appearing or going (create, delete, rename). A running turn appends every event to its thread's file, and
  // what Spaces shows of a thread (its workspace, whether it runs) does not change with them: the running state comes
  // from the Sessions events (SpacesTab's TURN_EVENTS), so a modify here raises nothing.
  if (under(p, SESSIONS_DIR) && !o.modify) out.push("threads");
  if (/^workspaces\/[^/]+\/workspace\.md$/.test(p)) out.push("world");
  if (p === TODO_PATH || under(p, PROPOSALS_DIR) || under(p, PROJECT_NOTES_DIR)) out.push("linked");
  if (!o.modify && o.selectedPath && p.startsWith(`${o.selectedPath}/`)) out.push("listing");
  return out;
}

/** The panes each flag redraws: only the ones whose data changed (the AgentTeamsTab pattern, per pane). */
export const PANES_FOR: Record<Flag, readonly Pane[]> = {
  snapshot: ["list", "centre", "right"],
  select: ["list", "centre", "right"],
  map: ["centre", "right"],
  threads: ["list", "right"],
  live: ["list"],
  // The linked code folder: the meta line, and where History's Resume and the pick-up hint say a thread resumes.
  world: ["centre", "right"],
  linked: ["list", "right"],
  listing: ["centre"],
  tree: ["centre", "right"],
};

/** What the file preview (the right pane while Files is open, D9) shows: the selection, the scan and the map. Of the
 *  folder's listing it shows only the file's own row, which rightPaneKey holds: a file made or removed beside it
 *  re-lists the tree and changes nothing in the preview. Threads, Linked, the live dots, the world and opening a folder
 *  in the tree change none of it either. */
export const PREVIEW_FLAGS: readonly Flag[] = ["select", "snapshot", "map"];

/**
 * The panes a batch of flags redraws. While the right pane is the preview it is redrawn exactly when a flag in
 * PREVIEW_FLAGS came in or it should now show something else (`rightChanged`: another file, workspace or view, or the
 * file's own row in the listing), so a Sessions turn, a to-do change or a file made beside it does not take a reader's
 * place in the file (the scroll, a selection).
 */
export function panesFor(flags: Iterable<Flag>, o: { previewShown: boolean; rightChanged: boolean }): Set<Pane> {
  const list = [...flags];
  const panes = new Set<Pane>();
  for (const f of list) for (const p of PANES_FOR[f]) panes.add(p);
  if (o.previewShown) {
    if (o.rightChanged || list.some((f) => PREVIEW_FLAGS.includes(f))) panes.add("right");
    else panes.delete("right");
  }
  return panes;
}

/** A workspace file's row in its folder's listing: undefined while that folder is not listed (or could not be), null
 *  when the listed folder does not hold it. */
export function listedEntry(rel: string, listings: ReadonlyMap<string, DirEntry[] | null>): DirEntry | null | undefined {
  const dir = path.posix.dirname(rel);
  const entries = listings.get(dir === "." ? "" : dir);
  if (!entries) return undefined;
  return entries.find((d) => d.name === path.posix.basename(rel)) ?? null;
}

/** What the right pane shows, compared with what it last drew (panesFor's `rightChanged`): the preview of a file of a
 *  workspace, with that file's own row in the listing (its size, the "not mapped" over 1 MB, or that it is gone), or
 *  that workspace's History and Linked. */
export function rightPaneKey(ui: Pick<SpacesUiState, "selected" | "centre" | "files">, listings: ReadonlyMap<string, DirEntry[] | null>): string {
  const sel = ui.selected ?? "";
  if (ui.centre !== "files") return `${ui.centre}:${sel}`;
  const rel = ui.files.preview ?? "";
  const row = rel ? listedEntry(rel, listings) : undefined;
  return `files:${sel}:${rel}:${row === undefined ? "" : row === null ? "gone" : `${row.size ?? "?"}`}`;
}

/** What Spaces shows of the app's Sessions threads (the live dot, "All n in Sessions"): a list that reads the same
 *  draws the same, so a re-list that changed none of it redraws nothing. */
export function threadSignature(threads: ReadonlyArray<Pick<HostSessionThread, "id" | "workspace" | "running">>): string {
  return threads.filter(Boolean).map((t) => `${t.id}\u0000${t.workspace}\u0000${t.running ? 1 : 0}`).sort().join("\n");
}

// ── places and launches (D5, D7, D31, D32) ──

/** Where a terminal for the entry starts: its place when it is a listed workspace folder on disk; why not otherwise. */
export function entryPlace(e: Pick<WorkspaceEntry, "name" | "hidden">, world: PlaceWorld): { place: Place; reason: null } | { place: null; reason: string } {
  if (world.workspaces.includes(e.name)) return { place: workspacePlace(e.name, world), reason: null };
  if (e.hidden) return { place: null, reason: "Archived and _ folders start no terminal: open it in Code from its folder" };
  return { place: null, reason: "Its folder is not under workspaces/ any more: rescan the vault" };
}

/** A row of a menu (DOM-built, Popover.ts). A disabled row shows its reason under its label (D31). */
export interface MenuItem {
  key: string;
  label: string;
  /** A second line: what it does, or why it is off. */
  detail?: string | null;
  disabled?: boolean;
  run?: () => void;
  /** A choice of one (the status menu): drawn as menuitemradio with aria-checked. */
  checked?: boolean;
  /** A separator above it (Archive…, Hide). */
  sep?: boolean;
}

/** The target of a session row, looked up again in the current snapshot (D7, D31, D32), or why it is off. */
export function targetFor(ctx: Pick<SpacesCtx, "snapshot" | "choices" | "world" | "sessionsAvailable">, e: WorkspaceEntry, ref: ResumeRef): ResumeTarget {
  const where = entryPlace(e, ctx.world);
  if (!where.place) return { kind: "disabled", disabled: true, reason: where.reason };
  return resumeTarget(ref, ctx.snapshot, ctx.choices, { world: ctx.world, sessionsAvailable: ctx.sessionsAvailable });
}

/** The words a resume line types after `exec` (the configured binary and its flags), for the hint; a binary that needs
 *  no quotes is shown without them, and with `home` a path under it reads `~/…` (Codex's `-C <folder>`, a binary
 *  installed under home): the hint is on screen and in screenshots, the full line stays in its title. */
export function typedCommand(line: string, home?: string | null): string {
  const at = line.indexOf(" exec ");
  const end = line.lastIndexOf(" || echo ");
  const words = at >= 0 ? line.slice(at + 6, end > at ? end : undefined).trim() : line.trim();
  const shown = words.replace(/^'([A-Za-z0-9._:/=-]+)'(?= |$)/, "$1");
  if (!home || home === "/") return shown;
  const h = home.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return shown.replace(new RegExp(`(^|[\\s'"])${h}(?=/|$|[\\s'"])`, "g"), "$1~");
}

/**
 * Resume in Code, the split button's main half (D5): the last thread (D6's *last*), resumed in a Code terminal or opened
 * in Sessions; with no thread yet, a new session on the host ⌘T would start (`quick`), else the first host that is on
 * and ready. Off with the reason otherwise.
 */
export interface PrimaryAction { label: string; title: string; disabled: boolean; reason: string | null; run: (() => void) | null }

export function primaryAction(ctx: Pick<SpacesCtx, "snapshot" | "choices" | "world" | "sessionsAvailable" | "act"> & Partial<Pick<SpacesCtx, "quick">>, e: WorkspaceEntry): PrimaryAction {
  const last = lastThread(e.sessions);
  if (last) {
    const t = targetFor(ctx, e, { workspace: e.name, id: last.id });
    if (t.kind === "sessions") return { label: "Open in Sessions", title: "Open the last thread in Sessions", disabled: false, reason: null, run: () => ctx.act.openSessions(t.thread) };
    if (t.kind === "terminal") return { label: "Resume in Code", title: `Resume the last ${t.host === "claude" ? "Claude Code" : "Codex"} thread in a Code terminal. ${t.hint}`, disabled: false, reason: null, run: () => ctx.act.resume({ workspace: e.name, id: last.id }) };
    return { label: "Resume in Code", title: t.reason, disabled: true, reason: t.reason, run: null };
  }
  const where = entryPlace(e, ctx.world);
  if (!where.place) return { label: "Start in Code", title: where.reason, disabled: true, reason: where.reason, run: null };
  const rows = newSessionRows(ctx.choices);
  const ready = rows.find((r) => !r.disabled && r.host === ctx.quick) ?? rows.find((r) => !r.disabled);
  if (ready) return { label: "Start in Code", title: `No session yet: start ${ready.label.replace(/^New /, "a new ")} in a Code terminal`, disabled: false, reason: null, run: () => ctx.act.newSession(ready.host) };
  const reason = rows[0]?.reason ?? "No agent host is on: run aos hosts add claude or aos hosts add codex";
  return { label: "Start in Code", title: reason, disabled: true, reason, run: null };
}

/**
 * The split button's menu (D5, D31, D32): a New session row per host that is on (a host that is off gets none, one that
 * is not logged in is off with its reason), Terminal here, and Open last thread in Sessions (off for a CLI thread or a
 * hidden Sessions tab). Never names a host the launcher's choices do not offer.
 */
export function splitMenuItems(ctx: Pick<SpacesCtx, "choices" | "world" | "sessionsAvailable" | "act">, e: WorkspaceEntry): MenuItem[] {
  const where = entryPlace(e, ctx.world);
  const items: MenuItem[] = newSessionRows(ctx.choices).map((r) => {
    const off = r.disabled || !where.place;
    return { key: `new:${r.host}`, label: r.label, detail: off ? (where.reason ?? r.reason) : null, disabled: off, run: off ? undefined : () => ctx.act.newSession(r.host) };
  });
  items.push({ key: "terminal", label: "Terminal here", detail: where.reason, disabled: !where.place, run: where.place ? () => ctx.act.terminal() : undefined });
  const link = sessionsLink(lastThread(e.sessions), ctx.sessionsAvailable);
  items.push({ key: "sessions", label: "Open last thread in Sessions", detail: link.reason, disabled: link.disabled, run: link.thread ? () => ctx.act.openSessions(link.thread) : undefined });
  return items;
}

/** Why a workspace's own verbs (Rename, Pin, status, Draft, Archive) are off, or null when they are on. */
export function verbsOff(e: Pick<WorkspaceEntry, "name" | "hidden" | "hiddenReason">, world: PlaceWorld): string | null {
  if (e.hidden) return e.hiddenReason === "archived" ? "Archived: restore it first" : "A _ folder is not a workspace Spaces manages";
  if (!world.workspaces.includes(e.name)) return "Its folder is not under workspaces/ any more: rescan the vault";
  if (!WS_RE.test(e.name)) return "Its folder's name is not one Spaces can pass to aos: rename it in Finder";
  return null;
}

/**
 * More ⋯ (D5; the Manage mock's menu): Rename…, Pin or Unpin, Set status…, Link code folder…, Draft workspace.md, Copy
 * path, Reveal in Finder, then Archive… (Restore… on an archived workspace). An item that cannot run stays, off, with
 * why (D31).
 */
export function moreMenuItems(ctx: Pick<SpacesCtx, "world" | "act" | "vault">, e: WorkspaceEntry): MenuItem[] {
  const abs = entryAbs(e, ctx.vault);
  const linked = !!ctx.world.links[e.name];
  const off = verbsOff(e, ctx.world);
  const items: MenuItem[] = [];
  if (!e.hidden) {
    const own = (key: string, label: string, run: () => void, detail: string | null = null): MenuItem =>
      ({ key, label, detail: off ?? detail, disabled: !!off, run: off ? undefined : run });
    items.push(
      own("rename", "Rename…", () => ctx.act.rename(), "Moves the folder, its map and its threads; the old name stays an alias"),
      own("pin", e.pinned ? "Unpin" : "Pin", () => ctx.act.togglePin(), e.pinned ? "Back into its status group" : "Keeps it at the top of the list"),
      own("status", "Set status…", () => ctx.act.statusMenu(), "Automatic, Active, Paused or Done, in workspace.md"),
      own("link", linked ? "Change code folder…" : "Link code folder…", () => ctx.act.linkCodeFolder(), "Terminals here start in that folder"),
      own("draft", "Draft workspace.md", () => ctx.act.draft(), "A summary, objectives and next step to review; nothing is saved until you press Save"),
    );
  }
  items.push(
    { key: "copy", label: "Copy path", run: () => ctx.act.copy(abs) },
    { key: "reveal", label: "Reveal in Finder", run: () => ctx.act.revealInFinder(abs) },
  );
  if (!e.hidden) {
    items.push({ key: "archive", label: "Archive…", sep: true, detail: off ?? "Moves it to workspaces/_archive/; restorable", disabled: !!off, run: off ? undefined : () => ctx.act.archive() });
  } else if (e.hiddenReason === "archived") {
    const name = e.label || e.name.replace(/^_archive\//, "");
    const ok = WS_RE.test(name);
    items.push({ key: "restore", label: "Restore…", sep: true, detail: ok ? `Moves it back to workspaces/${name}` : "Its name is not one Spaces can pass to aos", disabled: !ok, run: ok ? () => ctx.act.restore() : undefined });
  }
  return items;
}

/** The status menu (D18): Automatic (the scan's word), Active, Paused, Done; the one workspace.md sets is checked. */
export function statusMenuItems(ctx: Pick<SpacesCtx, "act">, e: WorkspaceEntry): MenuItem[] {
  const current = e.statusOverride ?? null;
  const auto = e.statusAuto ?? (statusPill(e).auto ? statusPill(e).word : null);
  const set = (s: ManifestStatus | "") => () => ctx.act.setStatus(s);
  return [
    { key: "status:auto", label: "Automatic", detail: auto ? `${auto} now, from sessions and commits` : "Worked out from sessions and commits", checked: !current, run: current ? set("") : undefined },
    { key: "status:active", label: "Active", detail: "Set in workspace.md", checked: current === "active", run: current === "active" ? undefined : set("active") },
    { key: "status:paused", label: "Paused", detail: "Set in workspace.md; muted, never an alarm", checked: current === "paused", run: current === "paused" ? undefined : set("paused") },
    { key: "status:done", label: "Done", detail: "Set in workspace.md", checked: current === "done", run: current === "done" ? undefined : set("done") },
  ];
}

/**
 * The outside list's popover (D16, D24): "Adopt into <name>" for a folder whose name matches a workspace (an alias,
 * nothing moves), "Link as code folder of <name>" when that workspace has no repository of its own, and Hide; a folder
 * that matches none gets "Adopt into a workspace…" and "Link as code folder of…", which pick the workspace first.
 */
export function outsideMenuItems(ctx: Pick<SpacesCtx, "act" | "entries" | "world">, row: OutsideListRow): MenuItem[] {
  // A row inside the vault (a workspaces/<old> left by a rename by hand, a vanished _archive/<n>): the runtime takes
  // only folders outside the vault for adopt, link and hide (cli/workspace.js checkOutsidePath), so say so here.
  const rel = path.relative(path.resolve(ctx.world.vault), path.resolve(row.cwd));
  const inVault = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)) ? "Inside the vault: rename or remove it in Files" : null;
  const match = row.match ? ctx.entries.find((e) => e.name === row.match && !e.hidden) ?? null : null;
  const items: MenuItem[] = [];
  const gone = row.exists ? null : "The folder no longer exists";
  if (match) {
    const n = match.label || match.name;
    const off = inVault ?? verbsOff(match, ctx.world);
    items.push({ key: "adopt", label: `Adopt into ${n}`, detail: off ?? "Records this folder as an alias: its sessions count there; nothing moves", disabled: !!off, run: off ? undefined : () => ctx.act.adoptInto(row, match.name) });
    const own = match.git?.kind === "repo" && !match.repoPath ? `${n} is a repository of its own` : null;
    // Linking never replaces a code folder without a word: that change is More › Link code folder…'s, which shows it.
    const linked = match.repoPath ? `Already linked to ${shortenHome(match.repoPath, ctx.world.home)}: change it in More › Link code folder…` : null;
    const why = off ?? gone ?? own ?? linked;
    items.push({ key: "link", label: `Link as code folder of ${n}`, detail: why ?? "Terminals in it start in this folder", disabled: !!why, run: why ? undefined : () => ctx.act.linkFolder(row, match.name) });
  } else {
    items.push({ key: "adopt", label: "Adopt into a workspace…", detail: inVault ?? "Pick the workspace; nothing moves", disabled: !!inVault, run: inVault ? undefined : () => ctx.act.pickWorkspace("adopt", row) });
    const why = inVault ?? gone;
    items.push({ key: "link", label: "Link as code folder of…", detail: why ?? "Pick the workspace whose terminals start here", disabled: !!why, run: why ? undefined : () => ctx.act.pickWorkspace("link", row) });
  }
  items.push({ key: "hide", label: "Hide", sep: true, detail: inVault ?? "Leaves this list; Unhide under Hidden brings it back", disabled: !!inVault, run: inVault ? undefined : () => ctx.act.hide(row) });
  return items;
}

/** A path as it reads, `~/…` under home. */
function shortenHome(p: string, home: string): string {
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/** The app's Sessions threads in a workspace (D32: Sessions lists app threads only). */
export function threadsIn(threads: HostSessionThread[], name: string): HostSessionThread[] {
  return threads.filter((t) => t && t.workspace === name);
}

/** "All n in Sessions →" (D10, D32), or why it is off; null when there is no app thread to count. */
export function sessionsFooter(threads: HostSessionThread[], name: string, sessionsAvailable: boolean): { text: string; disabled: boolean; reason: string | null } | null {
  if (!sessionsAvailable) return { text: "Threads in Sessions", disabled: true, reason: SESSIONS_OFF_TEXT };
  const n = threadsIn(threads, name).length;
  return n ? { text: `All ${n} in Sessions →`, disabled: false, reason: null } : null;
}

// ── paths ──

/** The entry's folder on disk: the scan's absolute path, else the vault's `workspaces/<name>`. */
export function entryAbs(e: Pick<WorkspaceEntry, "absPath" | "path">, vault: string): string {
  return e.absPath || path.join(vault, e.path);
}

/** "~/…" for a path under home. */
export function tilde(abs: string, home: string): string {
  return home && (abs === home || abs.startsWith(`${home}/`)) ? `~${abs.slice(home.length)}` : abs;
}

/** Whether map-workspace.js and regen-workspace-insight.js take this entry: a listed workspace, not a hidden one. */
export function mappable(e: Pick<WorkspaceEntry, "hidden">): boolean {
  return !e.hidden;
}
export const HIDDEN_MAP_TEXT = "Archived and _ folders are not mapped";

// ── render helpers ──

/** A reason line (`.aos-spc-why`, D31): the `aos hosts add <h>` it names is set in mono, so it reads as typed. */
export function whyLine(parent: HTMLElement, text: string, o: { div?: boolean; cls?: string } = {}): HTMLElement {
  const cls = `aos-spc-why${o.cls ? ` ${o.cls}` : ""}`;
  const el = o.div ? parent.createDiv({ cls }) : parent.createSpan({ cls });
  const re = /\baos hosts add [a-z]+/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) el.appendText(text.slice(at, m.index));
    el.createSpan({ cls: "aos-spc-mono", text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) el.appendText(text.slice(at));
  return el;
}

/** A coloured dot that carries its own text label (spec §4 Accessibility: every coloured dot has a text label). */
export function dot(parent: HTMLElement, tone: string, label: string, o: { hollow?: boolean; cls?: string } = {}): HTMLElement {
  return parent.createSpan({
    cls: `aos-spc-dot is-${tone}${o.hollow ? " is-hollow" : ""}${o.cls ? ` ${o.cls}` : ""}`,
    attr: { role: "img", "aria-label": label, title: label },
  });
}

/** The status dot of a row or the pill (D19: active ok, stalled warn, idle off). */
export function statusDot(parent: HTMLElement, s: StatusPill): HTMLElement {
  return dot(parent, s.tone, s.auto ? `${s.word}, worked out from sessions and commits` : `${s.word}, set in workspace.md`, { hollow: s.hollow });
}

/** A host's dot (D19: Claude Code info, Codex gate). */
export function hostDot(parent: HTMLElement, host: "claude" | "codex"): HTMLElement {
  return dot(parent, host, host === "claude" ? "Claude Code" : "Codex", { cls: "aos-spc-hostdot" });
}

/** A button with the tab's class; `key` keeps its focus across a redraw (data-spc-key). */
export function button(parent: HTMLElement, cls: string, text: string | null, o: { key?: string; title?: string | null; label?: string; disabled?: boolean | null; attr?: Record<string, string> } = {}): HTMLButtonElement {
  const attr: Record<string, string> = { type: "button", ...(o.attr ?? {}) };
  if (o.key) attr["data-spc-key"] = o.key;
  if (o.title) attr.title = o.title;
  if (o.label) attr["aria-label"] = o.label;
  const b = parent.createEl("button", { cls, attr });
  if (text) b.setText(text);
  if (o.disabled) b.disabled = true;
  return b;
}

/** A section heading (11px caps, D8): the label, then whatever the caller adds beside it. */
export function sectionHead(parent: HTMLElement, label: string, o: { id?: string; focusable?: boolean } = {}): HTMLElement {
  const head = parent.createDiv({ cls: "aos-spc-sechead" });
  const attr: Record<string, string> = {};
  if (o.id) attr.id = o.id;
  if (o.focusable) attr.tabindex = "-1";
  head.createEl("h3", { cls: "aos-spc-h3", text: label, attr });
  return head;
}

/** A segmented control of pressed buttons (All · Sessions · Commits; All · New · Changed). */
export function segmented<T extends string>(parent: HTMLElement, label: string, options: Array<{ id: T; text: string; count?: number | null }>, value: T, keyPrefix: string, onPick: (id: T) => void): HTMLElement {
  const group = parent.createDiv({ cls: "aos-spc-seg", attr: { role: "group", "aria-label": label } });
  for (const o of options) {
    const on = o.id === value;
    const b = button(group, `aos-spc-segbtn${on ? " is-on" : ""}`, null, { key: `${keyPrefix}:${o.id}`, attr: { "aria-pressed": String(on) } });
    b.createSpan({ text: o.text });
    if (o.count) b.createSpan({ cls: "aos-spc-segcount", text: String(o.count) });
    b.addEventListener("click", () => { if (!on) onPick(o.id); });
  }
  return group;
}

/** Arrow keys move the focus among `sel` inside `list` (Home, End too); Enter and Space are the buttons' own. */
export function arrowKeys(list: HTMLElement, sel: string): void {
  list.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>(sel)).filter((x) => x.offsetParent !== null || x === document.activeElement);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0 || !items.length) return;
    e.preventDefault();
    const n = items.length;
    const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : e.key === "ArrowDown" ? Math.min(n - 1, i + 1) : Math.max(0, i - 1);
    items[j].focus();
  });
}

/**
 * Redraws `el` with `draw`, keeping the user's place (the AgentTeamsTab pattern, per pane): the focused element by its
 * data-spc-key (and a text field's caret), and the scroll of every [data-spc-scroll] inside it and of `outer`.
 */
export function keepPlace(el: HTMLElement, draw: () => void, outer: Array<HTMLElement | null> = []): void {
  const doc = el.ownerDocument;
  const active = doc.activeElement as HTMLElement | null;
  const key = active && el.contains(active) ? active.getAttribute("data-spc-key") : null;
  const caret = key && active instanceof HTMLInputElement ? { start: active.selectionStart, end: active.selectionEnd } : null;
  const scrollers = (root: HTMLElement): HTMLElement[] => [root, ...Array.from(root.querySelectorAll<HTMLElement>("[data-spc-scroll]"))].filter((s) => s.hasAttribute("data-spc-scroll"));
  const tops = new Map<string, number>();
  for (const s of scrollers(el)) tops.set(s.getAttribute("data-spc-scroll")!, s.scrollTop);
  const outerTops = outer.filter((o): o is HTMLElement => !!o).map((o) => ({ o, top: o.scrollTop }));
  draw();
  for (const s of scrollers(el)) { const t = tops.get(s.getAttribute("data-spc-scroll")!); if (t !== undefined) s.scrollTop = t; }
  for (const { o, top } of outerTops) o.scrollTop = top;
  if (!key) return;
  const next = el.querySelector<HTMLElement>(`[data-spc-key="${cssEscape(key)}"]`);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (caret && next instanceof HTMLInputElement) { try { next.setSelectionRange(caret.start, caret.end); } catch { /* a search field may refuse */ } }
}

function cssEscape(s: string): string {
  const esc = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  return esc ? esc(s) : s.replace(/["\\]/g, "\\$&");
}
