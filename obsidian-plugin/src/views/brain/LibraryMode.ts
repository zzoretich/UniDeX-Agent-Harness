// Library (spec 2026-10-11-brain-hub D1, D2; canvas Library.dc.html): find and read what the brain holds. Three panes:
// the results on the left (Memories · Drafts · Patterns · Reflections, the facets Type, Status, Source and Use, the
// header's search), the reader in the middle (Reader.ts) and its context on the right (ContextPane.ts), which folds
// under the reader below 1100 px; everything stacks below 760 px. A link into the hub (D15) lands on a memory and widens
// only the facets that would hide it. Selecting a row redraws the reader and its context, never the list.
import { setIcon } from "obsidian";
import {
  DEFAULT_LIBRARY_FILTER, GONE_STATUSES, LIBRARY_KINDS, LIBRARY_KIND_LABEL, MEMORY_TYPES, STATUS_FACETS, filterShowing, hasUsage,
  libraryRows, librarySelection, sourceOptions, type BrainMemoryType, type BrainTarget, type LibraryFilter, type LibraryKind,
  type LibraryRow, type StatusFacet, type UseFacet,
} from "../../data/brainModel";
import { LibraryContext } from "./ContextPane";
import { LibraryLinks } from "./LibraryLinks";
import { LibraryReader, focusedKey, readerPath, refocus, type ReaderItem } from "./Reader";
import type { BrainCtx, BrainData, BrainModeView } from "./types";

/** At most this many result rows are drawn; past it the list says so (no silent cap). */
export const LIBRARY_ROW_CAP = 300;

type FacetKey = "type" | "status" | "source" | "use";
const FACET_LABEL: Record<FacetKey, string> = { type: "Type", status: "Status", source: "Source", use: "Use" };
interface Facet { wrap: HTMLElement; text: HTMLElement; select: HTMLSelectElement; options: string }

const ONE: Record<LibraryKind, string> = { memories: "memory", drafts: "draft", patterns: "pattern", reflections: "reflection" };
const NONE_YET: Record<LibraryKind, string> = {
  memories: "No memories yet.", drafts: "No feedback drafts wait for approval.", patterns: "No patterns yet.", reflections: "No reflections yet.",
};

export class LibraryMode implements BrainModeView {
  private root: HTMLElement | null = null;
  private kindBtns = new Map<LibraryKind, { btn: HTMLButtonElement; n: HTMLElement }>();
  private facetRow: HTMLElement | null = null;
  private facets = new Map<FacetKey, Facet>();
  private scroller: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private sortEl: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private more: HTMLElement | null = null;
  private split: HTMLElement | null = null;
  private reader: LibraryReader | null = null;
  private context: LibraryContext | null = null;
  private links: LibraryLinks;
  private filter: LibraryFilter = { ...DEFAULT_LIBRARY_FILTER };
  private sel: Record<LibraryKind, { sel: string | null; chosen: boolean }> = {
    memories: { sel: null, chosen: false }, drafts: { sel: null, chosen: false }, patterns: { sel: null, chosen: false }, reflections: { sel: null, chosen: false },
  };
  private rows: LibraryRow[] = [];
  /** A search or a facet narrows the rows (the empty reader says "No memories match." rather than "No memories yet."). */
  private filtered = false;
  private rowEls = new Map<string, HTMLButtonElement>();
  /** What the list last drew: a keystroke or a reload that leaves the rows as they are redraws none of them. */
  private listSig = "";
  private shownPath: string | null = null;

  constructor(private ctx: BrainCtx) {
    this.links = new LibraryLinks(ctx.plugin.app);
  }

  mount(host: HTMLElement): void {
    const root = host.createDiv({ cls: "aos-brain-panes aos-lib" });
    this.root = root;
    const left = root.createEl("aside", { cls: "aos-brain-left aos-lib-left", attr: { "aria-label": "Results" } });
    const top = left.createDiv({ cls: "aos-lib-top" });
    const kinds = top.createDiv({ cls: "aos-lib-kinds", attr: { role: "group", "aria-label": "Show" } });
    for (const k of LIBRARY_KINDS) {
      const btn = kinds.createEl("button", { cls: "aos-brain-chip aos-lib-kind", attr: { "data-kind": k, "aria-pressed": "false", "data-lib-key": `kind:${k}` } });
      btn.createSpan({ text: LIBRARY_KIND_LABEL[k] });
      const n = btn.createSpan({ cls: "aos-brain-chipn" });
      btn.addEventListener("click", () => this.setKind(k));
      this.kindBtns.set(k, { btn, n });
    }
    this.facetRow = top.createDiv({ cls: "aos-lib-facets", attr: { role: "group", "aria-label": "Filters" } });
    for (const k of ["type", "status", "source", "use"] as FacetKey[]) this.facets.set(k, this.facet(this.facetRow, k));

    this.scroller = left.createDiv({ cls: "aos-lib-scroll" });
    const head = this.scroller.createDiv({ cls: "aos-lib-counthead", attr: { "aria-live": "polite" } });
    this.countEl = head.createSpan({ cls: "aos-lib-count" });
    this.sortEl = head.createSpan({ cls: "aos-brain-mono aos-lib-sort" });
    this.list = this.scroller.createDiv({ cls: "aos-lib-list", attr: { role: "listbox", "aria-label": LIBRARY_KIND_LABEL[this.filter.kind] } });
    this.more = this.scroller.createDiv({ cls: "aos-lib-more" });
    this.list.addEventListener("keydown", (e) => this.listKey(e));

    this.split = root.createDiv({ cls: "aos-lib-split" });
    this.reader = new LibraryReader(this.split, this.ctx, { open: (p) => this.openPath(p) });
    this.context = new LibraryContext(this.split, this.ctx, this.links, { open: (p) => this.openPath(p) });
    this.update();
  }

