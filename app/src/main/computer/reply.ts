// What an acting computer tool answers with (session-browser S16, Task 19): its one-line result, then the page as it is now,
// so the agent does not call computer_snapshot after every action. No Electron.

/** The most characters of the page's outline an acting tool's reply carries. */
export const OUTLINE_MAX = 8000;
/** After the last input of an action the browser waits this long for a navigation to start (browser.ts `settled`). */
export const SETTLE_WINDOW_MS = 300;
/** ... and, when one started, for it to load, this long at the most counting from the same moment. */
export const SETTLE_MAX_MS = 5000;
/** The app's own sentence after a cut outline. */
export const MORE = "(The page goes on: computer_snapshot has the rest.)";
/** The reply's ending when the action ran but the page could not be read afterwards (the browser went off, to sleep or
 *  away meanwhile). Not an error: the action happened. */
export const UNREAD = "The page could not be read afterwards: call computer_status to see where things stand.";

const CLOSE = "</untrusted-page>";

/** Cuts `s` to at most `max` characters at its last line break; a text with no line break is cut at `max`. */
function atLineBreak(s: string, max: number): string {
  if (s.length <= max) return s;
  const i = s.lastIndexOf("\n", max);
  return s.slice(0, i > 0 ? i : max);
}

/**
 * `line`, a blank line, "Page now:", then the outline. A plain outline is cut at the last line break within 8,000 characters
 * and followed by MORE when it was cut. A snapshot is page text the browser already wrapped as untrusted (D21) and cut
 * itself, at its cap, on the page's own lines (`snapshot(…, { cap })`): `withPage` never cuts such a text again (a second cut
 * could break the opening part or the closing tag); it only puts MORE, the app's own sentence, after the wrapper when `cut`
 * says the browser cut it.
 */
export function withPage(line: string, outline: string, o: { cut?: boolean } = {}): string {
  const head = `${line}\n\nPage now:\n`;
  const wrapped = outline.startsWith("<untrusted-page") && outline.endsWith(`\n${CLOSE}`);
  let cut = o.cut === true;
  let shown = outline;
  if (!wrapped && outline.length > OUTLINE_MAX) {
    cut = true;
    shown = atLineBreak(outline, OUTLINE_MAX);
  }
  return `${head}${shown}${cut ? `\n${MORE}` : ""}`;
}
