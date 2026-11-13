import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, parseKey, permissionVerdict, NAV_KEYS, type Action, type Focus, type Access } from "../../src/main/computer/gate";
import type { Target } from "../../src/main/computer/categories";
import { REFUSAL } from "../../src/main/computer/refusals";

const btn = (name: string, extra: Partial<Target> = {}): Target => ({ role: "button", name, inForm: false, fileInput: false, ...extra });
const field: Focus = { target: { role: "textbox", name: "Email", inForm: true, fileInput: false }, shown: "Email", sensitive: false, plainTextarea: false, node: 1, frame: "F1" };
const edit = (marked: boolean) => ({ access: "edit" as Access, marked });
const READ_ONLY = { refuse: REFUSAL.readOnly };

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
  assert.deepEqual(judge({ kind: "open", url: "file:///etc/hosts" }, edit(false)), { refuse: REFUSAL.notWeb });
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

const D9 = { refuse: REFUSAL.passwordField };

test("a click into a cross-site frame asks frame on every site", () => {
  for (const marked of [true, false]) {
    assert.deepEqual(judge({ kind: "click", target: btn("", { role: "Iframe", opaque: true }) }, edit(marked)), { ask: "frame" }, String(marked));
    assert.deepEqual(judge({ kind: "click", target: btn("Pay now", { opaque: true }) }, edit(marked)), { ask: "frame" }, String(marked));
  }
  assert.deepEqual(judge({ kind: "click", target: btn("Next", { opaque: false }) }, edit(true)), { go: true });
});

test("a key into a cross-site frame asks frame on every site, except navigation keys", () => {
  const inFrame: Focus = { target: { role: "Iframe", name: "Card", inForm: false, fileInput: false, opaque: true }, shown: "Card", sensitive: false, plainTextarea: false, node: 1, frame: "F1" };
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
  const inFrame: Focus = { target: { role: "Iframe", name: "Card", inForm: false, fileInput: false, opaque: true }, shown: "Card", sensitive: false, plainTextarea: false, node: 1, frame: "F1" };
  for (const marked of [true, false]) {
    assert.deepEqual(judge({ kind: "type", text: "4242", focus: inFrame }, edit(marked)), { refuse: REFUSAL.otherSiteFrame });
    assert.deepEqual(judge({ kind: "type", text: "4242", focus: { ...inFrame, sensitive: true } }, edit(marked)), D9);
  }
});

test("a non-navigation key into a password field is refused (D9)", () => {
  const pw: Focus = { target: { role: "textbox", name: "Password", inForm: true, fileInput: false }, shown: "Password", sensitive: true, plainTextarea: false, node: 1, frame: "F1" };
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
  assert.deepEqual(judge({ kind: "type", text: "x", focus: pw }, edit(true)), { refuse: REFUSAL.passwordField });
  assert.deepEqual(judge({ kind: "type", text: "x", focus: pw }, edit(false)), { refuse: REFUSAL.passwordField });
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
    assert.deepEqual(judge({ kind: "type", text: "x", focus: { ...field, sensitive: true } }, { access, marked: true }), { refuse: REFUSAL.passwordField });
  }
});

test("a newline in a plain textarea on an unmarked site asks unmarked", () => {
  assert.deepEqual(judge({ kind: "type", text: "a\nb", focus: { ...field, plainTextarea: true } }, edit(false)), { ask: "unmarked" });
});

