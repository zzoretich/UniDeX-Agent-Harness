// Bootstrap (spec 2026-10-11-brain-hub; PR 3). Skeleton from the shell contract: the PR 3 builder replaces this body.
import { BRAIN_MODE_LABEL, type BrainTarget } from "../../data/brainModel";
import type { BrainCtx, BrainModeView } from "./types";

export class BootstrapMode implements BrainModeView {
  private host: HTMLElement | null = null;

  constructor(private ctx: BrainCtx) {}

  mount(host: HTMLElement): void {
    this.host = host.createDiv({ cls: "aos-brain-bootstrap", attr: { "aria-label": BRAIN_MODE_LABEL.bootstrap } });
    this.update();
  }

  update(): void {
    if (!this.host) return;
    this.host.empty();
    this.host.createEl("h2", { cls: "aos-brain-h2", text: BRAIN_MODE_LABEL.bootstrap });
    void this.ctx;
  }

  reveal(_target: BrainTarget): void { /* anchors land here (BrainTarget.anchor) */ }

  unmount(): void { this.host = null; }
}
