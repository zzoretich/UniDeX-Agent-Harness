import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyNotePath, isDailyNotePath, formatLayout, layoutRegex, DEFAULT_LAYOUT } from "./dailyNote";

test("default layout matches paths.test.js: 2026-09-04 → 2026/2026-09-September/2026-09-04.md", () => {
  assert.equal(dailyNotePath(new Date(2026, 8, 4)), "2026/2026-09-September/2026-09-04.md");
  assert.equal(dailyNotePath(new Date(2026, 7, 5)), "2026/2026-08-August/2026-08-05.md");
  assert.equal(dailyNotePath(new Date(2026, 0, 1)), "2026/2026-01-January/2026-01-01.md");
  assert.equal(dailyNotePath(new Date(2026, 11, 31)), "2026/2026-12-December/2026-12-31.md");
});

test("custom layout matches paths.test.js: daily/{yyyy}-{MM}-{dd}.md with 2026-01-09", () => {
  assert.equal(dailyNotePath(new Date(2026, 0, 9), "daily/{yyyy}-{MM}-{dd}.md"), "daily/2026-01-09.md");
});

test("formatLayout replaces {MMMM} before {MM} so the month name survives", () => {
  assert.equal(formatLayout("{MMMM}-{MM}-{dd}-{yyyy}", new Date(2026, 8, 4)), "September-09-04-2026");
  assert.equal(DEFAULT_LAYOUT, "{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md");
});

test("isDailyNotePath is strict to the layout, like the scripts' listDailyNotes", () => {
  assert.equal(isDailyNotePath("2026/2026-08-August/2026-08-05.md"), true);
  assert.equal(isDailyNotePath("2026/2026-08-04.md"), false); // a stray at the year root is not a daily note (spec §5.3)
  assert.equal(isDailyNotePath("2026/2026-08-Aug/2026-08-05.md"), false); // {MMMM} is the full month name, as in paths.js
  assert.equal(isDailyNotePath("brain/memory/projects/steno.md"), false);
  assert.equal(isDailyNotePath("brain/sessions/2026-08-05.md"), false); // legacy path is NOT valid
});

test("isDailyNotePath honors a custom layout", () => {
  assert.equal(isDailyNotePath("daily/2026-01-09.md", "daily/{yyyy}-{MM}-{dd}.md"), true);
  assert.equal(isDailyNotePath("daily/notes.md", "daily/{yyyy}-{MM}-{dd}.md"), false);
  assert.equal(layoutRegex("journal/{yyyy}/{MMMM}/{dd}.md").test("journal/2026/September/04.md"), true);
  // A layout that names no day matches nothing at all, exactly like paths.js:135 (Ruling A9).
  assert.equal(isDailyNotePath("journal/2026/September.md", "journal/{yyyy}/{MMMM}.md"), false);
});
