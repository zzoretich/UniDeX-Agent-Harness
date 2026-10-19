import { test } from "node:test";
import assert from "node:assert/strict";
import { composerWrites, mentionAt, matchFiles, insertMention, sanitizeSnippets } from "./termComposer";

test("a message is one bracketed paste with CR line ends, then Enter, in pieces under the pty cap", () => {
  assert.deepEqual(composerWrites("fix it\nand test"), ["\x1b[200~", "fix it\rand test", "\x1b[201~", "\r"]);
  assert.deepEqual(composerWrites("abcdef", 4), ["\x1b[200~", "abcd", "ef", "\x1b[201~", "\r"]);
  // a pasted end marker cannot close the paste early
  assert.deepEqual(composerWrites("a\x1b[201~b"), ["\x1b[200~", "ab", "\x1b[201~", "\r"]);
});

test("without bracketed paste (a program that did not ask for it) the lines are typed, each ending in a carriage return", () => {
  assert.deepEqual(composerWrites("ls\npwd", undefined, false), ["ls\rpwd", "\r"]);
  assert.deepEqual(composerWrites("abcdef", 4, false), ["abcd", "ef", "\r"]);
});

test("mentionAt finds the @token under the caret, not an @ inside a word", () => {
  assert.deepEqual(mentionAt("look at @src/ti", 15), { query: "src/ti", start: 8 });
  assert.deepEqual(mentionAt("@", 1), { query: "", start: 0 });
  assert.equal(mentionAt("meet at noon@4pm", 16), null);
  assert.equal(mentionAt("no token", 8), null);
});

test("matchFiles: substring first, then in-order letters; shortest first; capped", () => {
  const paths = ["src/tides.js", "src/tiles.js", "README.md", "test/tides.test.js"];
  assert.deepEqual(matchFiles(paths, "tides"), ["src/tides.js", "test/tides.test.js"]);
  const inOrder = matchFiles(paths, "stj");
  assert.deepEqual([...inOrder.slice(0, 2)].sort(), ["src/tides.js", "src/tiles.js"]);
  assert.equal(inOrder[2], "test/tides.test.js");
  assert.equal(matchFiles(paths, "").length, 4);
  assert.equal(matchFiles(paths, "", 2).length, 2);
  assert.deepEqual(matchFiles(paths, "zzz"), []);
});

test("insertMention replaces the token and quotes a path with a space", () => {
  assert.deepEqual(insertMention("see @ti now", 4, 7, "src/tides.js"), { text: "see @src/tides.js  now", caret: 18 });
  assert.equal(insertMention("@a", 0, 2, "my notes.md").text, '@"my notes.md" ');
});

test("snippets keep a title (the first line when none), drop empty ones, cap at 50", () => {
  assert.deepEqual(sanitizeSnippets([{ text: "Run the tests\nand fix failures" }, { title: "x", text: "  " }, { title: "Review", text: "Review the diff", host: "codex" }, 7]),
    [{ title: "Run the tests", text: "Run the tests\nand fix failures", host: null }, { title: "Review", text: "Review the diff", host: "codex" }]);
  assert.equal(sanitizeSnippets(Array.from({ length: 60 }, (_, i) => ({ text: `s${i}` }))).length, 50);
  assert.deepEqual(sanitizeSnippets("nope"), []);
});
