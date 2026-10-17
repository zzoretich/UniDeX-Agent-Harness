import { Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../../main";
import type { WorkbenchView } from "../WorkbenchView";
import { QuickOpenModal } from "../../ui/QuickOpenModal";
import { shell } from "../../host";
import {
  NO_SELECTION, SORT_KEYS, SORT_LABEL, VIEW_LABEL, crumbs, extOf, extendTo, go, goBack, goForward, itemsLabel, keepSelection,
  keyAction, kindOf, parentOf, renameInSelection, selectAll, selectOnly, sortItems, toggleIn, typeAhead,
  type History, type Item, type KeyAction, type Selection, type SortKey, type ViewMode,
} from "../../data/filesModel";
import { buildVaultIndex, type VaultIndex } from "../../data/vaultIndex";
import { childEntries, isListed, isProtected, protectedReason, quickOpenFiles, readCached, searchVault, SEARCH_MAX_MATCHES, type SearchResult } from "../../data/vaultFiles";
import { rememberFilesChoice, sanitizeFilesChoice, type FilesChoice } from "../../settingsDefaults";
import { FileChores } from "./chores";
import { renderColumns } from "./ColumnView";
import { renderIcons } from "./IconView";
import { renderList } from "./ListView";
import { FilesMenu, type MenuEntry } from "./Menu";
import { renderPreview, toDataUrl, type PreviewDeps } from "./Preview";
import { QuickLook } from "./QuickLook";
import { defaultFavorites, renderSidebar } from "./Sidebar";
import type { FilesCtx, ViewNav } from "./ctx";

/** Images up to this size are drawn in the preview and Quick Look (readBinary is synchronous per chunk, D19). */
const IMAGE_MAX_BYTES = 8_000_000;
const TYPE_AHEAD_MS = 900;

/**
 * FILES — a Finder window onto the vault (spec 2026-10-17-files-finder): a sidebar of favorites; Icons, List and
 * Columns (D2, D7–D9); a selection with Finder's keys (D4, D23); the preview (D10) and Quick Look (D11); the right-click
 * menu (D13) over today's chores; and the search across notes kept from today. Reads go through the vault's index;
 * writes through the vault API, which main checks against the Files surface. The pure parts are data/filesModel.ts,
 * data/vaultIndex.ts and data/vaultFiles.ts.
 */
export class FilesTab {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private viewEl: HTMLElement | null = null;
  private paneEl: HTMLElement | null = null;
  private footEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;
  private indexDebounce: number | null = null;
  private searchDebounce: number | null = null;

  private at = "";
  private colRoot = "";
  private hist: History = { at: "", back: [], forward: [] };
  private sel: Selection = NO_SELECTION;
  private expanded = new Set<string>();
  private nav: ViewNav | null = null;
  private typed = "";
  private typedAt = 0;

  private query = "";
  private allText = false;
  private result: SearchResult | null = null;
  private searching = false;
  private searchSeq = 0;

  private index: VaultIndex | null = null;
  private indexSeq = 0;
  private md: Component | null = null;
  private menu: FilesMenu | null = null;
  private ql: QuickLook | null = null;
  private chores: FileChores;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {
    this.chores = new FileChores(plugin, view, { landed: (to, from) => this.landed(to, from) });
  }

  // ── lifecycle ──

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const vault = this.plugin.app.vault;
      // Only a change to what is on screen redraws it: the runtime writes brain/_index all day, and a redraw between
      // the two clicks of a double-click would lose it. Notes still reach the index, which links depend on.
      const tree = (f: TAbstractFile, oldPath?: string) => {
        if (oldPath !== undefined) this.followRename(oldPath, f.path);
        const paths = oldPath !== undefined ? [f.path, oldPath] : [f.path];
        if (paths.some((p) => isListed(p) && this.touches(p))) this.schedule();
        else if (paths.some((p) => p.endsWith(".md"))) this.scheduleIndex();
      };
      this.view.registerEvent(vault.on("create", (f) => tree(f)));
      this.view.registerEvent(vault.on("delete", (f) => tree(f)));
      this.view.registerEvent(vault.on("rename", (f, oldPath) => tree(f, oldPath)));
      // A note's links and tags change as it is edited; the index catches up a moment later.
      this.view.registerEvent(vault.on("modify", (f) => { if (f.path.endsWith(".md")) this.scheduleIndex(); }));
    }
    this.md?.unload();
    this.md = new Component();
    this.md.load();
    void this.refresh();
    this.scheduleIndex(0);
  }

  unmount(): void {
    for (const t of [this.refreshDebounce, this.indexDebounce, this.searchDebounce]) if (t !== null) window.clearTimeout(t);
    this.refreshDebounce = this.indexDebounce = this.searchDebounce = null;
    this.searchSeq++;
    this.indexSeq++;
    this.menu?.close();
    this.ql?.dispose();
    this.md?.unload();
    this.md = null;
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => { this.refreshDebounce = null; void this.refresh(); this.scheduleIndex(); }, 250);
  }

  private scheduleIndex(ms = 1500): void {
    if (this.indexDebounce !== null) window.clearTimeout(this.indexDebounce);
    this.indexDebounce = window.setTimeout(() => {
      this.indexDebounce = null;
      const seq = ++this.indexSeq;
      void buildVaultIndex(this.plugin.app, { isCancelled: () => seq !== this.indexSeq }).then((idx) => {
        if (!idx || seq !== this.indexSeq) return;
        const before = this.indexSig(this.index);
        this.index = idx;
        if (!this.view.isTabActive("files") || !this.root?.isConnected) return;
        // The page art, the preview's Tags and Links: redrawn in place, the scroll and the focus kept, and only when
        // what is on screen changed.
        if (this.indexSig(idx) === before) return;
        if (!this.query.trim()) this.drawView();
        this.drawPane();
      });
    }, ms);
  }

  async refresh(): Promise<void> {
    if (this.query.trim()) await this.runSearch();
    if (!this.root?.isConnected) { this.render(); return; }
    // Drawn already: the parts that list the vault are drawn again in place, the scroll and the focus kept.
    this.listCache.clear();
    this.settle();
    this.drawBar();
    this.drawView();
    this.drawPane();
    this.drawFoot();
  }

  /** The folders the view lists now: the one in view, List's open ones, Columns' from the root to the cursor. */
  private shownFolders(): Set<string> {
    const out = new Set<string>([this.at]);
    const mode = this.mode();
    if (mode === "list") for (const f of this.expanded) out.add(f);
    if (mode === "columns") {
      out.add(this.colRoot);
      const deepest = this.sel.cursor ?? this.at;
      const parts = deepest.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        if (!this.colRoot || p === this.colRoot || p.startsWith(`${this.colRoot}/`)) out.add(p);
      }
    }
    return out;
  }

  /** Whether a vault change at `path` shows: in a folder on screen, a folder whose count is on screen, or what is
   *  shown or selected itself. A search on screen takes every change. */
  private touches(path: string): boolean {
    if (this.query.trim()) return true;
    const shown = this.shownFolders();
    const dir = parentOf(path);
    if (shown.has(dir) || (dir !== "" && shown.has(parentOf(dir)))) return true;
    const inside = (p: string) => p === path || p.startsWith(`${path}/`);
    return inside(this.at) || inside(this.colRoot) || this.sel.paths.some(inside);
  }

  /** What the index draws on screen (page art, tags, links), to tell whether a new index changes it. */
  private indexSig(idx: VaultIndex | null): string {
    if (!idx) return "";
    const note = (p: string) => {
      const n = idx.notes.get(p);
      return n ? `${p}:${n.lines.join(",")}:${n.tags.join(",")}:${n.out.length}:${idx.backlinks.get(p)?.length ?? 0}` : `${p}:-`;
    };
    const parts: string[] = [];
    for (const dir of this.shownFolders()) for (const it of this.list(dir)) if (it.ext === "md") parts.push(note(it.path));
    if (this.sel.cursor) parts.push(note(this.sel.cursor));
    return parts.join("|");
  }

  /** The state after the vault changed: the selection that still exists, a folder in view that still does. */
  private settle(): void {
    this.sel = keepSelection(this.sel, (p) => this.item(p) !== null);
    if (this.at && !this.isFolder(this.at)) this.at = this.nearestFolder(this.at);
    if (this.colRoot && !this.isFolder(this.colRoot)) this.colRoot = "";
  }

  /** Search vault…: shows the tab with the cursor in the search box. */
  focusSearch(): void {
    this.searchInput?.focus();
    this.searchInput?.select();
  }

  // ── state ──

  private choice(): FilesChoice { return sanitizeFilesChoice(this.plugin.settings.files); }

  private remember(pick: Parameters<typeof rememberFilesChoice>[1]): void {
    this.plugin.settings.files = rememberFilesChoice(this.plugin.settings.files, pick);
    void this.plugin.saveSettings();
  }

  private mode(): ViewMode { return this.choice().view; }

  private vaultName(): string { return this.plugin.app.vault.getName(); }

  private abs(rel: string): string {
    const root = this.plugin.vaultRoot().replace(/\/+$/, "");
    return rel ? `${root}/${rel}` : root;
  }

  private node(path: string): TAbstractFile | null {
    return path ? this.plugin.app.vault.getAbstractFileByPath(path) : this.plugin.app.vault.getRoot();
  }

  private isFolder = (path: string): boolean => {
    const n = this.node(path);
    return !!n && "children" in n;
  };

  private toItem(f: TAbstractFile): Item {
    const folder = "children" in f;
    const stat = folder ? null : (f as unknown as { stat?: { size: number; mtime: number; ctime: number } }).stat ?? null;
    return { path: f.path, name: f.name, folder, ext: folder ? "" : extOf(f.name), size: stat?.size ?? null, mtime: stat?.mtime ?? null, ctime: stat?.ctime ?? null };
  }

  /** A folder's listed entries, sorted (cached for one draw: a column and its counts read each folder once). */
  private listCache = new Map<string, Item[]>();

  private list = (folder: string): Item[] => {
    const hit = this.listCache.get(folder);
    if (hit) return hit;
    const n = this.node(folder);
    const children = n && "children" in n ? (n as unknown as { children: TAbstractFile[] }).children : [];
    const listed = new Set(childEntries(children).map((e) => e.path));
    const items = children.filter((c) => listed.has(c.path)).map((c) => this.toItem(c));
    const sorted = sortItems(items, this.choice().sort);
    this.listCache.set(folder, sorted);
    return sorted;
  };

  private item = (path: string): Item | null => {
    if (path === "") return null;
    const n = this.node(path);
    return n && isListed(path) ? this.toItem(n) : null;
  };

  private ctx(): FilesCtx {
    return {
      vaultName: this.vaultName(),
      now: new Date(),
      at: this.at,
      colRoot: this.colRoot,
      sel: this.sel,
      sort: this.choice().sort,
      index: this.index,
      expanded: this.expanded,
      list: this.list,
      item: this.item,
      count: (folder) => this.list(folder).length,
      isProtected: (p) => isProtected(p),
      setIcon: (el, id) => setIcon(el, id),
      press: (path, e) => this.press(path, e),
      activate: (path) => this.activate(path),
      menu: (path, e, folder) => this.openMenu(path, e, folder),
      toggle: (folder) => this.toggleFolder(folder),
      sortBy: (key) => this.sortBy(key),
      preview: (host, path) => renderPreview(host, path, this.previewDeps()),
    };
  }

  private previewDeps(): PreviewDeps {
    return {
      ctx: this.ctx(),
      readText: async (path) => {
        const f = this.plugin.app.vault.getFileByPath(path);
        return f ? readCached(this.plugin.app, f) : null;
      },
      readImage: async (path) => {
        const f = this.plugin.app.vault.getFileByPath(path);
        if (!f || f.stat.size > IMAGE_MAX_BYTES) return null;
        try { return toDataUrl(await this.plugin.app.vault.adapter.readBinary(path), f.extension.toLowerCase()); } catch { return null; }
      },
      renderMarkdown: (el, text, sourcePath) => {
        if (this.md) void MarkdownRenderer.renderMarkdown(text, el, sourcePath, this.md);
        else el.createEl("pre", { cls: "aos-fx-pre", text });
      },
      open: (path) => this.activate(path, true),
      quickLook: (path) => this.quickLook(path),
      menu: (path, e) => this.openMenu(path, e, parentOf(path)),
    };
  }

  // ── draw ──

  private render(): void {
    if (!this.view.isTabActive("files")) return;
    const host = this.host;
    if (!host) return;
    const hadSearchFocus = document.activeElement === this.searchInput;
    const hadViewFocus = !!this.viewEl && this.viewEl.contains(document.activeElement);
    this.listCache.clear();
    this.settle();
    this.menu?.close();
    host.empty();

    const root = host.createDiv({ cls: `aos-fx is-${this.mode()}` });
    this.root = root;
    root.addEventListener("keydown", (e) => this.onKey(e));
    this.menu = new FilesMenu(root);
    this.ql?.dispose();
    this.ql = new QuickLook(root, { ...this.previewDeps(), reveal: (p) => this.reveal(p), onClose: (p) => { if (p) this.select(selectOnly(p)); this.viewEl?.focus(); } });

    const years = this.list("").filter((i) => i.folder && /^\d{4}$/.test(i.name)).map((i) => i.name);
    const favorites = defaultFavorites(this.vaultName(), this.isFolder, years);
    renderSidebar(root, { favorites, current: this.mode() === "columns" ? this.colRoot : this.at, pick: (p) => this.pickFavorite(p), setIcon: (el, id) => setIcon(el, id) });

    const main = root.createEl("section", { cls: "aos-fx-main", attr: { "aria-label": "Files" } });
    this.barEl = main.createDiv({ cls: "aos-fx-bar" });
    this.drawBar();
    const body = main.createDiv({ cls: "aos-fx-body" });
    this.viewEl = body.createDiv({ cls: "aos-fx-view", attr: { tabindex: "0", "data-tour": "files-list", "data-view": this.mode() } });
    // A click on empty space clears the selection, as Finder's does.
    this.viewEl.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("[data-path], button, a, input")) this.select(NO_SELECTION); });
    this.drawView();
    this.paneEl = body.createEl("aside", { cls: "aos-fx-pane", attr: { "aria-label": "Preview" } });
    this.drawPane();
    this.footEl = main.createDiv({ cls: "aos-fx-foot" });
    this.drawFoot();

    if (hadSearchFocus && this.searchInput) { this.searchInput.focus(); this.searchInput.setSelectionRange(this.searchInput.value.length, this.searchInput.value.length); }
    else if (hadViewFocus) this.viewEl.focus({ preventScroll: true });
  }

  private nearestFolder(path: string): string {
    let p = parentOf(path);
    while (p && !this.isFolder(p)) p = parentOf(p);
    return p;
  }

  private drawBar(): void {
    const bar = this.barEl;
    if (!bar) return;
    bar.empty();
    const side = bar.createEl("button", { cls: "aos-fx-iconbtn aos-fx-sidetoggle", attr: { type: "button", "aria-label": "Show the sidebar" } });
    setIcon(side, "panel-left");
    side.addEventListener("click", () => this.root?.toggleClass("is-side-open", !this.root.hasClass("is-side-open")));
    const back = bar.createEl("button", { cls: "aos-fx-iconbtn", attr: { type: "button", "aria-label": "Back", "data-act": "back" } });
    setIcon(back, "chevron-left");
    back.disabled = !this.hist.back.length;
    back.addEventListener("click", () => this.travel(-1));
    const fwd = bar.createEl("button", { cls: "aos-fx-iconbtn", attr: { type: "button", "aria-label": "Forward", "data-act": "forward" } });
    setIcon(fwd, "chevron-right");
    fwd.disabled = !this.hist.forward.length;
    fwd.addEventListener("click", () => this.travel(1));

    const title = bar.createDiv({ cls: "aos-fx-title" });
    title.createEl("h1", { cls: "aos-fx-h1", text: this.at ? this.at.split("/").pop()! : this.vaultName() });
    title.createSpan({ cls: "aos-fx-count", text: itemsLabel(this.list(this.at).length) });
    const ws = /^workspaces\/([^/_.][^/]*)$/.exec(this.at);
    if (ws) {
      const chip = title.createEl("button", { cls: "aos-fx-chip aos-fx-wschip", attr: { type: "button", "data-act": "open-space" } });
      chip.createSpan({ text: "Workspace · Open in Spaces" });
      const go = chip.createSpan({ cls: "aos-fx-chip-ic" });
      setIcon(go, "arrow-up-right");
      chip.addEventListener("click", () => { this.view.open({ tab: "spaces", workspace: ws[1] }); });
    }

    const tools = bar.createDiv({ cls: "aos-fx-tools" });
    const seg = tools.createDiv({ cls: "aos-fx-seg", attr: { role: "group", "aria-label": "View", "data-tour": "files-views" } });
    const views: Array<{ id: ViewMode; icon: string; key: string }> = [
      { id: "icons", icon: "layout-grid", key: "⌃⌘1" },
      { id: "list", icon: "list", key: "⌃⌘2" },
      { id: "columns", icon: "columns-3", key: "⌃⌘3" },
    ];
    for (const v of views) {
      const on = this.mode() === v.id;
      const b = seg.createEl("button", { cls: on ? "is-on" : "", attr: { type: "button", "data-view": v.id, "aria-pressed": on ? "true" : "false", "aria-label": VIEW_LABEL[v.id], title: `${VIEW_LABEL[v.id]} (${v.key})` } });
      setIcon(b, v.icon);
      b.addEventListener("click", () => this.setView(v.id));
    }
    const sort = tools.createEl("button", { cls: "aos-fx-btn aos-fx-sortbtn", attr: { type: "button", "aria-haspopup": "menu", "data-act": "sort" } });
    const sortIc = sort.createSpan({ cls: "aos-fx-btn-ic" });
    setIcon(sortIc, "arrow-up-down");
    sort.createSpan({ text: SORT_LABEL[this.choice().sort.key] });
    sort.addEventListener("click", () => this.sortMenu(sort));
    if (this.mode() !== "columns") {
      const pv = this.choice().preview;
      const p = tools.createEl("button", { cls: `aos-fx-iconbtn${pv ? " is-on" : ""}`, attr: { type: "button", "aria-pressed": pv ? "true" : "false", "aria-label": "Preview (⇧⌘P)", title: "Preview (⇧⌘P)", "data-act": "preview" } });
      setIcon(p, "panel-right");
      p.addEventListener("click", () => this.togglePreview());
    }
    const add = tools.createEl("button", { cls: "aos-fx-iconbtn", attr: { type: "button", "aria-haspopup": "menu", "aria-label": "New", title: "New", "data-tour": "files-new-note", "data-act": "new" } });
    setIcon(add, "plus");
    add.addEventListener("click", () => this.menu?.open([
      { label: "New note…", key: "⌘N", act: "new-note", off: this.writeOff(`${this.at}/`), run: () => this.chores.newNote(this.at) },
    ], add, "New"));
    const more = tools.createEl("button", { cls: "aos-fx-iconbtn", attr: { type: "button", "aria-haspopup": "menu", "aria-label": "More actions", title: "More actions", "data-tour": "files-open", "data-act": "more" } });
    setIcon(more, "ellipsis");
    more.addEventListener("click", () => this.menu?.open([
      { label: "Open file…", key: "⌘O", act: "open-file", run: () => new QuickOpenModal(this.plugin.app).open() },
      { separator: true },
      { label: "Reveal in Finder", act: "reveal", run: () => this.reveal(this.at) },
      { label: "Copy path", act: "copy-path", run: () => this.copy(this.abs(this.at)) },
    ], more, "More actions"));

    const search = tools.createDiv({ cls: "aos-fx-search" });
    const field = search.createEl("label", { cls: "aos-fx-field" });
    const lens = field.createSpan({ cls: "aos-fx-field-ic" });
    setIcon(lens, "search");
    const input = field.createEl("input", { cls: "aos-fx-query", attr: { type: "search", placeholder: this.allText ? "Search every text file…" : "Search notes…", spellcheck: "false", "aria-label": "Search" } });
    input.value = this.query;
    input.addEventListener("input", () => this.onQuery(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ""; this.onQuery(""); }
      else if (e.key === "ArrowDown") { e.preventDefault(); this.viewEl?.focus(); }
    });
    this.searchInput = input;
    const scope = search.createEl("label", { cls: "aos-fx-scope" });
    const box = scope.createEl("input", { attr: { type: "checkbox" } });
    box.checked = this.allText;
    scope.appendText("all text files");
    box.addEventListener("change", () => { this.allText = box.checked; this.onQuery(this.query, 0); });
  }

  private drawView(): void {
    const el = this.viewEl;
    if (!el) return;
    const top = el.scrollTop;
    const left = el.scrollLeft;
    const hadFocus = el.contains(document.activeElement);
    el.empty();
    this.listCache.clear();
    if (this.query.trim()) { this.nav = null; this.renderResults(el); return; }
    const ctx = this.ctx();
    const mode = this.mode();
    this.nav = mode === "icons" ? renderIcons(el, ctx) : mode === "list" ? renderList(el, ctx) : renderColumns(el, ctx);
    this.paint();
    el.scrollTop = top;
    el.scrollLeft = left;
    if (hadFocus) el.focus({ preventScroll: true });
  }

  private drawPane(): void {
    const pane = this.paneEl;
    if (!pane) return;
    pane.empty();
    const show = this.mode() !== "columns" && this.choice().preview && !this.query.trim();
    pane.toggleClass("is-shown", show);
    if (!show) return;
    const cur = this.sel.cursor;
    if (!cur) { pane.createDiv({ cls: "aos-fx-empty", text: "Select an item to preview it." }); return; }
    renderPreview(pane.createDiv(), cur, this.previewDeps());
  }

  private drawFoot(): void {
    const foot = this.footEl;
    if (!foot) return;
    foot.empty();
    const path = foot.createEl("nav", { cls: "aos-fx-path", attr: { "aria-label": "Path" } });
    const cs = crumbs(this.sel.cursor ?? this.at, this.vaultName());
    cs.forEach((c, i) => {
      if (i) path.createSpan({ cls: "aos-fx-path-sep", text: "›", attr: { "aria-hidden": "true" } });
      const last = i === cs.length - 1;
      const b = path.createEl("button", { cls: `aos-fx-crumb${last ? " is-last" : ""}`, text: c.name, attr: { type: "button", "data-path": c.path } });
      b.addEventListener("click", () => { if (this.isFolder(c.path) && !(last && this.sel.cursor === c.path)) this.enter(c.path); });
    });
    const status = foot.createDiv({ cls: "aos-fx-status" });
    const parts = [itemsLabel(this.query.trim() ? 0 : this.list(this.at).length)];
    if (this.sel.paths.length) parts.push(`${this.sel.paths.length} selected`);
    if (!this.query.trim()) status.createSpan({ cls: "aos-fx-sel", text: parts.join(" · ") });
    status.createSpan({ cls: "aos-fx-total aos-rt-count", text: `${quickOpenFiles(this.plugin.app).length.toLocaleString("en-US")} files` });
  }

  /** Marks the selection on what the view drew, without drawing it again. */
  private paint(): void {
    const el = this.viewEl;
    if (!el) return;
    const on = new Set(this.sel.paths);
    el.querySelectorAll<HTMLElement>("[data-path]").forEach((n) => {
      const p = n.dataset.path!;
      n.toggleClass("is-selected", on.has(p));
      n.toggleClass("is-cursor", p === this.sel.cursor);
      n.setAttr("aria-selected", on.has(p) ? "true" : "false");
    });
    const cur = this.sel.cursor ? Array.from(el.querySelectorAll<HTMLElement>("[data-path]")).find((n) => n.dataset.path === this.sel.cursor) : null;
    cur?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ── selection and moving around ──

  private select(sel: Selection): void {
    this.sel = sel;
    if (this.mode() === "columns") {
      // Columns follow the cursor: the folder it is in becomes the one the title and + New name.
      const cur = sel.cursor;
      if (cur) this.at = this.isFolder(cur) ? cur : parentOf(cur);
      this.drawBar();
      this.drawView();
    } else this.paint();
    this.drawPane();
    this.drawFoot();
  }

  private press(path: string, e: MouseEvent): void {
    const order = this.nav?.order ?? [];
    if (e.metaKey) this.select(toggleIn(this.sel, path));
    else if (e.shiftKey) this.select(extendTo(this.sel, order, path));
    else this.select(selectOnly(path));
    this.viewEl?.focus({ preventScroll: true });
  }

  /** Double-click, ⌘↓, Open: a folder is entered (in Columns, selected, which opens its column); a file opened (D12). */
  private activate(path: string, fromPreview = false): void {
    const it = this.item(path);
    if (!it) return;
    if (it.folder) {
      if (this.mode() === "columns" && !fromPreview) { this.select(selectOnly(path)); return; }
      this.enter(path);
      return;
    }
    if (kindOf(it) === "note" || kindOf(it) === "text") { void this.chores.openNote(path); return; }
    void shell.openPath(this.abs(path)).then((err: string) => { if (err) new Notice(`Cannot open ${path}: ${err}`); });
  }

  /** Shows a folder (Icons and List) or puts the columns' cursor on it; `select` is what to select inside. */
  private enter(folder: string, select: string | null = null): void {
    this.hist = go(this.hist, folder);
    this.at = folder;
    if (this.mode() === "columns" && this.colRoot && folder !== this.colRoot && !folder.startsWith(`${this.colRoot}/`)) this.colRoot = "";
    this.sel = select ? selectOnly(select) : this.mode() === "columns" && folder ? selectOnly(folder) : NO_SELECTION;
    this.render();
    this.viewEl?.focus({ preventScroll: true });
  }

  private travel(dir: -1 | 1): void {
    const from = this.at;
    const h = dir < 0 ? goBack(this.hist) : goForward(this.hist);
    if (!h || !this.isFolder(h.at)) return;
    this.hist = h;
    this.at = h.at;
    // Back to the folder you came out of selects it, as Finder does.
    this.sel = parentOf(from) === h.at && this.item(from) ? selectOnly(from) : NO_SELECTION;
    this.render();
    this.viewEl?.focus({ preventScroll: true });
  }

  private pickFavorite(path: string): void {
    this.root?.removeClass("is-side-open");
    this.colRoot = path;
    this.hist = go(this.hist, path);
    this.at = path;
    this.sel = NO_SELECTION;
    this.render();
    this.viewEl?.focus({ preventScroll: true });
  }

  private toggleFolder(folder: string): void {
    if (this.expanded.has(folder)) {
      this.expanded.delete(folder);
      // A selection inside the closed folder moves to it.
      if (this.sel.cursor?.startsWith(`${folder}/`)) this.sel = selectOnly(folder);
    } else this.expanded.add(folder);
    this.drawView();
    this.drawFoot();
  }

  private setView(mode: ViewMode): void {
    if (mode === this.mode()) return;
    this.remember({ view: mode });
    if (mode === "columns" && this.colRoot && this.at !== this.colRoot && !this.at.startsWith(`${this.colRoot}/`)) this.colRoot = "";
    if (mode === "columns" && !this.sel.cursor && this.at) this.sel = selectOnly(this.at);
    this.render();
    this.viewEl?.focus({ preventScroll: true });
  }

  private sortBy(key: SortKey): void {
    const cur = this.choice().sort;
    this.remember({ sort: { key, desc: cur.key === key ? !cur.desc : key === "modified" || key === "size" } });
    this.drawBar();
    this.drawView();
  }

  private sortMenu(anchor: HTMLElement): void {
    const cur = this.choice().sort;
    const entries: MenuEntry[] = SORT_KEYS.map((k) => ({
      label: `${cur.key === k ? "✓ " : ""}${SORT_LABEL[k]}`, act: `sort-${k}`,
      run: () => { this.remember({ sort: { key: k, desc: cur.key === k ? cur.desc : k === "modified" || k === "size" } }); this.drawBar(); this.drawView(); },
    }));
    entries.push({ separator: true }, {
      label: `${cur.desc ? "✓ " : ""}Descending`, act: "sort-desc",
      run: () => { this.remember({ sort: { key: cur.key, desc: !cur.desc } }); this.drawBar(); this.drawView(); },
    });
    this.menu?.open(entries, anchor, "Sort by");
  }

  private togglePreview(): void {
    if (this.mode() === "columns") return;
    this.remember({ preview: !this.choice().preview });
    this.drawBar();
    this.drawPane();
  }

  private quickLook(path: string): void {
    this.ql?.show(path, this.nav?.order ?? [path]);
  }

  /** A note made, or a file moved or renamed: its folder in view, the file selected. */
  private landed(to: string, from?: string): void {
    if (from) this.sel = renameInSelection(this.sel, from, to);
    const dir = parentOf(to);
    if (this.mode() === "list") {
      const parts = dir ? dir.split("/") : [];
      for (let i = 1; i <= parts.length; i++) { const p = parts.slice(0, i).join("/"); if (p.length > this.at.length) this.expanded.add(p); }
      if (dir !== this.at && !dir.startsWith(`${this.at}/`)) { this.at = dir; this.hist = go(this.hist, dir); }
    } else if (this.mode() === "icons" && dir !== this.at) { this.at = dir; this.hist = go(this.hist, dir); }
    this.sel = selectOnly(to);
    this.render();
  }

  /** A vault rename carries the folder in view, the columns' root, the open folders and the selection with it. */
  private followRename(from: string, to: string): void {
    const move = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    this.at = move(this.at);
    this.colRoot = move(this.colRoot);
    this.expanded = new Set([...this.expanded].map(move));
    this.sel = renameInSelection(this.sel, from, to);
  }

  // ── the menu (D13) ──

  private writeOff(path: string): string | null {
    return protectedReason(path);
  }

  private openMenu(path: string | null, e: MouseEvent, folder: string): void {
    if (path && !this.sel.paths.includes(path)) this.select(selectOnly(path));
    const at = { x: e.clientX, y: e.clientY };
    if (!path) {
      this.menu?.open([
        { label: "New note here…", key: "⌘N", act: "new-note", off: this.writeOff(`${folder}/`), run: () => this.chores.newNote(folder) },
        { separator: true },
        { label: "Reveal in Finder", act: "reveal", run: () => this.reveal(folder) },
        { label: "Copy path", act: "copy-path", run: () => this.copy(this.abs(folder)) },
      ], at, folder || this.vaultName());
      return;
    }
    const it = this.item(path);
    if (!it) return;
    const many = this.sel.paths.length > 1 ? this.sel.paths : null;
    const off = this.writeOff(it.folder ? `${path}/` : path);
    const text = kindOf(it) === "note" || kindOf(it) === "text";
    const entries: MenuEntry[] = [
      { label: "Open", key: "⌘↓", act: "open", run: () => this.activate(path, true) },
      ...(it.folder ? [] : [{ label: "Quick Look", key: "Space", act: "quicklook", run: () => this.quickLook(path) }]),
      { separator: true },
      { label: "Rename…", key: "↩", act: "rename", off: many ? "Rename one item at a time" : off, run: () => this.chores.rename(path) },
      { label: "Move to…", act: "move", off: many ? "Move one item at a time" : off, run: () => this.chores.move(path) },
      { separator: true },
      { label: "New note here…", key: "⌘N", act: "new-note", off: this.writeOff(`${it.folder ? path : folder}/`), run: () => this.chores.newNote(it.folder ? path : folder) },
      { separator: true },
      { label: "Copy path", act: "copy-path", run: () => this.copy(this.abs(path)) },
      ...(it.folder ? [] : [{ label: "Copy as [[link]]", act: "copy-link", run: () => this.copy(`[[${it.ext === "md" ? it.name.slice(0, -3) : it.name}]]`) }]),
      { label: "Reveal in Finder", act: "reveal", run: () => this.reveal(path) },
      ...(it.folder || !text ? [] : [{ label: "Open with default app", act: "open-default", run: () => { void shell.openPath(this.abs(path)).then((err: string) => { if (err) new Notice(`Cannot open ${path}: ${err}`); }); } }]),
      { separator: true },
      {
        label: many ? `Move ${many.length} items to Trash` : "Move to Trash", key: "⌘⌫", act: "trash", danger: true,
        off: many ? (many.every((p) => isProtected(p)) ? protectedReason(many[0]) : null) : off,
        run: () => this.chores.trash(many ?? [path]),
      },
    ];
    this.menu?.open(entries, at, it.name);
  }

  private reveal(path: string): void { shell.showItemInFolder(this.abs(path)); }

  private copy(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => new Notice(`Copied ${text}`), () => new Notice("Could not copy"));
  }

  // ── keys (D23) ──

  private onKey(e: KeyboardEvent): void {
    if (this.ql?.isOpen()) { this.onQuickLookKey(e); return; }
    if (this.menu?.isOpen()) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    const inView = !!this.viewEl && this.viewEl.contains(t);
    const a = keyAction(e);
    if (!a) {
      if (inView && e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) this.typeAheadKey(e);
      return;
    }
    // Anywhere in Files: the views, the preview, search, a new note. The rest only with focus in the view, so a button's
    // own Space and Return keep working.
    const global: KeyAction[] = ["view-icons", "view-list", "view-columns", "preview", "search", "new-note"];
    if (!global.includes(a) && !inView) return;
    // A button inside the view (List's header) keeps its own Space and Return.
    if (!global.includes(a) && t !== this.viewEl && t.closest("button, a")) return;
    e.preventDefault();
    e.stopPropagation();
    this.run(a, e.shiftKey);
  }

  private run(a: KeyAction, shift: boolean): void {
    const nav = this.nav;
    const cur = this.sel.cursor;
    switch (a) {
      case "up": case "down": case "left": case "right": {
        if (!nav) return;
        const st = nav.step(cur, a);
        if (!st) return;
        if ("select" in st) this.select(shift ? extendTo(this.sel, nav.order, st.select) : selectOnly(st.select));
        else if ("expand" in st) this.toggleFolder(st.expand);
        else this.toggleFolder(st.collapse);
        return;
      }
      case "first": case "last": {
        const o = nav?.order ?? [];
        if (o.length) this.select(selectOnly(a === "first" ? o[0] : o[o.length - 1]));
        return;
      }
      case "open": if (cur) this.activate(cur, true); return;
      case "parent": {
        if (this.mode() === "columns") { const st = nav?.step(cur, "left"); if (st && "select" in st) this.select(selectOnly(st.select)); return; }
        if (this.at) this.enter(parentOf(this.at), this.at);
        return;
      }
      case "rename": if (cur && this.sel.paths.length <= 1 && !this.writeOff(this.isFolder(cur) ? `${cur}/` : cur)) this.chores.rename(cur); return;
      case "quicklook": if (cur) this.quickLook(cur); return;
      case "clear": if (this.sel.paths.length) this.select(NO_SELECTION); return;
      case "trash": if (this.sel.paths.length) this.chores.trash(this.sel.paths); return;
      case "select-all": if (nav) this.select(selectAll(nav.order)); return;
      case "view-icons": this.setView("icons"); return;
      case "view-list": this.setView("list"); return;
      case "view-columns": this.setView("columns"); return;
      case "preview": this.togglePreview(); return;
      case "search": this.focusSearch(); return;
      case "new-note": if (!this.writeOff(`${this.at}/`)) this.chores.newNote(this.at); return;
    }
  }

  private onQuickLookKey(e: KeyboardEvent): void {
    const ql = this.ql!;
    if (e.key === " " || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ql.close(); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); ql.step(-1); return; }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      if (e.metaKey && e.key === "ArrowDown") { const p = ql.current(); ql.close(); if (p) this.activate(p, true); return; }
      ql.step(1);
    }
  }

  private typeAheadKey(e: KeyboardEvent): void {
    const now = Date.now();
    this.typed = now - this.typedAt > TYPE_AHEAD_MS ? e.key : this.typed + e.key;
    this.typedAt = now;
    const scope = this.nav?.typeAheadScope(this.sel.cursor) ?? [];
    const i = typeAhead(scope.map((s) => s.name), this.typed);
    if (i >= 0) { e.preventDefault(); this.select(selectOnly(scope[i].path)); }
  }

  // ── search (today's, D22 widens it in PR 3) ──

  private onQuery(q: string, delay = 250): void {
    this.query = q;
    if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce);
    if (!q.trim()) { this.searchSeq++; this.result = null; this.searching = false; this.drawView(); this.drawPane(); this.drawFoot(); return; }
    this.searchDebounce = window.setTimeout(() => { void this.runSearch().then(() => { this.drawView(); this.drawPane(); this.drawFoot(); }); }, delay);
  }

  private async runSearch(): Promise<void> {
    const seq = ++this.searchSeq;
    this.searching = true;
    const r = await searchVault(this.plugin.app, this.query, { allText: this.allText, isCancelled: () => seq !== this.searchSeq });
    if (seq !== this.searchSeq || r === null) return;
    this.result = r;
    this.searching = false;
  }

  private renderResults(host: HTMLElement): void {
    const box = host.createDiv({ cls: "aos-fx-results" });
    const r = this.result;
    if (!r || this.searching) { box.createDiv({ cls: "aos-fx-empty", text: "Searching…" }); return; }
    const summary = r.matches
      ? `${r.matches} line${r.matches === 1 ? "" : "s"} in ${r.hits.length} file${r.hits.length === 1 ? "" : "s"}${r.truncated ? ` (the first ${SEARCH_MAX_MATCHES})` : ""} · ${r.files} searched`
      : `No matches in ${r.files} file${r.files === 1 ? "" : "s"}`;
    box.createDiv({ cls: "aos-fx-summary", text: summary });
    for (const hit of r.hits) {
      const group = box.createDiv({ cls: "aos-fx-hit", attr: { "data-hit": hit.path } });
      const title = group.createEl("button", { cls: "aos-fx-hitpath", attr: { type: "button" } });
      title.setText(hit.path);
      title.addEventListener("click", () => void this.chores.openNote(hit.path));
      for (const m of hit.matches) {
        const line = group.createEl("button", { cls: "aos-fx-line", attr: { type: "button", title: `${hit.path}:${m.line}` } });
        line.createSpan({ cls: "aos-fx-lineno", text: String(m.line) });
        const text = line.createSpan({ cls: "aos-fx-linetext" });
        text.appendText(m.text.slice(0, m.start));
        text.createSpan({ cls: "aos-fx-mark", text: m.text.slice(m.start, m.end) });
        text.appendText(m.text.slice(m.end));
        line.addEventListener("click", () => void this.chores.openNote(hit.path));
      }
    }
  }
}
