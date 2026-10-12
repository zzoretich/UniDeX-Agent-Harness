import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import {
  AI_TIMEOUT_MS, parseBrainHub, parseMemory, sweepScopeKey, type BrainMemory, type FixResult, type HubDup, type MemoryVerb, type SweepCard, type SweepFile,
} from "../../data/brainModel";
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
    now: new Date(2026, 9, 11, 12), memories, byPath: new Map(memories.map((m) => [m.path, m])), drafts: [], patterns: [], reflections: [], sweep: null,
    hub: parseBrainHub(JSON.stringify({ schema: 1, builtAt: "2026-10-11T10:00:00.000Z", dups: pairs, hygiene: { sources: { session: 1 } } })),
    sources: null, trail: [], written: new Map(), index: new Map(), pairs, flags: new Map(), batches: [], map: null,
    session: null, wake: null, indexRaw: null, settings: { telemetry: true, graph: true, neverUsedDays: 30, mapMin: 8, wrapHint: "$agenticos:wrap" },
  };
}

const EXPECT = "0123456789abcdef0123456789abcdef";
const DRY: FixResult = { kind: "sources", dryRun: true, files: 1, brainMd: null, expect: EXPECT, changes: [{ path: A, action: "source", before: "session", after: "manual-wrap" }] };

/** `sweep --estimate`'s answer: about $0.06 on haiku · Claude, unless a test says otherwise. */
const ESTIMATE = (o: Record<string, unknown> = {}): unknown => ({
  scope: null, considered: 4, of: 4,
  estimate: { available: true, reason: null, provider: "claude", model: "haiku", tokensIn: 9000, tokensOut: 1500, usd: 0.06, cap: { family: "reasoner", perDayUsd: 5, spentToday: 0.12, perCallUsd: 0.5 }, ...o },
});
type RunAnswer = { ok: boolean; reason?: string; stale?: boolean; json?: unknown };

