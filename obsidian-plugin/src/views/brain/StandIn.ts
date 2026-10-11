// Bootstrap and Health until PR 3 (spec 2026-10-11-brain-hub §4: "Bootstrap, Map, Health show PR 3 stand-ins"). Each
// reads what the runtime already writes and acts on nothing: Bootstrap shows BRAIN.md against its budget, its sections
// and the active projects that look shipped (D17); Health counts the store, its duplicates and the hygiene findings
// (D20), with each count that Review can act on linking there. What comes next is said once, in a note at the foot.
import { BRAIN_MODE_LABEL, brainMdPercent, type BrainMode } from "../../data/brainModel";
import type { BrainCtx, BrainModeView } from "./types";

const pl = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export class StandInMode implements BrainModeView {
  private host: HTMLElement | null = null;

  constructor(private ctx: BrainCtx, private mode: BrainMode) {}

  mount(host: HTMLElement): void {
    this.host = host.createDiv({ cls: "aos-brain-standin", attr: { "aria-label": BRAIN_MODE_LABEL[this.mode] } });
    this.update();
  }

  update(): void {
    const h = this.host;
    if (!h) return;
    h.empty();
    if (this.mode === "bootstrap") this.bootstrap(h);
    else this.health(h);
  }

  private section(h: HTMLElement, title: string, sub?: string): HTMLElement {
    const s = h.createEl("section", { cls: "aos-brain-sisec" });
    const head = s.createDiv({ cls: "aos-brain-sihead" });
    head.createEl("h2", { cls: "aos-brain-label", text: title });
    if (sub) head.createSpan({ cls: "aos-brain-dim aos-brain-mono", text: sub });
    return s;
  }

  private bootstrap(h: HTMLElement): void {
    const d = this.ctx.data();
    const src = d.sources;
    h.createEl("h2", { cls: "aos-brain-h2", text: "What every session starts with" });
    h.createEl("p", { cls: "aos-brain-lede", text: "BRAIN.md is injected into the first prompt of every session on both hosts. It is built from pinned memories and active projects." });
    const fill = this.section(h, "BRAIN.MD");
    if (!src) {
      fill.createDiv({ cls: "aos-brain-empty", text: "No brain-sources.json yet: it is written when BRAIN.md is next built (the next scan, or aos build-brain-md)." });
    } else {
      const pct = brainMdPercent(src) ?? 0;
      const row = fill.createDiv({ cls: "aos-brain-budget" });
      row.createSpan({ cls: "aos-brain-budgetval aos-brain-mono", text: `${src.tokens} / ${src.budget} tokens` });
      const bar = row.createDiv({ cls: `aos-brain-bar${pct >= 100 ? " is-warn" : ""}`, attr: { role: "progressbar", "aria-label": "BRAIN.md against its budget", "aria-valuemin": "0", "aria-valuemax": String(src.budget), "aria-valuenow": String(src.tokens), "aria-valuetext": `${pct}% of the budget` } });
      bar.createSpan({ cls: "aos-brain-barfill", attr: { style: `width: ${Math.min(100, pct)}%` } });
      row.createSpan({ cls: `aos-brain-mono${pct >= 100 ? " aos-brain-warn" : " aos-brain-dim"}`, text: `${pct}%` });
      const list = fill.createDiv({ cls: "aos-brain-silist" });
      for (const [k, label] of [["who", "Who you are"], ["rules", "Critical rules"], ["active", "Active context"]] as const) {
        const sec = src.sections[k];
        const r = list.createDiv({ cls: "aos-brain-sirow" });
        r.createSpan({ cls: "aos-brain-sititle", text: label });
        r.createSpan({ cls: "aos-brain-dim", text: `${pl(sec.paths.length, "memory", "memories")}${k === "active" && src.omitted.length ? ` · ${src.omitted.length} left out` : ""}` });
        r.createSpan({ cls: "aos-brain-mono aos-brain-dim", text: `${sec.tokens} tokens` });
      }
    }
    const shipped = (d.hub?.shipped ?? []).filter((s) => d.byPath.get(s.path)?.live);
    const ship = this.section(h, "LOOKS SHIPPED", shipped.length ? pl(shipped.length, "active project") : undefined);
    if (!shipped.length) ship.createDiv({ cls: "aos-brain-empty", text: "No active project looks shipped." });
    for (const s of shipped) {
      const m = d.byPath.get(s.path)!;
      const r = ship.createEl("button", { cls: "aos-brain-silink", attr: { "data-path": s.path } });
      r.createSpan({ cls: "aos-brain-sititle", text: m.title });
      r.createSpan({ cls: "aos-brain-dim aos-brain-mono", text: s.why });
      r.addEventListener("click", () => this.ctx.show({ mode: "library", memory: s.path }));
    }
    this.next(h, "Pin, Unpin and Mark complete from here, with the budget bars for SESSION.md and recall-wake, come with the next update. Today, open a memory in Library to pin it or change its status.");
  }

  private health(h: HTMLElement): void {
    const d = this.ctx.data();
    const live = d.memories.filter((m) => m.live);
    const toReview = d.batches.reduce((n, b) => n + b.paths.length, 0);
    h.createEl("h2", { cls: "aos-brain-h2", text: "The brain's health" });
    const tiles = h.createDiv({ cls: "aos-brain-tiles" });
    const tile = (n: number | string, label: string, go?: () => void): void => {
      const t = go ? tiles.createEl("button", { cls: "aos-brain-tile is-link" }) : tiles.createDiv({ cls: "aos-brain-tile" });
      t.createSpan({ cls: "aos-brain-tilen aos-brain-mono", text: String(n) });
      t.createSpan({ cls: "aos-brain-dim", text: go ? `${label} →` : label });
      if (go) t.addEventListener("click", go);
    };
    tile(live.length, "live memories", () => this.ctx.show({ mode: "library" }));
    tile(toReview, "to review", () => this.ctx.show({ mode: "review", queue: "session" }));
    tile(d.drafts.length, "feedback drafts", () => this.ctx.show({ mode: "review", queue: "drafts" }));
    tile(d.pairs.length, "duplicate pairs", () => this.ctx.show({ mode: "review", queue: "duplicates" }));
    tile(d.hub?.clusters.length ?? 0, "clusters");
    tile(d.memories.length - live.length, "archived or superseded");
    const hy = d.hub?.hygiene ?? {};
    const count = (k: string): number => (Array.isArray(hy[k]) ? (hy[k] as unknown[]).length : 0);
    const rows: Array<[string, number]> = [
      ["memories with no description of their own (MEMORY.md has one)", count("noDescription")], ["memories in the old type: shape", count("oldType")],
      ["memories missing from MEMORY.md", count("unindexed")], ["memories under another type's MEMORY.md heading", count("misfiled")],
      ["MEMORY.md lines to a missing file", count("brokenIndex")], ["approved drafts left behind", count("leftoverDrafts")],
    ];
    const hyg = this.section(h, "HYGIENE", d.hub?.builtAt ? `as of the last scan` : undefined);
    if (!d.hub) hyg.createDiv({ cls: "aos-brain-empty", text: "No brain-hub.json yet: the next scan writes it (aos scan-vault --quiet)." });
    else {
      const list = hyg.createDiv({ cls: "aos-brain-silist" });
      for (const [label, n] of rows) {
        const r = list.createDiv({ cls: "aos-brain-sirow" });
        r.createSpan({ cls: `aos-brain-mono${n ? " aos-brain-warn" : " aos-brain-dim"}`, text: String(n) });
        r.createSpan({ cls: "aos-brain-sititle", text: label });
      }
    }
    this.next(h, "Fixes for each finding (with a dry run first), dead weight from the usage log and the consolidation sweep come with the next update.");
  }

  private next(h: HTMLElement, text: string): void {
    h.createDiv({ cls: "aos-brain-sinote", text });
  }

  unmount(): void {
    this.host = null;
  }
}
