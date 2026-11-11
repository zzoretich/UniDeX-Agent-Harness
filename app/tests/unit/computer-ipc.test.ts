// The Computer pane's page calls (agent-computer D5, D32, R17): each handler refuses a sender that is not the main
// window, the schemas reject bad input, places and bounds are held to policy, and a call while the surface is off
// never reaches the service.

import { handle, on } from "./ipc-main-stub";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CH, type ComputerState } from "../../src/shared/ipc";
import { OFF, registerComputerIpc, type ComputerPageService } from "../../src/main/ipc/computer";
import { ComputerAnswerArgs, ComputerMarkArgs, ComputerNavArgs, ComputerNavigateArgs, ComputerSelectArgs, ComputerShowArgs, ComputerTabArgs } from "../../src/main/ipc/schemas";
import { clampBounds, placeAllowed } from "../../src/main/policy/computer";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-computer-ipc-")));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
fs.mkdirSync(path.join(ROOT, "workspaces", "Scratch"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "workspaces", "alpha"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "workspaces", "file.txt"), "x");

const STATE = { place: "vault", tabs: [], holder: null, asks: [], log: [], marked: false, poppedOut: false } as ComputerState;
const calls: string[] = [];
const seen: unknown[] = [];
const service: ComputerPageService = {
  select: (p) => { calls.push(`select ${p}`); return p ? STATE : null; },
  show: (b) => { calls.push(`show ${JSON.stringify(b)}`); seen.push(b); },
  navigate: async (u) => { calls.push(`navigate ${u}`); return { ok: true, data: null }; },
  tab: (op) => { calls.push(`tab ${JSON.stringify(op)}`); seen.push(op); },
  nav: (go) => { calls.push(`nav ${go}`); seen.push(go); },
  takeOver: () => { calls.push("takeOver"); },
  handBack: () => { calls.push("handBack"); },
  answer: (id, a) => { calls.push(`answer ${id} ${a}`); seen.push([id, a]); },
  mark: (o, v) => { calls.push(`mark ${o} ${v}`); seen.push([o, v]); },
  popOut: () => { calls.push("popOut"); },
};
let trusted = true;
let enabled = true;
registerComputerIpc(() => trusted, { enabled: () => enabled, service: () => service, vaultRoot: () => ROOT });
const send = (ch: string, raw: unknown): void => { calls.length = 0; seen.length = 0; on.get(ch)!({}, raw); };
const invoke = async (ch: string, raw: unknown): Promise<unknown> => { calls.length = 0; return handle.get(ch)!({}, raw); };

const SENDS: Array<[string, unknown, string]> = [
  [CH.computerShow, { bounds: { x: 1, y: 2, width: 3, height: 4 } }, "show"],
  [CH.computerTab, { op: { kind: "new" } }, "tab"],
  [CH.computerNav, { go: "back" }, "nav"],
  [CH.computerTakeOver, {}, "takeOver"],
  [CH.computerHandBack, {}, "handBack"],
  [CH.computerAnswer, { askId: "a1", a: "once" }, "answer"],
  [CH.computerMark, { origin: "https://example.com", on: true }, "mark"],
  [CH.computerPopOut, {}, "popOut"],
];

test("every handler refuses a sender other than the main window", async () => {
  trusted = false;
  for (const [ch, raw] of SENDS) { send(ch, raw); assert.deepEqual(calls, [], ch); }
  assert.deepEqual(await invoke(CH.computerSelect, { place: "vault" }), { ok: false, error: "untrusted sender", code: "EPERM" });
  assert.deepEqual(await invoke(CH.computerNavigate, { url: "https://example.com" }), { ok: false, error: "untrusted sender", code: "EPERM" });
  assert.deepEqual(calls, []);
  trusted = true;
});

