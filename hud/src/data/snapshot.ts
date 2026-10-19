import { App } from "obsidian";

export const SNAPSHOT_PATH = "brain/_index/snapshot.json";
export const SNAPSHOT_HISTORY_DIR = "brain/_index/snapshots";

// ── config ───────────────────────────────────────────────────────

export interface SnapshotSettings {
  path?: string;
  model: string | null;
  theme: string | null;
  effortLevel: string | null;
  dangerousMode: boolean;
  hookCount: number;
  hookEvents: string[];
  permissionsAllow: number;
  permissionsDefaultMode: string;
  statusLine: string | null;
  autoUpdatesChannel: string | null;
}

export interface ConfigFileMeta {
  size: number;
  mtime: string;
  lines?: number;
  pointers?: number;
}

export interface GsdManifestMeta {
  present: boolean;
  fileCount: number;
  version: string;
  timestamp: string;
}

export interface SnapshotUpdates {
  installed: string | null;
  latest: string | null;
  behind: boolean;
  checkedAt: string | null;
  snoozed: boolean;
}

export interface SnapshotConfig {
  settings: SnapshotSettings;
  updates?: SnapshotUpdates;
  claudeMd?: ConfigFileMeta;
  memoryMd?: ConfigFileMeta;
  gsdManifest?: GsdManifestMeta;
  historyJsonl?: ConfigFileMeta;
  topLevelFiles?: { packageJson?: boolean; gitignore?: boolean; credentials?: boolean };
  stray?: string[];
}

// ── capabilities ─────────────────────────────────────────────────

export interface SnapshotCapabilities {
  agents: { count: number; gsd: number; custom: string[]; totalBytes: number };
  commands: { count: number; names: string[] };
  // Codex's own inventory when it is a host (collectors/capabilities.js codexCapabilities); null or absent otherwise.
  codex?: { skills: number; prompts: number; hooks: number } | null;
  skills: { count: number; gsd?: number; customCount?: number; custom?: string[]; missingSkillMd?: string[] };
  hooks: {
    count: number;
    wired?: number;
    orphans?: string[];
    acknowledgedOrphans?: string[];
    missingRefs?: string[];
    settingsReferenced?: number;
  };
  brainScripts?: { count: number; names?: string[]; wired?: number };
  pluginsTopLevel?: { present?: boolean; count: number };
}

// ── brain ────────────────────────────────────────────────────────

export interface SnapshotBrain {
  counts: {
    memoryByType?: Record<string, number>;
    memoryTotal?: number;
    patterns?: number;
    reflections?: number;
    sessions?: number;
    templates?: number;
    [k: string]: number | Record<string, number> | undefined;
  };
  sessions: {
    // The daily-note count is counts.sessions (collectors/brain.js writes no count/active/stale here).
    today?: string;
    todayPresent?: boolean;
    streak?: number;
    latestDate?: string;
    oldestDate?: string;
  };
  indexFiles: {
    brainMd?: { present: boolean; size: number; mtime: string; ageDays: number };
    sessionMd?: { present: boolean; size: number; mtime: string; ageDays: number };
    dashboardMd?: { present: boolean; size: number; mtime: string; ageDays: number };
    bases?: string[];
    [k: string]: unknown;
  };
  templates?: string[];
  reflectionsLatest?: string;
  memoryIndex?: {
    byType?: Record<string, number>;
    lastTouched?: { name: string; mtime: string };
    pointerCount?: number;
    brokenPointers?: string[];
    orphanMemories?: string[];
    orphanPatterns?: string[];
  };
  oldestMemories?: Array<{ path: string; ageDays: number; mtime: string }>;
}

// ── projects ─────────────────────────────────────────────────────

