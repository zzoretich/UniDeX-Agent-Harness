// What a tab remembers of the secrets it has read (agent-computer D9, R32, R35, R37). Every sensitive field's value read in
// a tab is kept, scoped to the site (origin) it was read on, so text about a page the tab has since left is still
// scrubbed, while a site that plants words as "codes" cannot blank another site's titles: a site's pool scrubs names and
// text only while the tab is on that site. A value another site carried into this one's URL (a GET submit, a redirect, an
// error page's address, a popup's address) never enters this site's pool: it goes into the tab's "carried" set, which
// scrubs URL strings only (R35), each value keeping its kind (R37: a short one-time code scrubs as a whole word there too).
// Bounds per tab: at most SITES (16) sites, the least recently used evicted whole first (never the site being kept);
// values past MEMORY (256) evicted oldest first, but never a site's RESERVE (64) most recent one-time codes or 64 most
// recent passwords, so at most SITES x 2 x RESERVE (2,048) values in all; and at most CARRIED (64) carried values. The
// guarantee: filler read in LATER reads cannot push a real code out of its site's reserve. One read that returns more than
// RESERVE values of a kind keeps only the last RESERVE of them (`remember` says so, and the browser then hides that
// document's URL query and fragment, failing closed, R37). Pure: no Electron.

/** What the scrub removes: `values` (short ones only when all digits) and `whole` (one-time codes: short ones as words). */
export interface Secrets { values: string[]; whole: string[] }

/** How a value was read: from a one-time-code field, or from a password (or other sensitive) field. */
export type Kind = "otp" | "pw";

export const MEMORY = 256;
export const RESERVE = 64;
export const SITES = 16;
export const CARRIED = 64;

const collapse = (v: string): string => v.replace(/\s+/g, " ").trim();
const secret = (v: string): boolean => v !== "" && !/^[•●* ]+$/.test(v);

export class SecretMemory {
  /** Site to its values, each to its kind, in insertion order (oldest first); sites in order of last use. */
  private sites_ = new Map<string, Map<string, Kind>>();
  /** Values carried into a URL from another site, each to its kind, oldest first (R35: for URL strings only). */
  private carried_ = new Map<string, Kind>();

  /** Adds the secrets just read on `site`, which becomes the most recently used; `keep` (the current site, `site` by
   *  default) is never evicted. A value once seen as a one-time code stays one. Returns true when the read held more
   *  distinct values of one kind than `RESERVE`: the oldest of them may be gone already (R37: the caller fails closed). */
  remember(site: string, s: Secrets, keep: string = site): boolean {
    const m = this.touch(site);
    let flooded = false;
    for (const [list, kind] of [[s.values, "pw"], [s.whole, "otp"]] as const) {
      const distinct = new Set<string>();
      for (const raw of list) {
        const v = collapse(raw);
        if (!secret(v)) continue;
        distinct.add(v);
        const was = m.get(v);
        m.delete(v);
        m.set(v, was === "otp" ? "otp" : kind);
      }
      if (distinct.size > RESERVE) flooded = true;
    }
    this.evictSites(keep);
    this.evictValues();
    return flooded;
  }

  /** Remembers values another site carried into a URL of this tab, with their kinds: they scrub URL strings only, at
   *  most `CARRIED`. A value once carried as a one-time code stays one. */
  carry(s: Secrets): void {
    for (const [list, kind] of [[s.values, "pw"], [s.whole, "otp"]] as const) {
      for (const raw of list) {
        const v = collapse(raw);
        if (!secret(v)) continue;
        const was = this.carried_.get(v);
        this.carried_.delete(v);
        this.carried_.set(v, was === "otp" ? "otp" : kind);
      }
    }
    while (this.carried_.size > CARRIED) this.carried_.delete(this.carried_.keys().next().value!);
  }

  /** The carried values by kind, oldest first within each. */
  carried(): Secrets {
    const out: Secrets = { values: [], whole: [] };
    for (const [v, k] of this.carried_) (k === "pw" ? out.values : out.whole).push(v);
    return out;
  }

  /** The remembered secrets of `sites`, for the scrub of names and text. */
  pool(sites: string[]): Secrets {
    const out: Secrets = { values: [], whole: [] };
    for (const site of new Set(sites)) {
      for (const [v, k] of this.sites_.get(site) ?? []) (k === "pw" ? out.values : out.whole).push(v);
    }
    return out;
  }

  /** Copies another tab's entries for one site (a popup inherits its opener's, for the opener's site only). */
  inherit(from: SecretMemory, site: string): void {
    const src = from.sites_.get(site);
    if (!src) return;
    const m = this.touch(site);
    for (const [v, k] of src) { m.delete(v); m.set(v, k); }
    this.evictSites(site);
    this.evictValues();
  }

  size(): number {
    let n = 0;
    for (const m of this.sites_.values()) n += m.size;
    return n;
  }

  sites(): number { return this.sites_.size; }

  /** The site's map, moved to the most-recently-used end. */
  private touch(site: string): Map<string, Kind> {
    const m = this.sites_.get(site) ?? new Map<string, Kind>();
    this.sites_.delete(site);
    this.sites_.set(site, m);
    return m;
  }

  /** Drops whole sites, least recently used first, past `SITES`; `keep` stays. */
  private evictSites(keep: string): void {
    for (const site of [...this.sites_.keys()]) {
      if (this.sites_.size <= SITES) return;
      if (site !== keep) this.sites_.delete(site);
    }
  }

  /** Drops the oldest values past `MEMORY`, skipping each site's `RESERVE` most recent of either kind. */
  private evictValues(): void {
    let total = this.size();
    for (const [site, m] of this.sites_) {
      if (total <= MEMORY) return;
      const kept = new Set<string>();
      for (const kind of ["otp", "pw"] as const) {
        const ofKind = [...m].filter(([, k]) => k === kind).map(([v]) => v);
        for (const v of ofKind.slice(-RESERVE)) kept.add(v);
      }
      for (const [v] of m) {
        if (total <= MEMORY) break;
        if (kept.has(v)) continue;
        m.delete(v);
        total--;
      }
      if (!m.size) this.sites_.delete(site);
    }
  }
}
