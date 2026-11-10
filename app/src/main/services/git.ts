// A workspace's repository, for Sessions (spec 2026-10-07-unidex-sessions S9): what changed, one file's diff, and the
// commit the user asks for. Everything but commit only reads. Commit runs `git add -A` and `git commit -m <message>`
// only on the Commit button, with the message the user saw; nothing is ever pushed. git is the user's own (a bare
// name main's PATH finds), run without a shell in the workspace folder with a timeout. A file the page names must stay
// inside the workspace and follows `--`, so it is never read as an option. statusAt and diffAt read a folder main chose
// itself: a workspace's, or for the Code tab's Diff (code-chat C8) a workspace's or its linked code folder's
// (services/code-git.ts), with the same guards.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitDiff, GitStatus, Result } from "../../shared/ipc";
import { refused } from "./fs";

/** The most bytes of diff the page gets at once. */
export const DIFF_MAX = 2 * 1024 * 1024;
const STATUS_MAX = 4 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
/**
 * Before every git command (spaces-redesign D24, spec §6, the rules of the runtime's collectors/util.js). A read (status,
 * diff, rev-parse, ls-files, config) may not run a program the repository's own config names:
 *   core.fsmonitor (a hook on status), log.showSignature (gpg.program on a signed commit): off through GIT_GUARD's -c,
 *     which beats the repo's config and reaches the git processes git starts itself;
 *   filter.<driver>.clean/smudge/process (status and diff re-hash a changed file through them): every driver defined
 *     below global and system scope is turned off (filterOverrides), so the user's own (git-lfs) still work;
 *   diff.external, diff.<driver>.command and textconv: every diff passes DIFF_SAFE;
 *   a submodule's own config, which neither of the above reads (its filter drivers on the status git runs inside it, its
 *     external diff on the diff diff.submodule=diff runs inside it): status and every diff pass SUBMODULE_SAFE;
 *   a lazy fetch in a partial clone (core.sshCommand, remote helpers): READ_ENV, which allows no transport at all.
 * Commit is the user's own act on the Commit button: `add -A` and `commit` run the repository's filters, hooks
 * (core.hooksPath) and signing (commit.gpgsign, gpg.program) as they would in a terminal (SECURITY.md). --no-optional-locks
 * with no untracked cache keeps a read from writing the index.
 */
export const GIT_GUARD: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "core.untrackedCache=false", "--no-optional-locks"];
/** After `diff`: no external diff program and no textconv driver. */
export const DIFF_SAFE: readonly string[] = ["--no-ext-diff", "--no-textconv"];
/**
 * After `status` and `diff`: a submodule counts as changed only when its commit moved, so git never runs `status` inside it
 * (code-chat R54). The command line beats diff.ignoreSubmodules, submodule.<name>.ignore and .gitmodules.
 */
export const SUBMODULE_SAFE: readonly string[] = ["--ignore-submodules=dirty"];
/** After a `diff`'s DIFF_SAFE: SUBMODULE_SAFE, and a moved submodule shown as its two commits, never as a diff run inside it. */
const DIFF_SUBMODULE_SAFE: readonly string[] = [...SUBMODULE_SAFE, "--submodule=short"];
/** A read's environment on top of the rest: no lazy fetch, and an empty transport allow-list the repo cannot widen. */
export const READ_ENV: Readonly<Record<string, string>> = { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_LITERAL_PATHSPECS: "1" };
// filterOverrides' --config-env values: an empty command and required=false turn a driver off without failing a read.
const EMPTY_ENV = "AOS_GIT_EMPTY";
const FALSE_ENV = "AOS_GIT_FALSE";

/**
 * `config -z --show-scope --name-only --get-regexp ^filter\.` → the global options that turn off, for one command, every
 * filter driver defined below global and system scope (.git/config, the worktree config, a file either includes).
 * `--config-env` splits at the last `=`, so a driver named with `=` is turned off too.
 */
export function filterOverrides(out: string): string[] {
  const t = out.split("\0");
  const names = new Set<string>();
  for (let i = 0; i + 1 < t.length; i += 2) {
    const [scope, key] = [t[i], t[i + 1]];
    if (scope === "global" || scope === "system" || !key.startsWith("filter.")) continue;
    const dot = key.lastIndexOf(".");
    if (dot >= "filter.".length) names.add(key.slice("filter.".length, dot));
  }
  const args: string[] = [];
  for (const n of names) {
    for (const k of ["clean", "smudge", "process"]) args.push(`--config-env=filter.${n}.${k}=${EMPTY_ENV}`);
    args.push(`--config-env=filter.${n}.required=${FALSE_ENV}`);
  }
  return args;
}

