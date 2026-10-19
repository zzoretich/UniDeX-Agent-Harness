import { test } from "node:test";
import assert from "node:assert/strict";
import { proposalBadge, todoBadge, badgeText, touchesBadges } from "./badges";

test("proposalBadge counts proposal files and skips the README and non-Markdown", () => {
  assert.equal(proposalBadge([]), 0);
  assert.equal(proposalBadge([
    "persona/proposals/README.md",
    "persona/proposals/2026-09-20-a.md",
    "persona/proposals/2026-09-21-b.md",
    "persona/proposals/.DS_Store",
    "persona/proposals/notes.txt",
  ]), 2);
  assert.equal(proposalBadge(["2026-09-20-a.md"]), 1, "bare names work too");
});

test("badgeText hides zero and caps at 99+", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(-1), "");
  assert.equal(badgeText(Number.NaN), "");
  assert.equal(badgeText(3), "3");
  assert.equal(badgeText(99), "99");
  assert.equal(badgeText(100), "99+");
});

test("todoBadge counts open items overdue or due today", () => {
  const text = "## Open\n- [ ] late 📅 2026-09-20\n- [ ] now 📅 2026-09-22\n- [ ] later 📅 2026-09-30\n- [ ] whenever\n\n## Done\n- [x] was due 📅 2026-09-22 ✅ 2026-09-22\n";
  assert.equal(todoBadge(text, "2026-09-22"), 2);
  assert.equal(todoBadge(null, "2026-09-22"), 0);
});

test("touchesBadges matches TODO.md, the proposals folder and its files only", () => {
  assert.equal(touchesBadges("TODO.md"), true);
  assert.equal(touchesBadges("brain/TODO.md"), false);
  assert.equal(touchesBadges("persona/proposals"), true);
  assert.equal(touchesBadges("persona/proposals/2026-09-20-a.md"), true);
  assert.equal(touchesBadges("persona/proposals-old/x.md"), false);
  assert.equal(touchesBadges("persona/STATE.md"), false);
});
