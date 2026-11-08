import { test } from "node:test";
import assert from "node:assert/strict";
import { LEAVING, LOST_SITES, LOST_VALUES, LeavingRecords, mergeDepartures, PendingReads, type Departure } from "../../src/main/computer/leaving";
import type { Secrets } from "../../src/main/computer/memory";

const A = "http://localhost:1/done?code=975310", B = "http://127.0.0.1:1/start?b=1", C = "http://localhost:1/later?code=975310";
const dep = (values: string[] | null, from = "http://127.0.0.1:1"): Departure => ({ from: [from], read: Promise.resolve(values && { values, whole: [] }) });
const kinds = (c: { kind: string; own: Departure[]; others: Departure[] }) => ({ kind: c.kind, own: c.own.length, others: c.others.length });
const reads = async (ds: Departure[]): Promise<(Secrets | null)[]> => Promise.all(ds.map((d) => d.read));

test("starting another navigation never overwrites an earlier record; each commit consumes only its own (agent-computer D9, R39)", () => {
  // r40b q1': the old document starts A, then B before A commits; Chromium still commits A, then B.
  const l = new LeavingRecords();
  const a = dep(["975310"]), b = dep([]);
  l.start(A, a); l.start(B, b);
  assert.equal(l.size, 2, "B kept A's record");
  const ca = l.commit(A);
  assert.equal(ca.kind, "page"); assert.deepEqual(ca.own, [a], "A commits with its own record"); assert.deepEqual(ca.others, []);
  assert.equal(l.size, 1, "B's record stays: a navigation started before this commit can still commit after it");
  assert.deepEqual(l.commit(B).own, [b]);
  assert.equal(l.size, 0);
  assert.deepEqual(kinds(l.commit("http://localhost:1/x")), { kind: "none", own: 0, others: 0 }, "nothing pending: an ordinary commit");
});

test("a commit out of start order still finds its record, and the others stay", () => {
  const l = new LeavingRecords();
  const a = dep(["a"]), b = dep(["b"]), c = dep(["c"]);
  l.start(A, a); l.start(B, b); l.start(C, c);
  assert.deepEqual(l.commit(B).own, [b]);
  assert.deepEqual(l.commit(C).own, [c]);
  assert.deepEqual(l.commit(A).own, [a]);
  assert.equal(l.size, 0);
});

test("a redirect re-keys only the latest record, and only while it is the latest navigation started", () => {
  const l = new LeavingRecords();
  const a = dep(["a"]), b = dep(["b"]);
  l.start(A, a); l.start(B, b);
  l.redirect(C);
  assert.deepEqual(l.commit(A).own, [a], "the earlier record kept its key");
  assert.deepEqual(l.commit(C).own, [b], "the latest record follows the redirect");
  // A navigation with no record (not http or https) started after it: a redirect then is that navigation's.
  const m = new LeavingRecords();
  m.start(A, a); m.start(null);
  m.redirect(C);
  assert.deepEqual(m.commit(A).own, [a], "not re-keyed");
  // The agent's own load (from main, no record) is the latest: its redirect re-keys its own entry, not the page's.
  const n = new LeavingRecords();
  n.start(A, a); n.start(B);
  n.redirect(C);
  assert.equal(n.commit(C).kind, "main", "the agent's load followed its redirect");
  assert.deepEqual(n.commit(A).own, [a]);
  // Once the latest navigation has committed, a stray redirect re-keys nothing.
  const o = new LeavingRecords();
  o.start(A, a); o.start(B, b);
  o.commit(B);
  o.redirect(C);
  assert.deepEqual(o.commit(A).own, [a]);
});

test("the agent's own load is main, never hidden, and carries what its URL holds from page records still pending (R37 N4, R38 o1, R40)", () => {
  // o1 delay=0: the agent's load cancels the page's navigation; the page record lingers until loading stops.
  const l = new LeavingRecords();
  const a = dep(["975310"]);
  l.start(A, a); l.start(B);
  const c = l.commit(B);
  assert.equal(c.kind, "main");
  assert.deepEqual(c.own, []);
  assert.deepEqual(c.others, [a], "a page commit whose own entry went elsewhere and took the agent's: what the URL holds from it is carried");
  assert.equal(l.size, 1, "the cancelled page navigation's record waits for did-stop-loading");
  l.stop();
  assert.equal(l.size, 0);
  // o1 delay 10-50 ms: the page navigation was past the point of cancelling and commits first.
  const m = new LeavingRecords();
  m.start(A, a); m.start(B);
  assert.deepEqual(m.commit(A).own, [a]);
  assert.deepEqual(kinds(m.commit(B)), { kind: "main", own: 0, others: 0 }, "nothing pending: the agent's commit carries nothing");
});

test("with the same URL pending more than once, a commit carries the union of its page records and consumes the oldest (R40)", () => {
  const l = new LeavingRecords();
  const r1 = dep(["one"]), r2 = dep(["two"]);
  l.start(A); l.start(A, r1); l.start(A, r2);
  const c1 = l.commit(A);
  assert.equal(c1.kind, "page");
  assert.deepEqual(c1.own, [r1, r2], "both page records keyed at the URL are carried");
  assert.deepEqual(l.commit(A).own, [r2], "the second commit at the URL still finds a record");
  assert.equal(l.commit(A).kind, "main");
});

test("a commit no record matches fails closed while a page record could be it (an unseen redirect), and drops nothing", () => {
  const l = new LeavingRecords();
  const a = dep(["975310"]);
  l.start(A, a); l.start(B);
  const c = l.commit("http://localhost:1/elsewhere?code=975310");
  assert.equal(c.kind, "unknown"); assert.deepEqual(c.others, [a]);
  assert.equal(l.size, 2, "the records stay: their navigations may still commit");
  assert.equal(l.commit(B).kind, "main");
  // Only main-started entries pending: such a commit carries nothing and is not hidden.
  const m = new LeavingRecords();
  m.start(B);
  assert.equal(m.commit("http://127.0.0.1:1/other").kind, "none");
});

