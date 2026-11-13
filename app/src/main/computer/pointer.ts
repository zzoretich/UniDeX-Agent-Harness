// The pointer main draws above a browser tab (session-browser S18, §4.5): where the session's agent is about to click,
// hover or type, with its name beside it. Four parts: the travel maths (pure), the `Pointer` that moves a surface along
// it without ever keeping an action waiting on a drawing, `imageSurface` (an ImageView above the tab views of one
// window), and `tagDrawer`, one hidden window of main's own that makes the image (F9: JavaScript off, the name
// HTML-escaped, a transparent capture). Nothing here touches an Electron name until a function runs.

import { BrowserWindow, ImageView, nativeImage, nativeTheme, screen } from "electron";
import type { NativeImage } from "electron";
import type { Clock } from "./asks";
import { realClock } from "./asks";
import { cleanTitle } from "./title";

export const TRAVEL_MAX_MS = 250;
export const HIDE_AFTER_MS = 3000;
export const PULSE_MS = 150;
export const TAG_MAX = 24;
/** How long an action waits for the image to be drawn before it goes on with no pointer (the first draw of a name makes a
 *  page and captures it: about 140 ms; every later one is cached). */
export const DRAW_MAX_MS = 200;
const STEP_MS = 16;

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Box extends Point, Size {}
export type PointerKind = "arrow" | "press" | "caret";

/** 0 for the same point, else min(250, 80 + distance / 4). */
export function travelMs(from: Point, to: Point): number {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  return d === 0 ? 0 : Math.min(TRAVEL_MAX_MS, 80 + d / 4);
}

/** One point per 16 ms on a cubic ease-out curve (fast first, slowing in: 1 - (1 - u)^3); the last is exactly `to`. None
 *  for 0 ms: the caller then places `to` once. */
