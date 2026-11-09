// A Code launch's terminal (agent-computer D18): main runs the agent CLI as the terminal's own process, so the terminal
// shows at once, starting, and gets the agent when main answers; when the agent exits the user's login shell takes over
// in the same terminal and folder, and the terminal ends only with that shell. When main cannot vouch for the agent it
// falls back to today's terminal: the shell with the launch line typed. A fake HudHost stands in for main's terminals.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type * as PoolModule from "./terminalPool";
import type * as LauncherModule from "./terminalLauncher";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { setHudHost, type HostPtyAgentRequest, type HostPtyAgentResult, type HostPtyOptions, type HostPtyProcess, type HostResult, type HudHost } from "../host";
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
const { TerminalLauncher } = require("./terminalLauncher") as typeof LauncherModule;

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
function fakeHost(agentAnswer?: () => Promise<HostPtyAgentResult>) {
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
    place: "ws:harbor-map", label: "Claude Code in harbor-map", access: "edit", terminal: session.meta.terminalKey,
  }]);
  assert.match(session.meta.terminalKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a v4 UUID (code-chat R15)");
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

test("an agent main runs knows its computer key, code:<the app's terminal id>; a shell, a fallback or a host without ids has none", async () => {
  fakeHost(async () => ({ ok: true, data: { ...proc(4250), id: "t7" } }));
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  const { session, ready } = pool.createAgent({ spec: SPEC, place: PLACE, meta: META });
  assert.equal(session.computerKey, null, "none while it starts");
  await ready;
  assert.equal(session.computerKey, "code:t7", "the key the computer names this agent by (agent-computer D35)");
  assert.equal(pool.create().computerKey, null, "a plain shell");
  fakeHost(async () => ({ ok: true, data: proc(4251) }));
  const bare = pool.createAgent({ spec: SPEC, place: PLACE, meta: META });
  await bare.ready;
  assert.equal(bare.session.computerKey, null, "a process without the app's id");
  fakeHost(async () => ({ ok: false, error: "unsigned", code: "fallback" }));
  const fb = pool.createAgent({ spec: SPEC, place: PLACE, meta: META });
  await fb.ready;
  assert.equal(fb.session.computerKey, null);
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

test("R79: a line main refuses for its --no-daemon is rebuilt from main's answer and asked once more; a second refusal ends it", async () => {
  const CODEX: LaunchSpec = { host: "codex", bin: "/opt/homebrew/bin/codex", model: "gpt-6-luna", access: "host", cwd: PLACE.dir };
  const answers: HostPtyAgentResult[] = [
    { ok: false, error: "this Codex launch needs --no-daemon now: the page builds it again", code: "flags", flags: { noDaemon: true, bin: "/opt/homebrew/bin/codex" } },
    { ok: true, data: proc(4400) },
  ];
  const { requests, shells } = fakeHost(async () => answers.shift()!);
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  const seen: unknown[] = [];
  const onFlags = (f: { noDaemon: boolean; bin: string | null }): void => { seen.push(f); };
  const { ready } = pool.createAgent({ spec: CODEX, place: PLACE, meta: { ...META, host: "codex" }, onFlags });
  assert.deepEqual(await ready, { agent: true, reason: null });
  assert.deepEqual(seen, [{ noDaemon: true, bin: "/opt/homebrew/bin/codex" }]);
  assert.deepEqual(requests.map((r) => r.argv), [["-m", "gpt-6-luna"], ["--no-daemon", "-m", "gpt-6-luna"]], "the same terminal, asked once more with main's answer");
  assert.equal(shells.length, 0);
  // Refused again (the answer changed once more): the terminal ends with the reason; no third ask.
  const again: HostPtyAgentResult = { ok: false, error: "this Codex launch must go without --no-daemon now: the page builds it again", code: "flags", flags: { noDaemon: false, bin: "/opt/homebrew/bin/codex" } };
  const twice = fakeHost(async () => again);
  const b = pool.createAgent({ spec: CODEX, place: PLACE, meta: { ...META, host: "codex" }, onFlags });
  await assert.rejects(b.ready, /Codex did not start: this Codex launch must go without --no-daemon now/);
  assert.equal(twice.requests.length, 2);
  // A fallback after the retry types the rebuilt line.
  const fb = fakeHost(async () => (fb.requests.length === 1 ? answers0() : { ok: false, error: "unsigned", code: "fallback" }));
  function answers0(): HostPtyAgentResult { return { ok: false, error: "needs it", code: "flags", flags: { noDaemon: true, bin: "/opt/homebrew/bin/codex" } }; }
  const c = pool.createAgent({ spec: CODEX, place: PLACE, meta: { ...META, host: "codex" }, onFlags });
  assert.deepEqual(await c.ready, { agent: false, reason: "unsigned" });
  assert.deepEqual(fb.shells[0].p.written, [`${launchLine({ ...CODEX, noDaemon: true, probedBin: "/opt/homebrew/bin/codex" })}\r`]);
  assert.match(fb.shells[0].p.written[0], /--no-daemon/, "the typed line is the rebuilt one");
});

test("R80: the flags retry relaunches the same spec with only main's answer changed: a setting changed between the tries does not reach it", async () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "aos-retry-"));
  const vault = nodePath.join(root, "Vault");
  fs.mkdirSync(nodePath.join(vault, "workspaces"), { recursive: true });
  fs.mkdirSync(nodePath.join(root, "cfg"));
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: vault });
  const settings: Record<string, unknown> = {
    terminalChoice: { access: "edit" }, sessionChoice: { models: { codex: "gpt-6-luna" } }, terminalShell: "/bin/sh",
  };
  const plugin = {
    vaultRoot: () => vault, claudeConfigDir: () => nodePath.join(root, "cfg"), settings, saveSettings: async () => {},
    runBrainScript: () => {}, terminalPool: pool,
  };
  const answers: HostPtyAgentResult[] = [
    { ok: false, error: "this Codex launch needs --no-daemon now: the page builds it again", code: "flags", flags: { noDaemon: true, bin: "/opt/homebrew/bin/codex" } },
    { ok: true, data: proc(4500) },
  ];
  const { requests } = fakeHost(async () => {
    // The person changes the model and the access level while the first try is on its way.
    if (requests.length === 1) {
      settings.sessionChoice = { models: { codex: "gpt-6-sol" } };
      settings.terminalChoice = { access: "read" };
    }
    return answers.shift()!;
  });
  const launcher = new TerminalLauncher(plugin as never);
  const { session } = await launcher.launch({ host: "codex", picked: { kind: "vault", label: "Vault", dir: vault } });
  for (let i = 0; i < 50 && requests.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(requests.map((r) => r.argv), [
    ["-m", "gpt-6-luna", "-s", "workspace-write", "-a", "on-request"],
    ["--no-daemon", "-m", "gpt-6-luna", "-s", "workspace-write", "-a", "on-request"],
  ], "the retry is the first line with main's answer, not a line rebuilt from the settings now");
  assert.deepEqual(requests.map((r) => r.access), ["edit", "edit"]);
  assert.equal(session.meta.model, "gpt-6-luna");
  assert.match(launcher.preview("codex"), /^exec codex --no-daemon\b/, "the launcher keeps main's answer for its preview");
});

test("code-chat R15: AOS_TERMINAL is the terminal's key on an agent terminal's shell and on none else; a restored meta without a key gets a fresh one", async () => {
  const { shells } = fakeHost(async () => ({ ok: false, error: "", code: "fallback" }));
  const pool = new TerminalPool({ shell: "/bin/zsh", cwd: "/vault" });
  const { session, ready } = pool.createAgent({ spec: SPEC, place: PLACE, meta: META });
  await ready;
  assert.equal(shells[0].opts.env?.AOS_TERMINAL, session.meta.terminalKey, "the fallback shell carries it, so the typed agent inherits it");
  const plain = pool.create();
  assert.equal(shells[1].opts.env?.AOS_TERMINAL, undefined, "a plain shell has none");
  assert.notEqual(plain.meta.terminalKey, session.meta.terminalKey, "each terminal has its own key");
  const kept = pool.create({ meta: { host: "codex", terminalKey: "aaaaaaaa-0000-4000-8000-000000000001" } });
  assert.equal(shells[2].opts.env?.AOS_TERMINAL, "aaaaaaaa-0000-4000-8000-000000000001");
  assert.equal(kept.meta.terminalKey, "aaaaaaaa-0000-4000-8000-000000000001");
});
