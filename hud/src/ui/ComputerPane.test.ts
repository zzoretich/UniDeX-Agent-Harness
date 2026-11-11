// The Computer pane (agent-computer D4, D5, D27, D29, D32, D35; rulings R51–R53). It draws with Obsidian's DOM helpers and
// setIcon: under node:test "obsidian" resolves to a stub and the page is a small fake DOM with layout boxes, so the pane
// can be driven as the Code and Sessions pages drive it, against a fake HostComputer standing in for main.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type { HostComputer, HostComputerAnswer, HostComputerAsk, HostComputerEvent, HostComputerRect, HostComputerState, HostResult } from "../host";
import type { ComputerPaneSettings } from "../settingsDefaults";
import type * as Pane from "./ComputerPane";
import type * as Ask from "./ComputerAsk";
import type * as Store from "../data/computerStore";

const STUB = "obsidian-stub-computer-pane";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { setIcon: () => {} } } as unknown as NodeJS.Module;

// ── a fake DOM: elements, classes, attributes, the selectors the pane uses, events, focus and layout boxes ──

interface FakeDoc {
  activeElement: FakeEl | null;
  body: FakeEl;
  defaultView: FakeWindow;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
}
interface FakeWindow { innerWidth: number; listeners: Map<string, Set<(e: unknown) => void>>; addEventListener(t: string, fn: (e: unknown) => void): void; removeEventListener(t: string, fn: (e: unknown) => void): void }
type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
class FakeEl {
  kids: Array<FakeEl | string> = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  listeners = new Map<string, Array<(e: unknown) => void>>();
  style: Record<string, string> = {};
  value = "";
  disabled = false;
  /** The laid-out width: a column's or the pane's own (the test sets them; an aside gets FakeEl.asideWidth). */
  offsetWidth = 0;
  static asideWidth = 0;
  scrollTop = 0;
  scrollHeight = 0;
  scrolled = 0;
  rect = { left: 0, top: 0, width: 0, height: 0 };
  constructor(public tagName: string, public ownerDocument: FakeDoc) {}
  get classList() { return { contains: (c: string) => this.classes.has(c) }; }
  get children(): FakeEl[] { return this.kids.filter((c): c is FakeEl => typeof c !== "string"); }
  get isConnected(): boolean { let e: FakeEl | null = this; while (e.parent) e = e.parent; return e === this.ownerDocument.body; }
  createEl(tag: string, o: Opts = {}): FakeEl {
    const el = new FakeEl(tag.toUpperCase(), this.ownerDocument);
    for (const c of (o.cls ?? "").split(/\s+/).filter(Boolean)) el.classes.add(c);
    if (o.text !== undefined) el.kids.push(o.text);
    for (const [k, v] of Object.entries(o.attr ?? {})) el.attrs.set(k, String(v));
    if (tag === "aside") el.offsetWidth = FakeEl.asideWidth;
    el.parent = this;
    this.kids.push(el);
    return el;
  }
  createDiv(o: Opts = {}): FakeEl { return this.createEl("div", o); }
  createSpan(o: Opts = {}): FakeEl { return this.createEl("span", o); }
  empty(): void { this.kids = []; }
  detach(): void { if (this.parent) this.parent.kids = this.parent.kids.filter((x) => x !== this); this.parent = null; }
  remove(): void { this.detach(); }
  setText(t: string): void { this.kids = [t]; }
  appendText(t: string): void { this.kids.push(t); }
  setAttr(k: string, v: string | number | boolean | null): void { if (v === null || v === false) this.attrs.delete(k); else this.attrs.set(k, String(v)); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  toggleClass(c: string, on: boolean): void { if (on) this.classes.add(c); else this.classes.delete(c); }
  addClass(...c: string[]): void { for (const x of c) this.classes.add(x); }
  removeClass(...c: string[]): void { for (const x of c) this.classes.delete(x); }
  addEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  fire(type: string, e: Record<string, unknown> = {}): void { for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() {}, stopPropagation() {}, button: 0, ...e }); }
  click(): void { this.fire("click"); }
  focus(): void { this.ownerDocument.activeElement = this; }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  scrollIntoView(): void { this.scrolled++; }
  getBoundingClientRect() { return { ...this.rect, x: this.rect.left, y: this.rect.top, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
  get textContent(): string { return this.kids.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  matches(sel: string): boolean {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel.trim());
    if (m) return this.attrs.has(m[1]) && (m[2] === undefined || this.attrs.get(m[1]) === m[2]);
    if (sel.startsWith(".")) return sel.slice(1).split(".").every((c) => this.classes.has(c));
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel: string): FakeEl[] {
    const steps = sel.trim().split(/\s+(?![^[]*\])/);
    let from: FakeEl[] = [this];
    for (const s of steps) {
      const out: FakeEl[] = [];
      const walk = (e: FakeEl): void => { for (const c of e.children) { if (c.matches(s) && !out.includes(c)) out.push(c); walk(c); } };
      for (const f of from) walk(f);
      from = out;
    }
    return from;
  }
  querySelector(sel: string): FakeEl | null { return this.querySelectorAll(sel)[0] ?? null; }
}

class FakeTargetMap {
  listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(t: string, fn: (e: unknown) => void): void { this.listeners.set(t, (this.listeners.get(t) ?? new Set()).add(fn)); }
  removeEventListener(t: string, fn: (e: unknown) => void): void { this.listeners.get(t)?.delete(fn); }
  fire(t: string): void { for (const fn of [...(this.listeners.get(t) ?? [])]) fn({}); }
}

function makeDoc(innerWidth = 1400): FakeDoc & { win: FakeWindow & FakeTargetMap } {
  const win = Object.assign(new FakeTargetMap(), { innerWidth }) as FakeWindow & FakeTargetMap;
  const events = new FakeTargetMap();
  const doc = {
    activeElement: null, defaultView: win, win,
    addEventListener: (t: string, fn: (e: unknown) => void) => events.addEventListener(t, fn),
    removeEventListener: (t: string, fn: (e: unknown) => void) => events.removeEventListener(t, fn),
  } as unknown as FakeDoc & { win: FakeWindow & FakeTargetMap };
  doc.body = new FakeEl("BODY", doc);
  return doc;
}

// Layout and DOM watchers: the test fires them, as a relayout or a modal opening would.
const resizeObservers: Array<{ cb: () => void; targets: unknown[]; live: boolean }> = [];
const mutationObservers: Array<{ cb: () => void; live: boolean }> = [];
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver = class { private o: { cb: () => void; targets: unknown[]; live: boolean }; constructor(cb: () => void) { this.o = { cb, targets: [], live: true }; resizeObservers.push(this.o); } observe(t: unknown) { this.o.targets.push(t); } disconnect() { this.o.live = false; } };
g.MutationObserver = class { private o: { cb: () => void; live: boolean }; constructor(cb: () => void) { this.o = { cb, live: true }; mutationObservers.push(this.o); } observe() {} disconnect() { this.o.live = false; } };
const relayout = (): void => { for (const o of resizeObservers) if (o.live) o.cb(); };
const domChanged = (): void => { for (const o of mutationObservers) if (o.live) o.cb(); };

const { ComputerPane, addressUrl, drivingText } = require("./ComputerPane") as typeof Pane;
const { alwaysLabel } = require("./ComputerAsk") as typeof Ask;
const { storeFor } = require("../data/computerStore") as typeof Store;

// ── a fake main ──

function fakeComputer(answer: (place: string) => HostComputerState | null) {
  const f = {
    selects: [] as Array<string | null>,
    shows: [] as Array<HostComputerRect | null>,
    navs: [] as string[],
    tabs: [] as unknown[],
    answers: [] as Array<[string, HostComputerAnswer]>,
    marks: [] as Array<[string, boolean]>,
    takeOvers: 0, handBacks: 0, popOuts: 0,
    navResult: { ok: true, data: null } as HostResult<null>,
    subs: [] as Array<(ev: HostComputerEvent) => void>,
    emit(ev: HostComputerEvent): void { for (const cb of [...f.subs]) cb(ev); },
  };
  const host: HostComputer = {
    enabled: true,
    select: async (place) => { f.selects.push(place); return place === null ? null : answer(place); },
    show: (b) => { f.shows.push(b); },
    navigate: async (url) => { f.navs.push(url); return f.navResult; },
    tab: (op) => { f.tabs.push(op); },
    takeOver: () => { f.takeOvers++; },
    handBack: () => { f.handBacks++; },
    answer: (id, a) => { f.answers.push([id, a]); },
    mark: (origin, on) => { f.marks.push([origin, on]); },
    popOut: () => { f.popOuts++; },
    onEvent: (cb) => { f.subs.push(cb); return () => { f.subs.splice(f.subs.indexOf(cb), 1); }; },
  };
  return { host, f };
}

const ask = (id: string, why: string, o: Partial<HostComputerAsk> = {}): HostComputerAsk => ({
  id, at: 1000, computer: "ws:harbor-map", session: "code:t5", sessionLabel: "Claude Code in harbor-map", why,
  title: "Click: Continue on example.com?", detail: "The button “Continue”. Page: https://example.com/checkout", site: "https://example.com", always: true, ...o,
});
const state = (place: string, o: Partial<HostComputerState> = {}): HostComputerState => ({
  place, tabs: [{ index: 0, url: "https://example.com/checkout", title: "Checkout", openedBy: "Claude Code in harbor-map", active: true }],
  holder: null, asks: [], log: [], marked: false, poppedOut: false, ...o,
});
const RECT = { x: 900, y: 120, width: 440, height: 500 };
const last = <T>(a: T[]): T | undefined => a[a.length - 1];
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const buttons = (el: FakeEl): string[] => el.querySelectorAll("button").map((b) => b.textContent);

/** A clock the test moves by hand (M7: a card's buttons wake 500 ms after it is drawn). */
function fakeClock() {
  const c = {
    t: 1_000_000,
    timers: [] as Array<{ at: number; fn: () => void }>,
    now: () => c.t,
    setTimeout: (fn: () => void, ms: number): unknown => { const e = { at: c.t + ms, fn }; c.timers.push(e); return e; },
    advance(ms: number): void {
      const end = c.t + ms;
      for (;;) {
        const due = c.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        c.timers.splice(c.timers.indexOf(due), 1);
        c.t = due.at;
        due.fn();
      }
      c.t = end;
    },
  };
  return c;
}

function setup(o: { page?: "code" | "chat"; answer?: (place: string) => HostComputerState | null; settings?: ComputerPaneSettings; enabled?: boolean | "absent"; startPage?: string; column?: number; pane?: number } = {}) {
  const doc = makeDoc();
  const parent = doc.body.createDiv({ cls: "aos-term-deck" });
  // The row is the session's column and the pane together: 760 + 440 = 1200 unless a test says otherwise.
  const column = parent.createDiv({ cls: "aos-term-main" });
  column.offsetWidth = o.column ?? 760;
  FakeEl.asideWidth = o.pane ?? 440;
  const fake = fakeComputer(o.answer ?? ((place) => state(place)));
  const { f } = fake;
  const { enabled: _on, ...unsaid } = fake.host;
  const shown: HostComputer = o.enabled === undefined ? fake.host : o.enabled === "absent" ? unsaid : { ...fake.host, enabled: o.enabled };
  const host: HostComputer = o.startPage === undefined ? shown : { ...shown, startPage: o.startPage };
  const saved: ComputerPaneSettings[] = [];
  const clock = fakeClock();
  const pane = new ComputerPane({ host, page: o.page ?? "code", settings: () => o.settings ?? { width: 440, collapsed: false }, save: (s) => saved.push(s), clock,
    column: () => column as unknown as HTMLElement });
  pane.mount(parent as unknown as HTMLElement);
  const root = parent.querySelector(".aos-cp")!;
  const view = root.querySelector(".aos-cp-view")!;
  view.rect = { left: 900, top: 120, width: 440, height: 500 };
  return { doc, parent, column, host, f, pane, saved, root, view, clock, q: (sel: string) => root.querySelector(sel)! };
}

test("follow() selects the place and gives the view its rectangle; collapsing sends show(null) and saves; collapsed it still follows", async () => {
  const s = setup();
  assert.equal(s.root.getAttribute("data-page"), "code");
  assert.equal(s.view.getAttribute("data-tour"), "computer-view");
  assert.equal(s.root.style.width, "440px");
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  assert.deepEqual(s.f.selects, ["ws:harbor-map"]);
  assert.deepEqual(last(s.f.shows), RECT);
  assert.equal(s.q(".aos-cp-place").textContent, "harbor-map");
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  assert.equal(s.f.selects.length, 1, "the same place is not selected again");
  const shown = s.f.shows.length;
  relayout();
  assert.equal(s.f.shows.length, shown, "an unchanged rectangle is not sent again");
  s.view.rect = { left: 860, top: 120, width: 480, height: 500 };
  relayout();
  assert.deepEqual(last(s.f.shows), { x: 860, y: 120, width: 480, height: 500 }, "a relayout sends the new rectangle");

  s.q(".aos-cp-collapse").click();
  assert.equal(last(s.f.shows), null);
  assert.deepEqual(last(s.saved), { width: 440, collapsed: true });
  assert.ok(s.root.classes.has("is-collapsed"));
  assert.equal(s.q(".aos-cp-collapse").getAttribute("aria-expanded"), "false");
  s.pane.follow({ place: "vault", label: "Vault" });
  await flush();
  assert.deepEqual(s.f.selects, ["ws:harbor-map", "vault"], "collapsed or not, it shows the selected session's computer (D32)");
  assert.equal(last(s.f.shows), null, "and gives it no rectangle");
  s.q(".aos-cp-collapse").click();
  assert.deepEqual(last(s.f.shows), { x: 860, y: 120, width: 480, height: 500 });
  assert.deepEqual(last(s.saved), { width: 440, collapsed: false });
  s.pane.follow(null);
  await flush();
  assert.equal(last(s.f.selects), null, "no selection lets main park the computer");
  assert.equal(last(s.f.shows), null);
  assert.match(s.view.textContent, /Select a terminal/);
});

test("a pane on a hidden page shows nothing and selects nothing (R51); destroying it sends nothing more", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  s.pane.hide();
  assert.equal(last(s.f.shows), null);
  s.pane.follow({ place: "vault", label: "Vault" });
  await flush();
  assert.deepEqual(s.f.selects, ["ws:harbor-map"], "only the page in front selects");
  const n = s.f.shows.length;
  s.pane.destroy();
  assert.equal(s.f.shows.length, n, "already hidden: no second show(null)");
  assert.equal(s.parent.querySelector(".aos-cp"), null);
  const t = setup();
  t.pane.follow({ place: "vault", label: "Vault" });
  await flush();
  t.pane.destroy();
  assert.equal(last(t.f.shows), null, "a pane that was showing lets the view go");
  t.f.emit({ type: "state", state: state("vault", { asks: [ask("a1", "unmarked")] }) });
  assert.equal(t.f.subs.length, 1, "the store stays for the other readers; the pane no longer listens");
});

