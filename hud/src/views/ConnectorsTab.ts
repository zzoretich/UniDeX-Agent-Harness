import { Notice } from "obsidian";
import type { TAbstractFile } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { readAgenticosJson, sessionHosts, VAULT_CONFIG_DEFAULTS } from "../data/aosConfig";
import {
  CONNECTOR_FILES, CONNECTORS_LIVE_PATH, CONNECTORS_PATH, CONNECTORS_USAGE_PATH, CONN_HOST_LABEL, attentionFix, buildBoard, checkDue, copyOffers,
  metaLine, parseCaches, type ConnBoard, type ConnCard, type ConnHost, type ConnTile,
} from "../data/connectorsModel";
import { MCP_NAME_RE, copyArgs, planConfirm, planFor } from "../data/mcpServers";
import { failureText } from "../data/aosRun";
import { ConfirmModal } from "../ui/ConfirmModal";
import { fs, shell } from "../host";
import { drawBody, drawHead, type BoardCtx, type FoldGroup } from "./connectors/board";
import { drawSheet } from "./connectors/sheet";

/** How often the tab asks whether a check is due while it is shown (the cadence itself is connectors.checkEveryMin). */
const TICK_MS = 60_000;
/** `aos mcp check` starts every server the hosts would start, 10 s each, four at a time: give it room. */
const CHECK_TIMEOUT_MS = 180_000;
const CLAUDE_AI_CONNECTORS = "https://claude.ai/settings/connectors";

/**
 * CONNECTORS — every MCP server and connector both hosts can use (spec 2026-10-23-connectors-tab D3–D5, D9, D10, D12,
 * D20), from the runtime's three caches (data/connectorsModel.ts): the health board and a card's detail sheet. The tab
 * reads files only; what it starts is the runtime: `aos mcp check --json` when the tab is shown and the last check is
 * older than connectors.checkEveryMin, again every so often while it stays in front, and on Check now (one at a time);
 * `aos mcp copy` behind "Copy to <host>" in a server's sheet (the copy Skills offered, install-import B6: a dry run, its
 * exact command in a confirm, then the run naming the dry run's hash), and `aos mcp list --json` after a copy so the
 * board shows it at once. The fixes are a link (claude.ai's connectors page), a Code terminal (`codex mcp login`) or a
 * check. The badge is WorkbenchView's (D5).
 */
