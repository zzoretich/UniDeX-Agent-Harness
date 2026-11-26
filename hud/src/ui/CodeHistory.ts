// CodeHistory — Code ▸ History (remove-sessions D3; install-import B11 before it lived in Sessions): every past Claude Code
// and Codex session this Mac has a record of, by day, newest first, with a filter, HISTORY_PAGE rows at a time and Resume
// in a new terminal. It lies over Code's stage as the read-only past chat does (CodeStage), and reads nothing itself: its
// rows come from the HistoryCache the sidebar already holds (codeSidebarModel.ts), so the caches are stat'ed once.

import { routeWebLinks } from "./openWebLink";
import { HISTORY_PAGE, dayLabel, filterHistory, groupByDay, historyCount, type HistoryRow } from "../data/sessionHistory";

/** What the view needs of the panel that holds it. */
export interface CodeHistoryHost {
  /** The rows as the cache has them now, whether a read has landed (or failed), and whether any agent host is on and
   *  ready (without one the view says so; Resume says why on each row). Cheap: no config is read here. */
  history(): { rows: HistoryRow[]; loaded: boolean; error: string | null; hostReady: boolean };
  /** Resume `r` in a new Code terminal (its host's resume line at its place). */
  resume(r: HistoryRow): void;
  /** Close: back to the selected terminal. */
  close(): void;
}

export const NO_HOST_TEXT = "No host is signed in: History lists the past sessions on this Mac. Sign in to Claude Code or Codex to resume one.";

export class CodeHistory {
  private root: HTMLElement | null = null;
  private els: { count: HTMLElement; filter: HTMLInputElement; note: HTMLElement; list: HTMLElement } | null = null;
  private query = "";
  private shownRows = HISTORY_PAGE;
  /** What the list last drew, so a sidebar render that changed nothing here redraws nothing (and keeps focus). */
  private drawn: { rows: HistoryRow[]; loaded: boolean; error: string | null; ready: boolean; query: string; shown: number } | null = null;

  constructor(private readonly host: CodeHistoryHost) {}

  get shown(): boolean { return !!this.root && !this.root.hasClass("is-hidden"); }

