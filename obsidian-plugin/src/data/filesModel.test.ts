import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Lru, NO_SELECTION, THUMB_MAX_BYTES, columnChain, compactCount, crumbs, dateLabel, extOf, extendTo, foldersOf, go, goBack, goForward,
  groupByKind, isSmartId, itemsLabel, keepSelection, keyAction, kindLabel, kindOf, moveCursor, nameMatches, parentOf, pushUndo,
  renameInSelection, selectAll, selectOnly, sizeLabel, smartItems, sortItems, staleUndo, startHistory, startOfDay, thumbable, tintOf,
  toggleIn, typeAhead, undoMoves, within, UNDO_MAX, type Item, type KeyLike, type SortChoice, type UndoEntry,
} from "./filesModel";

const file = (path: string, size = 10, mtime = 1): Item => {
  const name = path.split("/").pop()!;
  return { path, name, folder: false, ext: extOf(name), size, mtime, ctime: mtime };
};
const dir = (path: string): Item => ({ path, name: path.split("/").pop()!, folder: true, ext: "", size: null, mtime: null, ctime: null });

test("kinds and their labels: folders, notes, images, text types, anything else", () => {
  assert.equal(kindOf(dir("brain")), "folder");
  assert.equal(kindOf(file("a.md")), "note");
  assert.equal(kindOf(file("chart.PNG")), "image");
  assert.equal(kindOf(file("config.json")), "text");
  assert.equal(kindOf(file("report.pdf")), "other");
  assert.equal(kindOf(file("Makefile")), "other");
  assert.deepEqual([dir("x"), file("a.md"), file("b.png"), file("c.jpeg"), file("d.json"), file("e.pdf"), file("LICENSE")].map(kindLabel),
    ["Folder", "Markdown note", "PNG image", "JPEG image", "JSON", "PDF file", "Document"]);
  assert.equal(extOf(".env"), "");
  assert.equal(extOf("a.tar.GZ"), "gz");
});

test("the kind tab: brain, workspaces and persona by their top folder, the daily notes' year folders, nothing else", () => {
  assert.equal(tintOf("brain"), "gate");
  assert.equal(tintOf("brain/memory/projects"), "gate");
  assert.equal(tintOf("workspaces/harbor-map/src"), "info");
  assert.equal(tintOf("persona/journal"), "ok");
  assert.equal(tintOf("2026/2026-10-October"), "warn");
  assert.equal(tintOf("templates"), null);
  assert.equal(tintOf("brainstorm"), null);
  assert.equal(tintOf("20261"), null);
});

test("sorting keeps folders first, sorts by the key, and breaks ties by name in natural order", () => {
  const items = [file("b10.md", 5, 30), dir("zeta"), file("b2.md", 50, 10), dir("alpha"), file("a.png", 5, 20)];
  assert.deepEqual(sortItems(items, { key: "name", desc: false }).map((i) => i.name), ["alpha", "zeta", "a.png", "b2.md", "b10.md"]);
  assert.deepEqual(sortItems(items, { key: "name", desc: true }).map((i) => i.name), ["zeta", "alpha", "b10.md", "b2.md", "a.png"]);
  assert.deepEqual(sortItems(items, { key: "modified", desc: true }).map((i) => i.name), ["zeta", "alpha", "b10.md", "a.png", "b2.md"]);
  assert.deepEqual(sortItems(items, { key: "size", desc: false }).map((i) => i.name), ["alpha", "zeta", "a.png", "b10.md", "b2.md"]);
  assert.deepEqual(sortItems(items, { key: "kind", desc: false }).map((i) => i.name), ["alpha", "zeta", "b2.md", "b10.md", "a.png"]);
});

