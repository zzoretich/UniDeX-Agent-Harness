import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadPeer, socketFd } from "../../src/main/computer/peer";

// The addon the postinstall builds (scripts/build-native.mjs); this bundle runs from out-test/.
const peer = loadPeer(path.join(__dirname, "..", "native", "peer", "build", "Release", "peer.node"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aos-peer-"));
/** The team codesign reports for a file, or null ("not set": ad hoc or unsigned). */
const codesignTeam = (file: string): string | null => {
  const team = /^TeamIdentifier=(.*)$/m.exec(spawnSync("codesign", ["-dv", file], { encoding: "utf8" }).stderr)?.[1];
  return team && team !== "not set" ? team : null;
};
const node = fs.realpathSync(process.execPath);
// A Developer ID-signed program to run: this Node when it is an official build (CI's is), else the dev Electron when it
// is signed so (it runs as Node with ELECTRON_RUN_AS_NODE=1). A local Node or Electron is usually ad hoc.
const devElectron = path.join(__dirname, "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const signedNode = codesignTeam(node) ? node : null;
const signedRunner = signedNode ?? (fs.existsSync(devElectron) && codesignTeam(devElectron) ? devElectron : null);
const NO_SIGNED = "no Developer ID-signed Node or Electron on this machine (both are ad hoc); CI's official Node runs it";
/** Starts a program and resolves once it runs (Node's spawn event comes after the exec). */
async function run(file: string, args: string[]): Promise<ChildProcess> {
  const child = spawn(file, args, { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  await once(child, "spawn");
  return child;
}

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
  assert.equal(peer.teamId(node), codesignTeam(node));
});

test("processTeamId reads the team of the code this process runs, as codesign reports it", () => {
  assert.equal(peer.processTeamId(process.pid), codesignTeam(node));
});

test("processTeamId is null for a running Apple platform binary and a dead pid, and refuses a bad pid", async () => {
  const sleeper = await run("/bin/sleep", ["30"]);
  try { assert.equal(peer.processTeamId(sleeper.pid!), null); } finally { sleeper.kill("SIGKILL"); }
  assert.equal(peer.processTeamId(999999), null);
  for (const bad of ["1", 0, -5, 2.5, null]) assert.throws(() => peer.processTeamId(bad as number), TypeError, String(bad));
});

test("processTeamId reads a running Developer ID program's team", { skip: signedRunner ? false : NO_SIGNED }, async () => {
  const child = await run(signedRunner!, ["-e", "setInterval(() => {}, 1000)"]);
  try { assert.equal(peer.processTeamId(child.pid!), codesignTeam(signedRunner!)); } finally { child.kill("SIGKILL"); }
});

test("processTeamId never takes the team of a signed binary renamed over a running program's path", { skip: signedNode ? false : NO_SIGNED }, async () => {
  const dir = tmp();
  const exe = path.join(dir, "cli");
  fs.copyFileSync("/bin/sleep", exe);
  const child = await run(exe, ["30"]);
  try {
    fs.copyFileSync(signedNode!, path.join(dir, "swap"));
    fs.renameSync(path.join(dir, "swap"), exe);
    // The kernel still names the old path, and the file there is now a Developer ID binary: the check of a path is fooled.
    assert.equal(peer.procInfo(child.pid!)?.path, fs.realpathSync(exe));
    assert.equal(peer.teamId(exe), codesignTeam(signedNode!));
    // The running code is still sleep's, which has no team.
    assert.equal(peer.processTeamId(child.pid!), null);
  } finally { child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); }
});
