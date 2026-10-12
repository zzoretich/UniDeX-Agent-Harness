// Health (spec 2026-10-11-brain-hub D20, D22, D23, §6; spec 2026-10-12-brain-hub-ai A3, A5, A10; plans PR 3, PR 4;
// canvas Health): the brain's shape at a glance and the one-click fixes. Six tiles; Duplicates and clusters (Compare
// lands on that pair in Review's Duplicates queue, Merge with AI… opens the Merge dialog on it, Not duplicates is
// remembered through `aos memory notdup`, Rescan rebuilds brain-hub.json; a cluster's Consolidate with AI… runs a sweep
// scoped to it, and its cards show under the row); the Consolidation sweep; Hygiene, one row per `aos memory fix <kind>`;
// Dead weight from the usage log (D8). The words and numbers come from data/brainHealth.ts and data/brainSweep.ts.
//
// A fix never writes before it asks (spec §6): its dry run (ctx.preview) lists the changes in FixModal, and only a
// confirm runs it (ctx.run), pinned to that preview (its `expect`: the runtime refuses, writing nothing, when the files
// no longer give those changes, and the page rescans). Fixes are not undoable, so nothing here says they are. A dry run
// that finds nothing means brain-hub.json was behind the files: the page says so and rescans. Every action is a button
// that ignores the second click of a double-click and a held key's repeats; a row stays, its button busy, until its
// verb answers, so a fast second click never lands on the next row. A redraw keeps the scroll and the keyboard where
// they were (a control that left hands it to the one now in its place, else its card's heading).
//
// The Consolidation sweep (brain-ai A5, A10): its line ("last run … · N suggestions · N open"), what a sweep would cost
// (`sweep --estimate`, fetched once each time Health is shown; off, the reason and what still works), Run a sweep (one
// model call, waited for up to AI_TIMEOUT_MS), and the open cards by scope (views/brain/SweepCards.ts). A cluster's
// Consolidate with AI… asks first with that scope's estimate (A3). One sweep runs at a time on this page.
import { Notice } from "obsidian";
import {
  AI_TIMEOUT_MS, BRAIN_MODE_LABEL, batchWhen, parseFixResult, parseSweepEstimate, parseSweepResult, type BrainAnchor, type BrainTarget,
  type FixKind, type SweepEstimate,
} from "../../data/brainModel";
import {
  FIX_LABEL, HYGIENE_SUBTITLE, archiveShippedAsk, deadWeight, deadWeightButtons, deadWeightLegend, deadWeightSubtitle, duplicateRows,
  duplicatesBasis, fixBehindText, fixDoneText, healthTiles, hygieneRows, pl, type ClusterRow, type DeadWeight,
} from "../../data/brainHealth";
import {
  consolidateAsk, groupScopes, scopePaths, scopeSummary, sweepDoneText, sweepEstimateLine, sweepGroups, sweepOffText, sweepSummary,
} from "../../data/brainSweep";
import { FixModal } from "./FixModal";
import { guardClicks } from "./guardClicks";
import { SweepCards } from "./SweepCards";
import type { BrainCtx, BrainData, BrainModeView } from "./types";

/** Pairs shown before "Show all N". */
const PAIRS_SHOWN = 8;
/** How long "Rescanning…" waits for brain-hub.json to change before it gives up saying so. */
const RESCAN_MS = 120_000;
/** The cards a link can land on (BrainTarget.anchor). */
const ANCHORS: readonly BrainAnchor[] = ["duplicates", "hygiene", "deadweight"];
const pk = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

type FixStage = "check" | "ask" | "run";
interface Place { key: string | null; sec: string | null; index: number; scroll: number }
/** The whole brain's sweep estimate (A5): asked for, answered, or why not. */
type SweepEst = { state: "loading" } | { state: "ok"; e: SweepEstimate } | { state: "failed"; reason: string };
/** The sweep's scope while it runs: the whole brain, or a cluster's row key. */
const ALL = "all";

