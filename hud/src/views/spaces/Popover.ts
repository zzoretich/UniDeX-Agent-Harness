// Popover.ts — the Spaces tab's menus (spaces-redesign D19): DOM-built, since compat has no Menu (as
// TerminalPanel.togglePlaceMenu). role=menu with menuitem rows; the focus starts on the first row that is on; arrows,
// Home and End move it; Escape, Tab and choosing a row close it and give the focus back to the button that opened it (so
// the next Tab continues from there, and a row whose action stays on the page does not drop the focus to the body); a
// click elsewhere closes. A row that is off stays in the list, aria-disabled, with its reason under its label (D31).
import type { MenuItem } from "./ui";

/** How a menu closed: a press elsewhere (its click is still to land), a key, a row chosen, or the code. */
export type PopoverClose = "pointer" | "key" | "item" | "code";

export interface PopoverHandle {
  el: HTMLElement;
  close(refocus?: boolean, how?: PopoverClose): void;
}

let seq = 0;

/**
 * Opens a menu under `anchor`, placed in `container` (positioned, the tab's root) so a pane redraw cannot detach it.
 * `onClose` runs once, whichever way it closes.
 */
export function openPopover(anchor: HTMLElement, container: HTMLElement, items: MenuItem[], o: { label: string; onClose?: (how: PopoverClose) => void }): PopoverHandle {
  const id = `aos-spc-pop-${++seq}`;
  const el = container.createDiv({ cls: "aos-spc-pop", attr: { role: "menu", id, "aria-label": o.label } });
  const rows: HTMLElement[] = [];
  for (const it of items) {
    if (it.sep && rows.length) el.createDiv({ cls: "aos-spc-popsep", attr: { role: "separator" } });
    // A choice of one (the status menu, PR 3) is a menuitemradio whose check reads as text too.
    const radio = it.checked !== undefined;
    const b = el.createEl("button", {
      cls: `aos-spc-popitem${it.disabled ? " is-off" : ""}${it.checked ? " is-checked" : ""}`,
      attr: {
        type: "button", role: radio ? "menuitemradio" : "menuitem", tabindex: "-1", "data-key": it.key,
        ...(radio ? { "aria-checked": String(!!it.checked) } : {}), ...(it.disabled ? { "aria-disabled": "true" } : {}),
      },
    });
    const label = b.createSpan({ cls: "aos-spc-poplabel", text: it.label });
    if (it.checked) label.createSpan({ cls: "aos-spc-popcheck", text: " ✓", attr: { "aria-hidden": "true" } });
    if (it.detail) b.createSpan({ cls: "aos-spc-popdetail", text: it.detail });
    b.addEventListener("click", (e) => {
      e.preventDefault();
      // The checked status closes the menu and changes nothing.
      if (it.checked && !it.run) { handle.close(true, "item"); return; }
      if (it.disabled || !it.run) return;
      // The focus goes back to the opener first; an action that opens a modal or another tab moves it on itself.
      handle.close(true, "item");
      it.run();
    });
    rows.push(b);
  }

  // Under the anchor, its left edge, kept inside the container.
  const place = () => {
    const a = anchor.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    const w = el.offsetWidth || 260;
    const left = Math.max(8, Math.min(a.left - c.left, c.width - w - 8)) + container.scrollLeft;
    // In the container's own coordinates: when it scrolls (the narrow layout), its content has moved under its top.
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(a.bottom - c.top + container.scrollTop + 4)}px`;
  };
  place();

  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute("aria-controls", id);

  let closed = false;
  const onDocDown = (e: Event) => {
    const t = e.target as Node | null;
    if (t && (el.contains(t) || anchor.contains(t))) return;
    handle.close(false, "pointer");
  };
  const doc = container.ownerDocument;
  doc.addEventListener("pointerdown", onDocDown, true);

  el.addEventListener("keydown", (e) => {
    const i = rows.indexOf(doc.activeElement as HTMLElement);
    const n = rows.length;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); handle.close(true, "key"); return; }
    // The menu is the last thing in the tab's root: let Tab continue from the button that opened it, not from there.
    if (e.key === "Tab") { e.preventDefault(); handle.close(true, "key"); return; }
    const j = e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowUp" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (j < 0 || !n) return;
    e.preventDefault();
    rows[j].focus();
  });

  const handle: PopoverHandle = {
    el,
    close(refocus = false, how: PopoverClose = "code") {
      if (closed) return;
      closed = true;
      doc.removeEventListener("pointerdown", onDocDown, true);
      el.remove();
      if (anchor.isConnected) {
        anchor.setAttribute("aria-expanded", "false");
        anchor.removeAttribute("aria-controls");
        if (refocus) anchor.focus();
      }
      o.onClose?.(how);
    },
  };

  (rows.find((r) => !r.classList.contains("is-off")) ?? rows[0])?.focus();
  return handle;
}