test("Icons' groups come in a fixed order, keep the order they were handed, and leave empty ones out", () => {
  const groups = groupByKind([file("z.md"), dir("d"), file("a.md"), file("p.png"), file("x.json"), file("y.pdf")]);
  assert.deepEqual(groups.map((g) => [g.id, g.label, g.items.map((i) => i.name)]), [
    ["folders", "Folders", ["d"]], ["notes", "Notes", ["z.md", "a.md"]], ["images", "Images", ["p.png"]], ["other", "Other files", ["x.json", "y.pdf"]],
  ]);
  assert.deepEqual(groupByKind([file("a.md")]).map((g) => g.id), ["notes"]);
});

test("selection: one, ⌘-toggle, ⇧-range from the anchor either way, all", () => {
  const order = ["a", "b", "c", "d", "e"];
  let s = selectOnly("b");
  assert.deepEqual(s, { paths: ["b"], cursor: "b", anchor: "b" });
  s = toggleIn(s, "d");
  assert.deepEqual(s.paths, ["b", "d"]);
  assert.equal(s.anchor, "d");
  s = toggleIn(s, "b");
  assert.deepEqual(s.paths, ["d"]);
  s = extendTo(selectOnly("b"), order, "d");
  assert.deepEqual(s, { paths: ["b", "c", "d"], cursor: "d", anchor: "b" });
  s = extendTo(s, order, "a");
  assert.deepEqual(s.paths, ["a", "b"]);
  assert.deepEqual(extendTo(NO_SELECTION, order, "c").paths, ["c"]);
  assert.deepEqual(extendTo(selectOnly("b"), order, "zz"), selectOnly("b"));
  assert.deepEqual(selectAll(order), { paths: order, cursor: "e", anchor: "a" });
  assert.deepEqual(selectAll([]), { paths: [], cursor: null, anchor: null });
});

test("the arrows move the cursor, clamp at the ends, start at an end with no cursor, and extend with ⇧", () => {
  const order = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(moveCursor(NO_SELECTION, order, 1).paths, ["a"]);
  assert.deepEqual(moveCursor(NO_SELECTION, order, -1).paths, ["f"]);
  assert.deepEqual(moveCursor(selectOnly("b"), order, 3).paths, ["e"]);
  assert.deepEqual(moveCursor(selectOnly("e"), order, 3).paths, ["f"]);
  assert.deepEqual(moveCursor(selectOnly("b"), order, -3).paths, ["a"]);
  const ext = moveCursor(moveCursor(selectOnly("b"), order, 1, true), order, 1, true);
  assert.deepEqual(ext, { paths: ["b", "c", "d"], cursor: "d", anchor: "b" });
  assert.deepEqual(moveCursor(selectOnly("b"), [], 1), selectOnly("b"));
});

test("a redraw keeps the selection that still exists; a rename carries it, folders included", () => {
  const s = { paths: ["a", "b/x.md", "c"], cursor: "c", anchor: "a" };
  assert.deepEqual(keepSelection(s, (p) => p !== "c"), { paths: ["a", "b/x.md"], cursor: "b/x.md", anchor: "a" });
  assert.deepEqual(keepSelection(s, () => false), { paths: [], cursor: null, anchor: null });
  assert.deepEqual(renameInSelection({ paths: ["b/x.md", "bb/y.md"], cursor: "b/x.md", anchor: "b" }, "b", "z"),
    { paths: ["z/x.md", "bb/y.md"], cursor: "z/x.md", anchor: "z" });
});

test("back and forward: entering a folder clears forward, the same folder is no step, empty stacks give null", () => {
  let h = startHistory("");
  h = go(h, "brain");
  h = go(h, "brain/memory");
  assert.equal(go(h, "brain/memory"), h);
  const b = goBack(h)!;
  assert.deepEqual(b, { at: "brain", back: [""], forward: ["brain/memory"] });
  const f = goForward(b)!;
  assert.deepEqual(f, { at: "brain/memory", back: ["", "brain"], forward: [] });
  assert.deepEqual(go(b, "persona").forward, []);
  assert.equal(goBack(startHistory("")), null);
  assert.equal(goForward(h), null);
});

