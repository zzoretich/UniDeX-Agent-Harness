// Sessions and their repositories as main runs them (spec 2026-10-07-unidex-sessions S1–S3, S8, S9, S11). The vault's
// brain/scripts is the checkout's own runtime, so a turn goes through the real lib/sessions.js (plan, events, record);
// the host CLIs are stand-ins that print a recorded-shape stream and note their argv. No network, nothing spent.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEvent, SessionEventRecord } from "../../src/shared/ipc";
import type { ProgramContext } from "../../src/main/policy/programs";
import { DIFF_SAFE, GIT_GUARD, GitService, filterOverrides, parseNumstat, parseStatus, untrackedLines } from "../../src/main/services/git";
import { SessionService, workspaceDir } from "../../src/main/services/sessions";
import { COMPUTER_LOOK, COMPUTER_TOOLS } from "../../../hud/src/data/terminalLaunch";

const REPO = path.resolve(process.cwd(), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sessions-app-"));
const vault = path.join(tmp, "vault");
const bin = path.join(tmp, "bin");
const ws = path.join(vault, "workspaces", "harbor-map");
fs.mkdirSync(path.join(vault, "brain", "_index"), { recursive: true });
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(bin);
fs.writeFileSync(path.join(vault, "AGENTICOS.md"), "# vault\n");
fs.symlinkSync(path.join(REPO, "brain", "scripts"), path.join(vault, "brain", "scripts"));

/** A stand-in CLI: notes its argv and cwd, then prints `lines` (or sleeps when told to). */
function fakeHost(name: string, lines: object[]): string {
  const p = path.join(bin, name);
  const out = lines.map((l) => JSON.stringify(l)).join("\n");
  fs.writeFileSync(p, `#!${process.execPath}
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(path.join(tmp, `${name}.argv`))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), headless: process.env.AOS_HEADLESS }) + "\\n");
if (process.argv.includes("--sleep")) setTimeout(() => {}, 60000);
else process.stdout.write(${JSON.stringify(out)} + "\\n");
`, { mode: 0o755 });
  return p;
}
const CLAUDE = fakeHost("claude", [
  { type: "system", subtype: "init", session_id: "will-be-replaced" },
  { type: "assistant", message: { content: [{ type: "text", text: "Fixed." }, { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/a.js" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 } },
]);
const CODEX = fakeHost("codex", [{ type: "thread.started", thread_id: "th-1" }, { type: "item.completed", item: { id: "a", type: "agent_message", text: "Done." } }, { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } }]);
const config = (extra: object = {}) => fs.writeFileSync(path.join(vault, "brain", "config.json"), JSON.stringify({ hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: true, bin: CODEX } }, ...extra }));
config();

const context: ProgramContext = { vaultRoot: vault, home: tmp, userData: path.join(tmp, "user-data"), env: process.env, agenticos: null, shells: [] } as unknown as ProgramContext;
const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, "claude-config"), AOS_CONFIG: path.join(tmp, "none.json") };
function service(on = true): { s: SessionService; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const s = new SessionService({ vaultRoot: () => vault, enabled: () => on, context: () => context, env, node: () => process.execPath, emit: (e) => events.push(e), graceMs: 500 });
  return { s, events };
}
async function idle(s: SessionService): Promise<void> {
  for (let i = 0; i < 400 && s.runningCount > 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.runningCount, 0, "the turn finished");
}
const kinds = (rows: SessionEventRecord[]) => rows.map((r) => r.kind);
const runs = () => fs.readFileSync(path.join(vault, "brain", "_index", "agent-runs", "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

test("workspaceDir: a folder under workspaces, by one plain name", () => {
  assert.deepEqual(workspaceDir(vault, "harbor-map"), { dir: ws });
  for (const bad of ["../etc", ".git", "_worktrees", "a/b", ""]) assert.ok("refusal" in workspaceDir(vault, bad), bad);
  assert.deepEqual(workspaceDir(vault, "nope"), { refusal: "no such workspace" });
  assert.deepEqual(workspaceDir(null, "harbor-map"), { refusal: "no vault is open" });
});

test("a claude turn: planned by the runtime, run in the workspace, its events stored and sent, its spend and run recorded; the next turn resumes it", async () => {
  const { s, events } = service();
  const r = await s.start({ workspace: "harbor-map", host: "claude", text: "fix the parser", model: "sonnet" });
  assert.ok(r.ok, JSON.stringify(r));
  await idle(s);
  const read = await s.read(r.data.id);
  assert.ok(read.ok);
  assert.deepEqual(kinds(read.data), ["prompt", "session", "text", "tool", "tool_result", "usage", "done"]);
  assert.equal(read.data.at(-1)?.ok, true);
  assert.deepEqual(events.map((e) => e.event.kind), kinds(read.data), "the page saw every stored event");
  const call = JSON.parse(fs.readFileSync(path.join(tmp, "claude.argv"), "utf8").trim()) as { argv: string[]; cwd: string; headless: string };
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(ws), "it ran in the workspace");
  assert.equal(call.headless, "1");
  assert.deepEqual(call.argv.slice(call.argv.indexOf("--session-id"), call.argv.indexOf("--session-id") + 2), ["--session-id", r.data.id], "the thread id is the claude session id");
  assert.deepEqual(runs().map((row) => [row.script, row.status, row.thread]), [["session:claude", "ok", r.data.id]]);
  const ledger = fs.readFileSync(path.join(vault, "brain", "_index", "provider-spend.jsonl"), "utf8");
  assert.match(ledger, /"feature":"session:claude"/);

  const next = await s.send({ thread: r.data.id, text: "and the tests" });
  assert.ok(next.ok);
  await idle(s);
  const second = JSON.parse(fs.readFileSync(path.join(tmp, "claude.argv"), "utf8").trim().split("\n")[1]) as { argv: string[] };
  assert.ok(second.argv.includes("--resume"), "a later turn resumes");
  const list = await s.list();
  assert.ok(list.ok);
  assert.deepEqual(list.data.map((t) => [t.workspace, t.host, t.turns, t.running, t.title]), [["harbor-map", "claude", 2, false, "fix the parser"]]);
  assert.equal(list.data[0].usd, 0.04);
});

test("a codex turn resumes by the thread id codex reported", async () => {
  const { s } = service();
  const r = await s.start({ workspace: "harbor-map", host: "codex", text: "go" });
  assert.ok(r.ok);
  await idle(s);
  await s.send({ thread: r.data.id, text: "again" });
  await idle(s);
  const calls = fs.readFileSync(path.join(tmp, "codex.argv"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { argv: string[] }).argv);
  assert.deepEqual(calls[0].slice(0, 2), ["exec", "--json"]);
  assert.deepEqual(calls[1].slice(0, 2), ["exec", "resume"]);
  assert.ok(calls[1].includes("th-1"));
});

test("the runtime's refusal (the day cap) is the turn's error; Stop ends a running turn as stopped", async () => {
  config({ sessions: { perDayUsd: 0 } });
  const { s } = service();
  const r = await s.start({ workspace: "harbor-map", host: "claude", text: "x" });
  assert.ok(r.ok);
  await idle(s);
  const read = await s.read(r.data.id);
  assert.ok(read.ok);
  assert.deepEqual(kinds(read.data), ["prompt", "error", "done"]);
  assert.match(String(read.data[1].message), /sessions\.perDayUsd is 0/);
  config();

  const slow = await s.start({ workspace: "harbor-map", host: "claude", text: "--sleep" });
  assert.ok(slow.ok);
  for (let i = 0; i < 200 && !fs.readFileSync(path.join(tmp, "claude.argv"), "utf8").includes("--sleep"); i++) await new Promise((res) => setTimeout(res, 25));
  s.stop(slow.data.id);
  await idle(s);
  const stopped = await s.read(slow.data.id);
  assert.ok(stopped.ok);
  assert.deepEqual(kinds(stopped.data).slice(-2), ["error", "done"]);
  assert.equal(stopped.data.at(-2)?.message, "stopped");
  assert.equal(runs().at(-1)?.status, "stopped");
});

test("onAgent: the turn's CLI is announced with its pid, workspace, host, access and title right after it starts, and again when it exits (agent-computer D18)", async () => {
  const spawned: Array<{ cmd: string; pid: number | undefined }> = [];
  const agents: Array<Record<string, unknown>> = [];
  const spawnImpl = ((cmd: string, args: string[], opts: object) => {
    const c = childProcess.spawn(cmd, args, opts);
    spawned.push({ cmd, pid: c.pid });
    return c;
  }) as unknown as typeof childProcess.spawn;
  const s = new SessionService({
    vaultRoot: () => vault, enabled: () => true, context: () => context, env, node: () => process.execPath, emit: () => {}, graceMs: 500, spawnImpl,
    onAgent: (ev) => {
      agents.push({ ...ev });
      // The CLI is still running when it is announced: its pid is the agent's, not a runtime command's.
      if (ev.kind === "start") assert.equal(spawned.at(-1)?.cmd, CLAUDE);
    },
  });
  const r = await s.start({ workspace: "harbor-map", host: "claude", text: "fix the parser\nand the tests", access: "read" });
  assert.ok(r.ok);
  await idle(s);
  const pid = spawned.find((x) => x.cmd === CLAUDE)?.pid;
  assert.equal(typeof pid, "number");
  assert.deepEqual(agents, [
    { kind: "start", pid, thread: r.data.id, workspace: "harbor-map", host: "claude", access: "read", title: "fix the parser" },
    { kind: "end", pid, thread: r.data.id },
  ]);
  // A turn the runtime refuses starts no CLI and announces nothing.
  config({ sessions: { perDayUsd: 0 } });
  await s.send({ thread: r.data.id, text: "again" });
  await idle(s);
  config();
  assert.equal(agents.length, 2);
});

test("resolveBin: the binary the runtime resolves for a Code launch (sessions.js bin), or why not", async () => {
  const { s } = service();
  assert.deepEqual(await s.resolveBin("claude"), { bin: CLAUDE });
  assert.deepEqual(await s.resolveBin("codex"), { bin: CODEX });
  const noNode = new SessionService({ vaultRoot: () => vault, enabled: () => true, context: () => context, env, node: () => null, emit: () => {} });
  assert.deepEqual(await noNode.resolveBin("claude"), { reason: "no node: run aos doctor" });
  // Not behind the Sessions surface: a Code launch needs no Sessions.
  assert.deepEqual(await service(false).s.resolveBin("claude"), { bin: CLAUDE });
  const noVault = new SessionService({ vaultRoot: () => null, enabled: () => true, context: () => context, env, node: () => process.execPath, emit: () => {} });
  assert.deepEqual(await noVault.resolveBin("claude"), { reason: "no vault is open" });
  // With no binary recorded, the one a Code terminal's PATH finds: the CLI its typed line would have run.
  const termBin = path.join(tmp, "term-bin");
  fs.mkdirSync(termBin, { recursive: true });
  const termCodex = path.join(termBin, "codex");
  fs.writeFileSync(termCodex, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(vault, "brain", "config.json"), JSON.stringify({ hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: true } } }));
  try {
    const onPath = new SessionService({ vaultRoot: () => vault, enabled: () => true, context: () => context, env, node: () => process.execPath, emit: () => {}, terminalPATH: () => `${termBin}:/usr/bin:/bin` });
    assert.deepEqual(await onPath.resolveBin("codex"), { bin: termCodex });
    assert.deepEqual(await onPath.resolveBin("claude"), { bin: CLAUDE }, "a recorded binary still comes first");
    // The runtime found none (AOS_NO_CODEX hides every Codex, the usual install folders included).
    const hidden = new SessionService({ vaultRoot: () => vault, enabled: () => true, context: () => context, env: { ...env, AOS_NO_CODEX: "1" }, node: () => process.execPath, emit: () => {} });
    assert.deepEqual(await hidden.resolveBin("codex"), { reason: "the runtime found no Codex binary: run aos doctor" });
  } finally { config(); }
});

