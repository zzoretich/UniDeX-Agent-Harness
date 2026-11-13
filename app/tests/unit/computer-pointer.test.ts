// The pointer main draws above a browser tab (session-browser S9, §4.5): the travel maths, the Pointer that moves it and
// never keeps an action waiting, the ImageView surface, and the drawer that makes its image. The unit bundle's electron
// is an empty stand-in (electron-stub.cjs), so the window, the view and the screen the code uses are given here.

import { test } from "node:test";
import assert from "node:assert/strict";
import electron from "electron";
import {
  DRAW_MAX_MS, HIDE_AFTER_MS, imageSurface, opaqueBox, Pointer, PULSE_MS, pointerHtml, tagDrawer, tagText, travelMs, travelPath, TAG_MAX,
  type Point, type PointerKind, type PointerSurface,
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
  /** Moves time on in 16 ms steps (the pointer's own), letting the promises the code awaits run between steps. */
  async advance(ms: number) {
    for (let left = ms; left > 0; left -= 16) { this.fire(this.t + Math.min(16, left)); await flush(); }
  }
}
const flush = () => new Promise<void>((r) => setImmediate(r));

class FakeSurface implements PointerSurface {
  log: string[] = []; places: Array<{ at: number; p: Point }> = []; drawn: Array<[PointerKind, string]> = [];
  /** Held by a test to keep the image from being ready; undefined draws at once. */
  gate: Promise<void> | undefined; fail = false; pressReady = true;
  constructor(private clock: FakeClock, private mid: Point = { x: 400, y: 300 }) {}
  async draw(kind: PointerKind, tag: string) {
    this.log.push(`draw:${kind}`); this.drawn.push([kind, tag]);
    if (this.gate) await this.gate;
    if (this.fail) throw new Error("no image");
  }
  place(at: Point) { this.places.push({ at: this.clock.now(), p: at }); this.log.push("place"); }
  show(on: boolean) { this.log.push(on ? "show" : "hide"); }
  centre() { return this.mid; }
  ready(kind: PointerKind) { return kind !== "press" || this.pressReady; }
}

function make(opts: { surface?: boolean } = {}) {
  const clock = new FakeClock(); const s = new FakeSurface(clock);
  const pointer = new Pointer({ surface: () => (opts.surface === false ? null : s), clock });
  return { clock, s, pointer };
}
const base = { window: "main" as const, name: "Fix login", kind: "arrow" as const };

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

test("opaqueBox finds the drawing and nothing for an empty bitmap", () => {
  const w = 12; const h = 8; const bm = Buffer.alloc(w * h * 4);
  assert.equal(opaqueBox(bm, w, h), null);
  for (const [x, y] of [[3, 2], [9, 5]] as const) bm[(y * w + x) * 4 + 3] = 255;
  assert.deepEqual(opaqueBox(bm, w, h), { x: 3, y: 2, width: 7, height: 4 });
});

test("moveTo draws, travels and shows; it hides 3 s after the last action", async () => {
  const { clock, s, pointer } = make();
  let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true }).then((v) => { done = v; });
  await flush();
  assert.deepEqual(s.drawn[0], ["arrow", "Fix login"]);
  assert.ok(s.log.indexOf("draw:arrow") < s.log.indexOf("show"));
  // The first move in a window starts from the view's centre and ends exactly on the target.
  assert.deepEqual(s.places[0].p, { x: 400, y: 300 });
  await clock.advance(300);
  assert.equal(done, true);
  assert.deepEqual(s.places[s.places.length - 1].p, { x: 440, y: 300 });
  assert.ok(!s.log.includes("hide"));
  await clock.advance(HIDE_AFTER_MS - 400);   // 2900 ms in; the travel ended near 90 ms
  assert.ok(!s.log.includes("hide"));
  await clock.advance(300);
  assert.equal(s.log.filter((l) => l === "hide").length, 1);
  // The next move starts where this one ended, not at the centre.
  s.places.length = 0;
  void pointer.moveTo({ ...base, to: { x: 500, y: 300 }, alive: () => true });
  await flush();
  assert.deepEqual(s.places[0].p, { x: 440, y: 300 });
});

test("a Take over during the travel stops it within one step and reports false", async () => {
  const { clock, s, pointer } = make();
  let alive = true; let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 3000, y: 2000 }, alive: () => alive }).then((v) => { done = v; });
  await flush();
  await clock.advance(40); alive = false;
  await clock.advance(16);
  assert.equal(done, false);
  assert.ok(s.places.every((p) => p.at <= 40), JSON.stringify(s.places.map((p) => p.at)));
  const n = s.places.length;
  await clock.advance(200);
  assert.equal(s.places.length, n);
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

