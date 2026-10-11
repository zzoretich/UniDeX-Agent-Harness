// The write surfaces. The HUD writes only through named surfaces. Each surface lists the vault files it may write
// (vault-relative globs) and the runtime commands it may run (a script under <vault>/brain/scripts run by node, or a
// program by name, each with an argument rule), and cites the HUD modules that do it. A surface is off until it is
// enabled; with none enabled the app is read-only. The background refreshes the HUD starts on its own run whatever is
// enabled. Everything else is refused.
//
// One surface is the app's own rather than the HUD's: Notes, the note editor's saves. Its files are checked only when
// the editor saves (canSave), never for the HUD's writes, so switching it on cannot widen what the HUD may write.
//
// This file is data and pure matching over vault-relative paths, with no imports: the main process enforces it
// (main/policy/write-policy.ts, behind the IPC bridge) and the sandboxed page reads it to show what writes are on and
// whether a note may be edited. Sources below are relative to ../obsidian-plugin/src.

export type ArgRule = RegExp | ((argv: readonly string[]) => boolean);

export interface SpawnRule {
  /** A runtime script, relative to <vault>/brain/scripts, that must be run by `node`. */
  script?: string;
  /** Or a program, by file name (the HUD finds it on PATH or through a setting). */
  bin?: string;
  /**
   * The arguments after the script (or program). A RegExp is tested against them joined with single spaces, for
   * fixed words; `argv(…)` checks them one by one, for rules with free text (a question, a message, a JSON value),
   * so a flag inside a message can never stand in for the flag itself.
   */
  args: ArgRule;
}

export interface Surface {
  id: string;
  /** How the status bar and the menu name it. */
  label: string;
  /** The HUD modules whose writes and spawns this entry admits. */
  source: string;
  /**
   * Vault-relative globs: `*` stays within one path segment, `**` spans any number of them. The folders an allowed
   * file could live in may be created (never removed) too.
   */
  writes: readonly string[];
  /** Folders it may create (never remove) that no file it writes would imply, as vault-relative globs. */
  folders?: readonly string[];
  /** Vault-relative globs it never writes or creates, even where `writes` or `folders` match. */
  except?: readonly string[];
  /**
   * Whose writes it admits: the HUD's (the default), checked by the guarded fs and the vault adapter; the app's note
   * editor's, checked only by the editor's save (canSave); or a service of main's own (Sessions), which main runs only
   * while the surface is on and whose writes and commands are never the page's: the HUD's rules leave it out.
   */
  scope?: "hud" | "editor" | "main";
  spawns: readonly SpawnRule[];
  /**
   * Its writes were checked on a live vault with the Obsidian HUD open (phase 2's per-surface step). Only these are on
   * by default; `AOS_APP_WRITE` can enable any surface, which is how a surface's tests run before that check.
   */
  verified: boolean;
}

/** An argument rule that checks each argument on its own: a literal, or a pattern the whole argument must match. */
export function argv(...parts: ReadonlyArray<string | RegExp>): (a: readonly string[]) => boolean {
  return (a) => a.length === parts.length && parts.every((p, i) => (typeof p === "string" ? a[i] === p : new RegExp(`^(?:${p.source})$`, p.flags).test(a[i])));
}

