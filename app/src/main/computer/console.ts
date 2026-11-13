// What a tab's page said about itself since it loaded (session-browser, computer_console): the newest errors, warnings,
// uncaught exceptions and failed requests, as text for an agent. Pure: no Electron. Every word of it is PAGE TEXT from a page
// that may be hostile. Order of work, at storage (the browser does it, with these helpers): the message's frame must be the
// tab's main frame or one a snapshot reads (otherwise it is dropped unread); then the text is taken (8,000 characters), made
// plain (addresses without user info, query and fragment), made one line with no control character, made plain again (cleaning
// can join an address a control character had split), its addresses through the tab's address scrubber, the tab's text
// scrubber, and cut at 2,000. It is scrubbed once more when read (`consoleText`).

import { oneLine } from "./title";

export const CONSOLE_MAX = 200;
export const CONSOLE_TEXT_MAX = 2000;

/** `loader`: a request entry carries the loader (document) it belongs to, so a page's own failed request survives its commit. */
export interface ConsoleEntry { at: number; kind: "error" | "warning" | "exception" | "request"; text: string; loader?: string }

/** `text` cut at `max` characters, never ending on half of a surrogate pair. */
export function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The newest `CONSOLE_MAX` entries, each text cut at `CONSOLE_TEXT_MAX` characters. */
export class ConsoleLog {
  private entries: ConsoleEntry[] = [];

  add(e: ConsoleEntry): void {
    this.entries.push({ ...e, text: e.text.length > CONSOLE_TEXT_MAX ? `${cutAt(e.text, CONSOLE_TEXT_MAX - 1)}…` : e.text });
    if (this.entries.length > CONSOLE_MAX) this.entries.splice(0, this.entries.length - CONSOLE_MAX);
  }

  /** A new document: only the entries of `loader` (the committing document's own request) stay; null keeps none. */
  keepOnly(loader: string | null): void {
    this.entries = loader === null ? [] : this.entries.filter((e) => e.loader === loader);
  }

  /** Every entry's text through `fn`. */
  remap(fn: (text: string) => string): void {
    this.entries = this.entries.map((e) => ({ ...e, text: fn(e.text) }));
  }

  list(): readonly ConsoleEntry[] { return this.entries; }
}

/** The most console messages a tab takes in a second; the rest are counted, not processed. */
export const CONSOLE_RATE = 100;

/** The app's own line (no kind in brackets, which every line a page can write has) saying how many messages were not kept; the
 *  reply puts it first, where a host that shortens a long reply keeps it. */
export const droppedLine = (n: number): string => `${n} more ${n === 1 ? "message or request was" : "messages and requests were"} not kept: the app takes in ${CONSOLE_RATE} a second at most.`;

export const NO_ENTRIES = "No errors, warnings or failed requests since this page loaded.";

// An address ends at a space, a quote or an angle bracket, but not at a tab, a line break, a NEL or a line or paragraph
// separator: the first pass sees them inside an address (cleaning turns them into spaces later), so what follows them in the
// address, its query included, is cut with it.
const STOP = /[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff<>"'`]/;
const SCHEME = /[a-z0-9+.-]/i;

/** Calls `edit(scheme, rest, blob)` for every `scheme://…` address in `text` (an address ends at a space, a quote or an angle
 *  bracket; `rest` is what follows `://`; `blob` when `blob:` comes right before the scheme) and splices in what it returns for
 *  the whole address. Linear: each `://` looks back at most 64 characters for its scheme, and the forward scan runs only for a
 *  real scheme and is consumed (the search resumes after it), so no character is scanned more than a bounded number of times. */
function scan(text: string, edit: (scheme: string, rest: string, blob: boolean) => string): string {
  let out = "", from = 0, at = 0;
  for (;;) {
    const i = text.indexOf("://", at);
    if (i < 0) break;
    let s = i;
    while (s > from && i - s < 64 && SCHEME.test(text[s - 1])) s--;
    while (s < i && !/[a-z]/i.test(text[s])) s++;
    if (s === i) { at = i + 3; continue; }
    let e = i + 3;
    while (e < text.length && !STOP.test(text[e])) e++;
    const blob = s - from >= 5 && text.slice(s - 5, s).toLowerCase() === "blob:";
    out += text.slice(from, blob ? s - 5 : s) + edit(text.slice(s, i), text.slice(i + 3, e), blob);
    from = at = e;
  }
  return out + text.slice(from);
}

/** Every address with an authority (`http:`, `https:`, `ws:`, `wss:`, `ftp:`, any `scheme://`) without its user name, password,
 *  query and fragment; with `originOnly` without its path too (a tab whose own address is still held back may not know which
 *  secrets its path carries). A `data:` address is its scheme and nothing after it; a `blob:` address keeps its inner origin only. */
export function plainAddresses(text: string, originOnly = false): string {
  // A data address's body can hold any character (a space, a quote, an angle bracket), so no later boundary is safe: the rest of
  // the line goes with it.
  const noData = text.replace(/(?<![a-z0-9+.-])data:[^\n\r\u0085\u2028\u2029]*/gi, "data:");
  return scan(noData, (scheme, rest, blob) => {
    const k = rest.search(/[/?#]/);
    const authority = k < 0 ? rest : rest.slice(0, k);
    const origin = `${scheme}://${authority.slice(authority.lastIndexOf("@") + 1)}`;
    if (blob) return `blob:${origin}`;
    if (originOnly || k < 0) return origin;
    const q = rest.slice(k).search(/[?#]/);
    return `${origin}${q < 0 ? rest.slice(k) : rest.slice(k, k + q)}`;
  });
}

/** The address scrub parses an address and so writes a hidden value's bullets percent-encoded; in a log line they read as bullets. */
export const bulletsPlain = (text: string): string => text.replace(/%E2%80%A2/gi, "•");

/** `text` with every address replaced by `fn(address)` (the address as it stands, whole). */
export function mapAddresses(text: string, fn: (address: string) => string): string {
  return scan(text, (scheme, rest, blob) => `${blob ? "blob:" : ""}${fn(`${scheme}://${rest}`)}`);
}

/** One line per entry, `[kind] text`: each address through `scrubUrl` (the tab's address scrubber), the line through `scrub`
 *  (the tab's text scrubber), then made one line with no control character (./title `oneLine`, as a session's title is) so
 *  a page cannot forge a second entry or repaint a terminal, and `<` escaped so it cannot close the wrapper the lines sit in
 *  (as a snapshot's quoted names are). */
export function consoleText(entries: readonly ConsoleEntry[], scrub: (s: string) => string, scrubUrl: (a: string) => string = (a) => a): string {
  if (!entries.length) return NO_ENTRIES;
  return entries.map((e) => `[${e.kind}] ${oneLine(scrub(mapAddresses(e.text, (a) => bulletsPlain(scrubUrl(a))))).replace(/</g, "\\u003c")}`).join("\n");
}