export interface ProjectEntry {
  name: string;
  kind: string;
  decodedCwd?: string;
  path: string;
  jsonlCount?: number;
  totalBytes: number;
  latestMtime?: string;
  latestAgeDays?: number;
  // user-named project fields
  fileCount?: number;
  mtime?: string;
  ageDays?: number;
  hasClaudeMd?: boolean;
  hasReadme?: boolean;
  linkedMemory?: string | null;
  // workspaces visibility (added 2026-05-31)
  status?: string;
  statusSource?: 'status.md' | 'handoff.md' | 'derived';
  nextStep?: string | null;
  summary?: string | null;
  lastEvent?: { iso: string | null; ageDays: number | null; subject: string | null };
}

export interface SessionEntry {
  uuid: string;
  hasJsonl: boolean;
  projectName: string;
  jsonlPath: string;
  jsonlBytes: number;
  records: number;
  hasTasks: boolean;
  hasLock: boolean;
  taskAgeDays: number | null;
  hasEnv: boolean;
  envBytes: number;
  hasFileHistory: boolean;
  fileHistoryBytes: number;
  lastActivity: string;
  ageDays: number;
  stale: boolean;
}

export interface SnapshotProjects {
  projects: ProjectEntry[];
  sessions: SessionEntry[];
  orphanUuids: { sessionEnv?: string[]; tasks?: string[]; fileHistory?: string[] };
  transientUuids?: { sessionEnv?: string[]; tasks?: string[]; fileHistory?: string[]; minAgeMinutes?: number };
  staleSessionCount: number;
  activeSessionCount: number;
  summary: {
    totalProjects: number;
    runtimeCwdProjects?: number;
    userNamedProjects?: number;
    userNamedWithoutMemory?: number;
    totalSessions: number;
    totalJsonlBytes: number;
    totalRecords: number;
  };
}

// ── workspaces (added 2026-05-31) ────────────────────────────────

export type WorkspaceSource = "manifest" | "derived" | "ai";

export interface WorkspaceObjective {
  text: string;
  source: WorkspaceSource;
  done?: boolean;          // `- [x]` (spaces-redesign D8); absent in snapshots written before the redesign
}

export interface WorkspaceSubproject {
  name: string;
  path: string;            // vault-relative, e.g. "workspaces/Example Workspace"
  status?: string | null;
  summary?: string | null;
}

export interface WorkspaceDoc {
  name: string;
  path: string;            // vault-relative
  // spaces-redesign D8 (absent in snapshots written before the redesign):
  mtime?: string | null;   // ISO
  note?: string | null;    // frontmatter `description`, else the first body line
  done?: boolean;          // frontmatter `status:` done/shipped/complete/superseded, or every box ticked
}

export interface WorkspaceInsight {
  text: string | null;
  status: "ok" | "unavailable";
  model?: string;          // provider model tag, or "heuristic"
  generatedAt?: string;    // ISO
  inputHash?: string;
  next?: string | null;    // the model's suggested next step: shown as "suggests: …", never as the workspace's next (spaces-redesign D23)
}

/** spaces-redesign D11: the words the scan works out, and the ones workspace.md may set instead. */
export type WorkspaceAutoStatus = "active" | "stalled" | "idle";
export type WorkspaceStatusOverride = "active" | "paused" | "done";

/** The workspace's newest top-level HANDOFF*.md (spaces-redesign D6, D23). */
export interface WorkspaceHandoff {
  file: string;            // its name inside the workspace, e.g. "HANDOFF-tiles.md"
  now: string | null;      // the first line under a "Now" / "Resume here" heading
  next: string | null;     // the first open bullet under a "Next" / "What's next" / "Remaining work" heading
  asOf: string | null;     // YYYY-MM-DD from the Now heading, else the title
  mtime: string | null;    // ISO
}

/** What moved last (spaces-redesign D11, A2): an attributed session or a counted commit; never a document's mtime. */
export interface WorkspaceActivity {
  at: string | null;       // ISO
  ageDays: number | null;
  from: "session" | "commit" | null;
}

/**
 * Git for the workspace's own repository or its `repo:` folder, never the vault's (spaces-redesign D24). A folder the
 * vault's git tracks is `{ kind: "vault" }` ("tracked by the vault"). `remotes` holds names only.
 */
