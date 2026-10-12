// MergeModal.ts — Merge with AI (brain-hub D21; spec 2026-10-12-brain-hub-ai A1, A2, A4, A5, A8, A9, A12; the plan's
// PR 4 Mechanics › HUD › Merge; canvas Merge). BrainTab hands it to every mode as ctx.merge(paths); Review's M, Health's
// duplicate rows and a sweep's Merge card open it on 2–6 memories.
//
// On open it runs `merge-draft --estimate` (ctx.preview: no model call, nothing written) and fills the editable draft
// with the no-model prefill (`byHand`, A4), so a merge can always be finished by hand. The sources sit on the left
// (type, title, path · created · source, the body as plain text); the draft on the right: Title, Description and Body
// (made with createEl and capped at MERGE_LIMITS; model text is only ever a value, never markup), the target line (the
// oldest keeps its path and its links, A1), Draft with AI beside what one call would cost or why none can be made (A5),
// the spend line after a draft, and what Save merged will do. Draft with AI runs `merge-draft` (ctx.run, AI_TIMEOUT_MS,
// A12), keeping the keyboard while it waits (aria-disabled, never disabled), and asks before its fields replace ones the
// person edited; a by-hand answer (no provider, a cap, no answer, a bad reply) shows its reason, and for a reply that
// could not be read who answered and what it cost, and leaves the draft to finish. Cancel while a draft runs drops its
// answer (a seq counter, as DraftModal) and says the call may still be billed; the dialog stays, to finish by hand.
// Save merged runs `merge … --expect <every source's hash>` once; while it runs nothing else does and the dialog cannot
// be closed, so its answer is shown. A memory changed since the dialog read it is refused by the runtime (CHANGED, A9):
// nothing is written, and the dialog says to open the merge again. The pure parts are exported for MergeModal.test.ts.
import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import {
  AI_TIMEOUT_MS, MERGE_LIMITS, UNDO_DAYS, bodyWithoutTitle, estimateText, parseMergeDraft, parseMergeEstimate, providerName,
  shortDay, spendText, type BrainMemory, type MergeDraft, type MergeEstimate, type MergeFields, type MergeResult, type MergeSource,
} from "../../data/brainModel";
import { dialogId } from "../../ui/spaces/SpaceDialogs";
import type { BrainCtx } from "./types";

// ── the pure parts ──

/** One line, as the runtime's Clean makes a title or a description (A8): control characters (a pasted line break, a
 *  tab) become one space, and the ends are trimmed. */
export const oneLine = (v: string): string => v.replace(/\s*[\u0000-\u001f\u007f\u2028\u2029]+\s*/g, " ").trim();

/** The fields Save sends: Clean's tidying done here (a one-line title and description, LF line ends, trimmed), so the
 *  runtime, which refuses rather than cuts (`BAD_FIELD`), only refuses what the dialog already says is too long. */
export function mergeInto(f: MergeFields): MergeFields {
  return { title: oneLine(f.title), description: oneLine(f.description), body: f.body.replace(/\r\n?/g, "\n").trim() };
}

const count = (n: number): string => n.toLocaleString("en-US");

/** Why Save merged is off for these fields (A8's limits; `merge --into` takes 1–120, 1–200 and 1–16,000 characters,
 *  and, as MEMORY.md links the memory as [title](path), no `[` or `]` in the title and no `](` in the description),
 *  or null when they can be saved. */
export function mergeProblem(f: MergeFields): string | null {
  const c = mergeInto(f);
  if (!c.title) return "The merged memory needs a title.";
  if (c.title.length > MERGE_LIMITS.title) return `The title is over ${count(MERGE_LIMITS.title)} characters.`;
  if (/[[\]]/.test(c.title)) return "The title cannot hold [ or ]: MEMORY.md links it as [title](path).";
  if (!c.description) return "The merged memory needs a description.";
  if (c.description.length > MERGE_LIMITS.description) return `The description is over ${count(MERGE_LIMITS.description)} characters.`;
  if (/\]\(/.test(c.description)) return "The description cannot hold “](”: MEMORY.md would read it as a link.";
  if (!c.body) return "The merged memory needs a body.";
  if (c.body.length > MERGE_LIMITS.body) return `The body is over ${count(MERGE_LIMITS.body)} characters.`;
  return null;
}

