// SpaceDialogs.ts — the Spaces tab's small dialogs (spec 2026-10-09-spaces-redesign, PR 3): the confirmation every move
// opens (Archive, Restore, Rename, Adopt; §6 Confirmation: it names the source and destination, the threads that move
// and the notes whose tag flips, and Cancel runs nothing), the workspace picker Adopt and Link as code folder use for a
// folder whose name matches none, + to-do and Link to-dos… (D35). Each takes the action as a callback that answers an
// error to show, or null when it is done; the dialog itself writes and spawns nothing. The shell (`dialogShell`) is the
// one NewSpaceModal and DraftModal use too: the Manage and Draft mocks' header, body and footer, with --udx-* tokens.
import { FuzzySuggestModal, Modal } from "obsidian";
import type { App } from "obsidian";
import type { WorkspaceEntry } from "../../data/snapshot";
import type { MovePlan, TodoSuggestion } from "../../data/spacesModel";

let seq = 0;
/** An id unique on the page, for aria-labelledby. */
export function dialogId(prefix: string): string { return `aos-spc-${prefix}-${++seq}`; }

export interface DialogShell { head: HTMLElement; title: HTMLElement; body: HTMLElement; foot: HTMLElement }

/** The dialog's frame: `.modal.mod-spc` with a header (title, an optional line under it), a body and a footer.
 *  `describedBy`: the id of what a screen reader reads after the title (a confirmation's plan). */
export function dialogShell(m: Modal, o: { cls: string; title: string; sub?: string | null; role?: "dialog" | "alertdialog"; describedBy?: string }): DialogShell {
  const id = dialogId("dlg");
  m.modalEl.addClass("mod-spc");
  m.modalEl.addClass(o.cls);
  m.modalEl.setAttr("role", o.role ?? "dialog");
  m.modalEl.setAttr("aria-modal", "true");
  m.modalEl.setAttr("aria-labelledby", id);
  if (o.describedBy) m.modalEl.setAttr("aria-describedby", o.describedBy);
  const c = m.contentEl;
  c.empty();
  c.addClass("aos-spc-dialog");
  const head = c.createEl("header", { cls: "aos-spc-dlghead" });
  const title = head.createEl("h2", { cls: "aos-spc-dlgtitle", text: o.title, attr: { id } });
  if (o.sub) head.createEl("p", { cls: "aos-spc-dlgsub", text: o.sub });
  const body = c.createDiv({ cls: "aos-spc-dlgbody" });
  const foot = c.createEl("footer", { cls: "aos-spc-dlgfoot" });
  return { head, title, body, foot };
}

/** A labelled field: the 11 px caps label over its control (the mocks' NAME, SUMMARY…). */
export function fieldLabel(parent: HTMLElement, text: string, o: { tag?: "label" | "div" } = {}): HTMLElement {
  const el = o.tag === "div" ? parent.createDiv({ cls: "aos-spc-field" }) : parent.createEl("label", { cls: "aos-spc-field" });
  el.createSpan({ cls: "aos-spc-flabel", text });
  return el;
}

/**
 * A field's control named by its caps label alone and described by its hint: the hint sits inside the <label>, so
 * without this it would be read as part of the name ("NAME workspaces/x already exists…"). → a setter for aria-invalid,
 * called wherever the hint turns into an error.
 */
export function wireField(field: HTMLElement, control: HTMLElement, hint: HTMLElement | null): (invalid: boolean) => void {
  const label = field.querySelector<HTMLElement>(".aos-spc-flabel");
  if (label) {
    if (!label.id) label.id = dialogId("flabel");
    control.setAttr("aria-labelledby", label.id);
  }
  if (hint) {
    if (!hint.id) hint.id = dialogId("fhint");
    control.setAttr("aria-describedby", hint.id);
  }
  return (invalid) => { if (invalid) control.setAttr("aria-invalid", "true"); else control.removeAttribute("aria-invalid"); };
}

/** A dialog button: the tab's own (`button.aos-spc-btn`), primary for the one that acts. */
export function dialogButton(parent: HTMLElement, text: string, o: { primary?: boolean; cls?: string; title?: string } = {}): HTMLButtonElement {
  const b = parent.createEl("button", {
    cls: `aos-spc-btn${o.primary ? " aos-spc-primary" : ""}${o.cls ? ` ${o.cls}` : ""}`,
    text, attr: { type: "button", ...(o.title ? { title: o.title } : {}) },
  });
  return b;
}

