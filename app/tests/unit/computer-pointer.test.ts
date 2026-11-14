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
  /** What `prepare` was asked for: it makes an image ready and touches neither the view nor its image. */
  prepared: Array<[PointerKind, string]> = [];
  constructor(private clock: FakeClock) {}
  prepare(kind: PointerKind, tag: string) { this.prepared.push([kind, tag]); }
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

test("in a narrow view the first move starts where the tagged image fits", async () => {
  const { clock, s, pointer } = make();
  s.size = (_k, tag) => (tag ? { width: 200, height: 30 } : { width: 14, height: 22 });
  const within = { x: 0, y: 0, width: 320, height: 400 };
  void pointer.moveTo({ ...base, within, to: { x: 50, y: 100 }, alive: () => true });
  await flush(); await clock.advance(400);
  // The middle of the view is (160, 200); a 200 wide image there reaches 360. It starts at 120, where it ends at the edge.
  assert.deepEqual(s.places[0].p, { x: 120, y: 200 });
  assert.ok(s.places.every((p) => p.p.x + 200 <= 320 && p.p.y + 30 <= 400), "every step lies inside the view");
  // The same from the bottom.
  const m = make();
  m.s.size = (_k, tag) => (tag ? { width: 100, height: 300 } : { width: 14, height: 22 });
  void m.pointer.moveTo({ ...base, within, to: { x: 50, y: 20 }, alive: () => true });
  await flush(); await m.clock.advance(400);
  assert.deepEqual(m.s.places[0].p, { x: 160, y: 100 });
});

test("a kept position where the new image would cross the edge is pulled in", async () => {
  const { clock, s, pointer } = make();
  s.size = (_k, tag) => (tag ? { width: 120, height: 30 } : { width: 14, height: 22 });
  const within = { x: 0, y: 0, width: 600, height: 500 };
  void pointer.moveTo({ ...base, name: "", within, to: { x: 580, y: 300 }, alive: () => true });   // a bare mark: it fits there
  await flush(); await clock.advance(400);
  assert.deepEqual(pointer.state().at, { x: 580, y: 300 });
  s.places.length = 0;
  void pointer.moveTo({ ...base, within, to: { x: 100, y: 100 }, alive: () => true });             // the tag is 120 wide
  await flush(); await clock.advance(400);
  assert.deepEqual(s.places[0].p, { x: 480, y: 300 });
  assert.ok(s.places.every((p) => p.p.x + 120 <= 600));
});

test("touch keeps a shown pointer for another 3 s and shows nothing by itself", async () => {
  const { clock, s, pointer } = make();
  pointer.touch();
  assert.equal(s.log.length, 0, "nothing on screen: nothing happens");
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);
  await clock.advance(2000); pointer.touch();
  await clock.advance(2000);                         // 4300 ms in: past the move's own timer
  assert.equal(pointer.state().shown, true);
  await clock.advance(1200);                         // 3 s after the touch
  assert.equal(pointer.state().shown, false);
  const hides = s.log.filter((l) => l === "hide").length;
  pointer.touch(); await clock.advance(5000);
  assert.equal(s.log.filter((l) => l === "hide").length, hides);
  const tail: string[] = s.log; assert.ok(!tail.slice(tail.lastIndexOf("hide") + 1).includes("show"));
});

test("a spinner in front of a name is not part of the tag", () => {
  assert.equal(tagText("✳ Fix login"), "Fix login");
  assert.equal(tagText("⠐ Fix login"), "Fix login");
  assert.equal(tagText("⠐  Fix login"), "Fix login");
  assert.equal(tagText("✳✻ Fix login"), "Fix login");
  assert.equal(tagText("[WIP] x"), "[WIP] x");
  assert.equal(tagText("#123"), "#123");
  assert.equal(tagText("C++ notes"), "C++ notes");
  assert.equal(tagText("✳ "), "✳");
  assert.equal(tagText("✳"), "✳");
  assert.equal(tagText("1 Fix"), "1 Fix");
  assert.equal(tagText("*** Fix"), "*** Fix");
  assert.equal(tagText("✳ ✻ Fix"), "✻ Fix", "one mark at most");
});

