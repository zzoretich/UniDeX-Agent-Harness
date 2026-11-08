// The Computer pane's left edge (agent-computer D4: resizable). Dragging it left widens the pane, inside the bounds the
// caller gives (320–900); the width follows the pointer and is saved once, on release; the keyboard moves it too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESIZE_STEP, bindColumnResize } from "./columnResize";

class FakeTarget {
  listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(fn)); }
  removeEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.get(type)?.delete(fn); }
  fire(type: string, e: Record<string, unknown> = {}): { prevented: boolean } {
    const ev = { prevented: false, button: 0, preventDefault() { ev.prevented = true; }, ...e };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
    return ev;
  }
  count(type: string): number { return this.listeners.get(type)?.size ?? 0; }
}

function setup(width = 440) {
  const classes = new Set<string>();
  const doc = Object.assign(new FakeTarget(), {
    body: { toggleClass: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); } },
  });
  const handle = Object.assign(new FakeTarget(), { ownerDocument: doc });
  let w = width;
  const sets: number[] = [];
  const dones: number[] = [];
  let starts = 0;
  const off = bindColumnResize(handle as unknown as HTMLElement, {
    min: 320, max: 900, get: () => w, set: (n) => { w = n; sets.push(n); }, done: (n) => { dones.push(n); }, start: () => { starts++; },
  });
  return { doc, handle, sets, dones, off, classes, starts: () => starts };
}

test("dragging the pane's left edge widens it to the left, clamped to 320–900; done fires once, on release", () => {
  const s = setup(440);
  s.handle.fire("mousedown", { clientX: 1000 });
  assert.equal(s.starts(), 1);
  assert.ok(s.classes.has("aos-col-resizing"), "the page shows the resize cursor while dragging");
  s.doc.fire("mousemove", { clientX: 900 });    // 100 px left: 540
  s.doc.fire("mousemove", { clientX: 200 });    // 800 px left: 1240, held at 900
  s.doc.fire("mousemove", { clientX: 150 });    // still 900: no new width
  s.doc.fire("mousemove", { clientX: 1700 });   // 700 px right: -260, held at 320
  assert.deepEqual(s.sets, [540, 900, 320]);
  assert.deepEqual(s.dones, [], "nothing is saved mid-drag");
  s.doc.fire("mouseup", { clientX: 1700 });
  s.doc.fire("mouseup", { clientX: 1700 });
  assert.deepEqual(s.dones, [320], "saved once");
  assert.equal(s.classes.has("aos-col-resizing"), false);
  s.doc.fire("mousemove", { clientX: 0 });
  assert.equal(s.sets.length, 3, "a move after release changes nothing");
  assert.equal(s.doc.count("mousemove") + s.doc.count("mouseup"), 0, "the page's listeners are gone");
});

test("a width that starts out of bounds is brought inside them; only the main button drags", () => {
  const s = setup(1200);
  s.handle.fire("mousedown", { clientX: 500, button: 2 });
  assert.equal(s.doc.count("mousemove"), 0);
  s.handle.fire("mousedown", { clientX: 500 });
  s.doc.fire("mousemove", { clientX: 490 });
  s.doc.fire("mouseup");
  assert.deepEqual(s.sets, [900]);
  assert.deepEqual(s.dones, [900]);
});

test("the arrow keys move the edge a step at a time inside the bounds, each step saved", () => {
  const s = setup(890);
  assert.ok(s.handle.fire("keydown", { key: "ArrowLeft" }).prevented);
  s.handle.fire("keydown", { key: "ArrowRight" });
  s.handle.fire("keydown", { key: "Enter" });
  assert.deepEqual(s.sets, [900, 900 - RESIZE_STEP]);
  assert.deepEqual(s.dones, [900, 900 - RESIZE_STEP]);
});

test("the returned function unbinds the edge and ends a drag in progress with its width", () => {
  const s = setup(440);
  s.handle.fire("mousedown", { clientX: 1000 });
  s.doc.fire("mousemove", { clientX: 960 });
  s.off();
  assert.deepEqual(s.dones, [480]);
  assert.equal(s.handle.count("mousedown") + s.handle.count("keydown") + s.doc.count("mousemove"), 0);
});