/** "feedback/small-diffs.md": a memory's path under brain/memory, as the dialog names it. */
export const memoryFile = (path: string): string => path.replace(/^brain\/memory\//, "");

/** The target line (A1; canvas Merge): the oldest keeps its path, so its [[links]], pins and use carry over. */
export function targetLine(winner: string, sources: number): string {
  return `${memoryFile(winner)} · keeps the ${sources > 2 ? "oldest" : "older"} slug's links`;
}

/** What Save merged does (A1, A2, A9), in the canvas's words; `pinned` when a source is pinned (the merge keeps a pin). */
export function savingWill(winner: string, others: number, pinned: boolean): string[] {
  return [
    `write the merged text into ${memoryFile(winner)}, mark it reviewed`,
    others === 1 ? "mark the other one superseded by it" : `mark the other ${others} superseded by it`,
    "replace their MEMORY.md lines with one",
    ...(pinned ? ["keep it pinned to BRAIN.md, as a source is pinned"] : []),
    `log it, so Undo merge works for ${UNDO_DAYS} days`,
  ];
}

/** The sources as the left pane lists them: the oldest (the one written over) first, then the rest as the runtime
 *  gives them. */
export function sourceOrder(sources: readonly MergeSource[], winner: string): MergeSource[] {
  return [...sources.filter((s) => s.path === winner), ...sources.filter((s) => s.path !== winner)];
}

/**
 * The line after a by-hand answer (A4, A5): its reason, then, when a model did answer (a reply that could not be read:
 * the runtime keeps its provider, model and cost, as the call was made and may be billed), who answered and what it cost.
 * A call that failed or never ran came back with no model and nothing spent, so nothing more is said.
 */
export function byHandText(d: Pick<MergeDraft, "reason" | "provider" | "model" | "usd" | "estimated" | "cap">): string {
  const head = `${d.reason ?? "No model answered."} Finish the draft by hand.`;
  const answered = d.provider !== "none" && (!!d.model || d.usd > 0);
  return answered ? `${head} · ${spendText(d, "answered by")}` : head;
}

/** What a stale save says: nothing was written, and the dialog's hashes are old, so only a fresh open can save. */
export const MERGE_STALE_TEXT = "Nothing was written: a memory changed since this dialog read it. Close it and open the merge again.";
/** What Cancel says while a draft runs (A12): the answer is dropped; the call itself is not stopped. */
export const MERGE_CANCEL_TEXT = "Stopped waiting for the draft. The model call may still be billed.";

// ── the dialog ──

type Busy = "loading" | "drafting" | "saving" | null;
type Base = Pick<MergeEstimate, "winner" | "type" | "sources" | "baseHashes" | "truncated">;
type Tone = "drafting" | "ai" | "by-hand" | "cancelled" | null;

interface Els { sub: HTMLElement; body: HTMLElement; err: HTMLElement; problem: HTMLElement; cancel: HTMLButtonElement; save: HTMLButtonElement }
interface FormEls {
  ai: HTMLButtonElement;
  est: HTMLElement;
  spend: HTMLElement;
  title: HTMLInputElement;
  description: HTMLInputElement;
  body: HTMLTextAreaElement;
  bodyCount: HTMLElement;
}

/** Open the Merge dialog on 2–6 memories; resolves true when Save merged wrote the merge, false on Cancel or a failure. */
export function openMerge(ctx: BrainCtx, paths: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => new MergeModal(ctx.plugin.app, ctx, paths, resolve).open());
}

export class MergeModal extends Modal {
  private readonly paths: string[];
  private busy: Busy = null;
  private seq = 0;
  private closed = false;
  private saved = false;
  /** Save was refused because a memory changed: the hashes are old, so Save and Draft stay off (open it again). */
  private stale = false;
  /** The estimate's answer: what a call would cost (A5); null until it is read, or when it could not be. */
  private est: MergeEstimate | null = null;
  /** The winner, the sources and their hashes from the newest answer (the estimate, then each draft): what Save sends. */
  private base: Base | null = null;
  private fields: MergeFields = { title: "", description: "", body: "" };
  /** The person changed a field since it was last filled: a model draft asks before it replaces them. */
  private edited = false;
  /** A model draft came back once: the button reads Redraft. */
  private drafted = false;
  private els: Els | null = null;
  private form: FormEls | null = null;

