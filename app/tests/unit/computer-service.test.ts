import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ASK_LABELS, ComputerService, type BrowserLike, type ComputerState } from "../../src/main/computer/service";
import { AskBroker, type Clock } from "../../src/main/computer/asks";
import { Wheel } from "../../src/main/computer/wheel";
import { SiteMarks } from "../../src/main/computer/sites";
import type { AgentRef } from "../../src/main/computer/registry";
import type { BrowserHooks, Resolved, TabInfo } from "../../src/main/computer/browser";
import type { Access, Focus } from "../../src/main/computer/gate";
import type { Target } from "../../src/main/computer/categories";
import type { Snapshot } from "../../src/main/computer/snapshot";
import type { ComputerTool } from "../../src/main/computer/bridge";
import type { Rect } from "../../src/main/computer/mask";

const flush = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

class FakeClock implements Clock {
  t = 0; private n = 0; private q = new Map<number, { at: number; fn: () => void }>();
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.q.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(id: unknown) { this.q.delete(id as number); }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const next = [...this.q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.q.delete(next[0]); this.t = next[1].at; next[1].fn();
    }
    this.t = end; await flush();
  }
}

interface Spot { target: Target; shown?: string; sensitive?: boolean; focuses?: boolean }
const btn = (name: string, more: Partial<Target> = {}): Target => ({ role: "button", name, inForm: false, fileInput: false, ...more });
const box = (name: string, more: Partial<Target> = {}): Target => ({ role: "textbox", name, inForm: false, fileInput: false, ...more });

/** The subset of ComputerBrowser the service drives, over an in-memory page. */
class FakeBrowser implements BrowserLike {
  pages: { url: string; openedBy: string | null }[] = [];
  current = -1; seq = 0;
  spots = new Map<string, Spot>();
  focused: Focus = { target: null, shown: "", sensitive: false, plainTextarea: false };
  text = "";
  clicks: Resolved[] = []; typed: string[] = []; keys: string[] = []; scrolls: { dx: number; dy: number; at: number | null }[] = [];
  shows: (Rect | null)[] = []; scrubs: [string, number | undefined][] = []; order: string[] = [];
  between: (() => void) | null = null;
  constructor(public place: string, public hooks: BrowserHooks) {}
  tabs(): TabInfo[] { return this.pages.map((p, index) => ({ index, url: p.url, title: "", openedBy: p.openedBy, active: index === this.current })); }
  pageToken(): string { return this.pages[this.current] ? `${this.current}.${this.seq}` : "none"; }
  async open(url: string, o: { newTab?: boolean; by: string | null }) {
    if (o.newTab || this.current < 0) { this.pages.push({ url: new URL(url).href, openedBy: o.by }); this.current = this.pages.length - 1; }
    else this.pages[this.current].url = new URL(url).href;
    this.seq++;
    return { url: this.pages[this.current].url, title: "" };
  }
  select(i: number) { this.need(i); this.current = i; this.seq++; }
  close(i: number) { this.need(i); this.pages.splice(i, 1); this.current = Math.min(this.current, this.pages.length - 1); this.seq++; }
  async snapshot(tab?: number): Promise<Snapshot> {
    this.need(tab);
    return { text: `<untrusted-page origin="o" url="${this.pages[tab ?? this.current].url}">\n${this.text}\n</untrusted-page>`, refs: new Map(), truncated: false };
  }
  async screenshot(tab?: number) { this.need(tab); return Buffer.from("PNGDATA"); }
  async resolve(by: { ref: string } | { x: number; y: number }): Promise<Resolved> {
    this.need(); this.order.push("resolve");
    const key = "ref" in by ? by.ref : `${by.x},${by.y}`;
    const s = this.spots.get(key);
    if (!s) throw new Error(`There is no ${key} on this page now: take a new snapshot.`);
    return { target: { ...s.target }, shown: s.shown ?? s.target.name, sensitive: !!s.sensitive, backendNodeId: 7, judged: [7], point: "ref" in by ? { x: 5, y: 5 } : by, pageToken: this.pageToken(), tab: this.current };
  }
  async focus(): Promise<Focus> { this.need(); this.order.push("focus"); return { ...this.focused }; }
  async scrub(text: string, tab?: number) { this.scrubs.push([text, tab]); return text.replaceAll("hunter2", "•••••••"); }
  async click(r: Resolved) {
    if (r.pageToken !== this.pageToken()) throw new Error("The page changed: look again.");
    this.order.push("click"); this.clicks.push(r);
    const s = [...this.spots.values()].find((x) => x.target.name === r.target.name);
    if (s?.focuses) this.focused = { target: { ...s.target }, shown: s.shown ?? s.target.name, sensitive: !!s.sensitive, plainTextarea: false };
  }
  async type(text: string, keepGoing: () => boolean) {
    for (let i = 0; i < text.length; i += 2) {
      if (!keepGoing()) return;
      this.typed.push(text.slice(i, i + 2));
      this.between?.();
      await Promise.resolve();
    }
  }
  async key(k: string) { this.keys.push(k); }
  async scroll(dx: number, dy: number, at?: Resolved) { this.scrolls.push({ dx, dy, at: at?.backendNodeId ?? null }); }
  show(b: Rect | null) { this.shows.push(b); }
  private need(tab?: number) {
    if (!this.pages[tab ?? this.current]) throw new Error(tab === undefined ? "No page is open: call computer_open first." : `There is no tab ${tab}.`);
  }
}

