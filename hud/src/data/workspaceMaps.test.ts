import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapStats, WorkspaceMap, indexMap, mergeDir, treeMatches, rowVisible, filterCounts, describeNewCount,
  mapSummary, fileBadge, describeDisabledReason, NOT_MAPPED_TEXT, UNDESCRIBED_TEXT, NEEDS_PROVIDER_TEXT,
} from "./workspaceMaps";
import type { TreeFilter, TreeRow } from "./workspaceMaps";
import type { DirEntry } from "./workspaceFiles";

const MAP: WorkspaceMap = {
  workspace: "Alpha", generatedAt: "2026-08-05T21:00:00Z", pending: 1,
  files: [
    { path: "src/main.js", desc: "Entry point that boots the app", descAt: "2026-08-05T21:00:00Z", mtime: 1, size: 10, status: "fresh" },
    { path: "README.md", desc: null, descAt: null, mtime: 2, size: 20, status: "new" },
    { path: "docs/guide.md", desc: "How to use Alpha end to end", descAt: "2026-08-05T21:00:00Z", mtime: 3, size: 30, status: "changed" },
  ],
};

test("mapStats counts mapped vs pending", () => {
  assert.deepEqual(mapStats(MAP), { mapped: 1, pending: 2, total: 3 });
});

test("mapStats on empty map", () => {
  assert.deepEqual(mapStats({ workspace: "x", generatedAt: null, pending: 0, files: [] } as unknown as WorkspaceMap),
    { mapped: 0, pending: 0, total: 0 });
});

// ── the merged Files tree (spaces-redesign D9) ──

const TREE: WorkspaceMap = {
  workspace: "site", generatedAt: "2026-10-10T10:00:00Z", pending: 3,
  files: [
    { path: "README.md", desc: "What the site is", descAt: "2026-10-10T09:00:00Z", mtime: 1, size: 10, status: "fresh", descSource: "model" },
    { path: "HANDOFF-site.md", desc: "Handoff for the site", descAt: "2026-10-09T09:00:00Z", mtime: 2, size: 10, status: "changed" },
    { path: "design/README.md", desc: "Design canvases", descAt: "2026-10-08T09:00:00Z", mtime: 3, size: 10, status: "fresh", descSource: "heuristic" },
    { path: "design/a.html", desc: null, descAt: null, mtime: 4, size: 10, status: "new" },
    { path: "design/deep/b.html", desc: null, descAt: null, mtime: 5, size: 10, status: "new" },
    { path: "src/main.ts", desc: "Boots the app", descAt: "2026-10-08T09:00:00Z", mtime: 6, size: 10, status: "fresh" },
  ],
};

const listing: DirEntry[] = [
  { name: "design", isDir: true },
  { name: "dist", isDir: true },
  { name: "src", isDir: true },
  { name: "HANDOFF-site.md", isDir: false, size: 10 },
  { name: "README.md", isDir: false, size: 10 },
  { name: "logo.png", isDir: false, size: 2048 },
  { name: "notes.md", isDir: false, size: 40 },
  { name: "dump.json", isDir: false, size: 2 * 1024 * 1024 },
  { name: ".env", isDir: false, size: 5 },
];

const byName = (rows: TreeRow[]) => Object.fromEntries(rows.map((r) => [r.name, r]));

test("fileBadge: NEW until described, CHANGED while the description predates the file, none when fresh", () => {
  assert.equal(fileBadge({ status: "new", desc: null }), "new");
  assert.equal(fileBadge({ status: "changed", desc: "x" }), "changed");
  assert.equal(fileBadge({ status: "fresh", desc: "x" }), null);
  assert.equal(fileBadge({ status: "fresh", desc: null }), "new");
});

test("indexMap rolls the map up per folder, every level counted", () => {
  const ix = indexMap(TREE);
  assert.deepEqual(ix.dirs.get(""), { files: 6, described: 4, new: 2, changed: 1 });
  assert.deepEqual(ix.dirs.get("design"), { files: 3, described: 1, new: 2, changed: 0 });
  assert.deepEqual(ix.dirs.get("design/deep"), { files: 1, described: 0, new: 1, changed: 0 });
  assert.deepEqual(filterCounts(ix), { all: 6, new: 2, changed: 1 });
  assert.deepEqual(filterCounts(indexMap(null)), { all: 0, new: 0, changed: 0 });
});