test("the gate judges the raw name: a planted sensitive value that matches a label does not hide it (D9, R26, Task 11b)", () => {
  // N1/N1b: a page plants a one-time-code field holding "Delete" (or "elet"). The browser hands the gate the raw name; the
  // scrub runs only on text that leaves the main process. Had the name been scrubbed first, the click would have gone through.
  assert.deepEqual(judge({ kind: "click", target: btn("Delete branch") }, edit(true)), { ask: "delete" });
  assert.deepEqual(judge({ kind: "click", target: btn("Delete") }, edit(true)), { ask: "delete" });
  assert.deepEqual(judge({ kind: "click", target: { role: "link", name: "Item 3 (Delete item 3)", inForm: false, fileInput: false } }, edit(true)), { ask: "delete" });
  assert.deepEqual(judge({ kind: "key", key: " ", focus: { ...field, target: btn("Delete branch") } }, edit(true)), { ask: "delete" });
  assert.deepEqual(judge({ kind: "click", target: btn("•••••• branch") }, edit(true)), { go: true }, "what a scrubbed name would do: why judge must never see one");
  assert.deepEqual(judge({ kind: "click", target: btn("D••••••e branch") }, edit(true)), { go: true });
});

test("M10: a permission this app cannot grant (camera, microphone, location) is denied without asking, with the line why; others ask", () => {
  assert.deepEqual(permissionVerdict("media", "maps.example.com"), { deny: "Denied maps.example.com the camera or microphone without asking: this app has no access to them on this Mac, so allowing would do nothing." });
  assert.deepEqual(permissionVerdict("geolocation", "maps.example.com"), { deny: "Denied maps.example.com your location without asking: this app has no access to it on this Mac, so allowing would do nothing." });
  for (const p of ["notifications", "clipboard-read", "fullscreen", "midi", "unknown"]) assert.equal(permissionVerdict(p, "a.test"), "ask", p);
});

// ---- session-browser S17: tab, navigation and hover

test("a tab switch, a hover and Back, Forward or Reload onto a GET entry do not ask", () => {
  for (const access of ["edit", "run", "host"] as const) {
    for (const marked of [false, true]) {
      const ctx = { access, marked };
      assert.deepEqual(judge({ kind: "hover" }, ctx), { go: true }, `${access} hover`);
      assert.deepEqual(judge({ kind: "tab", close: false, byUser: false }, ctx), { go: true }, `${access} switch`);
      assert.deepEqual(judge({ kind: "tab", close: false, byUser: true }, ctx), { go: true }, `${access} switch to a tab the person opened`);
      for (const go of ["back", "forward", "reload"] as const) assert.deepEqual(judge({ kind: "nav", go, method: "GET" }, ctx), { go: true }, `${access} ${go}`);
    }
  }
});

test("Reload after a form POST asks; onto GET it does not; an unknown method asks", () => {
  for (const go of ["back", "forward", "reload"] as const) {
    assert.deepEqual(judge({ kind: "nav", go, method: "other" }, edit(true)), { ask: "resend" }, `${go} onto another method`);
    assert.deepEqual(judge({ kind: "nav", go, method: "unknown" }, edit(true)), { ask: "resend" }, `${go} onto an unknown method`);
    assert.deepEqual(judge({ kind: "nav", go, method: "GET" }, edit(false)), { go: true }, `${go} onto GET`);
  }
  // The site's mark does not change it: a form sent again is the person's to allow.
  assert.deepEqual(judge({ kind: "nav", go: "reload", method: "other" }, edit(false)), { ask: "resend" });
});

test("closing a tab the user opened asks; closing its own does not", () => {
  assert.deepEqual(judge({ kind: "tab", close: true, byUser: true }, edit(true)), { ask: "closetab" });
  assert.deepEqual(judge({ kind: "tab", close: true, byUser: true }, edit(false)), { ask: "closetab" });
  assert.deepEqual(judge({ kind: "tab", close: true, byUser: false }, edit(false)), { go: true });
});

test("a read only session cannot switch tabs, go back or hover", () => {
  const ctx = { access: "read" as Access, marked: true };
  const acts: Action[] = [
    { kind: "tab", close: false, byUser: false }, { kind: "tab", close: true, byUser: false }, { kind: "hover" },
    { kind: "nav", go: "back", method: "GET" }, { kind: "nav", go: "forward", method: "GET" }, { kind: "nav", go: "reload", method: "GET" },
  ];
  for (const a of acts) assert.deepEqual(judge(a, ctx), READ_ONLY, a.kind);
});