/** A SessionService whose `sessions.js bin` is replaced by `code` (node -e): an old runtime, or one that never answers. */
function binStandIn(code: string, extra: Partial<ConstructorParameters<typeof SessionService>[0]> = {}) {
  const children: childProcess.ChildProcess[] = [];
  const spawnImpl = ((cmd: string, args: string[], opts: object) => {
    const c = args[1] === "bin" ? childProcess.spawn(process.execPath, ["-e", code], opts) : childProcess.spawn(cmd, args, opts);
    if (args[1] === "bin") children.push(c);
    return c;
  }) as unknown as typeof childProcess.spawn;
  const s = new SessionService({ vaultRoot: () => vault, enabled: () => true, context: () => context, env, node: () => process.execPath, emit: () => {}, spawnImpl, ...extra });
  return { s, children };
}

test("resolveBin: a runtime older than the bin verb says to upgrade; one that never answers is given up on and killed", async () => {
  const old = binStandIn("process.stderr.write('usage: sessions.js args <json> | events --host claude|codex [--model m] | catalog [--refresh] [--host h] | record <json>\\n'); process.exit(2);");
  assert.deepEqual(await old.s.resolveBin("claude"), { reason: "the runtime is older than this app: run aos upgrade" });
  const hung = binStandIn("setInterval(() => {}, 1000);", { binTimeoutMs: 300 });
  const started = Date.now();
  assert.deepEqual(await hung.s.resolveBin("claude"), { reason: "the runtime didn't answer" });
  assert.ok(Date.now() - started < 5000);
  const child = hung.children[0];
  if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once("exit", r));
  assert.ok(child.signalCode !== null, "the runtime child was killed");
});