test("mergeDir joins the live listing with the map: descriptions, badges, not mapped, and files the map has not seen", () => {
  const rows = byName(mergeDir("", listing, indexMap(TREE)));
  assert.deepEqual(Object.keys(rows), ["design", "dist", "src", "HANDOFF-site.md", "README.md", "logo.png", "notes.md", "dump.json", ".env"], "the listing's order");
  assert.deepEqual([rows.design.badge, rows.design.desc, rows.design.rollup?.files, rows.design.mapped], ["new", "Design canvases", 3, true], "a folder: NEW inside, its README's description");
  assert.deepEqual([rows.dist.mapped, rows.dist.descText, rows.dist.badge], [false, NOT_MAPPED_TEXT, null], "a folder the map never walks");
  assert.deepEqual([rows.src.badge, rows.src.desc, rows.src.descText], [null, null, ""]);
  assert.deepEqual([rows["HANDOFF-site.md"].badge, rows["HANDOFF-site.md"].descText], ["changed", "Handoff for the site"]);
  assert.deepEqual([rows["README.md"].badge, rows["README.md"].descSource], [null, "model"]);
  assert.deepEqual([rows["logo.png"].mapped, rows["logo.png"].skip, rows["logo.png"].badge, rows["logo.png"].descText], [false, "type", null, NOT_MAPPED_TEXT]);
  assert.deepEqual([rows["notes.md"].unscanned, rows["notes.md"].badge, rows["notes.md"].descText, rows["notes.md"].undescribed], [true, "new", UNDESCRIBED_TEXT, true], "new since the last scan");
  assert.equal(rows["README.md"].undescribed, false);
  assert.equal(rows["logo.png"].undescribed, false, "not mapped is not undescribed");
  assert.deepEqual([rows["dump.json"].mapped, rows["dump.json"].skip, rows["dump.json"].skipText], [false, "size", "Not mapped: over 1 MB"]);
  assert.equal(rows[".env"].skip, "hidden");
  const deep = byName(mergeDir("design", [{ name: "deep", isDir: true }, { name: "a.html", isDir: false, size: 10 }], indexMap(TREE)));
  assert.deepEqual([deep.deep.rel, deep.deep.badge, deep["a.html"].rel, deep["a.html"].badge, deep["a.html"].descText], ["design/deep", "new", "design/a.html", "new", UNDESCRIBED_TEXT]);
});

test("mergeDir with no map: every mappable file is NEW and undescribed, skipped ones still read not mapped", () => {
  const rows = byName(mergeDir("", listing, indexMap(null)));
  assert.equal(rows["README.md"].badge, "new");
  assert.equal(rows["README.md"].unscanned, true);
  assert.equal(rows["logo.png"].badge, null);
  assert.equal(rows.design.badge, null);
});

test("the All / New / Changed filters and the query keep matches and the folders above them", () => {
  const ix = indexMap(TREE);
  const root = mergeDir("", listing, ix);
  const shown = (f: TreeFilter, rows: TreeRow[] = root) => rows.filter((r) => rowVisible(r, f, treeMatches(ix, f))).map((r) => r.name);
  assert.deepEqual(shown({ filter: "all", query: "" }), root.map((r) => r.name));
  assert.deepEqual(shown({ filter: "new", query: "" }), ["design", "notes.md"], "map NEW files' folders, and a file the map has not seen");
  assert.deepEqual(treeMatches(ix, { filter: "new", query: "" }).dirs, new Set(["design", "design/deep"]));
  assert.deepEqual(shown({ filter: "changed", query: "" }), ["HANDOFF-site.md"]);
  assert.deepEqual(shown({ filter: "all", query: "BOOTS" }), ["src"], "by description");
  assert.deepEqual(shown({ filter: "all", query: "logo" }), ["logo.png"], "a file the map skips matches by path under All");
  assert.deepEqual(shown({ filter: "new", query: "logo" }), [], "but never under New");
  assert.deepEqual(shown({ filter: "all", query: "dist" }), ["dist"], "a folder whose path matches");
});

test("Describe N new counts only mappable files: the map's new ones and mappable files it has not seen", () => {
  const ix = indexMap(TREE);
  assert.equal(describeNewCount(ix), 2);
  assert.equal(describeNewCount(ix, ["notes.md", "notes.md", "logo.png", "dist/x.js", "README.md"]), 3, "logo.png, dist/ and a mapped file never count");
});

test("mapSummary: described of total, new, changed, heuristic, and the last description time", () => {
  assert.deepEqual(mapSummary(TREE), { total: 6, described: 4, undescribed: 2, new: 2, changed: 1, heuristic: 1, lastDescribedAt: "2026-10-10T09:00:00Z" });
  assert.deepEqual(mapSummary(null), { total: 0, described: 0, undescribed: 0, new: 0, changed: 0, heuristic: 0, lastDescribedAt: null });
});

test("↻ per file is off under provider none with the reason (spaces-redesign D33)", () => {
  assert.equal(describeDisabledReason("none"), NEEDS_PROVIDER_TEXT);
  assert.equal(describeDisabledReason(null), NEEDS_PROVIDER_TEXT);
  assert.equal(describeDisabledReason("ollama"), null);
  assert.equal(describeDisabledReason("codex"), null);
});
