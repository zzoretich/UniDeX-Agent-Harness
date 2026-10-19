// DraftModal.ts — Draft workspace.md (spec 2026-10-09-spaces-redesign D13, D14; the Draft mock). One click runs
// `aos workspace draft <name> --json` (one provider.js call, or the labelled heuristic), and the dialog shows the answer
// for review: Summary, Status (starting on "auto (not written)": the model is never asked for one), Objectives and Next
// as editable text (textareas and inputs made with createEl; model text is only ever a value, never markup), the
// sources it read, who answered, and the exact file Save would write, from `set … --dry-run`. Save sends only the keys
// that changed, compare-and-set on the hash the draft read (`--expect`); a workspace.md changed since then is refused
// ("workspace.md changed: draft again"). Draft again asks once more; Cancel writes nothing. The pure parts are exported
// for DraftModal.test.ts.
import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type { WorkspaceEntry } from "../../data/snapshot";
import { STALE_TEXT, workspaceArgs, type ManifestFields, type ManifestStatus, type VerbResult } from "../../data/spacesModel";
import { dialogButton, dialogShell, fieldLabel, setError } from "./SpaceDialogs";

// ── the model ──

/** What `aos workspace draft <name> --json` prints (the plan's Mechanics › PR 3 › Draft). */
export interface DraftOut {
  provider: string;
  model: string | null;
  reason: string | null;
  generatedAt: string | null;
  sources: string[];
  fields: { summary: string; objectives: string[]; next: string };
  /** workspaces/<name>/workspace.md */
  file: string;
  /** The hash of the file the draft read, or "none": what Save passes to --expect. */
  baseHash: string;
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** The draft's answer, checked, or null when it is not one. */
export function asDraft(json: unknown): DraftOut | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const f = (j.fields && typeof j.fields === "object" ? j.fields : null) as Record<string, unknown> | null;
  if (!f || typeof j.provider !== "string" || typeof j.baseHash !== "string" || !/^(?:none|[0-9a-f]{16,64})$/.test(j.baseHash)) return null;
  return {
    provider: j.provider,
    model: typeof j.model === "string" && j.model ? j.model : null,
    reason: typeof j.reason === "string" && j.reason ? j.reason : null,
    generatedAt: typeof j.generatedAt === "string" ? j.generatedAt : null,
    sources: Array.isArray(j.sources) ? j.sources.filter((x): x is string => typeof x === "string") : [],
    fields: {
      summary: s(f.summary),
      objectives: Array.isArray(f.objectives) ? f.objectives.filter((x): x is string => typeof x === "string") : [],
      next: s(f.next),
    },
    file: s(j.file),
    baseHash: j.baseHash,
  };
}

const PROVIDER_NAME: Record<string, string> = { ollama: "Ollama · local", claude: "Claude", codex: "Codex" };

/** Who answered (D14: the label names the provider that resolved, not the host the vault runs). */
export function providerLabel(d: Pick<DraftOut, "provider" | "model" | "reason">): { badge: "AI" | "HEURISTIC"; text: string; detail: string | null } {
  if (d.provider === "heuristic") return { badge: "HEURISTIC", text: "A heuristic draft: no model answered", detail: d.reason };
  const host = PROVIDER_NAME[d.provider] ?? d.provider;
  return { badge: "AI", text: d.model ? `Drafted by ${d.model} · ${host}` : `Drafted by ${host}`, detail: d.reason };
}

export type DraftStatus = "auto" | ManifestStatus;
export const DRAFT_STATUS_OPTIONS: ReadonlyArray<{ id: DraftStatus; label: string }> = [
  { id: "auto", label: "auto (not written)" },
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
  { id: "done", label: "Done" },
];

/** The dialog's fields; `touched` marks the ones the user edited (an edited field may be cleared on purpose). */
export interface DraftForm {
  summary: string;
  objectives: string[];
  next: string;
  status: DraftStatus;
  touched: { summary: boolean; objectives: boolean; next: boolean };
}

export function formFromDraft(d: DraftOut): DraftForm {
  return { summary: d.fields.summary, objectives: [...d.fields.objectives], next: d.fields.next, status: "auto", touched: { summary: false, objectives: false, next: false } };
}

