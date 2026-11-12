import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ComputerDoor, DOOR_IDLE_MS, doorSocketPath } from "../../src/main/computer/door";
import type { Clock } from "../../src/main/computer/asks";

// session-browser S4: the door a session's programs knock on to ask for one page. Ids are opaque to the door; the
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

async function boot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aos-dr-"));
  made.push(d);
  const sock = path.join(d, "computer", "door.sock");
  const opened: Array<[string, string]> = [];
  const logs: string[] = [];
  const door = new ComputerDoor({ path: sock, open: (s, u) => opened.push([s, u]), log: (l) => logs.push(l) });
  assert.equal(await door.start(), true);
  assert.equal(door.listening(), true);
  return { door, sock, opened, logs };
}
function talk(sock: string, send: string | null): Promise<{ data: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let data = "";
    const c = net.connect(sock);
    c.setEncoding("utf8");
    c.on("connect", () => { if (send !== null) c.write(send); });
    c.on("data", (s) => { data += s; });
    c.on("error", () => {});
    c.on("close", () => resolve({ data, ms: Date.now() - t0 }));
  });
}

test("junk, an oversize line and a silent connection are closed", async () => {
  const { door, sock, opened, logs } = await boot();
  try {
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
    const id = door.issue("code:t1");
    assert.equal((await talk(sock, `${JSON.stringify({ id, url: "http://localhost:1/" })}\n`)).data, '{"ok":true}\n');
    assert.deepEqual(opened, [["code:t1", "http://localhost:1/"]]);
    assert.equal((await talk(sock, "junk\n")).data, '{"ok":false}\n');
    assert.equal((await talk(sock, "a".repeat(17 * 1024))).data, "");
    const quiet = await talk(sock, null);
    assert.equal(quiet.data, "");
    assert.ok(quiet.ms >= DOOR_IDLE_MS - 200 && quiet.ms < DOOR_IDLE_MS + 1500, `closed after ${quiet.ms} ms`);
    assert.deepEqual(logs, []);
  } finally {
    door.stop();
  }
  assert.equal(door.listening(), false);
  assert.equal(fs.existsSync(sock), false);
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
