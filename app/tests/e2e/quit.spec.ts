// The app's quit with terminals running (R86). node-pty reports a terminal's exit from a thread of its own through the
// event loop. An exit that arrived while Electron was tearing Node down called into an environment that could no
// longer run JavaScript, and the app ended by SIGABRT instead of exiting 0 (pty.node
// Napi::Error::ThrowAsJavaScriptException ← Napi::ThreadSafeFunction::CallJS ← uv__async_io ←
// node::Environment::CleanupHandles ← node::FreeEnvironment). Main killed the terminals only as the window closed on the
// way out, so a shell was still running, or had ended unreported, when the quit reached will-quit.
//
// Main now ends every terminal when the quit starts and lets the quit go on once node-pty has reported each exit, at most
// about a second (SIGKILL halfway to what still runs). These tests pin that at will-quit no shell the app started still
// exists (deterministic: a shell that takes 0.3 s over its hangup, or ignores it, is still there on the old path), and that
// the app exits 0 (the crash itself, which the old path hit in about two quits out of three with a dozen shells open).
// Each test quits its own app, so each launches one.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { command, launchApp, openTab, restoreFixture, type AppHandle } from "./harness";

let h: AppHandle | null = null;
/** The shells a test started: one the app left behind (a failed run) is killed here, not left to the next spec. */
let started: number[] = [];
test.afterEach(async () => {
  await h?.close();
  h = null;
  for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* gone, as it should be */ } }
  started = [];
});

interface PoolTerminal { write(d: string): void; getScrollback(): string; isExited: boolean }
type PoolWindow = { aosHost: { plugin: { terminalPool: { list(): PoolTerminal[] } } } };

/**
 * Opens Code with `lines.length` shells running and types `lines[i]` and then `echo AOSPID:$$` into the i-th, so each
 * prints its pid once its line has run. The pids, in the same order.
 */
async function shellsRunning(win: Page, lines: string[]): Promise<number[]> {
  await openTab(win, "term");
  const live = () => win.evaluate(() => (window as unknown as PoolWindow).aosHost.plugin.terminalPool.list().filter((s) => !s.isExited).length);
  // Code opens a shell of its own the first time it shows.
  await expect.poll(live, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  for (let n = await live(); n < lines.length; n++) expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  await expect.poll(live, { timeout: 20_000 }).toBe(lines.length);
  await win.evaluate((ls) => {
    const list = (window as unknown as PoolWindow).aosHost.plugin.terminalPool.list().filter((s) => !s.isExited);
    list.forEach((s, i) => s.write(`${ls[i] ? `${ls[i]}; ` : ""}echo AOSPID:$$\r`));
  }, lines);
  const pids = () => win.evaluate(() => (window as unknown as PoolWindow).aosHost.plugin.terminalPool.list().filter((s) => !s.isExited)
    .map((s) => Number(/AOSPID:(\d+)/.exec(s.getScrollback())?.[1] ?? 0)));
  await expect.poll(async () => (await pids()).every((p) => p > 0), { timeout: 20_000, message: "every shell printed its pid" }).toBe(true);
  const out = await pids();
  started.push(...out);
  return out;
}

const exists = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Quits the app as ⌘Q does (`again`: a second quit `again` ms after the first), and reads which of `pids` still existed
 * when the quit reached will-quit (a zombie counts: its exit has not been reported yet) and how the app's process ended.
 */
async function quit(handle: AppHandle, pids: number[], again?: number): Promise<{ exit: { code: number | null; signal: NodeJS.Signals | null } | null; atWillQuit: number[] | null; ms: number }> {
  const { app: electron } = handle;
  const file = test.info().outputPath("will-quit.json");
  fs.rmSync(file, { force: true });
  // Added after main's own will-quit listener, so it reads what is left once main has done its part.
  await electron.evaluate(({ app }, o) => {
    const wfs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
    app.on("will-quit", () => {
      const left = o.pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      wfs.writeFileSync(o.file, JSON.stringify(left));
    });
  }, { pids, file });
  const proc = electron.process();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  const t0 = Date.now();
  await electron.evaluate(({ app }, ms) => {
    setTimeout(() => app.quit(), 0);
    if (ms !== null) setTimeout(() => app.quit(), ms);
  }, again ?? null);
  const exit = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))]);
  const ms = Date.now() - t0;
  const atWillQuit = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as number[] : null;
  return { exit, atWillQuit, ms };
}

test("quitting with terminals running ends every one first and exits 0; a second quit while it waits joins it (R86)", async () => {
  restoreFixture();
  h = await launchApp();
  // Fifteen plain shells, and one that takes 0.3 s over its hangup: still running at will-quit on the old path.
  const lines = [...Array.from({ length: 15 }, () => ""), "trap 'sleep 0.3; exit' HUP"];
  const pids = await shellsRunning(h.win, lines);
  expect(pids.every(exists)).toBe(true);
  // The second quit comes while main waits for the slow shell: it must neither be lost nor quit a second time.
  const r = await quit(h, pids, 100);
  console.log(`quit with ${pids.length} terminals running: ${r.ms} ms, ${JSON.stringify(r.exit)}, ${r.atWillQuit?.length ?? "?"} still there at will-quit`);
  expect(r.exit, "the app exited 0 by itself within 10 s").toEqual({ code: 0, signal: null });
  expect(r.atWillQuit, "the shells still there at will-quit").toEqual([]);
  expect(r.ms).toBeLessThan(5_000);
  expect(pids.filter(exists)).toEqual([]);
});

test("a terminal that ignores its hangup is killed halfway through the wait, so the quit still ends at once (R86)", async () => {
  restoreFixture();
  h = await launchApp();
  const pids = await shellsRunning(h.win, ["", "trap '' HUP"]);
  expect(pids.every(exists)).toBe(true);
  const r = await quit(h, pids);
  console.log(`quit with a terminal ignoring SIGHUP: ${r.ms} ms, ${JSON.stringify(r.exit)}, ${r.atWillQuit?.length ?? "?"} still there at will-quit`);
  expect(r.exit, "the app exited 0 by itself within 10 s").toEqual({ code: 0, signal: null });
  expect(r.atWillQuit, "the shells still there at will-quit").toEqual([]);
  // The wait is capped at about a second; the rest is the windows closing and Electron's own teardown.
  expect(r.ms).toBeLessThan(5_000);
  expect(pids.filter(exists)).toEqual([]);
});
