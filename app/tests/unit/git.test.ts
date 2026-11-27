// GitService: the read-only git behind Code's Diff pane (code-chat C8): statusAt and diffAt in a folder main chose, with
// the guards that keep a repository's own config from running anything (spaces-redesign D24, spec §6, R54). Ported from the
// Sessions tests when that service went (remove-sessions D11); the commit went with it, so every run here is a read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DIFF_SAFE, GIT_GUARD, GitService, filterOverrides, parseNumstat, parseStatus, untrackedLines } from "../../src/main/services/git";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aos-git-app-"));

test("statusAt and diffAt: status, a new file's diff, and +/- counts against HEAD; a folder that is no repository reads as none", async () => {
  const repo = path.join(tmp, "tide");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", ["test", "example.invalid"].join("@")); // a placeholder identity, built so no address sits in the source
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  const git = new GitService({ env: process.env });
  const st = await git.statusAt(repo);
  assert.ok(st.ok);
  assert.deepEqual([st.data.repo, st.data.branch, st.data.files], [true, "main", [{ status: "??", path: "a.txt", added: 1, removed: 0 }]], "a repository with no commit yet counts too");
  const d = await git.diffAt(repo, "a.txt");
  assert.ok(d.ok);
  assert.match(d.data.text, /\+one/);
  assert.deepEqual(await git.diffAt(repo, "../outside"), { ok: false, error: "a file outside the workspace", code: "EROFS" });
  g("add", "-A");
  g("commit", "-q", "-m", "Add a");
  // +/- per file against HEAD (sessions-ux U11): a changed file, a new text file, a new binary file.
  fs.writeFileSync(path.join(repo, "a.txt"), "uno\ntwo\nthree\n");
  fs.writeFileSync(path.join(repo, "b.md"), "x\ny");
  fs.writeFileSync(path.join(repo, "c.bin"), Buffer.from([1, 0, 2]));
  const counted = await git.statusAt(repo);
  assert.ok(counted.ok);
  assert.deepEqual(counted.data.files.map((f) => [f.path, f.added, f.removed]), [["a.txt", 3, 1], ["b.md", 2, 0], ["c.bin", null, null]]);
  const plain = path.join(tmp, "plain-folder");
  fs.mkdirSync(plain);
  assert.deepEqual(await git.statusAt(plain), { ok: true, data: { repo: false, branch: null, detached: false, merging: false, files: [] } });
});

test("diffAt: a new file's diff never follows a link to a folder out of the repository (R54)", async () => {
  const repo = path.join(tmp, "reef");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  const away = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sessions-away-"));
  fs.writeFileSync(path.join(away, "null"), "away-null-text\n");
  fs.symlinkSync(away, path.join(repo, "lnk"));
  const git = new GitService({ env: process.env });
  for (const file of ["lnk", "lnk/."]) {
    const r = await git.diffAt(repo, file);
    assert.equal(r.ok, false, `${file}: ${JSON.stringify(r)}`);
    assert.ok(!r.ok && !/away-null-text/.test(r.error));
  }
  fs.rmSync(away, { recursive: true, force: true });
});

test("parseStatus reads branch, detached HEAD, changed, renamed, unmerged and new files", () => {
  const out = ["# branch.head (detached)", "1 .M N... 100644 100644 100644 a b src/a b.js", "2 R. N... 100644 100644 100644 a b R100 new.js\told.js", "u UU N... 1 2 3 4 a b c conflict.js", "? notes.md"].join("\n");
  const f = (status: string, p: string) => ({ status, path: p, added: null, removed: null });
  assert.deepEqual(parseStatus(out), { branch: null, detached: true, files: [f(".M", "src/a b.js"), f("R.", "new.js"), f("UU", "conflict.js"), f("??", "notes.md")] });
});

