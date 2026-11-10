// code:save-image (spec 2026-11-09-code-chat C7, C13): the Code composer's pasted image, saved by main into the app's own
// data folder, `<userData>/code-images/<yyyy-mm>/<uuid>.<ext>`. Main checks the type the page names (PNG, JPEG, GIF or
// WebP), the size (10 MB at most, from the base64's length before anything is decoded) and the content's magic bytes,
// which must agree with that type; it picks the path and creates the file exclusively. The page never names a path. The
// Code chat surface owns it: off, every call is refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeSaveImageArgs } from "../../src/main/ipc/schemas";
import { CodeImageService, MAX_IMAGE_BYTES, saveImage, sniffImage } from "../../src/main/services/code-images";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-code-images-")));
let n = 0;
/** A fresh app data folder (with a space, as the real one has). */
const userData = (): string => { const d = path.join(tmp, `App Data ${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const GIF87 = Buffer.from("GIF87a\x01\x00\x01\x00", "latin1");
const GIF89 = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([26, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const b64 = (b: Buffer): string => b.toString("base64");
const NOV = new Date(2026, 10, 10, 9, 30);

test("sniffImage knows each type by its magic bytes alone", () => {
  assert.equal(sniffImage(PNG), "png");
  assert.equal(sniffImage(JPEG), "jpeg");
  assert.equal(sniffImage(GIF87), "gif");
  assert.equal(sniffImage(GIF89), "gif");
  assert.equal(sniffImage(WEBP), "webp");
  // Near misses: a cut PNG signature, a RIFF that is not WebP (a WAV), GIF's 88a, two JPEG bytes, text, nothing.
  assert.equal(sniffImage(PNG.subarray(0, 7)), null);
  assert.equal(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.from([26, 0, 0, 0]), Buffer.from("WAVEfmt ")])), null);
  assert.equal(sniffImage(Buffer.from("GIF88a\x01\x00", "latin1")), null);
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null);
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("an image is written under <userData>/code-images/<yyyy-mm>/<uuid>.<ext>, its bytes as sent, and the absolute path comes back", () => {
  const ud = userData();
  const cases: Array<[string, Buffer, string]> = [["image/png", PNG, "png"], ["image/jpeg", JPEG, "jpg"], ["image/gif", GIF89, "gif"], ["image/webp", WEBP, "webp"]];
  for (const [mime, bytes, ext] of cases) {
    const r = saveImage(ud, { mime, data: b64(bytes) }, { now: NOV });
    assert.ok(r.ok, `${mime}: ${r.ok ? "" : r.error}`);
    const p = r.data.path;
    assert.ok(path.isAbsolute(p), p);
    assert.equal(path.dirname(p), path.join(ud, "code-images", "2026-11"));
    assert.match(path.basename(p), new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${ext}$`));
    assert.deepEqual(fs.readFileSync(p), bytes);
  }
  // Each save is a new file.
  assert.equal(fs.readdirSync(path.join(ud, "code-images", "2026-11")).length, 4);
});

test("a PNG labelled image/gif is refused, and so is any content that disagrees with its type; nothing is written", () => {
  const ud = userData();
  const pngAsGif = saveImage(ud, { mime: "image/gif", data: b64(PNG) }, { now: NOV });
  assert.equal(pngAsGif.ok, false);
  assert.equal(!pngAsGif.ok && pngAsGif.code, "EINVAL");
  assert.equal(!pngAsGif.ok && pngAsGif.error, "its content is PNG, not GIF");
  const jpegAsPng = saveImage(ud, { mime: "image/png", data: b64(JPEG) }, { now: NOV });
  assert.equal(!jpegAsPng.ok && jpegAsPng.error, "its content is JPEG, not PNG");
  // Not an image at all, under an image type.
  const text = saveImage(ud, { mime: "image/png", data: b64(Buffer.from("not an image at all")) }, { now: NOV });
  assert.equal(!text.ok && text.error, "not a PNG, JPEG, GIF or WebP image");
  assert.equal(fs.existsSync(path.join(ud, "code-images")), false);
});

test("unknown types are refused before anything is read: SVG, TIFF, HEIC, a type with parameters, an empty one", () => {
  const ud = userData();
  for (const mime of ["image/svg+xml", "image/tiff", "image/heic", "image/png; charset=x", "IMAGE/PNG", "text/plain", ""]) {
    const r = saveImage(ud, { mime, data: b64(PNG) }, { now: NOV });
    assert.equal(r.ok, false, mime);
    assert.equal(!r.ok && r.code, "EINVAL", mime);
    assert.equal(!r.ok && r.error, "only PNG, JPEG, GIF or WebP images", mime);
  }
  assert.equal(fs.existsSync(path.join(ud, "code-images")), false);
});