export class HealthMode implements BrainModeView {
  private root: HTMLElement | null = null;
  /** The fix whose dry run, question or run is under way: one at a time. */
  private fixing: { kind: FixKind; stage: FixStage } | null = null;
  /** Pairs whose Not duplicates runs ("busy") or went through and wait for the reload to drop them ("done"). */
  private dismissing = new Map<string, "busy" | "done">();
  private archiving = false;
  private allPairs = false;
  /** Rescan pressed: brain-hub.json's builtAt then, so "Rescanning…" shows until it changes. */
  private rescan: { from: string | null; at: number } | null = null;
  private rescanTimer: number | null = null;
  /** The control to give the keyboard on the next draw (after a dialog, when the one that opened it was redrawn). */
  private focusKey: string | null = null;
  /** The whole brain's sweep estimate, fetched once each time Health is shown (A5); `estSeq` drops a late answer. */
  private estimate: SweepEst | null = null;
  private estSeq = 0;
  /** The sweep under way (the whole brain, or a cluster's): its stage; one at a time. */
  private sweeping: { scope: string; stage: FixStage } | null = null;
  /** The pair whose Merge dialog is open (its button busy until the dialog closes). */
  private merging: string | null = null;
  private cards: SweepCards;

  constructor(private ctx: BrainCtx) {
    this.cards = new SweepCards(ctx, { keyAttr: "data-hl-key", redraw: () => this.update() });
  }

  mount(host: HTMLElement): void {
    this.focusKey = null;
    this.root = host.createDiv({ cls: "aos-brain-health", attr: { "aria-label": BRAIN_MODE_LABEL.health } });
    this.estimate = { state: "loading" };
    this.update();
    void this.fetchEstimate();
  }

  update(): void {
    if (!this.root) return;
    const d = this.ctx.data();
    for (const [k, s] of this.dismissing) if (s === "done" && !d.pairs.some((p) => pk(p.a, p.b) === k)) this.dismissing.delete(k);
    const place = this.savePlace();
    this.root.empty();
    this.draw(d);
    this.restorePlace(place);
  }

  /** Lands on a card (BrainTarget.anchor: Bootstrap's "Fix in Health →" on Hygiene): scrolled to, and its heading takes
   *  the keyboard when nothing has it (the control that linked here went with its mode). */
  reveal(t: BrainTarget): void {
    if (!this.root || !t.anchor || !ANCHORS.includes(t.anchor)) return;
    const sec = this.root.querySelector<HTMLElement>(`[data-anchor="${t.anchor}"]`);
    if (!sec) return;
    sec.scrollIntoView({ block: "start" });
    const a = this.root.ownerDocument.activeElement;
    if (!a || a === this.root.ownerDocument.body) sec.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }

  unmount(): void {
    if (this.rescanTimer !== null) window.clearTimeout(this.rescanTimer);
    this.rescanTimer = null;
    this.root = null;
  }

  // ── keeping the place across a redraw ──

  private savePlace(): Place {
    const R = this.root!;
    const a = R.ownerDocument.activeElement;
    const el = a instanceof HTMLElement && R.contains(a) ? a : null;
    const sec = el?.closest("[data-anchor]")?.getAttribute("data-anchor") ?? null;
    const keyed = sec ? Array.from(R.querySelectorAll<HTMLElement>(`[data-anchor="${sec}"] [data-hl-key]`)) : [];
    return { key: el?.closest("[data-hl-key]")?.getAttribute("data-hl-key") ?? null, sec, index: el ? keyed.indexOf(el) : -1, scroll: R.scrollTop };
  }

  private restorePlace(p: Place): void {
    const R = this.root!;
    R.scrollTop = p.scroll;
    const doc = R.ownerDocument;
    const a = doc.activeElement;
    // Only when the keyboard is nowhere (a dialog closed and the control that opened it was redrawn meanwhile): never
    // away from a control the person moved to while the action ran.
    if (this.focusKey && (!a || a === doc.body)) {
      const want = this.focusKey;
      this.focusKey = null;
      const el = findBy(R, "data-hl-key", want);
      if (el) { el.focus({ preventScroll: true }); return; }
    }
    if (!p.key && !p.sec) return;
    const same = p.key ? findBy(R, "data-hl-key", p.key) : null;
    if (same) { same.focus({ preventScroll: true }); return; }
    // The control left (a pair dismissed, a fix with nothing left): the one now in its place in the same card, else the
    // card's heading, never the page.
    const sec = p.sec ? R.querySelector<HTMLElement>(`[data-anchor="${p.sec}"]`) : null;
    const keyed = sec ? Array.from(sec.querySelectorAll<HTMLElement>("[data-hl-key]")) : [];
    const next = p.index >= 0 && keyed.length ? keyed[Math.min(p.index, keyed.length - 1)] : null;
    (next ?? sec?.querySelector<HTMLElement>("h2") ?? null)?.focus({ preventScroll: true });
  }

  // ── drawing ──

