import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { parseBrainHub, parseBrainSources, parseIndexLines, parseMemory, type BrainMemory, type MemoryVerb } from "../../data/brainModel";
import type * as Bootstrap from "./BootstrapMode";
import type { BrainCtx, BrainData, RecallPreview } from "./types";

// BootstrapMode draws with Obsidian's DOM helpers (createDiv, createEl, setAttr, empty…), setIcon and Notice, and the
// obsidian package ships types only: under node:test "obsidian" resolves to a stub and the page is a small fake DOM with
// just what the mode uses, so its actions can be driven through ctx without the app.
const notices: string[] = [];
const STUB = "obsidian-stub";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
require.cache[STUB] = {
  id: STUB, filename: STUB, loaded: true,
  exports: { setIcon: () => {}, Notice: class { constructor(m: string) { notices.push(m); } } },
} as unknown as NodeJS.Module;

// ── a fake DOM: elements, attributes, the few selectors the mode uses, focus, clicks ──

interface FakeDoc { activeElement: FakeEl | null; body: FakeEl | null }
type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
class FakeEl {
  children: Array<FakeEl | string> = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  listeners = new Map<string, Array<(e: unknown) => void>>();
  style: Record<string, string> = {};
  value = "";
  disabled = false;
  scrollTop = 0;
  scrolled = 0;
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
  appendText(t: string): void { this.children.push(t); }
  empty(): void {
    if (this.ownerDocument.activeElement && this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.children = [];
  }
  setAttr(k: string, v: string): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  addClass(c: string): void { this.classes.add(c); }
  addEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(type: string, e: Record<string, unknown> = {}): void { for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() {}, ...e }); }
  click(): void { if (!this.disabled) this.fire("click"); }
  focus(): void { this.ownerDocument.activeElement = this; }
  scrollIntoView(): void { this.scrolled++; }
  get elements(): FakeEl[] { return this.children.filter((c): c is FakeEl => typeof c !== "string"); }
  get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  contains(x: FakeEl | null): boolean { for (let e: FakeEl | null = x; e; e = e.parent) if (e === this) return true; return false; }
  matches(sel: string): boolean {
    return sel.split(",").map((s) => s.trim()).some((s) => {
      if (s === ":disabled") return this.disabled;
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
      if (m) return this.attrs.has(m[1]) && (m[2] === undefined || this.attrs.get(m[1]) === m[2]);
      if (s.startsWith(".")) return this.classes.has(s.slice(1));
      return this.tagName === s.toUpperCase();
    });
  }
  closest<T = FakeEl>(sel: string): T | null { for (let e: FakeEl | null = this; e; e = e.parent) if (e.matches(sel)) return e as unknown as T; return null; }
  querySelectorAll<T = FakeEl>(sel: string): T[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => { for (const c of e.elements) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out as unknown as T[];
  }
  querySelector<T = FakeEl>(sel: string): T | null { return (this.querySelectorAll<T>(sel)[0] ?? null); }
}
const g = globalThis as unknown as Record<string, unknown>;
g.HTMLElement = FakeEl;
g.window = { setTimeout: () => 0, clearTimeout: () => {} };

const { BootstrapMode } = require("./BootstrapMode") as typeof Bootstrap;

// ── a store: a profile, a pinned rule, active projects (two look shipped), SESSION.md not wrapped ──

const P = (type: string, slug: string): string => `brain/memory/${type}/${slug}.md`;
const mem = (type: string, slug: string, title: string, o: { tags?: string; pin?: boolean } = {}): string =>
  ["---", "type: memory", `tags: [memory/${type}${o.tags ? `, ${o.tags}` : ""}]`, "created: 2026-10-01", "updated: 2026-10-01",
    ...(o.pin ? ["pin: true"] : []), "---", "", `# ${title}`, "", `The body of ${slug}.`, ""].join("\n");
