// A Code launch as main runs it (agent-computer D18, D30): the agent's CLI is the terminal's own process, started from
// the binary the runtime resolves, only when its install form can be vouched for, with only the flags the Code page's
// launch line carries; while it runs it is in the registry the bridge admits from. Anything main cannot vouch for falls
// back to the typed launch line in a shell (the HUD's), and never blocks the launch.

import { test } from "node:test";
import assert from "node:assert/strict";
import type * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PtyEvent } from "../../src/shared/ipc";
import type { ProgramContext } from "../../src/main/policy/programs";
import { agentArgvRefusal } from "../../src/main/policy/agent-launch";
import { PtyService, terminalBaseEnv, type PtyAgentRequest, type PtyLib, type PtyProcess, type PtyServiceOptions } from "../../src/main/services/pty";
import { AgentRegistry, type AgentRef } from "../../src/main/computer/registry";
import { VENDOR, type Sys } from "../../src/main/computer/admission";
import { FlagProbe, cliHelp } from "../../src/main/services/cli-flags";
import { CodeMirrorService } from "../../src/main/services/code-mirror";
import { COMPUTER_LOOK, COMPUTER_TOOLS, TERM_ACCESS, launchArgs, type LaunchSpec } from "../../../hud/src/data/terminalLaunch";

// ── agentArgvRefusal ─────────────────────────────────────────────────

test("agentArgvRefusal accepts every argv the Code page's launchArgs builds, on both hosts", () => {
  const specs: LaunchSpec[] = [];
  for (const access of TERM_ACCESS) {
    for (const model of [null, "opus", "claude-sonnet-4-5"]) {
      specs.push({ host: "claude", bin: null, model, access, sessionId: "3f2c9a1e-0000-4000-8000-000000000001" });
      specs.push({ host: "claude", bin: null, model, access, resume: "last" });
      specs.push({ host: "claude", bin: null, model, access, resume: { id: "c1a0de00-0000-4000-8000-000000000001" } });
      specs.push({ host: "claude", bin: null, model, access });
      specs.push({ host: "codex", bin: null, model: model && "gpt-5-codex", access });
      specs.push({ host: "codex", bin: null, model, access, resume: "last" });
      specs.push({ host: "codex", bin: null, model, access, resume: { id: "019a-thread" }, cwd: "/srv/code/tide chart" });
      specs.push({ host: "codex", bin: null, model, access, resume: { id: "019a-thread" } });
      // A chip restart (code-chat C12): the same conversation by id with the pick, on either host (R66).
      for (const picked of [{ model: true }, { access: true }, { model: true, access: true }]) {
        for (const cwd of [undefined, "/srv/code/tide chart"]) {
          specs.push({ host: "claude", bin: null, model, access, resume: { id: "c1a0de00-0000-4000-8000-000000000001" }, picked, cwd });
          specs.push({ host: "codex", bin: null, model: model && "gpt-6-luna", access, resume: { id: "019a-thread" }, picked, cwd });
        }
      }
    }
  }
  for (const s of specs) {
    const argv = launchArgs(s);
    assert.equal(agentArgvRefusal(s.host, argv), null, `${s.host} ${JSON.stringify(argv)}`);
  }
  // The picks do ride on a Codex resume's line, after the id (what the live check's restart was refused for).
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: "gpt-6-luna", access: "read", resume: { id: "019a-thread" }, picked: { model: true, access: true }, cwd: "/srv/code" }),
    ["resume", "-C", "/srv/code", "019a-thread", "-m", "gpt-6-luna", "-s", "read-only", "-a", "on-request"]);
});

test("agentArgvRefusal refuses what launchArgs never emits: skip-permission and MCP flags, unknown flags, odd values, -c keys", () => {
  const no = (host: "claude" | "codex", argv: string[]) => {
    const why = agentArgvRefusal(host, argv);
    assert.equal(typeof why, "string", `${host} ${JSON.stringify(argv)} should be refused`);
    assert.ok(why && why.length > 0 && !why.includes("\n"), "one line");
  };
  no("claude", ["--dangerously-skip-permissions"]);
  no("claude", ["--mcp-config", "/tmp/servers.json"]);
  no("claude", ["--strict-mcp-config"]);
  no("claude", ["--frobnicate"]);
  no("claude", ["--model=opus"]);
  no("claude", ["--model", "-p"]);
  no("claude", ["--model"]);
  no("claude", ["--session-id", "--dangerously-skip-permissions"]);
  no("claude", ["--resume", "id\u0015rm"]);
  no("claude", ["say hello"]);
  no("claude", ["--permission-mode", "bypassPermissions"]);
  no("claude", ["--allowedTools", "Bash,Write"]);
  no("claude", ["--allowedTools", "Write"]);
  no("claude", ["--allowedTools", "Bash", "Write"]);
  no("claude", ["--allowedTools"]);
  no("claude", ["--model", "a", "--model", "b"]);
  no("claude", ["-c", "x=y"]);
  no("codex", ["-c", "approval_policy=never"]);
  no("codex", ["-c", "approvals_reviewer=auto_review"]);
  no("codex", ["-c", "x=y"]);
  no("codex", ["--dangerously-bypass-approvals-and-sandbox"]);
  no("codex", ["-s", "danger-full-access"]);
  no("codex", ["-a", "never"]);
  no("codex", ["-m", "-x"]);
  no("codex", ["exec", "do it"]);
  no("codex", ["say hello"]);
  no("codex", ["resume", "--last", "extra"]);
  no("codex", ["resume", "-C", "relative/dir", "019a-thread"]);
  no("codex", ["resume", "-C", "/abs", "-x"]);
  no("codex", ["resume", "-C", "/abs"]);
  no("codex", ["resume", "019a-thread", "-c", "x=y"]);
  no("codex", ["resume"]);
  no("codex", ["-s", "read-only", "-s", "workspace-write"]);
  // After a resume's id only a chip's picks, each once, with a new session's value rules (R66).
  no("codex", ["resume", "019a-thread", "-m", "gpt-6-luna", "-m", "gpt-6-sol"]);
  no("codex", ["resume", "-C", "/abs", "019a-thread", "-s", "read-only", "-s", "read-only"]);
  no("codex", ["resume", "019a-thread", "--frobnicate"]);
  no("codex", ["resume", "-C", "/abs", "019a-thread", "--dangerously-bypass-approvals-and-sandbox"]);
  no("codex", ["resume", "-C", "/abs", "019a-thread", "-m", "gpt-6-luna", "-c", "approval_policy=never"]);
  no("codex", ["resume", "019a-thread", "--config", "x=y"]);
  no("codex", ["resume", "019a-thread", "-s", "danger-full-access"]);
  no("codex", ["resume", "019a-thread", "-a", "never"]);
  no("codex", ["resume", "019a-thread", "-m", "-x"]);
  no("codex", ["resume", "019a-thread", "-m"]);
  no("codex", ["resume", "019a-thread", "-C", "/abs"]);
  no("codex", ["resume", "019a-thread", "-m", "gpt-6-luna", "say hello"]);
  no("codex", ["resume", "--last", "-m", "gpt-6-luna"]);
  assert.match(agentArgvRefusal("codex", ["resume", "019a-thread", "-c", "x=y"]) ?? "", /-c override/);
  assert.match(agentArgvRefusal("codex", ["resume", "019a-thread", "-m", "a", "-m", "b"]) ?? "", /-m twice/);
});