const agent = (key: string, label: string, access: Access = "edit", place = "ws:alpha"): AgentRef => ({ pid: 1, host: "claude", page: "chat", key, label, place, access });
const A = agent("chat:a", "Alpha");
const B = agent("chat:b", "Beta");

function make(o: { enabled?: boolean } = {}) {
  const clock = new FakeClock();
  const sites = new SiteMarks(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aos-service-")), "computer", "sites.json"));
  const cfg = { enabled: o.enabled ?? true, askTimeoutSec: 120 };
  const states: ComputerState[] = [];
  const notes: [string, string][] = [];
  const browsers = new Map<string, FakeBrowser>();
  let svc: ComputerService | null = null;
  const broker = new AskBroker({ timeoutMs: () => cfg.askTimeoutSec * 1000, clock, onChange: () => svc?.refresh() });
  const wheel = new Wheel({ clock, reserved: (c) => svc?.reserved(c) ?? false, onChange: (c) => svc?.refresh(c) });
  svc = new ComputerService({
    browser: (place, hooks) => { const b = new FakeBrowser(place, hooks); browsers.set(place, b); return b; },
    broker, wheel, sites, config: () => cfg, emit: (s) => states.push(s), note: (a, line) => notes.push([a.key, line]), clock,
  });
  const s = svc;
  let id = 0;
  const call = (who: AgentRef, tool: ComputerTool, args: Record<string, unknown> = {}) => s.call(who, { id: ++id, tool, args });
  const b = (place = "ws:alpha"): FakeBrowser => { const x = browsers.get(place); if (!x) throw new Error(`no browser for ${place}`); return x; };
  const open = async (who: AgentRef, url: string) => { const r = await call(who, "computer_open", { url }); assert.ok(!r.isError, r.text); return b(who.place); };
  const asked = async (n = 1) => { for (let i = 0; i < 200 && broker.pending().length < n; i++) await flush(); assert.equal(broker.pending().length, n); return broker.pending()[n - 1]; };
  const lastState = (place = "ws:alpha") => [...states].reverse().find((x) => x.place === place)!;
  return { clock, sites, cfg, states, notes, broker, wheel, svc: s, call, b, open, asked, lastState };
}

// ---- the brief's tests

test("a Read only click is refused without taking the wheel, while a snapshot works", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.text = "hello";
  h.svc.agentGone(A);
  const R = agent("chat:r", "Reader", "read");
  const r = await h.call(R, "computer_click", { ref: "e1" });
  assert.equal(r.text, "Read only: this session can look but not act (D17).");
  assert.equal(r.isError, true);
  assert.equal(h.wheel.holder("ws:alpha"), null);
  assert.match((await h.call(R, "computer_snapshot")).text, /hello/);
});

test("a second session gets busy, and its look tools still answer", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.text = "page text"; b.spots.set("e1", { target: btn("Next") });
  const r = await h.call(B, "computer_click", { ref: "e1" });
  assert.equal(r.text, "busy: Alpha is driving");
  assert.equal(r.isError, true);
  assert.equal(b.clicks.length, 0);
  assert.match((await h.call(B, "computer_snapshot")).text, /page text/);
  assert.match((await h.call(B, "computer_status")).text, /Driving: Alpha/);
  assert.equal((await h.call(B, "computer_screenshot")).image?.mimeType, "image/png");
  const w = h.call(B, "computer_wait", { timeoutSec: 1 });
  await h.clock.advance(1_000);
  assert.match((await w).text, /^Waited 1 s\. Page: https:\/\/a\.test\/$/);
});