test("the ask cards answer once, always and deny; Always reads “Let it act freely” on an unmarked site and is hidden for Return (R52)", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  s.f.emit({ type: "state", state: state("ws:harbor-map", { marked: false, asks: [ask("a1", "unmarked"), ask("a2", "return", { title: "Press Return: submit on example.com?" })] }) });
  let cards = s.root.querySelectorAll(".aos-cp-ask");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].querySelector(".aos-cp-asktitle")!.textContent, "Click: Continue on example.com?", "the app's title, verbatim");
  assert.equal(cards[0].querySelector(".aos-cp-askdetail")!.textContent, "The button “Continue”. Page: https://example.com/checkout");
  assert.match(cards[0].querySelector(".aos-cp-asksite")!.textContent, /example\.com/);
  assert.deepEqual(buttons(cards[0]), ["Allow once", "Let it act freely on example.com", "Deny"]);
  assert.deepEqual(buttons(cards[1]), ["Allow once", "Deny"], "Return asks every time");
  s.clock.advance(500);
  for (const b of cards[0].querySelectorAll("button")) b.click();
  assert.deepEqual(s.f.answers, [["a1", "once"], ["a1", "always"], ["a1", "deny"]]);
  s.f.emit({ type: "state", state: state("ws:harbor-map", { marked: true, asks: [ask("a1", "delete")] }) });
  cards = s.root.querySelectorAll(".aos-cp-ask");
  assert.deepEqual(buttons(cards[0]), ["Allow once", "Always on example.com", "Deny"]);
  // Another place's state does not reach this pane.
  s.f.emit({ type: "state", state: state("vault", { asks: [ask("a9", "unmarked", { computer: "vault" })] }) });
  assert.deepEqual(s.root.querySelectorAll(".aos-cp-ask").map((c) => c.getAttribute("data-ask")), ["a1"]);
});

