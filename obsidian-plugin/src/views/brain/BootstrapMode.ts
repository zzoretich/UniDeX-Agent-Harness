// Bootstrap (spec 2026-10-11-brain-hub D17, D18; canvas Bootstrap): what every new session starts with, on either host.
// The main pane measures BRAIN.md, SESSION.md and recall-wake.md against their budgets and shows BRAIN.md by section as
// brain-sources.json recorded it (D10): Who you are, Critical rules (Unpin), Active context (Mark complete, the
// looks-shipped flag, the projects the budget left out behind "Show them"), Quick links and Last Session (its tokens only:
// the Stop hook writes it). The side pane previews recall on typed text (D18), lists SESSION.md's lines to remember and
// sizes MEMORY.md. Every change is `aos memory set --expect <the hash this page read>` through ctx.run (D13, D14), which
// rebuilds BRAIN.md (the bulk one rebuilds it once, after its last set: ctx.brainMd). "Looks shipped" is a suggestion
// only (D17): nothing is marked complete without a click, and the bulk one asks first (spec §6) and stops at the first
// refusal. A row stays, its button busy, until its verb answers, then leaves (or stays, when the verb failed); a row
// button ignores the second click of a double-click and a held key's repeats, so no click lands on the row below.
import { Notice, setIcon } from "obsidian";
import {
  activeHeader, bootstrapSections, budgetBars, completeAllLabel, completeConfirm, eachUntilFailure, indexCard, recallRows,
  reviewShippedLabel, sessionCard, shippedLede, shippedSummary, wrapNote, type BootstrapRow, type BootstrapSections,
  type ShippedSummary,
} from "../../data/brainBootstrap";
import {
  BRAIN_MODE_LABEL, SESSION_MD_PATH, clip, recallQuery, type BrainMemory, type BrainTarget, type RecallHit, type SetResult,
} from "../../data/brainModel";
import { guardClicks } from "./guardClicks";
import type { BrainCtx, BrainData, BrainModeView, RecallPreview } from "./types";

const pl = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** How long a row whose verb succeeded stays hidden while the files catch up (a reload takes well under it). */
const GONE_MS = 10_000;

type Section = "rules" | "active";
type RecallState =
  | { kind: "idle"; hint: string | null }
  | { kind: "loading"; query: string }
  | { kind: "error"; reason: string }
  | { kind: "done"; query: string; hits: RecallHit[] };
/** Where the keyboard and the panes were before a redraw: the focused control's key, its card and its place there. */
interface Place { had: boolean; key: string | null; group: { attr: string; value: string } | null; index: number; main: number; side: number; root: number }
interface RowAct { act: string; label: string; run: () => void }

export class BootstrapMode implements BrainModeView {
  private root: HTMLElement | null = null;
  private main: HTMLElement | null = null;
  private side: HTMLElement | null = null;
  private recallCard: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private out: HTMLElement | null = null;
  private cards: HTMLElement | null = null;
  /** Active context lists every project, or only those that look shipped ("Review the N…" lands here). */
  private filter: "all" | "shipped" = "all";
  /** "Show them": the projects BRAIN.md's budget left out. */
  private leftOutOpen = false;
  /** `<section>:<path>` whose verb runs (shown busy), and those whose verb went through (hidden until the files say so). */
  private busy = new Set<string>();
  private gone = new Map<string, number>();
  /** The hash `set` answered while the load still holds the one before it (a pinned project unpinned, then completed). */
  private hashes = new Map<string, { was: string; now: string }>();
  /** The bulk Mark complete runs: every row action waits for it. */
  private bulk = false;
  /** The recall preview: what was typed, what it answered, and which answer is the latest (an older one is dropped). */
  private text = "";
  private recall: RecallState = { kind: "idle", hint: null };
  private seq = 0;
  private goneTimer: number | null = null;

  constructor(private ctx: BrainCtx) {}

  mount(host: HTMLElement): void {
    const root = this.root = host.createDiv({ cls: "aos-brain-bootstrap", attr: { "aria-label": BRAIN_MODE_LABEL.bootstrap } });
    this.main = root.createEl("section", { cls: "aos-brain-bs-main", attr: { "aria-label": "BRAIN.md" } });
    this.side = root.createEl("aside", { cls: "aos-brain-bs-side", attr: { "aria-label": "Steer" } });
    this.buildRecall(this.side);
    this.cards = this.side.createDiv({ cls: "aos-brain-bs-cards" });
    this.update();
  }

