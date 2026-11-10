// code:save-image (spec 2026-11-09-code-chat C7, C13): the Code composer's pasted image, saved by main into the app's own
// data folder, `<userData>/code-images/<yyyy-mm>/<uuid>.<ext>`. Main checks the type the page names (PNG, JPEG, GIF or
// WebP), the size (10 MB at most, from the base64's length before anything is decoded) and the content's magic bytes,
// which must agree with that type; it picks the path and creates the file exclusively. The page never names a path. The
// Code chat surface owns it: off, every call is refused. The folder holds at most 2 GiB or 5,000 files (R59), and month
// folders are removed about three months after their month ended, checked at start and once a day after (M2).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeSaveImageArgs } from "../../src/main/ipc/schemas";
import { CodeImageService, IMAGE_QUOTA_BYTES, IMAGE_QUOTA_FILES, MAX_IMAGE_BYTES, PRUNE_EVERY_MS, pruneImages, saveImage, sniffImage } from "../../src/main/services/code-images";

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

test("sniffImage knows each type by its magic bytes alone", async () => {
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

test("an image is written under <userData>/code-images/<yyyy-mm>/<uuid>.<ext>, its bytes as sent, and the absolute path comes back", async () => {
  const ud = userData();
  const cases: Array<[string, Buffer, string]> = [["image/png", PNG, "png"], ["image/jpeg", JPEG, "jpg"], ["image/gif", GIF89, "gif"], ["image/webp", WEBP, "webp"]];
  for (const [mime, bytes, ext] of cases) {
    const r = await saveImage(ud, { mime, data: b64(bytes) }, { now: NOV });
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

test("a PNG labelled image/gif is refused, and so is any content that disagrees with its type; nothing is written", async () => {
  const ud = userData();
  const pngAsGif = await saveImage(ud, { mime: "image/gif", data: b64(PNG) }, { now: NOV });
  assert.equal(pngAsGif.ok, false);
  assert.equal(!pngAsGif.ok && pngAsGif.code, "EINVAL");
  assert.equal(!pngAsGif.ok && pngAsGif.error, "its content is PNG, not GIF");
  const jpegAsPng = await saveImage(ud, { mime: "image/png", data: b64(JPEG) }, { now: NOV });
  assert.equal(!jpegAsPng.ok && jpegAsPng.error, "its content is JPEG, not PNG");
  // Not an image at all, under an image type.
  const text = await saveImage(ud, { mime: "image/png", data: b64(Buffer.from("not an image at all")) }, { now: NOV });
  assert.equal(!text.ok && text.error, "not a PNG, JPEG, GIF or WebP image");
  assert.equal(fs.existsSync(path.join(ud, "code-images")), false);
});

test("unknown types are refused before anything is read: SVG, TIFF, HEIC, a type with parameters, an empty one", async () => {
  const ud = userData();
  for (const mime of ["image/svg+xml", "image/tiff", "image/heic", "image/png; charset=x", "IMAGE/PNG", "text/plain", ""]) {
    const r = await saveImage(ud, { mime, data: b64(PNG) }, { now: NOV });
    assert.equal(r.ok, false, mime);
    assert.equal(!r.ok && r.code, "EINVAL", mime);
    assert.equal(!r.ok && r.error, "only PNG, JPEG, GIF or WebP images", mime);
  }
  assert.equal(fs.existsSync(path.join(ud, "code-images")), false);
});

test("10 MB is the limit: exactly 10 MB is saved, 10 MB + 1 byte is refused by its length before it is decoded", async () => {
  const ud = userData();
  const at = Buffer.alloc(MAX_IMAGE_BYTES);
  PNG.copy(at);
  const ok = await saveImage(ud, { mime: "image/png", data: b64(at) }, { now: NOV });
  assert.ok(ok.ok);
  assert.equal(fs.statSync(ok.data.path).size, MAX_IMAGE_BYTES);
  const over = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  PNG.copy(over);
  const data = b64(over);
  // 10 MB and 10 MB + 1 byte have base64 of the same length; only the padding tells them apart.
  assert.equal(data.length, b64(at).length);
  const r = await saveImage(ud, { mime: "image/png", data }, { now: NOV });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "EFBIG");
  assert.equal(!r.ok && r.error, "larger than 10 MB");
  // Refused by its length alone: a string far over the limit that is not even base64 gets the size refusal.
  const huge = await saveImage(ud, { mime: "image/png", data: "!".repeat(4 * Math.ceil((MAX_IMAGE_BYTES + 3) / 3)) }, { now: NOV });
  assert.equal(!huge.ok && huge.code, "EFBIG");
  assert.equal(fs.readdirSync(path.join(ud, "code-images", "2026-11")).length, 1);
});

test("base64 that is not canonical is refused (Buffer.from would skip what it cannot read)", async () => {
  const ud = userData();
  for (const data of [`${b64(PNG)}*`, b64(PNG).slice(0, -1), `${b64(PNG).slice(0, 4)}\n${b64(PNG).slice(4)}`, "=AAA", ""]) {
    const r = await saveImage(ud, { mime: "image/png", data }, { now: NOV });
    assert.equal(r.ok, false, JSON.stringify(data.slice(0, 12)));
    assert.equal(!r.ok && r.code, "EINVAL");
  }
});

test("the file is created exclusively (an async write with wx): an existing file at the chosen name is never overwritten", async () => {
  const ud = userData();
  const same = () => "aaaaaaaa-0000-4000-8000-000000000001";
  const first = await saveImage(ud, { mime: "image/png", data: b64(PNG) }, { now: NOV, uuid: same });
  assert.ok(first.ok);
  const again = await saveImage(ud, { mime: "image/gif", data: b64(GIF89) }, { now: NOV, uuid: () => "aaaaaaaa-0000-4000-8000-000000000001" });
  assert.ok(again.ok, "another extension is another file");
  const clash = await saveImage(ud, { mime: "image/png", data: b64(Buffer.concat([PNG, Buffer.from("other")])) }, { now: NOV, uuid: same });
  assert.equal(clash.ok, false);
  assert.equal(!clash.ok && clash.code, "EEXIST");
  assert.deepEqual(fs.readFileSync(first.data.path), PNG);
});

test("a link in place of the images folder or the month's folder is refused; nothing is written through it", async () => {
  const away = fs.mkdtempSync(path.join(tmp, "away-"));
  const ud = userData();
  fs.symlinkSync(away, path.join(ud, "code-images"));
  const r = await saveImage(ud, { mime: "image/png", data: b64(PNG) }, { now: NOV });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "EROFS");
  assert.deepEqual(fs.readdirSync(away), []);
  const ud2 = userData();
  fs.mkdirSync(path.join(ud2, "code-images"));
  fs.symlinkSync(away, path.join(ud2, "code-images", "2026-11"));
  const r2 = await saveImage(ud2, { mime: "image/png", data: b64(PNG) }, { now: NOV });
  assert.equal(!r2.ok && r2.code, "EROFS");
  assert.deepEqual(fs.readdirSync(away), []);
  // A relative data folder is no folder main knows.
  assert.equal((await saveImage("relative/app", { mime: "image/png", data: b64(PNG) }, { now: NOV })).ok, false);
});

test("the Code chat surface owns it: off, a well-formed image is refused (EROFS) and nothing is written; on, it is saved", async () => {
  const ud = userData();
  let on = false;
  const svc = new CodeImageService({ userData: () => ud, enabled: () => on });
  const off = await svc.save({ mime: "image/png", data: b64(PNG) });
  assert.equal(off.ok, false);
  assert.equal(!off.ok && off.code, "EROFS");
  assert.equal(fs.existsSync(path.join(ud, "code-images")), false);
  on = true;
  const r = await svc.save({ mime: "image/png", data: b64(PNG) });
  assert.ok(r.ok);
  assert.ok(r.data.path.startsWith(path.join(ud, "code-images") + path.sep));
});

test("CodeSaveImageArgs: a type and base64 only, no path; at most the base64 of 10 MB", async () => {
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

test("the quota: the folder holds at most maxFiles files and maxBytes bytes; a write that would pass either is ENOSPC", async () => {
  assert.equal(IMAGE_QUOTA_BYTES, 2 * 1024 * 1024 * 1024);
  assert.equal(IMAGE_QUOTA_FILES, 5000);
  const ud = userData();
  const files = new CodeImageService({ userData: () => ud, enabled: () => true, maxFiles: 3, log: () => {} });
  for (let i = 0; i < 3; i++) assert.ok((await files.save({ mime: "image/png", data: b64(PNG) })).ok, `save ${i}`);
  const full = await files.save({ mime: "image/png", data: b64(PNG) });
  assert.equal(full.ok, false);
  assert.equal(!full.ok && full.code, "ENOSPC");
  assert.equal(!full.ok && full.error, "the images folder is full");
  const month = (d: string): string[] => fs.readdirSync(path.join(d, "code-images", fs.readdirSync(path.join(d, "code-images"))[0]));
  assert.equal(month(ud).length, 3);
  // Bytes: up to the limit is saved; one byte past it is not.
  const ud2 = userData();
  const bytes = new CodeImageService({ userData: () => ud2, enabled: () => true, maxBytes: PNG.length * 2, log: () => {} });
  assert.ok((await bytes.save({ mime: "image/png", data: b64(PNG) })).ok);
  assert.ok((await bytes.save({ mime: "image/png", data: b64(PNG) })).ok, "exactly at the limit");
  const over = await bytes.save({ mime: "image/png", data: b64(PNG) });
  assert.equal(!over.ok && over.code, "ENOSPC");
  assert.equal(month(ud2).length, 2);
  // Saves at once are counted as they are admitted, not after their writes land.
  const ud3 = userData();
  const race = new CodeImageService({ userData: () => ud3, enabled: () => true, maxFiles: 2, log: () => {} });
  const all = await Promise.all([1, 2, 3, 4].map(() => race.save({ mime: "image/png", data: b64(PNG) })));
  assert.equal(all.filter((r) => r.ok).length, 2);
  assert.equal(month(ud3).length, 2);
});

test("the quota's tally is seeded once from what the folder already holds (links not followed), and a failed write gives its share back", async () => {
  const ud = userData();
  const old = path.join(ud, "code-images", "2026-10");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "aaaaaaaa-0000-4000-8000-000000000001.png"), Buffer.alloc(100));
  fs.writeFileSync(path.join(old, "notes.txt"), Buffer.alloc(50));
  // A link to a big file elsewhere is not the folder's: not counted.
  const big = path.join(tmp, `big-${n}.bin`);
  fs.writeFileSync(big, Buffer.alloc(10_000));
  fs.symlinkSync(big, path.join(old, "bbbbbbbb-0000-4000-8000-000000000002.png"));
  const bytes = new CodeImageService({ userData: () => ud, enabled: () => true, maxBytes: 150 + PNG.length, log: () => {} });
  assert.ok((await bytes.save({ mime: "image/png", data: b64(PNG) })).ok, "150 bytes there and one PNG fit");
  assert.equal(((await bytes.save({ mime: "image/png", data: b64(PNG) })) as { code?: string }).code, "ENOSPC");
  // Files: the three files there count (the two written first and the PNG saved above; the link does not), so a limit of
  // 5 takes two more.
  const files = new CodeImageService({ userData: () => ud, enabled: () => true, maxFiles: 5, log: () => {} });
  assert.ok((await files.save({ mime: "image/png", data: b64(PNG) })).ok, "the fourth");
  assert.ok((await files.save({ mime: "image/png", data: b64(PNG) })).ok, "the fifth");
  assert.equal(((await files.save({ mime: "image/png", data: b64(PNG) })) as { code?: string }).code, "ENOSPC");
  // A write that fails (the name is taken: EEXIST) gives back the place it was counted for.
  const names = ["cccccccc-0000-4000-8000-000000000003", "cccccccc-0000-4000-8000-000000000003", "dddddddd-0000-4000-8000-000000000004"];
  const ud2 = userData();
  const svc = new CodeImageService({ userData: () => ud2, enabled: () => true, maxFiles: 2, uuid: () => names.shift() ?? "", now: () => NOV, log: () => {} });
  assert.ok((await svc.save({ mime: "image/png", data: b64(PNG) })).ok);
  assert.equal(((await svc.save({ mime: "image/png", data: b64(PNG) })) as { code?: string }).code, "EEXIST");
  assert.ok((await svc.save({ mime: "image/png", data: b64(PNG) })).ok, "the clash's place came back: a second file fits under 2");
});

test("retention: month folders whose month ended more than 90 days ago lose their images; links, other files and other folders stay", async () => {
  const ud = userData();
  const root = path.join(ud, "code-images");
  const away = fs.mkdtempSync(path.join(tmp, "keep-"));
  fs.writeFileSync(path.join(away, "aaaaaaaa-0000-4000-8000-00000000000a.png"), PNG);
  const img = (dir: string, name: string) => { fs.mkdirSync(path.join(root, dir), { recursive: true }); fs.writeFileSync(path.join(root, dir, name), PNG); };
  // 2026-06 and 2026-07 ended on 1 July and 1 August: more than 90 days before 10 November.
  img("2026-06", "aaaaaaaa-0000-4000-8000-000000000001.png");
  img("2026-06", "aaaaaaaa-0000-4000-8000-000000000002.webp");
  img("2026-07", "aaaaaaaa-0000-4000-8000-000000000003.jpg");
  img("2026-07", "notes.txt");
  img("2026-07", "aaaaaaaa-0000-4000-8000-000000000004.jpeg");
  fs.symlinkSync(path.join(away, "aaaaaaaa-0000-4000-8000-00000000000a.png"), path.join(root, "2026-07", "aaaaaaaa-0000-4000-8000-000000000005.png"));
  fs.mkdirSync(path.join(root, "2026-07", "aaaaaaaa-0000-4000-8000-000000000006.gif"));
  // 2026-08 ended on 1 September: 70 days, kept. So is this month.
  img("2026-08", "aaaaaaaa-0000-4000-8000-000000000007.png");
  img("2026-11", "aaaaaaaa-0000-4000-8000-000000000008.png");
  // A link named like an old month, and a folder that is not a month: never touched.
  fs.symlinkSync(away, path.join(root, "2026-05"));
  img("old-stuff", "aaaaaaaa-0000-4000-8000-000000000009.png");
  img("2026-6", "aaaaaaaa-0000-4000-8000-00000000000b.png");
  await pruneImages(ud, { now: NOV });
  assert.equal(fs.existsSync(path.join(root, "2026-06")), false, "an old folder left empty is removed");
  assert.deepEqual(fs.readdirSync(path.join(root, "2026-07")).sort(), ["aaaaaaaa-0000-4000-8000-000000000004.jpeg", "aaaaaaaa-0000-4000-8000-000000000005.png", "aaaaaaaa-0000-4000-8000-000000000006.gif", "notes.txt"]);
  assert.ok(fs.lstatSync(path.join(root, "2026-07", "aaaaaaaa-0000-4000-8000-000000000005.png")).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(away), ["aaaaaaaa-0000-4000-8000-00000000000a.png"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "2026-08")), ["aaaaaaaa-0000-4000-8000-000000000007.png"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "2026-11")), ["aaaaaaaa-0000-4000-8000-000000000008.png"]);
  assert.ok(fs.lstatSync(path.join(root, "2026-05")).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(path.join(root, "old-stuff")), ["aaaaaaaa-0000-4000-8000-000000000009.png"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "2026-6")), ["aaaaaaaa-0000-4000-8000-00000000000b.png"]);
  // A link in place of the images folder: nothing behind it is touched.
  const ud2 = userData();
  const elsewhere = fs.mkdtempSync(path.join(tmp, "elsewhere-"));
  fs.mkdirSync(path.join(elsewhere, "2026-01"));
  fs.writeFileSync(path.join(elsewhere, "2026-01", "aaaaaaaa-0000-4000-8000-000000000001.png"), PNG);
  fs.symlinkSync(elsewhere, path.join(ud2, "code-images"));
  await pruneImages(ud2, { now: NOV });
  assert.deepEqual(fs.readdirSync(path.join(elsewhere, "2026-01")), ["aaaaaaaa-0000-4000-8000-000000000001.png"]);
  // No folder yet: nothing to do, nothing thrown.
  await pruneImages(userData(), { now: NOV });
});

