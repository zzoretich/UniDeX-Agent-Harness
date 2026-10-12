// SweepCards (spec 2026-10-12-brain-hub-ai A3, A10; brain-hub D22, D23; plan PR 4 "HUD › Sweep"): a list of the
// consolidation sweep's cards for one scope. Each card says its kind as a word (Merge, Archive, Retitle), what it does,
// its memories' titles as the files say now, and why; a stale one carries "changed since the sweep" beside its colour.
// Two buttons per card: Review (merge → the Merge dialog on its paths, ctx.merge; archive → confirm, then archive; retitle
// → confirm "Retitle '<old>' to '<new>'?", then `set` with the new title and the memory's current hash) and Dismiss
// (`sweep dismiss`, for good). Health draws it in its Consolidation sweep card and under a cluster row, Map in a
// community's panel; the words come from data/brainSweep.ts.
//
// A card stays, its buttons busy (aria-disabled, so the keyboard stays on them), until its verb answers; once it went
// through, that card (its id and its run) is hidden until the files agree (a load reads it done or dismissed, or holds
// another run's card under that id). The modes call sync() on every load, whether or not a card is listed then, so a
// card applied, undone and suggested again by a later run (the same id: its kind and paths) shows again. After a dialog
// the keyboard goes back to the card's button, or to the card now in its place.
import { Notice } from "obsidian";
import { pl } from "../../data/brainHealth";
import type { SweepCard } from "../../data/brainModel";
import { archiveAsk, currentCards, retitleAsk, sweepState, type SweepCardView } from "../../data/brainSweep";
import { guardClicks } from "./guardClicks";
import type { BrainCtx } from "./types";

export interface SweepCardsOptions {
  /** The attribute the mode keeps the keyboard with across a redraw: Health's data-hl-key, Map's data-map-key. */
  keyAttr: string;
  /** Draw the cards again (a busy state changed); the mode keeps its place. */
  redraw: () => void;
}

export interface SweepListOptions {
  /** The list's accessible name: "Suggestions for Releases". */
  label: string;
  /** What shows when nothing is listed; nothing at all when absent. */
  empty?: string;
}

/** "review" while Review's dialog or verb runs, "dismiss" while Dismiss's; the text the busy button shows. */
type Busy = { act: "review" | "dismiss"; text: string };

export class SweepCards {
  private busy = new Map<string, Busy>();
  /** Cards whose action went through, hidden until the files agree: id → the run that card came from. */
  private gone = new Map<string, string>();
  /** After a dialog: the button to give the keyboard back to on the next draw, when nothing has it. */
  private want: { key: string; list: string; index: number } | null = null;
  /** Each listed card's place in its list at the last draw (where the keyboard goes when the card has left). */
  private place = new Map<string, number>();

  constructor(private ctx: BrainCtx, private o: SweepCardsOptions) {}

  /** The listed cards into `parent` (a role="list"), or the empty text; null when nothing was drawn. */
  render(parent: HTMLElement, views: readonly SweepCardView[], o: SweepListOptions): HTMLElement | null {
    this.sync();
    const shown = views.filter((v) => !this.hidden(v.card));
    if (!shown.length) {
      if (o.empty) parent.createDiv({ cls: "aos-brain-empty aos-brain-sw-empty", text: o.empty });
      this.focusWanted(parent, o.label, []);
      return null;
    }
    const list = parent.createDiv({ cls: "aos-brain-sw-list", attr: { role: "list", "aria-label": o.label } });
    shown.forEach((v, i) => { this.place.set(v.id, i); this.card(list, v, o.label); });
    this.focusWanted(list, o.label, shown);
    return list;
  }

