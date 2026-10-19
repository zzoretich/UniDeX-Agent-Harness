import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemoryMeta, filterMemories, MemoryMeta, workspaceMentions, workspaceKey, MAX_MENTIONS } from "./memories";

const RAW = `---
type: memory
tags: [memory/feedback, status/active]
created: 2026-03-23
updated: 2026-05-30
---
# Working style

Prefers terse answers with file:line refs.`;

test("parseMemoryMeta extracts type, title, dates from frontmatter + H1", () => {
  const m = parseMemoryMeta("brain/memory/feedback/working-style.md", RAW);
  assert.equal(m.type, "feedback");
  assert.equal(m.title, "Working style");
  assert.equal(m.slug, "working-style");
  assert.equal(m.updated, "2026-05-30");
});

test("parseMemoryMeta falls back to slug when no H1", () => {
  const m = parseMemoryMeta("brain/memory/user/profile.md", "---\ntype: memory\n---\nno heading here");
  assert.equal(m.title, "profile");
});

test("type comes from the path segment, not the tag", () => {
  const m = parseMemoryMeta("brain/memory/reference/decisions.md", RAW);
  assert.equal(m.type, "reference");
});

test("filterMemories narrows by type and by query over title+slug", () => {
  const list: MemoryMeta[] = [
    parseMemoryMeta("brain/memory/feedback/working-style.md", RAW),
    parseMemoryMeta("brain/memory/user/profile.md", "# Profile\n"),
  ];
  assert.equal(filterMemories(list, "", "feedback").length, 1);
  assert.equal(filterMemories(list, "PROF", null).length, 1);
  assert.equal(filterMemories(list, "", null).length, 2);
});

test("parseMemoryMeta reads `workspace:` and the body's workspaces/<name>/ mentions (spaces-redesign D27)", () => {
  const m = parseMemoryMeta("brain/memory/projects/redesign.md", `---
type: memory
workspace: "workspaces/site"
---
# Redesign

Work happens in workspaces/site/ and ~/vault/workspaces/notes/PLAN.md; see workspaces/site/HANDOFF.md again.
`);
  assert.equal(m.workspace, "site");
  assert.deepEqual(m.mentions, ["site", "notes"]);
  const none = parseMemoryMeta("brain/memory/user/profile.md", RAW);
  assert.equal(none.workspace, null);
  assert.deepEqual(none.mentions, []);
});

test("an empty `workspace:` does not read the next line; a frontmatter mention is not a body mention", () => {
  const m = parseMemoryMeta("brain/memory/projects/x.md", "---\nworkspace:\nsource: workspaces/site/x.md\n---\n# X\n");
  assert.equal(m.workspace, null);
  assert.deepEqual(m.mentions, []);
});

test("workspaceKey strips quotes, a wiki link and workspaces/; workspaceMentions keeps whole folder segments", () => {
  assert.equal(workspaceKey("'site'"), "site");
  assert.equal(workspaceKey("[[site|Site]]"), "site");
  assert.equal(workspaceKey("workspaces/site/"), "site");
  assert.equal(workspaceKey("  "), null);
  assert.equal(workspaceKey(null), null);
  assert.deepEqual(workspaceMentions("a workspaces/My Site/README.md b"), ["My Site"], "folder names may hold spaces");
  assert.deepEqual(workspaceMentions("my-workspaces/x/ and workspaces/y with no slash"), [], "glued or unfinished");
  assert.deepEqual(workspaceMentions("workspaces/_archive/old/ workspaces/../x/ workspaces/./y/"), [], "hidden and dot folders");
  assert.deepEqual(workspaceMentions("(workspaces/site/) `workspaces/notes/`"), ["site", "notes"]);
  const many = Array.from({ length: MAX_MENTIONS + 5 }, (_, i) => `workspaces/w${i}/`).join(" ");
  assert.equal(workspaceMentions(many).length, MAX_MENTIONS);
});
