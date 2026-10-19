// The spotlight (tour C7): four shades around the control, so the cutout stays clickable and only it (C1: "where it
// says click, it waits for your click"), a ring on its edge, and a popover placed where there is room, measured again
// on resize, on any scroll and when the page redraws. It is not a compat Modal: it never takes the keyboard from one,
// and it hides while one is open (engine.ts). Focus moves to the popover, which is a live region. The text is built
// with DOM calls from plain text; nothing here parses HTML.
import { boldRuns } from "./predicates";

export interface PopoverContent {
  /** "<chapter>.<step>", on the popover for tests and for the log. */
  ref: string;
  chapter: string;
  index: number;
  count: number;
  title: string;
  body: string;
  advance: "click" | "next";
  first: boolean;
  last: boolean;
}

export interface OverlayActions {
  next(): void;
  back(): void;
  skip(): void;
}

/** The room kept between the control and the ring, and between the popover and the screen's edge. */
const PAD = 6;
const GAP = 12;
const EDGE = 12;

type Side = "top" | "right" | "bottom" | "left";
const SIDES: Side[] = ["top", "right", "bottom", "left"];

let seq = 0;

export class TourOverlay {
  readonly root: HTMLElement;
  readonly pop: HTMLElement;
  private shades: Record<Side, HTMLElement>;
  private ring: HTMLElement;
  private anchor: () => HTMLElement | null = () => null;
  private frame = 0;
  private readonly onScroll = (): void => this.schedule();
  private readonly onResize = (): void => this.schedule();
  private readonly observer: MutationObserver;
  private resize: ResizeObserver | null = null;
  private observed: HTMLElement | null = null;

  constructor(private readonly doc: Document, private readonly act: OverlayActions) {
    const id = ++seq;
    this.root = doc.body.createDiv({ cls: "aos-tour", attr: { "data-tour-overlay": "" } });
    this.shades = {} as Record<Side, HTMLElement>;
    for (const side of SIDES) this.shades[side] = this.root.createDiv({ cls: "aos-tour-shade", attr: { "data-side": side, "aria-hidden": "true" } });
    this.ring = this.root.createDiv({ cls: "aos-tour-ring", attr: { "aria-hidden": "true" } });
    this.pop = this.root.createDiv({
      cls: "aos-tour-pop",
      attr: { role: "dialog", "aria-modal": "false", "aria-live": "polite", tabindex: "-1", "aria-labelledby": `aos-tour-title-${id}`, "aria-describedby": `aos-tour-body-${id}` },
    });
    this.pop.dataset.titleId = `aos-tour-title-${id}`;
    this.pop.dataset.bodyId = `aos-tour-body-${id}`;
    const win = doc.defaultView;
    win?.addEventListener("resize", this.onResize);
    doc.addEventListener("scroll", this.onScroll, true);
    // A redraw can move the control without a scroll or a resize (a tab refreshing its list).
    this.observer = new MutationObserver((records) => {
      if (records.every((r) => this.root.contains(r.target))) return;
      this.schedule();
    });
    this.observer.observe(doc.body, { subtree: true, childList: true });
  }

  /** Shows a step: the control `anchor()` returns (asked again at each measure, as a redraw may replace it). */
  show(anchor: () => HTMLElement | null, c: PopoverContent): void {
    this.anchor = anchor;
    this.root.removeClass("is-hidden");
    this.root.toggleClass("is-waiting", false);
    this.renderPopover(c);
    this.measure();
    this.pop.focus({ preventScroll: true });
  }

  /** Between steps (routing, waiting for the control): the page dims with no cutout and no popover. */
  waiting(): void {
    this.anchor = () => null;
    this.root.removeClass("is-hidden");
    this.root.toggleClass("is-waiting", true);
    this.measure();
  }

  /** While a modal holds the keyboard the spotlight steps aside entirely. */
  setHidden(hidden: boolean): void {
    this.root.toggleClass("is-hidden", hidden);
    if (!hidden) { this.measure(); if (!this.root.hasClass("is-waiting")) this.pop.focus({ preventScroll: true }); }
  }

  get hidden(): boolean { return this.root.hasClass("is-hidden"); }

  destroy(): void {
    if (this.frame) this.doc.defaultView?.cancelAnimationFrame(this.frame);
    this.doc.defaultView?.removeEventListener("resize", this.onResize);
    this.doc.removeEventListener("scroll", this.onScroll, true);
    this.observer.disconnect();
    this.resize?.disconnect();
    this.root.remove();
  }

  private schedule(): void {
    const win = this.doc.defaultView;
    if (!win || this.frame) return;
    this.frame = win.requestAnimationFrame(() => { this.frame = 0; this.measure(); });
  }

