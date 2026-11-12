import { test, afterEach } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ComputerDoor, DOOR_CONNECTIONS, DOOR_IDLE_MS, SESSION_VAR, doorSocketPath, openerPath } from "../../src/main/computer/door";
import { shortDirIn } from "../../src/main/computer/unix-socket";
import type { Clock } from "../../src/main/computer/asks";

// session-browser S23: the door a session's programs knock on to ask for one page. Ids are opaque to the door; the
// message path is driven through `accept`, the socket through a real temp socket.

const UUID = "chat:0b5c1f0e-4a4e-4c3a-9d0e-6a1b2c3d4e5f";
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function fakeClock(): Clock & { t: number } {
  const c = { t: 1_000_000, now: () => c.t, setTimeout: () => 0, clearTimeout: () => {} };
  return c;
}
function rig() {
  const opened: Array<[string, string]> = [];
  const logs: string[] = [];
  const clock = fakeClock();
  const door = new ComputerDoor({ path: "/unused", open: (s, u) => opened.push([s, u]), log: (l) => logs.push(l), clock });
  const msg = (id: string, url: unknown) => JSON.stringify({ id, url });
  return { door, opened, logs, clock, msg };
}

test("a live id opens its session's page", () => {
  const { door, opened, msg } = rig();
  const id = door.issue("code:t1");
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(door.accept(msg(id, "http://localhost:5173/")), true);
  assert.deepEqual(opened, [["code:t1", "http://localhost:5173/"]]);
});

test("an unknown, a revoked and a malformed id open nothing", () => {
  const { door, opened, msg, logs } = rig();
  const id = door.issue("code:t1");
  door.revoke("code:t1");
  const lines = [
    msg("0".repeat(32), "http://localhost/"), msg(id, "http://localhost/"), msg("ABC", "http://localhost/"), msg(id.toUpperCase(), "http://localhost/"),
    "not json", "[]", "7", "null", "{}", JSON.stringify({ id }), JSON.stringify({ url: "http://localhost/" }), JSON.stringify({ id: 5, url: "http://localhost/" }), msg(door.issue("code:t9"), 5),
  ];
  for (const l of lines) assert.equal(door.accept(l), false, l);
  assert.deepEqual(opened, []);
  assert.deepEqual(logs, []);
});

test("the door refuses what linkUrl refuses", () => {
  const { door, opened, msg } = rig();
  const id = door.issue("code:t1");
  for (const u of ["file:///etc/passwd", "javascript:alert(1)", "http://user:pass@example.com/", `http://example.com/${"a".repeat(8200)}`]) assert.equal(door.accept(msg(id, u)), false, u.slice(0, 40));
  assert.deepEqual(opened, []);
  assert.equal(door.accept(msg(id, "http://0.0.0.0:3000")), true);
  assert.deepEqual(opened, [["code:t1", "http://localhost:3000/"]]);
});

test("a seventh open within a minute is dropped and logged", () => {
  const { door, opened, logs, clock, msg } = rig();
  const id = door.issue("code:t1");
  for (let i = 0; i < 6; i++) assert.equal(door.accept(msg(id, `http://localhost/${i}`)), true);
  assert.equal(door.accept(msg(id, "http://localhost/7")), false);
  assert.equal(opened.length, 6);
  assert.deepEqual(logs, ["door: code:t1 asked for more than 6 pages in a minute"]);
  assert.equal(logs.some((l) => l.includes(id)), false);
  clock.t += 60_001;
  assert.equal(door.accept(msg(id, "http://localhost/8")), true);
});

test("issue is stable and move keeps the id under the new key", () => {
  const { door, opened, msg } = rig();
  const a = door.issue("code:t1");
  assert.equal(door.issue("code:t1"), a);
  assert.notEqual(door.issue(UUID), a);
  door.move("code:t1", "code:t2");
  assert.equal(door.accept(msg(a, "http://localhost/")), true);
  assert.deepEqual(opened, [["code:t2", "http://localhost/"]]);
  assert.notEqual(door.issue("code:t1"), a);   // t1 holds nothing now: a session that only received ids makes its own
  const c = door.issue("code:t3");
  door.move("code:t1", "code:t3");
  assert.equal(door.issue("code:t3"), c);
});