test("Always is offered only when main offers it, never for Return, a file, a download or a permission, and only with a site", () => {
  for (const why of ["return", "file", "download", "permission"]) assert.equal(alwaysLabel(ask("a", why)), null, why);
  assert.equal(alwaysLabel(ask("a", "unmarked", { always: false })), null);
  assert.equal(alwaysLabel(ask("a", "unmarked", { always: undefined })), null, "absent fails closed");
  assert.equal(alwaysLabel(ask("a", "purchase", { site: null })), null);
  assert.equal(alwaysLabel(ask("a", "purchase", { site: "http://localhost:5173" })), "Always on localhost:5173");
  assert.equal(alwaysLabel(ask("a", "unmarked")), "Let it act freely on example.com");
});

test("M4: the Always button reads from the ask's own reason, not the computer's current mark, so a tab change cannot mislabel it", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  // The active tab is now a marked site, but the ask was raised on an unmarked one: Always marks that site.
  s.f.emit({ type: "state", state: state("ws:harbor-map", { marked: true, asks: [ask("a1", "unmarked")] }) });
  assert.deepEqual(buttons(s.root.querySelectorAll(".aos-cp-ask")[0]), ["Allow once", "Let it act freely on example.com", "Deny"]);
  // And the other way: a category ask raised on a marked site, the active tab since unmarked.
  s.f.emit({ type: "state", state: state("ws:harbor-map", { marked: false, asks: [ask("a2", "delete")] }) });
  assert.deepEqual(buttons(s.root.querySelectorAll(".aos-cp-ask")[0]), ["Allow once", "Always on example.com", "Deny"]);
});

