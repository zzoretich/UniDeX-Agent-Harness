// The e2e harness's time extensions (tests/e2e/budget.ts), held to Playwright's rules for a beforeAll hook: the hook runs
// in a time slot of its own that test.setTimeout() sets, while test.info().timeout reads the test's slot (Playwright
// 1.63, worker TimeoutManager: `get timeout()` returns defaultSlot().timeout; setTimeout() sets the running slot's).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extender, type Budgeted } from "../e2e/budget";

/** Playwright's timeout manager as a hook meets it: the test's slot and the running hook's, each 60 s to start with. */
function playwright(): Budgeted & { hook: number } {
  const testSlot = { timeout: 60_000 };
  const hookSlot = { timeout: 60_000 };
  return {
    info: () => ({ timeout: testSlot.timeout }),
    setTimeout: (ms) => { hookSlot.timeout = ms; },
    get hook() { return hookSlot.timeout; },
  };
}

test("two extensions in one beforeAll add up: the wait for midnight (184 s) and then the rebuild (120 s)", () => {
  const pw = playwright();
  const more = extender(pw);
  more(184_000);
  assert.equal(pw.hook, 244_000);
  more(120_000);
  assert.equal(pw.hook, 364_000, "the rebuild's extension is added to the wait's, not put in its place");
});

test("in a test body, where test.info().timeout follows test.setTimeout(), the extensions add up the same way", () => {
  let slot = 60_000;
  const more = extender({ info: () => ({ timeout: slot }), setTimeout: (ms) => { slot = ms; } });
  more(5_000);
  more(120_000);
  assert.equal(slot, 185_000);
});

test("outside a test or hook (test.info() throws), nothing is extended and nothing throws", () => {
  const more = extender({ info: () => { throw new Error("test.info() can only be called while test is running"); }, setTimeout: () => { throw new Error("unreachable"); } });
  assert.doesNotThrow(() => more(1_000));
});
