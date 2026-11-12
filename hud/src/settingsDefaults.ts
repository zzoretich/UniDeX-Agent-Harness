// Pure settings shape + defaults (no obsidian import) so node:test can load it and
// data modules (nodeResolver) can take the settings object without pulling the UI in.
// Cost and telemetry are not here: they are the system's own switches (cost.enabled, telemetry.enabled), read from the
// merged config by Plugin.costOn()/telemetryOn() and changed through `aos config` (spec 2026-09-24-settings-tab D10).

import type { HostSessionAccess, HostSessionHost } from "./host";
import { DEFAULT_TOUR_STATE, type TourState } from "./tour/state";

/** One value per host the Sessions tab and Vault chat can run. */
export interface PerHost<T> { claude: T; codex: T }

/** The Sessions tab's last choice (spec 2026-10-07-sessions-ux U12): host and access globally, model and effort per
 *  host, so a new session starts where the last one left off. null means "the host's default". */
export interface SessionChoice {
  host: HostSessionHost | null;
  access: HostSessionAccess;
  models: PerHost<string | null>;
  efforts: PerHost<string | null>;
}

/** Vault chat's last choice, kept apart from the Sessions tab's: Vault chat is always read only, so it has no access,
 *  and its one-shot paths take fewer efforts. */
export interface VaultChoice {
  host: HostSessionHost | null;
  models: PerHost<string | null>;
  efforts: PerHost<string | null>;
}

/** What a Term launch runs, and what an agent there may do (spec 2026-10-08-term-agent-deck T2, T11): the same
 *  literals as data/terminalLaunch.ts TermHost and TermAccess, kept here so this module stays import-free. */
export type TermHostId = "claude" | "codex" | "shell";
export type TermAccessId = "host" | "read" | "edit" | "run";
export type AgentPlaceId = "scratch" | "last" | "vault";

/** The Term tab's last choice (T2, T4, T11): the host ⌘T starts, the access level, where agents start when no place
 *  is picked, and the workspaces launched in most recently (newest first). */
export interface TerminalChoice {
  host: TermHostId | null;
  access: TermAccessId;
  agentPlace: AgentPlaceId;
  recent: string[];
}

/** The Files tab's remembered choices (spec 2026-10-17-files-finder D21): the view, the sort, whether Icons and List
 *  show the preview pane, the sidebar's favorites (null: the defaults, D20), what was opened from Files, newest
 *  first, and whether a rename or move updates the links to it (D17, on unless turned off). The same literals as
 *  data/filesModel.ts, kept here so this module stays import-free. */
export type FilesViewId = "icons" | "list" | "columns";
export type FilesSortKey = "name" | "modified" | "size" | "kind";
export interface FilesChoice {
  view: FilesViewId;
  sort: { key: FilesSortKey; desc: boolean };
  preview: boolean;
  favorites: string[] | null;
  recents: string[];
  updateLinks: boolean;
}

/** The Computer pane's width and whether it is collapsed (agent-computer D4), remembered per page. */
export interface ComputerPaneSettings { width: number; collapsed: boolean }
/** The pages with a Computer pane: Code (the deck) and Sessions (its tab id stays "chat"). */
export type ComputerPaneId = "code" | "chat";
/** What data.json keeps: only the pages whose pane was changed, so a page never changed still starts collapsed in a
 *  narrow window (computerPaneStart). */
export type ComputerPaneChoice = Partial<Record<ComputerPaneId, ComputerPaneSettings>>;