export type WorkspaceGit =
  | { kind: "repo"; branch: string | null; detached: boolean; head: string | null; upstream: string | null; ahead: number | null; behind: number | null; dirty: number; remotes: string[] }
  | { kind: "vault" };

export interface WorkspaceCommit {
  hash: string | null;     // short hash
  iso: string | null;
  subject: string;
}

/** One of a workspace's newest sessions (collectors/hostSessions.js; spaces-redesign D20, D25 and spec §4's Resume table). */
export interface WorkspaceSessionRow {
  id: string;
  host: "claude" | "codex";
  format: "claude" | "codex";
  kind: "interactive" | "headless" | "team" | "app";
  title: string | null;
  titleSource: "custom" | "ai" | "index" | "prompt" | null;
  startedAt: string | null;
  lastAt: string | null;
  cwd: string | null;      // the start cwd
  startExists: boolean;    // whether that folder still exists (the page cannot look outside the vault)
  via: "app" | "team" | "cwd" | "worktree" | "files";
  resumable: boolean;
  reason: string | null;   // why not, shown as is
  thread?: string;         // a Sessions thread's id, via "app" only
}

/** Sessions of both hosts that ran inside a workspace (collectors/hostSessions.js, workspace hub D2). */
export interface WorkspaceSessions {
  claude: number;          // since spaces-redesign D34: the last `windowDays` days only
  codex: number;
  total: number;
  lastAt: string | null;   // ISO of the newest session, either host, whatever its age
  windowDays?: number;     // the days the counts cover (workspaces.idleDays); absent before the redesign, when counts were all-time
  recent?: WorkspaceSessionRow[];   // newest first, at most workspaces.recentSessions rows
}

export interface HostSessionsOutside {
  cwd: string;
  claude: number;
  codex: number;
  total: number;
  lastAt: string | null;
  // spaces-redesign D21 (absent in snapshots written before the redesign):
  exists?: boolean;        // false: the folder has vanished
  match?: string | null;   // a workspace whose name is the folder's, compared as slugs
  git?: { root: string; branch: string | null } | null;   // its repository, never the vault's
  worktrees?: number;      // linked worktrees folded into this row
}

export interface SnapshotHostSessions {
  byCwd: Record<string, { claude: number; codex: number; lastAt: string | null }>;
  outsideWorkspaces: HostSessionsOutside[];   // cwds under no workspace, newest first
  scannedAt: string;
  windowDays?: number;     // the days every count covers, both hosts and the outside rows (spaces-redesign D34)
}

export interface WorkspaceEntry {
  name: string;            // the folder under workspaces/; an archived one is "_archive/<n>" (spaces-redesign D22)
  path: string;            // vault-relative "workspaces/<name>"
  sessions?: WorkspaceSessions;   // attached by the scan; absent in snapshots written before the workspace hub
  absPath?: string;        // absolute fs path recorded at scan time (for the file tree)
  repoPath?: string;       // the linked code folder (`repo:` in workspace.md), absolute
  status: string | null;   // since spaces-redesign D11 an auto status or an override; older snapshots carry other words
  statusSource: WorkspaceSource;
  summary: string | null;
  summarySource: WorkspaceSource;
  objectives: WorkspaceObjective[];
  isCollection: boolean;
  subprojects: WorkspaceSubproject[];  // populated when isCollection
  docs: WorkspaceDoc[];                // key docs when !isCollection
  next: { text: string | null; source: WorkspaceSource; from?: string | null };   // from: "HANDOFF-x.md › Next" (D23)
  insight: WorkspaceInsight;
  lastEvent: { iso: string | null; ageDays: number | null; subject: string | null; hash?: string | null };
  inputHash: string;       // hash of insight inputs, for cache carry-forward
  // spaces-redesign (absent in snapshots written before it):
  hidden?: boolean;        // D22: a `_` folder or an archived one; every consumer leaves these out
  hiddenReason?: "underscore" | "archived" | null;
  label?: string;          // the name to show: "<n>" for "_archive/<n>", else the name
  archived?: string | boolean;   // D17: workspace.md's `archived:` date, true without one; false when not archived
  pinned?: boolean;        // D18: `pinned: true` in workspace.md
  aliases?: string[];      // D16, D17: former folders, absolute; their sessions count here
  statusAuto?: WorkspaceAutoStatus | null;
  statusOverride?: WorkspaceStatusOverride | null;
  activity?: WorkspaceActivity;
  summaryTemplate?: boolean;   // D23: only the stub's placeholder text was found (offers Draft)
  handoff?: WorkspaceHandoff | null;
  git?: WorkspaceGit | null;   // D24
  commits?: WorkspaceCommit[]; // newest first, workspaces.commits rows; a vault-tracked folder's minus ignoreCommitSubjects
}

