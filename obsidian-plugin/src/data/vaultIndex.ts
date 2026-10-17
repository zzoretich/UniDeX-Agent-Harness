// The vault index (spec 2026-10-17-files-finder D18): one background pass over the vault's Markdown that finds each
// note's frontmatter tags, its outgoing links and the shape of its first lines, and from the links the backlinks. It
// feeds the preview's Links row, Icons' page art, the link updates (D17) and later the Tags sidebar (D20). It reads
// through vaultFiles' cache, shared with search, and yields to the page every few files.
//
// Link updates (D17) are a pure plan: rewritePlan says which notes a rename or move would change and how many links in
// each, from the index; rewriteLinks makes the change in one note's text; moveInIndex keeps the index in step until
// the next pass reads the vault again.

import type { App, TFile } from "obsidian";
import { parseFrontmatter } from "./frontmatter";
import { SEARCH_MAX_BYTES, protectedReason, quickOpenFiles, readCached, type Move } from "./vaultFiles";

/** A link as written: a wiki link (`[[target]]`, `![[target]]`) or a Markdown link to a relative path. `n` is how many
 *  times the note writes it (1 when a caller builds one to resolve). */
export interface NoteLink { target: string; md: boolean; n?: number }

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
  return body.replace(FENCE_RE, "").replace(INLINE_CODE_RE, "");
}

const FENCE_RE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const INLINE_CODE_RE = /`[^`\n]*`/g;

/** A Markdown link's path as written (`notes/My%20File.md#part`) to the vault path it names (`notes/My File.md`);
 *  null for a URL or an anchor in the same note. */
function mdTarget(raw: string): string | null {
  if (SCHEME_RE.test(raw) || raw.startsWith("#")) return null;
  const t = raw.split("#")[0];
  try { return decodeURI(t); } catch { return t; }
}

export function parseNote(text: string): NoteFacts {
  const fm = FRONTMATTER_RE.exec(text);
  const body = fm ? text.slice(fm[0].length) : text;
  const prose = proseOf(body);
  const links: NoteLink[] = [];
  const seen = new Map<string, NoteLink>();
  const add = (target: string, md: boolean) => {
    const key = `${md ? "m" : "w"}:${target}`;
    if (!target) return;
    const had = seen.get(key);
    if (had) { had.n = (had.n ?? 1) + 1; return; }
    const link = { target, md, n: 1 };
    seen.set(key, link);
    links.push(link);
  };
  for (const m of prose.matchAll(WIKI_RE)) add(m[1].trim(), false);
  for (const m of prose.matchAll(MD_RE)) {
    const t = mdTarget(m[1]);
    if (t !== null) add(t, true);
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

/** A note in the index: its facts as parsed (the links as written), and the paths they resolve to. */
export interface IndexedNote { tags: string[]; links: NoteLink[]; out: string[]; unresolved: number; lines: number[] }

export interface VaultIndex {
  notes: Map<string, IndexedNote>;
  /** Who links to each path (resolved), the notes in path order. */
  backlinks: Map<string, string[]>;
  /** Each tag and how many notes carry it. */
  tags: Map<string, number>;
  /** Every vault path the index resolved links against. */
  paths: string[];
}

/** Facts by path and mtime, so a rebuild parses only what changed. */
const factsCache = new Map<string, { mtime: number; facts: NoteFacts }>();

/** Builds the index from parsed notes and every vault path (links can point at any file). Pure: the tests drive it. */
export function indexFrom(notes: Array<{ path: string; facts: NoteFacts }>, allPaths: Iterable<string>): VaultIndex {
  const paths = [...allPaths];
  const look = pathLookup(paths);
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
    out.set(path, { tags: facts.tags, links: facts.links, out: resolved, unresolved, lines: facts.lines });
  }
  const backlinks = new Map<string, string[]>();
  for (const [to, from] of back) backlinks.set(to, [...from].sort());
  return { notes: out, backlinks, tags, paths };
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

// ── link updates (D17) ──

/** Where `p` is after `moves`; a folder that moves takes everything under it. */
export function movedPath(p: string, moves: readonly Move[]): string {
  for (const m of moves) {
    if (p === m.from) return m.to;
    if (p.startsWith(`${m.from}/`)) return m.to + p.slice(m.from.length);
  }
  return p;
}

/** The moves, and the vault's paths before and after them, which links resolve against. */
export interface LinkMove { moves: readonly Move[]; before: PathLookup; after: PathLookup }

export function linkMove(moves: readonly Move[], paths: Iterable<string>): LinkMove {
  const list = [...paths];
  return { moves, before: pathLookup(list), after: pathLookup(list.map((p) => movedPath(p, moves))) };
}

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** `to` as a Markdown link in a note in `fromDir` writes it: `../c/x.md`. */
function relativeTo(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/**
 * What a link in `note` (now at `noteAfter`) should say once `lm`'s moves are made, or null when it can stay as written:
 * it resolves to nothing, or still lands on the same file. A wiki link keeps its form (a bare name stays a name unless
 * another file would take it, a path stays a path) and leaves `.md` off when it was left off; a Markdown link is
 * written relative to the note's folder again.
 */
export function retarget(link: NoteLink, note: string, noteAfter: string, lm: LinkMove): string | null {
  const was = resolveLink(link, note, lm.before);
  if (was === null) return null;
  const now = movedPath(was, lm.moves);
  if (resolveLink(link, noteAfter, lm.after) === now) return null;
  const dropMd = was.toLowerCase().endsWith(".md") && !link.target.toLowerCase().endsWith(".md");
  const bare = (p: string) => (dropMd && p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p);
  if (link.md) return bare(relativeTo(dirOf(noteAfter), now));
  const byPath = bare(now);
  if (link.target.includes("/")) return byPath;
  const byName = bare(now.split("/").pop()!);
  return resolveLink({ target: byName, md: false }, noteAfter, lm.after) === now ? byName : byPath;
}

/** `text` with its frontmatter and code blanked to spaces, so offsets still line up with the text. */
function maskCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const fm = FRONTMATTER_RE.exec(text);
  const t = fm ? blank(fm[0]) + text.slice(fm[0].length) : text;
  return t.replace(FENCE_RE, blank).replace(INLINE_CODE_RE, blank);
}

/** A Markdown link's new path, encoded as the old one was: a space or a parenthesis would end the link. */
function encodeMd(path: string, wasEncoded: boolean): string {
  if (wasEncoded) return encodeURI(path).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));
  return path.replace(/[ ()]/g, (c) => (c === " " ? "%20" : c === "(" ? "%28" : "%29"));
}