export interface AgenticOSSettings {
  statusBarEnabled: boolean;
  autoOpenSidebarOnStart: boolean;
  liveTailPollMs: number;
  // Terminal
  terminalShell: string;
  terminalCwd: string;
  terminalFontSize: number;
  terminalScrollback: number;
  // AgenticOS (contract §5)
  vaultRoot: string;         // "" → this Obsidian vault's base path
  claudeConfigDir: string;   // "" → agenticos.json.claudeConfigDir → $CLAUDE_CONFIG_DIR → ~/.claude
  nodePath: string;          // "" → auto (src/data/nodeResolver.ts); a login-shell probe result is saved here
  // Sessions (U12): read through sanitizeSessionChoice / sanitizeVaultChoice, since data.json may hold anything
  sessionChoice: SessionChoice;
  vaultChoice: VaultChoice;
  // Term (spec 2026-10-08-term-agent-deck): read through sanitizeTerminalChoice
  terminalChoice: TerminalChoice;
  // The Term composer's saved prompts (T12): read through data/termComposer.ts sanitizeSnippets
  terminalSnippets: Array<{ title: string; text: string; host: "claude" | "codex" | null }>;
  // Pulse (spec 2026-10-08-pulse-cockpit-design P10): when Pulse was last left; "since you last looked" counts from it
  pulseSeenAt: string | null;
  // Brain (spec 2026-10-11-brain-hub D16): when Review was last open on this machine; the rail badge counts memories
  // written after it, so it reaches zero. Null until the first count, which sets it (the backlog is never the badge).
  brainReviewSeenAt: string | null;
  // The guided tour (spec 2026-10-14-guided-tour-design C4): what ran, what was offered, Getting started, the version
  // whose What's new was last shown. Read through tour/state.ts sanitizeTourState.
  tour: TourState;
  // Files (spec 2026-10-17-files-finder D21): read through sanitizeFilesChoice
  files: FilesChoice;
  // The Computer pane (agent-computer D4): read through computerPaneStart, written through rememberComputerPane
  computerPane: ComputerPaneChoice;
}

/** Keys data.json may still hold from earlier versions; loadSettings prunes them (the two HUD-only toggles, D10). */
export const DEAD_SETTINGS_KEYS = ["snapshotPath", "runsPath", "sessionPath", "snapshotHistoryDir", "refreshDebounceMs", "costEnabled", "telemetryEnabled"];

export const DEFAULT_SETTINGS: AgenticOSSettings = {
  statusBarEnabled: true,
  autoOpenSidebarOnStart: false,
  liveTailPollMs: 300,
  // Terminal — shell + cwd auto-resolve at plugin load if blank
  terminalShell: "",
  terminalCwd: "",
  terminalFontSize: 13,
  terminalScrollback: 5000,
  // AgenticOS
  vaultRoot: "",
  claudeConfigDir: "",
  nodePath: "",
  // Sessions
  sessionChoice: { host: null, access: "edit", models: { claude: null, codex: null }, efforts: { claude: null, codex: null } },
  vaultChoice: { host: null, models: { claude: null, codex: null }, efforts: { claude: null, codex: null } },
  // Term
  terminalChoice: { host: null, access: "host", agentPlace: "vault", recent: [] },
  terminalSnippets: [],
  pulseSeenAt: null,
  brainReviewSeenAt: null,
  tour: DEFAULT_TOUR_STATE,
  files: { view: "icons", sort: { key: "name", desc: false }, preview: false, favorites: null, recents: [], updateLinks: true },
  computerPane: {},
};

// ── remembered choices (U12) ──
// loadSettings copies a stored value as it is, so a hand-edited or older data.json can hold any shape here. The views
// read through these sanitizers, which keep the good parts and fall back to the defaults for the rest, and never throw.
// A kept model or effort may still be one the catalog no longer lists: the view checks it against the catalog.

const HOSTS: readonly HostSessionHost[] = ["claude", "codex"];
const ACCESS: readonly HostSessionAccess[] = ["read", "edit", "run"];
/** The levels a session turn takes per host (the runtime's headless.js SESSION_EFFORTS). */
const SESSION_EFFORTS: PerHost<readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};
/** The levels Vault chat's one-shot paths take: claude -p --effort, and ask.js --effort= (the chat surface's rules). */
const VAULT_EFFORTS: PerHost<readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};
/** A model id the app's session schema admits: one word, no leading dash (app/src/main/ipc/schemas.ts Model). */
const MODEL_ID = /^[A-Za-z0-9._:/[\]-]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function pickHost(v: unknown): HostSessionHost | null {
  return HOSTS.includes(v as HostSessionHost) ? (v as HostSessionHost) : null;
}

function pickModel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim();
  return id.length > 0 && id.length <= 80 && !id.startsWith("-") && MODEL_ID.test(id) ? id : null;
}

