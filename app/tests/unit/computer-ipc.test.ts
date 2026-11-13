// The Computer pane's page calls (agent-computer D5, D32, R17; session-browser S1): each handler refuses a sender that is not the main
// window, the schemas reject bad input, sessions and bounds are held to policy, and a call while the surface is off
// never reaches the service.

import { handle, on } from "./ipc-main-stub";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CH, type ComputerState } from "../../src/shared/ipc";
import { OFF, registerComputerIpc, type ComputerPageService } from "../../src/main/ipc/computer";
import { ComputerAnswerArgs, ComputerMarkArgs, ComputerNavArgs, ComputerNavigateArgs, ComputerOpenLinkArgs, ComputerSelectArgs, ComputerShowArgs, ComputerTabArgs } from "../../src/main/ipc/schemas";
import { clampBounds, sessionAllowed } from "../../src/main/policy/computer";

const T = "0b9d6c1e-3f2a-4c7b-9e1d-5a6b7c8d9e0f";
const HAS = { terminal: (id: string) => ["t3", "t5", "t6", "t7"].includes(id), thread: (id: string) => id === T };

const STATE = { session: "code:t3", label: "", tabs: [], holder: null, asks: [], log: [], marked: false, poppedOut: false, power: "off" } as ComputerState;
const calls: string[] = [];
const seen: unknown[] = [];
const service: ComputerPageService = {
  select: (p) => { calls.push(`select ${p}`); return p ? STATE : null; },
  show: (b) => { calls.push(`show ${JSON.stringify(b)}`); seen.push(b); },
  navigate: async (u) => { calls.push(`navigate ${u}`); return { ok: true, data: null }; },
  openLink: async (s, u) => { calls.push(`openLink ${s} ${u}`); return { ok: true, data: null }; },
  openOutside: async () => { calls.push("openOutside"); return { ok: true, data: null }; },
  tab: (op) => { calls.push(`tab ${JSON.stringify(op)}`); seen.push(op); },
  nav: (go) => { calls.push(`nav ${go}`); seen.push(go); },
  takeOver: () => { calls.push("takeOver"); },
  handBack: () => { calls.push("handBack"); },
  answer: (id, a) => { calls.push(`answer ${id} ${a}`); seen.push([id, a]); },
  mark: (o, v) => { calls.push(`mark ${o} ${v}`); seen.push([o, v]); },
  popOut: () => { calls.push("popOut"); },
  power: (s, on) => { calls.push(`power ${s} ${on}`); seen.push([s, on]); },
  describe: (s, d) => { calls.push(`describe ${s} ${JSON.stringify(d)}`); seen.push([s, d]); },
  move: (f, t) => { calls.push(`move ${f} ${t}`); if (f === "code:t7") throw new Error("boom"); return f !== "code:t6"; },
};
let trusted = true;
let enabled = true;
registerComputerIpc(() => trusted, { enabled: () => enabled, service: () => service, sessions: HAS, moved: (f, t) => { calls.push(`moved ${f} ${t}`); } });
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
  [CH.computerPower, { session: "code:t3", on: true }, "power"],
  [CH.computerDescribe, { session: "code:t3", title: "Fix login", conversation: { host: "claude", id: "abc-1" } }, "describe"],
];

test("every handler refuses a sender other than the main window", async () => {
  trusted = false;
  for (const [ch, raw] of SENDS) { send(ch, raw); assert.deepEqual(calls, [], ch); }
  assert.deepEqual(await invoke(CH.computerSelect, { session: "code:t3" }), { ok: false, error: "untrusted sender", code: "EPERM" });
  assert.deepEqual(await invoke(CH.computerNavigate, { url: "https://example.com" }), { ok: false, error: "untrusted sender", code: "EPERM" });
  assert.deepEqual(calls, []);
  trusted = true;
});

test("a trusted, valid call reaches the service", async () => {
  for (const [ch, raw, what] of SENDS) { send(ch, raw); assert.ok(calls[0]?.startsWith(what), ch); }
  assert.deepEqual(await invoke(CH.computerSelect, { session: "code:t3" }), { ok: true, data: STATE });
  assert.deepEqual(await invoke(CH.computerSelect, { session: null }), { ok: true, data: null });
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
  assert.deepEqual(await invoke(CH.computerSelect, { session: `chat:${T}` }), { ok: true, data: STATE });
  assert.deepEqual(calls, [`select chat:${T}`]);
});

test("show clamps its numbers to 0-10000 before the service sees them", () => {
  assert.deepEqual(clampBounds({ x: -5, y: 20000, width: 10, height: 9999 }), { x: 0, y: 10000, width: 10, height: 9999 });
});