test("R70: agentArgvRefusal accepts --no-daemon where launchArgs puts it on a Codex line, and nowhere else", () => {
  for (const access of TERM_ACCESS) {
    for (const s of [
      { host: "codex", bin: null, model: "gpt-6-luna", access, noDaemon: true },
      { host: "codex", bin: null, model: null, access, noDaemon: true },
      { host: "codex", bin: null, model: null, access, noDaemon: true, resume: "last" },
      { host: "codex", bin: null, model: null, access, noDaemon: true, resume: { id: "019a-thread" }, cwd: "/srv/code/tide chart" },
      { host: "codex", bin: null, model: null, access, noDaemon: true, resume: { id: "019a-thread" } },
      { host: "codex", bin: null, model: "gpt-6-luna", access, noDaemon: true, resume: { id: "019a-thread" }, cwd: "/srv/code/tide chart", picked: { model: true, access: true } },
      { host: "codex", bin: null, model: "gpt-6-luna", access, noDaemon: true, resume: { id: "019a-thread" }, picked: { model: true } },
    ] as LaunchSpec[]) {
      assert.equal(agentArgvRefusal("codex", launchArgs(s), { noDaemon: true }), null, JSON.stringify(launchArgs(s)));
      // R79: only as main's spawn check allows: when main's answer is no, the flag is refused.
      assert.match(agentArgvRefusal("codex", launchArgs(s), { noDaemon: false }) ?? "", /--no-daemon/, JSON.stringify(launchArgs(s)));
    }
  }
  assert.match(agentArgvRefusal("codex", ["--no-daemon", "-m", "gpt-6-luna"]) ?? "", /--no-daemon/, "not allowed unless main says so");
  const no = (host: "claude" | "codex", argv: string[]) => assert.equal(typeof agentArgvRefusal(host, argv, { noDaemon: true }), "string", `${host} ${JSON.stringify(argv)}`);
  no("codex", ["--no-daemon", "--no-daemon"]);
  no("codex", ["--no-daemon=1"]);
  no("claude", ["--no-daemon"]);
  no("codex", ["resume", "--last", "--no-daemon"]);
  no("codex", ["resume", "--no-daemon"]);
  no("codex", ["resume", "--no-daemon", "--no-daemon", "--last"]);
  no("codex", ["resume", "019a-thread", "--no-daemon"]);
});

test("agentArgvRefusal: --allowedTools takes one comma-joined value of Bash and the known computer tools, nothing else (agent-computer D33)", () => {
  const plug = (t: string) => `mcp__plugin_agenticos_agenticos__${t}`;
  const yes = (v: string) => assert.equal(agentArgvRefusal("claude", ["--permission-mode", "acceptEdits", "--allowedTools", v]), null, v);
  const no = (v: string) => assert.match(agentArgvRefusal("claude", ["--allowedTools", v]) ?? "", /^--allowedTools with the value /, v);
  yes("Bash");
  for (const t of COMPUTER_TOOLS) yes(plug(t));
  yes(COMPUTER_LOOK.map(plug).join(","));
  yes(COMPUTER_TOOLS.map(plug).join(","));
  yes(["Bash", ...COMPUTER_TOOLS.map(plug)].join(","));
  no("");
  no(",");
  no(`Bash,${plug("computer_open")},`);
  no(`Bash,,${plug("computer_open")}`);
  no(`Bash, ${plug("computer_open")}`);
  no(`Bash,Bash`);
  no(`${plug("computer_open")},${plug("computer_open")}`);
  no(plug("computer_frobnicate"));
  no(plug("wrap_session"));
  no("mcp__agenticos__computer_open");
  no("mcp__plugin_other_other__computer_open");
  no("computer_open");
  no("Bash(rm:*)");
  no("mcp__plugin_agenticos_agenticos__*");
  no("Write,Bash");
  no(`${plug("computer_open")}\u0015`);
  // Still once only, and -c stays refused on both hosts.
  assert.match(agentArgvRefusal("claude", ["--allowedTools", "Bash", "--allowedTools", plug("computer_open")]) ?? "", /twice/);
  assert.match(agentArgvRefusal("codex", ["-c", `mcp_servers.agenticos.tools.computer_open.approval_mode="approve"`]) ?? "", /-c override/);
});