test("10 MB is the limit: exactly 10 MB is saved, 10 MB + 1 byte is refused by its length before it is decoded", () => {
  const ud = userData();
  const at = Buffer.alloc(MAX_IMAGE_BYTES);
  PNG.copy(at);
  const ok = saveImage(ud, { mime: "image/png", data: b64(at) }, { now: NOV });
  assert.ok(ok.ok);
  assert.equal(fs.statSync(ok.data.path).size, MAX_IMAGE_BYTES);
  const over = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  PNG.copy(over);
  const data = b64(over);
  // 10 MB and 10 MB + 1 byte have base64 of the same length; only the padding tells them apart.
  assert.equal(data.length, b64(at).length);
  const r = saveImage(ud, { mime: "image/png", data }, { now: NOV });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "EFBIG");
  assert.equal(!r.ok && r.error, "larger than 10 MB");
  // Refused by its length alone: a string far over the limit that is not even base64 gets the size refusal.
  const huge = saveImage(ud, { mime: "image/png", data: "!".repeat(4 * Math.ceil((MAX_IMAGE_BYTES + 3) / 3)) }, { now: NOV });
  assert.equal(!huge.ok && huge.code, "EFBIG");
  assert.equal(fs.readdirSync(path.join(ud, "code-images", "2026-11")).length, 1);
});

test("base64 that is not canonical is refused (Buffer.from would skip what it cannot read)", () => {
  const ud = userData();
  for (const data of [`${b64(PNG)}*`, b64(PNG).slice(0, -1), `${b64(PNG).slice(0, 4)}\n${b64(PNG).slice(4)}`, "=AAA", ""]) {
    const r = saveImage(ud, { mime: "image/png", data }, { now: NOV });
    assert.equal(r.ok, false, JSON.stringify(data.slice(0, 12)));
    assert.equal(!r.ok && r.code, "EINVAL");
  }
});

test("the file is created exclusively: an existing file at the chosen name is never overwritten", () => {
  const ud = userData();
  const same = () => "aaaaaaaa-0000-4000-8000-000000000001";
  const first = saveImage(ud, { mime: "image/png", data: b64(PNG) }, { now: NOV, uuid: same });
  assert.ok(first.ok);
  const again = saveImage(ud, { mime: "image/gif", data: b64(GIF89) }, { now: NOV, uuid: () => "aaaaaaaa-0000-4000-8000-000000000001" });
  assert.ok(again.ok, "another extension is another file");
  const clash = saveImage(ud, { mime: "image/png", data: b64(Buffer.concat([PNG, Buffer.from("other")])) }, { now: NOV, uuid: same });
  assert.equal(clash.ok, false);
  assert.equal(!clash.ok && clash.code, "EEXIST");
  assert.deepEqual(fs.readFileSync(first.data.path), PNG);
});

test("a link in place of the images folder or the month's folder is refused; nothing is written through it", () => {
  const away = fs.mkdtempSync(path.join(tmp, "away-"));
  const ud = userData();
  fs.symlinkSync(away, path.join(ud, "code-images"));
  const r = saveImage(ud, { mime: "image/png", data: b64(PNG) }, { now: NOV });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "EROFS");
  assert.deepEqual(fs.readdirSync(away), []);
  const ud2 = userData();
  fs.mkdirSync(path.join(ud2, "code-images"));
  fs.symlinkSync(away, path.join(ud2, "code-images", "2026-11"));
  const r2 = saveImage(ud2, { mime: "image/png", data: b64(PNG) }, { now: NOV });
  assert.equal(!r2.ok && r2.code, "EROFS");
  assert.deepEqual(fs.readdirSync(away), []);
  // A relative data folder is no folder main knows.
  assert.equal(saveImage("relative/app", { mime: "image/png", data: b64(PNG) }, { now: NOV }).ok, false);
});

test("the Code chat surface owns it: off, a well-formed image is refused (EROFS) and nothing is written; on, it is saved", () => {
  const ud = userData();
  let on = false;
  const svc = new CodeImageService({ userData: () => ud, enabled: () => on });
  const off = svc.save({ mime: "image/png", data: b64(PNG) });
  assert.equal(off.ok, false);
  assert.equal(!off.ok && off.code, "EROFS");
  assert.equal(fs.existsSync(path.join(ud, "code-images")), false);
  on = true;
  const r = svc.save({ mime: "image/png", data: b64(PNG) });
  assert.ok(r.ok);
  assert.ok(r.data.path.startsWith(path.join(ud, "code-images") + path.sep));
});

test("CodeSaveImageArgs: a type and base64 only, no path; at most the base64 of 10 MB", () => {
  const max = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
  assert.ok(CodeSaveImageArgs.safeParse({ mime: "image/png", data: b64(PNG) }).success);
  assert.ok(CodeSaveImageArgs.safeParse({ mime: "image/png", data: "A".repeat(max) }).success);
  assert.equal(CodeSaveImageArgs.safeParse({ mime: "image/png", data: "A".repeat(max + 4) }).success, false);
  assert.equal(CodeSaveImageArgs.safeParse({ mime: "image/png", data: b64(PNG), path: "/work/demo/x.png" }).success, false);
  assert.equal(CodeSaveImageArgs.safeParse({ mime: "image/png", data: b64(PNG), name: "x.png" }).success, false);
  assert.equal(CodeSaveImageArgs.safeParse({ mime: "image/png" }).success, false);
  assert.equal(CodeSaveImageArgs.safeParse({ mime: "image/png\u0000", data: b64(PNG) }).success, false);
  assert.equal(CodeSaveImageArgs.safeParse({ mime: "x".repeat(101), data: b64(PNG) }).success, false);
  assert.equal(CodeSaveImageArgs.safeParse({ mime: "image/png", data: [1, 2, 3] }).success, false);
});
