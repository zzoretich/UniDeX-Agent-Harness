// e2e only: moves this process's clock by AOS_E2E_CLOCK_SHIFT_MS (milliseconds, negative for the past), for
// `AOS_E2E_FIXTURE_DAYS_AGO`: global-setup.ts runs the fixture generator under it (`node --require`), and the generator
// hands it to every runtime run it makes, so the fixture is built as if on an earlier day. The app never loads it.
"use strict";
const shift = Number(process.env.AOS_E2E_CLOCK_SHIFT_MS) || 0;
if (shift) {
  const Real = Date;
  class Shifted extends Real {
    constructor(...args) {
      if (args.length === 0) super(Real.now() + shift);
      else super(...args);
    }
    static now() { return Real.now() + shift; }
  }
  globalThis.Date = Shifted;
}
