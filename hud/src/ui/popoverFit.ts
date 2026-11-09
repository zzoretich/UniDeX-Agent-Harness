// popoverFit — keeps a popover that opens from a chip inside the part of the window it can be seen in. Sessions' reader
// clips what overflows it, and with the Computer pane open in a 1024 px window it is about 280 px wide: the host menu's
// 420 px popover, anchored at its chip's right edge, ran past the reader's left edge, so its left part (the Claude Code
// host) was hidden under the session list beside it, and a click there landed on a session row. `fitSpan` is the
// arithmetic; `keepInside` measures the popover and its clipping box and applies it.

/** A horizontal extent in the window, in CSS pixels. */
export interface Span { left: number; right: number }

/** The CSS offset on the popover's anchored side (`right` for one anchored at its chip's right edge, `left` for one at
 *  its left edge) and the width cap that put `pop` inside `box`, `margin` in from each of its edges; a width cap of
 *  null when the popover fits as it is. A popover wider than the room is capped first, from its anchored side. */
export function fitSpan(pop: Span, box: Span, side: "left" | "right", margin = 8): { offset: number; maxWidth: number | null } {
  const lo = box.left + margin, hi = box.right - margin;
  const room = Math.max(0, hi - lo);
  let { left, right } = pop;
  let maxWidth: number | null = null;
  if (right - left > room) {
    maxWidth = Math.floor(room);
    if (side === "right") left = right - maxWidth; else right = left + maxWidth;
  }
  const dx = left < lo ? lo - left : right > hi ? hi - right : 0;
  const offset = Math.round(side === "right" ? -dx : dx);
  return { offset: offset === 0 ? 0 : offset, maxWidth };
}

/** The part of the window `el` can be seen in, across: the viewport, narrowed by each ancestor that clips its overflow. */
export function clipBox(el: HTMLElement): Span {
  const win = el.ownerDocument.defaultView;
  let box: Span = { left: 0, right: win ? win.innerWidth : Number.POSITIVE_INFINITY };
  for (let a = el.parentElement; a && win; a = a.parentElement) {
    if (win.getComputedStyle(a).overflowX === "visible") continue;
    const r = a.getBoundingClientRect();
    box = { left: Math.max(box.left, r.left), right: Math.min(box.right, r.right) };
  }
  return box;
}

/** Moves `pop` (placed absolutely, anchored on `side` by its stylesheet) inside the part of the window it can be seen in,
 *  and narrows it when that part is narrower than it. Called each time it opens or redraws; a popover with no layout
 *  (its page behind another tab) keeps the placement it has, to be measured at its next redraw. */
export function keepInside(pop: HTMLElement, side: "left" | "right", margin = 8): void {
  if (!pop.getBoundingClientRect().width) return;
  pop.style.removeProperty(side);
  pop.style.removeProperty("max-width");
  const r = pop.getBoundingClientRect();
  const fit = fitSpan({ left: r.left, right: r.right }, clipBox(pop), side, margin);
  if (fit.maxWidth !== null) pop.style.maxWidth = `${fit.maxWidth}px`;
  if (fit.offset) pop.style.setProperty(side, `${fit.offset}px`);
}
