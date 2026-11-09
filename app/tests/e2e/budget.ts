// The extra time a test or hook asks for while it runs (harness.ts fixtureForToday: the wait for midnight, then the
// fixture's rebuild), kept apart from harness.ts so a unit test can hold it to Playwright's rules. Inside a beforeAll,
// Playwright's `test.info().timeout` reads the test's own budget, not the hook's, while `test.setTimeout()` sets the
// hook's: each `setTimeout(info().timeout + ms)` therefore replaced the hook's budget instead of adding to it, and a run
// that waited 184 s for midnight then got 60 + 120 s in all for the rebuild, already spent (CI, 2026-11-09 00:00 UTC).

/** The part of Playwright's `test` this needs. */
export interface Budgeted { info(): { timeout: number }; setTimeout(ms: number): void }

/** Gives the running test or hook `ms` more on each call, every extension added to the budget it had at the first call.
 *  Outside a test or hook (no budget to extend) it does nothing. */
export function extender(t: Budgeted): (ms: number) => void {
  let base: number | null = null;
  let extra = 0;
  return (ms) => {
    try {
      base ??= t.info().timeout;
      extra += ms;
      t.setTimeout(base + extra);
    } catch { /* outside a test or hook */ }
  };
}
