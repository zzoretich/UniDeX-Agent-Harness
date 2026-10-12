import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { parseBrainHub, parseMemory, type BrainMemory, type FixResult, type HubDup, type MemoryVerb } from "../../data/brainModel";
import type * as Health from "./HealthMode";
import type { BrainCtx, BrainData } from "./types";

// HealthMode draws with Obsidian's DOM helpers and Notice, and asks through FixModal: under node:test "obsidian"
// resolves to a stub, FixModal to a stand-in whose answer each test sets, and the page is a small fake DOM with just
// what the mode uses, so its actions can be driven through ctx without the app.
const notices: string[] = [];
const STUB = "obsidian-stub";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
class Stub {}
require.cache[STUB] = {
  id: STUB, filename: STUB, loaded: true,
  exports: { setIcon: () => {}, Modal: Stub, FuzzySuggestModal: Stub, Notice: class { constructor(m: string) { notices.push(m); } } },
} as unknown as NodeJS.Module;
let fixAnswer: () => Promise<boolean> = async () => true;
const asked: FixResult[] = [];
const FIX_MODAL = require.resolve("./FixModal");
require.cache[FIX_MODAL] = {
  id: FIX_MODAL, filename: FIX_MODAL, loaded: true,
  exports: { FixModal: { ask: (_app: unknown, o: { result: FixResult }) => { asked.push(o.result); return fixAnswer(); } } },
} as unknown as NodeJS.Module;

// ── a fake DOM: elements, attributes, the selectors the mode uses (one descendant step included), focus, clicks ──

