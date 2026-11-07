import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, NAV_KEYS, type Action, type Focus, type Access } from "../../src/main/computer/gate";
import type { Target } from "../../src/main/computer/categories";

const btn = (name: string, extra: Partial<Target> = {}): Target => ({ role: "button", name, inForm: false, fileInput: false, ...extra });
const field: Focus = { target: { role: "textbox", name: "Email", inForm: true, fileInput: false }, sensitive: false, plainTextarea: false };
const edit = (marked: boolean) => ({ access: "edit" as Access, marked });
const READ_ONLY = { refuse: "Read only: this session can look but not act (D17)." };

test("read access lets only the looking actions through", () => {
  const ctx = { access: "read" as Access, marked: true };
  for (const kind of ["status", "snapshot", "screenshot", "wait"] as const) assert.deepEqual(judge({ kind }, ctx), { go: true }, kind);
  const acts: Action[] = [
    { kind: "scroll" }, { kind: "open", url: "https://a.test" }, { kind: "click", target: btn("Next") },
    { kind: "key", key: "Tab", focus: field }, { kind: "type", text: "x", focus: field },
  ];
  for (const a of acts) assert.deepEqual(judge(a, ctx), READ_ONLY, a.kind);
});

test("open goes for web pages and is refused otherwise", () => {
  assert.deepEqual(judge({ kind: "open", url: "https://a.test" }, edit(false)), { go: true });
  assert.deepEqual(judge({ kind: "open", url: "about:blank" }, edit(false)), { go: true });
  assert.deepEqual(judge({ kind: "open", url: "file:///etc/hosts" }, edit(false)), { refuse: "Only http and https pages open." });
});

test("status, snapshot, screenshot, wait and scroll go", () => {
  for (const access of ["edit", "run", "host"] as const)
    for (const kind of ["status", "snapshot", "screenshot", "wait", "scroll"] as const)
      assert.deepEqual(judge({ kind }, { access, marked: false }), { go: true }, `${access} ${kind}`);
});

test("click rows", () => {
  assert.deepEqual(judge({ kind: "click", target: btn("Upload", { fileInput: true }) }, edit(true)), { ask: "file" });
  assert.deepEqual(judge({ kind: "click", target: btn("Upload", { fileInput: true }) }, edit(false)), { ask: "file" });
  assert.deepEqual(judge({ kind: "click", target: btn("Next") }, edit(false)), { ask: "unmarked" });
  assert.deepEqual(judge({ kind: "click", target: btn("Merge pull request") }, edit(true)), { ask: "merge" });
  assert.deepEqual(judge({ kind: "click", target: btn("Next") }, edit(true)), { go: true });
});

test("key rows", () => {
  assert.deepEqual(judge({ kind: "key", key: "Enter", focus: field }, edit(true)), { ask: "return" });
  for (const k of ["Shift+Enter", "Control+Enter", "Meta+Enter", "return", "ENTER"]) assert.deepEqual(judge({ kind: "key", key: k, focus: field }, edit(true)), { ask: "return" }, k);
  const ta = { ...field, plainTextarea: true };
  assert.deepEqual(judge({ kind: "key", key: "Enter", focus: ta }, edit(true)), { go: true });
  assert.deepEqual(judge({ kind: "key", key: "Enter", focus: ta }, edit(false)), { ask: "unmarked" });
  for (const k of NAV_KEYS) assert.deepEqual(judge({ kind: "key", key: k, focus: field }, edit(false)), { go: true }, k);
  assert.deepEqual(judge({ kind: "key", key: "a", focus: field }, edit(false)), { ask: "unmarked" });
  assert.deepEqual(judge({ kind: "key", key: "a", focus: field }, edit(true)), { go: true });
  assert.deepEqual(judge({ kind: "key", key: " ", focus: { ...field, target: btn("Next") } }, edit(false)), { ask: "unmarked" });
  assert.deepEqual(judge({ kind: "key", key: " ", focus: { ...field, target: btn("Delete") } }, edit(true)), { ask: "delete" });
  assert.deepEqual(judge({ kind: "key", key: "Space", focus: { ...field, target: btn("Next") } }, edit(true)), { go: true });
  assert.deepEqual(judge({ kind: "key", key: " ", focus: { ...field, target: null } }, edit(true)), { go: true });
  assert.deepEqual(judge({ kind: "key", key: " ", focus: { ...field, target: btn("Up", { fileInput: true }) } }, edit(true)), { ask: "file" });
});

test("NAV_KEYS is exactly the listed keys", () => {
  assert.deepEqual([...NAV_KEYS].sort(), ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Escape", "Home", "PageDown", "PageUp", "Shift+Tab", "Tab"]);
});

test("type rows", () => {
  const pw = { ...field, sensitive: true };
  assert.deepEqual(judge({ kind: "type", text: "x", focus: pw }, edit(true)), { refuse: "Typing into a password field is refused (D9)." });
  assert.deepEqual(judge({ kind: "type", text: "x", focus: pw }, edit(false)), { refuse: "Typing into a password field is refused (D9)." });
  assert.deepEqual(judge({ kind: "type", text: "hi\n", focus: field }, edit(true)), { ask: "return" });
  assert.deepEqual(judge({ kind: "type", text: "hi\n", focus: { ...field, plainTextarea: true } }, edit(true)), { go: true });
  assert.deepEqual(judge({ kind: "type", text: "hi", focus: field }, edit(false)), { ask: "unmarked" });
  assert.deepEqual(judge({ kind: "type", text: "hi", focus: { ...field, target: { ...field.target!, fileInput: true } } }, edit(true)), { ask: "file" });
  assert.deepEqual(judge({ kind: "type", text: "hi", focus: field }, edit(true)), { go: true });
});
