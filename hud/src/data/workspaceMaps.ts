// Reader for brain/_index/workspace-maps/<name>.json (written by
// brain/scripts/collectors/fileMap.js — keep shapes in lockstep), and the Files tree that joins the live listing
// (workspaceFiles.ts) with it (spaces-redesign D9).
// Pure core; only loadWorkspaceMap/loadAllMaps touch Obsidian, via their param.
import type { App } from "obsidian";
import { MAP_SKIP_TEXT, mapSkipReason, mapSkipsDir } from "./workspaceFiles";
import type { DirEntry, MapSkip } from "./workspaceFiles";

export const MAPS_DIR = "brain/_index/workspace-maps";

export interface MapFile {
  path: string;
  desc: string | null;
  descAt: string | null;
  mtime: number;
  size: number;
  status: "new" | "changed" | "fresh";
  descSource?: "model" | "heuristic" | null;   // who wrote `desc`; absent in maps written before it was recorded
}
export interface WorkspaceMap {
  workspace: string;
  generatedAt: string | null;
  files: MapFile[];
  pending: number;
}

export function mapStats(map: WorkspaceMap): { mapped: number; pending: number; total: number } {
  const total = map.files.length;
  const pending = map.files.filter((f) => f.desc === null || f.status !== "fresh").length;
  return { mapped: total - pending, pending, total };
}

// ── the Files tree: the live listing joined with the map (spaces-redesign D9) ──

/** NEW: the map has never described the file; CHANGED: it changed since its description. */
export type FileBadge = "new" | "changed";
/** The tree's filters: All · New · Changed. */
export type FileFilter = "all" | "new" | "changed";
export const FILE_FILTERS: readonly FileFilter[] = ["all", "new", "changed"];
export const FILE_FILTER_LABEL: Record<FileFilter, string> = { all: "All", new: "New", changed: "Changed" };
export const FILE_BADGE_LABEL: Record<FileBadge, string> = { new: "NEW", changed: "CHANGED" };
/** Where a file's description goes when the map has none yet. */
export const UNDESCRIBED_TEXT = "Not described yet";
/** Where it goes for a file the map skips (binary, over 1 MB, an ignored folder): no badge. */
export const NOT_MAPPED_TEXT = "not mapped";
/** ↻ per file and Describe N new under provider `none` (spaces-redesign D33). */
export const NEEDS_PROVIDER_TEXT = "Needs a model provider";

/** A map row's badge: NEW until it is first described, CHANGED while its description predates the file. */
export function fileBadge(f: Pick<MapFile, "status" | "desc">): FileBadge | null {
  if (f.status === "changed") return "changed";
  if (f.status === "new" || !f.desc) return "new";
  return null;
}

/** The map's counts under one folder ("" is the workspace root), every level below included. */
export interface DirRollup { files: number; described: number; new: number; changed: number }

/** The map by path, with a rollup per folder: built once per map, read by every tree level. */
export interface MapIndex {
  files: Map<string, MapFile>;
  dirs: Map<string, DirRollup>;
  generatedAt: string | null;
}

const parentOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

export function indexMap(map: WorkspaceMap | null | undefined): MapIndex {
  const files = new Map<string, MapFile>();
  const dirs = new Map<string, DirRollup>();
  const roll = (dir: string): DirRollup => {
    let r = dirs.get(dir);
    if (!r) { r = { files: 0, described: 0, new: 0, changed: 0 }; dirs.set(dir, r); }
    return r;
  };
  roll("");
  for (const f of map && Array.isArray(map.files) ? map.files : []) {
    if (!f || typeof f.path !== "string" || !f.path) continue;
    files.set(f.path, f);
    const badge = fileBadge(f);
    for (let dir = parentOf(f.path); ; dir = parentOf(dir)) {
      const r = roll(dir);
      r.files++;
      if (f.desc) r.described++;
      if (badge === "new") r.new++;
      else if (badge === "changed") r.changed++;
      if (dir === "") break;
    }
  }
  return { files, dirs, generatedAt: map?.generatedAt ?? null };
}