// One argument of a given kind. None may start with "-", so a value can never be read as a flag.
const ID = /[A-Za-z0-9][\w.:@-]*/;          // a team, item, member, agent or skill id; a config key
const WORD = /[^\s-][^\s]*/;                // a preset, a model name
const TEXT = /[^-][\s\S]*/;                 // free text: a todo, a post, a path
// A workspace (spaces-redesign §6): an existing folder's name, which the runtime checks again. Not ".", "..", ".x" or "_x"
// (hidden and archived folders), no path separator, no NUL or line break (U+2028 and U+2029 included), at most 128
// characters. collectors/util.js WS_NAME is its twin.
const WS = /[^\s\0._\/\\-][^\/\\\0\n\r\u2028\u2029]{0,127}/;
// A file inside a workspace (map-workspace.js --file), which the runtime checks again: relative, no "." or ".." segment,
// no NUL or line break. The segment check spans any character, so no line separator can hide a "..".
const REL = /(?![-\/])(?!(?:[\s\S]*\/)?\.\.?(?:\/|$))[^\0\n\r\u2028\u2029]+/;
// The page's workspace verbs (spaces-redesign D15–D18, D29; the plan's Mechanics › PR 3 › Security). cli/workspace.js
// checks each again: a name against the folders under workspaces/, a path against the scan's outside rows.
// A new workspace's name (new, rename): kebab-case, at most 64 characters, no dash at either end.
const KEBAB = /[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?/;
// workspace.md's hash as `draft` read it (set --expect), or `none` when the workspace has no workspace.md yet.
const HASH = /none|[0-9a-f]{16,64}/;
// An outside folder (adopt, hide, unhide): absolute or under ~/, no NUL or line break (U+2028 and U+2029 included).
const PATH = /(?:\/|~\/)[^\0\n\r\u2028\u2029]+/;
// Chat's question. recall-cli.js and ask.js read only whole `--…` arguments as flags, so a question may start with one
// dash ("- what is due?"), as it may in Obsidian; `--` never, which keeps out `--warm` and ask.js's `--write=<file>`.
const QUESTION = /(?!--)[\s\S]+/;
const ANY = /[\s\S]*/;                      // a value the runtime parses itself (aos config set)
const USD = /\d+(\.\d+)?/;
const JSON_OBJ = /\{[\s\S]*\}/;
const SLUG = /[a-z0-9][a-z0-9-]{1,40}/;     // RoutinesTab's routine slug
// Vault chat's chosen host, model and effort for ask.js (spec 2026-10-07-sessions-ux U9): one argument each.
const ASK_HOST = /--host=(?:claude|codex)/;
const ASK_MODEL = new RegExp(`--model=${WORD.source}`);
const ASK_EFFORT = /--effort=(?:minimal|low|medium|high|xhigh|max)/;

/** The refreshes the HUD starts by itself on load and on timers; they write only runtime-owned caches under the runtime's locks. */
export const BACKGROUND: readonly SpawnRule[] = [
  { script: "cli/aos.js", args: /^(config (list|get)( .*)?|routines hosts --refresh|skills sync|agents sync)$/ },
  { script: "reconcile-sessions.js", args: /^$/ },
  { script: "statusline.js", args: /^refresh$/ },
  { script: "scan-vault.js", args: /^(--quiet)?$/ },
  { script: "team.js", args: /^list( --json)?$/ },
];

/** `claude -p` exactly as data/claudeAsk.ts builds it: no tools, no settings, no MCP, no session, a budget cap, JSON out.
 *  The effort is any level `claude --effort` takes (Vault chat's menu, spec 2026-10-07-sessions-ux U9). */
const claudeAsk = (effort: boolean): SpawnRule => ({
  bin: "claude",
  args: argv("-p", ANY, "--model", WORD, ...(effort ? ["--effort", /low|medium|high|xhigh|max/] : []), "--tools", "", "--setting-sources", "",
    "--strict-mcp-config", "--no-session-persistence", "--system-prompt", ANY, "--max-budget-usd", USD, "--output-format", "json"),
});

/** Every subset of `flags`, each keeping the order given: a command's optional flags as data, in one fixed order. */
const inOrder = (flags: readonly string[]): string[][] => flags.reduce<string[][]>((all, f) => [...all, ...all.map((s) => [...s, f])], [[]]);

/**
 * The `aos workspace` verbs Spaces runs (spaces-redesign D28, D29; spec §4 PR 3), each with --json last. Never `list`,
 * `which`, `stubs` or adopt's move form (adopt without --into): only a terminal or a session types those.
 */
const WORKSPACE_VERBS: readonly SpawnRule[] = [
  ...inOrder(["--git", "--pin", "--empty"]).map((flags): SpawnRule => ({ script: "cli/aos.js", args: argv("workspace", "new", KEBAB, ...flags, "--json") })),
  { script: "cli/aos.js", args: argv("workspace", "draft", WS, "--json") },
  // The Draft dialog's Save: only the keys that changed, compare-and-set on the hash the draft read.
  ...inOrder(["--dry-run"]).map((flags): SpawnRule => ({ script: "cli/aos.js", args: argv("workspace", "set", WS, "--set", JSON_OBJ, "--expect", HASH, ...flags, "--json") })),
  { script: "cli/aos.js", args: argv("workspace", /archive|restore/, WS, "--json") },
  { script: "cli/aos.js", args: argv("workspace", "rename", WS, KEBAB, "--json") },
  // An alias only: the folder stays where it is.
  { script: "cli/aos.js", args: argv("workspace", "adopt", PATH, "--into", WS, "--json") },
  { script: "cli/aos.js", args: argv("workspace", /hide|unhide/, PATH, "--json") },
];

// The Brain hub's verbs (brain-hub D13, D14; spec §6). lib/memory-ops.js checks each again: a memory path against the four
// type folders as a regular file inside the vault, a draft name against the drafts folder, set's hash against the file.
// A memory: brain/memory/<type>/<slug>.md, a direct child of one of the four type folders (memory-ops.js PATH_RE).
const MEMORY = /brain\/memory\/(?:user|feedback|projects|reference)\/[a-z0-9][a-z0-9.-]{0,120}\.md/;
// A feedback draft's name (memory-ops.js SLUG_RE).
const DRAFT = /[a-z0-9][a-z0-9.-]{0,120}/;
/** At most this many memories per keep, archive or restore (obsidian-plugin/src/data/brainModel.ts MAX_PATHS_PER_CALL). */
export const MAX_MEMORY_PATHS = 50;
const MEMORY_WHOLE = new RegExp(`^(?:${MEMORY.source})$`);
/** `memory <verb> <path>… --json` with 1 to MAX_MEMORY_PATHS memory paths. */
const memoryPaths = (verb: string) => (a: readonly string[]): boolean => {
  const paths = a.slice(2, -1);
  return a[0] === "memory" && a[1] === verb && a[a.length - 1] === "--json" && paths.length >= 1 && paths.length <= MAX_MEMORY_PATHS && paths.every((p) => MEMORY_WHOLE.test(p));
};
/**
 * The `aos memory` verbs the Brain tab runs, each with --json last: Review's keep, archive and supersede, Library's pin
 * and status (compare-and-set on the hash the page read), restore, a draft's approve or reject, and "not duplicates".
 * Never `list`: the page reads the memory files itself (data/brainModel.ts parses them as lib/memory-ops.js does).
 */
const MEMORY_VERBS: readonly SpawnRule[] = [
  ...["keep", "archive", "restore"].map((verb): SpawnRule => ({ script: "cli/aos.js", args: memoryPaths(verb) })),
  ...inOrder(["--dry-run"]).map((flags): SpawnRule => ({ script: "cli/aos.js", args: argv("memory", "set", MEMORY, "--set", JSON_OBJ, "--expect", HASH, ...flags, "--json") })),
  { script: "cli/aos.js", args: argv("memory", "supersede", MEMORY, "--by", MEMORY, "--json") },
  { script: "cli/aos.js", args: argv("memory", "draft", /approve|reject/, DRAFT, "--json") },
  { script: "cli/aos.js", args: argv("memory", "notdup", MEMORY, MEMORY, "--json") },
];

// What the Files tab and the note editor never touch: the runtime's caches and vendored scripts, dependency folders, and
// every dot-path. The Files tree and the vault index never show a dot-path; refusing them also keeps a compromised page
// from planting a host's project config in the vault (.claude/settings.json hooks, .mcp.json, .codex/, .git/hooks).
const PROTECTED = ["brain/_index/**", "brain/scripts/**", "**/node_modules/**", "**/.*", "**/.*/**"];

/** The runtime's own folders (its caches and vendored scripts): never moved, trashed or removed, nor any folder above them. */
export const RUNTIME_FOLDERS: readonly string[] = ["brain/_index", "brain/scripts"];

export const SURFACES: readonly Surface[] = [
  {
    id: "todo",
    label: "To-Do",
    source: "data/todoWriter.ts; views/TodoTab.ts (open TODO.md creates it from the template)",
    writes: ["TODO.md"],
    spawns: [],
    verified: true,
  },
  {
    id: "notifications",
    label: "Notifications",
    source: "data/notificationWriter.ts (views/NotificationsTab.ts: read, unread, archive, mark all read, reactions)",
    writes: ["brain/notifications/state.json", "brain/notifications/reactions.jsonl"],
    spawns: [],
    verified: true,
  },
  {
    id: "capture",
    label: "Capture",
    source: "data/memoryWriter.ts (ui/CaptureModal.ts), ui/RememberModal.ts, ui/PatternModal.ts",
    writes: ["brain/memory/**/*.md", "MEMORY.md", "brain/_index/SESSION.md", "brain/patterns/*.md"],
    spawns: [],
    verified: true,
  },
  {
    id: "settings",
    label: "Settings",
    source: "views/SettingsTab.ts, ui/pluginSettingRows.ts (aos config set|unset, the follow-ups data/settingsModel.ts accepts, the node probe of data/nodeResolver.ts); data/liveRuns.ts, which main.ts rebindLiveSources restarts after telemetry.enabled changes",
    // With telemetry on, the live-runs watcher makes sure its folder and summary log exist.
    writes: ["brain/_index/agent-runs/runs.jsonl"],
    folders: ["brain/_index/agent-runs/live"],
    spawns: [
      { script: "cli/aos.js", args: argv("config", "set", ID, ANY, "--json") },
      { script: "cli/aos.js", args: argv("config", "unset", ID, "--json") },
      // The follow-ups `aos config set` prints (brain/scripts/lib/settings-schema.js); skills and agents sync are background.
      { script: "cli/aos.js", args: /^(routines sync|statusline install)$/ },
      ...["zsh", "bash", "sh", "fish"].map((bin): SpawnRule => ({ bin, args: argv("-lic", "command -v node") })),
    ],
    verified: true,
  },
  {
    id: "routines",
    label: "Routines",
    source: "data/routineWriter.ts (views/RoutinesTab.ts: editor, on/off, delete, apply schedules, run now)",
    writes: ["brain/routines/*.md"],
    spawns: [
      { script: "cli/aos.js", args: /^routines sync$/ },
      { script: "routines/run-routine.js", args: argv(SLUG, "--manual") },
    ],
    verified: true,
  },
  {
    id: "sharing",
    label: "Skills & Agents",
    source: "views/SkillsTab.ts, views/AgentsTab.ts (share, unshare)",
    writes: [],
    spawns: [{ script: "cli/aos.js", args: argv(/skills|agents/, /include|exclude/, ID) }],
    verified: true,
  },
  {
    id: "pulse",
    label: "Pulse",
    // Pulse summarises the brain and the Brain tab acts on it (brain-hub D14, D15): the trail's keep, edit and revert and
    // their writes to brain/memory, MEMORY.md and the trail gave way to the brain surface's verbs.
    source: "views/PulseTab.ts and ui/PulsePopup.ts with data/fixQueue.ts and data/pipelines.ts (Fix Queue), ui/AnchorModal.ts (cost anchor), data/commandRegistry.ts (/scan, /reflect-week), the briefing band's ↻ (persona/briefing.js --force)",
    writes: [],
    spawns: [
      { script: "auto-cost.js", args: /^--backfill$/ },
      { script: "heartbeat-writer.js", args: /^$/ },
      { script: "graph-build.js", args: /^--quiet$/ },
      { script: "build-brain-md.js", args: /^$/ },
      { script: "map-workspace.js", args: argv(WS) },
      { script: "cost-budget.js", args: argv("--anchor", USD) },
      { script: "sdk/reflect-week.js", args: /^--local$/ },
      // The ↻ on the briefing band (spec 2026-10-08-pulse-cockpit-design P13): one paragraph now, under the daily duty cap.
      { script: "persona/briefing.js", args: /^--force$/ },
    ],
    verified: true,
  },
  {
    id: "spaces",
    label: "Spaces",
    source: "views/SpacesTab.ts and views/spaces/* (map now, ↻ one file, regen; New, Adopt, Hide, Archive, Restore, Rename, Pin, status), ui/spaces/{DraftModal,NewSpaceModal}.ts, data/terminalLauncher.ts (createAndLaunch, linkRepo), main.ts regenWorkspaceInsight",
    // The verbs write through the runtime (cli/workspace.js), never the page: workspaces/** and brain/_index/**, plus a
    // linked project note's status tag (spaces-redesign §6).
    writes: [],
    spawns: [
      { script: "map-workspace.js", args: argv(WS) },
      { script: "map-workspace.js", args: argv(WS, "--file", REL) },
      { script: "regen-workspace-insight.js", args: argv(WS) },
      ...WORKSPACE_VERBS,
    ],
    // Live check of the workspace verbs (spaces-redesign D29), 2026-10-10 on a real vault with both hosts enabled: new
    // (--pin), which, one draft with the provider pinned to Claude and one pinned to Codex (each labelled by who answered),
    // set --dry-run, set --expect and its refusal of a stale hash, archive, restore, archive again.
    verified: true,
  },
  {
    id: "brain",
    label: "Brain",
    source: "views/BrainTab.ts and views/brain/* (Review: keep, keep the batch, archive, keep the older one, not duplicates, a draft's approve or reject, Mark everything before; Library: pin, status, archive, restore), data/brainModel.ts (memoryArgs)",
    // The verbs write through the runtime (cli/memory.js → lib/memory-ops.js), never the page: a memory's own frontmatter
    // lines, MEMORY.md, the trail and brain/_index/**, and BRAIN.md through build-brain-md.js. Nothing is deleted but a
    // draft that is approved or rejected (brain-hub D6).
    writes: [],
    spawns: [
      ...MEMORY_VERBS,
      // After a verb the hub's cache follows the files at once (else the next scan rebuilds it): brain/_index/brain-hub.json.
      { script: "brain-hub.js", args: /^$/ },
    ],
    verified: false,
  },
  {
    id: "teams",
    label: "Agent Teams",
    source: "data/teamWriter.ts (views/AgentTeamsTab.ts, views/teams/BoardPane.ts, ManagePane.ts, InteractPane.ts)",
    writes: [],
    spawns: [
      { script: "team.js", args: /^init$/ },
      // Board writes are compare-and-set: the item as the tab last read it.
      { script: "team.js", args: argv("gate", "approve", ID, ID, "--expect", JSON_OBJ) },
      { script: "team.js", args: argv("gate", "approve", ID, ID, "--expect", JSON_OBJ, "--usd", USD) },
      { script: "team.js", args: argv("budget", ID, ID, USD, "--expect", JSON_OBJ) },
      { script: "team.js", args: argv(/pause|resume/, ID) },
      { script: "team.js", args: argv(/pause|resume/, ID, ID) },
      { script: "team.js", args: argv("set", ID, ID, /provider|model|effort/, WORD) },
      { script: "team.js", args: argv("member", /add|remove/, ID, ID) },
      { script: "team.js", args: argv("post", ID, "--from", "user", "--kind", "note", TEXT) },
    ],
    verified: true,
  },
  {
    id: "files",
    label: "Files",
    source: "views/FilesTab.ts and data/vaultFiles.ts: a new note (and its folders), a rename or move (both ends), a file to the Trash",
    writes: ["**/*"],
    folders: ["**"],
    // data/vaultFiles.ts PROTECTED_PREFIXES, and every dot-path.
    except: PROTECTED,
    spawns: [],
    verified: true,
  },
  {
    id: "notes",
    label: "Notes",
    source: "the app's own note editor (compat/src/noteEditor.ts), not the HUD: saves of a Markdown note open in the note pane",
    scope: "editor",
    writes: ["**/*.md"],
    // Written only by the runtime's scripts (brain/_index), vendored (brain/scripts), or not notes at all.
    except: PROTECTED,
    spawns: [],
    verified: true,
  },
  {
    id: "chat",
    label: "Chat",
    source: "views/ChatTab.ts (the chat log), data/claudeAsk.ts (recall, claude -p, the spend ledger), data/askSpawner.ts (local ask)",
    writes: ["brain/_index/agentic-os-chat.jsonl", "brain/_index/provider-spend.jsonl"],
    spawns: [
      { script: "sdk/recall-cli.js", args: argv(QUESTION) },
      { script: "sdk/ask.js", args: argv("--local", QUESTION) },
      { script: "sdk/ask.js", args: argv("--local", ASK_HOST, QUESTION) },
      { script: "sdk/ask.js", args: argv("--local", ASK_HOST, ASK_MODEL, QUESTION) },
      { script: "sdk/ask.js", args: argv("--local", ASK_HOST, ASK_EFFORT, QUESTION) },
      { script: "sdk/ask.js", args: argv("--local", ASK_HOST, ASK_MODEL, ASK_EFFORT, QUESTION) },
      claudeAsk(false),
      claudeAsk(true),
    ],
    verified: true,
  },
  {
    id: "sessions",
    label: "Sessions",
    source: "main/services/sessions.ts and main/services/git.ts, for views/SessionsTab.ts (spec 2026-10-07-unidex-sessions): main runs each turn through the runtime's lib/sessions.js in a workspace folder, keeps the thread, and diffs and commits the workspace repository; the page only names a workspace, a host and a prompt",
    scope: "main",
    writes: ["brain/_index/sessions/*/*.jsonl", "brain/_index/provider-spend.jsonl", "brain/_index/agent-runs/runs.jsonl", "brain/_index/host-catalog.json"],
    folders: ["brain/_index/sessions", "brain/_index/sessions/*", "brain/_index/agent-runs"],
    spawns: [
      { script: "lib/sessions.js", args: argv("args", JSON_OBJ) },
      { script: "lib/sessions.js", args: argv("events", "--host", /claude|codex/) },
      { script: "lib/sessions.js", args: argv("events", "--host", /claude|codex/, "--model", WORD) },
      { script: "lib/sessions.js", args: argv("record", JSON_OBJ) },
      { script: "lib/sessions.js", args: argv("catalog") },
      { script: "lib/sessions.js", args: argv("catalog", "--refresh") },
    ],
    // Checked live on 2026-10-07 (plan 2026-10-07-unidex-sessions C3): a turn and a resume on each host through the runtime
    // and the real CLIs, recorded in the ledger and in Runs.
    verified: true,
  },
];

export const SURFACE_IDS: readonly string[] = SURFACES.map((s) => s.id);

/** `AOS_APP_WRITE` or the saved setting → the surfaces it names (`all` names every one) and the ids it did not recognise. */
export function parseSurfaces(spec: string | readonly string[] | null | undefined): { ids: string[]; unknown: string[] } {
  const parts = (typeof spec === "string" ? spec.split(",") : [...(spec ?? [])]).map((s) => String(s).trim()).filter(Boolean);
  const unknown = parts.filter((p) => p !== "all" && !SURFACE_IDS.includes(p));
  const ids = parts.includes("all") ? [...SURFACE_IDS] : SURFACE_IDS.filter((id) => parts.includes(id));
  return { ids, unknown };
}

/** Compiles a vault-relative glob to an anchored, case-sensitive RegExp over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith("/**", i) && i + 3 === glob.length) { re += "(?:/.*)?"; i += 2; }
    else if (glob.startsWith("**/", i)) { re += "(?:.*/)?"; i += 2; }
    else if (glob.startsWith("**", i)) { re += ".*"; i += 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The folders a file matching `glob` could live in: one pattern per leading run of its segments. */
function folderPatterns(glob: string): RegExp[] {
  const segs = glob.split("/");
  const out: RegExp[] = [];
  for (let i = 1; i < segs.length; i++) {
    out.push(globToRegExp(segs.slice(0, i).join("/")));
    if (segs[i - 1] === "**") break; // its pattern already spans every depth below
  }
  return out;
}

/** A surface's rules, compiled: what it may write, the folders it may create, less what it never touches. */
interface Compiled { files: RegExp[]; folders: RegExp[]; except: RegExp[] }
const compile = (s: Surface): Compiled => ({
  files: s.writes.map(globToRegExp),
  folders: [...s.writes.flatMap(folderPatterns), ...(s.folders ?? []).map(globToRegExp)],
  except: (s.except ?? []).map(globToRegExp),
});
const excepted = (r: Compiled, rel: string): boolean => r.except.some((re) => re.test(rel));
const writesFile = (rules: readonly Compiled[], rel: string): boolean => rules.some((r) => r.files.some((re) => re.test(rel)) && !excepted(r, rel));

function matches(rule: ArgRule, list: readonly string[]): boolean {
  return typeof rule === "function" ? rule(list) : rule.test(list.join(" "));
}

/** The enabled surfaces' rules over vault-relative, `/`-separated paths (no leading `/`, no `..`). */
export class SurfaceRules {
  /** The enabled surfaces, in table order. */
  readonly surfaces: readonly Surface[];
  private readonly hud: Compiled[];
  private readonly editor: Compiled[];
  private readonly spawns: readonly SpawnRule[];

  constructor(enabled: readonly string[] = [], table: readonly Surface[] = SURFACES) {
    this.surfaces = table.filter((s) => enabled.includes(s.id));
    const hud = this.surfaces.filter((s) => (s.scope ?? "hud") === "hud");
    this.hud = hud.map(compile);
    this.editor = this.surfaces.filter((s) => s.scope === "editor").map(compile);
    this.spawns = [...BACKGROUND, ...hud.flatMap((s) => s.spawns)];
  }

  get ids(): string[] { return this.surfaces.map((s) => s.id); }

  /** Whether an enabled HUD surface may create, change or remove this vault path. */
  canWrite(rel: string): boolean { return writesFile(this.hud, rel); }

  /** Whether this folder may be created: a HUD surface may write it, or a file it may write could live in it. */
  canMakeFolder(rel: string): boolean {
    return this.canWrite(rel) || this.hud.some((r) => r.folders.some((re) => re.test(rel)) && !excepted(r, rel));
  }

  /** Whether the app's note editor may save this vault path (an enabled editor surface, Notes). */
  canSave(rel: string): boolean { return writesFile(this.editor, rel); }

  /**
   * Whether this path may be moved or sent to the Trash with everything under it: a HUD surface may write it, and it
   * is not, and holds no, runtime folder (moving `brain` would take brain/scripts with it).
   */
  canMoveTree(rel: string): boolean {
    return this.canWrite(rel) && !RUNTIME_FOLDERS.some((r) => r === rel || r.startsWith(`${rel}/`));
  }

  /** Whether `node <vault>/brain/scripts/<script> args…` is a background refresh or an enabled surface's command. */
  canRunScript(script: string, args: readonly string[]): boolean {
    return this.spawns.some((r) => r.script === script && matches(r.args, args));
  }

  /** Whether the program `bin` (a file name) with these arguments is an enabled surface's command. */
  canRunProgram(bin: string, args: readonly string[]): boolean {
    return this.spawns.some((r) => r.bin !== undefined && r.bin === bin && matches(r.args, args));
  }
}
