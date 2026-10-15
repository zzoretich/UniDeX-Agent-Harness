// The page's file system, in main (phase 4, S2 and S3). Every read is checked against the read scope and every write
// against the write policy before it reaches the disk; what is refused comes back as EROFS, and nothing is thrown at
// the bridge. No Electron here, so the unit tests drive it directly (tests/unit/main-services.test.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { isIgnoredName } from "../../../compat/src/ignore";
import type { DirEntryInfo, Result, StatInfo, WalkEntry, WriteVia } from "../../shared/ipc";
import type { ReadScope } from "../policy/read-scope";
import type { WritePolicy } from "../policy/write-policy";

/** The largest file the page may read whole, or write in one call. */
export const MAX_TEXT_BYTES = 64 * 1024 * 1024;
/** The most bytes one ranged read returns. */
export const MAX_RANGE_BYTES = 16 * 1024 * 1024;
/** The most files a vault walk lists. */
export const MAX_WALK = 200_000;

export const refused = (why: string): Result<never> => ({ ok: false, error: why, code: "EROFS" });

/** A Node error as a Result: its code, and no path (the page knows which path it asked for). */
export function failure(err: unknown): Result<never> {
  const code = (err as NodeJS.ErrnoException)?.code;
  return { ok: false, error: typeof code === "string" ? code : "failed", code: typeof code === "string" ? code : "EIO" };
}

const ok = <T>(data: T): Result<T> => ({ ok: true, data });

/** How long a change waits for a move to the Trash before it is answered `giveUp` (the page is blocked meanwhile). */
export const TRASH_HOLD_MS = 5000;

/**
 * Answers a change the page asked for once no move to the Trash is in flight (`pending`), so a trash's check and the
 * move itself are one step for the page: nothing it asks for runs in between. With none in flight, at once, in the same
 * turn. A trash that takes longer than `giveUp.ms` never leaves the page blocked: the change is answered `giveUp.value`
 * and not made.
 */
export function afterTrash<T>(pending: () => Promise<unknown> | null, run: () => T, reply: (value: T) => void,
  giveUp?: { ms: number; value: T }): void {
  if (!pending()) { reply(run()); return; }
  let settled = false;
  const timer = giveUp ? setTimeout(() => { if (!settled) { settled = true; reply(giveUp.value); } }, giveUp.ms) : null;
  const go = (): void => {
    if (settled) return;
    const wait = pending();
    if (wait) { void wait.then(go, go); return; }
    settled = true;
    if (timer) clearTimeout(timer);
    reply(run());
  };
  go();
}

function stats(s: fs.Stats, link = false): StatInfo {
  return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, file: s.isFile(), dir: s.isDirectory(), link, nlink: s.nlink };
}

/** Why a hard link is not the page's to change. */
export const HARD_LINKED = "it has other names on disk (hard links): a change here would change them too";

/**
 * A refusal when `p` is, or a link at `p` reaches, a regular file with other names on disk (a hard link): changing or
 * removing it here would reach those names too, and they can be anywhere, a protected folder included, where no path
 * check sees them. Null otherwise (not there, one name, or not a file).
 */
function hardLinked(p: string): Result<never> | null {
  for (const st of [() => fs.lstatSync(p), () => fs.statSync(p)]) {
    try { const s = st(); if (s.isFile() && s.nlink > 1) return { ok: false, error: HARD_LINKED, code: "EMLINK" }; } catch { /* not there */ }
  }
  return null;
}

export interface FsServiceOptions {
  vaultRoot: string | null;
  userData: string;
  scope: () => ReadScope;
  policy: () => WritePolicy;
}

export class FsService {
  /** The moves to the Trash, one after another; `trashing` counts those not done. */
  private trashQueue: Promise<unknown> = Promise.resolve();
  private trashing = 0;

  constructor(private readonly o: FsServiceOptions) {}

  exists(p: string): Result<boolean> {
    if (!this.o.scope().canProbe(p)) return refused("outside what the app reads");
    return ok(fs.existsSync(p));
  }

