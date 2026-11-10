// The Code chat's followers as main runs them (spec 2026-11-09-code-chat R2, R4, R10, R13–R18). The runtime is a stand-in
// (a lib/sessions.js and lib/code-mirror.js that only have to exist) and the spawn is faked, so nothing reads a transcript;
// the real mirror has its own tests in tests/. Review focus 3 (no orphan followers) is here: unfollow, the terminal's
// close (kill, killAll) and stopAll each SIGTERM; a PTY's own exit does not (R16: a follower lives as long as its terminal).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProgramContext } from "../../src/main/policy/programs";
import { CodeMirrorService, mirrorAllowed } from "../../src/main/services/code-mirror";
import { PtyService, type PtyLib, type PtyProcess } from "../../src/main/services/pty";
import { SURFACES } from "../../src/shared/surfaces";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aos-code-mirror-"));
const vault = path.join(tmp, "vault");
fs.mkdirSync(path.join(vault, "brain", "scripts", "lib"), { recursive: true });
fs.writeFileSync(path.join(vault, "brain", "scripts", "lib", "sessions.js"), "// stand-in\n");
fs.writeFileSync(path.join(vault, "brain", "scripts", "lib", "code-mirror.js"), "// stand-in\n");
const context = { vaultRoot: vault, home: tmp, userData: path.join(tmp, "user-data"), env: process.env, agenticos: null, shells: [] } as unknown as ProgramContext;
const KEY = "aaaaaaaa-0000-4000-8000-000000000001";
const KEY2 = "bbbbbbbb-0000-4000-8000-000000000002";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];
  stderr = new EventEmitter();
  kill(sig: string): boolean {
    this.signals.push(sig);
    this.signalCode = sig as NodeJS.Signals;
    queueMicrotask(() => this.emit("exit", null, sig));
    return true;
  }
  finish(code: number): void { this.exitCode = code; this.emit("exit", code, null); this.emit("close", code, null); }
}

type Info = { cwd: string; startedAt: number; terminal: string | null };
function rig(opts: { on?: boolean; info?: Info | null | ((pty: string) => Info | null); viewTimeoutMs?: number; vaultRoot?: string } = {}) {
  const spawned: Array<{ file: string; args: string[]; child: FakeChild; env: NodeJS.ProcessEnv; cwd?: string }> = [];
  const spawnImpl = ((file: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd?: string }) => {
    const child = new FakeChild();
    spawned.push({ file, args, child, env: o.env, cwd: o.cwd });
    return child;
  }) as unknown as typeof childProcess.spawn;
  const info = opts.info === undefined ? (pty: string): Info => ({ cwd: "/work/demo", startedAt: 1_700_000_000_123, terminal: pty === "t2" ? KEY2 : KEY }) : opts.info;
  const ptyInfo = typeof info === "function" ? info : () => info;
  const s = new CodeMirrorService({ vaultRoot: () => opts.vaultRoot ?? vault, enabled: () => opts.on !== false, context: () => ({ ...context, vaultRoot: opts.vaultRoot ?? vault }) as ProgramContext, env: { PATH: "/usr/bin" }, node: () => process.execPath, ptyInfo, spawnImpl, viewTimeoutMs: opts.viewTimeoutMs, killAfterMs: 50 });
  return { s, spawned };
}
const script = path.join(vault, "brain", "scripts", "lib", "sessions.js");

test("the surface lists four mirror argv shapes, off by default, writing only the caches", () => {
  const code = SURFACES.find((x) => x.id === "code");
  assert.ok(code);
  assert.equal(code.verified, false);
  assert.equal(code.scope, "main");
  assert.deepEqual(code.writes, ["brain/_index/code/*.jsonl", "brain/_index/code/*.claim.json"]);
  assert.deepEqual(code.folders, ["brain/_index/code"]);
  assert.equal(code.spawns.length, 4);
});

