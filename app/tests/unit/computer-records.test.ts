import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserRecords, orphanKey, FILE_MAX, ORPHAN_MAX, TABS_MAX, type Conversation } from "../../src/main/computer/records";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aos-records-"));
  dirs.push(d);
  return path.join(d, "computer", "browsers.json");
};
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const X: Conversation = { host: "claude", id: "conv-x" };
const rec = (over: Partial<{ on: boolean; tabs: string[]; active: number; conversation: Conversation }> = {}) =>
  ({ on: true, tabs: ["https://a.test/"], active: 0, ...over });

test("put then get, across a new instance", () => {
  const f = tmp();
  new BrowserRecords({ file: f, now: () => 1000 }).put("chat:T", rec({ tabs: ["https://a.test/", "http://b.test/x"], active: 1 }));
  const got = new BrowserRecords({ file: f }).get("chat:T");
  assert.deepEqual(got, { on: true, tabs: ["https://a.test/", "http://b.test/x"], active: 1, at: 1000 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["browsers.json"]);
});

test("a damaged file reads as empty", () => {
  for (const body of ["{", "", Buffer.alloc(5 * 1024 * 1024, 0x20), JSON.stringify({ schema: 2, browsers: {} })]) {
    const f = tmp(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body);
    const lines: string[] = [];
    const r = new BrowserRecords({ file: f, log: (l) => lines.push(l) });
    assert.deepEqual(r.keys(), []);
    assert.deepEqual(r.keys(), []);
    assert.equal(lines.length, 1, "logged once");
    r.put("chat:T", rec());
    assert.deepEqual(new BrowserRecords({ file: f }).get("chat:T")?.tabs, ["https://a.test/"]);
  }
});

test("a record keeps only web addresses", () => {
  const r = new BrowserRecords({ file: tmp() });
  r.put("chat:T", rec({ tabs: ["https://a.test/", "file:///etc/hosts", "javascript:alert(1)", "about:blank", 7 as unknown as string], active: 3 }));
  assert.deepEqual(r.get("chat:T")?.tabs, ["https://a.test/"]);
  assert.equal(r.get("chat:T")?.active, 0);
  r.put("chat:U", rec({ tabs: Array.from({ length: 60 }, (_, i) => `https://a.test/${i}`), active: 55 }));
  assert.equal(r.get("chat:U")?.tabs.length, TABS_MAX);
  assert.equal(r.get("chat:U")?.active, 0);
  // the same cleaning applies to a file written by hand
  const f = tmp(); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ schema: 1, browsers: {
    a: { on: true, tabs: ["https://a.test/", "file:///x"], active: 1, at: 5 },
    b: { on: "yes", tabs: [], active: 0, at: 5 },
    c: { on: true, tabs: [], active: 0, at: "5" },
  } }));
  const h = new BrowserRecords({ file: f });
  assert.deepEqual(h.keys(), ["a"]);
  assert.equal(h.get("a")?.active, 0);
});

test("orphanCode re-keys by conversation and drops the rest", () => {
  const r = new BrowserRecords({ file: tmp() });
  r.put("code:1", rec({ conversation: X }));
  r.put("code:2", rec());
  r.put("chat:T", rec());
  r.orphanCode();
  assert.deepEqual(r.keys().sort(), [orphanKey(X), "chat:T"].sort());
  assert.equal(r.get(orphanKey(X))?.on, false);
  assert.equal(r.get("chat:T")?.on, true);
  // two code records of one conversation: the newer wins
  let t = 1;
  const q = new BrowserRecords({ file: tmp(), now: () => t });
  q.put("code:1", rec({ tabs: ["https://old.test/"], conversation: X })); t = 2;
  q.put("code:2", rec({ tabs: ["https://new.test/"], conversation: X }));
  q.orphanCode();
  assert.deepEqual(q.get(orphanKey(X))?.tabs, ["https://new.test/"]);
});

test("adopt gives the orphan to a key once, off", () => {
  const r = new BrowserRecords({ file: tmp() });
  r.put("code:1", rec({ tabs: ["https://a.test/"], conversation: X }));
  r.orphanCode();
  const got = r.adopt("code:9", X);
  assert.deepEqual(got?.tabs, ["https://a.test/"]);
  assert.equal(got?.on, false);
  assert.equal(r.get("code:9")?.on, false);
  assert.equal(r.get(orphanKey(X)), undefined);
  assert.equal(r.adopt("code:10", X), undefined);
  r.put("code:2", rec({ conversation: X })); r.orphanCode();
  r.put("code:11", rec());
  assert.equal(r.adopt("code:11", X), undefined);
  assert.notEqual(r.get(orphanKey(X)), undefined, "a refused adopt leaves the orphan");
});