test("an unmarked click asks; Deny leaves the page unclicked; Allow once clicks", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.spots.set("e1", { target: btn("Next") });
  const p = h.call(A, "computer_click", { ref: "e1" });
  const ask = await h.asked();
  assert.equal(ask.why, "unmarked");
  assert.equal(ask.title, "Act on a site you haven't marked: Click “Next” on a.test?");
  assert.equal(ask.session, "chat:a"); assert.equal(ask.sessionLabel, "Alpha"); assert.equal(ask.computer, "ws:alpha");
  assert.equal(ask.site, "https://a.test"); assert.equal(ask.always, true);
  assert.ok(h.notes.some(([k, l]) => k === "chat:a" && l.includes(ask.title)), "the ask is a line in the transcript (D6)");
  h.svc.answer(ask.id, "deny");
  const r = await p;
  assert.equal(r.text, "The user denied: Act on a site you haven't marked: Click “Next” on a.test.");
  assert.equal(r.isError, true);
  assert.equal(b.clicks.length, 0);

  const p2 = h.call(A, "computer_click", { ref: "e1" });
  h.svc.answer((await h.asked()).id, "once");
  assert.equal((await p2).text, "Clicked e1. Page: https://a.test/");
  assert.equal(b.clicks.length, 1);
  assert.equal(h.sites.isMarked("https://a.test/"), false);
});

test("Always on an unmarked ask marks the site, so the next click goes", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/x");
  b.spots.set("e1", { target: btn("Next") });
  const p = h.call(A, "computer_click", { ref: "e1" });
  h.svc.answer((await h.asked()).id, "always");
  assert.match((await p).text, /^Clicked e1\./);
  assert.equal(h.sites.isMarked("https://a.test/"), true);
  assert.equal((await h.call(A, "computer_click", { ref: "e1" })).text, "Clicked e1. Page: https://a.test/x");
  assert.equal(h.broker.pending().length, 0);
  assert.equal(b.clicks.length, 2);
});

test("Take over cancels a pending ask, and a late Allow does nothing", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.spots.set("e1", { target: btn("Next") });
  h.svc.select("ws:alpha");
  const p = h.call(A, "computer_click", { ref: "e1" });
  const ask = await h.asked();
  h.svc.takeOver();
  const r = await p;
  assert.match(r.text, /^Cancelled because the user took over: /);
  assert.equal(h.broker.pending().length, 0);
  h.svc.answer(ask.id, "once");
  await flush();
  assert.equal(b.clicks.length, 0);
  assert.deepEqual(h.wheel.holder("ws:alpha"), { kind: "user", resume: { session: "chat:a", label: "Alpha" } });
  assert.ok(h.notes.some(([k, l]) => k === "chat:a" && /took over/.test(l)));
});

test("allowed action is dropped when the page changed", async () => {
  for (const change of ["navigate", "retarget", "tab"] as const) {
    const h = make();
    const b = await h.open(A, "https://a.test/");
    b.spots.set("e1", { target: btn("Next") });
    const p = h.call(A, "computer_click", { ref: "e1" });
    const ask = await h.asked();
    if (change === "navigate") b.seq++;
    else if (change === "retarget") b.spots.set("e1", { target: btn("Delete everything") });
    else { b.pages.push({ url: "https://a.test/other", openedBy: null }); b.current = 1; }
    h.svc.answer(ask.id, "once");
    const r = await p;
    assert.equal(r.text, "The page changed while you waited: look again.", change);
    assert.equal(b.clicks.length, 0, change);
  }
});

test("turn end cancels the pending ask", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.spots.set("e1", { target: btn("Next") });
  const p = h.call(A, "computer_click", { ref: "e1" });
  await h.asked();
  h.svc.agentGone(A);
  assert.match((await p).text, /^Cancelled because the turn ended: /);
  assert.equal(h.wheel.holder("ws:alpha"), null);
  assert.equal(h.broker.pending().length, 0);
  assert.equal(b.clicks.length, 0);
});