  private card(list: HTMLElement, v: SweepCardView, listLabel: string): void {
    const el = list.createDiv({ cls: `aos-brain-sw-card is-${v.state}`, attr: { role: "listitem", "data-sweep-id": v.id, "data-kind": v.kind, "data-sweep-state": v.state } });
    const head = el.createDiv({ cls: "aos-brain-sw-head" });
    // The kind is a word in a neutral outline (kind is not state, D23); a stale card's state is a pill with its word.
    head.createSpan({ cls: "aos-brain-sw-kind", text: v.word });
    head.createSpan({ cls: "aos-brain-sw-what", text: v.what, attr: { title: v.what } });
    if (v.note) head.createSpan({ cls: "aos-brain-pill is-warn aos-brain-sw-state", text: v.note });
    const titles = el.createEl("ul", { cls: "aos-brain-sw-titles", attr: { "aria-label": pl(v.titles.length, "memory", "memories") } });
    for (const t of v.titles) titles.createEl("li", { cls: "aos-brain-sw-title", text: t.title, attr: { title: t.path, "data-path": t.path } });
    if (v.why) el.createEl("p", { cls: "aos-brain-sw-why", text: v.why });
    const acts = el.createDiv({ cls: "aos-brain-sw-acts" });
    // While one of the card's actions runs, both its buttons wait; the one running says what it does.
    const b = this.busy.get(v.id);
    const any = !!b;
    const what = `${v.word} ${v.what}`;
    const rv = this.button(acts, b?.act === "review" ? b.text : "Review…", this.key(v.id, "review"), "review", () => void this.review(v, listLabel), { busy: any, label: b?.act === "review" ? `${b.text} ${what}` : v.label });
    const ds = this.button(acts, b?.act === "dismiss" ? b.text : "Dismiss", this.key(v.id, "dismiss"), "dismiss", () => void this.dismiss(v, listLabel), { busy: any, label: b?.act === "dismiss" ? `${b.text} ${what}` : `Dismiss: ${what}` });
    if (b) (b.act === "review" ? rv : ds).setAttr("aria-busy", "true");
  }

  private key(id: string, act: string): string { return `sw:${id}:${act}`; }

  /** A card's button: busy reads aria-disabled (a disabled button would drop the focus) and ignores clicks. */
  private button(parent: HTMLElement, text: string, key: string, act: string, run: () => void, o: { busy: boolean; label: string }): HTMLButtonElement {
    const b = parent.createEl("button", {
      cls: `aos-brain-btn is-small aos-brain-sw-btn${o.busy ? " is-busy" : ""}`, text,
      attr: { type: "button", [this.o.keyAttr]: key, "data-sweep-act": act, "aria-label": o.label, ...(o.busy ? { "aria-disabled": "true" } : {}) },
    });
    guardClicks(b, () => { if (b.getAttribute("aria-disabled") !== "true") run(); });
    return b;
  }

  /** Whether a card is one whose action went through (the same id from the same run). */
  private hidden(c: Pick<SweepCard, "id" | "run">): boolean {
    return this.gone.get(c.id) === c.run;
  }

  private hide(c: Pick<SweepCard, "id" | "run">): void {
    this.gone.set(c.id, c.run);
  }

  /**
   * After each load (Health calls it from update(), Map from its draw, and render() does): a hidden card the files now
   * read done or dismissed, that left the file (or a newer run on its group replaced), or whose id now belongs to another
   * run's card, is no longer ours to hide.
   */
  sync(): void {
    if (!this.gone.size) return;
    const d = this.ctx.data();
    const cards = new Map(currentCards(d.sweep).map((c) => [c.id, c]));
    for (const [id, run] of this.gone) {
      const c = cards.get(id);
      const s = c && c.run === run ? sweepState(c, d.byPath) : "done";
      if (s !== "open" && s !== "stale") this.gone.delete(id);
    }
  }