test("a replacement that already has its own id keeps it through the handoff", () => {
  const { door, opened, msg } = rig();
  const a = door.issue("code:t1");
  const b = door.issue("code:t2");
  assert.equal(door.accept(msg(b, "http://localhost/b")), true);
  door.move("code:t1", "code:t2");
  assert.equal(door.accept(msg(a, "http://localhost/a")), true);
  assert.equal(door.accept(msg(b, "http://localhost/b2")), true);
  assert.equal(door.issue("code:t2"), b);
  assert.deepEqual(opened.map(([s]) => s), ["code:t2", "code:t2", "code:t2"]);
  door.revoke("code:t2");
  assert.equal(door.accept(msg(a, "http://localhost/")), false);
  assert.equal(door.accept(msg(b, "http://localhost/")), false);
  assert.equal(opened.length, 3);
});

test("move adds the two sessions' open counts", () => {
  const { door, logs, msg } = rig();
  const a = door.issue("code:t1");
  const b = door.issue("code:t2");
  for (let i = 0; i < 3; i++) door.accept(msg(a, `http://localhost/${i}`));
  for (let i = 0; i < 3; i++) door.accept(msg(b, `http://localhost/${i}`));
  door.move("code:t1", "code:t2");
  assert.equal(door.accept(msg(b, "http://localhost/x")), false);
  assert.equal(logs.length, 1);
});

test("revokeAll drops every id under a prefix and leaves the others", () => {
  const { door, opened, msg } = rig();
  const a = door.issue("code:t1");
  const b = door.issue("code:t2");
  const c = door.issue(UUID);
  door.revokeAll("code:");
  assert.equal(door.accept(msg(a, "http://localhost/")), false);
  assert.equal(door.accept(msg(b, "http://localhost/")), false);
  assert.equal(door.accept(msg(c, "http://localhost/")), true);
  assert.deepEqual(opened, [[UUID, "http://localhost/"]]);
  assert.notEqual(door.issue("code:t1"), a);
});

test("doorSocketPath is bridge.sock's rule with door.sock", () => {
  assert.equal(doorSocketPath("/data", "/tmp"), "/data/computer/door.sock");
  const long = doorSocketPath(`/${"x".repeat(120)}`, "/tmp");
  assert.match(long ?? "", /^\/tmp\/unidex-computer-[0-9a-f]{12}\/door\.sock$/);
  assert.equal(doorSocketPath(`/${"x".repeat(120)}`, `/${"t".repeat(120)}`), null);
});

async function boot(idleMs?: number) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aos-dr-"));
  made.push(d);
  const sock = path.join(d, "computer", "door.sock");
  const opened: Array<[string, string]> = [];
  const logs: string[] = [];
  const door = new ComputerDoor({ path: sock, open: (s, u) => opened.push([s, u]), log: (l) => logs.push(l), ...(idleMs ? { idleMs } : {}) });
  assert.equal(await door.start(), true);
  assert.equal(door.listening(), true);
  return { door, sock, opened, logs };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Connects, writes each chunk (a pause between them), and resolves with what came back when the door closed. A door
 *  that never closes fails the test after 5 s instead of hanging the run. */
function talk(sock: string, send: string | Buffer[] | null): Promise<{ data: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let data = "";
    const c = net.connect(sock);
    const guard = setTimeout(() => { c.destroy(); reject(new Error("the door never closed the connection")); }, 5000);
    c.setEncoding("utf8");
    c.on("connect", async () => {
      if (send === null) return;
      for (const chunk of typeof send === "string" ? [send] : send) { c.write(chunk); if (typeof send !== "string") await sleep(40); }
    });
    c.on("data", (s) => { data += s; });
    c.on("error", () => {});
    c.on("close", () => { clearTimeout(guard); resolve({ data, ms: Date.now() - t0 }); });
  });
}