test("M7: a new card's buttons are disabled for 500 ms and ignore clicks meanwhile; a card already shown keeps its own start", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  s.f.emit({ type: "state", state: state("ws:harbor-map", { asks: [ask("a1", "unmarked")] }) });
  const first = () => s.root.querySelectorAll(".aos-cp-ask")[0];
  assert.ok(first().querySelectorAll("button").every((b) => b.disabled), "visibly disabled");
  first().querySelector('[data-answer="deny"]')!.click();
  s.clock.advance(300);
  // A second ask arrives and the cards are drawn again: the first keeps the time it was first shown.
  s.f.emit({ type: "state", state: state("ws:harbor-map", { asks: [ask("a1", "unmarked"), ask("a2", "unmarked")] }) });
  first().querySelector('[data-answer="deny"]')!.click();
  assert.deepEqual(s.f.answers, [], "clicks within 500 ms are ignored");
  s.clock.advance(199);
  first().querySelector('[data-answer="deny"]')!.click();
  assert.deepEqual(s.f.answers, []);
  s.clock.advance(1);
  assert.ok(first().querySelectorAll("button").every((b) => !b.disabled));
  first().querySelector('[data-answer="deny"]')!.click();
  assert.deepEqual(s.f.answers, [["a1", "deny"]]);
  const second = s.root.querySelectorAll(".aos-cp-ask")[1];
  assert.ok(second.querySelectorAll("button").every((b) => b.disabled), "the second card still waits");
  second.querySelector('[data-answer="once"]')!.click();
  s.clock.advance(300);
  assert.ok(second.querySelectorAll("button").every((b) => !b.disabled));
  second.querySelector('[data-answer="once"]')!.click();
  assert.deepEqual(s.f.answers, [["a1", "deny"], ["a2", "once"]]);
});

test("M7 (R69): a card that moves up because an earlier one left waits 500 ms again, so a double-click on the leaving card cannot answer it; a card that stays put keeps its wait", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  s.f.emit({ type: "state", state: state("ws:harbor-map", { asks: [ask("a1", "unmarked"), ask("a2", "unmarked")] }) });
  s.clock.advance(600);
  const cards = () => s.root.querySelectorAll(".aos-cp-ask");
  assert.ok(cards().every((c) => c.querySelectorAll("button").every((b) => !b.disabled)), "both armed");
  // The first click of a double-click answers a1; main drops it and a2 moves up into its place.
  cards()[0].querySelector('[data-answer="deny"]')!.click();
  s.f.emit({ type: "state", state: state("ws:harbor-map", { asks: [ask("a2", "unmarked")] }) });
  const moved = cards()[0];
  assert.equal(moved.getAttribute("data-ask"), "a2");
  assert.ok(moved.querySelectorAll("button").every((b) => b.disabled), "the card that moved up waits again");
  assert.ok(moved.classes.has("is-arming"));
  // The second click lands where a1 was.
  moved.querySelector('[data-answer="deny"]')!.click();
  assert.deepEqual(s.f.answers, [["a1", "deny"]], "the second click does not answer a2");
  s.clock.advance(499);
  cards()[0].querySelector('[data-answer="once"]')!.click();
  assert.deepEqual(s.f.answers, [["a1", "deny"]]);
  s.clock.advance(1);
  assert.ok(cards()[0].querySelectorAll("button").every((b) => !b.disabled));
  // A new card below leaves a2 where it is: a2 stays armed and answers at once.
  s.f.emit({ type: "state", state: state("ws:harbor-map", { asks: [ask("a2", "unmarked"), ask("a3", "unmarked")] }) });
  assert.ok(cards()[0].querySelectorAll("button").every((b) => !b.disabled), "a card that did not move keeps its wait");
  assert.ok(cards()[1].querySelectorAll("button").every((b) => b.disabled), "the new card waits");
  cards()[0].querySelector('[data-answer="once"]')!.click();
  assert.deepEqual(s.f.answers, [["a1", "deny"], ["a2", "once"]]);
});

test("the driving bar names the holder: violet with Take over for an agent, grey with Hand back for you, Take over when idle (M6)", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  const drive = s.q(".aos-cp-drive");
  // M6: idle, Take over is offered, so a person signing in is never interleaved by an agent's next action.
  assert.ok(drive.classes.has("is-idle"));
  assert.match(drive.textContent, /^No one is driving/);
  assert.deepEqual(buttons(drive), ["Take over"]);
  drive.querySelector("button")!.click();
  assert.equal(s.f.takeOvers, 1);
  s.f.emit({ type: "state", state: state("ws:harbor-map", { holder: { kind: "agent", session: "code:t5", label: "Claude Code in harbor-map" } }) });
  assert.ok(drive.classes.has("is-agent"));
  assert.match(drive.textContent, /^Claude Code in harbor-map is driving/);
  assert.deepEqual(buttons(drive), ["Take over"]);
  drive.querySelector("button")!.click();
  assert.equal(s.f.takeOvers, 2);
  assert.match(s.q(".aos-cp-foot").textContent, /Claude Code in harbor-map/, "the footer names the acting session");
  s.f.emit({ type: "state", state: state("ws:harbor-map", { holder: { kind: "user", resume: { session: "code:t5", label: "Claude Code in harbor-map" } } }) });
  assert.ok(drive.classes.has("is-user") && !drive.classes.has("is-agent"));
  assert.match(drive.textContent, /^You're driving/);
  assert.deepEqual(buttons(drive), ["Hand back"]);
  drive.querySelector("button")!.click();
  assert.equal(s.f.handBacks, 1);
  assert.deepEqual(drivingText(null), { kind: "idle", text: "No one is driving", button: "Take over" });
  assert.deepEqual(drivingText({ kind: "agent", session: "chat:th1", label: "Codex" }), { kind: "agent", text: "Codex is driving", button: "Take over" });
  assert.deepEqual(drivingText({ kind: "user", resume: null }), { kind: "user", text: "You're driving", button: "Hand back" });
});

