import { test } from "node:test";
import assert from "node:assert/strict";
import { TermStreamScanner, cleanTitle } from "./termStream";

const feedAll = (chunks: string[]) => {
  const s = new TermStreamScanner();
  return chunks.flatMap((c) => s.feed(c));
};

test("a title set with OSC 0 or 2, ended by BEL or ST", () => {
  assert.deepEqual(feedAll(["hi\x1b]0;Fix the race\x07there"]), [{ title: "Fix the race", spinner: false }]);
  assert.deepEqual(feedAll(["\x1b]2;Tide chart\x1b\\"]), [{ title: "Tide chart", spinner: false }]);
});

test("a title split across chunks arrives once, whole", () => {
  assert.deepEqual(feedAll(["out\x1b]0;Fix ", "the ra", "ce\x07 more"]), [{ title: "Fix the race", spinner: false }]);
  assert.deepEqual(feedAll(["out\x1b", "]2;Split at ESC\x1b", "\\"]), [{ title: "Split at ESC", spinner: false }]);
});

test("a leading spinner is stripped and reported", () => {
  assert.deepEqual(cleanTitle("⠋ agenticos-workbench"), { title: "agenticos-workbench", spinner: true });
  assert.deepEqual(cleanTitle("✳ Fix the race"), { title: "Fix the race", spinner: true });
  assert.deepEqual(cleanTitle("  plain  "), { title: "plain", spinner: false });
});

test("the bell outside an OSC, and OSC 9 notifications but not ConEmu progress", () => {
  assert.deepEqual(feedAll(["done\x07"]), [{ bell: true }]);
  assert.deepEqual(feedAll(["\x1b]9;Codex needs approval\x07"]), [{ notify: "Codex needs approval" }]);
  assert.deepEqual(feedAll(["\x1b]9;4;1;50\x07"]), []);
  assert.deepEqual(feedAll(["\x1b]1;icon\x07"]), []);
});

test("bracketed-paste mode on and off, also split", () => {
  assert.deepEqual(feedAll(["\x1b[?2004h> "]), [{ bracketedPaste: true }]);
  assert.deepEqual(feedAll(["\x1b[?20", "04l"]), [{ bracketedPaste: false }]);
  assert.deepEqual(feedAll(["\x1b[31mred\x1b[0m"]), []);
});

test("an endless OSC is dropped rather than held forever", () => {
  const s = new TermStreamScanner();
  assert.deepEqual(s.feed("\x1b]0;" + "x".repeat(5000)), []);
  assert.deepEqual(s.feed("\x1b]0;next\x07"), [{ title: "next", spinner: false }]);
});

test("several signals in one chunk keep their order", () => {
  assert.deepEqual(feedAll(["\x1b[?2004h\x1b]0;A\x07\x07\x1b]9;hi\x1b\\"]), [{ bracketedPaste: true }, { title: "A", spinner: false }, { bell: true }, { notify: "hi" }]);
});
