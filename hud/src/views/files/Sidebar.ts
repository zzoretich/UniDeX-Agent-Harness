// The sidebar (files-finder D6, D20): Favorites, by default the vault, Brain, Memory, Workspaces, the daily notes' year
// folder and Persona, the ones that exist, and the user's own once a folder is dragged in or one removed; then the smart
// folders (Recents, Changed today, Images) and the vault's most used tags. A folder pick shows that folder, and in
// Columns starts the columns there; a smart folder or a tag lists its files in the view.

import { SMART_FOLDERS } from "../../data/filesModel";

export interface Favorite { path: string; label: string; icon: string }

/** The default favorites' paths (D20), the daily notes' newest year folder among them when there is one. `years` are
 *  the vault's four-digit top folders. */
export function defaultFavoritePaths(years: readonly string[]): string[] {
  const year = [...years].sort().pop();
  return ["", "brain", "brain/memory", "workspaces", ...(year ? [year] : []), "persona"];
}

/** The favorites to show: each path (the defaults when `paths` is null) while its folder exists, the vault itself
 *  always. The default ones keep their names and icons; another is its folder's name. */
export function favoritesFrom(paths: readonly string[] | null, vaultName: string, isFolder: (p: string) => boolean, years: readonly string[]): Favorite[] {
  const year = [...years].sort().pop();
  const known: Record<string, { label: string; icon: string }> = {
    "": { label: vaultName, icon: "house" },
    brain: { label: "Brain", icon: "brain" },
    "brain/memory": { label: "Memory", icon: "library" },
    workspaces: { label: "Workspaces", icon: "folder" },
    persona: { label: "Persona", icon: "user-round" },
    ...(year ? { [year]: { label: "Daily notes", icon: "calendar" } } : {}),
  };
  return (paths ?? defaultFavoritePaths(years))
    .filter((p) => p === "" || isFolder(p))
    .map((p) => ({ path: p, ...(known[p] ?? { label: p.split("/").pop()!, icon: "folder" }) }));
}

/** The favorites' paths after `add` goes in (at the end, once) or `remove` comes out; null stays the defaults until
 *  it changes. */
export function editFavorites(current: readonly string[] | null, years: readonly string[], change: { add?: readonly string[]; remove?: string }): string[] {
  let out = [...(current ?? defaultFavoritePaths(years))];
  for (const p of change.add ?? []) if (!out.includes(p)) out.push(p);
  if (change.remove !== undefined) out = out.filter((p) => p !== change.remove);
  return out;
}

export interface SidebarOpts {
  favorites: Favorite[];
  /** The vault's most used tags, null while the vault is still being read. */
  tags: Array<{ tag: string; count: number }> | null;
  /** The folder in view, or null when a smart folder or a tag is. */
  current: string | null;
  /** The smart folder or `tag:<name>` in view, or null. */
  smart: string | null;
  pick(path: string): void;
  pickSmart(id: string): void;
  /** A right-click on a favorite. */
  menu(fav: Favorite, e: MouseEvent): void;
  setIcon(el: HTMLElement, id: string): void;
}

/** One sidebar row: its icon's span (set by the caller) and its label. */
function entry(host: HTMLElement, on: boolean, label: string, title: string, attrs: Record<string, string>): { a: HTMLButtonElement; ic: HTMLElement } {
  const a = host.createEl("button", { cls: `aos-fx-si${on ? " is-on" : ""}`, attr: { type: "button", title, ...attrs } });
  if (on) a.setAttr("aria-current", "true");
  const ic = a.createSpan({ cls: "aos-fx-si-ic" });
  a.createSpan({ cls: "aos-fx-si-label", text: label });
  return { a, ic };
}

export function renderSidebar(host: HTMLElement, opts: SidebarOpts): HTMLElement {
  const side = host.createEl("aside", { cls: "aos-fx-side", attr: { "aria-label": "Places", "data-tour": "files-places" } });
  drawSidebar(side, opts);
  return side;
}

/** Draws the sidebar's sections into `side`, again in place when the tags or the favorites change. */
export function drawSidebar(side: HTMLElement, opts: SidebarOpts): void {
  side.empty();
  // A folder dragged onto the section, not onto a favorite, joins the favorites (data-fav-add, drag.ts).
  const favs = side.createDiv({ cls: "aos-fx-sgroup aos-fx-favs", attr: { "data-fav-add": "", "data-tour": "files-favorites" } });
  favs.createDiv({ cls: "aos-fx-sh", text: "Favorites" });
  for (const f of opts.favorites) {
    // A favorite takes drops into its folder (D15).
    const { a, ic } = entry(favs, opts.smart === null && f.path === opts.current, f.label, f.path || f.label, { "data-fav": f.path, "data-drop": f.path });
    opts.setIcon(ic, f.icon);
    a.addEventListener("click", () => opts.pick(f.path));
    a.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); opts.menu(f, e); });
  }
  favs.createDiv({ cls: "aos-fx-favslot", text: "Drop a folder here to add it", attr: { "aria-hidden": "true" } });

  const smart = side.createDiv({ cls: "aos-fx-sgroup", attr: { "data-tour": "files-smart" } });
  smart.createDiv({ cls: "aos-fx-sh", text: "Smart folders" });
  for (const s of SMART_FOLDERS) {
    const { a, ic } = entry(smart, opts.smart === s.id, s.label, s.label, { "data-smart": s.id });
    opts.setIcon(ic, s.icon);
    a.addEventListener("click", () => opts.pickSmart(s.id));
  }

  const tags = side.createDiv({ cls: "aos-fx-sgroup aos-fx-tags" });
  tags.createDiv({ cls: "aos-fx-sh", text: "Tags" });
  if (opts.tags === null) { tags.createDiv({ cls: "aos-fx-sdim", text: "Reading the vault…" }); return; }
  if (!opts.tags.length) { tags.createDiv({ cls: "aos-fx-sdim", text: "No tags in the notes' frontmatter yet" }); return; }
  for (const t of opts.tags) {
    const id = `tag:${t.tag}`;
    const { a, ic } = entry(tags, opts.smart === id, t.tag, `#${t.tag} · ${t.count} note${t.count === 1 ? "" : "s"}`, { "data-smart": id });
    opts.setIcon(ic, "hash");
    a.createSpan({ cls: "aos-fx-si-count", text: String(t.count) });
    a.addEventListener("click", () => opts.pickSmart(id));
  }
}
