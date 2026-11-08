// A Code launch's terminal (agent-computer D18): main runs the agent CLI as the terminal's own process, so the terminal
// shows at once, starting, and gets the agent when main answers; when the agent exits the user's login shell takes over
// in the same terminal and folder, and the terminal ends only with that shell. When main cannot vouch for the agent it
// falls back to today's terminal: the shell with the launch line typed. A fake HudHost stands in for main's terminals.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type * as PoolModule from "./terminalPool";
import { setHudHost, type HostPtyAgentRequest, type HostPtyOptions, type HostPtyProcess, type HostResult, type HudHost } from "../host";
import { createNodeHost } from "../nodeHost";
import { launchArgs, launchLine, type LaunchSpec, type Place } from "./terminalLaunch";

// "obsidian" resolves to a stub whose Events is enough for the pool's triggers (ConfirmModal.test.ts's pattern).
class FakeEvents {
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  on(name: string, cb: (...a: unknown[]) => void): void { this.handlers.set(name, [...(this.handlers.get(name) ?? []), cb]); }
  trigger(name: string, ...data: unknown[]): void { for (const cb of this.handlers.get(name) ?? []) cb(...data); }
}
const STUB = "obsidian-stub-terminal-session";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { Events: FakeEvents } } as unknown as NodeJS.Module;
const { TerminalPool } = require("./terminalPool") as typeof PoolModule;

type Proc = HostPtyProcess & { written: string[]; killed: number; data(d: string): void; exit(code?: number): void };
function proc(pid: number): Proc {
  const data: Array<(d: string) => void> = [];
  const exit: Array<(e: { exitCode: number }) => void> = [];
  const p: Proc = {
    pid, written: [], killed: 0,
    write: (d) => { p.written.push(d); },
    resize: () => {},
    kill: () => { p.killed++; },
    onData: (cb) => { data.push(cb); },
    onExit: (cb) => { exit.push(cb); },
    data: (d) => { for (const cb of data) cb(d); },
    exit: (code = 0) => { for (const cb of exit) cb({ exitCode: code }); },
  };
  return p;
}

/** A host whose terminals are fakes: spawn records the shells, spawnAgent answers what the test hands it. */
function fakeHost(agentAnswer?: () => Promise<HostResult<HostPtyProcess>>) {
  const shells: Array<{ file: string; opts: HostPtyOptions; p: Proc }> = [];
  const requests: HostPtyAgentRequest[] = [];
  let pid = 100;
  const node = createNodeHost();
  const host: HudHost = {
    ...node,
    pty: {
      loadError: () => null,
      spawn: (file, _args, opts) => { const p = proc(++pid); shells.push({ file, opts, p }); return p; },
      ...(agentAnswer ? { spawnAgent: (req: HostPtyAgentRequest) => { requests.push(req); return agentAnswer(); } } : {}),
    },
  };
  setHudHost(host);
  return { shells, requests };
}

const PLACE: Place = { kind: "workspace", label: "harbor-map", dir: "/vault/workspaces/harbor-map", workspace: "harbor-map" };
const SPEC: LaunchSpec = { host: "claude", bin: null, model: "opus", access: "edit", sessionId: "3f2c9a1e-0000-4000-8000-000000000001", gitInit: true, configDir: "/cfg/claude", cwd: PLACE.dir };
const META = { host: "claude" as const, place: PLACE, origin: null, label: null, model: "opus", access: "edit" as const, sessionId: SPEC.sessionId ?? null, startedAt: 1 };

test("the terminal shows at once; main's agent becomes its process; when the agent exits the login shell takes over, and the terminal ends only with that shell", async () => {
  const agent = proc(4242);
  let answer: (r: HostResult<HostPtyProcess>) => void = () => {};
  const { shells, requests } = fakeHost(() => new Promise((r) => { answer = r; }));
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  const exits: unknown[] = [];
  pool.on("session-exit", (s: unknown) => exits.push(s));
  const { session, ready } = pool.createAgent({ spec: SPEC, place: PLACE, meta: META, shell: "/bin/sh" });
  assert.deepEqual(pool.list(), [session], "in the deck before main answers");
  assert.equal(session.isExited, false);
  assert.deepEqual(requests, [{
    host: "claude", argv: launchArgs(SPEC), cwd: PLACE.dir, configDir: "/cfg/claude", gitInit: true, cols: 80, rows: 24,
    place: "ws:harbor-map", label: "Claude Code in harbor-map", access: "edit",
  }]);
  session.write("typed early");
  session.resize(132, 50);
  answer({ ok: true, data: agent });
  assert.deepEqual(await ready, { agent: true, reason: null });
  assert.deepEqual(agent.written, ["typed early"], "what was typed while it started reaches the agent");
  assert.equal(shells.length, 0, "no shell while the agent runs");
  agent.data("\u001b]0;Fixing the parser\u0007hello");
  assert.equal(session.getTitle(), "Fixing the parser");
  agent.exit(0);
  assert.equal(shells.length, 1, "the login shell took over");
  assert.equal(shells[0].file, "/bin/sh");
  assert.deepEqual([shells[0].opts.cwd, shells[0].opts.cols, shells[0].opts.rows, shells[0].opts.env?.TERM], [PLACE.dir, 132, 50, "xterm-256color"]);
  assert.equal(session.isExited, false, "the terminal runs on");
  assert.deepEqual(exits, []);
  assert.match(session.getScrollback(), /hello[\s\S]*Claude Code ended/);
  assert.equal(session.getTitle(), "Claude Code", "the agent's title goes with it");
  assert.equal(session.meta.host, "claude", "still a Claude Code terminal: its end bar keeps Restart and Resume");
  assert.equal(session.meta.sessionId, SPEC.sessionId);
  session.write("ls\r");
  assert.deepEqual(shells[0].p.written, ["ls\r"]);
  agent.data("late");
  assert.doesNotMatch(session.getScrollback(), /late/, "the old agent's stream is no longer this terminal's");
  shells[0].p.exit(2);
  assert.equal(session.isExited, true);
  assert.equal(session.exitCode, 2);
  assert.deepEqual(exits, [session]);
});

