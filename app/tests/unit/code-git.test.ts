// code:git (spec 2026-11-09-code-chat C8): the Code tab's Diff reads git in the folder main picks from the terminal's own
// cwd, never a path the page names. A vault workspace resolves to its folder; a workspace's linked code folder (`repo:` in
// its workspace.md, term-agent-deck T8) resolves to that folder, from anywhere inside it; anything else is refused. The
// reads keep git.ts's guards and work whether the Sessions surface (or the Code chat one) is on or not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeGitArgs } from "../../src/main/ipc/schemas";
import { CodeGitService, resolveCodeRepo } from "../../src/main/services/code-git";
import { GitService } from "../../src/main/services/git";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-code-git-")));
const home = path.join(tmp, "home");
const vault = path.join(home, "vault");
const ws = (name: string, manifest?: string): string => {
  const dir = path.join(vault, "workspaces", name);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, "workspace.md"), manifest);
  return dir;
};
const mk = (...p: string[]): string => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const opts = { home, configDirs: [path.join(home, ".claude"), path.join(home, ".codex")] };

const tide = ws("tide");
const code = mk(home, "Code", "app");
ws("linked", `---\nstatus: active\nrepo: ~/Code/app\n---\n# Linked\n`);
const relTarget = mk(home, "rel", "app");
ws("relative", "---\nrepo: rel/app\n---\n");
const inVault = mk(vault, "elsewhere");
ws("internal", `---\nrepo: ${JSON.stringify(inVault)}\n---\n`);
// The vault seen through a link: a `repo:` spelled through it is still inside the vault.
fs.symlinkSync(vault, path.join(home, "vault-link"));
const viaLink = mk(vault, "via-link");
ws("internal-link", `---\nrepo: ${JSON.stringify(path.join(home, "vault-link", "via-link"))}\n---\n`);
const unrelated = mk(home, "Downloads");

test("a terminal in a vault workspace resolves to that workspace's folder, from a subfolder too", () => {
  assert.deepEqual(resolveCodeRepo(vault, tide, opts), { dir: tide });
  assert.deepEqual(resolveCodeRepo(vault, mk(tide, "src", "deep"), opts), { dir: tide });
});

test("a terminal in a workspace's linked code folder resolves to that folder", () => {
  assert.deepEqual(resolveCodeRepo(vault, code, opts), { dir: code });
});

test("a subfolder of a linked code folder resolves to the linked folder, not the subfolder", () => {
  assert.deepEqual(resolveCodeRepo(vault, mk(code, "packages", "core"), opts), { dir: code });
});

test("paths compare with links resolved on both sides: a vault or a cwd named through a link resolves the same", () => {
  assert.deepEqual(resolveCodeRepo(path.join(home, "vault-link"), tide, opts), { dir: tide });
  assert.deepEqual(resolveCodeRepo(vault, path.join(home, "vault-link", "workspaces", "tide"), opts), { dir: tide });
  fs.symlinkSync(code, path.join(home, "code-link"));
  assert.deepEqual(resolveCodeRepo(vault, path.join(home, "code-link", "packages"), opts), { dir: code });
});

test("a relative repo: is refused, even where home would make it a folder", () => {
  assert.ok("refusal" in resolveCodeRepo(vault, relTarget, opts));
});

test("a repo: inside the vault is refused, spelled plainly or through a link to the vault", () => {
  assert.ok("refusal" in resolveCodeRepo(vault, inVault, opts));
  assert.ok("refusal" in resolveCodeRepo(vault, viaLink, opts));
});

test("an unrelated folder, the vault root, a hidden or archived workspace folder and home are refused", () => {
  for (const cwd of [unrelated, vault, mk(vault, "workspaces", "_worktrees", "seat"), mk(vault, "workspaces", "_archive", "old"), mk(vault, "workspaces", ".hidden"), path.join(vault, "workspaces"), home]) {
    const r = resolveCodeRepo(vault, cwd, opts);
    assert.ok("refusal" in r, `${cwd}: ${JSON.stringify(r)}`);
  }
  assert.ok("refusal" in resolveCodeRepo(vault, path.join(home, "missing"), opts), "a folder that is not there");
  assert.ok("refusal" in resolveCodeRepo(vault, "relative/cwd", opts), "a relative cwd");
});