test("mirrorAllowed: exactly the four shapes, with ids, keys and numbers in their places", () => {
  assert.ok(mirrorAllowed(["mirror", "--host", "claude", "--id", "abc-1.2_3", "--terminal", KEY, "--follow"]));
  assert.ok(mirrorAllowed(["mirror", "--host", "codex", "--id", "abc", "--cwd", "/work/demo", "--since", "1700000000123", "--terminal", KEY, "--follow"]), "codex: an id, then its folder (R18)");
  assert.equal(mirrorAllowed(["mirror", "--host", "claude", "--id", "abc", "--cwd", "/work/demo", "--since", "1", "--terminal", KEY, "--follow"]), false, "claude never takes both");
  assert.equal(mirrorAllowed(["mirror", "--host", "codex", "--id", "abc", "--cwd", "/work/demo", "--since", "1", "--once"]), false);
  assert.ok(mirrorAllowed(["mirror", "--host", "codex", "--cwd", "/work/demo", "--since", "1700000000123", "--terminal", KEY, "--follow"]));
  assert.ok(mirrorAllowed(["mirror", "--host", "codex", "--id", "abc", "--once"]));
  for (const bad of [
    ["mirror", "--host", "sh", "--id", "abc", "--once"],
    ["mirror", "--host", "claude", "--id", "..", "--once"],
    ["mirror", "--host", "claude", "--id", "a..b", "--once"],
    ["mirror", "--host", "claude", "--id", "-x", "--once"],
    ["mirror", "--host", "claude", "--id", "abc", "--terminal", KEY, "--once"],
    ["mirror", "--host", "claude", "--id", "abc", "--terminal", "x", "--follow"],
    ["mirror", "--host", "claude", "--id", "abc", "--terminal", "../a", "--follow"],
    ["mirror", "--host", "claude", "--cwd", "relative", "--since", "1", "--terminal", KEY, "--follow"],
    ["mirror", "--host", "claude", "--cwd", "/work", "--since", "1x", "--terminal", KEY, "--follow"],
    ["mirror", "--host", "claude", "--id", "abc", "--once", "--extra"],
    ["events", "--host", "claude"],
  ]) assert.equal(mirrorAllowed(bad), false, bad.join(" "));
});

test("follow without an id: --cwd and --since from the terminal's info, --terminal, --follow; the cache is vault-relative", () => {
  const { s, spawned } = rig();
  const r = s.follow({ pty: "t1", host: "codex", terminal: KEY });
  assert.deepEqual(r, { ok: true, data: { cache: `brain/_index/code/${KEY}.jsonl`, fresh: true } });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, process.execPath);
  assert.deepEqual(spawned[0].args, [script, "mirror", "--host", "codex", "--cwd", "/work/demo", "--since", "1700000000123", "--terminal", KEY, "--follow"]);
  assert.equal(spawned[0].env.AOS_VAULT, vault);
  assert.equal(spawned[0].cwd, vault);
});

test("follow with an id: Claude names it (--id); Codex names it and keeps its folder (--cwd, --since: R18)", () => {
  const { s, spawned } = rig();
  assert.equal(s.follow({ pty: "t1", host: "claude", terminal: KEY, id: "sess-1" }).ok, true);
  assert.deepEqual(spawned[0].args.slice(1), ["mirror", "--host", "claude", "--id", "sess-1", "--terminal", KEY, "--follow"]);
  assert.equal(s.follow({ pty: "t2", host: "codex", terminal: KEY2, id: "rollout-9" }).ok, true);
  assert.deepEqual(spawned[1].args.slice(1), ["mirror", "--host", "codex", "--id", "rollout-9", "--cwd", "/work/demo", "--since", "1700000000123", "--terminal", KEY2, "--follow"]);
});

test("follow is idempotent per pty, terminal, host and id (R2); fresh says whether it started one (R16b)", () => {
  const { s, spawned } = rig();
  const a = s.follow({ pty: "t1", host: "claude", terminal: KEY });
  const b = s.follow({ pty: "t1", host: "claude", terminal: KEY, id: null });
  assert.deepEqual(a, { ok: true, data: { cache: `brain/_index/code/${KEY}.jsonl`, fresh: true } });
  assert.deepEqual(b, { ok: true, data: { cache: `brain/_index/code/${KEY}.jsonl`, fresh: false } });
  assert.equal(spawned.length, 1);
  const c = s.follow({ pty: "t1", host: "claude", terminal: KEY, id: "sess-1" });
  assert.deepEqual(c, { ok: true, data: { cache: `brain/_index/code/${KEY}.jsonl`, fresh: true } }, "the id changed: a new follower for the same terminal");
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
  assert.equal(s.running, 1);
  assert.equal(s.follow({ pty: "t1", host: "codex", terminal: KEY, id: "sess-1" }).ok, true, "the host changed");
  assert.equal(spawned.length, 3);
  assert.equal(s.running, 1);
});