function pickModels(v: unknown): PerHost<string | null> {
  const r = isRecord(v) ? v : {};
  return { claude: pickModel(r.claude), codex: pickModel(r.codex) };
}

function pickEfforts(v: unknown, allowed: PerHost<readonly string[]>): PerHost<string | null> {
  const r = isRecord(v) ? v : {};
  const one = (host: HostSessionHost): string | null =>
    typeof r[host] === "string" && allowed[host].includes(r[host] as string) ? (r[host] as string) : null;
  return { claude: one("claude"), codex: one("codex") };
}

/** A clean copy of a stored Sessions choice; anything missing or malformed reads as its default. */
export function sanitizeSessionChoice(raw: unknown): SessionChoice {
  const r = isRecord(raw) ? raw : {};
  return {
    host: pickHost(r.host),
    access: ACCESS.includes(r.access as HostSessionAccess) ? (r.access as HostSessionAccess) : "edit",
    models: pickModels(r.models),
    efforts: pickEfforts(r.efforts, SESSION_EFFORTS),
  };
}

/** A clean copy of a stored Vault chat choice; anything missing or malformed reads as its default. */
export function sanitizeVaultChoice(raw: unknown): VaultChoice {
  const r = isRecord(raw) ? raw : {};
  return { host: pickHost(r.host), models: pickModels(r.models), efforts: pickEfforts(r.efforts, VAULT_EFFORTS) };
}

/** The Sessions choice after a pick: the host becomes the last host, and a model, effort or access that is given
 *  (null included) replaces the stored one for that host; one left out keeps it. Returns a new object to store. */
export function rememberSessionChoice(
  current: unknown,
  pick: { host: HostSessionHost; model?: string | null; effort?: string | null; access?: HostSessionAccess },
): SessionChoice {
  const c = sanitizeSessionChoice(current);
  c.host = pick.host;
  if (pick.model !== undefined) c.models[pick.host] = pick.model;
  if (pick.effort !== undefined) c.efforts[pick.host] = pick.effort;
  if (pick.access !== undefined) c.access = pick.access;
  return sanitizeSessionChoice(c);
}

/** The Vault chat choice after a pick, as rememberSessionChoice does it (Vault chat has no access to keep). */
export function rememberVaultChoice(
  current: unknown,
  pick: { host: HostSessionHost; model?: string | null; effort?: string | null },
): VaultChoice {
  const c = sanitizeVaultChoice(current);
  c.host = pick.host;
  if (pick.model !== undefined) c.models[pick.host] = pick.model;
  if (pick.effort !== undefined) c.efforts[pick.host] = pick.effort;
  return sanitizeVaultChoice(c);
}

// ── the Term tab's choice (spec 2026-10-08-term-agent-deck T2, T4, T11) ──

const TERM_HOSTS: readonly TermHostId[] = ["claude", "codex", "shell"];
const TERM_ACCESS: readonly TermAccessId[] = ["host", "read", "edit", "run"];
const AGENT_PLACES: readonly AgentPlaceId[] = ["scratch", "last", "vault"];
/** How many recent workspaces the menu keeps. */
export const TERM_RECENT_MAX = 5;
/** A workspace folder name the list may keep: one segment, not hidden, not a team folder (agentSessions.workspaceNames). */
const WORKSPACE_NAME = /^[^./\\_][^/\\]{0,127}$/;

/** A clean copy of a stored Term choice; anything missing or malformed reads as its default. */
export function sanitizeTerminalChoice(raw: unknown): TerminalChoice {
  const r = isRecord(raw) ? raw : {};
  const recent = Array.isArray(r.recent)
    ? [...new Set(r.recent.filter((n): n is string => typeof n === "string" && WORKSPACE_NAME.test(n)))].slice(0, TERM_RECENT_MAX)
    : [];
  return {
    host: TERM_HOSTS.includes(r.host as TermHostId) ? (r.host as TermHostId) : null,
    access: TERM_ACCESS.includes(r.access as TermAccessId) ? (r.access as TermAccessId) : "host",
    agentPlace: AGENT_PLACES.includes(r.agentPlace as AgentPlaceId) ? (r.agentPlace as AgentPlaceId) : "vault",
    recent,
  };
}