test("the surface off: the pane is only its collapsed strip, saying so, and that collapse is never saved (R53, R54)", async () => {
  const s = setup({ answer: (place) => (place === "ws:off" ? null : state(place)), settings: { width: 520, collapsed: false } });
  s.pane.follow({ place: "ws:off", label: "off" });
  await flush();
  assert.ok(s.root.classes.has("is-collapsed"), "the collapsed strip, never a 440 px dead pane");
  assert.ok(s.root.classes.has("is-off"));
  assert.equal(s.root.style.width, "", "no wider than the strip");
  assert.equal(s.root.getAttribute("title"), "The Computer pane is off.");
  assert.equal(s.root.getAttribute("aria-label"), "The Computer pane is off.");
  assert.equal(s.q(".aos-cp-collapse").getAttribute("aria-label"), "The Computer pane is off.");
  assert.equal(s.q(".aos-cp-collapse").disabled, true);
  s.q(".aos-cp-collapse").click();
  assert.deepEqual(s.saved, [], "nothing is saved for the off strip, nor for a click on it");
  assert.equal(s.view.textContent, "The Computer pane is off.");
  assert.equal(last(s.f.shows), null, "show(null) is sent");
  assert.ok(s.f.shows.every((b) => b === null));
  assert.equal(s.q(".aos-cp-url").disabled, true);
  // A later select that answers a state: the user's own width and collapse come back.
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  assert.ok(!s.root.classes.has("is-collapsed") && !s.root.classes.has("is-off"));
  assert.equal(s.root.style.width, "520px");
  assert.equal(s.root.getAttribute("aria-label"), "Computer");
  assert.equal(s.root.getAttribute("title"), null);
  assert.deepEqual(last(s.f.shows), RECT);
  assert.deepEqual(s.saved, []);
});

test("the surface off for the run: the strip with nothing followed too, and main is asked nothing (R54); a host that does not say is off", async () => {
  for (const [page, enabled] of [["code", false], ["chat", false], ["code", "absent"], ["chat", "absent"]] as const) {
    const s = setup({ page, enabled, settings: { width: 520, collapsed: false } });
    assert.ok(s.root.classes.has("is-collapsed") && s.root.classes.has("is-off"), `${page}: the strip before the page follows anything`);
    s.pane.follow(null);
    await flush();
    assert.ok(s.root.classes.has("is-collapsed") && s.root.classes.has("is-off"), `${page}: with nothing to show, still the strip`);
    assert.equal(s.root.style.width, "");
    assert.equal(s.view.textContent, "The Computer pane is off.");
    s.pane.follow({ place: "vault", label: "Vault" });
    await flush();
    assert.ok(s.root.classes.has("is-off"), `${page}: and with a place`);
    assert.deepEqual(s.f.selects, [], `${page}: no select reaches main while the surface is off`);
    assert.ok(s.f.shows.every((b) => b === null), `${page}: never a rectangle`);
    assert.deepEqual(s.saved, []);
  }
});

test("following another place takes the view away until main answers for it, so the last computer never flashes", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  assert.deepEqual(last(s.f.shows), RECT);
  s.pane.follow({ place: "vault", label: "Vault" });
  assert.equal(last(s.f.shows), null, "sent before main has switched");
  relayout();
  assert.equal(last(s.f.shows), null, "a relayout meanwhile sends no rectangle either");
  await flush();
  assert.deepEqual(last(s.f.shows), RECT, "main answered for the new place");
});

test("the address bar's site switch names the site, sends mark only on a click, and hides without a web page (R55)", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  const trust = s.q(".aos-cp-trust");
  assert.equal(trust.textContent, "Asks first on example.com");
  assert.equal(trust.getAttribute("aria-pressed"), "false");
  assert.ok(!trust.classes.has("is-hidden"));
  trust.click();
  assert.deepEqual(s.f.marks, [["https://example.com", true]]);
  s.f.emit({ type: "state", state: state("ws:harbor-map", { marked: true }) });
  assert.equal(trust.textContent, "Acts freely on example.com");
  assert.deepEqual(s.f.marks, [["https://example.com", true]], "a state event never marks");
  trust.click();
  assert.deepEqual(s.f.marks, [["https://example.com", true], ["https://example.com", false]]);
  const blank = [{ index: 0, url: "about:blank", title: "", openedBy: null, active: true }];
  s.f.emit({ type: "state", state: state("ws:harbor-map", { tabs: blank }) });
  assert.ok(trust.classes.has("is-hidden") && trust.disabled, "about:blank has no site");
  s.f.emit({ type: "state", state: state("ws:harbor-map", { tabs: [] }) });
  assert.ok(trust.classes.has("is-hidden"), "no tab");
  s.f.emit({ type: "state", state: state("ws:harbor-map", { tabs: [{ index: 0, url: "https://example.com/", title: "Example", openedBy: null, active: false }] }) });
  assert.ok(trust.classes.has("is-hidden"), "no active tab");
  trust.click();
  assert.equal(s.f.marks.length, 2);
});

test("M3: on a local address the site switch is disabled and says why: local addresses always act freely", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  const trust = s.q(".aos-cp-trust");
  for (const url of ["http://localhost:5173/", "http://127.0.0.1:8080/app", "http://[::1]:3000/"]) {
    s.f.emit({ type: "state", state: state("ws:harbor-map", { marked: true, tabs: [{ index: 0, url, title: "Dev", openedBy: null, active: true }] }) });
    assert.ok(trust.disabled && !trust.classes.has("is-hidden"), url);
    assert.equal(trust.getAttribute("title"), "Local addresses always act freely");
    assert.match(trust.getAttribute("aria-label") ?? "", /Local addresses always act freely/);
    trust.click();
  }
  assert.deepEqual(s.f.marks, [], "a click there marks nothing");
  // A web site's switch works again, and loses the local reason.
  s.f.emit({ type: "state", state: state("ws:harbor-map", { marked: false }) });
  assert.ok(!trust.disabled);
  assert.match(trust.getAttribute("title") ?? "", /^Agents ask before any click/);
  assert.equal(trust.getAttribute("aria-label"), null);
  trust.click();
  assert.deepEqual(s.f.marks, [["https://example.com", true]]);
});