/** What workspace.md sets today, as the scan read it: the baseline a changed key differs from. */
export interface DraftBase { summary: string | null; objectives: string[]; next: string | null; status: ManifestStatus | null }

export function draftBase(e: Pick<WorkspaceEntry, "summary" | "summarySource" | "objectives" | "next" | "statusOverride">): DraftBase {
  return {
    summary: e.summarySource === "manifest" ? e.summary ?? null : null,
    objectives: (e.objectives ?? []).filter((o) => o && o.source === "manifest" && o.text).map((o) => o.text),
    next: e.next?.source === "manifest" ? e.next.text ?? null : null,
    status: e.statusOverride ?? null,
  };
}

/** One line for a frontmatter value: line breaks, tabs and every other control character (which `set` refuses) become a
 *  space, as workspace-draft.js clean() does. */
export const oneLine = (v: string): string => v.replace(/\s*[\u0000-\u001f\u007f\u2028\u2029]+\s*/g, " ").trim();

/**
 * The keys Save sends (D13): a field the draft filled or the user edited, when it differs from what workspace.md sets.
 * A field the draft left empty and nobody touched is left alone (the draft's "" means "nothing drafted", and `set`
 * would read it as clear); one the user emptied is cleared. Status is sent only when one is picked: "auto (not
 * written)" writes no `status:`.
 */
export function draftChanges(form: DraftForm, base: DraftBase): ManifestFields {
  const out: ManifestFields = {};
  for (const k of ["summary", "next"] as const) {
    const v = oneLine(form[k]);
    if (!v && !form.touched[k]) continue;
    if (v === (base[k] ?? "")) continue;
    out[k] = v;
  }
  const list = form.objectives.map(oneLine).filter(Boolean);
  if ((list.length || form.touched.objectives) && JSON.stringify(list) !== JSON.stringify(base.objectives)) out.objectives = list;
  if (form.status !== "auto" && form.status !== base.status) out.status = form.status;
  return out;
}

/** The preview's badge: a new file, the changes Save would write, or none (Save is off then). */
export function previewBadge(baseHash: string, changes: ManifestFields): { text: "NEW FILE" | "CHANGES" | "NO CHANGES"; tone: "is-ok" | "is-changed" | "is-off" } {
  if (baseHash === "none") return { text: "NEW FILE", tone: "is-ok" };
  return Object.keys(changes).length ? { text: "CHANGES", tone: "is-changed" } : { text: "NO CHANGES", tone: "is-off" };
}

/** The preview's lines; a line the file did not have before is marked added (the mock's "+"). */
export function previewLines(text: string, before: string | null): Array<{ text: string; added: boolean }> {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const had = before === null ? null : new Map<string, number>();
  if (had) for (const l of String(before).replace(/\r\n/g, "\n").split("\n")) had.set(l, (had.get(l) ?? 0) + 1);
  return lines.map((l) => {
    if (!had) return { text: l, added: true };
    const n = had.get(l) ?? 0;
    if (n > 0) { had.set(l, n - 1); return { text: l, added: false }; }
    return { text: l, added: true };
  });
}

/**
 * What `set … --dry-run --json` answers that the preview uses: `text`, the exact file after, and `beforeText`, the file
 * as it is now (null when there is none, so every line is new). Its `before` is the old file's hash, never its text.
 */
export function dryRunText(json: unknown): { text: string; before: string | null } | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (typeof j.text !== "string") return null;
  return { text: j.text, before: typeof j.beforeText === "string" ? j.beforeText : null };
}

// ── the dialog ──

export interface DraftOptions {
  /** The workspace's folder name (WS), and how it shows. */
  name: string;
  label: string;
  base: DraftBase;
  /** Runs a verb (the page's runAosJson through the spaces surface). */
  run(args: string[], timeoutMs: number): Promise<VerbResult<unknown>>;
  /** After a Save: rescan, redraw. */
  saved(): void;
}

const DRAFT_TIMEOUT_MS = 120_000;
const PREVIEW_DELAY_MS = 350;

export class DraftModal extends Modal {
  private draft: DraftOut | null = null;
  private form: DraftForm | null = null;
  private closed = false;
  private busy: "drafting" | "saving" | null = null;
  private seq = 0;
  private previewTimer: number | null = null;
  private els: { sub: HTMLElement; body: HTMLElement; err: HTMLElement; who: HTMLElement; again: HTMLButtonElement; cancel: HTMLButtonElement; save: HTMLButtonElement } | null = null;
  private formShown = false;

