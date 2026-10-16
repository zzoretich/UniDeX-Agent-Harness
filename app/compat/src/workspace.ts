// Workspace, leaves and views: the pane manager that replaces Obsidian's layout.
//
// Areas: "main" (tabs), "split" (a second column next to main) and "right" (the sidebar). Each area shows one active
// leaf. An ItemView's containerEl has two children, a header and the content, because the HUD reaches its content
// as `containerEl.children[1]`.

import { Component, Events } from "./events";
import { TFile, normalizePath } from "./files";
import { bridge } from "./bridge";
import { canSave } from "./guard";
import { MarkdownRenderer } from "./markdown";
import { NoteEditor, type SaveState } from "./noteEditor";
import { Notice } from "./notice";
import type { App } from "./plugin";

type Area = "main" | "split" | "right";

export interface ViewState { type: string; active?: boolean; state?: Record<string, unknown> }

export abstract class View extends Component {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  navigation = false;
  icon = "";

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.workspace.app;
    this.containerEl = createDiv({ cls: "workspace-leaf-content" });
  }

  abstract getViewType(): string;
  getDisplayText(): string { return this.getViewType(); }
  getIcon(): string { return this.icon; }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
  getState(): Record<string, unknown> { return {}; }
  async setState(_state: unknown, _result?: unknown): Promise<void> {}
  onResize(): void {}
}

export abstract class ItemView extends View {
  contentEl: HTMLElement;
  private headerEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.headerEl = this.containerEl.createDiv({ cls: "view-header" });
    this.headerEl.createDiv({ cls: "view-header-title" });
    this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
  }

  addAction(_icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const a = this.headerEl.createEl("a", { cls: "view-action clickable-icon", text: title, attr: { "aria-label": title } });
    a.addEventListener("click", (e) => void callback(e));
    return a;
  }
}

export class WorkspaceLeaf extends Component {
  workspace: Workspace;
  area: Area;
  view: View | null = null;
  containerEl: HTMLElement;

  constructor(workspace: Workspace, area: Area) {
    super();
    this.workspace = workspace;
    this.area = area;
    this.containerEl = createDiv({ cls: "workspace-leaf" });
  }

  get isDeferred(): boolean { return false; }
  async loadIfDeferred(): Promise<void> {}

  async setViewState(state: ViewState): Promise<void> {
    const creator = this.workspace.app.viewRegistry.get(state.type);
    if (!creator) { console.warn(`[compat] no view registered for "${state.type}"`); return; }
    await this.open(creator(this));
    if (state.state) await this.view?.setState(state.state);
    if (state.active) this.workspace.setActiveLeaf(this);
  }

  getViewState(): ViewState { return { type: this.view?.getViewType() ?? "empty", state: this.view?.getState() ?? {} }; }

  async open(view: View): Promise<View> {
    await this.closeView();
    this.view = view;
    view.containerEl.setAttr("data-type", view.getViewType());
    this.containerEl.appendChild(view.containerEl);
    void view.load();
    await view.onOpen();
    this.workspace.refreshChrome();
    return view;
  }

  async openFile(file: TFile): Promise<void> {
    await this.open(new NoteView(this, file));
    this.workspace.setActiveLeaf(this);
  }

  getDisplayText(): string { return this.view?.getDisplayText() ?? "New tab"; }

  private async closeView(): Promise<void> {
    const v = this.view;
    if (!v) return;
    this.view = null;
    try { await v.onClose(); } catch (err) { console.error("[compat] view onClose threw", err); }
    v.unload();
    v.containerEl.remove();
  }

  detach(): void {
    void this.closeView().then(() => this.workspace.removeLeaf(this));
  }

  setPinned(_pinned: boolean): void {}
  togglePinned(): void {}
}

/** Why a Markdown note cannot be edited here. */
const READ_ONLY = "Read-only: Notes is off for this run (AOS_APP_WRITE). Files the runtime writes (brain/_index, brain/scripts) stay read-only.";
/** Why a note with other names on disk cannot be edited here (main refuses its saves: services/fs.ts hardLinked). */
const HARD_LINKED = "Read-only: this note has other names on disk (hard links), so an edit here would change them too.";

/** Why this note cannot be edited here, or null when it can. */
function editRefusal(abs: string): string | null {
  if (!canSave(abs)) return READ_ONLY;
  const st = bridge().fs.stat(abs);
  return st.ok && st.data.file && st.data.nlink > 1 ? HARD_LINKED : null;
}

const STATE_TEXT: Record<SaveState, string> = {
  saved: "saved", unsaved: "unsaved", saving: "saving…", conflict: "changed on disk", deleted: "deleted on disk", refused: "not saved",
};

