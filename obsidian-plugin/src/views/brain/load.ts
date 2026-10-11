// Loads the Brain hub's data through the vault adapter (spec 2026-10-11-brain-hub D12): the memory files, the drafts,
// patterns and reflections, MEMORY.md, the trail and the runtime's two caches. A real vault holds hundreds of memories,
// so file texts are kept between loads: a vault event marks its path dirty and the next load re-reads only what is new
// or dirty (each folder is listed again, which is cheap); showing the tab reloads everything. Each memory is parsed (and
// hashed) again only when its text or its MEMORY.md line changed.
import type { App } from "obsidian";
import {
  BRAIN_HUB_PATH, BRAIN_SOURCES_PATH, DRAFTS_DIR, MEMORY_INDEX_PATH, MEMORY_ROOT, MEMORY_TYPES, PATTERNS_DIR, REFLECTIONS_DIR,
  dupFlags, livePairs, pairKey, parseBrainHub, parseBrainSources, parseDraft, parseIndexLines, parseMemory, parseNote,
  readTrailRows, reviewBatches, writtenAtMap, type BrainDraft, type BrainMemory, type BrainNote,
} from "../../data/brainModel";
import { TRAIL_PATH } from "../../data/promoteTrail";
import type { BrainData } from "./types";

/** The single files every load reads whole: small, and their changes are what the hub follows. */
const SINGLES = [BRAIN_HUB_PATH, BRAIN_SOURCES_PATH, MEMORY_INDEX_PATH, TRAIL_PATH];

export class BrainStore {
  private texts = new Map<string, string>();
  /** Each memory as last parsed, with the text and MEMORY.md description it was parsed from. */
  private parsed = new Map<string, { raw: string; desc: string | undefined; m: BrainMemory | null }>();
  private dirty = new Set<string>();
  private dismissed = new Set<string>();
  private loading: Promise<BrainData> | null = null;
  private again = false;

  constructor(private app: App) {}

  /** A vault event touched `path` (create, modify, delete, either end of a rename). */
  touch(path: string): void { this.dirty.add(path); }

  /** "Keep both" on this page: the pair stops showing before the next scan drops it from brain-hub.json. */
  dismiss(a: string, b: string): void { this.dismissed.add(pairKey(a, b)); }

  /**
   * The current data. `full` drops every kept text first. Loads never overlap: a call while one runs waits for it and
   * then loads once more, so the last event is never lost.
   */
  async load(full = false): Promise<BrainData> {
    if (full) { this.texts.clear(); this.dirty.clear(); }
    if (this.loading) { this.again = true; return this.loading; }
    this.loading = this.read();
    try {
      let d = await this.loading;
      while (this.again) { this.again = false; this.loading = this.read(); d = await this.loading; }
      return d;
    } finally { this.loading = null; }
  }

  private async list(dir: string): Promise<string[]> {
    try { return (await this.app.vault.adapter.list(dir)).files.filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
  }

  private async text(path: string, fresh = false): Promise<string | null> {
    if (!fresh && !this.dirty.has(path) && this.texts.has(path)) return this.texts.get(path)!;
    this.dirty.delete(path);
    try {
      const a = this.app.vault.adapter;
      if (!(await a.exists(path))) { this.texts.delete(path); return null; }
      const t = await a.read(path);
      this.texts.set(path, t);
      return t;
    } catch { this.texts.delete(path); return null; }
  }

  /** parseMemory, reusing the last answer for the same text and index line (a reload after one event re-reads one file;
   *  without this every memory was parsed and hashed again). */
  private memory(p: string, raw: string, index: ReadonlyMap<string, string>): BrainMemory | null {
    const desc = index.get(p);
    const c = this.parsed.get(p);
    if (c && c.raw === raw && c.desc === desc) return c.m;
    const m = parseMemory(p, raw, index);
    this.parsed.set(p, { raw, desc, m });
    return m;
  }

  private async read(): Promise<BrainData> {
    const now = new Date();
    const [hubRaw, srcRaw, indexRaw, trailRaw] = await Promise.all(SINGLES.map((p) => this.text(p, true)));
    const index = parseIndexLines(indexRaw);
    const memories: BrainMemory[] = [];
    const seen = new Set<string>();
    for (const t of MEMORY_TYPES) {
      for (const p of await this.list(`${MEMORY_ROOT}/${t}`)) {
        seen.add(p);
        const raw = await this.text(p);
        const m = raw === null ? null : this.memory(p, raw, index);
        if (m) memories.push(m);
      }
    }
    const drafts: BrainDraft[] = [];
    for (const p of await this.list(DRAFTS_DIR)) {
      seen.add(p);
      const raw = await this.text(p);
      const d = raw === null ? null : parseDraft(p, raw);
      if (d) drafts.push(d);
    }
    const notes = async (kind: "patterns" | "reflections", dir: string): Promise<BrainNote[]> => {
      const out: BrainNote[] = [];
      for (const p of await this.list(dir)) {
        seen.add(p);
        const raw = await this.text(p);
        const n = raw === null ? null : parseNote(kind, p, raw);
        if (n) out.push(n);
      }
      return out;
    };
    const patterns = await notes("patterns", PATTERNS_DIR);
    const reflections = (await notes("reflections", REFLECTIONS_DIR)).sort((a, b) => b.path.localeCompare(a.path));
    // Files gone from their folder leave the cache.
    for (const p of [...this.texts.keys()]) if (!seen.has(p) && !SINGLES.includes(p)) this.texts.delete(p);
    for (const p of [...this.parsed.keys()]) if (!seen.has(p)) this.parsed.delete(p);

    const hub = parseBrainHub(hubRaw);
    const trail = readTrailRows(trailRaw);
    const written = writtenAtMap(trail);
    const byPath = new Map(memories.map((m) => [m.path, m]));
    const pairs = livePairs(hub, byPath, this.dismissed);
    const flags = dupFlags(pairs);
    return {
      now, memories, byPath, drafts, patterns, reflections, hub, sources: parseBrainSources(srcRaw), trail, written, index,
      pairs, flags, batches: reviewBatches(memories, hub, written, flags),
    };
  }
}
