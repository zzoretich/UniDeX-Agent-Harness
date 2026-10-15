// Which folder a path is in by what the disk says the folders are (device and inode), not by how they are spelled. On
// macOS one folder has several spellings: another case or Unicode form, and the firmlinks that put the data volume
// under / (/System/Volumes/Data/<path> is /<path>), which no realpath turns back into the usual one. A spelling check
// misses those; the folder's identity does not.

import * as fs from "node:fs";
import * as path from "node:path";

export interface FolderId { dev: number; ino: number }

/** The identity of what is at `p` (links followed), or null when nothing is there. */
export function folderId(p: string): FolderId | null {
  try { const s = fs.statSync(p); return { dev: s.dev, ino: s.ino }; } catch { return null; }
}

/** Whether `a` and `b` are the same file or folder on the disk (both there). */
export function sameOnDisk(a: string, b: string): boolean {
  const x = folderId(a);
  const y = folderId(b);
  return !!x && !!y && x.dev === y.dev && x.ino === y.ino;
}

/**
 * The absolute path `p` relative to the first of `roots` that is `p` itself or one of its folders, `/`-separated (`""`
 * for a root itself), or null when none is. The part of `p` that is not there yet is kept as it is spelled.
 */
export function relUnder(roots: readonly FolderId[], p: string): string | null {
  if (!roots.length || !path.isAbsolute(p)) return null;
  const below: string[] = [];
  for (let at = path.resolve(p); ; at = path.dirname(at)) {
    const id = folderId(at);
    if (id && roots.some((r) => r.dev === id.dev && r.ino === id.ino)) return below.reverse().join("/");
    if (path.dirname(at) === at) return null;
    below.push(path.basename(at));
  }
}
