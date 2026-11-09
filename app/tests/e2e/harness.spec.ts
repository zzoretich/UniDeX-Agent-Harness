// The harness's own promise (harness.ts, the app's processes): once close() returns, nothing the app started still runs.
// Main starts the runtime's refreshes detached and, as it should for a user, leaves them running on quit
// (ProcService.killAttached). One still writing under vault/brain while the next spec file's restoreFixture() deleted it
// failed that restore with ENOTEMPTY (CI: theme.spec.ts after term-writes.spec.ts); one that ends after the restore
// writes into the fresh copy. Stand-ins for such refreshes pin the promise here without depending on timing;
// straggler.cjs forces the race itself with the real scan:
//
//   AOS_E2E_STRAGGLER=1 npx playwright test tests/e2e/term-writes.spec.ts tests/e2e/theme.spec.ts

import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { FX, launchApp, restoreFixture, type AppHandle } from "./harness";

let h: AppHandle | null = null;
let groups: number[] = [];
test.afterEach(async () => {
  await h?.close();
  h = null;
  for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone, as it should be */ } }
  groups = [];
});

/** Starts `script` from main as ProcService starts a refresh (detached, so it leads its own process group); its pid. */
async function startFromMain(app: AppHandle, script: string): Promise<number> {
  const pid = await app.app.evaluate((_e, s) => {
    const cp = process.getBuiltinModule("node:child_process") as typeof import("node:child_process");
    const child = cp.spawn("/bin/sh", ["-c", s], { detached: true, stdio: "ignore" });
    child.unref();
    return child.pid ?? 0;
  }, script);
  expect(pid).toBeGreaterThan(0);
  groups.push(pid);
  return pid;
}

/** Whether anything still runs in process group `pgid`. */
const groupRuns = (pgid: number) => spawnSync("pgrep", ["-g", String(pgid)]).status === 0;

test("close() returns only once what the app left running has ended", async () => {
  restoreFixture();
  h = await launchApp();
  const app = h.app.process().pid;
  // Writes into the vault half a second after the app has quit, as a slow scan's write phase does.
  const late = FX.v("brain/_index/e2e-late.txt");
  const pid = await startFromMain(h, `while kill -0 ${app} 2>/dev/null; do sleep 0.05; done; sleep 0.5; echo done > '${late}'`);
  await h.close();
  h = null;
  expect(fs.existsSync(late) && fs.readFileSync(late, "utf8")).toBe("done\n");
  expect(groupRuns(pid)).toBe(false);
});

test("close() kills what is still running after the grace, with its children", async () => {
  restoreFixture();
  h = await launchApp();
  // Would run on for a minute, through a child of its own (as the scan's git).
  const pid = await startFromMain(h, "sleep 60; exit 0");
  await expect.poll(() => spawnSync("pgrep", ["-g", String(pid)], { encoding: "utf8" }).stdout.trim().split("\n").length).toBe(2);
  await h.close({ graceMs: 1_000 });
  h = null;
  expect(groupRuns(pid)).toBe(false);
});

test("close() after the app quit by itself returns without an error, as the R46 spec leaves it (R73)", async () => {
  restoreFixture();
  h = await launchApp();
  const proc = h.app.process();
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const closed = h.app.waitForEvent("close");
  await h.app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await exited;
  // Playwright has let the app's handle go once it saw the app close: what useApp's afterAll then meets.
  await closed;
  await h.close();
  await h.close();
});