/** Shows `err` in the footer's error line (empty hides it). */
export function setError(el: HTMLElement, err: string | null): void {
  el.setText(err ?? "");
  el.toggleClass("is-shown", !!err);
}

// ── the confirmation of a move ──

export interface MoveConfirmOptions {
  plan: MovePlan;
  /** Rename: the new name typed here; the plan is drawn again as it changes. */
  rename?: {
    value: string;
    /** The slug a typed name becomes, and why it cannot be one (null when it can); `quiet` when that is no error
     *  (its name now, nothing typed yet): shown as a plain hint, though the move still waits for a new name. */
    check(typed: string): { slug: string; problem: string | null; quiet?: boolean };
    plan(slug: string): MovePlan;
  };
  /** Runs the move: answers an error to show, or null when it is done (the dialog then closes). */
  run(arg: string | null): Promise<string | null>;
}

/** What the confirm button reads while its move runs: progress, not the menu item's "Archive…" that opens a dialog. */
const BUSY_LABEL: Record<MovePlan["kind"], string> = { archive: "Archiving…", restore: "Restoring…", rename: "Renaming…", adopt: "Adopting…" };

/**
 * The confirmation every move opens (§6): the source and destination, what moves with the folder, the threads, the
 * notes whose status/ tag flips. Cancel, Escape and a click outside run nothing; it opens on Cancel (Rename on its
 * name), so a stray Enter never starts a move, and while the move runs it cannot be dismissed, so its answer is shown.
 */
export class MoveConfirmModal extends Modal {
  private busy = false;
  constructor(app: App, private o: MoveConfirmOptions) { super(app); }

  /** Escape, a click outside and ✕ wait while the move runs (Cancel is disabled then too). */
  close(): void {
    if (this.busy) return;
    super.close();
  }

  onOpen(): void {
    const planId = dialogId("plan");
    const shell = dialogShell(this, { cls: "mod-spc-confirm", title: this.o.plan.title, role: "alertdialog", describedBy: planId });
    const body = shell.body;
    let slug = this.o.rename ? this.o.rename.check(this.o.rename.value).slug : "";
    let input: HTMLInputElement | null = null;
    let hint: HTMLElement | null = null;
    let setInvalid: (invalid: boolean) => void = () => {};
    if (this.o.rename) {
      const f = fieldLabel(body, "NEW NAME");
      input = f.createEl("input", { cls: "aos-spc-input", attr: { type: "text", spellcheck: "false", "data-spc-field": "rename" } });
      input.value = this.o.rename.value;
      hint = f.createSpan({ cls: "aos-spc-fhint" });
      setInvalid = wireField(f, input, hint);
    }
    const planEl = body.createDiv({ cls: "aos-spc-plan", attr: { id: planId } });
    const err = shell.foot.createDiv({ cls: "aos-spc-dlgerr", attr: { role: "alert" } });
    shell.foot.createSpan({ cls: "aos-spc-grow" });
    const cancel = dialogButton(shell.foot, "Cancel", { cls: "aos-spc-cancel" });
    const ok = dialogButton(shell.foot, this.o.plan.confirm, { primary: true, cls: "aos-spc-confirm" });

    const draw = (): void => {
      const rn = this.o.rename;
      let plan = this.o.plan;
      let problem: string | null = null;
      if (rn && input && hint) {
        const c = rn.check(input.value);
        slug = c.slug;
        problem = c.problem;
        hint.setText(problem ?? (slug ? `workspaces/${slug}` : ""));
        hint.toggleClass("is-error", !!problem && !c.quiet);
        setInvalid(!!problem && !c.quiet);
        plan = rn.plan(slug);
      }
      shell.title.setText(plan.title);
      // Rename draws what moves only for a name it can take: never "Moves x to x", nor a move onto a taken name.
      if (rn && (problem || !slug)) {
        planEl.empty();
        planEl.createEl("p", { cls: "aos-spc-dlgnote", text: "Type a new name to see what moves." });
      } else renderPlan(planEl, plan);
      ok.disabled = this.busy || !!problem || (!!rn && !slug);
    };
    draw();
    input?.addEventListener("input", () => { setError(err, null); draw(); });
    input?.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ok.disabled) { ev.preventDefault(); void go(); } });
    cancel.addEventListener("click", () => this.close());
    const go = async (): Promise<void> => {
      if (this.busy || ok.disabled) return;
      this.busy = true;
      ok.disabled = true;
      cancel.disabled = true;
      if (input) input.disabled = true;
      setError(err, null);
      const label = ok.getText();
      ok.setText(BUSY_LABEL[this.o.plan.kind]);
      this.modalEl.setAttr("aria-busy", "true");
      let failed: string | null = null;
      try { failed = await this.o.run(this.o.rename ? slug : null); }
      catch (e) { failed = e instanceof Error ? e.message : String(e); }
      this.busy = false;
      this.modalEl.removeAttribute("aria-busy");
      if (!failed) { this.close(); return; }
      ok.setText(label);
      cancel.disabled = false;
      if (input) input.disabled = false;
      setError(err, failed);
      draw();
    };
    ok.addEventListener("click", () => void go());
    // The least destructive control first (an alertdialog): Rename's name field, else Cancel.
    (input ?? cancel).focus();
    input?.select();
  }

  onClose(): void { this.contentEl.empty(); }
}

