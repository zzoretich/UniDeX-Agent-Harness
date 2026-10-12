// Review (spec 2026-10-11-brain-hub D3, D4, D6, D7; canvas Main): what agents wrote, one session at a time. The left pane
// holds the queues (By session, Drafts, Duplicates, Older than 30d) and their rows; the main pane shows the chosen batch
// as cards, each with Keep, Edit, Merge, Archive and Pin and a key for each (↑↓ K E M A P ⇧K ⏎). Every action is an
// `aos memory` verb through ctx.run (the brain surface, D13, D14). A card leaves as soon as its verb starts and comes back
// if the verb fails; the card after it is then the selected one, and an emptied batch hands over to the next. No memory
// is deleted (D6): Archive tags in place (D5), and "Keep the older one" marks the newer memory superseded by the older
// (D7); only a feedback draft goes, when it is approved (into the store) or rejected.
// AI merge is PR 4: Merge here compares the two side by side.
import { Notice, setIcon } from "obsidian";
import {
  REVIEW_QUEUES, REVIEW_QUEUE_LABEL, batchLede, batchMeta, batchWhen, compareAges, defaultMarkBefore, knownLabel, olderByMonth,
  olderFirst, olderQueue, reviewCounts, reviewKey, reviewSelection, shortDay, splitByWeek, weekUse, writtenAt, writtenBefore,
  type BrainDraft, type BrainMemory, type BrainTarget, type HubDup, type MemoryVerb, type ReviewBatch, type ReviewKey, type ReviewQueue,
  type SetResult, sessionLabel,
} from "../../data/brainModel";
import { MarkBeforeModal } from "./MarkBeforeModal";
import type { BrainCtx, BrainData, BrainModeView } from "./types";

const pl = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** How long a row whose verb succeeded stays hidden while the files catch up (a reload takes well under it). */
const GONE_MS = 10_000;
/** Older than 30d draws this many cards and rows at a time, and "Show N more" the next: a real backlog runs to hundreds,
 *  and every action redraws the queue. */
const OLDER_PAGE = 50;
/** A duplicate pair's key on this page (pairKey's order, with a separator an attribute holds). */
const pk = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** A card's icon buttons (D4), each with its key; Pin's icon and label follow the memory. */
const CARD_ACTS = [
  { act: "keep", icon: "check", label: "Keep (K)", keys: "K" },
  { act: "edit", icon: "pencil", label: "Edit (E)", keys: "E" },
  { act: "merge", icon: "git-merge", label: "Merge (M)", keys: "M" },
  { act: "archive", icon: "archive", label: "Archive (A)", keys: "A" },
] as const;
const PIN_ACT = { on: { icon: "pin-off", label: "Unpin (P)" }, off: { icon: "pin", label: "Pin to BRAIN.md (P)" } } as const;
/** ⏎ has a button too (spec §4: every key has a button). */
const OPEN_ACT = { act: "open", icon: "arrow-up-right", label: "Open in Library (⏎)", keys: "Enter" } as const;

interface Sel { key: string | null; index: number }
interface Place { key: string | null; where: "left" | "main" | null; list: number; main: number; root: number }
interface MenuItem { key: string; label: string; run: () => void }
/** One draw's data: the load less what this page is hiding (verbs running or just done). */
interface View {
  d: BrainData;
  batches: ReviewBatch[];
  week: ReviewBatch[];
  earlier: ReviewBatch[];
  earlierOpen: boolean;
  /** The batches the left list shows, in its order (Earlier's only when unfolded). */
  shown: ReviewBatch[];
  drafts: BrainDraft[];
  pairs: HubDup[];
  /** The whole Older queue (its count, Keep all, Archive all) and the part drawn (OLDER_PAGE at a time). */
  older: BrainMemory[];
  olderShown: BrainMemory[];
  /** The memories no scan has checked for duplicates yet (ReviewBatch.unchecked). */
  unchecked: Set<string>;
}

export class ReviewMode implements BrainModeView {
  private root: HTMLElement | null = null;
  private left: HTMLElement | null = null;
  private main: HTMLElement | null = null;
  private queue: ReviewQueue = "session";
  private batch: Sel = { key: null, index: 0 };
  /** The selected row per queue: a card's path (session, older), a draft's slug, a pair's key (duplicates). */
  private sel: Record<ReviewQueue, Sel> = {
    session: { key: null, index: 0 }, drafts: { key: null, index: 0 }, duplicates: { key: null, index: 0 }, older: { key: null, index: 0 },
  };
  /** The card whose comparison is open (M). */
  private compareOpen: string | null = null;
  /** EARLIER folded or unfolded by hand; null: folded unless THIS WEEK is empty. */
  private earlier: boolean | null = null;
  /** The batch whose "More batch actions" menu is open. */
  private menu: string | null = null;
  private menuOff: { doc: Document; fn: (e: Event) => void } | null = null;
  /** Paths, `draft:<slug>` and `pair:<a|b>` whose verb runs: hidden at once (D4). */
  private busy = new Set<string>();
  /** …whose verb succeeded: hidden until the files say so, or GONE_MS. */
  private gone = new Map<string, number>();
  /** A pin toggled here, shown until the files say so. */
  private pins = new Map<string, { on: boolean; at: number }>();
  /** The hash `set` answered, while the load still holds the one before it: P twice before the reload (D17). */
  private hashes = new Map<string, { was: string; now: string }>();
  private resetLeft = false;
  private resetMain = false;
  private focusSel = false;
  private showSel = false;
  /** How much of the Older queue is drawn. */
  private olderLimit = OLDER_PAGE;
  /** Fires when the first hidden row or shown pin runs out of GONE_MS, so it comes back without waiting for a reload. */
  private goneTimer: number | null = null;

  constructor(private ctx: BrainCtx) {}