test("parseNumstat and untrackedLines: counts by path, a rename by its new path, a binary file as null", () => {
  const out = ["3\t1\tsrc/a b.js", "-\t-\timg.png", "2\t0\t", "old.js", "new.js", ""].join("\0");
  assert.deepEqual([...parseNumstat(out)], [["src/a b.js", [3, 1]], ["img.png", [null, null]], ["new.js", [2, 0]]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-numstat-"));
  const w = (name: string, data: string | Buffer) => { fs.writeFileSync(path.join(dir, name), data); return path.join(dir, name); };
  assert.equal(untrackedLines(w("a", "one\ntwo\n")), 2);
  assert.equal(untrackedLines(w("b", "one\ntwo")), 2, "a last line without its newline counts");
  assert.equal(untrackedLines(w("c", "")), 0);
  assert.equal(untrackedLines(w("d", Buffer.from([0x61, 0]))), null);
  assert.equal(untrackedLines(path.join(dir, "missing")), null);
  // A link is never followed: not to a file outside the workspace, and not to a FIFO, whose open would block main.
  const outside = w("outside.txt", "secret\nlines\n");
  fs.symlinkSync(outside, path.join(dir, "link"));
  assert.equal(untrackedLines(path.join(dir, "link")), null);
  execFileSync("mkfifo", [path.join(dir, "fifo")]);
  fs.symlinkSync(path.join(dir, "fifo"), path.join(dir, "fifo-link"));
  assert.equal(untrackedLines(path.join(dir, "fifo")), null);
  assert.equal(untrackedLines(path.join(dir, "fifo-link")), null);
});

test("statusAt and diffAt: a workspace folder inside another repository (a vault kept in git) is not a repository of its own: nothing to read", async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sessions-outer-"));
  const v = path.join(outer, "vault");
  const plain = path.join(v, "workspaces", "plain");
  fs.mkdirSync(plain, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: v, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(v, "note.md"), "a vault note\n");
  fs.writeFileSync(path.join(plain, "a.txt"), "one\n");
  const git = new GitService({ env: process.env });
  assert.deepEqual(await git.statusAt(plain), { ok: true, data: { repo: false, branch: null, detached: false, merging: false, files: [] } });
  assert.deepEqual(await git.diffAt(plain, "a.txt"), { ok: false, error: "not a git repository", code: "EROFS" });
  fs.rmSync(outer, { recursive: true, force: true });
});

test("git: every command carries the repo-config guard, so a repository's core.fsmonitor never runs (spaces-redesign D24)", async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sessions-guard-"));
  const v = path.join(outer, "vault");
  const repo = path.join(v, "workspaces", "guarded");
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", ["test", "example.invalid"].join("@"));
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "first");
  const marker = path.join(outer, "fsmonitor-ran");
  const hook = path.join(outer, "fsmonitor.sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  g("config", "core.fsmonitor", hook);
  execFileSync("git", ["status", "--porcelain=v2"], { cwd: repo, stdio: "ignore" });
  assert.ok(fs.existsSync(marker), "the control: plain git status runs the hook");
  fs.rmSync(marker);
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  const git = new GitService({ env: process.env });
  const st = await git.statusAt(repo);
  assert.ok(st.ok && st.data.repo && st.data.files.length === 1, JSON.stringify(st));
  assert.ok((await git.diffAt(repo, "a.txt")).ok);
  assert.equal(fs.existsSync(marker), false, "core.fsmonitor never ran");
  // Every argv starts with the guard, whatever the command.
  const seen: string[][] = [];
  const fake = ((_file: string, args: readonly string[], _opts: unknown, cb: (e: null, out: string, err: string) => void) => {
    seen.push([...args]);
    cb(null, "", "");
  }) as unknown as typeof execFile;
  const spy = new GitService({ env: process.env, execFileImpl: fake });
  await spy.statusAt(repo);
  await spy.diffAt(repo);
  assert.ok(seen.length >= 2, String(seen.length));
  for (const a of seen) assert.deepEqual(a.slice(0, GIT_GUARD.length), [...GIT_GUARD], a.join(" "));
  assert.deepEqual([...GIT_GUARD], ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "core.untrackedCache=false", "--no-optional-locks"]);
  fs.rmSync(outer, { recursive: true, force: true });
});

test("filterOverrides turns off every filter driver below global and system scope, a name with = included", () => {
  const out = ["local", "filter.evil.clean", "local", "filter.a=b.process", "worktree", "filter.x.y.smudge", "global", "filter.lfs.clean", "system", "filter.s.clean", ""].join("\0");
  const off = (n: string) => [`--config-env=filter.${n}.clean=AOS_GIT_EMPTY`, `--config-env=filter.${n}.smudge=AOS_GIT_EMPTY`, `--config-env=filter.${n}.process=AOS_GIT_EMPTY`, `--config-env=filter.${n}.required=AOS_GIT_FALSE`];
  assert.deepEqual(filterOverrides(out), [...off("evil"), ...off("a=b"), ...off("x.y")]);
  assert.deepEqual(filterOverrides(""), []);
});

