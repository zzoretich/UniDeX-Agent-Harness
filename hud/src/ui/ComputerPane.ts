// ComputerPane — the Computer pane on the Code and Sessions pages (agent-computer D4, D5, D27, D29, D32, D35; release 1,
// the Browser only). Docked right of the terminal or the reader: resizable, collapsible, and popped out to its own window.
// Top to bottom: the header (the Browser tab, the place, pop-out, collapse); the browser's tabs; the address bar; the ask
// cards and, under them, the view's rectangle, which main fills with the native browser view (so a card is never under
// it); the driving bar; the activity log on the Code page (D35: a terminal has no transcript to write to); and a footer
// naming the acting session, with help that says which tools act without these guards (D29).
//
// The rectangle goes to main on every layout change, and null while the pane is collapsed, its page is not in front, a
// modal or the tour is over the page, the edge is being dragged (the native view would sit over all of them), or main has
// not yet answered for a newly followed place (its last computer would show for a moment). While the Computer surface is
// off the pane is only its collapsed strip, saying so (ruling R54). The pane follows the selected terminal or thread
// (D32), collapsed or not; only the pane on the page in front selects (ruling R51), and one store (data/computerStore.ts)
// holds every computer's state for both pages' panes, the rail badges and the row dots.

import { setIcon } from "obsidian";
import type { HostComputer, HostComputerHolder, HostComputerRect, HostComputerState, HostComputerTab } from "../host";
import { START_PAGE, searchUrl } from "../data/computerStart";
import { storeFor, type ComputerPage, type ComputerStore } from "../data/computerStore";
import { COMPUTER_PANE_WIDTH, paneMax, paneSizeOf, paneSizeWidth, type ComputerPaneSettings, type PaneSize } from "../settingsDefaults";
import { bindColumnResize } from "./columnResize";
import { ARM_MS, arm, renderAsk, siteHost } from "./ComputerAsk";

export type { ComputerPaneSettings } from "../settingsDefaults";

export interface ComputerPaneOptions {
  host: HostComputer;
  page: ComputerPage;
  /** How the pane starts: its saved width and collapse (settingsDefaults.computerPaneStart). */
  settings: () => ComputerPaneSettings;
  /** Saves a changed width or collapse. */
  save: (s: ComputerPaneSettings) => void;
  /** The session's own column beside the pane (the terminal's, the reader): the pane may grow until it is 360 px wide
   *  (session-browser S11). Null while it is not on the page. */
  column: () => HTMLElement | null;
  /** The clock a new card's wait runs on (M7); the window's own by default (the tests pass a fake). */
  clock?: { now(): number; setTimeout(fn: () => void, ms: number): unknown };
}

const OFF_LINE = "The Computer pane is off.";
const POPPED_LINE = "Popped out to its own window. Closing that window brings the browser back here.";
const NONE_LINE: Record<ComputerPage, string> = {
  code: "Select a terminal to see the computer of its place.",
  chat: "Open a workspace session to see its computer.",
};
const HELP_TEXT = "Agents use this browser through the Computer tools: it asks you before anything irreversible, and Take over "
  + "stops them at once. Other browser and computer-use tools (Codex's built-in ones, Claude in Chrome, Playwright, "
  + "computer-use servers) act without these guards.";
const SIZES: ReadonlyArray<{ size: PaneSize; label: string; title: string }> = [
  { size: "side", label: "Side", title: "The usual width" },
  { size: "half", label: "Half", title: "Half the window" },
  { size: "wide", label: "Wide", title: "As wide as it can be" },
];
/** Under this row width the pane is already as wide as it may be, so Half and Wide have nothing to give. */
const SIZES_MIN_ROW = 680;
/** The row's width while it cannot be read (not on the page yet): wide enough that nothing is cut. */
const ROW_UNKNOWN = 10_000;
/** How many activity lines the Code page shows; main keeps the rest. */
const LOG_SHOWN = 50;

