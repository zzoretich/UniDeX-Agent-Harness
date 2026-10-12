import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { DEFAULT_LIBRARY_FILTER, libraryRows, parseBrainHub, parseMemory, type BrainMemory, type LibraryFilter, type MemoryVerb } from "../../data/brainModel";
import type { TrailEntry } from "../../data/promoteTrail";
import type * as Library from "./LibraryMode";
import type * as Context from "./ContextPane";
import type { BrainCtx, BrainData } from "./types";

// LibraryMode.ts and the reader it builds draw with Obsidian's setIcon and MarkdownRenderer, and the obsidian package
// ships types only: under node:test "obsidian" resolves to a stub, so the mode's pure part loads without a DOM, and the
// context pane draws into a small fake DOM.
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
  exports: { setIcon: () => {}, Component: Stub, Notice: class { constructor(m: string) { notices.push(m); } }, MarkdownRenderer: { render: async () => {} } },
} as unknown as NodeJS.Module;
const { filterForUse } = require("./LibraryMode") as typeof Library;
const { LibraryContext, undoDaysLeft } = require("./ContextPane") as typeof Context;

const P = (type: string, slug: string): string => `brain/memory/${type}/${slug}.md`;
const mem = (type: string, slug: string, title: string, o: { tags?: string; source?: string; updated?: string } = {}): string =>
  ["---", "type: memory", `tags: [memory/${type}${o.tags ? `, ${o.tags}` : ""}]`, "created: 2026-09-01", `updated: ${o.updated ?? "2026-09-01"}`,
    ...(o.source ? [`source: ${o.source}`] : []), "---", "", `# ${title}`, "", `The body of ${slug}.`, ""].join("\n");

test("filterForUse: Memories, live, the use, Type and Source cleared, the query kept", () => {
  const f: LibraryFilter = { kind: "patterns", query: "tide", type: "feedback", status: "archived", source: "auto-wrap", use: "used" };
  assert.deepEqual(filterForUse(f, "unused"), { kind: "memories", query: "tide", type: null, status: "live", source: null, use: "unused" });
  assert.deepEqual(filterForUse(DEFAULT_LIBRARY_FILTER, "unused"), { ...DEFAULT_LIBRARY_FILTER, use: "unused" });
  assert.deepEqual(filterForUse(f, "any"), { ...DEFAULT_LIBRARY_FILTER, query: "tide" });
  assert.equal(f.use, "used", "the filter it was given is left as it was");
});

test("a use link lands on the live memories no session used in 30 days, whatever the facets were", () => {
  const files: Record<string, string> = {
    [P("feedback", "ask-first")]: mem("feedback", "ask-first", "Ask first", { source: "auto-wrap", updated: "2026-09-20" }),
    [P("reference", "tide-table")]: mem("reference", "tide-table", "Tide table", { updated: "2026-09-10" }),
    [P("projects", "kite-build")]: mem("projects", "kite-build", "Kite build", { updated: "2026-09-15" }),
    [P("projects", "old-kite")]: mem("projects", "old-kite", "Old kite", { tags: "status/archived" }),
  };
  const memories = Object.entries(files).map(([p, t]) => parseMemory(p, t)).filter((m): m is BrainMemory => !!m);
  const data = { memories, drafts: [], patterns: [], reflections: [] };
  const hub = parseBrainHub(JSON.stringify({ schema: 1, usage: { since: "2026-09-01T00:00:00Z", paths: { [P("feedback", "ask-first")]: { d30: 4 } } } }));
  // Narrowed to feedback from auto-wrap, the never-used ones would all be hidden; the link clears those facets.
  const before: LibraryFilter = { ...DEFAULT_LIBRARY_FILTER, type: "feedback", source: "auto-wrap" };
  assert.deepEqual(libraryRows(data, { ...before, use: "unused" }, hub).map((r) => r.title), []);
  const rows = libraryRows(data, filterForUse(before, "unused"), hub);
  assert.deepEqual(rows.map((r) => [r.title, r.useLabel]), [["Kite build", "unused"], ["Tide table", "unused"]]);
  assert.ok(!rows.some((r) => r.path === P("projects", "old-kite")), "an archived memory is not live");
  // The header's search still narrows them.
  assert.deepEqual(libraryRows(data, filterForUse({ ...before, query: "tide" }, "unused"), hub).map((r) => r.title), ["Tide table"]);
});

