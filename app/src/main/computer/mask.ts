// Screenshot masks for password fields and cross-site frames (agent-computer D9): the browser reads each box in CSS
// pixels (DOM.getBoxModel), `screenScale` reads the capture's scale against the page's CSS viewport, `deviceRects` turns
// the boxes into the capture's device pixels, and `paintRects` paints over them on the bitmap before the image is scaled
// to CSS pixels (the space clicks use) and leaves main. Pure, so the pixel arithmetic is tested without a page.

export interface Rect { x: number; y: number; width: number; height: number }

/** The mask colour, a mid grey: the same in BGRA and RGBA, so it does not depend on the bitmap's channel order. */
export const MASK_BGRA: readonly number[] = [0x6e, 0x6e, 0x6e, 0xff];

/**
 * CSS-pixel rects, relative to the layout viewport, as device-pixel rects in a viewport screenshot. `viewport` is the
 * visible part in CSS pixels; one CSS pixel is `dpr * zoom` device pixels (agent-computer D9: a 2x display at 125 %
 * page zoom is 2.5). Rects are clipped to the viewport, rounded outwards, and dropped when nothing of them shows.
 */
export function deviceRects(css: Rect[], o: { dpr: number; zoom: number; viewport: Rect }): Rect[] {
  const s = o.dpr * o.zoom;
  const out: Rect[] = [];
  for (const r of css) {
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) continue;
    const x0 = Math.max(r.x - o.viewport.x, 0);
    const y0 = Math.max(r.y - o.viewport.y, 0);
    const x1 = Math.min(r.x + r.width - o.viewport.x, o.viewport.width);
    const y1 = Math.min(r.y + r.height - o.viewport.y, o.viewport.height);
    if (x1 <= x0 || y1 <= y0) continue;
    const left = Math.floor(x0 * s);
    const top = Math.floor(y0 * s);
    out.push({ x: left, y: top, width: Math.ceil(x1 * s) - left, height: Math.ceil(y1 * s) - top });
  }
  return out;
}

/** A copy of a 32-bit bitmap (`width` x `height`, four bytes a pixel) with every rect painted in `MASK_BGRA`. */
export function paintRects(bgra: Buffer, width: number, height: number, rects: Rect[]): Buffer {
  if (bgra.length !== width * height * 4) throw new Error(`The bitmap is ${bgra.length} bytes, not ${width}x${height}x4.`);
  const out = Buffer.from(bgra);
  const px = Buffer.from(MASK_BGRA);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(width, Math.ceil(r.x + r.width));
    const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px.copy(out, (y * width + x) * 4);
  }
  return out;
}

// The most a classic scrollbar adds to the capture beyond the CSS client size, in device-independent pixels.
const SCROLLBAR_DIP = 24;

/**
 * The capture's scale, from its size against the page's CSS viewport (`Page.getLayoutMetrics().cssVisualViewport`:
 * client size without scrollbars, page zoom, pinch scale): one CSS pixel is `dpr * zoom` capture pixels, and
 * `width` x `height` is the capture in CSS pixels. Null when the two disagree (the view resized between the capture and
 * the metrics, or a pinch zoom), so the caller refuses the screenshot rather than paint masks in the wrong place.
 */
export function screenScale(png: { width: number; height: number }, css: { width: number; height: number; zoom: number; scale?: number }): { dpr: number; zoom: number; width: number; height: number } | null {
  if (!(css.width > 0 && css.height > 0 && css.zoom > 0 && png.width > 0 && png.height > 0) || (css.scale ?? 1) !== 1) return null;
  const dpr = Math.round(png.width / (css.width * css.zoom));
  if (dpr < 1) return null;
  const s = dpr * css.zoom;
  const width = png.width / s, height = png.height / s;
  const slack = SCROLLBAR_DIP / css.zoom + 1;
  const fits = (got: number, want: number): boolean => got >= want - 1 && got <= want + slack;
  if (!fits(width, css.width) || !fits(height, css.height)) return null;
  return { dpr, zoom: css.zoom, width: Math.round(width), height: Math.round(height) };
}
