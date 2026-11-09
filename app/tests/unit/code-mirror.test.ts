// The Code chat's followers as main runs them (spec 2026-11-09-code-chat R2, R4, R10, R13–R15). The runtime is a stand-in
// (a lib/sessions.js that only has to exist) and the spawn is faked, so nothing reads a transcript; the real mirror has its
// own tests in tests/. Review focus 3 (no orphan followers) is here: unfollow, a terminal's exit and stopAll each SIGTERM.

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

function rig(opts: { on?: boolean; info?: { cwd: string; startedAt: number } | null; viewTimeoutMs?: number } = {}) {
  const spawned: Array<{ file: string; args: string[]; child: FakeChild; env: NodeJS.ProcessEnv; cwd?: string }> = [];
  const spawnImpl = ((file: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd?: string }) => {
    const child = new FakeChild();
    spawned.push({ file, args, child, env: o.env, cwd: o.cwd });
    return child;
  }) as unknown as typeof childProcess.spawn;
  const info = opts.info === undefined ? { cwd: "/work/demo", startedAt: 1_700_000_000_123 } : opts.info;
  const s = new CodeMirrorService({ vaultRoot: () => vault, enabled: () => opts.on !== false, context: () => context, env: { PATH: "/usr/bin" }, node: () => process.execPath, ptyInfo: () => info, spawnImpl, viewTimeoutMs: opts.viewTimeoutMs, killAfterMs: 50 });
  return { s, spawned };
}
const script = path.join(vault, "brain", "scripts", "lib", "sessions.js");

test("the surface lists three mirror argv shapes, off by default, writing only the caches", () => {
  const code = SURFACES.find((x) => x.id === "code");
  assert.ok(code);
  assert.equal(code.verified, false);
  assert.equal(code.scope, "main");
  assert.deepEqual(code.writes, ["brain/_index/code/*.jsonl", "brain/_index/code/*.claim.json"]);
  assert.deepEqual(code.folders, ["brain/_index/code"]);
  assert.equal(code.spawns.length, 3);
});

test("mirrorAllowed: exactly the three shapes, with ids, keys and numbers in their places", () => {
  assert.ok(mirrorAllowed(["mirror", "--host", "claude", "--id", "abc-1.2_3", "--terminal", KEY, "--follow"]));
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
  assert.deepEqual(r, { ok: true, data: { cache: `brain/_index/code/${KEY}.jsonl` } });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, process.execPath);
  assert.deepEqual(spawned[0].args, [script, "mirror", "--host", "codex", "--cwd", "/work/demo", "--since", "1700000000123", "--terminal", KEY, "--follow"]);
  assert.equal(spawned[0].env.AOS_VAULT, vault);
  assert.equal(spawned[0].cwd, vault);
});

test("follow with an id names it (--id) on either host", () => {
  const { s, spawned } = rig();
  assert.equal(s.follow({ pty: "t1", host: "claude", terminal: KEY, id: "sess-1" }).ok, true);
  assert.deepEqual(spawned[0].args.slice(1), ["mirror", "--host", "claude", "--id", "sess-1", "--terminal", KEY, "--follow"]);
});

test("follow is idempotent per pty and terminal (R2); another key for the pty replaces the follower", () => {
  const { s, spawned } = rig();
  const a = s.follow({ pty: "t1", host: "claude", terminal: KEY });
  const b = s.follow({ pty: "t1", host: "claude", terminal: KEY });
  assert.deepEqual(a, b);
  assert.equal(spawned.length, 1);
  const c = s.follow({ pty: "t1", host: "claude", terminal: KEY2 });
  assert.deepEqual(c, { ok: true, data: { cache: `brain/_index/code/${KEY2}.jsonl` } });
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
  assert.equal(s.running, 1);
});

test("an unknown pty, a bad key and a bad id are refused before anything runs", () => {
  const none = rig({ info: null });
  assert.deepEqual(none.s.follow({ pty: "t9", host: "claude", terminal: KEY }), { ok: false, error: "no such terminal", code: "ENOENT" });
  const { s, spawned } = rig();
  assert.equal((s.follow({ pty: "t1", host: "claude", terminal: "x" }) as { code: string }).code, "EINVAL");
  assert.equal((s.follow({ pty: "t1", host: "claude", terminal: KEY, id: "../a" }) as { code: string }).code, "EINVAL");
  assert.equal(spawned.length + none.spawned.length, 0);
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

test("a terminal's exit stops its follower: PtyService.onEnd → unfollow (an exit, and killAll)", () => {
  const spawned: Array<{ child: FakeChild }> = [];
  let live: CodeMirrorService | null = null;
  const exits: Array<(e: { exitCode: number }) => void> = [];
  const fake = (): PtyProcess => ({ pid: 1, write() {}, resize() {}, kill() {}, onData() {}, onExit(cb) { exits.push(cb as (e: { exitCode: number }) => void); } });
  const lib: PtyLib = { spawn: () => fake() };
  const shell = process.env.SHELL || "/bin/sh";
  const pty = new PtyService({
    context: () => ({ ...context, shells: [shell] }), env: { SHELL: shell }, emit: () => {}, load: () => lib, onEnd: (id) => live?.unfollow(id), now: () => 1_700_000_000_123,
  });
  const spawnShell = (id: string): void => { assert.equal(pty.spawn({ id, file: shell, args: [], cwd: tmp, name: "xterm-256color", cols: 80, rows: 24 }).ok, true); };
  spawnShell("t1");
  assert.deepEqual(pty.info("t1"), { cwd: tmp, startedAt: 1_700_000_000_123 });
  assert.equal(pty.info("t2"), null);
  live = new CodeMirrorService({ vaultRoot: () => vault, enabled: () => true, context: () => context, env: {}, node: () => process.execPath, ptyInfo: (id) => pty.info(id), spawnImpl: (() => { const c = new FakeChild(); spawned.push({ child: c }); return c; }) as unknown as typeof childProcess.spawn });
  assert.equal(live.follow({ pty: "t1", host: "claude", terminal: KEY }).ok, true);
  exits[0]({ exitCode: 0 });
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
  assert.equal(pty.info("t1"), null);
  spawnShell("t3");
  assert.equal(live.follow({ pty: "t3", host: "codex", terminal: KEY2 }).ok, true);
  pty.killAll();
  assert.deepEqual(spawned[1].child.signals, ["SIGTERM"]);
});
