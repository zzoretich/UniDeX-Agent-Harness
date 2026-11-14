// Held downloads (agent-computer D39): a download always asks, and nothing lands in Downloads before Allow. Chromium can
// have every byte before the person answers (a small file arrives with its headers, and pause() does not stop it
// finishing), so the browser saves each download into a private folder of its own in the user's system temp folder
// (macOS's per-user `$TMPDIR`; mkdtemp makes it 0700) and moves it into Downloads only once allowed. A folder is removed
// when its download settles, when its browser goes (quitting included), and, for one a crash left behind, by the sweep
// at the next start. Folder names carry the pid of the app that made them, so the sweep never takes a running app's.
// No Electron here, so the unit tests drive it.

import fs from "node:fs";
import path from "node:path";

/** A held folder's name: this prefix, the app's pid, a dash, then mkdtemp's random suffix. */
export const HELD_PREFIX = "unidex-download-";

/** A download's file name: no folders, no control characters, not hidden. */
export function downloadName(suggested: string): string {
  // Bidirectional controls, zero-width characters and line separators go too (M1): a page-chosen name must not read
  // differently in a note or an ask than on disk.
  return path.basename(suggested).replace(/[\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f/\\:]/g, "_").replace(/^\.+/, "").trim() || "download";
}

/** The `i`th place for `name` in `dir`: the name itself, then `stem (1).ext`, `stem (2).ext`, and so on. */
export function downloadPath(dir: string, name: string, i = 0): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return path.join(dir, i ? `${stem} (${i})${ext}` : name);
}

/** The file operations moveInto uses (node:fs; the tests stand in for one). */
export interface MoveOps {
  linkSync(from: string, to: string): void;
  unlinkSync(p: string): void;
  copyFileSync(from: string, to: string, mode: number): void;
}

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/**
 * Moves a held download to `name` in `dir`, never over a file: a hard link fails if anything is at the path (EEXIST),
 * so a file there already, or one that appears meanwhile, sends it to the next free name; then the held file goes. On
 * another volume (EXDEV) it copies with COPYFILE_EXCL, which refuses an existing file the same way. Returns the path.
 */
export function moveInto(from: string, dir: string, name: string, ops: MoveOps = fs): string {
  for (let i = 0; i < 10_000; i++) {
    const to = downloadPath(dir, name, i);
    try {
      ops.linkSync(from, to);
    } catch (e) {
      if (code(e) === "EEXIST") continue;
      if (code(e) !== "EXDEV") throw e;
      try { ops.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); } catch (c) { if (code(c) === "EEXIST") continue; throw c; }
    }
    ops.unlinkSync(from);
    return to;
  }
  throw new Error(`no free name for ${name} in ${dir}`);
}

/** The held folders one browser has open; each goes when its download settles, or all at once when the browser does. */
export class HeldDownloads {
  private readonly dirs = new Set<string>();

  constructor(private readonly tmp: () => string, private readonly pid: number = process.pid) {}

  /** A new private folder (0700) for one download. Throws when it cannot be made. */
  hold(): string {
    const dir = fs.mkdtempSync(path.join(this.tmp(), `${HELD_PREFIX}${this.pid}-`));
    this.dirs.add(dir);
    return dir;
  }

  /** Removes one held folder and whatever is in it. */
  drop(dir: string): void {
    this.dirs.delete(dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }

  /** Removes every held folder (the browser is going, or the app is quitting). */
  dropAll(): void {
    for (const dir of [...this.dirs]) this.drop(dir);
  }

  get size(): number { return this.dirs.size; }
}

/** Whether a process is there (another user's counts). */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return code(e) === "EPERM"; }
}

/**
 * At start: removes the held folders in `tmp` that no running app holds, those a crash or a kill left behind. A folder
 * whose name carries this app's pid, or a live one's, stays (so one made while this runs stays too); one with no pid in
 * its name is removed. Never throws or rejects; resolves with what it removed. It is asynchronous because the system's
 * temp folder is not the app's to keep small: listing one with 476,719 entries took 0.4 s on a quiet machine and
 * 20 to 48 s while another process walked it, and a synchronous listing held the whole app, window included. It reads the
 * folder entry by entry, so it holds no list of it either.
 */
export async function sweepHeld(tmp: string, alive: (pid: number) => boolean = pidAlive, self: number = process.pid): Promise<string[]> {
  const out: string[] = [];
  try {
    const dir = await fs.promises.opendir(tmp);
    for await (const entry of dir) {
      const n = entry.name;
      if (!n.startsWith(HELD_PREFIX)) continue;
      const pid = Number(/^(\d+)-/.exec(n.slice(HELD_PREFIX.length))?.[1]);
      if (Number.isInteger(pid) && pid > 0 && (pid === self || alive(pid))) continue;
      const held = path.join(tmp, n);
      try {
        if (!(await fs.promises.lstat(held)).isDirectory()) continue;
        await fs.promises.rm(held, { recursive: true, force: true });
        out.push(held);
      } catch { /* gone, or not ours to remove */ }
    }
  } catch { /* no such folder, or not a folder: nothing to do */ }
  return out;
}
