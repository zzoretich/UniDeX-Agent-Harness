import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { AI_TIMEOUT_MS, parseMemory, spendText, parseMergeDraft, type BrainMemory, type MemoryVerb } from "../../data/brainModel";
import type * as Merge from "./MergeModal";
import type { BrainCtx, BrainData, BrainRunOptions } from "./types";

// MergeModal draws into an Obsidian Modal and says what it did in a Notice: under node:test "obsidian" resolves to a
// stub whose Modal builds its modalEl and contentEl in a small fake DOM, so the dialog can be driven through ctx (the
// estimate, Draft with AI, Save merged) without the app. Escape, ✕ and a click outside all call close(), as Cancel does.
const notices: string[] = [];

interface FakeDoc { activeElement: FakeEl | null; body: FakeEl | null }
type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
class FakeEl {
  children: Array<FakeEl | string> = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  listeners = new Map<string, Array<(e: unknown) => void>>();
  value = "";
  disabled = false;
  readOnly = false;
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
  setText(t: string): void { this.children = [t]; }
  setAttr(k: string, v: string | null): void { if (v === null) this.attrs.delete(k); else this.attrs.set(k, String(v)); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  addClass(c: string): void { this.classes.add(c); }
  removeClass(c: string): void { this.classes.delete(c); }
  toggleClass(c: string, on: boolean): void { if (on) this.classes.add(c); else this.classes.delete(c); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  addEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(type: string, e: Record<string, unknown> = {}): void { for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() {}, detail: 1, ...e }); }
  click(): void { this.fire("click"); }
  focus(): void { this.ownerDocument.activeElement = this; }
  /** What typing does: the value changes, then an input event. */
  type(v: string): void { this.value = v; this.fire("input"); }
  get elements(): FakeEl[] { return this.children.filter((c): c is FakeEl => typeof c !== "string"); }
  get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  contains(x: FakeEl | null): boolean { for (let e: FakeEl | null = x; e; e = e.parent) if (e === this) return true; return false; }
  closest(sel: string): FakeEl | null { for (let e: FakeEl | null = this; e; e = e.parent) if (e.matches(sel)) return e; return null; }
  matches(sel: string): boolean {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel.trim());
    if (m) return this.attrs.has(m[1]) && (m[2] === undefined || this.attrs.get(m[1]) === m[2]);
    if (sel.startsWith(".")) return this.classes.has(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll<T = FakeEl>(sel: string): T[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => { for (const c of e.elements) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out as unknown as T[];
  }
  querySelector<T = FakeEl>(sel: string): T | null { return (this.querySelectorAll<T>(sel)[0] ?? null); }
}

const doc: FakeDoc = { activeElement: null, body: null };
doc.body = new FakeEl("BODY", doc);

/** Obsidian's Modal as far as MergeModal uses it: modalEl over contentEl in the page; open runs onOpen, close onClose. */
class FakeModal {
  modalEl: FakeEl;
  contentEl: FakeEl;
  constructor(public app: unknown) {
    this.modalEl = doc.body!.createDiv({ cls: "modal" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
  }
  open(): void { void (this as unknown as { onOpen(): void }).onOpen(); }
  close(): void { void (this as unknown as { onClose(): void }).onClose(); this.modalEl.remove(); }
}

const STUB = "obsidian-stub";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
class Stub {}
require.cache[STUB] = {
  id: STUB, filename: STUB, loaded: true,
  exports: { setIcon: () => {}, Modal: FakeModal, FuzzySuggestModal: Stub, Notice: class { constructor(m: string) { notices.push(m); } } },
} as unknown as NodeJS.Module;

const { openMerge, mergeInto, mergeProblem, savingWill, targetLine, sourceOrder, byHandText, MERGE_CANCEL_TEXT, MERGE_STALE_TEXT } = require("./MergeModal") as typeof Merge;

// ── two memories, the runtime's answers ──

const P = (type: string, slug: string): string => `brain/memory/${type}/${slug}.md`;
const A = P("feedback", "small-diffs"), B = P("feedback", "small-diffs-in-review");
const H = (c: string): string => c.repeat(64);
const mem = (title: string, created: string, body: string, pin = false): string =>
  ["---", "type: memory", "tags: [memory/feedback, status/active]", `created: ${created}`, "source: auto-wrap", ...(pin ? ["pin: true"] : []), "---", "", `# ${title}`, "", body, ""].join("\n");

function data(pinB = false): BrainData {
  const memories = [parseMemory(A, mem("Prefer small diffs", "2026-09-01", "Small diffs review faster.")), parseMemory(B, mem("Prefer small diffs in review", "2026-09-20", "Reviewers ask for small diffs.", pinB))]
    .filter((m): m is BrainMemory => !!m);
  return { now: new Date(2026, 9, 12, 12), memories, byPath: new Map(memories.map((m) => [m.path, m])) } as unknown as BrainData;
}

const SOURCES = [
  { path: A, title: "Prefer small diffs", type: "feedback", created: "2026-09-01", hash: H("a"), chars: 26, truncated: false },
  { path: B, title: "Prefer small diffs in review", type: "feedback", created: "2026-09-20", hash: H("b"), chars: 9000, truncated: true },
];
const BASE = { winner: A, type: "feedback", sources: SOURCES, baseHashes: [H("a"), H("b")], truncated: true };
const BY_HAND = { title: "Prefer small diffs", description: "Keep diffs small", body: "Small diffs review faster.\n\n## From Prefer small diffs in review\n\nReviewers ask for small diffs." };
const CAP = { family: "hook", perDayUsd: 0.5, spentToday: 0.12, perCallUsd: 0.05 };
const ESTIMATE = { ...BASE, byHand: BY_HAND, estimate: { available: true, reason: null, provider: "claude", model: "haiku", tokensIn: 1200, tokensOut: 600, usd: 0.0042, cap: CAP } };
const DRAFT = {
  ...BASE, mode: "ai", reason: null, provider: "claude", model: "haiku", usd: 0.0039, estimated: false, cap: { ...CAP, spentToday: 0.13 },
  fields: { title: "Keep diffs small", description: "Small diffs, in review too", body: "Small diffs review faster, and reviewers ask for them." }, generatedAt: "2026-10-12T12:00:00Z",
};

type Answer = { ok: true; json: unknown } | { ok: false; reason: string; refused: boolean; outdated: boolean; stale: boolean };
const fail = (reason: string, stale = false): Answer => ({ ok: false, reason, refused: false, outdated: false, stale });
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

interface Harness {
  previews: MemoryVerb[];
  runs: Array<{ v: MemoryVerb; label: string; opts?: BrainRunOptions }>;
  confirms: string[];
  q(sel: string): FakeEl;
  open(): boolean;
  saved(): boolean | null;
}

async function harness(o: { estimate?: Answer; run?: (v: MemoryVerb) => Promise<Answer>; confirm?: () => Promise<boolean>; pinB?: boolean } = {}): Promise<Harness> {
  doc.body!.children = [];
  doc.activeElement = null;
  const d = data(o.pinB);
  const previews: MemoryVerb[] = [];
  const runs: Harness["runs"] = [];
  const confirms: string[] = [];
  const ctx = {
    plugin: { app: {} },
    data: () => d,
    preview: async (v: MemoryVerb) => { previews.push(v); return o.estimate ?? { ok: true, json: ESTIMATE }; },
    run: async (v: MemoryVerb, label: string, opts?: BrainRunOptions) => { runs.push({ v, label, opts }); return o.run ? o.run(v) : { ok: true, json: {} }; },
    confirm: async (title: string) => { confirms.push(title); return o.confirm ? o.confirm() : true; },
  } as unknown as BrainCtx;
  let saved: boolean | null = null;
  void openMerge(ctx, [A, B]).then((x) => { saved = x; });
  await flush();
  const q = (sel: string): FakeEl => { const el = doc.body!.querySelector(sel); assert.ok(el, `no ${sel}`); return el; };
  return { previews, runs, confirms, q, open: () => !!doc.body!.querySelector(".modal"), saved: () => saved };
}

// ── the pure parts ──

test("mergeInto tidies what Save sends as the runtime's Clean does; mergeProblem names what Save refuses (A8)", () => {
  assert.deepEqual(mergeInto({ title: "  Keep\ndiffs\tsmall ", description: "Small,\r\nin review ", body: "\r\nLine one\r\nLine two\n\n" }),
    { title: "Keep diffs small", description: "Small, in review", body: "Line one\nLine two" });
  assert.equal(mergeProblem({ title: "T", description: "D", body: "B" }), null);
  assert.equal(mergeProblem({ title: " \n ", description: "D", body: "B" }), "The merged memory needs a title.");
  assert.equal(mergeProblem({ title: "T", description: " ", body: "B" }), "The merged memory needs a description.", "the runtime refuses an empty one");
  assert.equal(mergeProblem({ title: "T", description: "D", body: "  " }), "The merged memory needs a body.");
  assert.equal(mergeProblem({ title: "t".repeat(121), description: "D", body: "B" }), "The title is over 120 characters.");
  assert.equal(mergeProblem({ title: "T", description: "d".repeat(201), body: "B" }), "The description is over 200 characters.");
  assert.equal(mergeProblem({ title: "T", description: "D", body: "b".repeat(16_001) }), "The body is over 16,000 characters.");
  assert.equal(mergeProblem({ title: "T", description: "D", body: `${"b".repeat(16_000)}\n\n` }), null, "trailing space is not counted");
  // MEMORY.md links the memory as [title](path): the runtime refuses what would break or redirect that link.
  assert.equal(mergeProblem({ title: "[WIP] small diffs", description: "D", body: "B" }), "The title cannot hold [ or ]: MEMORY.md links it as [title](path).");
  assert.equal(mergeProblem({ title: "T", description: "see [x](other.md)", body: "B" }), "The description cannot hold “](”: MEMORY.md would read it as a link.");
  assert.equal(mergeProblem({ title: "T (draft)", description: "a [note] here", body: "[link](x.md) in the body is fine" }), null);
});

test("the target line, what saving will do and the sources' order (A1, A2, A9)", () => {
  assert.equal(targetLine(A, 2), "feedback/small-diffs.md · keeps the older slug's links");
  assert.equal(targetLine(A, 3), "feedback/small-diffs.md · keeps the oldest slug's links");
  assert.deepEqual(savingWill(A, 1, false), [
    "write the merged text into feedback/small-diffs.md, mark it reviewed",
    "mark the other one superseded by it",
    "replace their MEMORY.md lines with one",
    "log it, so Undo merge works for 30 days",
  ]);
  assert.deepEqual(savingWill(A, 3, true).slice(1, 4), ["mark the other 3 superseded by it", "replace their MEMORY.md lines with one", "keep it pinned to BRAIN.md, as a source is pinned"]);
  const s = parseMergeDraft(DRAFT)!.sources;
  assert.deepEqual(sourceOrder(s, B).map((x) => x.path), [B, A], "the one written over first");
});

// ── the dialog ──

test("it opens on the estimate: a labelled dialog, the by-hand draft, the sources, the target, the estimate, what saving will do", async () => {
  const h = await harness({ pinB: true });
  assert.deepEqual(h.previews, [{ verb: "merge-draft", paths: [A, B], estimate: true }], "one estimate; no model call");
  assert.equal(h.runs.length, 0);
  const modal = h.q(".mod-brain-merge");
  assert.equal(modal.getAttribute("role"), "dialog");
  assert.equal(modal.getAttribute("aria-modal"), "true");
  assert.equal(h.q(".aos-brain-mg-title").getAttribute("id"), modal.getAttribute("aria-labelledby"));
  assert.equal(h.q(".aos-brain-mg-title").textContent, "Merge 2 memories into one");
  const title = h.q('[data-field="title"]'), desc = h.q('[data-field="description"]'), body = h.q('[data-field="body"]');
  assert.deepEqual([title.value, desc.value, body.value], [BY_HAND.title, BY_HAND.description, BY_HAND.body]);
  assert.deepEqual([title.getAttribute("maxlength"), desc.getAttribute("maxlength"), body.getAttribute("maxlength")], ["120", "200", "16000"], "MERGE_LIMITS in the inputs");
  assert.equal(doc.activeElement, title, "the draft takes the keyboard when it arrives");
  const srcs = doc.body!.querySelectorAll(".aos-brain-mg-src");
  assert.deepEqual(srcs.map((x) => x.getAttribute("data-path")), [A, B]);
  assert.match(srcs[0].textContent, /keeps its path/);
  assert.match(srcs[0].textContent, /feedback\/small-diffs\.md · created Sep 1 · auto-wrap/);
  assert.match(srcs[0].textContent, /Small diffs review faster\./, "the body, without its title");
  assert.match(srcs[1].textContent, /cut for the model/);
  assert.match(srcs[1].textContent, /pinned/);
  assert.equal(h.q(".aos-brain-mg-target").textContent, "feedback/small-diffs.md · keeps the older slug's links");
  const ai = h.q('[data-act="draft"]');
  assert.equal(ai.disabled, false);
  assert.equal(ai.textContent, "Draft with AI");
  assert.equal(h.q(".aos-brain-mg-est").textContent, "about $0.0042 · haiku · Claude");
  assert.deepEqual(h.q(".aos-brain-mg-willlist").elements.map((li) => li.textContent), [
    "write the merged text into feedback/small-diffs.md, mark it reviewed",
    "mark the other one superseded by it",
    "replace their MEMORY.md lines with one",
    "keep it pinned to BRAIN.md, as a source is pinned",
    "log it, so Undo merge works for 30 days",
  ]);
  assert.equal(h.q('[data-act="save"]').disabled, false, "the by-hand draft can be saved as it is");
  assert.equal(h.q(".aos-brain-mg-count").textContent, `${BY_HAND.body.length} of 16,000 characters`);
});

test("Draft with AI makes one call with the long timeout, fills the untouched draft and says who drafted it and the spend", async () => {
  const h = await harness({ run: async () => ({ ok: true, json: DRAFT }) });
  h.q('[data-act="draft"]').click();
  await flush();
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.runs[0].v, { verb: "merge-draft", paths: [A, B], estimate: false });
  assert.equal(h.runs[0].opts?.timeoutMs, AI_TIMEOUT_MS);
  assert.equal(h.confirms.length, 0, "nothing edited: nothing to ask");
  assert.equal(h.q('[data-field="title"]').value, DRAFT.fields.title);
  assert.equal(h.q('[data-field="body"]').value, DRAFT.fields.body);
  assert.equal(h.q(".aos-brain-mg-spend").textContent, "drafted by haiku · Claude · $0.0039 · today $0.13 of $0.50");
  assert.equal(h.q(".aos-brain-mg-spend").textContent, spendText(parseMergeDraft(DRAFT)!));
  assert.equal(h.q('[data-act="draft"]').textContent, "Redraft");
});

test("a model draft replaces edited fields only when the person says so", async () => {
  let answer = false;
  const h = await harness({ run: async () => ({ ok: true, json: DRAFT }), confirm: async () => answer });
  h.q('[data-field="title"]').type("My own title");
  h.q('[data-act="draft"]').click();
  await flush();
  assert.deepEqual(h.confirms, ["Replace your edits?"]);
  assert.equal(h.q('[data-field="title"]').value, "My own title", "kept");
  assert.match(h.q(".aos-brain-mg-spend").textContent, /not used: your edits are kept$/);
  answer = true;
  h.q('[data-act="draft"]').click();
  await flush();
  assert.equal(h.confirms.length, 2);
  assert.equal(h.q('[data-field="title"]').value, DRAFT.fields.title, "replaced");
});

test("a by-hand answer (a cap, no provider, a bad reply) shows its reason and leaves the draft to finish", async () => {
  const reason = "Today's model cap is reached ($0.50, claude.perDayUsd).";
  const h = await harness({ run: async () => ({ ok: true, json: { ...DRAFT, mode: "by-hand", reason, provider: "none", model: null, usd: 0, fields: BY_HAND } }) });
  h.q('[data-field="description"]').type("Edited");
  h.q('[data-act="draft"]').click();
  await flush();
  assert.equal(h.q(".aos-brain-mg-spend").textContent, `${reason} Finish the draft by hand.`);
  assert.equal(h.q('[data-field="description"]').value, "Edited", "an edit is never overwritten by the by-hand draft");
  assert.equal(h.confirms.length, 0);
  assert.equal(h.q('[data-act="draft"]').textContent, "Draft with AI", "no model draft came back");
});

test("a reply that could not be read was still a call: the by-hand line says who answered and what it cost (A5)", async () => {
  const BAD = "The model's reply could not be read.";
  const codex = { ...DRAFT, mode: "by-hand", reason: BAD, provider: "codex", model: "gpt-5-codex", usd: 0.012, estimated: true, cap: { family: "codex", perDayUsd: 1, spentToday: 0.2, perCallUsd: null }, fields: BY_HAND };
  const h = await harness({ run: async () => ({ ok: true, json: codex }) });
  h.q('[data-act="draft"]').click();
  await flush();
  assert.equal(h.q(".aos-brain-mg-spend").textContent, `${BAD} Finish the draft by hand. · answered by gpt-5-codex · Codex · $0.01 (estimated) · today $0.20 of $1.00`);
  assert.equal(h.q(".aos-brain-mg-spend").getAttribute("data-tone"), "by-hand");
  // No call came back (no provider, a cap, a call that failed): no model and nothing spent, so only the reason.
  const none = { reason: "No model provider is set up.", provider: "none" as const, model: null, usd: 0, estimated: false, cap: null };
  assert.equal(byHandText(none), "No model provider is set up. Finish the draft by hand.");
  assert.equal(byHandText({ ...none, reason: "Claude did not answer.", provider: "claude" }), "Claude did not answer. Finish the draft by hand.", "a failed call: who failed is in the reason, no cost came back");
  assert.equal(byHandText({ ...none, reason: BAD, provider: "ollama", model: "qwen3:8b" }), `${BAD} Finish the draft by hand. · answered by qwen3:8b · Ollama · $0.00`);
});

test("Draft with AI keeps the keyboard while it runs (aria-disabled, not disabled), and the dialog takes it back after a stop", async () => {
  const late = deferred<Answer>();
  const h = await harness({ run: () => late.promise });
  const ai = h.q('[data-act="draft"]');
  ai.focus();
  ai.click();
  await flush();
  const busy = h.q('[data-act="draft"]');
  assert.equal(busy, ai, "the same button: the dialog does not redraw it");
  assert.deepEqual([busy.disabled, busy.getAttribute("aria-disabled"), busy.getAttribute("aria-busy")], [false, "true", "true"]);
  assert.equal(doc.activeElement, ai, "a disabled button would drop the focus to the page");
  busy.click();
  await flush();
  assert.equal(h.runs.length, 1, "a busy click does nothing");
  // Escape with the keyboard nowhere (it was on a control the page dropped): the stop gives it to Draft with AI.
  doc.activeElement = doc.body;
  h.q('[data-act="cancel"]').click();
  assert.equal(h.q(".aos-brain-mg-spend").textContent, MERGE_CANCEL_TEXT);
  assert.deepEqual([ai.getAttribute("aria-disabled"), ai.getAttribute("aria-busy")], [null, null]);
  assert.equal(doc.activeElement, ai);
  // A control the person moved to keeps the keyboard when the answer lands.
  const next = deferred<Answer>();
  const g = await harness({ run: () => next.promise });
  g.q('[data-act="draft"]').click();
  const desc = g.q('[data-field="description"]');
  desc.focus();
  next.resolve({ ok: true, json: DRAFT });
  await flush();
  assert.equal(doc.activeElement, desc);
  // The keyboard nowhere when it lands: Draft with AI (now Redraft) takes it.
  const third = deferred<Answer>();
  const k = await harness({ run: () => third.promise });
  k.q('[data-act="draft"]').click();
  doc.activeElement = doc.body;
  third.resolve({ ok: true, json: DRAFT });
  await flush();
  assert.equal(doc.activeElement, k.q('[data-act="draft"]'));
  assert.equal(k.q('[data-act="draft"]').textContent, "Redraft");
});

test("the body's count is beside its label, not in it: the field is named BODY and described by the count", async () => {
  const h = await harness();
  const body = h.q('[data-field="body"]');
  const label = body.closest("label")!;
  assert.equal(label.textContent, "BODY", "the label names the field and nothing else");
  const count = h.q(".aos-brain-mg-count");
  assert.equal(label.contains(count), false);
  assert.equal(body.getAttribute("aria-describedby"), count.getAttribute("id"));
  assert.equal(count.parent, label.parent, "under the field, in the same block");
});

test("Cancel while a draft runs drops its answer and says the call may still be billed; the dialog stays to finish by hand", async () => {
  const late = deferred<Answer>();
  const h = await harness({ run: () => late.promise });
  h.q('[data-act="draft"]').click();
  await flush();
  assert.equal(h.q('[data-act="draft"]').textContent, "Drafting…");
  assert.equal(h.q('[data-act="save"]').disabled, true, "no save while a draft runs");
  h.q('[data-act="cancel"]').click();
  assert.equal(h.open(), true, "the first Cancel stops waiting");
  assert.equal(h.q(".aos-brain-mg-spend").textContent, MERGE_CANCEL_TEXT);
  assert.equal(h.q('[data-act="save"]').disabled, false);
  late.resolve({ ok: true, json: DRAFT });
  await flush();
  assert.equal(h.q('[data-field="title"]').value, BY_HAND.title, "the late answer is dropped");
  assert.equal(h.q(".aos-brain-mg-spend").textContent, MERGE_CANCEL_TEXT);
  h.q('[data-act="cancel"]').click();
  await flush();
  assert.equal(h.open(), false);
  assert.equal(h.saved(), false);
});

test("Save merged runs merge once with every source's hash, cannot be closed while it runs, and resolves true", async () => {
  const done = deferred<Answer>();
  const h = await harness({ run: (v) => (v.verb === "merge" ? done.promise : Promise.resolve({ ok: true, json: DRAFT })) });
  h.q('[data-field="title"]').type("  Keep diffs\nsmall ");
  h.q('[data-act="save"]').click();
  h.q('[data-act="save"]').click();
  await flush();
  const merges = h.runs.filter((r) => r.v.verb === "merge");
  assert.equal(merges.length, 1, "one save, however many clicks");
  assert.deepEqual(merges[0].v, { verb: "merge", paths: [A, B], into: { title: "Keep diffs small", description: BY_HAND.description, body: BY_HAND.body }, expect: [H("a"), H("b")] });
  assert.equal(h.q('[data-act="save"]').textContent, "Saving…");
  assert.equal(h.q('[data-act="cancel"]').disabled, true);
  assert.equal(h.q('[data-field="title"]').readOnly, true);
  h.q('[data-act="cancel"]').click();   // Escape, ✕ and a click outside call close() too
  assert.equal(h.open(), true, "closing waits for the save's answer");
  done.resolve({ ok: true, json: { path: A, superseded: [B], record: "20261012-120000-abcd1234", hash: H("e"), brainMd: { ok: true } } });
  await flush();
  assert.equal(h.open(), false);
  assert.equal(h.saved(), true);
  assert.match(notices[notices.length - 1], /^Merged 2 memories into “Keep diffs small”\. Undo merge is in Library for 30 days\.$/);
});

test("a source changed since the dialog read it: nothing written, the dialog says to open the merge again, Save stays off", async () => {
  const h = await harness({ run: async () => fail(`${A} changed since it was read: open the merge again`, true) });
  h.q('[data-act="save"]').click();
  await flush();
  const err = h.q(".aos-brain-mg-err");
  assert.equal(err.textContent, MERGE_STALE_TEXT);
  assert.ok(err.classes.has("is-shown") && err.classes.has("is-stale"));
  assert.equal(h.q('[data-act="save"]').disabled, true);
  assert.equal(h.q('[data-act="draft"]').disabled, true);
  assert.equal(h.q('[data-act="cancel"]').textContent, "Close");
  h.q('[data-act="cancel"]').click();
  await flush();
  assert.equal(h.saved(), false);
  // Any other refusal says the runtime's own words, and Save stays on to try again.
  const g = await harness({ run: async () => fail("Brain's write surface is off in this app: run the aos memory command in a terminal instead") });
  g.q('[data-act="save"]').click();
  await flush();
  assert.match(g.q(".aos-brain-mg-err").textContent, /write surface is off/);
  assert.equal(g.q('[data-act="save"]').disabled, false);
});

test("no model: Draft with AI is off with the reason, and the merge is finished by hand (A4)", async () => {
  const off = { ...ESTIMATE, estimate: { available: false, reason: "no-provider", provider: "none", model: null, tokensIn: 0, tokensOut: 0, usd: 0, cap: null } };
  const h = await harness({ estimate: { ok: true, json: off } });
  assert.equal(h.q('[data-act="draft"]').disabled, true);
  assert.equal(h.q(".aos-brain-mg-est").textContent, "No model provider is set up. Combine them by hand below.");
  assert.ok(h.q(".aos-brain-mg-est").classes.has("is-off"));
  assert.equal(h.q('[data-act="save"]').disabled, false);
});

test("the limits turn Save off and say why; fixing the field turns it back on", async () => {
  const h = await harness();
  h.q('[data-field="title"]').type("   ");
  assert.equal(h.q('[data-act="save"]').disabled, true);
  assert.equal(h.q(".aos-brain-mg-problem").textContent, "The merged memory needs a title.");
  h.q('[data-field="title"]').type("Small diffs");
  h.q('[data-field="body"]').type("b".repeat(16_001));
  assert.equal(h.q(".aos-brain-mg-problem").textContent, "The body is over 16,000 characters.");
  assert.ok(h.q(".aos-brain-mg-count").classes.has("is-over"));
  h.q('[data-field="body"]').type("Short.");
  assert.equal(h.q(".aos-brain-mg-problem").textContent, "");
  assert.equal(h.q('[data-act="save"]').disabled, false);
});

test("an estimate that fails says why, and only Cancel works", async () => {
  const h = await harness({ estimate: fail("This vault's runtime predates the Brain hub: run aos upgrade") });
  assert.equal(h.q(".aos-brain-mg-err").textContent, "This vault's runtime predates the Brain hub: run aos upgrade");
  assert.equal(doc.body!.querySelector('[data-act="draft"]'), null);
  assert.equal(h.q('[data-act="save"]').disabled, true);
  h.q('[data-act="cancel"]').click();
  await flush();
  assert.equal(h.open(), false);
  assert.equal(h.saved(), false);
});
