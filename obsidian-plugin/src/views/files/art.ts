// Files' drawn art (files-finder D3, D7): the graphite folder with its kind tab, and the page a note shows in Icons
// with its first lines drawn as bars. Colours come from styles.css (.aos-fx-art-*), so both themes follow the tokens.

import { tintOf } from "../../data/filesModel";

const FOLDER_BACK = "M2 7a5 5 0 0 1 5-5h14.5a4 4 0 0 1 2.9 1.2L28 7h29a5 5 0 0 1 5 5v33a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5z";
const FOLDER_FRONT = "M2 15a4 4 0 0 1 4-4h52a4 4 0 0 1 4 4v30a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5z";
const PAGE = "M5 1.5h27L46.5 16v40a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 56V4A2.5 2.5 0 0 1 5 1.5z";
const PAGE_FOLD = "M32 1.5V13a3 3 0 0 0 3 3h11.5";

/** A folder, `size` px wide; the kind tab when the path is under a tinted top folder. */
export function folderArt(host: HTMLElement, path: string, size: number): SVGSVGElement {
  const svg = host.createSvg("svg", { cls: "aos-fx-art aos-fx-art-folder", attr: { viewBox: "0 0 64 52", width: size, height: Math.round(size * 52 / 64), "aria-hidden": "true" } });
  svg.createSvg("path", { cls: "aos-fx-art-back", attr: { d: FOLDER_BACK } });
  svg.createSvg("path", { cls: "aos-fx-art-front", attr: { d: FOLDER_FRONT } });
  const tint = tintOf(path);
  if (tint) svg.createSvg("rect", { cls: `aos-fx-art-tab is-${tint}`, attr: { x: 8, y: 40, width: 16, height: 5, rx: 2.5 } });
  return svg;
}

/**
 * A page, `size` px tall. `lines` are the note's first lines' lengths (vaultIndex), drawn as bars, the first darker
 * like a heading; none known yet, an empty page. `label` (MD, JSON, PNG…) sits at its foot.
 */
export function pageArt(host: HTMLElement, lines: readonly number[] | null, label: string, size: number): SVGSVGElement {
  const svg = host.createSvg("svg", { cls: "aos-fx-art aos-fx-art-page", attr: { viewBox: "0 0 48 60", width: Math.round(size * 48 / 60), height: size, "aria-hidden": "true" } });
  svg.createSvg("path", { cls: "aos-fx-art-sheet", attr: { d: PAGE } });
  svg.createSvg("path", { cls: "aos-fx-art-fold", attr: { d: PAGE_FOLD } });
  (lines ?? []).slice(0, 6).forEach((len, i) => {
    const w = Math.max(4, Math.round((len / 48) * 32));
    svg.createSvg("rect", { cls: i === 0 ? "aos-fx-art-head" : "aos-fx-art-ink", attr: { x: 8, y: i === 0 ? 10 : 14 + i * 5, width: w, height: i === 0 ? 3 : 2, rx: 1 } });
  });
  if (label) svg.createSvg("text", { cls: "aos-fx-art-label", attr: { x: 8, y: 53 } }).textContent = label.slice(0, 4);
  return svg;
}