test("junk, an oversize line and a silent connection are closed", async () => {
  const { door, sock, opened, logs } = await boot(150);
  try {
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
    const id = door.issue("code:t1");
    assert.equal((await talk(sock, `${JSON.stringify({ id, url: "http://localhost:1/" })}\n`)).data, '{"ok":true}\n');
    assert.deepEqual(opened, [["code:t1", "http://localhost:1/"]]);
    assert.equal((await talk(sock, "junk\n")).data, '{"ok":false}\n');
    const quiet = await talk(sock, null);
    assert.equal(quiet.data, "");
    assert.ok(quiet.ms >= 100 && quiet.ms < 1500, `closed after ${quiet.ms} ms`);
    assert.deepEqual(logs, []);
  } finally {
    door.stop();
  }
  assert.equal(door.listening(), false);
  assert.equal(fs.existsSync(sock), false);
});

test("an oversize line is closed unanswered at once, not by the idle limit", async () => {
  const { door, sock } = await boot();   // the default idle limit: only the 16 KiB limit can close this early
  try {
    const r = await talk(sock, "a".repeat(17 * 1024));
    assert.equal(r.data, "");
    assert.ok(r.ms < DOOR_IDLE_MS / 2, `closed after ${r.ms} ms`);
  } finally { door.stop(); }
});

test("a seventeenth connection at once is closed with no answer while the first sixteen stay open", async () => {
  const { door, sock } = await boot();
  const held: net.Socket[] = [];
  try {
    for (let i = 0; i < DOOR_CONNECTIONS; i++) {
      const c = net.connect(sock);
      c.on("error", () => {});
      await new Promise<void>((r) => c.once("connect", () => r()));
      held.push(c);
    }
    await sleep(100);
    const r = await talk(sock, null);
    assert.equal(r.data, "");
    assert.ok(r.ms < DOOR_IDLE_MS / 2, `closed after ${r.ms} ms`);
    assert.ok(held.every((c) => !c.destroyed));
  } finally {
    for (const c of held) c.destroy();
    door.stop();
  }
});

test("a line split across two writes is accepted once, and a multi-byte character split across two writes arrives whole", async () => {
  const { door, sock, opened } = await boot();
  try {
    const id = door.issue("code:t1");
    const line = Buffer.from(`${JSON.stringify({ id, url: "http://localhost/caf\u00e9" })}\n`);
    assert.equal((await talk(sock, [line.subarray(0, 20), line.subarray(20)])).data, '{"ok":true}\n');
    const cut = line.indexOf(0xc3) + 1;   // between the two bytes of the e-acute
    assert.equal((await talk(sock, [line.subarray(0, cut), line.subarray(cut)])).data, '{"ok":true}\n');
    assert.deepEqual(opened, [["code:t1", "http://localhost/caf%C3%A9"], ["code:t1", "http://localhost/caf%C3%A9"]]);
  } finally { door.stop(); }
});

/** A stand-in socket the test feeds chunks by hand; `end`'s callback runs only when the test says the reply flushed. */
function fakeSocket() {
  const s = Object.assign(new EventEmitter(), {
    ended: [] as string[], endCb: null as null | (() => void), destroyed: false,
    setEncoding() {}, destroy() { s.destroyed = true; },
    end(text: string, cb: () => void) { s.ended.push(text); s.endCb = cb; },
  });
  return s;
}

test("bytes after the first line never open a second page", () => {
  const { door, opened, msg } = rig();
  const id = door.issue("code:t1");
  const s = fakeSocket();
  (door as unknown as { connection(s: unknown): void }).connection(s);
  s.emit("data", `${msg(id, "http://localhost/1")}\n`);
  s.emit("data", `${msg(id, "http://localhost/2")}\n`);   // arrives before the reply's callback
  s.emit("data", "\n");
  assert.deepEqual(opened, [["code:t1", "http://localhost/1"]]);
  assert.deepEqual(s.ended, ['{"ok":true}\n']);
});

