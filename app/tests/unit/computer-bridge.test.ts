import { test, afterEach } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { BridgeKeeper, ComputerBridge, MAX_PATH_BYTES, bridgeSocketPath, type ToolCall, type ToolReply } from "../../src/main/computer/bridge";
import type { Admit } from "../../src/main/computer/admission";
import type { AgentRef } from "../../src/main/computer/registry";
import type { PeerAddon } from "../../src/main/computer/peer";

// agent-computer D18/D26: the bridge socket, over a real temp socket with a fake admit and a fake peer.

const AGENT: AgentRef = { pid: 4242, host: "claude", page: "code", key: "code:t1", label: "Code 1", place: "~/proj", access: "read" };
const peer: PeerAddon = { peerPid: () => 4242, procInfo: () => null, teamId: () => null, processTeamId: () => null };

/** The names the bridge accepts, in the order it lists them to a client (session-browser S16, Task 20). */
const THIRTEEN = [
  "computer_status", "computer_open", "computer_snapshot", "computer_screenshot", "computer_click", "computer_type", "computer_key",
  "computer_scroll", "computer_wait", "computer_tab", "computer_nav", "computer_hover", "computer_console",
];

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tmpSock(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aos-br-"));
  made.push(d);
  return path.join(d, "computer", "bridge.sock");
}

interface Opts { peer?: PeerAddon; helloMs?: number; admit?: (pid: number) => Admit; handle?: (a: AgentRef, c: ToolCall) => Promise<Omit<ToolReply, "id">>; onClose?: (a: AgentRef) => void; live?: (a: AgentRef) => boolean }
async function boot(o: Opts = {}) {
  const socketPath = tmpSock();
  const calls: Array<{ agent: AgentRef; call: ToolCall }> = [];
  const bridge = new ComputerBridge({
    socketPath, peer: o.peer ?? peer, helloMs: o.helloMs,
    admit: o.admit ?? (() => ({ ok: true, agent: AGENT })),
    handle: o.handle ?? (async (agent, call) => { calls.push({ agent, call }); return { text: `done ${call.tool}` }; }),
    onClose: o.onClose ?? (() => {}),
    ...(o.live ? { live: o.live } : {}),
  });
  await bridge.start();
  return { bridge, socketPath, calls };
}

/** A client that collects JSON lines and tells when the server closed it. */
function client(socketPath: string) {
  const sock = net.connect(socketPath);
  const lines: any[] = [];
  let buf = "";
  const waiters: Array<() => void> = [];
  let closed = false;
  sock.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    waiters.splice(0).forEach((w) => w());
  });
  sock.on("error", () => {});
  sock.on("close", () => { closed = true; waiters.splice(0).forEach((w) => w()); });
  const until = (pred: () => boolean) => new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), 3000);
    const check = () => { if (pred()) { clearTimeout(t); res(); } else waiters.push(check); };
    check();
  });
  return {
    sock, lines,
    send: (o: unknown) => sock.write(`${JSON.stringify(o)}\n`),
    line: async (n: number) => { await until(() => lines.length >= n); return lines[n - 1]; },
    closed: () => until(() => closed),
  };
}

test("an admitted hello, then a call routed with its AgentRef", async () => {
  const { bridge, socketPath, calls } = await boot();
  const c = client(socketPath);
  c.send({ hello: 1 });
  assert.deepEqual(await c.line(1), { admitted: true, session: "Code 1", tools: THIRTEEN });
  c.send({ id: 1, tool: "computer_status", args: {} });
  assert.deepEqual(await c.line(2), { id: 1, text: "done computer_status" });
  assert.equal(calls[0]!.agent, AGENT);
  c.sock.destroy();
  await bridge.stop();
});

test("a refused hello gets the reason and the socket closes", async () => {
  const { bridge, socketPath } = await boot({ admit: () => ({ ok: false, reason: "Not started by UniDeX." }) });
  const c = client(socketPath);
  c.send({ hello: 1 });
  assert.deepEqual(await c.line(1), { admitted: false, reason: "Not started by UniDeX." });
  await c.closed();
  await bridge.stop();
});

test("a 2 MiB line closes the connection and onClose fires for an admitted agent", async () => {
  const closedAgents: AgentRef[] = [];
  const { bridge, socketPath } = await boot({ onClose: (a) => closedAgents.push(a) });
  const c = client(socketPath);
  c.send({ hello: 1 });
  await c.line(1);
  c.sock.write("x".repeat(2 * 1024 * 1024));
  await c.closed();
  assert.deepEqual(closedAgents, [AGENT]);
  await bridge.stop();
});

