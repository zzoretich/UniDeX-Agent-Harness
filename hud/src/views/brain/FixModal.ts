// A hygiene fix's preview (spec 2026-10-11-brain-hub D20, §6; plan PR 3): the dry run's changes grouped by the file they
// write, each readable as before → after, at most FIX_SHOW of them and "and N more", then Cancel / the fix. It changes
// nothing itself: it resolves to true on confirm, and Health then runs the real `aos memory fix <kind>`. Fixes are not
// undoable, so it says so and Cancel takes the keyboard first. Styled like ConfirmModal (h3, p, .aos-capture-actions);
// announced as an alertdialog named by its title and described by what it changes and the no-undo note (the Spaces
// dialogs' pattern, SpaceDialogs.ts), so a screen reader hears them before the Cancel it lands on.
import { Modal, type App } from "obsidian";
import { dialogId } from "../../ui/spaces/SpaceDialogs";
import { fixChangeList, fixDialog, fixMoreText, type FixLine } from "../../data/brainHealth";
import type { FixKind, FixResult } from "../../data/brainModel";

export interface FixAsk {
  kind: FixKind;
  /** The dry run's answer (parseFixResult), with at least one change. */
  result: FixResult;
  /** A memory's title for a path, null when it is not one (BrainData.byPath). */
  titleOf(path: string): string | null;
}

/** Field changes read "before → after" with "none" for a missing value; index and draft changes name only their side. */
const FIELDS: ReadonlySet<FixLine["action"]> = new Set(["source", "type", "tags", "description"]);

export class FixModal extends Modal {
  private resolved = false;

  constructor(app: App, private o: FixAsk, private resolve: (ok: boolean) => void = () => {}) {
    super(app);
  }

  /** Whether to run the fix: true on confirm, false on Cancel, Escape or a click outside. */
  static ask(app: App, o: FixAsk): Promise<boolean> {
    return new Promise((resolve) => new FixModal(app, o, resolve).open());
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("mod-brain-fix");
    contentEl.addClass("aos-confirm-modal");
    contentEl.addClass("aos-brain-fixmodal");
    contentEl.setAttr("data-fix", this.o.kind);
    const words = fixDialog(this.o.kind, this.o.result);
    const list = fixChangeList(this.o.result.changes, (p) => this.o.titleOf(p));
    const ids = { title: dialogId("fix-title"), lede: dialogId("fix-lede"), note: dialogId("fix-note") };
    this.modalEl.setAttr("role", "alertdialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.modalEl.setAttr("aria-labelledby", ids.title);
    this.modalEl.setAttr("aria-describedby", `${ids.lede} ${ids.note}`);
    contentEl.createEl("h3", { text: words.title, attr: { id: ids.title } });
    contentEl.createEl("p", { cls: "aos-brain-fixlede", text: words.lede, attr: { id: ids.lede } });
    const count = `${list.changes} ${list.changes === 1 ? "change" : "changes"} in ${list.files} ${list.files === 1 ? "file" : "files"}`;
    contentEl.createEl("p", { cls: "aos-brain-fixcount aos-brain-mono", text: count });
    // Scrolls on its own; reachable by Tab so the keyboard can scroll a long list.
    const box = contentEl.createDiv({ cls: "aos-brain-fixlist", attr: { role: "region", "aria-label": `The changes: ${count}`, tabindex: "0" } });
    for (const g of list.groups) {
      const sec = box.createDiv({ cls: "aos-brain-fixfile", attr: { "data-file": g.file } });
      const head = sec.createDiv({ cls: "aos-brain-fixfilehead" });
      head.createSpan({ cls: "aos-brain-fixpath aos-brain-mono", text: g.file });
      if (g.title) head.createSpan({ cls: "aos-brain-fixftitle", text: g.title });
      const ul = sec.createEl("ul", { cls: "aos-brain-fixrows" });
      for (const l of g.lines) this.row(ul, l);
    }
    const more = fixMoreText(list);
    if (more) box.createEl("p", { cls: "aos-brain-fixmore", text: more });
    contentEl.createEl("p", { cls: "aos-brain-fixnote", text: words.note, attr: { id: ids.note } });
    const actions = contentEl.createDiv({ cls: "aos-capture-actions" });
    const cancel = actions.createEl("button", { cls: "aos-brain-fixcancel", text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { cls: "mod-cta aos-brain-fixok", text: words.confirm, attr: { type: "button" } });
    ok.addEventListener("click", () => { this.resolved = true; this.resolve(true); this.close(); });
    cancel.focus();
  }

  /** One change: its label, the memory an index line is about, then before → after (a screen reader hears "becomes"). */
  private row(ul: HTMLElement, l: FixLine): void {
    const li = ul.createEl("li", { cls: "aos-brain-fixrow", attr: { "data-action": l.action } });
    li.createSpan({ cls: "aos-brain-fixlabel aos-brain-mono", text: l.label });
    if (l.subject) li.createSpan({ cls: "aos-brain-fixsubj", text: l.subject });
    const vals = li.createSpan({ cls: "aos-brain-fixvals" });
    const showBefore = l.before !== null || FIELDS.has(l.action);
    const showAfter = l.after !== null || FIELDS.has(l.action);
    if (showBefore) vals.createSpan({ cls: `aos-brain-fixbefore aos-brain-mono${l.before === null ? " is-none" : ""}`, text: l.before ?? "none" });
    if (showBefore && showAfter) {
      vals.createSpan({ cls: "aos-brain-fixarrow", text: "→", attr: { "aria-hidden": "true" } });
      vals.createSpan({ cls: "aos-brain-fixsr", text: " becomes " });
    }
    if (showAfter) vals.createSpan({ cls: `aos-brain-fixafter aos-brain-mono${l.after === null ? " is-none" : ""}`, text: l.after ?? "removed" });
    else vals.createSpan({ cls: "aos-brain-fixgone", text: "removed" });
  }

  onClose(): void {
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}
