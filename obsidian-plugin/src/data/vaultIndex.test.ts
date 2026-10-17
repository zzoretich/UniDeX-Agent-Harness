import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import {
  buildVaultIndex, indexFrom, linkMove, moveInIndex, movedPath, notesTagged, parseNote, pathLookup, resolveLink, rewriteLinks, rewritePlan, topTags,
  type VaultIndex,
} from "./vaultIndex";

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
  // Each link once, with how many times the note writes it.
  assert.deepEqual(parseNote(text).links, [
    { target: "Tide API notes", md: false, n: 1 }, { target: "harbor-map", md: false, n: 1 }, { target: "chart.png", md: false, n: 1 }, { target: "a/b/c", md: false, n: 2 },
    { target: "../reference/notes.md", md: true, n: 1 }, { target: "My File.md", md: true, n: 1 },
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
  const a = idx.notes.get("a.md")!;
  assert.deepEqual({ ...a, links: a.links.length }, { tags: ["pin"], links: 5, out: ["dir/b.md", "img/pic.png"], unresolved: 1, lines: [3] });
  assert.deepEqual(idx.paths, ["a.md", "dir/b.md", "c.md", "img/pic.png"]);
  assert.deepEqual(idx.backlinks.get("img/pic.png"), ["a.md"]);
  assert.deepEqual(idx.backlinks.get("dir/b.md"), ["a.md", "c.md"]);
  assert.deepEqual(idx.backlinks.get("a.md"), ["dir/b.md"]);
  assert.equal(idx.backlinks.get("c.md"), undefined);
  assert.deepEqual(topTags(idx, 5), [{ tag: "pin", count: 2 }, { tag: "status/active", count: 1 }]);
  assert.deepEqual(topTags(idx, 1), [{ tag: "pin", count: 2 }]);
  // A tag in the sidebar lists its notes (files-finder D20), the exact tag only.
  assert.deepEqual(notesTagged(idx, "pin"), ["a.md", "dir/b.md"]);
  assert.deepEqual(notesTagged(idx, "status/active"), ["dir/b.md"]);
  assert.deepEqual(notesTagged(idx, "status"), []);
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

// ── link updates (files-finder D17) ──

/** An index over `notes` (path → text), every path in `others` a file too. */
function indexOf(notes: Record<string, string>, others: string[] = []): VaultIndex {
  return indexFrom(Object.entries(notes).map(([path, text]) => ({ path, facts: parseNote(text) })), [...Object.keys(notes), ...others]);
}

/** One note's text after `moves`, as the tab writes it. */
function after(notes: Record<string, string>, others: string[], note: string, moves: Array<{ from: string; to: string }>) {
  const lm = linkMove(moves, [...Object.keys(notes), ...others]);
  return rewriteLinks(notes[note], note, movedPath(note, moves), lm);
}

test("movedPath: the moved item and everything under a moved folder; nothing else", () => {
  const moves = [{ from: "a/x.md", to: "b/y.md" }, { from: "dir", to: "archive/dir" }];
  assert.equal(movedPath("a/x.md", moves), "b/y.md");
  assert.equal(movedPath("dir/sub/n.md", moves), "archive/dir/sub/n.md");
  assert.equal(movedPath("dirt/n.md", moves), "dirt/n.md");
  assert.equal(movedPath("a/x.md.bak", moves), "a/x.md.bak");
});

test("a rename rewrites wiki links by name, keeping headings, block refs, aliases and embeds, and .md where it was written", () => {
  const notes = {
    "notes/plan.md": "# Plan\n",
    "notes/log.md": [
      "See [[plan]], [[plan#Next]], [[plan#^b1]], [[plan|the plan]], [[plan#Next|next]] and [[ plan ]].",
      "Embedded: ![[plan]]; with .md: [[plan.md]]; by path: [[notes/plan]] and [[notes/plan.md#Next]].",
      "Other: [[log]] [[ghost]] and the picture ![[chart.png|300]].",
    ].join("\n"),
  };
  const r = after(notes, ["img/chart.png"], "notes/log.md", [{ from: "notes/plan.md", to: "notes/roadmap.md" }]);
  assert.equal(r.text, [
    "See [[roadmap]], [[roadmap#Next]], [[roadmap#^b1]], [[roadmap|the plan]], [[roadmap#Next|next]] and [[ roadmap ]].",
    "Embedded: ![[roadmap]]; with .md: [[roadmap.md]]; by path: [[notes/roadmap]] and [[notes/roadmap.md#Next]].",
    "Other: [[log]] [[ghost]] and the picture ![[chart.png|300]].",
  ].join("\n"));
  assert.equal(r.count, 10);
  // An image renamed: its embeds follow, the size kept.
  const img = after(notes, ["img/chart.png"], "notes/log.md", [{ from: "img/chart.png", to: "img/tides.png" }]);
  assert.match(img.text, /!\[\[tides\.png\|300\]\]/);
  assert.equal(img.count, 1);
});

test("Markdown links are written relative to the note again, encoded as they were, with their anchor and title", () => {
  const notes = {
    "MEMORY.md": "- [Harbor Map](brain/memory/projects/harbor-map.md) — the chart viewer\n",
    "brain/memory/projects/harbor-map.md": "See [notes](../reference/tide%20notes.md#Limits \"limits\") and [site](https://example.com/harbor-map.md).\n",
    "brain/memory/reference/tide notes.md": "Used by [the map](../projects/harbor-map) and [self](#top).\n",
  };
  const moves = [{ from: "brain/memory/projects/harbor-map.md", to: "workspaces/harbor-map/About harbor (old).md" }];
  assert.deepEqual(after(notes, [], "MEMORY.md", moves), { text: "- [Harbor Map](workspaces/harbor-map/About%20harbor%20%28old%29.md) — the chart viewer\n", count: 1 });
  // .md left off stays off.
  assert.equal(after(notes, [], "brain/memory/reference/tide notes.md", moves).text,
    "Used by [the map](../../../workspaces/harbor-map/About%20harbor%20%28old%29) and [self](#top).\n");
  // The moved note's own relative link points from its new folder; the URL is left alone.
  assert.deepEqual(after(notes, [], "brain/memory/projects/harbor-map.md", moves), {
    text: "See [notes](../../brain/memory/reference/tide%20notes.md#Limits \"limits\") and [site](https://example.com/harbor-map.md).\n", count: 1,
  });
});

test("a move keeps bare names that still find the file, and writes a path when another file would take the name", () => {
  const notes = {
    "a/x.md": "# X\n",
    "b/x.md": "# the other x\n",
    "a/log.md": "[[x]] and [[a/x]]\n",
    "c/log.md": "[[x]]\n",
    "d/y.md": "# Y\n",
    "c/ref.md": "[[y]] [[d/y|why]]\n",
  };
  // y is the only y: [[y]] still finds it; [[d/y]] is a path and follows.
  assert.deepEqual(after(notes, [], "c/ref.md", [{ from: "d/y.md", to: "e/y.md" }]), { text: "[[y]] [[e/y|why]]\n", count: 1 });
  // From a/, [[x]] meant a/x.md (its own folder); moved to c/, a/log.md's [[x]] would find b/x.md: it becomes a path.
  assert.deepEqual(after(notes, [], "a/log.md", [{ from: "a/x.md", to: "c/x.md" }]), { text: "[[c/x]] and [[c/x]]\n", count: 2 });
  // c/log.md's [[x]] meant a/x.md (the shortest); in c/ it is found by name again.
  assert.deepEqual(after(notes, [], "c/log.md", [{ from: "a/x.md", to: "c/x.md" }]), { text: "[[x]]\n", count: 0 });
});

test("links in the frontmatter or in code are left as they are, and a note with nothing to change comes back the same", () => {
  const notes = {
    "plan.md": "# Plan\n",
    "log.md": "---\nrelated: \"[[plan]]\"\n---\n`[[plan]]` and:\n```\n[[plan]] [x](plan.md)\n```\n~~~md\n[[plan]]\n~~~\nbut [[plan]].\n",
  };
  const r = after(notes, [], "log.md", [{ from: "plan.md", to: "goals.md" }]);
  assert.equal(r.text, notes["log.md"].replace("but [[plan]]", "but [[goals]]"));
  assert.equal(r.count, 1);
  assert.deepEqual(after(notes, [], "log.md", [{ from: "other.md", to: "x.md" }]), { text: notes["log.md"], count: 0 });
});

test("rewritePlan names the notes a rename or move changes and how many links; notes in the runtime's folders are not updated", () => {
  const notes = {
    "brain/memory/projects/harbor-map.md": "See [notes](../reference/tide.md) and [[harbor-map#Next]].\n",
    "brain/memory/reference/tide.md": "Used by [[harbor-map]] and [[harbor-map|the map]] and [[nowhere]].\n",
    "MEMORY.md": "- [Harbor Map](brain/memory/projects/harbor-map.md)\n",
    "brain/_index/BRAIN.md": "- [Harbor Map](../memory/projects/harbor-map.md)\n",
    "notes/unrelated.md": "[[tide]]\n",
  };
  const idx = indexOf(notes);
  // A rename: tide.md's two links and MEMORY.md's one; the note's own [[harbor-map#Next]] is a link to itself.
  const rename = rewritePlan(idx, [{ from: "brain/memory/projects/harbor-map.md", to: "brain/memory/projects/chart-viewer.md" }]);
  assert.deepEqual(rename, {
    notes: [{ path: "MEMORY.md", links: 1 }, { path: "brain/memory/projects/harbor-map.md", links: 1 }, { path: "brain/memory/reference/tide.md", links: 2 }],
    skipped: [{ path: "brain/_index/BRAIN.md", links: 1, reason: "brain/_index/ is written by the runtime itself" }],
    links: 4,
  });
  // A move to another folder, the same name: the bare names still find it; the Markdown links and its own relative link
  // change.
  const move = rewritePlan(idx, [{ from: "brain/memory/projects/harbor-map.md", to: "workspaces/harbor-map.md" }]);
  assert.deepEqual(move.notes, [{ path: "MEMORY.md", links: 1 }, { path: "brain/memory/projects/harbor-map.md", links: 1 }]);
  assert.equal(move.links, 2);
  // A folder that moves with everything in it: links between its own notes still hold; the ones from outside follow.
  const folder = rewritePlan(idx, [{ from: "brain/memory", to: "archive/memory" }]);
  assert.deepEqual(folder.notes, [{ path: "MEMORY.md", links: 1 }]);
  assert.deepEqual(folder.skipped.map((s) => s.path), ["brain/_index/BRAIN.md"]);
  // Nothing links to it: nothing to update.
  assert.deepEqual(rewritePlan(idx, [{ from: "notes/unrelated.md", to: "notes/other.md" }]), { notes: [], skipped: [], links: 0 });
});

test("moveInIndex is the index once the moves are made and the edited notes hold their new text", () => {
  const notes = { "a/plan.md": "# Plan\n", "log.md": "[[plan]] [p](a/plan.md)\n", "img/x.png": "" };
  const idx = indexOf({ "a/plan.md": notes["a/plan.md"], "log.md": notes["log.md"] }, ["img/x.png"]);
  const moves = [{ from: "a/plan.md", to: "b/goals.md" }];
  const next = moveInIndex(idx, moves, new Map([["log.md", "[[goals]] [p](b/goals.md)\n"]]));
  assert.deepEqual([...next.notes.keys()].sort(), ["b/goals.md", "log.md"]);
  assert.deepEqual(next.backlinks.get("b/goals.md"), ["log.md"]);
  assert.equal(next.backlinks.get("a/plan.md"), undefined);
  assert.deepEqual(next.paths, ["b/goals.md", "log.md", "img/x.png"]);
  // A second rename right after the first still finds the links.
  assert.deepEqual(rewritePlan(next, [{ from: "b/goals.md", to: "b/aims.md" }]).notes, [{ path: "log.md", links: 2 }]);
});