  private renderPopover(c: PopoverContent): void {
    const p = this.pop;
    p.empty();
    p.dataset.step = c.ref;
    p.dataset.advance = c.advance;
    p.createDiv({ cls: "aos-tour-meta", text: `${c.chapter} · ${c.index + 1} of ${c.count}` });
    p.createDiv({ cls: "aos-tour-title", text: c.title, attr: { id: p.dataset.titleId ?? "" } });
    const body = p.createDiv({ cls: "aos-tour-body", attr: { id: p.dataset.bodyId ?? "" } });
    for (const run of boldRuns(c.body)) {
      if (run.bold) body.createEl("strong", { text: run.text });
      else body.appendText(run.text);
    }
    if (c.advance === "click") p.createDiv({ cls: "aos-tour-hint", text: "Click the highlighted control to go on, or press →." });
    const foot = p.createDiv({ cls: "aos-tour-foot" });
    const skip = foot.createEl("button", { cls: "aos-tour-skip", text: c.last ? "Close" : "Skip tour", attr: { type: "button", title: "Esc" } });
    skip.addEventListener("click", () => this.act.skip());
    foot.createDiv({ cls: "aos-tour-spacer" });
    const back = foot.createEl("button", { cls: "aos-tour-back", text: "Back", attr: { type: "button", title: "←" } });
    back.disabled = c.first;
    back.addEventListener("click", () => this.act.back());
    if (c.advance === "next" || c.last) {
      const next = foot.createEl("button", { cls: "aos-tour-next mod-cta", text: c.last ? "Done" : "Next", attr: { type: "button", title: "→" } });
      next.addEventListener("click", () => this.act.next());
    }
  }

  /** Lays the shades, the ring and the popover out around the control as it is now. */
  measure(): void {
    const win = this.doc.defaultView;
    if (!win) return;
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    let el = this.anchor();
    if (el && !el.isConnected) el = null;
    this.watch(el);
    const r = el?.getBoundingClientRect();
    const box = r && r.width > 0 && r.height > 0
      ? { left: Math.max(0, r.left - PAD), top: Math.max(0, r.top - PAD), right: Math.min(vw, r.right + PAD), bottom: Math.min(vh, r.bottom + PAD) }
      : null;
    const set = (e: HTMLElement, x: number, y: number, w: number, h: number): void => {
      e.style.left = `${Math.round(x)}px`;
      e.style.top = `${Math.round(y)}px`;
      e.style.width = `${Math.max(0, Math.round(w))}px`;
      e.style.height = `${Math.max(0, Math.round(h))}px`;
    };
    if (!box) {
      // No control (between steps, or it went away): one shade over everything.
      set(this.shades.top, 0, 0, vw, vh);
      for (const s of ["right", "bottom", "left"] as Side[]) set(this.shades[s], 0, 0, 0, 0);
      this.ring.addClass("is-off");
      this.placePopover(null, vw, vh);
      return;
    }
    set(this.shades.top, 0, 0, vw, box.top);
    set(this.shades.bottom, 0, box.bottom, vw, vh - box.bottom);
    set(this.shades.left, 0, box.top, box.left, box.bottom - box.top);
    set(this.shades.right, box.right, box.top, vw - box.right, box.bottom - box.top);
    this.ring.removeClass("is-off");
    set(this.ring, box.left, box.top, box.right - box.left, box.bottom - box.top);
    this.placePopover(box, vw, vh);
  }

  /** Re-measures when the control itself changes size. */
  private watch(el: HTMLElement | null): void {
    if (el === this.observed) return;
    this.resize?.disconnect();
    this.observed = el;
    const RO = this.doc.defaultView?.ResizeObserver;
    if (el && RO) { this.resize = new RO(() => this.schedule()); this.resize.observe(el); }
  }

  /** Beside the control on the side with the most room that fits it; inside the screen's corner when none does. */
  private placePopover(box: { left: number; top: number; right: number; bottom: number } | null, vw: number, vh: number): void {
    const p = this.pop;
    const w = p.offsetWidth || 320;
    const h = p.offsetHeight || 160;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
    let x: number;
    let y: number;
    let side = "center";
    if (!box) {
      x = (vw - w) / 2;
      y = (vh - h) / 2;
    } else {
      const room = { right: vw - box.right - GAP - EDGE, bottom: vh - box.bottom - GAP - EDGE, left: box.left - GAP - EDGE, top: box.top - GAP - EDGE };
      const fits: Array<[keyof typeof room, number]> = [
        ["right", room.right >= w ? room.right : -1],
        ["bottom", room.bottom >= h ? room.bottom : -1],
        ["left", room.left >= w ? room.left : -1],
        ["top", room.top >= h ? room.top : -1],
      ];
      const best = fits.filter(([, v]) => v >= 0).sort((a, b) => b[1] - a[1])[0];
      side = best ? best[0] : "inside";
      if (side === "right") { x = box.right + GAP; y = clamp(box.top, EDGE, vh - h - EDGE); }
      else if (side === "left") { x = box.left - GAP - w; y = clamp(box.top, EDGE, vh - h - EDGE); }
      else if (side === "bottom") { y = box.bottom + GAP; x = clamp(box.left, EDGE, vw - w - EDGE); }
      else if (side === "top") { y = box.top - GAP - h; x = clamp(box.left, EDGE, vw - w - EDGE); }
      else { x = clamp(box.right - w - GAP, EDGE, vw - w - EDGE); y = clamp(box.bottom - h - GAP, EDGE, vh - h - EDGE); }
    }
    p.dataset.side = side;
    p.style.left = `${Math.round(x)}px`;
    p.style.top = `${Math.round(y)}px`;
  }
}
