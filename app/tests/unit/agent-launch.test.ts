// A Code launch as main runs it (agent-computer D18, D30): the agent's CLI is the terminal's own process, started from
// the binary the runtime resolves, only when its install form can be vouched for, with only the flags the Code page's
// launch line carries; while it runs it is in the registry the bridge admits from. Anything main cannot vouch for falls
// back to the typed launch line in a shell (the HUD's), and never blocks the launch.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PtyEvent } from "../../src/shared/ipc";
import type { ProgramContext } from "../../src/main/policy/programs";
import { agentArgvRefusal } from "../../src/main/policy/agent-launch";
import { PtyService, type PtyAgentRequest, type PtyLib, type PtyProcess } from "../../src/main/services/pty";
import { AgentRegistry } from "../../src/main/computer/registry";
import { VENDOR, type Sys } from "../../src/main/computer/admission";
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
    }
  }
  for (const s of specs) {
    const argv = launchArgs(s);
    assert.equal(agentArgvRefusal(s.host, argv), null, `${s.host} ${JSON.stringify(argv)}`);
  }
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

function service(o: { bin?: string | { reason: string }; sys?: Sys | null; git?: string[]; registry?: AgentRegistry; resolveBin?: boolean } = {}) {
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
    context, env: { PATH: "/usr/bin" }, emit: () => {}, load: () => lib, registry, sys: sysOf(VENDOR.claude.team),
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
  const none = new PtyService({ context, env: {}, emit: () => {}, load: () => { throw new Error("Cannot find module 'node-pty'"); }, resolveBin: async () => ({ bin: CLAUDE }), registry: new AgentRegistry(), sys: sysOf(VENDOR.claude.team) });
  const r = await none.spawnAgent(req());
  assert.equal(!r.ok && r.code, "ENOSYS");
});