test("schemas reject bad input", () => {
  assert.equal(ComputerNavigateArgs.safeParse({ url: "javascript:alert(1)" }).success, false);
  assert.equal(ComputerNavigateArgs.safeParse({ url: "file:///etc/passwd" }).success, false);
  assert.equal(ComputerNavigateArgs.safeParse({ url: "about:blank" }).success, true);
  assert.equal(ComputerSelectArgs.safeParse({ session: "../x" }).success, false);
  assert.equal(ComputerSelectArgs.safeParse({ session: "ws:alpha" }).success, false);
  assert.equal(ComputerSelectArgs.safeParse({ session: "code:t" + "1".repeat(60) }).success, false);
  assert.equal(ComputerSelectArgs.safeParse({ place: "vault" }).success, false);
  assert.equal(ComputerSelectArgs.safeParse({ session: "code:t3" }).success, true);
  assert.equal(ComputerSelectArgs.safeParse({ session: null }).success, true);
  for (const bounds of [{ x: NaN, y: 0, width: 1, height: 1 }, { x: Infinity, y: 0, width: 1, height: 1 }]) {
    assert.equal(ComputerShowArgs.safeParse({ bounds }).success, false);
  }
  assert.equal(ComputerShowArgs.safeParse({ bounds: null }).success, true);
  assert.equal(ComputerShowArgs.safeParse({ bounds: null, inView: true }).success, true);
  assert.equal(ComputerShowArgs.safeParse({ bounds: null, inView: "yes" }).success, false);
  assert.equal(ComputerShowArgs.safeParse({ bounds: null, extra: 1 }).success, false);
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

test("sessionAllowed", () => {
  assert.equal(sessionAllowed("code:t3", HAS), true);
  assert.equal(sessionAllowed(`chat:${T}`, HAS), true);
  for (const k of ["code:t4", "code:t3x", "code:3", "code:t3\0", "chat:nope", `chat:${T.toUpperCase()}`, "vault", "ws:x", "dir:/", "home", ""]) assert.equal(sessionAllowed(k, HAS), false, k);
  assert.equal(sessionAllowed("code:t2", { terminal: (id) => id === "t1", thread: () => false }), false, "a takeover shell's id names no session");
  assert.equal(sessionAllowed("code:t1234567890", { terminal: () => true, thread: () => true }), false, "ten digits is not a terminal id");
  assert.equal(sessionAllowed(`chat:${T.replace("-4c7b", "-1c7b")}`, { terminal: () => true, thread: () => true }), false, "only a v4 UUID is a thread");
});

test("computer:select refuses a key the app does not hold", async () => {
  // A well-formed key of a session main does not hold: the policy refuses it.
  for (const session of ["code:t9", `chat:${T.replace("0b9d", "1b9d")}`]) {
    assert.deepEqual(await invoke(CH.computerSelect, { session }), { ok: false, error: "That session is not allowed", code: "EINVAL" }, session);
    assert.deepEqual(calls, [], session);
  }
  // A place, or anything else that is no session key, never gets past the schema.
  for (const session of ["vault", "ws:x", "home", "dir:/"]) {
    assert.deepEqual(await invoke(CH.computerSelect, { session }), { ok: false, error: "invalid arguments", code: "EINVAL" }, session);
    assert.deepEqual(calls, [], session);
  }
});

test("with the surface off, every call is refused and nothing reaches the service", async () => {
  enabled = false;
  for (const [ch, raw] of SENDS) { send(ch, raw); assert.deepEqual(calls, [], ch); }
  assert.deepEqual(await invoke(CH.computerSelect, { session: "code:t3" }), OFF);
  assert.deepEqual(await invoke(CH.computerNavigate, { url: "https://example.com" }), OFF);
  assert.equal(OFF.error, "The Computer pane is off");
  assert.deepEqual(calls, []);
  enabled = true;
});

test("computer:power is refused for a session main does not hold, and for arguments the schema does not know", () => {
  send(CH.computerPower, { session: "code:t9", on: true });
  assert.deepEqual(calls, [], "a terminal main does not hold");
  send(CH.computerPower, { session: "chat:00000000-0000-4000-8000-000000000000", on: true });
  assert.deepEqual(calls, [], "a thread main does not hold");
  send(CH.computerPower, { session: "code:t3", on: true, extra: 1 });
  assert.deepEqual(calls, [], "strict");
  send(CH.computerPower, { session: "code:t3", on: "yes" });
  assert.deepEqual(calls, [], "on is a boolean");
  send(CH.computerPower, { session: "nonsense", on: true });
  assert.deepEqual(calls, [], "a session key");
  send(CH.computerPower, { session: "code:t3", on: false });
  assert.deepEqual(calls, ["power code:t3 false"]);
});

test("computer:describe takes Code keys the app holds, a bounded title and a plain conversation; computer:move needs both ends held", async () => {
  send(CH.computerDescribe, { session: "code:t9", title: "x" });
  assert.deepEqual(calls, [], "a terminal main does not hold");
  send(CH.computerDescribe, { session: "chat:00000000-0000-4000-8000-000000000000", title: "x" });
  assert.deepEqual(calls, [], "a thread key is not a Code key");
  send(CH.computerDescribe, { session: "code:t3", title: "x".repeat(401) });
  assert.deepEqual(calls, [], "title bound");
  send(CH.computerDescribe, { session: "code:t3", conversation: { host: "claude", id: "../x" } });
  assert.deepEqual(calls, [], "conversation id");
  send(CH.computerDescribe, { session: "code:t3", title: "Fix", extra: 1 });
  assert.deepEqual(calls, [], "strict");
  send(CH.computerDescribe, { session: "code:t3", title: "Fix" });
  assert.deepEqual(calls, ['describe code:t3 {"title":"Fix"}']);
  assert.deepEqual(await invoke(CH.computerMove, { from: "code:t3", to: "code:t3" }), { ok: true, data: true });
  assert.deepEqual(await invoke(CH.computerMove, { from: "code:t3", to: "code:t4" }), { ok: true, data: false }, "t4 is not held");
  assert.deepEqual(calls, [], "refused before the service");
  assert.deepEqual(await invoke(CH.computerMove, { from: "chat:00000000-0000-4000-8000-000000000000", to: "code:t3" }), { ok: false, error: "invalid arguments", code: "EINVAL" });
  trusted = false;
  assert.deepEqual(await invoke(CH.computerMove, { from: "code:t3", to: "code:t3" }), { ok: false, error: "untrusted sender", code: "EPERM" });
  trusted = true;
});

test("computer:move tells the app the ids moved whenever the call completed for two keys it holds, whether the service answered true or false (session-browser A8)", async () => {
  assert.deepEqual(await invoke(CH.computerMove, { from: "code:t3", to: "code:t5" }), { ok: true, data: true });
  assert.deepEqual(calls, ["move code:t3 code:t5", "moved code:t3 code:t5"], "answered true");
  assert.deepEqual(await invoke(CH.computerMove, { from: "code:t6", to: "code:t5" }), { ok: true, data: false });
  assert.deepEqual(calls, ["move code:t6 code:t5", "moved code:t6 code:t5"], "answered false: the ids still follow the terminal row");
  assert.deepEqual(await invoke(CH.computerMove, { from: "code:t3", to: "code:t9" }), { ok: true, data: false }, "a key main does not hold");
  assert.deepEqual(calls, [], "refused: neither the service nor the ids");
  const error = console.error;
  console.error = () => {};
  try { assert.equal(((await invoke(CH.computerMove, { from: "code:t7", to: "code:t5" })) as { ok: boolean }).ok, false, "the wrapper answers a failure"); } finally { console.error = error; }
  assert.deepEqual(calls, ["move code:t7 code:t5"], "the service threw: the ids did not move");
  enabled = false;
  try { assert.deepEqual(await invoke(CH.computerMove, { from: "code:t3", to: "code:t5" }), { ok: true, data: false }); } finally { enabled = true; }
  assert.deepEqual(calls, [], "the surface is off");
});

test("computer:open-link takes a session and an address, and refuses a session main does not hold", async () => {
  for (const ok of [{ session: "code:t3", url: "https://a.test/" }]) assert.equal(ComputerOpenLinkArgs.safeParse(ok).success, true);
  for (const bad of [{ session: "code:t3" }, { session: "code:t3", url: "" }, { session: "code:t3", url: "h".repeat(8193) }, { session: "code:t3", url: "https://a.test/", extra: 1 }, { url: "https://a.test/" }]) {
    assert.equal(ComputerOpenLinkArgs.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
  }
  assert.deepEqual(await invoke(CH.computerOpenLink, { session: "code:t3", url: "https://a.test/" }), { ok: true, data: null });
  assert.deepEqual(calls, ["openLink code:t3 https://a.test/"]);
  assert.deepEqual(await invoke(CH.computerOpenLink, { session: "code:t9", url: "https://a.test/" }), { ok: false, error: "That session is not allowed", code: "EPERM" });
  assert.deepEqual(calls, []);
  trusted = false;
  assert.deepEqual(await invoke(CH.computerOpenLink, { session: "code:t3", url: "https://a.test/" }), { ok: false, error: "untrusted sender", code: "EPERM" });
  trusted = true;
  assert.deepEqual(calls, []);
  assert.deepEqual(await invoke(CH.computerOpenLink, { session: "code:t3", url: "" }), { ok: false, error: "invalid arguments", code: "EINVAL" });
  enabled = false;
  try { assert.deepEqual(await invoke(CH.computerOpenLink, { session: "code:t3", url: "https://a.test/" }), OFF); } finally { enabled = true; }
  assert.deepEqual(calls, []);
});

test("computer:open-outside takes no arguments, checks the sender and answers the service's result (session-browser S24)", async () => {
  assert.deepEqual(await invoke(CH.computerOpenOutside, {}), { ok: true, data: null });
  assert.deepEqual(calls, ["openOutside"]);
  assert.deepEqual(await invoke(CH.computerOpenOutside, { url: "https://a.test/" }), { ok: false, error: "invalid arguments", code: "EINVAL" }, "the page never names the address");
  assert.deepEqual(calls, []);
  trusted = false;
  assert.deepEqual(await invoke(CH.computerOpenOutside, {}), { ok: false, error: "untrusted sender", code: "EPERM" });
  trusted = true;
  assert.deepEqual(calls, []);
  enabled = false;
  try { assert.deepEqual(await invoke(CH.computerOpenOutside, {}), OFF); } finally { enabled = true; }
  assert.deepEqual(calls, []);
});
