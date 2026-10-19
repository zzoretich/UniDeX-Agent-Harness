// Icons (files-finder D7): the folder's entries (or a smart folder's, a tag's, a name search's) as tiles, grouped by
// kind, each with its art, its name and a line of info (a folder's item count, a file's date); an image's art becomes
// its thumbnail once the tile is in view (D19). The arrows move by position, so ↑ ↓ cross the groups as Finder's do.

import { dateLabel, groupByKind, itemsLabel, kindOf, parentOf } from "../../data/filesModel";
import { folderArt, pageArt } from "./art";
import { itemEl, type Arrow, type FilesCtx, type Step, type ViewNav } from "./ctx";

export function renderIcons(host: HTMLElement, ctx: FilesCtx): ViewNav {
  const flat = ctx.flat;
  const items = flat ? flat.items : ctx.list(ctx.at);
  const box = host.createDiv({ cls: "aos-fx-icons", attr: { role: "listbox", "aria-multiselectable": "true", "aria-label": flat?.label ?? (ctx.at || ctx.vaultName) } });
  box.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest("[data-path]")) return;
    e.preventDefault();
    ctx.menu(null, e, ctx.at);
  });
  const order: string[] = [];
  const els = new Map<string, HTMLElement>();
  if (!items.length) box.createDiv({ cls: "aos-fx-empty", text: flat ? flat.empty : ctx.at ? "This folder is empty." : "The vault is empty." });
  for (const g of groupByKind(items)) {
    const sec = box.createDiv({ cls: "aos-fx-group", attr: { "data-group": g.id } });
    const head = sec.createDiv({ cls: "aos-fx-group-head" });
    head.createSpan({ text: g.label });
    head.createSpan({ cls: "aos-fx-group-count", text: String(g.items.length) });
    const grid = sec.createDiv({ cls: "aos-fx-grid" });
    for (const it of g.items) {
      order.push(it.path);
      const tile = grid.createDiv({ cls: "aos-fx-tile" });
      itemEl(tile, ctx, it, flat ? parentOf(it.path) : ctx.at);
      els.set(it.path, tile);
      const art = tile.createDiv({ cls: "aos-fx-tile-art" });
      if (it.folder) {
        folderArt(art, it.path, 64);
        if (ctx.isProtected(`${it.path}/`)) {
          const lock = art.createSpan({ cls: "aos-fx-lock", attr: { title: "Written by the runtime", "aria-label": "Written by the runtime" } });
          ctx.setIcon(lock, "lock");
        }
      } else {
        const lines = kindOf(it) === "note" ? ctx.index?.notes.get(it.path)?.lines ?? null : null;
        pageArt(art, lines, it.ext.toUpperCase(), 58);
        if (kindOf(it) === "image") ctx.thumb(art, it);
      }
      // From across the vault, a tile names where it is too.
      tile.createDiv({ cls: "aos-fx-tile-name", text: it.name, attr: { title: flat ? it.path : it.name } });
      tile.createDiv({ cls: "aos-fx-tile-meta", text: it.folder ? itemsLabel(ctx.count(it.path)) : dateLabel(it.mtime, ctx.now) });
    }
  }

  const step = (from: string | null, arrow: Arrow): Step => {
    if (!order.length) return null;
    const at = from ? order.indexOf(from) : -1;
    if (at < 0) return { select: arrow === "up" || arrow === "left" ? order[order.length - 1] : order[0] };
    if (arrow === "left") return at > 0 ? { select: order[at - 1] } : null;
    if (arrow === "right") return at < order.length - 1 ? { select: order[at + 1] } : null;
    // ↑ ↓: the nearest tile in the next row up or down, by position, across the groups.
    const r = els.get(from!)!.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const rows = order.map((p) => ({ p, b: els.get(p)!.getBoundingClientRect() }))
      .filter(({ b }) => (arrow === "down" ? b.top > r.top + r.height / 2 : b.bottom < r.bottom - r.height / 2));
    if (!rows.length) return null;
    const rowTop = arrow === "down" ? Math.min(...rows.map((x) => x.b.top)) : Math.max(...rows.map((x) => x.b.top));
    const row = rows.filter((x) => Math.abs(x.b.top - rowTop) < 4);
    row.sort((a, b) => Math.abs(a.b.left + a.b.width / 2 - cx) - Math.abs(b.b.left + b.b.width / 2 - cx));
    return { select: row[0].p };
  };

  return { order, step, typeAheadScope: () => items.map((i) => ({ name: i.name, path: i.path })) };
}