test("git: status and diff run no filter driver, external diff or textconv the repository defines (spec §6)", async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sessions-drivers-"));
  const v = path.join(outer, "vault");
  const repo = path.join(v, "workspaces", "drivers");
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", ["test", "example.invalid"].join("@"));
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "first");
  const log = path.join(outer, "ran.log");
  const script = (name: string, body: string) => {
    const p = path.join(outer, `${name}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\necho ${name} >> "${log}"\n${body}\n`, { mode: 0o755 });
    return p;
  };
  g("config", "filter.evil.clean", script("clean", "cat"));
  g("config", "diff.external", script("external", "exit 0"));
  g("config", "diff.tc.textconv", script("textconv", "cat \"$1\""));
  fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "* filter=evil diff=tc\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
  const ran = () => (fs.existsSync(log) ? [...new Set(fs.readFileSync(log, "utf8").trim().split("\n"))].sort() : []);
  // Control: plain git runs all three.
  execFileSync("git", ["diff", "HEAD"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["diff", "--no-ext-diff", "HEAD"], { cwd: repo, stdio: "ignore" });
  assert.deepEqual(ran(), ["clean", "external", "textconv"], "the control ran every driver");
  fs.rmSync(log);
  const git = new GitService({ env: process.env });
  const st = await git.statusAt(repo);
  assert.ok(st.ok && st.data.files.length === 2, JSON.stringify(st));
  const whole = await git.diffAt(repo);
  assert.ok(whole.ok && /\+two/.test(whole.data.text), JSON.stringify(whole));
  assert.ok((await git.diffAt(repo, "a.txt")).ok);
  const added = await git.diffAt(repo, "new.txt");
  assert.ok(added.ok && /\+new/.test(added.data.text), JSON.stringify(added));
  assert.deepEqual(ran(), [], "no driver the repository names ran");
  fs.rmSync(outer, { recursive: true, force: true });
});

test("git: status and diff run nothing a submodule's own config names: no status inside it, no diff inside it (R54)", async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sessions-submodule-"));
  const v = path.join(outer, "vault");
  const sup = path.join(v, "workspaces", "harbor");
  const origin = path.join(outer, "sub-origin");
  fs.mkdirSync(sup, { recursive: true });
  fs.mkdirSync(origin);
  const gi = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", `user.email=${["test", "example.invalid"].join("@")}`, "-c", "user.name=Test", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...a], { cwd, stdio: "ignore" });
  gi(origin, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(origin, "f.txt"), "one\n");
  fs.writeFileSync(path.join(origin, "g.txt"), "g\n");
  gi(origin, "add", "-A");
  gi(origin, "commit", "-q", "-m", "first");
  gi(sup, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(sup, "a.txt"), "one\n");
  gi(sup, "add", "-A");
  gi(sup, "commit", "-q", "-m", "first");
  gi(sup, "submodule", "add", "-q", origin, "sub");
  gi(sup, "commit", "-q", "-m", "add sub");
  const sub = path.join(sup, "sub");
  // The submodule moves to a commit the superproject has not recorded, and one of its files changes in its work tree.
  fs.writeFileSync(path.join(sub, "g.txt"), "g2\n");
  gi(sub, "commit", "-q", "-a", "-m", "second");
  const log = path.join(outer, "ran.log");
  const script = (name: string, body: string) => {
    const p = path.join(outer, `${name}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\necho ${name} >> "${log}"\n${body}\n`, { mode: 0o755 });
    return p;
  };
  // The submodule's own config (.git/modules/sub/config): one the superproject's filter overrides never read.
  execFileSync("git", ["config", "filter.evil.clean", script("clean", "cat")], { cwd: sub });
  execFileSync("git", ["config", "diff.external", script("external", "exit 0")], { cwd: sub });
  execFileSync("git", ["config", "diff.tc.textconv", script("textconv", "cat \"$1\"")], { cwd: sub });
  const info = execFileSync("git", ["rev-parse", "--git-path", "info"], { cwd: sub, encoding: "utf8" }).trim();
  fs.mkdirSync(path.resolve(sub, info), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(sub, info), "attributes"), "* filter=evil diff=tc\n");
  fs.writeFileSync(path.join(sub, "f.txt"), "two\n");
  // The superproject asks for a submodule's change as a diff run inside it.
  execFileSync("git", ["config", "diff.submodule", "diff"], { cwd: sup });
  const ran = () => (fs.existsSync(log) ? [...new Set(fs.readFileSync(log, "utf8").trim().split("\n"))].sort() : []);
  // Control: plain git runs the submodule's filter on status, and its external diff on a guarded diff.
  execFileSync("git", ["status", "--porcelain=v2"], { cwd: sup, stdio: "ignore" });
  assert.deepEqual(ran(), ["clean"], "the control ran the submodule's filter");
  fs.rmSync(log);
  execFileSync("git", ["-c", "core.fsmonitor=false", "diff", ...DIFF_SAFE, "--ignore-submodules=dirty", "HEAD"], { cwd: sup, stdio: "ignore" });
  assert.deepEqual(ran(), ["external"], "the control ran the submodule's external diff");
  fs.rmSync(log);
  const git = new GitService({ env: process.env });
  const st = await git.statusAt(sup);
  const whole = await git.diffAt(sup);
  const one = await git.diffAt(sup, "sub");
  assert.deepEqual(ran(), [], "nothing the submodule's config names ran");
  assert.ok(st.ok && st.data.repo, JSON.stringify(st));
  assert.deepEqual(st.data.files.map((f) => f.path), ["sub"], "a submodule on a new commit is still listed");
  // Its change as git's short form: the two commits.
  assert.ok(whole.ok && /^\+Subproject commit [0-9a-f]{40}$/m.test(whole.data.text), JSON.stringify(whole));
  assert.ok(one.ok && /Subproject commit/.test(one.data.text), JSON.stringify(one));
  fs.rmSync(outer, { recursive: true, force: true });
});

