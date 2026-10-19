import { test } from "node:test";
import assert from "node:assert/strict";
import { appendRemember, rememberLine, rememberTarget, PROMOTE_HEADING, REMEMBER_HEADING } from "./sessionNotes";

const SESSION = [
  "---", "type: session", "updated: 2026-09-01", "---", "",
  "# Current Session Working Memory", "",
  "## Active Task", "",
  "## Things to Remember", "- older note #promote", "",
  "## Promote to Memory on Close", "",
].join("\n");

test("a plain note goes under Things to Remember with #promote, and updated: moves to today", () => {
  const out = appendRemember(SESSION, "the deck writes SESSION.md now", "2026-09-24");
  assert.match(out, /updated: 2026-09-24\n/);
  assert.match(out, /## Things to Remember\n- older note #promote\n- the deck writes SESSION\.md now #promote\n\n## Promote to Memory on Close/);
});

test("a typed note goes under Promote to Memory on Close, whatever its case", () => {
  assert.equal(rememberTarget("feedback: keep the terminal on"), PROMOTE_HEADING);
  assert.equal(rememberTarget("  Project : Settings phase 3"), PROMOTE_HEADING);
  assert.equal(rememberTarget("pattern:check the listener count"), PROMOTE_HEADING);
  assert.equal(rememberTarget("reference: not a remember prefix"), REMEMBER_HEADING);
  assert.equal(rememberTarget("a note about feedback: later"), REMEMBER_HEADING);
  const out = appendRemember(SESSION, "feedback: keep the terminal on", "2026-09-24");
  assert.equal(out.endsWith("## Promote to Memory on Close\n- feedback: keep the terminal on #promote\n"), true);
});

test("rememberLine makes one bullet with exactly one trailing #promote", () => {
  assert.equal(rememberLine("two\nlines  here"), "- two lines here #promote");
  assert.equal(rememberLine("already tagged #promote"), "- already tagged #promote");
  assert.equal(rememberLine("#promote tagged first"), "- tagged first #promote");
  assert.equal(rememberLine("keeps #promoted-ish words"), "- keeps #promoted-ish words #promote");
});

test("a missing SESSION.md starts from a minimal one", () => {
  for (const missing of [null, "", "  \n"]) {
    const out = appendRemember(missing, "first note", "2026-09-24");
    assert.equal(out, "---\ntype: session\nupdated: 2026-09-24\n---\n\n# Current Session Working Memory\n\n## Things to Remember\n- first note #promote\n\n## Promote to Memory on Close\n");
  }
});

test("an empty note is refused", () => {
  assert.throws(() => appendRemember(SESSION, "   ", "2026-09-24"), /nothing to remember/);
  assert.throws(() => appendRemember(SESSION, "#promote", "2026-09-24"), /nothing to remember/);
});
