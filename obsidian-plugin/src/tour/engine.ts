// The tour engine (tour C4, C7, C8): a queue of steps. For each: skip it when its `when` fails; route to its tab through
// WorkbenchView.open() (the driver); wait for the control (a MutationObserver, 2 s); spotlight it; then wait for Next,
// for the real click on the control ("click" steps), or for ← →. A step whose control never appears is skipped and
// logged, never a dead end. Esc skips the chapter. Nothing runs while a modal holds the keyboard: the spotlight steps
// aside until it closes, and a step never opens over one.
import { fillText, holds, type TourContext } from "./predicates";
import { TourOverlay } from "./overlay";
import { stepRef, type TourChapter, type TourStep } from "./steps";

/** How long a step waits for its control after the route settles. */
export const ANCHOR_WAIT_MS = 2_000;

/** What the engine needs from the Workbench. */
export interface TourDriver {
  doc: Document;
  /** Shows what a step names (its tab, Brain mode or Spaces pane); with no tab, makes sure the Workbench is showing.
   *  False when it cannot be shown (a tab that is off on this Mac). */
  route(step: TourStep): Promise<boolean>;
  context(): TourContext;
}

export interface TourItem { chapter: TourChapter; step: TourStep }

/** How a run ended: its last step was done, it was skipped (Esc, Skip tour), or something else stopped it. */
export type TourEnd = "done" | "skipped" | "stopped";

export interface RunOptions {
  /** The chapter the run counts for (null for a What's new "Show me"). */
  chapter: string | null;
  onEnd?(how: TourEnd): void;
}

export interface ProbeResult { ref: string; status: "found" | "gated" | "unrouted" | "missing" }

const MODAL = ".modal-container";

/** Whether `el` takes typing, so ← → belong to it. */
function typing(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  return h.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest(".xterm");
}

