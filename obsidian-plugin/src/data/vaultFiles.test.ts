import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import {
  childEntries, cleanPath, duplicatePath, foldPath, isListed, isProtected, matchLines, movePath, movePlan, newFolderPath, newNotePath, quickOpenFiles,
  renamePath, searchVault, sortEntries, SEARCH_MAX_MATCHES,
} from "./vaultFiles";

/** A vault index the way the HUD sees it: files with a path, an extension and a stat; folders with children. */
function fakeApp(files: Record<string, string>): App & { reads: string[] } {
  const reads: string[] = [];
  const list = Object.entries(files).map(([path, text]) => ({
    path, name: path.split("/").pop()!, extension: path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "",
    stat: { mtime: 1, size: Buffer.byteLength(text), ctime: 1 },
  }));
  const app = {
    reads,
    vault: {
      getFiles: () => list,
      cachedRead: async (f: { path: string }) => { reads.push(f.path); return files[f.path]; },
    },
  };
  return app as unknown as App & { reads: string[] };
}

test("isListed skips graphify-out at any depth; isProtected covers the runtime's own folders", () => {
  assert.equal(isListed("brain/memory/user/a.md"), true);
  assert.equal(isListed("brain/graphify-out/cache/x.json"), false);
  assert.equal(isListed("workspaces/app/graphify-out/graph.json"), false);
  for (const p of ["brain/_index/BRAIN.md", "brain/scripts/statusline.js", ".obsidian/app.json", ".git/HEAD", "brain/_index"]) assert.equal(isProtected(p), true, p);
  for (const p of ["brain/memory/user/a.md", "brain/indexer.md", "TODO.md", "brain/scripts-notes.md"]) assert.equal(isProtected(p), false, p);
});

test("isProtected compares the way macOS's disk does: any case, U+017F, NFD; and refuses node_modules at any depth, as main does", () => {
  for (const p of ["Brain/Scripts/x.js", "BRAIN/_INDEX/BRAIN.md", "brain/\u017Fcripts/x.js", "brain/_Index", ".OBSIDIAN/app.json", ".Git/HEAD",
    "node_modules/x.md", "workspaces/app/Node_Modules/x.md", "a/node_module\u017F/x"]) assert.equal(isProtected(p), true, p);
  for (const p of ["Brain.md", "notes/Brain/Scripts.md", "node_modules.md", "brain/_index.md"]) assert.equal(isProtected(p), false, p);
  assert.equal(foldPath("cafe\u0301"), foldPath("CAF\u00C9"));
  assert.equal(foldPath("\u212Ait"), "kit");
});

test("sortEntries: folders first, then files, by name with numbers in order and case folded", () => {
  const e = (name: string, folder = false) => ({ path: name, name, folder });
  assert.deepEqual(sortEntries([e("b.md"), e("Zeta", true), e("a10.md"), e("alpha", true), e("a2.md"), e("B2.md")]).map((x) => x.name),
    ["alpha", "Zeta", "a2.md", "a10.md", "b.md", "B2.md"]);
});

test("childEntries: folders by their children, listed entries only", () => {
  const folder = { path: "brain/memory", name: "memory", children: [] };
  const file = { path: "brain/notes.md", name: "notes.md", extension: "md" };
  const skipped = { path: "brain/graphify-out", name: "graphify-out", children: [] };
  assert.deepEqual(childEntries([file, folder, skipped] as never), [
    { path: "brain/memory", name: "memory", folder: true },
    { path: "brain/notes.md", name: "notes.md", folder: false },
  ]);
});

test("quickOpenFiles: Markdown first, then other files, each by path; skipped folders left out", () => {
  const app = fakeApp({ "z.md": "", "a.json": "", "b/c.md": "", "brain/graphify-out/g.md": "" });
  assert.deepEqual(quickOpenFiles(app).map((f) => f.path), ["b/c.md", "z.md", "a.json"]);
});

test("matchLines: case folded, numbered from 1, the hit located, long lines clipped around it", () => {
  assert.deepEqual(matchLines("one\nTwo tides\nthree tide", "TIDE"), [
    { line: 2, text: "Two tides", start: 4, end: 8 },
    { line: 3, text: "three tide", start: 6, end: 10 },
  ]);
  assert.deepEqual(matchLines("anything", "   "), []);
  const long = `${"x".repeat(300)}needle${"y".repeat(300)}`;
  const [m] = matchLines(long, "needle", 10, 40);
  assert.ok(m.text.startsWith("…"));
  assert.equal(m.text.slice(m.start, m.end), "needle");
  assert.equal(matchLines("a\na\na", "a", 2).length, 2, "the limit holds");
});