  stat(p: string): Result<StatInfo> {
    if (!this.o.scope().canProbe(p)) return refused("outside what the app reads");
    try { return ok(stats(fs.statSync(p))); } catch (err) { return failure(err); }
  }

  readText(p: string): Result<string> {
    if (!this.o.scope().canRead(p)) return refused("outside what the app reads");
    try {
      if (fs.statSync(p).size > MAX_TEXT_BYTES) return { ok: false, error: "too large", code: "EFBIG" };
      return ok(fs.readFileSync(p, "utf8"));
    } catch (err) { return failure(err); }
  }

  readBytes(p: string, position: number, length: number): Result<Uint8Array> {
    if (!this.o.scope().canRead(p)) return refused("outside what the app reads");
    const want = Math.min(Math.max(0, length), MAX_RANGE_BYTES);
    let fd: number | null = null;
    try {
      fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, position);
      return ok(new Uint8Array(buf.buffer, buf.byteOffset, n).slice());
    } catch (err) { return failure(err); } finally { if (fd !== null) fs.closeSync(fd); }
  }

  readdir(p: string): Result<DirEntryInfo[]> {
    if (!this.o.scope().canList(p)) return refused("outside what the app reads");
    try {
      return ok(fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, file: d.isFile(), dir: d.isDirectory(), link: d.isSymbolicLink() })));
    } catch (err) { return failure(err); }
  }

  /** Every file under the vault with its stats, skipping what the vault index skips (dot-paths, node_modules, worktrees). */
  walk(): Result<WalkEntry[]> {
    const root = this.o.vaultRoot;
    if (!root) return refused("no vault");
    const out: WalkEntry[] = [];
    const visit = (dir: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= MAX_WALK) return;
        if (isIgnoredName(e.name)) continue;
        const rel = prefix + e.name;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) visit(abs, `${rel}/`);
        else if (e.isFile()) {
          try { const s = fs.statSync(abs); out.push({ rel, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }); } catch { /* gone */ }
        }
      }
    };
    visit(root, "");
    return ok(out);
  }

  /** Creates the missing folders above `p`, each one only where the policy lets a folder be made. */
  private makeParents(p: string): Result<null> | null {
    const missing: string[] = [];
    for (let dir = path.dirname(p); !fs.existsSync(dir); dir = path.dirname(dir)) {
      if (dir === path.dirname(dir)) break;
      missing.unshift(dir);
    }
    for (const dir of missing) {
      if (!this.o.policy().canMakeFolder(dir)) return refused("a folder no write surface creates");
      try { fs.mkdirSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") return failure(err); }
    }
    return null;
  }

  writeText(p: string, data: string, via: WriteVia): Result<null> {
    const policy = this.o.policy();
    if (!(via === "editor" ? policy.canSave(p) : policy.canWrite(p))) return refused("no write surface allows it");
    if (Buffer.byteLength(data) > MAX_TEXT_BYTES) return { ok: false, error: "too large", code: "EFBIG" };
    const linked = hardLinked(p);
    if (linked) return linked;
    const parents = this.makeParents(p);
    if (parents) return parents;
    try { fs.writeFileSync(p, data, "utf8"); return ok(null); } catch (err) { return failure(err); }
  }

  appendText(p: string, data: string): Result<null> {
    if (!this.o.policy().canWrite(p)) return refused("no write surface allows it");
    if (Buffer.byteLength(data) > MAX_TEXT_BYTES) return { ok: false, error: "too large", code: "EFBIG" };
    const linked = hardLinked(p);
    if (linked) return linked;
    try { fs.appendFileSync(p, data, "utf8"); return ok(null); } catch (err) { return failure(err); }
  }

  /** A folder: nothing to do when it exists; otherwise the policy decides, for it and (recursive) each missing parent. */
  mkdir(p: string, recursive: boolean): Result<null> {
    if (fs.existsSync(p)) return recursive || fs.statSync(p).isDirectory() ? ok(null) : { ok: false, error: "EEXIST", code: "EEXIST" };
    if (!this.o.policy().canMakeFolder(p)) return refused("a folder no write surface creates");
    if (recursive) {
      const parents = this.makeParents(p);
      if (parents) return parents;
    }
    try { fs.mkdirSync(p); return ok(null); } catch (err) { return failure(err); }
  }

  /** One file. A folder and what is in it never goes for good: the Files tab sends it to the Trash, where it can be restored. */
  remove(p: string, recursive: boolean): Result<null> {
    if (recursive) return refused("a folder goes to the Trash, not away for good");
    if (!this.o.policy().canWrite(p)) return refused("no write surface allows it");
    const linked = hardLinked(p);
    if (linked) return linked;
    try { fs.rmSync(p, { force: true }); return ok(null); } catch (err) { return failure(err); }
  }

  rename(from: string, to: string): Result<null> {
    const policy = this.o.policy();
    if (!policy.canMoveTree(from) || !policy.canWrite(to)) return refused("no write surface allows both ends");
    try { fs.renameSync(from, to); return ok(null); } catch (err) { return failure(err); }
  }

  /**
   * A copy never makes a file executable: a new file gets the source's read and write bits only, and a file that was
   * there keeps its own mode (the copy would take the source's), so a user's own script stays as they set it.
   */
  copy(from: string, to: string): Result<null> {
    if (!this.o.scope().canRead(from)) return refused("outside what the app reads");
    if (!this.o.policy().canWrite(to)) return refused("no write surface allows it");
    const linked = hardLinked(to);
    if (linked) return linked;
    let before: number | null = null;
    try { before = fs.statSync(to).mode & 0o7777; } catch { /* a new file */ }
    try {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, before ?? (fs.statSync(to).mode & 0o666));
      return ok(null);
    } catch (err) { return failure(err); }
  }

  /** Whether `p` may go to the Trash with everything in it. */
  canTrash(p: string): boolean { return this.o.policy().canMoveTree(p); }

  /**
   * Sends `p` to the Trash with `trashItem` (Electron's shell.trashItem), after every earlier one, checked when its turn
   * comes. Until it is done, pending() names it, and the bridge holds the page's other changes (afterTrash).
   */
  trash(p: string, trashItem: (p: string) => Promise<void>): Promise<Result<null>> {
    this.trashing++;
    const run = async (): Promise<Result<null>> => {
      try {
        if (!this.canTrash(p)) return refused("no write surface allows it");
        await trashItem(p);
        return ok(null);
      } catch (err) { return failure(err); } finally { this.trashing--; }
    };
    const done = this.trashQueue.then(run, run);
    this.trashQueue = done;
    return done;
  }

  /** While a move to the Trash is in flight: a promise that settles when every one asked for so far is done. */
  pending(): Promise<unknown> | null { return this.trashing > 0 ? this.trashQueue : null; }

  /**
   * A plugin's settings: the app's own copy, else what Obsidian kept in the vault (read, never written). Obsidian's is
   * copied into the app's data the first time it is read, so the user can remove the old plugin folder (the migration
   * guide says to) without losing their settings; a copy that cannot be written is tried again on the next read.
   */
  loadPluginData(id: string): Result<unknown> {
    const own = path.join(this.o.userData, "plugins", `${id}.json`);
    try { return ok(JSON.parse(fs.readFileSync(own, "utf8")) as unknown); } catch { /* none of its own yet */ }
    if (!this.o.vaultRoot) return ok(null);
    let data: unknown;
    try { data = JSON.parse(fs.readFileSync(path.join(this.o.vaultRoot, ".obsidian", "plugins", id, "data.json"), "utf8")); } catch { return ok(null); }
    this.savePluginData(id, `${JSON.stringify(data, null, 2)}\n`);
    return ok(data);
  }

  savePluginData(id: string, json: string): Result<null> {
    try { JSON.parse(json); } catch { return { ok: false, error: "not JSON", code: "EINVAL" }; }
    const dir = path.join(this.o.userData, "plugins");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.json`), json, "utf8");
      return ok(null);
    } catch (err) { return failure(err); }
  }
}