/** The Term choice after a launch or a pick: a host launched from the deck becomes the one ⌘T starts, a workspace
 *  launched in moves to the front of the recent list, and an access level or default place that is given replaces the
 *  stored one. Returns a new object to store. */
export function rememberTerminalChoice(
  current: unknown,
  pick: { host?: TermHostId; workspace?: string | null; access?: TermAccessId; agentPlace?: AgentPlaceId },
): TerminalChoice {
  const c = sanitizeTerminalChoice(current);
  if (pick.host) c.host = pick.host;
  if (pick.access) c.access = pick.access;
  if (pick.agentPlace) c.agentPlace = pick.agentPlace;
  if (pick.workspace) c.recent = [pick.workspace, ...c.recent.filter((n) => n !== pick.workspace)];
  return sanitizeTerminalChoice(c);
}

// ── Files (spec 2026-10-17-files-finder D21) ──

const FILES_VIEWS: readonly FilesViewId[] = ["icons", "list", "columns"];
const FILES_SORTS: readonly FilesSortKey[] = ["name", "modified", "size", "kind"];
export const FILES_FAVORITES_MAX = 30;
export const FILES_RECENTS_MAX = 50;

/** A vault-relative path a favorite or a recent may hold: no leading slash, no `.` or `..` segment, no empty one. */
function vaultPath(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 1024 && !v.startsWith("/") && v.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

function pathList(v: unknown, max: number): string[] {
  return Array.isArray(v) ? [...new Set(v.filter(vaultPath))].slice(0, max) : [];
}

/** A clean copy of a stored Files choice; anything missing or malformed reads as its default. The favorites stay null
 *  (the defaults) until the user changes them; "" (the vault itself) is a favorite like any folder. */
export function sanitizeFilesChoice(raw: unknown): FilesChoice {
  const r = isRecord(raw) ? raw : {};
  const sort = isRecord(r.sort) ? r.sort : {};
  const favorites = Array.isArray(r.favorites)
    ? [...new Set(r.favorites.filter((p): p is string => p === "" || vaultPath(p)))].slice(0, FILES_FAVORITES_MAX)
    : null;
  return {
    view: FILES_VIEWS.includes(r.view as FilesViewId) ? (r.view as FilesViewId) : "icons",
    sort: { key: FILES_SORTS.includes(sort.key as FilesSortKey) ? (sort.key as FilesSortKey) : "name", desc: sort.desc === true },
    preview: r.preview === true,
    favorites,
    recents: pathList(r.recents, FILES_RECENTS_MAX),
    updateLinks: r.updateLinks !== false,
  };
}

/** The Files choice after a change: the fields given replace the stored ones; an opened path moves to the front of the
 *  recents; `moved` (a rename or a move in Files, files-finder D20) takes the favorites and recents it touches along, a
 *  folder everything under it. Returns a new object to store. */
export function rememberFilesChoice(
  current: unknown,
  pick: Partial<Omit<FilesChoice, "recents">> & { opened?: string; moved?: ReadonlyArray<{ from: string; to: string }> },
): FilesChoice {
  const c = sanitizeFilesChoice(current);
  if (pick.view) c.view = pick.view;
  if (pick.sort) c.sort = { ...pick.sort };
  if (pick.preview !== undefined) c.preview = pick.preview;
  if (pick.favorites !== undefined) c.favorites = pick.favorites ? [...pick.favorites] : null;
  if (pick.updateLinks !== undefined) c.updateLinks = pick.updateLinks;
  if (pick.opened) c.recents = [pick.opened, ...c.recents.filter((p) => p !== pick.opened)];
  if (pick.moved?.length) {
    const moves = pick.moved;
    const follow = (p: string): string => {
      for (const m of moves) if (p === m.from || p.startsWith(`${m.from}/`)) return m.to + p.slice(m.from.length);
      return p;
    };
    if (c.favorites) c.favorites = c.favorites.map((p) => (p === "" ? p : follow(p)));
    c.recents = c.recents.map(follow);
  }
  return sanitizeFilesChoice(c);
}

// ── the Computer pane (agent-computer D4) ──

/** The pane's smallest width and its default, in CSS pixels. It has no fixed largest: that is the row less the session's
 *  column (paneMax), so a bigger window gives a bigger browser (session-browser S11). */
export const COMPUTER_PANE_WIDTH = { min: 320, default: 440 } as const;
/** The least width the session's own column keeps while the pane grows. */
export const SESSION_COLUMN_MIN = 360;
/** What a stored width is held under; a window is never this wide, the real limit is paneMax of the row it is shown in. */
const COMPUTER_PANE_STORED_MAX = 10_000;

export type PaneSize = "side" | "half" | "wide";

/** The widest the pane may be in a row of `row` px (the session column and the pane together). */
export function paneMax(row: number): number {
  return Math.max(COMPUTER_PANE_WIDTH.min, Math.floor(row) - SESSION_COLUMN_MIN);
}

/** The width a size button gives in a row of `row` px: Side is the default, Half is half the row, Wide is the most. */
export function paneSizeWidth(size: PaneSize, row: number): number {
  const max = paneMax(row);
  const w = size === "side" ? COMPUTER_PANE_WIDTH.default : size === "half" ? Math.round(row / 2) : max;
  return Math.min(max, Math.max(COMPUTER_PANE_WIDTH.min, w));
}

/** The size button `width` matches in a row of `row` px (within 1 px), or null; Wide before Half before Side. */
export function paneSizeOf(width: number, row: number): PaneSize | null {
  for (const size of ["wide", "half", "side"] as const) if (Math.abs(paneSizeWidth(size, row) - width) <= 1) return size;
  return null;
}
/** Under this window width a page whose pane was never changed starts with it collapsed. */
export const COMPUTER_PANE_NARROW = 760;
/** Under this RENDERED width the pane drops what it can do without (session-browser S11). Not COMPUTER_PANE_NARROW,
 *  which is a window width. */
export const COMPUTER_PANE_COMPACT = 380;
const COMPUTER_PAGES: readonly ComputerPaneId[] = ["code", "chat"];

function paneWidth(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return COMPUTER_PANE_WIDTH.default;
  return Math.round(Math.min(COMPUTER_PANE_STORED_MAX, Math.max(COMPUTER_PANE_WIDTH.min, v)));
}

function paneOf(v: Record<string, unknown>): ComputerPaneSettings {
  return { width: paneWidth(v.width), collapsed: v.collapsed === true };
}

/** The pages data.json holds a pane for, each cleaned; a page with junk is a page never changed. */
function storedPanes(raw: unknown): ComputerPaneChoice {
  const r = isRecord(raw) ? raw : {};
  const out: ComputerPaneChoice = {};
  for (const page of COMPUTER_PAGES) {
    const v = r[page];
    if (isRecord(v)) out[page] = paneOf(v);
  }
  return out;
}

/** A clean copy of the stored Computer pane for both pages; anything missing or malformed reads as 440 px and open. */
export function sanitizeComputerPane(v: unknown): Record<ComputerPaneId, ComputerPaneSettings> {
  const stored = storedPanes(v);
  return {
    code: stored.code ?? { width: COMPUTER_PANE_WIDTH.default, collapsed: false },
    chat: stored.chat ?? { width: COMPUTER_PANE_WIDTH.default, collapsed: false },
  };
}

/** How a page's pane starts: as it was left, or, never changed, collapsed when the window is under 760 px wide (the
 *  user's toggle then wins and is saved). */
export function computerPaneStart(raw: unknown, page: ComputerPaneId, windowWidth: number): ComputerPaneSettings {
  const stored = storedPanes(raw)[page];
  if (stored) return stored;
  return { width: COMPUTER_PANE_WIDTH.default, collapsed: windowWidth < COMPUTER_PANE_NARROW };
}

/** The stored Computer pane after a page's pane changed: that page's settings, cleaned, and the other page as it was
 *  stored (not saved stays not saved). Returns a new object to store. */
export function rememberComputerPane(current: unknown, page: ComputerPaneId, pane: ComputerPaneSettings): ComputerPaneChoice {
  return { ...storedPanes(current), [page]: paneOf(pane as unknown as Record<string, unknown>) };
}