test("the service's prune frees the quota: the tally is counted again after it", async () => {
  const ud = userData();
  fs.mkdirSync(path.join(ud, "code-images", "2026-06"), { recursive: true });
  for (let i = 1; i <= 2; i++) fs.writeFileSync(path.join(ud, "code-images", "2026-06", `aaaaaaaa-0000-4000-8000-00000000000${i}.png`), PNG);
  const svc = new CodeImageService({ userData: () => ud, enabled: () => true, maxFiles: 2, now: () => NOV, log: () => {} });
  assert.equal(((await svc.save({ mime: "image/png", data: b64(PNG) })) as { code?: string }).code, "ENOSPC");
  await svc.prune(NOV);
  assert.ok((await svc.save({ mime: "image/png", data: b64(PNG) })).ok);
});

test("retention runs at start and again once a day while the app stays open, by the service's clock; stop ends it (M2)", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const ud = userData();
  const img = (dir: string, name: string) => { fs.mkdirSync(path.join(ud, "code-images", dir), { recursive: true }); fs.writeFileSync(path.join(ud, "code-images", dir, name), PNG); };
  // On 10 November 2026, June ended more than 90 days ago; August (ended 1 September) did not.
  img("2026-06", "aaaaaaaa-0000-4000-8000-000000000001.png");
  img("2026-08", "aaaaaaaa-0000-4000-8000-000000000002.png");
  let now = NOV;
  const runs: number[] = [];
  const svc = new CodeImageService({ userData: () => ud, enabled: () => true, now: () => now, log: () => {} });
  const settled = async (count: number) => { for (let i = 0; i < 200 && runs.length < count; i++) await new Promise((r) => setImmediate(r)); };
  const stop = svc.keepPruned((n) => runs.push(n), (err) => { throw err; });
  await settled(1);
  assert.deepEqual(runs, [1], "the run at start");
  assert.deepEqual(fs.readdirSync(path.join(ud, "code-images")), ["2026-08"]);
  // The app stays open into December: on 1 December August ended 91 days ago, and the next day's run lets it go.
  now = new Date(2026, 11, 1, 9, 30);
  t.mock.timers.tick(PRUNE_EVERY_MS - 1);
  await settled(2);
  assert.deepEqual(runs, [1], "not before a day");
  t.mock.timers.tick(1);
  await settled(2);
  assert.deepEqual(runs, [1, 1]);
  assert.deepEqual(fs.readdirSync(path.join(ud, "code-images")), []);
  stop();
  t.mock.timers.tick(PRUNE_EVERY_MS * 3);
  await settled(3);
  assert.deepEqual(runs, [1, 1], "stopped: no more runs");
});

test("refusals are logged at most once a minute per reason", async () => {
  const lines: string[] = [];
  let t = 1_000_000;
  let on = false;
  const ud = userData();
  const svc = new CodeImageService({ userData: () => ud, enabled: () => on, log: (l) => lines.push(l), clock: () => t });
  await svc.save({ mime: "image/png", data: b64(PNG) });
  await svc.save({ mime: "image/png", data: b64(PNG) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /code:save-image: the Code chat surface is off/);
  on = true;
  await svc.save({ mime: "image/tiff", data: b64(PNG) });
  await svc.save({ mime: "image/tiff", data: b64(PNG) });
  assert.equal(lines.length, 2, "another reason has its own minute");
  t += 60_001;
  await svc.save({ mime: "image/tiff", data: b64(PNG) });
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => !l.includes(ud)), "no path in the log");
});
