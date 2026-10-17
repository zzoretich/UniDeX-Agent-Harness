// Quick Look (files-finder D11): Space shows the item over the tab without opening it. A note rendered, a text file
// as mono, an image fitted, a folder's art and count, anything else its icon and Open with default app. ← → go through
// the view's order, ⌘↓ opens, Space or Esc closes. PDFs are not drawn inline (the CSP has object-src 'none'). From a
// search hit it opens at the hit's line (D22).

import { blockAtLine, itemsLabel, kindLabel, kindOf, sizeLabel } from "../../data/filesModel";
import { folderArt, pageArt } from "./art";
import type { PreviewDeps } from "./Preview";

/** The most of a text file Quick Look draws. */
const QL_CHARS = 200_000;

export class QuickLook {
  private el: HTMLElement | null = null;
  private order: string[] = [];
  private at = -1;
  private seq = 0;
  /** The line to show of the item it opened on (a search hit's, 1-based). */
  private line: { path: string; line: number } | null = null;

  constructor(private host: HTMLElement, private deps: PreviewDeps & { reveal(path: string): void; onClose(path: string | null): void }) {}

  isOpen(): boolean { return this.el !== null; }
  current(): string | null { return this.at >= 0 ? this.order[this.at] ?? null : null; }

  /** Shows `path`, at `line` of it when given; `order` is the view's, for ← →. */
  show(path: string, order: readonly string[], line?: number): void {
    this.order = order.includes(path) ? [...order] : [path];
    this.at = this.order.indexOf(path);
    this.line = line ? { path, line } : null;
    this.draw();
  }

  step(delta: number): void {
    if (!this.el || this.order.length < 2) return;
    this.line = null;
    this.at = (this.at + delta + this.order.length) % this.order.length;
    this.draw();
  }

  /** Takes it away without telling anyone: the tab is being drawn again or put away. */
  dispose(): void {
    this.el?.remove();
    this.el = null;
    this.order = [];
    this.at = -1;
  }

  /** Closes it and hands the item it last showed to onClose; closed already, nothing happens. */
  close(): void {
    if (!this.el) return;
    const last = this.current();
    this.el.remove();
    this.el = null;
    this.order = [];
    this.at = -1;
    this.deps.onClose(last);
  }

  private draw(): void {
    const path = this.current();
    const { ctx } = this.deps;
    const item = path ? ctx.item(path) : null;
    if (!path || !item) { this.close(); return; }
    const id = ++this.seq;
    const live = () => this.el !== null && this.seq === id;
    this.el?.remove();
    const scrim = this.host.createDiv({ cls: "aos-fx-ql" });
    this.el = scrim;
    scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) { e.preventDefault(); this.close(); } });
    const panel = scrim.createEl("section", { cls: "aos-fx-qlpanel", attr: { role: "dialog", "aria-modal": "true", "aria-label": `Quick Look: ${item.name}`, tabindex: "-1" } });

    const bar = panel.createDiv({ cls: "aos-fx-qlbar" });
    const close = bar.createEl("button", { cls: "aos-fx-iconbtn", attr: { type: "button", "aria-label": "Close (Esc)", "data-act": "close" } });
    ctx.setIcon(close, "x");
    close.addEventListener("click", () => this.close());
    bar.createDiv({ cls: "aos-fx-qltitle", text: item.name, attr: { title: item.path } });
    if (this.order.length > 1) bar.createSpan({ cls: "aos-fx-qlpos", text: `${this.at + 1} of ${this.order.length}` });
    const reveal = bar.createEl("button", { cls: "aos-fx-btn", text: "Reveal in Finder", attr: { type: "button", "data-act": "reveal" } });
    reveal.addEventListener("click", () => this.deps.reveal(path));
    const open = bar.createEl("button", { cls: "aos-fx-btn is-primary", text: item.folder ? "Open" : kindOf(item) === "note" || kindOf(item) === "text" ? "Open" : "Open with default app", attr: { type: "button", "data-act": "open" } });
    open.addEventListener("click", () => { this.close(); this.deps.open(path); });

    const body = panel.createDiv({ cls: `aos-fx-qlbody is-${kindOf(item)}` });
    const kind = kindOf(item);
    if (kind === "note" || kind === "text") {
      void this.deps.readText(path).then((text) => {
        if (!live()) return;
        if (text === null) { body.createDiv({ cls: "aos-fx-empty", text: "Could not read this file." }); return; }
        const t = text.length > QL_CHARS ? `${text.slice(0, QL_CHARS)}\n…` : text;
        if (kind === "note") this.deps.renderMarkdown(body.createDiv({ cls: "aos-fx-md" }), t, path);
        else body.createEl("pre", { cls: "aos-fx-pre", text: t });
        const at = this.line?.path === path ? this.line.line : null;
        if (at !== null) window.requestAnimationFrame(() => { if (live()) showLine(body, at); });
      });
    } else if (kind === "image") {
      void this.deps.readImage(path).then((url) => {
        if (!live()) return;
        if (url) body.createEl("img", { cls: "aos-fx-qlimg", attr: { src: url, alt: item.name } });
        else this.other(body, item.ext, `${kindLabel(item)} · ${sizeLabel(item.size)}`, "Too large to show here.");
      });
    } else if (item.folder) {
      const f = body.createDiv({ cls: "aos-fx-qlother" });
      folderArt(f, item.path, 128);
      f.createDiv({ cls: "aos-fx-pkind", text: itemsLabel(ctx.count(item.path)) });
    } else this.other(body, item.ext, `${kindLabel(item)} · ${sizeLabel(item.size)}`, null);

    const foot = panel.createDiv({ cls: "aos-fx-qlfoot" });
    foot.createSpan({ text: "← → previous and next · ⌘↓ open · Space or Esc closes" });
    foot.createSpan({ cls: "aos-fx-mono", text: item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : ctx.vaultName });
    panel.focus();
  }

  private other(body: HTMLElement, ext: string, line: string, note: string | null): void {
    const f = body.createDiv({ cls: "aos-fx-qlother" });
    pageArt(f, null, ext.toUpperCase(), 128);
    f.createDiv({ cls: "aos-fx-pkind", text: line });
    if (note) f.createDiv({ cls: "aos-fx-dim", text: note });
  }
}

/**
 * Shows `line` (1-based) of what Quick Look drew, marked: the line itself in a text file, or the rendered block it falls
 * in (the app's renderer marks each block with the line it starts on; Obsidian's does not, and the note stays at its top).
 */
function showLine(body: HTMLElement, line: number): void {
  let at: HTMLElement | null = null;
  const pre = body.querySelector<HTMLElement>("pre.aos-fx-pre");
  if (pre) {
    const text = pre.textContent ?? "";
    const lines = text.split("\n");
    if (line > lines.length) return;
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    pre.empty();
    pre.appendText(text.slice(0, start));
    at = pre.createEl("mark", { cls: "aos-fx-qlat", text: lines[line - 1] || " " });
    pre.appendText(text.slice(start + lines[line - 1].length));
  } else {
    const blocks = Array.from(body.querySelectorAll<HTMLElement>("[data-line]"));
    const i = blockAtLine(blocks.map((b) => Number(b.dataset.line)), line);
    if (i === null) return;
    at = blocks[i];
    at.addClass("aos-fx-qlat");
  }
  at.setAttr("data-at-line", String(line));
  at.scrollIntoView({ block: "center" });
}
