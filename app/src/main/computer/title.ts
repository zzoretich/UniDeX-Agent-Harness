// Session names main hands out (session-browser S22).

/** A Code session's title as the app's own cards may show it (session-browser S6): tabs and line breaks become spaces,
 *  every other control and the direction marks go, runs of spaces fold, and it is cut at 60. */
export function cleanTitle(raw: string): string {
  const t = raw.replace(/[\t\n\r\v\f\u0085\u2028\u2029]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/ +/g, " ").trim();
  const cut = t.slice(0, 60);
  // Never end on half of a surrogate pair, nor on the space the cut left.
  return (/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}