  constructor(app: App, private o: DraftOptions) { super(app); }

  onOpen(): void {
    const shell = dialogShell(this, { cls: "mod-spc-draft", title: "", sub: "" });
    shell.title.empty();
    shell.title.appendText("Draft ");
    shell.title.createSpan({ cls: "aos-spc-mono", text: "workspace.md" });
    shell.title.appendText(` for ${this.o.label}`);
    const sub = shell.head.querySelector<HTMLElement>(".aos-spc-dlgsub") ?? shell.head.createEl("p", { cls: "aos-spc-dlgsub" });
    const who = shell.foot.createDiv({ cls: "aos-spc-who" });
    const err = shell.foot.createDiv({ cls: "aos-spc-dlgerr", attr: { role: "alert" } });
    // The three buttons as one group, kept together at the right however long the reason beside them is.
    const acts = shell.foot.createDiv({ cls: "aos-spc-dlgacts" });
    const again = dialogButton(acts, "Draft again", { cls: "aos-spc-again", title: "Ask again: one more model call, under the same caps" });
    const cancel = dialogButton(acts, "Cancel", { cls: "aos-spc-cancel" });
    const save = dialogButton(acts, "Save workspace.md", { primary: true, cls: "aos-spc-confirm" });
    this.els = { sub, body: shell.body, err, who, again, cancel, save };
    again.addEventListener("click", () => void this.runDraft());
    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", () => void this.save());
    void this.runDraft();
    // The dialog takes the keyboard at once: Cancel is the one control that works while it drafts.
    cancel.focus();
  }

  /** Escape, a click outside and ✕ wait while Save runs, so its answer (a refusal, or the saved notice) is never lost. */
  close(): void {
    if (this.busy === "saving") return;
    super.close();
  }

  onClose(): void {
    this.closed = true;
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.contentEl.empty();
  }

  private async runDraft(): Promise<void> {
    const els = this.els;
    if (!els || this.busy) return;
    this.busy = "drafting";
    const seq = ++this.seq;
    this.draft = null;
    this.form = null;
    setError(els.err, null);
    els.who.empty();
    els.sub.setText("Reading the workspace's own top-level files. Nothing is written until you save.");
    els.body.empty();
    els.body.setAttr("aria-busy", "true");
    els.body.createDiv({ cls: "aos-spc-drafting", text: "Drafting… one model call through the vault's provider, or a heuristic draft without one (up to two minutes).", attr: { role: "status", "aria-live": "polite" } });
    this.buttons();
    const r = await this.o.run(workspaceArgs.draft(this.o.name), DRAFT_TIMEOUT_MS);
    if (this.closed || seq !== this.seq) return;
    this.busy = null;
    els.body.removeAttribute("aria-busy");
    const d = r.ok ? asDraft(r.json) : null;
    if (!d) {
      els.body.empty();
      els.body.createEl("p", { cls: "aos-spc-emptyval", text: "No draft this time." });
      setError(els.err, r.ok ? "aos workspace draft answered in an unexpected shape" : r.reason);
      this.buttons();
      return;
    }
    this.draft = d;
    this.form = formFromDraft(d);
    els.sub.setText(d.sources.length
      ? `Read from ${d.sources.slice(0, 4).join(", ")}${d.sources.length > 4 ? ` and ${d.sources.length - 4} more` : ""}. Nothing is written until you save.`
      : "No readable file in the folder: the draft goes by its name. Nothing is written until you save.");
    const label = providerLabel(d);
    els.who.createSpan({ cls: `aos-spc-badge ${label.badge === "AI" ? "is-new" : "is-off"}`, text: label.badge });
    els.who.createSpan({ cls: "aos-spc-whotext", text: label.text, attr: label.detail ? { title: label.detail } : {} });
    if (label.detail && d.provider === "heuristic") els.who.createSpan({ cls: "aos-spc-whydetail", text: label.detail });
    this.renderForm();
    this.schedulePreview(0);
  }