export class ConnectorsTab {
  private host: HTMLElement | null = null;
  private board: ConnBoard = buildBoard(parseCaches(null, null, null), []);
  private hosts: ConnHost[] = ["claude"];
  private everyMin = VAULT_CONFIG_DEFAULTS.connectors.checkEveryMin;
  private query = "";
  private tile: ConnTile | null = null;
  private folds = new Set<FoldGroup>();
  /** The card whose sheet is open, by key. */
  private openKey: string | null = null;
  private checking = false;
  /** Why the last automatic check failed (shown in the header), until one succeeds. */
  private checkFailed: string | null = null;
  /** When a check last started: an automatic one that failed is not retried before the cadence comes round again. */
  private lastTry = 0;
  /** The target hosts a copy is running for: one at a time per host, as the runtime's lock has it. */
  private copyBusy = new Set<ConnHost>();
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;
  private tick: number | null = null;
  private keyListening = false;
  /** The board as last drawn, for a redraw of its body alone (the filter) or of the header's age (the clock). */
  private ctx: BoardCtx | null = null;
  private bodyEl: HTMLElement | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const watch = (f: TAbstractFile) => { if (CONNECTOR_FILES.includes(f.path)) this.schedule(); };
      const vault = this.plugin.app.vault;
      this.view.registerEvent(vault.on("modify", watch));
      this.view.registerEvent(vault.on("create", watch));
      this.view.registerEvent(vault.on("delete", watch));
    }
    // The cadence (D10): only while this tab is in front; the timer itself lives until the view closes.
    if (this.tick === null) this.tick = window.setInterval(() => { if (this.view.isTabActive("connectors")) { this.renderMeta(); this.maybeCheck(); } }, TICK_MS);
    if (!this.keyListening) { this.keyListening = true; window.addEventListener("keydown", this.onKey); }
    void this.refresh();
  }

  unmount(): void {
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
    if (this.tick !== null) { window.clearInterval(this.tick); this.tick = null; }
    if (this.keyListening) { this.keyListening = false; window.removeEventListener("keydown", this.onKey); }
  }

  /** Esc closes the sheet from the tab or from nowhere in particular (the focus back on the page after a confirm), never
   *  from another surface's own field, menu or dialog, which keeps its Esc. */
  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || e.defaultPrevented || this.openKey === null || !this.view.isTabActive("connectors")) return;
    const doc = this.host?.ownerDocument;
    const t = e.target instanceof Node ? e.target : null;
    if (!doc || (t && t !== doc.body && t !== doc.documentElement && !this.host?.contains(t))) return;
    if (doc.querySelector(".modal-container")) return;
    e.preventDefault();
    this.closeSheet();
  };

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => { this.refreshDebounce = null; void this.refresh(); }, 250);
  }

  async refresh(): Promise<void> {
    this.load();
    this.render();
    this.maybeCheck();
  }

  private read(rel: string): string | null {
    try {
      const file = path.join(this.plugin.vaultRoot(), rel);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    } catch { return null; }
  }

  private load(): void {
    this.hosts = sessionHosts(readAgenticosJson(this.plugin.claudeConfigDir()));
    try { this.everyMin = Number(this.plugin.systemConfig().connectors.checkEveryMin) || VAULT_CONFIG_DEFAULTS.connectors.checkEveryMin; } catch { /* the default */ }
    this.board = buildBoard(parseCaches(this.read(CONNECTORS_PATH), this.read(CONNECTORS_LIVE_PATH), this.read(CONNECTORS_USAGE_PATH)), this.hosts);
  }

  // ── the check (D10) ──

  /** A check when one is due: never on a runtime without Connectors, with no host on, or while one runs. */
  private maybeCheck(): void {
    if (!this.view.isTabActive("connectors") || this.checking || !this.board.listed || !this.hosts.length) return;
    const now = Date.now();
    const every = Math.max(1, this.everyMin) * 60_000;
    if (!checkDue(this.board, now, this.everyMin) || now - this.lastTry < every) return;
    void this.check(false);
  }

  /** `aos mcp check --json`, one at a time. Check now says why it failed in a notice; an automatic check in the header. */
  private async check(forced: boolean): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.lastTry = Date.now();
    this.render();
    let failed: string | null = null;
    try {
      const r = await this.plugin.aosJson<{ ok?: unknown }>(["mcp", "check", "--json"], CHECK_TIMEOUT_MS);
      if (r.code !== 0) failed = failureText(r);
      else if (!r.json || r.json.ok !== true) failed = "aos mcp check answered in an unexpected shape";
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    } finally {
      this.checking = false;
      this.checkFailed = failed;
      if (failed && forced) new Notice(`Connectors: the check failed: ${failed}`, 10000);
      this.load();
      this.render();
    }
  }

  // ── actions ──

  /** A card's one fix (attentionFix): claude.ai's connectors page, `codex mcp login` in a Code terminal, or a check. */
  private fix(k: ConnCard): void {
    const f = attentionFix(k);
    if (!f) return;
    if (f.fix === "claude.ai") { void shell.openExternal(CLAUDE_AI_CONNECTORS); return; }
    if (f.fix === "login") {
      if (!MCP_NAME_RE.test(f.side.name)) { new Notice(`Sign in to ${f.side.name} from a Codex session: its name is not one codex mcp login takes`); return; }
      this.view.runInTerm(`codex mcp login ${f.side.name}`, { host: "codex", origin: "Connectors" });
      return;
    }
    void this.check(true);
  }

  /**
   * Copy to <host> (install-import B6, D20): the dry run first, whose exact command and file the confirm shows; only
   * Confirm runs the copy, which backs the target's file up and goes through that host's own CLI, then lists both hosts
   * again so the card shows it on both. Without the `mcp` surface the run is refused and the notice names the same
   * command for a Code terminal.
   */
  private async copyTo(name: string, to: ConnHost): Promise<void> {
    if (this.copyBusy.has(to)) return;
    const label = CONN_HOST_LABEL[to];
    const by = `aos mcp copy ${name} --to ${to}`;
    this.copyBusy.add(to);
    this.render();
    let copied = false;
    try {
      const dry = await this.plugin.aosJson<unknown>(copyArgs(name, to, true));
      // Only the dry run of this server to this host is offered for confirm.
      const plan = dry.code === 0 ? planFor(dry.json, name, to, true) : null;
      if (!plan) { new Notice(`Make available on ${label}: ${dry.code === 0 ? "aos mcp copy answered in an unexpected shape" : failureText(dry)} — or run ${by} in the Code tab`, 12000); return; }
      const c = planConfirm(plan);
      if (!(await ConfirmModal.ask(this.plugin.app, c.title, c.message, c.confirm, c.detail))) return;
      // The dry run's hash: the copy runs only what the confirm showed, and is refused when the config changed since.
      const r = await this.plugin.aosJson<unknown>(copyArgs(name, to, false, plan.expect), 90_000);
      const done = r.code === 0 ? planFor(r.json, name, to, false) : null;
      if (done) { copied = true; new Notice(`${name} is on ${label} now${done.backup ? ` (backup: ${done.backup})` : ""}.`, 8000); }
      else new Notice(`Make available on ${label}: ${r.code === 0 ? "aos mcp copy answered in an unexpected shape" : failureText(r)}`, 12000);
    } finally {
      // The copy rewrote mcp-servers.json only; the board reads connectors.json, which `aos mcp list` writes.
      if (copied) await this.plugin.aosJson<unknown>(["mcp", "list", "--json"], 120_000).catch(() => null);
      this.copyBusy.delete(to);
      this.load();
      this.render();
    }
  }

  private openSheet(k: ConnCard): void {
    this.openKey = k.key;
    this.render("close");
  }

  private closeSheet(): void {
    const key = this.openKey;
    if (key === null) return;
    this.openKey = null;
    this.render(`card:${key}`);
  }

  // ── render ──

  /** Draws the tab again, keeping the focus (by its data-fk key, or `focus` when given), the filter's caret and the scroll. */
  private render(focus: string | null = null): void {
    if (!this.view.isTabActive("connectors")) return;
    const host = this.host;
    if (!host) return;
    const doc = host.ownerDocument;
    const active = doc.activeElement instanceof HTMLElement && host.contains(doc.activeElement) ? doc.activeElement : null;
    const fk = focus ?? active?.dataset.fk ?? null;
    const caret = active instanceof HTMLInputElement ? { start: active.selectionStart, end: active.selectionEnd } : null;
    const scroll = host.querySelector(".aos-con-body")?.scrollTop ?? 0;
    const sheetScroll = host.querySelector(".aos-con-sheetbody")?.scrollTop ?? 0;
    host.empty();

    const root = host.createDiv({ cls: "aos-con" });
    const now = Date.now();
    const ctx: BoardCtx = {
      board: this.board, hosts: this.hosts, now, everyMin: this.everyMin, checking: this.checking, failed: this.checkFailed,
      query: this.query, tile: this.tile, folds: this.folds,
      on: {
        check: () => void this.check(true),
        tile: (t) => { this.tile = this.tile === t ? null : t; this.render(`tile:${t}`); },
        query: (q) => { this.query = q; this.renderBody(); },
        open: (k) => this.openSheet(k),
        fold: (g) => { if (this.folds.has(g)) this.folds.delete(g); else this.folds.add(g); this.render(`fold:${g}`); },
        fix: (k) => this.fix(k),
        upgrade: () => { this.view.runInTerm("aos upgrade", { origin: "Connectors" }); },
      },
    };
    this.ctx = ctx;
    drawHead(root, ctx);
    const body = root.createDiv({ cls: "aos-con-body" });
    this.bodyEl = body;
    drawBody(body, ctx);
    body.scrollTop = scroll;

    const card = this.openKey !== null ? this.board.cards.find((k) => k.key === this.openKey) ?? null : null;
    if (this.openKey !== null && !card) this.openKey = null;
    if (card) {
      drawSheet(root, {
        card, board: this.board, hosts: this.hosts, now, offers: copyOffers(card, this.hosts), busy: this.copyBusy, checking: this.checking,
        on: { close: () => this.closeSheet(), copy: (name, to) => void this.copyTo(name, to), fix: (k) => this.fix(k) },
      });
      const sb = root.querySelector(".aos-con-sheetbody");
      if (sb) sb.scrollTop = sheetScroll;
    }

    if (fk) {
      const el = root.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]`) ?? (card ? root.querySelector<HTMLElement>('[data-fk="close"]') : null);
      if (el) {
        el.focus({ preventScroll: true });
        if (el instanceof HTMLInputElement && caret) el.setSelectionRange(caret.start, caret.end);
      }
    }
  }

  /** The filter changed: the board's body alone, so the field (its caret, an input method's composition) stays as it is. */
  private renderBody(): void {
    const body = this.bodyEl;
    if (!this.ctx || !body || !body.isConnected) { this.render("q"); return; }
    this.ctx = { ...this.ctx, query: this.query, now: Date.now() };
    body.empty();
    drawBody(body, this.ctx);
  }

  /** The clock moved: the header's "checked … ago · next check in …" line alone. */
  private renderMeta(): void {
    const el = this.host?.querySelector<HTMLElement>(".aos-con-meta");
    if (!el || this.checking) return;
    el.setText(metaLine(this.board, Date.now(), this.everyMin, { failed: this.checkFailed }));
  }
}
