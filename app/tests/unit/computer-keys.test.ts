import { test } from "node:test";
import assert from "node:assert/strict";
import { cdp, CdpTimeout, keyEvents } from "../../src/main/computer/cdp";

test("keyEvents for Shift+Tab", () => {
  assert.deepEqual(keyEvents("Shift+Tab"), [
    { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 },
    { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 },
    { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 },
    { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 },
  ]);
});

test("keyEvents for Control+a sends no text", () => {
  assert.deepEqual(keyEvents("Control+a"), [
    { type: "rawKeyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 },
    { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
    { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
    { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0 },
  ]);
  assert.deepEqual(keyEvents("Ctrl+A"), keyEvents("Control+a"), "aliases and case read the same way as the gate");
});

test("keyEvents for Enter", () => {
  const enter = [
    { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" },
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 },
  ];
  assert.deepEqual(keyEvents("Enter"), enter);
  assert.deepEqual(keyEvents("Return"), enter);
  assert.deepEqual(keyEvents("\n"), enter);
});

test("keyEvents types text for printable keys and shifts them", () => {
  assert.deepEqual(keyEvents("Shift+a").slice(1, 2), [{ type: "keyDown", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 8, text: "A" }]);
  assert.deepEqual(keyEvents("Shift+1")[1], { type: "keyDown", key: "!", code: "Digit1", windowsVirtualKeyCode: 49, modifiers: 8, text: "!" });
  assert.deepEqual(keyEvents(" ")[0], { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 0, text: " " });
  assert.deepEqual(keyEvents("/")[0], { type: "keyDown", key: "/", code: "Slash", windowsVirtualKeyCode: 191, modifiers: 0, text: "/" });
  assert.deepEqual(keyEvents("F5")[0], { type: "rawKeyDown", key: "F5", code: "F5", windowsVirtualKeyCode: 116, modifiers: 0 });
  assert.deepEqual(keyEvents("Meta+Shift+ArrowLeft").map((e) => [e.type, e.key, e.modifiers]), [
    ["rawKeyDown", "Meta", 4], ["rawKeyDown", "Shift", 12], ["rawKeyDown", "ArrowLeft", 12], ["keyUp", "ArrowLeft", 12], ["keyUp", "Shift", 4], ["keyUp", "Meta", 0],
  ]);
  assert.deepEqual(keyEvents("Shift").map((e) => [e.type, e.key, e.modifiers]), [["rawKeyDown", "Shift", 8], ["keyUp", "Shift", 0]]);
});

test("keyEvents throws for an empty part or a name it does not know", () => {
  for (const bad of ["", "+", "Shift+", "Shift++"]) assert.throws(() => keyEvents(bad), /a part is empty/, JSON.stringify(bad));
  for (const bad of ["a+Shift", "a+b", "Hyper+a"]) assert.throws(() => keyEvents(bad), /is not a modifier/, JSON.stringify(bad));
  for (const bad of ["Hyper", "Shift+Hyper", "Enterr", "F13"]) assert.throws(() => keyEvents(bad), /not a key this browser knows/, JSON.stringify(bad));
});

test("cdp passes results through and times out with a clear error", async () => {
  assert.deepEqual(await cdp({ sendCommand: async (m, p) => ({ m, p }) }, "DOM.enable", { a: 1 }), { m: "DOM.enable", p: { a: 1 } });
  await assert.rejects(cdp({ sendCommand: async () => { throw new Error("No node"); } }, "DOM.getBoxModel"), /No node/);
  const hang = { sendCommand: () => new Promise<unknown>(() => {}) };
  await assert.rejects(cdp(hang, "Page.captureScreenshot", {}, 20), (e: unknown) => e instanceof CdpTimeout && /Page\.captureScreenshot/.test(e.message));
});
