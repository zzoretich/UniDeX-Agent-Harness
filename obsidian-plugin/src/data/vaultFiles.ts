// The Files tab's data (spec 2026-10-05-workbench-app, phase 2): what the vault tree shows, quick open's list, vault
// search, and the rules for a new note, a rename and a move, and (files-finder D14, D15, D24) a new folder, a duplicate
// and a drop of several items. Everything goes through the vault's own index
// (getFiles, folder children), so it reads the same in Obsidian and in the app; the pure parts take plain values.

import type { App, TAbstractFile, TFile } from "obsidian";

/** Folders quick open and search skip on top of the index's own rules (dot-folders, dependency folders). */
export const SKIPPED_SEGMENTS: readonly string[] = ["graphify-out"];

/**
 * Folders the tab never writes into: the runtime's caches and vendored scripts, and the host's own folders; and, at any
 * depth, dependency folders. Display only, the twin of the write policy's protected folders (app/src/shared/surfaces.ts
 * PROTECTED), which main enforces: the tab offers nothing main refuses.
 */
export const PROTECTED_PREFIXES: readonly string[] = ["brain/_index/", "brain/scripts/", ".obsidian/", ".git/"];
const PROTECTED_SEGMENTS: readonly string[] = ["node_modules"];

/** File types search reads when "all text files" is on; otherwise only Markdown. */
export const TEXT_EXTENSIONS: readonly string[] = ["md", "txt", "json", "jsonl", "yml", "yaml", "toml", "csv", "js", "cjs", "mjs", "ts", "css", "html", "sh", "py"];

/** Files larger than this are not searched (a log or a data dump, not a note). */
export const SEARCH_MAX_BYTES = 1_000_000;
export const SEARCH_MAX_MATCHES = 200;

const BAD_CHARS = /[\\:*?"<>|\u0000-\u001f]/;

export interface Entry { path: string; name: string; folder: boolean }

/** A path the tab lists, opens and searches: not under a skipped folder. */
export function isListed(path: string): boolean {
  return !path.split("/").some((seg) => SKIPPED_SEGMENTS.includes(seg));
}

/** A path as macOS's disk compares names: any case, any Unicode form (app/src/shared/surfaces.ts foldPath, its twin). */
export function foldPath(p: string): string {
  return p.normalize("NFD").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}

/** The protected folder `path` is in, named as the tab names it, or null. Compared folded, as the disk compares. */
function protectedBy(path: string): string | null {
  const p = foldPath(path.replace(/^\/+/, ""));
  const pre = PROTECTED_PREFIXES.find((x) => p === x.slice(0, -1) || p.startsWith(x));
  if (pre) return pre;
  const seg = p.split("/").find((s) => PROTECTED_SEGMENTS.includes(s));
  return seg ? `${seg}/` : null;
}

export function isProtected(path: string): boolean {
  return protectedBy(path) !== null;
}

/** The runtime's own folders: never moved, renamed or trashed, nor any folder above them (surfaces.ts RUNTIME_FOLDERS,
 *  its twin, which main enforces). */
const RUNTIME_FOLDERS: readonly string[] = ["brain/_index", "brain/scripts"];

/** Why `path` cannot move with everything in it because it holds a runtime folder (moving `brain` would take
 *  brain/scripts along), or null. Compared folded, as the disk compares. */
export function holdsRuntime(path: string): string | null {
  const p = foldPath(path.replace(/^\/+|\/+$/g, ""));
  const held = RUNTIME_FOLDERS.find((r) => p === "" || r.startsWith(`${p}/`));
  return held ? `${path} holds ${held}/, which the runtime writes itself` : null;
}

/** Why the tab does not write there (the reason a menu item that is off gives, files-finder D13). */
export function protectedReason(path: string): string | null {
  return protectedBy(path) === null ? null : protectedError(path);
}

/** Why the tab does not write there. */
function protectedError(path: string): string {
  const by = protectedBy(path) ?? path;
  return PROTECTED_SEGMENTS.some((s) => by === `${s}/`) ? `${by} belongs to a package manager` : `${by} is written by the runtime itself`;
}

/** Folders first, then files; each by name, numbers in natural order, case folded. */
export function sortEntries<T extends Entry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.folder ? -1 : 1));
}

/** A folder's children as entries, listed ones only, sorted. */
export function childEntries(children: readonly TAbstractFile[]): Entry[] {
  return sortEntries(children
    .filter((c) => isListed(c.path))
    .map((c) => ({ path: c.path, name: c.name, folder: "children" in c })));
}

