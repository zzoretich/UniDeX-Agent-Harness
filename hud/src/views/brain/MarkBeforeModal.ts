// "Mark everything before <date> reviewed" (spec 2026-10-11-brain-hub D3): the one-time sweep for a backlog that predates
// the hub. A day, the live count of what it would mark, Cancel / Mark N reviewed. It marks nothing itself: it resolves to
// the day, and Review runs `aos memory keep` over that day's paths (spec §6: a bulk action confirms first). Styled like
// ConfirmModal (h3, p, .aos-capture-actions).
import { Modal, type App } from "obsidian";
import { shortDay } from "../../data/brainModel";

export interface MarkBeforeOptions {
  /** The day offered first (defaultMarkBefore), YYYY-MM-DD. */
  initial: string;
  now: Date;
  /** How many memories marking before `day` would keep (live, unreviewed, written before it, not already leaving). */
  count(day: string): number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number): string => String(n).padStart(2, "0");

export class MarkBeforeModal extends Modal {
  private resolved = false;
  private input: HTMLInputElement | null = null;
  private line: HTMLElement | null = null;
  private ok: HTMLButtonElement | null = null;

  constructor(app: App, private o: MarkBeforeOptions, private resolve: (day: string | null) => void = () => {}) {
    super(app);
  }

  /** The day to mark before, or null when cancelled. */
  static ask(app: App, o: MarkBeforeOptions): Promise<string | null> {
    return new Promise((resolve) => new MarkBeforeModal(app, o, resolve).open());
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-confirm-modal");
    contentEl.addClass("aos-brain-markmodal");
    contentEl.createEl("h3", { text: "Mark everything before a day reviewed" });
    contentEl.createEl("p", { cls: "aos-brain-markwhy", text: "For a backlog from before the hub: memories written before this day leave Review as kept." });
    const field = contentEl.createEl("label", { cls: "aos-brain-markfield" });
    field.createSpan({ text: "Written before" });
    const n = this.o.now;
    this.input = field.createEl("input", {
      cls: "aos-brain-markday",
      attr: { type: "date", max: `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`, "aria-describedby": "aos-brain-markline" },
    });
    this.input.value = this.o.initial;
    this.line = contentEl.createEl("p", { cls: "aos-brain-markline", attr: { id: "aos-brain-markline", "aria-live": "polite" } });
    const actions = contentEl.createDiv({ cls: "aos-capture-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    this.ok = actions.createEl("button", { cls: "mod-cta aos-brain-markok", attr: { type: "button" } });
    this.ok.addEventListener("click", () => this.confirm());
    this.input.addEventListener("input", () => this.paint());
    this.input.addEventListener("change", () => this.paint());
    this.input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.confirm(); } });
    this.paint();
    this.input.focus();
  }

  private day(): string | null {
    const v = this.input?.value ?? "";
    return DAY_RE.test(v) ? v : null;
  }

  /** The live line and the button follow the day. */
  private paint(): void {
    if (!this.line || !this.ok) return;
    const day = this.day();
    const n = day ? this.o.count(day) : 0;
    const when = day ? shortDay(day, this.o.now) : "";
    this.line.setText(!day ? "Pick a day."
      : n ? `Marks ${n} ${n === 1 ? "memory" : "memories"} written before ${when} reviewed. Nothing is deleted.`
      : `Nothing written before ${when} waits for review.`);
    this.ok.setText(`Mark ${n} reviewed`);
    this.ok.disabled = !n;
  }

  private confirm(): void {
    const day = this.day();
    if (!day || !this.o.count(day)) return;
    this.resolved = true;
    this.resolve(day);
    this.close();
  }

  onClose(): void {
    if (!this.resolved) this.resolve(null);
    this.contentEl.empty();
  }
}
