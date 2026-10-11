// Library's "Linked from" (spec 2026-10-11-brain-hub D1, D2): the vault's markdown files that link a file by
// [[name]], [[name|…]], [[name#…]] or ](path). Each file's link targets are kept by its mtime and size, so after the
// first pass a lookup re-reads only the files that changed; a file's answer is kept for one load of the hub (a new load
// asks again, cheaply). Reads go through the vault, never the page's own fs.
import type { App } from "obsidian";
import { linkTargets, linksTo, type LinkTargets } from "../../data/brainModel";

/** At most this many linking files per answer (the Memory tab's backlinks kept the same cap). */
export const MAX_BACKLINKS = 100;
/** A file larger than this is not read for links (a log or an export, not a note). */
const MAX_BYTES = 2_000_000;
/** Files read between two yields to the page, so a first pass over a large vault never freezes typing. */
const PER_SLICE = 40;

interface Seen { mtime: number; size: number; t: LinkTargets }

export class LibraryLinks {
  private files = new Map<string, Seen>();
  private answers = new Map<string, string[]>();
  private answersFor: object | null = null;
  private scanning: Promise<void> | null = null;

  constructor(private app: App) {}

  /** The answer already known for `path` in this load, or null. */
  known(path: string, load: object): string[] | null {
    return this.answersFor === load ? this.answers.get(path) ?? null : null;
  }

  /** The files linking `path`, sorted, at most MAX_BACKLINKS; `load` is the hub's current data (answers last one load). */
  async backlinks(path: string, load: object): Promise<string[]> {
    if (this.answersFor !== load) { this.answers.clear(); this.answersFor = load; }
    const hit = this.answers.get(path);
    if (hit) return hit;
    await this.refresh();
    const out: string[] = [];
    for (const [p, s] of this.files) {
      if (p === path || !linksTo(s.t, path)) continue;
      out.push(p);
      if (out.length >= MAX_BACKLINKS) break;
    }
    out.sort((a, b) => a.localeCompare(b));
    if (this.answersFor === load) this.answers.set(path, out);
    return out;
  }

  /** One pass at a time; a caller during a pass waits for it. */
  private refresh(): Promise<void> {
    this.scanning ??= this.scan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async scan(): Promise<void> {
    const vault = this.app.vault;
    const live = new Set<string>();
    let read = 0;
    for (const f of vault.getMarkdownFiles()) {
      live.add(f.path);
      const was = this.files.get(f.path);
      if (was && was.mtime === f.stat.mtime && was.size === f.stat.size) continue;
      let t: LinkTargets = { wiki: new Set(), paths: new Set() };
      if (f.stat.size <= MAX_BYTES) {
        try { t = linkTargets(await vault.cachedRead(f)); } catch { /* unreadable now: no links, read again when it changes */ }
        if (++read % PER_SLICE === 0) await new Promise<void>((r) => window.setTimeout(r, 0));
      }
      this.files.set(f.path, { mtime: f.stat.mtime, size: f.stat.size, t });
    }
    for (const p of [...this.files.keys()]) if (!live.has(p)) this.files.delete(p);
  }
}