test("searchVault: Markdown by default, every text type on request, contents cached by mtime", async () => {
  const app = fakeApp({ "notes/tide.md": "High tide at noon", "data/tide.json": "{\"tide\": 1}", "img/tide.png": "tide", "x.md": "nothing" });
  const md = await searchVault(app, "tide");
  assert.deepEqual(md!.hits.map((h) => h.path), ["notes/tide.md"]);
  assert.equal(md!.files, 2);
  const all = await searchVault(app, "tide", { allText: true });
  assert.deepEqual(all!.hits.map((h) => h.path).sort(), ["data/tide.json", "notes/tide.md"]);
  // The second Markdown search reread nothing: the cache had both notes at the same mtime.
  assert.equal(app.reads.filter((p) => p.endsWith(".md")).length, 2);
  assert.deepEqual(await searchVault(app, ""), { hits: [], files: 0, matches: 0, truncated: false });
  assert.equal(await searchVault(app, "tide", { isCancelled: () => true }), null);
});

test("searchVault stops at the match limit and says so", async () => {
  const app = fakeApp({ "big.md": "hit\n".repeat(SEARCH_MAX_MATCHES + 50), "later.md": "hit" });
  const r = await searchVault(app, "hit");
  assert.equal(r!.matches, SEARCH_MAX_MATCHES);
  assert.equal(r!.truncated, true);
});

test("cleanPath trims, normalises slashes and drops empty and . segments", () => {
  assert.equal(cleanPath("  /notes//./a\\b.md/ "), "notes/a/b.md");
  assert.equal(cleanPath(""), "");
});

test("newNotePath: .md added, folders kept, and every refusal says why", () => {
  const exists = (p: string) => p === "notes/taken.md";
  assert.deepEqual(newNotePath("notes", "Harbor plan", exists), { ok: true, path: "notes/Harbor plan.md" });
  assert.deepEqual(newNotePath("", "inbox/idea", exists), { ok: true, path: "inbox/idea.md" });
  assert.deepEqual(newNotePath("notes", "taken", exists), { ok: false, error: "notes/taken.md already exists" });
  assert.deepEqual(newNotePath("notes", "data.json", exists), { ok: false, error: "a new note is a Markdown file (.md)" });
  assert.deepEqual(newNotePath("notes", "", exists), { ok: false, error: "a name is required" });
  assert.equal((newNotePath("notes", "../escape", exists) as { error: string }).error, "a path cannot climb out of the vault (..)");
  assert.equal((newNotePath("", ".hidden", exists) as { error: string }).error, "names cannot start with a dot");
  assert.equal((newNotePath("", "a:b", exists) as { error: string }).error, 'names cannot contain \\ : * ? " < > |');
  assert.equal((newNotePath("brain/_index", "x", exists) as { error: string }).error, "brain/_index/ is written by the runtime itself");
});

test("renamePath keeps the folder and the extension; movePath keeps the name", () => {
  const none = () => false;
  assert.deepEqual(renamePath("notes/a.md", "b", none), { ok: true, path: "notes/b.md" });
  assert.deepEqual(renamePath("a.png", "b.jpg", none), { ok: true, path: "b.jpg" });
  assert.deepEqual(renamePath("notes/a.md", "a", none), { ok: false, error: "that is its name already" });
  assert.deepEqual(renamePath("notes/a.md", "x/b", none), { ok: false, error: "a name cannot contain / (use Move to change the folder)" });
  assert.deepEqual(renamePath("brain/_index/BRAIN.md", "x", none), { ok: false, error: "brain/_index/BRAIN.md is written by the runtime itself" });
  assert.deepEqual(movePath("notes/a.md", "archive/2026", none), { ok: true, path: "archive/2026/a.md" });
  assert.deepEqual(movePath("notes/a.md", "", none), { ok: true, path: "a.md" });
  assert.deepEqual(movePath("notes/a.md", "notes/", none), { ok: false, error: "it is in that folder already" });
  assert.deepEqual(movePath("notes/a.md", "brain/scripts", none), { ok: false, error: "brain/scripts/ is written by the runtime itself" });
  assert.deepEqual(movePath("notes/a.md", "Brain/Scripts", none), { ok: false, error: "brain/scripts/ is written by the runtime itself" });
  assert.deepEqual(movePath("notes/a.md", "app/node_modules", none), { ok: false, error: "node_modules/ belongs to a package manager" });
  assert.equal((newNotePath("BRAIN/_INDEX", "x", none) as { error: string }).error, "brain/_index/ is written by the runtime itself");
  assert.deepEqual(movePath("notes/a.md", "x", (p) => p === "x/a.md"), { ok: false, error: "x/a.md already exists" });
});