test("waiting_for_user arrives at 45 s, and computer_wait gets the result", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.spots.set("e1", { target: btn("Next") });
  let done = false;
  const p = h.call(A, "computer_click", { ref: "e1" }).then((r) => { done = true; return r; });
  const ask = await h.asked();
  await h.clock.advance(44_000);
  assert.equal(done, false);
  await h.clock.advance(1_000);
  assert.equal((await p).text, `waiting_for_user: call computer_wait with askId "${ask.id}"`);
  assert.equal((await p).isError, undefined);
  assert.deepEqual(h.wheel.holder("ws:alpha"), { kind: "agent", session: "chat:a", label: "Alpha" }, "a pending ask reserves the wheel past 30 s idle");
  const w = h.call(A, "computer_wait", { askId: ask.id });
  await flush();
  assert.match((await h.call(B, "computer_wait", { askId: ask.id })).text, /another session/);
  h.svc.answer(ask.id, "once");
  assert.equal((await w).text, "Clicked e1. Page: https://a.test/");
  assert.equal(b.clicks.length, 1);
  assert.equal((await h.call(A, "computer_wait", { askId: ask.id })).text, "Clicked e1. Page: https://a.test/", "a later wait sees the same result");
});

test("computer_wait on a pending ask returns waiting_for_user again at its timeout", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.spots.set("e1", { target: btn("Next") });
  const p = h.call(A, "computer_click", { ref: "e1" });
  const ask = await h.asked();
  await h.clock.advance(45_000);
  await p;
  const w = h.call(A, "computer_wait", { askId: ask.id, timeoutSec: 5 });
  await h.clock.advance(5_000);
  assert.equal((await w).text, `waiting_for_user: call computer_wait with askId "${ask.id}"`);
  assert.match((await h.call(A, "computer_wait", { askId: "nope" })).text, /There is no ask "nope"/);
});

test("type stops between chunks after Take over, and after the turn ends", async () => {
  for (const stop of ["takeOver", "turnEnd"] as const) {
    const h = make();
    const b = await h.open(A, "http://localhost:5173/");
    b.focused = { target: box("Message"), shown: "Message", sensitive: false, plainTextarea: false };
    h.svc.select("ws:alpha");
    b.between = () => { b.between = null; if (stop === "takeOver") h.svc.takeOver(); else h.svc.agentGone(A); };
    const r = await h.call(A, "computer_type", { text: "abcdef" });
    assert.deepEqual(b.typed, ["ab"], stop);
    assert.match(r.text, /^Typing stopped part way/, stop);
    assert.equal(r.isError, true);
  }
});

test("disabled config refuses with the Settings line", async () => {
  const h = make({ enabled: false });
  for (const tool of ["computer_status", "computer_open", "computer_click", "computer_snapshot"] as const) {
    const r = await h.call(A, tool, { url: "https://a.test/", ref: "e1" });
    assert.equal(r.text, "The Computer pane is off (Settings › Computer).");
    assert.equal(r.isError, true);
  }
  assert.equal(h.wheel.holder("ws:alpha"), null);
});

test("a page-started navigation writes a note", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.hooks.note("The page went to https://b.test/next");
  assert.deepEqual(h.notes.at(-1), ["chat:a", "The page went to https://b.test/next"]);
  const line = h.lastState().log.at(-1)!;
  assert.equal(line.session, "the page"); assert.equal(line.text, "The page went to https://b.test/next");
});

// ---- the controller's requirements

test("ask titles use the scrubbed name, while the gate judges the raw one (D9)", async () => {
  const h = make();
  h.sites.mark("https://github.com");
  const b = await h.open(A, "https://github.com/o/r/pull/1");
  b.spots.set("e3", { target: btn("Delete item 3"), shown: "•••••• item 3" });
  const p = h.call(A, "computer_click", { ref: "e3" });
  const ask = await h.asked();
  assert.equal(ask.why, "delete", "the raw name asks as delete");
  assert.equal(ask.title, "Delete: Click “•••••• item 3” on github.com?");
  assert.ok(b.scrubs.some(([, tab]) => tab === 0), "other page-derived text is scrubbed with the action's tab");
  h.svc.answer(ask.id, "deny");
  const r = await p;
  const out = [ask.title, ask.detail, r.text, ...h.notes.map(([, l]) => l), ...h.states.flatMap((s) => s.log.map((l) => l.text))];
  for (const t of out) assert.ok(!t.includes("Delete item 3"), `raw name leaked into: ${t}`);
});