test("a failing open is logged once, without the id or the error text, and answers false", () => {
  const logs: string[] = [];
  const door = new ComputerDoor({ path: "/unused", open: () => { throw new Error("no pane"); }, log: (l) => logs.push(l), clock: fakeClock() });
  const id = door.issue("code:t1");
  assert.equal(door.accept(JSON.stringify({ id, url: "http://localhost/" })), false);
  assert.deepEqual(logs, ["door: an open for code:t1 failed"]);
});

test("revoke clears the session's count: a new id for the same key starts clean", () => {
  const { door, opened, msg } = rig();
  const a = door.issue("code:t1");
  for (let i = 0; i < 6; i++) assert.equal(door.accept(msg(a, `http://localhost/${i}`)), true);
  door.revoke("code:t1");
  const b = door.issue("code:t1");
  for (let i = 0; i < 6; i++) assert.equal(door.accept(msg(b, `http://localhost/${i}`)), true);
  assert.equal(opened.length, 12);
});

test("a clock that jumps backwards does not lock a session out", () => {
  const { door, clock, msg } = rig();
  const id = door.issue("code:t1");
  for (let i = 0; i < 6; i++) assert.equal(door.accept(msg(id, `http://localhost/${i}`)), true);
  clock.t -= 3_600_000;
  assert.equal(door.accept(msg(id, "http://localhost/back")), true);
});

test("the too-many line is logged once per session per minute", () => {
  const { door, logs, clock, msg } = rig();
  const id = door.issue("code:t1");
  for (let i = 0; i < 6; i++) door.accept(msg(id, `http://localhost/${i}`));
  for (let i = 0; i < 8; i++) assert.equal(door.accept(msg(id, "http://localhost/more")), false);
  assert.equal(logs.length, 1);
  clock.t += 30_000;
  door.accept(msg(id, "http://localhost/more"));
  assert.equal(logs.length, 1);
  clock.t += 30_001;   // a minute past the first open: room again, then fill it and be refused anew
  for (let i = 0; i < 6; i++) door.accept(msg(id, `http://localhost/n${i}`));
  door.accept(msg(id, "http://localhost/more"));
  assert.equal(logs.length, 2);
});

test("the window's edges: 60,000 ms frees a slot, 59,999 does not", () => {
  for (const [gap, allowed] of [[60_000, true], [59_999, false]] as const) {
    const { door, clock, msg } = rig();
    const id = door.issue("code:t1");
    door.accept(msg(id, "http://localhost/first"));
    clock.t += 1;
    for (let i = 0; i < 5; i++) door.accept(msg(id, `http://localhost/${i}`));
    clock.t += gap - 1;
    assert.equal(door.accept(msg(id, "http://localhost/edge")), allowed, `gap ${gap}`);
  }
});

test("refused addresses and unknown ids use up none of the six", () => {
  const { door, opened, msg } = rig();
  const id = door.issue("code:t1");
  for (let i = 0; i < 8; i++) { door.accept(msg(id, "file:///etc/passwd")); door.accept(msg("0".repeat(32), "http://localhost/")); }
  for (let i = 0; i < 6; i++) assert.equal(door.accept(msg(id, `http://localhost/${i}`)), true);
  assert.equal(opened.length, 6);
});

test("the address limit: 8,192 characters pass, 8,193 do not", () => {
  const { door, msg } = rig();
  const id = door.issue("code:t1");
  const pad = (n: number) => `http://localhost/${"a".repeat(n - "http://localhost/".length)}`;
  assert.equal(pad(8192).length, 8192);
  assert.equal(door.accept(msg(id, pad(8192))), true);
  assert.equal(door.accept(msg(id, pad(8193))), false);
});

test("start answers false and logs one line when it cannot listen", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aos-dr-"));
  made.push(d);
  fs.mkdirSync(path.join(d, "computer"));
  fs.writeFileSync(path.join(d, "computer", "door.sock"), "mine");
  const logs: string[] = [];
  const door = new ComputerDoor({ path: path.join(d, "computer", "door.sock"), open: () => {}, log: (l) => logs.push(l) });
  assert.equal(await door.start(), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^door: /);
  assert.equal(fs.readFileSync(path.join(d, "computer", "door.sock"), "utf8"), "mine");
});