test("the bound folds every dropped page record into one lost record, so eviction never loses a read value (R40, review s7p)", async () => {
  // s7p: A (a code in its path) is past ready-to-commit; the same document starts ten more before A commits.
  const l = new LeavingRecords();
  const a = dep(["975310"]);
  l.start("http://localhost:1/v/975310", a);
  for (let i = 0; i < 10; i++) l.start(`http://127.0.0.1:1/start?i=${i}`, dep([`decoy${i}`]));
  assert.equal(l.size, LEAVING);
  const c = l.commit("http://localhost:1/v/975310");
  assert.equal(c.kind, "unknown", "A's own entry went to the bound: fail closed");
  const got = await reads(c.others);
  assert.ok(got.some((s) => s?.values.includes("975310")), "A's read value is still carried, from the lost record");
  assert.ok(got.some((s) => s?.values.includes("decoy1")) && got.some((s) => s?.values.includes("decoy9")), "the other dropped records and the pending ones too");
  // Every commit until loading stops carries from the lost record, even with the list empty.
  for (let i = 2; i < 10; i++) l.commit(`http://127.0.0.1:1/start?i=${i}`);
  assert.equal(l.size, 0);
  const late = l.commit("http://localhost:1/x");
  assert.equal(late.kind, "unknown");
  assert.equal(late.others.length, 1);
  assert.deepEqual((await late.others[0].read)?.values, ["975310", "decoy0", "decoy1"], "A and the two others the bound dropped, merged in drop order");
  l.stop();
  assert.equal(l.commit("http://localhost:1/x").kind, "none", "loading stopped: nothing is pending");
  // Dropping an entry from main loses no record.
  const m = new LeavingRecords();
  for (let i = 0; i <= LEAVING; i++) m.start(`http://a.test/${i}`, i === 0 ? null : dep([`v${i}`]));
  for (let i = 1; i <= LEAVING; i++) m.commit(`http://a.test/${i}`);
  assert.equal(m.commit("http://a.test/0").kind, "none");
});

test("a merged record keeps distinct values up to LOST_VALUES (oldest first), the sites it left up to LOST_SITES, and fails only when every read failed", async () => {
  const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const m1 = mergeDepartures(dep(["x", "y"], "https://a.test"), dep(["y", "z"], "https://b.test"));
  assert.deepEqual(await m1.read, { values: ["x", "y", "z"], whole: [] });
  assert.deepEqual(m1.from, ["https://a.test", "https://b.test"]);
  const m2 = mergeDepartures(dep(null), { from: ["https://a.test"], read: Promise.resolve({ values: [], whole: ["123456"] }) });
  assert.deepEqual(await m2.read, { values: [], whole: ["123456"] }, "one failed read keeps the other's values, kinds kept");
  assert.equal(await mergeDepartures(dep(null), dep(null)).read, null, "all failed: null");
  const big = mergeDepartures(dep(many("old", LOST_VALUES)), dep(["newest"]));
  const vals = (await big.read)!.values;
  assert.equal(vals.length, LOST_VALUES); assert.ok(vals.includes("old0") && !vals.includes("newest"), "the oldest values are the ones kept");
  let d = dep(["v"], "https://s0.test");
  for (let i = 1; i < 40; i++) d = mergeDepartures(d, dep(["v"], `https://s${i}.test`));
  assert.equal(d.from.length, LOST_SITES); assert.equal(d.from[0], "https://s0.test", "the oldest sites are the ones kept");
});

test("did-stop-loading drops every record, the lost record and the latest mark", () => {
  const l = new LeavingRecords();
  for (let i = 0; i <= LEAVING; i++) l.start(`http://a.test/${i}`, dep(["v"]));
  l.stop();
  assert.equal(l.size, 0);
  l.redirect(C);
  assert.equal(l.commit(C).kind, "none", "no record to re-key after loading stopped");
  assert.equal(l.commit("http://a.test/0").kind, "none", "and no lost record");
});

test("a commit ends every pending leaving read of the tab with null, and a read that answered keeps its value (R40, review rv5)", async () => {
  const p = new PendingReads();
  const done = p.track(Promise.resolve({ values: ["975310"], whole: [] }));
  let release!: (v: Secrets) => void;
  const held = p.track(new Promise<Secrets | null>((r) => { release = r; }));
  assert.deepEqual(await done, { values: ["975310"], whole: [] }, "answered before the commit: kept");
  p.endAll();
  assert.equal(await held, null, "held by DevTools across the commit: ended with null, not waited for");
  release({ values: ["newdoc-pw"], whole: [] });
  assert.equal(await held, null, "a late answer (possibly from the new document) changes nothing");
  const after = p.track(Promise.resolve({ values: ["x"], whole: [] }));
  assert.deepEqual(await after, { values: ["x"], whole: [] }, "a read started after the commit is its own");
  // A merged record whose parts were ended resolves at once, with the values the answered parts held. (An answer and a
  // commit arrive as separate tasks, so the answered read has settled when the commit comes: one turn of the loop here.)
  const q = new PendingReads();
  const merged = mergeDepartures({ from: ["a"], read: q.track(Promise.resolve({ values: ["975310"], whole: [] })) }, { from: ["a"], read: q.track(new Promise<Secrets | null>(() => {})) });
  await new Promise((r) => setImmediate(r));
  q.endAll();
  assert.deepEqual(await merged.read, { values: ["975310"], whole: [] });
});
