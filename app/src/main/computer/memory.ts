// What a tab remembers of the secrets it has read (agent-computer D9, R32). Every sensitive field's value read in a tab
// is kept, scoped to the site (origin) it was read on, so text about a page the tab has since left is still scrubbed,
// while a site that plants words as "codes" cannot blank another site's titles. Bounded: 256 values per tab, evicting
// the oldest, but never a site's 64 most recent one-time codes or 64 most recent passwords (a flood of filler cannot push
// the real code out), and never a value pinned because it appeared in a URL (capped at 32 per site). Pure: no Electron.

/** What the scrub removes: `values` (short ones only when all digits) and `whole` (one-time codes: short ones as words). */
export interface Secrets { values: string[]; whole: string[] }

/** How a value was read: from a one-time-code field, from a password (or other sensitive) field, or seen in a URL. */
export type Kind = "otp" | "pw" | "url";

export const MEMORY = 256;
export const RESERVE = 64;
export const PINNED = 32;

const collapse = (v: string): string => v.replace(/\s+/g, " ").trim();
const secret = (v: string): boolean => v !== "" && !/^[•●* ]+$/.test(v);

export class SecretMemory {
  /** Site to its values, each to its kind, in insertion order (oldest first). */
  private sites = new Map<string, Map<string, Kind>>();

  /** Adds the secrets just read on `site`. A value once seen as a one-time code stays one; a pinned one stays pinned. */
  remember(site: string, s: Secrets): void {
    const m = this.site(site);
    for (const [list, kind] of [[s.values, "pw"], [s.whole, "otp"]] as const) {
      for (const raw of list) {
        const v = collapse(raw);
        if (!secret(v)) continue;
        const was = m.get(v);
        m.delete(v);
        m.set(v, was === "url" ? "url" : was === "otp" ? "otp" : kind);
      }
    }
    this.evict();
  }

  /** Pins values that appeared in a URL of `site` (a code submitted by GET): never evicted, at most `PINNED` per site. */
  pin(site: string, values: string[]): void {
    const m = this.site(site);
    for (const raw of values) {
      const v = collapse(raw);
      if (!secret(v)) continue;
      m.delete(v);
      m.set(v, "url");
    }
    const pins = [...m].filter(([, k]) => k === "url").map(([v]) => v);
    for (const v of pins.slice(0, Math.max(0, pins.length - PINNED))) m.delete(v);
  }

  /** The remembered secrets of `sites`, for the scrub. */
  pool(sites: string[]): Secrets {
    const out: Secrets = { values: [], whole: [] };
    for (const site of new Set(sites)) {
      for (const [v, k] of this.sites.get(site) ?? []) (k === "pw" ? out.values : out.whole).push(v);
    }
    return out;
  }

  /** Copies another tab's entries for one site (a popup inherits its opener's, for the opener's site only). */
  inherit(from: SecretMemory, site: string): void {
    const src = from.sites.get(site);
    if (!src) return;
    const m = this.site(site);
    for (const [v, k] of src) { m.delete(v); m.set(v, k); }
    this.evict();
  }

  size(): number {
    let n = 0;
    for (const m of this.sites.values()) n += m.size;
    return n;
  }

  private site(site: string): Map<string, Kind> {
    let m = this.sites.get(site);
    if (!m) { m = new Map(); this.sites.set(site, m); }
    return m;
  }

  /** Drops the oldest values past `MEMORY`, skipping each site's `RESERVE` most recent of either kind and every pin. */
  private evict(): void {
    let total = this.size();
    for (const [site, m] of this.sites) {
      if (total <= MEMORY) return;
      const kept = new Set<string>();
      for (const kind of ["otp", "pw"] as const) {
        const ofKind = [...m].filter(([, k]) => k === kind).map(([v]) => v);
        for (const v of ofKind.slice(-RESERVE)) kept.add(v);
      }
      for (const [v, k] of m) {
        if (total <= MEMORY) break;
        if (k === "url" || kept.has(v)) continue;
        m.delete(v);
        total--;
      }
      if (!m.size) this.sites.delete(site);
    }
  }
}