/** The files quick open offers: every indexed file that is listed, Markdown first, then by path. */
export function quickOpenFiles(app: App): TFile[] {
  return app.vault.getFiles()
    .filter((f) => isListed(f.path))
    .sort((a, b) => (a.extension === "md") === (b.extension === "md") ? a.path.localeCompare(b.path) : a.extension === "md" ? -1 : 1);
}

export interface LineMatch { line: number; text: string; start: number; end: number }

/** The lines of `text` that contain `query` (case folded), with where the first hit is. Long lines are clipped around it. */
export function matchLines(text: string, query: string, limit = SEARCH_MAX_MATCHES, width = 160): LineMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: LineMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const at = lines[i].toLowerCase().indexOf(q);
    if (at < 0) continue;
    const from = Math.max(0, Math.min(at - Math.floor((width - q.length) / 2), lines[i].length - width));
    const clipped = lines[i].slice(from, from + width);
    const lead = from > 0 ? "…" : "";
    out.push({ line: i + 1, text: lead + clipped, start: lead.length + at - from, end: lead.length + at - from + q.length });
  }
  return out;
}

export interface SearchHit { path: string; matches: LineMatch[] }
export interface SearchResult { hits: SearchHit[]; files: number; matches: number; truncated: boolean }

/** Contents by path and modification time, so a second search (or the vault index) reads only what changed. */
const contentCache = new Map<string, { mtime: number; text: string }>();

/** A file's text through the cache search and the vault index share (files-finder D18); null when it cannot be read. */
export async function readCached(app: App, f: TFile): Promise<string | null> {
  const cached = contentCache.get(f.path);
  if (cached && cached.mtime === f.stat.mtime) return cached.text;
  try {
    const text = await app.vault.cachedRead(f);
    contentCache.set(f.path, { mtime: f.stat.mtime, text });
    return text;
  } catch {
    return null;
  }
}

/**
 * Searches the vault's files for `query`: Markdown, or every text type with `allText`; only the paths `only` takes
 * when it is given (files-finder D22's "this folder"). Yields to the UI every few files; `isCancelled` stops a search a
 * newer one replaced. Stops at SEARCH_MAX_MATCHES lines.
 */
export async function searchVault(app: App, query: string, opts: { allText?: boolean; only?: (path: string) => boolean; isCancelled?: () => boolean } = {}): Promise<SearchResult | null> {
  const result: SearchResult = { hits: [], files: 0, matches: 0, truncated: false };
  if (!query.trim()) return result;
  const files = quickOpenFiles(app).filter((f) => (opts.allText ? TEXT_EXTENSIONS.includes(f.extension) : f.extension === "md") && f.stat.size <= SEARCH_MAX_BYTES && (!opts.only || opts.only(f.path)));
  for (let i = 0; i < files.length; i++) {
    if (i % 40 === 0) {
      await new Promise((r) => setTimeout(r, 0));
      if (opts.isCancelled?.()) return null;
    }
    const f = files[i];
    const text = await readCached(app, f);
    if (text === null) continue;
    result.files++;
    const matches = matchLines(text, query, SEARCH_MAX_MATCHES - result.matches);
    if (!matches.length) continue;
    result.hits.push({ path: f.path, matches });
    result.matches += matches.length;
    if (result.matches >= SEARCH_MAX_MATCHES) { result.truncated = true; break; }
  }
  return result;
}

export type PathCheck = { ok: true; path: string } | { ok: false; error: string };

/** A vault-relative path from what the user typed: slashes normalised, no leading or trailing slash, no `.` segments. */
export function cleanPath(input: string): string {
  return input.trim().replace(/\\/g, "/").split("/").map((s) => s.trim()).filter((s) => s && s !== ".").join("/");
}

/** The shape of a path: no climbing out, no dot-names (the index never shows them), no characters Finder rejects. */
function shapeError(path: string): string | null {
  const segs = path.split("/");
  if (segs.some((s) => s === "..")) return "a path cannot climb out of the vault (..)";
  if (segs.some((s) => s.startsWith("."))) return "names cannot start with a dot";
  if (segs.some((s) => BAD_CHARS.test(s))) return 'names cannot contain \\ : * ? " < > |';
  return null;
}

/** Shared rules for a path the tab is about to write. `exists` asks the vault. */
function checkTarget(path: string, exists: (p: string) => boolean): PathCheck {
  if (!path) return { ok: false, error: "a name is required" };
  const shape = shapeError(path);
  if (shape) return { ok: false, error: shape };
  if (isProtected(path)) return { ok: false, error: protectedError(path) };
  if (exists(path)) return { ok: false, error: `${path} already exists` };
  return { ok: true, path };
}