  update(): void {
    if (!this.root || !this.main || !this.side) return;
    const d = this.ctx.data();
    this.prune(d);
    const place = this.savePlace();
    this.drawMain(d);
    this.drawCards(d);
    this.drawRecall(d);
    this.restorePlace(place);
    this.armGone();
  }

  /** "Review the N…" lands on the looks-shipped list (anchor "shipped"); a link to the preview on its field ("recall"). */
  reveal(t: BrainTarget): void {
    if (!this.root) return;
    if (t.anchor === "shipped") {
      const s = this.sections(this.ctx.data());
      if (s && shippedSummary(s).rows.length) this.filter = "shipped";
      this.update();
      findBy(this.root, "data-section", "active")?.scrollIntoView({ block: "start" });
      (findBy(this.root, "data-bs-key", "active:filter:shipped") ?? findBy(this.root, "data-bs-key", "sec:active"))?.focus({ preventScroll: true });
    } else if (t.anchor === "recall") {
      this.recallCard?.scrollIntoView({ block: "start" });
      this.input?.focus({ preventScroll: true });
    }
  }

  unmount(): void {
    if (this.goneTimer !== null) window.clearTimeout(this.goneTimer);
    this.goneTimer = null;
    this.root = this.main = this.side = this.recallCard = this.out = this.cards = null;
    this.input = null;
  }

  // ── state ──

  private hidden(key: string): boolean { return this.gone.has(key); }

  private sections(d: BrainData): BootstrapSections | null {
    return bootstrapSections(d, (p, sec) => !this.hidden(`${sec}:${p}`));
  }

  /** A done row stays hidden until its file no longer puts it there (unpinned, no longer active), or GONE_MS. */
  private prune(d: BrainData): void {
    const now = Date.now();
    for (const [k, at] of this.gone) {
      const cut = k.indexOf(":");
      const m = d.byPath.get(k.slice(cut + 1));
      const still = !!m && m.live && (k.slice(0, cut) === "rules" ? m.pin : m.type === "projects" && m.status === "active");
      if (!still || now - at > GONE_MS) this.gone.delete(k);
    }
    // Kept while the load still holds the hash before `set` or the one it answered: a hash read before the change (the
    // bulk's, saved when its button was pressed) still maps to the newest. Anything else is a change made elsewhere.
    for (const [p, h] of this.hashes) { const cur = d.byPath.get(p)?.hash; if (cur !== h.was && cur !== h.now) this.hashes.delete(p); }
  }

  /** A row the files still list after GONE_MS (a verb that went through but whose reload never came) shows again then. */
  private armGone(): void {
    if (this.goneTimer !== null) window.clearTimeout(this.goneTimer);
    this.goneTimer = null;
    if (!this.gone.size || !this.root) return;
    const wait = Math.max(0, Math.min(...this.gone.values()) + GONE_MS - Date.now()) + 50;
    this.goneTimer = window.setTimeout(() => { this.goneTimer = null; this.update(); }, wait);
  }

  // ── keeping the place across a redraw ──

  private savePlace(): Place {
    const root = this.root!;
    const a = root.ownerDocument.activeElement;
    const el = a instanceof HTMLElement && root.contains(a) ? a : null;
    const keyed = el?.closest<HTMLElement>("[data-bs-key]") ?? null;
    const card = keyed?.closest<HTMLElement>("[data-section], [data-bs]") ?? null;
    const attr = card?.hasAttribute("data-section") ? "data-section" : "data-bs";
    return {
      had: !!el, key: keyed?.getAttribute("data-bs-key") ?? null,
      group: card ? { attr, value: card.getAttribute(attr) ?? "" } : null,
      index: keyed && card ? Array.from(card.querySelectorAll<HTMLElement>("[data-bs-key]")).indexOf(keyed) : -1,
      main: this.main!.scrollTop, side: this.side!.scrollTop, root: root.scrollTop,
    };
  }