test("a repo: that is home, the filesystem root, holds the vault, or is in a host's config folder is refused (aos workspace set's rule)", () => {
  const v2 = path.join(tmp, "v2", "vault");
  const ws2 = (name: string, repo: string) => {
    fs.mkdirSync(path.join(v2, "workspaces", name), { recursive: true });
    fs.writeFileSync(path.join(v2, "workspaces", name, "workspace.md"), `---\nrepo: ${JSON.stringify(repo)}\n---\n`);
  };
  const cfg = mk(home, ".claude", "projects");
  ws2("home", "~");
  ws2("root", "/");
  ws2("holds-vault", path.join(tmp, "v2"));
  ws2("config", cfg);
  for (const cwd of [mk(home, "Notes"), unrelated, mk(tmp, "v2", "beside"), cfg]) {
    const r = resolveCodeRepo(v2, cwd, opts);
    assert.ok("refusal" in r, `${cwd}: ${JSON.stringify(r)}`);
  }
});

// ── git ──

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "ignore" });
function repo(dir: string): void {
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", ["test", "example.invalid"].join("@")); // a placeholder identity, built so no address sits in the source
  g(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "init");
}
repo(tide);
repo(code);
// Sessions off: code:git never asks it.
const git = new GitService({ workspace: () => ({ refusal: "not used" }), enabled: () => false, env: process.env });

test("statusAt and diffAt read a folder's repository: its branch, the changed files with their counts, one file's diff", async () => {
  fs.writeFileSync(path.join(tide, "a.txt"), "uno\ntwo\n");
  const st = await git.statusAt(tide);
  assert.ok(st.ok);
  assert.deepEqual([st.data.repo, st.data.branch, st.data.files], [true, "main", [{ status: ".M", path: "a.txt", added: 2, removed: 1 }]]);
  const d = await git.diffAt(tide, "a.txt");
  assert.ok(d.ok);
  assert.match(d.data.text, /\+uno/);
  assert.match(d.data.text, /-one/);
  const all = await git.diffAt(tide);
  assert.ok(all.ok && /a\.txt/.test(all.data.stat));
  g(tide, "checkout", "-q", "--", "a.txt");
});

test("diffAt refuses a file outside the folder: climbing out, absolute, or through a linked folder that leads out", async () => {
  const outside = mk(tmp, "outside");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  fs.symlinkSync(outside, path.join(tide, "out"));
  for (const file of ["../outside/secret.txt", path.join(outside, "secret.txt"), "out/secret.txt", ""]) {
    const r = await git.diffAt(tide, file);
    assert.equal(r.ok, false, `${file}: ${JSON.stringify(r)}`);
    assert.ok(!r.ok && !/secret/.test(r.error), "nothing of the file comes back");
  }
  fs.unlinkSync(path.join(tide, "out"));
});

test("diffAt shows a new file only when status lists it as new and it is a file: never a link to a folder, an ignored file, .git or a pipe (R54)", async () => {
  const reef = mk(tmp, "reef");
  repo(reef);
  const away = mk(tmp, "away");
  // `git diff --no-index -- /dev/null lnk` takes a linked folder as a folder and reads `<folder>/null`.
  fs.writeFileSync(path.join(away, "null"), "away-null-text\n");
  fs.writeFileSync(path.join(away, "s.txt"), "away-secret-text\n");
  execFileSync("mkfifo", [path.join(away, "fifo")]);
  fs.symlinkSync(away, path.join(reef, "lnk"));
  fs.writeFileSync(path.join(reef, ".gitignore"), "local.ignored\n");
  fs.writeFileSync(path.join(reef, "local.ignored"), "ignored-text\n");
  execFileSync("mkfifo", [path.join(reef, "pipe")]);
  // A link to a pipe is listed as new (git lists links), and `--no-index` would read the pipe and wait on it.
  fs.symlinkSync(path.join(away, "fifo"), path.join(reef, "lfifo"));
  fs.symlinkSync("a.txt", path.join(reef, "alias"));
  fs.symlinkSync(path.join(away, "s.txt"), path.join(reef, "lfile"));
  for (const file of ["lnk", "lnk/.", "lnk/null", "local.ignored", ".git/HEAD", ".git/config", "pipe", "lfifo"]) {
    const r = await git.diffAt(reef, file);
    assert.equal(r.ok, false, `${file}: ${JSON.stringify(r)}`);
    assert.ok(!r.ok && !/away-|ignored-text|\[core\]/.test(r.error), `${file}: nothing of the file comes back`);
  }
  // A leaf link is shown as git shows a link: its target as text, never what it points at.
  const alias = await git.diffAt(reef, "alias");
  assert.ok(alias.ok && /^\+a\.txt$/m.test(alias.data.text), JSON.stringify(alias));
  const lfile = await git.diffAt(reef, "lfile");
  assert.ok(lfile.ok && /new file mode 120000/.test(lfile.data.text) && !/away-secret-text/.test(lfile.data.text), JSON.stringify(lfile));
  // A new plain file still shows its text.
  fs.writeFileSync(path.join(reef, "new.txt"), "fresh\n");
  const fresh = await git.diffAt(reef, "new.txt");
  assert.ok(fresh.ok && /\+fresh/.test(fresh.data.text), JSON.stringify(fresh));
});