test("Esc inside the pane stays in it; Esc in the address bar still puts the address back", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  let stopped = 0;
  const stop = { stopPropagation: () => { stopped++; } };
  s.root.fire("keydown", { key: "Escape", ...stop });
  assert.equal(stopped, 1, "never reaches Sessions, which stops a running turn on Esc");
  s.root.fire("keydown", { key: "Enter", ...stop });
  assert.equal(stopped, 1, "other keys go on");
  const input = s.q(".aos-cp-url");
  input.focus();
  input.value = "exam";
  input.fire("keydown", { key: "Escape", ...stop });
  assert.equal(input.value, "https://example.com/checkout");
  assert.notEqual(s.doc.activeElement, input);
  assert.equal(stopped, 2);
});

test("popped out, the followed computer counts as on screen for the row dots, as main counts it, whatever the pane shows", async () => {
  const s = setup();
  const store = storeFor(s.host);
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  const holder = { kind: "agent" as const, session: "code:t5", label: "Claude Code in harbor-map" };
  s.q(".aos-cp-collapse").click();
  s.f.emit({ type: "state", state: state("ws:harbor-map", { holder }) });
  assert.equal(store.marks("code:t5").dot, true, "collapsed and docked: off-screen");
  s.f.emit({ type: "state", state: state("ws:harbor-map", { holder, poppedOut: true }) });
  assert.equal(store.marks("code:t5").dot, false, "popped out: on screen in its own window");
  s.pane.hide();
  assert.equal(store.marks("code:t5").dot, false, "another rail tab in front: still in its window");
  s.f.emit({ type: "state", state: state("ws:harbor-map", { holder, poppedOut: false }) });
  assert.equal(store.marks("code:t5").dot, true, "back in the hidden pane: off-screen");
});

test("popped out: the rectangle says where the browser went and that closing that window brings it back; chrome and asks stay (R53)", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  s.q(".aos-cp-popout").click();
  assert.equal(s.f.popOuts, 1);
  s.f.emit({ type: "state", state: state("ws:harbor-map", { poppedOut: true, asks: [ask("a1", "unmarked")] }) });
  assert.match(s.view.textContent, /Popped out/);
  assert.match(s.view.textContent, /clos/i);
  assert.equal(s.root.querySelectorAll(".aos-cp-ask").length, 1);
  assert.equal(s.q(".aos-cp-popout").disabled, true);
  assert.deepEqual(last(s.f.shows), RECT, "the docked rectangle is kept for when it comes back");
});

test("the address bar: a scheme is kept, the Mac's servers get http, an address https, and anything else searches the start page", () => {
  const search = (q: string): string => `https://duckduckgo.com/?q=${q}`;
  const table: Array<[string, string, string]> = [
    // A scheme followed by // or by no spaces is kept: main refuses anything but http and https, and says why.
    ["http://example.com", "http://example.com", "http is kept"],
    ["https://example.com/a b", "https://example.com/a b", "a scheme and // keep the rest, spaces and all"],
    ["javascript:alert(1)", "javascript:alert(1)", "main refuses it and says why"],
    ["about:blank", "about:blank", "about:blank is kept"],
    ["file:///etc/hosts", "file:///etc/hosts", "main refuses it and says why"],
    // The Mac's own servers get http.
    ["  localhost:5173/app ", "http://localhost:5173/app", "trimmed, localhost with a port"],
    ["localhost", "http://localhost", "localhost alone"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080", "the IPv4 loopback"],
    ["[::1]:3000/x", "http://[::1]:3000/x", "the IPv6 loopback"],
    ["localhost:3000/a b", "http://localhost:3000/a b", "spaces after the path start are the page's"],
    // An address (a host with a dot or a port, no spaces before its path) gets https.
    ["example.com", "https://example.com", "a host with a dot"],
    ["example.com/docs", "https://example.com/docs", "a host and a path"],
    ["docs.example.org/x?y=1#z", "https://docs.example.org/x?y=1#z", "a query and a fragment"],
    ["example.com/search?q=a b", "https://example.com/search?q=a b", "spaces after the host are the page's"],
    ["example.com:8443/admin", "https://example.com:8443/admin", "a host with a port"],
    ["dev-box:3000", "https://dev-box:3000", "a port makes one word an address"],
    ["192.168.1.10/admin", "https://192.168.1.10/admin", "an IPv4 address"],
    ["[2001:db8::1]:8080/x", "https://[2001:db8::1]:8080/x", "an IPv6 address"],
    // Anything else is a search: words, a question, one word with no dot.
    ["weather", search("weather"), "one word with no dot"],
    ["weather?", search("weather%3F"), "one word and a question mark"],
    ["what is the weather?", search("what%20is%20the%20weather%3F"), "a question"],
    ["how to use example.com", search("how%20to%20use%20example.com"), "words before an address"],
    ["example.com is down", search("example.com%20is%20down"), "an address before words"],
    ["note: buy milk", search("note%3A%20buy%20milk"), "a word and a colon, then words, is no scheme"],
    ["localhost docs", search("localhost%20docs"), "localhost and a word"],
    ["C++ & Rust", search("C%2B%2B%20%26%20Rust"), "every character is encoded"],
    ["/etc/hosts", search("%2Fetc%2Fhosts"), "a path with no host"],
    ["   ", "", "nothing typed opens nothing"],
  ];
  for (const [typed, want, why] of table) assert.equal(addressUrl(typed), want, `${JSON.stringify(typed)}: ${why}`);
  // Another start page (the e2e suite's fixture, host.startPage) gets the words instead.
  assert.equal(addressUrl("tide times", "http://search.test:4100/"), "http://search.test:4100/?q=tide%20times");
  assert.equal(addressUrl("example.com", "http://search.test:4100/"), "https://example.com", "an address is never a search");
});

test("the address bar opens what you type through navigate and shows a refusal inline", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  const input = s.q(".aos-cp-url");
  assert.equal(input.value, "https://example.com/checkout", "the active tab's address");
  assert.equal(input.getAttribute("placeholder"), "Search DuckDuckGo or type an address");
  assert.equal(input.getAttribute("aria-label"), "Address or search");
  assert.equal(s.root.querySelector(".aos-cp-web")!.textContent, "web");
  s.f.navResult = { ok: false, error: "The Computer pane is off.", code: "ENOENT" };
  input.value = "example.com/docs";
  s.q(".aos-cp-address").fire("submit");
  await flush();
  assert.deepEqual(s.f.navs, ["https://example.com/docs"]);
  assert.equal(s.q(".aos-cp-navmsg").textContent, "The Computer pane is off.");
  s.f.navResult = { ok: true, data: null };
  s.q(".aos-cp-address").fire("submit");
  await flush();
  assert.equal(s.q(".aos-cp-navmsg").textContent, "");
});