function harness(d: BrainData, o: {
  run?: (v: MemoryVerb) => Promise<RunAnswer>; preview?: () => Promise<unknown>; estimate?: (v: MemoryVerb) => Promise<unknown>;
  confirm?: boolean | (() => Promise<boolean>); merge?: () => Promise<boolean>;
} = {}) {
  const doc: FakeDoc = { activeElement: null, body: null };
  doc.body = new FakeEl("BODY", doc);
  const host = doc.body.createDiv();
  const calls = {
    runs: [] as MemoryVerb[], runOpts: [] as unknown[], previews: [] as MemoryVerb[], previewOpts: [] as unknown[], shows: [] as unknown[], rescans: 0, dismissed: [] as string[][],
    merges: [] as string[][], confirms: [] as Array<{ title: string; message: string; label: string }>, runAll: [] as Array<{ verb: string; paths: string[] }>,
  };
  const ctx = {
    plugin: { app: {} },
    data: () => d,
    run: async (v: MemoryVerb, _label: string, opts?: unknown) => {
      calls.runs.push(v);
      calls.runOpts.push(opts);
      const r: RunAnswer = o.run ? await o.run(v) : { ok: true };
      return r.ok ? { ok: true, json: r.json ?? { ...DRY, dryRun: false } } : { ok: false, reason: r.reason ?? "no", refused: false, outdated: false, stale: !!r.stale };
    },
    preview: async (v: MemoryVerb, _label: string, opts?: unknown) => {
      calls.previews.push(v);
      calls.previewOpts.push(opts);
      if (v.verb === "sweep") return { ok: true, json: o.estimate ? await o.estimate(v) : ESTIMATE() };
      return { ok: true, json: o.preview ? await o.preview() : DRY };
    },
    merge: async (paths: readonly string[]) => { calls.merges.push([...paths]); return o.merge ? o.merge() : true; },
    confirm: async (title: string, message: string, label: string) => {
      calls.confirms.push({ title, message, label });
      return typeof o.confirm === "function" ? o.confirm() : o.confirm ?? true;
    },
    runAll: async (verb: string, paths: readonly string[]) => { calls.runAll.push({ verb, paths: [...paths] }); return { done: paths.length, failed: null }; },
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
  assert.deepEqual(h.calls.previews.filter((v) => v.verb === "fix"), [{ verb: "fix", kind: "sources", dryRun: true }]);
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

// ── the consolidation sweep (brain-ai A3, A5, A10) ──

const E = P("projects", "release-1-4");
const hashOf = (d: BrainData, p: string): string => d.byPath.get(p)!.hash;
const sweepCard = (d: BrainData, o: Partial<SweepCard> & Pick<SweepCard, "id" | "kind" | "paths">): SweepCard => ({
  run: "r1", hashes: o.paths.map((p) => hashOf(d, p)), title: "", description: "", why: "", scope: null, state: "open", ...o,
});

/** The store above, a cluster (the Tide pair), a project to archive, and a sweep: whole-brain cards and the cluster's. */
function sweepData(): BrainData {
  const d = data();
  const e = parseMemory(E, mem("projects", "release-1-4", "Release 1.4"))!;
  d.memories.push(e);
  d.byPath.set(E, e);
  d.hub = parseBrainHub(JSON.stringify({ schema: 1, builtAt: "2026-10-11T10:00:00.000Z", dups: d.pairs, clusters: [{ paths: [C, D], label: "tide api" }], hygiene: {} }));
  const tide = sweepScopeKey([C, D])!;
  const file: SweepFile = {
    runs: [
      { id: "r2", at: "2026-10-11T09:00:00.000Z", scope: { paths: [C, D] }, provider: "claude", model: "haiku", usd: 0.01, estimated: false, considered: 2, of: 2, suggestions: 1 },
      { id: "r1", at: "2026-10-11T08:00:00.000Z", scope: null, provider: "claude", model: "haiku", usd: 0.05, estimated: false, considered: 5, of: 5, suggestions: 5 },
    ],
    suggestions: [
      sweepCard(d, { id: "00000000000a", kind: "merge", paths: [A, B], title: "Small diffs", why: "the same rule twice" }),
      sweepCard(d, { id: "00000000000b", kind: "archive", paths: [E], why: "shipped" }),
      sweepCard(d, { id: "00000000000c", kind: "retitle", paths: [C], title: "Tide API client", why: "vague" }),
      sweepCard(d, { id: "00000000000d", kind: "archive", paths: [B], state: "dismissed" }),
      sweepCard(d, { id: "00000000000e", kind: "archive", paths: [D], hashes: ["0".repeat(64)] }),
      sweepCard(d, { id: "00000000000f", kind: "retitle", paths: [D], title: "Tide API usage notes", scope: tide, run: "r2" }),
    ],
  };
  d.sweep = file;
  return d;
}

const card = (h: ReturnType<typeof harness>, id: string): FakeEl | undefined => h.q("[data-sweep-id]").find((x) => x.getAttribute("data-sweep-id") === id);
const act = (h: ReturnType<typeof harness>, id: string, a: "review" | "dismiss"): FakeEl => card(h, id)!.querySelectorAll('[data-sweep-act]').find((x) => x.getAttribute("data-sweep-act") === a)!;
const section = (h: ReturnType<typeof harness>, anchor: string): FakeEl => h.q("[data-anchor]").find((x) => x.getAttribute("data-anchor") === anchor)!;

test("the Consolidation sweep card: its line, the estimate fetched once per show, Run a sweep waits up to AI_TIMEOUT_MS", async () => {
  const gate = deferred<RunAnswer>();
  const h = harness(sweepData(), { run: (v) => (v.verb === "sweep" ? gate.promise : Promise.resolve({ ok: true })) });
  const sweep = section(h, "sweep");
  assert.match(sweep.textContent, /Consolidation sweep/);
  assert.match(sweep.textContent, /last run today on “tide api” · 1 suggestion · 4 open · 1 changed since/);
  assert.match(sweep.textContent, /Checking what a sweep would cost…/);
  await tick();
  assert.deepEqual(h.calls.previews, [{ verb: "sweep", paths: [], estimate: true }], "one estimate, the whole brain");
  assert.deepEqual(h.calls.previewOpts, [{ quiet: true }], "asked on every show, so a failure is said on the card, not in a Notice");
  assert.match(section(h, "sweep").textContent, /about \$0\.06 · haiku · Claude · today \$0\.12 of \$5\.00/);
  h.mode.update();
  await tick();
  assert.equal(h.calls.previews.length, 1, "a redraw does not ask again");
  const run = h.q('[data-act="sweep"]')[0];
  run.click();
  assert.deepEqual(h.calls.runs, [{ verb: "sweep", paths: [], estimate: false }]);
  assert.deepEqual(h.calls.runOpts, [{ timeoutMs: AI_TIMEOUT_MS }]);
  const busy = h.q('[data-act="sweep"]')[0];
  assert.deepEqual([busy.textContent, busy.getAttribute("aria-disabled")], ["Sweeping…", "true"]);
  busy.click();
  h.q('[data-act="consolidate"]')[0].click();
  assert.equal(h.calls.runs.length, 1, "one sweep at a time");
  assert.equal(h.calls.previews.length, 1, "no cluster's estimate while the sweep runs");
  gate.resolve({ ok: true, json: { run: { id: "r3", at: "2026-10-11T11:00:00Z", scope: null, provider: "claude", model: "haiku", usd: 0.05, estimated: false, considered: 5, of: 5, suggestions: 2 }, suggestions: [] } });
  await tick();
  assert.equal(notices.pop(), "Sweep: nothing to suggest · swept by haiku · Claude · $0.05");
  assert.equal(h.calls.previews.length, 2, "after a run, the estimate again (today's spend moved)");
  h.mode.unmount();
  h.mode.mount(h.host as unknown as HTMLElement);
  await tick();
  assert.equal(h.calls.previews.length, 3, "shown again: asked again");
});

test("the sweep off: the reason and what still works, and Run a sweep does nothing", async () => {
  const h = harness(sweepData(), { estimate: async () => ESTIMATE({ available: false, reason: "claude-not-logged-in", provider: "none", cap: null }) });
  await tick();
  const sweep = section(h, "sweep");
  assert.match(sweep.textContent, /offClaude Code is not signed in\. Merge with AI still works by hand\./);
  const run = h.q('[data-act="sweep"]')[0];
  assert.equal(run.getAttribute("aria-disabled"), "true");
  run.click();
  assert.deepEqual(h.calls.runs, []);
});

test("the open cards: the whole brain's in the sweep card, the cluster's under its row; done and dismissed are not listed", async () => {
  const h = harness(sweepData());
  await tick();
  const sweep = section(h, "sweep");
  const ids = (el: FakeEl): string[] => el.querySelectorAll("[data-sweep-id]").map((x) => x.getAttribute("data-sweep-id")!);
  assert.deepEqual(ids(sweep), ["00000000000a", "00000000000b", "00000000000c", "00000000000e"], "open first, then stale; the dismissed one is not listed");
  const under = h.q("[data-cluster-cards]")[0];
  assert.equal(under.getAttribute("data-cluster-cards"), [C, D].sort().join("|"));
  assert.deepEqual(ids(under), ["00000000000f"], "the cluster's own card, once, under its row");
  assert.match(under.textContent, /last run today · 1 suggestion · 1 open/);
  const stale = card(h, "00000000000e")!;
  assert.equal(stale.getAttribute("data-sweep-state"), "stale");
  assert.match(stale.textContent, /changed since the sweep/, "a stale card carries its word");
  const m = card(h, "00000000000a")!;
  assert.match(m.textContent, /^Merge2 into “Small diffs”Prefer small diffsPrefer small diffs in reviewthe same rule twice/);
  assert.equal(act(h, "00000000000a", "review").getAttribute("aria-label"), "Review: Merge 2 into “Small diffs”");
});

test("Review per kind: merge opens the Merge dialog; archive and retitle ask first, retitle with the memory's current hash", async () => {
  const d = sweepData();
  const h = harness(d);
  await tick();
  act(h, "00000000000a", "review").click();
  await tick();
  assert.deepEqual(h.calls.merges, [[A, B]]);

  act(h, "00000000000b", "review").click();
  await tick();
  assert.deepEqual(h.calls.confirms.pop(), { title: "Archive 1 memory?", message: "Archives “Release 1.4”. It leaves recall, the MOCs and BRAIN.md. Nothing is deleted: Restore in Library puts it back. The sweep's reason: shipped", label: "Archive" });
  assert.deepEqual(h.calls.runAll, [{ verb: "archive", paths: [E] }]);
  assert.match(notices.pop() ?? "", /^Archived 1 memory\./);
  assert.equal(card(h, "00000000000b"), undefined, "applied: hidden until the files say it is done");

  // The file changed after the sweep read it (and before Retitle): `set` takes the hash the page reads now.
  const changed = parseMemory(C, mem("reference", "tide-api", "Tide API").replace("Body.", "Body, edited."))!;
  d.byPath.set(C, changed);
  act(h, "00000000000c", "review").click();
  await tick();
  assert.equal(h.calls.confirms.pop()?.title, "Retitle 'Tide API' to 'Tide API client'?");
  assert.deepEqual(h.calls.runs.pop(), { verb: "set", path: C, fields: { title: "Tide API client" }, expect: changed.hash });
});

test("a question answered No changes nothing, and the card stays", async () => {
  const h = harness(sweepData(), { confirm: false });
  await tick();
  act(h, "00000000000b", "review").click();
  await tick();
  assert.equal(h.calls.confirms.length, 1);
  assert.deepEqual(h.calls.runAll, []);
  assert.ok(card(h, "00000000000b"));
  assert.equal(act(h, "00000000000b", "review").getAttribute("aria-disabled"), null, "not busy once answered");
});

test("Dismiss: the card stays, busy, until the verb answers, then goes; a refusal brings it back", async () => {
  const gate = deferred<RunAnswer>();
  const h = harness(sweepData(), { run: () => gate.promise });
  await tick();
  act(h, "00000000000a", "dismiss").click();
  assert.deepEqual(h.calls.runs, [{ verb: "sweep-dismiss", id: "00000000000a" }]);
  const busy = act(h, "00000000000a", "dismiss");
  assert.deepEqual([busy.textContent, busy.getAttribute("aria-disabled")], ["Dismissing…", "true"]);
  assert.equal(act(h, "00000000000a", "review").getAttribute("aria-disabled"), "true", "its Review waits too");
  busy.click();
  assert.equal(h.calls.runs.length, 1);
  gate.resolve({ ok: true, json: { dismissed: "00000000000a", already: false } });
  await tick();
  assert.equal(card(h, "00000000000a"), undefined);

  const no = harness(sweepData(), { run: async () => ({ ok: false, reason: "no" }) });
  await tick();
  act(no, "00000000000b", "dismiss").click();
  await tick();
  assert.ok(card(no, "00000000000b"), "refused: still listed");
});

test("a card applied, then undone, shows again; one suggested again by a later run shows even before the files caught up", async () => {
  // One whole-brain card, so the load after the merge lists none (Health draws no card list then).
  const d = sweepData();
  d.sweep = { runs: [d.sweep!.runs[1]], suggestions: [sweepCard(d, { id: "00000000000a", kind: "merge", paths: [A, B], title: "Small diffs" })] };
  const h = harness(d);
  await tick();
  act(h, "00000000000a", "review").click();
  await tick();
  assert.deepEqual(h.calls.merges, [[A, B]]);
  assert.equal(card(h, "00000000000a"), undefined, "applied: hidden until the files say so");
  h.mode.update();
  assert.equal(card(h, "00000000000a"), undefined, "a load from before the merge still reads it open: still hidden");
  // The merge's load: B superseded, so the card is done and nothing is listed.
  const live = d.byPath.get(B)!;
  d.byPath.set(B, parseMemory(B, mem("feedback", "small-diffs-in-review", "Prefer small diffs in review").replace("status/active", "status/superseded"))!);
  h.mode.update();
  assert.equal(h.q("[data-sweep-id]").length, 0);
  // Undo merge: both live again, and the files read the card open again.
  d.byPath.set(B, live);
  h.mode.update();
  assert.ok(card(h, "00000000000a"), "the files win: open again, so listed again");
  // Applied again; before any load, a later run suggests the same merge (same id: its kind and paths, another run).
  act(h, "00000000000a", "review").click();
  await tick();
  assert.equal(card(h, "00000000000a"), undefined);
  const r9 = { ...d.sweep!.runs[0], id: "r9", at: "2026-10-11T11:00:00.000Z" };
  d.sweep = { runs: [r9, ...d.sweep!.runs], suggestions: [sweepCard(d, { id: "00000000000a", kind: "merge", paths: [A, B], title: "Small diffs", run: "r9" })] };
  h.mode.update();
  const again = card(h, "00000000000a");
  assert.ok(again, "the new run's card is not the one applied");
  assert.match(section(h, "sweep").textContent, /Whole brain · 1/);
});

test("Merge with AI… on a duplicate row opens the Merge dialog on that pair", async () => {
  const done = deferred<boolean>();
  const h = harness(data(), { merge: () => done.promise });
  const merges = h.q('[data-act="merge"]');
  assert.equal(merges.length, 2);
  merges[1].click();
  assert.deepEqual(h.calls.merges, [[C, D]]);
  const busy = h.q('[data-act="merge"]')[1];
  assert.deepEqual([busy.textContent, busy.getAttribute("aria-disabled")], ["Merging…", "true"]);
  assert.equal(busy.getAttribute("aria-label"), "Merge with AI: “Tide API” and “Tide API notes”");
  done.resolve(false);
  await tick();
  assert.equal(h.q('[data-act="merge"]')[1].textContent, "Merge with AI…");
});

test("a cluster's Consolidate with AI…: the scoped estimate, a question with the cost, then the scoped sweep", async () => {
  const d = sweepData();
  const h = harness(d, { run: async () => ({ ok: true, json: { run: { id: "r4", at: "x", scope: { paths: [C, D] }, provider: "codex", model: "gpt-5-codex", usd: 0.002, estimated: true, considered: 2, of: 2, suggestions: 1 }, suggestions: [sweepCard(d, { id: "000000000010", kind: "archive", paths: [D] })] } }) });
  await tick();
  const b = h.q('[data-act="consolidate"]')[0];
  assert.equal(b.getAttribute("aria-label"), "Consolidate “tide api” with AI");
  b.click();
  await tick(); await tick();
  assert.deepEqual(h.calls.previews[1], { verb: "sweep", paths: [C, D], estimate: true }, "the cluster's memories, its first path leading");
  assert.equal(h.calls.previewOpts[1], undefined, "a click's estimate says a failure in a Notice");
  assert.deepEqual(h.calls.confirms[0], {
    title: "Consolidate “tide api” with AI?",
    message: "A model reads these 2 memories and suggests merges, archives and retitles; nothing changes until you apply one. Cost: about $0.06 · haiku · Claude, today $0.12 of $5.00.",
    label: "Run the sweep",
  });
  assert.deepEqual(h.calls.runs, [{ verb: "sweep", paths: [C, D], estimate: false }]);
  assert.deepEqual(h.calls.runOpts, [{ timeoutMs: AI_TIMEOUT_MS }]);
  assert.equal(notices.pop(), "Sweep of “tide api”: 1 suggestion · swept by gpt-5-codex · Codex · $0.002 (estimated)");
  assert.equal(h.q('[data-act="consolidate"]')[0].textContent, "Consolidate with AI…");
  // It spent against the reasoner's cap, as the whole brain's sweep does: the sweep card's estimate is asked again.
  await tick();
  assert.deepEqual(h.calls.previews.slice(2), [{ verb: "sweep", paths: [], estimate: true }]);
});

test("a cluster's Consolidate answered No runs nothing, and the sweep card's estimate is not asked again", async () => {
  const h = harness(sweepData(), { confirm: false });
  await tick();
  h.q('[data-act="consolidate"]')[0].click();
  await tick(); await tick();
  assert.equal(h.calls.confirms.length, 1);
  assert.deepEqual(h.calls.runs, []);
  assert.equal(h.calls.previews.length, 2, "the one on show and the cluster's");
});

test("a cluster's Consolidate with the sweep off: a Notice with the reason, no question, no run", async () => {
  const h = harness(sweepData(), { estimate: async (v) => (v.verb === "sweep" && v.paths.length ? ESTIMATE({ available: false, reason: "ollama-only", provider: "ollama", cap: null }) : ESTIMATE()) });
  await tick();
  h.q('[data-act="consolidate"]')[0].click();
  await tick(); await tick();
  assert.equal(notices.pop(), "Consolidate with AI: The sweep needs Claude or Codex; a local model cannot hold the whole brain. Merge with AI still works, on Ollama.");
  assert.deepEqual(h.calls.confirms, []);
  assert.deepEqual(h.calls.runs, []);
});
