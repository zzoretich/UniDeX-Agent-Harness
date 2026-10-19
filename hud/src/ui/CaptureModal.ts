import { App, Modal, Notice, Setting } from "obsidian";
import { writeMemory, MemoryType, slugify, deriveDescription, PromoteSource } from "../data/memoryWriter";

interface CaptureModalOptions {
  prefillBody?: string;
  prefillType?: MemoryType;
  promoteSource?: PromoteSource;
  onSubmit?: () => void;
}

export class CaptureModal extends Modal {
  private opts: CaptureModalOptions;
  private type: MemoryType;
  private title: string = "";
  private description: string = "";
  private body: string = "";
  private slug: string = "";
  private slugTouched: boolean = false;

  constructor(app: App, opts: CaptureModalOptions = {}) {
    super(app);
    this.opts = opts;
    this.type = opts.prefillType || "feedback";
    this.body = opts.prefillBody || "";
    this.description = deriveDescription(this.body);
    this.slug = slugify(this.body);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-capture-modal");

    contentEl.createEl("h2", { text: this.opts.promoteSource ? "Promote to Memory" : "Quick Capture", cls: "aos-capture-title" });

    let slugInputEl: HTMLInputElement | null = null;

    // Type
    new Setting(contentEl)
      .setName("Type")
      .setDesc("Where this memory lives")
      .addDropdown((d) =>
        d
          .addOption("user", "user — about you")
          .addOption("feedback", "feedback — corrections / approvals")
          .addOption("projects", "projects — active work")
          .addOption("reference", "reference — pointers to external systems")
          .setValue(this.type)
          .onChange((v) => {
            this.type = v as MemoryType;
          })
      );

    // Title
    new Setting(contentEl)
      .setName("Title")
      .setDesc("Short, human-readable")
      .addText((t) =>
        t.setValue(this.title).onChange((v) => {
          this.title = v;
          if (!this.slugTouched) {
            this.slug = slugify(v || this.body);
            if (slugInputEl) slugInputEl.value = this.slug;
          }
        })
      );

    // Description
    new Setting(contentEl)
      .setName("Description")
      .setDesc("One-line summary, used in MEMORY.md index")
      .addText((t) => {
        t.setValue(this.description).onChange((v) => { this.description = v; });
        t.inputEl.style.width = "100%";
      });

    // Slug
    new Setting(contentEl)
      .setName("Slug")
      .setDesc("Filename (without .md)")
      .addText((t) => {
        slugInputEl = t.inputEl;
        t.setValue(this.slug).onChange((v) => {
          this.slug = v;
          this.slugTouched = true;
        });
      });

    // Body
    contentEl.createEl("div", { text: "Body", cls: "aos-capture-section-label" });
    const bodyEl = contentEl.createEl("textarea", { cls: "aos-capture-body" });
    bodyEl.value = this.body;
    bodyEl.rows = 8;
    bodyEl.placeholder = this.bodyPlaceholder();
    bodyEl.addEventListener("input", () => {
      this.body = bodyEl.value;
      if (!this.description) this.description = deriveDescription(this.body);
      if (!this.slugTouched) this.slug = slugify(this.body);
      if (slugInputEl) slugInputEl.value = this.slug;
    });

    // Hint about structure
    const hint = contentEl.createEl("div", { cls: "aos-capture-hint aos-dim" });
    hint.textContent = this.bodyHint();

    // Actions
    const actions = contentEl.createDiv({ cls: "aos-capture-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: this.opts.promoteSource ? "Promote" : "Capture", cls: "mod-cta" });
    submit.addEventListener("click", () => { void this.submit(); });

    // Hotkey: Cmd-Enter to submit
    contentEl.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.submit();
      }
    });
  }

  private bodyPlaceholder(): string {
    if (this.type === "feedback" || this.type === "projects") {
      return "Lead with the rule/fact.\n\nWhy: …\nHow to apply: …";
    }
    return "Write the memory content…";
  }

  private bodyHint(): string {
    if (this.type === "feedback") return "Tip: feedback memories should include Why: and How to apply: lines.";
    if (this.type === "projects") return "Tip: project memories should include Why: and How to apply: lines.";
    if (this.type === "user") return "Tip: build up a coherent profile across sessions; favor stable facts.";
    return "Tip: reference memories are pointers — keep them short.";
  }

  private async submit(): Promise<void> {
    if (!this.body.trim()) {
      new Notice("Body is required");
      return;
    }
    if (!this.description.trim()) {
      this.description = deriveDescription(this.body);
    }
    if (!this.title.trim()) {
      this.title = this.description;
    }
    if (!this.slug.trim()) {
      this.slug = slugify(this.body);
    }

    try {
      const result = await writeMemory(
        this.app,
        {
          type: this.type,
          slug: this.slug,
          title: this.title,
          description: this.description,
          body: this.body,
        },
        this.opts.promoteSource
      );
      new Notice(`✓ ${result.memoryPath.split("/").pop()}${result.sessionUpdated ? " · SESSION.md trimmed" : ""}`);
      this.close();
      if (this.opts.onSubmit) this.opts.onSubmit();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Capture failed: ${msg}`);
    }
  }
}
