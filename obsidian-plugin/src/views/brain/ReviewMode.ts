// PLACEHOLDER (Brain hub PR 2 fan-out): replaced by the full mode.
import type { BrainCtx, BrainModeView } from "./types";

export class ReviewMode implements BrainModeView {
  private host: HTMLElement | null = null;
  constructor(private ctx: BrainCtx) {}
  mount(host: HTMLElement): void { this.host = host.createDiv({ cls: "aos-brain-placeholder" }); this.update(); }
  update(): void { if (this.host) this.host.textContent = `${this.ctx.data().memories.length} memories`; }
  unmount(): void { this.host = null; }
}
