// The navigations under way in a tab's main frame, each with what its commit carries (agent-computer D9, R35, R38, R39).
// A page-started navigation keeps a "leaving record": the old document's sensitive values, read when it starts, so that at
// its commit what the committed URL carries from the old site goes to the tab's carried set (which scrubs URL strings
// only). One slot was not enough (R39): a document can start navigation A and then B before A commits, and Chromium
// still commits A when A was already past the point where B could cancel it (A ready to commit), then commits B. So every
// navigation started gets its own entry, keyed by the URL Electron reports for it at did-start-navigation and again at
// its commit: a page-started one with its record, one started from main (the agent's own load) with none, since an
// agent-chosen URL carries nothing (R37 N4). A commit consumes only its own entry and keeps the others. A redirect re-keys
// only the latest entry, and only while it is the latest navigation started: in a frame only that navigation can still be
// redirected (an earlier one still pending is past ready-to-commit, or was cancelled by the later one). When no entry
// matches a commit but a page record is pending that could be its navigation (a redirect not seen), or one was lost to
// the bound, the commit fails closed (the browser hides that document's query and fragment). Every entry goes when
// loading stops: nothing is pending then. Bounded at LEAVING entries, the oldest dropped first. Pure: no Electron.

/** At most this many navigations are tracked per tab (R39). */
export const LEAVING = 8;

/** What a commit was: a page-started navigation (carry from its record, hold the URL back while the record's read is
 *  pending), one started from main (carries nothing), unknown while a page record could be it (fail closed: carry from
 *  every pending record and hide the query and fragment for the document's life), or none of those (nothing pending). */
export type Committed<R> = { kind: "page"; record: R } | { kind: "main" } | { kind: "unknown"; records: R[] } | { kind: "none" };

export class LeavingRecords<R> {
  /** Oldest first; `record` null for a navigation started from main. */
  private list: { url: string; record: R | null }[] = [];
  /** Whether the last entry is the latest navigation started (so a redirect is its). */
  private latest = false;
  /** A page record was dropped by the bound since loading last stopped: its navigation may still commit. */
  private lost = false;

  /** A main-frame cross-document navigation started at `url`: `record` for a page-started one, null for one from main.
   *  `url` null: a navigation that gets no entry (not http or https); a redirect after it is that navigation's. */
  start(url: string | null, record: R | null = null): void {
    this.latest = url !== null;
    if (url === null) return;
    this.list.push({ url, record });
    while (this.list.length > LEAVING) if (this.list.shift()!.record !== null) this.lost = true;
  }

  /** A main-frame cross-document redirect to `url` (did-redirect-navigation reports the URL its commit will report). */
  redirect(url: string): void {
    if (this.latest) this.list[this.list.length - 1].url = url;
  }

  /** A main-frame commit at `url` (did-navigate, or an error page's did-fail-provisional-load). With the same URL pending
   *  more than once, a page record goes first (carrying is the safe side), oldest first. */
  commit(url: string): Committed<R> {
    let i = this.list.findIndex((n) => n.url === url && n.record !== null);
    if (i < 0) i = this.list.findIndex((n) => n.url === url);
    if (i >= 0) {
      if (i === this.list.length - 1) this.latest = false;
      const { record } = this.list.splice(i, 1)[0];
      return record === null ? { kind: "main" } : { kind: "page", record };
    }
    const records = this.list.flatMap((n) => (n.record === null ? [] : [n.record]));
    return records.length || this.lost ? { kind: "unknown", records } : { kind: "none" };
  }

  /** Loading stopped (did-stop-loading): no navigation is pending, so none of these can commit any more. */
  stop(): void {
    this.list = [];
    this.latest = false;
    this.lost = false;
  }

  /** The entries pending (for tests and spikes). */
  get size(): number { return this.list.length; }
}