test("the tabs: + opens one, × closes one, a click selects one", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  s.f.emit({ type: "state", state: state("ws:harbor-map", { tabs: [
    { index: 0, url: "https://example.com/", title: "Example", openedBy: null, active: false },
    { index: 1, url: "about:blank", title: "", openedBy: null, active: true },
  ] }) });
  const tabs = s.root.querySelectorAll(".aos-cp-tab");
  assert.deepEqual(tabs.map((t) => t.querySelector(".aos-cp-tabtitle")!.textContent), ["Example", "New tab"]);
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
  tabs[0].click();
  tabs[1].querySelector(".aos-cp-tabclose")!.click();
  s.q(".aos-cp-tabnew").click();
  assert.deepEqual(s.f.tabs, [{ kind: "select", index: 0 }, { kind: "close", index: 1 }, { kind: "new" }]);
});

test("a new tab on the bare start page reads as one: the address bar is empty and the tab says New tab, whatever its title", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  const tab = (url: string, title: string, active = true) => ({ index: 0, url, title, openedBy: null, active });
  const titles = (): string[] => s.root.querySelectorAll(".aos-cp-tabtitle").map((t) => t.textContent);
  const input = s.q(".aos-cp-url");
  s.f.emit({ type: "state", state: state("ws:harbor-map", { tabs: [tab("https://duckduckgo.com/", "DuckDuckGo - Protection. Privacy. Peace of mind.")] }) });
  assert.equal(input.value, "", "the start page, as about:blank");
  assert.deepEqual(titles(), ["New tab"]);
  s.f.emit({ type: "state", state: state("ws:harbor-map", { tabs: [tab("about:blank", "about:blank")] }) });
  assert.equal(input.value, "");
  assert.deepEqual(titles(), ["New tab"], "about:blank whatever main calls its title");
  // A search on it, or any other page of the site, is a page like any other.
  s.f.emit({ type: "state", state: state("ws:harbor-map", { tabs: [tab("https://duckduckgo.com/?q=weather&ia=web", "weather at DuckDuckGo")] }) });
  assert.equal(input.value, "https://duckduckgo.com/?q=weather&ia=web");
  assert.deepEqual(titles(), ["weather at DuckDuckGo"]);
  s.f.emit({ type: "state", state: state("ws:harbor-map", { tabs: [tab("https://duckduckgo.com/about", "")] }) });
  assert.deepEqual(titles(), ["duckduckgo.com"]);
  // Words typed there search the start page through navigate.
  input.focus();
  input.value = "what is the weather?";
  s.q(".aos-cp-address").fire("submit");
  await flush();
  assert.deepEqual(s.f.navs, ["https://duckduckgo.com/?q=what%20is%20the%20weather%3F"]);
});

test("with another start page from the host (the e2e suite's fixture), a new tab on it reads as one and words search it", async () => {
  const s = setup({ startPage: "http://search.test:4100/" });
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  const input = s.q(".aos-cp-url");
  s.f.emit({ type: "state", state: state("ws:harbor-map", { tabs: [{ index: 0, url: "http://search.test:4100/", title: "Start", openedBy: null, active: true }] }) });
  assert.equal(input.value, "");
  assert.deepEqual(s.root.querySelectorAll(".aos-cp-tabtitle").map((t) => t.textContent), ["New tab"]);
  s.f.emit({ type: "state", state: state("ws:harbor-map", { tabs: [{ index: 0, url: "https://duckduckgo.com/", title: "DuckDuckGo", openedBy: null, active: true }] }) });
  assert.equal(input.value, "https://duckduckgo.com/", "DuckDuckGo is a page like any other here");
  input.value = "tide times";
  s.q(".aos-cp-address").fire("submit");
  await flush();
  assert.deepEqual(s.f.navs, ["http://search.test:4100/?q=tide%20times"]);
});

test("the Code page keeps an activity log (D35); the Chat page has none (its thread shows the lines)", async () => {
  const code = setup({ page: "code" });
  code.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  code.f.emit({ type: "state", state: state("ws:harbor-map", { log: [{ at: Date.UTC(2026, 10, 8, 9, 30), session: "Claude Code in harbor-map", text: "Clicked “Continue”" }] }) });
  assert.match(code.q(".aos-cp-log").textContent, /Claude Code in harbor-map.*Clicked “Continue”/);
  const chat = setup({ page: "chat" });
  chat.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  assert.equal(chat.root.querySelector(".aos-cp-log"), null);
  assert.match(chat.q(".aos-cp-foot").textContent, /Claude in Chrome/, "the help says which tools act without these guards (D29)");
});

test("a modal or the tour over the page takes the view away until it goes", async () => {
  const s = setup();
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  const modal = s.doc.body.createDiv({ cls: "modal-container mod-dim" });
  domChanged();
  assert.equal(last(s.f.shows), null);
  modal.detach();
  domChanged();
  assert.deepEqual(last(s.f.shows), RECT);
  const tour = s.doc.body.createDiv({ cls: "aos-tour", attr: { "data-tour-overlay": "" } });
  domChanged();
  assert.equal(last(s.f.shows), null, "the tour's overlay, for the whole tour");
  tour.detach();
  domChanged();
  assert.deepEqual(last(s.f.shows), RECT);
});

