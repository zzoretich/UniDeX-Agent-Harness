import { Component, MarkdownRenderer, Notice, TFile } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import {
  NOTIFICATIONS_DIR, STATE_PATH, REACTIONS_PATH, LEVELS, Level, View, NotificationRow, NotificationAction, Notification,
  notificationId, parseNotification, parseState, parseReactions, withState, filterRows, senders, unreadBadge,
  splitSections, actionsFor, askCommand, ago,
} from "../data/notifications";
import { adapterOf, setFlags, appendReaction } from "../data/notificationWriter";
import { readAgenticosJson, sessionHosts, invocationHint } from "../data/aosConfig";

const LEVEL_PILL: Record<Level, string> = { breaking: "aos-pill-rose", alert: "aos-pill-amber", edition: "aos-pill-cyan", info: "aos-pill-dim" };
const HOST_LABEL = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * NOTIFICATIONS — what agents, routines and duties posted with `aos notify` (spec 2026-09-24-notifications-design).
 * Items are read-only files; this tab writes only brain/notifications/state.json (read, archived) and reactions.jsonl.
 * Ask actions open a Term session running the named skill on each enabled host (D6). Parsing lives in
 * src/data/notifications.ts.
 */
export class NotificationsTab {
  private host: HTMLElement | null = null;
  private rows: NotificationRow[] = [];
  private unreadable = 0;
  private votes: Record<string, 1 | -1> = {};
  private view: View = "unread";
  private level: Level | null = null;
  private from: string | null = null;
  /** The notification open in the reading pane (UniDeX D4), or none. */
  private selected: string | null = null;
  private md: Component | null = null;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;

