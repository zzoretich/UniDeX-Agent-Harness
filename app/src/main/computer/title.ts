// Session names main hands out (session-browser S22).

/** Text from a page as one line: line breaks (NEL, line and paragraph separators too) become spaces, every other control, the
 *  C1 controls and the direction marks go, runs of spaces fold, and the ends are trimmed. Shared by session titles and by
 *  computer_console, whose lines are page text. */
export function oneLine(raw: string): string {
  return raw.replace(/[\t\n\r\v\f\u0085\u2028\u2029]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/ +/g, " ").trim();
}

/** A Code session's title as the app's own cards may show it (session-browser S6): tabs and line breaks become spaces,
 *  every other control and the direction marks go, runs of spaces fold, and it is cut at 60. */
export function cleanTitle(raw: string): string {
  const cut = oneLine(raw).slice(0, 60);
  // Never end on half of a surrogate pair, nor on the space the cut left.
  return (/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}

export const TAG_MAX = 24;

/** The string with every lone surrogate dropped: `encodeURIComponent` throws on one. */
export const wellFormed = (s: string): string => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");

/** A spinner or status mark in front of a name: one or two characters that are neither letters, digits nor white space, then
 *  white space and something more. The hosts put one before a Code session's title and change it several times a second. */
const LEADING_MARK = /^[^\p{L}\p{N}\s]{1,2}\s+(?=\S)/u;

/** The session's name as the tag shows it: scrubbed like a title, without one leading spinner mark (nothing is dropped when
 *  nothing would remain), well formed, at most 24 characters counting the closing "…". */
export function tagText(name: string): string {
  const t = wellFormed(cleanTitle(name)).replace(LEADING_MARK, "");
  if (t.length <= TAG_MAX) return t;
  let cut = t.slice(0, TAG_MAX - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);   // never half of a surrogate pair
  return `${cut.trimEnd()}…`;
}

