// What an acting computer tool answers with (session-browser S16, Task 19): its line, then the page as it is now.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MORE, OUTLINE_MAX, withPage } from "../../src/main/computer/reply";

test("withPage appends the outline", () => {
  assert.equal(withPage("Clicked Save.", "[e1] button Save"), "Clicked Save.\n\nPage now:\n[e1] button Save");
});

test("withPage cuts at a line break within 8,000 characters and says where the rest is", () => {
  const out = withPage("Clicked.", Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n"));
  assert.match(out, /\nline \d+\n\(The page goes on: computer_snapshot has the rest\.\)$/);
  assert.ok(out.length <= "Clicked.\n\nPage now:\n".length + OUTLINE_MAX + 1 + MORE.length);
});

test("withPage leaves an outline of exactly 8,000 characters whole", () => {
  const exact = "x".repeat(OUTLINE_MAX);
  assert.equal(withPage("Done.", exact), `Done.\n\nPage now:\n${exact}`);
});

test("withPage cuts a single line with no break at 8,000 characters", () => {
  const out = withPage("Done.", "y".repeat(OUTLINE_MAX + 500));
  assert.equal(out, `Done.\n\nPage now:\n${"y".repeat(OUTLINE_MAX)}\n${MORE}`);
});

test("a cut keeps the page-text wrapper closed and puts the app's sentence outside it", () => {
  const inner = Array.from({ length: 2000 }, (_, i) => `  [e${i}] button "Item ${i}"`).join("\n");
  const out = withPage("Clicked e1.", `<untrusted-page origin="https://a.test" url="https://a.test/">\n${inner}\n</untrusted-page>`);
  assert.ok(out.endsWith(`\n</untrusted-page>\n${MORE}`), "the closing tag, then the sentence");
  const outline = out.slice(out.indexOf("Page now:\n") + "Page now:\n".length, out.length - MORE.length - 1);
  assert.ok(outline.length <= OUTLINE_MAX, "the outline itself stays within the cap");
  assert.equal(out.split("</untrusted-page>").length, 2, "one closing tag");
});

test("an outline cut upstream is followed by the sentence too", () => {
  assert.equal(withPage("Done.", "short", { cut: true }), `Done.\n\nPage now:\nshort\n${MORE}`);
});