  private restorePlace(p: Place): void {
    const root = this.root!;
    this.main!.scrollTop = p.main;
    this.side!.scrollTop = p.side;
    root.scrollTop = p.root;
    if (!p.had) return;
    const a = root.ownerDocument.activeElement;
    // The recall field is never redrawn: when it had the focus it still has it.
    if (a instanceof HTMLElement && root.contains(a)) return;
    const usable = (e: HTMLElement | null): HTMLElement | null => (e && !e.matches(":disabled") ? e : null);
    let back = usable(p.key ? findBy(root, "data-bs-key", p.key) : null);
    if (!back && p.group) {
      // The focused row left (unpinned, completed): the control now at its place in the same card, so the keyboard stays
      // where it was rather than falling back to the page, where it no longer reaches the hub (§4).
      const card = findBy(root, p.group.attr, p.group.value);
      const all = card ? Array.from(card.querySelectorAll<HTMLElement>("[data-bs-key]")).filter((e) => !e.matches(":disabled")) : [];
      back = all[Math.min(Math.max(p.index, 0), all.length - 1)] ?? null;
    }
    (back ?? findBy(root, "data-bs-key", "head"))?.focus({ preventScroll: true });
  }

  // ── the main pane: budgets, the lede, BRAIN.md by section ──

  private drawMain(d: BrainData): void {
    const M = this.main!;
    M.empty();
    const head = M.createDiv({ cls: "aos-brain-bs-head", attr: { "data-tour": "brain-bootstrap-head" } });
    head.createEl("h2", { cls: "aos-brain-h2", text: "What every new session starts with", attr: { tabindex: "-1", "data-bs-key": "head" } });
    head.createSpan({ cls: "aos-brain-bs-sub", text: "Injected on the first prompt in Claude Code and Codex" });
    this.drawBudgets(M, d);
    const s = this.sections(d);
    if (!s) {
      M.createDiv({
        cls: "aos-brain-empty aos-brain-bs-empty",
        text: "BRAIN.md has not recorded what it was built from yet. The next scan rebuilds it, and so does any Pin, Unpin or Mark complete.",
      });
      return;
    }
    const sum = shippedSummary(s);
    if (!sum.rows.length) this.filter = "all";
    const lede = shippedLede(sum);
    if (lede) {
      const box = M.createDiv({ cls: "aos-brain-bs-lede", attr: { "data-bs": "lede" } });
      box.createSpan({ cls: "aos-brain-bs-ledetext", text: lede });
      const b = box.createEl("button", { cls: "aos-brain-btn is-small is-primary", text: reviewShippedLabel(sum.rows.length), attr: { type: "button", "data-act": "review-shipped", "data-bs-key": "lede:review" } });
      b.addEventListener("click", () => this.reveal({ anchor: "shipped" }));
    }
    this.whoSection(M, s);
    this.rulesSection(M, s);
    this.activeSection(M, s, sum);
    this.section(M, "links", "Quick links", "quickLinks in brain/config.json", pl(s.links.tokens, "token"));
    const last = this.section(M, "lastSession", "Last Session", "the Stop hook's summary, cut to the room the other sections leave", pl(s.lastSession.tokens, "token"));
    last.sec.createDiv({ cls: "aos-brain-bs-more", text: "Written every few turns by the session hooks; the hub does not edit it." });
  }

  private drawBudgets(M: HTMLElement, d: BrainData): void {
    const wrap = M.createDiv({ cls: "aos-brain-bs-budgets", attr: { role: "list", "aria-label": "Budgets", "data-tour": "brain-bootstrap-budgets" } });
    for (const b of budgetBars(d)) {
      const card = wrap.createDiv({ cls: `aos-brain-bs-budget${b.warn ? " is-warn" : ""}`, attr: { role: "listitem", "data-budget": b.key } });
      const top = card.createDiv({ cls: "aos-brain-bs-btop" });
      top.createSpan({ cls: "aos-brain-mono aos-brain-bs-bname", text: b.name });
      top.createSpan({ cls: "aos-brain-mono aos-brain-bs-bval", text: b.value });
      // A meter only when there is something to measure (§4: budget bars are progressbars); else a bare track.
      const bar = card.createDiv({
        cls: "aos-brain-bs-bar",
        attr: b.known
          ? { role: "progressbar", "aria-label": `${b.name} against its budget`, "aria-valuemin": "0", "aria-valuemax": String(b.max), "aria-valuenow": String(Math.min(b.now, b.max)), "aria-valuetext": `${b.value}. ${b.note}` }
          : { "aria-hidden": "true" },
      });
      bar.createDiv({ cls: "aos-brain-bs-fill" }).style.width = `${b.pct}%`;
      card.createSpan({ cls: "aos-brain-bs-bnote", text: b.note });
    }
  }

