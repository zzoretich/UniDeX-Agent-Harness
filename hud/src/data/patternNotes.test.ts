import { test } from "node:test";
import assert from "node:assert/strict";
import { addPatternIndexEntry, appendPattern, areaTitle, newPatternFile, patternIndexEntry, patternPath, PATTERN_AREAS } from "./patternNotes";

const draft = { title: "Count the listeners", body: "After a fix for a leak, mount and unmount in a loop and count what is left.", today: "2026-09-24" };

test("areas map to their file and title", () => {
  assert.deepEqual([...PATTERN_AREAS], ["debugging", "architecture", "code-quality", "testing", "other"]);
  assert.equal(patternPath("code-quality"), "brain/patterns/code-quality.md");
  assert.equal(areaTitle("code-quality"), "Code Quality");
  assert.equal(areaTitle("debugging"), "Debugging");
});

test("newPatternFile writes the pattern.md frontmatter, H1 and first subsection", () => {
  assert.equal(newPatternFile("testing", draft), [
    "---", "type: pattern", "tags: [pattern/testing, status/active]", "created: 2026-09-24", "updated: 2026-09-24", "---", "",
    "# Testing Patterns", "",
    "### Count the listeners",
    "After a fix for a leak, mount and unmount in a loop and count what is left.", "",
  ].join("\n"));
});

test("appendPattern adds a subsection at the end and bumps updated:", () => {
  const existing = "---\ntype: pattern\ncreated: 2026-09-01\nupdated: 2026-09-01\n---\n\n# Debugging Patterns\n\n### Old one\nbody\n\n\n";
  const out = appendPattern(existing, draft);
  assert.match(out, /created: 2026-09-01\nupdated: 2026-09-24\n/);
  assert.equal(out.endsWith("### Old one\nbody\n\n### Count the listeners\nAfter a fix for a leak, mount and unmount in a loop and count what is left.\n"), true);
});

test("a pattern needs a title and a body", () => {
  assert.throws(() => newPatternFile("other", { ...draft, title: "  " }), /title and a body/);
  assert.throws(() => appendPattern("# x\n", { ...draft, body: "\n" }), /title and a body/);
});

test("addPatternIndexEntry adds the area's line under ## Patterns once", () => {
  const index = "## Reference\n- [R](r.md) — r\n\n## Patterns\n- [Debugging Patterns](brain/patterns/debugging.md) — debugging heuristics\n";
  const out = addPatternIndexEntry(index, "testing");
  assert.equal(out, index.replace(/\n$/, "") + "\n" + patternIndexEntry("testing") + "\n");
  assert.equal(patternIndexEntry("testing"), "- [Testing Patterns](brain/patterns/testing.md) — testing decision heuristics");
  assert.equal(addPatternIndexEntry(out, "testing"), out, "already linked: unchanged");
  assert.equal(addPatternIndexEntry(index, "debugging"), index, "an existing line with another description counts");
});