  private renderForm(): void {
    const els = this.els;
    const d = this.draft;
    const f = this.form;
    if (!els || !d || !f) return;
    els.body.empty();
    const grid = els.body.createDiv({ cls: "aos-spc-draftgrid" });
    const form = grid.createEl("form", { cls: "aos-spc-form aos-spc-draftform", attr: { novalidate: "true" } });
    form.addEventListener("submit", (ev) => ev.preventDefault());
    const changed = (): void => { setError(els.err, null); this.schedulePreview(PREVIEW_DELAY_MS); this.buttons(); };

    const sum = fieldLabel(form, "SUMMARY");
    const sumBox = sum.createEl("textarea", { cls: "aos-spc-input aos-spc-textarea", attr: { rows: "3", "data-spc-field": "summary" } });
    sumBox.value = f.summary;
    sumBox.addEventListener("input", () => { f.summary = sumBox.value; f.touched.summary = true; changed(); });

    const st = fieldLabel(form, "STATUS");
    const sel = st.createEl("select", { cls: "aos-spc-input aos-spc-select", attr: { "data-spc-field": "status" } });
    for (const opt of DRAFT_STATUS_OPTIONS) {
      const el = sel.createEl("option", { text: opt.label, attr: { value: opt.id } });
      el.selected = opt.id === f.status;
    }
    st.createSpan({
      cls: "aos-spc-fhint",
      text: this.o.base.status ? `workspace.md sets ${this.o.base.status} today; auto leaves it as it is` : "auto: the scan works it out from sessions and commits",
    });
    sel.addEventListener("change", () => { f.status = (sel.value as DraftStatus) || "auto"; changed(); });

    const objSet = form.createEl("fieldset", { cls: "aos-spc-fieldset" });
    objSet.createEl("legend", { cls: "aos-spc-flabel", text: "OBJECTIVES" });
    const objList = objSet.createDiv({ cls: "aos-spc-objedit" });
    const drawObjectives = (focusLast = false): void => {
      objList.empty();
      f.objectives.forEach((text, i) => {
        const row = objList.createDiv({ cls: "aos-spc-objrow" });
        const input = row.createEl("input", { cls: "aos-spc-input", attr: { type: "text", "aria-label": `Objective ${i + 1}`, "data-spc-field": `objective-${i}` } });
        input.value = text;
        input.addEventListener("input", () => { f.objectives[i] = input.value; f.touched.objectives = true; changed(); });
        const rm = row.createEl("button", { cls: "aos-spc-iconbtn aos-spc-objrm", text: "✕", attr: { type: "button", "aria-label": `Remove objective ${i + 1}`, title: "Remove" } });
        rm.addEventListener("click", () => { f.objectives.splice(i, 1); f.touched.objectives = true; drawObjectives(); changed(); });
        if (focusLast && i === f.objectives.length - 1) input.focus();
      });
    };
    drawObjectives();
    const add = objSet.createEl("button", { cls: "aos-spc-btn aos-spc-addobj", text: "Add an objective", attr: { type: "button" } });
    add.addEventListener("click", () => { f.objectives.push(""); f.touched.objectives = true; drawObjectives(true); changed(); });

    const nx = fieldLabel(form, "NEXT");
    const nextBox = nx.createEl("textarea", { cls: "aos-spc-input aos-spc-textarea", attr: { rows: "2", "data-spc-field": "next" } });
    nextBox.value = f.next;
    nextBox.addEventListener("input", () => { f.next = nextBox.value; f.touched.next = true; changed(); });

    const src = form.createDiv({ cls: "aos-spc-sources" });
    src.createSpan({ text: "Sources" });
    if (d.sources.length) for (const n of d.sources) src.createSpan({ cls: "aos-spc-chip aos-spc-mono", text: n });
    else src.createSpan({ cls: "aos-spc-dim", text: "none readable" });

    const pv = grid.createDiv({ cls: "aos-spc-draftpreview", attr: { role: "region", "aria-label": "Preview of workspace.md" } });
    const ph = pv.createDiv({ cls: "aos-spc-prevtop" });
    ph.createSpan({ cls: "aos-spc-flabel", text: "PREVIEW" });
    ph.createSpan({ cls: "aos-spc-grow" });
    ph.createSpan({ cls: "aos-spc-badge", attr: { "data-spc-badge": "" } });
    ph.createSpan({ cls: "aos-spc-mono aos-spc-dim aos-spc-prevfile", text: d.file || `workspaces/${this.o.name}/workspace.md` });
    pv.createEl("pre", { cls: "aos-spc-draftpre", attr: { "data-spc-preview": "" } });
    pv.createEl("p", { cls: "aos-spc-dlgnote", text: "The body below the frontmatter stays yours: Save only touches these fields." });
    this.drawBadge();
    this.buttons();
    // The form takes the keyboard when it arrives, unless the user is already in it (or chose a control of their own).
    if (!this.formShown) {
      this.formShown = true;
      const active = document.activeElement;
      if (!active || !this.modalEl.contains(active) || active === els.cancel) sumBox.focus();
    }
  }

