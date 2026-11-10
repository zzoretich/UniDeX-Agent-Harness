import { test } from "node:test";
import assert from "node:assert/strict";
import { composerWrites, composeSend, dataUrlBase64, imageReason, imageRefusal, IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, mentionAt, matchFiles, insertMention, sanitizeSnippets, sendPhases, sendWaitEnd, sendWrites } from "./termComposer";

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
  // Typed as one text where the program takes no bracketed paste.
  assert.deepEqual(sendWrites("see", [a], undefined, false), [`see "${a}"`, "\r"]);
});

test("sendWrites (R63): each image's path as a bracketed paste of its own, in order, then the text as its own paste, then one Enter", () => {
  const a = "/work/demo/App Data/code-images/2026-11/aaaaaaaa-0000-4000-8000-000000000001.png";
  const b = "/work/demo/data/code-images/2026-11/bbbbbbbb-0000-4000-8000-000000000002.jpg";
  const [S, E] = ["\x1b[200~", "\x1b[201~"];
  // The text after images starts with a space (D4: Claude Code's placeholder has none after it).
  assert.deepEqual(sendWrites("look at this", [a]), [S, `"${a}"`, E, S, " look at this", E, "\r"]);
  assert.deepEqual(sendWrites("both", [a, b]), [S, `"${a}"`, E, S, b, E, S, " both", E, "\r"]);
  // …unless it already starts with whitespace.
  assert.deepEqual(sendWrites(" spaced", [b]), [S, b, E, S, " spaced", E, "\r"]);
  assert.deepEqual(sendWrites("\nnext line", [b]), [S, b, E, S, "\rnext line", E, "\r"]);
  // An image alone: its paste, then Enter; text of only whitespace adds no paste.
  assert.deepEqual(sendWrites("", [b]), [S, b, E, "\r"]);
  assert.deepEqual(sendWrites("  \n", [b, a]), [S, b, E, S, `"${a}"`, E, "\r"]);
  // The text's paste is cut into pieces and keeps its line ends as carriage returns, as composerWrites does.
  assert.deepEqual(sendWrites("abc\ndef", [b], 4), [S, ...chunks(b, 4), E, S, " abc", "\rdef", E, "\r"]);
  // No image: exactly composerWrites, pasted or typed.
  assert.deepEqual(sendWrites("fix it\nand test", []), composerWrites("fix it\nand test"));
  assert.deepEqual(sendWrites("ls", [], undefined, false), ["ls", "\r"]);
  // Without bracketed paste the paths follow the text in one typed line (the TUI can still read the path).
  assert.deepEqual(sendWrites("look at this", [a, b], undefined, false), [`look at this "${a}" ${b}`, "\r"]);
});

test("sendPhases (R70): the image pastes apart from the text and Enter, which wait for the TUI to show the images", () => {
  const b = "/work/demo/data/code-images/2026-11/bbbbbbbb-0000-4000-8000-000000000002.jpg";
  const [S, E] = ["\x1b[200~", "\x1b[201~"];
  assert.deepEqual(sendPhases("look", [b]), { images: [S, b, E], rest: [S, " look", E, "\r"] });
  assert.deepEqual(sendPhases("", [b, b]), { images: [S, b, E, S, b, E], rest: ["\r"] });
  // No image, or no bracketed paste: nothing to wait for, everything is the rest.
  assert.deepEqual(sendPhases("hi", []), { images: [], rest: composerWrites("hi") });
  assert.deepEqual(sendPhases("hi", [b], undefined, false), { images: [], rest: [`hi ${b}`, "\r"] });
  // sendWrites is the two, in order.
  const p = sendPhases("look", [b]);
  assert.deepEqual(sendWrites("look", [b]), [...p.images, ...p.rest]);
});

test("sendWaitEnd (D1, D2): only a clear wait writes; held says why, gone says the terminal changed (not where the composer is kept away); text the images took comes back to an empty box", () => {
  const o = { blocked: false, cleared: false, box: "look", text: "look" };
  assert.deepEqual(sendWaitEnd("clear", o), { write: true, note: null, box: "look" });
  assert.deepEqual(sendWaitEnd("held", o), { write: false, note: "held", box: "look" });
  assert.deepEqual(sendWaitEnd("gone", o), { write: false, note: "changed", box: "look" });
  assert.deepEqual(sendWaitEnd("gone", { ...o, blocked: true }), { write: false, note: null, box: "look" }, "an ended agent's chat says it itself");
  // After the image pastes the box was emptied: the text comes back, unless something was typed there since.
  const after = { blocked: false, cleared: true, box: "", text: "look at this" };
  assert.deepEqual(sendWaitEnd("held", after), { write: false, note: "held", box: "look at this" });
  assert.deepEqual(sendWaitEnd("gone", after), { write: false, note: "changed", box: "look at this" });
  assert.deepEqual(sendWaitEnd("held", { ...after, box: "a new draft" }), { write: false, note: "held", box: "a new draft" });
  assert.deepEqual(sendWaitEnd("clear", after), { write: true, note: null, box: "" });
});

/** `s` in pieces of `n`. */
function chunks(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

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