test("the ask labels state each category in app-written text", () => {
  assert.deepEqual(ASK_LABELS, {
    submit: "Submit", purchase: "Purchase", send: "Send", delete: "Delete", merge: "Merge", signin: "Sign in", download: "Download",
    unmarked: "Act on a site you haven't marked", return: "Press Return", file: "Choose a file", permission: "Grant a permission",
    frame: "Act inside a frame from another site",
  });
});

test("Always on a category ask allows every category of the name; a later ask is skipped only when all of its are allowed", async () => {
  const h = make();
  h.sites.mark("https://github.com");
  const b = await h.open(A, "https://github.com/o/r");
  b.spots.set("e1", { target: btn("Delete and merge") });
  b.spots.set("e2", { target: btn("Merge") });
  b.spots.set("e3", { target: btn("Merge and send") });
  b.spots.set("e4", { target: btn("Delete branch") });
  const p = h.call(A, "computer_click", { ref: "e1" });
  const ask = await h.asked();
  assert.equal(ask.title, "Delete: Click “Delete and merge” on github.com?");
  assert.equal(ask.always, true);
  h.svc.answer(ask.id, "always");
  assert.match((await p).text, /^Clicked e1\./);
  assert.equal(h.sites.categoryAllowed("https://github.com", "delete"), true);
  assert.equal(h.sites.categoryAllowed("https://github.com", "merge"), true);
  assert.match((await h.call(A, "computer_click", { ref: "e2" })).text, /^Clicked e2\./);
  assert.match((await h.call(A, "computer_click", { ref: "e4" })).text, /^Clicked e4\./);
  const p3 = h.call(A, "computer_click", { ref: "e3" });
  const ask3 = await h.asked();
  assert.equal(ask3.why, "send", "send is not allowed, so the ask stands");
  h.svc.answer(ask3.id, "deny");
  await p3;
});

test("return, file, download, permission and frame asks offer no Always; an always answer counts as once", async () => {
  const h = make();
  const b = await h.open(A, "http://localhost:3000/");
  b.focused = { target: box("Message"), shown: "Message", sensitive: false, plainTextarea: false };
  // Return in an ordinary field
  for (let i = 0; i < 2; i++) {
    const p = h.call(A, "computer_type", { text: "a\nb" });
    const ask = await h.asked();
    assert.equal(ask.why, "return"); assert.equal(ask.always, false);
    assert.equal(ask.title, "Press Return: Type 3 characters on 2 lines into “Message” on localhost:3000?");
    h.svc.answer(ask.id, "always");
    assert.match((await p).text, /^Typed 3 characters\./);
  }
  // A file input
  b.focused = { target: box("Upload", { fileInput: true }), shown: "Upload", sensitive: false, plainTextarea: false };
  const pf = h.call(A, "computer_type", { text: "x" });
  const af = await h.asked();
  assert.equal(af.why, "file"); assert.equal(af.always, false);
  h.svc.answer(af.id, "deny"); await pf;
  // A frame from another site, and a Download label
  b.spots.set("e1", { target: { role: "iframe", name: "Pay", inForm: false, fileInput: false, opaque: true } });
  b.spots.set("e2", { target: btn("Download PDF") });
  b.spots.set("e3", { target: btn("Delete and download") });
  for (const [ref, why] of [["e1", "frame"], ["e1", "frame"], ["e2", "download"], ["e2", "download"], ["e3", "delete"]] as const) {
    const p = h.call(A, "computer_click", { ref });
    const ask = await h.asked();
    assert.equal(ask.why, why); assert.equal(ask.always, false, `${ref} ${why}`);
    h.svc.answer(ask.id, "always");
    assert.match((await p).text, new RegExp(`^Clicked ${ref}\\.`));
  }
  for (const c of ["download", "delete"] as const) assert.equal(h.sites.categoryAllowed("http://localhost:3000", c), false);
  // Page-started downloads and permission prompts
  for (const why of ["download", "permission"] as const) {
    const pr = b.hooks.ask({ why, title: "Let localhost:3000 use camera?", detail: "d", site: "http://localhost:3000" });
    const ask = await h.asked();
    assert.equal(ask.always, false);
    h.svc.answer(ask.id, "always");
    assert.equal(await pr, true);
  }
  assert.deepEqual(h.sites.list(), []);
});