test("a trusted, valid call reaches the service", async () => {
  for (const [ch, raw, what] of SENDS) { send(ch, raw); assert.ok(calls[0]?.startsWith(what), ch); }
  assert.deepEqual(await invoke(CH.computerSelect, { place: "ws:alpha" }), { ok: true, data: STATE });
  assert.deepEqual(await invoke(CH.computerSelect, { place: null }), { ok: true, data: null });
  assert.deepEqual(await invoke(CH.computerNavigate, { url: "https://example.com/a" }), { ok: true, data: null });
});

test("the handler passes arguments through unchanged, and clamps show's rectangle", async () => {
  send(CH.computerShow, { bounds: { x: -5, y: 20000, width: 10, height: 9999 } });
  assert.deepEqual(seen, [{ x: 0, y: 10000, width: 10, height: 9999 }]);
  send(CH.computerShow, { bounds: { x: 10.5, y: 2.25, width: 300.75, height: 200 } });
  assert.deepEqual(seen, [{ x: 10.5, y: 2.25, width: 300.75, height: 200 }]);
  send(CH.computerShow, { bounds: null });
  assert.deepEqual(seen, [null]);
  send(CH.computerAnswer, { askId: "ask-9", a: "always" });
  assert.deepEqual(seen, [["ask-9", "always"]]);
  send(CH.computerMark, { origin: "https://example.com:8443", on: false });
  assert.deepEqual(seen, [["https://example.com:8443", false]]);
  send(CH.computerTab, { op: { kind: "select", index: 3 } });
  assert.deepEqual(seen, [{ kind: "select", index: 3 }]);
  assert.deepEqual(await invoke(CH.computerSelect, { place: `dir:${ROOT}` }), { ok: true, data: STATE });
  assert.deepEqual(calls, [`select dir:${ROOT}`]);
});

test("show clamps its numbers to 0-10000 before the service sees them", () => {
  assert.deepEqual(clampBounds({ x: -5, y: 20000, width: 10, height: 9999 }), { x: 0, y: 10000, width: 10, height: 9999 });
});

test("schemas reject bad input", () => {
  assert.equal(ComputerNavigateArgs.safeParse({ url: "javascript:alert(1)" }).success, false);
  assert.equal(ComputerNavigateArgs.safeParse({ url: "file:///etc/passwd" }).success, false);
  assert.equal(ComputerNavigateArgs.safeParse({ url: "about:blank" }).success, true);
  assert.equal(ComputerSelectArgs.safeParse({ place: "../x" }).success, false);
  assert.equal(ComputerSelectArgs.safeParse({ place: "ws:../x" }).success, false);
  assert.equal(ComputerSelectArgs.safeParse({ place: "x".repeat(513) }).success, false);
  assert.equal(ComputerSelectArgs.safeParse({ place: null }).success, true);
  for (const bounds of [{ x: NaN, y: 0, width: 1, height: 1 }, { x: Infinity, y: 0, width: 1, height: 1 }]) {
    assert.equal(ComputerShowArgs.safeParse({ bounds }).success, false);
  }
  assert.equal(ComputerShowArgs.safeParse({ bounds: null }).success, true);
  assert.equal(ComputerShowArgs.safeParse({ bounds: { x: -5, y: 20000, width: 1, height: 1 } }).success, true);
  assert.equal(ComputerAnswerArgs.safeParse({ askId: "a", a: "sometimes" }).success, false);
  assert.equal(ComputerAnswerArgs.safeParse({ askId: "x".repeat(65), a: "once" }).success, false);
  for (const a of ["once", "always", "deny"]) assert.equal(ComputerAnswerArgs.safeParse({ askId: "a", a }).success, true);
  assert.equal(ComputerMarkArgs.safeParse({ origin: "https://example.com/path", on: true }).success, false);
  assert.equal(ComputerMarkArgs.safeParse({ origin: "javascript:1", on: true }).success, false);
  assert.equal(ComputerMarkArgs.safeParse({ origin: "https://example.com", on: true }).success, true);
  assert.equal(ComputerTabArgs.safeParse({ op: { kind: "close" } }).success, false);
  assert.equal(ComputerTabArgs.safeParse({ op: { kind: "select", index: -1 } }).success, false);
  assert.equal(ComputerTabArgs.safeParse({ op: { kind: "select", index: 1.5 } }).success, false);
  assert.equal(ComputerTabArgs.safeParse({ op: { kind: "other" } }).success, false);
  assert.equal(ComputerTabArgs.safeParse({ op: { kind: "close", index: 2 } }).success, true);
});

