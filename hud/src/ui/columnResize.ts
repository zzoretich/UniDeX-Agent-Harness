// columnResize — a column's draggable edge (agent-computer D4: the Computer pane is resizable). The handle is the left
// edge of a column docked right, so dragging it left widens the column. The width stays inside min–max (max is asked at
// every move and key: the room a column has changes while the window does) and follows the
// pointer through `set`; `done` (where the caller saves it) fires once per drag, on release, and `start` lets the caller
// get out of the pointer's way first (the pane takes its native view away, which would swallow the drag). The arrow keys
// move a focused edge a step at a time, each step a done; a double click calls `reset`. Returns the unbinding, which ends a drag in progress.

/** How far one arrow key moves the edge, in CSS pixels. */
export const RESIZE_STEP = 16;

export interface ColumnResizeOptions {
  min: number;
  max: () => number;
  get: () => number;
  set: (w: number) => void;
  done: (w: number) => void;
  start?: () => void;
  /** A double click on the edge: the caller puts the column back to its usual width. */
  reset?: () => void;
}

export function bindColumnResize(handle: HTMLElement, o: ColumnResizeOptions): () => void {
  const doc = handle.ownerDocument;
  const clamp = (w: number): number => Math.round(Math.min(o.max(), Math.max(o.min, w)));
  let drag: { x: number; last: number; from: number } | null = null;

  const move = (e: MouseEvent): void => {
    if (!drag) return;
    const w = clamp(drag.from + (drag.x - e.clientX));
    if (w === drag.last) return;
    drag.last = w;
    o.set(w);
  };
  const end = (): void => {
    if (!drag) return;
    const w = drag.last;
    drag = null;
    doc.removeEventListener("mousemove", move);
    doc.removeEventListener("mouseup", end);
    doc.body.toggleClass("aos-col-resizing", false);
    o.done(w);
  };
  const down = (e: MouseEvent): void => {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    const was = o.get();
    const from = clamp(was);
    drag = { x: e.clientX, last: from, from };
    doc.addEventListener("mousemove", move);
    doc.addEventListener("mouseup", end);
    doc.body.toggleClass("aos-col-resizing", true);
    o.start?.();
    // A width saved out of bounds (an older build, a hand edit) comes inside them as the drag starts.
    if (from !== was) o.set(from);
  };
  const key = (e: KeyboardEvent): void => {
    const dir = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0;
    if (!dir || drag) return;
    e.preventDefault();
    const w = clamp(o.get() + dir * RESIZE_STEP);
    o.set(w);
    o.done(w);
  };

  const reset = (): void => o.reset?.();

  handle.addEventListener("mousedown", down);
  handle.addEventListener("keydown", key);
  handle.addEventListener("dblclick", reset);
  return () => {
    end();
    handle.removeEventListener("mousedown", down);
    handle.removeEventListener("keydown", key);
    handle.removeEventListener("dblclick", reset);
  };
}
