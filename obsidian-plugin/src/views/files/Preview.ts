// The preview (files-finder D10): Columns' last column, and the ⇧⌘P pane in Icons and List. The first part of a note
// rendered, a text file's first lines, an image, a folder's art; then what it is, its size and dates, its tags and
// links (the vault index, D18) and where it is; then Open, Quick Look and ⋯.

import { dateLabel, itemsLabel, kindLabel, kindOf, sizeLabel } from "../../data/filesModel";
import { folderArt, pageArt } from "./art";
import type { FilesCtx } from "./ctx";

/** What the preview and Quick Look need from the tab beyond the view context. */
export interface PreviewDeps {
  ctx: FilesCtx;
  /** A file's text (vaultFiles' shared cache), null when it cannot be read. */
  readText(path: string): Promise<string | null>;
  /** An image as a data: URL (the CSP's img-src allows data:), null when it is too big or cannot be read. */
  readImage(path: string): Promise<string | null>;
  /** compat's MarkdownRenderer (sanitized, raw HTML escaped), relative links resolved from `path`. */
  renderMarkdown(el: HTMLElement, text: string, path: string): void;
  open(path: string): void;
  quickLook(path: string): void;
  menu(path: string, e: MouseEvent): void;
}

const FRONTMATTER_RE = /^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
/** How much of a note the preview renders: enough for its head, never a whole long file. */
const PREVIEW_CHARS = 2400;
const PREVIEW_LINES = 40;

/** The latest preview drawn into each host, so a slow read never lands on a newer one. */
const latest = new WeakMap<HTMLElement, number>();
let seq = 0;

export function renderPreview(host: HTMLElement, path: string, deps: PreviewDeps): void {
  const { ctx } = deps;
  const item = ctx.item(path);
  host.addClass("aos-fx-preview");
  if (!item) { host.createDiv({ cls: "aos-fx-empty", text: "Select a file to preview it here." }); return; }
  const id = ++seq;
  latest.set(host, id);
  const live = () => host.isConnected && latest.get(host) === id;
  const kind = kindOf(item);

  const look = host.createDiv({ cls: `aos-fx-plook is-${kind}` });
  if (item.folder) folderArt(look, item.path, 96);
  else if (kind === "note" || kind === "text") {
    const sheet = look.createDiv({ cls: "aos-fx-sheet" });
    void deps.readText(path).then((text) => {
      if (!live()) return;
      if (text === null) { sheet.setText("Could not read this file."); return; }
      if (kind === "note") {
        const body = text.replace(FRONTMATTER_RE, "").slice(0, PREVIEW_CHARS);
        deps.renderMarkdown(sheet.createDiv({ cls: "aos-fx-md" }), body, path);
      } else {
        sheet.createEl("pre", { cls: "aos-fx-pre", text: text.split(/\r?\n/).slice(0, PREVIEW_LINES).join("\n") });
      }
    });
  } else if (kind === "image") {
    const frame = look.createDiv({ cls: "aos-fx-pimg" });
    void deps.readImage(path).then((url) => {
      if (!live()) return;
      if (url) frame.createEl("img", { attr: { src: url, alt: item.name } });
      else pageArt(frame, null, item.ext.toUpperCase(), 96);
    });
  } else pageArt(look, null, item.ext.toUpperCase(), 96);

  const title = host.createDiv({ cls: "aos-fx-ptitle" });
  title.createDiv({ cls: "aos-fx-pname", text: item.name });
  title.createDiv({ cls: "aos-fx-pkind", text: item.folder ? `Folder · ${itemsLabel(ctx.count(item.path))}` : `${kindLabel(item)} · ${sizeLabel(item.size)}` });

  const dl = host.createEl("dl", { cls: "aos-fx-info" });
  const row = (k: string, fill: (dd: HTMLElement) => void) => {
    const r = dl.createDiv({ cls: "aos-fx-kv" });
    r.createEl("dt", { text: k });
    fill(r.createEl("dd"));
  };
  if (!item.folder) {
    row("Modified", (dd) => dd.setText(dateLabel(item.mtime, ctx.now)));
    row("Created", (dd) => dd.setText(dateLabel(item.ctime, ctx.now)));
  }
  if (kind === "note") {
    const facts = ctx.index?.notes.get(path);
    row("Tags", (dd) => {
      if (!ctx.index) { dd.setText("…"); dd.setAttr("title", "Reading the vault…"); return; }
      if (!facts?.tags.length) { dd.addClass("is-dim"); dd.setText("None"); return; }
      for (const t of facts.tags) dd.createSpan({ cls: "aos-fx-chip", text: t });
    });
    row("Links", (dd) => {
      if (!ctx.index) { dd.setText("…"); dd.setAttr("title", "Reading the vault…"); return; }
      const out = facts?.out.length ?? 0;
      const inn = ctx.index.backlinks.get(path)?.length ?? 0;
      dd.setText(`${out} out · ${inn} in`);
      dd.setAttr("data-links", `${out}:${inn}`);
    });
  } else if (kind !== "folder" && ctx.index?.backlinks.get(path)?.length) {
    row("Linked from", (dd) => dd.setText(String(ctx.index!.backlinks.get(path)!.length)));
  }
  row("Where", (dd) => { dd.addClass("aos-fx-mono"); dd.setText(item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : `${ctx.vaultName} (the vault)`); });

  const acts = host.createDiv({ cls: "aos-fx-pacts" });
  const open = acts.createEl("button", { cls: "aos-fx-btn is-primary", text: "Open", attr: { type: "button", "data-act": "open" } });
  open.addEventListener("click", () => deps.open(path));
  if (!item.folder) {
    const ql = acts.createEl("button", { cls: "aos-fx-btn", text: "Quick Look", attr: { type: "button", "data-act": "quicklook", title: "Quick Look (Space)" } });
    ql.addEventListener("click", () => deps.quickLook(path));
  }
  const more = acts.createEl("button", { cls: "aos-fx-btn aos-fx-iconbtn", attr: { type: "button", "aria-label": "More actions", "data-act": "more" } });
  ctx.setIcon(more, "ellipsis");
  more.addEventListener("click", (e) => deps.menu(path, e));
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

/** Bytes as a data: URL of the image type `ext` names; null for a type that is not an image. */
export function toDataUrl(bytes: ArrayBuffer, ext: string): string | null {
  const mime = MIME[ext];
  if (!mime) return null;
  const u8 = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}
