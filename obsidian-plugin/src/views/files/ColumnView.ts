// Columns (files-finder D9): Miller columns from the root the sidebar last picked down to the cursor, then the
// preview of the file the cursor is on (D10). ↑ ↓ move in the cursor's column, → goes into a folder, ← back out.

import { columnChain, compactCount, parentOf, type Item } from "../../data/filesModel";
import { glyphFor, itemEl, type Arrow, type FilesCtx, type Step, type ViewNav } from "./ctx";

export function renderColumns(host: HTMLElement, ctx: FilesCtx): ViewNav {
  const box = host.createDiv({ cls: "aos-fx-columns" });
  const cursor = ctx.sel.cursor;
  const isFolder = (p: string) => ctx.item(p)?.folder ?? false;
  const target = cursor ?? (ctx.at !== ctx.colRoot ? ctx.at : null);
  const chain = columnChain(ctx.colRoot, target, isFolder);
  const lists = new Map<string, Item[]>();

  chain.forEach((folder, i) => {
    const items = ctx.list(folder);
    lists.set(folder, items);
    // A column takes drops too: into its folder (D15).
    const col = box.createDiv({ cls: "aos-fx-col", attr: { role: "listbox", "aria-multiselectable": "true", "aria-label": folder || ctx.vaultName, "data-folder": folder, "data-drop": folder } });
    col.addEventListener("contextmenu", (e) => {
      if ((e.target as HTMLElement).closest("[data-path]")) return;
      e.preventDefault();
      ctx.menu(null, e, folder);
    });
    const next = chain[i + 1];
    for (const it of items) {
      const row = col.createDiv({ cls: `aos-fx-crow${it.path === next ? " is-trail" : ""}` });
      itemEl(row, ctx, it, folder);
      glyphFor(ctx, row.createSpan({ cls: "aos-fx-glyph" }), it);
      row.createSpan({ cls: "aos-fx-name", text: it.name, attr: { title: it.name } });
      if (it.folder) {
        row.createSpan({ cls: "aos-fx-ccount", text: compactCount(ctx.count(it.path)) });
        const chev = row.createSpan({ cls: "aos-fx-chev", attr: { "aria-hidden": "true" } });
        ctx.setIcon(chev, "chevron-right");
      }
    }
    if (!items.length) col.createDiv({ cls: "aos-fx-empty", text: "Empty" });
  });
  const file = cursor && !isFolder(cursor) ? cursor : null;
  if (file) ctx.preview(box.createDiv({ cls: "aos-fx-col aos-fx-pcol", attr: { "aria-label": "Preview" } }).createDiv(), file);
  // The newest column in sight, as Finder keeps it.
  window.requestAnimationFrame(() => { box.scrollLeft = box.scrollWidth; });

  /** The column the cursor is in, or the last one when there is no cursor. */
  const home = (): string => (cursor && lists.has(parentOf(cursor)) ? parentOf(cursor) : chain[chain.length - 1]);
  const homeItems = (): Item[] => lists.get(home()) ?? [];

  const step = (from: string | null, arrow: Arrow): Step => {
    const items = homeItems();
    const at = from ? items.findIndex((i) => i.path === from) : -1;
    if (at < 0) return items.length ? { select: items[0].path } : null;
    const it = items[at];
    if (arrow === "up") return at > 0 ? { select: items[at - 1].path } : null;
    if (arrow === "down") return at < items.length - 1 ? { select: items[at + 1].path } : null;
    if (arrow === "right") {
      if (!it.folder) return null;
      const inner = ctx.list(it.path);
      return inner.length ? { select: inner[0].path } : null;
    }
    // ← goes to the folder the cursor is in, when that folder is a row of an earlier column (not the root column).
    const up = parentOf(it.path);
    return chain.indexOf(up) > 0 ? { select: up } : null;
  };

  return {
    get order() { return homeItems().map((i) => i.path); },
    step,
    typeAheadScope: () => homeItems().map((i) => ({ name: i.name, path: i.path })),
  };
}