  /** A section card: its heading (a focus target when its rows leave), where it comes from, its tokens. */
  private section(M: HTMLElement, key: string, name: string, source: string, tokens: string): { sec: HTMLElement; tok: HTMLElement } {
    const sec = M.createEl("section", { cls: "aos-brain-bs-sec", attr: { "data-section": key, "aria-label": name } });
    const head = sec.createEl("header", { cls: "aos-brain-bs-shead" });
    head.createEl("h3", { cls: "aos-brain-bs-h3", text: name, attr: { tabindex: "-1", "data-bs-key": `sec:${key}` } });
    head.createSpan({ cls: "aos-brain-bs-src", text: source });
    head.createSpan({ cls: "aos-brain-sp" });
    const tok = head.createSpan({ cls: "aos-brain-mono aos-brain-bs-tok", text: tokens });
    return { sec, tok };
  }

  private rowList(sec: HTMLElement, label: string): HTMLElement {
    return sec.createDiv({ cls: "aos-brain-bs-rows", attr: { role: "list", "aria-label": label } });
  }

  /** One BRAIN.md line: the title and description as BRAIN.md shows them, the looks-shipped flag, its action. */
  private row(list: HTMLElement, r: BootstrapRow, section: string, act: RowAct | null, leftOut = false): void {
    const el = list.createDiv({ cls: "aos-brain-bs-row", attr: { role: "listitem", "data-path": r.path, ...(r.shipped ? { "data-shipped": "true" } : {}) } });
    const t = el.createSpan({ cls: "aos-brain-bs-rtext", attr: { title: `${r.line}\n(about ${pl(r.tokens, "token")} in BRAIN.md)` } });
    t.createEl("b", { cls: "aos-brain-bs-rtitle", text: r.title });
    if (r.description) t.createSpan({ cls: "aos-brain-bs-rdesc", text: ` — ${r.description}` });
    if (leftOut) el.createSpan({ cls: "aos-brain-bs-rnote", text: "left out" });
    // Colour for the state, with its words (D23): the flag says what made it look shipped.
    if (r.shipped) el.createSpan({ cls: "aos-brain-pill is-warn aos-brain-bs-flag", text: `looks shipped · ${r.shipped.toLowerCase()}`, attr: { title: `Its title or index line says “${r.shipped}”. A suggestion only.` } });
    if (!act) return;
    // Its verb runs: the row stays and its button reads busy (aria-disabled keeps the keyboard on it; clicks do nothing).
    const busy = this.busy.has(`${section}:${r.path}`);
    const text = busy ? (act.act === "unpin" ? "Unpinning…" : act.act === "complete" ? "Marking…" : act.label) : act.label;
    const b = el.createEl("button", {
      cls: `aos-brain-btn is-small aos-brain-bs-act${busy ? " is-busy" : ""}`, text,
      attr: { type: "button", "data-act": act.act, "data-bs-key": `${section}:${act.act}:${r.path}`, "aria-label": `${act.label}: ${r.title}`, ...(busy ? { "aria-disabled": "true", "aria-busy": "true" } : {}) },
    });
    b.disabled = this.bulk;
    guardClicks(b, () => { if (b.getAttribute("aria-disabled") !== "true") act.run(); });
  }

  private whoSection(M: HTMLElement, s: BootstrapSections): void {
    const { sec } = this.section(M, "who", "Who you are", "the first paragraph of user/profile.md", pl(s.who.tokens, "token"));
    const r = s.who.row;
    if (!r) {
      sec.createDiv({ cls: "aos-brain-bs-more", text: "No profile yet: brain/memory/user/profile.md's first paragraph goes here." });
      return;
    }
    this.row(this.rowList(sec, "Who you are"), r, "who", { act: "open", label: "Open", run: () => this.ctx.show({ mode: "library", memory: r.path }) });
  }

  private rulesSection(M: HTMLElement, s: BootstrapSections): void {
    const { sec } = this.section(M, "rules", "Critical rules", "memories with pin: true", pl(s.rules.tokens, "token"));
    if (s.rules.rows.length) {
      const list = this.rowList(sec, "Critical rules");
      for (const r of s.rules.rows) this.row(list, r, "rules", { act: "unpin", label: "Unpin", run: () => void this.setOne(r, "rules", { pin: false }, "Unpin") });
    } else {
      sec.createDiv({ cls: "aos-brain-bs-more", text: "None pinned." });
    }
    const more = sec.createDiv({ cls: "aos-brain-bs-more" });
    const pin = more.createEl("button", { cls: "aos-brain-bs-link", text: "+ Pin a memory…", attr: { type: "button", "data-act": "pin-more", "data-bs-key": "rules:pin" } });
    pin.addEventListener("click", () => this.ctx.show({ mode: "library" }));
    more.createSpan({ text: "Feedback rules work best here." });
  }

