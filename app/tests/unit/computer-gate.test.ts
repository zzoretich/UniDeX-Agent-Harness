import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, parseKey, NAV_KEYS, type Action, type Focus, type Access } from "../../src/main/computer/gate";
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
  // A file input no longer asks on click: the browser asks "file" when the chooser opens (also for script-opened ones).
  assert.deepEqual(judge({ kind: "click", target: btn("Upload", { fileInput: true }) }, edit(true)), { go: true });
  assert.deepEqual(judge({ kind: "click", target: btn("Upload", { fileInput: true }) }, edit(false)), { ask: "unmarked" });
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
  assert.deepEqual(judge({ kind: "key", key: " ", focus: { ...field, target: btn("Up", { fileInput: true }) } }, edit(true)), { go: true });
});

const D9 = { refuse: "Typing into a password field is refused (D9)." };

test("a click into a cross-site frame asks frame on every site", () => {
  for (const marked of [true, false]) {
    assert.deepEqual(judge({ kind: "click", target: btn("", { role: "Iframe", opaque: true }) }, edit(marked)), { ask: "frame" }, String(marked));
    assert.deepEqual(judge({ kind: "click", target: btn("Pay now", { opaque: true }) }, edit(marked)), { ask: "frame" }, String(marked));
  }
  assert.deepEqual(judge({ kind: "click", target: btn("Next", { opaque: false }) }, edit(true)), { go: true });
});

test("a key into a cross-site frame asks frame on every site, except navigation keys", () => {
  const inFrame: Focus = { target: { role: "Iframe", name: "Card", inForm: false, fileInput: false, opaque: true }, sensitive: false, plainTextarea: false };
  for (const marked of [true, false]) {
    for (const k of ["a", "Backspace", " ", "Control+v"]) assert.deepEqual(judge({ kind: "key", key: k, focus: inFrame }, edit(marked)), { ask: "frame" }, `${marked} ${k}`);
    for (const k of ["Tab", "Shift+Tab", "Escape", "ArrowDown"]) assert.deepEqual(judge({ kind: "key", key: k, focus: inFrame }, edit(marked)), { go: true }, `${marked} ${k}`);
    // Enter too: the frame's own form is out of sight, so frame is asked before the return rule.
    for (const k of ["Enter", "Shift+Enter"]) assert.deepEqual(judge({ kind: "key", key: k, focus: inFrame }, edit(marked)), { ask: "frame" }, `${marked} ${k}`);
    assert.deepEqual(judge({ kind: "key", key: "Enter", focus: { ...inFrame, plainTextarea: true } }, edit(marked)), { ask: "frame" });
  }
  // As the browser reports it: focus in a cross-site frame also counts as sensitive, so a printable key is refused.
  assert.deepEqual(judge({ kind: "key", key: "a", focus: { ...inFrame, sensitive: true } }, edit(true)), D9);
});

test("typing into a cross-site frame is refused, sensitive or not", () => {
  const inFrame: Focus = { target: { role: "Iframe", name: "Card", inForm: false, fileInput: false, opaque: true }, sensitive: false, plainTextarea: false };
  for (const marked of [true, false]) {
    assert.deepEqual(judge({ kind: "type", text: "4242", focus: inFrame }, edit(marked)), { refuse: "Typing into a frame from another site is refused (D9)." });
    assert.deepEqual(judge({ kind: "type", text: "4242", focus: { ...inFrame, sensitive: true } }, edit(marked)), D9);
  }
});

test("a non-navigation key into a password field is refused (D9)", () => {
  const pw: Focus = { target: { role: "textbox", name: "Password", inForm: true, fileInput: false }, sensitive: true, plainTextarea: false };
  for (const marked of [true, false]) {
    for (const k of ["a", "Shift+a", "1", " ", "Backspace", "Control+v", "Meta+a"]) assert.deepEqual(judge({ kind: "key", key: k, focus: pw }, edit(marked)), D9, `${marked} ${k}`);
    for (const k of NAV_KEYS) assert.deepEqual(judge({ kind: "key", key: k, focus: pw }, edit(marked)), { go: true }, `${marked} ${k}`);
    assert.deepEqual(judge({ kind: "key", key: "Enter", focus: pw }, edit(marked)), { ask: "return" });
  }
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

test("unknown action kinds are refused under every access", () => {
  for (const access of ["edit", "run", "host"] as const)
    assert.ok("refuse" in judge({ kind: "teleport" } as unknown as Action, { access, marked: true }), access);
});

test("a bare carriage return in typed text asks return", () => {
  assert.deepEqual(judge({ kind: "type", text: "hi\r", focus: field }, edit(true)), { ask: "return" });
  assert.deepEqual(judge({ kind: "type", text: "hi\r\n", focus: field }, edit(true)), { ask: "return" });
});

test("key variants are canonicalised before judging", () => {
  for (const k of ["\r", "\n", " Enter", "Ctrl + Enter", "enter", "RETURN", "Shift+ Return "])
    assert.deepEqual(judge({ kind: "key", key: k, focus: field }, edit(true)), { ask: "return" }, JSON.stringify(k));
  const del = { ...field, target: btn("Delete") };
  for (const k of [" ", "Space", "space", "SPACE", "Shift+Space", "Shift + space"])
    assert.deepEqual(judge({ kind: "key", key: k, focus: del }, edit(true)), { ask: "delete" }, JSON.stringify(k));
  for (const k of ["arrowdown", " Tab ", "Shift+Tab", "SHIFT + TAB", "escape"])
    assert.deepEqual(judge({ kind: "key", key: k, focus: field }, edit(false)), { go: true }, JSON.stringify(k));
});

test("parseKey canonicalises", () => {
  assert.deepEqual(parseKey(" "), { parts: ["space"], enter: false, space: true });
  assert.deepEqual(parseKey("\r"), { parts: ["enter"], enter: true, space: false });
  assert.deepEqual(parseKey("Ctrl + Return"), { parts: ["ctrl", "enter"], enter: true, space: false });
});

test("run and host access judge like edit", () => {
  for (const access of ["run", "host"] as const) {
    assert.deepEqual(judge({ kind: "click", target: btn("Merge pull request") }, { access, marked: true }), { ask: "merge" });
    assert.deepEqual(judge({ kind: "click", target: btn("Next") }, { access, marked: false }), { ask: "unmarked" });
    assert.deepEqual(judge({ kind: "key", key: "Enter", focus: field }, { access, marked: true }), { ask: "return" });
    assert.deepEqual(judge({ kind: "key", key: "a", focus: field }, { access, marked: true }), { go: true });
    assert.deepEqual(judge({ kind: "type", text: "x", focus: field }, { access, marked: true }), { go: true });
    assert.deepEqual(judge({ kind: "type", text: "x", focus: { ...field, sensitive: true } }, { access, marked: true }), { refuse: "Typing into a password field is refused (D9)." });
  }
});

test("a newline in a plain textarea on an unmarked site asks unmarked", () => {
  assert.deepEqual(judge({ kind: "type", text: "a\nb", focus: { ...field, plainTextarea: true } }, edit(false)), { ask: "unmarked" });
});