/** A new note: `folder` plus what the user typed, `.md` added when there is no extension. */
export function newNotePath(folder: string, name: string, exists: (p: string) => boolean): PathCheck {
  let n = cleanPath(name);
  if (!n) return { ok: false, error: "a name is required" };
  const shape = shapeError(n);
  if (shape) return { ok: false, error: shape };
  if (!/\.[A-Za-z0-9]+$/.test(n.split("/").pop()!)) n += ".md";
  const full = cleanPath(folder ? `${folder}/${n}` : n);
  if (!full.endsWith(".md")) return { ok: false, error: "a new note is a Markdown file (.md)" };
  return checkTarget(full, exists);
}

/** A rename in place: the new name keeps the old extension when the user leaves it off. */
export function renamePath(from: string, name: string, exists: (p: string) => boolean): PathCheck {
  if (isProtected(from)) return { ok: false, error: `${from} is written by the runtime itself` };
  const held = holdsRuntime(from);
  if (held) return { ok: false, error: held };
  let n = cleanPath(name);
  if (n.includes("/")) return { ok: false, error: "a name cannot contain / (use Move to change the folder)" };
  const ext = from.includes(".") ? from.slice(from.lastIndexOf(".")) : "";
  if (n && ext && !n.includes(".")) n += ext;
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const to = dir ? `${dir}/${n}` : n;
  if (to === from) return { ok: false, error: "that is its name already" };
  return checkTarget(to, exists);
}

/** A move into another folder, keeping the name. `folder` is vault-relative ("" is the vault root). */
export function movePath(from: string, folder: string, exists: (p: string) => boolean): PathCheck {
  if (isProtected(from)) return { ok: false, error: `${from} is written by the runtime itself` };
  const held = holdsRuntime(from);
  if (held) return { ok: false, error: held };
  const name = from.split("/").pop()!;
  const dir = cleanPath(folder);
  const to = dir ? `${dir}/${name}` : name;
  if (to === from) return { ok: false, error: "it is in that folder already" };
  if (dir === from || dir.startsWith(`${from}/`)) return { ok: false, error: `${name} cannot go inside itself` };
  return checkTarget(to, exists);
}

export interface Move { from: string; to: string }
export type MovePlan = { ok: true; moves: Move[] } | { ok: false; error: string };

/**
 * Several items dropped on one folder (files-finder D15): every movePath check passes before the first one moves, so a
 * drop moves all of them or none. An item inside another one that moves goes with it; items already in that folder stay
 * where they are, and a drop of only those does nothing.
 */
export function movePlan(paths: readonly string[], folder: string, exists: (p: string) => boolean): MovePlan {
  const dir = cleanPath(folder);
  // A runtime folder refuses the drop whatever is dropped, and says so once.
  if (dir && isProtected(`${dir}/`)) return { ok: false, error: protectedError(`${dir}/`) };
  const tops = [...new Set(paths)].filter((p) => !paths.some((q) => q !== p && p.startsWith(`${q}/`)));
  const going = tops.filter((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") !== dir);
  if (!going.length) return { ok: false, error: tops.length === 1 ? "it is in that folder already" : "they are in that folder already" };
  const moves: Move[] = [];
  const taken = new Set<string>();
  for (const from of going) {
    const c = movePath(from, dir, exists);
    if (!c.ok) return going.length === 1 ? c : { ok: false, error: `${from.split("/").pop()}: ${c.error}` };
    if (taken.has(foldPath(c.path))) return { ok: false, error: `two items are named ${from.split("/").pop()}` };
    taken.add(foldPath(c.path));
    moves.push({ from, to: c.path });
  }
  return { ok: true, moves };
}

/** `name 2`, `name 3`, …, the first that is free (Finder's numbering), the extension kept after the number. */
function numbered(dir: string, stem: string, ext: string, exists: (p: string) => boolean): string {
  const at = (n: number) => { const name = `${stem}${n > 1 ? ` ${n}` : ""}${ext}`; return dir ? `${dir}/${name}` : name; };
  let n = 1;
  while (exists(at(n)) && n < 10_000) n++;
  return at(n);
}

/** New folder (files-finder D14): `untitled folder` in `folder`, numbered when that is taken. */
export function newFolderPath(folder: string, exists: (p: string) => boolean): PathCheck {
  const dir = cleanPath(folder);
  return checkTarget(numbered(dir, "untitled folder", "", exists), exists);
}

/** Duplicate (files-finder D24): `name copy.ext` beside the original, then `name copy 2.ext`, as Finder names them. */
export function duplicatePath(from: string, isFolder: boolean, exists: (p: string) => boolean): PathCheck {
  if (isProtected(from)) return { ok: false, error: protectedError(from) };
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const name = from.split("/").pop()!;
  const dot = isFolder ? -1 : name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return checkTarget(numbered(dir, `${stem} copy`, ext, exists), exists);
}
