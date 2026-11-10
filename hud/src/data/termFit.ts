// What the terminal panel keys its fit on (code-chat R51): a terminal under the chat is refitted only when something that
// changes its cells or its room did. DOM-free, so a unit test pins it.

export interface FitFrame { clientWidth: number; clientHeight: number }
export interface FitFont { fontSize?: number; fontFamily?: string }

/** A frame with no width or no height (a tab hidden, a pane collapsed) has nothing to fit to: the last size stays. */
export function frameUnsized(frame: FitFrame | null | undefined): boolean {
  return !!frame && (!frame.clientWidth || !frame.clientHeight);
}

/** The frame's size and the cell's (font size and family, and the screen's pixel ratio, which a zoom changes): a fit made
 *  at one key is not one at another. */
export function fitKey(frame: FitFrame | null | undefined, font: FitFont, pixelRatio: number): string | undefined {
  if (!frame) return undefined;
  return `${frame.clientWidth}x${frame.clientHeight}@${font.fontSize ?? ""}/${font.fontFamily ?? ""}/${pixelRatio}`;
}
