import { test } from "node:test";
import assert from "node:assert/strict";
import { CARRIED, MEMORY, RESERVE, SITES, SecretMemory } from "../../src/main/computer/memory";

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

test("eviction keeps the most recent 64 one-time-code and 64 password values per site out of the cap", () => {
  const m = new SecretMemory();
  m.remember(A, { values: ["realpass"], whole: ["111111"] });
  m.remember(B, { values: codes(300, "pw"), whole: [] });
  assert.ok(m.size() <= MEMORY + RESERVE, `bounded: ${m.size()}`);
  const b = m.pool([B]).values;
  assert.deepEqual(b.slice(-RESERVE), codes(300, "pw").slice(-RESERVE), "the most recent 64 passwords of site B are kept");
  assert.ok(!b.includes("pw0000"), "the oldest filler went");
  const a = m.pool([A]);
  assert.ok(a.values.includes("realpass") && a.whole.includes("111111"), "site A's own recent values are protected from site B's flood");
  m.remember(B, { values: [], whole: codes(300, "ot") });
  assert.deepEqual(m.pool([B]).whole.slice(-RESERVE), codes(300, "ot").slice(-RESERVE), "and the most recent 64 one-time codes");
  assert.ok(m.pool([B]).values.length >= RESERVE, "without pushing out site B's protected passwords");
  assert.ok(m.pool([A]).values.includes("realpass"), "site A still intact");
});

test("values carried from another site scrub URL strings only, never a site's pool (R35)", () => {
  // T1: an attacker site plants "Delete" and "account" and navigates to the victim with them in the query.
  const m = new SecretMemory();
  m.remember(A, { values: ["account"], whole: ["Delete"] });
  m.carry(["Delete", "account", " ", "••••"]);
  assert.deepEqual(m.pool([B]), { values: [], whole: [] }, "nothing of the attacker's reaches the victim site's pool");
  assert.deepEqual(m.carried(), ["Delete", "account"], "the carried set, for URLs only");
  m.carry(codes(100, "u"));
  assert.equal(m.carried().length, CARRIED, "the carried set is capped");
  assert.deepEqual(m.carried().slice(-3), codes(100, "u").slice(-3), "oldest carried values go first");
  assert.ok(!m.carried().includes("Delete"));
  m.carry(["u0099"]);
  assert.equal(m.carried().length, CARRIED, "re-carrying a value keeps one copy");
  assert.equal(m.carried().at(-1), "u0099", "and makes it the most recent");
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

test("memory is bounded across sites: at most 16 sites per tab, the least recently used evicted first, never the one kept (B3)", () => {
  const m = new SecretMemory();
  const site = (i: number) => `https://h${i}.evil.test`;
  for (let i = 0; i < 50; i++) m.remember(site(i), { values: codes(64, `pw${i}-`), whole: codes(64, `ot${i}-`) });
  assert.ok(m.sites() <= SITES, `sites: ${m.sites()}`);
  assert.ok(m.size() <= SITES * 2 * RESERVE, `values: ${m.size()} (the stated bound)`);
  assert.deepEqual(m.pool([site(0)]), { values: [], whole: [] }, "the oldest site went");
  assert.equal(m.pool([site(49)]).whole.length, 64, "the newest stays whole");
  // The current site is never evicted, even when it is the least recently used.
  for (let i = 100; i < 140; i++) m.remember(site(i), { values: ["x"], whole: [] }, site(49));
  assert.equal(m.pool([site(49)]).whole.length, 64, "the kept site survives forty newer sites");
  assert.ok(m.sites() <= SITES);
  // Touching a site makes it recent again.
  const n = new SecretMemory();
  for (let i = 0; i < SITES; i++) n.remember(site(i), { values: ["v"], whole: [] });
  n.remember(site(0), { values: ["w"], whole: [] });
  n.remember(site(99), { values: ["z"], whole: [] });
  assert.deepEqual(n.pool([site(0)]).values, ["v", "w"], "site 0 was touched, so site 1 went instead");
  assert.deepEqual(n.pool([site(1)]), { values: [], whole: [] });
});
