import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { parseBrainHub, parseMemory, type BrainMemory, type HubDup } from "../../data/brainModel";
import type * as Review from "./ReviewMode";
import type { BrainCtx, BrainData } from "./types";

// ReviewMode draws with Obsidian's DOM helpers, setIcon and Notice: under node:test "obsidian" resolves to a stub and the
// page is a small fake DOM, so reveal() can be driven as Health's Compare drives it.
const STUB = "obsidian-stub";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
class Stub {}
require.cache[STUB] = {
  id: STUB, filename: STUB, loaded: true, exports: { setIcon: () => {}, Modal: Stub, Notice: class { constructor(_m: string) {} } },
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
  removeAttribute(k: string): void { this.attrs.delete(k); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
  toggleClass(c: string, on: boolean): void { if (on) this.classes.add(c); else this.classes.delete(c); }
  addClass(c: string): void { this.classes.add(c); }
  removeClass(c: string): void { this.classes.delete(c); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  hidden = false;
  appendText(t: string): void { this.children.push(t); }
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

const { ReviewMode } = require("./ReviewMode") as typeof Review;

const P = (type: string, slug: string): string => `brain/memory/${type}/${slug}.md`;
const mem = (title: string, created: string): string =>
  ["---", "type: memory", "tags: [memory/feedback, status/active]", `created: ${created}`, "reviewed: true", "---", "", `# ${title}`, "", "Body.", ""].join("\n");
const A = P("feedback", "small-diffs"), B = P("feedback", "small-diffs-in-review"), C = P("feedback", "tide-api"), D = P("feedback", "tide-api-notes");

function data(): BrainData {
  const memories = ([[A, "Prefer small diffs", "2026-09-01"], [B, "Prefer small diffs in review", "2026-09-20"], [C, "Tide API", "2026-08-01"], [D, "Tide API notes", "2026-09-10"]] as const)
    .map(([p, t, c]) => parseMemory(p, mem(t, c))).filter((m): m is BrainMemory => !!m);
  const pairs: HubDup[] = [{ a: A, b: B, score: 0.92, title: 0.8, text: 0.8, meaning: null }, { a: C, b: D, score: 0.88, title: 0.7, text: 0.8, meaning: null }];
  return {
    now: new Date(2026, 9, 11, 12), memories, byPath: new Map(memories.map((m) => [m.path, m])), drafts: [], patterns: [], reflections: [],
    hub: parseBrainHub(JSON.stringify({ schema: 1, builtAt: "2026-10-11T10:00:00.000Z", dups: pairs })),
    sources: null, trail: [], written: new Map(), index: new Map(), pairs, flags: new Map(), batches: [], map: null,
    session: null, wake: null, indexRaw: null, settings: { telemetry: true, graph: true, neverUsedDays: 30, mapMin: 8, wrapHint: "/wrap" },
  };
}

test("reveal with a pair (Health's Compare) selects that pair in the Duplicates queue, whichever was selected before", () => {
  const doc: FakeDoc = { activeElement: null, body: null };
  doc.body = new FakeEl("BODY", doc);
  const host = doc.body.createDiv();
  const d = data();
  const mode = new ReviewMode({ data: () => d, run: async () => ({ ok: true, json: {} }), show: () => {}, markReviewSeen: () => {} } as unknown as BrainCtx);
  mode.mount(host as unknown as HTMLElement);
  const shown = (): [string | null, string | null] => { const p = host.querySelector(".aos-brain-rv-pair")!; return [p.getAttribute("data-a"), p.getAttribute("data-b")]; };
  mode.reveal({ mode: "review", queue: "duplicates", pair: { a: C, b: D } });
  assert.deepEqual(shown(), [C, D], "the second pair, not the first");
  mode.reveal({ mode: "review", queue: "duplicates", pair: { a: B, b: A } });
  assert.deepEqual(shown(), [A, B], "either order names the same pair");
  // A pair no longer listed (dismissed since): the queue's first.
  mode.reveal({ mode: "review", queue: "duplicates", pair: { a: C, b: P("feedback", "gone") } });
  assert.deepEqual(shown(), [A, B]);
});