test("paths: the parent, the path bar's crumbs, and Columns' chain from a root", () => {
  assert.equal(parentOf("brain/memory/a.md"), "brain/memory");
  assert.equal(parentOf("TODO.md"), "");
  assert.deepEqual(crumbs("brain/memory", "AgenticOS"), [{ name: "AgenticOS", path: "" }, { name: "brain", path: "brain" }, { name: "memory", path: "brain/memory" }]);
  assert.deepEqual(crumbs("", "Vault"), [{ name: "Vault", path: "" }]);
  const folders = new Set(["brain", "brain/memory", "brain/memory/projects"]);
  const isFolder = (p: string) => folders.has(p);
  assert.deepEqual(columnChain("", "brain/memory/projects/a.md", isFolder), ["", "brain", "brain/memory", "brain/memory/projects"]);
  assert.deepEqual(columnChain("", "brain/memory", isFolder), ["", "brain", "brain/memory"]);
  assert.deepEqual(columnChain("brain", "brain/memory/projects/a.md", isFolder), ["brain", "brain/memory", "brain/memory/projects"]);
  assert.deepEqual(columnChain("brain", "persona/x.md", isFolder), ["brain"]);
  assert.deepEqual(columnChain("", null, isFolder), [""]);
});

test("the key map: Finder's keys, view keys on ⌃⌘, nothing for keys it does not own", () => {
  const k = (key: string, mods: Partial<KeyLike> = {}) => keyAction({ key, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...mods });
  assert.equal(k("ArrowDown"), "down");
  assert.equal(k("ArrowLeft", { shiftKey: true }), "left");
  assert.equal(k("Enter"), "rename");
  assert.equal(k(" "), "quicklook");
  assert.equal(k("Escape"), "clear");
  assert.equal(k("Home"), "first");
  assert.equal(k("ArrowDown", { metaKey: true }), "open");
  assert.equal(k("ArrowUp", { metaKey: true }), "parent");
  assert.equal(k("Backspace", { metaKey: true }), "trash");
  assert.equal(k("a", { metaKey: true }), "select-all");
  assert.equal(k("P", { metaKey: true, shiftKey: true }), "preview");
  assert.equal(k("f", { metaKey: true }), "search");
  assert.equal(k("n", { metaKey: true }), "new-note");
  assert.equal(k("1", { metaKey: true, ctrlKey: true }), "view-icons");
  assert.equal(k("3", { metaKey: true, ctrlKey: true }), "view-columns");
  assert.equal(k("d", { metaKey: true }), "duplicate");
  assert.equal(k("z", { metaKey: true }), "undo");
  // ⌥⌘N by the physical key: ⌥N types a dead key on a Mac.
  assert.equal(k("Dead", { metaKey: true, altKey: true, code: "KeyN" }), "new-folder");
  assert.equal(k("n", { metaKey: true, altKey: true }), "new-folder");
  assert.equal(k("z", { metaKey: true, shiftKey: true }), null, "⇧⌘Z is the Edit menu's");
  assert.equal(k("d", { metaKey: true, altKey: true, code: "KeyD" }), null);
  // ⌘1–⌘9 switch tabs, ⇧⌘N is New workspace, ⇧⌘F is Search vault…: not the view's.
  assert.equal(k("1", { metaKey: true }), null);
  assert.equal(k("n", { metaKey: true, shiftKey: true }), null);
  assert.equal(k("f", { metaKey: true, shiftKey: true }), null);
  assert.equal(k("a"), null);
  assert.equal(k("Enter", { shiftKey: true }), null);
  assert.equal(k("ArrowDown", { altKey: true }), null);
  assert.equal(k("ArrowDown", { ctrlKey: true }), null);
});

test("type-ahead finds the first name that starts with the letters, else the first after them", () => {
  const names = ["agents", "archive", "memory", "notifications", "patterns"];
  assert.equal(typeAhead(names, "ar"), 1);
  assert.equal(typeAhead(names, "M"), 2);
  assert.equal(typeAhead(names, "o"), 4);
  assert.equal(typeAhead(names, "zz"), -1);
  assert.equal(typeAhead(names, ""), -1);
});

