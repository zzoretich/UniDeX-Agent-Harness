// PreviewPane.ts — the right pane while Files is open (spaces-redesign D9): the file's name and badge, its map
// description with ↻ (off under provider `none`, D33), Open, Copy path, Reveal in Finder, and the first part of the file
// (a Markdown file rendered, as the approved Files frame shows it; anything else as text).
import * as path from "path";
import type { WorkspaceEntry } from "../../data/snapshot";
import { FILE_BADGE_LABEL, NOT_MAPPED_TEXT, UNDESCRIBED_TEXT, describeDisabledReason, fileBadge } from "../../data/workspaceMaps";
import { mapSkipReason, MAP_SKIP_TEXT, type PreviewResult } from "../../data/workspaceFiles";
import { button, entryAbs, mappable, HIDDEN_MAP_TEXT, type SpacesCtx } from "./ui";

const kb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function renderPreview(host: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry): void {
  const rel = ctx.ui.files.preview;
  const sec = host.createEl("section", { cls: "aos-spc-preview", attr: { "aria-label": "Preview" } });
  if (!rel) { sec.createDiv({ cls: "aos-spc-empty", text: "Select a file to preview it here." }); return; }
  const abs = path.join(entryAbs(e, ctx.vault), rel);
  const f = ctx.index.files.get(rel) ?? null;
  // The listing's size, as the tree row reads it (mergeDir), so a file over 1 MB is "not mapped" in both places (D9).
  const dir = path.posix.dirname(rel);
  const size = ctx.listings.get(dir === "." ? "" : dir)?.find((d) => d.name === path.posix.basename(rel))?.size;
  const skip = f ? null : mapSkipReason(rel, size);

  const head = sec.createDiv({ cls: "aos-spc-prevhead" });
  const top = head.createDiv({ cls: "aos-spc-prevtop" });
  top.createSpan({ cls: "aos-spc-prevname", text: rel, attr: { title: abs } });
  const badge = f ? fileBadge(f) : skip ? null : "new";
  if (badge) top.createSpan({ cls: `aos-spc-badge is-${badge}`, text: FILE_BADGE_LABEL[badge] });

  const desc = head.createDiv({ cls: "aos-spc-prevdesc" });
  desc.createSpan({
    cls: `aos-spc-prevdesctext${f?.desc ? "" : " is-empty"}`,
    text: f?.desc ?? (skip ? NOT_MAPPED_TEXT : UNDESCRIBED_TEXT),
    attr: skip ? { title: MAP_SKIP_TEXT[skip] } : {},
  });
  if (f) {
    const off = !mappable(e) ? HIDDEN_MAP_TEXT : describeDisabledReason(ctx.provider);
    const re = button(desc, "aos-spc-iconbtn aos-spc-redesc", null, { key: "prev-redesc", label: "Describe this file again", title: off ?? "Describe this file again", disabled: !!off });
    ctx.setIcon(re, "refresh-cw");
    re.addEventListener("click", () => ctx.act.describeFile(rel));
    if (off) desc.createDiv({ cls: "aos-spc-why", text: off });
  }

  const acts = head.createDiv({ cls: "aos-spc-prevacts" });
  button(acts, "aos-spc-btn aos-spc-small", "Open", { key: "prev-open", title: "Open with the system's app" }).addEventListener("click", () => ctx.act.openPath(abs));
  button(acts, "aos-spc-btn aos-spc-small", "Copy path", { key: "prev-copy", title: abs }).addEventListener("click", () => ctx.act.copy(abs));
  button(acts, "aos-spc-btn aos-spc-small", "Reveal in Finder", { key: "prev-reveal" }).addEventListener("click", () => ctx.act.revealInFinder(abs));

  const body = sec.createDiv({ cls: "aos-spc-prevbody", attr: { "data-spc-scroll": "preview" } });
  const show = (res: PreviewResult): void => {
    body.empty();
    if (res.kind === "empty") { body.createDiv({ cls: "aos-spc-empty", text: "Empty file." }); return; }
    if (res.kind === "binary") { body.createDiv({ cls: "aos-spc-empty", text: `Binary file, ${kb(res.size)}.` }); return; }
    if (res.truncated) body.createDiv({ cls: "aos-spc-why", text: `Showing the first part of ${kb(res.size)}.` });
    if (/\.(md|markdown)$/i.test(rel)) ctx.renderMarkdown(body.createDiv({ cls: "aos-spc-md" }), res.text ?? "", `${e.path}/${rel}`);
    else body.createEl("pre", { cls: "aos-spc-pre", text: res.text ?? "" });
  };
  // The last read of this file is drawn at once, so a redraw puts the reader back where they were (keepPlace restores
  // the scroll onto the real text, not onto a short "Reading…"); the read below only replaces it when the file changed.
  const cached = ctx.cachedPreview(abs);
  if (cached) show(cached);
  else body.createDiv({ cls: "aos-spc-empty", text: "Reading…" });
  void ctx.act.readPreview(abs).then(
    (res) => {
      if (!body.isConnected || ctx.ui.files.preview !== rel) return;   // a newer draw or another file
      if (cached && samePreview(cached, res)) return;
      show(res);
    },
    () => {
      if (!body.isConnected) return;
      body.empty();
      body.createDiv({ cls: "aos-spc-empty", text: "This file cannot be read." });
    },
  );
}

function samePreview(a: PreviewResult, b: PreviewResult): boolean {
  return a.kind === b.kind && a.size === b.size && a.text === b.text && !!a.truncated === !!b.truncated;
}
