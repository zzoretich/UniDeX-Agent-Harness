// Writing a file of the user's own (the PATH line into ~/.zprofile, the CLAUDE.md line) without ever replacing a link
// (inspection round 2, M3). A dotfiles setup often makes these links, sometimes to a file that does not exist yet: the
// link is followed and kept, its target written (created when its folder is there), and refused otherwise.

import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomic } from "./atomic";

/** Where writing `file` must land: the end of its chain of links (which may not exist yet), or `file` itself. */
export function linkTarget(file: string): string {
  let at = file;
  const seen = new Set<string>();
  for (;;) {
    let st: fs.Stats;
    try { st = fs.lstatSync(at); } catch { return at; }
    if (!st.isSymbolicLink()) return at;
    if (seen.has(at) || seen.size >= 32) throw new Error(`${file} is a loop of links, so nothing was written`);
    seen.add(at);
    at = path.resolve(path.dirname(at), fs.readlinkSync(at));
  }
}

const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Writes `text` as `file`'s contents, atomically (an exclusive, unpredictable temp file beside the target, then a rename:
 * atomic.ts). A link stays a link: its target is written, and created when missing, provided the target's folder exists;
 * else nothing is written. Just before the rename the chain of links must still end where it did.
 */
export function writeKeepingLinks(file: string, text: string): void {
  const target = linkTarget(file);
  if (target === file) fs.mkdirSync(path.dirname(file), { recursive: true });
  else if (!isDir(path.dirname(target))) throw new Error(`${file} links to ${target}, whose folder does not exist, so nothing was written`);
  let mode = 0o644;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* a new file */ }
  writeAtomic(target, text, mode, () => linkTarget(file) === target);
}
