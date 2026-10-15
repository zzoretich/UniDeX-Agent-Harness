// One atomic write for the files this app writes into folders it does not own alone (inspection round 3, F2): the temp
// file has an unpredictable name and is created exclusively (O_CREAT | O_EXCL | O_NOFOLLOW), so a link planted where a
// predictable name would be is never followed; the destination is checked again just before the rename; and on any
// failure only the temp file this write created is removed.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const EXCL = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

/** A fresh, unpredictable name beside `target`, opened exclusively; the open fails rather than follow anything there. */
export function exclusiveTemp(target: string, mode: number, suffix = "tmp"): { path: string; fd: number } {
  for (let tries = 0; ; tries++) {
    const p = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(9).toString("hex")}.${suffix}`);
    try { return { path: p, fd: fs.openSync(p, EXCL, mode) }; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || tries >= 8) throw err;
    }
  }
}

/**
 * Writes `text` to `target` through an exclusive temp file and one rename. `stillOk`, when given, is asked again right
 * before the rename (the destination may have changed meanwhile); false or a throw leaves `target` untouched.
 */
export function writeAtomic(target: string, text: string, mode = 0o644, stillOk?: () => boolean): void {
  const tmp = exclusiveTemp(target, mode);
  try {
    fs.writeSync(tmp.fd, text);
    fs.closeSync(tmp.fd);
    tmp.fd = -1;
    if (stillOk && !stillOk()) throw new Error(`${target} changed while it was being written, so nothing was written`);
    fs.renameSync(tmp.path, target);
  } catch (err) {
    if (tmp.fd >= 0) { try { fs.closeSync(tmp.fd); } catch { /* closed */ } }
    try { fs.unlinkSync(tmp.path); } catch { /* renamed, or gone */ }
    throw err;
  }
}
