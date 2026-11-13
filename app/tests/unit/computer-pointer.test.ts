// The pointer main draws above a browser tab (session-browser S18, §4.5): the travel maths, the Pointer that moves it and
// never keeps an action waiting, the ImageView surface, and the drawer that makes its image. The unit bundle's electron
// is an empty stand-in (electron-stub.cjs), so the window, the view and the screen the code uses are given here.

import { test } from "node:test";
import assert from "node:assert/strict";
import electron from "electron";
import {
  DRAW_MAX_MS, HIDE_AFTER_MS, imageSurface, opaqueBox, Pointer, PULSE_MS, pointerHtml, tagDrawer, tagText, travelMs, travelPath, TAG_MAX,
  type Point, type PointerKind, type PointerSurface, type Size,
} from "../../src/main/computer/pointer";
import type { Clock } from "../../src/main/computer/asks";

const stub = electron as unknown as Record<string, unknown>;

class FakeClock implements Clock {
  t = 0; private n = 0; private q = new Map<number, { at: number; fn: () => void }>();
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.q.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(id: unknown) { this.q.delete(id as number); }
  fire(end: number) {
    for (;;) {
      const next = [...this.q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.q.delete(next[0]); this.t = next[1].at; next[1].fn();
    }
    this.t = end;
  }
  /** Moves time on in `step` ms (16, the pointer's own, unless a test wants a finer reading), letting the promises the code
   *  awaits run between steps. */
  async advance(ms: number, step = 16) {
    for (let left = ms; left > 0; left -= step) { this.fire(this.t + Math.min(step, left)); await flush(); }
  }
}
const flush = () => new Promise<void>((r) => setImmediate(r));

class FakeSurface implements PointerSurface {
  log: string[] = []; places: Array<{ at: number; p: Point }> = []; drawn: Array<[PointerKind, string]> = [];
  /** Held by a test to keep the image from being ready; undefined draws at once. */
  gate: Promise<void> | undefined; fail = false; pressReady = true; delay = 0;
  size: (kind: PointerKind, tag: string) => Size = () => ({ width: 30, height: 20 });
  /** What the view shows and whether it is visible, and every image set while it was visible (N1b). */
  visible = false; current: { kind: PointerKind; tag: string } | null = null; setWhileVisible: Array<[PointerKind, string]> = [];
  dead = false;
  constructor(private clock: FakeClock) {}
  async draw(kind: PointerKind, tag: string) {
    this.log.push(`draw:${kind}`); this.drawn.push([kind, tag]);
    if (this.delay) await new Promise<void>((r) => this.clock.setTimeout(r, this.delay));
    if (this.gate) await this.gate;
    if (this.fail) throw new Error("no image");
    this.current = { kind, tag };
    if (this.visible) this.setWhileVisible.push([kind, tag]);
    return this.size(kind, tag);
  }
  place(at: Point) { this.places.push({ at: this.clock.now(), p: at }); this.log.push("place"); }
  show(on: boolean) { this.visible = on; this.log.push(on ? "show" : "hide"); }
  gone() { return this.dead; }
  ready(kind: PointerKind) { return kind !== "press" || this.pressReady; }
}

const WITHIN = { x: 0, y: 0, width: 5000, height: 4000 };
function make(opts: { surface?: boolean } = {}) {
  const clock = new FakeClock(); const s = new FakeSurface(clock);
  const pointer = new Pointer({ surface: () => (opts.surface === false ? null : s), clock });
  return { clock, s, pointer };
}
function makeTwo() {
  const clock = new FakeClock(); const main = new FakeSurface(clock); const pop = new FakeSurface(clock);
  const pointer = new Pointer({ surface: (w) => (w === "main" ? main : pop), clock });
  return { clock, main, pop, pointer };
}
const base = { window: "main" as const, name: "Fix login", kind: "arrow" as const, within: WITHIN };

test("travel takes at most 250 ms and none for the same point", () => {
  assert.equal(travelMs({ x: 0, y: 0 }, { x: 0, y: 0 }), 0);
  assert.equal(travelMs({ x: 0, y: 0 }, { x: 40, y: 0 }), 90);
  assert.equal(travelMs({ x: 0, y: 0 }, { x: 3000, y: 2000 }), 250);
});

test("the path ends exactly on the target", () => {
  const from = { x: 10, y: 20 }; const to = { x: 333.3, y: 71.7 };
  const ms = travelMs(from, to); const path = travelPath(from, to, ms);
  assert.equal(path.length, Math.ceil(ms / 16));
  assert.deepEqual(path[path.length - 1], to);
  assert.deepEqual(travelPath(from, to, 0), []);
  // Ease-out: the first step covers more ground than the last.
  const first = path[0].x - from.x; const last = path[path.length - 1].x - path[path.length - 2].x;
  assert.ok(first > last && last > 0);
});

test("the tag is cut to fit", () => {
  assert.equal(tagText("Fix login"), "Fix login");
  assert.equal(tagText("x".repeat(5000)).length, 24);
  assert.equal(tagText("a‮b\n"), "ab");
  assert.equal(tagText(""), "");
  assert.equal(tagText("x".repeat(5000)), `${"x".repeat(23)}…`);
  // Never half of a surrogate pair before the closing mark.
  const cut = tagText(`${"x".repeat(22)}😀😀😀`);
  assert.ok(cut.endsWith("…") && cut.length <= TAG_MAX && !/[\ud800-\udbff]…$/.test(cut));
});

test("a lone surrogate is dropped and nothing can make the address throw", () => {
  assert.equal(tagText("ab\ud800cd"), "abcd");
  assert.equal(tagText("ab\udc00cd"), "abcd");
  assert.equal(tagText("a😀b"), "a😀b");
  for (const bad of ["ab\ud800cd", "\udfff", "x\ud83d"]) {
    for (const kind of ["arrow", "press", "caret"] as const) {
      assert.doesNotThrow(() => encodeURIComponent(pointerHtml(kind, bad, false)));
    }
  }
});

test("the document escapes the name and holds no script", () => {
  for (const kind of ["arrow", "press", "caret"] as const) {
    for (const dark of [false, true]) {
      const html = pointerHtml(kind, "<script>alert(1)</script>&\"'", dark);
      assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;") || html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#x27;"), html);
      assert.ok(!/<script/i.test(html) && !/javascript:/i.test(html) && !/https?:|\/\//i.test(html) && !/<link|<img|@font-face|url\(/i.test(html));
      assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`));
      // The mark's tip is the drawing's top-left pixel.
      assert.match(html, /left:\s*0(px)?;\s*top:\s*0(px)?/);
    }
  }
  assert.ok(!pointerHtml("arrow", "", false).includes('class="tag"'));
});

test("the document's zoom is written on its root and nowhere else", () => {
  assert.match(pointerHtml("arrow", "x", false, 2), /html\{[^}]*zoom:2[;}]/);
  assert.match(pointerHtml("arrow", "x", false, 0.5), /html\{[^}]*zoom:0\.5[;}]/);
  assert.ok(!/zoom/.test(pointerHtml("arrow", "x", false)));
});

test("opaqueBox finds the drawing and nothing for an empty bitmap", () => {
  const w = 12; const h = 8; const bm = Buffer.alloc(w * h * 4);
  assert.equal(opaqueBox(bm, w, h), null);
  for (const [x, y] of [[3, 2], [9, 5]] as const) bm[(y * w + x) * 4 + 3] = 255;
  assert.deepEqual(opaqueBox(bm, w, h), { x: 3, y: 2, width: 7, height: 4 });
  // A drawing whose tip is the top-left pixel gives a box that starts at 0,0.
  bm[3] = 255;
  assert.deepEqual(opaqueBox(bm, w, h), { x: 0, y: 0, width: 10, height: 6 });
});

test("moveTo draws, travels and shows; it hides 3 s after the last action", async () => {
  const { clock, s, pointer } = make();
  let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true }).then((v) => { done = v; });
  await flush();
  assert.deepEqual(s.drawn[0], ["arrow", "Fix login"]);
  assert.ok(s.log.indexOf("draw:arrow") < s.log.indexOf("show"));
  // The first move in a window starts from the middle of the tab's view and ends exactly on the target.
  assert.deepEqual(s.places[0].p, { x: 2500, y: 2000 });
  await clock.advance(300);
  assert.equal(done, true);
  assert.deepEqual(s.places[s.places.length - 1].p, { x: 440, y: 300 });
  assert.ok(!s.log.includes("hide"));
  await clock.advance(HIDE_AFTER_MS - 400);   // 2900 ms in; the travel from the view's middle ended at 240 ms
  assert.ok(!s.log.includes("hide"));
  await clock.advance(500);
  assert.equal(s.log.filter((l) => l === "hide").length, 1);
  // The next move starts where this one ended, not at the centre.
  s.places.length = 0;
  void pointer.moveTo({ ...base, to: { x: 500, y: 300 }, alive: () => true });
  await flush();
  assert.deepEqual(s.places[0].p, { x: 440, y: 300 });
});

test("a move started 50 ms before the last one's timer was due, with an image that takes 100 ms, is shown and travels", async () => {
  const { clock, s, pointer } = make();
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(100);
  const due = 80 + HIDE_AFTER_MS;   // the travel ended at 80 ms
  await clock.advance(due - 50 - clock.t);
  s.delay = 100; s.log.length = 0; s.places.length = 0;
  let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 500, y: 300 }, alive: () => true }).then((v) => { done = v; });
  await flush(); await clock.advance(400);
  assert.equal(done, true);
  assert.ok(s.log.includes("show"), s.log.join());
  assert.ok(s.places.length > 1 && s.places[s.places.length - 1].p.x === 500);
  assert.ok(!s.log.includes("hide"), s.log.join());
});

test("a Take over during the travel stops it within one step, reports false and hides at once", async () => {
  const { clock, s, pointer } = make();
  let alive = true; let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 3000, y: 2000 }, alive: () => alive }).then((v) => { done = v; });
  await flush();
  await clock.advance(40); alive = false;
  await clock.advance(16);
  assert.equal(done, false);
  assert.ok(s.places.every((p) => p.at <= 40), JSON.stringify(s.places.map((p) => p.at)));
  assert.equal(s.log[s.log.length - 1], "hide");
  const n = s.places.length;
  await clock.advance(4000);
  assert.equal(s.places.length, n);
  assert.equal(s.log.filter((l) => l === "hide").length, 1, "no timer is left armed");
});

test("pulse shows the press image for 150 ms; hide is at once", async () => {
  const { clock, s, pointer } = make();
  void pointer.moveTo({ ...base, to: { x: 400, y: 300 }, alive: () => true });
  await flush(); await clock.advance(32);
  s.drawn.length = 0;
  pointer.pulse(); await flush();
  assert.deepEqual(s.drawn.map((d) => d[0]), ["press"]);
  await clock.advance(PULSE_MS - 16); assert.equal(s.drawn.length, 1);
  await clock.advance(32);
  assert.deepEqual(s.drawn.map((d) => d[0]), ["press", "arrow"]);
  // A pulse whose image is not ready changes nothing.
  s.pressReady = false; s.drawn.length = 0; pointer.pulse(); await flush(); await clock.advance(200);
  assert.deepEqual(s.drawn, []);
  s.log.length = 0; pointer.hide();
  assert.deepEqual(s.log, ["hide"]);
  // After a hide a pulse does nothing.
  s.pressReady = true; pointer.pulse(); await flush(); await clock.advance(500);
  assert.deepEqual(s.drawn, []);
});

test("a pulse while a move still waits on its image changes nothing", async () => {
  const { clock, s, pointer } = make();
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(200);
  s.delay = 100; s.drawn.length = 0;
  let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 500, y: 300 }, alive: () => true }).then((v) => { done = v; });
  await flush(); await clock.advance(48);
  pointer.pulse(); await flush();
  await clock.advance(300);
  assert.equal(done, true);
  assert.deepEqual(s.drawn.map((d) => d[0]), ["arrow"], "no press image replaced the move's own");
});

test("a window with no surface delivers anyway", async () => {
  const { pointer } = make({ surface: false });
  assert.equal(await pointer.moveTo({ ...base, to: { x: 1, y: 1 }, alive: () => true }), true);
});

test("a move to a window with no surface hides what was on screen and leaves no timer", async () => {
  const clock = new FakeClock(); const s = new FakeSurface(clock);
  const pointer = new Pointer({ surface: (w) => (w === "main" ? s : null), clock });
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);
  assert.equal(await pointer.moveTo({ ...base, window: "pop", to: { x: 1, y: 1 }, alive: () => true }), true);
  assert.equal(s.log[s.log.length - 1], "hide");
  await clock.advance(5000);
  assert.equal(s.log.filter((l) => l === "hide").length, 1);
  assert.equal(pointer.state().shown, false);
});

test("the image is not awaited past 200 ms: the action goes on with no pointer", async () => {
  const { clock, s, pointer } = make();
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);          // a pointer is on screen from an earlier action
  s.log.length = 0; s.gate = new Promise(() => {});
  let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 500, y: 300 }, alive: () => true }).then((v) => { done = v; });
  await flush(); await clock.advance(DRAW_MAX_MS - 32); assert.equal(done, undefined);
  await clock.advance(64);
  assert.equal(done, true);
  assert.ok(!s.log.includes("show") && !s.log.includes("place"));
  assert.equal(s.log[s.log.length - 1], "hide", "what was on screen is gone");
  await clock.advance(5000);
  assert.equal(s.log.filter((l) => l === "hide").length, 1, "no timer is left armed");
});

test("the waits are read from the clock: 200 ms to draw and 250 ms to travel at most, at 1 ms resolution", async () => {
  {
    const { clock, s, pointer } = make();
    s.gate = new Promise(() => {});
    let at = -1;
    void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true }).then(() => { at = clock.now(); });
    await flush(); await clock.advance(400, 1);
    assert.ok(at >= 0 && at <= DRAW_MAX_MS, `resolved at ${at}`);
  }
  {
    const { clock, pointer } = make();
    let at = -1;
    void pointer.moveTo({ ...base, to: { x: 3000, y: 2000 }, alive: () => true }).then(() => { at = clock.now(); });
    await flush(); await clock.advance(400, 1);
    assert.ok(at >= 0 && at <= 250, `resolved at ${at}`);
  }
});

test("a draw that fails delivers anyway", async () => {
  const { clock, s, pointer } = make();
  s.fail = true;
  assert.equal(await pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true }), true);
  assert.ok(!s.log.includes("show"));
  await clock.advance(4000);
  assert.equal(pointer.state().shown, false);
});

test("Take over while the image is drawn reports false within one step", async () => {
  const { clock, s, pointer } = make();
  s.gate = new Promise(() => {});
  let alive = true; let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => alive }).then((v) => { done = v; });
  await flush(); await clock.advance(32); alive = false;
  await clock.advance(16);
  assert.equal(done, false);
});

test("a second move ends the first one's travel", async () => {
  const { clock, s, pointer } = make();
  const aliveA = { v: true }; let a: boolean | undefined; let b: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 3000, y: 2000 }, alive: () => aliveA.v }).then((v) => { a = v; });
  await flush(); await clock.advance(48);
  aliveA.v = false;   // the earlier one answers with its own alive() at that moment
  void pointer.moveTo({ ...base, to: { x: 100, y: 100 }, alive: () => true }).then((v) => { b = v; });
  await flush(); await clock.advance(16);
  assert.equal(a, false);
  await clock.advance(400);
  assert.equal(b, true);
  assert.deepEqual(s.places[s.places.length - 1].p, { x: 100, y: 100 });
  // The second starts where the first stopped and goes on to its own target only: the first's travel never resumed.
  const after = s.places.filter((p) => p.at >= 64).map((p) => p.p.x);
  assert.ok(after.every((x, i) => i === 0 || x <= after[i - 1]), JSON.stringify(after));
});

test("nothing is shown after hide, not even by a late draw or a pulse's end", async () => {
  const { clock, s, pointer } = make();
  let release!: () => void; s.gate = new Promise<void>((r) => { release = r; });
  let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true }).then((v) => { done = v; });
  await flush(); await clock.advance(32);
  pointer.hide(); release();
  await flush(); await clock.advance(32);
  assert.equal(done, true);
  assert.ok(!s.log.includes("show") && s.places.length === 0);
  // A pulse in flight when hide comes.
  s.gate = undefined;
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(400);
  pointer.pulse(); await flush(); pointer.hide();
  s.log.length = 0; s.drawn.length = 0;
  await clock.advance(400);
  assert.ok(!s.log.includes("show") && !s.drawn.some((d) => d[0] === "arrow"));
});

test("a move to the other window hides the first window's pointer, and each window keeps its own position", async () => {
  const { clock, main, pop, pointer } = makeTwo();
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);
  void pointer.moveTo({ ...base, window: "pop", within: { x: 0, y: 0, width: 200, height: 200 }, to: { x: 150, y: 100 }, alive: () => true });
  await flush(); await clock.advance(300);
  assert.equal(main.log[main.log.length - 1], "hide");
  assert.deepEqual(pop.places[0].p, { x: 100, y: 100 }, "the pop-out starts in the middle of its own view");
  main.places.length = 0;
  void pointer.moveTo({ ...base, to: { x: 500, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);
  assert.deepEqual(main.places[0].p, { x: 440, y: 300 }, "the main window goes on from where it was");
});

test("a target near the right edge drops the tag", async () => {
  const { clock, s, pointer } = make();
  s.size = (_k, tag) => (tag ? { width: 120, height: 30 } : { width: 14, height: 22 });
  const within = { x: 100, y: 50, width: 600, height: 400 };
  let done: boolean | undefined;
  void pointer.moveTo({ ...base, within, to: { x: 650, y: 100 }, alive: () => true }).then((v) => { done = v; });
  await flush(); await clock.advance(400);
  assert.equal(done, true);
  assert.deepEqual(s.drawn, [["arrow", "Fix login"], ["arrow", ""]]);
  assert.deepEqual(s.places[s.places.length - 1].p, { x: 650, y: 100 });
  assert.equal(pointer.state().tag, "");
  // The same at the bottom edge, and a target well inside keeps its tag.
  s.drawn.length = 0;
  void pointer.moveTo({ ...base, within, to: { x: 200, y: 425 }, alive: () => true });
  await flush(); await clock.advance(400);
  assert.deepEqual(s.drawn.map((d) => d[1]), ["Fix login", ""]);
  s.drawn.length = 0;
  void pointer.moveTo({ ...base, within, to: { x: 200, y: 100 }, alive: () => true });
  await flush(); await clock.advance(400);
  assert.deepEqual(s.drawn.map((d) => d[1]), ["Fix login"]);
  assert.equal(pointer.state().tag, "Fix login");
});

test("one at the very edge shows nothing and is not slowed", async () => {
  const { clock, s, pointer } = make();
  s.size = (_k, tag) => (tag ? { width: 120, height: 30 } : { width: 14, height: 22 });
  const within = { x: 100, y: 50, width: 600, height: 400 };
  let at = -1; let done: boolean | undefined;
  void pointer.moveTo({ ...base, within, to: { x: 695, y: 100 }, alive: () => true }).then((v) => { done = v; at = clock.now(); });
  await flush(); await clock.advance(100, 1);
  assert.equal(done, true);
  assert.ok(at <= 16, `resolved at ${at}`);
  assert.ok(!s.log.includes("show") && !s.log.includes("place"));
  assert.equal(pointer.state().shown, false);
  await clock.advance(5000);
  assert.ok(!s.log.includes("show"));
});

test("a target outside the view shows nothing", async () => {
  const { clock, s, pointer } = make();
  const within = { x: 100, y: 50, width: 600, height: 400 };
  for (const to of [{ x: 50, y: 100 }, { x: 200, y: 20 }, { x: 800, y: 100 }, { x: 200, y: 450 }]) {
    assert.equal(await pointer.moveTo({ ...base, within, to, alive: () => true }), true);
  }
  await clock.advance(100);
  assert.ok(!s.log.includes("show") && !s.log.includes("place"));
});

test("state reports what is on screen across a move, a pulse and a hide", async () => {
  const { clock, pointer } = make();
  assert.deepEqual(pointer.state(), { shown: false, at: null, tag: "", window: null });
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);
  assert.deepEqual(pointer.state(), { shown: true, at: { x: 440, y: 300 }, tag: "Fix login", window: "main" });
  pointer.pulse(); await flush();
  assert.equal(pointer.state().shown, true);
  await clock.advance(200);
  assert.deepEqual(pointer.state(), { shown: true, at: { x: 440, y: 300 }, tag: "Fix login", window: "main" });
  pointer.hide();
  assert.deepEqual(pointer.state(), { shown: false, at: null, tag: "", window: null });
});

test("the first move starts from the middle of the tab's view", async () => {
  const { clock, s, pointer } = make();
  void pointer.moveTo({ ...base, within: { x: 100, y: 50, width: 600, height: 400 }, to: { x: 650, y: 100 }, alive: () => true });
  await flush(); await clock.advance(400);
  assert.deepEqual(s.places[0].p, { x: 400, y: 250 });
});

test("a kept position outside the view is not used", async () => {
  const { clock, s, pointer } = make();
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);
  s.places.length = 0;
  void pointer.moveTo({ ...base, within: { x: 0, y: 0, width: 400, height: 400 }, to: { x: 100, y: 100 }, alive: () => true });
  await flush(); await clock.advance(300);
  assert.deepEqual(s.places[0].p, { x: 200, y: 200 }, "the kept (440, 300) lies outside the smaller view");
});

test("near the right edge the tagged image is never on screen", async () => {
  const { clock, s, pointer } = make();
  s.size = (_k, tag) => (tag ? { width: 120, height: 30 } : { width: 14, height: 22 });
  const within = { x: 100, y: 50, width: 600, height: 400 };
  void pointer.moveTo({ ...base, within, to: { x: 650, y: 100 }, alive: () => true });   // the tag is dropped: the bare mark is shown
  await flush(); await clock.advance(400);
  assert.equal(s.current!.tag, "");
  s.setWhileVisible.length = 0;
  void pointer.moveTo({ ...base, within, to: { x: 660, y: 100 }, alive: () => true });
  await flush(); await clock.advance(400);
  assert.deepEqual(s.setWhileVisible.filter(([, tag]) => tag !== ""), [], "a refused image was set on a visible view");
  assert.equal(pointer.state().tag, "");
});

test("the second move at the very edge resolves at once and asks for no drawing", async () => {
  const { clock, s, pointer } = make();
  s.size = (_k, tag) => (tag ? { width: 120, height: 30 } : { width: 14, height: 22 });
  s.delay = 60;
  const within = { x: 100, y: 50, width: 600, height: 400 };
  void pointer.moveTo({ ...base, within, to: { x: 695, y: 100 }, alive: () => true });
  await flush(); await clock.advance(300);          // the first one may draw, and learns the bare mark's size
  const asked = s.drawn.length;
  let at = -1; const t0 = clock.now();
  void pointer.moveTo({ ...base, within, to: { x: 697, y: 100 }, alive: () => true }).then(() => { at = clock.now() - t0; });
  await flush(); await clock.advance(10, 1);
  assert.equal(at, 0);
  assert.equal(s.drawn.length, asked);
});

test("a move on a disposed surface shows nothing and state says so", async () => {
  stub.ImageView = FakeView; stub.screen = { getDisplayMatching: () => ({ scaleFactor: 1 }) }; stub.nativeTheme = { shouldUseDarkColors: false };
  const { win } = fakeWindow();
  const surface = imageSurface({ window: win as never, has: () => true, tag: async () => img(10, 10) });
  const clock = new FakeClock();
  const pointer = new Pointer({ surface: () => surface, clock });
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);
  assert.equal(pointer.state().shown, true);
  surface.dispose();
  assert.equal(pointer.state().shown, false, "a surface that is gone shows nothing");
  let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 500, y: 300 }, alive: () => true }).then((v) => { done = v; });
  await flush();
  assert.equal(done, true);
  assert.equal(pointer.state().shown, false);
});

test("a draw that fails hides the pointer that was on screen, and no timer is left", async () => {
  const { clock, s, pointer } = make();
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);
  s.fail = true; s.log.length = 0;
  assert.equal(await pointer.moveTo({ ...base, to: { x: 500, y: 300 }, alive: () => true }), true);
  assert.deepEqual(s.log, ["draw:arrow", "hide"]);
  await clock.advance(5000);
  assert.equal(s.log.filter((l) => l === "hide").length, 1);
  assert.equal(pointer.state().shown, false);
});

test("a Take over while the image is drawn hides the pointer that was on screen, and no timer is left", async () => {
  const { clock, s, pointer } = make();
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);
  s.gate = new Promise(() => {}); s.log.length = 0;
  let alive = true; let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 500, y: 300 }, alive: () => alive }).then((v) => { done = v; });
  await flush(); await clock.advance(32); alive = false;
  await clock.advance(16);
  assert.equal(done, false);
  assert.equal(s.log[s.log.length - 1], "hide");
  await clock.advance(5000);
  assert.equal(s.log.filter((l) => l === "hide").length, 1);
});

test("the edge exit hides the pointer that was on screen, and no timer is left", async () => {
  const { clock, s, pointer } = make();
  s.size = (_k, tag) => (tag ? { width: 120, height: 30 } : { width: 14, height: 22 });
  const within = { x: 100, y: 50, width: 600, height: 400 };
  void pointer.moveTo({ ...base, within, to: { x: 650, y: 100 }, alive: () => true });   // bare mark shown, its size learned
  await flush(); await clock.advance(400);
  s.log.length = 0;
  assert.equal(await pointer.moveTo({ ...base, within, to: { x: 695, y: 100 }, alive: () => true }), true);
  assert.deepEqual(s.log, ["hide"]);
  await clock.advance(5000);
  assert.equal(s.log.filter((l) => l === "hide").length, 1);
  assert.equal(pointer.state().shown, false);
});

test("timers that fire 10 ms late do not stretch the travel", async () => {
  class LateClock extends FakeClock { setTimeout(fn: () => void, ms: number) { return super.setTimeout(fn, ms === 16 ? 26 : ms); } }
  const clock = new LateClock(); const s = new FakeSurface(clock);
  const pointer = new Pointer({ surface: () => s, clock });
  let at = -1;
  void pointer.moveTo({ ...base, to: { x: 4000, y: 3000 }, alive: () => true }).then(() => { at = clock.now(); });
  await flush(); await clock.advance(600, 1);
  assert.ok(at >= 0 && at <= 250 + 16, `ended at ${at}`);
  assert.deepEqual(s.places[s.places.length - 1].p, { x: 4000, y: 3000 });
  assert.ok(s.places.length < 16, "late timers skip points instead of stretching the travel");
});

// ---- imageSurface -------------------------------------------------------------------------------------------------

class FakeView {
  static last: FakeView | undefined;
  image: unknown; bounds = { x: 0, y: 0, width: 0, height: 0 }; visible = true;
  constructor() { FakeView.last = this; }
  setImage(i: unknown) { this.image = i; }
  setBounds(b: typeof this.bounds) { this.bounds = b; }
  setVisible(v: boolean) { this.visible = v; }
}
function fakeWindow() {
  const children: unknown[] = []; const st = { destroyed: false };
  const win = {
    isDestroyed: () => st.destroyed, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), getContentBounds: () => ({ x: 0, y: 0, width: 801, height: 601 }),
    contentView: {
      addChildView: (v: unknown) => { if (st.destroyed) throw new Error("Object has been destroyed"); children.push(v); },
      removeChildView: (v: unknown) => { if (st.destroyed) throw new Error("Object has been destroyed"); const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); },
    },
  };
  return { win, children, st };
}
const img = (w: number, h: number) => ({ getSize: () => ({ width: w, height: h }) }) as never;

test("imageSurface puts the view's origin on the target, raises it when shown, and survives a destroyed window", async () => {
  stub.ImageView = FakeView;
  stub.screen = { getDisplayMatching: () => ({ scaleFactor: 2 }) };
  stub.nativeTheme = { shouldUseDarkColors: true };
  const { win, children, st } = fakeWindow();
  const tabs = { tab: true }; children.push(tabs);
  const asked: unknown[][] = [];
  const surface = imageSurface({
    window: win as never, has: () => true,
    tag: async (kind, text, scale, dark) => { asked.push([kind, text, scale, dark]); return img(90, 30); },
  });
  const view = FakeView.last!;
  assert.ok(!children.includes(view), "not a child before it is shown");
  assert.equal(view.visible, false);
  assert.deepEqual(await surface.draw("arrow", "Fix"), { width: 90, height: 30 });
  assert.deepEqual(asked, [["arrow", "Fix", 2, true]]);
  surface.place({ x: 120.4, y: 80.6 });
  assert.ok(!children.includes(view), "placing does not add it");
  surface.show(true);
  assert.equal(children[children.length - 1], view, "above the tab");
  assert.deepEqual(view.bounds, { x: 120, y: 81, width: 90, height: 30 });
  assert.equal(view.visible, true);
  children.push(tabs);              // a tab swap puts a tab above it
  assert.notEqual(children[children.length - 1], view);
  surface.show(true);
  assert.equal(children[children.length - 1], view);
  assert.equal(children.filter((c) => c === view).length, 1);
  surface.show(false); assert.equal(view.visible, false);
  st.destroyed = true;
  assert.doesNotThrow(() => { surface.place({ x: 1, y: 1 }); surface.show(true); surface.show(false); surface.raise(); surface.dispose(); });
  await assert.rejects(surface.draw("press", "Fix"), "nothing to draw on");
  assert.equal(surface.gone(), true);
});

test("imageSurface: only the latest asked-for image lands", async () => {
  stub.ImageView = FakeView; stub.screen = { getDisplayMatching: () => ({ scaleFactor: 1 }) }; stub.nativeTheme = { shouldUseDarkColors: false };
  const { win } = fakeWindow();
  const slow = img(10, 10); const fast = img(20, 20); let releaseSlow!: () => void;
  const surface = imageSurface({
    window: win as never, has: () => true,
    tag: (kind) => (kind === "press" ? new Promise((r) => { releaseSlow = () => r(slow); }) : Promise.resolve(fast)),
  });
  const view = FakeView.last!;
  const first = surface.draw("press", "x");
  await surface.draw("arrow", "x");
  releaseSlow(); await first;
  assert.equal(view.image, fast);
  assert.deepEqual(view.bounds.width, 20);
});

test("imageSurface: dispose is final", async () => {
  stub.ImageView = FakeView; stub.screen = { getDisplayMatching: () => ({ scaleFactor: 1 }) }; stub.nativeTheme = { shouldUseDarkColors: false };
  const { win, children } = fakeWindow();
  const surface = imageSurface({ window: win as never, has: () => true, tag: async () => img(10, 10) });
  const view = FakeView.last!;
  await surface.draw("arrow", "x");
  surface.show(true); assert.ok(children.includes(view));
  surface.dispose(); assert.ok(!children.includes(view));
  surface.show(true); surface.raise(); surface.place({ x: 5, y: 5 });
  assert.ok(!children.includes(view), "never added again");
});

test("imageSurface: ready reads the drawer's cache", () => {
  stub.ImageView = FakeView; stub.screen = { getDisplayMatching: () => ({ scaleFactor: 2 }) }; stub.nativeTheme = { shouldUseDarkColors: true };
  const { win } = fakeWindow(); const seen: unknown[][] = [];
  const surface = imageSurface({ window: win as never, tag: async () => img(1, 1), has: (...a) => { seen.push(a); return a[0] === "press"; } });
  assert.equal(surface.ready("press", "t"), true);
  assert.equal(surface.ready("arrow", "t"), false);
  assert.deepEqual(seen[0], ["press", "t", 2, true]);
});

// ---- the drawer ---------------------------------------------------------------------------------------------------

const doc = (u: string) => decodeURIComponent(u.slice("data:text/html;charset=utf-8,".length));

class FakeWin {
  static made: FakeWin[] = []; static active = 0; static maxActive = 0; static urls: string[] = []; static failCaptures = 0; static captures = 0;
  /** The display the window sits on: the capture is this many pixels per DIP. */
  static display = 1; static hang = false;
  opts: Record<string, unknown>; destroyed = false; handlers = new Map<string, (...a: unknown[]) => void>();
  content: [number, number] = [260, 60]; sizes: number[][] = []; lastUrl = ""; zoomCalls = 0;
  openHandler: (() => { action: string }) | undefined;
  webContents = {
    setWindowOpenHandler: (f: () => { action: string }) => { this.openHandler = f; },
    on: (n: string, f: (...a: unknown[]) => void) => { this.handlers.set(n, f); },
    setZoomFactor: () => { this.zoomCalls++; },
    loadURL: async (u: string) => {
      FakeWin.urls.push(u); this.lastUrl = u;
      if (FakeWin.hang) await new Promise(() => {});
      FakeWin.active++; FakeWin.maxActive = Math.max(FakeWin.maxActive, FakeWin.active);
      await new Promise((r) => setTimeout(r, 2)); FakeWin.active--;
    },
    capturePage: async () => {
      if (this.destroyed) throw new Error("Object has been destroyed");
      FakeWin.captures++;
      if (FakeWin.failCaptures > 0) { FakeWin.failCaptures--; throw new Error("UnknownVizError"); }
      // The document draws an 80 x 36 DIP mark at 3,2 px, scaled by its root's zoom and by the display, clipped to the window.
      const m = /zoom:([0-9.]+)/.exec(doc(this.lastUrl)); const zoom = m ? Number(m[1]) : 1;
      const W = Math.round(this.content[0] * FakeWin.display); const H = Math.round(this.content[1] * FakeWin.display);
      const bm = Buffer.alloc(W * H * 4);
      const bw = Math.round(80 * zoom * FakeWin.display); const bh = Math.round(36 * zoom * FakeWin.display);
      for (let y = 2; y < Math.min(H, 2 + bh); y++) for (let x = 3; x < Math.min(W, 3 + bw); x++) { const i = (y * W + x) * 4; bm[i] = 1; bm[i + 3] = 255; }
      return { toBitmap: () => bm, getSize: () => ({ width: W, height: H }) };
    },
  };
  constructor(opts: Record<string, unknown>) { this.opts = opts; FakeWin.made.push(this); }
  setContentSize(w: number, h: number) { this.content = [w, h]; this.sizes.push([w, h]); }
  getContentSize() { return this.content; }
  getBounds() { return { x: 0, y: 0, width: 260, height: 60 }; }
  setTitle() {}
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}
/** `screenSays`: what the screen lookup answers (the drawer's first guess); FakeWin.display is the truth. */
function drawerEnv(screenSays = 1, display = 1) {
  FakeWin.made = []; FakeWin.active = 0; FakeWin.maxActive = 0; FakeWin.urls = []; FakeWin.failCaptures = 0; FakeWin.captures = 0; FakeWin.hang = false;
  FakeWin.display = display;
  stub.BrowserWindow = FakeWin;
  stub.screen = { getDisplayMatching: () => ({ scaleFactor: screenSays }) };
  stub.nativeImage = { createFromBitmap: (buf: Buffer, o: { width: number; height: number; scaleFactor: number }) => ({ buf, ...o }) };
}
type Made = { buf: Buffer; width: number; height: number; scaleFactor: number };
const dip = (i: unknown) => { const m = i as Made; return [m.width / m.scaleFactor, m.height / m.scaleFactor]; };
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the drawer draws one at a time, caches, and makes the press image with the arrow", async () => {
  drawerEnv();
  const d = tagDrawer();
  assert.equal(FakeWin.made.length, 0, "no window until the first draw");
  const [a, b] = await Promise.all([d.draw("arrow", "One", 1, false), d.draw("caret", "One", 1, false)]);
  await later(30);
  assert.equal(FakeWin.made.length, 1);
  assert.equal(FakeWin.maxActive, 1);
  // arrow, caret, and the press the arrow started: three loads, each its own kind.
  assert.equal(FakeWin.urls.length, 3);
  assert.ok(FakeWin.urls.every((u) => u.startsWith("data:text/html;charset=utf-8,")));
  // The image is cropped to the drawing and starts on its first opaque pixel.
  assert.deepEqual(dip(a), [80, 36]);
  assert.equal((a as unknown as Made).buf[3], 255, "the first pixel of the image is the mark's tip");
  assert.ok(b);
  const w = FakeWin.made[0].opts;
  const wp = w.webPreferences as Record<string, unknown>;
  assert.equal(w.show, false); assert.equal(w.transparent, true); assert.equal(w.frame, false); assert.equal(w.focusable, false); assert.equal(w.skipTaskbar, true);
  assert.equal(wp.sandbox, true); assert.equal(wp.javascript, false); assert.ok(!String(wp.partition).startsWith("persist:") && wp.partition); assert.equal(wp.preload, undefined);
  assert.ok(!String(w.title).startsWith("UniDeX Browser"));
  assert.deepEqual(FakeWin.made[0].openHandler!(), { action: "deny" });
  let prevented = 0; FakeWin.made[0].handlers.get("will-navigate")!({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
  // The press image is already cached: asking for it loads nothing.
  const before = FakeWin.urls.length;
  await d.draw("press", "One", 1, false);
  await d.draw("arrow", "One", 1, false);
  assert.equal(FakeWin.urls.length, before);
  assert.equal(d.has("press", "One", 1, false), true);
  assert.equal(d.has("press", "Two", 1, false), false);
  // One retry after a failed capture; two failures reject.
  FakeWin.failCaptures = 1; await d.draw("caret", "Retry", 1, false);
  FakeWin.failCaptures = 2; await assert.rejects(d.draw("caret", "Never", 1, false));
  assert.ok(doc(FakeWin.urls[0]).includes("One"));
  assert.equal(FakeWin.made[0].zoomCalls, 0, "the page is never zoomed by the window");
  d.dispose(); assert.equal(FakeWin.made[0].destroyed, true);
});

test("the image's DIP size is the same for wanted 1 and 2 on a 1x and on a 2x drawer display", async () => {
  for (const display of [1, 2]) {
    drawerEnv(display, display);
    const d = tagDrawer();
    for (const wanted of [1, 2]) {
      const i = await d.draw("caret", `n${wanted}`, wanted, false);
      assert.deepEqual(dip(i), [80, 36], `display ${display}, wanted ${wanted}`);
      assert.equal((i as unknown as Made).scaleFactor, wanted);
      const k = wanted / display;
      assert.deepEqual(FakeWin.made[0].sizes[FakeWin.made[0].sizes.length - 1], [Math.round(260 * k), Math.round(60 * k)], "the window is sized for the zoom");
      if (k !== 1) assert.ok(doc(FakeWin.urls[FakeWin.urls.length - 1]).includes(`zoom:${k}`));
    }
    d.dispose();
  }
});

test("when the screen's answer is wrong, the measured scale corrects it and the drawing is made again", async () => {
  drawerEnv(1, 2);   // the lookup says 1x, the capture is 2x
  const d = tagDrawer();
  const i = await d.draw("caret", "x", 2, false);
  assert.deepEqual(dip(i), [80, 36]);
  assert.equal((i as unknown as Made).scaleFactor, 2);
  assert.equal(FakeWin.urls.length, 2, "once wrong, once right");
  const j = await d.draw("caret", "y", 1, false);
  assert.deepEqual(dip(j), [80, 36]);
  assert.equal(FakeWin.urls.length, 3, "the measured scale is remembered");
  d.dispose();
});

test("the drawer keeps at most 32 images, dropping the oldest", async () => {
  drawerEnv();
  const d = tagDrawer();
  for (let i = 0; i < 33; i++) await d.draw("caret", `n${i}`, 1, false);
  assert.equal(d.has("caret", "n0", 1, false), false);
  assert.equal(d.has("caret", "n32", 1, false), true);
  d.dispose();
});

test("an arrow drawn and the drawer disposed at once: one window was ever made, and press is not there", async () => {
  drawerEnv();
  const d = tagDrawer();
  await d.draw("arrow", "A", 1, false);
  d.dispose();
  await later(40);
  assert.equal(FakeWin.made.length, 1);
  assert.equal(FakeWin.made[0].destroyed, true);
  assert.equal(d.has("press", "A", 1, false), false);
  assert.equal(d.has("arrow", "A", 1, false), false);
  await assert.rejects(d.draw("arrow", "B", 1, false));
  assert.equal(FakeWin.made.length, 1);
});

test("an arrow found in the cache starts a press that failed before", async () => {
  drawerEnv();
  const d = tagDrawer({ retryMs: 1 });
  await d.draw("caret", "warm", 1, false);
  await d.draw("arrow", "C", 1, false);
  FakeWin.failCaptures = 2;                      // the press that follows fails: its capture and its retry
  await assert.rejects(d.draw("press", "C", 1, false));
  assert.equal(d.has("press", "C", 1, false), false, "the press failed");
  await d.draw("arrow", "C", 1, false);          // the arrow is cached now
  await d.draw("press", "C", 1, false);          // joins the press the arrow started
  assert.equal(d.has("press", "C", 1, false), true, "tried again");
  d.dispose();
});

test("a render that never settles is cut at its limit: the draw rejects, the window is replaced, the queue goes on", async () => {
  drawerEnv();
  const d = tagDrawer({ renderMs: 40 });
  await d.draw("caret", "ok", 1, false);
  FakeWin.hang = true;
  await assert.rejects(d.draw("caret", "stuck", 1, false));
  assert.equal(FakeWin.made[0].destroyed, true);
  FakeWin.hang = false;
  const i = await d.draw("caret", "after", 1, false);
  assert.deepEqual(dip(i), [80, 36]);
  assert.equal(FakeWin.made.length, 2, "a fresh window");
  d.dispose();
});