test("labels: Finder's decimal sizes, counts, compact counts", () => {
  assert.equal(sizeLabel(265), "265 B");
  assert.equal(sizeLabel(12_682), "12.7 KB");
  assert.equal(sizeLabel(128_400), "128 KB");
  assert.equal(sizeLabel(1_900_000), "1.9 MB");
  assert.equal(sizeLabel(null), "--");
  assert.equal(itemsLabel(1), "1 item");
  assert.equal(itemsLabel(6416), "6,416 items");
  assert.equal(compactCount(724), "724");
  assert.equal(compactCount(1861), "1.9k");
  assert.equal(compactCount(12_400), "12k");
});

test("dates: today and yesterday by the local calendar, then the month and day, then the year", () => {
  // Built from local fields, so the result is the same in every time zone the tz-env job runs.
  const now = new Date(2026, 9, 17, 9, 30);
  assert.equal(dateLabel(new Date(2026, 9, 17, 0, 5).getTime(), now), "Today, 00:05");
  assert.equal(dateLabel(new Date(2026, 9, 16, 22, 41).getTime(), now), "Yesterday, 22:41");
  assert.equal(dateLabel(new Date(2026, 9, 15, 18, 2).getTime(), now), "Oct 15, 18:02");
  assert.equal(dateLabel(new Date(2025, 11, 31, 23, 59).getTime(), now), "Dec 31, 2025");
  assert.equal(dateLabel(new Date(2026, 0, 1, 0, 0).getTime(), new Date(2026, 0, 1, 8, 0)), "Today, 00:00");
  assert.equal(dateLabel(new Date(2025, 11, 31, 12, 0).getTime(), new Date(2026, 0, 1, 8, 0)), "Yesterday, 12:00");
  assert.equal(dateLabel(null, now), "--");
});

test("undo (D16): a stack of 20, the newest last; an entry goes stale once its paths change; moves undo last first", () => {
  const entry = (n: number): UndoEntry => ({ label: `#${n}`, moves: [{ from: `a${n}.md`, to: `b${n}.md` }], edits: [] });
  let stack: UndoEntry[] = [];
  for (let i = 1; i <= UNDO_MAX + 3; i++) stack = pushUndo(stack, entry(i));
  assert.equal(stack.length, UNDO_MAX);
  assert.deepEqual([stack[0].label, stack[stack.length - 1].label], ["#4", "#23"]);

  const two: UndoEntry = { label: "move", moves: [{ from: "a/x.md", to: "b/x.md" }, { from: "a/y.md", to: "b/y.md" }], edits: [] };
  const on = (...paths: string[]) => (p: string) => paths.includes(p);
  assert.equal(staleUndo(two, on("b/x.md", "b/y.md")), null);
  assert.equal(staleUndo(two, on("b/x.md")), "y.md is no longer at b/y.md");
  assert.equal(staleUndo(two, on("b/x.md", "b/y.md", "a/x.md")), "a/x.md exists again");
  // A rename of the letter case alone is one file on the disk: both spellings answer.
  assert.equal(staleUndo({ label: "r", moves: [{ from: "n/a.md", to: "n/A.md" }], edits: [] }, on("n/a.md", "n/A.md")), null);
  assert.deepEqual(undoMoves(two), [{ from: "b/y.md", to: "a/y.md" }, { from: "b/x.md", to: "a/x.md" }]);
});

test("thumbnails (D19): images of a known size up to 4 MB, nothing else", () => {
  assert.equal(thumbable(file("a.png", 1)), true);
  assert.equal(thumbable(file("a.SVG", THUMB_MAX_BYTES)), true);
  assert.equal(thumbable(file("a.webp", THUMB_MAX_BYTES + 1)), false, "too large: the page stays");
  assert.equal(thumbable({ ...file("a.gif"), size: null }), false, "a size it does not know");
  for (const p of ["a.md", "a.pdf", "a.json"]) assert.equal(thumbable(file(p)), false, p);
  assert.equal(thumbable(dir("pics.png")), false, "a folder named like an image");
});

