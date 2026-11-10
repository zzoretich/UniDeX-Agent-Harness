import { test } from "node:test";
import assert from "node:assert/strict";
import { composerWrites, composeSend, dataUrlBase64, imageReason, imageRefusal, IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, mentionAt, matchFiles, insertMention, sanitizeSnippets } from "./termComposer";

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

test("composeSend: the image paths after the text, separated by spaces, each quoted when it holds a space", () => {
  const a = "/work/demo/App Data/code-images/2026-11/aaaaaaaa-0000-4000-8000-000000000001.png";
  const b = "/work/demo/data/code-images/2026-11/bbbbbbbb-0000-4000-8000-000000000002.jpg";
  assert.equal(composeSend("look at this", [a]), `look at this "${a}"`);
  assert.equal(composeSend("look at this", [b]), `look at this ${b}`);
  assert.equal(composeSend("both", [a, b]), `both "${a}" ${b}`);
  // No text: the paths alone. No image: the text exactly as written.
  assert.equal(composeSend("", [b, a]), `${b} "${a}"`);
  assert.equal(composeSend("  \n", [b]), b);
  assert.equal(composeSend("fix it\nand test\n", []), "fix it\nand test\n");
  // Text that ends in a new line or spaces is followed by one space, then the paths.
  assert.equal(composeSend("two lines\nhere\n", [b]), `two lines\nhere ${b}`);
  // A tab is whitespace too: that path is quoted.
  assert.equal(composeSend("x", ["/a\tb/c.png"]), 'x "/a\tb/c.png"');
  // It goes as one bracketed paste, then Enter.
  assert.deepEqual(composerWrites(composeSend("see", [a])), ["\x1b[200~", `see "${a}"`, "\x1b[201~", "\r"]);
});

test("imageRefusal: PNG, JPEG, GIF or WebP up to 10 MB; anything else says why, in main's words", () => {
  assert.equal(IMAGE_MAX_BYTES, 10 * 1024 * 1024);
  for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp"]) assert.equal(imageRefusal(t, 1000), null, t);
  assert.equal(imageRefusal("image/png", IMAGE_MAX_BYTES), null);
  assert.equal(imageRefusal("image/png", IMAGE_MAX_BYTES + 1), "larger than 10 MB");
  for (const t of ["image/tiff", "image/heic", "image/svg+xml", "application/pdf", ""]) assert.equal(imageRefusal(t, 1000), "only PNG, JPEG, GIF or WebP images", t);
  assert.equal(imageRefusal("image/png", 0), "an empty file");
});

test("dataUrlBase64: the base64 of a data: URL, or null for anything else", () => {
  assert.equal(dataUrlBase64("data:image/png;base64,iVBORw0KGgo="), "iVBORw0KGgo=");
  assert.equal(dataUrlBase64("data:application/octet-stream;base64,"), "");
  assert.equal(dataUrlBase64("data:text/plain,hello"), null);
  assert.equal(dataUrlBase64("blob:app://hud/1"), null);
  assert.equal(dataUrlBase64(""), null);
});

test("imageRefusal: at most 8 images in one message; a 9th says so, whatever it is", () => {
  assert.equal(IMAGE_MAX_COUNT, 8);
  assert.equal(imageRefusal("image/png", 1000, 7), null);
  assert.equal(imageRefusal("image/png", 1000, 8), "8 images at most in one message");
  assert.equal(imageRefusal("image/tiff", 1000, 8), "8 images at most in one message");
});

test("imageReason: main's plain reasons as they are; a bare errno code in plain words, never the code", () => {
  assert.equal(imageReason("the images folder is full"), "the images folder is full");
  assert.equal(imageReason("its content is GIF, not PNG"), "its content is GIF, not PNG");
  assert.equal(imageReason("ENOSPC"), "the disk is full");
  assert.equal(imageReason("EEXIST"), "it could not be saved: try again");
  assert.equal(imageReason("EACCES"), "the app can't write to its data folder");
  assert.equal(imageReason("EPERM"), "the app can't write to its data folder");
  assert.equal(imageReason("EROFS"), "the app can't write to its data folder");
  for (const code of ["EIO", "EMFILE", "ENAMETOOLONG", "EBADF"]) assert.equal(imageReason(code), "it could not be saved", code);
  assert.equal(imageReason(""), "it could not be saved");
});