test("a fallback starts the shell and types the launch line, and hands back main's reason for the note; a host without agents falls back silently", async () => {
  const { shells } = fakeHost(async () => ({ ok: false, error: "Claude Code at /opt/claude isn't a supported install: unsigned", code: "fallback" }));
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  const { session, ready } = pool.createAgent({ spec: SPEC, place: PLACE, meta: META });
  assert.deepEqual(await ready, { agent: false, reason: "Claude Code at /opt/claude isn't a supported install: unsigned" });
  assert.equal(shells.length, 1);
  assert.equal(shells[0].file, "/bin/zsh", "the pool's default shell when none is named");
  assert.deepEqual(shells[0].p.written, [`${launchLine(SPEC)}\r`]);
  shells[0].p.exit(0);
  assert.equal(session.isExited, true, "the exec'd agent ends the terminal, as before");

  const plain = fakeHost();
  const pool2 = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  assert.deepEqual(await pool2.createAgent({ spec: SPEC, place: PLACE, meta: META }).ready, { agent: false, reason: null });
  assert.deepEqual(plain.shells[0].p.written, [`${launchLine(SPEC)}\r`]);
});

test("a fallback types the launch line before what was typed while the terminal started: typeahead reaches the agent, never the shell's line", async () => {
  let answer: (r: HostResult<HostPtyProcess>) => void = () => {};
  const { shells } = fakeHost(() => new Promise((r) => { answer = r; }));
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  const { session, ready } = pool.createAgent({ spec: SPEC, place: PLACE, meta: META });
  session.write("fix the parser");
  session.write("\r");
  answer({ ok: false, error: "Claude Code at /opt/claude isn't a supported install: unsigned", code: "fallback" });
  await ready;
  assert.equal(shells[0].p.written.join(""), `${launchLine(SPEC)}\rfix the parser\r`);
});

test("what main's schema would refuse never blocks the launch: a long label is cut to 200 characters, a place key over 512 falls back without asking main", async () => {
  const { shells, requests } = fakeHost(async () => ({ ok: true, data: proc(4300) }));
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  const long = "w".repeat(300);
  const named: Place = { kind: "workspace", label: long, dir: `/vault/workspaces/${long}`, workspace: long };
  const a = pool.createAgent({ spec: SPEC, place: named, meta: META });
  assert.deepEqual(await a.ready, { agent: true, reason: null });
  assert.equal(requests[0].label.length, 200);
  assert.equal(requests[0].place, `ws:${long}`);
  const deep: Place = { kind: "other", label: "deep", dir: `/${"d".repeat(600)}` };
  const b = pool.createAgent({ spec: SPEC, place: deep, meta: META });
  const r = await b.ready;
  assert.equal(r.agent, false);
  assert.match(r.reason ?? "", /too long/);
  assert.equal(requests.length, 1, "main was not asked");
  assert.deepEqual(shells.at(-1)?.p.written, [`${launchLine(SPEC)}\r`]);
});

test("a refusal ends the terminal with the reason in it and rejects; a value launchArgs refuses throws before any terminal opens", async () => {
  const { shells, requests } = fakeHost(async () => ({ ok: false, error: "a working directory that is not there", code: "EROFS" }));
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  const exits: unknown[] = [];
  pool.on("session-exit", (s: unknown) => exits.push(s));
  const { session, ready } = pool.createAgent({ spec: SPEC, place: PLACE, meta: META });
  await assert.rejects(ready, /Claude Code did not start: a working directory that is not there/);
  assert.deepEqual(pool.list(), [session], "still in the deck, ended: its end bar offers Restart and a shell");
  assert.deepEqual([session.isExited, session.exitCode], [true, 1]);
  assert.match(session.getScrollback(), /Claude Code did not start: a working directory that is not there/);
  assert.deepEqual(exits, [session]);
  assert.equal(shells.length, 0);
  assert.throws(() => pool.createAgent({ spec: { ...SPEC, model: "--dangerously-skip-permissions" }, place: PLACE, meta: META }), /starts with "-"/);
  assert.equal(requests.length, 1, "main was never asked");
  assert.deepEqual(pool.list(), [session]);
});

test("a terminal closed while it starts kills the agent when it arrives, opens no shell, and reports it not started (no note)", async () => {
  const agent = proc(4243);
  let answer: (r: HostResult<HostPtyProcess>) => void = () => {};
  const { shells } = fakeHost(() => new Promise((r) => { answer = r; }));
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  const { session, ready } = pool.createAgent({ spec: SPEC, place: PLACE, meta: META });
  pool.remove(session.id);
  answer({ ok: true, data: agent });
  await assert.rejects(ready, /closed/);
  assert.equal(agent.killed, 1);
  agent.exit(0);
  assert.equal(shells.length, 0);
  // The same on the fallback path: no shell for a closed terminal.
  const fb = fakeHost(async () => ({ ok: false, error: "unsigned", code: "fallback" }));
  const pool2 = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  const c = pool2.createAgent({ spec: SPEC, place: PLACE, meta: META });
  pool2.remove(c.session.id);
  await assert.rejects(c.ready, /closed/);
  assert.equal(fb.shells.length, 0);
});
