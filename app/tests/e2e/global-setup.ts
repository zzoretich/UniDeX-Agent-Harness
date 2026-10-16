// Builds the synthetic fixture once per run (scripts/make-fixture-vault.mjs) and keeps a pristine copy that every spec
// file restores from (harness.ts restoreFixture builds it again when the run has crossed midnight since).
// AOS_E2E_REUSE_FIXTURE=1 skips the generator when a fixture from today already exists.
// AOS_E2E_FIXTURE_DAYS_AGO=<n> builds it as if <n> days ago (the generator and its runtime runs on a clock moved back,
// tests/e2e/clock-shift.cjs): what a run that crosses midnight between the build and a spec file meets.

import * as fs from "node:fs";
import * as path from "node:path";
import { FX, buildFixture } from "./harness";

export default async function globalSetup(): Promise<void> {
  const expectedFile = path.join(FX.root, "expected.json");
  const today = new Date().toDateString();
  // Reuse needs the pristine copy too: the live vault/ and home/ may carry a previous run's edits.
  const reusable = process.env.AOS_E2E_REUSE_FIXTURE === "1" && fs.existsSync(expectedFile) && fs.existsSync(path.join(FX.pristine, "vault"))
    && new Date(JSON.parse(fs.readFileSync(expectedFile, "utf8")).generatedAt).toDateString() === today;
  if (reusable) return;
  const daysAgo = Number(process.env.AOS_E2E_FIXTURE_DAYS_AGO) || 0;
  if (daysAgo) console.log(`fixture: built as if ${daysAgo} day(s) ago (AOS_E2E_FIXTURE_DAYS_AGO)`);
  buildFixture(daysAgo
    ? { ...process.env, AOS_E2E_CLOCK_SHIFT_MS: String(-daysAgo * 86_400_000), NODE_OPTIONS: `--require ${path.join(__dirname, "clock-shift.cjs")}` }
    : process.env);
}