  private activeSection(M: HTMLElement, s: BootstrapSections, sum: ShippedSummary): void {
    const h = activeHeader(s.active);
    const { sec, tok } = this.section(M, "active", "Active context", "projects tagged status/active, newest first", h.text);
    sec.setAttr("data-anchor", "shipped");
    if (h.leftOut) {
      tok.appendText(" · ");
      tok.createSpan({ cls: "aos-brain-bs-left", text: h.leftOut });
    }
    const n = sum.rows.length;
    const complete = (r: BootstrapRow): RowAct => ({ act: "complete", label: "Mark complete", run: () => void this.setOne(r, "active", { status: "complete" }, "Mark complete") });
    if (n) {
      const bar = sec.createDiv({ cls: "aos-brain-bs-filter" });
      const grp = bar.createDiv({ cls: "aos-brain-bs-chips", attr: { role: "group", "aria-label": "Show in Active context" } });
      for (const [f, label, count] of [["all", "All", sum.of], ["shipped", "Looks shipped", n]] as const) {
        const c = grp.createEl("button", { cls: "aos-brain-chip", attr: { type: "button", "aria-pressed": String(this.filter === f), "data-filter": f, "data-bs-key": `active:filter:${f}` } });
        c.createSpan({ text: label });
        c.createSpan({ cls: "aos-brain-chipn", text: String(count) });
        c.addEventListener("click", () => { if (this.filter !== f) { this.filter = f; this.update(); } });
      }
      bar.createSpan({ cls: "aos-brain-sp" });
      const all = bar.createEl("button", { cls: "aos-brain-btn is-small", text: completeAllLabel(n), attr: { type: "button", "data-act": "complete-shipped", "data-bs-key": "active:bulk" } });
      all.disabled = this.bulk;
      all.addEventListener("click", () => void this.completeShipped(sum));
    }
    if (this.filter === "shipped") {
      const left = new Set(s.active.leftOut.map((r) => r.path));
      const list = this.rowList(sec, "Active projects that look shipped");
      for (const r of sum.rows) this.row(list, r, "active", complete(r), left.has(r.path));
      sec.createDiv({ cls: "aos-brain-bs-more", text: "Suggestions only: each names a version, “shipped”, “released” or “superseded”. Check before you mark one complete." });
      return;
    }
    if (s.active.shown.length) {
      const list = this.rowList(sec, "Active context");
      for (const r of s.active.shown) this.row(list, r, "active", complete(r));
    } else if (!s.active.leftOut.length) {
      sec.createDiv({ cls: "aos-brain-bs-more", text: "No active projects." });
    }
    const k = s.active.leftOut.length;
    if (!k) return;
    const more = sec.createDiv({ cls: "aos-brain-bs-more" });
    more.createSpan({ text: `…and ${pl(k, `${s.active.shown.length ? "older " : ""}active project`)} that no longer ${k === 1 ? "fits" : "fit"}.` });
    const t = more.createEl("button", {
      cls: "aos-brain-bs-link", text: this.leftOutOpen ? "Hide them" : "Show them",
      attr: { type: "button", "aria-expanded": String(this.leftOutOpen), "data-act": "left-out", "data-bs-key": "active:leftout" },
    });
    t.addEventListener("click", () => { this.leftOutOpen = !this.leftOutOpen; this.update(); });
    if (!this.leftOutOpen) return;
    const list = this.rowList(sec, "Left out of BRAIN.md");
    list.addClass("is-leftout");
    for (const r of s.active.leftOut) this.row(list, r, "active", complete(r), true);
  }

  // ── actions ──

  /** `set` with the newest hash this page knows (D17); says so when BRAIN.md was not rebuilt after it. `skipBrainMd`: the
   *  caller rebuilds it once after several (the bulk). */
  private async set(m: BrainMemory, fields: { pin?: boolean; status?: "complete" }, label: string, skipBrainMd = false): Promise<{ ok: boolean; reason?: string }> {
    const h = this.hashes.get(m.path);
    const expect = h && h.was === m.hash ? h.now : m.hash;
    const r = await this.ctx.run<SetResult>({ verb: "set", path: m.path, fields, expect, ...(skipBrainMd ? { skipBrainMd } : {}) }, label);
    if (!r.ok) return { ok: false, reason: r.reason };
    if (typeof r.json.hash === "string") this.hashes.set(m.path, { was: m.hash, now: r.json.hash });
    const b = r.json.brainMd;
    if (b && typeof b === "object" && (b as { ok?: unknown }).ok === false) {
      const why = (b as { error?: unknown }).error;
      new Notice(`${label}: done, but BRAIN.md was not rebuilt${typeof why === "string" && why ? `: ${why}` : ""}`);
    }
    return { ok: true };
  }

