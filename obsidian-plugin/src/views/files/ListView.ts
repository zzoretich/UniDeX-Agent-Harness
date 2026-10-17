// List (files-finder D8): Name · Date Modified · Size · Kind, the header sorts, and a folder's triangle opens it in
// place (today's tree lives on here). → opens a folder, then goes into it; ← closes it, then goes to its parent.

import { SORT_KEYS, SORT_LABEL, dateLabel, kindLabel, parentOf, sizeLabel, type Item } from "../../data/filesModel";
import { glyphFor, itemEl, type Arrow, type FilesCtx, type Step, type ViewNav } from "./ctx";

export function renderList(host: HTMLElement, ctx: FilesCtx): ViewNav {
  const box = host.createDiv({ cls: "aos-fx-list" });
  const head = box.createDiv({ cls: "aos-fx-lhead", attr: { role: "row" } });
  for (const key of SORT_KEYS) {
    const on = ctx.sort.key === key;
    const b = head.createEl("button", {
      cls: `aos-fx-lh aos-fx-col-${key}${on ? " is-on" : ""}`,
      attr: { type: "button", "data-sort": key, "aria-sort": on ? (ctx.sort.desc ? "descending" : "ascending") : "none" },
    });
    b.createSpan({ text: SORT_LABEL[key] });
    if (on) { const ic = b.createSpan({ cls: "aos-fx-lh-dir" }); if (ctx.sort.desc) ctx.setIcon(ic, "chevron-down"); else ctx.setIcon(ic, "chevron-up"); }
    b.addEventListener("click", () => ctx.sortBy(key));
  }
  const rows = box.createDiv({ cls: "aos-fx-lrows", attr: { role: "listbox", "aria-multiselectable": "true", "aria-label": ctx.at || ctx.vaultName } });
  rows.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest("[data-path]")) return;
    e.preventDefault();
    ctx.menu(null, e, ctx.at);
  });

  const order: string[] = [];
  const shown = new Map<string, Item>();
  const walk = (folder: string, depth: number) => {
    for (const it of ctx.list(folder)) {
      order.push(it.path);
      shown.set(it.path, it);
      const open = it.folder && ctx.expanded.has(it.path);
      const row = rows.createDiv({ cls: `aos-fx-row${it.folder ? " is-folder" : ""}${open ? " is-open" : ""}` });
      itemEl(row, ctx, it, folder);
      if (it.folder) row.setAttr("aria-expanded", open ? "true" : "false");
      const name = row.createDiv({ cls: "aos-fx-cell aos-fx-col-name" });
      name.style.paddingLeft = `${8 + depth * 16}px`;
      const tw = name.createSpan({ cls: "aos-fx-twisty" });
      if (it.folder) {
        tw.setAttr("aria-hidden", "true");
        if (open) ctx.setIcon(tw, "chevron-down"); else ctx.setIcon(tw, "chevron-right");
        tw.addEventListener("click", (e) => { e.stopPropagation(); ctx.toggle(it.path); });
        tw.addEventListener("dblclick", (e) => e.stopPropagation());
      }
      glyphFor(ctx, name.createSpan({ cls: "aos-fx-glyph" }), it);
      name.createSpan({ cls: "aos-fx-name", text: it.name, attr: { title: it.path } });
      row.createDiv({ cls: "aos-fx-cell aos-fx-col-modified", text: dateLabel(it.mtime, ctx.now) });
      row.createDiv({ cls: "aos-fx-cell aos-fx-col-size", text: it.folder ? `${ctx.count(it.path)} items` : sizeLabel(it.size) });
      row.createDiv({ cls: "aos-fx-cell aos-fx-col-kind", text: kindLabel(it) });
      if (open) walk(it.path, depth + 1);
    }
  };
  walk(ctx.at, 0);
  if (!order.length) rows.createDiv({ cls: "aos-fx-empty", text: ctx.at ? "This folder is empty." : "The vault is empty." });

  const step = (from: string | null, arrow: Arrow): Step => {
    if (!order.length) return null;
    const at = from ? order.indexOf(from) : -1;
    if (at < 0) return { select: arrow === "up" ? order[order.length - 1] : order[0] };
    const it = shown.get(from!)!;
    if (arrow === "up") return at > 0 ? { select: order[at - 1] } : null;
    if (arrow === "down") return at < order.length - 1 ? { select: order[at + 1] } : null;
    if (arrow === "right") {
      if (!it.folder) return null;
      if (!ctx.expanded.has(it.path)) return { expand: it.path };
      const next = order[at + 1];
      return next && parentOf(next) === it.path ? { select: next } : null;
    }
    if (it.folder && ctx.expanded.has(it.path)) return { collapse: it.path };
    const up = parentOf(it.path);
    return up !== ctx.at && shown.has(up) ? { select: up } : null;
  };

  const scope = (cursor: string | null) => {
    const dir = cursor ? parentOf(cursor) : ctx.at;
    return ctx.list(shown.has(dir) || dir === ctx.at ? dir : ctx.at).map((i) => ({ name: i.name, path: i.path }));
  };
  return { order, step, typeAheadScope: scope };
}
