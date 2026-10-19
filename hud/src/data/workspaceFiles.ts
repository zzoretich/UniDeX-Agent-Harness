import * as path from "path";
import { fs, utf8, utf8Bytes } from "../host";

export const IGNORED = new Set([".git", "node_modules", ".DS_Store"]);

export function isIgnored(name: string): boolean {
  return IGNORED.has(name);
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  /** A file's size in bytes, when listDir could stat it (the Files tree's "not mapped" over 1 MB, spaces-redesign D9). */
  size?: number;
}

// ── what the file map skips (spaces-redesign D9) ──
// A mirror of brain/scripts/collectors/fileMap.js walkFiles/mappableFile, pinned by workspaceFiles.test.ts against the
// runtime's own mappableFile: a file the map skips shows "not mapped" with no badge in the Files tree, and Describe N new
// never counts it.

export const MAP_IGNORED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".obsidian", "dist", "build", "__pycache__", ".venv"]);
export const MAP_IGNORED_FILES: ReadonlySet<string> = new Set([".DS_Store", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock"]);
export const MAP_IGNORED_EXTS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".pdf", ".zip", ".gz", ".tar",
  ".mp3", ".mp4", ".mov", ".wav", ".woff", ".woff2", ".ttf", ".otf", ".pptx", ".xlsx", ".docx", ".bin", ".dylib", ".node"]);
export const MAP_MAX_SIZE = 1024 * 1024;

/** Why the map skips a file, for the "not mapped" tooltip. */
export type MapSkip = "hidden" | "folder" | "name" | "type" | "size";
export const MAP_SKIP_TEXT: Record<MapSkip, string> = {
  hidden: "Not mapped: a dot file or folder",
  folder: "Not mapped: inside a folder the map skips (node_modules, dist, build…)",
  name: "Not mapped: a lock file or .DS_Store",
  type: "Not mapped: an image, media, archive or binary type",
  size: "Not mapped: over 1 MB",
};

/**
 * Why the map skips the file at `relPath` (relative to the workspace, `/`-separated), or null when the map describes
 * it. `size` is its byte size when known; an unknown size passes, as the map would stat it.
 */
export function mapSkipReason(relPath: string, size?: number | null): MapSkip | null {
  const segs = String(relPath).split("/").filter((s) => s !== "");
  const name = segs[segs.length - 1] ?? "";
  if (segs.some((s) => s.startsWith(".") && s !== ".github")) return "hidden";
  if (segs.slice(0, -1).some((s) => MAP_IGNORED_DIRS.has(s))) return "folder";
  if (MAP_IGNORED_FILES.has(name)) return "name";
  if (MAP_IGNORED_EXTS.has(path.extname(name).toLowerCase())) return "type";
  if (typeof size === "number" && size > MAP_MAX_SIZE) return "size";
  return null;
}

/** Whether the map never walks into the folder at `relDir` (a dot folder other than .github, or a skipped name). */
export function mapSkipsDir(relDir: string): boolean {
  return String(relDir).split("/").filter((s) => s !== "").some((s) => (s.startsWith(".") && s !== ".github") || MAP_IGNORED_DIRS.has(s));
}

export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export const TEXT_EXTS = new Set([
  ".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json",
  ".yml", ".yaml", ".css", ".scss", ".html", ".xml", ".svg", ".sh", ".bash",
  ".zsh", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".toml",
  ".ini", ".cfg", ".conf", ".env", ".log", ".csv", ".sql",
  // dotfile basenames (extname() returns "" for these)
  ".gitignore", ".eslintrc", ".prettierrc", ".editorconfig",
]);

export const MAX_PREVIEW_BYTES = 200 * 1024;
export const MAX_PREVIEW_LINES = 5000;

export function truncate(text: string): { text: string; truncated: boolean } {
  let truncated = false;
  let out = text;
  const bytes = utf8Bytes(out);
  if (bytes.length > MAX_PREVIEW_BYTES) {
    out = utf8(bytes.subarray(0, MAX_PREVIEW_BYTES));
    // a byte cut can land mid-codepoint; toString() leaves a trailing U+FFFD — drop it
    if (out.endsWith("�")) out = out.slice(0, -1);
    truncated = true;
  }
  const lines = out.split("\n");
  if (lines.length > MAX_PREVIEW_LINES) {
    out = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
    truncated = true;
  }
  return { text: out, truncated };
}

/** One folder's entries, IGNORED left out, folders first; each file with its size when a stat answers. */
export async function listDir(absDir: string): Promise<DirEntry[]> {
  const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (isIgnored(d.name)) continue;
    const e: DirEntry = { name: d.name, isDir: d.isDirectory() };
    if (!e.isDir) {
      try { e.size = (await fs.promises.stat(path.join(absDir, d.name))).size; } catch { /* a dangling link: no size */ }
    }
    entries.push(e);
  }
  return sortEntries(entries);
}

const SNIFF_BYTES = 8192;

export type PreviewKind = "text" | "binary" | "empty";

export interface PreviewResult {
  kind: PreviewKind;
  size: number;
  text?: string;
  truncated?: boolean;
}

export async function readPreview(absPath: string): Promise<PreviewResult> {
  const stat = await fs.promises.stat(absPath);
  const size = stat.size;
  if (size === 0) return { kind: "empty", size };

  const sniff = fs.readBytesSync(absPath, 0, Math.min(SNIFF_BYTES, size));
  if (!looksTextual(path.basename(absPath), sniff)) {
    return { kind: "binary", size };
  }
  const readLen = Math.min(size, MAX_PREVIEW_BYTES);
  // small file already fully captured by the sniff read — no second I/O
  const data = readLen <= sniff.length ? sniff.subarray(0, readLen) : fs.readBytesSync(absPath, 0, readLen);
  const { text, truncated } = truncate(utf8(data));
  return { kind: "text", size, text, truncated: truncated || size > MAX_PREVIEW_BYTES };
}

export function looksTextual(name: string, sample: Uint8Array): boolean {
  const lower = name.toLowerCase();
  const ext = path.extname(lower);
  if (ext && TEXT_EXTS.has(ext)) return true;
  if (lower.startsWith(".") && TEXT_EXTS.has(lower)) return true;
  // No bytes to sniff for an unknown file type → can't confirm text.
  if (sample.length === 0) return false;
  // Fallback heuristic: a NUL byte means binary.
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  return true;
}