export class TourEngine {
  /** Steps skipped this session, and why (also on the console): what e2e and a curious user read. */
  readonly log: string[] = [];
  private items: TourItem[] = [];
  private index = -1;
  private opts: RunOptions | null = null;
  private overlay: TourOverlay | null = null;
  /** Bumped by every move: a step still routing when the user moves on stops where it is. */
  private seq = 0;
  private modalObserver: MutationObserver | null = null;
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);
  private readonly onClick = (e: MouseEvent): void => this.click(e);

  constructor(private readonly driver: TourDriver) {}

  running(): boolean { return this.opts !== null; }

  /** The step on screen now, if any. */
  current(): { chapter: string; step: string; ref: string } | null {
    const it = this.items[this.index];
    return this.opts && it ? { chapter: it.chapter.id, step: it.step.id, ref: stepRef(it.chapter.id, it.step.id) } : null;
  }

  /** Runs a list of steps (a chapter, or a What's new entry's). A run already going is stopped first. */
  run(items: TourItem[], opts: RunOptions): void {
    if (this.opts) this.end("stopped");
    const ctx = this.driver.context();
    this.items = items.filter((it) => holds(it.chapter.when, ctx));
    this.opts = opts;
    if (!this.items.length) { this.end("done"); return; }
    const doc = this.driver.doc;
    this.overlay = new TourOverlay(doc, { next: () => this.next(), back: () => this.back(), skip: () => this.skip() });
    doc.addEventListener("keydown", this.onKey, true);
    doc.addEventListener("click", this.onClick, true);
    this.modalObserver = new MutationObserver(() => this.onModals());
    this.modalObserver.observe(doc.body, { childList: true });
    void this.go(0, 1);
  }

  next(): void { if (this.opts) void this.go(this.index + 1, 1); }
  back(): void { if (this.opts && this.index > 0) void this.go(this.index - 1, -1); }
  skip(): void { if (this.opts) this.end(this.index >= this.items.length - 1 ? "done" : "skipped"); }
  stop(): void { if (this.opts) this.end("stopped"); }

  /** Routes each step of a chapter and waits for its control, drawing nothing: what e2e checks every anchor with. */
  async probe(items: TourItem[], waitMs = ANCHOR_WAIT_MS): Promise<ProbeResult[]> {
    const ctx = this.driver.context();
    const out: ProbeResult[] = [];
    for (const { chapter, step } of items) {
      const ref = stepRef(chapter.id, step.id);
      if (!holds(chapter.when, ctx) || !holds(step.when, ctx)) { out.push({ ref, status: "gated" }); continue; }
      if (!(await this.driver.route(step))) { out.push({ ref, status: "unrouted" }); continue; }
      out.push({ ref, status: (await this.waitFor(step.anchor, waitMs, () => true)) ? "found" : "missing" });
    }
    return out;
  }

  private modalOpen(): boolean { return !!this.driver.doc.querySelector(MODAL); }

  private onModals(): void {
    if (!this.overlay) return;
    const open = this.modalOpen();
    if (open !== this.overlay.hidden) this.overlay.setHidden(open);
  }

  /** Waits until no modal is open; false when the run moved on meanwhile. */
  private async noModal(token: number): Promise<boolean> {
    if (!this.modalOpen()) return true;
    this.overlay?.setHidden(true);
    await new Promise<void>((resolve) => {
      const mo = new MutationObserver(() => { if (!this.modalOpen() || token !== this.seq) { mo.disconnect(); resolve(); } });
      mo.observe(this.driver.doc.body, { childList: true });
    });
    if (token !== this.seq) return false;
    this.overlay?.setHidden(false);
    return true;
  }

  private async go(i: number, dir: 1 | -1): Promise<void> {
    const token = ++this.seq;
    for (;;) {
      if (!this.opts || token !== this.seq) return;
      if (i >= this.items.length) { this.end("done"); return; }
      if (i < 0) { i = 0; dir = 1; }
      const { chapter, step } = this.items[i];
      const ref = stepRef(chapter.id, step.id);
      if (!holds(step.when, this.driver.context())) { i += dir; continue; }
      if (!(await this.noModal(token))) return;
      this.overlay?.waiting();
      const routed = await this.driver.route(step);
      if (token !== this.seq || !this.opts) return;
      if (!routed) { this.note(`${ref}: its tab cannot be shown here`); i += dir; continue; }
      const el = await this.waitFor(step.anchor, ANCHOR_WAIT_MS, () => token === this.seq);
      if (token !== this.seq || !this.opts) return;
      if (!el) { this.note(`${ref}: no ${step.anchor} after ${ANCHOR_WAIT_MS / 1000} s`); i += dir; continue; }
      if (!(await this.noModal(token))) return;
      this.index = i;
      const reduce = this.driver.doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
      const ctx = this.driver.context();
      const shown = this.items.map((it) => holds(it.step.when, ctx));
      const count = shown.filter(Boolean).length;
      const at = shown.slice(0, i).filter(Boolean).length;
      const anchor = step.anchor;
      this.overlay?.show(() => this.find(anchor) ?? (el.isConnected ? el : null), {
        ref, chapter: chapter.title, index: at, count,
        title: fillText(step.title, ctx), body: fillText(step.body, ctx), advance: step.advance,
        first: at === 0, last: at === count - 1,
      });
      return;
    }
  }

  private note(line: string): void {
    this.log.push(line);
    console.warn(`[tour] skipped ${line}`);
  }

  /** The first element the selector matches that is laid out on screen. */
  private find(selector: string): HTMLElement | null {
    let all: NodeListOf<Element>;
    try { all = this.driver.doc.querySelectorAll(selector); } catch { return null; }
    for (const el of Array.from(all)) {
      if (!(el instanceof HTMLElement) || el.closest("[data-tour-overlay]")) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    return null;
  }

  private waitFor(selector: string, ms: number, live: () => boolean): Promise<HTMLElement | null> {
    const now = this.find(selector);
    if (now) return Promise.resolve(now);
    const doc = this.driver.doc;
    return new Promise((resolve) => {
      let done = false;
      const finish = (el: HTMLElement | null): void => {
        if (done) return;
        done = true;
        mo.disconnect();
        window.clearTimeout(timer);
        resolve(el);
      };
      const mo = new MutationObserver(() => {
        if (!live()) { finish(null); return; }
        const el = this.find(selector);
        if (el) finish(el);
      });
      mo.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
      const timer = window.setTimeout(() => finish(this.find(selector)), ms);
    });
  }

  private key(e: KeyboardEvent): void {
    if (!this.opts || this.modalOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.skip(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    const inPopover = !!target?.closest(".aos-tour-pop");
    if (!inPopover && typing(target)) return;
    if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); this.next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); this.back(); }
  }

  /** A "click" step goes on once the click on its control has done what it does. */
  private click(e: MouseEvent): void {
    const it = this.items[this.index];
    if (!this.opts || !it || it.step.advance !== "click" || this.overlay?.hidden) return;
    const target = e.target instanceof Element ? e.target : null;
    let hit = false;
    try { hit = !!target?.closest(it.step.anchor) && !target.closest("[data-tour-overlay]"); } catch { hit = false; }
    if (!hit) return;
    const at = this.index;
    window.setTimeout(() => { if (this.opts && this.index === at) this.next(); }, 0);
  }

  private end(how: TourEnd): void {
    const opts = this.opts;
    this.opts = null;
    this.seq++;
    const doc = this.driver.doc;
    doc.removeEventListener("keydown", this.onKey, true);
    doc.removeEventListener("click", this.onClick, true);
    this.modalObserver?.disconnect();
    this.modalObserver = null;
    this.overlay?.destroy();
    this.overlay = null;
    this.items = [];
    this.index = -1;
    opts?.onEnd?.(how);
  }
}
