import { test } from "node:test";
import assert from "node:assert/strict";
import { SLASH_KEYS, insertCommand, slashCount, slashEmpty, slashHeading, stepIndex } from "./SlashMenu";

test("insertCommand replaces the typed token with the insert text", () => {
  assert.equal(insertCommand("/", "/code-review "), "/code-review ");
  assert.equal(insertCommand("/rev", "/code-review "), "/code-review ");
  assert.equal(insertCommand("$fi", "$fix-tests "), "$fix-tests ");
  assert.equal(insertCommand("/rev the diff", "/code-review "), "/code-review the diff");
  assert.equal(insertCommand("plain text", "/init "), "/init plain text");
});

test("stepIndex wraps at both ends and answers -1 for an empty list", () => {
  assert.equal(stepIndex(0, 1, 3), 1);
  assert.equal(stepIndex(2, 1, 3), 0);
  assert.equal(stepIndex(0, -1, 3), 2);
  assert.equal(stepIndex(0, 1, 1), 0);
  assert.equal(stepIndex(0, 1, 0), -1);
});

test("the heading and footnote name commands on Claude and skills on Codex", () => {
  assert.equal(slashHeading("claude"), "Commands");
  assert.equal(slashHeading("codex"), "Skills");
  assert.equal(slashCount("claude", 211), "211 commands from Claude Code");
  assert.equal(slashCount("claude", 1), "1 command from Claude Code");
  assert.equal(slashCount("codex", 9), "9 skills from Codex");
  assert.equal(slashCount("codex", 0), "0 skills from Codex");
  assert.equal(SLASH_KEYS, "↑↓ move · ↵ insert · esc close");
});

test("slashEmpty tells a host that listed none from a query that matched none", () => {
  assert.equal(slashEmpty("claude", 0, "/"), "Claude Code listed no commands");
  assert.equal(slashEmpty("codex", 0, "$x"), "Codex listed no skills; typing $name still works");
  assert.equal(slashEmpty("claude", 12, "/zzz"), "No commands match /zzz");
  assert.equal(slashEmpty("codex", 3, "$zzz"), "No skills match $zzz");
});