  /** Builds the view, hidden, inside the stage. */
  mount(stage: HTMLElement): void {
    const root = stage.createDiv({ cls: "aos-ch is-hidden", attr: { "data-tour": "code-history", role: "region", "aria-label": "History" } });
    this.root = root;
    const head = root.createDiv({ cls: "aos-ch-head" });
    head.createDiv({ cls: "aos-ch-heading", text: "History", attr: { role: "heading", "aria-level": "2" } });
    const count = head.createSpan({ cls: "aos-ch-count", attr: { "aria-live": "polite" } });
    const close = head.createEl("button", { cls: "aos-ch-close", text: "Close", attr: { type: "button", "aria-label": "Close History" } });
    close.addEventListener("click", () => this.host.close());
    const scroll = root.createDiv({ cls: "aos-ch-scroll" });
    const col = scroll.createDiv({ cls: "aos-ch-col" });
    routeWebLinks(col, () => null);
    const filter = col.createEl("input", {
      cls: "aos-ch-filter",
      attr: { type: "search", placeholder: "Filter by title, summary, workspace or host", "aria-label": "Filter past sessions", "data-focus": "history-filter" },
    });
    filter.addEventListener("input", () => { this.query = filter.value; this.shownRows = HISTORY_PAGE; this.update(); });
    // Esc clears a filter first, then closes History; it never reaches the terminal under it or the Workbench.
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (filter.value) { filter.value = ""; this.query = ""; this.shownRows = HISTORY_PAGE; this.update(); return; }
      this.host.close();
    });
    const note = col.createDiv({ cls: "aos-ch-note aos-ch-nohost", text: NO_HOST_TEXT });
    this.els = { count, filter, note, list: col.createDiv({ cls: "aos-ch-days" }) };
  }

  show(): void {
    if (!this.root) return;
    this.root.removeClass("is-hidden");
    this.drawn = null;
    this.update();
  }

  hide(): void { this.root?.addClass("is-hidden"); }

  /** The keyboard goes to the filter (All history's click; a tour or a link that opens History leaves the focus alone). */
  focusFilter(): void { if (this.shown) this.els?.filter.focus(); }

  destroy(): void {
    this.root?.remove();
    this.root = null;
    this.els = null;
    this.drawn = null;
  }

  /** Draws the list again when its rows, load state, error, the hosts or the filter changed; focus stays where it was. */
  update(): void {
    const el = this.els;
    if (!el || !this.shown) return;
    const { rows, loaded, error, hostReady: ready } = this.host.history();
    const d = this.drawn;
    if (d && d.rows === rows && d.loaded === loaded && d.error === error && d.ready === ready && d.query === this.query && d.shown === this.shownRows) return;
    this.drawn = { rows, loaded, error, ready, query: this.query, shown: this.shownRows };
    el.note.toggleClass("is-hidden", ready);
    el.count.setText(loaded ? historyCount(rows) : "");
    const now = document.activeElement;
    const key = now instanceof HTMLElement && el.list.contains(now) ? now.getAttribute("data-focus") : null;
    this.drawList(el.list, rows, loaded, error);
    if (!key) return;
    for (const k of [key, "history-filter"]) {
      const target = k === "history-filter" ? el.filter : el.list.querySelector<HTMLElement>(`[data-focus="${CSS.escape(k)}"]`);
      if (target && !target.matches(":disabled")) { target.focus(); return; }
    }
  }

  private drawList(list: HTMLElement, all: HistoryRow[], loaded: boolean, error: string | null): void {
    list.empty();
    if (!loaded) { list.createDiv({ cls: "aos-ch-note", text: "Reading the session index…" }); return; }
    if (error) list.createDiv({ cls: "aos-ch-error", text: `Could not read the session index: ${error}` });
    if (!all.length) {
      list.createDiv({ cls: "aos-ch-note aos-ch-empty", text: "No past sessions on this Mac yet. The scan lists Claude Code and Codex sessions as it finds them; `aos import` adds a one-line summary to each." });
      return;
    }
    const rows = filterHistory(all, this.query);
    if (!rows.length) { list.createDiv({ cls: "aos-ch-note aos-ch-empty", text: "No past session matches the filter." }); return; }
    const now = new Date();
    for (const g of groupByDay(rows.slice(0, this.shownRows))) {
      const day = list.createDiv({ cls: "aos-ch-day", attr: { "data-day": g.day, role: "group", "aria-label": dayLabel(g.day, now) } });
      day.createDiv({ cls: "aos-ch-dayname", text: dayLabel(g.day, now) });
      for (const r of g.rows) this.drawRow(day, r);
    }
    const left = rows.length - this.shownRows;
    if (left > 0) {
      const more = list.createEl("button", { cls: "aos-ch-more", text: `Show ${Math.min(left, HISTORY_PAGE)} more (${left} left)`, attr: { type: "button", "data-focus": "history-more" } });
      more.addEventListener("click", () => { this.shownRows += HISTORY_PAGE; this.update(); });
    }
  }

  private drawRow(parent: HTMLElement, r: HistoryRow): void {
    const row = parent.createDiv({ cls: "aos-ch-row", attr: { "data-key": r.key, "data-host": r.host } });
    row.createSpan({ cls: `aos-ch-hostdot is-${r.host}`, attr: { role: "img", title: r.hostLabel, "aria-label": r.hostLabel } });
    const body = row.createDiv({ cls: "aos-ch-body" });
    body.createDiv({ cls: "aos-ch-title", text: r.title, attr: { title: r.title } });
    body.createDiv({ cls: "aos-ch-meta", text: [r.time, r.hostLabel, r.where].filter(Boolean).join(" · ") });
    if (r.summary) body.createDiv({ cls: "aos-ch-summary", text: r.summary });
    const res = r.resume;
    if (res.state === "none") return;
    const btn = row.createEl("button", {
      cls: "aos-ch-resume", text: "Resume",
      attr: { type: "button", "data-focus": `resume:${r.key}`, title: res.state === "on" ? res.hint : res.reason, "aria-label": `Resume ${r.title}` },
    });
    if (res.state === "off") { btn.disabled = true; body.createDiv({ cls: "aos-ch-why", text: res.reason }); return; }
    btn.addEventListener("click", () => this.host.resume(r));
  }
}
