// The app's quit waits for its terminals (R86): the gate before-quit asks (quit-gate.ts) and the wait it runs
// (PtyService.settle). node-pty reports a terminal's exit through the event loop; one that lands during Electron's
// teardown aborts the app, so the quit goes on only once every terminal's exit has been reported, or at the cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import type { PtyEvent } from "../../src/shared/ipc";
import type { ProgramContext } from "../../src/main/policy/programs";
import { quitGate } from "../../src/main/quit-gate";
import { PtyService, type PtyLib, type PtyProcess } from "../../src/main/services/pty";

// ── the gate ─────────────────────────────────────────────────────────

/** A before-quit event: counts preventDefault. */
const quitEvent = () => { const e = { prevented: 0, preventDefault() { e.prevented++; } }; return e; };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the gate lets a quit with nothing running go on at once, and never waits", () => {
  let settles = 0;
  let quits = 0;
  const gate = quitGate({ busy: () => false, settle: async () => { settles++; }, quit: () => { quits++; } });
  const e = quitEvent();
  assert.equal(gate.hold(e), false);
  assert.equal(e.prevented, 0);
  assert.deepEqual([settles, quits, gate.holding], [0, 0, false]);
});

test("the gate holds a quit with a terminal running, waits once, then asks the quit again; that quit goes on", async () => {
  let busy = true;
  let settles = 0;
  let finish: () => void = () => {};
  const events: string[] = [];
  const gate = quitGate({
    busy: () => busy,
    settle: () => { settles++; events.push("settle"); return new Promise<void>((resolve) => { finish = () => { busy = false; resolve(); }; }); },
    // As app.quit() does: before-quit again, synchronously.
    quit: () => { events.push("quit"); const again = quitEvent(); events.push(gate.hold(again) ? "held again" : "goes on"); },
  });
  const first = quitEvent();
  assert.equal(gate.hold(first), true);
  assert.equal(first.prevented, 1);
  assert.equal(gate.holding, true);
  // A second ⌘Q while it waits joins the held quit: prevented too, and no second wait.
  const second = quitEvent();
  assert.equal(gate.hold(second), true);
  assert.equal(second.prevented, 1);
  await tick();
  assert.deepEqual(events, ["settle"]);
  finish();
  await tick();
  assert.equal(settles, 1);
  assert.deepEqual(events, ["settle", "quit", "goes on"]);
  assert.equal(gate.holding, false);
  // Nothing is held for good: a later quit with nothing running goes on.
  assert.equal(gate.hold(quitEvent()), false);
});

test("the gate asks the quit again even when the wait fails, sync or async", async () => {
  for (const settle of [() => { throw new Error("boom"); }, () => Promise.reject(new Error("boom"))]) {
    let quits = 0;
    let busy = true;
    const gate = quitGate({ busy: () => busy, settle: settle as () => Promise<void>, quit: () => { quits++; busy = false; } });
    assert.equal(gate.hold(quitEvent()), true);
    await tick();
    assert.equal(quits, 1);
    assert.equal(gate.holding, false);
  }
});

// ── PtyService.settle ────────────────────────────────────────────────

const CWD = fs.realpathSync(os.tmpdir());
const context = (): ProgramContext => ({ vaultRoot: CWD, home: CWD, userData: CWD, env: {}, agenticos: null, shells: ["/bin/sh"] });

type FakeProc = PtyProcess & { killed: string[]; exit(code?: number): void };
/** node-pty's stand-in: kill() only records the signal; the test says when a terminal's exit is reported. `deaf` ones
 *  report their exit on SIGKILL only (a shell that ignores its hangup); `hup` ones on any signal, at once. */
function fakePty(mode: (n: number) => "hup" | "deaf" | "manual" = () => "manual"): { lib: PtyLib; spawned: FakeProc[] } {
  const spawned: FakeProc[] = [];
  const lib: PtyLib = {
    spawn: () => {
      let onExit: (e: { exitCode: number; signal?: number }) => void = () => {};
      const kind = mode(spawned.length);
      const p: FakeProc = {
        pid: 8000 + spawned.length, killed: [],
        write: () => {}, resize: () => {}, onData: () => {},
        onExit: (cb) => { onExit = cb; },
        kill: (signal) => {
          p.killed.push(signal ?? "SIGHUP");
          if (kind === "hup" || (kind === "deaf" && signal === "SIGKILL")) p.exit();
        },
        exit: (code = 0) => onExit({ exitCode: code }),
      };
      spawned.push(p);
      return p;
    },
  };
  return { lib, spawned };
}

const shell = (id: string) => ({ id, file: "/bin/sh", args: [], cwd: CWD, name: "xterm-256color", cols: 80, rows: 24 });