  private draw(d: BrainData): void {
    const R = this.root!;
    if (!d.hub) {
      const busy = this.rescanning(d);
      const b = R.createDiv({ cls: "aos-brain-hl-banner", attr: { role: "note", "data-anchor": "banner" } });
      b.createSpan({ text: "No brain-hub.json yet: the next scan writes it, and until then there is nothing to fix." });
      this.button(b, busy ? "Scanning…" : "Scan now", "rescan:banner", "rescan", () => this.doRescan(), { busy });
    }
    const grid = R.createDiv({ cls: "aos-brain-hl-tiles", attr: { role: "list", "aria-label": "Health at a glance" } });
    for (const t of healthTiles(d)) {
      const el = grid.createDiv({ cls: `aos-brain-hl-tile is-${t.tone}`, attr: { role: "listitem", "data-tile": t.key, "data-tone": t.tone } });
      el.createSpan({ cls: "aos-brain-hl-tv aos-brain-mono", text: t.value });
      const k = el.createSpan({ cls: "aos-brain-hl-tk" });
      k.createSpan({ text: t.label });
      if (t.word) k.createSpan({ cls: "aos-brain-hl-tw", text: t.word });
      el.createSpan({ cls: "aos-brain-hl-tn", text: t.note, attr: { title: t.note } });
    }
    const cols = R.createDiv({ cls: "aos-brain-hl-cols" });
    const wide = cols.createDiv({ cls: "aos-brain-hl-col is-wide" });
    const claimed = this.duplicates(wide, d);
    this.sweepCard(wide, d, claimed);
    const side = cols.createDiv({ cls: "aos-brain-hl-col" });
    this.hygiene(side, d);
    this.deadWeightCard(side, d);
  }

  /** A card: its heading (which a link or a lost focus lands on), the subtitle, then what `head` adds on the right. */
  private card(parent: HTMLElement, anchor: string, title: string, sub: string): { head: HTMLElement; body: HTMLElement } {
    const sec = parent.createEl("section", { cls: "aos-brain-hl-card", attr: { "data-anchor": anchor, "aria-labelledby": `aos-brain-hl-${anchor}` } });
    const head = sec.createEl("header", { cls: "aos-brain-hl-chead" });
    head.createEl("h2", { cls: "aos-brain-hl-ctitle", text: title, attr: { id: `aos-brain-hl-${anchor}`, tabindex: "-1" } });
    head.createSpan({ cls: "aos-brain-hl-csub", text: sub });
    head.createSpan({ cls: "aos-brain-sp" });
    return { head, body: sec.createDiv({ cls: "aos-brain-hl-cbody" }) };
  }

  /**
   * A button that keeps the keyboard while its action runs: busy reads aria-disabled (a disabled button would drop the
   * focus to the page) and ignores clicks. `label` is the accessible name when the text alone is not enough.
   */
  private button(parent: HTMLElement, text: string, key: string, act: string, run: () => void, o: { busy?: boolean; primary?: boolean; label?: string } = {}): HTMLButtonElement {
    const b = parent.createEl("button", {
      cls: `aos-brain-btn is-small aos-brain-hl-btn${o.primary ? " is-primary" : ""}${o.busy ? " is-busy" : ""}`, text,
      attr: { type: "button", "data-hl-key": key, "data-act": act, ...(o.label ? { "aria-label": o.label } : {}), ...(o.busy ? { "aria-disabled": "true" } : {}) },
    });
    guardClicks(b, () => { if (b.getAttribute("aria-disabled") !== "true") run(); });
    return b;
  }