test("overlapping calls are answered by id", async () => {
  const gates = new Map<number, () => void>();
  const { bridge, socketPath } = await boot({
    handle: (_a, call) => new Promise((res) => gates.set(call.id, () => res({ text: `r${call.id}` }))),
  });
  const c = client(socketPath);
  c.send({ hello: 1 });
  await c.line(1);
  c.send({ id: 1, tool: "computer_wait", args: {} });
  c.send({ id: 2, tool: "computer_wait", args: {} });
  await new Promise((r) => setTimeout(r, 50));
  gates.get(2)!();
  assert.deepEqual(await c.line(2), { id: 2, text: "r2" });
  gates.get(1)!();
  assert.deepEqual(await c.line(3), { id: 1, text: "r1" });
  c.sock.destroy();
  await bridge.stop();
});

test("a handle that throws or rejects replies with an error, and the connection stays", async () => {
  const { bridge, socketPath } = await boot({ handle: async (_a, call) => { if (call.id === 1) throw new Error("boom"); return { text: "ok" }; } });
  const c = client(socketPath);
  c.send({ hello: 1 });
  await c.line(1);
  c.send({ id: 1, tool: "computer_click", args: {} });
  assert.deepEqual(await c.line(2), { id: 1, text: "The computer failed (boom): call computer_status to see whether the browser is still there.", isError: true });
  c.send({ id: 2, tool: "computer_click", args: {} });
  assert.deepEqual(await c.line(3), { id: 2, text: "ok" });
  c.sock.destroy();
  await bridge.stop();
});

test("malformed JSON, a missing id, an unknown tool, or a call before hello close the connection with no reply", async () => {
  const { bridge, socketPath } = await boot();
  for (const first of [false, true]) {
    for (const bad of ["{ not json\n", `${JSON.stringify({ tool: "computer_status", args: {} })}\n`, `${JSON.stringify({ id: 1, tool: "computer_bogus", args: {} })}\n`]) {
      const c = client(socketPath);
      if (first) { c.send({ hello: 1 }); await c.line(1); }
      c.sock.write(bad);
      await c.closed();
      assert.equal(c.lines.length, first ? 1 : 0);
    }
  }
  const pre = client(socketPath);
  pre.send({ id: 1, tool: "computer_status", args: {} });
  await pre.closed();
  assert.equal(pre.lines.length, 0);
  await bridge.stop();
});

test("one connection's failure does not touch another", async () => {
  const { bridge, socketPath } = await boot();
  const a = client(socketPath);
  a.send({ hello: 1 });
  await a.line(1);
  const b = client(socketPath);
  b.sock.write("garbage\n");
  await b.closed();
  a.send({ id: 7, tool: "computer_status", args: {} });
  assert.deepEqual(await a.line(2), { id: 7, text: "done computer_status" });
  a.sock.destroy();
  await bridge.stop();
});