test("a throw inside a move leaves nothing behind and the action goes on", async () => {
  const clock = new FakeClock(); const s = new FakeSurface(clock);
  const lines: string[] = [];
  let n = 0; const realPlace = s.place.bind(s);
  s.place = (at: Point) => { if (++n === 3) throw new Error("boom with a secret name"); realPlace(at); };
  const pointer = new Pointer({ surface: () => s, clock, log: (l) => lines.push(l) });
  let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 3000, y: 2000 }, alive: () => true }).then((v) => { done = v; });
  await flush(); await clock.advance(300);
  assert.equal(done, true, "resolves alive()");
  assert.equal(pointer.state().shown, false);
  assert.equal(s.log[s.log.length - 1], "hide");
  await clock.advance(5000);
  assert.equal(s.log.filter((l) => l === "hide").length, 1, "no timer is left armed");
  assert.equal(lines.length, 1);
  assert.ok(!/secret/.test(lines[0]));
  // With a Take over already in, it resolves false.
  const t = new FakeSurface(clock); t.place = () => { throw new Error("x"); };
  const p2 = new Pointer({ surface: () => t, clock });
  assert.equal(await p2.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => false }), false);
});

test("a hostile name of 5000 characters gives a tag no longer than the longest allowed", async () => {
  const hostile = "W".repeat(5000);
  const longest = "W".repeat(TAG_MAX);
  assert.equal(tagText(hostile).length, TAG_MAX);
  assert.equal(tagText(longest), longest);
  const html = pointerHtml("arrow", tagText(hostile), false);
  assert.ok(html.includes(`>${tagText(hostile)}</div>`));
  assert.ok(!html.includes("W".repeat(TAG_MAX + 1)));
  assert.match(html, /\.tag\{[^}]*max-width:200px;[^}]*overflow:hidden;white-space:nowrap/);
  const { clock, s, pointer } = make();
  void pointer.moveTo({ ...base, name: hostile, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(300);
  assert.ok(s.drawn.every(([, tag]) => tag.length <= TAG_MAX));
});

test("an edge drop hides a pointer that is on the other window's surface", async () => {
  const { clock, main, pop, pointer } = makeTwo();
  main.size = pop.size = (_k, tag) => (tag ? { width: 120, height: 30 } : { width: 14, height: 22 });
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush(); await clock.advance(400);
  assert.equal(main.visible, true);
  const within = { x: 0, y: 0, width: 700, height: 400 };
  assert.equal(await pointer.moveTo({ ...base, window: "pop", within, to: { x: 695, y: 100 }, alive: () => true }), true);
  assert.equal(main.visible, false, "the pointer on the other window is gone");
  assert.equal(pop.visible, false);
  assert.ok(!pop.log.includes("show"));
  assert.equal(pointer.state().shown, false);
  await clock.advance(5000);
  assert.equal(main.log.filter((l) => l === "hide").length, 1);
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
  assert.doesNotThrow(() => { surface.place({ x: 1, y: 1 }); surface.show(true); surface.show(false); surface.dispose(); });
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
  surface.show(true); surface.place({ x: 5, y: 5 });
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
  static made: FakeWin[] = []; static active = 0; static maxActive = 0; static urls: string[] = []; static failCaptures = 0; static emptyCaptures = 0; static captures = 0;
  /** What the window answers for its content width (null: the truth): a capture over this gives a measured scale. */
  static reportedWidth: number | null = null;
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
      await flush(); FakeWin.active--;
    },
    capturePage: async () => {
      if (this.destroyed) throw new Error("Object has been destroyed");
      FakeWin.captures++;
      if (FakeWin.failCaptures > 0) { FakeWin.failCaptures--; throw new Error("UnknownVizError"); }
      // Electron resolves, it does not reject, when there is no frame to copy: an image of 0 x 0.
      if (FakeWin.emptyCaptures > 0) { FakeWin.emptyCaptures--; return { toBitmap: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) }; }
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
  getContentSize() { return [FakeWin.reportedWidth ?? this.content[0], this.content[1]]; }
  getBounds() { return { x: 0, y: 0, width: 260, height: 60 }; }
  setTitle() {}
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}
/** `screenSays`: what the screen lookup answers (the drawer's first guess); FakeWin.display is the truth. */
function drawerEnv(screenSays = 1, display = 1) {
  FakeWin.made = []; FakeWin.active = 0; FakeWin.maxActive = 0; FakeWin.urls = []; FakeWin.failCaptures = 0; FakeWin.emptyCaptures = 0; FakeWin.captures = 0; FakeWin.hang = false; FakeWin.reportedWidth = null;
  FakeWin.display = display;
  stub.BrowserWindow = FakeWin;
  stub.screen = { getDisplayMatching: () => ({ scaleFactor: screenSays }) };
  stub.nativeImage = { createFromBitmap: (buf: Buffer, o: { width: number; height: number; scaleFactor: number }) => ({ buf, ...o }) };
}
type Made = { buf: Buffer; width: number; height: number; scaleFactor: number };
const dip = (i: unknown) => { const m = i as Made; return [m.width / m.scaleFactor, m.height / m.scaleFactor]; };
/** A drawer on a fake clock: nothing in it waits on real time. */
function mk(o: { renderMs?: number; retryMs?: number; idleMs?: number; log?: (l: string) => void } = {}) {
  const clock = new FakeClock();
  return { clock, d: tagDrawer({ clock, ...o }) };
}
/** Lets the clock run on (50 ms at a time) until `p` has settled: a draw that waits for a retry or a limit. */
async function settle<T>(clock: FakeClock, p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> {
  let out: { ok: true; v: T } | { ok: false; e: unknown } | undefined;
  p.then((v) => { out = { ok: true, v }; }, (e) => { out = { ok: false, e }; });
  for (let i = 0; i < 200 && !out; i++) { await flush(); await clock.advance(50); }
  if (!out) throw new Error("did not settle");
  return out;
}
/** Lets queued microtasks and the fake window's loads run. */
const idle = async () => { for (let i = 0; i < 20; i++) await flush(); };

test("the drawer draws one at a time, caches, and makes the press image with the arrow", async () => {
  drawerEnv();
  const { clock, d } = mk();
  assert.equal(FakeWin.made.length, 0, "no window until the first draw");
  const [a, b] = await Promise.all([d.draw("arrow", "One", 1, false), d.draw("caret", "One", 1, false)]);
  await d.draw("press", "One", 1, false);              // joins the press the arrow started
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
  FakeWin.failCaptures = 1; assert.equal((await settle(clock, d.draw("caret", "Retry", 1, false))).ok, true);
  FakeWin.failCaptures = 2; assert.equal((await settle(clock, d.draw("caret", "Never", 1, false))).ok, false);
  assert.ok(doc(FakeWin.urls[0]).includes("One"));
  assert.equal(FakeWin.made[0].zoomCalls, 0, "the page is never zoomed by the window");
  d.dispose(); assert.equal(FakeWin.made[0].destroyed, true);
});

test("the image's DIP size is the same for wanted 1 and 2 on a 1x and on a 2x drawer display", async () => {
  for (const display of [1, 2]) {
    drawerEnv(display, display);
    const { d } = mk();
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
  const { d } = mk();
  const i = await d.draw("caret", "x", 2, false);
  assert.deepEqual(dip(i), [80, 36]);
  assert.equal((i as unknown as Made).scaleFactor, 2);
  assert.equal(FakeWin.urls.length, 2, "once wrong, once right");
  const j = await d.draw("caret", "y", 1, false);
  assert.deepEqual(dip(j), [80, 36]);
  assert.equal(FakeWin.urls.length, 3, "the measured scale is remembered");
  d.dispose();
});

test("one empty capture fails that draw and the next draw works", async () => {
  drawerEnv();
  const { clock, d } = mk();
  // An empty capture is a failed one: it is tried again once, and a second empty one rejects the draw.
  FakeWin.emptyCaptures = 2;
  assert.equal((await settle(clock, d.draw("caret", "a", 1, false))).ok, false);
  const next = await settle(clock, d.draw("caret", "b", 1, false));
  assert.equal(next.ok, true, "the drawer is not switched off");
  assert.deepEqual(dip((next as { ok: true; v: unknown }).v), [80, 36]);
  assert.deepEqual(FakeWin.made[0].sizes[FakeWin.made[0].sizes.length - 1], [260, 60], "no zoom of Infinity, no size of 0");
  // A single empty capture is passed by the retry.
  FakeWin.emptyCaptures = 1;
  assert.equal((await settle(clock, d.draw("caret", "c", 1, false))).ok, true);
  d.dispose();
});

test("a measured scale of 0, NaN or 40 is never kept", async () => {
  for (const reported of [Infinity, NaN, 6.5, 260 / 0.1]) {   // measured: 0, NaN, 40, 0.1
    drawerEnv();
    const { clock, d } = mk();
    await d.draw("caret", "good", 1, false);                  // the scale 1 is measured and kept
    FakeWin.reportedWidth = reported;
    assert.equal((await settle(clock, d.draw("caret", `bad${reported}`, 1, false))).ok, false, `reported ${reported}`);
    FakeWin.reportedWidth = null;
    const sizes = FakeWin.made[0].sizes.length;
    const again = await settle(clock, d.draw("caret", "again", 1, false));
    assert.equal(again.ok, true, `reported ${reported}`);
    assert.deepEqual(FakeWin.made[0].sizes[sizes], [260, 60], "the stored scale is still 1");
    d.dispose();
  }
});

test("the drawer keeps at most 32 images, dropping the oldest", async () => {
  drawerEnv();
  const { d } = mk();
  for (let i = 0; i < 33; i++) await d.draw("caret", `n${i}`, 1, false);
  assert.equal(d.has("caret", "n0", 1, false), false);
  assert.equal(d.has("caret", "n32", 1, false), true);
  d.dispose();
});

test("an image used again outlives 32 newer ones", async () => {
  drawerEnv();
  const { d } = mk();
  await d.draw("caret", "keep", 1, false);
  for (let i = 0; i < 10; i++) await d.draw("caret", `a${i}`, 1, false);
  await d.draw("caret", "keep", 1, false);               // used again: it is the newest now
  for (let i = 0; i < 31; i++) await d.draw("caret", `b${i}`, 1, false);
  assert.equal(d.has("caret", "keep", 1, false), true, "least recently used goes first");
  assert.equal(d.has("caret", "a0", 1, false), false);
  assert.equal(d.has("caret", "b30", 1, false), true);
  d.dispose();
});

test("an arrow drawn and the drawer disposed at once: one window was ever made, and press is not there", async () => {
  drawerEnv();
  const { d } = mk();
  await d.draw("arrow", "A", 1, false);
  d.dispose();
  await idle();
  assert.equal(FakeWin.made.length, 1);
  assert.equal(FakeWin.made[0].destroyed, true);
  assert.equal(d.has("press", "A", 1, false), false);
  assert.equal(d.has("arrow", "A", 1, false), false);
  await assert.rejects(d.draw("arrow", "B", 1, false));
  assert.equal(FakeWin.made.length, 1);
});

test("an arrow found in the cache starts a press that failed before", async () => {
  drawerEnv();
  const { clock, d } = mk();
  await d.draw("caret", "warm", 1, false);
  await d.draw("arrow", "C", 1, false);
  FakeWin.failCaptures = 2;                      // the press that follows fails: its capture and its retry
  assert.equal((await settle(clock, d.draw("press", "C", 1, false))).ok, false);
  assert.equal(d.has("press", "C", 1, false), false, "the press failed");
  await d.draw("arrow", "C", 1, false);          // the arrow is cached now
  await d.draw("press", "C", 1, false);          // joins the press the arrow started
  assert.equal(d.has("press", "C", 1, false), true, "tried again");
  d.dispose();
});

test("a render that never settles is cut at its limit: the draw rejects, the window is replaced, the queue goes on", async () => {
  drawerEnv();
  const { clock, d } = mk({ renderMs: 40 });
  await d.draw("caret", "ok", 1, false);
  FakeWin.hang = true;
  assert.equal((await settle(clock, d.draw("caret", "stuck", 1, false))).ok, false);
  assert.equal(FakeWin.made[0].destroyed, true);
  FakeWin.hang = false;
  const i = await d.draw("caret", "after", 1, false);
  assert.deepEqual(dip(i), [80, 36]);
  assert.equal(FakeWin.made.length, 2, "a fresh window");
  d.dispose();
});

test("a failed drawing is logged once a minute, with no name and no address in the line", async () => {
  drawerEnv();
  const lines: string[] = [];
  const { clock, d } = mk({ log: (l) => lines.push(l) });
  FakeWin.failCaptures = 4;
  await settle(clock, d.draw("caret", "Secret project name", 1, false));
  await settle(clock, d.draw("caret", "Another secret name", 1, false));
  assert.equal(lines.length, 1, "the second failure within a minute is not logged again");
  assert.match(lines[0], /^pointer: a drawing failed \(\w+\)$/);
  assert.ok(!/secret|data:|http/i.test(lines[0]));
  await clock.advance(60_000);
  FakeWin.failCaptures = 2;
  await settle(clock, d.draw("caret", "A third one", 1, false));
  assert.equal(lines.length, 2, "a minute later it is logged again");
  // A drawing that was cut off by dispose is not a failure to report.
  const before = lines.length;
  d.dispose();
  await d.draw("caret", "x", 1, false).catch(() => {});
  assert.equal(lines.length, before);
});

test("the hidden window is destroyed after 60 s with no draw, the cache stays, and the next draw makes a fresh one", async () => {
  drawerEnv();
  const { clock, d } = mk();
  await d.draw("caret", "A", 1, false);
  await clock.advance(59_000);
  assert.equal(FakeWin.made[0].destroyed, false);
  await d.draw("caret", "B", 1, false);          // a draw starts the minute again
  await clock.advance(59_000);
  assert.equal(FakeWin.made[0].destroyed, false);
  await clock.advance(2_000);
  assert.equal(FakeWin.made[0].destroyed, true);
  assert.equal(d.has("caret", "A", 1, false), true, "the cache stays");
  await d.draw("caret", "A", 1, false);
  assert.equal(FakeWin.made.length, 1, "a cached image needs no window");
  await d.draw("caret", "C", 1, false);
  assert.equal(FakeWin.made.length, 2);
  d.dispose();
  assert.equal(FakeWin.made[1].destroyed, true);
});

test("the idle limit is an option", async () => {
  drawerEnv();
  const { clock, d } = mk({ idleMs: 500 });
  await d.draw("caret", "A", 1, false);
  await clock.advance(600);
  assert.equal(FakeWin.made[0].destroyed, true);
  d.dispose();
});

test("warm sets no image and shows nothing", async () => {
  const { s, pointer } = make();
  pointer.warm({ window: "main", name: "Fix login" });
  await flush();
  assert.deepEqual(s.prepared, [["arrow", "Fix login"], ["caret", "Fix login"]]);
  assert.deepEqual(s.drawn, [], "no draw: the view's image is never set");
  assert.deepEqual(s.log.filter((l) => l === "show" || l === "place"), [], "nothing placed or shown");
  assert.equal(s.current, null);
  assert.equal(pointer.state().shown, false);
  // A missing surface and a gone surface are no-ops that throw nothing.
  s.dead = true;
  pointer.warm({ window: "main", name: "Gone" });
  make({ surface: false }).pointer.warm({ window: "pop", name: "None" });
  assert.equal(s.prepared.length, 2);
});

test("a warm during a move's draw does not change the image that lands", async () => {
  const { clock, s, pointer } = make();
  let release!: () => void;
  s.gate = new Promise<void>((r) => { release = r; });
  const moved = pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true });
  await flush();
  pointer.warm({ window: "main", name: "Other name" });
  release(); s.gate = undefined;
  await clock.advance(300);
  assert.equal(await moved, true);
  assert.deepEqual(s.drawn, [["arrow", "Fix login"]], "only the move drew");
  assert.deepEqual(s.current, { kind: "arrow", tag: "Fix login" });
});

// ---- keepWithin: a view whose box changed

async function shownAt(to = { x: 440, y: 300 }) {
  const m = make();
  const within = { x: 100, y: 50, width: 1000, height: 800 };
  void m.pointer.moveTo({ ...base, within, to, alive: () => true });
  await m.clock.advance(300);
  assert.equal(m.pointer.state().shown, true);
  return { ...m, within };
}

test("a view that only got shorter keeps a pointer that still fits", async () => {
  const { clock, s, pointer, within } = await shownAt();
  const hides = s.log.filter((l) => l === "hide").length;
  pointer.keepWithin({ ...within, height: 500 });
  assert.equal(pointer.state().shown, true);
  assert.equal(s.log.filter((l) => l === "hide").length, hides, "not hidden");
  // Its timer is untouched: it still hides 3 s after the move.
  await clock.advance(HIDE_AFTER_MS);
  assert.equal(pointer.state().shown, false);
});

test("a view that moved, or no longer holds the pointer, hides it", async () => {
  const a = await shownAt();
  a.pointer.keepWithin({ ...a.within, x: a.within.x + 5 });
  assert.equal(a.pointer.state().shown, false, "its origin moved");
  const b = await shownAt();
  b.pointer.keepWithin({ ...b.within, height: 200 });   // the pointer's image reaches down to y 320, the box to 250
  assert.equal(b.pointer.state().shown, false, "the image no longer lies inside");
  const c = await shownAt();
  c.pointer.keepWithin({ ...c.within, width: 300 });
  assert.equal(c.pointer.state().shown, false, "the image no longer lies inside (width)");
  // Nothing on screen: nothing to do.
  const d = make();
  assert.doesNotThrow(() => d.pointer.keepWithin(WITHIN));
});


test("imageSurface: prepare asks the drawer for the window's scale and theme and sets no image", async () => {
  stub.ImageView = FakeView; stub.screen = { getDisplayMatching: () => ({ scaleFactor: 2 }) }; stub.nativeTheme = { shouldUseDarkColors: true };
  const { win, children } = fakeWindow(); const asked: unknown[][] = [];
  let fail = false;
  const surface = imageSurface({ window: win as never, has: () => false, tag: async (...a) => { asked.push(a); if (fail) throw new Error("no"); return img(10, 10); } });
  const view = FakeView.last!;
  surface.prepare("arrow", "Fix");
  await flush();
  assert.deepEqual(asked, [["arrow", "Fix", 2, true]]);
  assert.equal(view.image, undefined, "no image set");
  assert.ok(!children.includes(view), "never shown");
  fail = true;
  assert.doesNotThrow(() => surface.prepare("caret", "Fix"));
  await flush();
  surface.dispose();
  assert.doesNotThrow(() => surface.prepare("caret", "Fix"));
});

test("keepWithin does not re-arm the timer of a pointer it keeps", async () => {
  const { clock, pointer, within } = await shownAt();
  await clock.advance(2000);
  pointer.keepWithin({ ...within, height: 600 });
  assert.equal(pointer.state().shown, true);
  await clock.advance(1200);                      // the move's own timer is due (about 3240 ms after it started); a re-armed one is not
  assert.equal(pointer.state().shown, false);
});

test("keepWithin hides a pointer whose image no longer fits, though its point does", async () => {
  const { s, pointer, within } = await shownAt();   // the image is 30 x 20 at (440, 300)
  pointer.keepWithin({ ...within, height: 260 });   // the box ends at y 310: the point 300 is inside, the image (to 320) is not
  assert.equal(pointer.state().shown, false);
  assert.equal(s.log[s.log.length - 1], "hide");
  const b = await shownAt();
  b.pointer.keepWithin({ ...b.within, width: 360 });   // ends at x 460; the image reaches 470
  assert.equal(b.pointer.state().shown, false);
});

test("keepWithin hides a pointer whose target no longer fits, though the pointer now does", async () => {
  const { clock, s, pointer } = make();
  const within = { x: 100, y: 50, width: 1000, height: 800 };
  void pointer.moveTo({ ...base, within, to: { x: 1000, y: 800 }, alive: () => true });   // from the view's middle (600, 450)
  await flush(); await clock.advance(32);
  assert.equal(pointer.state().shown, true);
  const at = pointer.state().at!;
  assert.ok(at.x < 1000, "still travelling");
  pointer.keepWithin({ ...within, height: 760 });   // the box ends at y 810: the image at the target (to 820) no longer fits; where it is now, it does
  assert.equal(pointer.state().shown, false);
  assert.equal(s.log[s.log.length - 1], "hide");
});