test("an ask that settles touches the wheel before the action is revalidated", async () => {
  for (const answer of ["once", "deny"] as const) {
    const h = make();
    const b = await h.open(A, "https://a.test/");
    b.spots.set("e1", { target: btn("Next") });
    const touch = h.wheel.touch.bind(h.wheel);
    h.wheel.touch = (c: string, s: string) => { b.order.push(`touch ${c} ${s}`); touch(c, s); };
    const p = h.call(A, "computer_click", { ref: "e1" });
    const ask = await h.asked();
    await h.clock.advance(100_000);
    assert.match((await p).text, /^waiting_for_user/);
    b.order.length = 0;
    h.svc.answer(ask.id, answer);
    await h.call(A, "computer_wait", { askId: ask.id });
    assert.equal(b.order[0], "touch ws:alpha chat:a", answer);
    if (answer === "once") assert.deepEqual(b.order.slice(1, 3), ["resolve", "click"]);
    // Held from the settle (t = 100 s) for 30 s: still held at 125 s, though the idle timer last armed at 90 s.
    await h.clock.advance(25_000);
    assert.notEqual(h.wheel.holder("ws:alpha"), null, answer);
    await h.clock.advance(10_000);
    assert.equal(h.wheel.holder("ws:alpha"), null, answer);
  }
});

test("page-event asks go to the session holding the wheel, or to the page, and never reserve the wheel for another agent", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  const pr = b.hooks.ask({ why: "download", title: "Download hunter2.pdf from a.test?", detail: "hunter2.pdf, into Downloads", site: "https://a.test" });
  const ask = await h.asked();
  assert.equal(ask.session, "chat:a"); assert.equal(ask.sessionLabel, "Alpha");
  assert.equal(ask.title, "Download: Download •••••••.pdf from a.test?");
  assert.equal(ask.detail, "•••••••.pdf, into Downloads");
  h.svc.answer(ask.id, "once");
  assert.equal(await pr, true);

  h.svc.agentGone(A);
  const pr2 = b.hooks.ask({ why: "permission", title: "Let a.test use camera?", detail: "The page asked.", site: "https://a.test" });
  const ask2 = await h.asked();
  assert.equal(ask2.session, "page"); assert.equal(ask2.sessionLabel, "the page");
  assert.equal(ask2.title, "Grant a permission: Let a.test use camera?");
  assert.equal(h.wheel.holder("ws:alpha"), null);
  await h.open(B, "https://a.test/b");
  assert.equal(h.svc.reserved("ws:alpha"), false);
  await h.clock.advance(31_000);
  assert.equal(h.wheel.holder("ws:alpha"), null, "the page's ask does not hold the wheel for Beta");
  h.svc.answer(ask2.id, "deny");
  assert.equal(await pr2, false);
});

test("agentGone ends the session's turn and cancels only its asks", async () => {
  const h = make();
  const B2 = agent("chat:b", "Beta", "edit", "ws:beta");
  const ba = await h.open(A, "https://a.test/");
  const bb = await h.open(B2, "https://b.test/");
  ba.spots.set("e1", { target: btn("Next") }); bb.spots.set("e1", { target: btn("Next") });
  const pa = h.call(A, "computer_click", { ref: "e1" });
  await h.asked(1);
  const pb = h.call(B2, "computer_click", { ref: "e1" });
  const askB = await h.asked(2);
  h.svc.agentGone(A);
  assert.match((await pa).text, /turn ended/);
  assert.deepEqual(h.broker.pending().map((x) => x.id), [askB.id]);
  assert.equal(h.wheel.holder("ws:alpha"), null);
  assert.deepEqual(h.wheel.holder("ws:beta"), { kind: "agent", session: "chat:b", label: "Beta" });
  h.svc.answer(askB.id, "once");
  assert.match((await pb).text, /^Clicked e1\./);
});

test("while the user drives, acting tools are busy and look tools work; Hand back returns the wheel", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.text = "ok";
  h.svc.select("ws:alpha");
  h.svc.takeOver();
  const r = await h.call(A, "computer_scroll", { dy: 100 });
  assert.equal(r.text, "busy: the user is driving: wait for Hand back.");
  assert.match((await h.call(A, "computer_snapshot")).text, /ok/);
  h.svc.handBack();
  assert.deepEqual(h.wheel.holder("ws:alpha"), { kind: "agent", session: "chat:a", label: "Alpha" });
  assert.ok(h.notes.some(([k, l]) => k === "chat:a" && /handed .*back/.test(l)));
  assert.equal((await h.call(A, "computer_scroll", { dy: 100 })).text, "Scrolled by (0, 100). Page: https://a.test/");
});