/** What the address bar opens for what was typed, trimmed: a scheme followed by `//` or by no spaces is kept (main
 *  refuses anything but http and https and says why); the Mac's own servers (localhost, 127.0.0.1, [::1]) get http; an
 *  address (a host with a dot or a port, or an IPv6 address, and no spaces before its path) gets https; and anything else
 *  (words, a question, one word with no dot) is a search on the start page `start` (data/computerStart.ts searchUrl). */
export function addressUrl(typed: string, start: string = START_PAGE): string {
  const t = typed.trim();
  if (!t) return "";
  const hostPort = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(t);
  if (!hostPort && /^[a-z][a-z0-9+.-]*:(?:\/\/|\S*$)/i.test(t)) return t;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(t)) return `http://${t}`;
  const host = t.split(/[/?#]/, 1)[0];
  const address = hostPort || (!/\s/.test(host) && (/[^.]\.[^.]/.test(host) || /^\[[0-9a-f:.]+\](?::\d+)?$/i.test(host)));
  return address ? `https://${t}` : searchUrl(t, start);
}

/** The driving bar for a holder (D5, D31): violet while an agent drives, with Take over; grey while you do, with Hand
 *  back; and while nobody holds the wheel, Take over too (M6), so a person about to sign in can hold it first and no
 *  agent's next action lands in between. */
export function drivingText(holder: HostComputerHolder): { kind: "agent" | "user" | "idle"; text: string; button: string } {
  if (!holder) return { kind: "idle", text: "No one is driving", button: "Take over" };
  if (holder.kind === "agent") return { kind: "agent", text: `${holder.label} is driving`, button: "Take over" };
  return { kind: "user", text: "You're driving", button: "Hand back" };
}

/** The hosts a site mark cannot change: main's SiteMarks treats them as marked always (computer/sites.ts LOCAL_HOSTS). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOCAL_LINE = "Local addresses always act freely";

/** A tab with nothing of its own on it yet: no page, about:blank, or the bare start page, as + opens it. */
function blankTab(url: string | undefined, start: string): boolean {
  return !url || url === "about:blank" || url === start;
}

function tabTitle(t: HostComputerTab, start: string): string {
  if (blankTab(t.url, start)) return "New tab";
  return t.title || siteHost(t.url);
}

/** An http or https page's origin, which a site mark names; null for anything else (a blank tab). */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function sameRect(a: HostComputerRect | null, b: HostComputerRect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** What covers the page when it is a child of body: a modal, or the tour's overlay for the whole of a tour. */
const COVERS = ["modal-container", "aos-tour"];

/** Whether something covers the page: the native view would sit over it. */
function coveredIn(body: HTMLElement | null): boolean {
  if (!body) return false;
  return Array.from(body.children).some((el) => COVERS.some((c) => el.classList.contains(c)));
}

interface PaneEls {
  root: HTMLElement;
  handle: HTMLElement;
  place: HTMLElement;
  count: HTMLElement;
  sizes: Record<PaneSize, HTMLButtonElement>;
  pop: HTMLButtonElement;
  collapse: HTMLButtonElement;
  tabs: HTMLElement;
  input: HTMLInputElement;
  trust: HTMLButtonElement;
  navMsg: HTMLElement;
  asks: HTMLElement;
  view: HTMLElement;
  drive: HTMLElement;
  log: HTMLElement | null;
  acting: HTMLElement;
}

export class ComputerPane {
  private readonly store: ComputerStore;
  private el: PaneEls | null = null;
  /** What the page follows: undefined until it first says (follow), then a place or none. */
  private sel: { place: string; label: string } | null | undefined = undefined;
  private state: HostComputerState | null = null;
  /** The Computer surface is off (the host says so), or select answered null: main refused the place (R53). */
  private off: boolean;
  /** The page is in front; a hidden page's pane never selects and shows nothing (R51). */
  private visible = true;
  private destroyed = false;
  /** The user's collapse, as saved (or opened by a reveal); while off the pane draws collapsed without changing it. */
  private collapsed: boolean;
  private width: number;
  private covered = false;
  private dragging = false;
  /** Each select; an answer to an older one is dropped. */
  private seq = 0;
  /** A select for a newly followed place has not answered: main still shows the last place, so no rectangle yet. */
  private switching = false;
  /** The rectangle last sent to main; undefined before the first, so the first is always sent. */
  private sent: HostComputerRect | null | undefined = undefined;
  /** What each part last drew, so a state that changes nothing there leaves it (and its focus) alone. */
  private drawn = { tabs: "", asks: "", drive: "", log: "", icon: "" };
  private navError: string | null = null;
  private cleanups: Array<() => void> = [];
  /** M7: when each pending ask's card was drawn where it is now, and its place in the list, by ask id. */
  private readonly shownAt = new Map<string, { at: number; index: number }>();
  private readonly clock: { now(): number; setTimeout(fn: () => void, ms: number): unknown };
  /** The start page main opens for +, whose search gets words typed in the address bar (HostComputer.startPage). */
  private readonly start: string;

  constructor(private readonly o: ComputerPaneOptions) {
    this.store = storeFor(o.host);
    this.clock = o.clock ?? { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms) };
    this.start = o.host.startPage ?? START_PAGE;
    const s = o.settings();
    this.width = s.width;
    this.collapsed = s.collapsed;
    this.off = this.surfaceOff();
  }

  mount(parent: HTMLElement): void {
    if (this.el || this.destroyed) return;
    const page = this.o.page;
    const root = parent.createEl("aside", { cls: "aos-cp", attr: { "aria-label": "Computer", "data-page": page } });
    // Esc in the pane is the pane's: it never reaches the page around it (Sessions stops a running turn on Esc).
    root.addEventListener("keydown", (e) => { if (e.key === "Escape") e.stopPropagation(); });
    const handle = root.createDiv({
      cls: "aos-cp-handle",
      attr: {
        role: "separator", "aria-orientation": "vertical", "aria-label": "Resize the Computer pane", tabindex: "0",
        "aria-valuemin": String(COMPUTER_PANE_WIDTH.min),
      },
    });

    const head = root.createDiv({ cls: "aos-cp-head" });
    const mode = head.createSpan({ cls: "aos-cp-mode is-active", attr: { title: "Browser" } });
    const modeIcon = mode.createSpan({ cls: "aos-cp-modeicon" });
    setIcon(modeIcon, "globe");
    mode.createSpan({ cls: "aos-cp-modelabel", text: "Browser" });
    const place = head.createSpan({ cls: "aos-cp-place" });
    const count = head.createSpan({ cls: "aos-cp-count" });
    const group = head.createDiv({ cls: "aos-cp-sizes", attr: { role: "group", "aria-label": "Pane size", "data-tour": "computer-size" } });
    const sizes = {} as Record<PaneSize, HTMLButtonElement>;
    for (const z of SIZES) {
      const b = group.createEl("button", { cls: "aos-cp-size", text: z.label, attr: { type: "button", "data-size": z.size, title: z.title, "aria-pressed": "false" } });
      b.addEventListener("click", () => this.setSize(z.size));
      sizes[z.size] = b;
    }
    const pop = head.createEl("button", { cls: "aos-cp-icon aos-cp-popout", attr: { type: "button" } });
    setIcon(pop, "picture-in-picture-2");
    pop.addEventListener("click", () => {
      const st = this.live();
      if (st && !st.poppedOut) this.o.host.popOut();
    });
    const collapse = head.createEl("button", { cls: "aos-cp-icon aos-cp-collapse", attr: { type: "button" } });
    collapse.addEventListener("click", () => { if (!this.off) this.setCollapsed(!this.collapsed); });

    const body = root.createDiv({ cls: "aos-cp-body" });
    const tabs = body.createDiv({ cls: "aos-cp-tabs", attr: { role: "tablist", "aria-label": "Browser tabs" } });
    const form = body.createEl("form", { cls: "aos-cp-address" });
    form.createSpan({ cls: "aos-cp-web", text: "web", attr: { title: "A web page, in the Computer's browser" } });
    const input = form.createEl("input", {
      cls: "aos-cp-url", attr: { type: "text", "aria-label": "Address or search", placeholder: "Search DuckDuckGo or type an address", spellcheck: "false", autocomplete: "off" },
    });
    const trust = form.createEl("button", { cls: "aos-cp-trust", attr: { type: "button" } });
    form.addEventListener("submit", (e) => { e.preventDefault(); void this.go(input.value); });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      input.value = this.address();
      input.blur();
    });
    trust.addEventListener("click", () => this.toggleTrust());
    const navMsg = body.createDiv({ cls: "aos-cp-navmsg", attr: { role: "status" } });
    const stage = body.createDiv({ cls: "aos-cp-stage" });
    const asks = stage.createDiv({ cls: "aos-cp-asks", attr: { "aria-live": "polite" } });
    const view = stage.createDiv({ cls: "aos-cp-view", attr: { "data-tour": "computer-view" } });
    const drive = body.createDiv({ cls: "aos-cp-drive", attr: { role: "status" } });
    const log = page === "code" ? body.createDiv({ cls: "aos-cp-log", attr: { role: "log", "aria-label": "Computer activity" } }) : null;
    const foot = body.createDiv({ cls: "aos-cp-foot" });
    const acting = foot.createSpan({ cls: "aos-cp-acting" });
    const helpId = `aos-cp-help-${page}`;
    const helpBtn = foot.createEl("button", { cls: "aos-cp-helpbtn", text: "Help", attr: { type: "button", "aria-expanded": "false", "aria-controls": helpId } });
    const help = foot.createDiv({ cls: "aos-cp-help", text: HELP_TEXT, attr: { id: helpId } });
    helpBtn.addEventListener("click", () => {
      const open = helpBtn.getAttribute("aria-expanded") !== "true";
      helpBtn.setAttr("aria-expanded", String(open));
      help.toggleClass("is-open", open);
    });
    this.el = { root, handle, place, count, sizes, pop, collapse, tabs, input, trust, navMsg, asks, view, drive, log, acting };

    // The rectangle moves with the view's own size, the page around the pane (a drawer opening shifts it), the window,
    // and a modal opening over it. The same two watchers keep the width inside the row: the row's size is what they see.
    const doc = parent.ownerDocument;
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (RO) {
      const ro = new RO(() => { this.applyWidth(); this.push(); });
      ro.observe(view);
      ro.observe(parent);
      this.cleanups.push(() => ro.disconnect());
    }
    const win = doc.defaultView;
    if (win) {
      const onResize = (): void => { this.applyWidth(); this.push(); };
      win.addEventListener("resize", onResize);
      this.cleanups.push(() => win.removeEventListener("resize", onResize));
    }
    const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    if (MO && doc.body) {
      const mo = new MO(() => { this.covered = coveredIn(doc.body); this.push(); });
      mo.observe(doc.body, { childList: true });
      this.covered = coveredIn(doc.body);
      this.cleanups.push(() => mo.disconnect());
    }
    this.cleanups.push(bindColumnResize(handle, {
      min: COMPUTER_PANE_WIDTH.min,
      max: () => paneMax(this.row()),
      reset: () => this.setSize("side"),
      get: () => this.shownWidth(),
      set: (w) => { this.width = w; this.applyWidth(); },
      start: () => { this.dragging = true; this.push(); },
      done: (w) => {
        this.dragging = false;
        this.width = w;
        this.applyWidth();
        this.o.save({ width: w, collapsed: this.collapsed });
        this.push();
      },
    }));
    this.cleanups.push(this.store.subscribe(() => this.onStore()));
    this.cleanups.push(this.store.onReveal(() => this.takeReveal()));
    this.store.noteShown(page);
    this.render();
  }

  /** Shows the computer of the selected terminal's place, or the thread's workspace (D32); null shows none. */
  follow(sel: { place: string; label: string } | null): void {
    if (this.destroyed) return;
    const next = sel ? { place: sel.place, label: sel.label } : null;
    const same = this.sel !== undefined && (this.sel?.place ?? null) === (next?.place ?? null);
    this.sel = next;
    // M5: a page's own ask on this place can be routed to this page.
    this.store.noteFollowed(this.o.page, next?.place ?? null);
    if (same) { this.render(); return; }
    this.off = this.surfaceOff();
    this.navError = null;
    this.state = next ? this.store.state(next.place) : null;
    this.render();
    this.select();
  }

  /** How the pane shows now, for the Code top bar's Computer button (code-chat §4): open, collapsed, or off (the surface). */
  paneState(): "open" | "collapsed" | "off" { return this.off ? "off" : this.collapsed ? "collapsed" : "open"; }

  /** The Code top bar's Computer button: opens or collapses the pane as its own collapse button does; nothing while off. */
  toggle(): void { if (!this.off && !this.destroyed) this.setCollapsed(!this.collapsed); }

  /** Its page went behind another rail tab: the view goes, and the pane selects nothing until it is mounted again. */
  hide(): void {
    if (this.destroyed || !this.visible) return;
    this.visible = false;
    this.markColumn(false);
    this.seq++;
    this.switching = false;
    this.push();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.seq++;
    if (this.sent) this.o.host.show(null);
    this.sent = null;
    this.destroyed = true;
    this.markColumn(false);
    this.store.setOnScreen(this.o.page, null);
    for (const fn of this.cleanups.splice(0)) {
      try { fn(); } catch { /* already gone */ }
    }
    this.el?.root.detach();
    this.el = null;
  }

  // ── main ──

  /** The followed computer's state, or null while it is off or unknown. */
  private live(): HostComputerState | null { return this.off ? null : this.state; }

  /** The Computer surface is off for this run (R54): with nothing followed too, select's null cannot say so. A host
   *  that does not say counts as off (fail closed). */
  private surfaceOff(): boolean { return this.o.host.enabled !== true; }

  private select(): void {
    if (!this.visible || this.destroyed || this.sel === undefined) return;
    // Main answers nothing while the surface is off: the pane stays its collapsed strip and asks it nothing.
    if (this.surfaceOff()) { this.off = true; this.render(); this.push(); return; }
    const seq = ++this.seq;
    const place = this.sel?.place ?? null;
    this.switching = true;
    this.store.noteSelected(place);
    this.push();
    this.o.host.select(place).then((st) => {
      if (seq !== this.seq || this.destroyed || !this.visible) return;
      this.switching = false;
      this.off = place !== null && !st;
      this.state = st;
      if (st) this.store.put(st);
      this.render();
      this.push();
      this.takeReveal();
    }, () => {
      if (seq !== this.seq || this.destroyed) return;
      this.switching = false;
      this.off = place !== null;
      this.state = null;
      this.render();
      this.push();
    });
  }

  /** A state from main, for any computer: this pane redraws when it is the followed one's. */
  private onStore(): void {
    if (this.destroyed || !this.sel) return;
    const s = this.store.state(this.sel.place);
    if (!s || s === this.state) return;
    // Off, yet main sends this computer's state: the surface came on since. Selecting it again shows it.
    if (this.off) { this.select(); return; }
    this.state = s;
    this.render();
    this.push();
    this.takeReveal();
  }

  /** The rectangle main should paint the view in, or null. */
  private bounds(): HostComputerRect | null {
    if (!this.visible || this.destroyed || this.collapsed || this.covered || this.dragging || this.switching || !this.sel || !this.live()) return null;
    const v = this.el?.view;
    if (!v || !v.isConnected) return null;
    const r = v.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }

  /** Sends the rectangle when it changed, and tells the store what this page shows on screen (for the row dots). */
  private push(): void {
    if (this.destroyed) return;
    const b = this.bounds();
    if (this.sent === undefined || !sameRect(b, this.sent)) {
      this.sent = b;
      this.o.host.show(b);
    }
    // A popped-out computer is on screen too: the store counts main's selected place while popped out (as main does).
    this.store.setOnScreen(this.o.page, b !== null && this.sel ? this.sel.place : null);
  }

  /** A notification's reveal (D27): the pane showing that ask opens, and its card comes into view. */
  private takeReveal(): void {
    const id = this.store.revealing();
    const st = this.live();
    if (!id || !this.visible || !this.el || !st?.asks.some((a) => a.id === id)) return;
    this.store.takeReveal(id);
    // Opened for this ask only: the saved collapse stays as the user left it.
    if (this.collapsed) { this.collapsed = false; this.render(); this.push(); }
    else this.render();
    const card = this.el.asks.querySelectorAll<HTMLElement>(".aos-cp-ask");
    Array.from(card).find((c) => c.getAttribute("data-ask") === id)?.scrollIntoView({ block: "nearest" });
  }

  // ── actions ──

  private setCollapsed(on: boolean): void {
    this.collapsed = on;
    this.o.save({ width: this.width, collapsed: on });
    this.render();
    this.push();
  }

  /** A size button (or a double click on the bar: Side): the width is saved, and the pane opens if it was collapsed. */
  private setSize(size: PaneSize): void {
    if (!this.el) return;
    this.width = paneSizeWidth(size, this.row());
    this.collapsed = false;
    this.o.save({ width: this.width, collapsed: false });
    this.render();
    this.push();
  }

  private async go(typed: string): Promise<void> {
    const url = addressUrl(typed, this.start);
    if (!url || !this.live()) return;
    const r = await this.o.host.navigate(url);
    if (this.destroyed) return;
    this.navError = r.ok ? null : r.error || "That address did not open.";
    if (r.ok) this.el?.input.blur();
    this.render();
  }

  /** The address bar's site switch (D39): let agents act freely on the active tab's site, or make them ask first again. */
  private toggleTrust(): void {
    const st = this.live();
    const origin = originOf(st?.tabs.find((t) => t.active)?.url);
    if (st && origin && !LOCAL_HOSTS.has(new URL(origin).hostname)) this.o.host.mark(origin, !st.marked);
  }

  /** The active tab's address, or nothing for a blank tab (about:blank or the bare start page). */
  private address(): string {
    const url = this.live()?.tabs.find((t) => t.active)?.url ?? "";
    return blankTab(url, this.start) ? "" : url;
  }

  // ── render ──

  /** The row the pane sits in: the session's column and the pane together (they fill it; the window sets it). */
  private row(): number {
    const n = (this.o.column()?.offsetWidth ?? 0) + (this.el?.root.offsetWidth ?? 0);
    return n > 0 ? n : ROW_UNKNOWN;
  }

  /** The width drawn: the saved one, held to what the row allows now. The saved width is not rewritten. */
  private shownWidth(): number { return Math.min(this.width, paneMax(this.row())); }

  private applyWidth(): void {
    const e = this.el;
    if (!e) return;
    const row = this.row();
    const w = Math.min(this.width, paneMax(row));
    e.root.style.width = this.drawnCollapsed() ? "" : `${w}px`;
    e.handle.setAttr("aria-valuenow", String(w));
    e.handle.setAttr("aria-valuemax", String(paneMax(row)));
    const on = paneSizeOf(w, row);
    for (const z of SIZES) {
      const b = e.sizes[z.size];
      b.setAttr("aria-pressed", String(on === z.size));
      b.disabled = z.size !== "side" && row < SIZES_MIN_ROW;
    }
    this.markColumn(this.visible && !this.drawnCollapsed() && this.width !== COMPUTER_PANE_WIDTH.default);
  }

  /** Once the user has sized the pane (and it is drawn open) the session's column may narrow to 360 px; at the usual
   *  width it keeps its own floor (session-browser S11). Never left on a column without a pane. */
  private markColumn(on: boolean): void {
    this.o.column()?.toggleClass("is-narrowable", on);
  }

  /** Collapsed as drawn: the user's collapse, or the surface being off (R54), which is never saved. */
  private drawnCollapsed(): boolean { return this.collapsed || this.off; }

  private render(): void {
    const e = this.el;
    if (!e) return;
    const st = this.live();
    const sel = this.sel ?? null;
    const collapsed = this.drawnCollapsed();
    e.root.toggleClass("is-collapsed", collapsed);
    e.root.toggleClass("is-off", this.off);
    e.root.setAttr("aria-label", this.off ? OFF_LINE : "Computer");
    e.root.setAttr("title", this.off ? OFF_LINE : null);
    e.root.toggleClass("is-popped", !!st?.poppedOut);
    this.applyWidth();
    e.place.setText(sel?.label ?? "");
    e.place.setAttr("title", sel ? `The computer of ${sel.label}` : null);
    const waiting = st?.asks.length ?? 0;
    e.count.setText(waiting ? String(waiting) : "");
    e.count.setAttr("title", waiting ? `${waiting} waiting for your answer` : null);

    const popped = !!st?.poppedOut;
    e.pop.disabled = !st || popped;
    const popLabel = popped ? "Popped out: closing that window brings it back" : "Pop out to its own window";
    e.pop.setAttr("aria-label", popLabel);
    e.pop.setAttr("title", popLabel);
    const collapseLabel = this.off ? OFF_LINE : collapsed ? "Expand the Computer pane" : "Collapse the Computer pane";
    e.collapse.disabled = this.off;
    e.collapse.setAttr("aria-expanded", String(!collapsed));
    e.collapse.setAttr("aria-label", collapseLabel);
    e.collapse.setAttr("title", collapseLabel);
    const icon = collapsed ? "open" : "close";
    if (this.drawn.icon !== icon) {
      this.drawn.icon = icon;
      if (collapsed) setIcon(e.collapse, "panel-right-open");
      else setIcon(e.collapse, "panel-right-close");
    }

    this.renderTabs(st);
    e.input.disabled = !st;
    if (e.input.ownerDocument.activeElement !== e.input) e.input.value = this.address();
    this.renderTrust(st);
    e.navMsg.setText(this.navError ?? "");

    const line = this.off ? OFF_LINE : !sel ? NONE_LINE[this.o.page] : popped ? POPPED_LINE : "";
    e.view.empty();
    if (line) e.view.createDiv({ cls: "aos-cp-viewline", text: line });
    e.view.toggleClass("has-line", !!line);

    this.renderAsks(st);
    this.renderDrive(st);
    this.renderLog(st);
    const h = st?.holder ?? null;
    e.acting.setText(h?.kind === "agent" ? `Acting: ${h.label}` : h?.kind === "user" ? "Acting: you" : "No session is acting");
  }

  private renderTabs(st: HostComputerState | null): void {
    const el = this.el?.tabs;
    const sig = st ? JSON.stringify(st.tabs) : "-";
    if (!el || sig === this.drawn.tabs) return;
    this.drawn.tabs = sig;
    el.empty();
    if (!st) return;
    for (const t of st.tabs) {
      const name = tabTitle(t, this.start);
      const item = el.createDiv({
        cls: `aos-cp-tab${t.active ? " is-active" : ""}`,
        attr: { role: "tab", "aria-selected": String(t.active), tabindex: "0", title: t.openedBy ? `${name} · opened by ${t.openedBy}` : name },
      });
      item.createSpan({ cls: "aos-cp-tabtitle", text: name });
      const close = item.createEl("button", { cls: "aos-cp-tabclose", text: "×", attr: { type: "button", "aria-label": `Close ${name}` } });
      close.addEventListener("click", (e) => { e.stopPropagation(); this.o.host.tab({ kind: "close", index: t.index }); });
      item.addEventListener("click", () => this.o.host.tab({ kind: "select", index: t.index }));
      item.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        this.o.host.tab({ kind: "select", index: t.index });
      });
    }
    const plus = el.createEl("button", { cls: "aos-cp-tabnew", attr: { type: "button", "aria-label": "New tab", title: "New tab" } });
    setIcon(plus, "plus");
    plus.addEventListener("click", () => this.o.host.tab({ kind: "new" }));
  }

  private renderTrust(st: HostComputerState | null): void {
    const b = this.el?.trust;
    if (!b) return;
    const origin = originOf(st?.tabs.find((t) => t.active)?.url);
    b.toggleClass("is-hidden", !origin);
    b.disabled = !origin;
    if (!origin) return;
    const host = siteHost(origin);
    // M3: main marks local addresses always, so the switch could change nothing there: it is disabled and says why.
    const local = LOCAL_HOSTS.has(new URL(origin).hostname);
    const marked = local || st?.marked === true;
    b.disabled = local;
    b.setText(marked ? `Acts freely on ${host}` : `Asks first on ${host}`);
    b.setAttr("aria-pressed", String(marked));
    b.setAttr("aria-label", local ? `Acts freely on ${host}. ${LOCAL_LINE}` : null);
    b.setAttr("title", local ? LOCAL_LINE : marked
      ? `Agents act freely on ${host}; only irreversible actions ask. Click to make them ask first again.`
      : `Agents ask before any click or typing on ${host}. Click to let them act freely here.`);
  }

  private renderAsks(st: HostComputerState | null): void {
    const el = this.el?.asks;
    const sig = st ? st.asks.map((a) => a.id).join(",") : "";
    if (!el || sig === this.drawn.asks) return;
    this.drawn.asks = sig;
    el.empty();
    // M7: each card waits ARM_MS from when it was drawn where it is, kept by ask id, so a redraw that leaves it in place
    // (another ask arriving below) never restarts its wait. A card that moves (R69: an earlier card left, so it slid
    // into that card's spot) waits again, so the second click of a double-click aimed at the leaving card is no answer.
    const now = this.clock.now();
    const ids = new Set((st?.asks ?? []).map((a) => a.id));
    for (const id of [...this.shownAt.keys()]) if (!ids.has(id)) this.shownAt.delete(id);
    for (const [index, a] of (st?.asks ?? []).entries()) {
      const seen = this.shownAt.get(a.id);
      if (!seen || seen.index !== index) this.shownAt.set(a.id, { at: now, index });
      const armedAt = (this.shownAt.get(a.id)?.at ?? now) + ARM_MS;
      const card = renderAsk(el, a, (answer) => this.o.host.answer(a.id, answer), { armedAt, now: () => this.clock.now() });
      if (armedAt > now) this.clock.setTimeout(() => arm(card), armedAt - now);
    }
  }

  private renderDrive(st: HostComputerState | null): void {
    const el = this.el?.drive;
    if (!el) return;
    const holder = st?.holder ?? null;
    // Only for a computer shown: nothing followed (or the pane off) has no wheel to take.
    const d = st ? drivingText(holder) : null;
    el.toggleClass("is-agent", d?.kind === "agent");
    el.toggleClass("is-user", d?.kind === "user");
    el.toggleClass("is-idle", !d || d.kind === "idle");
    const back = holder?.kind === "user" && holder.resume ? `Hand the wheel back to ${holder.resume.label}` : "";
    const sig = d ? `${d.kind}|${d.text}|${back}` : "";
    if (sig === this.drawn.drive) return;
    this.drawn.drive = sig;
    el.empty();
    if (!d) return;
    el.createSpan({ cls: "aos-cp-drivetext", text: d.text });
    const b = el.createEl("button", { cls: "aos-cp-drivebtn", text: d.button, attr: { type: "button", ...(back ? { title: back } : {}) } });
    b.addEventListener("click", () => {
      if (d.kind === "user") this.o.host.handBack();
      else this.o.host.takeOver();
    });
  }

  /** The Code page's activity log (D35): what agents and you did on this computer, newest last. */
  private renderLog(st: HostComputerState | null): void {
    const el = this.el?.log;
    if (!el) return;
    const lines = st?.log ?? [];
    const end = lines[lines.length - 1];
    const sig = `${lines.length}|${end ? `${end.at}|${end.text}` : ""}`;
    if (sig === this.drawn.log) return;
    this.drawn.log = sig;
    el.empty();
    el.createDiv({ cls: "aos-cp-loghead", text: "Activity" });
    if (!lines.length) { el.createDiv({ cls: "aos-cp-logempty", text: "What agents and you do here shows up here." }); return; }
    for (const l of lines.slice(-LOG_SHOWN)) {
      const row = el.createDiv({ cls: "aos-cp-logline" });
      row.createSpan({ cls: "aos-cp-logtime", text: clock(l.at) });
      row.createSpan({ cls: "aos-cp-logwho", text: l.session });
      row.createSpan({ cls: "aos-cp-logtext", text: l.text });
    }
    el.scrollTop = el.scrollHeight;
  }
}