  /** After a dialog closed (the keyboard is nowhere): the card's button again, else the card now in its place. */
  private focusWanted(scope: HTMLElement, listLabel: string, shown: readonly SweepCardView[]): void {
    const w = this.want;
    if (!w || w.list !== listLabel) return;
    this.want = null;
    const doc = scope.ownerDocument;
    const a = doc.activeElement;
    if (a && a !== doc.body) return;
    const same = Array.from(scope.querySelectorAll<HTMLElement>(`[${this.o.keyAttr}]`)).find((el) => el.getAttribute(this.o.keyAttr) === w.key);
    if (same) { same.focus({ preventScroll: true }); return; }
    const next = shown.length ? shown[Math.min(w.index, shown.length - 1)] : null;
    if (!next) return;
    const el = Array.from(scope.querySelectorAll<HTMLElement>(`[${this.o.keyAttr}]`)).find((x) => x.getAttribute(this.o.keyAttr) === this.key(next.id, "review"));
    el?.focus({ preventScroll: true });
  }

  private set(v: SweepCardView, b: Busy | null, listLabel: string, act: "review" | "dismiss"): void {
    if (b) this.busy.set(v.id, b);
    else this.busy.delete(v.id);
    this.want = { key: this.key(v.id, act), list: listLabel, index: this.place.get(v.id) ?? 0 };
    this.o.redraw();
  }

  /** Review per kind (A10): each applies through the same verbs as by hand, after the same question. */
  private async review(v: SweepCardView, listLabel: string): Promise<void> {
    if (this.busy.has(v.id)) return;
    const label = `${v.word} suggestion`;
    try {
      if (v.kind === "merge") {
        this.set(v, { act: "review", text: "Merging…" }, listLabel, "review");
        if (await this.ctx.merge(v.card.paths)) this.hide(v.card);
      } else if (v.kind === "archive") {
        this.set(v, { act: "review", text: "Review…" }, listLabel, "review");
        const q = archiveAsk(v);
        if (!(await this.ctx.confirm(q.title, q.message, q.confirm))) return;
        this.set(v, { act: "review", text: "Archiving…" }, listLabel, "review");
        const paths = v.card.paths;
        const r = await this.ctx.runAll("archive", paths, "Archive");
        if (r.done) new Notice(`Archived ${pl(r.done, "memory", "memories")}${r.failed ? ` of ${paths.length}` : ""}. Restore in Library puts ${r.done === 1 ? "it" : "each one"} back.`);
        if (r.done === paths.length) this.hide(v.card);
      } else {
        const path = v.card.paths[0];
        const before = this.ctx.data().byPath.get(path);
        if (!before) { new Notice(`${label}: ${path} is gone`); return; }
        this.set(v, { act: "review", text: "Review…" }, listLabel, "review");
        const q = retitleAsk(before.title, v.card);
        if (!(await this.ctx.confirm(q.title, q.message, q.confirm))) return;
        // The hash the page reads now (the file may have reloaded while the question was open).
        const m = this.ctx.data().byPath.get(path);
        if (!m || !m.live) { new Notice(`${label}: ${path} is no longer live`); return; }
        this.set(v, { act: "review", text: "Retitling…" }, listLabel, "review");
        const fields = { title: v.card.title, ...(v.card.description ? { description: v.card.description } : {}) };
        const r = await this.ctx.run({ verb: "set", path, fields, expect: m.hash }, "Retitle");
        if (r.ok) this.hide(v.card);
      }
    } catch (e) {
      new Notice(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.set(v, null, listLabel, "review");
    }
  }

  /** Dismiss (A10): hidden for good, never suggested again; the card stays, busy, until the verb answers. */
  private async dismiss(v: SweepCardView, listLabel: string): Promise<void> {
    if (this.busy.has(v.id)) return;
    this.set(v, { act: "dismiss", text: "Dismissing…" }, listLabel, "dismiss");
    try {
      const r = await this.ctx.run({ verb: "sweep-dismiss", id: v.id }, "Dismiss suggestion");
      if (r.ok) this.hide(v.card);
    } catch (e) {
      new Notice(`Dismiss suggestion: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.set(v, null, listLabel, "dismiss");
    }
  }
}
