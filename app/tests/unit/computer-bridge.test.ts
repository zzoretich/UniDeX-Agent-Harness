import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ComputerBridge, type ToolCall, type ToolReply } from "../../src/main/computer/bridge";
import type { Admit } from "../../src/main/computer/admission";
import type { AgentRef } from "../../src/main/computer/registry";
import type { PeerAddon } from "../../src/main/computer/peer";

// agent-computer D18/D26: the bridge socket, over a real temp socket with a fake admit and a fake peer.

const AGENT: AgentRef = { pid: 4242, host: "claude", page: "code", key: "code:t1", label: "Code 1", place: "~/proj", access: "read" };
const peer: PeerAddon = { peerPid: () => 4242, procInfo: () => null, teamId: () => null, processTeamId: () => null };

function tmpSock(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aos-br-")), "computer", "bridge.sock");
}

interface Opts { admit?: (pid: number) => Admit; handle?: (a: AgentRef, c: ToolCall) => Promise<Omit<ToolReply, "id">>; onClose?: (a: AgentRef) => void }
async function boot(o: Opts = {}) {
  const socketPath = tmpSock();
  const calls: Array<{ agent: AgentRef; call: ToolCall }> = [];
  const bridge = new ComputerBridge({
    socketPath, peer,
    admit: o.admit ?? (() => ({ ok: true, agent: AGENT })),
    handle: o.handle ?? (async (agent, call) => { calls.push({ agent, call }); return { text: `done ${call.tool}` }; }),
    onClose: o.onClose ?? (() => {}),
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
  assert.deepEqual(await c.line(1), { admitted: true, session: "Code 1" });
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
  assert.deepEqual(await c.line(2), { id: 1, text: "The computer failed: boom", isError: true });
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
  fs.writeFileSync(socketPath, "stale");
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