const INDEX = [
  "# Memory index", "", "## User", `- [Profile](${P("user", "profile")}) — who the owner is`, "", "## Feedback",
  `- [Search the graph first](${P("feedback", "graph-first")}) — use the graph tools first`, "", "## Projects",
  `- [Widget 1.5.0 release](${P("projects", "widget")}) — out to everyone`,
  `- [Ledger tool](${P("projects", "ledger")}) — still being built`,
  `- [Old proposal (superseded)](${P("projects", "old")}) — replaced`, "",
].join("\n");

function data(o: Partial<BrainData> = {}): BrainData {
  const index = parseIndexLines(INDEX);
  const files: Record<string, string> = {
    [P("user", "profile")]: mem("user", "profile", "Profile"),
    [P("feedback", "graph-first")]: mem("feedback", "graph-first", "Search the graph first", { pin: true, tags: "status/active" }),
    [P("projects", "widget")]: mem("projects", "widget", "Widget 1.5.0 release", { tags: "status/active" }),
    [P("projects", "ledger")]: mem("projects", "ledger", "Ledger tool", { tags: "status/active" }),
    [P("projects", "old")]: mem("projects", "old", "Old proposal (superseded)", { tags: "status/active" }),
  };
  const memories = Object.entries(files).map(([p, t]) => parseMemory(p, t, index)).filter((m): m is BrainMemory => !!m);
  return {
    now: new Date(2026, 9, 11, 12), memories, byPath: new Map(memories.map((m) => [m.path, m])), drafts: [], patterns: [], reflections: [],
    hub: parseBrainHub(JSON.stringify({ schema: 1, hygiene: { misfiled: [P("user", "profile")] } })),
    sources: parseBrainSources(JSON.stringify({
      schema: 1, budget: 850, tokens: 840,
      sections: {
        who: { paths: [P("user", "profile")], tokens: 20 }, rules: { paths: [P("feedback", "graph-first")], tokens: 15 },
        active: { paths: [P("projects", "widget"), P("projects", "ledger")], omitted: [P("projects", "old")], tokens: 40 },
        links: { tokens: 50 }, lastSession: { tokens: 30 },
      },
    })),
    trail: [], written: new Map(), index, pairs: [], flags: new Map(), batches: [], map: null,
    session: "# SESSION\n\n## Things to Remember\n\n- keep the folder flag #promote\n\n## Wrap Status\n\n- Session s1 not wrapped (provider: none) — run /wrap.\n",
    wake: "## Recall (auto)\n- `brain/memory/projects/widget.md` (3d) — out to everyone\n",
    indexRaw: INDEX, settings: { telemetry: true, graph: true, neverUsedDays: 30, mapMin: 8, wrapHint: "/wrap" },
    ...o,
  };
}

