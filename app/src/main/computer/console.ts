// What a tab's page said about itself since it loaded (session-browser, computer_console): the newest errors, warnings,
// uncaught exceptions and failed requests, as text for an agent. Pure: no Electron. Every word of it is PAGE TEXT from a page
// that may be hostile: addresses lose their query and fragment before an entry is stored (`plainAddresses`), and the lines
// are scrubbed and made harmless to the wrapper they sit in (`consoleText`) when they are read.

export const CONSOLE_MAX = 200;
export const CONSOLE_TEXT_MAX = 2000;

export interface ConsoleEntry { at: number; kind: "error" | "warning" | "exception" | "request"; text: string }

/** The newest `CONSOLE_MAX` entries, each text cut at `CONSOLE_TEXT_MAX` characters. */
export class ConsoleLog {
  private entries: ConsoleEntry[] = [];

  add(e: ConsoleEntry): void {
    this.entries.push({ ...e, text: e.text.length > CONSOLE_TEXT_MAX ? `${e.text.slice(0, CONSOLE_TEXT_MAX - 1)}…` : e.text });
    if (this.entries.length > CONSOLE_MAX) this.entries.splice(0, this.entries.length - CONSOLE_MAX);
  }

  clear(): void { this.entries = []; }

  list(): readonly ConsoleEntry[] { return this.entries; }
}

export const NO_ENTRIES = "No errors, warnings or failed requests since this page loaded.";

/** Every http(s) address in `text` without its user name and password, query and fragment; with `originOnly` without its path
 *  too (a tab whose own address is still held back may not know which secrets its path carries). An address ends at a space,
 *  a quote or an angle bracket, so a query is cut with whatever punctuation follows it. */
export function plainAddresses(text: string, originOnly = false): string {
  return text.replace(/https?:\/\/[^\s<>"'`]+/gi, (address) => {
    const noUser = address.replace(/^(https?:\/\/)[^/?#]*@/i, "$1");
    if (originOnly) return /^https?:\/\/[^/?#]*/i.exec(noUser)![0];
    return noUser.replace(/[?#].*$/s, "");
  });
}

/** One line per entry, `[kind] text`, scrubbed with the tab's own scrubber; whitespace collapsed so a page cannot forge a
 *  second entry with a line break, and `<` escaped so a page cannot close the wrapper the lines sit in (as a snapshot's
 *  quoted names are). */
export function consoleText(entries: readonly ConsoleEntry[], scrub: (s: string) => string): string {
  if (!entries.length) return NO_ENTRIES;
  return entries.map((e) => `[${e.kind}] ${scrub(e.text).replace(/\s+/g, " ").trim().replace(/</g, "\\u003c")}`).join("\n");
}