function service(mode?: Parameters<typeof fakePty>[0], quitting: () => boolean = () => false) {
  const { lib, spawned } = fakePty(mode);
  const events: PtyEvent[] = [];
  const t = new PtyService({ context, env: { PATH: "/usr/bin" }, emit: (ev) => events.push(ev), load: () => lib, quitting, computerOn: () => true });
  return { t, spawned, events };
}

test("settle with no terminal resolves at once and leaves nothing busy", async () => {
  const { t } = service();
  assert.equal(t.busy, false);
  await t.settle(50, 20);
  assert.equal(t.busy, false);
});

test("settle ends every terminal and resolves only once each exit has been reported, the page told of each", async () => {
  const { t, spawned, events } = service();
  assert.ok(t.spawn(shell("t1")).ok);
  assert.ok(t.spawn(shell("t2")).ok);
  assert.equal(t.busy, true);
  let done = false;
  const settled = t.settle(5_000, 4_000).then(() => { done = true; });
  assert.deepEqual(spawned.map((p) => p.killed), [["SIGHUP"], ["SIGHUP"]]);
  assert.equal(t.open, 0, "no terminal is open any more");
  assert.equal(t.busy, true, "but their exits are still to come");
  spawned[0].exit();
  await tick();
  assert.equal(done, false, "one exit is still to come");
  spawned[1].exit(1);
  await settled;
  assert.equal(t.busy, false);
  assert.deepEqual(events, [{ id: "t1", type: "exit", exitCode: 0 }, { id: "t2", type: "exit", exitCode: 1 }]);
});

test("settle waits for terminals killAll ended earlier (the page went, or an update closed the window) as well", async () => {
  const { t, spawned } = service();
  assert.ok(t.spawn(shell("t1")).ok);
  t.killAll();
  assert.equal(t.open, 0);
  assert.equal(t.busy, true, "ended, its exit not reported yet");
  let done = false;
  const settled = t.settle(5_000, 4_000).then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  spawned[0].exit();
  await settled;
  assert.equal(t.busy, false);
});

test("settle sends SIGKILL halfway to a terminal that ignores its hangup, and resolves on its exit", async () => {
  const { t, spawned } = service((n) => (n === 1 ? "deaf" : "hup"));
  assert.ok(t.spawn(shell("t1")).ok);
  assert.ok(t.spawn(shell("t2")).ok);
  const t0 = Date.now();
  await t.settle(5_000, 30);
  assert.ok(Date.now() - t0 < 1_000, "resolved on the SIGKILLed exit, not at the cap");
  assert.deepEqual(spawned.map((p) => p.killed), [["SIGHUP"], ["SIGHUP", "SIGKILL"]]);
  assert.equal(t.busy, false);
});

test("settle resolves at its cap whatever is left, forgetting it, so a stuck child never keeps the app from quitting", async () => {
  const { t, spawned } = service();
  assert.ok(t.spawn(shell("t1")).ok);
  const t0 = Date.now();
  await t.settle(60, 20);
  assert.ok(Date.now() - t0 >= 55, "it waited up to the cap");
  assert.deepEqual(spawned[0].killed, ["SIGHUP", "SIGKILL"]);
  assert.equal(t.busy, false, "forgotten: the quit asked again goes on");
  spawned[0].exit();
  assert.equal(t.busy, false);
});

test("two waits at once both resolve on the same exits", async () => {
  const { t, spawned } = service();
  assert.ok(t.spawn(shell("t1")).ok);
  const a = t.settle(5_000, 4_000);
  const b = t.settle(5_000, 4_000);
  spawned[0].exit();
  await Promise.all([a, b]);
  assert.equal(t.busy, false);
});

test("while the app quits no terminal starts: a shell, or an agent's (its exit makes the page start a shell)", async () => {
  let quitting = false;
  const { t, spawned } = service(undefined, () => quitting);
  assert.ok(t.spawn(shell("t1")).ok);
  quitting = true;
  assert.deepEqual(t.spawn(shell("t2")), { ok: false, error: "the app is quitting", code: "ECANCELED" });
  const agent = await t.spawnAgent({ id: "t3", host: "claude", argv: [], cwd: CWD, configDir: null, gitInit: false, cols: 80, rows: 24, place: "vault", label: "x", access: "edit" });
  assert.deepEqual(agent, { ok: false, error: "the app is quitting", code: "ECANCELED" });
  assert.equal(spawned.length, 1, "nothing started");
  // An update's quit that failed lets terminals start again (main's `quitting` goes back to false).
  quitting = false;
  assert.ok(t.spawn(shell("t4")).ok);
});