interface Calls { runs: MemoryVerb[]; shows: unknown[]; edits: string[]; confirms: string[]; brainMd: number }
function harness(d: BrainData, o: { run?: (v: MemoryVerb) => { ok: boolean; reason?: string }; confirm?: boolean | (() => Promise<boolean>); recall?: (t: string) => Promise<RecallPreview> } = {}) {
  const doc: FakeDoc = { activeElement: null, body: null };
  doc.body = new FakeEl("BODY", doc);
  const host = doc.body.createDiv();
  const calls: Calls = { runs: [], shows: [], edits: [], confirms: [], brainMd: 0 };
  let n = 0;
  const ctx = {
    data: () => d,
    run: async (v: MemoryVerb) => {
      calls.runs.push(v);
      const r = o.run?.(v) ?? { ok: true };
      return r.ok ? { ok: true, json: { hash: `${"ab".repeat(15)}${String(++n).padStart(2, "0")}`, brainMd: { ok: true } } } : { ok: false, reason: r.reason ?? "no", refused: false, outdated: false, stale: false };
    },
    confirm: async (title: string) => { calls.confirms.push(title); return typeof o.confirm === "function" ? o.confirm() : o.confirm ?? true; },
    brainMd: async () => { calls.brainMd++; return { ok: true }; },
    recall: o.recall ?? (async () => ({ ok: true, query: "q", hits: [] })),
    show: (t: unknown) => { calls.shows.push(t); },
    edit: async (p: string) => { calls.edits.push(p); },
  } as unknown as BrainCtx;
  const mode = new BootstrapMode(ctx);
  mode.mount(host as unknown as HTMLElement);
  const q = (sel: string): FakeEl[] => host.querySelectorAll(sel);
  const one = (sel: string): FakeEl => { const x = q(sel); assert.equal(x.length, 1, `one ${sel}`); return x[0]; };
  return { host, doc, mode, calls, q, one, set: (x: Partial<BrainData>) => { Object.assign(d, x); mode.update(); } };
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── tests ──

test("Bootstrap draws the three budgets as progressbars, BRAIN.md by section, the lede, SESSION.md and MEMORY.md", () => {
  const h = harness(data());
  const bars = h.q('[role="progressbar"]');
  assert.deepEqual(bars.map((b) => [b.getAttribute("aria-valuenow"), b.getAttribute("aria-valuemax")]), [["840", "850"], [String(Math.ceil(data().session!.length / 4)), "400"], ["1", "3"]]);
  assert.match(h.one('[data-budget="brain"]').textContent, /840 \/ 850 tokens.*Full: 1 older active project left out/);
  assert.deepEqual(h.q("[data-section]").map((s) => s.getAttribute("data-section")), ["who", "rules", "active", "links", "lastSession"]);
  assert.match(h.one('[data-bs="lede"]').textContent, /^2 of the 3 active projects look shipped\. Marking them complete frees about \d+ tokens? of BRAIN\.md/);
  assert.equal(h.one('[data-section="active"]').querySelectorAll('[data-shipped="true"]').length, 1, "BRAIN.md shows one that looks shipped; the other is left out");
  assert.equal(h.q('[data-act="unpin"]').length, 1);
  assert.match(h.one('[data-bs="session"]').textContent, /keep the folder flag#promote.*Not wrapped yet · \/wrap promotes the tagged lines/);
  assert.match(h.one('[data-bs="index"]').textContent, /1 line sits under the wrong heading\.Fix in Health →$/);
  h.one('[data-act="fix-in-health"]').click();
  assert.deepEqual(h.calls.shows.pop(), { mode: "health", anchor: "hygiene" });
});

test("Unpin runs `set` with the hash the page read; the row stays, busy, until the verb answers; refused, it stays", async () => {
  const d = data();
  const h = harness(d, { run: () => ({ ok: false, reason: "changed since it was read" }) });
  const hash = d.byPath.get(P("feedback", "graph-first"))!.hash;
  const b = h.one('[data-act="unpin"]');
  b.focus();
  b.click();
  assert.deepEqual(h.calls.runs[0], { verb: "set", path: P("feedback", "graph-first"), fields: { pin: false }, expect: hash });
  const busy = h.one('[data-act="unpin"]');
  assert.deepEqual([busy.getAttribute("aria-disabled"), busy.textContent], ["true", "Unpinning…"], "kept in place, busy, while the verb runs");
  assert.equal(h.doc.activeElement, busy, "the keyboard stays on it");
  busy.click();
  assert.equal(h.calls.runs.length, 1, "a click on the busy button does nothing");
  await tick();
  assert.deepEqual([h.one('[data-act="unpin"]').getAttribute("aria-disabled"), h.one('[data-act="unpin"]').textContent], [null, "Unpin"], "refused: it stays, ready again");
});

test("A double-click marks one project complete, never the row that slides under the second click", async () => {
  const h = harness(data());
  const rows = h.one('[data-section="active"]').querySelectorAll('[data-act="complete"]');
  assert.ok(rows.length >= 2);
  rows[0].fire("click", { detail: 1 });
  // The second click of the double-click: on the same busy button (the row stays), or on whatever sits there now.
  for (const b of h.one('[data-section="active"]').querySelectorAll('[data-act="complete"]')) b.fire("click", { detail: 2 });
  await tick();
  assert.equal(h.calls.runs.length, 1, "one set");
  // A held Enter's repeats are not new presses.
  let prevented = 0;
  h.one('[data-section="active"]').querySelectorAll('[data-act="complete"]')[0].fire("keydown", { key: "Enter", repeat: true, preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
});

test("Mark the N complete… asks first, runs each set in turn with each hash as read, and stops at the first failure", async () => {
  const d = data();
  let calls = 0;
  const h = harness(d, { run: () => (++calls === 2 ? { ok: false, reason: "surface off" } : { ok: true }) });
  h.one('[data-act="complete-shipped"]').click();
  await tick(); await tick(); await tick();
  assert.deepEqual(h.calls.confirms, ["Mark 2 projects complete?"]);
  assert.deepEqual(h.calls.runs.map((v) => v.verb === "set" ? [v.path, v.fields, v.expect, v.skipBrainMd] : null), [
    [P("projects", "widget"), { status: "complete" }, d.byPath.get(P("projects", "widget"))!.hash, true],
    [P("projects", "old"), { status: "complete" }, d.byPath.get(P("projects", "old"))!.hash, true],
  ]);
  // Each set skips the BRAIN.md rebuild; one runs after the last that went through, the stop included.
  assert.equal(h.calls.brainMd, 1);
  assert.equal(notices.pop(), "Marked 1 of 2 projects complete; stopped at “Old proposal (superseded)”.");
  const no = harness(data(), { confirm: false });
  no.one('[data-act="complete-shipped"]').click();
  await tick();
  assert.deepEqual(no.calls.runs, [], "nothing runs when the dialog is cancelled");
  assert.equal(no.calls.brainMd, 0);
  const none = harness(data(), { run: () => ({ ok: false, reason: "surface off" }) });
  none.one('[data-act="complete-shipped"]').click();
  await tick(); await tick(); await tick();
  assert.equal(none.calls.brainMd, 0, "nothing went through: no rebuild");
});

test("Unpin, then Mark the N complete… while the reload lands under its dialog: the set sends the hash Unpin answered", async () => {
  const W = P("projects", "widget");
  const d = data();
  // Widget is pinned as well as active and looking shipped: it shows in Critical rules and in Active context.
  const w0 = { ...d.byPath.get(W)!, pin: true };
  const swap = (m: BrainMemory): void => { d.memories = d.memories.map((x) => (x.path === m.path ? m : x)); d.byPath = new Map(d.memories.map((x) => [x.path, x])); };
  swap(w0);
  d.sources!.sections.rules.paths.push(W);
  let release: (v: boolean) => void = () => {};
  const h = harness(d, { confirm: () => new Promise<boolean>((r) => { release = r; }) });
  const unpin = h.one('[data-section="rules"]').querySelectorAll('[data-act="unpin"]').find((b) => b.getAttribute("data-bs-key")!.endsWith(W))!;
  unpin.click();
  await tick();
  const answered = h.calls.runs.length === 1 ? `${"ab".repeat(15)}01` : "";
  assert.equal(answered.length, 32);
  // Mark the N complete… before the reload, then the reload lands while its dialog is open (the file now holds `answered`).
  h.one('[data-act="complete-shipped"]').click();
  await tick();
  swap({ ...w0, pin: false, hash: answered });
  h.mode.update();
  release(true);
  await tick(); await tick(); await tick();
  const sent = h.calls.runs.find((v) => v.verb === "set" && v.path === W && v.fields.status === "complete");
  assert.ok(sent && sent.verb === "set");
  assert.equal(sent.expect, answered, "the newest hash the page knows, not the one read before Unpin");
});

test("Review the N… lands on the looks-shipped list; Show them opens the left-out projects", () => {
  const h = harness(data());
  h.one('[data-act="review-shipped"]').click();
  assert.equal(h.one('[data-filter="shipped"]').getAttribute("aria-pressed"), "true");
  assert.equal(h.doc.activeElement, h.one('[data-filter="shipped"]'));
  assert.deepEqual(h.one('[data-section="active"]').querySelectorAll("[data-path]").map((r) => r.getAttribute("data-path")), [P("projects", "widget"), P("projects", "old")]);
  h.one('[data-filter="all"]').click();
  const show = h.one('[data-act="left-out"]');
  assert.equal(show.getAttribute("aria-expanded"), "false");
  show.click();
  assert.equal(h.one('[data-act="left-out"]').getAttribute("aria-expanded"), "true");
  assert.ok(h.one('[data-section="active"]').querySelectorAll("[data-path]").some((r) => r.getAttribute("data-path") === P("projects", "old")));
});

test("The recall preview: loading, the hits (a memory opens Library, stale says so), an error's reason, nothing recalled", async () => {
  let answer: RecallPreview = { ok: true, query: "widget", hits: [{ path: P("projects", "widget"), score: 2.5, flag: "stale: 70d", snippet: "out" }, { path: "brain/patterns/steps.md", score: 1, flag: "4d", snippet: "" }] };
  const h = harness(data(), { recall: async () => answer });
  const input = h.one('[data-bs-key="recall:input"]');
  const out = h.one(".aos-brain-bs-hits");
  assert.equal(out.getAttribute("data-state"), "idle");
  input.fire("keydown", { key: "Enter" });
  assert.equal(out.getAttribute("data-state"), "idle", "an empty field asks for a prompt and runs nothing");
  input.value = "cut a widget release";
  input.fire("input");
  input.fire("keydown", { key: "Enter" });
  assert.equal(out.getAttribute("data-state"), "loading");
  assert.equal(out.getAttribute("aria-busy"), "true");
  await tick();
  assert.equal(out.getAttribute("data-state"), "results");
  const hits = out.querySelectorAll("[data-path]");
  assert.match(hits[0].textContent, /^2\.5Widget 1\.5\.0 releaseprojects70dstale$/);
  hits[0].click();
  assert.deepEqual(h.calls.shows.pop(), { mode: "library", memory: P("projects", "widget") });
  hits[1].click();
  assert.deepEqual(h.calls.edits, ["brain/patterns/steps.md"]);
  h.mode.update();
  assert.equal(h.one('[data-bs-key="recall:input"]').value, "cut a widget release", "the field keeps its text across a redraw");
  answer = { ok: false, reason: "recall exited 1" };
  h.one('[data-act="recall"]').click();
  await tick();
  assert.equal(out.getAttribute("data-state"), "error");
  assert.equal(out.textContent, "Recall did not run: recall exited 1");
  answer = { ok: true, query: "zzz", hits: [] };
  h.one('[data-act="recall"]').click();
  await tick();
  assert.equal(out.getAttribute("data-state"), "empty");
});

test("No sources, SESSION.md, recall-wake.md or hub yet: Bootstrap says so and offers nothing it cannot do", () => {
  const h = harness(data({ sources: null, session: null, wake: null, hub: null, indexRaw: null }));
  assert.equal(h.q("[data-section]").length, 0);
  assert.match(h.one(".aos-brain-bs-empty").textContent, /has not recorded what it was built from yet/);
  assert.equal(h.q('[role="progressbar"]').length, 1, "only recall-wake.md has a measure (zero of three)");
  assert.match(h.one('[data-bs="session"]').textContent, /No SESSION\.md yet/);
  assert.match(h.one('[data-bs="index"]').textContent, /No MEMORY\.md yet/);
  assert.equal(h.q('[data-act="fix-in-health"]').length, 0);
  assert.equal(h.q('[data-bs="lede"]').length, 0);
});