/**
 * Stands in for Obsidian's editor: a vault file rendered to read, and a Markdown note edited in place with CodeMirror
 * (noteEditor.ts) when the Notes write surface allows its path. Show in Finder hands it to the OS.
 */
export class NoteView extends ItemView {
  file: TFile;
  navigation = true;
  editor: NoteEditor | null = null;
  private bodyEl: HTMLElement | null = null;
  private editBtn: HTMLButtonElement | null = null;
  private stateEl: HTMLElement | null = null;
  private conflictEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, file: TFile) { super(leaf); this.file = file; }

  getViewType(): string { return "markdown"; }
  getDisplayText(): string { return this.file.basename; }
  getIcon(): string { return "document"; }
  getState(): Record<string, unknown> { return { file: this.file.path, mode: this.editor ? "source" : "preview" }; }
  getMode(): "source" | "preview" { return this.editor ? "source" : "preview"; }

  private get abs(): string { return this.app.vault.adapter.getFullPath(this.file.path); }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("aos-note");
    const bar = root.createDiv({ cls: "aos-note-bar" });
    bar.createSpan({ cls: "aos-note-path", text: this.file.path });
    this.stateEl = bar.createSpan({ cls: "aos-note-state" });
    if (this.file.extension === "md") {
      this.editBtn = bar.createEl("button", { cls: "aos-note-btn aos-note-edit", text: "Edit" });
      this.editBtn.addEventListener("click", () => { void this.setMode(this.editor ? "read" : "edit"); });
    }
    const finder = bar.createEl("button", { cls: "aos-note-btn", text: "Show in Finder" });
    finder.addEventListener("click", () => { bridge().shell.showItemInFolder(this.abs); });
    this.conflictEl = root.createDiv({ cls: "aos-note-conflict" });
    this.bodyEl = root.createDiv({ cls: "aos-note-body" });

    // Follow the file: a change on disk re-renders it, or reaches the editor, which decides what it means.
    const mine = (f: { path: string }) => f.path === this.file.path;
    for (const ev of ["modify", "create", "delete"]) this.registerEvent(this.app.vault.on(ev, (f: { path: string }) => { if (mine(f)) void this.diskChanged(); }));
    this.registerEvent(this.app.workspace.on("write-policy-change", () => this.refreshEditButton()));
    this.registerDomEvent(window, "beforeunload", () => this.editor?.saveSync());
    this.refreshEditButton();
    await this.renderRead();
  }

  async onClose(): Promise<void> {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    try { await ed.save(); } finally { ed.destroy(); }
  }

  /** Switches between the rendered note and the editor. Leaving the editor saves first, and waits for a conflict. */
  async setMode(mode: "read" | "edit"): Promise<void> {
    if (mode === "edit") {
      if (this.editor || !this.bodyEl || this.file.extension !== "md") return;
      const no = editRefusal(this.abs);
      if (no) { new Notice(no); this.refreshEditButton(); return; }
      let text: string;
      try { text = await this.app.vault.adapter.read(this.file.path); }
      catch (err) { new Notice(`Cannot read ${this.file.path}: ${String(err)}`); return; }
      this.bodyEl.empty();
      this.contentEl.addClass("is-editing");
      this.editor = new NoteEditor(this.bodyEl, text, { abs: this.abs, rel: this.file.path, onState: (st) => this.showState(st) });
      this.showState("saved");
      this.refreshEditButton();
      this.editor.focus();
      return;
    }
    const ed = this.editor;
    if (!ed) return;
    await ed.save();
    if (ed.state !== "saved") { new Notice(`${this.file.path} has unsaved edits (${STATE_TEXT[ed.state]}): resolve them before leaving the editor.`); return; }
    this.editor = null;
    ed.destroy();
    this.contentEl.removeClass("is-editing");
    this.showState(null);
    this.refreshEditButton();
    await this.renderRead();
  }

  private refreshEditButton(): void {
    const btn = this.editBtn;
    if (!btn) return;
    if (this.editor) { btn.setText("Read"); btn.disabled = false; btn.title = "Back to the rendered note (saves first)"; return; }
    const no = editRefusal(this.abs);
    btn.setText("Edit");
    btn.disabled = !!no;
    btn.title = no ?? "Edit this note; it saves as you type, and on ⌘S";
  }

  private showState(st: SaveState | null): void {
    if (this.stateEl) {
      this.stateEl.setText(st ? STATE_TEXT[st] : "");
      this.stateEl.className = `aos-note-state${st ? ` is-${st}` : ""}`;
    }
    const box = this.conflictEl;
    if (!box) return;
    box.empty();
    box.toggleClass("is-shown", st === "conflict" || st === "deleted" || st === "refused");
    const ed = this.editor;
    if (!ed) return;
    const act = (text: string, fn: () => Promise<void>) => box.createEl("button", { cls: "aos-note-btn", text }).addEventListener("click", () => { void fn(); });
    if (st === "conflict") {
      box.createSpan({ text: "This note changed on disk while you had unsaved edits. Nothing was written." });
      act("Reload from disk", () => ed.reloadFromDisk());
      act("Keep mine", () => ed.keepMine());
    } else if (st === "deleted") {
      box.createSpan({ text: "This note was deleted on disk. Your text is still here." });
      act("Keep mine", () => ed.keepMine());
    } else if (st === "refused") {
      box.createSpan({ text: "Not saved: the Notes write surface is off for this run (AOS_APP_WRITE)." });
    }
  }

  private async diskChanged(): Promise<void> {
    if (this.editor) await this.editor.diskChanged();
    else await this.renderRead();
  }

  private async renderRead(): Promise<void> {
    const body = this.bodyEl;
    if (!body || this.editor) return;
    let text: string;
    try { text = await this.app.vault.read(this.file); }
    catch (err) { body.empty(); body.createDiv({ cls: "aos-note-error", text: `Cannot read ${this.file.path}: ${String(err)}` }); return; }
    if (this.editor) return; // the editor opened while the file was being read
    body.empty();
    if (this.file.extension === "md") await MarkdownRenderer.renderMarkdown(text, body, this.file.path, this);
    else body.createEl("pre", { cls: "aos-note-raw", text: text.length > 200_000 ? `${text.slice(0, 200_000)}\n…` : text });
  }
}

