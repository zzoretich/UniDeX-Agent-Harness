import { test } from "node:test";
import assert from "node:assert/strict";
import { appendUnderHeading, setFrontmatterValue } from "./mdSections";

const INDEX = "# Memory Index\n\n## User\n- [A](a.md) — a\n\n## Feedback (how to work)\n- [B](b.md) — b\n\n## Patterns\n";

test("appendUnderHeading adds the entry at the end of its section, before the blank lines", () => {
  const out = appendUnderHeading(INDEX, "## User", "- [C](c.md) — c");
  assert.equal(out, "# Memory Index\n\n## User\n- [A](a.md) — a\n- [C](c.md) — c\n\n## Feedback (how to work)\n- [B](b.md) — b\n\n## Patterns\n");
});

test("appendUnderHeading prefix-matches the heading, first match wins", () => {
  const out = appendUnderHeading(INDEX, "## Feedback", "- [D](d.md) — d");
  assert.match(out, /## Feedback \(how to work\)\n- \[B\]\(b\.md\) — b\n- \[D\]\(d\.md\) — d\n/);
  const projects = appendUnderHeading("## Projects\n- [P](p.md) — p\n", "## Project", "- [Q](q.md) — q");
  assert.equal(projects, "## Projects\n- [P](p.md) — p\n- [Q](q.md) — q\n");
});

test("appendUnderHeading fills an empty last section and keeps the final newline", () => {
  assert.equal(appendUnderHeading(INDEX, "## Patterns", "- [X](x.md) — x").endsWith("## Patterns\n- [X](x.md) — x\n"), true);
  assert.equal(appendUnderHeading("## A\n\n## B\n", "## A", "- a"), "## A\n- a\n\n## B\n");
});

test("appendUnderHeading adds a missing section at the end", () => {
  assert.equal(appendUnderHeading("# Title\n", "## Patterns", "- p"), "# Title\n\n## Patterns\n- p");
  assert.equal(appendUnderHeading("# Title", "## Patterns", "- p"), "# Title\n\n## Patterns\n- p");
});

test("appendUnderHeading does not treat a ### subsection as the end of the section", () => {
  assert.equal(appendUnderHeading("## A\n### sub\n- x\n## B\n", "## A", "- y"), "## A\n### sub\n- x\n- y\n## B\n");
});

test("setFrontmatterValue replaces or adds a key inside the frontmatter only", () => {
  const doc = "---\ntype: session\nupdated: 2026-09-01\n---\n\nupdated: not frontmatter\n";
  assert.equal(setFrontmatterValue(doc, "updated", "2026-09-24"), "---\ntype: session\nupdated: 2026-09-24\n---\n\nupdated: not frontmatter\n");
  assert.equal(setFrontmatterValue("---\ntype: session\n---\nbody\n", "updated", "2026-09-24"), "---\ntype: session\nupdated: 2026-09-24\n---\nbody\n");
});

test("setFrontmatterValue leaves text without frontmatter unchanged", () => {
  assert.equal(setFrontmatterValue("# no frontmatter\n", "updated", "2026-09-24"), "# no frontmatter\n");
  assert.equal(setFrontmatterValue("---\nnever closed\n", "updated", "2026-09-24"), "---\nnever closed\n");
});
