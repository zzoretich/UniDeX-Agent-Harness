// The Brain hub's header (spec 2026-10-11-brain-hub D2, D23): "Brain", the store in one line, search, Capture, and the
// five modes as a tablist across the top with their counts. Built once per mount and updated in place, so typing in the
// search box never loses focus to a redraw.
import { setIcon } from "obsidian";
import { BRAIN_MODES, BRAIN_MODE_LABEL, type BrainMode, type ModeBadge } from "../../data/brainModel";

export interface HeaderHandlers {
  mode(m: BrainMode): void;
  search(q: string): void;
  capture(): void;
}

export class BrainHeader {
  readonly el: HTMLElement;
  private stats: HTMLElement;
  private input: HTMLInputElement;
  private tabs = new Map<BrainMode, { btn: HTMLButtonElement; badge: HTMLElement }>();

  constructor(parent: HTMLElement, private on: HeaderHandlers) {
    this.el = parent.createDiv({ cls: "aos-brain-head" });
    const bar = this.el.createDiv({ cls: "aos-brain-titlebar" });
    bar.createEl("h1", { cls: "aos-brain-h1", text: "Brain" });
    this.stats = bar.createSpan({ cls: "aos-brain-stats aos-brain-mono" });
    bar.createSpan({ cls: "aos-brain-sp" });
    const search = bar.createEl("label", { cls: "aos-brain-search" });
    const sic = search.createSpan({ cls: "aos-brain-searchic", attr: { "aria-hidden": "true" } });
    setIcon(sic, "search");
    this.input = search.createEl("input", { cls: "aos-brain-searchinput", attr: { type: "search", "aria-label": "Search the brain", placeholder: "Search titles and bodies…", spellcheck: "false" } });
    search.createEl("kbd", { cls: "aos-brain-kbd aos-brain-mono", text: "⌘F" });
    this.input.addEventListener("input", () => this.on.search(this.input.value));
    this.input.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.input.value) { e.preventDefault(); this.input.value = ""; this.on.search(""); } });
    const cap = bar.createEl("button", { cls: "aos-brain-btn aos-brain-capture", attr: { "aria-label": "Quick Capture" } });
    const cic = cap.createSpan({ cls: "aos-brain-ic", attr: { "aria-hidden": "true" } });
    setIcon(cic, "plus");
    cap.createSpan({ text: "Capture" });
    cap.addEventListener("click", () => this.on.capture());

    const strip = this.el.createDiv({ cls: "aos-brain-modes", attr: { role: "tablist", "aria-label": "Brain modes" } });
    for (const m of BRAIN_MODES) {
      const btn = strip.createEl("button", { cls: "aos-brain-mode", attr: { role: "tab", "data-mode": m, "aria-selected": "false", tabindex: "-1" } });
      btn.createSpan({ cls: "aos-brain-modelabel", text: BRAIN_MODE_LABEL[m] });
      const badge = btn.createSpan({ cls: "aos-brain-modebadge aos-brain-mono is-empty" });
      btn.addEventListener("click", () => this.on.mode(m));
      this.tabs.set(m, { btn, badge });
    }
    // The tablist pattern: ←/→ (and Home/End) move between modes and show them.
    strip.addEventListener("keydown", (e) => {
      const i = BRAIN_MODES.findIndex((m) => this.tabs.get(m)!.btn === e.target);
      if (i < 0) return;
      const j = e.key === "ArrowRight" ? (i + 1) % BRAIN_MODES.length : e.key === "ArrowLeft" ? (i + BRAIN_MODES.length - 1) % BRAIN_MODES.length
        : e.key === "Home" ? 0 : e.key === "End" ? BRAIN_MODES.length - 1 : -1;
      if (j < 0) return;
      e.preventDefault();
      this.on.mode(BRAIN_MODES[j]);
      this.tabs.get(BRAIN_MODES[j])!.btn.focus();
    });
  }

  /** The stats line, the active mode and each mode's count. */
  update(o: { stats: string; mode: BrainMode; badges: Partial<Record<BrainMode, ModeBadge>> }): void {
    this.stats.textContent = o.stats;
    for (const [m, { btn, badge }] of this.tabs) {
      const on = m === o.mode;
      btn.toggleClass("is-on", on);
      btn.setAttr("aria-selected", String(on));
      btn.setAttr("tabindex", on ? "0" : "-1");
      const b = o.badges[m];
      badge.textContent = b?.text ?? "";
      badge.toggleClass("is-empty", !b);
      badge.toggleClass("is-warn", b?.tone === "warn");
      btn.setAttr("aria-label", b ? `${BRAIN_MODE_LABEL[m]}, ${b.text}` : BRAIN_MODE_LABEL[m]);
    }
  }

  query(): string { return this.input.value; }

  setQuery(q: string): void { if (this.input.value !== q) this.input.value = q; }

  focusSearch(): void { this.input.focus(); this.input.select(); }
}