  /** The data or the search changed: the chips and facets in place, the list (keeping its scroll and focus), the reader. */
  update(): void {
    const root = this.root;
    if (!root) return;
    const doc = root.ownerDocument;
    const had = root.contains(doc.activeElement);
    this.filter.query = this.ctx.query();
    this.drawTop();
    this.drawList();
    this.drawReader();
    // An action that removed its own button (Keep, Approve, a draft gone) leaves the focus on the selected row, not lost;
    // with no row left (the last draft approved), on the kind's chip, so the keys still reach the hub (§4).
    if (had && !root.contains(doc.activeElement)) {
      (this.rowEls.get(this.sel[this.filter.kind].sel ?? "") ?? this.list?.querySelector<HTMLElement>(".aos-lib-row") ?? this.kindBtns.get(this.filter.kind)?.btn)?.focus({ preventScroll: true });
    }
  }

  /** A link into the hub (D15): show that memory, widening only the facets that hide it. */
  reveal(t: BrainTarget): void {
    if (!t.memory) return;
    // The focus goes to its row only when it is nowhere (⏎ in Review removed the card it was on); never from a field.
    const a = this.root?.ownerDocument.activeElement;
    this.showMemory(t.memory, !a || a === this.root?.ownerDocument.body);
  }

  unmount(): void {
    this.reader?.destroy();
    this.context?.destroy();
    this.root = null;
    this.kindBtns.clear();
    this.facets.clear();
    this.rowEls.clear();
    this.listSig = "";
    this.facetRow = this.scroller = this.countEl = this.sortEl = this.list = this.more = this.split = null;
    this.reader = null;
    this.context = null;
    this.shownPath = null;
  }

  // ── the left pane ──

  private facet(parent: HTMLElement, key: FacetKey): Facet {
    // A dashed chip that reads "Type: any", over a native select (the accessible control, and the platform's menu).
    const wrap = parent.createEl("label", { cls: "aos-lib-facet", attr: { "data-facet": key } });
    const text = wrap.createSpan({ cls: "aos-lib-facettext" });
    const chev = wrap.createSpan({ cls: "aos-lib-chev", attr: { "aria-hidden": "true" } });
    setIcon(chev, "chevron-down");
    const select = wrap.createEl("select", { cls: "aos-lib-oversel", attr: { "aria-label": FACET_LABEL[key], "data-lib-key": `facet:${key}` } });
    select.addEventListener("change", () => this.setFacet(key, select.value));
    return { wrap, text, select, options: "" };
  }

  private setFacet(key: FacetKey, v: string): void {
    if (key === "type") this.filter.type = v === "any" ? null : (v as BrainMemoryType);
    else if (key === "status") this.filter.status = v as StatusFacet;
    else if (key === "source") this.filter.source = v === "any" ? null : v;
    else this.filter.use = v as UseFacet;
    this.update();
  }

  private setKind(k: LibraryKind): void {
    if (this.filter.kind === k) return;
    this.filter.kind = k;
    this.update();
  }

