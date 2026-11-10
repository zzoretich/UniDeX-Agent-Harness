// code:git (spec 2026-11-09-code-chat C8): the Code tab's Diff, git status and diff for the terminal the page names, read
// only. The page names a terminal (its pty id), never a path: main takes the folder that terminal started in
// (PtyService.info) and resolves it here to a vault workspace's folder, or to a workspace's linked code folder (`repo:` in
// its workspace.md, read as the Code page reads it: hud/src/data/repoLink.ts). Anything else is refused: the vault root,
// home, any other folder. Paths compare with links resolved on both sides. The reads are GitService's statusAt and
// diffAt, under its guards (GIT_GUARD, DIFF_SAFE, READ_ENV); nothing here writes, and no write surface gates it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodeGitRequest, GitDiff, GitStatus, Result } from "../../shared/ipc";
import { parseRepoLink } from "../../../../hud/src/data/repoLink";
import { refused } from "./fs";
import type { GitService, WorkspaceDir } from "./git";
import { WORKSPACE_RE } from "./sessions";

/** The most of a workspace.md read for its `repo:` (the frontmatter is its first lines). */
const MANIFEST_MAX = 256 * 1024;

export interface CodeRepoOptions {
  /** The user's home (default os.homedir()): what `~/…` in a `repo:` means; a `repo:` may not be home itself. */
  home?: string;
  /** The hosts' config folders a `repo:` may neither sit in nor hold (aos workspace set's rule); default $CLAUDE_CONFIG_DIR
   *  or ~/.claude, and $CODEX_HOME or ~/.codex. */
  configDirs?: string[];
}

/** A path with every link resolved (the case stored on disk, on a case-insensitive file system), or null when it is not there. */
function real(p: string): string | null {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function hostConfigDirs(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const abs = (v: string | undefined): string | null => (v && path.isAbsolute(v) ? v : null);
  return [abs(env.CLAUDE_CONFIG_DIR) ?? path.join(home, ".claude"), abs(env.CODEX_HOME) ?? path.join(home, ".codex")];
}

/** A workspace's workspace.md, or null: none, not a file, or larger than a manifest is. */
function readManifest(dir: string): string | null {
  const file = path.join(dir, "workspace.md");
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size <= MANIFEST_MAX ? fs.readFileSync(file, "utf8") : null;
  } catch { return null; }
}

/** Whether a linked folder (links resolved) may be read: not the filesystem root or home, apart from the vault (neither in
 *  it nor holding it), and apart from every host config folder (aos workspace set refuses the same when it writes one). */
function linkAllowed(dir: string, vault: string, home: string, configs: string[]): boolean {
  if (dir === path.parse(dir).root || dir === home) return false;
  if (within(dir, vault) || within(vault, dir)) return false;
  return !configs.some((c) => within(dir, c) || within(c, dir));
}

/**
 * The folder code:git reads for a terminal whose cwd is `cwd`: a cwd under `<vault>/workspaces/<name>` resolves to that
 * workspace's folder; else a workspace whose `repo:` (absolute, outside the vault) is the cwd or holds it resolves to that
 * folder (the deepest, when links nest); anything else is refused.
 */
export function resolveCodeRepo(vault: string, cwd: string, o: CodeRepoOptions = {}): WorkspaceDir {
  if (!path.isAbsolute(vault) || !path.isAbsolute(cwd)) return { refusal: "not a folder main knows" };
  const v = real(vault);
  if (!v) return { refusal: "no vault is open" };
  const c = real(cwd);
  if (!c) return { refusal: "the terminal's folder is not there" };
  const root = real(path.join(v, "workspaces"));
  if (root && c !== root && within(c, root)) {
    const name = path.relative(root, c).split(path.sep)[0];
    // Not a hidden folder, the team worktrees or the archive (sessions.ts WORKSPACE_RE).
    return WORKSPACE_RE.test(name) ? { dir: path.join(root, name) } : { refusal: "not a workspace folder" };
  }
  if (within(c, v)) return { refusal: "the vault, outside its workspaces" };
  const home = path.resolve(o.home ?? os.homedir());
  const homeReal = real(home) ?? home;
  const configs = (o.configDirs ?? hostConfigDirs(home)).map((d) => real(d) ?? path.resolve(d));
  let names: string[] = [];
  try { names = root ? fs.readdirSync(root) : []; } catch { /* no workspaces */ }
  let best: string | null = null;
  for (const name of names) {
    if (!root || !WORKSPACE_RE.test(name)) continue;
    // Relative or inside the vault (as written): null.
    const link = parseRepoLink(readManifest(path.join(root, name)), home, v);
    const dir = link ? real(link) : null;
    if (!dir || !linkAllowed(dir, v, homeReal, configs)) continue;
    if (within(c, dir) && (!best || dir.length > best.length)) best = dir;
  }
  return best ? { dir: best } : { refusal: "not a workspace or a workspace's linked code folder" };
}

export interface CodeGitOptions extends CodeRepoOptions {
  vaultRoot: () => string | null;
  /** The folder a terminal started in (PtyService.info), or null for a pty main does not know (never started, closed). */
  ptyInfo: (pty: string) => { cwd: string } | null;
  git: Pick<GitService, "statusAt" | "diffAt">;
}

export class CodeGitService {
  constructor(private readonly o: CodeGitOptions) {}

  /** The folder for the terminal `pty`, or why there is none. */
  dirOf(pty: string): WorkspaceDir {
    const vault = this.o.vaultRoot();
    if (!vault) return { refusal: "no vault is open" };
    const info = this.o.ptyInfo(pty);
    if (!info) return { refusal: "no such terminal" };
    return resolveCodeRepo(vault, info.cwd, this.o);
  }

  async run(req: CodeGitRequest): Promise<Result<GitStatus | GitDiff>> {
    const w = this.dirOf(req.pty);
    if ("refusal" in w) return refused(w.refusal);
    return req.op === "status" ? this.o.git.statusAt(w.dir) : this.o.git.diffAt(w.dir, req.file);
  }
}
