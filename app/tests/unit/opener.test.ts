import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// session-browser S23: the command every session's BROWSER points at. `route` is its decision; run as a program it acts
// on it. The door is a fake socket in a short folder, the previous BROWSER a script that records its argument; nothing
// here runs /usr/bin/open.

type Route = { to: "door"; door: string; id: string; url: string } | { to: "prev"; cmd: string; url: string } | { to: "system"; url: string };
const SCRIPT = path.resolve(__dirname, "../resources/opener/unidex-open.js");
const { route } = createRequire(__filename)(SCRIPT) as { route: (argv: string[], env: NodeJS.ProcessEnv) => Route };

const ID = "a1".repeat(16);
const made: string[] = [];
const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const folder = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "uo-")); made.push(d); return d; };
const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A previous BROWSER: records its first argument in `rec` and exits `code`. */
function prevProgram(dir: string, code = 0): { cmd: string; rec: string } {
  const cmd = path.join(dir, "prev.sh");
  const rec = path.join(dir, "prev.out");
  fs.writeFileSync(cmd, `#!/bin/sh\nprintf '%s' "$1" > ${rec}\nexit ${code}\n`, { mode: 0o755 });
  return { cmd, rec };
}

/** A door that answers `answer` to the first line of each connection and ends it. */
async function fakeDoor(dir: string, answer: string): Promise<{ sock: string; lines: string[]; conns: () => number }> {
  const sock = path.join(dir, "d.sock");
  const lines: string[] = [];
  let conns = 0;
  const server = net.createServer((s) => {
    conns++;
    let buf = "";
    s.on("error", () => {});
    s.on("data", (b) => {
      buf += b.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      lines.push(buf.slice(0, nl));
      s.end(`${answer}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(sock, res));
  return { sock, lines, conns: () => conns };
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    c.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the opener sends a web address to the door and exits 0", async () => {
  const dir = folder();
  const door = await fakeDoor(dir, '{"ok":true}');
  const prev = prevProgram(dir);
  const url = "http://localhost:5173/x?k=v";
  const r = await run(["--new-tab", url], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: prev.cmd }) });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
  assert.deepEqual(door.lines.map((l) => JSON.parse(l)), [{ id: ID, url }], "one line with the id and the last argument");
  assert.equal(fs.existsSync(prev.rec), false, "the previous BROWSER did not run");
});

test("a refused open opens nothing", async () => {
  const dir = folder();
  const door = await fakeDoor(dir, '{"ok":false}');
  const prev = prevProgram(dir);
  const r = await run(["https://example.com/"], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: prev.cmd }) });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
  assert.equal(door.lines.length, 1);
  assert.equal(fs.existsSync(prev.rec), false, "not opened anywhere else either");
});

test("anything that is not a web address goes to the previous BROWSER", async () => {
  const dir = folder();
  const door = await fakeDoor(dir, '{"ok":true}');
  const prev = prevProgram(dir);
  const r = await run(["file:///tmp/x.html"], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: prev.cmd }) });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
  assert.equal(fs.readFileSync(prev.rec, "utf8"), "file:///tmp/x.html");
  assert.equal(door.conns(), 0, "no connection was made");
});

test("with no door it falls back to the previous BROWSER", async () => {
  const dir = folder();
  const prev = prevProgram(dir, 3);
  const r = await run(["http://localhost:5173"], { AOS_BROWSER_SESSION: enc({ id: ID, door: path.join(dir, "gone.sock"), prev: prev.cmd }) });
  assert.equal(fs.readFileSync(prev.rec, "utf8"), "http://localhost:5173");
  assert.deepEqual([r.code, r.stdout, r.stderr], [3, "", ""], "the previous program's status, and nothing said about a door that is simply gone");
});

test("a door the sandbox blocks is named on standard error once, then it falls back", async () => {
  const dir = folder();
  const door = await fakeDoor(dir, '{"ok":true}');
  fs.chmodSync(door.sock, 0o000);   // connect(2) answers EACCES, as a host's command sandbox does with EPERM
  const prev = prevProgram(dir);
  const r = await run(["http://localhost:5173"], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: prev.cmd }) });
  assert.equal(r.stderr, "unidex-open: this session's sandbox blocks the UniDeX browser. Use the computer_open tool to open the address.\n");
  assert.deepEqual([r.code, r.stdout], [0, ""]);
  assert.equal(fs.readFileSync(prev.rec, "utf8"), "http://localhost:5173");
  assert.equal(door.conns(), 0);
});

test("with the variable missing or malformed it goes to the system's opener, whatever BROWSER was", () => {
  const url = "http://localhost:5173";
  assert.deepEqual(route([url], {}), { to: "system", url });
  assert.deepEqual(route([url], { BROWSER: "firefox" }), { to: "system", url }, "the previous BROWSER travels only inside the variable");
  assert.deepEqual(route([url], { AOS_BROWSER_SESSION: "not-base64" }), { to: "system", url });
  assert.deepEqual(route([url], { AOS_BROWSER_SESSION: enc({ door: "/tmp/d.sock", prev: null }) }), { to: "system", url }, "decodable, but no id");
  assert.deepEqual(route([url], { AOS_BROWSER_SESSION: enc({ id: "xyz", door: "/tmp/d.sock", prev: null }) }), { to: "system", url });
  assert.deepEqual(route([url], { AOS_BROWSER_SESSION: enc({ id: ID, prev: null }) }), { to: "system", url }, "no door");
  // A readable variable: the door for a web address; the previous BROWSER or the system for the rest and for a door that is gone.
  const door = (prev: string | null): NodeJS.ProcessEnv => ({ AOS_BROWSER_SESSION: enc({ id: ID, door: "/tmp/d.sock", prev }) });
  assert.deepEqual(route([url], door("firefox")), { to: "door", door: "/tmp/d.sock", id: ID, url });
  assert.deepEqual(route(["-x", "https://example.com/a"], door(null)), { to: "door", door: "/tmp/d.sock", id: ID, url: "https://example.com/a" });
  assert.deepEqual(route(["file:///tmp/x.html"], door("firefox")), { to: "prev", cmd: "firefox", url: "file:///tmp/x.html" });
  assert.deepEqual(route(["file:///tmp/x.html"], door(null)), { to: "system", url: "file:///tmp/x.html" });
  assert.deepEqual(route(["ftp://example.com/x"], door("firefox")), { to: "prev", cmd: "firefox", url: "ftp://example.com/x" });
});
