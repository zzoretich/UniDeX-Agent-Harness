// code:save-image (spec 2026-11-09-code-chat C7, C13): an image pasted, dropped or picked in the Code composer, saved by main
// into the app's own data folder so the agent can read it: `<userData>/code-images/<yyyy-mm>/<uuid>.<ext>`. The page sends
// a type and the bytes as base64, never a path or a name: main checks the type (PNG, JPEG, GIF or WebP), the size (at most
// 10 MB, from the base64's length before anything is decoded) and the content's magic bytes, which must agree with that
// type, then picks the path and creates the file exclusively (never over another), with the folders checked not to be
// links. The absolute path goes back to the page, which pastes it into the agent's prompt. The Code chat surface owns the
// call: while it is off every image is refused. Not the vault (it syncs and backs up screenshots) and not the temp folder
// (a resumed session would find the image gone). The folder holds at most 2 GiB or 5,000 files, and a month's folder goes
// about three months after its month ended (R59), so neither a page that loops nor ordinary use fills the disk.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeImage, CodeSaveImageRequest, Result } from "../../shared/ipc";
import { failure, refused } from "./fs";

/** The largest image the composer may attach (spec C7). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** The longest base64 an image of MAX_IMAGE_BYTES has. */
export const MAX_IMAGE_BASE64 = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

export type ImageKind = "png" | "jpeg" | "gif" | "webp";

const BY_MIME: Record<string, ImageKind> = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp" };
const EXT: Record<ImageKind, string> = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" };
const NAME: Record<ImageKind, string> = { png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP" };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** An image's type by its magic bytes alone, or null for anything else. */
export function sniffImage(b: Buffer): ImageKind | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6) {
    const head = b.toString("latin1", 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "gif";
  }
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** What base64 of this length and padding decodes to, read from the string alone. */
function decodedSize(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}

const fail = (error: string, code: string): Result<never> => ({ ok: false, error, code });

/** The most the images folder holds (code-chat R59): a save that would pass either is refused (ENOSPC). */
export const IMAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const IMAGE_QUOTA_FILES = 5000;
/** A month's folder goes this many days after its month ended: images are kept about three months (R59). */
export const IMAGE_KEEP_DAYS = 90;
/** One refusal reason is logged at most this often (R60). */
const LOG_EVERY_MS = 60_000;
const DAY_MS = 86_400_000;
/** The names main gives a month's folder and an image: anything else in the folder is not the app's to remove. */
const MONTH_NAME = /^\d{4}-\d{2}$/;
const IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

async function lstatOf(p: string): Promise<fs.Stats | null> {
  try { return await fs.promises.lstat(p); } catch { return null; }
}
async function namesIn(dir: string): Promise<string[]> {
  try { return await fs.promises.readdir(dir); } catch { return []; }
}
/** `dir` is a folder, not a link to one (lstat). */
async function plainFolder(dir: string): Promise<boolean> {
  const st = await lstatOf(dir);
  return !!st && st.isDirectory() && !st.isSymbolicLink();
}

/** An image the page sent, once checked: its type by content, and its bytes. */
export interface CheckedImage { kind: ImageKind; bytes: Buffer }

/**
 * The checks on what the page sent, in order and before anything touches the disk: a type other than PNG, JPEG, GIF or
 * WebP (EINVAL); more than MAX_IMAGE_BYTES, from the base64's length before it is decoded (EFBIG); base64 that is not
 * canonical (EINVAL); content whose magic bytes are no such image, or another type than `mime` (EINVAL).
 */
export function checkImage(req: CodeSaveImageRequest): Result<CheckedImage> {
  const kind = Object.prototype.hasOwnProperty.call(BY_MIME, req.mime) ? BY_MIME[req.mime] : null;
  if (!kind) return fail("only PNG, JPEG, GIF or WebP images", "EINVAL");
  const data = req.data;
  if (decodedSize(data) > MAX_IMAGE_BYTES) return fail("larger than 10 MB", "EFBIG");
  if (data.length % 4 !== 0 || !BASE64.test(data)) return fail("the image could not be read", "EINVAL");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) return fail("larger than 10 MB", "EFBIG");
  const found = sniffImage(bytes);
  if (!found) return fail("not a PNG, JPEG, GIF or WebP image", "EINVAL");
  if (found !== kind) return fail(`its content is ${NAME[found]}, not ${NAME[kind]}`, "EINVAL");
  return { ok: true, data: { kind, bytes } };
}

