import { App, Modal, Setting } from "obsidian";

/** Asks for the current claude.ai billed MTD figure, then hands it back. */
export class AnchorModal extends Modal {
  private onSubmit: (usd: number) => void;
  private value = "";

  constructor(app: App, onSubmit: (usd: number) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: "Re-anchor cost budget" });
    this.contentEl.createEl("p", {
      text: "Enter the current month-to-date billed figure from claude.ai (Settings → Usage). This stamps a fresh anchor and resets the month.",
    });
    new Setting(this.contentEl).setName("Billed USD").addText((t) =>
      t.setPlaceholder("0.00").onChange((v) => { this.value = v.trim(); })
    );
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Anchor").setCta().onClick(() => {
        const usd = parseFloat(this.value);
        if (Number.isFinite(usd) && usd >= 0) { this.close(); this.onSubmit(usd); }
      })
    );
  }

  onClose(): void { this.contentEl.empty(); }
}