test("follow (F): replacing a terminal's follower removes the old cache first; a first follow and an idempotent one leave it", () => {
  const { s, spawned } = rig();
  const cache = path.join(vault, "brain", "_index", "code", `${KEY}.jsonl`);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, '{"kind":"prompt","text":"old"}\n');
  s.follow({ pty: "t1", host: "claude", terminal: KEY });
  assert.ok(fs.existsSync(cache), "no follower was replaced: a cache already there is left to the new follower");
  s.follow({ pty: "t1", host: "claude", terminal: KEY });
  assert.ok(fs.existsSync(cache), "an idempotent follow replaces nothing");
  s.follow({ pty: "t1", host: "claude", terminal: KEY, id: "sess-1" });
  assert.equal(fs.existsSync(cache), false, "the replaced follower's lines are gone before the new one starts");
  assert.equal(spawned.length, 2);
  fs.rmSync(cache, { force: true });
});

test("follow refuses a terminal key that is not the one the pty started with (M6)", () => {
  const { s, spawned } = rig();
  assert.deepEqual(s.follow({ pty: "t1", host: "claude", terminal: KEY2 }), { ok: false, error: "that terminal key is not this terminal's", code: "EINVAL" });
  const none = rig({ info: { cwd: "/work/demo", startedAt: 1, terminal: null } });
  assert.equal((none.s.follow({ pty: "t1", host: "claude", terminal: KEY }) as { code: string }).code, "EINVAL", "a terminal started without a key");
  assert.equal(spawned.length + none.spawned.length, 0);
});

test("an unknown pty, a bad key and a bad id are refused before anything runs", () => {
  const none = rig({ info: null });
  assert.deepEqual(none.s.follow({ pty: "t9", host: "claude", terminal: KEY }), { ok: false, error: "no such terminal", code: "ENOENT" });
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "aos-code-mirror-old-"));
  fs.mkdirSync(path.join(old, "brain", "scripts", "lib"), { recursive: true });
  fs.writeFileSync(path.join(old, "brain", "scripts", "lib", "sessions.js"), "// a runtime from before the chat view\n");
  const stale = rig({ vaultRoot: old });
  assert.deepEqual(stale.s.follow({ pty: "t1", host: "claude", terminal: KEY }), { ok: false, error: "this vault's runtime has no chat view yet: run aos upgrade", code: "EIO" }, "M1: lib/code-mirror.js decides");
  assert.equal(stale.spawned.length, 0);
  const { s, spawned } = rig();
  assert.equal((s.follow({ pty: "t1", host: "claude", terminal: "x" }) as { code: string }).code, "EINVAL");
  assert.equal((s.follow({ pty: "t1", host: "claude", terminal: KEY, id: "../a" }) as { code: string }).code, "EINVAL");
  assert.equal(spawned.length + none.spawned.length, 0);
});

test("a follower that fails says so once in main's log: its exit code and last stderr line, or aos upgrade for a usage exit", () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    const { s, spawned } = rig();
    s.follow({ pty: "t1", host: "claude", terminal: KEY });
    spawned[0].child.stderr.emit("data", Buffer.from("starting\ncode-mirror: no such host\n"));
    spawned[0].child.finish(1);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /exit 1/);
    assert.match(warned[0], /code-mirror: no such host/);
    s.follow({ pty: "t2", host: "codex", terminal: KEY2 });
    spawned[1].child.stderr.emit("data", Buffer.from("usage: sessions.js args <json> | …\n"));
    spawned[1].child.finish(2);
    assert.match(warned[1], /run aos upgrade/);
    s.follow({ pty: "t1", host: "claude", terminal: KEY });
    spawned[2].child.emit("error", Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }));
    spawned[2].child.finish(-2);
    assert.equal(warned.length, 3, "once per follower");
    assert.match(warned[2], /ENOENT/);
    s.follow({ pty: "t1", host: "claude", terminal: KEY });
    spawned[3].child.finish(0);
    s.follow({ pty: "t2", host: "codex", terminal: KEY2 });
    s.unfollow("t2");
    assert.equal(warned.length, 3, "a clean exit and a SIGTERM say nothing");
  } finally { console.warn = warn; }
});

