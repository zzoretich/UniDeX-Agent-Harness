// Rename in place (files-finder D14): the item's name becomes a field with the stem selected, and vaultFiles'
// renamePath checks it as you type, under it. When other notes link to the item, *Update N links* (D17) sits under the
// field, on unless it was turned off (the choice is remembered). ↩ commits, Esc keeps the name, and focus leaving the
// field commits, as in Finder. The tab holds back its redraws of the view until the field is gone.

import type { PathCheck } from "../../data/vaultFiles";

/** What *Update N links* says for a target: links in notes the tab will write, and notes it will not (the runtime's). */
export interface LinkCount { links: number; notes: number; skipped: number }

export interface RenameDeps {
  /** renamePath for the typed name. */
  check(name: string): PathCheck;
  /** The links a rename to `to` would update, or null while the vault index is not read yet. */
  links(to: string): LinkCount | null;
  updateLinks: boolean;
  setUpdateLinks(on: boolean): void;
  /** Makes the rename; a throw shows its message under the field and keeps it open. */
  commit(to: string, updateLinks: boolean): Promise<void>;
  /** The field is gone, committed or not: the tab redraws what it held back. */
  done(committed: boolean): void;
}

const SAME = "that is its name already";

/** The part of a name before its extension, which the field selects (Finder's). */
export function stemLength(name: string, folder: boolean): number {
  const dot = folder ? -1 : name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/** Turns `nameEl` (inside the item `itemEl`) into the rename field; returns a function that ends it, keeping the name. */
export function renameInPlace(itemEl: HTMLElement, nameEl: HTMLElement, name: string, folder: boolean, deps: RenameDeps): () => void {
  const draggable = itemEl.getAttribute("draggable");
  itemEl.setAttr("draggable", "false");
  itemEl.addClass("is-renaming");
  nameEl.addClass("aos-fx-hidden");
  const box = document.createElement("div");
  box.addClass("aos-fx-rename");
  nameEl.insertAdjacentElement("afterend", box);
  const input = box.createEl("input", { cls: "aos-fx-rename-input", attr: { type: "text", spellcheck: "false", "aria-label": `Rename ${name}` } });
  input.value = name;
  const tip = box.createDiv({ cls: "aos-fx-rename-tip", attr: { role: "status" } });
  const note = tip.createDiv({ cls: "aos-fx-rename-note" });
  const row = tip.createEl("label", { cls: "aos-fx-rename-links" });
  const box2 = row.createEl("input", { attr: { type: "checkbox" } });
  box2.checked = deps.updateLinks;
  const rowText = row.createSpan();
  const skipped = tip.createDiv({ cls: "aos-fx-rename-skip" });

  // The field's own clicks and drags stay in it: the item under it would select, open or start a drag.
  for (const ev of ["click", "dblclick", "mousedown", "contextmenu", "dragstart"]) box.addEventListener(ev, (e) => e.stopPropagation());
  // A click on the checkbox keeps the focus in the field, so it does not count as leaving it.
  row.addEventListener("mousedown", (e) => e.preventDefault());

  let ended = false;
  let busy = false;
  const end = (committed: boolean) => {
    if (ended) return;
    ended = true;
    box.remove();
    nameEl.removeClass("aos-fx-hidden");
    itemEl.removeClass("is-renaming");
    if (draggable === null) itemEl.removeAttribute("draggable"); else itemEl.setAttr("draggable", draggable);
    deps.done(committed);
  };

  const update = (): PathCheck => {
    const c = deps.check(input.value);
    const same = !c.ok && c.error === SAME;
    note.setText(c.ok || same ? "" : c.error);
    note.toggleClass("is-shown", !c.ok && !same);
    box.toggleClass("is-bad", !c.ok && !same);
    const n = c.ok ? deps.links(c.path) : null;
    row.toggleClass("is-shown", !!n && n.links > 0);
    if (n && n.links > 0) rowText.setText(`Update ${n.links} link${n.links === 1 ? "" : "s"}${n.notes > 1 ? ` in ${n.notes} notes` : ""}`);
    skipped.toggleClass("is-shown", !!n && n.skipped > 0);
    if (n && n.skipped > 0) skipped.setText(`${n.skipped} note${n.skipped === 1 ? "" : "s"} in the runtime's folders will not be updated`);
    tip.toggleClass("is-shown", note.hasClass("is-shown") || row.hasClass("is-shown") || skipped.hasClass("is-shown"));
    return c;
  };

  const commit = () => {
    if (ended || busy) return;
    const c = update();
    if (!c.ok) {
      // The same name, or a name that cannot be: Finder keeps the old one when focus leaves, and ↩ stays.
      if (c.error === SAME || !box.contains(document.activeElement)) end(false);
      return;
    }
    busy = true;
    input.disabled = true;
    void deps.commit(c.path, box2.checked && row.hasClass("is-shown")).then(() => end(true), (err: unknown) => {
      busy = false;
      input.disabled = false;
      note.setText(`Not renamed: ${err instanceof Error ? err.message : String(err)}`);
      note.addClass("is-shown");
      tip.addClass("is-shown");
      input.focus();
    });
  };

  input.addEventListener("input", () => { update(); });
  box2.addEventListener("change", () => { deps.setUpdateLinks(box2.checked); input.focus(); });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(false); }
    else e.stopPropagation();
  });
  box.addEventListener("focusout", (e) => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (to && box.contains(to)) return;
    // A redraw that removed the field has ended it already; anything else that takes the focus commits, as Finder does.
    if (!ended && !busy) commit();
  });

  update();
  input.focus();
  input.setSelectionRange(0, stemLength(name, folder));
  return () => end(false);
}