test("acting replies end with the active tab's URL, and a screenshot is an image with one line", async () => {
  const h = make();
  h.sites.mark("https://a.test");
  const b = await h.open(A, "https://a.test/");
  assert.equal((await h.call(A, "computer_open", { url: "https://a.test/two", newTab: true })).text, "Opened the page. Page: https://a.test/two");
  assert.equal(b.pages[1].openedBy, "Alpha");
  b.spots.set("e1", { target: btn("Next") });
  b.focused = { target: box("Search"), shown: "Search", sensitive: false, plainTextarea: false };
  for (const [tool, args] of [["computer_click", { ref: "e1" }], ["computer_type", { text: "hi" }], ["computer_key", { key: "Tab" }], ["computer_scroll", { dy: 5, ref: "e1" }]] as const) {
    const r = await h.call(A, tool, args);
    assert.ok(r.text.endsWith(" Page: https://a.test/two"), `${tool}: ${r.text}`);
  }
  assert.deepEqual(b.keys, ["Tab"]); assert.deepEqual(b.typed, ["hi"]); assert.deepEqual(b.scrolls, [{ dx: 0, dy: 5, at: 7 }]);
  const shot = await h.call(A, "computer_screenshot", { tab: 0 });
  assert.deepEqual(shot.image, { data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" });
  assert.ok(!shot.text.includes("\n") && shot.text.includes("https://a.test/"), shot.text);
});

test("computer_status reports the place, driver, access, pane, tabs and pending asks", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.spots.set("e1", { target: btn("Next") });
  const p = h.call(A, "computer_click", { ref: "e1" });
  const ask = await h.asked();
  let s = (await h.call(A, "computer_status")).text;
  assert.match(s, /^Computer: ws:alpha$/m);
  assert.match(s, /^Driving: this session \(Alpha\)$/m);
  assert.match(s, /^Access: /m);
  assert.match(s, /^Pane: off screen$/m);
  assert.match(s, /^ {2}\[0\] \(active\) https:\/\/a\.test\/ opened by Alpha$/m);
  assert.ok(s.includes(`${ask.id} ${ask.title} (Alpha)`), s);
  h.svc.select("ws:alpha"); h.svc.show({ x: 0, y: 0, width: 400, height: 300 });
  s = (await h.call(A, "computer_status")).text;
  assert.match(s, /^Pane: on screen$/m);
  assert.match((await h.call(agent("chat:r", "Reader", "read"), "computer_status")).text, /Access: read only/);
  h.svc.answer(ask.id, "deny"); await p;
});

test("computer_wait with text re-reads the page every 500 ms until the text appears or the time is up", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.text = "Loading";
  const w = h.call(B, "computer_wait", { text: "Done", timeoutSec: 5 });
  await h.clock.advance(1_000);
  b.text = "Done!";
  await h.clock.advance(500);
  assert.match((await w).text, /^“Done” is on the page now/);
  const w2 = h.call(B, "computer_wait", { text: "Never", timeoutSec: 2 });
  await h.clock.advance(2_000);
  assert.match((await w2).text, /^“Never” did not appear within 2 s\./);
  const w3 = h.call(B, "computer_wait", { text: "a.test", timeoutSec: 1 });
  await h.clock.advance(1_000);
  assert.match((await w3).text, /did not appear/, "the wrapper's url attribute is not page text");
});

test("typing into a ref clicks it and types under one ask; a password field is refused", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.spots.set("e5", { target: box("Search"), focuses: true });
  const p = h.call(A, "computer_type", { text: "hi", ref: "e5" });
  const ask = await h.asked();
  assert.equal(ask.title, "Act on a site you haven't marked: Type 2 characters into “Search” on a.test?");
  h.svc.answer(ask.id, "once");
  assert.match((await p).text, /^Typed 2 characters\./);
  assert.equal(b.clicks.length, 1); assert.deepEqual(b.typed, ["hi"]);
  b.focused = { target: box("Password"), shown: "Password", sensitive: true, plainTextarea: false };
  const r = await h.call(A, "computer_type", { text: "x" });
  assert.equal(r.text, "Typing into a password field is refused (D9).");
});