test("the thumbnail cache keeps the most recently used, a get or a set making an entry the newest", () => {
  const lru = new Lru<number>(3);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.set("c", 3);
  assert.equal(lru.get("a"), 1);
  lru.set("d", 4);
  assert.deepEqual(lru.keys(), ["c", "a", "d"], "b, the least recently used, went");
  lru.set("c", 30);
  assert.deepEqual(lru.keys(), ["a", "d", "c"]);
  assert.equal(lru.get("c"), 30);
  assert.equal(lru.get("b"), undefined);
  assert.equal(lru.size, 3);
  const nulls = new Lru<string | null>(2);
  nulls.set("x", null);
  assert.equal(nulls.get("x"), null, "a remembered failure is not a miss");
});

test("smart folders (D20): Recents in the order opened, Changed today since local midnight, Images; the runtime's folders left out", () => {
  const now = new Date(2026, 9, 17, 15, 30);
  const midnight = startOfDay(now);
  assert.equal(midnight, new Date(2026, 9, 17).getTime());
  const files = [
    file("notes/b.md", 10, midnight + 1000), file("notes/a.md", 10, midnight - 1), file("pics/z.png", 10, midnight - 5000),
    file("pics/y.JPG", 10, midnight + 10), file("brain/_index/snap.json", 10, midnight + 50), file("brain/_index/chart.png", 10, 1),
  ];
  const hidden = (p: string) => p.startsWith("brain/_index/");
  const sort: SortChoice = { key: "name", desc: false };
  const opts = { recents: ["pics/z.png", "gone.md", "brain/_index/snap.json", "notes/a.md"], now, hidden, sort };
  assert.deepEqual(smartItems("recents", files, opts).map((f) => f.path), ["pics/z.png", "brain/_index/snap.json", "notes/a.md"], "newest opened first; a file gone is left out; Recents keeps what you opened anywhere");
  assert.deepEqual(smartItems("today", files, opts).map((f) => f.path), ["notes/b.md", "pics/y.JPG"]);
  assert.deepEqual(smartItems("today", files, { ...opts, sort: { key: "modified", desc: true } }).map((f) => f.path), ["notes/b.md", "pics/y.JPG"]);
  assert.deepEqual(smartItems("images", files, opts).map((f) => f.path), ["pics/y.JPG", "pics/z.png"]);
  assert.deepEqual(smartItems("today", [dir("notes"), ...files], opts).map((f) => f.path), ["notes/b.md", "pics/y.JPG"], "files only");
  for (const id of ["recents", "today", "images", "tag:status/active"]) assert.equal(isSmartId(id), true, id);
  for (const id of ["tag:", "brain", "", "Recents"]) assert.equal(isSmartId(id), false, id);
});

test("search by name (D22): any case, folders from the files' paths, within a folder or the vault", () => {
  const sort: SortChoice = { key: "name", desc: false };
  const items = [file("Harbor/Tide.md"), file("harbor/notes.md"), file("tides.js"), dir("harbor/tide-charts"), file("x/Café.md".normalize("NFD"))];
  assert.deepEqual(nameMatches(items, "  TIDE ", sort).map((i) => i.path), ["harbor/tide-charts", "Harbor/Tide.md", "tides.js"], "folders first");
  assert.deepEqual(nameMatches(items, "café", sort).length, 1, "Unicode forms compare alike");
  assert.deepEqual(nameMatches(items, "  ", sort), []);
  assert.deepEqual(foldersOf(["a/b/c.md", "a/d.md", "e.md", "a/b/f/g.md"]).sort(), ["a", "a/b", "a/b/f"]);
  assert.equal(within("a/b.md", ""), true);
  assert.equal(within("a/b.md", "a"), true);
  assert.equal(within("a", "a"), true);
  assert.equal(within("ab/c.md", "a"), false);
});