/** One row of the merged tree. */
export interface TreeRow {
  name: string;
  /** Relative to the workspace, `/`-separated. */
  rel: string;
  isDir: boolean;
  /** A file's map description; a folder's is its README.md's, when the map has one. */
  desc: string | null;
  /** What the description column shows: the description, "Not described yet", or "not mapped" (empty for a folder with none). */
  descText: string;
  /** NEW / CHANGED; a folder takes NEW when anything under it is new, else CHANGED when anything changed. */
  badge: FileBadge | null;
  /** False for a file the map skips or a folder it never walks into: "not mapped", no badge. */
  mapped: boolean;
  /** A mappable file with no description yet: "Not described yet", shown dimmed. */
  undescribed: boolean;
  /** Why the map skips it, and that in words for a tooltip. */
  skip: MapSkip | null;
  skipText: string | null;
  /** A mappable file the live listing has but the map does not know yet: NEW until the next scan describes it. */
  unscanned: boolean;
  size: number | null;
  descAt: string | null;
  descSource: "model" | "heuristic" | null;
  /** A folder's counts from the map (files under it, described, new, changed); null for a file. */
  rollup: DirRollup | null;
}

const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/**
 * One folder of the tree: the live listing of `relDir` ("" for the workspace root) in its order, each entry joined
 * with the map. A file the map skips reads "not mapped" with no badge; a mappable file the map has not seen yet is
 * NEW and "Not described yet" until the next scan.
 */
export function mergeDir(relDir: string, entries: DirEntry[], index: MapIndex): TreeRow[] {
  const dir = String(relDir || "").replace(/^\/+|\/+$/g, "");
  return entries.map((e): TreeRow => {
    const rel = joinRel(dir, e.name);
    if (e.isDir) {
      const skipped = mapSkipsDir(rel);
      const rollup = index.dirs.get(rel) ?? { files: 0, described: 0, new: 0, changed: 0 };
      const desc = index.files.get(`${rel}/README.md`)?.desc ?? null;
      return {
        name: e.name, rel, isDir: true, desc, descText: skipped ? NOT_MAPPED_TEXT : desc ?? "",
        badge: rollup.new ? "new" : rollup.changed ? "changed" : null, mapped: !skipped, undescribed: false,
        skip: null, skipText: skipped ? MAP_SKIP_TEXT.folder : null, unscanned: false, size: null,
        descAt: null, descSource: null, rollup,
      };
    }
    const f = index.files.get(rel);
    const size = typeof e.size === "number" ? e.size : f ? f.size : null;
    // The live size wins: a file that grew past 1 MB leaves the map at the next scan.
    const skip = mapSkipReason(rel, typeof e.size === "number" ? e.size : null);
    if (skip) {
      return { name: e.name, rel, isDir: false, desc: null, descText: NOT_MAPPED_TEXT, badge: null, mapped: false, undescribed: false, skip,
        skipText: MAP_SKIP_TEXT[skip], unscanned: false, size, descAt: null, descSource: null, rollup: null };
    }
    const desc = f?.desc ?? null;
    return {
      name: e.name, rel, isDir: false, desc, descText: desc ?? UNDESCRIBED_TEXT, badge: f ? fileBadge(f) : "new",
      mapped: true, undescribed: !desc, skip: null, skipText: null, unscanned: !f, size, descAt: f?.descAt ?? null,
      descSource: f?.descSource ?? null, rollup: null,
    };
  });
}

export interface TreeFilter { filter: FileFilter; query: string }

/** What a filter and a query keep of the map, and the folders above it (the pane opens those). */
export interface TreeMatches { active: boolean; files: Set<string>; dirs: Set<string> }

/** The filter box: "by path or description", case-insensitive. */
function queryHits(q: string, rel: string, desc: string | null): boolean {
  return !q || rel.toLowerCase().includes(q) || (desc ?? "").toLowerCase().includes(q);
}