test("diffAt reads a file name literally: a glob or pathspec magic matches nothing", async () => {
  const sand = mk(tmp, "sand");
  repo(sand);
  fs.writeFileSync(path.join(sand, "a.txt"), "changed\n");
  for (const file of ["*", "*.txt", ":(glob)*.txt", ":/a.txt", "a.tx[t]"]) {
    const r = await git.diffAt(sand, file);
    assert.equal(r.ok, false, `${file}: ${JSON.stringify(r)}`);
  }
  const ok = await git.diffAt(sand, "a.txt");
  assert.ok(ok.ok && /\+changed/.test(ok.data.text));
});

test("diffAt refuses a name in git's quoted form, which is never a file's literal name", async () => {
  const bay = mk(tmp, "bay");
  repo(bay);
  // `\303\251.txt` is how status writes a file named with an accent; a file whose name is that text, quotes and all, must
  // not stand in for it.
  fs.writeFileSync(path.join(bay, "\u00e9.txt"), "accent\n");
  const quoted = '"\\303\\251.txt"';
  fs.writeFileSync(path.join(bay, quoted), "planted\n");
  const st = await git.statusAt(bay);
  assert.ok(st.ok && st.data.files.some((f) => f.path === quoted), "status lists the accent name in its quoted form");
  const r = await git.diffAt(bay, quoted);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(!r.ok && !/planted/.test(r.error));
});

type Info = { cwd: string; startedAt: number; terminal: string | null };
function service(cwds: Record<string, string>, vaultRoot: string | null = vault) {
  return new CodeGitService({
    vaultRoot: () => vaultRoot,
    ptyInfo: (pty) => (cwds[pty] ? { cwd: cwds[pty], startedAt: 1, terminal: null } satisfies Info : null),
    git,
    ...opts,
  });
}

test("code:git: main picks the folder from the terminal's own cwd; status and diff for a workspace and a linked folder", async () => {
  const s = service({ t1: mk(tide, "src"), t2: mk(code, "packages") });
  fs.writeFileSync(path.join(code, "b.txt"), "new\n");
  const a = await s.run({ pty: "t1", op: "status" });
  assert.ok(a.ok && "files" in a.data && a.data.repo && a.data.files.length === 0, JSON.stringify(a));
  const b = await s.run({ pty: "t2", op: "status" });
  assert.ok(b.ok && "files" in b.data);
  assert.deepEqual(b.data.files, [{ status: "??", path: "b.txt", added: 1, removed: 0 }]);
  const d = await s.run({ pty: "t2", op: "diff", file: "b.txt" });
  assert.ok(d.ok && "text" in d.data && /\+new/.test(d.data.text), JSON.stringify(d));
  fs.unlinkSync(path.join(code, "b.txt"));
});

test("code:git refuses an unknown terminal, no vault, a place that is not a workspace or a linked folder, and a file outside", async () => {
  const s = service({ v: vault, h: home, u: unrelated, t: tide });
  for (const pty of ["nope", "v", "h", "u"]) {
    const r = await s.run({ pty, op: "status" });
    assert.equal(r.ok, false, pty);
    assert.ok(!r.ok && r.code === "EROFS", pty);
  }
  assert.equal((await service({ t: tide }, null).run({ pty: "t", op: "status" })).ok, false);
  assert.deepEqual(await s.run({ pty: "t", op: "diff", file: "../x" }), { ok: false, error: "a file outside the workspace", code: "EROFS" });
});

test("code:git's arguments: a terminal and an op, a file only as text; no folder, no other key", () => {
  assert.ok(CodeGitArgs.safeParse({ pty: "t1", op: "status" }).success);
  assert.ok(CodeGitArgs.safeParse({ pty: "t1", op: "diff", file: "src/a b.ts" }).success);
  for (const bad of [
    { pty: "t1", op: "commit" }, { pty: "t1", op: "status", dir: "/work/demo" }, { pty: "../t1", op: "status" }, { op: "status" },
    { pty: "t1", op: "diff", file: "" }, { pty: "t1", op: "diff", file: "a\0b" }, { pty: "t1", op: "diff", file: "x".repeat(4097) },
  ]) assert.ok(!CodeGitArgs.safeParse(bad).success, JSON.stringify(bad));
});
