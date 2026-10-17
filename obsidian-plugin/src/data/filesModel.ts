// The Files tab's pure parts (spec 2026-10-17-files-finder): what kind a file is and what it is called, the kind tab
// a top folder gives everything under it (D3), sorting and grouping (D7, D8), the selection with its cursor and
// anchor (D4), back and forward (D6), the undo stack (D16), the key map (D23), type-ahead, and the size and date labels. No obsidian
// import: the tab hands in plain items.

export type ViewMode = "icons" | "list" | "columns";
export const VIEW_MODES: readonly ViewMode[] = ["icons", "list", "columns"];
export const VIEW_LABEL: Record<ViewMode, string> = { icons: "Icons", list: "List", columns: "Columns" };

/** One entry of a folder, as the views draw it. `size`, `mtime` and `ctime` are null for a folder. */
export interface Item {
  path: string;
  name: string;
  folder: boolean;
  /** Lower case, without the dot; "" for a folder or a name with none. */
  ext: string;
  size: number | null;
  mtime: number | null;
  ctime: number | null;
}

export type Kind = "folder" | "note" | "text" | "image" | "other";

/** Image types the views draw as images (D19's thumbnails, Quick Look). */
export const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/** Text types that are not notes, opened in a note tab like today (vaultFiles TEXT_EXTENSIONS minus md). */
const TEXT_KINDS: Record<string, string> = {
  txt: "Plain text", json: "JSON", jsonl: "JSON Lines", yml: "YAML", yaml: "YAML", toml: "TOML", csv: "CSV",
  js: "JavaScript", cjs: "JavaScript", mjs: "JavaScript", ts: "TypeScript", css: "CSS", html: "HTML", sh: "Shell script",
  py: "Python",
};

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function kindOf(item: Pick<Item, "folder" | "ext">): Kind {
  if (item.folder) return "folder";
  if (item.ext === "md") return "note";
  if (IMAGE_EXTENSIONS.includes(item.ext)) return "image";
  if (item.ext in TEXT_KINDS) return "text";
  return "other";
}

/** What the Kind column and the preview call it, as Finder does ("PNG image", "Markdown note"). */
export function kindLabel(item: Pick<Item, "folder" | "ext">): string {
  const k = kindOf(item);
  if (k === "folder") return "Folder";
  if (k === "note") return "Markdown note";
  if (k === "image") return `${item.ext === "jpeg" ? "JPEG" : item.ext.toUpperCase()} image`;
  if (k === "text") return TEXT_KINDS[item.ext];
  return item.ext ? `${item.ext.toUpperCase()} file` : "Document";
}

/** The kind tab (D3): a status tone per top folder, inherited by every folder under it. */
export type Tint = "gate" | "info" | "ok" | "warn";
const TOP_TINTS: Record<string, Tint> = { brain: "gate", workspaces: "info", persona: "ok" };

export function tintOf(path: string): Tint | null {
  const top = path.split("/")[0];
  if (TOP_TINTS[top]) return TOP_TINTS[top];
  // The daily notes' year folders (dailyNote.layout's default `<year>/…`).
  return /^\d{4}$/.test(top) ? "warn" : null;
}

export type SortKey = "name" | "modified" | "size" | "kind";
export const SORT_KEYS: readonly SortKey[] = ["name", "modified", "size", "kind"];
export const SORT_LABEL: Record<SortKey, string> = { name: "Name", modified: "Date Modified", size: "Size", kind: "Kind" };
export interface SortChoice { key: SortKey; desc: boolean }

const byName = (a: Item, b: Item): number => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** Folders first (today's rule, Finder's "keep folders on top"), then by the key; ties and folders by name. */
export function sortItems(items: readonly Item[], sort: SortChoice): Item[] {
  const sign = sort.desc ? -1 : 1;
  const cmp = (a: Item, b: Item): number => {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    let d = 0;
    if (sort.key === "modified") d = (a.mtime ?? 0) - (b.mtime ?? 0);
    else if (sort.key === "size") d = (a.size ?? 0) - (b.size ?? 0);
    else if (sort.key === "kind") d = kindLabel(a).localeCompare(kindLabel(b));
    if (sort.key === "name" || d === 0) return sign * byName(a, b);
    return sign * d;
  };
  return [...items].sort(cmp);
}

export type GroupId = "folders" | "notes" | "images" | "other";
export interface Group { id: GroupId; label: string; items: Item[] }
const GROUP_LABEL: Record<GroupId, string> = { folders: "Folders", notes: "Notes", images: "Images", other: "Other files" };

/** Icons' groups (D7), in this order, empty ones left out; each keeps the order it was handed. */
export function groupByKind(items: readonly Item[]): Group[] {
  const groupOf = (i: Item): GroupId => {
    const k = kindOf(i);
    return k === "folder" ? "folders" : k === "note" ? "notes" : k === "image" ? "images" : "other";
  };
  return (["folders", "notes", "images", "other"] as GroupId[])
    .map((id) => ({ id, label: GROUP_LABEL[id], items: items.filter((i) => groupOf(i) === id) }))
    .filter((g) => g.items.length);
}

