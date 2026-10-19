import { App, Modal, Setting } from "obsidian";

/**
 * Links a workspace to the code folder it is about (spec 2026-10-08-term-agent-deck T8): the folder goes into the
 * workspace's workspace.md as `repo:`, and terminals started "in" the workspace start there. Empty unlinks it. The write
 * is the caller's: TerminalLauncher.linkRepo, through `aos workspace set` while the Spaces surface is on
 * (spaces-redesign D24, D28), so the dialog waits for its answer and shows a refusal beside the field.
 */
export class LinkRepoModal extends Modal {
  private value: string;
  private busy = false;

  constructor(app: App, private workspace: string, current: string | null, private onSubmit: (typed: string | null) => string | null | Promise<string | null>) {
    super(app);
    this.value = current ?? "";
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: `Link ${this.workspace} to its code folder` });
    this.contentEl.createEl("p", { text: "Terminals started in this workspace will start in that folder. Use ~/… or a full path outside the vault; leave it empty to unlink." });
    const error = this.contentEl.createEl("p", { cls: "aos-text-rose" });
    new Setting(this.contentEl).setName("Code folder").addText((t) => {
      t.setPlaceholder("~/Code/my-app").setValue(this.value).onChange((v) => { this.value = v; });
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } });
    });
    const submit = async (): Promise<void> => {
      if (this.busy) return;
      this.busy = true;
      error.setText("");
      try { await this.onSubmit(this.value.trim() || null); this.close(); }
      catch (e) { error.setText(e instanceof Error ? e.message : String(e)); }
      finally { this.busy = false; }
    };
    new Setting(this.contentEl).addButton((b) => b.setButtonText(this.value ? "Save" : "Link").setCta().onClick(() => void submit()));
  }

  onClose(): void { this.contentEl.empty(); }
}