/** The entries Spaces and every other consumer list: hidden ones left out (spaces-redesign D22). */
export function visibleWorkspaces(list: WorkspaceEntry[] | null | undefined): WorkspaceEntry[] {
  return (list ?? []).filter((w) => w && !w.hidden);
}

// ── plans ────────────────────────────────────────────────────────

export interface PlanEntry {
  name: string;
  path: string;
  size: number;
  mtime: string;
  ageDays: number;
  title: string;
  explicitStatus: string | null;
  checkboxes: { total: number; done: number; pct: number | null };
  sections: string[];
  lifecycleStatus: string;
}

export interface SnapshotPlans {
  plans: PlanEntry[];
  summary: {
    total: number;
    active: number;
    stale: number;
    dormant: number;
    complete: number;
    totalCheckboxes: number;
    totalCheckboxesDone: number;
  };
}

// ── runtime ──────────────────────────────────────────────────────

export interface RuntimeBucket {
  count: number;
  totalBytes: number;
  oldest?: { name: string; mtime?: string; ageDays: number };
  newest?: { name: string; mtime?: string; ageHours?: number };
  warnLarge?: boolean;
}

export interface SnapshotRuntime {
  backups?: RuntimeBucket;
  shellSnapshots?: RuntimeBucket;
  cache?: { files: Array<{ name: string; size: number; ageDays: number }>; totalBytes: number };
  downloads?: { count: number; totalBytes: number; warnLarge?: boolean };
  ide?: { lockFiles?: string[]; active: boolean };
  runtimeSessions?: { count: number; files: Array<{ name: string; size: number; mtime: string }> };
}

// ── gsd ──────────────────────────────────────────────────────────

export interface SnapshotGsd {
  installed: boolean;
  version: string;
  counts: { bin?: number; contexts?: number; references?: number; templates?: number; workflows?: number };
  manifest: {
    present: boolean;
    fileCount: number;
    manifestVersion?: string;
    manifestTimestamp?: string;
    missing?: string[];
    drift: number;
  };
}

// ── folder atlas ─────────────────────────────────────────────────

export interface FolderAtlasEntry {
  name: string;
  scope?: "config" | "vault";
  present: boolean;
  entries?: number;
  files?: number;
  bytes?: number;
  approx?: boolean;   // stat-walked two levels deep (collectors/folderAtlas.js STAT_ONLY_DEEP): files/bytes undercount deeper trees
  newestMtime?: string;
  mtime?: string;
}

// ── health ───────────────────────────────────────────────────────

export interface HealthIssue {
  severity: "warn" | "error" | "info";
  area: string;
  message: string;
  detail?: unknown;
}

export interface SnapshotHealth {
  issues: HealthIssue[];
  counts?: { error: number; warn: number; info: number; total: number };
}

// ── maintenance ──────────────────────────────────────────────────

export interface SnapshotMaintenance {
  orphanSweep?: {
    enabled: boolean;
    reason?: string;   // 'projects-unreadable:<code>' — the allow-list could not be read, nothing was swept (sweep-orphans.js rule 4)
    swept: { sessionEnv?: string[]; fileHistory?: string[] };
    transientSwept?: { sessionEnv?: string[]; fileHistory?: string[] };
    skipped: { nonEmpty: number; hasJsonl: number; tooYoung: number; error: number };
  };
}