  mount(host: HTMLElement): void {
    this.root = host.createDiv({ cls: "aos-brain-panes aos-brain-rv" });
    this.left = this.root.createEl("aside", { cls: "aos-brain-left aos-brain-rv-left", attr: { "aria-label": "Sessions that wrote memories" } });
    this.main = this.root.createEl("section", { cls: "aos-brain-main aos-brain-rv-main" });
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    // The keys act on the card the keyboard is in (§4): Tab onto a card's buttons selects that card, so K or A there
    // never lands on another one that was selected by a click.
    this.main.addEventListener("focusin", (e) => {
      const card = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-sel]") : null;
      const key = card?.getAttribute("data-sel");
      if (key && key !== this.sel[this.queue].key) this.selectQuiet(key);
    });
    this.update();
  }

  update(): void {
    if (!this.root || !this.left || !this.main) return;
    const d = this.ctx.data();
    this.prune(d);
    const v = this.view(d);
    this.resolve(v);
    const place = this.savePlace();
    this.drawLeft(v);
    this.drawMain(v);
    this.restorePlace(place);
    this.armGone();
  }

  reveal(t: BrainTarget): void {
    if (t.queue) this.setQueue(t.queue);
    if (t.memory) {
      const v = this.view(this.ctx.data());
      const b = v.batches.find((x) => x.paths.includes(t.memory!));
      if (b) {
        this.setQueue("session");
        if (v.earlier.some((x) => x.key === b.key)) this.earlier = true;
        this.batch = { key: b.key, index: 0 };
        this.sel.session = { key: t.memory, index: 0 };
        this.compareOpen = null;
      } else if (v.older.some((m) => m.path === t.memory)) {
        this.setQueue("older");
        // Drawn OLDER_PAGE at a time: far enough down the queue to hold it.
        const i = v.older.findIndex((m) => m.path === t.memory);
        this.olderLimit = Math.max(this.olderLimit, (Math.floor(i / OLDER_PAGE) + 1) * OLDER_PAGE);
        this.sel.older = { key: t.memory, index: 0 };
      }
    }
    this.showSel = true;
    // Landed from elsewhere (Pulse, a link) with the focus nowhere: the selected card takes it, so the keys work at once
    // (as Library's reveal does). Never from a field or a control that has it.
    const a = this.root?.ownerDocument.activeElement;
    if (!a || a === this.root?.ownerDocument.body) this.focusSel = true;
    this.update();
  }

  unmount(): void {
    this.closeMenu(false);
    if (this.goneTimer !== null) window.clearTimeout(this.goneTimer);
    this.goneTimer = null;
    this.root = null;
    this.left = null;
    this.main = null;
  }

  // ── state ──

  private hidden(k: string): boolean { return this.busy.has(k) || this.gone.has(k); }

  private setQueue(q: ReviewQueue): void {
    if (q !== this.queue) { this.queue = q; this.resetLeft = true; this.resetMain = true; }
    this.closeMenu(false);
  }

  /** Done rows stay hidden until the files no longer list them; a pin shown here until the file has it. */
  private prune(d: BrainData): void {
    const now = Date.now();
    const drafts = new Set(d.drafts.map((x) => `draft:${x.slug}`));
    const pairs = new Set(d.pairs.map((p) => `pair:${pk(p.a, p.b)}`));
    for (const [k, at] of this.gone) {
      const m = d.byPath.get(k);
      const still = k.startsWith("draft:") ? drafts.has(k) : k.startsWith("pair:") ? pairs.has(k) : !!m && m.live && m.reviewed === false;
      if (!still || now - at > GONE_MS) this.gone.delete(k);
    }
    for (const [p, x] of this.pins) if (d.byPath.get(p)?.pin === x.on || now - x.at > GONE_MS) this.pins.delete(p);
    for (const [p, h] of this.hashes) if (d.byPath.get(p)?.hash !== h.was) this.hashes.delete(p);
  }

  /** "Hidden until the files say so, or GONE_MS": a timer for the first that runs out, so a row the files still list
   *  (a verb that went through but whose reload never came) shows again then, not at the next vault event. */
  private armGone(): void {
    if (this.goneTimer !== null) window.clearTimeout(this.goneTimer);
    this.goneTimer = null;
    const ats = [...this.gone.values(), ...[...this.pins.values()].map((x) => x.at)];
    if (!ats.length || !this.root) return;
    const wait = Math.max(0, Math.min(...ats) + GONE_MS - Date.now()) + 50;
    this.goneTimer = window.setTimeout(() => { this.goneTimer = null; this.update(); }, wait);
  }

  private view(d: BrainData): View {
    const vis = (k: string): boolean => !this.hidden(k);
    const batches = d.batches
      .map((b) => ({ ...b, paths: b.paths.filter(vis), fresh: b.fresh.filter(vis), known: b.known.filter(vis), unchecked: b.unchecked.filter(vis) }))
      .filter((b) => b.paths.length);
    const { week, earlier } = splitByWeek(batches, d.now);
    const earlierOpen = this.earlier ?? !week.length;
    const older = olderQueue(d.memories, d.written, d.now).filter((m) => vis(m.path));
    return {
      d, batches, week, earlier, earlierOpen, shown: earlierOpen ? [...week, ...earlier] : week,
      drafts: d.drafts.filter((x) => vis(`draft:${x.slug}`)),
      pairs: d.pairs.filter((p) => vis(`pair:${pk(p.a, p.b)}`)),
      older, olderShown: older.slice(0, this.olderLimit),
      unchecked: new Set(batches.flatMap((b) => b.unchecked)),
    };
  }

  /** Each selection after the data changed: the same row while it is listed, else the one now at its place (D4). */
  private resolve(v: View): void {
    const prev = this.batch.key;
    this.batch = reviewSelection(v.shown.map((b) => b.key), this.batch.key, this.batch.index);
    if (prev !== null && this.batch.key !== prev) {
      this.sel.session = { key: null, index: 0 };
      this.compareOpen = null;
      if (this.queue === "session") this.resetMain = true;
    }
    const b = v.shown.find((x) => x.key === this.batch.key);
    this.sel.session = reviewSelection(b?.paths ?? [], this.sel.session.key, this.sel.session.index);
    this.sel.drafts = reviewSelection(v.drafts.map((x) => x.slug), this.sel.drafts.key, this.sel.drafts.index);
    this.sel.duplicates = reviewSelection(v.pairs.map((p) => pk(p.a, p.b)), this.sel.duplicates.key, this.sel.duplicates.index);
    this.sel.older = reviewSelection(v.olderShown.map((m) => m.path), this.sel.older.key, this.sel.older.index);
    if (this.menu !== null && (this.queue !== "session" || this.menu !== this.batch.key)) this.closeMenu(false);
  }

  private currentBatch(): ReviewBatch | null {
    const v = this.view(this.ctx.data());
    return v.shown.find((b) => b.key === this.batch.key) ?? null;
  }

  /** The selected card's memory, when it is on screen. */
  private current(): BrainMemory | null {
    const key = this.sel[this.queue].key;
    if (!key || this.hidden(key) || !this.main || !findBy(this.main, "data-sel", key)) return null;
    return this.ctx.data().byPath.get(key) ?? null;
  }

  // ── keeping the place across a redraw ──

  private savePlace(): Place {
    const a = this.root!.ownerDocument.activeElement;
    const el = a instanceof HTMLElement ? a : null;
    const where = el && this.left!.contains(el) ? "left" : el && this.main!.contains(el) ? "main" : null;
    return {
      key: where ? el!.closest("[data-rv-key]")?.getAttribute("data-rv-key") ?? null : null,
      where,
      list: this.left!.querySelector<HTMLElement>(".aos-brain-rv-list")?.scrollTop ?? 0,
      main: this.main!.scrollTop,
      root: this.root!.scrollTop,
    };
  }

  private restorePlace(p: Place): void {
    const list = this.left!.querySelector<HTMLElement>(".aos-brain-rv-list");
    if (list) list.scrollTop = this.resetLeft ? 0 : p.list;
    this.main!.scrollTop = this.resetMain ? 0 : p.main;
    this.root!.scrollTop = p.root;
    this.resetLeft = false;
    this.resetMain = false;
    const key = this.sel[this.queue].key;
    const sel = key ? findBy(this.main!, "data-sel", key) : null;
    if (this.focusSel && sel) sel.focus({ preventScroll: true });
    else if (p.where) {
      // The focused row may have left (kept, archived), or its control may be off now ("Keep the 0 new"): the keyboard
      // goes to what is selected now, in the same pane; with nothing left there, to the empty state or the queue's chip,
      // never to the page, where the keys no longer reach the hub (§4).
      const same = p.key ? findBy(this.root!, "data-rv-key", p.key) : null;
      const chip = this.left!.querySelector<HTMLElement>("[data-queue][aria-pressed='true']");
      const back = (same && !same.matches(":disabled") ? same : null)
        ?? (p.where === "main"
          ? sel ?? this.main!.querySelector<HTMLElement>(".aos-brain-empty[tabindex]")
          : this.left!.querySelector<HTMLElement>("[role=option][tabindex='0']"))
        ?? chip;
      back?.focus({ preventScroll: true });
    }
    if ((this.focusSel || this.showSel) && sel) sel.scrollIntoView({ block: "nearest" });
    this.focusSel = false;
    this.showSel = false;
  }

  // ── the left pane: queues, rows, the footer ──

  private drawLeft(v: View): void {
    const L = this.left!;
    L.empty();
    const counts = reviewCounts(v.batches, v.drafts, v.pairs, v.older);
    const chips = L.createDiv({ cls: "aos-brain-rv-queues", attr: { role: "group", "aria-label": "Review queues" } });
    for (const q of REVIEW_QUEUES) {
      const b = chips.createEl("button", { cls: "aos-brain-chip", attr: { type: "button", "aria-pressed": String(q === this.queue), "data-queue": q, "data-rv-key": `queue:${q}` } });
      b.createSpan({ text: REVIEW_QUEUE_LABEL[q] });
      b.createSpan({ cls: "aos-brain-chipn", text: String(counts[q]) });
      b.addEventListener("click", () => { if (q !== this.queue) { this.setQueue(q); this.update(); } });
    }
    const list = L.createDiv({ cls: "aos-brain-rv-list" });
    if (this.queue === "session") this.sessionList(list, v);
    else if (this.queue === "drafts") this.draftList(list, v);
    else if (this.queue === "duplicates") this.pairList(list, v);
    else this.olderList(list, v);
    // A listbox is reached by Tab on its selected row; with none selected, on its first.
    if (!list.querySelector("[role=option][tabindex='0']")) list.querySelector("[role=option]")?.setAttribute("tabindex", "0");

    const foot = L.createDiv({ cls: "aos-brain-rv-foot" });
    const day = defaultMarkBefore(v.d.now);
    if (this.markable(day).length) {
      const mb = foot.createEl("button", { cls: "aos-brain-rv-markbtn", text: `Mark everything before ${shortDay(day, v.d.now)} reviewed…`, attr: { type: "button", "data-rv-key": "markbefore" } });
      mb.addEventListener("click", () => void this.markBefore());
    }
    // Approve and Reject remove the draft file (D6): only the other queues can say nothing is deleted.
    foot.createSpan({ text: this.queue === "drafts" ? "Approve files a draft as a memory; Reject removes the draft. No memory is deleted." : "Reviewing deletes no memory. Kept memories leave this list." });
  }

  private sessionList(list: HTMLElement, v: View): void {
    if (!v.batches.length) return;
    const count = (bs: readonly ReviewBatch[]): string => `${pl(bs.reduce((n, b) => n + b.paths.length, 0), "memory", "memories")} · ${pl(bs.length, "session")}`;
    const week = list.createDiv({ cls: "aos-brain-rv-group" });
    week.createSpan({ text: "THIS WEEK" });
    week.createSpan({ cls: "aos-brain-rv-groupn", text: count(v.week) });
    if (v.week.length) this.batchList(list, v.week, "This week's sessions", v.d);
    else list.createDiv({ cls: "aos-brain-rv-none", text: "Nothing new this week." });
    if (!v.earlier.length) return;
    const fold = list.createEl("button", { cls: "aos-brain-rv-fold", attr: { type: "button", "aria-expanded": String(v.earlierOpen), "data-rv-key": "earlier" } });
    const ch = fold.createSpan({ cls: "aos-brain-rv-chev", attr: { "aria-hidden": "true" } });
    setIcon(ch, "chevron-right");
    fold.createSpan({ text: "EARLIER" });
    fold.createSpan({ cls: "aos-brain-rv-groupn", text: count(v.earlier) });
    fold.addEventListener("click", () => { this.earlier = !v.earlierOpen; this.update(); });
    if (v.earlierOpen) this.batchList(list, v.earlier, "Earlier sessions", v.d);
  }

  private batchList(list: HTMLElement, bs: readonly ReviewBatch[], label: string, d: BrainData): void {
    const lb = list.createDiv({ cls: "aos-brain-rv-lb", attr: { role: "listbox", "aria-label": label } });
    for (const b of bs) {
      const on = b.key === this.batch.key;
      const r = lb.createEl("button", {
        cls: "aos-brain-rv-row aos-brain-rv-batch",
        attr: { type: "button", role: "option", "aria-selected": String(on), tabindex: on ? "0" : "-1", "data-key": b.key, "data-rv-key": `batch:${b.key}` },
      });
      const l1 = r.createSpan({ cls: "aos-brain-rv-rline" });
      // The host is named in words on the next line; the dot only repeats it.
      l1.createSpan({ cls: `aos-brain-dot${b.host === "claude" || b.host === "codex" ? ` is-${b.host}` : ""}`, attr: { "aria-hidden": "true" } });
      l1.createSpan({ cls: "aos-brain-rv-rtitle", text: b.title, attr: { title: b.title } });
      l1.createSpan({ cls: "aos-brain-rv-when aos-brain-mono", text: batchWhen(b.at, d.now) });
      const l2 = r.createSpan({ cls: "aos-brain-rv-rmeta" });
      l2.createSpan({ cls: "aos-brain-mono", text: b.host ?? "wrap" });
      l2.createSpan({ text: `${b.paths.length} new` });
      if (b.known.length) l2.createSpan({ cls: "aos-brain-pill is-warn", text: knownLabel(b.known.length) });
      if (b.unchecked.length) l2.createSpan({ cls: "aos-brain-pill is-off aos-brain-rv-unchecked", text: `${b.unchecked.length} not checked`, attr: { title: "Written since the duplicate check last ran; it runs again now" } });
      // Many sessions share one custom title: the first memory's title tells them apart.
      if (b.lead && b.lead !== b.title) r.createSpan({ cls: "aos-brain-rv-lead", text: b.lead, attr: { title: b.lead } });
      // One bar per memory; their types are named in words (§4). Colour is for state only (brain-hub D23).
      const types = b.paths.map((p) => d.byPath.get(p)?.type ?? "none");
      const words = [...new Set(types)].map((t) => `${types.filter((x) => x === t).length} ${t}`).join(" · ");
      const pips = r.createSpan({ cls: "aos-brain-rv-pips", attr: { role: "img", "aria-label": words, title: words } });
      for (const t of types) pips.createSpan({ cls: `aos-brain-rv-pip is-${t}` });
      r.addEventListener("click", () => this.pickBatch(b.key));
    }
  }

  /** A row of the Drafts, Duplicates or Older list: a listbox option whose selection is `key` (D4, §4). */
  private optionRow(lb: HTMLElement, key: string, attr: Record<string, string> = {}): HTMLButtonElement {
    const on = this.sel[this.queue].key === key;
    const r = lb.createEl("button", {
      cls: "aos-brain-rv-row",
      attr: { type: "button", role: "option", "aria-selected": String(on), tabindex: on ? "0" : "-1", "data-sel": key, "data-rv-key": `row:${key}`, ...attr },
    });
    r.addEventListener("click", () => this.select(key, { scroll: true }));
    return r;
  }

  private draftList(list: HTMLElement, v: View): void {
    if (!v.drafts.length) return;
    const lb = list.createDiv({ cls: "aos-brain-rv-lb", attr: { role: "listbox", "aria-label": "Feedback drafts" } });
    for (const x of v.drafts) {
      const l1 = this.optionRow(lb, x.slug, { "data-slug": x.slug }).createSpan({ cls: "aos-brain-rv-rline" });
      l1.createSpan({ cls: "aos-brain-rv-rtitle", text: x.title, attr: { title: x.title } });
      l1.createSpan({ cls: "aos-brain-rv-when aos-brain-mono", text: shortDay(x.created, v.d.now) });
    }
  }

  private pairList(list: HTMLElement, v: View): void {
    if (!v.pairs.length) return;
    const lb = list.createDiv({ cls: "aos-brain-rv-lb", attr: { role: "listbox", "aria-label": "Duplicate pairs" } });
    for (const p of v.pairs) {
      const t = `${v.d.byPath.get(p.a)?.title ?? p.a} · ${v.d.byPath.get(p.b)?.title ?? p.b}`;
      const l1 = this.optionRow(lb, pk(p.a, p.b), { "data-a": p.a, "data-b": p.b }).createSpan({ cls: "aos-brain-rv-rline" });
      l1.createSpan({ cls: "aos-brain-rv-rtitle", text: t, attr: { title: t } });
      l1.createSpan({ cls: "aos-brain-rv-when aos-brain-mono", text: p.score.toFixed(2) });
    }
  }

  private olderList(list: HTMLElement, v: View): void {
    for (const g of olderByMonth(v.olderShown, v.d.written)) {
      const head = list.createDiv({ cls: "aos-brain-rv-group" });
      head.createSpan({ text: g.label.toUpperCase() });
      head.createSpan({ cls: "aos-brain-rv-groupn", text: pl(g.items.length, "memory", "memories") });
      const lb = list.createDiv({ cls: "aos-brain-rv-lb", attr: { role: "listbox", "aria-label": g.label } });
      for (const m of g.items) {
        const l1 = this.optionRow(lb, m.path).createSpan({ cls: "aos-brain-rv-rline" });
        l1.createSpan({ cls: `aos-brain-dot is-${m.type}`, attr: { role: "img", "aria-label": m.type } });
        l1.createSpan({ cls: "aos-brain-rv-rtitle", text: m.title, attr: { title: m.title } });
        l1.createSpan({ cls: "aos-brain-rv-when aos-brain-mono", text: shortDay(writtenAt(m, v.d.written), v.d.now) });
      }
    }
    this.olderMore(list, v, "older:moreleft");
  }

  /** "Show N more" under the Older queue's rows and cards, while some are not drawn. */
  private olderMore(parent: HTMLElement, v: View, key: string): void {
    const rest = v.older.length - v.olderShown.length;
    if (rest <= 0) return;
    const n = Math.min(rest, OLDER_PAGE);
    const b = parent.createEl("button", { cls: "aos-brain-btn is-small aos-brain-rv-moreolder", text: `Show ${n} more`, attr: { type: "button", "data-rv-key": key, title: `${rest} more not shown` } });
    b.addEventListener("click", () => { this.olderLimit += OLDER_PAGE; this.update(); });
  }

  // ── the main pane ──

  private drawMain(v: View): void {
    const M = this.main!;
    M.empty();
    if (this.queue === "session") this.sessionMain(M, v);
    else if (this.queue === "drafts") this.draftsMain(M, v);
    else if (this.queue === "duplicates") this.pairsMain(M, v);
    else this.olderMain(M, v);
  }

  private sessionMain(M: HTMLElement, v: View): void {
    const b = v.shown.find((x) => x.key === this.batch.key) ?? null;
    if (!b) {
      M.setAttr("aria-label", "Review");
      M.createDiv({ cls: "aos-brain-empty aos-brain-rv-empty", text: v.batches.length ? "Pick a session on the left." : "Nothing to review. Memories your sessions write land here.", attr: { tabindex: "-1" } });
      return;
    }
    M.setAttr("aria-label", b.title);
    const head = M.createEl("header", { cls: "aos-brain-rv-head" });
    const r1 = head.createDiv({ cls: "aos-brain-rv-hrow" });
    r1.createEl("h2", { cls: "aos-brain-h2", text: b.title });
    r1.createSpan({ cls: "aos-brain-rv-meta aos-brain-mono", text: batchMeta(b, v.d.now) });
    const r2 = head.createDiv({ cls: "aos-brain-rv-hrow" });
    r2.createSpan({ cls: "aos-brain-rv-lede", text: batchLede(b.paths.length, b.known.length, b.unchecked.length) });
    r2.createSpan({ cls: "aos-brain-sp" });
    const keep = r2.createEl("button", { cls: "aos-brain-btn is-primary aos-brain-rv-keepnew", attr: { type: "button", "aria-keyshortcuts": "Shift+K", "data-rv-key": "keepnew" } });
    keep.createSpan({ text: b.fresh.length ? `Keep the ${b.fresh.length} new` : b.unchecked.length ? "Waiting for the duplicate check" : "Nothing new to keep" });
    keep.createEl("kbd", { cls: "aos-brain-kbd aos-brain-mono", text: "⇧K", attr: { "aria-hidden": "true" } });
    if (!b.fresh.length) {
      keep.disabled = true;
      keep.setAttr("title", b.unchecked.length ? "The duplicate check has not seen these yet; it runs again now" : "Every memory here looks like one you already have");
    }
    keep.addEventListener("click", () => void this.keepFresh(this.currentBatch()));
    const n = b.paths.length;
    const what = (): string => `${n === 1 ? "the one memory" : `all ${n} memories`} left to review from “${b.title}”`;
    this.moreMenu(r2, b.key, [
      { key: "keepall", label: `Keep all ${n}`, run: () => { const cb = this.currentBatch(); if (cb) void this.bulk("keep", cb.paths, "Keep all"); } },
      { key: "archiveall", label: `Archive all ${n}…`, run: () => { const cb = this.currentBatch(); if (cb) void this.archiveAll(cb.paths, what()); } },
    ]);
    const cards = M.createDiv({ cls: "aos-brain-rv-cards", attr: { "aria-label": "Memories this session wrote" } });
    for (const p of b.paths) { const m = v.d.byPath.get(p); if (m) this.card(cards, m, v, "session"); }
    this.keysFooter(M, true);
  }

  private olderMain(M: HTMLElement, v: View): void {
    M.setAttr("aria-label", "Older than 30 days");
    const n = v.older.length;
    const head = M.createEl("header", { cls: "aos-brain-rv-head" });
    head.createDiv({ cls: "aos-brain-rv-hrow" }).createEl("h2", { cls: "aos-brain-h2", text: "Older than 30 days" });
    const cards = M.createDiv({ cls: "aos-brain-rv-cards", attr: { "aria-label": "Memories older than 30 days" } });
    if (!n) { cards.createDiv({ cls: "aos-brain-empty", text: "Nothing older than 30 days waits for review.", attr: { tabindex: "-1" } }); return; }
    const r2 = head.createDiv({ cls: "aos-brain-rv-hrow" });
    r2.createSpan({ cls: "aos-brain-rv-lede", text: `${pl(n, "memory", "memories")} written more than 30 days ago ${n === 1 ? "waits" : "wait"} for review.` });
    r2.createSpan({ cls: "aos-brain-sp" });
    const keepAll = r2.createEl("button", { cls: "aos-brain-btn", text: `Keep all ${n}`, attr: { type: "button", "data-act": "keepall", "data-rv-key": "older:keepall" } });
    keepAll.addEventListener("click", () => void this.bulk("keep", this.view(this.ctx.data()).older.map((m) => m.path), "Keep all"));
    const archAll = r2.createEl("button", { cls: "aos-brain-btn", text: `Archive all ${n}…`, attr: { type: "button", "data-act": "archiveall", "data-rv-key": "older:archiveall" } });
    archAll.addEventListener("click", () => {
      const paths = this.view(this.ctx.data()).older.map((m) => m.path);
      void this.archiveAll(paths, `${paths.length === 1 ? "the one memory" : `all ${paths.length} memories`} older than 30 days still in Review`);
    });
    for (const m of v.olderShown) this.card(cards, m, v, "older");
    this.olderMore(cards, v, "older:moremain");
    this.keysFooter(M, false);
  }

  private draftsMain(M: HTMLElement, v: View): void {
    M.setAttr("aria-label", "Feedback drafts");
    const head = M.createEl("header", { cls: "aos-brain-rv-head" });
    head.createEl("h2", { cls: "aos-brain-h2", text: "Feedback drafts" });
    head.createSpan({ cls: "aos-brain-rv-lede", text: "Rules drafted from your corrections. Approve files one into brain/memory/feedback; Reject removes the draft and it is never drafted again." });
    const body = M.createDiv({ cls: "aos-brain-rv-cards", attr: { "aria-label": "Feedback drafts" } });
    if (!v.drafts.length) { body.createDiv({ cls: "aos-brain-empty", text: "No feedback drafts.", attr: { tabindex: "-1" } }); return; }
    for (const x of v.drafts) {
      const on = this.sel.drafts.key === x.slug;
      const c = body.createEl("article", {
        cls: `aos-brain-card aos-brain-rv-card aos-brain-rv-draft${on ? " is-selected" : ""}`,
        attr: { "data-slug": x.slug, "data-path": x.path, "data-sel": x.slug, "data-rv-key": `draft:${x.slug}`, tabindex: on ? "0" : "-1", "aria-current": on ? "true" : null, "aria-label": x.title },
      });
      const h = c.createDiv({ cls: "aos-brain-rv-chead" });
      h.createSpan({ cls: "aos-brain-type is-feedback", text: "feedback" });
      h.createSpan({ cls: "aos-brain-rv-ctitle", text: x.title, attr: { title: x.title } });
      const acts = h.createDiv({ cls: "aos-brain-rv-dacts" });
      this.textBtn(acts, "Approve", "is-primary", `dact:${x.slug}:approve`, "approve", () => void this.approve(x));
      this.textBtn(acts, "Reject…", "", `dact:${x.slug}:reject`, "reject", () => void this.reject(x));
      this.textBtn(acts, "Edit", "", `dact:${x.slug}:edit`, "edit", () => void this.ctx.edit(x.path));
      c.createDiv({ cls: "aos-brain-rv-sum", text: x.summary || "No description yet." });
      const meta = [shortDay(x.created, v.d.now), x.session ? sessionLabel(x.session) : ""].filter(Boolean).join(" · ");
      if (meta) c.createDiv({ cls: "aos-brain-rv-dmeta aos-brain-mono", text: meta });
      c.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("button")) this.select(x.slug, { focus: true }); });
    }
  }

  private pairsMain(M: HTMLElement, v: View): void {
    M.setAttr("aria-label", "Duplicates");
    const d = v.d;
    const head = M.createEl("header", { cls: "aos-brain-rv-head" });
    head.createEl("h2", { cls: "aos-brain-h2", text: "Duplicates" });
    head.createSpan({ cls: "aos-brain-rv-lede", text: "Pairs that read alike, the closest first. Keeping one marks the other superseded by it; Restore in Library undoes it." });
    const body = M.createDiv({ cls: "aos-brain-rv-cards" });
    if (!v.pairs.length) { body.createDiv({ cls: "aos-brain-empty", text: d.hub ? "No duplicates found." : "The scan has not built brain-hub.json yet.", attr: { tabindex: "-1" } }); return; }
    const p = v.pairs.find((x) => pk(x.a, x.b) === this.sel.duplicates.key);
    const a = p ? d.byPath.get(p.a) : undefined;
    const b = p ? d.byPath.get(p.b) : undefined;
    if (!p || !a || !b) return;
    const [older, newer] = olderFirst(a, b, d.written);
    const score = body.createDiv({ cls: "aos-brain-rv-dupscore" });
    score.createSpan({ cls: "aos-brain-pill is-warn", text: `${p.score.toFixed(2)} similar` });
    score.createSpan({ cls: "aos-brain-mono aos-brain-dim", text: [`title ${p.title.toFixed(2)}`, `text ${p.text.toFixed(2)}`, p.meaning === null ? "" : `meaning ${p.meaning.toFixed(2)}`].filter(Boolean).join(" · ") });
    const wrap = body.createDiv({ cls: "aos-brain-rv-compare aos-brain-rv-pair", attr: { "data-a": p.a, "data-b": p.b } });
    for (const [m, label] of [[older, "OLDER"], [newer, "NEWER"]] as const) {
      const box = wrap.createDiv({ cls: "aos-brain-rv-box", attr: { "data-path": m.path } });
      box.createSpan({ cls: "aos-brain-label", text: label });
      const t = box.createDiv({ cls: "aos-brain-rv-boxhead" });
      t.createSpan({ cls: `aos-brain-type is-${m.type}`, text: m.type });
      t.createSpan({ cls: "aos-brain-rv-boxtitle", text: m.title });
      box.createSpan({ cls: "aos-brain-rv-boxtext", text: m.summary || "No description yet." });
      box.createSpan({
        cls: "aos-brain-rv-boxmeta aos-brain-mono",
        text: [`${m.type}/${m.slug}.md`, m.created ? `created ${shortDay(m.created, d.now)}` : "", m.reviewed === false ? "to review" : "reviewed", weekUse(d.hub, m.path)].filter(Boolean).join(" · "),
      });
    }
    const acts = body.createDiv({ cls: "aos-brain-rv-cmpacts" });
    this.textBtn(acts, "Keep the older one", "is-primary", "pair:keepolder", "keepolder", () => void this.keepOver(older, newer, "Keep the older one"));
    this.textBtn(acts, "Keep the newer one", "", "pair:keepnewer", "keepnewer", () => void this.keepOver(newer, older, "Keep the newer one"));
    this.textBtn(acts, "Not duplicates", "", "pair:notdup", "notdup", () => void this.notDup(p));
    this.textBtn(acts, "Open both", "", "pair:openboth", "openboth", () => { void this.ctx.edit(older.path); void this.ctx.edit(newer.path); });
    acts.createSpan({ cls: "aos-brain-rv-hint", text: "Keeping one marks the other superseded by it; Restore undoes it. Not duplicates is remembered by the next scan." });
  }

  /** One memory's card (D4): type, title, flag, pin, the icon buttons, the summary, and the comparison when open (M). */
  private card(list: HTMLElement, m: BrainMemory, v: View, q: "session" | "older"): void {
    const d = v.d;
    const on = this.sel[q].key === m.path;
    const pinned = this.pins.get(m.path)?.on ?? m.pin;
    const flag = d.flags.get(m.path) ?? null;
    const other = flag ? d.byPath.get(flag.other) ?? null : null;
    const open = !!(flag && other) && this.compareOpen === m.path;
    const c = list.createEl("article", {
      cls: `aos-brain-card aos-brain-rv-card${on ? " is-selected" : ""}${open ? " is-open" : ""}`,
      attr: { "data-path": m.path, "data-sel": m.path, "data-rv-key": `card:${m.path}`, tabindex: on ? "0" : "-1", "aria-current": on ? "true" : null, "aria-label": m.title },
    });
    const head = c.createDiv({ cls: "aos-brain-rv-chead" });
    head.createSpan({ cls: `aos-brain-type is-${m.type}`, text: m.type });
    head.createSpan({ cls: "aos-brain-rv-ctitle", text: m.title, attr: { title: m.title } });
    if (flag) {
      const t = `looks like ${other?.title ?? flag.other} · ${flag.score.toFixed(2)}`;
      head.createSpan({ cls: "aos-brain-pill is-warn aos-brain-rv-flag", text: t, attr: { title: t } });
    }
    if (!flag && v.unchecked.has(m.path)) head.createSpan({ cls: "aos-brain-pill is-off aos-brain-rv-unchecked", text: "not checked yet", attr: { title: "Written since the duplicate check last ran; it runs again now" } });
    if (pinned) head.createSpan({ cls: "aos-brain-pill is-info aos-brain-rv-pinned", text: "pinned" });
    if (q === "older") head.createSpan({ cls: "aos-brain-rv-cdate aos-brain-mono", text: shortDay(writtenAt(m, d.written), d.now) });
    const acts = head.createDiv({ cls: "aos-brain-rv-acts" });
    for (const a of CARD_ACTS) {
      const b = this.iconBtn(acts, m.path, a.act, a.icon, a.label, a.keys);
      if (a.act === "merge") {
        if (!flag) { b.disabled = true; b.setAttr("title", "Nothing looks like this one"); }
        else b.setAttr("aria-expanded", String(open));
      }
      b.addEventListener("click", () => this.act(a.act, m));
    }
    const pin = pinned ? PIN_ACT.on : PIN_ACT.off;
    this.iconBtn(acts, m.path, "pin", pin.icon, pin.label, "P").addEventListener("click", () => this.act("pin", m));
    this.iconBtn(acts, m.path, OPEN_ACT.act, OPEN_ACT.icon, OPEN_ACT.label, OPEN_ACT.keys).addEventListener("click", () => this.act("open", m));
    c.createDiv({ cls: "aos-brain-rv-sum", text: m.summary || "No description yet." });
    if (open && flag && other) this.compare(c, m, other, flag.score, d);
    c.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("button")) this.select(m.path, { focus: true }); });
    c.addEventListener("dblclick", (e) => { if (!(e.target as HTMLElement).closest("button")) this.ctx.show({ mode: "library", memory: m.path }); });
  }

  /**
   * M on a flagged card: this one and the one it looks like, side by side, and what to do about it (D7). Each box says
   * which is the older by the rule "Keep the older one" picks with, with the day each was written: the card can be the
   * older of its pair (both members of a pair are flagged), and then the button keeps it and retires the other.
   */
  private compare(c: HTMLElement, m: BrainMemory, o: BrainMemory, score: number, d: BrainData): void {
    const age = compareAges(m, o, d.written);
    const day = (x: BrainMemory): string => shortDay(writtenAt(x, d.written), d.now);
    const wrap = c.createDiv({ cls: "aos-brain-rv-compare", attr: { "data-other": o.path } });
    const mine = wrap.createDiv({ cls: "aos-brain-rv-box", attr: { "data-path": m.path, "data-age": age.mine.toLowerCase() } });
    mine.createSpan({ cls: "aos-brain-label", text: `THIS ONE · ${age.mine}` });
    mine.createSpan({ cls: "aos-brain-rv-boxtext", text: m.summary || m.title });
    mine.createSpan({ cls: "aos-brain-rv-boxmeta aos-brain-mono", text: [`${m.type}/${m.slug}.md`, day(m)].filter(Boolean).join(" · ") });
    const theirs = wrap.createDiv({ cls: "aos-brain-rv-box", attr: { "data-path": o.path, "data-age": age.other.toLowerCase() } });
    const label = theirs.createSpan({ cls: "aos-brain-label aos-brain-rv-boxlabel" });
    label.createSpan({ text: `LOOKS LIKE · ${age.other}` });
    label.createSpan({ cls: "aos-brain-mono aos-brain-warn", text: `${score.toFixed(2)} similar` });
    theirs.createSpan({ cls: "aos-brain-rv-boxtitle", text: o.title });
    theirs.createSpan({ cls: "aos-brain-rv-boxtext", text: o.summary || o.title });
    theirs.createSpan({ cls: "aos-brain-rv-boxmeta aos-brain-mono", text: [o.type, day(o), weekUse(d.hub, o.path)].filter(Boolean).join(" · ") });
    const acts = c.createDiv({ cls: "aos-brain-rv-cmpacts" });
    const keepOlder = this.textBtn(acts, "Keep the older one", "is-primary", `cmp:${m.path}:keepolder`, "keepolder", () => {
      const now = compareAges(m, o, this.ctx.data().written);
      void this.keepOver(now.older, now.newer, "Keep the older one");
    });
    keepOlder.setAttr("title", `Keeps ${age.mine === "OLDER" ? "this one" : `“${o.title}”`}; ${age.mine === "OLDER" ? `“${o.title}”` : "this one"} is marked superseded by it`);
    this.textBtn(acts, "Keep both", "", `cmp:${m.path}:keepboth`, "keepboth", () => void this.keepBoth(m, o));
    this.textBtn(acts, "Open both", "", `cmp:${m.path}:openboth`, "openboth", () => { void this.ctx.edit(m.path); void this.ctx.edit(o.path); });
    acts.createSpan({ cls: "aos-brain-rv-hint", text: "Keep the older one marks the newer superseded by it; Restore undoes it. Merging two into one comes in a later update." });
  }

  private keysFooter(M: HTMLElement, batch: boolean): void {
    const f = M.createEl("footer", { cls: "aos-brain-rv-keys aos-brain-mono", attr: { "aria-label": "Keys" } });
    for (const t of ["↑↓ move", "K keep", "E edit", "M merge", "A archive", "P pin", ...(batch ? ["⇧K keep the batch"] : []), "⏎ open in Library"]) f.createSpan({ text: t });
  }

  private iconBtn(parent: HTMLElement, path: string, act: string, icon: string, label: string, keys: string): HTMLButtonElement {
    const b = parent.createEl("button", {
      cls: "aos-brain-iconbtn",
      attr: { type: "button", "aria-label": label, title: label, "aria-keyshortcuts": keys, "data-act": act, "data-rv-key": `act:${path}:${act}` },
    });
    const ic = b.createSpan({ cls: "aos-brain-ic", attr: { "aria-hidden": "true" } });
    setIcon(ic, icon);
    return b;
  }

  private textBtn(parent: HTMLElement, text: string, mod: string, key: string, act: string, run: () => void): HTMLButtonElement {
    const b = parent.createEl("button", { cls: `aos-brain-btn is-small${mod ? ` ${mod}` : ""}`, text, attr: { type: "button", "data-act": act, "data-rv-key": key } });
    b.addEventListener("click", run);
    return b;
  }

  /** "More batch actions": Keep all N, Archive all N… (a DOM menu; compat has no Menu). Part of the draw, so a reload
   *  keeps it open with fresh counts; Escape, Tab, a choice or a press elsewhere closes it. */
  private moreMenu(parent: HTMLElement, key: string, items: MenuItem[]): void {
    const wrap = parent.createDiv({ cls: "aos-brain-rv-morewrap" });
    const open = this.menu === key;
    const btn = wrap.createEl("button", {
      cls: "aos-brain-btn aos-brain-rv-more",
      attr: { type: "button", "aria-label": "More batch actions", title: "More batch actions", "aria-haspopup": "menu", "aria-expanded": String(open), "data-rv-key": "more" },
    });
    const ic = btn.createSpan({ cls: "aos-brain-ic", attr: { "aria-hidden": "true" } });
    setIcon(ic, "ellipsis");
    btn.addEventListener("click", () => { if (this.menu === key) this.closeMenu(true); else this.openMenu(key); });
    if (!open) return;
    const menu = wrap.createDiv({ cls: "aos-brain-rv-menu", attr: { role: "menu", "aria-label": "More batch actions" } });
    for (const it of items) {
      const mi = menu.createEl("button", { cls: "aos-brain-rv-menuitem", text: it.label, attr: { type: "button", role: "menuitem", tabindex: "-1", "data-act": it.key, "data-rv-key": `menu:${it.key}` } });
      mi.addEventListener("click", () => { this.closeMenu(true); it.run(); });
    }
    menu.addEventListener("keydown", (e) => {
      const rows = Array.from(menu.querySelectorAll<HTMLElement>("[role=menuitem]"));
      if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); this.closeMenu(true); return; }
      const i = rows.indexOf(e.target as HTMLElement);
      const n = rows.length;
      const j = e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowUp" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
      if (j < 0 || !n) return;
      e.preventDefault();
      rows[j].focus();
    });
  }

  private openMenu(key: string): void {
    this.closeMenu(false);
    this.menu = key;
    this.update();
    this.root?.querySelector<HTMLElement>(".aos-brain-rv-menuitem")?.focus();
    const doc = this.root?.ownerDocument;
    if (!doc) return;
    const fn = (e: Event): void => {
      const wrap = this.root?.querySelector(".aos-brain-rv-morewrap");
      if (wrap && e.target instanceof Node && wrap.contains(e.target)) return;
      this.closeMenu(false);
    };
    doc.addEventListener("pointerdown", fn, true);
    this.menuOff = { doc, fn };
  }

  private closeMenu(refocus: boolean): void {
    if (this.menuOff) { this.menuOff.doc.removeEventListener("pointerdown", this.menuOff.fn, true); this.menuOff = null; }
    if (this.menu === null) return;
    this.menu = null;
    this.root?.querySelector(".aos-brain-rv-menu")?.remove();
    const btn = this.root?.querySelector<HTMLElement>(".aos-brain-rv-more");
    btn?.setAttr("aria-expanded", "false");
    if (refocus) btn?.focus();
  }

  // ── selection ──

  private pickBatch(key: string): void {
    if (key === this.batch.key) return;
    this.batch = { key, index: 0 };
    this.sel.session = { key: null, index: 0 };
    this.compareOpen = null;
    this.closeMenu(false);
    this.resetMain = true;
    this.update();
  }

  /** Select a card (or a Drafts / Older row's card) in place, without a redraw: a double-click still lands on it. */
  private select(key: string, o: { focus?: boolean; scroll?: boolean } = {}): void {
    if (this.queue === "duplicates") {
      const keys = Array.from(this.left?.querySelectorAll<HTMLElement>("[role=option][data-sel]") ?? []).map((el) => el.getAttribute("data-sel"));
      this.sel.duplicates = { key, index: Math.max(0, keys.indexOf(key)) };
      this.resetMain = true;
      this.update();
      return;
    }
    this.selectQuiet(key);
    const card = this.main ? findBy(this.main, "data-sel", key) : null;
    if (card && o.focus) card.focus({ preventScroll: true });
    if (card && (o.focus || o.scroll)) card.scrollIntoView({ block: "nearest" });
    if (this.queue !== "session" && this.left) findBy(this.left, "data-sel", key)?.scrollIntoView({ block: "nearest" });
  }

  private selectQuiet(key: string): void {
    const keys = Array.from(this.main?.querySelectorAll<HTMLElement>("[data-sel]") ?? []).map((el) => el.getAttribute("data-sel"));
    const i = keys.indexOf(key);
    this.sel[this.queue] = { key, index: i < 0 ? this.sel[this.queue].index : i };
    this.paintSelection();
  }

  private paintSelection(): void {
    const key = this.sel[this.queue].key;
    for (const el of Array.from(this.main?.querySelectorAll<HTMLElement>("[data-sel]") ?? [])) {
      const on = el.getAttribute("data-sel") === key;
      el.toggleClass("is-selected", on);
      el.setAttr("aria-current", on ? "true" : null);
      el.setAttr("tabindex", on ? "0" : "-1");
    }
    if (this.queue === "session") return;
    for (const el of Array.from(this.left?.querySelectorAll<HTMLElement>("[role=option][data-sel]") ?? [])) {
      const on = el.getAttribute("data-sel") === key;
      el.setAttr("aria-selected", String(on));
      el.setAttr("tabindex", on ? "0" : "-1");
    }
  }

  /** ↑↓ in the left list: the next row is selected and takes the keyboard (a listbox, §4). */
  private stepRow(opt: HTMLElement, dir: number): void {
    const rows = Array.from(this.left!.querySelectorAll<HTMLElement>("[role=option]"));
    const i = rows.indexOf(opt);
    const j = Math.max(0, Math.min(rows.length - 1, i + dir));
    if (i < 0 || j === i) return;
    const key = rows[j].getAttribute("data-rv-key");
    rows[j].click();
    const el = key && this.left ? findBy(this.left, "data-rv-key", key) : null;
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }

  /** ↑↓ in the main pane: the card before or after takes the selection and the keyboard, scrolled into view. */
  private stepCard(dir: number): boolean {
    const cards = Array.from(this.main?.querySelectorAll<HTMLElement>("[data-sel]") ?? []);
    if (!cards.length) return false;
    const i = cards.findIndex((c) => c.getAttribute("data-sel") === this.sel[this.queue].key);
    const j = i < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, i + dir));
    this.select(cards[j].getAttribute("data-sel")!, { focus: true });
    return true;
  }

  // ── keys (D4): ↑↓ K E M A P ⇧K ⏎ ──

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || !this.root || !this.left || !this.main) return;
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t && (t.isContentEditable || t.closest("input, textarea, select, .aos-brain-rv-menu"))) return;
    if (this.root.ownerDocument.querySelector(".modal-container")) return;
    const k = reviewKey(e);
    if (!k) return;
    if (k === "up" || k === "down") {
      const dir = k === "up" ? -1 : 1;
      const opt = t && this.left.contains(t) ? t.closest<HTMLElement>("[role=option]") : null;
      if (opt) { e.preventDefault(); this.stepRow(opt, dir); return; }
      if (t && this.left.contains(t)) return;
      if (this.stepCard(dir)) e.preventDefault();
      return;
    }
    if (this.queue !== "session" && this.queue !== "older") return;
    if (k === "open" && t?.closest("button, a")) return;   // Enter on a button presses that button
    if (e.repeat) return;
    if (k === "keepBatch") {
      if (this.queue === "session") { e.preventDefault(); void this.keepFresh(this.currentBatch()); }
      return;
    }
    // The card the keyboard is in, else the selected one (focusin keeps the two together; this is the belt to it).
    const own = t && this.main.contains(t) ? t.closest<HTMLElement>("[data-sel]")?.getAttribute("data-sel") ?? null : null;
    const m = own && !this.hidden(own) ? this.ctx.data().byPath.get(own) ?? null : this.current();
    if (!m) return;
    e.preventDefault();
    this.act(k, m);
  }

  // ── actions ──

  private act(k: ReviewKey, m: BrainMemory): void {
    this.selectQuiet(m.path);
    switch (k) {
      case "keep": void this.verbHide([m.path], { verb: "keep", paths: [m.path] }, "Keep"); return;
      // One memory archives without asking (spec §6: more than one confirms); Restore in Library undoes it (D5).
      case "archive": void this.verbHide([m.path], { verb: "archive", paths: [m.path] }, "Archive"); return;
      case "edit": void this.ctx.edit(m.path); return;
      case "merge": this.toggleCompare(m); return;
      case "pin": void this.togglePin(m); return;
      case "open": this.ctx.show({ mode: "library", memory: m.path }); return;
      default: return;
    }
  }

  /**
   * Hides `keys` at once and runs `fn`, which answers the keys whose verb went through. Those stay hidden until the files
   * say so; the rest come back (ctx.run has already said why in a Notice). Answers how many went through.
   */
  private async hideRun(keys: readonly string[], fn: () => Promise<readonly string[]>): Promise<number> {
    const q = this.queue;
    const before = { ...this.sel[q] };
    // A queue's selection is a path, a draft's slug or a pair's key; what this hides is `draft:<slug>` and `pair:<a|b>`.
    const hiddenAs = before.key === null ? null : q === "drafts" ? `draft:${before.key}` : q === "duplicates" ? `pair:${before.key}` : before.key;
    const beforeBatch = { ...this.batch };
    for (const k of keys) this.busy.add(k);
    this.update();
    let done: readonly string[] = [];
    try { done = await fn(); } catch (e) { new Notice(`Review: ${e instanceof Error ? e.message : String(e)}`); }
    const ok = new Set(done);
    for (const k of keys) { this.busy.delete(k); if (ok.has(k)) this.gone.set(k, Date.now()); }
    this.armGone();
    if (ok.size < keys.length) {
      // A card that came back takes its selection back, and the keyboard with it when the keyboard is in the cards.
      if (hiddenAs && keys.includes(hiddenAs) && !ok.has(hiddenAs) && this.queue === q) {
        if (q === "session") this.batch = beforeBatch;
        this.sel[q] = before;
        // Duplicates draws only the selected pair: it is drawn again, and its buttons share their keys with the pair that
        // stood in, so the focus goes back to the same button on the right pair.
        if (q === "duplicates") this.resetMain = true;
        const a = this.root?.ownerDocument.activeElement;
        this.focusSel = !!(a && this.main?.contains(a));
      }
      this.update();
    }
    return ok.size;
  }

  private verbHide(keys: string[], v: MemoryVerb, label: string): Promise<number> {
    return this.hideRun(keys, async () => ((await this.ctx.run(v, label)).ok ? keys : []));
  }

  /** keep or archive over many paths, in calls of at most MAX_PATHS_PER_CALL; a failure stops it and shows the rest again. */
  private bulk(verb: "keep" | "archive", paths: readonly string[], label: string): Promise<number> {
    const ps = [...paths];
    if (!ps.length) return Promise.resolve(0);
    return this.hideRun(ps, async () => ps.slice(0, (await this.ctx.runAll(verb, ps, label)).done));
  }

  /** ⇧K: keep the batch's memories that look new (no duplicate flag, D3). */
  private async keepFresh(b: ReviewBatch | null): Promise<void> {
    if (b?.fresh.length) await this.bulk("keep", b.fresh, "Keep the new ones");
  }

  /** Archive of more than one confirms first, naming the count and the way back (spec §6, D5). */
  private async archiveAll(paths: readonly string[], what: string): Promise<void> {
    const n = paths.length;
    if (!n) return;
    const ok = await this.ctx.confirm(`Archive ${pl(n, "memory", "memories")}?`, `Archives ${what}. They leave recall, the MOCs and BRAIN.md. Nothing is deleted: Restore in Library puts each one back.`, `Archive ${n}`);
    if (ok) await this.bulk("archive", paths, "Archive");
  }

  private toggleCompare(m: BrainMemory): void {
    if (!this.ctx.data().flags.has(m.path)) return;
    this.compareOpen = this.compareOpen === m.path ? null : m.path;
    this.showSel = true;
    this.update();
  }

  /** P: pin or unpin through `set` with the hash the page read (D17); shown at once, put back if refused. */
  private async togglePin(m: BrainMemory): Promise<void> {
    const k = `pin:${m.path}`;
    if (this.busy.has(k)) return;
    const on = !(this.pins.get(m.path)?.on ?? m.pin);
    this.busy.add(k);
    this.pins.set(m.path, { on, at: Date.now() });
    this.update();
    const h = this.hashes.get(m.path);
    const expect = h && h.was === m.hash ? h.now : m.hash;
    const r = await this.ctx.run<SetResult>({ verb: "set", path: m.path, fields: { pin: on }, expect }, on ? "Pin" : "Unpin");
    this.busy.delete(k);
    if (r.ok) {
      this.pins.set(m.path, { on, at: Date.now() });
      if (typeof r.json.hash === "string") this.hashes.set(m.path, { was: m.hash, now: r.json.hash });
    } else { this.pins.delete(m.path); this.update(); }
  }

  /**
   * "Keep the older one" (or, in Duplicates, either one): `loser` is superseded by `winner` (D7), which leaves review as a
   * superseded memory is not live; then the winner is kept when it waits for review too. Restore undoes the supersede.
   */
  private async keepOver(winner: BrainMemory, loser: BrainMemory, label: string): Promise<void> {
    const keepWinner = winner.live && winner.reviewed === false;
    const pair = `pair:${pk(winner.path, loser.path)}`;
    const keys = [loser.path, pair, ...(keepWinner ? [winner.path] : [])];
    this.compareOpen = null;
    await this.hideRun(keys, async () => {
      const r = await this.ctx.run({ verb: "supersede", path: loser.path, by: winner.path }, label);
      if (!r.ok) return [];
      if (!keepWinner) return keys;
      return (await this.ctx.run({ verb: "keep", paths: [winner.path] }, label)).ok ? keys : [loser.path, pair];
    });
  }

  /** "Keep both": not duplicates (remembered for the scan, D11), then both kept where they wait for review. */
  private async keepBoth(m: BrainMemory, o: BrainMemory): Promise<void> {
    const paths = [m.path, ...(o.live && o.reviewed === false ? [o.path] : [])];
    const pair = `pair:${pk(m.path, o.path)}`;
    this.compareOpen = null;
    await this.hideRun([...paths, pair], async () => {
      if (!(await this.ctx.run({ verb: "notdup", a: m.path, b: o.path }, "Keep both")).ok) return [];
      this.ctx.dismissPair(m.path, o.path);
      return (await this.ctx.run({ verb: "keep", paths }, "Keep both")).ok ? [...paths, pair] : [pair];
    });
  }

  private async notDup(p: HubDup): Promise<void> {
    const key = `pair:${pk(p.a, p.b)}`;
    await this.hideRun([key], async () => {
      if (!(await this.ctx.run({ verb: "notdup", a: p.a, b: p.b }, "Not duplicates")).ok) return [];
      this.ctx.dismissPair(p.a, p.b);
      return [key];
    });
  }

  private async approve(x: BrainDraft): Promise<void> {
    const n = await this.verbHide([`draft:${x.slug}`], { verb: "draft", action: "approve", slug: x.slug }, "Approve");
    if (n) new Notice(`Approved: “${x.title}” is a feedback memory now.`);
  }

  /** Reject keeps today's behaviour (D6): the draft file goes and the rule is never drafted again; it confirms first. */
  private async reject(x: BrainDraft): Promise<void> {
    const ok = await this.ctx.confirm(`Reject “${x.title}”?`, "Removes this draft, and the rule is never drafted again. No memory changes.", "Reject");
    if (ok) await this.verbHide([`draft:${x.slug}`], { verb: "draft", action: "reject", slug: x.slug }, "Reject");
  }

  // ── Mark everything before … (D3) ──

  private markable(day: string): string[] {
    const d = this.ctx.data();
    return writtenBefore(d.memories, d.written, day).filter((p) => !this.hidden(p));
  }

  private async markBefore(): Promise<void> {
    const now = this.ctx.data().now;
    const day = await MarkBeforeModal.ask(this.ctx.plugin.app, { initial: defaultMarkBefore(now), now, count: (x) => this.markable(x).length });
    if (!day) return;
    const paths = this.markable(day);
    if (!paths.length) return;
    const done = await this.bulk("keep", paths, "Mark reviewed");
    if (done === paths.length) new Notice(`Marked ${pl(done, "memory", "memories")} reviewed.`);
    else if (done) new Notice(`Marked ${done} of ${pl(paths.length, "memory", "memories")} reviewed.`);
  }
}

/** The element under `root` whose `attr` is `value` (compared as text: paths and keys need no selector escaping). */
function findBy(root: HTMLElement, attr: string, value: string): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${attr}]`))) if (el.getAttribute(attr) === value) return el;
  return null;
}