export function treeMatches(index: MapIndex, f: TreeFilter): TreeMatches {
  const q = (f.query ?? "").trim().toLowerCase();
  const active = f.filter !== "all" || !!q;
  const files = new Set<string>();
  const dirs = new Set<string>();
  if (!active) return { active, files, dirs };
  for (const [rel, file] of index.files) {
    const badge = fileBadge(file);
    if (f.filter === "new" && badge !== "new") continue;
    if (f.filter === "changed" && badge !== "changed") continue;
    if (!queryHits(q, rel, file.desc)) continue;
    files.add(rel);
    for (let d = parentOf(rel); d; d = parentOf(d)) dirs.add(d);
  }
  return { active, files, dirs };
}

/**
 * Whether a row shows under the filter: map files by `treeMatches`, folders when they hold a match; a file the map has
 * not seen yet counts as New; a file the map skips shows only under All.
 */
export function rowVisible(row: TreeRow, f: TreeFilter, m: TreeMatches): boolean {
  if (!m.active) return true;
  const q = (f.query ?? "").trim().toLowerCase();
  const pathHit = !q || row.rel.toLowerCase().includes(q);
  if (row.isDir) return m.dirs.has(row.rel) || (f.filter === "all" && !!q && pathHit);
  if (!row.mapped) return f.filter === "all" && pathHit;
  if (row.unscanned) return f.filter !== "changed" && pathHit;
  return m.files.has(row.rel);
}

/** The filter chips' numbers: every file the map lists, the new ones and the changed ones. */
export function filterCounts(index: MapIndex): Record<FileFilter, number> {
  const root = index.dirs.get("") ?? { files: 0, described: 0, new: 0, changed: 0 };
  return { all: root.files, new: root.new, changed: root.changed };
}

/**
 * Describe N new: the map's new files plus the mappable files the listing has shown that the map does not know yet
 * (`unscanned`, workspace-relative). Only mappable files count, so the number never promises a binary or an
 * ignored folder.
 */
export function describeNewCount(index: MapIndex, unscanned: Iterable<string> = []): number {
  let n = filterCounts(index).new;
  const seen = new Set<string>();
  for (const rel of unscanned) {
    if (seen.has(rel) || index.files.has(rel) || mapSkipReason(rel)) continue;
    seen.add(rel);
    n++;
  }
  return n;
}

/** The line under the filters: "200 of 214 described · last described 2h ago" (the pane formats the time). */
export interface MapSummary { total: number; described: number; undescribed: number; new: number; changed: number; heuristic: number; lastDescribedAt: string | null }

export function mapSummary(map: WorkspaceMap | null | undefined): MapSummary {
  const files = map && Array.isArray(map.files) ? map.files : [];
  let described = 0, fresh = 0, changed = 0, heuristic = 0;
  let last: string | null = null;
  for (const f of files) {
    if (f.desc) described++;
    const b = fileBadge(f);
    if (b === "new") fresh++;
    else if (b === "changed") changed++;
    if (f.descSource === "heuristic") heuristic++;
    if (f.descAt && !Number.isNaN(Date.parse(f.descAt)) && (!last || Date.parse(f.descAt) > Date.parse(last))) last = f.descAt;
  }
  return { total: files.length, described, undescribed: files.length - described, new: fresh, changed, heuristic, lastDescribedAt: last };
}

/** Why ↻ per file is off (spaces-redesign D33): under provider `none` it would fail, so it says so. */
export function describeDisabledReason(provider: string | null | undefined): string | null {
  return !provider || provider === "none" ? NEEDS_PROVIDER_TEXT : null;
}

// ── IO ──
export async function loadWorkspaceMap(app: App, name: string): Promise<WorkspaceMap | null> {
  try {
    const raw = await app.vault.adapter.read(`${MAPS_DIR}/${name}.json`);
    const parsed = JSON.parse(raw) as WorkspaceMap;
    return parsed && Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null; // missing map = not yet scanned; renders as "no map yet"
  }
}

export async function loadAllMaps(app: App, names: string[]): Promise<Record<string, WorkspaceMap | null>> {
  const out: Record<string, WorkspaceMap | null> = {};
  for (const n of names) out[n] = await loadWorkspaceMap(app, n);
  return out;
}