  /** The Duplicates and clusters card; returns the sweep scopes whose cards it drew under a cluster row. */
  private duplicates(parent: HTMLElement, d: BrainData): Set<string> {
    const claimed = new Set<string>();
    const rows = duplicateRows(d);
    const scanned = d.hub?.builtAt ? batchWhen(d.hub.builtAt, d.now) : "";
    const { head, body } = this.card(parent, "duplicates", "Duplicates and clusters", `${duplicatesBasis(rows.meaning)}${scanned ? ` · scanned ${scanned}` : ""}`);
    const busy = this.rescanning(d);
    head.createSpan({ cls: "aos-brain-hl-status", text: busy ? "Rescanning…" : "", attr: { role: "status" } });
    this.button(head, busy ? "Rescanning…" : "Rescan", "rescan", "rescan", () => this.doRescan(), { busy });
    if (!d.hub) { body.createDiv({ cls: "aos-brain-empty aos-brain-hl-empty", text: "The next scan writes brain-hub.json; nothing to compare yet." }); return claimed; }
    // A pair whose Not duplicates runs stays in place, its button busy, until the verb answers (then it goes).
    const pairs = rows.pairs.filter((p) => this.dismissing.get(pk(p.a, p.b)) !== "done");
    if (!pairs.length && !rows.drafts.length && !rows.clusters.length) { body.createDiv({ cls: "aos-brain-empty aos-brain-hl-empty", text: "No duplicates found." }); return claimed; }
    const list = body.createDiv({ cls: "aos-brain-hl-rows", attr: { role: "list", "aria-label": "Duplicate pairs, leftover drafts and clusters" } });
    for (const p of this.allPairs ? pairs : pairs.slice(0, PAIRS_SHOWN)) {
      const k = pk(p.a, p.b);
      const r = list.createDiv({ cls: "aos-brain-hl-row aos-brain-hl-pair", attr: { role: "listitem", "data-pair": k, "data-a": p.a, "data-b": p.b } });
      r.createSpan({ cls: "aos-brain-hl-score aos-brain-mono", text: p.score, attr: { title: "similarity, 0 to 1" } });
      const t = r.createDiv({ cls: "aos-brain-hl-text" });
      t.createSpan({ cls: "aos-brain-hl-t1", text: p.aTitle, attr: { title: p.aTitle } });
      const l2 = `${p.bTitle}${p.meta ? ` · ${p.meta}` : ""}`;
      t.createSpan({ cls: "aos-brain-hl-t2", text: l2, attr: { title: l2 } });
      const acts = r.createDiv({ cls: "aos-brain-hl-acts" });
      const names = `“${p.aTitle}” and “${p.bTitle}”`;
      this.button(acts, "Compare", `pair:${k}:compare`, "compare", () => this.ctx.show({ mode: "review", queue: "duplicates", pair: { a: p.a, b: p.b } }), { label: `Compare ${names} in Review` });
      // brain-hub D21, brain-ai A1/A4: the Merge dialog on the pair (the model's draft on a click, else by hand).
      const merging = this.merging === k;
      this.button(acts, merging ? "Merging…" : "Merge with AI…", `pair:${k}:merge`, "merge", () => void this.mergePair(p.a, p.b, k), { label: `Merge with AI: ${names}`, busy: merging });
      const busy = this.dismissing.get(k) === "busy";
      this.button(acts, busy ? "Marking…" : "Not duplicates", `pair:${k}:notdup`, "notdup", () => void this.notDup(p.a, p.b), { label: `Not duplicates: ${names}`, busy });
    }
    if (pairs.length > PAIRS_SHOWN) {
      const more = list.createDiv({ cls: "aos-brain-hl-row aos-brain-hl-more", attr: { role: "listitem" } });
      const b = this.button(more, this.allPairs ? "Show fewer" : `Show all ${pairs.length}`, "pairs:all", "allpairs", () => { this.allPairs = !this.allPairs; this.update(); });
      b.setAttr("aria-expanded", String(this.allPairs));
    }
    const n = rows.drafts.length;
    for (const x of rows.drafts) {
      const r = list.createDiv({ cls: "aos-brain-hl-row aos-brain-hl-draft", attr: { role: "listitem", "data-draft": x.slug, "data-path": x.path } });
      r.createSpan({ cls: "aos-brain-hl-score aos-brain-hl-leftover", text: "draft" });
      const t = r.createDiv({ cls: "aos-brain-hl-text" });
      t.createSpan({ cls: "aos-brain-hl-t1", text: x.title, attr: { title: x.title } });
      t.createSpan({ cls: "aos-brain-hl-t2", text: "The same rule (slug and title), still in feedback/_drafts after it was approved" });
      const acts = r.createDiv({ cls: "aos-brain-hl-acts" });
      // The drafts fix removes every leftover draft, so the button says how many; its preview lists them.
      this.fixButton(acts, "drafts", n === 1 ? "Remove the draft…" : `Remove the ${n} drafts…`, `draft:${x.slug}:fix`);
    }
    for (const c of rows.clusters) {
      const r = list.createDiv({ cls: "aos-brain-hl-row aos-brain-hl-cluster", attr: { role: "listitem", "data-cluster": c.key } });
      r.createSpan({ cls: "aos-brain-hl-score aos-brain-mono", text: c.count, attr: { title: `${c.paths.length} memories that read alike` } });
      const t = r.createDiv({ cls: "aos-brain-hl-text" });
      t.createSpan({ cls: "aos-brain-hl-t1", text: c.label, attr: { title: c.label } });
      t.createSpan({ cls: "aos-brain-hl-t2", text: c.titles, attr: { title: c.titles } });
      // brain-ai A3: a sweep scoped to the cluster (its first path leads); its cards show under the row, not again in
      // the Consolidation sweep card.
      const acts = r.createDiv({ cls: "aos-brain-hl-acts" });
      const mine = this.sweeping?.scope === c.key ? this.sweeping.stage : null;
      const text = mine === "run" ? "Consolidating…" : mine ? "Checking…" : "Consolidate with AI…";
      const b = this.button(acts, text, `cluster:${c.key}:sweep`, "consolidate", () => void this.consolidate(c), { busy: !!this.sweeping, label: mine ? `Consolidate “${c.label}”: ${text}` : `Consolidate “${c.label}” with AI` });
      if (mine) b.setAttr("aria-busy", "true");
      const scopes = groupScopes(d.sweep, scopePaths(c.paths[0] ?? null, c.paths).paths);
      for (const s of scopes) claimed.add(s);
      const sum = scopeSummary(d, scopes);
      if (!sum.views.length) continue;
      const under = list.createDiv({ cls: "aos-brain-hl-row aos-brain-sw-under", attr: { role: "listitem", "data-cluster-cards": c.key, "aria-label": `Suggestions for ${c.label}` } });
      under.createEl("p", { cls: "aos-brain-sw-line", text: sum.line });
      this.cards.render(under, sum.views, { label: `Suggestions for ${c.label}` });
    }
    return claimed;
  }

