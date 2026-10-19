import { App, Modal } from "obsidian";
import { dialogId } from "./spaces/SpaceDialogs";

/**
 * A yes/no dialog that resolves to true on confirm. Used by the Routines drawer for guarded duties, the Brain hub's
 * questions (an archive, a retitle, Merge's "Replace your edits?") and the other tabs' deletes. Announced as an
 * alertdialog named by its title and described by its message (FixModal's pattern), and Cancel takes the keyboard when it
 * opens: a question that lands while the person is typing gets the next keys, never the field behind it, and a stray
 * Enter keeps things as they are. The host gives the keyboard back to what had it when the dialog closes.
 */
export class ConfirmModal extends Modal {
  private resolved = false;
  /** `detail`, when given, is shown as written under the message in a monospace block: the exact command a confirm runs
   *  (Skills ▸ MCP servers' Make available on …). */
  constructor(app: App, private title: string, private message: string, private confirmLabel = "Confirm", private resolve: (ok: boolean) => void = () => {}, private detail: string | null = null) {
    super(app);
  }

  static ask(app: App, title: string, message: string, confirmLabel = "Confirm", detail: string | null = null): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, title, message, confirmLabel, resolve, detail).open());
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-confirm-modal");
    const ids = { title: dialogId("confirm-title"), message: dialogId("confirm-message") };
    this.modalEl.setAttr("role", "alertdialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.modalEl.setAttr("aria-labelledby", ids.title);
    this.modalEl.setAttr("aria-describedby", ids.message);
    contentEl.createEl("h3", { text: this.title, attr: { id: ids.title } });
    contentEl.createEl("p", { text: this.message, attr: { id: ids.message } });
    if (this.detail) contentEl.createEl("pre", { cls: "aos-confirm-detail", text: this.detail });
    const actions = contentEl.createDiv({ cls: "aos-capture-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { text: this.confirmLabel, cls: "mod-cta", attr: { type: "button" } });
    ok.addEventListener("click", () => { this.resolved = true; this.resolve(true); this.close(); });
    cancel.focus();
  }

  onClose(): void {
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}
