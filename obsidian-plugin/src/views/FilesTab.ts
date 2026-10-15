import { Notice, TFile } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { ConfirmModal } from "../ui/ConfirmModal";
import { QuickOpenModal } from "../ui/QuickOpenModal";
import {
  childEntries, isListed, isProtected, movePath, newNotePath, quickOpenFiles, renamePath, searchVault, Entry, PathCheck,
  SearchResult, SEARCH_MAX_MATCHES, TEXT_EXTENSIONS,
} from "../data/vaultFiles";

/**
 * FILES — the vault as a tree, quick open, search, and the file chores (spec 2026-10-05-workbench-app, phase 2):
 * a new note, rename, move, and delete to the Trash. Reads go through the vault's index, so the tab shows what Obsidian
 * or the app indexes; writes go through the vault API. Pure parts live in src/data/vaultFiles.ts.
 */
export class FilesTab {
  private host: HTMLElement | null = null;
  private expanded = new Set<string>();
  private query = "";
  private allText = false;
  private result: SearchResult | null = null;
  private searching = false;
  private searchSeq = 0;
  private searchDebounce: number | null = null;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;
  private searchInput: HTMLInputElement | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      // The tree changes on create, delete and rename; a modify only matters to a search already on screen.
      const vault = this.plugin.app.vault;
      const tree = (f: TAbstractFile, oldPath?: string) => { if (isListed(f.path) || (oldPath !== undefined && isListed(oldPath))) this.schedule(); };
      this.view.registerEvent(vault.on("create", (f) => tree(f)));
      this.view.registerEvent(vault.on("delete", (f) => tree(f)));
      this.view.registerEvent(vault.on("rename", (f, oldPath) => tree(f, oldPath)));
    }
    void this.refresh();
  }

  unmount(): void {
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
    if (this.searchDebounce !== null) { window.clearTimeout(this.searchDebounce); this.searchDebounce = null; }
    this.searchSeq++;
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    if (this.query.trim()) await this.runSearch();
    this.render();
  }

  /** Search vault…: shows the tab with the cursor in the search box. */
  focusSearch(): void {
    this.searchInput?.focus();
    this.searchInput?.select();
  }

  // ── render ──

  private render(): void {
    if (!this.view.isTabActive("files")) return;
    const host = this.host;
    if (!host) return;
    const hadFocus = document.activeElement === this.searchInput;
    host.empty();

    const files = quickOpenFiles(this.plugin.app);
    const head = host.createDiv({ cls: "aos-rt-head" });
    head.createSpan({ cls: "aos-rt-title", text: "Files" });
    head.createSpan({ cls: "aos-dim aos-rt-count", text: `${files.length} files` });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    const add = actions.createEl("button", { cls: "aos-ws-action", text: "+ note", attr: { "data-tour": "files-new-note" } });
    add.addEventListener("click", () => this.newNote(""));
    const open = actions.createEl("button", { cls: "aos-ws-action", text: "open…", attr: { title: "Open file… (⌘O)", "data-tour": "files-open" } });
    open.addEventListener("click", () => new QuickOpenModal(this.plugin.app).open());

    const bar = host.createDiv({ cls: "aos-fl-search" });
    const input = bar.createEl("input", { cls: "aos-fl-query", attr: { type: "search", placeholder: this.allText ? "Search every text file…" : "Search notes…", spellcheck: "false" } });
    input.value = this.query;
    input.addEventListener("input", () => this.onQuery(input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Escape" && input.value) { e.preventDefault(); input.value = ""; this.onQuery(""); } });
    this.searchInput = input;
    const scope = bar.createEl("label", { cls: "aos-fl-scope aos-dim" });
    const box = scope.createEl("input", { attr: { type: "checkbox" } });
    box.checked = this.allText;
    scope.appendText("all text files");
    box.addEventListener("change", () => { this.allText = box.checked; this.onQuery(this.query, 0); });
    if (hadFocus) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }

    if (this.query.trim()) this.renderResults(host.createDiv({ cls: "aos-fl-results", attr: { "data-tour": "files-list" } }));
    else this.renderFolder(host.createDiv({ cls: "aos-fl-tree", attr: { "data-tour": "files-list" } }), "", 0);
  }

  private renderFolder(host: HTMLElement, folder: string, depth: number): void {
    const vault = this.plugin.app.vault;
    const node = folder ? vault.getAbstractFileByPath(folder) : vault.getRoot();
    const children = node && "children" in node ? childEntries((node as unknown as { children: TAbstractFile[] }).children) : [];
    if (!children.length && depth === 0) {
      host.createDiv({ cls: "aos-inv-row aos-dim", text: "The vault is empty." });
      return;
    }
    for (const e of children) {
      if (e.folder) this.renderFolderRow(host, e, depth);
      else this.renderFileRow(host, e, depth);
    }
  }

  private indent(row: HTMLElement, depth: number): void {
    row.style.paddingLeft = `${6 + depth * 14}px`;
  }

  private renderFolderRow(host: HTMLElement, e: Entry, depth: number): void {
    const open = this.expanded.has(e.path);
    const row = host.createDiv({ cls: `aos-fl-row aos-fl-folder${open ? " is-open" : ""}`, attr: { "data-path": e.path, role: "button", tabindex: "0" } });
    this.indent(row, depth);
    row.createSpan({ cls: "aos-fl-twisty", text: open ? "▾" : "▸" });
    row.createSpan({ cls: "aos-fl-name", text: e.name });
    const acts = row.createSpan({ cls: "aos-fl-acts" });
    if (!isProtected(`${e.path}/`)) this.act(acts, "+", "New note in this folder", () => this.newNote(e.path));
    const toggle = () => { if (open) this.expanded.delete(e.path); else this.expanded.add(e.path); this.render(); };
    row.addEventListener("click", (ev) => { if (!(ev.target as HTMLElement).closest(".aos-fl-acts")) toggle(); });
    row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
    if (open) this.renderFolder(host, e.path, depth + 1);
  }

  private renderFileRow(host: HTMLElement, e: Entry, depth: number): void {
    const file = this.plugin.app.vault.getAbstractFileByPath(e.path);
    const opens = file instanceof TFile && TEXT_EXTENSIONS.includes(file.extension);
    const row = host.createDiv({ cls: `aos-fl-row aos-fl-file${opens ? "" : " is-inert"}`, attr: { "data-path": e.path, role: "button", tabindex: "0" } });
    this.indent(row, depth);
    row.createSpan({ cls: "aos-fl-twisty" });
    row.createSpan({ cls: "aos-fl-name", text: e.name });
    if (!opens) row.setAttr("title", "Not a text file: rename, move or delete it here");
    const acts = row.createSpan({ cls: "aos-fl-acts" });
    if (!isProtected(e.path)) {
      this.act(acts, "✎", "Rename", () => this.rename(e.path));
      this.act(acts, "→", "Move to another folder", () => this.move(e.path));
      this.act(acts, "✕", "Move to the Trash", () => this.trash(e.path));
    }
    const go = () => { if (opens) void this.openFile(e.path); };
    row.addEventListener("click", (ev) => { if (!(ev.target as HTMLElement).closest(".aos-fl-acts")) go(); });
    row.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); go(); } });
  }

  private act(host: HTMLElement, glyph: string, title: string, run: () => void): void {
    const a = host.createEl("a", { cls: "aos-link aos-fl-act", text: glyph, href: "#", attr: { title, "aria-label": title } });
    a.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); run(); });
  }

  // ── search ──

  private onQuery(q: string, delay = 250): void {
    this.query = q;
    if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce);
    if (!q.trim()) { this.searchSeq++; this.result = null; this.searching = false; this.render(); return; }
    this.searchDebounce = window.setTimeout(() => { void this.runSearch().then(() => this.render()); }, delay);
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
    const r = this.result;
    if (!r || this.searching) { host.createDiv({ cls: "aos-inv-row aos-dim", text: "Searching…" }); return; }
    const summary = r.matches
      ? `${r.matches} line${r.matches === 1 ? "" : "s"} in ${r.hits.length} file${r.hits.length === 1 ? "" : "s"}${r.truncated ? ` (the first ${SEARCH_MAX_MATCHES})` : ""} · ${r.files} searched`
      : `No matches in ${r.files} file${r.files === 1 ? "" : "s"}`;
    host.createDiv({ cls: "aos-dim aos-fl-summary", text: summary });
    for (const hit of r.hits) {
      const group = host.createDiv({ cls: "aos-fl-hit", attr: { "data-path": hit.path } });
      const title = group.createDiv({ cls: "aos-fl-hitpath", attr: { role: "button", tabindex: "0" } });
      title.setText(hit.path);
      title.addEventListener("click", () => void this.openFile(hit.path));
      for (const m of hit.matches) {
        const line = group.createDiv({ cls: "aos-fl-line", attr: { role: "button", tabindex: "0", title: `${hit.path}:${m.line}` } });
        line.createSpan({ cls: "aos-fl-lineno aos-dim", text: String(m.line) });
        const text = line.createSpan({ cls: "aos-fl-linetext" });
        text.appendText(m.text.slice(0, m.start));
        text.createSpan({ cls: "aos-fl-mark", text: m.text.slice(m.start, m.end) });
        text.appendText(m.text.slice(m.end));
        line.addEventListener("click", () => void this.openFile(hit.path));
      }
    }
  }

  // ── file chores ──

  private async openFile(path: string): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.plugin.app.workspace.getLeaf("tab").openFile(f);
    else new Notice(`${path} is gone`);
  }

  private exists = (p: string): boolean => this.plugin.app.vault.getAbstractFileByPath(p) !== null;

  /** Every folder that holds a listed file, for the folder pickers. */
  private folders(): string[] {
    const set = new Set<string>();
    for (const f of quickOpenFiles(this.plugin.app)) {
      const parts = f.path.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    return [...set].filter((d) => !isProtected(`${d}/`)).sort();
  }

  /**
   * A drawer with one or two text fields, a live check of what the action would do, and a button that runs it. `check`
   * turns the fields into a target path or a reason; `run` gets the path once the button is pressed.
   */
  private form(title: string, fields: { label: string; value: string; list?: string[] }[], verb: string, check: (values: string[]) => PathCheck, run: (path: string) => Promise<void>): void {
    this.view.openDrawer(title, (host) => {
      host.addClass("aos-fl-form");
      const inputs: HTMLInputElement[] = [];
      for (const [i, f] of fields.entries()) {
        const label = host.createEl("label", { cls: "aos-rt-field", text: f.label });
        const input = label.createEl("input", { cls: "aos-rt-input", attr: { type: "text", spellcheck: "false" } });
        input.value = f.value;
        if (f.list) {
          const id = `aos-fl-list-${i}`;
          const dl = label.createEl("datalist", { attr: { id } });
          for (const o of f.list) dl.createEl("option", { attr: { value: o } });
          input.setAttr("list", id);
        }
        inputs.push(input);
      }
      const note = host.createDiv({ cls: "aos-rt-errors" });
      const buttons = host.createDiv({ cls: "aos-capture-actions" });
      const go = buttons.createEl("button", { cls: "mod-cta", text: verb });
      const update = (): PathCheck => {
        const c = check(inputs.map((i) => i.value));
        note.setText(c.ok ? `→ ${c.path}` : c.error);
        note.toggleClass("is-ok", c.ok);
        go.disabled = !c.ok;
        return c;
      };
      for (const i of inputs) {
        i.addEventListener("input", update);
        i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go.click(); } });
      }
      go.addEventListener("click", () => {
        const c = update();
        if (!c.ok) return;
        go.disabled = true;
        void run(c.path).then(() => this.view.closeDrawer(), (err: unknown) => {
          note.setText(`Not done: ${err instanceof Error ? err.message : String(err)}`);
          note.removeClass("is-ok");
          go.disabled = false;
        });
      });
      update();
      // At once, not on a timer: the drawer is already in the page, and a late timer would take the focus from a field
      // the user (or a test driver) has started typing in.
      const last = inputs[inputs.length - 1];
      last.focus();
      last.select();
    });
  }

  newNote(folder: string): void {
    this.form("New note", [{ label: "folder", value: folder, list: this.folders() }, { label: "name", value: "" }], "create",
      ([dir, name]) => newNotePath(dir, name, this.exists),
      async (path) => {
        const vault = this.plugin.app.vault;
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir && !(await vault.adapter.exists(dir))) await vault.createFolder(dir);
        const file = await vault.create(path, "");
        this.expandTo(path);
        await this.plugin.app.workspace.getLeaf("tab").openFile(file);
      });
  }

  private rename(path: string): void {
    const name = path.split("/").pop()!;
    this.form("Rename", [{ label: `rename ${name} to`, value: name }], "rename",
      ([n]) => renamePath(path, n, this.exists),
      async (to) => { await this.renameFile(path, to); });
  }

  private move(path: string): void {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    this.form("MOVE", [{ label: `move ${path.split("/").pop()} to folder`, value: dir, list: this.folders() }], "move",
      ([d]) => movePath(path, d, this.exists),
      async (to) => {
        const vault = this.plugin.app.vault;
        const target = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
        if (target && !(await vault.adapter.exists(target))) await vault.createFolder(target);
        await this.renameFile(path, to);
        this.expandTo(to);
      });
  }

  private async renameFile(from: string, to: string): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(from);
    if (!f) throw new Error(`${from} is gone`);
    await this.plugin.app.vault.rename(f, to);
  }

  private trash(path: string): void {
    new ConfirmModal(this.plugin.app, "Move to the Trash", `${path} goes to the Trash. You can put it back from there.`, "Move to Trash", (ok) => {
      if (!ok) return;
      const f = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!f) { new Notice(`${path} is gone`); return; }
      void this.plugin.app.vault.trash(f, true).then(
        () => new Notice(`${path} moved to the Trash`),
        (err: unknown) => new Notice(`Not moved to the Trash: ${err instanceof Error ? err.message : String(err)}`),
      );
    }).open();
  }

  /** Opens the folders down to `path`, so a file just made or moved is in sight. */
  private expandTo(path: string): void {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) this.expanded.add(parts.slice(0, i).join("/"));
  }
}