test("a notification's reveal opens the collapsed pane on its ask and scrolls the card into view (D27)", async () => {
  const s = setup({ settings: { width: 500, collapsed: true } });
  assert.equal(s.root.style.width, "");
  s.pane.follow({ place: "ws:harbor-map", label: "harbor-map" });
  await flush();
  s.f.emit({ type: "state", state: state("ws:harbor-map", { asks: [ask("a1", "unmarked")] }) });
  assert.equal(s.q(".aos-cp-count").textContent, "1", "collapsed, the pane counts its asks");
  assert.equal(last(s.f.shows), null);
  s.f.emit({ type: "reveal", askId: "a1" });
  assert.ok(!s.root.classes.has("is-collapsed"));
  assert.deepEqual(s.saved, [], "opened for the ask only: the saved collapse stays");
  assert.deepEqual(last(s.f.shows), RECT);
  assert.equal(s.root.querySelector(".aos-cp-ask")!.scrolled, 1);
});

// ── session-browser S11: the bar, Side · Half · Wide ──

const sizeBtn = (s: ReturnType<typeof setup>, size: string): FakeEl => s.q(`[data-size="${size}"]`);

test("Half saves 600 and is marked pressed", () => {
  const s = setup();
  assert.equal(sizeBtn(s, "side").getAttribute("aria-pressed"), "true", "440 is Side");
  assert.equal(sizeBtn(s, "half").getAttribute("aria-pressed"), "false");
  assert.equal(s.q(".aos-cp-sizes").getAttribute("data-tour"), "computer-size");
  assert.deepEqual(["side", "half", "wide"].map((z) => sizeBtn(s, z).textContent), ["Side", "Half", "Wide"]);
  sizeBtn(s, "half").click();
  assert.deepEqual(last(s.saved), { width: 600, collapsed: false });
  assert.equal(s.root.style.width, "600px");
  assert.equal(sizeBtn(s, "half").getAttribute("aria-pressed"), "true");
  assert.equal(sizeBtn(s, "side").getAttribute("aria-pressed"), "false");
  sizeBtn(s, "wide").click();
  assert.deepEqual(last(s.saved), { width: 840, collapsed: false });
  assert.equal(s.q(".aos-cp-handle").getAttribute("aria-valuemax"), "840");
});

test("a row under 680 disables Half and Wide", () => {
  const s = setup({ column: 280, pane: 320, settings: { width: 320, collapsed: false } });
  assert.equal(sizeBtn(s, "half").disabled, true);
  assert.equal(sizeBtn(s, "wide").disabled, true);
  assert.equal(sizeBtn(s, "side").disabled, false);
  s.column.offsetWidth = 760;
  s.root.offsetWidth = 440;
  relayout();
  assert.equal(sizeBtn(s, "half").disabled, false, "the row grew: the existing observer redraws the buttons");
  assert.equal(sizeBtn(s, "wide").disabled, false);
});

test("a shown width never passes the row's maximum", () => {
  const s = setup({ settings: { width: 1400, collapsed: false } });
  assert.equal(s.root.style.width, "840px");
  assert.equal(s.q(".aos-cp-handle").getAttribute("aria-valuenow"), "840");
  assert.deepEqual(s.saved, [], "the stored 1400 is not rewritten");
  s.column.offsetWidth = 500;
  relayout();
  assert.equal(s.root.style.width, "580px", "the row shrank to 940: the pane follows it down (940 less 360)");
});

test("a double click on the bar goes back to Side", () => {
  const s = setup({ settings: { width: 700, collapsed: false } });
  s.q(".aos-cp-handle").fire("dblclick");
  assert.deepEqual(last(s.saved), { width: 440, collapsed: false });
  assert.equal(s.root.style.width, "440px");
});

test("at the default width the session column keeps its own floor", () => {
  const s = setup();
  assert.equal(s.column.classes.has("is-narrowable"), false);
});

test("a pane the user sized lets the session column narrow", () => {
  const s = setup();
  sizeBtn(s, "half").click();
  assert.equal(s.column.classes.has("is-narrowable"), true);
  sizeBtn(s, "side").click();
  assert.equal(s.column.classes.has("is-narrowable"), false);
});

test("a collapsed or hidden pane never leaves the column narrowable", () => {
  const s = setup({ settings: { width: 600, collapsed: false } });
  assert.equal(s.column.classes.has("is-narrowable"), true);
  s.q(".aos-cp-collapse").click();
  assert.equal(s.column.classes.has("is-narrowable"), false);
  s.q(".aos-cp-collapse").click();
  assert.equal(s.column.classes.has("is-narrowable"), true);
  s.pane.hide();
  assert.equal(s.column.classes.has("is-narrowable"), false);
  relayout();
  assert.equal(s.column.classes.has("is-narrowable"), false, "a relayout does not bring it back");
  const t = setup({ settings: { width: 600, collapsed: false } });
  t.pane.destroy();
  assert.equal(t.column.classes.has("is-narrowable"), false);
});

test("on a narrowing row the pane follows the layout down and comes back", () => {
  const s = setup({ settings: { width: 600, collapsed: false }, column: 760, pane: 600 });
  assert.equal(s.root.style.width, "600px");
  // The window narrows: the column sits at its floor and the flex layout shrinks the pane (360 + 450 = 810).
  s.column.offsetWidth = 360;
  s.root.offsetWidth = 450;
  relayout();
  assert.equal(s.root.style.width, "450px", "the shown width follows the shrunk pane");
  assert.equal(s.q(".aos-cp-handle").getAttribute("aria-valuemax"), "450");
  assert.deepEqual(s.saved, [], "the saved 600 is not rewritten");
  // The window grows again: the column takes the room (the pane keeps its drawn 450), and the width returns to 600.
  s.column.offsetWidth = 760;
  relayout();
  assert.equal(s.root.style.width, "600px");
  assert.deepEqual(s.saved, []);
});