test("nothing runs while the Sessions surface is off, and a thread that is not there is ENOENT", async () => {
  const { s } = service(false);
  assert.deepEqual(await s.start({ workspace: "harbor-map", host: "claude", text: "x" }), { ok: false, error: "the Sessions surface is off", code: "EROFS" });
  const on = service().s;
  assert.equal((await on.read("00000000-0000-4000-8000-000000000000")).ok, false);
});

test("git: status, a new file's diff, and a commit only with a message, on a branch, with something to commit", async () => {
  const repo = path.join(vault, "workspaces", "tide");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", ["test", "example.invalid"].join("@")); // a placeholder identity, built so no address sits in the source
  g("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  const git = new GitService({ workspace: (n) => workspaceDir(vault, n), enabled: () => true, env: process.env });
  const st = await git.status("tide");
  assert.ok(st.ok);
  assert.deepEqual([st.data.repo, st.data.branch, st.data.files], [true, "main", [{ status: "??", path: "a.txt", added: 1, removed: 0 }]], "a repository with no commit yet counts too");
  const d = await git.diff("tide", "a.txt");
  assert.ok(d.ok);
  assert.match(d.data.text, /\+one/);
  assert.deepEqual(await git.diff("tide", "../outside"), { ok: false, error: "a file outside the workspace", code: "EROFS" });
  assert.deepEqual(await git.commit("tide", "  "), { ok: false, error: "a commit needs a message", code: "EROFS" });
  const c = await git.commit("tide", "Add a");
  assert.ok(c.ok && /^[0-9a-f]{40}$/.test(c.data.commit), JSON.stringify(c));
  assert.deepEqual(await git.commit("tide", "again"), { ok: false, error: "nothing to commit", code: "EROFS" });
  // +/- per file against HEAD (sessions-ux U11): a changed file, a new text file, a new binary file.
  fs.writeFileSync(path.join(repo, "a.txt"), "uno\ntwo\nthree\n");
  fs.writeFileSync(path.join(repo, "b.md"), "x\ny");
  fs.writeFileSync(path.join(repo, "c.bin"), Buffer.from([1, 0, 2]));
  const counted = await git.status("tide");
  assert.ok(counted.ok);
  assert.deepEqual(counted.data.files.map((f) => [f.path, f.added, f.removed]), [["a.txt", 3, 1], ["b.md", 2, 0], ["c.bin", null, null]]);
  assert.deepEqual((await git.status("harbor-map")).ok && (await git.status("harbor-map")), { ok: true, data: { repo: false, branch: null, detached: false, merging: false, files: [] } });
  const off = new GitService({ workspace: (n) => workspaceDir(vault, n), enabled: () => false, env: process.env });
  assert.deepEqual(await off.status("tide"), { ok: false, error: "the Sessions surface is off", code: "EROFS" });
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

test("git: a workspace folder inside another repository (a vault kept in git) is not a repository of its own: nothing to read or commit", async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sessions-outer-"));
  const v = path.join(outer, "vault");
  const plain = path.join(v, "workspaces", "plain");
  fs.mkdirSync(plain, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: v, stdio: "ignore" });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(v, "note.md"), "a vault note\n");
  fs.writeFileSync(path.join(plain, "a.txt"), "one\n");
  const git = new GitService({ workspace: (n) => workspaceDir(v, n), enabled: () => true, env: process.env });
  assert.deepEqual(await git.status("plain"), { ok: true, data: { repo: false, branch: null, detached: false, merging: false, files: [] } });
  assert.deepEqual(await git.diff("plain", "a.txt"), { ok: false, error: "not a git repository", code: "EROFS" });
  assert.deepEqual(await git.commit("plain", "Add a"), { ok: false, error: "not a git repository", code: "EROFS" });
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
  const git = new GitService({ workspace: (n) => workspaceDir(v, n), enabled: () => true, env: process.env });
  const st = await git.status("guarded");
  assert.ok(st.ok && st.data.repo && st.data.files.length === 1, JSON.stringify(st));
  assert.ok((await git.diff("guarded", "a.txt")).ok);
  assert.equal(fs.existsSync(marker), false, "core.fsmonitor never ran");
  // Every argv starts with the guard, whatever the command.
  const seen: string[][] = [];
  const fake = ((_file: string, args: readonly string[], _opts: unknown, cb: (e: null, out: string, err: string) => void) => {
    seen.push([...args]);
    cb(null, "", "");
  }) as unknown as typeof execFile;
  const spy = new GitService({ workspace: () => ({ dir: repo }), enabled: () => true, env: process.env, execFileImpl: fake });
  await spy.status("guarded");
  await spy.diff("guarded");
  await spy.commit("guarded", "x");
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
  const git = new GitService({ workspace: (n) => workspaceDir(v, n), enabled: () => true, env: process.env });
  const st = await git.status("drivers");
  assert.ok(st.ok && st.data.files.length === 2, JSON.stringify(st));
  const whole = await git.diff("drivers");
  assert.ok(whole.ok && /\+two/.test(whole.data.text), JSON.stringify(whole));
  assert.ok((await git.diff("drivers", "a.txt")).ok);
  const added = await git.diff("drivers", "new.txt");
  assert.ok(added.ok && /\+new/.test(added.data.text), JSON.stringify(added));
  assert.deepEqual(ran(), [], "no driver the repository names ran");
  fs.rmSync(outer, { recursive: true, force: true });
});