// ── history (embedded current/previous/sevenDayAgo/thirtyDayAgo) ──

export interface HistoryRecord {
  date: string;
  scannedAt: string;
  totalBytes: number;
  folderBytes: Record<string, number>;
  counts: {
    agents: number;
    commands: number;
    skills: number;
    hooks: number;
    hooksWired?: number;
    brainScripts?: number;
    memories: number;
    patterns: number;
    reflections?: number;
    sessions: number;
  };
  health: { error: number; warn: number; info: number; total: number };
  plans?: { total: number; totalCheckboxes: number; done: number; complete: number };
  projects?: { projects: number; sessions: number; records: number; jsonlBytes: number; active: number; stale: number };
}

export interface SnapshotHistory {
  records: number;
  earliestDate?: string;
  latestPriorDate?: string;
  current?: HistoryRecord;
  previous?: HistoryRecord | null;
  sevenDayAgo?: HistoryRecord | null;
  thirtyDayAgo?: HistoryRecord | null;
}

// ── top-level snapshot ───────────────────────────────────────────

export interface Snapshot {
  scannedAt: string;
  vault: string;
  scanVersion: number;
  elapsedMs: number;
  maintenance?: SnapshotMaintenance;
  config: SnapshotConfig;
  capabilities: SnapshotCapabilities;
  brain: SnapshotBrain;
  projects?: SnapshotProjects;
  workspaces?: WorkspaceEntry[];
  hostSessions?: SnapshotHostSessions;
  plans?: SnapshotPlans;
  runtime?: SnapshotRuntime;
  gsd?: SnapshotGsd;
  folderAtlas?: FolderAtlasEntry[];
  health: SnapshotHealth;
  history?: SnapshotHistory;
}

// ── loaders ──────────────────────────────────────────────────────

export async function loadSnapshot(app: App): Promise<Snapshot | null> {
  try {
    const raw = await app.vault.adapter.read(SNAPSHOT_PATH);
    return JSON.parse(raw) as Snapshot;
  } catch (err) {
    console.error("[agentic-os] failed to load snapshot:", err);
    return null;
  }
}

// ── daily-snapshot history (separate per-day files) ──────────────

export interface DailySnapshot {
  date: string;
  scannedAt: string;
  totalBytes: number;
  counts: {
    agents: number;
    commands: number;
    skills: number;
    hooks?: number;
    hooksWired?: number;
    brainScripts?: number;
    memories: number;
    patterns: number;
    reflections?: number;
    sessions: number;
  };
  health: { error: number; warn: number; info: number; total: number };
  plans?: { total: number; totalCheckboxes: number; done: number; complete: number };
  projects?: { projects: number; sessions: number; records: number; jsonlBytes: number; active: number; stale: number };
  folderBytes?: Record<string, number>;
}

export async function loadSnapshotHistory(app: App, limit = 21): Promise<DailySnapshot[]> {
  try {
    const list = await app.vault.adapter.list(SNAPSHOT_HISTORY_DIR);
    const files = (list.files || [])
      .filter((p) => p.endsWith(".json"))
      .sort();
    const tail = files.slice(-limit);
    const out: DailySnapshot[] = [];
    for (const f of tail) {
      try {
        const raw = await app.vault.adapter.read(f);
        const d = JSON.parse(raw) as DailySnapshot;
        out.push(d);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch (err) {
    console.error("[agentic-os] failed to load snapshot history:", err);
    return [];
  }
}

export type CountKey = "agents" | "commands" | "skills" | "memories" | "patterns" | "sessions";

export function seriesFromHistory(history: DailySnapshot[], key: CountKey): number[] {
  return history.map((d) => (d.counts as Record<string, number>)[key] ?? 0);
}
