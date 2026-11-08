// The navigations under way in a tab's main frame, each with what its commit carries (agent-computer D9, R35, R38, R39, R40).
// A page-started navigation keeps a "leaving record": the old document's sensitive values, read when it starts, so that at
// its commit what the committed URL carries from the old site goes to the tab's carried set (which scrubs URL strings
// only). One slot was not enough (R39): a document can start navigation A and then B before A commits, and Chromium
// still commits A when A was already past the point where B could cancel it (A ready to commit), then commits B. So every
// navigation started gets its own entry, keyed by the URL Electron reports for it at did-start-navigation and again at
// its commit: a page-started one with its record, one started from main (the agent's own load) with none (R37 N4).
// A redirect re-keys only the latest entry, and only while it is the latest navigation started: in a frame only that
// navigation can still be redirected (an earlier one still pending is past ready-to-commit, or was cancelled by the later
// one). The list is bounded at LEAVING entries, the oldest dropped first; but the oldest is the navigation most likely
// to commit (past ready-to-commit while the page starts more), so a dropped record is never thrown away (R40): every
// dropped record folds into one "lost" record (one read merging their reads, and the sites they left), kept until loading
// stops and carried from at every commit. A commit then yields its own records and the others whose values its URL may
// hold, so the browser carries what the URL holds from all of them:
// - page: the page records keyed at the committed URL (all of them carried, the oldest consumed: a second commit at the
//   same URL still finds one), and the lost record;
// - main: the agent's own entry matched. The pending page records and the lost record are carried from too (R40): a page
//   commit whose own entry was re-keyed elsewhere could match the agent's entry, and the agent's URL is never held back;
// - unknown: no entry matched while a page record is pending or one was lost (a redirect not seen): carried from all of
//   them, and the browser fails closed (the document's query and fragment stay hidden);
// - none: nothing pending could be it.
// Every entry and the lost record go when loading stops: nothing is pending then. Pure: no Electron.

import type { Secrets } from "./memory";

/** At most this many navigations are tracked per tab (R39). */
export const LEAVING = 8;
/** A lost record keeps at most this many distinct values (the oldest kept: they are the oldest navigations') and sites. */
export const LOST_VALUES = 4_096;
export const LOST_SITES = 16;

/** A page-started navigation's leaving record: the sites being left and the read of their documents' values (G2). */
export interface Departure { from: string[]; read: Promise<Secrets | null> }

/** A commit's records: `own` (kind page: the page records keyed at the committed URL, the consumed one first, whose read
 *  decides whether the URL is held back) and `others` (records whose values the URL may also hold: the lost record, and for
 *  main and unknown every pending page record). */
export interface Committed { kind: "page" | "main" | "unknown" | "none"; own: Departure[]; others: Departure[] }

const union = (reads: (Secrets | null)[]): Secrets | null => {
  if (reads.every((r) => r === null)) return null;
  const values = new Set<string>(), whole = new Set<string>();
  for (const r of reads) {
    for (const v of r?.values ?? []) if (values.size + whole.size < LOST_VALUES) values.add(v);
    for (const v of r?.whole ?? []) if (values.size + whole.size < LOST_VALUES) whole.add(v);
  }
  return { values: [...values], whole: [...whole] };
};

/** R40: two records as one: both reads merged (distinct values, kinds kept, at most LOST_VALUES, the first's first; null
 *  only when both failed) and the sites they left (at most LOST_SITES, the first's first). */
export function mergeDepartures(a: Departure, b: Departure): Departure {
  return {
    from: [...new Set([...a.from, ...b.from])].slice(0, LOST_SITES),
    read: Promise.all([a.read, b.read].map((r) => r.catch(() => null))).then(union),
  };
}

/** agent-computer D9 (R40): a tab's leaving reads still waiting for an answer. A commit ends them all with null (a failed
 *  read): DevTools holds commands while a cross-process navigation commits and then sends them to the new renderer, where a
 *  stale context id can name a context of the new document (review rv5), so an answer after a commit may not be the old
 *  document's; and a commit then never waits on reads that can no longer count (DevTools may hold them until a later
 *  navigation commits, which would hide the committed URL for its whole life). */
export class PendingReads {
  private ends = new Set<() => void>();

  /** `read`, or null as soon as the tab commits before it answers. */
  track<T>(read: Promise<T | null>): Promise<T | null> {
    let end!: () => void;
    const ended = new Promise<null>((r) => { end = () => r(null); });
    this.ends.add(end);
    return Promise.race([read.catch(() => null), ended]).finally(() => this.ends.delete(end));
  }

  /** The tab committed a new document: every read still pending is a failed read. */
  endAll(): void {
    for (const end of this.ends) end();
    this.ends.clear();
  }
}

export class LeavingRecords {
  /** Oldest first; `record` null for a navigation started from main. */
  private list: { url: string; record: Departure | null }[] = [];
  /** Whether the last entry is the latest navigation started (so a redirect is its). */
  private latest = false;
  /** Every page record the bound dropped since loading last stopped, merged (R40). */
  private lost: Departure | null = null;

  /** A main-frame cross-document navigation started at `url`: `record` for a page-started one, null for one from main.
   *  `url` null: a navigation that gets no entry (not http or https); a redirect after it is that navigation's. */
  start(url: string | null, record: Departure | null = null): void {
    this.latest = url !== null;
    if (url === null) return;
    this.list.push({ url, record });
    while (this.list.length > LEAVING) {
      const dropped = this.list.shift()!.record;
      if (dropped) this.lost = this.lost ? mergeDepartures(this.lost, dropped) : dropped;
    }
  }

  /** A main-frame cross-document redirect to `url` (did-redirect-navigation reports the URL its commit will report). */
  redirect(url: string): void {
    if (this.latest) this.list[this.list.length - 1].url = url;
  }

  /** A main-frame commit at `url` (did-navigate, or an error page's did-fail-provisional-load). A page record keyed at the
   *  URL goes before the agent's entry at the same URL (carrying is the safe side). */
  commit(url: string): Committed {
    const lost = this.lost ? [this.lost] : [];
    const pending = (): Departure[] => this.list.flatMap((n) => (n.record ? [n.record] : []));
    const own = this.list.filter((n) => n.url === url && n.record).map((n) => n.record!);
    const i = own.length ? this.list.findIndex((n) => n.record === own[0]) : this.list.findIndex((n) => n.url === url);
    if (i < 0) {
      const others = [...pending(), ...lost];
      return { kind: others.length ? "unknown" : "none", own: [], others };
    }
    if (i === this.list.length - 1) this.latest = false;
    this.list.splice(i, 1);
    return own.length ? { kind: "page", own, others: lost } : { kind: "main", own: [], others: [...pending(), ...lost] };
  }

  /** Loading stopped (did-stop-loading): no navigation is pending, so none of these can commit any more. */
  stop(): void {
    this.list = [];
    this.latest = false;
    this.lost = null;
  }

  /** The entries pending (for tests and spikes). */
  get size(): number { return this.list.length; }
}