export interface SaveImageOptions {
  /** The month the image is filed under (default now, local time). */
  now?: Date;
  /** The file's name (default a fresh v4 UUID). */
  uuid?: () => string;
}

/**
 * Writes a checked image into `<userData>/code-images/<yyyy-mm>/<uuid>.<ext>`: each folder made and checked in turn (a link
 * where a folder should be is EROFS), then the file created exclusively and asynchronously (`wx`, 0600): a name that
 * exists is EEXIST, never overwritten.
 */
export async function writeImage(userData: string, img: CheckedImage, o: SaveImageOptions = {}): Promise<Result<CodeImage>> {
  if (!path.isAbsolute(userData)) return refused("not a folder main knows");
  const now = o.now ?? new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const root = path.join(userData, "code-images");
  const dir = path.join(root, month);
  // One folder at a time, each checked before the next is made in it: a link in place of either is refused, so nothing
  // is made or written wherever it leads (a recursive mkdir would follow it).
  for (const d of [root, dir]) {
    try {
      await fs.promises.mkdir(d, { recursive: d === root, mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return failure(err);
    }
    if (!(await plainFolder(d))) return refused("the images folder is not a plain folder");
  }
  const file = path.join(dir, `${(o.uuid ?? randomUUID)()}.${EXT[img.kind]}`);
  try {
    await fs.promises.writeFile(file, img.bytes, { flag: "wx", mode: 0o600 });
  } catch (err) { return failure(err); }
  return { ok: true, data: { path: file } };
}

/** Checks the image the page sent, then writes it (checkImage, then writeImage), and answers with its absolute path. */
export async function saveImage(userData: string, req: CodeSaveImageRequest, o: SaveImageOptions = {}): Promise<Result<CodeImage>> {
  const c = checkImage(req);
  return c.ok ? writeImage(userData, c.data, o) : c;
}

/** What the images folder holds. */
export interface ImageTally { bytes: number; files: number }

/** One readdir and lstat pass over the images folder: the regular files in it and in its folders, links neither followed
 *  nor counted. Nothing there (or a link in its place) is an empty tally. */
export async function tallyImages(userData: string): Promise<ImageTally> {
  const t: ImageTally = { bytes: 0, files: 0 };
  const root = path.join(userData, "code-images");
  if (!(await plainFolder(root))) return t;
  const count = (st: fs.Stats | null): void => { if (st?.isFile()) { t.files += 1; t.bytes += st.size; } };
  for (const name of await namesIn(root)) {
    const p = path.join(root, name);
    const st = await lstatOf(p);
    if (st?.isDirectory()) { for (const f of await namesIn(p)) count(await lstatOf(path.join(p, f))); } else count(st);
  }
  return t;
}

/**
 * Retention (R59): removes the images of every month folder whose month ended more than `keepDays` days before `now`
 * (default 90), then the folder if that leaves it empty. Only a plain `<yyyy-mm>` folder and plain `<uuid>.<ext>` files
 * main names are touched; links are never followed or removed, and a link in place of the images folder leaves
 * everything as it is. Answers how many images went.
 */
export async function pruneImages(userData: string, o: { now?: Date; keepDays?: number } = {}): Promise<number> {
  const now = (o.now ?? new Date()).getTime();
  const keep = (o.keepDays ?? IMAGE_KEEP_DAYS) * DAY_MS;
  const root = path.join(userData, "code-images");
  if (!path.isAbsolute(userData) || !(await plainFolder(root))) return 0;
  let removed = 0;
  for (const name of await namesIn(root)) {
    if (!MONTH_NAME.test(name)) continue;
    const [year, month] = name.split("-").map(Number);
    if (month < 1 || month > 12) continue;
    // The month ended at local midnight on the first of the next one.
    if (now - new Date(year, month, 1).getTime() <= keep) continue;
    const dir = path.join(root, name);
    if (!(await plainFolder(dir))) continue;
    for (const f of await namesIn(dir)) {
      if (!IMAGE_NAME.test(f)) continue;
      const p = path.join(dir, f);
      if (!(await lstatOf(p))?.isFile()) continue;
      try { await fs.promises.unlink(p); removed += 1; } catch { /* gone already */ }
    }
    try { await fs.promises.rmdir(dir); } catch { /* not empty: what is left is not the app's */ }
  }
  return removed;
}

export interface CodeImageOptions {
  /** The app's data folder (app.getPath("userData")). */
  userData: () => string;
  /** Whether the Code chat surface is on. */
  enabled: () => boolean;
  /** The quota (default IMAGE_QUOTA_BYTES and IMAGE_QUOTA_FILES) and the retention (default IMAGE_KEEP_DAYS). */
  maxBytes?: number;
  maxFiles?: number;
  keepDays?: number;
  /** For tests: the month an image is filed under, and its name. */
  now?: () => Date;
  uuid?: () => string;
  /** Where a refusal is logged (default console.warn), and the clock its once-a-minute limit reads. */
  log?: (line: string) => void;
  clock?: () => number;
}

/**
 * code:save-image behind the Code chat surface (C13), with the images folder's quota (R59): a running tally, counted once
 * from the folder on the first save, grows as each write is admitted (so saves at once are counted before they land) and
 * gives back a write that fails. prune() is the retention, run once after the app is ready.
 */
export class CodeImageService {
  private tally: Promise<ImageTally> | null = null;
  /** When each refusal reason was last logged. */
  private readonly logged = new Map<string, number>();

  constructor(private readonly o: CodeImageOptions) {}

  /** Logs a refusal's reason, at most once a minute per reason (R60), and answers it. */
  private answer<T>(r: Result<T>): Result<T> {
    if (r.ok) return r;
    const now = (this.o.clock ?? Date.now)();
    const last = this.logged.get(r.error);
    if (last === undefined || now - last >= LOG_EVERY_MS) {
      this.logged.set(r.error, now);
      (this.o.log ?? ((line: string) => console.warn(line)))(`[main] code:save-image: ${r.error}`);
    }
    return r;
  }

  async save(req: CodeSaveImageRequest): Promise<Result<CodeImage>> {
    if (!this.o.enabled()) return this.answer(refused("the Code chat surface is off"));
    const c = checkImage(req);
    if (!c.ok) return this.answer(c);
    const userData = this.o.userData();
    const t = await (this.tally ??= tallyImages(userData).catch(() => ({ bytes: 0, files: 0 })));
    const size = c.data.bytes.length;
    // Checked and counted with nothing awaited in between: two saves at once cannot both take the last place.
    if (t.bytes + size > (this.o.maxBytes ?? IMAGE_QUOTA_BYTES) || t.files + 1 > (this.o.maxFiles ?? IMAGE_QUOTA_FILES)) {
      return this.answer(fail("the images folder is full", "ENOSPC"));
    }
    t.bytes += size;
    t.files += 1;
    const r = await writeImage(userData, c.data, { now: this.o.now?.(), uuid: this.o.uuid });
    if (!r.ok) { t.bytes -= size; t.files -= 1; }
    return this.answer(r);
  }

  /** Retention: removes month folders whose month ended more than about three months ago; the tally is counted again on
   *  the next save. Answers how many images went. */
  async prune(now: Date = new Date()): Promise<number> {
    const removed = await pruneImages(this.o.userData(), { now, keepDays: this.o.keepDays });
    this.tally = null;
    return removed;
  }
}