  /** Unpin or Mark complete one row: it stays, busy, while the verb runs, and leaves once it went through (ctx.run says
   *  why when it did not). */
  private async setOne(r: BootstrapRow, section: Section, fields: { pin?: boolean; status?: "complete" }, label: string): Promise<void> {
    const key = `${section}:${r.path}`;
    if (this.bulk || this.busy.has(key)) return;
    this.busy.add(key);
    this.update();
    try {
      if ((await this.set(r.memory, fields, label)).ok) this.gone.set(key, Date.now());
    } finally {
      this.busy.delete(key);
      this.update();
    }
  }

  /**
   * "Mark the N complete…" (D17: suggestions only; spec §6: asks first): each `set` in turn with the hash read when the
   * button was pressed, stopping at the first one refused (a memory changed elsewhere since, a surface off). Each set
   * skips the BRAIN.md rebuild; one runs after the last that went through (ctx.brainMd), so BRAIN.md matches every row
   * completed, a stop included.
   */
  private async completeShipped(sum: ShippedSummary): Promise<void> {
    if (this.bulk || !sum.rows.length) return;
    const items = sum.rows.map((r) => ({ path: r.path, title: r.title, memory: r.memory }));
    const c = completeConfirm(items);
    if (!(await this.ctx.confirm(c.title, c.message, c.label))) return;
    this.bulk = true;
    this.update();
    let res: { done: number; failed: string | null; at: (typeof items)[number] | null } = { done: 0, failed: null, at: null };
    let wentThrough = 0;
    try {
      res = await eachUntilFailure(items, async (x) => {
        const key = `active:${x.path}`;
        this.busy.add(key);
        this.update();
        try {
          const r = await this.set(x.memory, { status: "complete" }, "Mark complete", true);
          if (r.ok) { this.gone.set(key, Date.now()); wentThrough++; }
          return r;
        } finally { this.busy.delete(key); }
      });
    } finally {
      // BRAIN.md once, for every row that went through (a stop included), before the page lets go of the rows.
      let built: { ok: boolean; error?: string } = { ok: true };
      if (wentThrough > 0) {
        try { built = await this.ctx.brainMd(); } catch (e) { built = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      }
      this.bulk = false;
      this.update();
      if (!built.ok) new Notice(`Mark complete: done, but BRAIN.md was not rebuilt${built.error ? `: ${built.error}` : ""}: run aos build-brain-md`);
    }
    if (!res.failed) new Notice(`Marked ${pl(res.done, "project")} complete.`);
    else new Notice(`Marked ${res.done} of ${pl(items.length, "project")} complete; stopped at “${res.at?.title ?? ""}”.`);
  }

  // ── the side pane: the recall preview, SESSION.md, MEMORY.md ──

  /** Built once per mount: the field keeps its text, caret and focus across every redraw. */
  private buildRecall(side: HTMLElement): void {
    const card = this.recallCard = side.createEl("section", { cls: "aos-brain-bs-card aos-brain-bs-recall", attr: { "data-bs": "recall", "data-anchor": "recall", "aria-label": "Recall preview" } });
    card.createEl("h3", { cls: "aos-brain-label", text: "RECALL PREVIEW" });
    card.createSpan({ cls: "aos-brain-bs-hint", text: "What recall would hand an agent for this prompt, on either host." });
    const ask = card.createDiv({ cls: "aos-brain-bs-ask" });
    const field = ask.createEl("label", { cls: "aos-brain-bs-field" });
    const input = this.input = field.createEl("input", {
      cls: "aos-brain-bs-input",
      attr: { type: "text", "aria-label": "Prompt to preview", placeholder: "Type a prompt…", spellcheck: "false", autocomplete: "off", "data-bs-key": "recall:input" },
    });
    input.value = this.text;
    field.createEl("kbd", { cls: "aos-brain-kbd aos-brain-mono", text: "⏎", attr: { "aria-hidden": "true" } });
    const go = ask.createEl("button", { cls: "aos-brain-btn is-small aos-brain-bs-go", attr: { type: "button", "data-act": "recall", "data-bs-key": "recall:go", "aria-label": "Preview recall" } });
    const ic = go.createSpan({ cls: "aos-brain-ic", attr: { "aria-hidden": "true" } });
    setIcon(ic, "search");
    go.createSpan({ text: "Preview" });
    input.addEventListener("input", () => { this.text = input.value; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void this.runRecall(); }
      else if (e.key === "Escape" && input.value) {
        e.preventDefault();
        input.value = this.text = "";
        this.seq++;
        this.recall = { kind: "idle", hint: null };
        this.drawRecall(this.ctx.data());
      }
    });
    go.addEventListener("click", () => void this.runRecall());
    this.out = card.createDiv({ cls: "aos-brain-bs-hits", attr: { "aria-live": "polite" } });
    // Copy that holds (D18): recall-wake.md comes from SESSION.md's own words at session end (recall.js writeWakeRecall),
    // never from what is typed here.
    card.createSpan({
      cls: "aos-brain-bs-foot",
      text: "recall-wake.md is not built from this box: at session end the scan recalls on SESSION.md's own words and keeps the top 3 for the next first prompt. A stale hit is a memory to mark complete or archive.",
    });
  }