  /**
   * The Consolidation sweep (brain-hub D22; brain-ai A5, A10): the line, what a sweep would cost (or why it is off, and
   * what still works), Run a sweep, then the open cards by scope: the whole brain first, then each community's or
   * cluster's under its name (a cluster's own cards show under its row instead: `claimed`).
   */
  private sweepCard(parent: HTMLElement, d: BrainData, claimed: ReadonlySet<string>): void {
    const sum = sweepSummary(d);
    const { head, body } = this.card(parent, "sweep", "Consolidation sweep", sum.line);
    const mine = this.sweeping?.scope === ALL;
    const est = this.estimate;
    const line = est?.state === "ok" ? sweepEstimateLine(est.e) : null;
    const off = !!line?.off;
    head.createSpan({ cls: "aos-brain-hl-status", text: mine ? "Sweeping…" : "", attr: { role: "status" } });
    const run = this.button(head, mine ? "Sweeping…" : "Run a sweep", "sweep:run", "sweep", () => void this.runSweep(), {
      busy: !!this.sweeping || off, primary: !off, label: off ? `Run a sweep: off. ${line!.text}` : undefined,
    });
    if (mine) run.setAttr("aria-busy", "true");
    const p = body.createEl("p", { cls: `aos-brain-sw-est${off ? " is-off" : ""}`, attr: { "data-est": mine ? "running" : est?.state === "ok" ? (off ? "off" : "ready") : est?.state ?? "loading" } });
    if (mine) p.createSpan({ text: "A model reads each memory's title, description and first lines; this can take up to two minutes." });
    else if (!est || est.state === "loading") p.createSpan({ text: "Checking what a sweep would cost…" });
    else if (est.state === "failed") p.createSpan({ text: `Could not check what a sweep would cost: ${est.reason}` });
    else {
      // Off is a state: its colour and its word, then the reason.
      if (off) p.createSpan({ cls: "aos-brain-pill is-off aos-brain-sw-off", text: "off" });
      p.createSpan({ text: line!.text });
    }
    const groups = sweepGroups(d, claimed);
    if (!groups.length) {
      body.createDiv({
        cls: "aos-brain-empty aos-brain-sw-empty",
        text: !sum.run ? "A sweep reads each memory's title, description and first lines, and suggests merges, archives and retitles. Nothing changes until you apply one."
          : sum.views.length ? "The open suggestions for a cluster show under its row." : "Nothing open: every suggestion was applied or dismissed.",
      });
      return;
    }
    for (const g of groups) {
      const sec = body.createEl("section", { cls: "aos-brain-sw-group", attr: { "data-scope": g.scope ?? "all", "aria-label": g.name } });
      sec.createEl("h3", { cls: "aos-brain-label aos-brain-sw-gname", text: `${g.name} · ${g.cards.length}` });
      this.cards.render(sec, g.cards, { label: `Suggestions: ${g.name}` });
    }
  }

