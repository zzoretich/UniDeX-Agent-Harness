// Drag to move (files-finder D15): an item drags from any view, and with it the rest of the selection when it is
// selected; it drops on a folder in a view, a favorite in the sidebar or a folder in the path bar (each marked
// `data-drop` with its folder). Over each target the move is checked once, every item at once (vaultFiles movePlan):
// a target that refuses shows no-drop, and the hint at the foot says why; one that takes it says what the drop will do,
// with the links it updates (D17). A folder dropped on the sidebar's Favorites, but not on a favorite, joins them (D20,
// `data-fav-add`); while a drag is on, the tab carries `is-dragging`, which shows the slot that says so. Only drags
// that start in Files are taken: nothing from Finder or other tabs.

/** What a drop on one folder would do: the move and what it says, or why it cannot. */
export type DropVerdict = { ok: true; text: string } | { ok: false; text: string };

export interface DragDeps {
  /** What a drag from `path` carries: the selection when `path` is in it, else `path` alone (which it selects). */
  start(path: string): string[];
  /** Checks a drop of `paths` on `folder`. Called once per target in a drag. */
  check(paths: string[], folder: string): DropVerdict;
  /** Checks a drop of `paths` on Favorites: folders only, each not a favorite yet. */
  checkFavorite(paths: string[]): DropVerdict;
  /** Shows the hint at the foot (null hides it). */
  hint(text: string | null, ok: boolean): void;
  drop(paths: string[], folder: string): void;
  addFavorites(paths: string[]): void;
}

/** The verdicts' key for a drop on Favorites: no vault path holds a NUL. */
const FAVORITES = "\u0000favorites";

export class FilesDrag {
  private paths: string[] | null = null;
  private over: HTMLElement | null = null;
  private verdicts = new Map<string, DropVerdict>();

  constructor(private root: HTMLElement, private deps: DragDeps) {
    root.addEventListener("dragstart", (e) => this.onStart(e));
    root.addEventListener("dragover", (e) => this.onOver(e));
    root.addEventListener("dragleave", (e) => this.onLeave(e));
    root.addEventListener("drop", (e) => this.onDrop(e));
    root.addEventListener("dragend", () => this.finish());
  }

  isDragging(): boolean { return this.paths !== null; }

  private onStart(e: DragEvent): void {
    const src = (e.target as HTMLElement).closest<HTMLElement>("[data-path][draggable='true']");
    if (!src || !this.root.contains(src)) return;
    this.paths = this.deps.start(src.dataset.path!);
    this.verdicts.clear();
    this.root.addClass("is-dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // A type of its own: a drop elsewhere in the app (a note, the terminal) takes nothing from it.
      e.dataTransfer.setData("application/x-unidex-files", this.paths.join("\n"));
    }
    this.deps.hint(this.paths.length === 1 ? "Drop on a folder to move it" : `Drop on a folder to move ${this.paths.length} items`, true);
  }

  /** The drop target under the pointer: a folder (`data-drop`), or Favorites around its entries (`data-fav-add`). */
  private target(e: DragEvent): HTMLElement | null {
    const t = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-drop], [data-fav-add]") ?? null;
    return t && this.root.contains(t) ? t : null;
  }

  private keyOf(t: HTMLElement): string {
    return t.dataset.drop !== undefined ? t.dataset.drop : FAVORITES;
  }

  private verdict(key: string): DropVerdict {
    let v = this.verdicts.get(key);
    if (!v) { v = key === FAVORITES ? this.deps.checkFavorite(this.paths!) : this.deps.check(this.paths!, key); this.verdicts.set(key, v); }
    return v;
  }

  private mark(t: HTMLElement | null, v: DropVerdict | null): void {
    if (this.over && this.over !== t) {
      this.over.removeClass("is-drop");
      this.over.removeClass("is-nodrop");
    }
    this.over = t;
    if (!t || !v) return;
    t.toggleClass("is-drop", v.ok);
    t.toggleClass("is-nodrop", !v.ok);
  }

  private onOver(e: DragEvent): void {
    if (!this.paths) return;
    const t = this.target(e);
    if (!t) { this.mark(null, null); return; }
    const v = this.verdict(this.keyOf(t));
    this.mark(t, v);
    this.deps.hint(v.text, v.ok);
    if (v.ok) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    } else if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  }

  private onLeave(e: DragEvent): void {
    if (!this.paths || !this.over) return;
    const to = e.relatedTarget as Node | null;
    if (to && this.over.contains(to)) return;
    this.mark(null, null);
  }

  private onDrop(e: DragEvent): void {
    if (!this.paths) return;
    const t = this.target(e);
    const paths = this.paths;
    e.preventDefault();
    const key = t ? this.keyOf(t) : null;
    const v = key !== null ? this.verdict(key) : null;
    this.finish();
    if (key === null || !v?.ok) return;
    if (key === FAVORITES) this.deps.addFavorites(paths);
    else this.deps.drop(paths, key);
  }

  private finish(): void {
    this.root.removeClass("is-dragging");
    this.mark(null, null);
    this.paths = null;
    this.verdicts.clear();
    this.deps.hint(null, true);
  }
}