interface FakeDoc { activeElement: FakeEl | null; body: FakeEl | null }
type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
class FakeEl {
  children: Array<FakeEl | string> = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  listeners = new Map<string, Array<(e: unknown) => void>>();
  style: Record<string, string> = {};
  scrollTop = 0;
  constructor(public tagName: string, public ownerDocument: FakeDoc) {}
  createEl(tag: string, o: Opts = {}): FakeEl {
    const el = new FakeEl(tag.toUpperCase(), this.ownerDocument);
    for (const c of (o.cls ?? "").split(/\s+/).filter(Boolean)) el.classes.add(c);
    if (o.text !== undefined) el.children.push(o.text);
    for (const [k, v] of Object.entries(o.attr ?? {})) el.attrs.set(k, String(v));
    el.parent = this;
    this.children.push(el);
    return el;
  }
  createDiv(o: Opts = {}): FakeEl { return this.createEl("div", o); }
  createSpan(o: Opts = {}): FakeEl { return this.createEl("span", o); }
  empty(): void {
    if (this.ownerDocument.activeElement && this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.children = [];
  }
  setAttr(k: string, v: string): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  addEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(type: string, e: Record<string, unknown> = {}): void { for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() {}, detail: 1, ...e }); }
  click(): void { this.fire("click"); }
  focus(): void { this.ownerDocument.activeElement = this; }
  scrollIntoView(): void {}
  get elements(): FakeEl[] { return this.children.filter((c): c is FakeEl => typeof c !== "string"); }
  get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  contains(x: FakeEl | null): boolean { for (let e: FakeEl | null = x; e; e = e.parent) if (e === this) return true; return false; }
  matches(sel: string): boolean {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel.trim());
    if (m) return this.attrs.has(m[1]) && (m[2] === undefined || this.attrs.get(m[1]) === m[2]);
    if (sel.startsWith(".")) return this.classes.has(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  closest(sel: string): FakeEl | null { for (let e: FakeEl | null = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
  querySelectorAll<T = FakeEl>(sel: string): T[] {
    const steps = sel.trim().split(/\s+(?![^[]*\])/);
    let from: FakeEl[] = [this];
    for (const s of steps) {
      const out: FakeEl[] = [];
      const walk = (e: FakeEl): void => { for (const c of e.elements) { if (c.matches(s) && !out.includes(c)) out.push(c); walk(c); } };
      for (const f of from) walk(f);
      from = out;
    }
    return from as unknown as T[];
  }
  querySelector<T = FakeEl>(sel: string): T | null { return (this.querySelectorAll<T>(sel)[0] ?? null); }
}
const g = globalThis as unknown as Record<string, unknown>;
g.HTMLElement = FakeEl;
g.window = { setTimeout: () => 0, clearTimeout: () => {} };

const { HealthMode } = require("./HealthMode") as typeof Health;

// ── a store: four memories, two duplicate pairs, one legacy source label ──

const P = (type: string, slug: string): string => `brain/memory/${type}/${slug}.md`;
const mem = (type: string, slug: string, title: string): string =>
  ["---", "type: memory", `tags: [memory/${type}, status/active]`, "created: 2026-10-01", "---", "", `# ${title}`, "", "Body.", ""].join("\n");
const A = P("feedback", "small-diffs"), B = P("feedback", "small-diffs-in-review"), C = P("reference", "tide-api"), D = P("reference", "tide-api-notes");

function data(): BrainData {
  const memories = [[A, "Prefer small diffs"], [B, "Prefer small diffs in review"], [C, "Tide API"], [D, "Tide API notes"]]
    .map(([p, t]) => parseMemory(p, mem(p.split("/")[2], p.split("/")[3].replace(/\.md$/, ""), t))).filter((m): m is BrainMemory => !!m);
  const pairs: HubDup[] = [{ a: A, b: B, score: 0.92, title: 0.8, text: 0.8, meaning: null }, { a: C, b: D, score: 0.88, title: 0.7, text: 0.8, meaning: null }];
  return {
    now: new Date(2026, 9, 11, 12), memories, byPath: new Map(memories.map((m) => [m.path, m])), drafts: [], patterns: [], reflections: [],
    hub: parseBrainHub(JSON.stringify({ schema: 1, builtAt: "2026-10-11T10:00:00.000Z", dups: pairs, hygiene: { sources: { session: 1 } } })),
    sources: null, trail: [], written: new Map(), index: new Map(), pairs, flags: new Map(), batches: [], map: null,
    session: null, wake: null, indexRaw: null, settings: { telemetry: true, graph: true, neverUsedDays: 30, mapMin: 8, wrapHint: "$agenticos:wrap" },
  };
}

const EXPECT = "0123456789abcdef0123456789abcdef";
const DRY: FixResult = { kind: "sources", dryRun: true, files: 1, brainMd: null, expect: EXPECT, changes: [{ path: A, action: "source", before: "session", after: "manual-wrap" }] };

function harness(d: BrainData, o: { run?: (v: MemoryVerb) => Promise<{ ok: boolean; reason?: string; stale?: boolean }>; preview?: () => Promise<unknown> } = {}) {
  const doc: FakeDoc = { activeElement: null, body: null };
  doc.body = new FakeEl("BODY", doc);
  const host = doc.body.createDiv();
  const calls = { runs: [] as MemoryVerb[], previews: [] as MemoryVerb[], shows: [] as unknown[], rescans: 0, dismissed: [] as string[][] };
  const ctx = {
    plugin: { app: {} },
    data: () => d,
    run: async (v: MemoryVerb) => {
      calls.runs.push(v);
      const r = o.run ? await o.run(v) : { ok: true };
      return r.ok ? { ok: true, json: { ...DRY, dryRun: false } } : { ok: false, reason: r.reason ?? "no", refused: false, outdated: false, stale: !!r.stale };
    },
    preview: async (v: MemoryVerb) => { calls.previews.push(v); return { ok: true, json: o.preview ? await o.preview() : DRY }; },
    rescan: () => { calls.rescans++; },
    show: (t: unknown) => { calls.shows.push(t); },
    dismissPair: (a: string, b: string) => { calls.dismissed.push([a, b]); },
  } as unknown as BrainCtx;
  const mode = new HealthMode(ctx);
  mode.mount(host as unknown as HTMLElement);
  const q = (sel: string): FakeEl[] => host.querySelectorAll(sel);
  return { host, doc, mode, calls, q };
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => { let resolve: (v: T) => void = () => {}; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

// ── tests ──

test("Compare lands Review on that row's pair, whichever row it is", () => {
  const h = harness(data());
  const compares = h.q('[data-act="compare"]');
  assert.equal(compares.length, 2);
  compares[1].click();
  assert.deepEqual(h.calls.shows.pop(), { mode: "review", queue: "duplicates", pair: { a: C, b: D } });
  compares[0].click();
  assert.deepEqual(h.calls.shows.pop(), { mode: "review", queue: "duplicates", pair: { a: A, b: B } });
});

test("Not duplicates: the row stays, busy, until notdup answers, so a double-click's second click never dismisses the next pair", async () => {
  const gate = deferred<{ ok: boolean }>();
  const h = harness(data(), { run: () => gate.promise });
  h.q('[data-act="notdup"]')[0].click();
  assert.deepEqual(h.calls.runs, [{ verb: "notdup", a: A, b: B }]);
  const rows = h.q("[data-pair]");
  assert.equal(rows.length, 2, "both pairs still listed while the verb runs");
  const busy = h.q('[data-act="notdup"]')[0];
  assert.deepEqual([busy.getAttribute("aria-disabled"), busy.textContent], ["true", "Marking…"]);
  // The second click of the double-click, on the same spot: the busy button, which ignores it. Even one landing on the
  // next pair's button with detail 2 is not an action.
  busy.fire("click", { detail: 2 });
  h.q('[data-act="notdup"]')[1].fire("click", { detail: 2 });
  busy.click();
  assert.equal(h.calls.runs.length, 1, "only the pair the person clicked");
  gate.resolve({ ok: true });
  await tick();
  assert.deepEqual(h.q("[data-pair]").map((r) => r.getAttribute("data-a")), [C], "it goes once the verb answered");
  assert.deepEqual(h.calls.dismissed, [[A, B]]);
});

test("Hygiene names /wrap as this machine's hosts invoke it", () => {
  const h = harness(data());
  const row = h.q('[data-fix="sources"]').find((x) => x.classes.has("aos-brain-hl-hyg"))!;
  assert.match(row.textContent, /where \$agenticos:wrap writes manual-wrap/);
  assert.doesNotMatch(row.textContent, /\/wrap/);
});

test("a fix's confirm runs it pinned to the preview (expect), even when the person moved to another mode meanwhile", async () => {
  const answer = deferred<boolean>();
  fixAnswer = () => answer.promise;
  const h = harness(data());
  h.q('[data-fix="sources"]').find((x) => x.tagName === "BUTTON")!.click();
  await tick();
  assert.deepEqual(h.calls.previews, [{ verb: "fix", kind: "sources", dryRun: true }]);
  assert.equal(asked.length, 1, "the dialog shows the dry run");
  h.mode.unmount();
  answer.resolve(true);
  await tick();
  assert.deepEqual(h.calls.runs, [{ verb: "fix", kind: "sources", dryRun: false, expect: EXPECT }], "it ran, with the preview's hash");
  assert.match(notices.pop() ?? "", /^Normalise source labels: changed 1 file/);
  fixAnswer = async () => true;
});

test("a fix whose dry run ends after the person left Health opens no dialog over the other mode", async () => {
  const pre = deferred<unknown>();
  const h = harness(data(), { preview: () => pre.promise });
  const before = asked.length;
  h.q('[data-fix="sources"]').find((x) => x.tagName === "BUTTON")!.click();
  h.mode.unmount();
  pre.resolve(DRY);
  await tick();
  assert.equal(asked.length, before);
  assert.deepEqual(h.calls.runs, []);
});

test("the runtime refusing a stale preview (the files changed under the dialog): nothing ran, and the page rescans", async () => {
  const h = harness(data(), { run: async () => ({ ok: false, reason: "the files changed since it was read: check again", stale: true }) });
  h.q('[data-fix="sources"]').find((x) => x.tagName === "BUTTON")!.click();
  await tick(); await tick();
  assert.equal(h.calls.runs.length, 1);
  assert.equal(h.calls.rescans, 1);
});