test("unfollow SIGTERMs the follower; a second unfollow and an unknown pty do nothing", () => {
  const { s, spawned } = rig();
  s.follow({ pty: "t1", host: "claude", terminal: KEY });
  s.unfollow("t1");
  s.unfollow("t1");
  s.unfollow("nope");
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
  assert.equal(s.running, 0);
});

test("a follower that ends by itself is forgotten, so the next follow starts a new one", () => {
  const { s, spawned } = rig();
  s.follow({ pty: "t1", host: "claude", terminal: KEY });
  spawned[0].child.finish(0);
  assert.equal(s.running, 0);
  s.follow({ pty: "t1", host: "claude", terminal: KEY });
  assert.equal(spawned.length, 2);
});

test("stopAll SIGTERMs every follower and leaves none", () => {
  const { s, spawned } = rig();
  s.follow({ pty: "t1", host: "claude", terminal: KEY });
  s.follow({ pty: "t2", host: "codex", terminal: KEY2 });
  s.stopAll();
  assert.deepEqual(spawned.map((x) => x.child.signals), [["SIGTERM"], ["SIGTERM"]]);
  assert.equal(s.running, 0);
});

test("the surface off: follow and view answer EROFS and start nothing; unfollow is a no-op", async () => {
  const { s, spawned } = rig({ on: false });
  assert.equal((s.follow({ pty: "t1", host: "claude", terminal: KEY }) as { code: string }).code, "EROFS");
  assert.equal(((await s.view({ host: "claude", id: "abc" })) as { code: string }).code, "EROFS");
  s.unfollow("t1");
  assert.equal(spawned.length, 0);
});

test("view runs --once, waits for exit 0 and answers the conversation's cache", async () => {
  const { s, spawned } = rig();
  const p = s.view({ host: "codex", id: "rollout-9" });
  assert.deepEqual(spawned[0].args.slice(1), ["mirror", "--host", "codex", "--id", "rollout-9", "--once"]);
  spawned[0].child.finish(0);
  assert.deepEqual(await p, { ok: true, data: { cache: "brain/_index/code/codex-rollout-9.jsonl" } });
});

test("view: a usage exit (a runtime older than mirror) asks for aos upgrade", async () => {
  const { s, spawned } = rig();
  const p = s.view({ host: "claude", id: "abc" });
  spawned[0].child.stderr.emit("data", Buffer.from("usage: sessions.js args <json> | events --host claude|codex\n"));
  spawned[0].child.finish(2);
  assert.deepEqual(await p, { ok: false, error: "the runtime is older than this app: run aos upgrade", code: "EIO" });
});

test("view: a non-zero exit is an error with the runtime's last line; a bad id never spawns; a slow run is killed", async () => {
  const a = rig();
  const p = a.s.view({ host: "claude", id: "abc" });
  a.spawned[0].child.stderr.emit("data", Buffer.from("first\nno such session\n"));
  a.spawned[0].child.finish(1);
  assert.deepEqual(await p, { ok: false, error: "no such session", code: "EIO" });
  const b = rig();
  assert.equal(((await b.s.view({ host: "claude", id: "../x" })) as { code: string }).code, "EINVAL");
  assert.equal(b.spawned.length, 0);
  const c = rig({ viewTimeoutMs: 20 });
  const slow = c.s.view({ host: "claude", id: "abc" });
  c.spawned[0].child.kill = (sig: string) => { c.spawned[0].child.signals.push(sig); queueMicrotask(() => c.spawned[0].child.finish(137)); return true; };
  assert.deepEqual(await slow, { ok: false, error: "the conversation took too long to load", code: "ETIMEDOUT" });
  assert.deepEqual(c.spawned[0].child.signals, ["SIGKILL"]);
});