export class Workspace extends Events {
  app: App;
  layoutReady = false;
  activeLeaf: WorkspaceLeaf | null = null;
  containerEl: HTMLElement;
  private leaves: WorkspaceLeaf[] = [];
  private active: Record<Area, WorkspaceLeaf | null> = { main: null, split: null, right: null };
  private readyQueue: Array<() => unknown> = [];
  private tabbarEl: HTMLElement;
  private paneEls: Record<Area, HTMLElement>;
  private rightTabsEl: HTMLElement;
  private rightEl: HTMLElement;

  constructor(app: App, root: HTMLElement) {
    super();
    this.app = app;
    this.containerEl = root;
    root.addClass("aos-host-workspace");
    const main = root.createDiv({ cls: "aos-host-main" });
    this.tabbarEl = main.createDiv({ cls: "aos-host-tabbar" });
    const panes = main.createDiv({ cls: "aos-host-panes" });
    this.rightEl = root.createDiv({ cls: "aos-host-right is-empty" });
    this.rightTabsEl = this.rightEl.createDiv({ cls: "aos-host-tabbar is-right" });
    this.paneEls = {
      main: panes.createDiv({ cls: "aos-host-pane is-main" }),
      split: panes.createDiv({ cls: "aos-host-pane is-split is-empty" }),
      right: this.rightEl.createDiv({ cls: "aos-host-pane is-right" }),
    };
  }

  // ── layout ──────────────────────────────────────────────────────────

  onLayoutReady(cb: () => unknown): void {
    if (this.layoutReady) void cb();
    else this.readyQueue.push(cb);
  }

  /** The host calls this once the plugin has loaded, as Obsidian does after restoring its layout. */
  markLayoutReady(): void {
    if (this.layoutReady) return;
    this.layoutReady = true;
    for (const cb of this.readyQueue.splice(0)) {
      try { void cb(); } catch (err) { console.error("[compat] onLayoutReady callback threw", err); }
    }
    this.trigger("layout-ready");
  }

  // ── leaves ──────────────────────────────────────────────────────────

