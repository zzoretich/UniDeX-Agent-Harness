import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// session-browser S23: the command every session's BROWSER points at. `route` is its decision; run as a program it acts
// on it. The door is a fake socket in a short folder, the previous BROWSER a script that records its argument. Nothing
// here can run /usr/bin/open: every case that can end in a fallback runs the opener through `runSafe`, which replaces the
// system's opener with a stand-in, and the two cases that run the shipped script itself (a door that answers) are
// refused by `run` unless the route is the door, whose fallback is the previous BROWSER.

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

/** A door that answers `answer` to the first line of each connection and ends it; null answers nothing, ever; "close" ends
 *  the connection with no answer; a string with no newline at its end is written as it is and then the connection ends. */
async function fakeDoor(dir: string, answer: string | null | "close"): Promise<{ sock: string; lines: string[]; conns: () => number }> {
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
      if (answer === "close") s.end();
      else if (answer !== null) s.end(answer.endsWith("|") ? answer.slice(0, -1) : `${answer}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(sock, res));
  return { sock, lines, conns: () => conns };
}

/** Runs `script` (the opener unless told) with `args`. Fails, never hangs, after 10 s; and refuses to start the real opener
 *  on a route that would end at the system's opener (/usr/bin/open would open this machine's real browser). */
function run(args: string[], env: Record<string, string>, script = SCRIPT): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (script === SCRIPT) assert.notEqual(route(args, env).to, "system", "this test would reach /usr/bin/open");
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { c.kill("SIGKILL"); reject(new Error("the opener did not end in 10 s")); }, 10_000);
    c.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    c.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    c.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** A stand-in for /usr/bin/open: appends one line (the address, and whether the session variable reached it) to `rec`. */
function openStandIn(dir: string): { cmd: string; rec: string } {
  const cmd = path.join(dir, "open-standin.sh");
  const rec = path.join(dir, "open.out");
  fs.writeFileSync(cmd, `#!/bin/sh\nprintf '%s %s\\n' "$1" "${"$"}{AOS_BROWSER_SESSION:-unset}" >> ${rec}\n`, { mode: 0o755 });
  return { cmd, rec };
}
/** Runs the opener with the system's opener replaced by a stand-in: for every case that can end in a fallback. `opened`
 *  is what the stand-in recorded (nothing when it never ran). */
async function runSafe(dir: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string; opened: string }> {
  const open = openStandIn(dir);
  const guard = path.join(dir, "guard.out");
  const script = openerWith(dir, "safe.js", open.cmd, guard);
  const r = await run(args, env, script);
  assert.equal(fs.existsSync(guard), false, "the depth guard was never hit");
  return { ...r, opened: fs.existsSync(open.rec) ? fs.readFileSync(open.rec, "utf8") : "" };
}

/** A program that is the opener, with the system's opener replaced by `open` (the only way to do that: an argument). It
 *  counts its depth in OPENER_TEST_DEPTH (the test's own variable, not the shipped script's) and past 3 it records a hit in
 *  `guard` and exits 99 without starting anything, so a regressed opener cannot run away. */
function openerWith(dir: string, name: string, open: string, guard: string): string {
  const file = path.join(dir, name);
  const body = [
    "#!/usr/bin/env node",
    `const o = require(${JSON.stringify(SCRIPT)});`,
    "const depth = Number(process.env.OPENER_TEST_DEPTH || 0);",
    `if (depth > 3) { require("node:fs").appendFileSync(${JSON.stringify(guard)}, "x"); process.exit(99); }`,
    "const env = { ...process.env, OPENER_TEST_DEPTH: String(depth + 1) };",
    `o.act(o.route(process.argv.slice(2), env), env, { open: ${JSON.stringify(open)} });`,
    "",
  ].join("\n");
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
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
  const r = await runSafe(dir, ["file:///tmp/x.html"], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: prev.cmd }) });
  assert.deepEqual([r.code, r.stdout, r.stderr, r.opened], [0, "", "", ""]);
  assert.equal(fs.readFileSync(prev.rec, "utf8"), "file:///tmp/x.html");
  assert.equal(door.conns(), 0, "no connection was made");
});

test("with no door it falls back to the previous BROWSER", async () => {
  const dir = folder();
  const prev = prevProgram(dir, 3);
  const r = await runSafe(dir, ["http://localhost:5173"], { AOS_BROWSER_SESSION: enc({ id: ID, door: path.join(dir, "gone.sock"), prev: prev.cmd }) });
  assert.equal(fs.readFileSync(prev.rec, "utf8"), "http://localhost:5173");
  assert.deepEqual([r.code, r.stdout, r.stderr, r.opened], [3, "", "", ""], "the previous program's status, and nothing said about a door that is simply gone");
});

test("a door the sandbox blocks is named on standard error once, then it falls back", async () => {
  const dir = folder();
  const door = await fakeDoor(dir, '{"ok":true}');
  fs.chmodSync(door.sock, 0o000);   // connect(2) answers EACCES, as a host's command sandbox does with EPERM
  const prev = prevProgram(dir);
  const r = await runSafe(dir, ["http://localhost:5173"], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: prev.cmd }) });
  assert.equal(r.stderr, "unidex-open: this session's sandbox blocks the UniDeX browser. Use the computer_open tool to open the address.\n");
  assert.deepEqual([r.code, r.stdout, r.opened], [0, "", ""]);
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

