// terminalLaunch.ts — what the Term tab starts and where (spec 2026-10-08-term-agent-deck T2–T11). Pure: which hosts a
// launch may use, the place a terminal lands, the line typed into its shell, the workspace stubs (a port of
// cli/workspace.js, pinned by its test) and their placeholder text (a mirror of collectors/workspaces.js, likewise),
// whether a new workspace gets its own git repo, and a workspace's linked code folder (`repo:` in its workspace.md).
// data/terminalLauncher.ts does the writes and the spawns.
import * as path from "path";
import type { AgenticosJson, ProviderState } from "./aosConfig";
import { sessionHosts } from "./aosConfig";
import { hostChoices } from "./agentSessions";
import { shq } from "./skills";

/** What a terminal runs: an agent's own terminal app, or a plain shell. */
export type TermHost = "claude" | "codex" | "shell";
/** What an agent may do (T11). "host" passes no flag: the agent behaves as if you typed `claude` or `codex` yourself. */
export type TermAccess = "host" | "read" | "edit" | "run";

export const TERM_HOSTS: readonly TermHost[] = ["claude", "codex", "shell"];
export const TERM_HOST_LABEL: Record<TermHost, string> = { claude: "Claude Code", codex: "Codex", shell: "Shell" };
export const TERM_ACCESS: readonly TermAccess[] = ["host", "read", "edit", "run"];
export const TERM_ACCESS_LABEL: Record<TermAccess, string> = { host: "Host default", read: "Read only", edit: "Edit files", run: "Edit and run commands" };
/** What each level means in a terminal, where the agent can still ask you (unlike a headless session). */
export const TERM_ACCESS_NOTE: Record<TermAccess, string> = {
  host: "As if you typed it yourself: the agent's own settings decide, and it asks you.",
  read: "Reads and plans; asks before changing anything.",
  edit: "Edits files without asking; asks before running commands.",
  run: "Edits files and runs commands; Codex still asks outside its sandbox.",
};

// ── workspaces (a port of cli/workspace.js; terminalLaunch.test.ts pins it to the CLI) ──

/** The vault's own folders under workspaces/, whatever the user typed. */
export const RESERVED_WORKSPACES: readonly string[] = ["_archive", "research"];
/** The shared workspace agents start in when no place is picked (T5). */
export const SCRATCH = "scratch";

