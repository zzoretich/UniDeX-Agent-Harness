// The vault index (spec 2026-10-17-files-finder D18): one background pass over the vault's Markdown that finds each
// note's frontmatter tags, its outgoing links and the shape of its first lines, and from the links the backlinks. It
// feeds the preview's Links row, Icons' page art, and later the Tags sidebar (D20) and the link updates (D17). It reads
// through vaultFiles' cache, shared with search, and yields to the page every few files.

import type { App, TFile } from "obsidian";
import { parseFrontmatter } from "./frontmatter";
import { SEARCH_MAX_BYTES, quickOpenFiles, readCached } from "./vaultFiles";

/** A link as written: a wiki link (`[[target]]`, `![[target]]`) or a Markdown link to a relative path. */
export interface NoteLink { target: string; md: boolean }

export interface NoteFacts {
  tags: string[];
  links: NoteLink[];
  /** The lengths of the note's first non-empty lines after the frontmatter (at most 6, each at most 48): Icons draws
   *  the page from them. */
  lines: number[];
}

const FRONTMATTER_RE = /^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/;
const WIKI_RE = /!?\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const MD_RE = /\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\)/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Frontmatter `tags:` as a block list, an inline `[a, b]` list or a comma string; a leading `#` dropped. */
function tagsOf(text: string): string[] {
  const raw = parseFrontmatter(text).tags;
  const list = Array.isArray(raw) ? raw : String(raw ?? "").replace(/^\[|\]$/g, "").split(",");
  const out: string[] = [];
  for (const t of list) {
    const tag = t.trim().replace(/^["']|["']$/g, "").replace(/^#/, "");
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The body with fenced code blocks and inline code blanked, so a link shown as code is not a link. */
function proseOf(body: string): string {
  return body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
}

export function parseNote(text: string): NoteFacts {
  const fm = FRONTMATTER_RE.exec(text);
  const body = fm ? text.slice(fm[0].length) : text;
  const prose = proseOf(body);
  const links: NoteLink[] = [];
  const seen = new Set<string>();
  const add = (target: string, md: boolean) => {
    const key = `${md ? "m" : "w"}:${target}`;
    if (!target || seen.has(key)) return;
    seen.add(key);
    links.push({ target, md });
  };
  for (const m of prose.matchAll(WIKI_RE)) add(m[1].trim(), false);
  for (const m of prose.matchAll(MD_RE)) {
    let t = m[1];
    if (SCHEME_RE.test(t) || t.startsWith("#")) continue;
    t = t.split("#")[0];
    try { t = decodeURI(t); } catch { /* keep it as written */ }
    add(t, true);
  }
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 6).map((l) => Math.min(48, l.length));
  return { tags: fm ? tagsOf(text) : [], links, lines };
}

/** `a/b/../c` → `a/c`; null when it climbs out of the vault. */
function normalize(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join("/");
}

/** Every vault path, and the paths each lower-cased name (with and without `.md`) belongs to. */
export interface PathLookup { paths: Set<string>; byName: Map<string, string[]> }

export function pathLookup(paths: Iterable<string>): PathLookup {
  const set = new Set<string>();
  const byName = new Map<string, string[]>();
  const put = (k: string, p: string) => { const l = byName.get(k); if (l) l.push(p); else byName.set(k, [p]); };
  for (const p of paths) {
    set.add(p);
    const name = p.split("/").pop()!.toLowerCase();
    put(name, p);
    if (name.endsWith(".md")) put(name.slice(0, -3), p);
  }
  return { paths: set, byName };
}

/**
 * Where a link from `from` lands, as Obsidian resolves it: a Markdown link relative to the note's folder; a wiki link
 * with a slash from the vault root (with or without `.md`); a bare wiki link by its name, the one in the note's own
 * folder first, else the shortest path. Null when nothing matches.
 */
export function resolveLink(link: NoteLink, from: string, look: PathLookup): string | null {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  if (link.md) {
    const p = normalize(dir ? `${dir}/${link.target}` : link.target);
    if (p === null) return null;
    if (look.paths.has(p)) return p;
    return look.paths.has(`${p}.md`) ? `${p}.md` : null;
  }
  const t = link.target.replace(/^\/+/, "");
  if (t.includes("/")) {
    if (look.paths.has(t)) return t;
    if (look.paths.has(`${t}.md`)) return `${t}.md`;
  }
  const name = t.split("/").pop()!.toLowerCase();
  const hits = look.byName.get(name) ?? [];
  const tail = t.toLowerCase();
  const fit = hits.filter((p) => { const l = p.toLowerCase(); return l === tail || l === `${tail}.md` || l.endsWith(`/${tail}`) || l.endsWith(`/${tail}.md`); });
  if (!fit.length) return null;
  const here = fit.find((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === dir);
  return here ?? [...fit].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

export interface IndexedNote { tags: string[]; out: string[]; unresolved: number; lines: number[] }

export interface VaultIndex {
  notes: Map<string, IndexedNote>;
  /** Who links to each path (resolved), the notes in path order. */
  backlinks: Map<string, string[]>;
  /** Each tag and how many notes carry it. */
  tags: Map<string, number>;
}

/** Facts by path and mtime, so a rebuild parses only what changed. */
const factsCache = new Map<string, { mtime: number; facts: NoteFacts }>();

/** Builds the index from parsed notes and every vault path (links can point at any file). Pure: the tests drive it. */
export function indexFrom(notes: Array<{ path: string; facts: NoteFacts }>, allPaths: Iterable<string>): VaultIndex {
  const look = pathLookup(allPaths);
  const out = new Map<string, IndexedNote>();
  const back = new Map<string, Set<string>>();
  const tags = new Map<string, number>();
  for (const { path, facts } of notes) {
    const resolved: string[] = [];
    let unresolved = 0;
    for (const l of facts.links) {
      const to = resolveLink(l, path, look);
      if (to === null) { unresolved++; continue; }
      if (to === path || resolved.includes(to)) continue;
      resolved.push(to);
      const s = back.get(to);
      if (s) s.add(path); else back.set(to, new Set([path]));
    }
    for (const t of facts.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    out.set(path, { tags: facts.tags, out: resolved, unresolved, lines: facts.lines });
  }
  const backlinks = new Map<string, string[]>();
  for (const [to, from] of back) backlinks.set(to, [...from].sort());
  return { notes: out, backlinks, tags };
}

/**
 * One pass over the vault's Markdown (under SEARCH_MAX_BYTES), yielding every 40 files; `isCancelled` stops a pass a
 * newer one replaced (null then).
 */
export async function buildVaultIndex(app: App, opts: { isCancelled?: () => boolean } = {}): Promise<VaultIndex | null> {
  const all = quickOpenFiles(app);
  const md = all.filter((f) => f.extension === "md" && f.stat.size <= SEARCH_MAX_BYTES);
  const notes: Array<{ path: string; facts: NoteFacts }> = [];
  for (let i = 0; i < md.length; i++) {
    if (i % 40 === 0) {
      await new Promise((r) => setTimeout(r, 0));
      if (opts.isCancelled?.()) return null;
    }
    const f: TFile = md[i];
    const hit = factsCache.get(f.path);
    if (hit && hit.mtime === f.stat.mtime) { notes.push({ path: f.path, facts: hit.facts }); continue; }
    const text = await readCached(app, f);
    if (text === null) continue;
    const facts = parseNote(text);
    factsCache.set(f.path, { mtime: f.stat.mtime, facts });
    notes.push({ path: f.path, facts });
  }
  if (opts.isCancelled?.()) return null;
  return indexFrom(notes, all.map((f) => f.path));
}

/** The most used tags, most first, ties by name. */
export function topTags(index: VaultIndex, n: number): Array<{ tag: string; count: number }> {
  return [...index.tags].map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, n);
}