  private hygiene(parent: HTMLElement, d: BrainData): void {
    const { body } = this.card(parent, "hygiene", "Hygiene", HYGIENE_SUBTITLE);
    if (!d.hub) { body.createDiv({ cls: "aos-brain-empty aos-brain-hl-empty", text: "The next scan writes brain-hub.json; nothing to fix yet." }); return; }
    const list = body.createDiv({ cls: "aos-brain-hl-rows", attr: { role: "list", "aria-label": "Hygiene findings" } });
    for (const h of hygieneRows(d.hub, { wrapHint: d.settings.wrapHint, byPath: d.byPath })) {
      const r = list.createDiv({ cls: `aos-brain-hl-row aos-brain-hl-hyg${h.button ? "" : " is-clean"}`, attr: { role: "listitem", "data-fix": h.kind, "data-count": String(h.count) } });
      r.createSpan({ cls: "aos-brain-hl-hygtext", text: h.text });
      if (h.button) this.fixButton(r, h.kind, h.button, `fix:${h.kind}`);
      else r.createSpan({ cls: "aos-brain-hl-clean", text: "clean" });
    }
  }

  /** A fix's button: its dry run, its dialog, its run (fix). While any fix runs, every fix button waits. */
  private fixButton(parent: HTMLElement, kind: FixKind, text: string, key: string): void {
    const mine = this.fixing?.kind === kind;
    const shown = mine ? (this.fixing!.stage === "run" ? "Fixing…" : "Checking…") : text;
    const b = this.button(parent, shown, key, "fix", () => void this.fix(kind, key), { busy: !!this.fixing, label: mine ? `${FIX_LABEL[kind]}: ${shown}` : undefined });
    b.setAttr("data-fix", kind);
    if (mine) b.setAttr("aria-busy", "true");
  }

  private deadWeightCard(parent: HTMLElement, d: BrainData): void {
    const dw = deadWeight(d);
    const { body } = this.card(parent, "deadweight", "Dead weight", deadWeightSubtitle(dw.days));
    body.setAttr("data-state", dw.state);
    if (dw.state !== "ready") { body.createEl("p", { cls: `aos-brain-hl-dwtext${dw.state === "off" ? " is-off" : ""}`, text: dw.text }); return; }
    this.usageBar(body, dw);
    body.createEl("p", { cls: "aos-brain-hl-dwtext", text: dw.text });
    const b = deadWeightButtons(dw);
    if (!b.review && !b.archive) return;
    const acts = body.createDiv({ cls: "aos-brain-hl-dwacts" });
    if (b.review) this.button(acts, b.review, "dw:review", "review-unused", () => this.ctx.show({ mode: "library", use: "unused" }), { label: `${b.review} in Library` });
    if (b.archive) this.button(acts, this.archiving ? "Archiving…" : b.archive, "dw:archive", "archive-shipped", () => void this.archiveShipped(), { busy: this.archiving });
  }

  /** Used, quiet, never as one bar, each part named in words beside its colour (D23). */
  private usageBar(body: HTMLElement, dw: DeadWeight): void {
    const lg = deadWeightLegend(dw);
    const total = dw.used + dw.quiet + dw.never;
    const bar = body.createDiv({ cls: "aos-brain-hl-bar", attr: { role: "img", "aria-label": `${lg.used}, ${lg.quiet}, ${lg.never}` } });
    for (const [cls, n] of [["is-used", dw.used], ["is-quiet", dw.quiet], ["is-never", dw.never]] as const) {
      if (n > 0 && total > 0) bar.createSpan({ cls: `aos-brain-hl-seg ${cls}` }).style.width = `${(n / total) * 100}%`;
    }
    const legend = body.createDiv({ cls: "aos-brain-hl-legend aos-brain-mono" });
    for (const [cls, text] of [["is-used", lg.used], ["is-quiet", lg.quiet], ["is-never", lg.never]] as const) {
      const s = legend.createSpan({ cls: `aos-brain-hl-key ${cls}`, attr: { "data-bucket": cls.slice(3) } });
      s.createSpan({ cls: "aos-brain-hl-swatch", attr: { "aria-hidden": "true" } });
      s.createSpan({ text });
    }
    body.createEl("p", { cls: "aos-brain-hl-help", text: lg.help });
  }

  // ── actions ──

  private rescanning(d: BrainData): boolean {
    if (!this.rescan) return false;
    if ((d.hub?.builtAt ?? null) !== this.rescan.from || Date.now() - this.rescan.at > RESCAN_MS) { this.rescan = null; return false; }
    return true;
  }

