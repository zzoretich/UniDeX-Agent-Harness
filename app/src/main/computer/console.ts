// What a tab's page said about itself since it loaded (session-browser, computer_console): the newest errors, warnings,
// uncaught exceptions and failed requests, as text for an agent. Pure: no Electron. Every word of it is PAGE TEXT from a page
// that may be hostile: an entry is made plain, one line and scrubbed before it is kept (the browser does that, with these
// helpers), and scrubbed again, its addresses through the tab's address scrubber, when it is read (`consoleText`).

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

  clear(): void { this.entries = []; }

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

export const NO_ENTRIES = "No errors, warnings or failed requests since this page loaded.";

const STOP = /[\s<>"'`]/;
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
  const noData = text.replace(/(?<![a-z0-9+.-])data:[^\s<>"'`]*/gi, "data:");
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
  return entries.map((e) => `[${e.kind}] ${oneLine(scrub(mapAddresses(e.text, scrubUrl))).replace(/</g, "\\u003c")}`).join("\n");
}