test("a window with no surface delivers anyway", async () => {
  const { pointer } = make({ surface: false });
  assert.equal(await pointer.moveTo({ ...base, to: { x: 1, y: 1 }, alive: () => true }), true);
});

test("the image is not awaited past 200 ms: the action goes on with no pointer", async () => {
  const { clock, s, pointer } = make();
  s.gate = new Promise(() => {});
  let done: boolean | undefined;
  void pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true }).then((v) => { done = v; });
  await flush(); await clock.advance(DRAW_MAX_MS - 32); assert.equal(done, undefined);
  await clock.advance(64);
  assert.equal(done, true);
  assert.ok(!s.log.includes("show") && s.places.length === 0);
});

test("a draw that fails delivers anyway", async () => {
  const { s, pointer } = make();
  s.fail = true;
  assert.equal(await pointer.moveTo({ ...base, to: { x: 440, y: 300 }, alive: () => true }), true);
  assert.ok(!s.log.includes("show"));
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

// ---- imageSurface -------------------------------------------------------------------------------------------------

class FakeView {
  image: unknown; bounds = { x: 0, y: 0, width: 0, height: 0 }; visible = true;
  setImage(i: unknown) { this.image = i; }
  setBounds(b: typeof this.bounds) { this.bounds = b; }
  setVisible(v: boolean) { this.visible = v; }
}

test("imageSurface puts the view's origin on the target, raises it when shown, and survives a destroyed window", async () => {
  const children: unknown[] = []; let destroyed = false; const tabs = { tab: true };
  stub.ImageView = FakeView;
  stub.screen = { getDisplayMatching: () => ({ scaleFactor: 2 }) };
  stub.nativeTheme = { shouldUseDarkColors: true };
  const win = {
    isDestroyed: () => destroyed, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), getContentBounds: () => ({ x: 0, y: 0, width: 801, height: 601 }),
    contentView: {
      addChildView: (v: unknown) => { if (destroyed) throw new Error("Object has been destroyed"); children.push(v); },
      removeChildView: (v: unknown) => { if (destroyed) throw new Error("Object has been destroyed"); const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); },
    },
  };
  children.push(tabs);
  const asked: unknown[][] = [];
  const surface = imageSurface({
    window: win as never,
    tag: async (kind, text, scale, dark) => { asked.push([kind, text, scale, dark]); return { getSize: () => ({ width: 90, height: 30 }) } as never; },
  });
  assert.deepEqual(surface.centre(), { x: 401, y: 301 });
  await surface.draw("arrow", "Fix");
  assert.deepEqual(asked, [["arrow", "Fix", 2, true]]);
  surface.place({ x: 120.4, y: 80.6 });
  const view = children.find((c) => c instanceof FakeView) as FakeView | undefined;
  surface.show(true);
  const shown = children.find((c) => c instanceof FakeView) as FakeView;
  assert.ok(view === undefined || view === shown);
  assert.equal(children[children.length - 1], shown, "above the tab");
  assert.deepEqual(shown.bounds, { x: 120, y: 81, width: 90, height: 30 });
  assert.equal(shown.visible, true);
  children.push(tabs);              // a tab swap puts a tab above it
  surface.show(true);
  assert.equal(children[children.length - 1], shown);
  surface.show(false); assert.equal(shown.visible, false);
  surface.dispose(); assert.ok(!children.includes(shown));
  destroyed = true;
  assert.doesNotThrow(() => { surface.place({ x: 1, y: 1 }); surface.show(true); surface.show(false); surface.raise(); surface.dispose(); surface.centre(); });
  await assert.doesNotReject(surface.draw("press", "Fix"));
});

// ---- the drawer ---------------------------------------------------------------------------------------------------

const BW = 20; const BH = 10;
function bitmap() { const b = Buffer.alloc(BW * BH * 4); for (let y = 2; y <= 5; y++) for (let x = 3; x <= 8; x++) { const i = (y * BW + x) * 4; b[i] = 1; b[i + 3] = 255; } return b; }