  /** The preview's badge, from what Save would send now (previewBadge). */
  private drawBadge(): void {
    const el = this.els?.body.querySelector<HTMLElement>("[data-spc-badge]");
    if (!el || !this.draft) return;
    const b = previewBadge(this.draft.baseHash, this.changes());
    el.className = `aos-spc-badge ${b.tone}`;
    el.setText(b.text);
  }

  private changes(): ManifestFields {
    return this.form ? draftChanges(this.form, this.o.base) : {};
  }

  private buttons(): void {
    const els = this.els;
    if (!els) return;
    els.again.disabled = this.busy !== null;
    els.cancel.disabled = this.busy === "saving";
    els.save.disabled = this.busy !== null || !this.draft || !Object.keys(this.changes()).length;
    els.save.setText(this.busy === "saving" ? "Saving…" : "Save workspace.md");
  }

  private schedulePreview(delay: number): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => { this.previewTimer = null; void this.preview(); }, delay);
  }

  /** The exact file Save would write: `set … --dry-run`, which writes nothing. */
  private async preview(): Promise<void> {
    const d = this.draft;
    const pre = this.els?.body.querySelector<HTMLElement>("[data-spc-preview]");
    if (!d || !pre) return;
    const seq = ++this.seq;
    const fields = this.changes();
    this.drawBadge();
    if (!Object.keys(fields).length) {
      pre.empty();
      pre.createSpan({ cls: "aos-spc-dim", text: "Nothing to save: every field matches workspace.md." });
      return;
    }
    const r = await this.o.run(workspaceArgs.set(this.o.name, fields, d.baseHash, { dryRun: true }), 60_000);
    if (this.closed || seq !== this.seq) return;
    pre.empty();
    const out = r.ok ? dryRunText(r.json) : null;
    if (!out) {
      pre.createSpan({ cls: "aos-spc-dim", text: "No preview." });
      if (!r.ok) setError(this.els!.err, r.stale ? STALE_TEXT : r.reason);
      return;
    }
    for (const l of previewLines(out.text, out.before)) {
      const line = pre.createSpan({ cls: `aos-spc-pline${l.added ? " is-added" : ""}` });
      line.createSpan({ cls: "aos-spc-pmark", text: l.added ? "+" : " ", attr: { "aria-hidden": "true" } });
      // The "+" is a mark for the eye; a screen reader hears which lines Save adds.
      if (l.added) line.createSpan({ cls: "aos-spc-sr", text: "added: " });
      line.createSpan({ text: l.text || " " });
    }
  }

  private async save(): Promise<void> {
    const els = this.els;
    const d = this.draft;
    const fields = this.changes();
    if (!els || !d || this.busy || !Object.keys(fields).length) return;
    this.busy = "saving";
    ++this.seq;   // a preview still running is stale now
    this.buttons();
    setError(els.err, null);
    const r = await this.o.run(workspaceArgs.set(this.o.name, fields, d.baseHash), 60_000);
    this.busy = null;
    if (this.closed) return;
    if (r.ok) {
      new Notice(`Saved ${d.file || `workspaces/${this.o.name}/workspace.md`}`);
      this.o.saved();
      this.close();
      return;
    }
    // A workspace.md changed since the draft read it: say so plainly; Draft again reads the new one.
    setError(els.err, r.stale ? STALE_TEXT : r.reason);
    els.err.toggleClass("is-stale", r.stale);
    this.buttons();
  }
}