test("git: every diff passes --no-ext-diff --no-textconv; a read gets no lazy fetch and no transport; commit runs as in a terminal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-git-spy-"));
  const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const fake = ((_file: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv }, cb: (e: null, out: string, err: string) => void) => {
    seen.push({ args: [...args], env: opts.env });
    const a = args.slice(GIT_GUARD.length).filter((x) => !x.startsWith("--config-env="));
    if (a[0] === "rev-parse" && a[1] === "--show-toplevel") return cb(null, `${dir}\n`, "");
    if (a[0] === "rev-parse" && a[1] === "--git-path") return cb(null, ".git/MERGE_HEAD\n", "");
    if (a[0] === "status") return cb(null, "# branch.head main\n1 .M N... 100644 100644 100644 a b a.txt\n", "");
    if (a[0] === "config") return cb(null, ["local", "filter.evil.clean", ""].join("\0"), "");
    return cb(null, "", "");
  }) as unknown as typeof execFile;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: path.join(dir, "elsewhere"), GIT_WORK_TREE: path.join(dir, "elsewhere") };
  const spy = new GitService({ workspace: () => ({ dir }), enabled: () => true, env, execFileImpl: fake });
  assert.ok((await spy.diff("x")).ok);
  assert.ok((await spy.diff("x", "a.txt")).ok);
  assert.ok((await spy.commit("x", "msg")).ok);
  const diffs = seen.filter((c) => c.args.includes("diff"));
  assert.ok(diffs.length >= 5, String(diffs.length));
  for (const c of diffs) { const i = c.args.indexOf("diff"); assert.deepEqual(c.args.slice(i + 1, i + 3), [...DIFF_SAFE], c.args.join(" ")); }
  for (const c of seen.filter((x) => x.args.includes("status") || x.args.includes("diff"))) {
    assert.ok(c.args.includes("--config-env=filter.evil.clean=AOS_GIT_EMPTY"), c.args.join(" "));
  }
  const writes = seen.filter((c) => c.args.includes("add") || c.args.includes("commit"));
  assert.equal(writes.length, 2);
  for (const c of seen) {
    assert.equal(c.env.GIT_DIR, undefined, "no inherited GIT_DIR");
    assert.equal(c.env.GIT_WORK_TREE, undefined, "no inherited work tree");
    const write = writes.includes(c);
    assert.equal(c.env.GIT_NO_LAZY_FETCH, write ? env.GIT_NO_LAZY_FETCH : "1", c.args.join(" "));
    assert.equal(c.env.GIT_ALLOW_PROTOCOL, write ? env.GIT_ALLOW_PROTOCOL : "", c.args.join(" "));
    if (write) assert.ok(!c.args.some((x) => x.startsWith("--config-env=")), "the user's commit keeps the repository's filters");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("each turn runs with its own model, effort and access; a send that names none reuses the thread's last (sessions-ux U6, U7)", async () => {
  const { s } = service();
  const log = path.join(tmp, "claude.argv");
  const calls = (): string[][] => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { argv: string[] }).argv);
  const seen = calls().length;
  const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  // Every turn pre-approves the computer tools by access (agent-computer D33): the look tools, all nine, or Bash and all nine.
  const plug = (t: string) => `mcp__plugin_agenticos_agenticos__${t}`;
  const NINE = COMPUTER_TOOLS.map(plug).join(",");
  const r = await s.start({ workspace: "harbor-map", host: "claude", text: "plan it", model: "sonnet", effort: "high", access: "read" });
  assert.ok(r.ok);
  assert.deepEqual([r.data.model, r.data.effort, r.data.access], ["sonnet", "high", "read"]);
  await idle(s);
  const sent = await s.send({ thread: r.data.id, text: "now do it", model: "opus", access: "run" });
  assert.ok(sent.ok);
  await idle(s);
  assert.ok((await s.send({ thread: r.data.id, text: "and again" })).ok);
  await idle(s);
  const [first, second, third] = calls().slice(seen);
  assert.deepEqual([flag(first, "--permission-mode"), flag(first, "--model"), flag(first, "--effort"), flag(first, "--allowedTools")], ["plan", "sonnet", "high", COMPUTER_LOOK.map(plug).join(",")]);
  assert.deepEqual([flag(second, "--permission-mode"), flag(second, "--model"), flag(second, "--effort"), flag(second, "--allowedTools")], ["acceptEdits", "opus", "high", `Bash,${NINE}`]);
  assert.deepEqual([flag(third, "--model"), flag(third, "--allowedTools")], ["opus", `Bash,${NINE}`], "the last turn's choices carry on");
  const read = await s.read(r.data.id);
  assert.ok(read.ok);
  assert.deepEqual(read.data.filter((e) => e.kind === "prompt").map((e) => [e.model, e.effort, e.access]), [["sonnet", "high", "read"], ["opus", "high", "run"], ["opus", "high", "run"]]);
  const list = await s.list();
  assert.ok(list.ok);
  const t = list.data.find((x) => x.id === r.data.id);
  assert.deepEqual([t?.model, t?.effort, t?.access], ["opus", "high", "run"], "the list shows the latest choices");
  const old = await s.send({ thread: r.data.id, text: "older page", allowCommands: false });
  assert.ok(old.ok);
  await idle(s);
  assert.equal(flag(calls().at(-1) as string[], "--allowedTools"), NINE, "allowCommands false still reads as edit");
});

