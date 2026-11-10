// code:save-image (spec 2026-11-09-code-chat C7, C13): an image pasted, dropped or picked in the Code composer, saved by main
// into the app's own data folder so the agent can read it: `<userData>/code-images/<yyyy-mm>/<uuid>.<ext>`. The page sends
// a type and the bytes as base64, never a path or a name: main checks the type (PNG, JPEG, GIF or WebP), the size (at most
// 10 MB, from the base64's length before anything is decoded) and the content's magic bytes, which must agree with that
// type, then picks the path and creates the file exclusively (never over another), with the folders checked not to be
// links. The absolute path goes back to the page, which pastes it into the agent's prompt. The Code chat surface owns the
// call: while it is off every image is refused. Not the vault (it syncs and backs up screenshots) and not the temp folder
// (a resumed session would find the image gone).

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

/** `dir` is a folder, not a link to one (lstat). */
function plainFolder(dir: string): boolean {
  try { const st = fs.lstatSync(dir); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
}

export interface SaveImageOptions {
  /** The month the image is filed under (default now, local time). */
  now?: Date;
  /** The file's name (default a fresh v4 UUID). */
  uuid?: () => string;
}

/**
 * Saves the image the page sent into `<userData>/code-images/<yyyy-mm>/<uuid>.<ext>` and answers with its absolute path.
 * Refused: a type other than PNG, JPEG, GIF or WebP (EINVAL); more than MAX_IMAGE_BYTES, from the base64's length (EFBIG);
 * base64 that is not canonical (EINVAL); content whose magic bytes are no such image or another type than `mime` (EINVAL);
 * a link where a folder should be (EROFS). The file is created exclusively: a name that exists is EEXIST, never overwritten.
 */
export function saveImage(userData: string, req: CodeSaveImageRequest, o: SaveImageOptions = {}): Result<CodeImage> {
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
  if (!path.isAbsolute(userData)) return refused("not a folder main knows");
  const now = o.now ?? new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const root = path.join(userData, "code-images");
  const dir = path.join(root, month);
  // One folder at a time, each checked before the next is made in it: a link in place of either is refused, so nothing
  // is made or written wherever it leads (a recursive mkdir would follow it).
  for (const d of [root, dir]) {
    try {
      fs.mkdirSync(d, { recursive: d === root, mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return failure(err);
    }
    if (!plainFolder(d)) return refused("the images folder is not a plain folder");
  }
  const file = path.join(dir, `${(o.uuid ?? randomUUID)()}.${EXT[kind]}`);
  try {
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  } catch (err) { return failure(err); }
  return { ok: true, data: { path: file } };
}

export interface CodeImageOptions {
  /** The app's data folder (app.getPath("userData")). */
  userData: () => string;
  /** Whether the Code chat surface is on. */
  enabled: () => boolean;
}

/** code:save-image behind the Code chat surface (C13). */
export class CodeImageService {
  constructor(private readonly o: CodeImageOptions) {}

  save(req: CodeSaveImageRequest): Result<CodeImage> {
    if (!this.o.enabled()) { console.warn("[main] code:save-image: the Code chat surface is off"); return refused("the Code chat surface is off"); }
    const r = saveImage(this.o.userData(), req);
    if (!r.ok) console.warn(`[main] code:save-image: ${r.error}`);
    return r;
  }
}