test("git: every diff passes --no-ext-diff --no-textconv; every run is a read, with no lazy fetch and no transport", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-git-spy-"));
  const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const fake = ((_file: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv }, cb: (e: null, out: string, err: string) => void) => {
    seen.push({ args: [...args], env: opts.env });
    // The command after its global options: GIT_GUARD, filterOverrides' --config-env, and a `-c key=value` (status's quotePath).
    const a = args.slice(GIT_GUARD.length).filter((x) => !x.startsWith("--config-env=")).filter((x, i, all) => x !== "-c" && all[i - 1] !== "-c");
    if (a[0] === "rev-parse" && a[1] === "--show-toplevel") return cb(null, `${dir}\n`, "");
    if (a[0] === "rev-parse" && a[1] === "--git-path") return cb(null, ".git/MERGE_HEAD\n", "");
    if (a[0] === "status") return cb(null, "# branch.head main\n1 .M N... 100644 100644 100644 a b a.txt\n", "");
    if (a[0] === "config") return cb(null, ["local", "filter.evil.clean", ""].join("\0"), "");
    return cb(null, "", "");
  }) as unknown as typeof execFile;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: path.join(dir, "elsewhere"), GIT_WORK_TREE: path.join(dir, "elsewhere") };
  const spy = new GitService({ env, execFileImpl: fake });
  assert.ok((await spy.statusAt(dir)).ok);
  assert.ok((await spy.diffAt(dir)).ok);
  assert.ok((await spy.diffAt(dir, "a.txt")).ok);
  const diffs = seen.filter((c) => c.args.includes("diff"));
  assert.ok(diffs.length >= 5, String(diffs.length));
  for (const c of diffs) { const i = c.args.indexOf("diff"); assert.deepEqual(c.args.slice(i + 1, i + 3), [...DIFF_SAFE], c.args.join(" ")); }
  // Nothing runs inside a submodule (R54): no status in it, and its change shown as two commits, never a diff run in it.
  for (const c of seen.filter((x) => x.args.includes("status") || (x.args.includes("diff") && !x.args.includes("--no-index")))) {
    assert.ok(c.args.includes("--ignore-submodules=dirty"), c.args.join(" "));
    if (c.args.includes("diff")) assert.ok(c.args.includes("--submodule=short"), c.args.join(" "));
  }
  for (const c of seen.filter((x) => x.args.includes("status") || x.args.includes("diff"))) {
    assert.ok(c.args.includes("--config-env=filter.evil.clean=AOS_GIT_EMPTY"), c.args.join(" "));
  }
  assert.equal(seen.filter((c) => c.args.includes("add") || c.args.includes("commit")).length, 0, "nothing writes");
  for (const c of seen) {
    assert.equal(c.env.GIT_DIR, undefined, "no inherited GIT_DIR");
    assert.equal(c.env.GIT_WORK_TREE, undefined, "no inherited work tree");
    assert.equal(c.env.GIT_NO_LAZY_FETCH, "1", c.args.join(" "));
    assert.equal(c.env.GIT_ALLOW_PROTOCOL, "", c.args.join(" "));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