export type WorkspaceDir = { dir: string } | { refusal: string };

export interface GitServiceOptions {
  /** The folder of a workspace by name, or why there is none (shared with the session service). */
  workspace: (name: string) => WorkspaceDir;
  /** Whether the Sessions surface is on. */
  enabled: () => boolean;
  env: NodeJS.ProcessEnv;
  execFileImpl?: typeof childProcess.execFile;
}

interface Run { code: number; stdout: string; stderr: string; truncated: boolean }

/** A file the page names: relative to the workspace, inside it, and plain text. */
export function fileRefusal(file: string): string | null {
  if (!file || file.length > 4096 || file.includes("\0")) return "a file name";
  // Status writes a name it still quotes (one with a quote, a backslash or a control character) C-quoted: that text,
  // quotes and all, never names a file.
  if (file.startsWith('"')) return "a file name";
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) return "a file outside the workspace";
  return null;
}

/** `git status --porcelain=v2 --branch` → the parts the page shows. */
export function parseStatus(out: string): Omit<GitStatus, "repo" | "merging"> {
  let branch: string | null = null;
  let detached = false;
  const files: GitStatus["files"] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      detached = head === "(detached)";
      branch = detached ? null : head;
    } else if (line.startsWith("1 ")) {
      const f = line.split(" ");
      files.push({ status: f[1], path: f.slice(8).join(" "), added: null, removed: null });
    } else if (line.startsWith("2 ")) {
      const f = line.split(" ");
      files.push({ status: f[1], path: f.slice(9).join(" ").split("\t")[0], added: null, removed: null });
    } else if (line.startsWith("u ")) {
      const f = line.split(" ");
      files.push({ status: f[1], path: f.slice(10).join(" "), added: null, removed: null });
    } else if (line.startsWith("? ")) {
      files.push({ status: "??", path: line.slice(2), added: null, removed: null });
    }
  }
  return { branch, detached, files };
}

/** `git diff --numstat -z` → path → [added, removed], null for a binary file. A rename is keyed by its new path. */
export function parseNumstat(out: string): Map<string, [number | null, number | null]> {
  const counts = new Map<string, [number | null, number | null]>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let file = m[3];
    if (file === "") { file = parts[i + 2] ?? ""; i += 2; }   // a rename: "a\tr\t" NUL old NUL new
    const n = (v: string): number | null => (v === "-" ? null : Number(v));
    if (file) counts.set(file, [n(m[1]), n(m[2])]);
  }
  return counts;
}

/**
 * An untracked file's lines, all added; null for a binary or unreadable one, or anything but a regular file: a link is
 * never followed (out of the workspace, or to a FIFO that would block main). Reads at most UNTRACKED_READ bytes.
 */
