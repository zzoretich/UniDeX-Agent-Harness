// What the Files tab hands its views (files-finder D6–D10), and what a view hands back: the order it shows and
// where an arrow goes. The views only draw and report; the tab keeps the state and does every change.

import type { Item, Selection, SortChoice, SortKey } from "../../data/filesModel";
import type { VaultIndex } from "../../data/vaultIndex";

export type Arrow = "up" | "down" | "left" | "right";

/** What an arrow does: move the cursor, or open or close a List folder in place. */
export type Step = { select: string } | { expand: string } | { collapse: string } | null;

export interface ViewNav {
  /** Every path the view shows, in reading order: ⇧-ranges, ⌘A, Quick Look's ← → and type-ahead run over it. */
  order: string[];
  /** Where an arrow goes from `from` (null: nothing selected yet). */
  step(from: string | null, arrow: Arrow): Step;
  /** The names type-ahead searches, with their paths: the folder the cursor is in. */
  typeAheadScope(cursor: string | null): Array<{ name: string; path: string }>;
}

export interface FilesCtx {
  vaultName: string;
  now: Date;
  /** The folder Icons and List show, and Columns' last folder ("" the vault). */
  at: string;
  /** Where Columns starts: the favorite last picked, or the vault. */
  colRoot: string;
  sel: Selection;
  sort: SortChoice;
  index: VaultIndex | null;
  /** List's open folders. */
  expanded: ReadonlySet<string>;
  /** A folder's listed entries, sorted; [] for one that is gone. */
  list(folder: string): Item[];
  item(path: string): Item | null;
  /** How many listed entries a folder holds. */
  count(folder: string): number;
  isProtected(path: string): boolean;
  /** Obsidian's setIcon, called with literal ids so `npm run check:compat` sees each one. */
  setIcon(el: HTMLElement, id: string): void;
  /** A click on an item (selection by its modifiers; `order` is the view's). */
  press(path: string, e: MouseEvent): void;
  /** A double-click: a folder is entered, a file opened (D12). */
  activate(path: string): void;
  /** A right-click on an item, or on empty space in `folder` (path null). */
  menu(path: string | null, e: MouseEvent, folder: string): void;
  /** List's disclosure triangle. */
  toggle(folder: string): void;
  /** List's header: sort by `key`, again to reverse. */
  sortBy(key: SortKey): void;
  /** Draws the preview of `path` into `host` (Columns' last column, D10). */
  preview(host: HTMLElement, path: string): void;
}

/** Marks an element as one item of a view: its path, the role, the right-click, and dragging (D15): every item drags,
 *  a folder takes drops. */
export function itemEl(el: HTMLElement, ctx: FilesCtx, item: Item, folder: string): void {
  const path = item.path;
  el.setAttr("data-path", path);
  el.setAttr("role", "option");
  el.setAttr("aria-selected", "false");
  el.setAttr("draggable", "true");
  if (item.folder) el.setAttr("data-drop", path);
  el.addEventListener("click", (e) => ctx.press(path, e));
  el.addEventListener("dblclick", (e) => { e.preventDefault(); ctx.activate(path); });
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); ctx.menu(path, e, folder); });
}

/** The glyph a row shows for an item (List, Columns, search hits). */
export function glyphFor(ctx: FilesCtx, el: HTMLElement, item: Item): void {
  if (item.folder) { if (ctx.isProtected(`${item.path}/`)) ctx.setIcon(el, "folder-lock"); else ctx.setIcon(el, "folder"); return; }
  if (item.ext === "md") ctx.setIcon(el, "file-text");
  else if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(item.ext)) ctx.setIcon(el, "image");
  else if (["json", "jsonl", "yml", "yaml", "toml", "csv"].includes(item.ext)) ctx.setIcon(el, "file-json");
  else if (["js", "cjs", "mjs", "ts", "css", "html", "sh", "py"].includes(item.ext)) ctx.setIcon(el, "file-code");
  else ctx.setIcon(el, "file");
}