  constructor(private plugin: AgenticOSPlugin, private wb: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const hit = (p: string) => p === NOTIFICATIONS_DIR || p.startsWith(`${NOTIFICATIONS_DIR}/`);
      const watch = (f: TAbstractFile, oldPath?: string) => { if (hit(f.path) || (oldPath !== undefined && hit(oldPath))) this.schedule(); };
      const vault = this.plugin.app.vault;
      this.wb.registerEvent(vault.on("modify", (f) => watch(f)));
      this.wb.registerEvent(vault.on("create", (f) => watch(f)));
      this.wb.registerEvent(vault.on("delete", (f) => watch(f)));
      this.wb.registerEvent(vault.on("rename", (f, oldPath) => watch(f, oldPath)));
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
    const items: Notification[] = [];
    let unreadable = 0;
    let years: string[] = [];
    try { years = (await a.list(NOTIFICATIONS_DIR)).folders.filter((f) => /\/\d{4}$/.test(f)); } catch { /* no folder yet */ }
    for (const y of years) {
      let files: string[] = [];
      try { files = (await a.list(y)).files; } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        try {
          const n = notificationId(f) ? parseNotification(f, await a.read(f)) : null;
          if (n) items.push(n); else unreadable++;
        } catch { /* removed between list and read */ }
      }
    }
    const readOr = async (p: string) => { try { return (await a.exists(p)) ? await a.read(p) : null; } catch { return null; } };
    this.rows = withState(items, parseState(await readOr(STATE_PATH)));
    this.votes = parseReactions(await readOr(REACTIONS_PATH));
    this.unreadable = unreadable;
    const b = unreadBadge(this.rows);
    this.wb.setBadge("notifications", b.count, b.breaking);
    this.render();
  }

  // ── render ──

  private render(): void {
    if (!this.wb.isTabActive("notifications")) return;
    const host = this.host;
    if (!host) return;
    host.empty();
    this.md?.unload();
    this.md = new Component();
    this.md.load();

    const badge = unreadBadge(this.rows);
    const head = host.createDiv({ cls: "aos-rt-head" });
    head.createSpan({ cls: "aos-rt-title", text: "Notifications" });
    head.createSpan({ cls: "aos-dim aos-rt-count", text: `${badge.count} unread · ${this.rows.filter((r) => !r.archived).length} total` });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    if (badge.count) {
      const all = actions.createEl("button", { cls: "aos-ws-action", text: "Mark all read" });
      all.addEventListener("click", () => void this.flag(this.rows.filter((r) => !r.read && !r.archived).map((r) => r.id), "read", true));
    }

    this.renderFilters(host);

    const shown = filterRows(this.rows, { view: this.view, level: this.level, from: this.from });
    // The inbox and its reading pane (UniDeX D4): the list on the left, the selected notification on the right.
    const split = host.createDiv({ cls: "aos-split" });
    const table = split.createDiv({ cls: "aos-inv-table aos-rt-table aos-split-list", attr: { "data-tour": "notifications-list" } });
    if (!this.rows.length) {
      table.createDiv({
        cls: "aos-inv-row aos-dim",
        text: `No notifications yet. Agents post with \`aos notify post\` — see ${invocationHint("notifications", readAgenticosJson())}.`,
      });
    } else if (!shown.length) {
      table.createDiv({ cls: "aos-inv-row aos-dim", text: this.view === "unread" ? "All caught up." : "Nothing matches these filters." });
    }
    for (const r of shown) this.renderRow(table, r);
    if (this.rows.length) {
      const reader = split.createDiv({ cls: "aos-split-detail aos-nt-reader" });
      const open = this.rows.find((r) => r.id === this.selected);
      if (open) this.renderDetail(reader, open);
      else reader.createDiv({ cls: "aos-nt-reader-empty", text: "Select a notification to read it." });
    }
    if (this.unreadable) host.createDiv({ cls: "aos-dim aos-nt-foot", text: `${this.unreadable} unreadable file(s) in ${NOTIFICATIONS_DIR} skipped` });
  }

  private renderFilters(host: HTMLElement): void {
    const bar = host.createDiv({ cls: "aos-nt-filters" });
    for (const v of ["unread", "all", "archived"] as View[]) {
      const b = bar.createEl("button", { cls: `aos-nt-chip${this.view === v ? " is-active" : ""}`, text: v[0].toUpperCase() + v.slice(1), attr: { "data-tour": `notifications-view-${v}` } });
      b.addEventListener("click", () => { this.view = v; this.render(); });
    }
    bar.createSpan({ cls: "aos-nt-sep" });
    for (const l of LEVELS) {
      const b = bar.createEl("button", { cls: `aos-nt-chip aos-nt-lvl-${l}${this.level === l ? " is-active" : ""}`, text: l });
      b.addEventListener("click", () => { this.level = this.level === l ? null : l; this.render(); });
    }
    const list = senders(this.rows);
    if (list.length > 1) {
      const sel = bar.createEl("select", { cls: "dropdown aos-nt-from" });
      sel.createEl("option", { text: "all senders", value: "" });
      for (const s of list) sel.createEl("option", { text: s, value: s });
      sel.value = this.from ?? "";
      sel.addEventListener("change", () => { this.from = sel.value || null; this.render(); });
    }
  }

  private renderRow(table: HTMLElement, r: NotificationRow): void {
    const open = this.selected === r.id;
    const row = table.createDiv({ cls: `aos-inv-row aos-inv-row-clickable aos-nt-row${r.read ? "" : " is-unread"}${open ? " is-selected" : ""}` });
    row.createSpan({ cls: "aos-nt-dot", text: r.read ? "" : "●" });
    row.createSpan({ cls: `aos-pill ${LEVEL_PILL[r.level]}`, text: r.level === "breaking" ? "BREAKING" : r.level });
    const name = row.createDiv({ cls: "aos-rt-name" });
    name.createDiv({ text: r.title });
    name.createDiv({ cls: "aos-dim aos-rt-slug", text: r.from + (r.requestedLevel ? ` · sent as ${r.requestedLevel}, over the hourly limit` : "") });
    row.createSpan({ cls: "aos-dim aos-nt-age", text: ago(r.created, new Date()), attr: { title: r.created } });
    row.addEventListener("click", () => {
      this.selected = open ? null : r.id;
      if (!open && !r.read) void this.flag([r.id], "read", true);   // refresh re-renders
      else this.render();
    });
  }

  /** The reading pane: the notification's title, level and sender, then its sections, actions and links. */
  private renderDetail(reader: HTMLElement, r: NotificationRow): void {
    const head = reader.createDiv({ cls: "aos-nt-reader-head" });
    head.createDiv({ cls: "aos-nt-reader-title", text: r.title });
    const meta = head.createDiv({ cls: "aos-nt-reader-meta" });
    meta.createSpan({ cls: `aos-pill ${LEVEL_PILL[r.level]}`, text: r.level === "breaking" ? "BREAKING" : r.level });
    meta.createSpan({ text: `${r.from} · ${ago(r.created, new Date())}`, attr: { title: r.created } });
    const d = reader.createDiv({ cls: "aos-nt-detail", attr: { "data-id": r.id } });
    const secs = splitSections(r.body);
    const anchors = secs.map((s) => s.anchor);
    for (const s of secs) {
      if (s.heading !== null) d.createEl("h4", { cls: "aos-nt-h", text: s.heading });
      if (s.text && this.md) void MarkdownRenderer.renderMarkdown(s.text, d.createDiv({ cls: "aos-nt-md" }), r.path, this.md);
      if (s.anchor !== null) this.renderActions(d, r, actionsFor(r.actions, s.anchor, anchors));
    }
    this.renderActions(d, r, actionsFor(r.actions, null, anchors));

    const links = d.createDiv({ cls: "aos-rt-rowactions aos-nt-links" });
    const toggleRead = links.createEl("a", { text: r.read ? "Mark unread" : "Mark read", cls: "aos-link", href: "#" });
    toggleRead.addEventListener("click", (e) => { e.preventDefault(); void this.flag([r.id], "read", !r.read); });
    const arch = links.createEl("a", { text: r.archived ? "Unarchive" : "Archive", cls: "aos-link", href: "#" });
    arch.addEventListener("click", (e) => { e.preventDefault(); void this.flag([r.id], "archived", !r.archived); });
    const note = links.createEl("a", { text: "Open note", cls: "aos-link", href: "#", attr: { title: r.path } });
    note.addEventListener("click", (e) => { e.preventDefault(); void this.openFile(r.path); });
  }

  private renderActions(parent: HTMLElement, r: NotificationRow, list: NotificationAction[]): void {
    if (!list.length) return;
    const bar = parent.createDiv({ cls: "aos-nt-actions" });
    const cfg = readAgenticosJson();
    const hosts = sessionHosts(cfg);
    for (const a of list) {
      if (a.kind === "ask") {
        if (!hosts.length) { bar.createSpan({ cls: "aos-dim", text: `${a.label}: enable a host to run this` }); continue; }
        for (const h of hosts) {
          const cmd = askCommand(a, h, cfg);
          const b = bar.createEl("button", { cls: "aos-ws-action", text: hosts.length > 1 ? `${a.label} ❯_ ${h}` : `${a.label} ❯_`, attr: { title: `Opens a ${HOST_LABEL[h]} session in the vault running: ${cmd}` } });
          b.addEventListener("click", (e) => { e.stopPropagation(); this.wb.runInTerm(cmd, { host: h, origin: "Notifications" }); });
        }
      } else {
        const chosen = this.votes[`${r.id}|${a.ref}`] === a.value;
        const b = bar.createEl("button", { cls: `aos-ws-action aos-nt-react${chosen ? " is-chosen" : ""}`, text: `${a.value > 0 ? "▲" : "▼"} ${a.label}` });
        b.addEventListener("click", (e) => { e.stopPropagation(); void this.react(r.id, a.ref, a.value); });
      }
    }
  }

  private async flag(ids: string[], key: "read" | "archived", value: boolean): Promise<void> {
    try { await setFlags(adapterOf(this.plugin.app), ids, key, value); } catch (e) {
      new Notice(`Could not update ${STATE_PATH}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.refresh();
  }

  private async react(id: string, ref: string, value: 1 | -1): Promise<void> {
    try { await appendReaction(adapterOf(this.plugin.app), id, ref, value); } catch (e) {
      new Notice(`Could not record the reaction: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.refresh();
  }

  private async openFile(p: string): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) { await this.plugin.app.workspace.getLeaf("tab").openFile(f); return; }
    new Notice(`Cannot open: ${p}`);
  }
}
