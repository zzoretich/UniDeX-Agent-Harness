// The harness's own promise (harness.ts, the app's processes): once close() returns, nothing the app started still runs.
// Main starts the runtime's refreshes detached and, as it should for a user, leaves them running on quit
// (ProcService.killAttached). One still writing under vault/brain while the next spec file's restoreFixture() deleted it
// failed that restore with ENOTEMPTY (CI: theme.spec.ts after term-writes.spec.ts); one that ends after the restore
// writes into the fresh copy. Stand-ins for such refreshes pin the promise here without depending on timing;
// straggler.cjs forces the race itself with the real scan:
//
//   AOS_E2E_STRAGGLER=1 npx playwright test tests/e2e/term-writes.spec.ts tests/e2e/theme.spec.ts
//
// It also covers a failed launch (launchApp ends the app it started, even one stuck past answering close) and the
// link's clean-up (removeUserDataLink).

import { _electron as electron, expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, REPO, appEnv, endFailedLaunch, USER_DATA, USER_DATA_LINK, installComputerAgents, launchApp, removeUserDataLink, restoreFixture, type AppHandle } from "./harness";

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

// removeUserDataLink (harness.ts): what an app that outlived its launch's failure leaves at the link's path is a real
// folder, which fs.rmSync(link, { force: true }) refuses (EISDIR).
test.describe("removeUserDataLink", () => {
  test.afterEach(() => { removeUserDataLink(); });

  test("removeUserDataLink: a link goes and what it points at stays", () => {
    const kept = path.join(USER_DATA, "link-keeps-me.txt");
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(kept, "still here\n");
    removeUserDataLink();
    fs.symlinkSync(USER_DATA, USER_DATA_LINK);
    removeUserDataLink();
    expect(() => fs.lstatSync(USER_DATA_LINK)).toThrow(/ENOENT/);
    expect(fs.readFileSync(kept, "utf8")).toBe("still here\n");
    fs.rmSync(kept, { force: true });
  });

  test("removeUserDataLink: a real folder left at the link's path goes with what is in it", () => {
    removeUserDataLink();
    fs.mkdirSync(path.join(USER_DATA_LINK, "computer"), { recursive: true });
    fs.writeFileSync(path.join(USER_DATA_LINK, "computer", "left.txt"), "x");
    removeUserDataLink();
    expect(() => fs.lstatSync(USER_DATA_LINK)).toThrow(/ENOENT/);
    // What a later launch's setup does next: it must not meet the folder.
    fs.mkdirSync(path.join(USER_DATA_LINK, "computer"), { recursive: true });
    installComputerAgents();
    expect(fs.lstatSync(USER_DATA_LINK).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(USER_DATA_LINK)).toBe(fs.realpathSync(USER_DATA));
  });

  test("removeUserDataLink: nothing there is fine", () => {
    removeUserDataLink();
    expect(() => removeUserDataLink()).not.toThrow();
    expect(() => fs.lstatSync(USER_DATA_LINK)).toThrow(/ENOENT/);
  });
});

/** Electron processes of this checkout (an app this harness launched, with its helpers), never the owner's own app. */
const launchedHere = () => spawnSync("ps", ["-Aww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout
  .split("\n").filter((l) => l.includes(REPO) && /electron/i.test(l)).map((l) => l.trim());

// The launch that failed must end its app: left running, it outlived the run and made a real folder at the link's path.
test("launchApp: an app whose first window does not come in time is ended, and the launch's own error is what is thrown", async () => {
  test.setTimeout(60_000);
  restoreFixture();
  await expect(launchApp({ firstWindowMs: 1 })).rejects.toThrow(/Timeout 1ms exceeded/);
  await expect.poll(launchedHere, { timeout: 15_000 }).toEqual([]);
});

test("launchApp: after a failed launch the next launch in the same file works", async () => {
  test.setTimeout(120_000);
  restoreFixture();
  h = await launchApp();
  await h.close();
  h = null;
  expect(launchedHere()).toEqual([]);
});

// The path that really happened: a main thread that is stuck does not answer close(). SIGSTOP stops the process as a
// stuck thread would, so the graceful close can never come back and only the kill ends it.
test("launchApp: an app that cannot answer close is killed within the bound", async () => {
  test.setTimeout(60_000);
  restoreFixture();
  const app = await electron.launch({ args: [REPO], cwd: REPO, env: appEnv(), timeout: 60_000 });
  const pid = app.process().pid!;
  // In no handle: whatever throws below, the app (stopped or not) must still be ended, or it outlives the run.
  let ended = false;
  try {
    expect(launchedHere().length).toBeGreaterThan(0);
    process.kill(pid, "SIGSTOP");
    const own = new Error("the launch's own error");
    const at = Date.now();
    const got = await endFailedLaunch(app, own);
    ended = true;
    const took = Date.now() - at;
    expect(got).toBe(own);
    expect(own.message).toBe("the launch's own error");
    expect(took).toBeLessThan(12_000);
    await expect.poll(launchedHere, { timeout: 5_000 }).toEqual([]);
  } finally {
    if (!ended) await endFailedLaunch(app, new Error("the test failed before its own clean-up"));
  }
});