/** The plan in the dialog: from → to, the items, the notes, a warning and the footnote. */
export function renderPlan(el: HTMLElement, plan: MovePlan): void {
  el.empty();
  const move = el.createDiv({ cls: "aos-spc-move" });
  move.createSpan({ cls: "aos-spc-mono aos-spc-movefrom", text: plan.from });
  move.createSpan({ cls: "aos-spc-movearrow", text: "→", attr: { "aria-label": "to" } });
  move.createSpan({ cls: "aos-spc-mono aos-spc-moveto", text: plan.to });
  const ul = el.createEl("ul", { cls: "aos-spc-planlist" });
  for (const it of plan.items) ul.createEl("li", { text: it });
  if (plan.notes.length) {
    const n = el.createDiv({ cls: "aos-spc-plannotes" });
    n.createSpan({ cls: "aos-spc-flabel", text: "NOTES WHOSE TAG FLIPS" });
    const list = n.createEl("ul", { cls: "aos-spc-planlist" });
    const shown = plan.notes.slice(0, 6);
    for (const t of shown) list.createEl("li", { text: t });
    if (plan.notes.length > shown.length) list.createEl("li", { cls: "aos-spc-dim", text: `and ${plan.notes.length - shown.length} more` });
  }
  if (plan.warn) el.createEl("p", { cls: "aos-spc-planwarn", text: plan.warn });
  if (plan.footnote) el.createEl("p", { cls: "aos-spc-dlgnote", text: plan.footnote });
}

// ── a workspace, picked ──

/**
 * Adopt into… and Link as code folder of… for a folder whose name matches no workspace (D16). What it does (`sentence`:
 * the folder and the action) is a line of its own above the input and the input's accessible name, never only a
 * placeholder that a long path cuts off and the first keystroke hides; `purpose` says what Enter does.
 */
export class WorkspacePickerModal extends FuzzySuggestModal<WorkspaceEntry> {
  constructor(app: App, private items: WorkspaceEntry[], sentence: string, private onPick: (e: WorkspaceEntry) => void, purpose?: string) {
    super(app);
    this.modalEl.addClass("mod-spc-picker");
    const head = createDiv({ cls: "aos-spc-pickhead", text: sentence });
    this.modalEl.insertBefore(head, this.inputEl.parentElement);
    this.setPlaceholder("Type a workspace name");
    this.inputEl.setAttr("aria-label", sentence);
    if (purpose) this.setInstructions([{ command: "↵", purpose }]);
    this.emptyStateText = "No workspace matches";
  }
  getItems(): WorkspaceEntry[] { return this.items; }
  getItemText(e: WorkspaceEntry): string { return e.label || e.name; }
  onChooseItem(e: WorkspaceEntry): void { this.onPick(e); }
}

// ── + to-do and Link to-dos… (D35) ──

/** + to-do: one line for TODO.md, tagged `#ws/<slug>`; the To-Do surface's writer adds it. */
export class TodoForSpaceModal extends Modal {
  private busy = false;
  constructor(app: App, private name: string, private slug: string, private add: (text: string) => Promise<string | null>) { super(app); }

  /** Escape, a click outside and ✕ wait while the line is written, so a refusal is shown. */
  close(): void {
    if (this.busy) return;
    super.close();
  }