export function travelPath(from: Point, to: Point, ms: number): Point[] {
  const n = Math.ceil(ms / STEP_MS);
  const out: Point[] = [];
  for (let i = 1; i <= n; i++) {
    if (i === n) { out.push({ x: to.x, y: to.y }); break; }
    const e = 1 - (1 - i / n) ** 3;
    out.push({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
  }
  return out;
}

/** The string with every lone surrogate dropped: `encodeURIComponent` throws on one. */
const wellFormed = (s: string) => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");

/** The session's name as the tag shows it: scrubbed like a title, well formed, at most 24 characters counting the closing "…". */
export function tagText(name: string): string {
  const t = wellFormed(cleanTitle(name));
  if (t.length <= TAG_MAX) return t;
  let cut = t.slice(0, TAG_MAX - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);   // never half of a surrogate pair
  return `${cut.trimEnd()}…`;
}

/** What draws it: one per window that shows a browser. `draw` resolves with the image's size in DIPs once the image for a
 *  kind and a tag is ready (and is the view's image). `ready` says whether a draw of that kind and tag would be instant. */
export interface PointerSurface {
  draw(kind: PointerKind, tag: string): Promise<Size>;
  place(at: Point): void;
  show(on: boolean): void;
  /** The centre of the window's content area, in window coordinates: where the first move in a window starts. */
  centre(): Point;
  ready(kind: PointerKind, tag: string): boolean;
}

type Win = "main" | "pop";
interface OnScreen { window: Win; surface: PointerSurface; kind: "arrow" | "caret"; tag: string; at: Point }
type Waited<T> = { ok: true; v: T } | { ok: false; r: boolean };

export class Pointer {
  private readonly clock: Clock;
  /** Bumped by every move and every hide: a travel, a late draw or a pulse's end from an older one does nothing more. */
  private gen = 0;
  /** What is on screen now (null: nothing), and whether the move that put it there has finished drawing (a pulse needs it). */
  private on: OnScreen | null = null;
  private settled = false;
  private last: Partial<Record<Win, Point>> = {};
  private hideTimer: unknown = null;
  private pulseTimer: unknown = null;

  constructor(private o: { surface: (window: Win) => PointerSurface | null; clock?: Clock }) { this.clock = o.clock ?? realClock; }

  private sleep(ms: number): Promise<void> { return new Promise((r) => { this.clock.setTimeout(r, ms); }); }

  private arm(): void {
    if (this.hideTimer !== null) this.clock.clearTimeout(this.hideTimer);
    this.hideTimer = this.clock.setTimeout(() => this.hide(), HIDE_AFTER_MS);
  }

  /** Takes whatever is on screen off it and leaves no timer: every exit that shows nothing ends here. */
  private drop(): void {
    this.stopPulse();
    if (this.hideTimer !== null) { this.clock.clearTimeout(this.hideTimer); this.hideTimer = null; }
    this.settled = false;
    const c = this.on; this.on = null;
    if (c) c.surface.show(false);
  }

  /** Waits for `p` without keeping anything waiting: every 16 ms (or less, near the deadline) it asks whether this move is
   *  still the current one (then the answer is its own alive()), whether the Take over came (false), and whether `until` has
   *  come on the clock or the draw failed (true, with no pointer). */
  private async waitFor<T>(g: number, alive: () => boolean, p: Promise<T>, until: number): Promise<Waited<T>> {
    let st = 0; let v!: T;
    void p.then((x) => { v = x; st = 1; }, () => { st = 2; });
    const stop = (r: boolean, shows: boolean): Waited<T> => { if (shows && g === this.gen) this.drop(); return { ok: false, r }; };
    while (st === 0) {
      if (g !== this.gen) return stop(alive(), false);
      if (!alive()) return stop(false, true);
      const left = until - this.clock.now();
      if (left <= 0) return stop(true, true);
      await Promise.race([p.then(() => {}, () => {}), this.sleep(Math.min(STEP_MS, left))]);
    }
    if (g !== this.gen) return stop(alive(), false);
    if (!alive()) return stop(false, true);
    if (st === 2) return stop(true, true);
    return { ok: true, v };
  }

  /** Travels to `to` (window coordinates), inside `within` (the tab view's box: the view may take the person's clicks on its
   *  own box, and outside it lie the app's controls). False when `alive` went false on the way: the caller delivers nothing.
   *  It never waits long on a drawing: past DRAW_MAX_MS, or when the draw fails, it resolves true with no pointer for this
   *  action. A tag that would cross the box's right or bottom edge is dropped; a mark that still would, or a target outside
   *  the box, shows nothing. */
  async moveTo(o: { window: Win; to: Point; name: string; kind: "arrow" | "caret"; within: Box; alive: () => boolean }): Promise<boolean> {
    const g = ++this.gen;
    this.stopPulse();
    if (this.hideTimer !== null) { this.clock.clearTimeout(this.hideTimer); this.hideTimer = null; }   // this move owns the timer
    this.settled = false;
    const surface = this.o.surface(o.window);
    const { to, within } = o;
    if (!surface || to.x < within.x || to.y < within.y || to.x >= within.x + within.width || to.y >= within.y + within.height) {
      this.drop();
      return o.alive();
    }
    const fits = (s: Size) => to.x + s.width <= within.x + within.width && to.y + s.height <= within.y + within.height;
    const until = this.clock.now() + DRAW_MAX_MS;

    let tag = tagText(o.name);
    let r = await this.waitFor(g, o.alive, surface.draw(o.kind, tag), until);
    if (!r.ok) return r.r;
    if (!fits(r.v) && tag !== "") {
      tag = "";
      r = await this.waitFor(g, o.alive, surface.draw(o.kind, tag), until);
      if (!r.ok) return r.r;
    }
    if (!fits(r.v)) { this.drop(); return o.alive(); }

    if (this.on && this.on.surface !== surface) { this.on.surface.show(false); this.on = null; }
    const from = this.last[o.window] ?? surface.centre();
    const path = travelPath(from, to, travelMs(from, to));
    surface.place(from);
    surface.show(true);
    const on: OnScreen = { window: o.window, surface, kind: o.kind, tag, at: from };
    this.on = on;
    this.settled = true;
    this.arm();
    if (path.length === 0) { surface.place(to); this.last[o.window] = to; on.at = to; }
    for (let i = 0; i < path.length; i++) {
      if (g !== this.gen) return o.alive();
      if (!o.alive()) { this.drop(); return false; }
      surface.place(path[i]); this.last[o.window] = path[i]; on.at = path[i];
      if (i < path.length - 1) await this.sleep(STEP_MS);   // none after the last point: the move ends when it is placed
    }
    if (g !== this.gen) return o.alive();
    if (!o.alive()) { this.drop(); return false; }
    this.arm();
    return true;
  }

  /** What is on screen now (the e2e suite reads it through main). */
  state(): { shown: boolean; at: Point | null; tag: string; window: Win | null } {
    const c = this.on;
    return c ? { shown: true, at: { ...c.at }, tag: c.tag, window: c.window } : { shown: false, at: null, tag: "", window: null };
  }

  /** The press image for PULSE_MS, then the kind it had. Nothing unless the pointer is shown and its move has finished
   *  drawing; when the press image is not ready it changes nothing but the 3 s timer. */
  pulse(): void {
    const c = this.on;
    if (!c || !this.settled) return;
    this.arm();
    if (!c.surface.ready("press", c.tag)) return;
    this.stopPulse();
    const g = this.gen;
    void c.surface.draw("press", c.tag).then(() => {
      if (g !== this.gen) return;
      this.pulseTimer = this.clock.setTimeout(() => {
        this.pulseTimer = null;
        if (g !== this.gen) return;
        void c.surface.draw(c.kind, c.tag).catch(() => {});
      }, PULSE_MS);
    }, () => {});
  }

  private stopPulse(): void {
    if (this.pulseTimer !== null) { this.clock.clearTimeout(this.pulseTimer); this.pulseTimer = null; }
  }

  /** At once. A travel in flight ends at its next step, a late draw lands unseen. */
  hide(): void {
    this.gen++;
    this.drop();
  }
}

// ---- the image ------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// The app's accent per theme: Pulse's colour, `--udx-pulse` in hud/styles.css (#1e3a8a light, #00b3ff dark). Text on it is
// white (10.4:1) on the light one and near-black (8:1) on the dark one; the outline is the opposite tone, so it reads on any page.
const TONES = {
  light: { accent: "#1e3a8a", text: "#ffffff", outline: "#ffffff" },
  dark: { accent: "#00b3ff", text: "#0b0b0b", outline: "#0b0b0b" },
};

/** The whole document the hidden window loads. Pure. `zoom` is written as CSS on the document's root, so the drawing is that
 *  many times as large whatever display the window sits on. The mark's tip is the top-left pixel of the drawing (left 0, top 0),
 *  the tag a pill beside and below it; no script, no link, no image or font from anywhere. */
export function pointerHtml(kind: PointerKind, text: string, dark: boolean, zoom = 1): string {
  text = wellFormed(text);
  const c = dark ? TONES.dark : TONES.light;
  const press = kind === "press";
  const mark = kind === "caret"
    ? `<svg class="mark" width="8" height="24" viewBox="0 0 8 24"><path d="M0 0H8M4 0V24M0 24H8" fill="none" stroke="${c.outline}" stroke-width="4.5" stroke-linecap="round"/><path d="M0 0H8M4 0V24M0 24H8" fill="none" stroke="${c.accent}" stroke-width="2" stroke-linecap="round"/></svg>`
    : `<svg class="mark" width="14" height="22" viewBox="0 0 14 22"><path d="M0 0V17L4.2 13.2L7 19.5L9.4 18.4L6.7 12.3H12.4Z" fill="${press ? c.outline : c.accent}" stroke="${press ? c.accent : c.outline}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  const tagLeft = kind === "caret" ? 10 : 14;
  const tagTop = kind === "caret" ? 22 : 20;
  const tag = text ? `<div class="tag">${esc(text)}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>pointer</title><style>` +
    `html,body{margin:0;padding:0;background:transparent;overflow:hidden}` + (zoom === 1 ? "" : `html{zoom:${zoom}}`) +
    `.mark{position:absolute;left:0;top:0;display:block}` +
    `.tag{position:absolute;left:${tagLeft}px;top:${tagTop}px;box-sizing:border-box;max-width:200px;height:22px;padding:0 8px;overflow:hidden;white-space:nowrap;` +
    `font:600 12px/19px -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;color:${c.text};background:${c.accent};border:1.5px solid ${c.outline};border-radius:11px}` +
    `</style></head><body>${mark}${tag}</body></html>`;
}

/** The smallest box holding every pixel whose alpha is not 0 (a BGRA bitmap), or null when there is none. Pure. */
export function opaqueBox(bitmap: Uint8Array | Buffer, width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bitmap[(y * width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

const DRAWER_W = 260; const DRAWER_H = 60;
const CACHE_MAX = 32;
const RENDER_MAX_MS = 2000;

/** One reusable hidden window of main's own that makes the pointer's images. Made at the first draw (never at start), draws
 *  one at a time, caches by kind, text, scale and theme (32, the oldest dropped), and asking for an arrow also starts its
 *  press image in the background, so a pulse finds it ready. The image has the same size in DIPs on every display: the
 *  window's capture is as many pixels per DIP as the display it sits on, so the document is zoomed by wanted / that scale
 *  (CSS on its root, never the window's zoom) and the cropped bitmap is wrapped with the wanted scale. A render past
 *  `renderMs` rejects and the window is replaced. `dispose()` ends it for good. */
export function tagDrawer(o: { renderMs?: number } = {}): { draw(kind: PointerKind, text: string, scale: number, dark: boolean): Promise<NativeImage>; has(kind: PointerKind, text: string, scale: number, dark: boolean): boolean; dispose(): void } {
  const renderMs = o.renderMs ?? RENDER_MAX_MS;
  let win: BrowserWindow | null = null;
  let disposed = false;
  /** Pixels per DIP in the window's capture, once measured. */
  let capScale: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const cache = new Map<string, NativeImage>();
  const inflight = new Map<string, Promise<NativeImage>>();
  const key = (kind: PointerKind, text: string, scale: number, dark: boolean) => `${kind}\u0000${scale}\u0000${dark ? 1 : 0}\u0000${text}`;

  function window(): BrowserWindow {
    if (disposed) throw new Error("the pointer drawer is disposed");
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false, transparent: true, backgroundColor: "#00000000", frame: false, focusable: false, skipTaskbar: true, useContentSize: true,
      width: DRAWER_W, height: DRAWER_H, title: "pointer",
      // In memory (no "persist:"), no preload, no script: it draws a document main wrote and nothing else.
      webPreferences: { sandbox: true, javascript: false, partition: "pointer-drawer" },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    return win;
  }
  function destroyWindow(): void { if (win && !win.isDestroyed()) win.destroy(); win = null; }

  async function capture(w: BrowserWindow): Promise<NativeImage> {
    try { return await w.webContents.capturePage(); }
    catch { await new Promise((r) => setTimeout(r, 100)); return await w.webContents.capturePage(); }   // F9: once, after a pause
  }

  async function render(kind: PointerKind, text: string, scale: number, dark: boolean): Promise<NativeImage> {
    const w = window();
    let native = capScale ?? (() => { try { return screen.getDisplayMatching(w.getBounds()).scaleFactor; } catch { return 1; } })();
    for (let attempt = 0; ; attempt++) {
      const k = Number((scale / native).toFixed(4));
      w.setContentSize(Math.round(DRAWER_W * k), Math.round(DRAWER_H * k));
      await w.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pointerHtml(kind, text, dark, k))}`);
      if (disposed) throw new Error("the pointer drawer is disposed");
      const shot = await capture(w);
      const { width, height } = shot.getSize();
      const measured = width / w.getContentSize()[0];
      // The screen's answer was wrong for the display this window sits on: the capture says what it is, draw once more.
      if (attempt === 0 && Math.abs(measured - native) > 0.01) { native = measured; capScale = measured; continue; }
      capScale = measured;
      const bitmap = shot.toBitmap();
      const box = opaqueBox(bitmap, width, height);
      if (!box) throw new Error("the pointer image came out empty");
      const out = Buffer.alloc(box.width * box.height * 4);
      for (let y = 0; y < box.height; y++) bitmap.copy(out, y * box.width * 4, ((box.y + y) * width + box.x) * 4, ((box.y + y) * width + box.x + box.width) * 4);
      return nativeImage.createFromBitmap(out, { width: box.width, height: box.height, scaleFactor: scale });
    }
  }

  /** One render with its time limit: past it the window is destroyed (the next draw makes a fresh one) and the queue goes on. */
  function limited(kind: PointerKind, text: string, scale: number, dark: boolean): Promise<NativeImage> {
    if (disposed) return Promise.reject(new Error("the pointer drawer is disposed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { destroyWindow(); reject(new Error("the pointer image took too long")); }, renderMs);
      render(kind, text, scale, dark).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  }

  function draw(kind: PointerKind, text: string, scale: number, dark: boolean): Promise<NativeImage> {
    if (disposed) return Promise.reject(new Error("the pointer drawer is disposed"));
    const k = key(kind, text, scale, dark);
    let p = inflight.get(k);
    const hit = cache.get(k);
    if (!hit && !p) {
      p = tail.then(() => limited(kind, text, scale, dark)).then((img) => {
        if (!disposed) {
          cache.set(k, img);
          if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
        }
        return img;
      }).finally(() => { inflight.delete(k); });
      tail = p.catch(() => {});
      inflight.set(k, p);
    }
    if (kind === "arrow") {
      // The press image follows the arrow, also when the arrow is cached and the press failed before.
      const pk = key("press", text, scale, dark);
      if (!cache.has(pk) && !inflight.has(pk)) draw("press", text, scale, dark).catch(() => {});
    }
    return hit ? Promise.resolve(hit) : p!;
  }

  return {
    draw,
    has: (kind, text, scale, dark) => cache.has(key(kind, text, scale, dark)),
    dispose() { disposed = true; cache.clear(); inflight.clear(); destroyWindow(); },
  };
}

// ---- the view -------------------------------------------------------------------------------------------------------

/** The pointer as an ImageView above the tab views of one window (F8). The image's tip is its top-left corner, so `place`
 *  puts the view's origin on the target and the view covers nothing but its drawing. A destroyed window makes every member
 *  a no-op, and so does `dispose()`, for good. `raise` makes the view the last child again (after a tab swap puts a tab above
 *  it); `show(true)` raises too. */
export function imageSurface(o: {
  window: BrowserWindow;
  tag: (kind: PointerKind, text: string, scale: number, dark: boolean) => Promise<NativeImage>;
  /** For `ready`: whether `tag` would answer from its cache (the drawer's `has`). */
  has: (kind: PointerKind, text: string, scale: number, dark: boolean) => boolean;
}): PointerSurface & { raise(): void; dispose(): void } {
  const view = new ImageView();
  view.setVisible(false);
  let size: Size = { width: 0, height: 0 };
  let at: Point = { x: 0, y: 0 };
  let seq = 0;
  let disposed = false;
  const gone = () => disposed || o.window.isDestroyed();
  const apply = () => { try { view.setBounds({ x: Math.round(at.x), y: Math.round(at.y), width: size.width, height: size.height }); } catch { /* the window went */ } };
  const scale = () => { try { return screen.getDisplayMatching(o.window.getBounds()).scaleFactor; } catch { return 1; } };
  const dark = () => { try { return nativeTheme.shouldUseDarkColors; } catch { return false; } };
  const raise = () => {
    if (gone()) return;
    try { o.window.contentView.removeChildView(view); } catch { /* not a child yet */ }
    try { o.window.contentView.addChildView(view); } catch { /* the window went */ }
  };
  return {
    async draw(kind, tag) {
      if (gone()) return { width: 0, height: 0 };
      const mine = ++seq;
      const image = await o.tag(kind, tag, scale(), dark());
      const got = image.getSize();
      // Only the latest asked-for image lands: a pulse's press image and the kind's own image race.
      if (mine !== seq || gone()) return got;
      view.setImage(image);
      size = got;
      apply();
      return got;
    },
    place(p) { at = p; if (!gone()) apply(); },
    show(on) {
      if (gone()) return;
      try { view.setVisible(on); } catch { return; }
      if (on) raise();
    },
    centre() {
      if (gone()) return { x: 0, y: 0 };
      const b = o.window.getContentBounds();
      return { x: Math.round(b.width / 2), y: Math.round(b.height / 2) };
    },
    ready(kind, tag) { return o.has(kind, tag, scale(), dark()); },
    raise,
    dispose() {
      if (disposed) return;
      if (!o.window.isDestroyed()) { try { o.window.contentView.removeChildView(view); } catch { /* not a child */ } }
      disposed = true;
    },
  };
}