// ── spawnAgent ───────────────────────────────────────────────────────

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-agent-launch-")));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
const VAULT = path.join(ROOT, "vault");
const HOME = path.join(ROOT, "home");
const BIN = path.join(ROOT, "bin");
const CODE = path.join(ROOT, "code", "tide-chart");
for (const d of [VAULT, HOME, BIN, CODE, path.join(HOME, ".claude"), path.join(HOME, "other-claude")]) fs.mkdirSync(d, { recursive: true });
const CLAUDE = path.join(BIN, "claude");
fs.writeFileSync(CLAUDE, "#!/bin/sh\n", { mode: 0o755 });
// An npm install: the bin is a link to the package's entry script.
const PKG = path.join(ROOT, "lib", "node_modules", "@anthropic-ai", "claude-code");
fs.mkdirSync(PKG, { recursive: true });
fs.writeFileSync(path.join(PKG, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
const NPM_CLAUDE = path.join(BIN, "claude-npm");
fs.symlinkSync(path.join(PKG, "cli.js"), NPM_CLAUDE);
const IN_VAULT = path.join(VAULT, "claude");
fs.writeFileSync(IN_VAULT, "#!/bin/sh\n", { mode: 0o755 });

const context = (): ProgramContext => ({ vaultRoot: VAULT, home: HOME, userData: path.join(ROOT, "userData"), env: {}, agenticos: null, shells: ["/bin/sh"] });

/** A Sys whose static check answers `team` for every file (a fresh object each time: launchForm caches per Sys). */
const sysOf = (team: string | null): Sys => ({
  procInfo: () => null, teamId: () => team, processTeamId: () => null, realpath: (p) => fs.realpathSync(p), stat: (p) => fs.statSync(p),
});

type FakeProc = PtyProcess & { written: string[]; killed: string[]; exit(code?: number): void; data(d: string): void };
function fakePty(): { lib: PtyLib; spawned: Array<{ file: string; args: string[]; opts: Record<string, unknown>; p: FakeProc }> } {
  const spawned: Array<{ file: string; args: string[]; opts: Record<string, unknown>; p: FakeProc }> = [];
  let pid = 7000;
  const lib: PtyLib = {
    spawn: (file, args, opts) => {
      let onData: (d: string) => void = () => {};
      let onExit: (e: { exitCode: number }) => void = () => {};
      const p: FakeProc = {
        pid: ++pid, written: [], killed: [],
        write: (d) => { p.written.push(d); },
        resize: () => {},
        kill: (signal) => { p.killed.push(signal ?? "SIGHUP"); },
        onData: (cb) => { onData = cb; },
        onExit: (cb) => { onExit = cb; },
        exit: (code = 0) => onExit({ exitCode: code }),
        data: (d) => onData(d),
      };
      spawned.push({ file, args, opts, p });
      return p;
    },
  };
  return { lib, spawned };
}

function service(o: { bin?: string | { reason: string }; sys?: Sys | null; git?: string[]; registry?: AgentRegistry; resolveBin?: boolean; extra?: Partial<PtyServiceOptions> } = {}) {
  const { lib, spawned } = fakePty();
  const events: PtyEvent[] = [];
  const registry = o.registry ?? new AgentRegistry();
  const asked: string[] = [];
  const t = new PtyService({
    context, env: { PATH: "/usr/bin:/bin", HOME }, emit: (ev) => events.push(ev), load: () => lib,
    ...(o.resolveBin === false ? {} : { resolveBin: async (host: "claude" | "codex") => { asked.push(host); return typeof o.bin === "object" ? o.bin : { bin: o.bin ?? CLAUDE }; } }),
    registry,
    sys: o.sys === undefined ? sysOf(VENDOR.claude.team) : o.sys,
    gitInit: async (cwd) => { o.git?.push(cwd); },
    computerOn: () => true,
    ...o.extra,
  });
  return { t, spawned, events, registry, asked };
}

const req = (over: Partial<PtyAgentRequest> = {}): PtyAgentRequest => ({
  id: "t1", host: "claude", argv: ["--permission-mode", "acceptEdits", "--session-id", "3f2c9a1e-0000-4000-8000-000000000001"],
  cwd: VAULT, configDir: null, gitInit: false, cols: 120, rows: 40, place: "vault", label: "Claude Code in Vault", access: "edit", ...over,
});

test("spawnAgent: the runtime's binary runs as the terminal's own process, registered as a Code agent until it exits", async () => {
  const { t, spawned, events, registry, asked } = service();
  const r = await t.spawnAgent(req());
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(asked, ["claude"], "resolved by the runtime, the way a Chat turn's binary is");
  assert.equal(spawned.length, 1);
  const s = spawned[0];
  assert.equal(s.file, CLAUDE);
  assert.deepEqual(s.args, req().argv);
  assert.deepEqual([s.opts.cwd, s.opts.cols, s.opts.rows, s.opts.name], [VAULT, 120, 40, "xterm-256color"]);
  const env = s.opts.env as Record<string, string>;
  assert.deepEqual([env.TERM, env.COLORTERM, env.AGENTIC_OS, env.FORCE_HYPERLINK, env.PATH], ["xterm-256color", "truecolor", "1", "1", "/usr/bin:/bin"]);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined, "no config folder: the agent finds the one a new terminal would");
  assert.deepEqual(r.data, { pid: s.p.pid });
  assert.deepEqual(registry.get(s.p.pid), { pid: s.p.pid, host: "claude", page: "code", key: "code:t1", label: "Claude Code in Vault", place: "vault", access: "edit" });
  s.p.data("hello");
  t.write("t1", "/help\r");
  assert.deepEqual(s.p.written, ["/help\r"]);
  s.p.exit(0);
  assert.deepEqual(events, [{ id: "t1", type: "data", data: "hello" }, { id: "t1", type: "exit", exitCode: 0 }]);
  assert.equal(registry.get(s.p.pid), undefined, "forgotten when it exits");
  assert.equal(t.open, 0);
});

test("spawnAgent: closing the terminal, and every terminal ending with the page, forget the agent at once", async () => {
  const { t, spawned, registry } = service();
  assert.ok((await t.spawnAgent(req({ id: "t1" }))).ok);
  assert.ok((await t.spawnAgent(req({ id: "t2", place: "ws:harbor-map" }))).ok);
  assert.ok((await t.spawnAgent(req({ id: "t3" }))).ok);
  const [a, b, c] = spawned.map((s) => s.p.pid);
  t.kill("t1");
  assert.deepEqual(spawned[0].p.killed, ["SIGHUP"]);
  assert.equal(registry.get(a), undefined);
  assert.equal(registry.get(b)?.key, "code:t2");
  t.killAll();
  assert.equal(registry.get(b), undefined);
  assert.equal(registry.get(c), undefined);
  // A late exit of a forgotten agent leaves a newer registration of the same pid alone.
  registry.add({ pid: b, host: "claude", page: "chat", key: "chat:thread-1", label: "x", place: "ws:harbor-map", access: "edit" });
  spawned[1].p.exit(0);
  assert.equal(registry.get(b)?.key, "chat:thread-1");
});

test("spawnAgent: an agent still being resolved when every terminal ends with its page is never started", async () => {
  const { lib, spawned } = fakePty();
  const registry = new AgentRegistry();
  let answer: (r: { bin: string }) => void = () => {};
  const t = new PtyService({
    context, env: { PATH: "/usr/bin" }, emit: () => {}, load: () => lib, registry, sys: sysOf(VENDOR.claude.team), computerOn: () => true,
    resolveBin: () => new Promise((r) => { answer = r; }),
  });
  const pending = t.spawnAgent(req());
  await new Promise((r) => setImmediate(r));
  t.killAll();
  answer({ bin: CLAUDE });
  const r = await pending;
  assert.equal(!r.ok && r.code, "ECANCELED");
  assert.equal(spawned.length, 0);
  assert.equal(t.open, 0);
});

test("spawnAgent: an agent still being resolved when the app starts quitting is never started (R86)", async () => {
  const { lib, spawned } = fakePty();
  let quitting = false;
  let answer: (r: { bin: string }) => void = () => {};
  const t = new PtyService({
    context, env: { PATH: "/usr/bin" }, emit: () => {}, load: () => lib, registry: new AgentRegistry(), sys: sysOf(VENDOR.claude.team), computerOn: () => true,
    resolveBin: () => new Promise((r) => { answer = r; }), quitting: () => quitting,
  });
  const pending = t.spawnAgent(req());
  await new Promise((r) => setImmediate(r));
  quitting = true;
  answer({ bin: CLAUDE });
  assert.deepEqual(await pending, { ok: false, error: "the app is quitting", code: "ECANCELED" });
  assert.equal(spawned.length, 0);
  assert.equal(t.busy, false);
});

test("spawnAgent: a stale agent's late exit (its page reloaded, its id taken again) is not sent as the new terminal's", async () => {
  const { t, spawned, events, registry } = service();
  assert.ok((await t.spawnAgent(req({ id: "t1" }))).ok);
  t.killAll();
  assert.ok((await t.spawnAgent(req({ id: "t1" }))).ok, "the reloaded page's first terminal");
  spawned[0].p.exit(0);
  assert.deepEqual(events.filter((e) => e.type === "exit"), [], "no exit for t1 while the new t1 runs");
  assert.equal(t.open, 1);
  assert.equal(registry.get(spawned[1].p.pid)?.key, "code:t1");
  spawned[1].p.exit(0);
  assert.deepEqual(events.filter((e) => e.type === "exit"), [{ id: "t1", type: "exit", exitCode: 0 }]);
});

test("spawnAgent: an npm install of the vendor's package is accepted without a signature; the config folder reaches the agent's environment", async () => {
  const { t, spawned, registry } = service({ bin: NPM_CLAUDE, sys: sysOf(null) });
  const r = await t.spawnAgent(req({ configDir: path.join(HOME, ".claude"), access: "host" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(spawned[0].file, NPM_CLAUDE);
  assert.equal((spawned[0].opts.env as Record<string, string>).CLAUDE_CONFIG_DIR, path.join(HOME, ".claude"));
  assert.equal(registry.get(spawned[0].p.pid)?.access, "host");
});

test("spawnAgent: git init runs first when asked and the folder has no .git; a linked code folder outside the vault is a place too (D30)", async () => {
  const git: string[] = [];
  const { t } = service({ git });
  assert.ok((await t.spawnAgent(req({ id: "t1", cwd: CODE, gitInit: true, place: "ws:tide-chart" }))).ok);
  assert.deepEqual(git, [CODE]);
  fs.mkdirSync(path.join(CODE, ".git"));
  assert.ok((await t.spawnAgent(req({ id: "t2", cwd: CODE, gitInit: true }))).ok);
  assert.ok((await t.spawnAgent(req({ id: "t3", cwd: HOME, gitInit: false, place: "home" }))).ok);
  assert.deepEqual(git, [CODE], "not again where .git is, nor when not asked");
  t.killAll();
});

test("spawnAgent: what main cannot vouch for falls back with a one-line reason, and nothing starts or registers", async () => {
  const cases: Array<{ name: string; o: Parameters<typeof service>[0]; reason: RegExp }> = [
    { name: "the runtime's reason: no binary", o: { bin: { reason: "the runtime found no Claude Code binary: run aos doctor" } }, reason: /^the runtime found no Claude Code binary: run aos doctor$/ },
    { name: "the runtime's reason: no answer", o: { bin: { reason: "the runtime didn't answer" } }, reason: /^the runtime didn't answer$/ },
    { name: "the runtime's reason: too old", o: { bin: { reason: "the runtime is older than this app: run aos upgrade" } }, reason: /^the runtime is older than this app: run aos upgrade$/ },
    { name: "an unsigned native binary", o: { sys: sysOf(null) }, reason: new RegExp(`^Claude Code at ${CLAUDE.replace(/[/.]/g, "\\$&")} isn't a supported install: `) },
    { name: "another vendor's signature", o: { sys: sysOf(VENDOR.codex.team) }, reason: /isn't a supported install/ },
    { name: "no peer addon", o: { sys: null }, reason: /addon/ },
    { name: "no resolver", o: { resolveBin: false }, reason: /./ },
    { name: "a binary inside the vault", o: { bin: IN_VAULT }, reason: /inside the vault/ },
    { name: "a config folder main does not know", o: {}, reason: /CLAUDE_CONFIG_DIR/ },
  ];
  for (const c of cases) {
    const { t, spawned, registry, events } = service(c.o);
    const r = await t.spawnAgent(req(c.name.startsWith("a config") ? { configDir: path.join(HOME, "other-claude") } : {}));
    assert.equal(r.ok, false, c.name);
    assert.equal(!r.ok && r.code, "fallback", c.name);
    assert.match(!r.ok ? r.error : "", c.reason, c.name);
    assert.ok(!r.ok && !r.error.includes("\n"), `${c.name}: one line`);
    assert.equal(spawned.length, 0, `${c.name}: nothing started`);
    assert.equal(registry.get(7001), undefined);
    assert.deepEqual(events, []);
  }
});

test("spawnAgent: a refused argv or folder, a taken id and no node-pty are errors, not fallbacks", async () => {
  const { t, spawned, asked } = service();
  const bad = await t.spawnAgent(req({ argv: ["--dangerously-skip-permissions"] }));
  assert.equal(!bad.ok && bad.code, "EROFS");
  const gone = await t.spawnAgent(req({ cwd: path.join(ROOT, "nope") }));
  assert.equal(!gone.ok && gone.code, "EROFS");
  const file = await t.spawnAgent(req({ cwd: CLAUDE }));
  assert.equal(!file.ok && file.code, "EROFS");
  assert.deepEqual([spawned.length, asked.length], [0, 0], "refused before the runtime is asked");
  assert.ok((await t.spawnAgent(req())).ok);
  const taken = await t.spawnAgent(req());
  assert.equal(!taken.ok && taken.code, "EEXIST");
  // A shell terminal and an agent share the ids and the cap.
  assert.equal(t.spawn({ id: "t1", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 80, rows: 24 }).ok, false);
  t.killAll();
  const none = new PtyService({ context, env: {}, emit: () => {}, load: () => { throw new Error("Cannot find module 'node-pty'"); }, resolveBin: async () => ({ bin: CLAUDE }), registry: new AgentRegistry(), sys: sysOf(VENDOR.claude.team), computerOn: () => true });
  const r = await none.spawnAgent(req());
  assert.equal(!r.ok && r.code, "ENOSYS");
});

test("spawnAgent: a CLI the test build trusts by its real path runs without a signature (agent-computer D18)", async () => {
  const plain = service({ sys: sysOf(null) });
  assert.equal((await plain.t.spawnAgent(req())).ok, false, "unsigned and not trusted: falls back");
  const trusted = service({ sys: sysOf(null), extra: { trusted: [fs.realpathSync(CLAUDE)] } });
  const r = await trusted.t.spawnAgent(req());
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(trusted.registry.get(r.data.pid)?.key, "code:t1");
});

test("spawnAgent: the agent's exit, its terminal closing, or its page going tells onAgentGone once, with its ref (agent-computer D31)", async () => {
  const gone: AgentRef[] = [];
  const { t, spawned } = service({ extra: { onAgentGone: (a) => gone.push(a) } });
  assert.ok((await t.spawnAgent(req({ id: "t1" }))).ok);
  assert.ok((await t.spawnAgent(req({ id: "t2", place: "ws:harbor-map" }))).ok);
  assert.ok((await t.spawnAgent(req({ id: "t3" }))).ok);
  spawned[0].p.exit(0);
  assert.deepEqual(gone.map((a) => [a.key, a.pid, a.place]), [["code:t1", spawned[0].p.pid, "vault"]]);
  t.kill("t2");
  assert.deepEqual(gone.map((a) => a.key), ["code:t1", "code:t2"]);
  spawned[1].p.exit(0);
  assert.equal(gone.length, 2, "the late exit of a terminal already closed says nothing again");
  t.killAll();
  assert.deepEqual(gone.map((a) => a.key), ["code:t1", "code:t2", "code:t3"]);
});

// ── C1 (R65): the computer off, launches are typed; on, the agent gets the login shell's environment ──

test("spawnAgent: with the computer surface off, a Code launch falls back with no reason before anything is checked or resolved (C1, R65a)", async () => {
  const looked: string[] = [];
  const spy: Sys = {
    procInfo: () => { looked.push("procInfo"); return null; },
    teamId: () => { looked.push("teamId"); return VENDOR.claude.team; },
    processTeamId: () => { looked.push("processTeamId"); return null; },
    realpath: (p) => { looked.push("realpath"); return fs.realpathSync(p); },
    stat: (p) => fs.statSync(p),
  };
  let shells = 0;
  const { t, spawned, registry, asked, events } = service({ sys: spy, extra: { computerOn: () => false, shellEnv: async () => { shells++; return {}; } } });
  // Even words main would refuse: the page types the line it built, as it always did.
  for (const r of [req(), req({ id: "t2", argv: ["--dangerously-skip-permissions"] })]) {
    assert.deepEqual(await t.spawnAgent(r), { ok: false, error: "", code: "fallback" });
  }
  assert.deepEqual([spawned.length, asked.length, looked, shells, events], [0, 0, [], 0, []], "nothing resolved, no signature or install check, no shell asked");
  assert.equal(registry.get(7001), undefined);
  // Absent, the switch is off.
  const bare = new PtyService({ context, env: {}, emit: () => {}, load: () => fakePty().lib, resolveBin: async () => ({ bin: CLAUDE }), registry: new AgentRegistry(), sys: sysOf(VENDOR.claude.team) });
  assert.deepEqual(await bare.spawnAgent(req()), { ok: false, error: "", code: "fallback" });
});

const shellContext = (): ProgramContext => ({ ...context(), env: { SHELL: "/bin/sh" } });

test("spawnAgent: with it on, the agent starts from what the login shell gives a typed command, without CLAUDECODE (C1, R65b)", async () => {
  const calls: Array<{ shell: string; cwd: string; base: NodeJS.ProcessEnv }> = [];
  const { t, spawned, registry } = service({
    extra: {
      context: shellContext,
      shellEnv: async (shell, cwd, base) => {
        calls.push({ shell, cwd, base });
        return { PATH: "/rc/bin:/usr/bin", HOME, ANTHROPIC_BASE_URL: "https://llm.example.com", HTTPS_PROXY: "http://proxy.example.com:3128", CLAUDECODE: "1", TERM: "dumb" };
      },
    },
  });
  const r = await t.spawnAgent(req({ configDir: path.join(HOME, ".claude") }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].shell, calls[0].cwd], ["/bin/sh", VAULT], "main's $SHELL, in the launch's folder");
  assert.deepEqual([calls[0].base.PATH, calls[0].base.TERM, calls[0].base.AGENTIC_OS], ["/usr/bin:/bin", "xterm-256color", "1"], "started from the terminal's own environment");
  const env = spawned[0].opts.env as Record<string, string>;
  assert.deepEqual([env.PATH, env.ANTHROPIC_BASE_URL, env.HTTPS_PROXY], ["/rc/bin:/usr/bin", "https://llm.example.com", "http://proxy.example.com:3128"]);
  assert.equal(env.CLAUDECODE, undefined);
  assert.deepEqual([env.TERM, env.COLORTERM, env.CLAUDE_CONFIG_DIR], ["xterm-256color", "truecolor", path.join(HOME, ".claude")], "main's variables still win");
  assert.equal(spawned[0].file, CLAUDE, "the binary main judged, as the terminal's own process");
  assert.equal(registry.get(spawned[0].p.pid)?.key, "code:t1");
});

test("spawnAgent (code-chat R64): the login shell starts without the launching session's markers, and a CLAUDE_CODE_* its rc files export reaches the agent", async () => {
  const calls: NodeJS.ProcessEnv[] = [];
  const { t, spawned } = service({
    extra: {
      context: shellContext,
      // main's own environment, as an app started from a Claude Code session's shell has it
      env: () => terminalBaseEnv({ PATH: "/usr/bin:/bin", HOME, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: "4242", CODEX_THREAD_ID: "019a-thread" }, null),
      shellEnv: async (_shell, _cwd, base) => {
        calls.push(base);
        return { ...base, CLAUDE_CODE_USE_BEDROCK: "1", CLAUDECODE: "1" };
      },
    },
  });
  const r = await t.spawnAgent(req());
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([calls[0].CLAUDECODE, calls[0].CLAUDE_CODE_ENTRYPOINT, calls[0].CLAUDE_PID, calls[0].CODEX_THREAD_ID], [undefined, undefined, undefined, undefined], "the shell never sees the launching session's markers");
  const env = spawned[0].opts.env as Record<string, string>;
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1", "the user's own rc export reaches the agent, as it reaches a typed launch");
  assert.deepEqual([env.CLAUDECODE, env.CLAUDE_CODE_ENTRYPOINT, env.CODEX_THREAD_ID], [undefined, undefined, undefined]);
});

test("spawnAgent: a login shell that gives no environment, or none to ask, falls back and nothing starts (C1, fails closed)", async () => {
  const cases: Array<{ name: string; ctx: () => ProgramContext; env: NodeJS.ProcessEnv | null; reason: RegExp }> = [
    { name: "a startup file that exits, hangs or execs something else", ctx: shellContext, env: null, reason: /^\/bin\/sh gave no environment/ },
    { name: "no $SHELL", ctx: context, env: {}, reason: /\$SHELL is not set/ },
    { name: "a $SHELL that is no listed shell", ctx: () => ({ ...context(), env: { SHELL: "bin/zsh" } }), env: {}, reason: /^the login shell's environment could not be read: bin\/zsh is not in \/etc\/shells$/ },
  ];
  for (const c of cases) {
    const { t, spawned, registry } = service({ extra: { context: c.ctx, shellEnv: async () => c.env } });
    const r = await t.spawnAgent(req());
    assert.equal(!r.ok && r.code, "fallback", c.name);
    assert.match(!r.ok ? r.error : "", c.reason, c.name);
    assert.equal(spawned.length, 0, c.name);
    assert.equal(registry.get(7001), undefined, c.name);
  }
});

// ── R70: Codex's shared background server ───────────────────────────

test("R70: the --no-daemon probe reads a CLI's --help once per binary (real path, mtime, size); a failed or timed-out probe is not listed and is asked again", async () => {
  const calls: string[] = [];
  let out: string | null = "Usage: codex [OPTIONS]\n      --no-daemon\n          Run without the shared background server, even if it is already running\n";
  let st = { mtimeMs: 1, size: 10 };
  let real = "/opt/codex-real";
  const probe = new FlagProbe("--no-daemon", { realpath: () => real, stat: () => st, help: async (bin) => { calls.push(bin); return out; } });
  assert.equal(await probe.lists("/opt/codex"), true);
  assert.equal(await probe.lists("/opt/codex"), true);
  assert.deepEqual(calls, ["/opt/codex"], "cached");
  st = { mtimeMs: 2, size: 10 };
  out = "Usage: codex [OPTIONS]\n  -m, --model <MODEL>\n";
  assert.equal(await probe.lists("/opt/codex"), false, "an updated binary is asked again");
  st = { mtimeMs: 2, size: 11 };
  out = "      --no-daemon\n";
  assert.equal(await probe.lists("/opt/codex"), true, "a new size too");
  real = "/opt/other-codex";
  out = "  --no-daemon-ish\n  no-daemon\n";
  assert.equal(await probe.lists("/opt/codex"), false, "another real file is another binary; a longer flag or a bare word does not count");
  assert.equal(calls.length, 4);
  st = { mtimeMs: 3, size: 12 };
  out = null;
  assert.equal(await probe.lists("/opt/codex"), false, "a failed probe is not listed");
  assert.equal(await probe.lists("/opt/codex"), false);
  assert.equal(calls.length, 6, "and is not cached");
  const gone = new FlagProbe("--no-daemon", { realpath: () => { throw new Error("ENOENT"); }, stat: () => st, help: async () => { throw new Error("must not run"); } });
  assert.equal(await gone.lists("/opt/nothing"), false, "no binary: not listed, nothing run");
});

test("R70: cliHelp runs the binary's --help and answers its output, or null when it fails or outlasts the timeout", async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "help-"));
  const ok = path.join(dir, "ok");
  fs.writeFileSync(ok, '#!/bin/sh\n[ "$1" = "--help" ] && echo "      --no-daemon" && exit 0\nexit 9\n', { mode: 0o755 });
  const bad = path.join(dir, "bad");
  fs.writeFileSync(bad, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  const slow = path.join(dir, "slow");
  fs.writeFileSync(slow, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  assert.match((await cliHelp(ok)) ?? "", /--no-daemon/);
  assert.equal(await cliHelp(bad), null);
  const t0 = Date.now();
  assert.equal(await cliHelp(slow, { timeoutMs: 300 }), null);
  assert.ok(Date.now() - t0 < 3000, "cut off at the timeout");
  assert.equal(await cliHelp(path.join(dir, "missing")), null);
});

const CODEX_BIN = path.join(BIN, "codex");
fs.writeFileSync(CODEX_BIN, "#!/bin/sh\n", { mode: 0o755 });

test("R70: agentFlags says a Codex launch passes --no-daemon only with the surface on, a CLI main vouches for, and the flag in its help", async () => {
  const probed: string[] = [];
  const mk = (o: { on?: boolean; listed?: boolean; team?: string | null; bin?: string | { reason: string } }) => service({
    bin: o.bin ?? CODEX_BIN, sys: sysOf(o.team === undefined ? VENDOR.codex.team : o.team),
    extra: { computerOn: () => o.on ?? true, noDaemon: async (bin) => { probed.push(bin); return o.listed ?? true; } },
  });
  const on = mk({});
  assert.deepEqual(await on.t.agentFlags("codex"), { ok: true, data: { noDaemon: true, bin: CODEX_BIN } });
  assert.deepEqual(on.asked, ["codex"], "the binary the runtime resolves, as a launch's");
  assert.deepEqual(probed, [CODEX_BIN]);
  assert.deepEqual(await mk({ listed: false }).t.agentFlags("codex"), { ok: true, data: { noDaemon: false, bin: CODEX_BIN } });
  probed.length = 0;
  const off = mk({ on: false });
  assert.deepEqual(await off.t.agentFlags("codex"), { ok: true, data: { noDaemon: false, bin: null } });
  assert.deepEqual([off.asked, probed], [[], []], "surface off: nothing resolved or run");
  const claude = mk({});
  assert.deepEqual(await claude.t.agentFlags("claude"), { ok: true, data: { noDaemon: false, bin: null } });
  assert.deepEqual([claude.asked, probed], [[], []], "Claude Code has no shared server to leave");
  assert.deepEqual(await mk({ team: null }).t.agentFlags("codex"), { ok: true, data: { noDaemon: false, bin: null } });
  assert.deepEqual(probed, [], "an install main cannot vouch for is never run for its help");
  assert.deepEqual(await mk({ bin: { reason: "no codex binary found" } }).t.agentFlags("codex"), { ok: true, data: { noDaemon: false, bin: null } });
  const noProbe = service({ bin: CODEX_BIN, sys: sysOf(VENDOR.codex.team) });
  assert.deepEqual(await noProbe.t.agentFlags("codex"), { ok: true, data: { noDaemon: false, bin: null } }, "no probe wired: as before");
});

// R77: an npm install's codex is a `#!/usr/bin/env node` script; an app opened from the Dock has launchd's PATH, where
// there is no node. The probe runs with the launch's environment (the terminal base environment, the login PATH).
const NODE_DIR = fs.mkdtempSync(path.join(ROOT, "login-path-"));
fs.symlinkSync(process.execPath, path.join(NODE_DIR, "node"));
const CODEX_PKG = path.join(ROOT, "lib", "node_modules", "@openai", "codex", "bin");
fs.mkdirSync(CODEX_PKG, { recursive: true });
fs.writeFileSync(path.join(CODEX_PKG, "codex.js"), `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "--help") console.log("Usage: codex [OPTIONS]\\n      --no-daemon\\n          Run without the shared background server");
else if (a[0] === "resume" && a[1] === "--help") console.log("Usage: codex resume [OPTIONS]\\n      --no-daemon");
else process.exit(2);
`, { mode: 0o755 });
const NPM_CODEX = path.join(BIN, "codex-npm");
fs.symlinkSync(path.join(CODEX_PKG, "codex.js"), NPM_CODEX);
/** Runs `fn` with main's own PATH as launchd gives it (no node on it), as an app opened from the Dock or Finder has. */
async function launchdPath<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  try { return await fn(); } finally { process.env.PATH = was; }
}

test("R77: cliHelp runs with the environment it is given: an env-node launcher whose node is only on that PATH answers its help", async () => {
  const loginEnv = { ...process.env, PATH: `${NODE_DIR}:/usr/bin:/bin` };
  await launchdPath(async () => {
    assert.equal(await cliHelp(NPM_CODEX), null, "with main's launchd PATH, /usr/bin/env finds no node");
    assert.match((await cliHelp(NPM_CODEX, { env: loginEnv })) ?? "", /--no-daemon/);
  });
});

test("R77: agentFlags probes an npm-form Codex with the terminal base environment (the login PATH resolveBin searches)", async () => {
  const probe = new FlagProbe("--no-daemon");
  const seen: (string | undefined)[] = [];
  const { t } = service({
    bin: NPM_CODEX, sys: sysOf(null),
    extra: { env: () => ({ PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME }), noDaemon: (bin, env) => { seen.push(env?.PATH); return probe.lists(bin, { env }); } },
  });
  const r = await launchdPath(() => t.agentFlags("codex"));
  assert.ok(r.ok);
  assert.equal(r.data.noDaemon, true, "the npm install's help was read and lists the flag");
  assert.deepEqual(seen, [`${NODE_DIR}:/usr/bin:/bin`]);
});

test("R77: --no-daemon needs both switches: the computer surface on and Settings ▸ Computer on", async () => {
  const probed: string[] = [];
  const mk = (surface: boolean, setting: boolean) => service({
    bin: CODEX_BIN, sys: sysOf(VENDOR.codex.team),
    extra: { computerOn: () => surface, computerEnabled: () => setting, noDaemon: async (bin) => { probed.push(bin); return true; } },
  });
  assert.deepEqual(await mk(true, true).t.agentFlags("codex"), { ok: true, data: { noDaemon: true, bin: CODEX_BIN } });
  probed.length = 0;
  for (const [surface, setting] of [[true, false], [false, true], [false, false]] as const) {
    const m = mk(surface, setting);
    assert.deepEqual(await m.t.agentFlags("codex"), { ok: true, data: { noDaemon: false, bin: null } }, `surface ${surface}, setting ${setting}`);
    assert.deepEqual([m.asked, probed], [[], []], "nothing resolved or run");
  }
});

test("R77: a resume line asks the resume subcommand's own help (`codex resume --help`), cached apart from the top level's", async () => {
  const calls: [string, string | undefined][] = [];
  const answers: Record<string, string> = { top: "      --no-daemon\n", resume: "Usage: codex resume [OPTIONS] [SESSION_ID]\n      --last\n" };
  const probe = new FlagProbe("--no-daemon", { realpath: (p) => p, stat: () => ({ mtimeMs: 1, size: 1 }), help: async (bin, o) => { calls.push([bin, o.sub]); return answers[o.sub ?? "top"]; } });
  assert.equal(await probe.lists("/opt/codex"), true);
  assert.equal(await probe.lists("/opt/codex", { sub: "resume" }), false, "the resume subcommand's help, which here lacks it");
  assert.equal(await probe.lists("/opt/codex", { sub: "resume" }), false);
  assert.equal(await probe.lists("/opt/codex"), true);
  assert.deepEqual(calls, [["/opt/codex", undefined], ["/opt/codex", "resume"]], "each asked once, cached apart");
  // cliHelp runs `<bin> resume --help` for it.
  const loginEnv = { ...process.env, PATH: `${NODE_DIR}:/usr/bin:/bin` };
  assert.match((await cliHelp(NPM_CODEX, { env: loginEnv, sub: "resume" })) ?? "", /^Usage: codex resume/);
  // agentFlags asks the subcommand a resume line uses.
  const subs: (string | undefined)[] = [];
  const { t } = service({ bin: CODEX_BIN, sys: sysOf(VENDOR.codex.team), extra: { noDaemon: async (_bin, _env, sub) => { subs.push(sub); return sub !== "resume"; } } });
  assert.deepEqual(await t.agentFlags("codex"), { ok: true, data: { noDaemon: true, bin: CODEX_BIN } });
  assert.deepEqual(await t.agentFlags("codex", "resume"), { ok: true, data: { noDaemon: false, bin: CODEX_BIN } });
  assert.deepEqual(subs, [undefined, "resume"]);
});

test("R77: concurrent asks of one binary share one probe; nothing is resolved or probed while Codex is not an enabled host", async () => {
  let runs = 0;
  let answer!: (v: string) => void;
  const probe = new FlagProbe("--no-daemon", { realpath: (p) => p, stat: () => ({ mtimeMs: 1, size: 1 }), help: () => { runs++; return new Promise<string>((r) => { answer = r; }); } });
  const both = Promise.all([probe.lists("/opt/codex"), probe.lists("/opt/codex"), probe.lists("/opt/codex")]);
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1, "one probe in flight for the key");
  answer("      --no-daemon\n");
  assert.deepEqual(await both, [true, true, true]);
  assert.equal(await probe.lists("/opt/codex"), true);
  assert.equal(runs, 1, "and cached after it");
  // A failed probe is not shared with later asks: they ask again.
  let fails = 0;
  const flaky = new FlagProbe("--no-daemon", { realpath: (p) => p, stat: () => ({ mtimeMs: 1, size: 1 }), help: async () => { fails++; return null; } });
  assert.deepEqual(await Promise.all([flaky.lists("/x"), flaky.lists("/x")]), [false, false]);
  assert.equal(fails, 1);
  assert.equal(await flaky.lists("/x"), false);
  assert.equal(fails, 2);

  const probed: string[] = [];
  const off = service({ bin: CODEX_BIN, sys: sysOf(VENDOR.codex.team), extra: { hostOn: (h) => h !== "codex", noDaemon: async (bin) => { probed.push(bin); return true; } } });
  assert.deepEqual(await off.t.agentFlags("codex"), { ok: true, data: { noDaemon: false, bin: null } });
  assert.deepEqual([off.asked, probed], [[], []], "a Claude-only Mac resolves and runs nothing");
  const on = service({ bin: CODEX_BIN, sys: sysOf(VENDOR.codex.team), extra: { hostOn: () => true, noDaemon: async (bin) => { probed.push(bin); return true; } } });
  assert.deepEqual(await on.t.agentFlags("codex"), { ok: true, data: { noDaemon: true, bin: CODEX_BIN } });
});

test("R77: agentFlags names the binary it probed, so the page types the flag only for that binary", async () => {
  const { t } = service({ bin: CODEX_BIN, sys: sysOf(VENDOR.codex.team), extra: { noDaemon: async () => true } });
  assert.deepEqual(await t.agentFlags("codex"), { ok: true, data: { noDaemon: true, bin: CODEX_BIN } });
  const off = service({ bin: CODEX_BIN, sys: sysOf(VENDOR.codex.team), extra: { computerOn: () => false, noDaemon: async () => true } });
  assert.deepEqual(await off.t.agentFlags("codex"), { ok: true, data: { noDaemon: false, bin: null } }, "nothing probed: no binary named");
});

test("R79: spawnAgent decides --no-daemon itself: an argv that disagrees with main's answer now is refused with that answer; one that agrees starts", async () => {
  const subs: (string | undefined)[] = [];
  let listed = true, setting = true, codexOn = true;
  const { t, spawned } = service({
    bin: CODEX_BIN, sys: sysOf(VENDOR.codex.team),
    extra: { computerEnabled: () => setting, hostOn: (h) => h !== "codex" || codexOn, noDaemon: async (_b, _e, sub) => { subs.push(sub); return listed; } },
  });
  const codex = (argv: string[]) => req({ host: "codex", argv, access: "host", label: "Codex in Vault" });
  const without = ["-m", "gpt-6-luna"], withIt = ["--no-daemon", "-m", "gpt-6-luna"];
  assert.deepEqual(await t.spawnAgent(codex(without)), { ok: false, code: "flags", error: "this Codex launch needs --no-daemon now: the page builds it again", flags: { noDaemon: true, bin: CODEX_BIN } });
  assert.equal(spawned.length, 0, "nothing started");
  const ok = await t.spawnAgent(codex(withIt));
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(spawned.map((x) => x.args), [withIt]);
  // Settings ▸ Computer turned off, Codex turned off, or the help no longer listing it: the answer is no.
  for (const flip of [() => { setting = false; }, () => { setting = true; codexOn = false; }, () => { codexOn = true; listed = false; }]) {
    flip();
    const r = await t.spawnAgent({ ...codex(withIt), id: "t11" });
    assert.deepEqual(r, { ok: false, code: "flags", error: "this Codex launch must go without --no-daemon now: the page builds it again", flags: { noDaemon: false, bin: CODEX_BIN } });
  }
  assert.equal(spawned.length, 1);
  // A resume line is judged by `codex resume --help`.
  listed = true;
  subs.length = 0;
  const resumed = await t.spawnAgent({ ...codex(["resume", "--last"]), id: "t20" });
  assert.equal(resumed.ok, false);
  assert.deepEqual(subs, ["resume"]);
  // Claude Code is never judged by it (this stand-in resolves the Codex binary, so its own launch falls back).
  const claude = await t.spawnAgent(req({ id: "t21" }));
  assert.notEqual(!claude.ok && claude.code, "flags");
  assert.deepEqual(subs, ["resume"]);
});

test("R70: spawnAgent runs a Codex line with --no-daemon exactly as the page sent it", async () => {
  const { t, spawned } = service({ bin: CODEX_BIN, sys: sysOf(VENDOR.codex.team), extra: { noDaemon: async () => true } });
  const argv = ["--no-daemon", "-m", "gpt-6-luna"];
  const r = await t.spawnAgent(req({ host: "codex", argv, access: "host", label: "Codex in Vault" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([spawned[0].file, spawned[0].args], [CODEX_BIN, argv]);
});

test("R81: spawnAgent checks --no-daemon again right before the spawn: Settings ▸ Computer flipped during agentBase() or git init gives the flags refusal, and nothing starts", async () => {
  const codex = (argv: string[], over: Partial<PtyAgentRequest> = {}) => req({ host: "codex", argv, access: "host", label: "Codex in Vault", ...over });
  const withIt = ["--no-daemon", "-m", "gpt-6-luna"], without = ["-m", "gpt-6-luna"];
  const mk = (setting: { on: boolean }, hooks: Partial<PtyServiceOptions>) => service({
    bin: CODEX_BIN, sys: sysOf(VENDOR.codex.team),
    extra: { context: shellContext, computerEnabled: () => setting.on, noDaemon: async () => true, shellEnv: async () => ({ PATH: "/usr/bin:/bin", HOME }), ...hooks },
  });
  // Turned off while the login shell's environment is read: the line carries a flag main would no longer add.
  const off = { on: true };
  const a = mk(off, { shellEnv: async () => { off.on = false; return { PATH: "/usr/bin:/bin", HOME }; } });
  assert.deepEqual(await a.t.spawnAgent(codex(withIt)), { ok: false, code: "flags", error: "this Codex launch must go without --no-daemon now: the page builds it again", flags: { noDaemon: false, bin: CODEX_BIN } });
  assert.deepEqual([a.spawned.length, a.t.open], [0, 0], "nothing spawned or opened");
  // Turned on while it is read: the line now needs the flag.
  const on = { on: false };
  const b = mk(on, { shellEnv: async () => { on.on = true; return { PATH: "/usr/bin:/bin", HOME }; } });
  assert.deepEqual(await b.t.spawnAgent(codex(without)), { ok: false, code: "flags", error: "this Codex launch needs --no-daemon now: the page builds it again", flags: { noDaemon: true, bin: CODEX_BIN } });
  assert.equal(b.spawned.length, 0);
  // Turned off during git init, the last await before the spawn.
  const git = { on: true };
  const c = mk(git, { gitInit: async () => { git.on = false; } });
  const fresh = fs.mkdtempSync(path.join(ROOT, "no-git-"));
  assert.deepEqual(await c.t.spawnAgent(codex(withIt, { cwd: fresh, gitInit: true })), { ok: false, code: "flags", error: "this Codex launch must go without --no-daemon now: the page builds it again", flags: { noDaemon: false, bin: CODEX_BIN } });
  assert.equal(c.spawned.length, 0);
  // Nothing flipped: it starts as before.
  const steady = mk({ on: true }, {});
  const r = await steady.t.spawnAgent(codex(withIt));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(steady.spawned.map((x) => x.args), [withIt]);
});

// ── code-chat R16, R22: a terminal's Code chat follower ends with the terminal, not with its agent ──

test("code-chat R22: an agent's own exit keeps its terminal's follower; closing the terminal through the login shell's pty, or killAll, ends it", async () => {
  const KEY = "aaaaaaaa-0000-4000-8000-000000000001";
  const KEY2 = "bbbbbbbb-0000-4000-8000-000000000002";
  const mirrorVault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-agent-mirror-"));
  fs.mkdirSync(path.join(mirrorVault, "brain", "scripts", "lib"), { recursive: true });
  for (const n of ["sessions.js", "code-mirror.js"]) fs.writeFileSync(path.join(mirrorVault, "brain", "scripts", "lib", n), "// stand-in\n");
  class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: string[] = [];
    stderr = new EventEmitter();
    kill(sig: string): boolean { this.signals.push(sig); this.signalCode = sig as NodeJS.Signals; queueMicrotask(() => this.emit("exit", null, sig)); return true; }
  }
  const children: FakeChild[] = [];
  const ended: Array<[string, string | null]> = [];
  let mirror: CodeMirrorService | null = null;
  const { t, spawned } = service({ extra: { onEnd: (id, terminal) => { ended.push([id, terminal]); mirror?.end(id, terminal); } } });
  mirror = new CodeMirrorService({
    vaultRoot: () => mirrorVault, enabled: () => true, context: () => ({ ...context(), vaultRoot: mirrorVault }), env: {}, node: () => process.execPath,
    ptyInfo: (id) => t.info(id), spawnImpl: (() => { const c = new FakeChild(); children.push(c); return c; }) as unknown as typeof childProcess.spawn,
  });
  assert.ok((await t.spawnAgent(req({ id: "t1", terminal: KEY }))).ok);
  assert.equal((spawned[0].opts.env as Record<string, string>).AOS_TERMINAL, KEY);
  assert.equal(t.info("t1")?.terminal, KEY, "main records the key the agent started with");
  assert.ok(mirror.follow({ pty: "t1", host: "claude", terminal: KEY }).ok);
  spawned[0].p.exit(0);
  assert.deepEqual(children[0].signals, [], "the agent exited: the follower stays for the login shell that takes over");
  assert.deepEqual([...ended], []);
  assert.equal(mirror.running, 1);
  // The page's takeover shell: a new pty in the same terminal, carrying its key. Closing the terminal kills that pty.
  assert.ok(t.spawn({ id: "t2", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 120, rows: 40, env: { AOS_TERMINAL: KEY } }).ok);
  t.kill("t2");
  assert.deepEqual([...ended], [["t2", KEY]]);
  assert.deepEqual(children[0].signals, ["SIGTERM"], "the terminal closed: its follower ends");
  assert.equal(mirror.running, 0);
  assert.ok((await t.spawnAgent(req({ id: "t3", terminal: KEY2 }))).ok);
  assert.ok(mirror.follow({ pty: "t3", host: "claude", terminal: KEY2 }).ok);
  t.killAll();
  assert.deepEqual(children[1].signals, ["SIGTERM"], "every terminal ends with the page");
  assert.equal(mirror.running, 0);
  assert.ok(ended.some(([id, key]) => id === "t3" && key === KEY2));
});

test("a takeover shell's own id is not a session key", async () => {
  const KEY = "aaaaaaaa-0000-4000-8000-000000000012";
  const { t, spawned } = service({});
  assert.ok((await t.spawnAgent(req({ id: "t1", terminal: KEY }))).ok);
  assert.ok(t.spawn({ id: "t2", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 120, rows: 40, env: { AOS_TERMINAL: KEY }, origin: "t1" }).ok);
  assert.equal(t.holdsOrigin("t1"), true);
  assert.equal(t.holdsOrigin("t2"), false);
  assert.equal(t.holds("t2"), true);
  spawned[0].p.exit(0);
  assert.equal(t.holdsOrigin("t1"), true, "still the terminal's key after its first process exited");
  t.kill("t2");
  spawned[1].p.exit(0);
  assert.equal(t.holdsOrigin("t1"), false);
  assert.equal(t.holdsOrigin("t2"), false);
  assert.equal(t.holds("t2"), false);
});

test("a terminal's origin is always the first process of its chain, even when the page names a takeover shell", async () => {
  const KEY = "aaaaaaaa-0000-4000-8000-000000000013";
  const { t } = service({});
  assert.ok((await t.spawnAgent(req({ id: "t1", terminal: KEY }))).ok);
  assert.ok(t.spawn({ id: "t2", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 120, rows: 40, env: { AOS_TERMINAL: KEY }, origin: "t1" }).ok);
  // A page that names the takeover shell as the origin of a third process gets the chain's root, not t2.
  assert.ok(t.spawn({ id: "t3", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 120, rows: 40, env: { AOS_TERMINAL: KEY }, origin: "t2" }).ok);
  assert.equal(t.holdsOrigin("t2"), false, "a takeover shell's id never becomes a session key");
  assert.equal(t.holdsOrigin("t1"), true);
});

test("kill reports closed and killAll reports all; a takeover shell's close reports its terminal's origin", async () => {
  const KEY = "aaaaaaaa-0000-4000-8000-000000000011";
  const ended: Array<[string, string | null, string, string]> = [];
  const { t, spawned } = service({ extra: { onEnd: (id, terminal, why, origin) => { ended.push([id, terminal, why, origin]); } } });
  assert.ok((await t.spawnAgent(req({ id: "t1", terminal: KEY }))).ok);
  // The agent exits and the login shell takes over: a new pty that names the terminal's first process.
  assert.ok(t.spawn({ id: "t2", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 120, rows: 40, env: { AOS_TERMINAL: KEY }, origin: "t1" }).ok);
  t.kill("t2");
  assert.deepEqual(ended[0], ["t2", KEY, "closed", "t1"], "the shell's close reports its terminal's first process");
  assert.equal(spawned[0].p.killed.length, 1, "the origin's own process is ended with its terminal");
  spawned[0].p.exit(0);
  spawned[1].p.exit(0);
  assert.equal(t.holds("t1"), false, "the origin is not held after its terminal closed");
  assert.equal(t.holds("t2"), false);
  // A spawn that names an origin main never began is its own origin.
  assert.ok(t.spawn({ id: "t5", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 120, rows: 40, origin: "t77" }).ok);
  ended.length = 0;
  t.kill("t5");
  assert.deepEqual(ended[0], ["t5", null, "closed", "t5"]);
  spawned[2].p.exit(0);
  assert.ok(t.spawn({ id: "t6", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 120, rows: 40 }).ok);
  ended.length = 0;
  t.killAll();
  assert.deepEqual(ended.map((e) => [e[0], e[2]]), [["t6", "all"]]);
});