// ── selection (D4) ──

/** The selected paths, the cursor (where the arrows move from, the last one clicked) and the anchor of a ⇧-range. */
export interface Selection { paths: string[]; cursor: string | null; anchor: string | null }

export const NO_SELECTION: Selection = { paths: [], cursor: null, anchor: null };

export function selectOnly(path: string): Selection {
  return { paths: [path], cursor: path, anchor: path };
}

/** ⌘-click: adds or removes one path; the cursor and the anchor move to it. */
export function toggleIn(sel: Selection, path: string): Selection {
  const has = sel.paths.includes(path);
  return { paths: has ? sel.paths.filter((p) => p !== path) : [...sel.paths, path], cursor: path, anchor: path };
}

/** ⇧-click or ⇧-arrow: everything between the anchor and `path` in `order`; the anchor stays. */
export function extendTo(sel: Selection, order: readonly string[], path: string): Selection {
  const anchor = sel.anchor && order.includes(sel.anchor) ? sel.anchor : path;
  const a = order.indexOf(anchor);
  const b = order.indexOf(path);
  if (b < 0) return sel;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return { paths: order.slice(lo, hi + 1), cursor: path, anchor };
}

export function selectAll(order: readonly string[]): Selection {
  return { paths: [...order], cursor: order[order.length - 1] ?? null, anchor: order[0] ?? null };
}

/**
 * The arrows: the cursor moves `delta` places in `order` (± the columns per row in Icons), clamped at the ends. With
 * `extend` the range from the anchor follows it; without, the selection is the new cursor alone. No cursor yet: the
 * first item (or the last, going back).
 */
export function moveCursor(sel: Selection, order: readonly string[], delta: number, extend = false): Selection {
  if (!order.length) return sel;
  const at = sel.cursor ? order.indexOf(sel.cursor) : -1;
  const to = at < 0 ? (delta < 0 ? order.length - 1 : 0) : Math.max(0, Math.min(order.length - 1, at + delta));
  return extend ? extendTo(sel, order, order[to]) : selectOnly(order[to]);
}

/** After a redraw: the paths that still exist, a cursor and an anchor only while they do. */
export function keepSelection(sel: Selection, exists: (p: string) => boolean): Selection {
  const paths = sel.paths.filter(exists);
  return {
    paths,
    cursor: sel.cursor && exists(sel.cursor) ? sel.cursor : paths[paths.length - 1] ?? null,
    anchor: sel.anchor && exists(sel.anchor) ? sel.anchor : null,
  };
}

/** A path (or a folder above it) renamed from `from` to `to`: the selection follows it. */
export function renameInSelection(sel: Selection, from: string, to: string): Selection {
  const move = (p: string | null): string | null => (p === null ? null : p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  return { paths: sel.paths.map((p) => move(p)!), cursor: move(sel.cursor), anchor: move(sel.anchor) };
}

// ── back and forward (D6) ──

export interface History { at: string; back: string[]; forward: string[] }

export function startHistory(at: string): History { return { at, back: [], forward: [] }; }

/** Entering a folder: the old one goes on the back stack and forward is cleared; the same folder changes nothing. */
export function go(h: History, to: string): History {
  if (to === h.at) return h;
  return { at: to, back: [...h.back, h.at].slice(-50), forward: [] };
}

export function goBack(h: History): History | null {
  if (!h.back.length) return null;
  return { at: h.back[h.back.length - 1], back: h.back.slice(0, -1), forward: [h.at, ...h.forward] };
}

export function goForward(h: History): History | null {
  if (!h.forward.length) return null;
  return { at: h.forward[0], back: [...h.back, h.at], forward: h.forward.slice(1) };
}

/** The folder a path is in ("" the vault root). */
export function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** The path bar's segments for `path`: the vault (path ""), then each folder, then the item itself. */
export function crumbs(path: string, vaultName: string): Array<{ name: string; path: string }> {
  const out = [{ name: vaultName, path: "" }];
  if (!path) return out;
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) out.push({ name: parts[i - 1], path: parts.slice(0, i).join("/") });
  return out;
}

/** Columns (D9): the folders shown from `root` down to the one `path` is in (or `path` itself, when it is a folder). */
export function columnChain(root: string, path: string | null, isFolder: (p: string) => boolean): string[] {
  const chain = [root];
  if (!path || path === root) return chain;
  const inside = root ? (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null) : path;
  if (inside === null) return chain;
  const parts = inside.split("/");
  const upTo = isFolder(path) ? parts.length : parts.length - 1;
  for (let i = 1; i <= upTo; i++) chain.push(root ? `${root}/${parts.slice(0, i).join("/")}` : parts.slice(0, i).join("/"));
  return chain;
}

// ── undo (D16) ──

/** One undoable change: the moves it made (a rename is one), and the notes whose links it rewrote, each with its text
 *  before and after, by the path it had before (`home`) and after the move. */