test("Space on a focused category control asks as a click on it", async () => {
  const h = make();
  h.sites.mark("https://a.test");
  const b = await h.open(A, "https://a.test/");
  b.focused = { target: btn("Delete repo"), shown: "Delete repo", sensitive: false, plainTextarea: false };
  const p = h.call(A, "computer_key", { key: "Space" });
  const ask = await h.asked();
  assert.equal(ask.title, "Delete: Press Space with “Delete repo” focused on a.test?");
  h.svc.answer(ask.id, "once");
  assert.equal((await p).text, "Pressed Space. Page: https://a.test/");
});

test("bad arguments and refused URLs are answered without taking the wheel", async () => {
  const h = make();
  assert.equal((await h.call(A, "computer_click", {})).text, "Give either ref, or both x and y.");
  assert.equal((await h.call(A, "computer_open", { url: "javascript:alert(1)" })).text, "Only http and https pages open.");
  assert.equal(h.wheel.holder("ws:alpha"), null);
  assert.match((await h.call(A, "computer_snapshot")).text, /No page is open/);
});

test("the pane's calls: select, show, navigate, tabs, mark and state", async () => {
  const h = make();
  assert.equal(h.svc.select(null), null);
  const s0 = h.svc.select("ws:alpha")!;
  assert.deepEqual({ place: s0.place, tabs: s0.tabs, holder: s0.holder, marked: s0.marked, poppedOut: s0.poppedOut }, { place: "ws:alpha", tabs: [], holder: null, marked: false, poppedOut: false });
  assert.deepEqual(await h.svc.navigate("file:///etc/passwd"), { ok: false, error: "Only http and https pages open.", code: "EROFS" });
  assert.deepEqual(await h.svc.navigate("https://a.test/"), { ok: true, data: null });
  const b = h.b();
  assert.equal(b.pages[0].openedBy, null);
  h.svc.show({ x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(b.shows.at(-1), { x: 1, y: 2, width: 3, height: 4 });
  h.svc.tab({ kind: "new" });
  await flush();
  assert.equal(b.pages.length, 2);
  h.svc.tab({ kind: "select", index: 0 });
  assert.equal(b.current, 0);
  h.svc.tab({ kind: "close", index: 9 });
  h.svc.mark("https://a.test", true);
  assert.equal(h.lastState().marked, true);
  h.svc.mark("https://a.test", false);
  assert.equal(h.lastState().marked, false);
  h.svc.popOut();
  assert.equal(h.lastState().poppedOut, true);
  h.svc.select("ws:beta");
  assert.equal(b.shows.at(-1), null, "the computer no longer selected is parked");
});

test("an action queued behind another is not delivered once the user has taken over", async () => {
  const h = make();
  h.sites.mark("https://a.test");
  const b = await h.open(A, "https://a.test/");
  b.spots.set("e1", { target: btn("Next") });
  b.focused = { target: box("Search"), shown: "Search", sensitive: false, plainTextarea: false };
  h.svc.select("ws:alpha");
  b.between = () => { b.between = null; h.svc.takeOver(); };
  const typing = h.call(A, "computer_type", { text: "abcd" });
  const click = h.call(A, "computer_click", { ref: "e1" });
  assert.match((await typing).text, /^Typing stopped part way/);
  assert.equal((await click).text, "busy: the user is driving: wait for Hand back.");
  assert.equal(b.clicks.length, 0);
});

test("an unmarked ask on a Download-labelled control still offers Always, which marks the site only", async () => {
  const h = make();
  const b = await h.open(A, "https://a.test/");
  b.spots.set("e1", { target: btn("Download PDF") });
  const p = h.call(A, "computer_click", { ref: "e1" });
  const ask = await h.asked();
  assert.equal(ask.why, "unmarked"); assert.equal(ask.always, true);
  h.svc.answer(ask.id, "always");
  assert.match((await p).text, /^Clicked e1\./);
  assert.equal(h.sites.isMarked("https://a.test/"), true);
  assert.equal(h.sites.categoryAllowed("https://a.test", "download"), false);
  const p2 = h.call(A, "computer_click", { ref: "e1" });
  const ask2 = await h.asked();
  assert.equal(ask2.why, "download"); assert.equal(ask2.always, false);
  h.svc.answer(ask2.id, "deny"); await p2;
});
