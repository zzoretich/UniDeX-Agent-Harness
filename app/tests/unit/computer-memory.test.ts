import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY, PINNED, RESERVE, SecretMemory } from "../../src/main/computer/memory";

const A = "https://a.test", B = "https://b.test";
const codes = (n: number, p = "c") => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(4, "0")}`);

test("remembered secrets are scoped to the site they were read on (D9, R32)", () => {
  const m = new SecretMemory();
  m.remember(A, { values: ["hunter2pass", "  12  3456 "], whole: ["777777"] });
  m.remember(B, { values: ["Delete"], whole: ["account"] });
  assert.deepEqual(m.pool([A]), { values: ["hunter2pass", "12 3456"], whole: ["777777"] }, "collapsed and trimmed; one-time codes in whole");
  assert.deepEqual(m.pool([B]), { values: ["Delete"], whole: ["account"] });
  assert.deepEqual(m.pool([A, B]), { values: ["hunter2pass", "12 3456", "Delete"], whole: ["777777", "account"] }, "a navigation's note uses both sites");
  assert.deepEqual(m.pool(["https://c.test"]), { values: [], whole: [] });
  m.remember(A, { values: ["777777", "", "••••••"], whole: [] });
  assert.deepEqual(m.pool([A]).whole, ["777777"], "a value once seen as a one-time code stays one; blanks and bullets are not remembered");
  assert.equal(m.size(), 5);
});

test("eviction keeps the most recent 64 one-time-code and 64 password values per site out of the cap, and pinned URL values always", () => {
  const m = new SecretMemory();
  m.remember(A, { values: ["realpass"], whole: ["111111"] });
  m.pin(A, ["fromurl1"]);
  m.remember(B, { values: codes(300, "pw"), whole: [] });
  assert.ok(m.size() <= MEMORY + RESERVE, `bounded: ${m.size()}`);
  const b = m.pool([B]).values;
  assert.equal(b.length >= RESERVE, true);
  assert.deepEqual(b.slice(-RESERVE), codes(300, "pw").slice(-RESERVE), "the most recent 64 passwords of site B are kept");
  assert.ok(!b.includes("pw0000"), "the oldest filler went");
  const a = m.pool([A]);
  assert.ok(a.values.includes("realpass") && a.whole.includes("111111"), "site A's own recent values are protected from site B's flood");
  assert.ok(a.whole.includes("fromurl1"), "a pinned URL value is never evicted");
  m.remember(B, { values: [], whole: codes(300, "ot") });
  assert.deepEqual(m.pool([B]).whole.slice(-RESERVE), codes(300, "ot").slice(-RESERVE), "and the most recent 64 one-time codes");
  assert.ok(m.pool([B]).values.length >= RESERVE, "without pushing out site B's protected passwords");
  assert.ok(m.pool([A]).values.includes("realpass"), "site A still intact");
  m.pin(A, codes(40, "u"));
  const pins = m.pool([A]).whole.filter((v) => v.startsWith("u"));
  assert.equal(pins.length, PINNED, "pinned values are capped per site");
  assert.deepEqual(pins, codes(40, "u").slice(-PINNED), "oldest pins go first");
});

test("a popup inherits its opener's entries for the opener's site only", () => {
  const m = new SecretMemory();
  m.remember(A, { values: ["pa"], whole: ["111111"] });
  m.remember(B, { values: ["pb"], whole: [] });
  const n = new SecretMemory();
  n.inherit(m, A);
  assert.deepEqual(n.pool([A]), { values: ["pa"], whole: ["111111"] });
  assert.deepEqual(n.pool([B]), { values: [], whole: [] });
});
