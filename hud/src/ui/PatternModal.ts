// PatternModal — the command deck's /pattern: a decision heuristic into brain/patterns/<area>.md
// (spec 2026-09-24-hud-deck-fixes D5, D7).
import { App, Modal, Notice, Setting, TFile } from "obsidian";
import {
  PATTERN_AREAS, PATTERNS_DIR, PatternArea, addPatternIndexEntry, appendPattern, areaTitle, newPatternFile, patternPath,
} from "../data/patternNotes";
import { deriveTitle } from "../data/memoryWriter";
import { localDay } from "../data/todos";

export class PatternModal extends Modal {
  private area: PatternArea = "debugging";
  private title = "";
  private body = "";

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-capture-modal");
    contentEl.createEl("h2", { text: "New pattern", cls: "aos-capture-title" });

    new Setting(contentEl)
      .setName("Area")
      .setDesc("One file per area in brain/patterns/")
      .addDropdown((d) => {
        for (const a of PATTERN_AREAS) d.addOption(a, areaTitle(a));
        d.setValue(this.area).onChange((v) => { this.area = v as PatternArea; });
      });

    new Setting(contentEl)
      .setName("Title")
      .setDesc("Short; becomes the ### heading (taken from the pattern when empty)")
      .addText((t) => {
        t.setValue(this.title).onChange((v) => { this.title = v; });
        t.inputEl.style.width = "100%";
      });

    contentEl.createEl("div", { text: "Pattern", cls: "aos-capture-section-label" });
    const bodyEl = contentEl.createEl("textarea", { cls: "aos-capture-body" });
    bodyEl.rows = 6;
    bodyEl.placeholder = "When …, do … because …";
    bodyEl.addEventListener("input", () => { this.body = bodyEl.value; });

    const actions = contentEl.createDiv({ cls: "aos-capture-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "Save pattern", cls: "mod-cta" });
    submit.addEventListener("click", () => { void this.submit(); });

    contentEl.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.submit();
      }
    });
  }

  private async submit(): Promise<void> {
    if (!this.body.trim()) {
      new Notice("The pattern is required");
      return;
    }
    const draft = { title: this.title.trim() || deriveTitle(this.body), body: this.body, today: localDay(new Date()) };
    const target = patternPath(this.area);
    try {
      const file = this.app.vault.getAbstractFileByPath(target);
      if (file instanceof TFile) {
        await this.app.vault.process(file, (text) => appendPattern(text, draft));
      } else {
        if (!(await this.app.vault.adapter.exists(PATTERNS_DIR))) await this.app.vault.createFolder(PATTERNS_DIR);
        await this.app.vault.create(target, newPatternFile(this.area, draft));
        const index = this.app.vault.getAbstractFileByPath("MEMORY.md");
        if (index instanceof TFile) await this.app.vault.process(index, (text) => addPatternIndexEntry(text, this.area));
      }
      new Notice(`✓ ${target}`);
      this.close();
    } catch (err) {
      new Notice(`Pattern failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
