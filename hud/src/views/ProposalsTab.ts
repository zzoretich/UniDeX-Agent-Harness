import { Component, MarkdownRenderer, Notice, TFile } from "obsidian";
import type { DataAdapter, TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import {
  PROPOSALS_DIR, LEDGER_PATH, BACKLOG_PATH, PAGES_DIR, pageFor, pageForSlug,
  Proposal, LedgerRecord, LedgerRates, BacklogEntry,
  isProposalFile, parseProposal, parseLedger, ledgerRates, historyRows, parseBacklog, ageDays,
} from "../data/proposals";
import { readAgenticosJson, reviewCommand } from "../data/aosConfig";
import { shell } from "../host";

const WATCHED = [LEDGER_PATH, BACKLOG_PATH];
const KIND_PILL: Record<string, string> = { self: "aos-pill-cyan", vault: "aos-pill-cyan", workflow: "aos-pill-green", product: "aos-pill-green" };
const EVENT_MARK: Record<string, [string, string]> = {
  approved: ["✓", "aos-text-green"], "auto-applied": ["✓", "aos-text-green"], verified: ["✓", "aos-text-green"],
  accepted: ["◇", "aos-text-cyan"], rejected: ["✗", "aos-text-rose"], regressed: ["✗", "aos-text-rose"],
  dismissed: ["–", "aos-dim"], "stale-dropped": ["–", "aos-dim"],
};
type Group = "pending" | "backlog" | "history";

async function readOr<T extends string | null>(a: DataAdapter, p: string, fallback: T): Promise<string | T> {
  try { return await a.read(p); } catch { return fallback; }
}
const pct = (r: number | null) => (r === null ? "n/a" : `${Math.round(r * 100)}%`);

/**
 * PROPOSALS — the Chief of Staff's pending proposals, accepted backlog and ledger history (spec
 * 2026-09-22-todo-and-proposals-tabs D5/D6). Read-only: every decision goes through the
 * persona-flag-closer skill, reached with the Review button (Claude Code or Codex). Parsing lives in src/data/proposals.ts.
 */
export class ProposalsTab {
  private host: HTMLElement | null = null;
  private personaPresent = true;
  private proposals: Proposal[] = [];
  private ledger: LedgerRecord[] = [];
  private rates: LedgerRates | null = null;
  private backlog: BacklogEntry[] = [];
  private pages: string[] = [];               // file names in PAGES_DIR (spec 2026-09-22-proposal-pages D7)
  /** The proposal or backlog idea open in the reading pane (UniDeX D4): `p:<file>` or `b:<slug>`, or none. */
  private selected: string | null = null;
  private collapsed = new Set<Group>();
  private md: Component | null = null;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const hit = (p: string) => p === "persona" || p === PROPOSALS_DIR || p.startsWith(`${PROPOSALS_DIR}/`) || p.startsWith(`${PAGES_DIR}/`) || WATCHED.includes(p);
      const watch = (f: TAbstractFile, oldPath?: string) => { if (hit(f.path) || (oldPath !== undefined && hit(oldPath))) this.schedule(); };
      const vault = this.plugin.app.vault;
      this.view.registerEvent(vault.on("modify", (f) => watch(f)));
      this.view.registerEvent(vault.on("create", (f) => watch(f)));
      this.view.registerEvent(vault.on("delete", (f) => watch(f)));
      this.view.registerEvent(vault.on("rename", (f, oldPath) => watch(f, oldPath)));
    }
    void this.refresh();
  }

  unmount(): void {
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
    this.md?.unload();
    this.md = null;
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    const a = this.plugin.app.vault.adapter;
    this.personaPresent = await a.exists("persona");
    let names: string[] = [];
    try { names = (await a.list(PROPOSALS_DIR)).files.map((f) => f.split("/").pop() ?? "").filter(isProposalFile).sort(); } catch { /* no folder yet */ }
    const proposals: Proposal[] = [];
    for (const n of names) {
      try { proposals.push(parseProposal(n, await a.read(`${PROPOSALS_DIR}/${n}`))); } catch { /* removed between list and read */ }
    }
    this.proposals = proposals;
    this.ledger = parseLedger(await readOr(a, LEDGER_PATH, ""));
    this.rates = ledgerRates(this.ledger, new Date());
    this.backlog = parseBacklog(await readOr(a, BACKLOG_PATH, "")).reverse();   // the file is newest last
    try { this.pages = (await a.list(PAGES_DIR)).files.map((f) => f.split("/").pop() ?? "").filter((n) => n.endsWith(".html")); } catch { this.pages = []; }
    this.view.setBadge("proposals", this.proposals.length);
    this.render();
  }

  // ── render ──

  private render(): void {
    if (!this.view.isTabActive("proposals")) return;
    const host = this.host;
    if (!host) return;
    host.empty();
    this.md?.unload();
    this.md = new Component();
    this.md.load();

    const head = host.createDiv({ cls: "aos-rt-head" });
    head.createSpan({ cls: "aos-rt-title", text: "Proposals" });
    head.createSpan({ cls: "aos-dim aos-rt-count", text: `${this.proposals.length} pending · ${this.backlog.length} in backlog` });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    // The persona-flag-closer skill in the user's first host (Claude Code, else Codex): data/aosConfig.ts reviewCommand.
    const rc = reviewCommand(readAgenticosJson());
    const review = actions.createEl("button", { cls: "aos-ws-action", text: rc.label, attr: { "data-tour": "proposals-review" } });
    review.setAttr("title", `Opens a terminal in Code, in the vault, running: ${rc.command}`);
    review.addEventListener("click", () => this.view.runInTerm(rc.command, { host: rc.host, origin: "Proposals" }));

    if (!this.personaPresent) {
      host.createDiv({ cls: "aos-rt-note aos-dim", text: "The Chief of Staff isn't set up — run `aos persona` to create it." });
      return;
    }
    if (this.rates) {
      host.createDiv({
        cls: "aos-dim aos-pr-rates",
        text: `last ${this.rates.days} d · approval ${pct(this.rates.approvalRate)} · accept ${pct(this.rates.acceptRate)}`,
        attr: { title: "approved ÷ (approved + rejected) and accepted ÷ (accepted + dismissed), as `ledger.js summary` counts them" },
      });
    }

    // The groups on the left, the selected proposal or idea in the reading pane on the right (UniDeX D4).
    const split = host.createDiv({ cls: "aos-split" });
    const list = split.createDiv({ cls: "aos-split-list" });
    const pending = this.group(list, "pending", `PENDING (${this.proposals.length})`);
    if (pending) {
      if (!this.proposals.length) pending.createDiv({ cls: "aos-inv-row aos-dim", text: "Nothing pending — the Chief of Staff files proposals from its reflect duties." });
      for (const p of this.proposals) this.renderProposal(pending, p);
    }
    const backlog = this.group(list, "backlog", `BACKLOG (${this.backlog.length})`);
    if (backlog) {
      if (!this.backlog.length) backlog.createDiv({ cls: "aos-inv-row aos-dim", text: "No accepted ideas yet — accepting a workflow or product proposal adds it here." });
      for (const b of this.backlog) this.renderBacklog(backlog, b);
    }
    const rows = historyRows(this.ledger);
    const history = this.group(list, "history", "HISTORY");
    if (history) {
      if (!rows.length) history.createDiv({ cls: "aos-inv-row aos-dim", text: "No decisions recorded yet." });
      for (const r of rows) this.renderHistory(history, r);
    }
    const reader = split.createDiv({ cls: "aos-split-detail aos-pr-reader" });
    const sel = this.selected;
    const openP = sel?.startsWith("p:") ? this.proposals.find((x) => `p:${x.name}` === sel) : undefined;
    const openB = sel?.startsWith("b:") ? this.backlog.find((x) => `b:${x.slug}` === sel) : undefined;
    if (openP) this.renderProposalDetail(reader, openP);
    else if (openB) this.renderBacklogDetail(reader, openB);
    else reader.createDiv({ cls: "aos-reader-empty", text: "Select a proposal or a backlog idea to read it." });
  }

  /** A collapsible group; returns its table, or null while collapsed. */
  private group(host: HTMLElement, id: Group, label: string): HTMLElement | null {
    const open = !this.collapsed.has(id);
    const sub = host.createDiv({ cls: "aos-rt-subhead aos-dim aos-pr-grouphead", attr: { "data-tour": `proposals-${id}` } });
    sub.createSpan({ text: `${open ? "▾" : "▸"} ${label}` });
    sub.addEventListener("click", () => { if (open) this.collapsed.add(id); else this.collapsed.delete(id); this.render(); });
    return open ? host.createDiv({ cls: "aos-inv-table aos-rt-table" }) : null;
  }

  private renderProposal(table: HTMLElement, p: Proposal): void {
    const key = `p:${p.name}`;
    const open = this.selected === key;
    const row = table.createDiv({ cls: `aos-inv-row aos-inv-row-clickable aos-pr-row${open ? " is-selected" : ""}` });
    row.createSpan({ cls: "aos-pr-caret aos-dim", text: open ? "▾" : "▸" });
    const name = row.createDiv({ cls: "aos-rt-name" });
    name.createDiv({ text: p.slug });
    name.createDiv({ cls: "aos-dim aos-rt-slug", text: p.target });
    const meta = row.createDiv({ cls: "aos-pr-rowmeta" });
    meta.createSpan({ cls: `aos-pill ${KIND_PILL[p.kind] ?? "aos-pill-dim"}`, text: p.kind });
    if (p.surface) meta.createSpan({ cls: "aos-pill aos-pill-dim", text: p.surface });
    const age = ageDays(p.filed, new Date());
    meta.createSpan({ cls: "aos-dim aos-pr-age", text: age === null ? p.filed : `${age}d`, attr: { title: `filed ${p.filed}` } });
    if (p.lint.length) meta.createSpan({ cls: "aos-text-amber aos-pr-lint", text: `⚠ ${p.lint.length}`, attr: { title: p.lint.join("\n") } });
    row.addEventListener("click", () => { this.toggle(key); });
  }

  /** The reading pane for a pending proposal: its page, what it needs, What / Why / Risk and the premises. */
  private renderProposalDetail(reader: HTMLElement, p: Proposal): void {
    const head = reader.createDiv({ cls: "aos-reader-head" });
    head.createDiv({ cls: "aos-reader-title", text: p.slug });
    head.createDiv({ cls: "aos-reader-meta", text: p.target });
    const d = reader.createDiv({ cls: "aos-pr-detail" });
    const page = pageFor(p.name);
    if (this.pages.includes(page.slice(PAGES_DIR.length + 1))) this.pageLink(d.createDiv({ cls: "aos-pr-open" }), page, "Open the proposal in browser");
    else d.createDiv({ cls: "aos-pr-open aos-dim", text: "The proposal's HTML page appears after the next scan." });
    const meta = d.createDiv({ cls: "aos-pr-meta" });
    meta.createDiv({ text: `needs: ${p.decision}` });
    if (p.recheck) meta.createDiv({ cls: "aos-dim" }).createEl("code", { text: p.recheck });
    for (const l of p.lint) meta.createDiv({ cls: "aos-text-amber", text: `⚠ ${l}` });
    const body = [["What", p.what], ["Why", p.why], ["Risk", p.risk]].filter(([, v]) => v).map(([h, v]) => `#### ${h}\n\n${v}`).join("\n\n");
    if (body && this.md) void MarkdownRenderer.renderMarkdown(body, d.createDiv({ cls: "aos-pr-md" }), `${PROPOSALS_DIR}/${p.name}`, this.md);
    if (p.premises.length) {
      const pt = d.createDiv({ cls: "aos-pr-premises" });
      pt.createDiv({ cls: "aos-dim aos-rt-subhead", text: `PREMISES · ${p.premises.filter((x) => x.status === "VERIFIED").length} verified / ${p.premises.filter((x) => x.status === "ASSUMED").length} assumed` });
      for (const x of p.premises) {
        const r = pt.createDiv({ cls: "aos-pr-premise" });
        r.createSpan({ cls: `aos-pill ${x.status === "VERIFIED" ? "aos-pill-green" : "aos-pill-amber"}`, text: x.status });
        r.createSpan({ text: x.claim });
        r.createSpan({ cls: "aos-dim", text: x.evidence });
      }
    }
    const links = d.createDiv({ cls: "aos-rt-rowactions" });
    const openFile = links.createEl("a", { text: "Open file", cls: "aos-link", href: "#" });
    openFile.addEventListener("click", (e) => { e.preventDefault(); void this.openFile(`${PROPOSALS_DIR}/${p.name}`); });
  }

  private renderBacklog(table: HTMLElement, b: BacklogEntry): void {
    const key = `b:${b.slug}`;
    const open = this.selected === key;
    const row = table.createDiv({ cls: `aos-inv-row aos-inv-row-clickable aos-pr-row${open ? " is-selected" : ""}` });
    row.createSpan({ cls: "aos-pr-caret aos-dim", text: open ? "▾" : "▸" });
    const name = row.createDiv({ cls: "aos-rt-name" });
    name.createDiv({ text: b.slug });
    if (b.target) name.createDiv({ cls: "aos-dim aos-rt-slug", text: b.target });
    const meta = row.createDiv({ cls: "aos-pr-rowmeta" });
    meta.createSpan({ cls: `aos-pill ${KIND_PILL[b.kind] ?? "aos-pill-dim"}`, text: b.kind });
    if (b.surface) meta.createSpan({ cls: "aos-pill aos-pill-dim", text: b.surface });
    meta.createSpan({ cls: "aos-dim aos-pr-age", text: b.accepted ? `accepted ${b.accepted}` : `filed ${b.filed}` });
    row.addEventListener("click", () => { this.toggle(key); });
  }

  /** The reading pane for a backlog idea: its notes, its page and the backlog file. */
  private renderBacklogDetail(reader: HTMLElement, b: BacklogEntry): void {
    const head = reader.createDiv({ cls: "aos-reader-head" });
    head.createDiv({ cls: "aos-reader-title", text: b.slug });
    if (b.target) head.createDiv({ cls: "aos-reader-meta", text: b.target });
    const d = reader.createDiv({ cls: "aos-pr-detail" });
    if (b.body && this.md) void MarkdownRenderer.renderMarkdown(b.body, d.createDiv({ cls: "aos-pr-md" }), BACKLOG_PATH, this.md);
    const links = d.createDiv({ cls: "aos-rt-rowactions" });
    const page = pageForSlug(this.pages, b.slug);
    if (page) { this.pageLink(links, page, "Open the proposal in browser"); links.createSpan({ cls: "aos-dim", text: " · " }); }
    const openFile = links.createEl("a", { text: "Open backlog", cls: "aos-link", href: "#" });
    openFile.addEventListener("click", (e) => { e.preventDefault(); void this.openFile(BACKLOG_PATH); });
  }

  private renderHistory(table: HTMLElement, r: LedgerRecord): void {
    const row = table.createDiv({ cls: "aos-inv-row aos-pr-row aos-pr-history" });
    const [mark, cls] = EVENT_MARK[r.event] ?? ["·", "aos-dim"];
    row.createSpan({ cls: `aos-pr-mark ${cls}`, text: mark });
    row.createSpan({ cls: "aos-rt-name", text: r.slug, attr: { title: r.slug } });
    const meta = row.createDiv({ cls: "aos-pr-rowmeta" });
    meta.createSpan({ cls: `aos-pr-event ${cls}`, text: r.event });
    meta.createSpan({ cls: `aos-pill ${KIND_PILL[r.kind] ?? "aos-pill-dim"}`, text: r.kind });
    meta.createSpan({ cls: "aos-dim aos-pr-age", text: `${r.ts.slice(0, 10)}${r.by ? ` · ${r.by}` : ""}` });
    const page = pageForSlug(this.pages, r.slug);
    if (page) this.pageLink(meta, page, "page ↗").addClass("aos-pr-pagelink");
    if (r.note) row.setAttr("title", r.note);
  }

  private toggle(key: string): void {
    this.selected = this.selected === key ? null : key;
    this.render();
  }

  /** A link that opens a rendered proposal page in the OS default browser. */
  private pageLink(parent: HTMLElement, page: string, text: string): HTMLAnchorElement {
    const a = parent.createEl("a", { text, cls: "aos-link", href: "#", attr: { title: page } });
    a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.openPage(page); });
    return a;
  }

  // The page lives in the gitignored brain/_index cache, not as a note: open it through the OS, as SpacesTab does.
  private openPage(page: string): void {
    const abs = `${this.plugin.vaultRoot()}/${page}`;
    try {
      void shell.openPath(abs).then((err: string) => { if (err) new Notice(`Cannot open ${page}: ${err}`); });
    } catch {
      new Notice(`Cannot open: ${page}`);
    }
  }

  private async openFile(p: string): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) { await this.plugin.app.workspace.getLeaf("tab").openFile(f); return; }
    new Notice(`Cannot open: ${p}`);
  }
}