  private drawTop(): void {
    const d = this.ctx.data();
    const count: Record<LibraryKind, number> = {
      memories: d.memories.filter((m) => m.live).length, drafts: d.drafts.length, patterns: d.patterns.length, reflections: d.reflections.length,
    };
    for (const [k, { btn, n }] of this.kindBtns) {
      btn.setAttr("aria-pressed", String(k === this.filter.kind));
      n.textContent = String(count[k]);
      btn.setAttr("aria-label", `${LIBRARY_KIND_LABEL[k]}, ${count[k]}`);
    }
    if (this.facetRow) this.facetRow.hidden = this.filter.kind !== "memories";
    // The Use facet needs the usage log (D8); without one it is hidden and reads "any".
    const usage = hasUsage(d.hub);
    if (!usage) this.filter.use = "any";
    const sources = sourceOptions(d.memories);
    if (this.filter.source !== null && !sources.includes(this.filter.source)) sources.push(this.filter.source);
    this.setFacetView("type", ["any", ...MEMORY_TYPES], this.filter.type ?? "any", "any");
    this.setFacetView("status", [...STATUS_FACETS], this.filter.status, "live");
    this.setFacetView("source", ["any", ...sources], this.filter.source ?? "any", "any");
    this.setFacetView("use", ["any", "used", "unused"], this.filter.use, "any");
    const use = this.facets.get("use");
    if (use) use.wrap.hidden = !usage;
  }

  private setFacetView(key: FacetKey, values: string[], value: string, plain: string): void {
    const f = this.facets.get(key);
    if (!f) return;
    const sig = values.join("\n");
    if (f.options !== sig) {
      f.select.empty();
      for (const v of values) f.select.createEl("option", { text: v, value: v });
      f.options = sig;
    }
    if (f.select.value !== value) f.select.value = value;
    f.text.textContent = `${FACET_LABEL[key]}: ${value}`;
    f.wrap.toggleClass("is-set", value !== plain);
  }

  private exists(kind: LibraryKind, p: string, d: BrainData): boolean {
    if (kind === "memories") return d.byPath.has(p);
    const xs = kind === "drafts" ? d.drafts : kind === "patterns" ? d.patterns : d.reflections;
    return xs.some((x) => x.path === p);
  }

  private drawList(): void {
    const list = this.list;
    const scroller = this.scroller;
    if (!list || !scroller) return;
    const d = this.ctx.data();
    const kind = this.filter.kind;
    const rows = libraryRows(d, this.filter, d.hub);
    this.rows = rows;
    this.sel[kind] = librarySelection(rows, this.sel[kind].sel, this.sel[kind].chosen, (p) => this.exists(kind, p, d));
    const sel = this.sel[kind].sel;
    this.filtered = !!this.filter.query.trim() || (kind === "memories" && (this.filter.type !== null || this.filter.source !== null || this.filter.use !== "any" || this.filter.status !== "live"));
    const shown = rows.slice(0, LIBRARY_ROW_CAP);
    const sig = JSON.stringify([kind, this.filtered, rows.length, shown.map((r) => [r.path, r.title, r.summary, r.type, r.status, r.pin, r.useLabel])]);
    if (sig === this.listSig) { this.paintRows(sel); return; }
    this.listSig = sig;

    const top = scroller.scrollTop;
    const key = focusedKey(list);
    list.empty();
    this.rowEls.clear();
    list.setAttr("aria-label", LIBRARY_KIND_LABEL[kind]);
    if (this.countEl) this.countEl.textContent = `${rows.length} ${rows.length === 1 ? "MATCH" : "MATCHES"}`;
    if (this.sortEl) this.sortEl.textContent = rows.some((r) => r.use !== null) ? "sorted by use" : "newest first";
    // The reader says what is empty; the list only says how to see more.
    if (!rows.length && this.filtered) list.createDiv({ cls: "aos-brain-empty aos-lib-lempty", text: "Clear the search or widen a filter to see more." });
    for (const r of shown) this.row(list, r, r.path === sel);
    // One Tab stop: the selected row, else the first.
    if (!shown.some((r) => r.path === sel)) list.querySelector<HTMLElement>(".aos-lib-row")?.setAttribute("tabindex", "0");
    if (this.more) {
      const cut = rows.length > LIBRARY_ROW_CAP;
      this.more.hidden = !cut;
      this.more.textContent = cut ? `Showing ${LIBRARY_ROW_CAP} of ${rows.length}: narrow the search` : "";
    }
    scroller.scrollTop = top;
    refocus(list, key);
  }

  private row(list: HTMLElement, r: LibraryRow, on: boolean): void {
    const word = r.type ?? ONE[r.kind];
    const b = list.createEl("button", {
      cls: `aos-lib-row${on ? " is-selected" : ""}`,
      attr: { role: "option", "aria-selected": String(on), tabindex: on ? "0" : "-1", "data-path": r.path, "data-kind": r.kind, "data-lib-key": `row:${r.path}` },
    });
    const top = b.createSpan({ cls: "aos-lib-rowtop" });
    top.createSpan({ cls: `aos-lib-dot is-${r.kind === "memories" ? r.type : r.kind}`, attr: { "aria-hidden": "true", title: word } });
    top.createSpan({ cls: "aos-lib-sr", text: `${word}: ` });
    top.createSpan({ cls: "aos-lib-rowtitle", text: r.title });
    if (r.status && GONE_STATUSES.includes(r.status)) top.createSpan({ cls: "aos-brain-mono aos-lib-rowtag", text: r.status });
    if (r.pin) {
      const pin = top.createSpan({ cls: "aos-lib-pin", attr: { role: "img", "aria-label": "Pinned" } });
      setIcon(pin, "pin");
    }
    if (r.useLabel) {
      const unused = r.useLabel === "unused";
      top.createSpan({
        cls: `aos-brain-mono aos-lib-use${unused ? " is-unused" : ""}`, text: r.useLabel,
        attr: { title: unused ? "Not used in 30 days" : `${r.use} uses in 30 days` },
      });
    }
    if (r.summary) b.createSpan({ cls: "aos-lib-rowsum", text: r.summary });
    b.addEventListener("click", () => this.select(r.path));
    this.rowEls.set(r.path, b);
  }