  private createLeaf(area: Area): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this, area);
    this.leaves.push(leaf);
    this.paneEls[area].appendChild(leaf.containerEl);
    void leaf.load();
    this.setActiveLeaf(leaf);
    return leaf;
  }

  getLeaf(newLeaf?: boolean | "tab" | "split" | "window", _direction?: "vertical" | "horizontal"): WorkspaceLeaf {
    if (newLeaf === "split") return this.createLeaf("split");
    if (newLeaf === true || newLeaf === "tab" || newLeaf === "window") return this.createLeaf("main");
    // Reuse the active main leaf only when it holds a note (Obsidian's "navigable" views); never replace the Workbench.
    const current = this.active.main;
    if (current?.view?.navigation) return current;
    return this.createLeaf("main");
  }

  getRightLeaf(_split: boolean): WorkspaceLeaf { return this.createLeaf("right"); }
  getLeftLeaf(_split: boolean): WorkspaceLeaf { return this.createLeaf("right"); }

  getLeavesOfType(type: string): WorkspaceLeaf[] { return this.leaves.filter((l) => l.view?.getViewType() === type); }

  getActiveViewOfType<T extends View>(type: new (...args: any[]) => T): T | null {
    const v = this.activeLeaf?.view;
    return v instanceof type ? v : null;
  }

  iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void { for (const l of [...this.leaves]) cb(l); }

  detachLeavesOfType(type: string): void { for (const l of this.getLeavesOfType(type)) l.detach(); }

  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> { this.setActiveLeaf(leaf); }

  setActiveLeaf(leaf: WorkspaceLeaf, _params?: unknown): void {
    this.active[leaf.area] = leaf;
    this.activeLeaf = leaf;
    this.refreshChrome();
    this.trigger("active-leaf-change", leaf);
  }

  /** Called by WorkspaceLeaf.detach once its view has closed. */
  removeLeaf(leaf: WorkspaceLeaf): void {
    this.leaves = this.leaves.filter((l) => l !== leaf);
    leaf.containerEl.remove();
    leaf.unload();
    if (this.active[leaf.area] === leaf) {
      const rest = this.leaves.filter((l) => l.area === leaf.area);
      this.active[leaf.area] = rest[rest.length - 1] ?? null;
    }
    if (this.activeLeaf === leaf) this.activeLeaf = this.active.main ?? this.active.right;
    this.refreshChrome();
    this.trigger("layout-change");
  }

  async openLinkText(linktext: string, sourcePath: string, newLeaf?: boolean | "tab" | "split"): Promise<void> {
    const file = this.resolveLink(linktext, sourcePath);
    if (!file) { new Notice(`Cannot find "${linktext}" in the vault`); return; }
    const leaf = this.getLeaf(newLeaf === true ? "tab" : newLeaf || false);
    await leaf.openFile(file);
  }

  /** Obsidian's link resolution: an exact path, the path plus .md, relative to the source note, then by basename. */
  resolveLink(linktext: string, sourcePath = ""): TFile | null {
    const target = linktext.split("|")[0].split("#")[0].trim();
    if (!target) return sourcePath ? this.app.vault.getFileByPath(sourcePath) : null;
    const tries = [target, `${target}.md`];
    const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    if (dir) tries.push(`${dir}/${target}`, `${dir}/${target}.md`);
    for (const t of tries) {
      const f = this.app.vault.getFileByPath(normalizePath(t));
      if (f) return f;
    }
    const want = target.toLowerCase().replace(/\.md$/, "");
    const hits = this.app.vault.getMarkdownFiles().filter((f) => f.basename.toLowerCase() === want || f.path.toLowerCase().endsWith(`/${want}.md`));
    hits.sort((a, b) => a.path.length - b.path.length);
    return hits[0] ?? null;
  }

  // ── chrome ──────────────────────────────────────────────────────────

  refreshChrome(): void {
    for (const area of ["main", "split", "right"] as Area[]) {
      const inArea = this.leaves.filter((l) => l.area === area);
      for (const l of inArea) l.containerEl.toggleClass("is-active", l === this.active[area]);
      const pane = this.paneEls[area];
      pane.toggleClass("is-empty", inArea.length === 0);
    }
    this.rightEl.toggleClass("is-empty", !this.leaves.some((l) => l.area === "right"));
    this.renderTabs(this.tabbarEl, [...this.leaves.filter((l) => l.area === "main"), ...this.leaves.filter((l) => l.area === "split")]);
    this.renderTabs(this.rightTabsEl, this.leaves.filter((l) => l.area === "right"));
  }

  private renderTabs(bar: HTMLElement, leaves: WorkspaceLeaf[]): void {
    bar.empty();
    for (const leaf of leaves) {
      const tab = bar.createDiv({ cls: "aos-host-tab", attr: { role: "tab", tabindex: "0" } });
      tab.toggleClass("is-active", this.active[leaf.area] === leaf);
      if (leaf.area === "split") tab.addClass("is-split");
      tab.createSpan({ cls: "aos-host-tab-title", text: leaf.getDisplayText() });
      const close = tab.createSpan({ cls: "aos-host-tab-close", text: "✕", attr: { "aria-label": "Close tab" } });
      close.addEventListener("click", (e) => { e.stopPropagation(); leaf.detach(); });
      tab.addEventListener("click", () => this.setActiveLeaf(leaf));
    }
  }
}