export function untrackedLines(file: string): number | null {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
    const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return null;
      const buf = Buffer.alloc(Math.min(st.size, UNTRACKED_READ));
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (buf.includes(0)) return null;
      if (!buf.length) return 0;
      let lines = 0;
      for (const b of buf) if (b === 10) lines += 1;
      return buf[buf.length - 1] === 10 ? lines : lines + 1;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** git's empty tree: what a repository with no commit yet is compared with. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const UNTRACKED_READ = 1024 * 1024;
const UNTRACKED_COUNTED = 200;
const NOT_REPO: GitStatus = { repo: false, branch: null, detached: false, merging: false, files: [] };

export class GitService {
  constructor(private readonly o: GitServiceOptions) {}

  /** `git <guard> <args…>` in `dir`. A read (the default) gets READ_ENV; only add and commit pass `write`. */
  private run(dir: string, args: readonly string[], o: { maxBuffer?: number; write?: boolean } = {}): Promise<Run> {
    const env: NodeJS.ProcessEnv = { ...this.o.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", [EMPTY_ENV]: "", [FALSE_ENV]: "false", ...(o.write ? {} : READ_ENV) };
    // The cwd picks the repository, never a GIT_DIR or work tree inherited from a parent git process.
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[k];
    const maxBuffer = o.maxBuffer ?? STATUS_MAX;
    return new Promise((resolve) => {
      (this.o.execFileImpl ?? childProcess.execFile)("git", [...GIT_GUARD, ...args], { cwd: dir, env, maxBuffer, timeout: TIMEOUT_MS, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const truncated = !!e && e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        // An exit status as git gave it; -1 when git did not exit on its own (missing, killed at the timeout).
        const code = !e || truncated ? 0 : typeof e.code === "number" ? e.code : -1;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), truncated });
      });
    });
  }

  /** filterOverrides for the repository at `dir` (reading config runs nothing), or null when git cannot say. */
  private async filters(dir: string): Promise<string[] | null> {
    const r = await this.run(dir, ["config", "-z", "--show-scope", "--name-only", "--get-regexp", "^filter\\."]);
    if (r.code === 1 && !r.stdout) return []; // no filter defined anywhere
    return r.code === 0 ? filterOverrides(r.stdout) : null;
  }

  private dir(workspace: string): WorkspaceDir {
    if (!this.o.enabled()) return { refusal: "the Sessions surface is off" };
    return this.o.workspace(workspace);
  }

  async status(workspace: string): Promise<Result<GitStatus>> {
    const w = this.dir(workspace);
    if ("refusal" in w) return refused(w.refusal);
    return this.statusAt(w.dir);
  }

  /** The status of the repository whose top level is `dir` (a folder main chose: a workspace, or code-chat's code:git). */
  async statusAt(dir: string): Promise<Result<GitStatus>> {
    return { ok: true, data: await this.statusOf(dir) };
  }

  private async statusOf(dir: string, known?: readonly string[] | null): Promise<GitStatus> {
    // The workspace's own repository only: a folder inside another one (a vault kept in git) is not a repository here,
    // or its status would be the vault's and Commit would add the whole vault.
    const top = await this.run(dir, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || !sameDir(top.stdout.trim(), dir)) return NOT_REPO;
    // When git cannot say which filter drivers the repository defines, nothing that could run one is read.
    const filters = known === undefined ? await this.filters(dir) : known;
    if (!filters) return NOT_REPO;
    // core.quotePath=false: a non-ASCII name comes back as it is, the name numstat -z (never quoted) keys its counts by;
    // a name with a quote, a backslash or a control character is still C-quoted, and fileRefusal refuses that text.
    const s = await this.run(dir, [...filters, "-c", "core.quotePath=false", "status", ...SUBMODULE_SAFE, "--porcelain=v2", "--branch", "--untracked-files=all"]);
    const mergeHead = await this.run(dir, ["rev-parse", "--git-path", "MERGE_HEAD"]);
    const merging = mergeHead.code === 0 && fs.existsSync(path.resolve(dir, mergeHead.stdout.trim()));
    const st = parseStatus(s.stdout);
    if (st.files.length) {
      // +/- per file (spec 2026-10-07-sessions-ux U11): tracked changes against HEAD, staged or not; untracked files count
      // their lines.
      const head = await this.run(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      const n = await this.run(dir, [...filters, "diff", ...DIFF_SAFE, ...DIFF_SUBMODULE_SAFE, "--numstat", "-z", head.code === 0 ? "HEAD" : EMPTY_TREE]);
      const counts = n.code === 0 ? parseNumstat(n.stdout) : new Map<string, [number | null, number | null]>();
      let untracked = 0;
      for (const f of st.files) {
        const c = counts.get(f.path);
        if (c) [f.added, f.removed] = c;
        else if (f.status === "??" && untracked++ < UNTRACKED_COUNTED) { f.added = untrackedLines(path.join(dir, f.path)); f.removed = f.added === null ? null : 0; }
        else if (f.status !== "??" && n.code === 0) { f.added = 0; f.removed = 0; }
      }
    }
    return { repo: true, merging, ...st };
  }

  async diff(workspace: string, file?: string): Promise<Result<GitDiff>> {
    const w = this.dir(workspace);
    if ("refusal" in w) return refused(w.refusal);
    return this.diffAt(w.dir, file);
  }

  /** The diff of the repository whose top level is `dir`, or of one file in it; a file that leads out of `dir` is refused. */
  async diffAt(dir: string, file?: string): Promise<Result<GitDiff>> {
    if (file !== undefined) { const why = fileRefusal(file); if (why) return refused(why); }
    const filters = await this.filters(dir);
    const st = await this.statusOf(dir, filters);
    if (!st.repo || !filters) return refused("not a git repository");
    const hasHead = (await this.run(dir, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
    const base = [...filters, "diff", ...DIFF_SAFE, ...DIFF_SUBMODULE_SAFE, ...(hasHead ? ["HEAD"] : [])];
    const stat = await this.run(dir, [...base, "--stat"]);
    let text: Run;
    if (file === undefined) text = await this.run(dir, base, { maxBuffer: DIFF_MAX });
    else if ((await this.run(dir, ["ls-files", "--error-unmatch", "--", file])).code === 0) text = await this.run(dir, [...base, "--", file], { maxBuffer: DIFF_MAX });
    // A new file git does not track yet: its whole text as an addition (exit 1 means "they differ"). `--no-index` opens
    // the path as the file system has it, so a folder link inside the repository must not lead it out (git's own pathspecs
    // stop at a link; this one would not). Only a path the status just listed as new qualifies, so an ignored file and
    // anything under .git (whose config can hold a remote's token) never do, and only a file: `--no-index` reads a linked
    // folder as a folder (`<folder>/null`) and waits on a pipe it is given, a linked one too (R54).
    else if (leadsOut(dir, file)) return refused("a file outside the workspace");
    else if (!st.files.some((f) => f.status === "??" && f.path === file)) return refused("not a new file in the workspace");
    else if (!plainNewFile(path.join(dir, file))) return refused("not a file: nothing to show");
    else text = await this.run(dir, [...filters, "diff", ...DIFF_SAFE, "--no-index", "--", "/dev/null", file], { maxBuffer: DIFF_MAX });
    return { ok: true, data: { stat: stat.stdout, text: text.stdout, truncated: text.truncated } };
  }

  async commit(workspace: string, message: string): Promise<Result<{ commit: string }>> {
    const w = this.dir(workspace);
    if ("refusal" in w) return refused(w.refusal);
    const msg = message.trim();
    if (!msg) return refused("a commit needs a message");
    const st = await this.statusOf(w.dir);
    if (!st.repo) return refused("not a git repository");
    if (st.detached) return refused("HEAD is detached: check out a branch first");
    if (st.merging) return refused("a merge is in progress");
    if (!st.files.length) return refused("nothing to commit");
    // The user's own commit: the repository's filters, hooks and signing run, as in a terminal (GIT_GUARD).
    const add = await this.run(w.dir, ["add", "-A"], { write: true });
    if (add.code !== 0) return { ok: false, error: lastLine(add.stderr) || "git add failed", code: "EIO" };
    const done = await this.run(w.dir, ["commit", "-m", msg], { write: true });
    if (done.code !== 0) return { ok: false, error: lastLine(done.stderr || done.stdout) || "git commit failed", code: "EIO" };
    const head = await this.run(w.dir, ["rev-parse", "HEAD"]);
    return { ok: true, data: { commit: head.stdout.trim() } };
  }
}

/**
 * Whether `file` (relative, no `..`: fileRefusal) names a path whose folder, links resolved, is outside `dir`'s: a link to
 * a folder elsewhere. The file itself may be a link (git shows a link's target as its text, never what it points at). A
 * folder that is not there leads nowhere: git finds no file in it.
 */
function leadsOut(dir: string, file: string): boolean {
  let root: string;
  try { root = fs.realpathSync(dir); } catch { return true; }
  let parent: string;
  try { parent = fs.realpathSync(path.dirname(path.join(dir, file))); } catch { return false; }
  const rel = path.relative(root, parent);
  return rel !== "" && (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/**
 * Whether `file` is what `git diff --no-index` may be given: a regular file, or a link (git shows its target as text) to a
 * regular file or to nothing. Never a folder, a pipe, a socket or a device, nor a link to one.
 */
function plainNewFile(file: string): boolean {
  try {
    const st = fs.lstatSync(file);
    if (st.isFile()) return true;
    if (!st.isSymbolicLink()) return false;
  } catch { return false; }
  try { return fs.statSync(file).isFile(); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** Whether two paths are one folder, links resolved (git prints the top level's real path). */
function sameDir(a: string, b: string): boolean {
  if (!a) return false;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

function lastLine(s: string): string {
  return s.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? "";
}