  /** ↑↓ (and Home, End) move the selection through the rows, the focus with it. */
  private listKey(e: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = Array.from(this.rowEls.values());
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.indexOf(e.target as HTMLButtonElement);
    const n = rows.length;
    const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : i < 0 ? 0 : e.key === "ArrowDown" ? Math.min(n - 1, i + 1) : Math.max(0, i - 1);
    const next = rows[j];
    this.select(next.getAttribute("data-path")!);
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  }

  /** The person picked a row: move the highlight, redraw the reader and its context. */
  private select(path: string): void {
    const k = this.filter.kind;
    const was = this.sel[k].sel;
    this.sel[k] = { sel: path, chosen: true };
    if (was === path) return;
    this.paintRows(path);
    this.drawReader();
  }

  /** The highlight on the drawn rows, in place, and one Tab stop: the selected row, else the first. */
  private paintRows(sel: string | null): void {
    let any = false;
    for (const [p, b] of this.rowEls) {
      const on = p === sel;
      any ||= on;
      b.toggleClass("is-selected", on);
      b.setAttr("aria-selected", String(on));
      b.setAttr("tabindex", on ? "0" : "-1");
    }
    if (!any) this.rowEls.values().next().value?.setAttribute("tabindex", "0");
  }

  // ── the reader and its context ──

  private item(): ReaderItem | null {
    const d = this.ctx.data();
    const k = this.filter.kind;
    const p = this.sel[k].sel;
    if (!p || !this.rows.length) return null;
    if (k === "memories") { const m = d.byPath.get(p); return m ? { kind: k, m } : null; }
    if (k === "drafts") { const x = d.drafts.find((y) => y.path === p); return x ? { kind: k, d: x } : null; }
    const n = (k === "patterns" ? d.patterns : d.reflections).find((y) => y.path === p);
    return n ? { kind: k, n } : null;
  }

  private drawReader(): void {
    const k = this.filter.kind;
    const it = this.item();
    const empty = this.rows.length ? `Pick a ${ONE[k]} to read it.` : this.filtered ? `No ${k} match.` : NONE_YET[k];
    const path = it ? readerPath(it) : null;
    // Under 1100 px the reader and its context scroll as one: a redraw of the same file keeps the place, a new file
    // starts at the top.
    const split = this.split;
    const top = split && path !== null && path === this.shownPath ? split.scrollTop : 0;
    this.shownPath = path;
    this.reader?.show(it, empty);
    this.context?.show(it);
    if (split) split.scrollTop = top;
  }

  /** A file the reader or its context names: a memory, a draft, a pattern or a reflection shows here; the rest opens. */
  private openPath(path: string): void {
    const d = this.ctx.data();
    if (d.byPath.has(path)) { this.showMemory(path, true); return; }
    const kind: LibraryKind | null = d.drafts.some((x) => x.path === path) ? "drafts" : d.patterns.some((x) => x.path === path) ? "patterns"
      : d.reflections.some((x) => x.path === path) ? "reflections" : null;
    if (!kind) { void this.ctx.edit(path); return; }
    this.filter.kind = kind;
    this.sel[kind] = { sel: path, chosen: true };
    this.update();
    this.land(true);
  }

  private showMemory(path: string, focus: boolean): void {
    const d = this.ctx.data();
    const m = d.byPath.get(path);
    if (m) this.filter = filterShowing({ ...this.filter, query: this.ctx.query() }, m, d.hub);
    else this.filter.kind = "memories";
    this.sel.memories = { sel: path, chosen: true };
    this.update();
    this.land(focus);
  }

  /** Scroll the selected row into view (and focus it, when the person followed a link here). */
  private land(focus: boolean): void {
    const b = this.rowEls.get(this.sel[this.filter.kind].sel ?? "");
    if (!b) return;
    b.scrollIntoView({ block: "nearest" });
    if (focus) b.focus({ preventScroll: true });
  }
}