// ── the opener and the session's environment (Task 17) ────────────────────

function shortDir(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ud-")); made.push(d); return d; }

test("envFor gives the three variables, and none while the door is down", async () => {
  const dir = shortDir();
  const opener = path.join(dir, "unidex-open.js");
  const sock = path.join(dir, "d.sock");
  const door = new ComputerDoor({ path: sock, open: () => {}, log: () => {}, opener });
  assert.deepEqual(door.envFor("code:t1", {}), {}, "not listening yet");
  assert.equal(await door.start(), true);
  try {
    const env = door.envFor("code:t1", { BROWSER: "firefox", PATH: "/usr/bin" });
    assert.deepEqual(Object.keys(env).sort(), ["AOS_BROWSER_SESSION", "BRAINSTORM_OPEN_CMD", "BROWSER"]);
    assert.equal(SESSION_VAR, "AOS_BROWSER_SESSION");
    assert.equal(env.BROWSER, opener);
    assert.equal(env.BRAINSTORM_OPEN_CMD, opener);
    const seen = JSON.parse(Buffer.from(env[SESSION_VAR], "base64url").toString("utf8")) as { id: string; door: string; prev: string | null };
    assert.match(seen.id, /^[0-9a-f]{32}$/);
    assert.deepEqual([seen.door, seen.prev], [sock, "firefox"]);
    assert.equal(JSON.parse(Buffer.from(door.envFor("code:t2", {})[SESSION_VAR], "base64url").toString("utf8")).prev, null, "no BROWSER before: null");
    assert.equal(JSON.parse(Buffer.from(door.envFor("code:t3", { BROWSER: opener })[SESSION_VAR], "base64url").toString("utf8")).prev, null, "never itself as the previous BROWSER");
    // The id is the one the door accepts for that session.
    const opened: string[] = [];
    const live = new ComputerDoor({ path: path.join(dir, "e.sock"), open: (s) => opened.push(s), log: () => {}, opener });
    assert.equal(await live.start(), true);
    try {
      const id = JSON.parse(Buffer.from(live.envFor("chat:x", {})[SESSION_VAR], "base64url").toString("utf8")).id as string;
      assert.equal(live.accept(JSON.stringify({ id, url: "http://localhost/" })), true);
      assert.deepEqual(opened, ["chat:x"]);
    } finally { live.stop(); }
  } finally { door.stop(); }
  assert.deepEqual(door.envFor("code:t1", {}), {}, "stopped");
  const bare = new ComputerDoor({ path: path.join(dir, "f.sock"), open: () => {}, log: () => {} });
  assert.equal(await bare.start(), true);
  try { assert.deepEqual(bare.envFor("code:t1", {}), {}, "no opener to point at"); } finally { bare.stop(); }
});

test("envFor gives none while the Computer surface is off", async () => {
  const dir = shortDir();
  let on = false;
  const door = new ComputerDoor({ path: path.join(dir, "d.sock"), open: () => {}, log: () => {}, opener: path.join(dir, "unidex-open.js"), enabled: () => on });
  assert.equal(await door.start(), true);
  try {
    assert.deepEqual(door.envFor("code:t1", {}), {});
    on = true;
    assert.equal(Object.keys(door.envFor("code:t1", {})).length, 3);
    on = false;
    assert.deepEqual(door.envFor("code:t1", {}), {}, "off again");
  } finally { door.stop(); }
});

test("openerPath uses the path as it is only when a shell would read it as one word", () => {
  const tmp = shortDir();
  const userData = path.join(shortDir(), "ud");
  for (const name of ["a(b)", "it's", "a$b", "a;b", "a&b", "a`b", "a\"b", "a*b", "a#b"]) {
    const res = path.join(shortDir(), name);
    fs.mkdirSync(path.join(res, "opener"), { recursive: true });
    fs.writeFileSync(path.join(res, "opener", "unidex-open.js"), `// ${name}\n`);
    const got = openerPath({ resources: res, tmp, userData });
    assert.ok(got && got !== path.join(res, "opener", "unidex-open.js") && got.startsWith(tmp), name);
    assert.ok(/^[A-Za-z0-9._/@%+=:,-]+$/.test(got), `${name} -> ${got}`);
    assert.equal(fs.readFileSync(got, "utf8"), `// ${name}\n`, "a stale copy is replaced");
  }
  const safe = path.join(shortDir(), "Res-1.0_x+y@z,w:v=%");
  fs.mkdirSync(path.join(safe, "opener"), { recursive: true });
  fs.writeFileSync(path.join(safe, "opener", "unidex-open.js"), "x\n");
  assert.equal(openerPath({ resources: safe, tmp, userData }), path.join(safe, "opener", "unidex-open.js"));
});

test("openerPath makes no copy in a folder that is a link", () => {
  const res = path.join(shortDir(), "has space");
  fs.mkdirSync(path.join(res, "opener"), { recursive: true });
  fs.writeFileSync(path.join(res, "opener", "unidex-open.js"), "x\n");
  const tmp = shortDir();
  const userData = path.join(shortDir(), "ud");
  const elsewhere = shortDir();
  fs.symlinkSync(elsewhere, shortDirIn(userData, tmp));
  assert.equal(openerPath({ resources: res, tmp, userData }), null);
  assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing was written through the link");
});

test("openerPath uses a copy when its own path holds whitespace", () => {
  const plain = shortDir();
  fs.mkdirSync(path.join(plain, "opener"));
  fs.writeFileSync(path.join(plain, "opener", "unidex-open.js"), "#!/usr/bin/env node\n");
  const tmp = shortDir();
  const userData = path.join(shortDir(), "ud");
  assert.equal(openerPath({ resources: plain, tmp, userData }), path.join(plain, "opener", "unidex-open.js"), "no whitespace: its own path");

  const spaced = path.join(shortDir(), "Application Support");
  fs.mkdirSync(path.join(spaced, "opener"), { recursive: true });
  fs.writeFileSync(path.join(spaced, "opener", "unidex-open.js"), "#!/usr/bin/env node\nprocess.exit(0)\n");
  const copy = openerPath({ resources: spaced, tmp, userData });
  assert.ok(copy && !/\s/.test(copy) && copy.startsWith(tmp), String(copy));
  assert.equal(fs.readFileSync(copy, "utf8"), "#!/usr/bin/env node\nprocess.exit(0)\n");
  assert.equal(fs.statSync(copy).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(copy)).mode & 0o777, 0o700);
  assert.equal(openerPath({ resources: spaced, tmp: path.join(tmp, "with space"), userData }), null, "no whitespace-free place: none");
  assert.equal(openerPath({ resources: path.join(plain, "missing"), tmp, userData }), null, "nothing to point at: none");
});

test("an id issued before the page went opens nothing after it, though its key is in use again", () => {
  const { door, opened, msg } = rig();
  const before = door.issue("code:t1");
  door.issue("chat:" + "a".repeat(8));
  door.revokeAll("code:");
  const after = door.issue("code:t1");
  assert.notEqual(before, after);
  assert.equal(door.accept(msg(before, "http://localhost/")), false);
  assert.equal(door.accept(msg(after, "http://localhost/")), true);
  assert.deepEqual(opened, [["code:t1", "http://localhost/"]]);
});

test("openerPath gives null, and writes nothing, when the copy's own path is not shell-safe either", () => {
  const res = path.join(shortDir(), "has space");
  fs.mkdirSync(path.join(res, "opener"), { recursive: true });
  fs.writeFileSync(path.join(res, "opener", "unidex-open.js"), "x\n");
  const userData = path.join(shortDir(), "ud");
  for (const name of ["with space", "with(paren"]) {
    const tmp = path.join(shortDir(), name);
    fs.mkdirSync(tmp);
    assert.equal(openerPath({ resources: res, tmp, userData }), null, name);
    assert.deepEqual(fs.readdirSync(tmp), [], `${name}: nothing was written`);
  }
});