test("R16: a follower lives as long as its terminal — the PTY's own exit keeps it; kill (even after the exit) and killAll end it", () => {
  const spawned: Array<{ child: FakeChild }> = [];
  let live: CodeMirrorService | null = null;
  const procs: Array<{ exit: (e: { exitCode: number }) => void; killed: number }> = [];
  const fake = (): PtyProcess => {
    const rec = { exit: (_e: { exitCode: number }) => {}, killed: 0 };
    procs.push(rec);
    return { pid: 1, write() {}, resize() {}, kill() { rec.killed++; }, onData() {}, onExit(cb) { rec.exit = cb as (e: { exitCode: number }) => void; } };
  };
  const lib: PtyLib = { spawn: () => fake() };
  const shell = process.env.SHELL || "/bin/sh";
  const ended: Array<[string, string | null]> = [];
  const pty = new PtyService({
    context: () => ({ ...context, shells: [shell] }), env: { SHELL: shell }, emit: () => {}, load: () => lib, now: () => 1_700_000_000_123,
    onEnd: (id, terminal) => { ended.push([id, terminal]); live?.end(id, terminal); },
  });
  const spawnShell = (id: string, key?: string): void => {
    assert.equal(pty.spawn({ id, file: shell, args: [], cwd: tmp, name: "xterm-256color", cols: 80, rows: 24, ...(key ? { env: { AOS_TERMINAL: key } } : {}) }).ok, true);
  };
  spawnShell("t1", KEY);
  assert.deepEqual(pty.info("t1"), { cwd: tmp, startedAt: 1_700_000_000_123, terminal: KEY }, "main records the key the PTY started with (M6)");
  assert.equal(pty.info("t2"), null);
  live = new CodeMirrorService({ vaultRoot: () => vault, enabled: () => true, context: () => context, env: {}, node: () => process.execPath, ptyInfo: (id) => pty.info(id), spawnImpl: (() => { const c = new FakeChild(); spawned.push({ child: c }); return c; }) as unknown as typeof childProcess.spawn });
  assert.equal(live.follow({ pty: "t1", host: "claude", terminal: KEY }).ok, true);
  procs[0].exit({ exitCode: 0 });
  assert.deepEqual(spawned[0].child.signals, [], "the agent exited and the login shell takes over: the follower stays");
  assert.deepEqual(ended, []);
  // The login shell that takes over is a new PTY of the same terminal (the same key); closing the terminal kills it.
  spawnShell("t5", KEY);
  pty.kill("t5");
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"], "the terminal closed");
  assert.equal(live.running, 0);
  spawnShell("t3", KEY2);
  assert.equal(live.follow({ pty: "t3", host: "codex", terminal: KEY2 }).ok, true);
  procs[2].exit({ exitCode: 0 });
  pty.kill("t3");
  assert.deepEqual(spawned[1].child.signals, ["SIGTERM"], "kill after the exit still ends it");
  spawnShell("t4", KEY);
  assert.equal(live.follow({ pty: "t4", host: "codex", terminal: KEY }).ok, true);
  pty.killAll();
  assert.deepEqual(spawned[2].child.signals, ["SIGTERM"]);
  assert.equal(live.running, 0);
});

test("a stale exit for a reused terminal id leaves the new terminal's state alone", () => {
  const procs: Array<{ exit: (e: { exitCode: number }) => void }> = [];
  const lib: PtyLib = { spawn: () => { const rec = { exit: (_e: { exitCode: number }) => {} }; procs.push(rec); return { pid: 1, write() {}, resize() {}, kill() {}, onData() {}, onExit(cb) { rec.exit = cb as (e: { exitCode: number }) => void; } }; } };
  const shell = process.env.SHELL || "/bin/sh";
  const events: unknown[] = [];
  const pty = new PtyService({ context: () => ({ ...context, shells: [shell] }), env: { SHELL: shell }, emit: (e) => events.push(e), load: () => lib, now: () => 5 });
  const open = (key: string) => assert.equal(pty.spawn({ id: "t1", file: shell, args: [], cwd: tmp, name: "xterm-256color", cols: 80, rows: 24, env: { AOS_TERMINAL: key } }).ok, true);
  open(KEY);
  pty.killAll(); // the page reloaded: ids start over
  open(KEY2);
  procs[0].exit({ exitCode: 0 }); // the first page's shell reports its exit only now
  assert.deepEqual(pty.info("t1"), { cwd: tmp, startedAt: 5, terminal: KEY2 });
  assert.equal(pty.open, 1);
  assert.deepEqual(events, [], "nothing said to the terminal that has the id now");
});

test("unfollow by either PTY of a terminal ends its follower", () => {
  const { s, spawned } = rig({ info: (pty) => (pty === "t9" ? null : { cwd: "/work/demo", startedAt: 1, terminal: KEY }) });
  s.follow({ pty: "t1", host: "claude", terminal: KEY });
  s.unfollow("t7"); // the login shell that took over in the same terminal
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
  s.follow({ pty: "t1", host: "claude", terminal: KEY });
  s.unfollow("t9");
  assert.equal(s.running, 1, "an unknown pty is nothing");
});