test("the folder is 0700, the socket 0600, and a stale socket is replaced", async () => {
  const socketPath = tmpSock();
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o755 });
  // A real leftover: a process that listened and was killed leaves its socket file behind.
  spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, "SIGKILL"))`]);
  assert.ok(fs.lstatSync(socketPath).isSocket(), "the leftover is a socket");
  const bridge = new ComputerBridge({ socketPath, peer, admit: () => ({ ok: true, agent: AGENT }), handle: async () => ({ text: "" }), onClose: () => {} });
  await bridge.start();
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  assert.ok(fs.statSync(socketPath).isSocket());
  await bridge.stop();
  assert.equal(fs.existsSync(socketPath), false, "stop removes the socket");
});

test("a path over 103 bytes is refused", async () => {
  const socketPath = path.join(os.tmpdir(), "a".repeat(100), "bridge.sock");
  assert.ok(Buffer.byteLength(socketPath) > 103);
  const bridge = new ComputerBridge({ socketPath, peer, admit: () => ({ ok: true, agent: AGENT }), handle: async () => ({ text: "" }), onClose: () => {} });
  await assert.rejects(bridge.start(), /103/);
  assert.equal(fs.existsSync(path.dirname(socketPath)), false);
});

test("a regular file, a link or a folder at the path makes start() reject and is left alone", async () => {
  for (const make of [(p: string) => fs.writeFileSync(p, "mine"), (p: string) => fs.symlinkSync("/nonexistent", p), (p: string) => fs.mkdirSync(p)]) {
    const socketPath = tmpSock();
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    make(socketPath);
    const bridge = new ComputerBridge({ socketPath, peer, admit: () => ({ ok: true, agent: AGENT }), handle: async () => ({ text: "" }), onClose: () => {} });
    await assert.rejects(bridge.start(), /not a socket/);
    assert.ok(fs.lstatSync(socketPath));
  }
});

test("a line over 16 KiB of multibyte text reaches handle unchanged", async () => {
  const seen: string[] = [];
  const { bridge, socketPath } = await boot({ handle: async (_a, call) => { seen.push(String(call.args.t)); return { text: "ok" }; } });
  const c = client(socketPath);
  c.send({ hello: 1 });
  await c.line(1);
  const t = "é漢😀".repeat(8000);
  c.send({ id: 1, tool: "computer_type", args: { t } });
  await c.line(2);
  assert.equal(seen[0], t);
  c.sock.destroy();
  await bridge.stop();
});

test("admit or peerPid throwing is a refusal", async () => {
  for (const o of [{ admit: () => { throw new Error("x"); } }, { peer: { ...peer, peerPid: () => { throw new Error("y"); } } }]) {
    const { bridge, socketPath } = await boot(o);
    const c = client(socketPath);
    c.send({ hello: 1 });
    const r = await c.line(1);
    assert.equal(r.admitted, false);
    await c.closed();
    await bridge.stop();
  }
});

test("hello and a first call in one write: the admitted line, then the reply", async () => {
  const { bridge, socketPath } = await boot();
  const c = client(socketPath);
  c.sock.write(`${JSON.stringify({ hello: 1 })}\n${JSON.stringify({ id: 3, tool: "computer_status", args: {} })}\n`);
  assert.deepEqual(await c.line(1), { admitted: true, session: "Code 1", tools: THIRTEEN });
  assert.deepEqual(await c.line(2), { id: 3, text: "done computer_status" });
  c.sock.destroy();
  await bridge.stop();
});

test("a non-numeric id, or JSON that is not an object, closes the connection", async () => {
  const { bridge, socketPath } = await boot();
  for (const bad of [{ id: "1", tool: "computer_status", args: {} }, [], null]) {
    const c = client(socketPath);
    c.send({ hello: 1 });
    await c.line(1);
    c.send(bad);
    await c.closed();
  }
  await bridge.stop();
});

test("stop() with a call in flight writes nothing after the close", async () => {
  let release!: () => void;
  const { bridge, socketPath } = await boot({ handle: () => new Promise((res) => { release = () => res({ text: "late" }); }) });
  const c = client(socketPath);
  c.send({ hello: 1 });
  await c.line(1);
  c.send({ id: 1, tool: "computer_wait", args: {} });
  await new Promise((r) => setTimeout(r, 50));
  await bridge.stop();
  release();
  await c.closed();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.lines.length, 1);
});

test("a reply that cannot be serialised becomes an error reply", async () => {
  const { bridge, socketPath } = await boot({ handle: async () => ({ text: 1n as unknown as string }) });
  const c = client(socketPath);
  c.send({ hello: 1 });
  await c.line(1);
  c.send({ id: 1, tool: "computer_status", args: {} });
  const r = await c.line(2);
  assert.equal(r.isError, true);
  c.sock.destroy();
  await bridge.stop();
});

test("a connection that never says hello is closed after the deadline", async () => {
  const { bridge, socketPath } = await boot({ helloMs: 50 });
  const c = client(socketPath);
  await c.closed();
  await bridge.stop();
});

test("a fifth call in flight on one connection is answered at once and never reaches handle; a finished call frees a slot", async () => {
  const gates = new Map<number, () => void>();
  const seen: number[] = [];
  const { bridge, socketPath } = await boot({
    handle: (_a, call) => { seen.push(call.id); return new Promise((res) => gates.set(call.id, () => res({ text: `r${call.id}` }))); },
  });
  const c = client(socketPath);
  const other = client(socketPath);
  try {
    c.send({ hello: 1 });
    await c.line(1);
    for (let id = 1; id <= 5; id++) c.send({ id, tool: "computer_wait", args: {} });
    assert.deepEqual(await c.line(2), { id: 5, text: "Too many computer calls at once: wait for one to finish.", isError: true });
    assert.deepEqual(seen, [1, 2, 3, 4]);
    gates.get(2)!();
    assert.deepEqual(await c.line(3), { id: 2, text: "r2" });
    c.send({ id: 6, tool: "computer_wait", args: {} });
    for (let i = 0; i < 50 && !seen.includes(6); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, [1, 2, 3, 4, 6], "the freed slot takes the next call");
    // The cap is per connection.
    other.send({ hello: 1 });
    await other.line(1);
    other.send({ id: 1, tool: "computer_status", args: {} });
    for (let i = 0; i < 50 && seen.length < 6; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, 6, "another connection's call reaches handle");
  } finally {
    for (const g of gates.values()) g();
    c.sock.destroy();
    other.sock.destroy();
    await bridge.stop();
  }
});

test("a call that throws frees its slot", async () => {
  let n = 0;
  const { bridge, socketPath } = await boot({ handle: async () => { n++; throw new Error("boom"); } });
  const c = client(socketPath);
  try {
    c.send({ hello: 1 });
    await c.line(1);
    for (let id = 1; id <= 6; id++) {
      c.send({ id, tool: "computer_status", args: {} });
      const r = await c.line(id + 1);
      assert.equal(r.isError, true);
      assert.match(r.text, /boom/);
    }
    assert.equal(n, 6, "every call reached handle: none was held by a slot a thrown call kept");
  } finally {
    c.sock.destroy();
    await bridge.stop();
  }
});

test("BridgeKeeper: one bridge for the vault it should serve; the same vault keeps it, another replaces it, null stops it", async () => {
  const log: string[] = [];
  const k = new BridgeKeeper({
    make: async (root) => { log.push(`start ${root}`); return { stop: async () => { log.push(`stop ${root}`); } }; },
    log: (m) => log.push(`warn ${m}`),
  });
  await k.sync(null);
  assert.deepEqual(log, [], "the computer surface off (or no vault): nothing starts");
  void k.sync("/v/a");
  await k.sync("/v/a");
  assert.deepEqual(log, ["start /v/a"], "the same vault again keeps the running bridge (its CLIs cannot reconnect)");
  assert.equal(k.root, "/v/a");
  await k.sync("/v/b");
  assert.deepEqual(log, ["start /v/a", "stop /v/a", "start /v/b"]);
  await k.sync(null);
  assert.deepEqual(log.slice(3), ["stop /v/b"], "the surface turned off: the bridge stops");
  assert.equal(k.root, null);
  await k.sync("/v/b");
  assert.equal(log.at(-1), "start /v/b", "and turned on again: it starts");
});

test("BridgeKeeper: a bridge that fails to start is logged and leaves none running; the next sync tries again", async () => {
  const log: string[] = [];
  let fail = true;
  const k = new BridgeKeeper({
    make: async (root) => { if (fail) throw new Error("the socket path is too long"); log.push(`start ${root}`); return { stop: async () => {} }; },
    log: (m) => log.push(`warn ${m}`),
  });
  await k.sync("/v/a");
  assert.deepEqual(log, ["warn the computer bridge did not start: the socket path is too long"]);
  assert.equal(k.root, null);
  fail = false;
  await k.sync("/v/a");
  assert.equal(log.at(-1), "start /v/a");
});

test("the socket path: the data folder's own, else a short one of its own in the user's temp folder, else none (agent-computer D18)", () => {
  const tmp = "/var/folders/ab/cdefghijklmnopqrstuvwxyz0000gn/T";
  assert.equal(bridgeSocketPath("/Volumes/Data/Library/Application Support/UniDeX", tmp), "/Volumes/Data/Library/Application Support/UniDeX/computer/bridge.sock");
  const long = `/Volumes/${"s".repeat(40)}/Library/Application Support/AgenticOS Workbench`;
  assert.ok(Buffer.byteLength(path.join(long, "computer", "bridge.sock")) > MAX_PATH_BYTES);
  const short = bridgeSocketPath(long, tmp)!;
  assert.match(short, /^\/var\/folders\/ab\/cdefghijklmnopqrstuvwxyz0000gn\/T\/unidex-computer-[0-9a-f]{12}\/bridge\.sock$/);
  assert.ok(Buffer.byteLength(short) <= MAX_PATH_BYTES);
  assert.equal(bridgeSocketPath(long, tmp), short, "the same data folder, the same path");
  assert.notEqual(bridgeSocketPath(`${long}-2`, tmp), short, "another data folder (a dev run beside the app), another path");
  assert.equal(bridgeSocketPath(long, `/${"t".repeat(100)}`), null, "nothing short enough: the bridge does not start");
});

test("the temp-folder path listens like the default one, in a 0700 folder of this user's; a link there is refused", async () => {
  // The system temp folder itself, as the app passes it (a folder inside it would make the path too long again).
  const tmp = os.tmpdir();
  const data = fs.mkdtempSync(path.join(tmp, "aos-brt-"));
  made.push(data);
  const long = path.join(data, "x".repeat(110));
  const socketPath = bridgeSocketPath(long, tmp)!;
  assert.ok(socketPath, "a short path exists");
  assert.equal(path.dirname(path.dirname(socketPath)), tmp);
  made.push(path.dirname(socketPath));
  const bridge = new ComputerBridge({ socketPath, peer, admit: () => ({ ok: true, agent: AGENT }), handle: async () => ({ text: "" }), onClose: () => {} });
  await bridge.start();
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  await bridge.stop();
  // A link where the folder goes (someone else's folder, or anything): the bridge will not listen through it.
  const other = path.join(data, "elsewhere");
  fs.mkdirSync(other);
  fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  fs.symlinkSync(other, path.dirname(socketPath));
  const again = new ComputerBridge({ socketPath, peer, admit: () => ({ ok: true, agent: AGENT }), handle: async () => ({ text: "" }), onClose: () => {} });
  await assert.rejects(again.start(), /is not a folder of this user's/);
  assert.deepEqual(fs.readdirSync(other), [], "nothing was made in the link's target");
});

test("BridgeKeeper: a bridge that fails to start is reported to onFail with its vault, so the app can record it", async () => {
  const failed: string[] = [];
  const k = new BridgeKeeper({
    make: async () => { throw new Error("the peer addon did not load"); },
    log: () => {},
    onFail: (root, e) => failed.push(`${root}: ${(e as Error).message}`),
  });
  await k.sync("/vault-a");
  assert.deepEqual(failed, ["/vault-a: the peer addon did not load"]);
  assert.equal(k.root, null);
  await k.sync(null);
  assert.deepEqual(failed, ["/vault-a: the peer addon did not load"], "stopping is not a failure");
});

test("M12: an agent that leaves the registry loses its connection (drop), and a call from one no longer live is refused and closes it", async () => {
  const closed: AgentRef[] = [];
  let live = true;
  const { bridge, socketPath, calls } = await boot({ onClose: (a) => closed.push(a), live: () => live });
  try {
  const c = client(socketPath);
  c.send({ hello: 1 });
  await c.line(1);
  c.send({ id: 1, tool: "computer_status", args: {} });
  assert.deepEqual(await c.line(2), { id: 1, text: "done computer_status" });
  // Gone from the registry, a call is answered with the refusal and never reaches the computer.
  live = false;
  c.send({ id: 2, tool: "computer_open", args: { url: "https://a.test/" } });
  assert.deepEqual(await c.line(3), { id: 2, text: "This session has ended, so its computer connection is closed: start a new session to use the browser.", isError: true });
  await c.closed();
  assert.equal(calls.length, 1);
  assert.deepEqual(closed, [AGENT]);
  // drop(pid): the bridge closes that agent's connection at once.
  live = true;
  const d = client(socketPath);
  d.send({ hello: 1 });
  await d.line(1);
  bridge.drop(4242);
  await d.closed();
  assert.deepEqual(closed, [AGENT, AGENT]);
  bridge.drop(4242);
  bridge.drop(7);
  assert.equal(closed.length, 2, "nothing more to close");
  } finally { await bridge.stop(); }
});

// ---- session-browser S16 (Task 20): the app says which tools it takes

test("the admission answer lists the thirteen tools", async () => {
  const { bridge, socketPath } = await boot();
  const c = client(socketPath);
  try {
  c.send({ hello: 1 });
  const answer = await c.line(1);
  assert.deepEqual(Object.keys(answer).sort(), ["admitted", "session", "tools"], "nothing else is added to the answer");
  assert.deepEqual(answer.tools, THIRTEEN);
  assert.equal(new Set(answer.tools).size, 13);
  } finally { c.sock.destroy(); await bridge.stop(); }
});

test("the bridge accepts thirteen tool names and no fourteenth", async () => {
  const { bridge, socketPath, calls } = await boot();
  const c = client(socketPath);
  try {
  c.send({ hello: 1 });
  await c.line(1);
  // One at a time: the bridge answers a fifth call in flight with "too many" before it reaches the handler.
  for (const [i, tool] of THIRTEEN.entries()) { c.send({ id: i + 1, tool, args: {} }); await c.line(i + 2); }
  assert.deepEqual(calls.map((x) => x.call.tool), THIRTEEN, "each of the thirteen reached the handler");
  c.send({ id: 99, tool: "computer_fourteen", args: {} });
  await c.closed();
  assert.equal(calls.length, 13, "the fourteenth reached nothing");
  } finally { c.sock.destroy(); await bridge.stop(); }
});

test("an unknown tool still ends the connection", async () => {
  const { bridge, socketPath, calls } = await boot();
  const c = client(socketPath);
  try {
  c.send({ hello: 1 });
  await c.line(1);
  c.send({ id: 1, tool: "computer_teleport", args: {} });
  await c.closed();
  assert.deepEqual(calls, []);
  } finally { c.sock.destroy(); await bridge.stop(); }
});
