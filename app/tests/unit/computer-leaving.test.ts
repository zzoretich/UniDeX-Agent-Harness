import { test } from "node:test";
import assert from "node:assert/strict";
import { LEAVING, LeavingRecords } from "../../src/main/computer/leaving";

const A = "http://localhost:1/done?code=975310", B = "http://127.0.0.1:1/start?b=1", C = "http://localhost:1/later?code=975310";

test("starting another navigation never overwrites an earlier record; each commit consumes only its own (agent-computer D9, R39)", () => {
  // r40b q1': the old document starts A, then B before A commits; Chromium still commits A, then B.
  const l = new LeavingRecords<string>();
  l.start(A, "readA");
  l.start(B, "readB");
  assert.equal(l.size, 2, "B kept A's record");
  assert.deepEqual(l.commit(A), { kind: "page", record: "readA" }, "A commits with its own record");
  assert.equal(l.size, 1, "B's record stays: a navigation started before this commit can still commit after it");
  assert.deepEqual(l.commit(B), { kind: "page", record: "readB" });
  assert.equal(l.size, 0);
  assert.deepEqual(l.commit("http://localhost:1/x"), { kind: "none" }, "nothing pending: an ordinary commit");
});

test("a commit out of start order still finds its record, and the others stay", () => {
  const l = new LeavingRecords<string>();
  l.start(A, "readA"); l.start(B, "readB"); l.start(C, "readC");
  assert.deepEqual(l.commit(B), { kind: "page", record: "readB" });
  assert.deepEqual(l.commit(C), { kind: "page", record: "readC" });
  assert.deepEqual(l.commit(A), { kind: "page", record: "readA" });
  assert.equal(l.size, 0);
});

test("a redirect re-keys only the latest record, and only while it is the latest navigation started", () => {
  const l = new LeavingRecords<string>();
  l.start(A, "readA"); l.start(B, "readB");
  l.redirect(C);
  assert.deepEqual(l.commit(A), { kind: "page", record: "readA" }, "the earlier record kept its key");
  assert.deepEqual(l.commit(C), { kind: "page", record: "readB" }, "the latest record follows the redirect");
  // A navigation with no record (not http or https) started after it: a redirect then is that navigation's.
  const m = new LeavingRecords<string>();
  m.start(A, "readA"); m.start(null);
  m.redirect(C);
  assert.deepEqual(m.commit(A), { kind: "page", record: "readA" }, "not re-keyed");
  // The agent's own load (from main, no record) is the latest: its redirect re-keys its own entry, not the page's.
  const n = new LeavingRecords<string>();
  n.start(A, "readA"); n.start(B);
  n.redirect(C);
  assert.deepEqual(n.commit(C), { kind: "main" }, "the agent's load followed its redirect");
  assert.deepEqual(n.commit(A), { kind: "page", record: "readA" });
  // Once the latest navigation has committed, a stray redirect re-keys nothing.
  const o = new LeavingRecords<string>();
  o.start(A, "readA"); o.start(B, "readB");
  o.commit(B);
  o.redirect(C);
  assert.deepEqual(o.commit(A), { kind: "page", record: "readA" });
});

test("the agent's own load carries nothing and is never hidden for a page record it raced (R37 N4, R38 o1)", () => {
  // o1 delay=0: the agent's load cancels the page's navigation; the page record lingers until loading stops.
  const l = new LeavingRecords<string>();
  l.start(A, "readA"); l.start(B);
  assert.deepEqual(l.commit(B), { kind: "main" });
  assert.equal(l.size, 1, "the cancelled page navigation's record waits for did-stop-loading");
  l.stop();
  assert.equal(l.size, 0);
  // o1 delay 10-50 ms: the page navigation was past the point of cancelling and commits first.
  const m = new LeavingRecords<string>();
  m.start(A, "readA"); m.start(B);
  assert.deepEqual(m.commit(A), { kind: "page", record: "readA" });
  assert.deepEqual(m.commit(B), { kind: "main" });
});

test("with the same URL pending twice, the page record is consumed first, oldest first", () => {
  const l = new LeavingRecords<string>();
  l.start(A); l.start(A, "read1"); l.start(A, "read2");
  assert.deepEqual(l.commit(A), { kind: "page", record: "read1" });
  assert.deepEqual(l.commit(A), { kind: "page", record: "read2" });
  assert.deepEqual(l.commit(A), { kind: "main" });
});

test("a commit no record matches fails closed while a page record could be it (an unseen redirect), and drops nothing", () => {
  const l = new LeavingRecords<string>();
  l.start(A, "readA"); l.start(B);
  assert.deepEqual(l.commit("http://localhost:1/elsewhere?code=975310"), { kind: "unknown", records: ["readA"] });
  assert.equal(l.size, 2, "the records stay: their navigations may still commit");
  assert.deepEqual(l.commit(B), { kind: "main" });
  // Only main-started entries pending: such a commit carries nothing and is not hidden.
  const m = new LeavingRecords<string>();
  m.start(B);
  assert.deepEqual(m.commit("http://127.0.0.1:1/other"), { kind: "none" });
});

test("the list is bounded: the oldest goes first, and a lost page record keeps unmatched commits closed until loading stops", () => {
  const l = new LeavingRecords<number>();
  for (let i = 0; i <= LEAVING; i++) l.start(`http://a.test/${i}`, i);
  assert.equal(l.size, LEAVING);
  assert.deepEqual(l.commit("http://a.test/0"), { kind: "unknown", records: [1, 2, 3, 4, 5, 6, 7, 8] }, "the dropped record's commit fails closed");
  for (let i = 1; i <= LEAVING; i++) assert.deepEqual(l.commit(`http://a.test/${i}`), { kind: "page", record: i });
  assert.deepEqual(l.commit("http://a.test/x"), { kind: "unknown", records: [] }, "still closed with the list empty: a lost record's navigation may commit");
  l.stop();
  assert.deepEqual(l.commit("http://a.test/x"), { kind: "none" }, "loading stopped: nothing is pending");
  // Dropping an entry from main loses no record.
  const m = new LeavingRecords<number>();
  for (let i = 0; i <= LEAVING; i++) m.start(`http://a.test/${i}`, i === 0 ? null : i);
  for (let i = 1; i <= LEAVING; i++) m.commit(`http://a.test/${i}`);
  assert.deepEqual(m.commit("http://a.test/0"), { kind: "none" });
});

test("did-stop-loading drops every record and the latest mark", () => {
  const l = new LeavingRecords<string>();
  l.start(A, "readA"); l.start(B, "readB");
  l.stop();
  assert.equal(l.size, 0);
  l.redirect(C);
  assert.deepEqual(l.commit(C), { kind: "none" }, "no record to re-key after loading stopped");
  assert.deepEqual(l.commit(A), { kind: "none" });
});