  constructor(app: App, private ctx: BrainCtx, paths: readonly string[], private resolve: (saved: boolean) => void = () => {}) {
    super(app);
    this.paths = [...paths];
  }

  onOpen(): void {
    const ids = { title: dialogId("merge-title"), sub: dialogId("merge-sub") };
    this.modalEl.addClass("mod-brain-merge");
    this.modalEl.setAttr("role", "dialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.modalEl.setAttr("aria-labelledby", ids.title);
    this.modalEl.setAttr("aria-describedby", ids.sub);
    const c = this.contentEl;
    c.empty();
    c.addClass("aos-brain-merge");
    const head = c.createEl("header", { cls: "aos-brain-mg-head" });
    head.createEl("h2", { cls: "aos-brain-mg-title", text: `Merge ${this.paths.length} memories into one`, attr: { id: ids.title } });
    const sub = head.createEl("p", { cls: "aos-brain-mg-sub", text: "Reading the memories. Nothing is written until you save.", attr: { id: ids.sub } });
    const body = c.createDiv({ cls: "aos-brain-mg-body" });
    const foot = c.createEl("footer", { cls: "aos-brain-mg-foot" });
    const err = foot.createDiv({ cls: "aos-brain-mg-err", attr: { role: "alert" } });
    const problem = foot.createDiv({ cls: "aos-brain-mg-problem", attr: { "aria-live": "polite" } });
    const acts = foot.createDiv({ cls: "aos-brain-mg-acts" });
    const cancel = acts.createEl("button", { cls: "aos-brain-btn aos-brain-mg-cancel", text: "Cancel", attr: { type: "button", "data-act": "cancel" } });
    const save = acts.createEl("button", { cls: "aos-brain-btn is-primary aos-brain-mg-save", text: "Save merged", attr: { type: "button", "data-act": "save" } });
    this.els = { sub, body, err, problem, cancel, save };
    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", () => void this.save());
    this.paint();
    // The dialog takes the keyboard at once: Cancel is the one control that works while it reads.
    cancel.focus();
    void this.load();
  }

  /**
   * Cancel, Escape, a click outside and ✕: while a draft runs they drop its answer and say the call may still be billed
   * (the dialog stays, to finish by hand); while Save runs they wait, so its answer (a refusal, the saved notice) is
   * never lost; otherwise the dialog closes.
   */
  close(): void {
    if (this.busy === "saving") return;
    if (this.busy === "drafting") { this.stopDraft(); return; }
    super.close();
  }

  onClose(): void {
    this.closed = true;
    this.resolve(this.saved);
    this.contentEl.empty();
  }

  // ── steps ──

  /** `merge-draft --estimate`: the sources, their hashes, the by-hand draft and what a call would cost. */
  private async load(): Promise<void> {
    const els = this.els;
    if (!els) return;
    this.busy = "loading";
    const seq = ++this.seq;
    els.body.setAttr("aria-busy", "true");
    els.body.createDiv({ cls: "aos-brain-mg-wait", text: "Reading the memories…", attr: { role: "status" } });
    this.paint();
    const r = await this.ctx.preview<unknown>({ verb: "merge-draft", paths: this.paths, estimate: true }, "Merge");
    if (this.closed || seq !== this.seq) return;
    this.busy = null;
    els.body.removeAttribute("aria-busy");
    const e = r.ok ? parseMergeEstimate(r.json) : null;
    if (!e) {
      els.body.empty();
      els.body.createEl("p", { cls: "aos-brain-empty", text: "These memories could not be read for a merge." });
      els.sub.setText("Nothing was written.");
      this.error(r.ok ? "aos memory merge-draft answered in an unexpected shape: run aos upgrade" : r.reason);
      this.paint();
      return;
    }
    this.est = e;
    this.base = e;
    els.sub.setText("Edit the draft on the right, or draft it with AI. Nothing is written until you save.");
    this.renderForm();
    this.fill(e.byHand);
    // The draft takes the keyboard when it arrives, unless the person already chose a control of their own.
    const a = this.modalEl.ownerDocument.activeElement;
    if (!a || !this.modalEl.contains(a) || a === els.cancel) this.form?.title.focus();
  }

  /** Draft with AI: one `merge-draft` call through the provider chain (A7), waited for up to AI_TIMEOUT_MS (A12). */
  private async draftWithAi(): Promise<void> {
    const e = this.est?.estimate;
    if (!this.form || !e || !e.available || this.busy || this.stale) return;
    this.busy = "drafting";
    const seq = ++this.seq;
    this.error(null);
    this.say(`Drafting with ${e.model ?? providerName(e.provider)} · ${providerName(e.provider)}, up to two minutes. You can keep editing; Cancel stops waiting.`, "drafting");
    this.paint();
    const r = await this.ctx.run<unknown>({ verb: "merge-draft", paths: this.paths, estimate: false }, "Draft with AI", { timeoutMs: AI_TIMEOUT_MS });
    // Cancelled (or closed) while it ran: the answer is dropped.
    if (this.closed || seq !== this.seq) return;
    this.busy = null;
    const d = r.ok ? parseMergeDraft(r.json) : null;
    if (!d) {
      this.say("");
      this.error(r.ok ? "aos memory merge-draft answered in an unexpected shape: run aos upgrade" : r.reason);
      this.paint();
      this.keepKeyboard();
      return;
    }
    this.base = d;
    if (d.mode === "by-hand") {
      // No model answered (none, a cap, no answer, a bad reply): its reason, and the by-hand draft stays to finish.
      this.say(byHandText(d), "by-hand");
      if (!this.edited) this.fill(d.fields);
      this.paint();
      this.keepKeyboard();
      return;
    }
    this.drafted = true;
    let use = !this.edited;
    if (!use) {
      // Who answered and what it cost show while the question is asked: the call was made either way.
      this.say(spendText(d), "ai");
      this.paint();
      use = await this.ctx.confirm("Replace your edits?", "The model's draft replaces the title, description and body you changed here.", "Replace");
      if (this.closed || seq !== this.seq) return;
    }
    if (use) this.fill(d.fields);
    this.say(use ? spendText(d) : `${spendText(d)} · not used: your edits are kept`, "ai");
    this.paint();
    this.keepKeyboard();
  }

  /** After a draft's answer or a stop: when the keyboard is nowhere in the dialog, Draft with AI takes it back. */
  private keepKeyboard(): void {
    const ai = this.form?.ai;
    if (!ai || this.closed) return;
    const doc = this.modalEl.ownerDocument;
    const a = doc.activeElement as HTMLElement | null;
    // In the dialog already, or in another dialog on top (it gives the keyboard back itself when it closes).
    if (a && a !== doc.body && (this.modalEl.contains(a) || a.closest?.(".modal"))) return;
    (ai.disabled ? this.form?.title : ai)?.focus();
  }

  /** Cancel while a draft runs: its answer is dropped (seq); the call itself is not stopped (A12). */
  private stopDraft(): void {
    ++this.seq;
    this.busy = null;
    this.say(MERGE_CANCEL_TEXT, "cancelled");
    this.paint();
    this.keepKeyboard();
  }

  /** Save merged: `merge … --into … --expect <every source's hash>` once (A9). */
  private async save(): Promise<void> {
    const els = this.els;
    const b = this.base;
    if (!els || !b || this.busy || this.stale) return;
    const into = mergeInto(this.fields);
    if (mergeProblem(into)) return;
    this.busy = "saving";
    ++this.seq;
    this.error(null);
    this.paint();
    const r = await this.ctx.run<MergeResult>({ verb: "merge", paths: this.paths, into, expect: b.baseHashes }, "Merge");
    this.busy = null;
    if (this.closed) return;
    if (r.ok) {
      this.saved = true;
      new Notice(`Merged ${this.paths.length} memories into “${into.title}”. Undo merge is in Library for ${UNDO_DAYS} days.`);
      this.close();
      return;
    }
    // CHANGED (A9): a source changed since the dialog read it. Its hashes are old now: open the merge again.
    if (r.stale || /changed since/.test(r.reason)) {
      this.stale = true;
      this.error(MERGE_STALE_TEXT, r.reason);
      els.err.addClass("is-stale");
    } else this.error(r.reason);
    this.paint();
    els.cancel.focus();
  }

  // ── drawing ──

  private renderForm(): void {
    const els = this.els;
    const e = this.est;
    if (!els || !e) return;
    els.body.empty();
    const grid = els.body.createDiv({ cls: "aos-brain-mg-grid" });
    const d = this.ctx.data();

    const left = grid.createEl("section", { cls: "aos-brain-mg-sources", attr: { "aria-label": "The memories merged" } });
    left.createEl("h3", { cls: "aos-brain-label", text: `SOURCES · ${e.sources.length}` });
    for (const s of sourceOrder(e.sources, e.winner)) this.source(left, s, d.byPath.get(s.path) ?? null, s.path === e.winner);

    const right = grid.createEl("section", { cls: "aos-brain-mg-draft", attr: { "aria-label": "The merged memory" } });
    right.createEl("h3", { cls: "aos-brain-label", text: "MERGED MEMORY" });
    const row = right.createDiv({ cls: "aos-brain-mg-airow" });
    const estId = dialogId("merge-est");
    const ai = row.createEl("button", { cls: "aos-brain-btn is-small aos-brain-mg-ai", text: "Draft with AI", attr: { type: "button", "data-act": "draft", "aria-describedby": estId } });
    const est = row.createSpan({ cls: "aos-brain-mg-est", attr: { id: estId } });
    ai.addEventListener("click", () => void this.draftWithAi());
    const spend = right.createEl("p", { cls: "aos-brain-mg-spend", attr: { role: "status", "aria-live": "polite" } });

    const title = this.input(right, "TITLE", "title", MERGE_LIMITS.title);
    const description = this.input(right, "DESCRIPTION", "description", MERGE_LIMITS.description);
    // The count sits beside the label, not in it: the field is named "BODY" alone, and the count is its description.
    const bw = right.createDiv({ cls: "aos-brain-mg-field" });
    const bf = bw.createEl("label", { cls: "aos-brain-mg-field" });
    bf.createSpan({ cls: "aos-brain-mg-flabel", text: "BODY" });
    const countId = dialogId("merge-count");
    const body = bf.createEl("textarea", {
      cls: "aos-brain-mg-input",
      attr: { rows: "12", maxlength: String(MERGE_LIMITS.body), "data-field": "body", "aria-describedby": countId },
    });
    const bodyCount = bw.createSpan({ cls: "aos-brain-mg-count aos-brain-mono", attr: { id: countId } });
    body.addEventListener("input", () => { this.fields.body = body.value; this.edited = true; this.paint(); });

    right.createEl("p", { cls: "aos-brain-mg-target aos-brain-mono", text: targetLine(e.winner, e.sources.length) });
    if (e.sources.some((s) => s.type !== e.type)) right.createEl("p", { cls: "aos-brain-mg-note", text: `Saved as a ${e.type} memory: the oldest one's type.` });
    if (e.truncated) {
      right.createEl("p", { cls: "aos-brain-mg-note", text: "A long source is cut to fit the model's prompt (8,000 characters each, 24,000 in all): check a draft with AI against it." });
    }
    const will = right.createDiv({ cls: "aos-brain-mg-will" });
    will.createEl("h3", { cls: "aos-brain-label", text: "SAVING WILL" });
    const ul = will.createEl("ul", { cls: "aos-brain-mg-willlist" });
    const pinned = e.sources.some((s) => d.byPath.get(s.path)?.pin);
    for (const l of savingWill(e.winner, e.sources.length - 1, pinned)) ul.createEl("li", { text: l });

    this.form = { ai, est, spend, title, description, body, bodyCount };
  }

  /** One source beside the draft (D21): its type, title, path, created and source, and its body as plain text. */
  private source(parent: HTMLElement, s: MergeSource, m: BrainMemory | null, winner: boolean): void {
    const now = this.ctx.data().now;
    const box = parent.createEl("article", { cls: `aos-brain-mg-src${winner ? " is-winner" : ""}`, attr: { "data-path": s.path } });
    const head = box.createDiv({ cls: "aos-brain-mg-srchead" });
    head.createSpan({ cls: "aos-brain-type", text: s.type });
    const title = m?.title ?? s.title;
    head.createSpan({ cls: "aos-brain-mg-srctitle", text: title, attr: { title } });
    if (winner) head.createSpan({ cls: "aos-brain-pill is-off", text: "keeps its path", attr: { title: "The oldest: the merged text is written over it, so its links, pin and use carry over" } });
    if (s.truncated) head.createSpan({ cls: "aos-brain-pill is-warn", text: "cut for the model", attr: { title: "The model sees the first 8,000 characters of this one" } });
    if (m?.pin) head.createSpan({ cls: "aos-brain-pill is-info", text: "pinned" });
    const created = shortDay(s.created ?? m?.created ?? null, now);
    box.createDiv({
      cls: "aos-brain-mg-srcmeta aos-brain-mono",
      text: [memoryFile(s.path), created ? `created ${created}` : "", m?.source ?? ""].filter(Boolean).join(" · "),
    });
    const text = m ? bodyWithoutTitle(m.body, m.title).trim() : "";
    // Scrolls on its own; reachable by Tab so the keyboard can read a long one.
    box.createDiv({
      cls: `aos-brain-mg-srcbody${text ? "" : " is-empty"}`,
      text: text || (m ? "Nothing under the title." : "Not in this page's load yet."),
      attr: { role: "region", tabindex: "0", "aria-label": `Body of ${title}` },
    });
  }

  /** A one-line field under its caps label, capped at `max` characters (A8). */
  private input(parent: HTMLElement, label: string, key: "title" | "description", max: number): HTMLInputElement {
    const f = parent.createEl("label", { cls: "aos-brain-mg-field" });
    f.createSpan({ cls: "aos-brain-mg-flabel", text: label });
    const el = f.createEl("input", { cls: "aos-brain-mg-input", attr: { type: "text", maxlength: String(max), "data-field": key } });
    el.addEventListener("input", () => { this.fields[key] = el.value; this.edited = true; this.paint(); });
    return el;
  }

  /** The draft's fields, from the by-hand prefill or a model's draft; what the person types after this is an edit. */
  private fill(f: MergeFields): void {
    this.fields = { title: f.title, description: f.description, body: f.body };
    this.edited = false;
    const x = this.form;
    if (x) {
      x.title.value = f.title;
      x.description.value = f.description;
      x.body.value = f.body;
    }
    this.paint();
  }

  /** The line under Draft with AI: a draft running, who drafted it and what it cost, a by-hand reason, or a cancel. */
  private say(text: string, tone: Tone = null): void {
    const s = this.form?.spend;
    if (!s) return;
    s.setText(text);
    s.setAttr("data-tone", tone);
  }

  private error(text: string | null, detail?: string): void {
    const el = this.els?.err;
    if (!el) return;
    el.setText(text ?? "");
    el.toggleClass("is-shown", !!text);
    el.setAttr("title", detail ?? null);
    if (!text) el.removeClass("is-stale");
  }

  /** Every control from the state: busy, stale, the estimate, the fields' limits. */
  private paint(): void {
    const els = this.els;
    if (!els) return;
    const problem = this.base ? mergeProblem(this.fields) : null;
    els.save.disabled = this.busy !== null || !this.base || this.stale || !!problem;
    els.save.setText(this.busy === "saving" ? "Saving…" : "Save merged");
    els.cancel.disabled = this.busy === "saving";
    els.cancel.setText(this.stale ? "Close" : "Cancel");
    els.cancel.setAttr("title", this.busy === "drafting" ? "Stop waiting for the draft (the model call may still be billed)" : null);
    els.problem.setText(problem ?? "");
    els.problem.toggleClass("is-shown", !!problem);
    const f = this.form;
    if (!f) return;
    const e = this.est?.estimate ?? null;
    // Off (no estimate, no model, stale) is `disabled`; busy is aria-disabled, which keeps the keyboard on the button
    // while a draft runs (a disabled button would drop it to the page), and its clicks do nothing (draftWithAi).
    f.ai.disabled = this.stale || !e?.available;
    const waiting = this.busy !== null && !f.ai.disabled;
    f.ai.setAttr("aria-disabled", waiting ? "true" : null);
    f.ai.toggleClass("is-busy", waiting);
    if (this.busy === "drafting") f.ai.setAttr("aria-busy", "true");
    else f.ai.removeAttribute("aria-busy");
    f.ai.setText(this.busy === "drafting" ? "Drafting…" : this.drafted ? "Redraft" : "Draft with AI");
    f.est.setText(!e ? "" : e.available ? estimateText(e) : `${estimateText(e)} Combine them by hand below.`);
    f.est.toggleClass("is-off", !!e && !e.available);
    for (const el of [f.title, f.description, f.body]) el.readOnly = this.busy === "saving";
    const n = this.fields.body.replace(/\r\n?/g, "\n").trim().length;
    f.bodyCount.setText(`${count(n)} of ${count(MERGE_LIMITS.body)} characters`);
    f.bodyCount.toggleClass("is-over", n > MERGE_LIMITS.body);
  }
}