// ── Undo merge (brain-ai A2): the context pane's history, in a fake DOM ──

interface FakeDoc { activeElement: FakeEl | null; body: FakeEl | null }
type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
class FakeEl {
  nodes: Array<FakeEl | string> = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  listeners = new Map<string, Array<(e: unknown) => void>>();
  scrollTop = 0;
  constructor(public tagName: string, public ownerDocument: FakeDoc) {}
  createEl(tag: string, o: Opts = {}): FakeEl {
    const el = new FakeEl(tag.toUpperCase(), this.ownerDocument);
    for (const c of (o.cls ?? "").split(/\s+/).filter(Boolean)) el.classes.add(c);
    if (o.text !== undefined) el.nodes.push(o.text);
    for (const [k, v] of Object.entries(o.attr ?? {})) el.attrs.set(k, String(v));
    el.parent = this;
    this.nodes.push(el);
    return el;
  }
  createDiv(o: Opts = {}): FakeEl { return this.createEl("div", o); }
  createSpan(o: Opts = {}): FakeEl { return this.createEl("span", o); }
  empty(): void { this.nodes = []; }
  remove(): void { if (this.parent) this.parent.nodes = this.parent.nodes.filter((x) => x !== this); this.parent = null; }
  setAttr(k: string, v: string): void { this.attrs.set(k, String(v)); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  addEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  click(): void { for (const fn of this.listeners.get("click") ?? []) fn({ preventDefault() {}, detail: 1 }); }
  focus(): void { this.ownerDocument.activeElement = this; }
  get children(): FakeEl[] { return this.nodes.filter((c): c is FakeEl => typeof c !== "string"); }
  get textContent(): string { return this.nodes.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  contains(x: FakeEl | null): boolean { for (let e: FakeEl | null = x; e; e = e.parent) if (e === this) return true; return false; }
  matches(sel: string): boolean {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel.trim());
    if (m) return this.attrs.has(m[1]) && (m[2] === undefined || this.attrs.get(m[1]) === m[2]);
    if (sel.startsWith(".")) return this.classes.has(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll<T = FakeEl>(sel: string): T[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => { for (const c of e.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out as unknown as T[];
  }
  querySelector<T = FakeEl>(sel: string): T | null { return (this.querySelectorAll<T>(sel)[0] ?? null); }
}

const SMALL = P("feedback", "small-diffs"), REVIEW = P("feedback", "small-diffs-in-review");
const flush = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

function contextHarness(o: { trail?: (m: BrainMemory) => TrailEntry[]; confirm?: boolean } = {}) {
  const doc: FakeDoc = { activeElement: null, body: null };
  doc.body = new FakeEl("BODY", doc);
  const m = parseMemory(SMALL, mem("feedback", "small-diffs", "Prefer small diffs"))!;
  const row = (action: string, ts: string, extra: Record<string, unknown> = {}): TrailEntry =>
    ({ ts, session: "", action, slug: "small-diffs", type: "feedback", title: "Prefer small diffs", ...extra }) as unknown as TrailEntry;
  const trail = o.trail ? o.trail(m) : [row("merged", "2026-10-10T12:00:00.000Z", { from: [REVIEW], record: "20261010-120000-abcd1234", hash: m.hash })];
  const d = { now: new Date("2026-10-12T12:00:00.000Z"), memories: [m], byPath: new Map([[m.path, m]]), drafts: [], patterns: [], reflections: [], pairs: [], trail, hub: null } as unknown as BrainData;
  const runs: MemoryVerb[] = [];
  const confirms: Array<[string, string]> = [];
  const ctx = {
    data: () => d, plugin: { telemetryOn: () => true },
    confirm: async (title: string, message: string) => { confirms.push([title, message]); return o.confirm ?? true; },
    run: async (v: MemoryVerb) => { runs.push(v); return { ok: true, json: { path: SMALL, restored: [REVIEW], record: "20261010-120000-abcd1234", hash: "f".repeat(64), brainMd: null } }; },
  } as unknown as BrainCtx;
  const links = { known: () => [], backlinks: async () => [] };
  const pane = new LibraryContext(doc.body.createDiv() as unknown as HTMLElement, ctx, links as never, { open: () => {} });
  pane.show({ kind: "memories", m });
  const history = (pane.el as unknown as FakeEl).querySelector('[data-section="history"]')!;
  return { m, row, runs, confirms, history, button: () => history.querySelector('[data-action="unmerge"]') };
}

test("undoDaysLeft: whole days until the merge record is pruned, at least one", () => {
  const now = new Date("2026-10-12T12:00:00.000Z");
  assert.equal(undoDaysLeft("2026-10-12T11:00:00.000Z", now), 30);
  assert.equal(undoDaysLeft("2026-10-10T12:00:00.000Z", now), 28);
  assert.equal(undoDaysLeft("2026-09-12T13:00:00.000Z", now), 1);
  assert.equal(undoDaysLeft("someday", now), 30);
});

test("a memory a merge wrote into shows Undo merge under its history; it confirms, then runs unmerge with its hash", async () => {
  const h = contextHarness();
  assert.match(h.history.textContent, /Created Sep 1 · merged 1 into this Oct 10/);
  const b = h.button();
  assert.ok(b, "offered");
  assert.equal(b.textContent, "Undo merge");
  assert.match(h.history.textContent, /28 days left to undo it/);
  b.click();
  await flush();
  assert.deepEqual(h.confirms.map((c) => c[0]), ["Undo the merge into “Prefer small diffs”?"]);
  assert.match(h.confirms[0][1], /restores the memory merged into it, with their MEMORY\.md lines/);
  assert.deepEqual(h.runs, [{ verb: "unmerge", path: SMALL, expect: h.m.hash }]);
  assert.equal(notices[notices.length - 1], "Merge undone: 1 memory restored.");
  // Declined: nothing runs.
  const no = contextHarness({ confirm: false });
  no.button()!.click();
  await flush();
  assert.equal(no.confirms.length, 1);
  assert.deepEqual(no.runs, []);
});

test("Undo merge is not offered once the memory changed, the merge was undone, or its record is past UNDO_DAYS", () => {
  const changed = contextHarness({ trail: () => [({ ts: "2026-10-10T12:00:00.000Z", session: "", action: "merged", slug: "small-diffs", type: "feedback", title: "t", from: [REVIEW], record: "r1", hash: "0".repeat(64) }) as unknown as TrailEntry] });
  assert.equal(changed.button(), null, "edited since the merge");
  const undone = contextHarness({
    trail: (m) => [
      ({ ts: "2026-10-10T12:00:00.000Z", session: "", action: "merged", slug: "small-diffs", type: "feedback", title: "t", from: [REVIEW], record: "r1", hash: m.hash }) as unknown as TrailEntry,
      ({ ts: "2026-10-11T12:00:00.000Z", session: "", action: "unmerged", slug: "small-diffs", type: "feedback", title: "t", record: "r1", restored: [REVIEW] }) as unknown as TrailEntry,
    ],
  });
  assert.equal(undone.button(), null, "already undone");
  assert.match(undone.history.textContent, /merge undone Oct 11/);
  const old = contextHarness({ trail: (m) => [({ ts: "2026-09-01T12:00:00.000Z", session: "", action: "merged", slug: "small-diffs", type: "feedback", title: "t", from: [REVIEW], record: "r1", hash: m.hash }) as unknown as TrailEntry] });
  assert.equal(old.button(), null, "its record is pruned after 30 days");
});