test("orphans expire after 30 days and only the 200 newest stay", () => {
  const DAY = 24 * 60 * 60 * 1000;
  let t = 1_000_000;
  const r = new BrowserRecords({ file: tmp(), now: () => t });
  r.put("code:old", rec({ conversation: { host: "codex", id: "old" } }));
  r.orphanCode();
  assert.deepEqual(r.keys(), [orphanKey({ host: "codex", id: "old" })]);
  t += 31 * DAY;
  r.orphanCode();
  assert.deepEqual(r.keys(), [], "31 days on, it has expired");
  for (let i = 0; i < 250; i++) { t += 1; r.put(`code:${i}`, rec({ conversation: { host: "claude", id: `c${i}` } })); }
  r.put("chat:T", rec());
  r.orphanCode();
  const orphans = r.keys().filter((k) => k.startsWith("orphan:"));
  assert.equal(orphans.length, ORPHAN_MAX);
  assert.ok(orphans.includes(orphanKey({ host: "claude", id: "c249" })));
  assert.ok(!orphans.includes(orphanKey({ host: "claude", id: "c0" })), "the oldest went");
  assert.ok(r.keys().includes("chat:T"), "chat records are never touched");
});

test("move re-keys; forget removes", () => {
  const f = tmp();
  const r = new BrowserRecords({ file: f });
  r.put("code:1", rec());
  r.move("code:1", "chat:T");
  assert.equal(r.get("code:1"), undefined);
  assert.deepEqual(r.get("chat:T")?.tabs, ["https://a.test/"]);
  r.move("nope", "chat:U");
  assert.deepEqual(r.keys(), ["chat:T"]);
  assert.deepEqual(new BrowserRecords({ file: f }).keys(), ["chat:T"]);
  r.forget("chat:T");
  assert.deepEqual(new BrowserRecords({ file: f }).keys(), []);
});

test("an address longer than 8,192 characters is dropped, so the file stays under its cap", () => {
  const f = tmp();
  const r = new BrowserRecords({ file: f });
  const huge = `https://a.test/${"x".repeat(9000)}`;
  r.put("chat:T", rec({ tabs: ["https://a.test/", huge, `https://a.test/${"y".repeat(8100)}`], active: 0 }));
  assert.equal(r.get("chat:T")?.tabs.length, 2);
  assert.ok(!r.get("chat:T")?.tabs.includes(huge));
});

test("active still points at the same tab when non-web tabs are dropped, or at the first when that tab was dropped", () => {
  const f = tmp();
  const r = new BrowserRecords({ file: f });
  r.put("chat:T", rec({ tabs: ["about:blank", "https://a.test/", "javascript:1", "https://b.test/"], active: 3 }));
  assert.deepEqual(r.get("chat:T")?.tabs, ["https://a.test/", "https://b.test/"]);
  assert.equal(r.get("chat:T")?.active, 1);
  r.put("chat:U", rec({ tabs: ["https://a.test/", "javascript:1", "https://b.test/"], active: 1 }));
  assert.equal(r.get("chat:U")?.active, 0, "the active tab was dropped");
});

test("a read problem and a write problem are each logged once", () => {
  const f = tmp();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "{");
  const lines: string[] = [];
  const r = new BrowserRecords({ file: f, log: (l) => lines.push(l) });
  r.keys();
  fs.rmSync(f);
  fs.mkdirSync(f); // a folder where the file goes: the rename fails
  r.put("chat:T", rec());
  r.put("chat:U", rec());
  assert.equal(lines.filter((l) => /damaged|unreadable|unrecognised/.test(l)).length, 1);
  assert.equal(lines.filter((l) => /saved/.test(l)).length, 1, "the write problem is logged although the read problem was");
});

test("a stale temp file is removed, and a folder and file that existed with wider modes are tightened", () => {
  const f = tmp();
  const dir = path.dirname(f);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(f, JSON.stringify({ schema: 1, browsers: {} }), { mode: 0o644 });
  fs.chmodSync(f, 0o644);
  fs.writeFileSync(`${f}.tmp`, "stale", { mode: 0o666 });
  fs.chmodSync(`${f}.tmp`, 0o666);
  new BrowserRecords({ file: f }).put("chat:T", rec());
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["browsers.json"]);
});

test("move onto a key that has a record replaces it", () => {
  const r = new BrowserRecords({ file: tmp() });
  r.put("code:t1", rec({ tabs: ["https://a.test/"] }));
  r.put("code:t2", rec({ tabs: ["https://old.test/"] }));
  r.move("code:t1", "code:t2");
  assert.deepEqual(r.get("code:t2")?.tabs, ["https://a.test/"]);
  assert.equal(r.get("code:t1"), undefined);
});