/**
 * Rewrites the links in one note's text that `lm`'s moves would break, keeping each link's alias, heading, block ref,
 * embed mark and title; links in the frontmatter or in code are left as they are, as the index leaves them. `note` is
 * the note's path before the moves, `noteAfter` after them (a moved note's relative links are written again).
 */
export function rewriteLinks(text: string, note: string, noteAfter: string, lm: LinkMove): { text: string; count: number } {
  const masked = maskCode(text);
  const edits: Array<{ at: number; end: number; put: string }> = [];
  for (const m of masked.matchAll(WIKI_RE)) {
    const start = m.index! + (m[0].startsWith("!") ? 3 : 2);
    const raw = text.slice(start, start + m[1].length);
    const target = raw.trim();
    const put = retarget({ target, md: false }, note, noteAfter, lm);
    const lead = raw.length - raw.trimStart().length;
    if (put !== null) edits.push({ at: start + lead, end: start + lead + target.length, put });
  }
  for (const m of masked.matchAll(MD_RE)) {
    const open = m[0].indexOf("](") + 2;
    const start = m.index! + open + (m[0][open] === "<" ? 1 : 0);
    const raw = text.slice(start, start + m[1].length);
    const target = mdTarget(raw);
    if (target === null) continue;
    const pathPart = raw.split("#")[0];
    const put = retarget({ target, md: true }, note, noteAfter, lm);
    if (put !== null) edits.push({ at: start, end: start + pathPart.length, put: encodeMd(put, /%[0-9a-f]{2}/i.test(pathPart)) });
  }
  edits.sort((a, b) => a.at - b.at);
  let out = "";
  let last = 0;
  let count = 0;
  for (const e of edits) {
    if (e.at < last) continue;
    out += text.slice(last, e.at) + e.put;
    last = e.end;
    count++;
  }
  return { text: out + text.slice(last), count };
}

export interface RewritePlan {
  /** The notes a rename or move would update, by their path before it, and how many links in each. */
  notes: Array<{ path: string; links: number }>;
  /** Notes that link to what moves but are not written (the runtime's folders), and why. */
  skipped: Array<{ path: string; links: number; reason: string }>;
  /** The links in `notes`. */
  links: number;
}

/**
 * Which notes `moves` would leave with broken links (files-finder D17): those that link to a moved file, and moved notes
 * whose own relative links would point elsewhere. From the index alone, so the rename field and a drop can say
 * *Update N links* before anything is read. `paths` are the vault's files now (the index's by default).
 */
export function rewritePlan(index: VaultIndex, moves: readonly Move[], paths: Iterable<string> = index.paths): RewritePlan {
  const list = [...paths];
  const lm = linkMove(moves, list);
  const moved = (p: string) => movedPath(p, moves) !== p;
  const candidates = new Set<string>();
  for (const p of list) if (moved(p)) for (const from of index.backlinks.get(p) ?? []) candidates.add(from);
  for (const p of index.notes.keys()) if (moved(p)) candidates.add(p);
  const plan: RewritePlan = { notes: [], skipped: [], links: 0 };
  for (const path of [...candidates].sort()) {
    const n = index.notes.get(path);
    if (!n) continue;
    const after = movedPath(path, moves);
    let links = 0;
    for (const l of n.links) if (retarget(l, path, after, lm) !== null) links += l.n ?? 1;
    if (!links) continue;
    const reason = protectedReason(path);
    if (reason) plan.skipped.push({ path, links, reason });
    else { plan.notes.push({ path, links }); plan.links += links; }
  }
  return plan;
}

/**
 * The index once `moves` are made and the notes in `edited` (by their new path) hold their new text: what the next
 * pass would find, without reading the vault, so a second rename right after the first still knows the links.
 */
export function moveInIndex(index: VaultIndex, moves: readonly Move[], edited: ReadonlyMap<string, string> = new Map()): VaultIndex {
  const notes = [...index.notes].map(([p, n]) => {
    const path = movedPath(p, moves);
    const text = edited.get(path);
    return { path, facts: text !== undefined ? parseNote(text) : { tags: n.tags, links: n.links, lines: n.lines } };
  });
  return indexFrom(notes, index.paths.map((p) => movedPath(p, moves)));
}