test("what the opener starts never inherits the session variable", async () => {
  const dir = folder();
  const rec = path.join(dir, "env.out");
  const cmd = path.join(dir, "envprev.sh");
  fs.writeFileSync(cmd, `#!/bin/sh\nprintf '%s' "${"$"}{AOS_BROWSER_SESSION:-unset}" > ${rec}\n`, { mode: 0o755 });
  const session = enc({ id: ID, door: path.join(dir, "gone.sock"), prev: cmd });
  for (const url of ["file:///tmp/x.html", "http://localhost:5173"]) {
    fs.rmSync(rec, { force: true });
    const r = await runSafe(dir, [url], { AOS_BROWSER_SESSION: session });
    assert.equal(r.code, 0, url);
    assert.equal(r.opened, "", url);
    assert.equal(fs.readFileSync(rec, "utf8"), "unset", url);
  }
});

test("an opener run as the previous BROWSER does not start itself again", async () => {
  const dir = folder();
  const open = openStandIn(dir);
  const guard = path.join(dir, "guard.out");
  const inner = openerWith(dir, "inner.js", open.cmd, guard);
  const outer = openerWith(dir, "outer.js", open.cmd, guard);
  const session = enc({ id: ID, door: path.join(dir, "gone.sock"), prev: inner });
  const r = await run(["file:///tmp/x.html"], { AOS_BROWSER_SESSION: session }, outer);
  assert.equal(fs.existsSync(guard), false, "the depth guard was never hit: the chain did not run away");
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
  assert.deepEqual(fs.readFileSync(open.rec, "utf8").trim().split("\n"), ["file:///tmp/x.html unset"], "the chain ended at the system's opener, once, with no session");
});

test("a previous BROWSER killed by a signal ends the opener as a shell would: 128 plus the signal", async () => {
  const dir = folder();
  const cmd = path.join(dir, "killme.sh");
  fs.writeFileSync(cmd, "#!/bin/sh\nkill -TERM $$\nsleep 5\n", { mode: 0o755 });
  const r = await runSafe(dir, ["file:///tmp/x.html"], { AOS_BROWSER_SESSION: enc({ id: ID, door: path.join(dir, "gone.sock"), prev: cmd }) });
  assert.deepEqual([r.code, r.opened], [143, ""]);
});

const NO_ANSWER = "unidex-open: the UniDeX browser did not answer. Use the computer_open tool to open the address.\n";

test("a door that accepts and never answers ends the opener with 1 after the wait, with its one line, and nothing else opens", async () => {
  const dir = folder();
  const door = await fakeDoor(dir, null);
  const prev = prevProgram(dir);
  const t0 = Date.now();
  const r = await runSafe(dir, ["http://localhost:5173"], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: prev.cmd }) });
  assert.deepEqual([r.code, r.stdout, r.stderr, r.opened], [1, "", NO_ANSWER, ""]);
  assert.ok(Date.now() - t0 >= 2500, "it waited for an answer");
  assert.equal(door.lines.length, 1);
  assert.equal(fs.existsSync(prev.rec), false, "the previous BROWSER did not run: the door may have taken the address");
});

test("a door that closes without answering ends the opener with 1 and its one line, and nothing else opens", async () => {
  const dir = folder();
  const door = await fakeDoor(dir, "close");
  const prev = prevProgram(dir);
  const r = await runSafe(dir, ["http://localhost:5173"], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: prev.cmd }) });
  assert.deepEqual([r.code, r.stdout, r.stderr, r.opened], [1, "", NO_ANSWER, ""]);
  assert.equal(door.lines.length, 1);
  assert.equal(fs.existsSync(prev.rec), false);
});

test("half an answer line is no answer", async () => {
  const dir = folder();
  const door = await fakeDoor(dir, '{"ok":true}|');   // written without its newline, then the connection ends
  const prev = prevProgram(dir);
  const r = await runSafe(dir, ["http://localhost:5173"], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: prev.cmd }) });
  assert.deepEqual([r.code, r.stdout, r.stderr, r.opened], [1, "", NO_ANSWER, ""]);
  assert.equal(fs.existsSync(prev.rec), false);
});

test("a door that answers off is treated as a door that is gone: the previous BROWSER runs, silently", async () => {
  const dir = folder();
  const door = await fakeDoor(dir, '{"ok":false,"off":true}');
  const prev = prevProgram(dir, 4);
  const r = await runSafe(dir, ["http://localhost:5173"], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: prev.cmd }) });
  assert.deepEqual([r.code, r.stdout, r.stderr, r.opened], [4, "", "", ""]);
  assert.equal(fs.readFileSync(prev.rec, "utf8"), "http://localhost:5173");
  assert.equal(door.lines.length, 1);
  // With no previous BROWSER it is the system's opener (the stand-in here).
  const r2 = await runSafe(dir, ["http://localhost:5173"], { AOS_BROWSER_SESSION: enc({ id: ID, door: door.sock, prev: null }) });
  assert.deepEqual([r2.code, r2.stderr, r2.opened], [0, "", "http://localhost:5173 unset\n"]);
});
