// The sidebar (files-finder D6, D20): Favorites, by default the vault, Brain, Memory, Workspaces, the daily notes'
// year folder and Persona, the ones that exist. A pick shows that folder, and in Columns starts the columns there.

export interface Favorite { path: string; label: string; icon: string }

/** The default favorites (D20), each only while its folder exists; the vault itself always. `years` are the vault's
 *  four-digit top folders: the daily notes' newest one is the Daily notes favorite. */
export function defaultFavorites(vaultName: string, isFolder: (p: string) => boolean, years: readonly string[]): Favorite[] {
  const year = [...years].sort().pop();
  const all: Favorite[] = [
    { path: "", label: vaultName, icon: "house" },
    { path: "brain", label: "Brain", icon: "brain" },
    { path: "brain/memory", label: "Memory", icon: "library" },
    { path: "workspaces", label: "Workspaces", icon: "folder" },
    ...(year ? [{ path: year, label: "Daily notes", icon: "calendar" }] : []),
    { path: "persona", label: "Persona", icon: "user-round" },
  ];
  return all.filter((f) => f.path === "" || isFolder(f.path));
}

export function renderSidebar(host: HTMLElement, opts: {
  favorites: Favorite[];
  current: string;
  pick: (path: string) => void;
  setIcon: (el: HTMLElement, id: string) => void;
}): void {
  const side = host.createEl("aside", { cls: "aos-fx-side", attr: { "aria-label": "Places", "data-tour": "files-places" } });
  side.createDiv({ cls: "aos-fx-sh", text: "Favorites" });
  for (const f of opts.favorites) {
    const on = f.path === opts.current;
    const a = side.createEl("button", { cls: `aos-fx-si${on ? " is-on" : ""}`, attr: { type: "button", "data-fav": f.path, title: f.path || f.label } });
    if (on) a.setAttr("aria-current", "true");
    const ic = a.createSpan({ cls: "aos-fx-si-ic" });
    opts.setIcon(ic, f.icon);
    a.createSpan({ cls: "aos-fx-si-label", text: f.label });
    a.addEventListener("click", () => opts.pick(f.path));
  }
}