  onOpen(): void {
    const shell = dialogShell(this, { cls: "mod-spc-todo", title: `New to-do for ${this.name}`, sub: "Added to TODO.md under Open, tagged for this workspace." });
    const f = fieldLabel(shell.body, "TO-DO");
    const input = f.createEl("input", { cls: "aos-spc-input", attr: { type: "text", spellcheck: "true", "data-spc-field": "todo", placeholder: "What needs doing?" } });
    const line = f.createSpan({ cls: "aos-spc-fhint aos-spc-mono" });
    wireField(f, input, line);
    const err = shell.foot.createDiv({ cls: "aos-spc-dlgerr", attr: { role: "alert" } });
    shell.foot.createSpan({ cls: "aos-spc-grow" });
    const cancel = dialogButton(shell.foot, "Cancel", { cls: "aos-spc-cancel" });
    const ok = dialogButton(shell.foot, "Add to-do", { primary: true, cls: "aos-spc-confirm" });
    const draw = (): void => {
      const t = input.value.replace(/[\r\n]+/g, " ").trim();
      line.setText(`- [ ] ${t || "…"} #ws/${this.slug}`);
      ok.disabled = !t;
    };
    draw();
    input.addEventListener("input", () => { setError(err, null); draw(); });
    const go = async (): Promise<void> => {
      if (ok.disabled || this.busy) return;
      this.busy = true;
      ok.disabled = true;
      cancel.disabled = true;
      const failed = await this.add(input.value.replace(/[\r\n]+/g, " ").trim()).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      this.busy = false;
      cancel.disabled = false;
      if (!failed) { this.close(); return; }
      setError(err, failed);
      draw();
    };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); void go(); } });
    cancel.addEventListener("click", () => this.close());
    ok.addEventListener("click", () => void go());
    input.focus();
  }

  onClose(): void { this.contentEl.empty(); }
}

/**
 * Link to-dos… (D35): the untagged to-dos that name the workspace (spacesModel todoLinkSuggestions), each with one Link
 * button that adds `#ws/<slug>` to that line through the To-Do surface's writer. Nothing is tagged without that click.
 */
export class LinkTodosModal extends Modal {
  constructor(app: App, private name: string, private slug: string, private items: TodoSuggestion[], private link: (s: TodoSuggestion) => Promise<string | null>) { super(app); }

  onOpen(): void {
    const shell = dialogShell(this, {
      cls: "mod-spc-linktodos", title: `Link to-dos to ${this.name}`,
      sub: `Open to-dos with no #ws/ tag that name ${this.name}. Link adds #ws/${this.slug} to that line in TODO.md.`,
    });
    const err = shell.foot.createDiv({ cls: "aos-spc-dlgerr", attr: { role: "alert" } });
    shell.foot.createSpan({ cls: "aos-spc-grow" });
    const done = dialogButton(shell.foot, "Done", { cls: "aos-spc-cancel" });
    done.addEventListener("click", () => this.close());
    if (!this.items.length) {
      shell.body.createEl("p", { cls: "aos-spc-emptyval", text: `No untagged to-do names ${this.name}. Add one with + to-do, or tag a line with #ws/${this.slug} in To-Do.` });
      done.focus();
      return;
    }
    const list = shell.body.createEl("ul", { cls: "aos-spc-suggest", attr: { "aria-label": "Suggested to-dos" } });
    let first: HTMLButtonElement | null = null;
    for (const s of this.items) {
      const li = list.createEl("li", { cls: "aos-spc-sugrow" });
      const text = li.createDiv({ cls: "aos-spc-sugtext" });
      text.createSpan({ cls: "aos-spc-sugline", text: s.text });
      text.createSpan({ cls: "aos-spc-lhow", text: s.how === "former" ? `names its former name ${s.former}` : `names “${s.matched}”` });
      const b = dialogButton(li, "Link", { cls: "aos-spc-small aos-spc-suglink", title: `Add #ws/${this.slug} to this to-do` });
      // Each Link names its to-do for a screen reader, not only in a tooltip.
      b.setAttr("aria-label", `Link “${s.text}” to ${this.name}`);
      first ??= b;
      b.addEventListener("click", async () => {
        b.disabled = true;
        setError(err, null);
        const failed = await this.link(s).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
        if (failed) { b.disabled = false; setError(err, failed); return; }
        b.setText("Linked");
        li.addClass("is-linked");
      });
    }
    first?.focus();
  }

  onClose(): void { this.contentEl.empty(); }
}