  private async runRecall(): Promise<void> {
    const text = this.input?.value ?? this.text;
    this.text = text;
    if (!recallQuery(text)) {
      this.seq++;
      this.recall = { kind: "idle", hint: "Type a prompt first." };
      if (this.root) this.drawRecall(this.ctx.data());
      this.input?.focus();
      return;
    }
    const seq = ++this.seq;
    this.recall = { kind: "loading", query: recallQuery(text) };
    if (this.root) this.drawRecall(this.ctx.data());
    let r: RecallPreview;
    try { r = await this.ctx.recall(text); } catch (e) { r = { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
    if (seq !== this.seq) return;
    this.recall = r.ok ? { kind: "done", query: r.query, hits: r.hits } : { kind: "error", reason: r.reason };
    if (this.root) this.drawRecall(this.ctx.data());
  }

  /** The preview's answer: loading, why it did not run, nothing recalled, or the hits (a memory opens in Library). */
  private drawRecall(d: BrainData): void {
    const O = this.out;
    if (!O) return;
    const doc = O.ownerDocument;
    const focused = doc.activeElement instanceof HTMLElement && O.contains(doc.activeElement) ? doc.activeElement.getAttribute("data-bs-key") : null;
    O.empty();
    const st = this.recall;
    O.setAttr("aria-busy", String(st.kind === "loading"));
    O.setAttr("data-state", st.kind === "done" ? (st.hits.length ? "results" : "empty") : st.kind);
    if (st.kind === "idle") { O.createDiv({ cls: "aos-brain-bs-state", text: st.hint ?? "Type a prompt, then ⏎ or Preview." }); return; }
    if (st.kind === "loading") { O.createDiv({ cls: "aos-brain-bs-state", text: `Recalling “${clip(st.query, 60)}”…` }); return; }
    if (st.kind === "error") { O.createDiv({ cls: "aos-brain-bs-state is-warn", text: `Recall did not run: ${st.reason}` }); return; }
    if (!st.hits.length) { O.createDiv({ cls: "aos-brain-bs-state", text: `Nothing recalled for “${clip(st.query, 60)}”.` }); return; }
    const list = O.createEl("ol", { cls: "aos-brain-bs-hitlist", attr: { "aria-label": `Recall for “${clip(st.query, 60)}”` } });
    for (const r of recallRows(st.hits, d.byPath, d.patterns)) {
      const li = list.createEl("li");
      const what = r.open === "memory" ? "open in Library" : r.open === "file" ? "open in the editor" : "not in the store any more";
      const label = `${r.title}, ${r.kind}, score ${r.score}${r.age ? `, ${r.age} old` : ""}${r.stale ? ", stale" : ""}: ${what}`;
      const el = r.open === "none"
        ? li.createDiv({ cls: "aos-brain-bs-hit is-inert", attr: { "aria-label": label } })
        : li.createEl("button", { cls: "aos-brain-bs-hit", attr: { type: "button", "aria-label": label, "data-bs-key": `hit:${r.path}` } });
      el.setAttr("data-path", r.path);
      el.setAttr("title", r.snippet || r.path);
      el.createSpan({ cls: "aos-brain-mono aos-brain-bs-score", text: r.score });
      el.createSpan({ cls: "aos-brain-bs-htitle", text: r.title });
      el.createSpan({ cls: "aos-brain-bs-hkind", text: r.kind });
      if (r.age) el.createSpan({ cls: "aos-brain-mono aos-brain-bs-age", text: r.age });
      if (r.stale) el.createSpan({ cls: "aos-brain-pill is-warn", text: "stale", attr: { title: "Not updated in over 60 days" } });
      if (r.open === "memory") el.addEventListener("click", () => this.ctx.show({ mode: "library", memory: r.path }));
      else if (r.open === "file") el.addEventListener("click", () => void this.ctx.edit(r.path));
    }
    if (focused) findBy(O, "data-bs-key", focused)?.focus({ preventScroll: true });
  }

  private drawCards(d: BrainData): void {
    const C = this.cards!;
    C.empty();
    this.sessionCardEl(C, d);
    this.indexCardEl(C, d);
  }

  private cardHead(sec: HTMLElement, label: string): HTMLElement {
    const h = sec.createDiv({ cls: "aos-brain-bs-chead" });
    h.createEl("h3", { cls: "aos-brain-label", text: label });
    h.createSpan({ cls: "aos-brain-sp" });
    return h;
  }

  private sessionCardEl(C: HTMLElement, d: BrainData): void {
    const sec = C.createEl("section", { cls: "aos-brain-bs-card", attr: { "data-bs": "session", "aria-label": "SESSION.md, working memory" } });
    const h = this.cardHead(sec, "SESSION.MD · WORKING MEMORY");
    const c = sessionCard(d.session);
    if (!c) { sec.createDiv({ cls: "aos-brain-bs-state", text: "No SESSION.md yet: the session hooks write it." }); return; }
    const open = h.createEl("button", { cls: "aos-brain-bs-link", text: "Open", attr: { type: "button", "data-act": "open-session", "data-bs-key": "session:open", "aria-label": "Open SESSION.md" } });
    open.addEventListener("click", () => void this.ctx.edit(SESSION_MD_PATH));
    if (!c.lines.length) {
      sec.createDiv({ cls: "aos-brain-bs-state", text: "Nothing to remember yet. Lines added with remember land here; tagged #promote, the next wrap keeps them." });
    } else {
      const ul = sec.createEl("ul", { cls: "aos-brain-bs-lines" });
      for (const l of c.lines) {
        const li = ul.createEl("li", { cls: "aos-brain-bs-line", attr: { "data-promote": String(l.promote) } });
        li.createSpan({ cls: "aos-brain-bs-ltext", text: l.text });
        if (l.promote) li.createSpan({ cls: "aos-brain-mono aos-brain-pill is-info aos-brain-bs-ptag", text: "#promote", attr: { title: "The next wrap files it as a memory" } });
      }
    }
    const note = wrapNote(c, d.settings.wrapHint);
    if (note) sec.createDiv({ cls: `aos-brain-bs-wrap${note.warn ? " is-warn" : ""}`, text: note.text, attr: { "data-wrapped": String(!c.notWrapped) } });
  }

  private indexCardEl(C: HTMLElement, d: BrainData): void {
    const sec = C.createEl("section", { cls: "aos-brain-bs-card", attr: { "data-bs": "index", "aria-label": "MEMORY.md, the index" } });
    this.cardHead(sec, "MEMORY.MD · THE INDEX");
    const ic = indexCard(d.indexRaw, d.hub);
    if (!ic) { sec.createDiv({ cls: "aos-brain-bs-state", text: "No MEMORY.md yet." }); return; }
    sec.createDiv({ cls: "aos-brain-bs-size", text: ic.size });
    const note = sec.createDiv({ cls: "aos-brain-bs-note" });
    note.createSpan({ text: "Agents read it through tools, never at start-up." });
    for (const f of ic.findings) { note.appendText(" "); note.createSpan({ cls: "aos-brain-bs-finding", text: f }); }
    if (!ic.fixable) return;
    const fix = sec.createEl("button", { cls: "aos-brain-bs-link", text: "Fix in Health →", attr: { type: "button", "data-act": "fix-in-health", "data-bs-key": "index:fix" } });
    fix.addEventListener("click", () => this.ctx.show({ mode: "health", anchor: "hygiene" }));
  }
}

function findBy(root: HTMLElement, attr: string, value: string): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${attr}]`))) if (el.getAttribute(attr) === value) return el;
  return null;
}