class FakeWin {
  static made: FakeWin[] = []; static active = 0; static maxActive = 0; static urls: string[] = []; static failCaptures = 0; static captures = 0;
  opts: Record<string, unknown>; destroyed = false; handlers = new Map<string, (...a: unknown[]) => void>();
  zoom: number[] = []; size: number[][] = [];
  webContents = {
    setWindowOpenHandler: (f: () => { action: string }) => { this.openHandler = f; },
    on: (n: string, f: (...a: unknown[]) => void) => { this.handlers.set(n, f); },
    setZoomFactor: (z: number) => { this.zoom.push(z); },
    loadURL: async (u: string) => { FakeWin.urls.push(u); FakeWin.active++; FakeWin.maxActive = Math.max(FakeWin.maxActive, FakeWin.active); await new Promise((r) => setTimeout(r, 2)); FakeWin.active--; },
    capturePage: async () => {
      FakeWin.captures++;
      if (FakeWin.failCaptures > 0) { FakeWin.failCaptures--; throw new Error("UnknownVizError"); }
      return { toBitmap: () => bitmap(), getSize: () => ({ width: BW, height: BH }) };
    },
  };
  openHandler: (() => { action: string }) | undefined;
  constructor(opts: Record<string, unknown>) { this.opts = opts; FakeWin.made.push(this); }
  setContentSize(w: number, h: number) { this.size.push([w, h]); }
  setTitle() {}
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}
function drawerEnv() {
  FakeWin.made = []; FakeWin.active = 0; FakeWin.maxActive = 0; FakeWin.urls = []; FakeWin.failCaptures = 0; FakeWin.captures = 0;
  stub.BrowserWindow = FakeWin;
  stub.nativeImage = { createFromBitmap: (buf: Buffer, o: { width: number; height: number; scaleFactor: number }) => ({ buf, ...o }) };
}
const doc = (u: string) => decodeURIComponent(u.slice("data:text/html;charset=utf-8,".length));

test("the drawer draws one at a time, caches, and makes the press image with the arrow", async () => {
  drawerEnv();
  const d = tagDrawer();
  assert.equal(FakeWin.made.length, 0, "no window until the first draw");
  const [a, b] = await Promise.all([d.draw("arrow", "One", 1, false), d.draw("caret", "One", 1, false)]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(FakeWin.made.length, 1);
  assert.equal(FakeWin.maxActive, 1);
  // arrow, caret, and the press the arrow started: three loads, each its own kind.
  assert.equal(FakeWin.urls.length, 3);
  assert.ok(FakeWin.urls.every((u) => u.startsWith("data:text/html;charset=utf-8,")));
  // The image is cropped to the drawing: 6 x 4 pixels, scale 1.
  assert.deepEqual([(a as never as { width: number }).width, (a as never as { height: number }).height, (a as never as { scaleFactor: number }).scaleFactor], [6, 4, 1]);
  assert.ok(b);
  const w = FakeWin.made[0].opts;
  const wp = w.webPreferences as Record<string, unknown>;
  assert.equal(w.show, false); assert.equal(w.transparent, true); assert.equal(w.frame, false); assert.equal(w.focusable, false);
  assert.equal(wp.sandbox, true); assert.equal(wp.javascript, false); assert.ok(!String(wp.partition).startsWith("persist:") && wp.partition); assert.equal(wp.preload, undefined);
  assert.deepEqual(FakeWin.made[0].openHandler!(), { action: "deny" });
  // The press image is already cached: asking for it loads nothing.
  const before = FakeWin.urls.length;
  await d.draw("press", "One", 1, false);
  await d.draw("arrow", "One", 1, false);
  assert.equal(FakeWin.urls.length, before);
  assert.equal(d.has("press", "One", 1, false), true);
  assert.equal(d.has("press", "Two", 1, false), false);
  // A scale of 2 zooms the page and doubles the window.
  await d.draw("arrow", "One", 2, false);
  assert.ok(FakeWin.made[0].zoom.includes(2));
  assert.ok(FakeWin.made[0].size.some(([sw, sh]) => sw % 2 === 0 && sh % 2 === 0));
  // One retry after a failed capture; two failures reject.
  FakeWin.failCaptures = 1; await d.draw("caret", "Retry", 1, false);
  FakeWin.failCaptures = 2; await assert.rejects(d.draw("caret", "Never", 1, false));
  assert.ok(doc(FakeWin.urls[0]).includes("One"));
  d.dispose(); assert.equal(FakeWin.made[0].destroyed, true);
});

test("the drawer keeps at most 32 images, dropping the oldest", async () => {
  drawerEnv();
  const d = tagDrawer();
  for (let i = 0; i < 33; i++) await d.draw("caret", `n${i}`, 1, false);
  assert.equal(d.has("caret", "n0", 1, false), false);
  assert.equal(d.has("caret", "n32", 1, false), true);
  d.dispose();
});