test("computer:nav takes only back, forward and reload", () => {
  for (const go of ["back", "forward", "reload"]) assert.equal(ComputerNavArgs.safeParse({ go }).success, true, go);
  assert.equal(ComputerNavArgs.safeParse({ go: "home" }).success, false);
  assert.equal(ComputerNavArgs.safeParse({ go: "back", x: 1 }).success, false);
  assert.equal(ComputerNavArgs.safeParse({ go: "back", url: "https://example.com" }).success, false);
  assert.equal(ComputerNavArgs.safeParse({}).success, false);
  send(CH.computerNav, { go: "home" });
  assert.deepEqual(calls, []);
  send(CH.computerNav, { go: "reload" });
  assert.deepEqual(seen, ["reload"]);
});

test("invalid arguments never reach the service", async () => {
  send(CH.computerAnswer, { askId: "a", a: "sometimes" });
  assert.deepEqual(calls, []);
  assert.deepEqual(await invoke(CH.computerNavigate, { url: "javascript:alert(1)" }), { ok: false, error: "invalid arguments", code: "EINVAL" });
  assert.deepEqual(calls, []);
});

test("placeAllowed accepts workspaces, vault, home and existing directories only", () => {
  assert.equal(placeAllowed("ws:alpha", ROOT), true);
  assert.equal(placeAllowed("ws:Scratch", ROOT), true);
  assert.equal(placeAllowed("vault", ROOT), true);
  assert.equal(placeAllowed("home", ROOT), true);
  assert.equal(placeAllowed(`dir:${ROOT}`, ROOT), true);
  for (const p of ["ws:missing", "ws:file.txt", "ws:../x", "ws:a/b", "ws:", "ws:..", "dir:relative", `dir:${ROOT}/nope`, `dir:${ROOT}/workspaces/file.txt`, `dir:${ROOT}/../`, "bogus", "", "../x", ROOT]) {
    assert.equal(placeAllowed(p, ROOT), false, p);
  }
  assert.equal(placeAllowed("ws:alpha", null), false);
  assert.equal(placeAllowed("vault", null), false);
  assert.equal(placeAllowed("ws:ALPHA", ROOT), false);
  assert.equal(placeAllowed("ws:scratch", ROOT), false);
  for (const p of [`dir:${ROOT}/workspaces/./alpha`, `dir:${ROOT}/workspaces/alpha/`, `dir:${ROOT}//workspaces`, `dir:${ROOT}/workspaces/alpha/../alpha`]) {
    assert.equal(placeAllowed(p, ROOT), false, p);
  }
  assert.equal(placeAllowed(`dir:${ROOT}/workspaces/alpha`, ROOT), true);
});

test("select refuses a place the policy does not allow", async () => {
  assert.deepEqual(await invoke(CH.computerSelect, { place: "ws:missing" }), { ok: false, error: "That place is not allowed", code: "EINVAL" });
  assert.deepEqual(calls, []);
});

test("with the surface off, every call is refused and nothing reaches the service", async () => {
  enabled = false;
  for (const [ch, raw] of SENDS) { send(ch, raw); assert.deepEqual(calls, [], ch); }
  assert.deepEqual(await invoke(CH.computerSelect, { place: "vault" }), OFF);
  assert.deepEqual(await invoke(CH.computerNavigate, { url: "https://example.com" }), OFF);
  assert.equal(OFF.error, "The Computer pane is off");
  assert.deepEqual(calls, []);
  enabled = true;
});