export interface UndoEntry {
  label: string;
  moves: Array<{ from: string; to: string }>;
  edits: Array<{ home: string; path: string; before: string; after: string }>;
}

export const UNDO_MAX = 20;

/** The stack after a change: the newest last, the oldest dropped past UNDO_MAX. */
export function pushUndo(stack: readonly UndoEntry[], entry: UndoEntry, max = UNDO_MAX): UndoEntry[] {
  return [...stack, entry].slice(-max);
}

/**
 * Why an entry cannot be undone any more, or null: it is stale once its paths changed, so every moved item must still
 * be where it went and nothing may have taken its old place. `exists` asks the vault.
 */
export function staleUndo(entry: UndoEntry, exists: (p: string) => boolean): string | null {
  for (const m of entry.moves) {
    const name = m.to.split("/").pop()!;
    if (!exists(m.to)) return `${name} is no longer at ${m.to}`;
    // A rename that only changed the letter case is the same file on the disk.
    if (exists(m.from) && m.from.toLowerCase() !== m.to.toLowerCase()) return `${m.from} exists again`;
  }
  return null;
}

/** The moves that undo an entry: each one back, the last first. */
export function undoMoves(entry: UndoEntry): Array<{ from: string; to: string }> {
  return [...entry.moves].reverse().map((m) => ({ from: m.to, to: m.from }));
}

// ── keys (D23) ──

export type KeyAction =
  | "up" | "down" | "left" | "right" | "first" | "last"
  | "open" | "parent" | "rename" | "quicklook" | "clear" | "trash" | "select-all"
  | "view-icons" | "view-list" | "view-columns" | "preview" | "search" | "new-note"
  | "new-folder" | "duplicate" | "undo";

/** `code` is the physical key: ⌥ turns a letter into another character (⌥N is a dead key), so ⌥⌘N is read by it. */
export interface KeyLike { key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; code?: string }

/** The view's own keys, while focus is in Files and not in a field. ⇧ on an arrow extends (the caller reads shiftKey). */
export function keyAction(e: KeyLike): KeyAction | null {
  const k = e.key;
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  if (e.metaKey && e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (k === "1") return "view-icons";
    if (k === "2") return "view-list";
    if (k === "3") return "view-columns";
    return null;
  }
  if (e.ctrlKey) return null;
  if (e.metaKey && e.altKey && !e.shiftKey) return e.code === "KeyN" || k.toLowerCase() === "n" ? "new-folder" : null;
  if (e.metaKey && !e.altKey) {
    const l = k.toLowerCase();
    if (k === "ArrowDown" && !e.shiftKey) return "open";
    if (k === "ArrowUp" && !e.shiftKey) return "parent";
    if (k === "Backspace" && !e.shiftKey) return "trash";
    if (l === "a" && !e.shiftKey) return "select-all";
    if (l === "p" && e.shiftKey) return "preview";
    if (l === "f" && !e.shiftKey) return "search";
    if (l === "n" && !e.shiftKey) return "new-note";
    if (l === "d" && !e.shiftKey) return "duplicate";
    // ⇧⌘Z (redo) is the Edit menu's.
    if (l === "z" && !e.shiftKey) return "undo";
    return null;
  }
  if (!plain) return null;
  if (k === "ArrowUp") return "up";
  if (k === "ArrowDown") return "down";
  if (k === "ArrowLeft") return "left";
  if (k === "ArrowRight") return "right";
  if (e.shiftKey) return null;
  if (k === "Home") return "first";
  if (k === "End") return "last";
  if (k === "Enter") return "rename";
  if (k === " ") return "quicklook";
  if (k === "Escape") return "clear";
  return null;
}

/** Type-ahead (Finder's): the first name that starts with what was typed, else the first that sorts after it. */
export function typeAhead(names: readonly string[], typed: string): number {
  const t = typed.toLowerCase();
  if (!t) return -1;
  const starts = names.findIndex((n) => n.toLowerCase().startsWith(t));
  if (starts >= 0) return starts;
  return names.findIndex((n) => n.localeCompare(typed, undefined, { numeric: true, sensitivity: "base" }) > 0);
}

// ── labels ──

/** Finder's sizes: decimal units, one decimal under 100. */
export function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "--";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return `${v < 100 ? Math.round(v * 10) / 10 : Math.round(v)} ${units[u]}`;
}

export function itemsLabel(n: number): string {
  return `${n.toLocaleString("en-US")} item${n === 1 ? "" : "s"}`;
}

/** A count for a column row: 724, 1.9k, 12k. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? Math.round(k * 10) / 10 : Math.round(k)}k`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number): string => String(n).padStart(2, "0");

/** "Today, 22:41", "Yesterday, 08:12", "Oct 15, 18:02", or "Oct 15, 2025" in an earlier year; local time. */
export function dateLabel(ms: number | null, now: Date): string {
  if (ms === null) return "--";
  const d = new Date(ms);
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const today = day(now);
  if (day(d) === today) return `Today, ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (day(d) === yesterday) return `Yesterday, ${time}`;
  if (d.getFullYear() === now.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
