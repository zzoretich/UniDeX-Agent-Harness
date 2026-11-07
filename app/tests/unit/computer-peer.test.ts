import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadPeer, socketFd } from "../../src/main/computer/peer";

// The addon the postinstall builds (scripts/build-native.mjs); this bundle runs from out-test/.
const peer = loadPeer(path.join(__dirname, "..", "native", "peer", "build", "Release", "peer.node"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aos-peer-"));

test("peerPid reads the pid at the other end of an accepted Unix socket", async () => {
  const dir = tmp();
  const server = net.createServer();
  const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
  await new Promise<void>((resolve) => server.listen(path.join(dir, "s"), resolve));
  const client = net.connect(path.join(dir, "s"));
  try {
    const conn = await accepted;
    assert.equal(peer.peerPid(socketFd(conn)), process.pid);
    conn.destroy();
  } finally {
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("peerPid refuses a file that is not a socket, and a bad argument", () => {
  const dir = tmp();
  const fd = fs.openSync(path.join(dir, "f"), "w");
  try {
    assert.throws(() => peer.peerPid(fd), (e: Error) => !(e instanceof TypeError) && /getsockopt/.test(e.message));
  } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
  for (const bad of ["3", -1, 1.5, undefined]) assert.throws(() => peer.peerPid(bad as number), TypeError, String(bad));
});

test("socketFd throws for a socket with no handle", () => {
  assert.throws(() => socketFd(new net.Socket()), /no file descriptor/);
});

test("procInfo describes this process: its parent, its real executable and its argv", () => {
  const me = peer.procInfo(process.pid);
  assert.ok(me);
  assert.equal(me.pid, process.pid);
  assert.equal(me.ppid, process.ppid);
  assert.equal(me.path, fs.realpathSync(process.execPath));
  assert.ok(me.argv.length >= 2, me.argv.join(" "));
});

test("procInfo reads a child's argv exactly, empty and spaced arguments included", async () => {
  const args = ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)", "a b", "", "c"];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise((resolve) => child.stdout.once("data", resolve));
    assert.deepEqual(peer.procInfo(child.pid!), { pid: child.pid, ppid: process.pid, path: fs.realpathSync(process.execPath), argv: [process.execPath, ...args] });
  } finally { child.kill("SIGKILL"); }
});

test("procInfo is null for a process that does not exist or cannot be read", () => {
  assert.equal(peer.procInfo(999999), null);
  // launchd belongs to root: its arguments are not readable by this user.
  assert.equal(peer.procInfo(1), null);
  for (const bad of ["1", 0, -5, 2.5, null]) assert.throws(() => peer.procInfo(bad as number), TypeError, String(bad));
});

test("teamId is null for a platform binary, an unsigned script, an ad hoc signature and a missing file; it refuses a relative path", () => {
  assert.equal(peer.teamId("/bin/ls"), null);
  const dir = tmp();
  try {
    const script = path.join(dir, "tool.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho hi\n", { mode: 0o755 });
    assert.equal(peer.teamId(script), null);
    const adhoc = path.join(dir, "ls");
    fs.copyFileSync("/bin/ls", adhoc);
    assert.equal(spawnSync("codesign", ["--force", "--sign", "-", adhoc]).status, 0);
    assert.equal(peer.teamId(adhoc), null);
    assert.equal(peer.teamId(path.join(dir, "missing")), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  for (const bad of [42, null, "/bin/ls\0x", "bin/ls", ""]) assert.throws(() => peer.teamId(bad as string), TypeError, JSON.stringify(bad));
});

test("teamId agrees with codesign about this Node (a Developer ID build has a team, a local build has none)", () => {
  const node = fs.realpathSync(process.execPath);
  const team = /^TeamIdentifier=(.*)$/m.exec(spawnSync("codesign", ["-dv", node], { encoding: "utf8" }).stderr)?.[1];
  assert.equal(peer.teamId(node), team && team !== "not set" ? team : null);
});
