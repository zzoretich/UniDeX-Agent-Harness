// The right-click menu (files-finder D13): a DOM popover at the pointer, like the HUD's other menus, not Obsidian's
// Menu. An item that cannot run here stays in the list, off, and says why on hover. Keys: ↑ ↓ move, ↩ or Space runs,
// Esc or Tab closes; focus goes back to the view.

export type MenuEntry =
  | { label: string; run: () => void; key?: string; off?: string | null; danger?: boolean; act: string }
  | { separator: true };

export class FilesMenu {
  private el: HTMLElement | null = null;
  private onDoc = (e: MouseEvent) => { if (this.el && !this.el.contains(e.target as Node)) this.close(); };
  private restore: HTMLElement | null = null;

  constructor(private host: HTMLElement) {}

  isOpen(): boolean { return this.el !== null; }

  /** Opens at the pointer (or under `anchor`), clamped inside the tab. */
  open(entries: MenuEntry[], at: { x: number; y: number } | HTMLElement, label: string): void {
    this.close();
    this.restore = document.activeElement as HTMLElement | null;
    const menu = this.host.createDiv({ cls: "aos-fx-menu", attr: { role: "menu", "aria-label": label } });
    this.el = menu;
    for (const e of entries) {
      if ("separator" in e) { menu.createDiv({ cls: "aos-fx-msep", attr: { role: "separator" } }); continue; }
      const b = menu.createEl("button", { cls: `aos-fx-mi${e.danger ? " is-danger" : ""}`, attr: { type: "button", role: "menuitem", "data-act": e.act } });
      b.createSpan({ cls: "aos-fx-mlabel", text: e.label });
      if (e.key) b.createSpan({ cls: "aos-fx-mkey", text: e.key });
      if (e.off) { b.disabled = true; b.setAttr("aria-disabled", "true"); b.setAttr("title", e.off); }
      b.addEventListener("click", () => { if (b.disabled) return; this.close(); e.run(); });
    }
    menu.addEventListener("keydown", (ev) => this.onKey(ev));
    const box = this.host.getBoundingClientRect();
    const pt = at instanceof HTMLElement ? (() => { const r = at.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; })() : at;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(pt.x - box.left, box.width - w - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(pt.y - box.top, box.height - h - 4))}px`;
    document.addEventListener("mousedown", this.onDoc, true);
    this.items()[0]?.focus();
  }

  close(): void {
    if (!this.el) return;
    document.removeEventListener("mousedown", this.onDoc, true);
    const hadFocus = this.el.contains(document.activeElement);
    this.el.remove();
    this.el = null;
    if (hadFocus && this.restore?.isConnected) this.restore.focus();
    this.restore = null;
  }

  private items(): HTMLButtonElement[] {
    return this.el ? Array.from(this.el.querySelectorAll<HTMLButtonElement>(".aos-fx-mi:not(:disabled)")) : [];
  }

  private onKey(e: KeyboardEvent): void {
    const items = this.items();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      next?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? items[0] : items[items.length - 1])?.focus();
    }
    // ↩ and Space reach the focused button as a click.
    e.stopPropagation();
  }
}
