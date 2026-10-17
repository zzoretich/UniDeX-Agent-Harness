// Drag to move (files-finder D15): an item drags from any view, and with it the rest of the selection when it is
// selected; it drops on a folder in a view, a favorite in the sidebar or a folder in the path bar (each marked
// `data-drop` with its folder). Over each target the move is checked once, every item at once (vaultFiles movePlan):
// a target that refuses shows no-drop, and the hint at the foot says why; one that takes it says what the drop will do,
// with the links it updates (D17). Only drags that start in Files are taken: nothing from Finder or other tabs.

/** What a drop on one folder would do: the move and what it says, or why it cannot. */
export type DropVerdict = { ok: true; text: string } | { ok: false; text: string };

export interface DragDeps {
  /** What a drag from `path` carries: the selection when `path` is in it, else `path` alone (which it selects). */
  start(path: string): string[];
  /** Checks a drop of `paths` on `folder`. Called once per target in a drag. */
  check(paths: string[], folder: string): DropVerdict;
  /** Shows the hint at the foot (null hides it). */
  hint(text: string | null, ok: boolean): void;
  drop(paths: string[], folder: string): void;
}

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
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // A type of its own: a drop elsewhere in the app (a note, the terminal) takes nothing from it.
      e.dataTransfer.setData("application/x-unidex-files", this.paths.join("\n"));
    }
    this.deps.hint(this.paths.length === 1 ? "Drop on a folder to move it" : `Drop on a folder to move ${this.paths.length} items`, true);
  }

  private target(e: DragEvent): HTMLElement | null {
    const t = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-drop]") ?? null;
    return t && this.root.contains(t) ? t : null;
  }

  private verdict(folder: string): DropVerdict {
    let v = this.verdicts.get(folder);
    if (!v) { v = this.deps.check(this.paths!, folder); this.verdicts.set(folder, v); }
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
    const v = this.verdict(t.dataset.drop!);
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
    const v = t ? this.verdict(t.dataset.drop!) : null;
    this.finish();
    if (t && v?.ok) this.deps.drop(paths, t.dataset.drop!);
  }

  private finish(): void {
    this.mark(null, null);
    this.paths = null;
    this.verdicts.clear();
    this.deps.hint(null, true);
  }
}