test("adopt replaces a record that has no tabs and is off, and refuses one with tabs or one that is on", () => {
  const c: Conversation = { host: "claude", id: "conv-1" };
  const mk = () => new BrowserRecords({ file: tmp() });
  for (const [mine, replaced] of [[{ on: false, tabs: [] as string[], active: 0 }, true], [{ on: false, tabs: ["https://k.test/"], active: 0 }, false], [{ on: true, tabs: [] as string[], active: 0 }, false]] as const) {
    const r = mk();
    r.put("code:t9", { on: true, tabs: ["https://o.test/"], active: 0, conversation: c });
    r.orphanCode();
    r.put("code:t1", { ...mine, tabs: [...mine.tabs] });
    const got = r.adopt("code:t1", c);
    assert.equal(got !== undefined, replaced, JSON.stringify(mine));
    if (replaced) assert.deepEqual([got?.on, got?.tabs], [false, ["https://o.test/"]]);
  }
});

const big = (i: number) => rec({ tabs: Array.from({ length: TABS_MAX }, (_, j) => `https://a.test/${i}-${j}-`.padEnd(8000, "x")) });

test("a file that would be too large to read drops its oldest records, orphans first", () => {
  const f = tmp();
  const lines: string[] = [];
  let t = 0;
  const w = new BrowserRecords({ file: f, now: () => ++t, log: (l) => lines.push(l) });
  const orphans = new Set([5, 6]);
  // Thirty records of about 160 kB: a few must go. The two orphans are not the oldest, so the oldest live one goes too.
  for (let i = 0; i < 30; i++) w.put(orphans.has(i) ? `orphan:claude:o${i}` : `chat:s${i}`, big(i));
  assert.ok(fs.statSync(f).size <= FILE_MAX, "file within FILE_MAX");
  const r = new BrowserRecords({ file: f });
  const keys = r.keys();
  assert.ok(keys.length > 0, "a new store reads records, not an empty map");
  assert.deepEqual(keys.filter((k) => k.startsWith("orphan:")), [], "orphans went first");
  assert.ok(!keys.includes("chat:s0"), "then the oldest live record");
  assert.ok(!keys.includes("chat:s1"), "and the next oldest");
  for (let i = 2; i < 30; i++) if (!orphans.has(i)) assert.ok(keys.includes(`chat:s${i}`), `chat:s${i} survives`);
  assert.deepEqual(lines, ["browser records: too large, the oldest were dropped"]);
});

test("a store under the limit drops nothing and logs nothing", () => {
  const f = tmp();
  const lines: string[] = [];
  const r = new BrowserRecords({ file: f, log: (l) => lines.push(l) });
  r.put("chat:a", big(1));
  r.put("orphan:claude:o", big(2));
  assert.deepEqual(new BrowserRecords({ file: f }).keys().sort(), ["chat:a", "orphan:claude:o"]);
  assert.deepEqual(lines, []);
});

test("the dropped records are gone from the running store too", () => {
  const f = tmp();
  let t = 0;
  const r = new BrowserRecords({ file: f, now: () => ++t });
  for (let i = 0; i < 30; i++) r.put(`chat:s${i}`, big(i));
  assert.equal(r.get("chat:s0"), undefined);
  assert.equal(r.get("chat:s1"), undefined);
  assert.ok(r.get("chat:s29"));
  assert.deepEqual(r.keys(), new BrowserRecords({ file: f }).keys());
});

test("a record's addresses lose any user name and password", () => {
  const f = tmp();
  const r = new BrowserRecords({ file: f });
  r.put("chat:T", rec({ tabs: ["https://user:pass@example.com/x?q=1", "http://u@example.org/"] }));
  assert.deepEqual(r.get("chat:T")?.tabs, ["https://example.com/x?q=1", "http://example.org/"]);
  assert.equal(/user|pass/.test(fs.readFileSync(f, "utf8")), false, "nothing with credentials is written");
  // a hand-edited file is cleaned when read
  fs.writeFileSync(f, JSON.stringify({ schema: 1, browsers: { "chat:H": { on: true, tabs: ["https://user:pass@example.net/"], active: 0, at: 1 } } }));
  assert.deepEqual(new BrowserRecords({ file: f }).get("chat:H")?.tabs, ["https://example.net/"]);
});

test("a record keeps as many tabs as a browser can hold", () => {
  const r = new BrowserRecords({ file: tmp() });
  r.put("chat:V", rec({ tabs: Array.from({ length: 25 }, (_, i) => `https://a.test/${i}`), active: 22 }));
  const got = r.get("chat:V");
  assert.equal(got?.tabs.length, 20);
  assert.equal(TABS_MAX, 20);
  assert.ok((got?.active ?? 99) < 20);
});