test("movePath refuses a folder into itself or a folder under it", () => {
  const none = () => false;
  assert.deepEqual(movePath("notes", "notes", none), { ok: false, error: "notes cannot go inside itself" });
  assert.deepEqual(movePath("notes", "notes/2026", none), { ok: false, error: "notes cannot go inside itself" });
  assert.deepEqual(movePath("notes", "notes-old", none), { ok: true, path: "notes-old/notes" });
});

test("movePlan checks every item before the first moves (files-finder D15)", () => {
  const none = () => false;
  assert.deepEqual(movePlan(["a/x.md", "a/y.png"], "b", none), { ok: true, moves: [{ from: "a/x.md", to: "b/x.md" }, { from: "a/y.png", to: "b/y.png" }] });
  // One that cannot go stops all of them, naming it.
  assert.deepEqual(movePlan(["a/x.md", "a/y.png"], "b", (p) => p === "b/y.png"), { ok: false, error: "y.png: b/y.png already exists" });
  assert.deepEqual(movePlan(["a/x.md", "brain/_index/BRAIN.md"], "b", none), { ok: false, error: "BRAIN.md: brain/_index/BRAIN.md is written by the runtime itself" });
  // A runtime folder says why once, whatever is dropped on it; a lone item keeps its own reason.
  assert.deepEqual(movePlan(["a/x.md", "a/y.png"], "brain/_index", none), { ok: false, error: "brain/_index/ is written by the runtime itself" });
  assert.deepEqual(movePlan(["a/x.md"], "Brain/Scripts/lib", none), { ok: false, error: "brain/scripts/ is written by the runtime itself" });
  assert.deepEqual(movePlan(["a/x.md"], "b", (p) => p === "b/x.md"), { ok: false, error: "b/x.md already exists" });
  // Something inside a folder that moves goes with it; items already there stay; two of one name cannot share a folder.
  assert.deepEqual(movePlan(["a", "a/x.md"], "b", none), { ok: true, moves: [{ from: "a", to: "b/a" }] });
  assert.deepEqual(movePlan(["b/x.md", "a/y.md"], "b", none), { ok: true, moves: [{ from: "a/y.md", to: "b/y.md" }] });
  assert.deepEqual(movePlan(["b/x.md"], "b", none), { ok: false, error: "it is in that folder already" });
  assert.deepEqual(movePlan(["b/x.md", "b/y.md"], "b/", none), { ok: false, error: "they are in that folder already" });
  assert.deepEqual(movePlan(["a/x.md", "c/X.md"], "b", none), { ok: false, error: "two items are named X.md" });
  assert.deepEqual(movePlan(["a", "c"], "a/d", none), { ok: false, error: "a: a cannot go inside itself" });
});

test("newFolderPath: untitled folder, then numbered as Finder does; never in the runtime's folders", () => {
  const taken = new Set(["notes/untitled folder", "notes/untitled folder 2"]);
  assert.deepEqual(newFolderPath("", () => false), { ok: true, path: "untitled folder" });
  assert.deepEqual(newFolderPath("notes", (p) => taken.has(p)), { ok: true, path: "notes/untitled folder 3" });
  assert.deepEqual(newFolderPath("brain/_index", () => false), { ok: false, error: "brain/_index/ is written by the runtime itself" });
});

test("duplicatePath: name copy.ext beside it, then copy 2; a folder has no extension; never the runtime's files", () => {
  const taken = new Set(["notes/a copy.md", "notes/a copy 2.md"]);
  assert.deepEqual(duplicatePath("notes/a.md", false, () => false), { ok: true, path: "notes/a copy.md" });
  assert.deepEqual(duplicatePath("notes/a.md", false, (p) => taken.has(p)), { ok: true, path: "notes/a copy 3.md" });
  assert.deepEqual(duplicatePath("archive.tar.gz", false, () => false), { ok: true, path: "archive.tar copy.gz" });
  assert.deepEqual(duplicatePath("README", false, () => false), { ok: true, path: "README copy" });
  assert.deepEqual(duplicatePath("notes/v1.2", true, () => false), { ok: true, path: "notes/v1.2 copy" });
  assert.deepEqual(duplicatePath("brain/_index/BRAIN.md", false, () => false), { ok: false, error: "brain/_index/ is written by the runtime itself" });
  assert.deepEqual(duplicatePath("brain/scripts", true, () => false), { ok: false, error: "brain/scripts/ is written by the runtime itself" });
});