  private doRescan(): void {
    new Notice("Rescanning in the background: Health updates when brain-hub.json is rebuilt.");
    this.startRescan();
  }

  /** Rebuild brain-hub.json and brain-map.json (ctx.rescan); "Rescanning…" shows until builtAt moves or RESCAN_MS. */
  private startRescan(): void {
    this.ctx.rescan();
    this.rescan = { from: this.ctx.data().hub?.builtAt ?? null, at: Date.now() };
    if (this.rescanTimer !== null) window.clearTimeout(this.rescanTimer);
    this.rescanTimer = window.setTimeout(() => { this.rescanTimer = null; this.rescan = null; this.update(); }, RESCAN_MS + 50);
    this.update();
  }

  /**
   * A fix (D20, spec §6): its dry run first (ctx.preview writes nothing); nothing to change means the cache was behind,
   * so say so and rescan; else FixModal lists the changes, and only a confirm runs `aos memory fix <kind> --expect <the
   * dry run's hash>` (ctx.run, which reloads every file and rebuilds the cache). The runtime refuses, writing nothing,
   * when the files changed while the dialog was open (ctx.run's Notice says so) and the page rescans. A confirm runs the
   * fix even when the person moved to another mode meanwhile. The Notice names the files changed and a BRAIN.md rebuild
   * that failed.
   */
  private async fix(kind: FixKind, key: string): Promise<void> {
    if (this.fixing || !this.root) return;
    const label = FIX_LABEL[kind];
    this.fixing = { kind, stage: "check" };
    this.update();
    try {
      const pre = await this.ctx.preview<unknown>({ verb: "fix", kind, dryRun: true }, label);
      if (!pre.ok) return;
      const r = parseFixResult(pre.json);
      if (!r) { new Notice(`${label}: aos answered in an unexpected shape`); return; }
      if (!r.changes.length) { new Notice(fixBehindText(kind)); this.startRescan(); return; }
      // Left for another mode while the dry run ran: no dialog over a page the person moved to.
      if (!this.root) return;
      this.fixing = { kind, stage: "ask" };
      this.update();
      const ok = await FixModal.ask(this.ctx.plugin.app, { kind, result: r, titleOf: (p) => this.ctx.data().byPath.get(p)?.title ?? null });
      if (!ok) return;
      this.fixing = { kind, stage: "run" };
      this.update();
      const run = await this.ctx.run<unknown>({ verb: "fix", kind, dryRun: false, expect: r.expect }, label);
      if (run.ok) new Notice(fixDoneText(kind, parseFixResult(run.json)));
      else if (run.stale) this.startRescan();
    } catch (e) {
      new Notice(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.fixing = null;
      this.focusKey = key;
      this.update();
    }
  }

  /**
   * What a whole-brain sweep would cost (brain-ai A5): `sweep --estimate` writes nothing and calls no model. Asked once
   * each time Health is shown and after a run (today's spend moved); an answer from an earlier show is dropped.
   */
  private async fetchEstimate(): Promise<void> {
    const seq = ++this.estSeq;
    let next: SweepEst;
    try {
      // Quiet: the card says why inline ("Could not check what a sweep would cost: …"), on every show.
      const r = await this.ctx.preview<unknown>({ verb: "sweep", paths: [], estimate: true }, "Sweep estimate", { quiet: true });
      const e = r.ok ? parseSweepEstimate(r.json) : null;
      next = !r.ok ? { state: "failed", reason: r.reason } : e ? { state: "ok", e } : { state: "failed", reason: "aos answered in an unexpected shape" };
    } catch (err) {
      next = { state: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
    if (seq !== this.estSeq) return;
    this.estimate = next;
    this.update();
  }

  /**
   * Run a sweep (brain-hub D22; brain-ai A6, A10, A12): one model call over the whole brain, waited for up to
   * AI_TIMEOUT_MS; its cards replace the whole brain's open ones (the runtime does) and the reload shows them. The runtime
   * refuses when no Claude or Codex can answer (ctx.run's Notice gives its reason).
   */
  private async runSweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = { scope: ALL, stage: "run" };
    this.update();
    try {
      const r = await this.ctx.run<unknown>({ verb: "sweep", paths: [], estimate: false }, "Run a sweep", { timeoutMs: AI_TIMEOUT_MS });
      if (r.ok) new Notice(sweepDoneText(parseSweepResult(r.json)));
    } catch (e) {
      new Notice(`Run a sweep: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.sweeping = null;
      this.focusKey = "sweep:run";
      if (this.root) { this.estimate = { state: "loading" }; void this.fetchEstimate(); }
      this.update();
    }
  }

  /**
   * A cluster's Consolidate with AI… (brain-ai A3): the scoped estimate first (its first path leads), a question naming
   * the cost, then a sweep over those memories; its cards show under the row. Off, a Notice says why and nothing runs.
   * A confirm runs the sweep even when the person moved to another mode meanwhile.
   */
  private async consolidate(c: ClusterRow): Promise<void> {
    if (this.sweeping || !this.root) return;
    const key = `cluster:${c.key}:sweep`;
    const label = "Consolidate with AI";
    const sent = scopePaths(c.paths[0] ?? null, c.paths);
    this.sweeping = { scope: c.key, stage: "check" };
    this.update();
    try {
      const pre = await this.ctx.preview<unknown>({ verb: "sweep", paths: sent.paths, estimate: true }, label);
      if (!pre.ok) return;
      const e = parseSweepEstimate(pre.json);
      if (!e) { new Notice(`${label}: aos answered in an unexpected shape`); return; }
      if (!e.estimate.available) { new Notice(`${label}: ${sweepOffText(e.estimate)}`); return; }
      // Left for another mode while the estimate ran: no question over a page the person moved to.
      if (!this.root) return;
      this.sweeping = { scope: c.key, stage: "ask" };
      this.update();
      const q = consolidateAsk(c.label, e, sent);
      if (!(await this.ctx.confirm(q.title, q.message, q.confirm))) return;
      this.sweeping = { scope: c.key, stage: "run" };
      this.update();
      const r = await this.ctx.run<unknown>({ verb: "sweep", paths: sent.paths, estimate: false }, label, { timeoutMs: AI_TIMEOUT_MS });
      if (r.ok) new Notice(sweepDoneText(parseSweepResult(r.json), c.label));
    } catch (e) {
      new Notice(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.sweeping = null;
      this.focusKey = key;
      this.update();
    }
  }

  /** Merge with AI… on a pair (brain-hub D21): the Merge dialog; the pair goes once the merge is saved and reloaded. */
  private async mergePair(a: string, b: string, k: string): Promise<void> {
    if (this.merging) return;
    this.merging = k;
    this.update();
    try {
      await this.ctx.merge([a, b]);
    } catch (e) {
      new Notice(`Merge with AI: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.merging = null;
      this.focusKey = `pair:${k}:merge`;
      this.update();
    }
  }

  /**
   * Not duplicates (D11): remembered for the scan (notdup). The row stays, its button busy, while the verb runs, so the
   * second click of a double-click lands on this busy button and never on the next pair's; it goes once the verb answers.
   */
  private async notDup(a: string, b: string): Promise<void> {
    const k = pk(a, b);
    if (this.dismissing.has(k)) return;
    this.dismissing.set(k, "busy");
    this.update();
    let ok = false;
    try { ok = (await this.ctx.run({ verb: "notdup", a, b }, "Not duplicates")).ok; } catch (e) { new Notice(`Not duplicates: ${e instanceof Error ? e.message : String(e)}`); }
    if (ok) { this.dismissing.set(k, "done"); this.update(); this.ctx.dismissPair(a, b); }
    else { this.dismissing.delete(k); this.update(); }
  }

  /** "Archive the N shipped…" (spec §6: more than one confirms): never-used projects that are complete or look shipped. */
  private async archiveShipped(): Promise<void> {
    if (this.archiving) return;
    const dw = deadWeight(this.ctx.data());
    const paths = dw.shipped;
    if (!paths.length) return;
    const q = archiveShippedAsk(paths.length, dw.days);
    const ok = await this.ctx.confirm(q.title, q.message, q.confirm);
    this.focusKey = "dw:archive";
    if (!ok) { this.update(); return; }
    this.archiving = true;
    this.update();
    try {
      const r = await this.ctx.runAll("archive", paths, "Archive shipped");
      if (r.done) new Notice(`Archived ${pl(r.done, "project note")}${r.failed ? ` of ${paths.length}` : ""}. Restore in Library puts each one back.`);
    } catch (e) {
      new Notice(`Archive shipped: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.archiving = false;
      this.focusKey = "dw:archive";
      this.update();
    }
  }
}

/** The element under `root` whose `attr` is `value` (compared as text: paths need no selector escaping). */
function findBy(root: HTMLElement, attr: string, value: string): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${attr}]`))) if (el.getAttribute(attr) === value) return el;
  return null;
}
