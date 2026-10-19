// RememberModal — the command deck's /remember: one note into SESSION.md (spec 2026-09-24-hud-deck-fixes D4, D7).
import { App, Modal, Notice, TFile } from "obsidian";
import { appendRemember, rememberTarget, SESSION_PATH, PROMOTE_HEADING } from "../data/sessionNotes";
import { localDay } from "../data/todos";

export class RememberModal extends Modal {
  private note = "";

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-capture-modal");
    contentEl.createEl("h2", { text: "Remember", cls: "aos-capture-title" });

    const noteEl = contentEl.createEl("textarea", { cls: "aos-capture-body" });
    noteEl.rows = 4;
    noteEl.placeholder = "A note for this session's working memory…";
    noteEl.addEventListener("input", () => { this.note = noteEl.value; });

    const hint = contentEl.createEl("div", { cls: "aos-capture-hint aos-dim" });
    hint.textContent = "Saved to SESSION.md with #promote, so /wrap keeps it. Start with feedback:, project: or pattern: to pick the memory type.";

    const actions = contentEl.createDiv({ cls: "aos-capture-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "Remember", cls: "mod-cta" });
    submit.addEventListener("click", () => { void this.submit(); });

    contentEl.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.submit();
      }
    });
    noteEl.focus();
  }

  private async submit(): Promise<void> {
    if (!this.note.trim()) {
      new Notice("Nothing to remember");
      return;
    }
    const today = localDay(new Date());
    try {
      const file = this.app.vault.getAbstractFileByPath(SESSION_PATH);
      if (file instanceof TFile) {
        await this.app.vault.process(file, (text) => appendRemember(text, this.note, today));
      } else {
        const dir = SESSION_PATH.slice(0, SESSION_PATH.lastIndexOf("/"));
        if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);
        await this.app.vault.create(SESSION_PATH, appendRemember(null, this.note, today));
      }
      const where = rememberTarget(this.note) === PROMOTE_HEADING ? "Promote to Memory on Close" : "Things to Remember";
      new Notice(`✓ SESSION.md · ${where}`);
      this.close();
    } catch (err) {
      new Notice(`Remember failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