export function slugify(name: string): string {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function isReserved(name: string, slug: string): boolean {
  const r = new Set(RESERVED_WORKSPACES);
  return r.has(slug) || r.has(String(name || "").trim().toLowerCase()) || r.has("_" + slug);
}

function titleOf(slug: string): string {
  return slug.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function instructions(slug: string, extra: string[] = []): string {
  return [
    `# ${titleOf(slug)} — project instructions`,
    "",
    `This is the \`workspaces/${slug}/\` workspace of an AgenticOS vault. Project notes, plans and status live here;`,
    "durable knowledge goes to the vault's memory through `/remember` and `/wrap` (Claude Code) or `$agenticos:remember` and",
    "`$agenticos:wrap` (Codex; `$remember` and `$wrap` when Codex is wired directly).",
    ...extra,
    "",
    "<!-- CLAUDE.md and AGENTS.md carry the same text: Claude Code reads the first, Codex the second. Edit both. -->",
    "",
  ].join("\n");
}

/** The three stubs `aos workspace new` writes, byte for byte. CLAUDE.md and AGENTS.md are identical on purpose. */
export function workspaceStubs(slug: string): Record<string, string> {
  const text = instructions(slug);
  return {
    "README.md": `# ${titleOf(slug)}\n\nOne line about what this project is.\n\n## Objectives\n\n- \n\n## Next step\n\n- \n`,
    "CLAUDE.md": text,
    "AGENTS.md": text,
  };
}

/**
 * The stubs' placeholder text, which never counts as a summary, an objective or a next step (spaces-redesign D23): a
 * mirror of TEMPLATE_TEXT in brain/scripts/collectors/workspaces.js, pinned by terminalLaunch.test.ts (the pulse-facts
 * precedent). `<slug>` stands for any workspace name and backticks are ignored; the stubs' empty `- ` bullets under
 * Objectives and Next step are skipped wherever bullets are read, so they need no entry. A workspace whose summary was
 * only this text carries `summaryTemplate: true` in the snapshot.
 */
export const TEMPLATE_TEXT: readonly string[] = Object.freeze([
  "One line about what this project is.",
  "This is the `workspaces/<slug>/` workspace of an AgenticOS vault.",
]);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TEMPLATE_RES = TEMPLATE_TEXT.map((t) => new RegExp("^" + escapeRe(t.replace(/`/g, "")).replace("<slug>", "[^/]+")));

/** Whether a line is stub placeholder text (spaces-redesign D23), as the runtime's isTemplateText decides it. */
export function isTemplateText(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const v = s.replace(/`/g, "").replace(/\s+/g, " ").trim();
  return !!v && TEMPLATE_RES.some((re) => re.test(v));
}

/** Scratch's stubs: a README that says what Scratch is, and the instructions with one line more. */
export function scratchStubs(): Record<string, string> {
  const text = instructions(SCRATCH, [
    "",
    "Scratch is shared: agents start here when someone picks Scratch in the Code tab. When the work here becomes a",
    "project, ask the user to use Make this a workspace… in the Code tab rather than building it here.",
  ]);
  return {
    "README.md": "# Scratch\n\nA shared workspace for quick questions and experiments. Pick Scratch in the Code tab's New menu to start\nClaude Code or Codex here. When something here becomes a project, use Make this a workspace… in the Code tab.\n",
    "CLAUDE.md": text,
    "AGENTS.md": text,
  };
}

/**
 * The files to write so a workspace folder has its stubs, as cli/workspace.js completeStubs does it: when exactly one
 * instruction file exists it is mirrored into the other, then every stub that is still missing is written.
 */
export function stubWrites(stubs: Record<string, string>, has: (name: string) => boolean, read: (name: string) => string): Array<{ name: string; data: string }> {
  const out: Array<{ name: string; data: string }> = [];
  const hasClaude = has("CLAUDE.md");
  const hasAgents = has("AGENTS.md");
  if (hasClaude !== hasAgents) {
    const [from, to] = hasClaude ? ["CLAUDE.md", "AGENTS.md"] : ["AGENTS.md", "CLAUDE.md"];
    out.push({ name: to, data: read(from) });
  }
  for (const name of Object.keys(stubs)) {
    if (has(name) || out.some((w) => w.name === name)) continue;
    out.push({ name, data: stubs[name] });
  }
  return out;
}

/** Why a typed name cannot be a new workspace, or null when it can (the CLI's two refusals). */
export function workspaceNameProblem(name: string): string | null {
  const slug = slugify(name);
  if (!name.trim()) return null;
  if (!slug) return "Use a letter or digit";
  if (isReserved(name, slug)) return `"${slug}" is reserved: try ${slug.replace(/^_+/, "")}-notes`;
  return null;
}

// ── git (T7) ──

/**
 * Whether a new workspace (or Scratch) should get its own git repo. Yes when the vault is not a git repo. When it is,
 * only when the vault's .gitignore ignores what is under workspaces/ and does not take this one back, so the new repo
 * never nests inside a folder the vault's own git tracks.
 */
export function gitInitWanted(vaultIsRepo: boolean, gitignore: string | null, slug: string): boolean {
  if (!vaultIsRepo) return true;
  if (!gitignore) return false;
  const lines = gitignore.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const ignored = lines.some((l) => /^\/?workspaces\/?(\*|\*\*)?$/.test(l));
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const takenBack = lines.some((l) => new RegExp(`^!\\/?workspaces\\/${esc}(\\/.*)?$`).test(l));
  return ignored && !takenBack;
}

// ── places (T4) ──

export type PlaceKind = "workspace" | "scratch" | "vault" | "home" | "other";

/** Where a terminal runs: its group in the list and the folder it starts in. */
export interface Place {
  kind: PlaceKind;
  /** What the list and the chips call it: the workspace's name, "Scratch", "Vault", "Home", or the folder's name. */
  label: string;
  /** The folder the terminal starts in. */
  dir: string;
  /** The workspace folder's name, for a workspace or Scratch. */
  workspace?: string;
  /** True when `dir` is the workspace's linked code folder rather than its own folder. */
  linked?: boolean;
}

export interface PlaceWorld {
  vault: string;
  home: string;
  /** The workspace names under <vault>/workspaces a terminal may start in (agentSessions.workspaceNames). */
  workspaces: string[];
  /** Linked code folders by workspace name (absolute). */
  links: Record<string, string>;
}

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};

/** A workspace by name as a place: in its linked code folder when it has one. */
export function workspacePlace(name: string, w: PlaceWorld): Place {
  if (name === SCRATCH) return { kind: "scratch", label: "Scratch", dir: path.join(w.vault, "workspaces", SCRATCH), workspace: SCRATCH };
  const link = w.links[name];
  return link
    ? { kind: "workspace", label: name, dir: link, workspace: name, linked: true }
    : { kind: "workspace", label: name, dir: path.join(w.vault, "workspaces", name), workspace: name };
}

export const vaultPlace = (w: PlaceWorld): Place => ({ kind: "vault", label: "Vault", dir: w.vault });
export const homePlace = (w: PlaceWorld): Place => ({ kind: "home", label: "Home", dir: w.home });

/**
 * The place a folder belongs to, by the longest match: a workspace's linked code folder, a workspace under
 * <vault>/workspaces (hidden ones such as `_worktrees` count as the vault), the vault, home, or any other folder.
 */
export function placeOf(dir: string, w: PlaceWorld): Place {
  const abs = path.resolve(dir);
  let best: { place: Place; len: number } | null = null;
  const offer = (place: Place, root: string) => {
    if (inside(abs, root) && (!best || root.length > best.len)) best = { place, len: root.length };
  };
  for (const [name, link] of Object.entries(w.links)) if (w.workspaces.includes(name)) offer(workspacePlace(name, w), path.resolve(link));
  for (const name of w.workspaces) offer(name === SCRATCH ? workspacePlace(SCRATCH, w) : { kind: "workspace", label: name, dir: path.join(w.vault, "workspaces", name), workspace: name }, path.join(w.vault, "workspaces", name));
  offer(vaultPlace(w), path.resolve(w.vault));
  const found = best as { place: Place; len: number } | null;
  if (found) return found.place;
  if (abs === path.resolve(w.home)) return homePlace(w);
  return { kind: "other", label: path.basename(abs) || abs, dir: abs };
}

/** Whether a place counts as context for a launch: only a workspace, never Scratch, the vault, home or elsewhere. */
export function isContextPlace(p: Place | null | undefined): p is Place {
  return !!p && p.kind === "workspace";
}

export type AgentPlaceDefault = "scratch" | "last" | "vault";
export type PlaceWhy = "picked" | "context" | "default";

/**
 * Where a launch lands (T4): what was picked, else what you are looking at (a workspace only), else the default:
 * agents per the "Agents start in" choice (the vault unless it says Scratch or the last workspace used), shells in
 * the shell default (the Working directory setting, else the vault).
 */
export function resolvePlace(o: {
  host: TermHost;
  picked?: Place | null;
  context?: Place | null;
  agentPlace: AgentPlaceDefault;
  lastWorkspace?: Place | null;
  scratch: Place;
  vault: Place;
  shellDefault: Place;
}): { place: Place; why: PlaceWhy } {
  if (o.picked) return { place: o.picked, why: "picked" };
  if (isContextPlace(o.context)) return { place: o.context, why: "context" };
  if (o.host === "shell") return { place: o.shellDefault, why: "default" };
  if (o.agentPlace === "scratch") return { place: o.scratch, why: "default" };
  if (o.agentPlace === "last" && isContextPlace(o.lastWorkspace)) return { place: o.lastWorkspace, why: "default" };
  return { place: o.vault, why: "default" };
}

// ── linked code folders (T8) ──

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(v: string): string {
  const s = v.trim();
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;
}

/** A `~/…` or absolute path as an absolute one; null for anything relative. */
export function expandHome(p: string, home: string): string | null {
  const s = p.trim();
  if (s === "~") return path.resolve(home);
  if (s.startsWith("~/")) return path.resolve(home, s.slice(2));
  return path.isAbsolute(s) ? path.resolve(s) : null;
}

/** The `repo:` of a workspace.md's frontmatter as an absolute folder, or null: none, relative, or inside the vault. */
export function parseRepoLink(text: string | null, home: string, vault: string): string | null {
  const m = text ? FRONTMATTER.exec(text) : null;
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => /^repo\s*:/.test(l));
  if (!line) return null;
  const abs = expandHome(unquote(line.replace(/^repo\s*:/, "")), home);
  if (!abs || inside(abs, path.resolve(vault))) return null;
  return abs;
}

/** How a linked folder is written: `~/…` when it is under home, so the note reads the same on another Mac. */
export function repoValue(abs: string, home: string): string {
  const rel = path.relative(path.resolve(home), abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : abs;
}

/** workspace.md with its frontmatter's `repo:` set (added or replaced), or removed when `repo` is null; the rest kept. */
export function withRepoLink(text: string | null, repo: string | null): string {
  const src = text ?? "";
  const m = FRONTMATTER.exec(src);
  const value = repo === null ? null : `repo: ${JSON.stringify(repo)}`;
  if (!m) return value ? `---\n${value}\n---\n${src}` : src;
  const lines = m[1].split(/\r?\n/).filter((l) => !/^repo\s*:/.test(l));
  if (value) lines.push(value);
  const body = src.slice(m[0].length);
  return lines.length ? `---\n${lines.join("\n")}\n---\n${body}` : body;
}

// ── hosts (T2) ──

export interface TermHostChoice {
  host: TermHost;
  label: string;
  /** Off in agenticos.json: not offered anywhere. */
  hidden: boolean;
  ready: boolean;
  reason: string | null;
  /** The recorded absolute binary, or null for the bare name. */
  bin: string | null;
}

/** The hosts a launch may use: the agents as the Sessions tab sees them (aos config + login cache), and the shell. */
export function termHostChoices(cfg: AgenticosJson | null, state: ProviderState | null): TermHostChoice[] {
  const enabled = sessionHosts(cfg);
  const agents = hostChoices(cfg, state).map((c): TermHostChoice => {
    const on = enabled.includes(c.host);
    const recorded = cfg?.hosts?.[c.host]?.bin || cfg?.[c.host]?.bin || state?.[c.host]?.bin || null;
    return { host: c.host, label: c.label, hidden: !on, ready: c.ready, reason: c.reason, bin: recorded && path.isAbsolute(recorded) ? recorded : null };
  });
  return [...agents, { host: "shell", label: TERM_HOST_LABEL.shell, hidden: false, ready: true, reason: null, bin: null }];
}

/**
 * The host ⌘T starts (T2): the last one launched from the deck, else the first ready agent, else the shell. When the
 * remembered host is not ready the answer is no host and why, so the caller opens the menu rather than starting
 * another one the user did not ask for.
 */
export function quickHost(remembered: TermHost | null, choices: TermHostChoice[]): { host: TermHost | null; reason: string | null } {
  const by = (h: TermHost) => choices.find((c) => c.host === h);
  if (remembered) {
    const c = by(remembered);
    if (c && !c.hidden && c.ready) return { host: remembered, reason: null };
    if (c && !c.hidden) return { host: null, reason: c.reason };
  }
  const first = choices.find((c) => c.host !== "shell" && !c.hidden && c.ready);
  return { host: first ? first.host : "shell", reason: null };
}

// ── the launch line (T10, T11) ──

/**
 * spaces-redesign D7 for Codex, checked on 2026-10-10 against codex-cli 0.162.0: `codex resume <id>` takes any
 * recorded session by UUID (exec included), and when the terminal's folder differs from the session's recorded cwd the
 * TUI asks which folder to use, unless `tui.resume_cwd` is set (codex-rs/tui/src/session_resume.rs). An explicit
 * `-C <dir>` (`--cd`, an option of `codex resume`) makes `effective_resume_cwd_mode` answer "current", so the thread
 * resumes in <dir> with no question (codex-rs/tui/src/lib.rs `resolve_startup_resume_or_fork_cwd`, which passes
 * `cli.cwd`; its test `startup_resume_and_fork_use_configured_or_explicit_cwd` pins that an explicit cwd wins even over
 * `resume_cwd = "session"`). So a resume by id of a Codex thread types `codex resume -C <cwd> <id>` (launchArgs, with
 * `LaunchSpec.cwd`; a Spaces resume passes `ResumeTarget.cwd`); `-c tui.resume_cwd=current` would do the same from the
 * terminal's own folder. Nothing here started a model session.
 */
export const CODEX_RESUME_CD = Object.freeze({
  flag: "-C",
  checked: "2026-10-10",
  version: "codex-cli 0.162.0",
});

export interface LaunchSpec {
  host: "claude" | "codex";
  /** The recorded absolute binary, or null for the bare name. */
  bin: string | null;
  /** A model id, or null for the host's own default. */
  model: string | null;
  access: TermAccess;
  /** Claude: the id the deck gives a new conversation (`--session-id`), so it can be resumed exactly. */
  sessionId?: string | null;
  /** Continue a conversation instead of starting one: by id (either host), or the latest one (Claude --continue,
   *  `codex resume --last`). */
  resume?: { id: string } | "last" | null;
  /**
   * The folder the terminal starts in. A Codex resume by id names it with `-C`: Codex otherwise asks which folder to use
   * when the thread was recorded in another one, and an explicit `--cd` answers that question with this folder
   * (spaces-redesign D7; codex-cli 0.162.0, codex-rs/tui/src/session_resume.rs `effective_resume_cwd_mode`). Claude Code
   * needs no flag: `claude --resume <id>` finds a thread started in another folder (D7's build check, 2026-10-10).
   */
  cwd?: string | null;
  /** Make the folder its own repo first (T7); a folder that already has .git is left alone. */
  gitInit?: boolean;
  /** `NAME='value' ` prefixes for a non-default config folder (teams.ts envPrefix). */
  envPrefix?: string;
}

const CLAUDE_ACCESS: Record<TermAccess, string[]> = {
  host: [],
  read: ["--permission-mode", "plan"],
  edit: ["--permission-mode", "acceptEdits"],
  run: ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"],
};
const CODEX_ACCESS: Record<TermAccess, string[]> = {
  host: [],
  read: ["-s", "read-only", "-a", "on-request"],
  edit: ["-s", "workspace-write", "-a", "on-request"],
  run: ["-s", "workspace-write", "-a", "on-request"],
};

/**
 * The ids a launch carries (spaces-redesign D7). `fresh`: the id the deck gives a new Claude Code conversation
 * (`--session-id`). `known`: the id the terminal keeps so its end bar resumes this conversation by id: the fresh one,
 * or the thread a resume by id names, on either host. A shell, a new Codex session (Codex takes no id up front) and a
 * resume of the latest conversation know none.
 */
export function launchIds(host: TermHost, resume: LaunchSpec["resume"], newId: () => string): { fresh: string | null; known: string | null } {
  if (host === "shell") return { fresh: null, known: null };
  if (resume && resume !== "last") return { fresh: null, known: resume.id };
  const fresh = host === "claude" && !resume ? newId() : null;
  return { fresh, known: fresh };
}

/** A C0 control character or DEL: typed into a shell, ^U, ^C, a newline or an escape act on the line itself. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * A free value on the agent's line (a model, an id, a folder): one that starts with `-` would read as a flag, and one
 * that holds a control character would act on the shell's line (a folder the scan found named with ^U could erase the
 * line and type another), so the line is refused rather than typed (spaces-redesign D7, spec §6; install-import B11).
 */
function free(what: string, v: string): string {
  if (v.startsWith("-")) throw new Error(`Refused a ${what} that starts with "-": ${JSON.stringify(v.slice(0, 40))}`);
  if (CONTROL_RE.test(v)) throw new Error(`Refused a ${what} that holds a control character: ${JSON.stringify(v.slice(0, 40))}`);
  return v;
}

/** Whether a value holds a C0 control character or DEL, which a launch line refuses (free). */
export function hasControl(v: string): boolean { return CONTROL_RE.test(v); }

/** The agent's words after its binary, unquoted (the model, the ids and the folder are the only free values). Throws
 *  when a free value starts with `-`. */
export function launchArgs(s: LaunchSpec): string[] {
  const model = s.model ? free("model", s.model) : null;
  const resume = s.resume && s.resume !== "last" ? { id: free("session id", s.resume.id) } : s.resume ?? null;
  if (s.host === "claude") {
    const tail = resume === "last" ? ["--continue"]
      : resume ? ["--resume", resume.id]
      : s.sessionId ? ["--session-id", free("session id", s.sessionId)] : [];
    return [...(model ? ["--model", model] : []), ...CLAUDE_ACCESS[s.access], ...tail];
  }
  // A Codex resume takes the conversation's own settings: flags beside `resume` are not verified (spec §5 gaps). By id,
  // `-C <folder>` comes first and names this terminal's folder, so Codex resumes there without asking (LaunchSpec.cwd);
  // `--last` already looks only at threads recorded in this folder.
  if (resume === "last") return ["resume", "--last"];
  if (resume) return ["resume", ...(s.cwd ? [CODEX_RESUME_CD.flag, free("folder", s.cwd)] : []), resume.id];
  return [...(model ? ["-m", model] : []), ...CODEX_ACCESS[s.access]];
}

/**
 * The line typed into the fresh shell. The leading space keeps it out of a history that ignores spaced lines. `exec`
 * hands the terminal to the agent, so the row ends with the agent's own exit code; when the binary is not there the
 * shell stays open and says so instead.
 */
export function launchLine(s: LaunchSpec): string {
  const bin = shq(s.bin || s.host);
  const argv = [bin, ...launchArgs(s).map((a) => (/^[A-Za-z0-9._:/=-]+$/.test(a) ? a : shq(a)))].join(" ");
  const label = TERM_HOST_LABEL[s.host];
  const git = s.gitInit ? "[ -e .git ] || git init -q; " : "";
  return ` ${git}command -v ${bin} >/dev/null 2>&1 && ${s.envPrefix ?? ""}exec ${argv} || echo ${shq(`${label} was not found: run aos doctor`)}`;
}

/** The short form the menu previews: `exec claude --model opus --session-id 3f2c…`. */
export function previewLine(s: LaunchSpec): string {
  const words = launchArgs(s).map((a) => (s.sessionId && a === s.sessionId ? `${a.slice(0, 4)}…` : a));
  return `${s.gitInit ? "git init -q; " : ""}exec ${s.host} ${words.join(" ")}`.trim();
}

// ── the New menu's rows (T3, T6) ──

export interface MenuRow {
  key: string;
  kind: "header" | "now" | "place" | "create" | "new";
  label: string;
  sub?: string;
  /** "now" rows: the host the row starts. */
  host?: TermHost;
  /** "place" rows: where the menu's host starts. */
  place?: Place;
  /** "create" rows: the new workspace's folder name. */
  slug?: string;
  kbd?: string;
  disabled?: boolean;
}

const NOW_KEYS: Record<TermHost, string> = { claude: "⌥⌘1", codex: "⌥⌘2", shell: "⌥⌘3" };

/**
 * What the New menu lists. With no query: Start now (one row per host that is on), then where the chosen host can
 * start (what you have selected, Scratch, the vault, home for a shell, recent and all workspaces) and New workspace.
 * With a query: a place whose name it matches exactly comes first; otherwise creating it comes first (or why it
 * cannot be made), with the closest existing places below. So Enter never starts in a near-miss like `bz-wedding`
 * when you typed `wedding` (T6).
 */
export function menuRows(o: {
  query: string;
  host: TermHost;
  choices: TermHostChoice[];
  world: PlaceWorld;
  context: Place | null;
  recent: string[];
  /** The second line of a Start now row: where and how that host would start. */
  nowSub: (host: TermHost) => string;
}): MenuRow[] {
  const rows: MenuRow[] = [];
  const w = o.world;
  const named = w.workspaces.filter((n) => n !== SCRATCH);
  const placeRow = (key: string, p: Place, label = p.label, sub?: string): MenuRow =>
    ({ key, kind: "place", label, place: p, sub: sub ?? (p.linked ? `code: ${p.dir}` : p.kind === "workspace" ? `workspaces/${p.workspace}` : p.dir) });
  const fixed: Array<{ name: string; row: MenuRow }> = [
    { name: "vault", row: placeRow("vault", vaultPlace(w), "Vault", "the vault itself · when nothing is picked") },
    { name: "scratch", row: placeRow("scratch", workspacePlace(SCRATCH, w), "Scratch", "workspaces/scratch · a shared workspace") },
    ...(o.host === "shell" ? [{ name: "home", row: placeRow("home", homePlace(w), "Home", "~") }] : []),
  ];
  const q = o.query.trim().toLowerCase();
  if (!q) {
    rows.push({ key: "h-now", kind: "header", label: "Start now" });
    for (const c of o.choices) {
      if (c.hidden) continue;
      rows.push({ key: `now-${c.host}`, kind: "now", host: c.host, label: c.label, kbd: NOW_KEYS[c.host], disabled: !c.ready, sub: c.ready ? o.nowSub(c.host) : c.reason ?? "" });
    }
    rows.push({ key: "h-in", kind: "header", label: `Start ${TERM_HOST_LABEL[o.host]} in…` });
    if (isContextPlace(o.context)) rows.push(placeRow("same", o.context, "Same as selected", o.context.label));
    rows.push(...fixed.map((f) => f.row));
    const recent = o.recent.filter((n) => named.includes(n)).slice(0, 3);
    if (recent.length) {
      rows.push({ key: "h-recent", kind: "header", label: "Recent" });
      for (const n of recent) rows.push(placeRow(`recent-${n}`, workspacePlace(n, w)));
    }
    if (named.length) {
      rows.push({ key: "h-ws", kind: "header", label: "Workspaces" });
      for (const n of named) rows.push(placeRow(`ws-${n}`, workspacePlace(n, w)));
    }
    rows.push({ key: "new", kind: "new", label: "New workspace…", sub: `name it, then ${TERM_HOST_LABEL[o.host]} starts there`, kbd: "⇧⌘N" });
    return rows;
  }
  const slug = slugify(o.query);
  const cands: Array<{ name: string; row: MenuRow }> = [...fixed, ...named.map((n) => ({ name: n, row: placeRow(`ws-${n}`, workspacePlace(n, w)) }))];
  const exact = cands.find((c) => c.name === q || (!!slug && c.name === slug));
  const near = cands.filter((c) => c !== exact && (c.name.includes(q) || (!!slug && c.name.includes(slug)))).slice(0, 5);
  if (exact) rows.push(exact.row);
  else {
    const problem = workspaceNameProblem(o.query);
    rows.push(problem
      ? { key: "create", kind: "create", label: problem, disabled: true }
      : { key: "create", kind: "create", slug, label: `Create workspaces/${slug} and ${o.host === "shell" ? "open a shell" : `start ${TERM_HOST_LABEL[o.host]}`}`, sub: "README.md, CLAUDE.md and AGENTS.md", kbd: "⏎" });
  }
  if (near.length) {
    rows.push({ key: "h-near", kind: "header", label: exact ? "Also matching" : "Closest existing (↓ to pick)" });
    rows.push(...near.map((c) => c.row));
  }
  return rows;
}

/** The row Enter acts on first: the first one that is not a header and not disabled. */
export function firstActionable(rows: MenuRow[]): MenuRow | null {
  return rows.find((r) => r.kind !== "header" && !r.disabled) ?? null;
}
