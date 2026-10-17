import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { buildVaultIndex, indexFrom, parseNote, pathLookup, resolveLink, topTags } from "./vaultIndex";

test("tags come from the frontmatter in every shape it is written, deduplicated, without a leading #", () => {
  assert.deepEqual(parseNote("---\ntags: [memory/projects, status/active]\n---\n# x\n").tags, ["memory/projects", "status/active"]);
  assert.deepEqual(parseNote("---\ntags:\n  - pin\n  - '#status/active'\n  - pin\n---\nbody\n").tags, ["pin", "status/active"]);
  assert.deepEqual(parseNote("---\ntags: a, b\n---\n").tags, ["a", "b"]);
  assert.deepEqual(parseNote("---\ntitle: x\n---\n").tags, []);
  // A body that only looks like frontmatter further down is not frontmatter.
  assert.deepEqual(parseNote("# Title\n\n---\ntags: [x]\n---\n").tags, []);
});

test("links: wiki links with headings, aliases and embeds, relative Markdown links; not URLs, anchors or code", () => {
  const text = [
    "---", "tags: [x]", "---",
    "See [[Tide API notes]] and [[harbor-map#Next|the plan]], ![[chart.png]], [[a/b/c]] twice: [[a/b/c]].",
    "A [relative](../reference/notes.md#part) link, an [encoded](My%20File.md) one, a [site](https://example.com), an [anchor](#top).",
    "Inline `[[not a link]]` and:",
    "```", "[[also not]] [x](nope.md)", "```",
  ].join("\n");
  assert.deepEqual(parseNote(text).links, [
    { target: "Tide API notes", md: false }, { target: "harbor-map", md: false }, { target: "chart.png", md: false }, { target: "a/b/c", md: false },
    { target: "../reference/notes.md", md: true }, { target: "My File.md", md: true },
  ]);
});

test("the first lines' lengths shape Icons' page art: after the frontmatter, non-empty, six at most, capped", () => {
  const long = "x".repeat(90);
  assert.deepEqual(parseNote(`---\na: b\n---\n# Hi\n\n${long}\n1\n22\n333\n4444\n55555\n`).lines, [4, 48, 1, 2, 3, 4]);
  assert.deepEqual(parseNote("").lines, []);
});

test("resolveLink: Markdown links from the note's folder; wiki paths from the root; bare names here first, else the shortest", () => {
  const look = pathLookup([
    "brain/memory/projects/harbor-map.md", "brain/memory/reference/notes.md", "workspaces/harbor-map/README.md",
    "workspaces/harbor-map/notes.md", "notes.md", "assets/chart.png", "a/b/c.md",
  ]);
  const from = "brain/memory/projects/plan.md";
  assert.equal(resolveLink({ target: "../reference/notes.md", md: true }, from, look), "brain/memory/reference/notes.md");
  assert.equal(resolveLink({ target: "../reference/notes", md: true }, from, look), "brain/memory/reference/notes.md");
  assert.equal(resolveLink({ target: "../../../../out.md", md: true }, from, look), null);
  assert.equal(resolveLink({ target: "a/b/c", md: false }, from, look), "a/b/c.md");
  assert.equal(resolveLink({ target: "Harbor-Map", md: false }, from, look), "brain/memory/projects/harbor-map.md");
  assert.equal(resolveLink({ target: "chart.png", md: false }, from, look), "assets/chart.png");
  // Three notes.md: the root's is the shortest; from inside workspaces/harbor-map its own wins.
  assert.equal(resolveLink({ target: "notes", md: false }, from, look), "notes.md");
  assert.equal(resolveLink({ target: "notes", md: false }, "workspaces/harbor-map/PLAN.md", look), "workspaces/harbor-map/notes.md");
  assert.equal(resolveLink({ target: "harbor-map/notes", md: false }, from, look), "workspaces/harbor-map/notes.md");
  assert.equal(resolveLink({ target: "nowhere", md: false }, from, look), null);
});

test("the index resolves links, counts unresolved ones, builds backlinks without self-links or repeats, and counts tags", () => {
  const idx = indexFrom([
    // [[b]] and [x](dir/b.md) land on the same note (counted once); [[a]] is itself; [[ghost]] is nowhere.
    { path: "a.md", facts: { tags: ["pin"], links: [{ target: "b", md: false }, { target: "dir/b.md", md: true }, { target: "a", md: false }, { target: "ghost", md: false }, { target: "pic.png", md: false }], lines: [3] } },
    { path: "dir/b.md", facts: { tags: ["pin", "status/active"], links: [{ target: "../a.md", md: true }], lines: [] } },
    { path: "c.md", facts: { tags: [], links: [{ target: "dir/b", md: false }], lines: [] } },
  ], ["a.md", "dir/b.md", "c.md", "img/pic.png"]);
  assert.deepEqual(idx.notes.get("a.md"), { tags: ["pin"], out: ["dir/b.md", "img/pic.png"], unresolved: 1, lines: [3] });
  assert.deepEqual(idx.backlinks.get("img/pic.png"), ["a.md"]);
  assert.deepEqual(idx.backlinks.get("dir/b.md"), ["a.md", "c.md"]);
  assert.deepEqual(idx.backlinks.get("a.md"), ["dir/b.md"]);
  assert.equal(idx.backlinks.get("c.md"), undefined);
  assert.deepEqual(topTags(idx, 5), [{ tag: "pin", count: 2 }, { tag: "status/active", count: 1 }]);
  assert.deepEqual(topTags(idx, 1), [{ tag: "pin", count: 2 }]);
});

test("buildVaultIndex reads Markdown only, skips what cannot be read, reuses parsed notes, and stops when cancelled", async () => {
  const files: Record<string, string> = {
    "notes/a.md": "---\ntags: [pin]\n---\n[[b]]\n",
    "notes/b.md": "# B\n",
    "img/c.png": "binary",
    "notes/broken.md": "",
  };
  let mtime = 1;
  const reads: string[] = [];
  const app = {
    vault: {
      getFiles: () => Object.keys(files).map((path) => ({ path, name: path.split("/").pop()!, extension: path.split(".").pop()!, stat: { mtime, size: 10, ctime: 1 } })),
      cachedRead: async (f: { path: string }) => { reads.push(f.path); if (f.path.endsWith("broken.md")) throw new Error("gone"); return files[f.path]; },
    },
  } as unknown as App;
  const idx = (await buildVaultIndex(app))!;
  assert.deepEqual([...idx.notes.keys()].sort(), ["notes/a.md", "notes/b.md"]);
  assert.deepEqual(idx.backlinks.get("notes/b.md"), ["notes/a.md"]);
  assert.ok(!reads.includes("img/c.png"));
  const before = reads.length;
  await buildVaultIndex(app);
  assert.deepEqual(reads.slice(before), ["notes/broken.md"], "unchanged notes come from the caches; only the unreadable one is tried again");
  mtime = 2;
  assert.equal(await buildVaultIndex(app, { isCancelled: () => true }), null);
});