test("catalog: the runtime's answer for each host; a host that does not answer keeps its aliases; refused while Sessions is off", async () => {
  const { s } = service();
  const [a, b] = await Promise.all([s.catalog(), s.catalog()]);
  assert.ok(a.ok, JSON.stringify(a));
  assert.deepEqual(b, a, "one fetch at a time: the second call shares the first");
  assert.equal(a.data.schema, 1);
  const claude = a.data.hosts.claude;
  assert.ok(claude && !claude.ok && claude.reason, "the stand-in claude never answers initialize");
  assert.deepEqual(claude.models.map((m) => m.id), ["default", "opus", "fable", "sonnet", "haiku"]);
  assert.ok(fs.existsSync(path.join(vault, "brain", "_index", "host-catalog.json")));
  assert.ok((await s.catalog(true)).ok);
  assert.deepEqual(await service(false).s.catalog(), { ok: false, error: "the Sessions surface is off", code: "EROFS" });
});

test("an archived workspace's threads stay listed and readable, and refuse a turn until Restore (spaces-redesign D17)", async () => {
  const { s } = service();
  const live = path.join(vault, "workspaces", "tide-log");
  const archived = path.join(vault, "workspaces", "_archive", "tide-log");
  fs.mkdirSync(live, { recursive: true });
  const log = path.join(tmp, "claude.argv");
  const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").length;
  const r = await s.start({ workspace: "tide-log", host: "claude", text: "chart the tides" });
  assert.ok(r.ok, JSON.stringify(r));
  await idle(s);
  const file = path.join(vault, "brain", "_index", "sessions", "tide-log", `${r.data.id}.jsonl`);
  assert.ok(fs.existsSync(file));

  // Archive (cli/workspace.js) moves the folder under _archive/ and leaves the thread where it is.
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(live, archived);
  const before = fs.readFileSync(file, "utf8");
  const seen = calls();
  const why = "tide-log is archived: restore it in Spaces to continue";
  assert.deepEqual(await s.send({ thread: r.data.id, text: "and the moon" }), { ok: false, error: why, code: "EROFS" });
  assert.deepEqual(await s.start({ workspace: "tide-log", host: "claude", text: "new thread" }), { ok: false, error: why, code: "EROFS" });
  assert.deepEqual(workspaceDir(vault, "tide-log"), { refusal: why });
  assert.equal(s.runningCount, 0);
  assert.equal(calls(), seen, "no host ran");
  assert.equal(fs.readFileSync(file, "utf8"), before, "the thread is unchanged");
  assert.deepEqual(fs.readdirSync(path.join(vault, "brain", "_index", "sessions", "tide-log")), [`${r.data.id}.jsonl`], "no new thread");
  const list = await s.list();
  assert.ok(list.ok);
  assert.ok(list.data.some((t) => t.id === r.data.id && t.workspace === "tide-log"), "still listed");
  const read = await s.read(r.data.id);
  assert.ok(read.ok);
  assert.equal(read.data.filter((e) => e.kind === "prompt").length, 1, "still readable");
  // The archive folder itself is never a workspace a turn runs in, and a name nothing holds is still "no such workspace".
  assert.deepEqual(workspaceDir(vault, "_archive"), { refusal: "a workspace name" });
  assert.deepEqual(workspaceDir(vault, "ebb-log"), { refusal: "no such workspace" });

  // Restore moves it back: the same thread takes a turn again.
  fs.renameSync(archived, live);
  const next = await s.send({ thread: r.data.id, text: "and the moon" });
  assert.ok(next.ok, JSON.stringify(next));
  await idle(s);
  assert.equal(calls(), seen + 1, "the host ran once");
});
