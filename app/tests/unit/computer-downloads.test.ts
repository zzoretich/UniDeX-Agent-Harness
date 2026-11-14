import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HELD_PREFIX, HeldDownloads, downloadName, downloadPath, moveInto, sweepHeld, type MoveOps } from "../../src/main/computer/downloads";

// agent-computer D39: a download waits in a private folder until it is allowed, then moves into Downloads, never over a
// file; held folders go with their download, their browser, or (after a crash) the next start's sweep.

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aos-dl-"));
  made.push(d);
  return d;
}
const held = (dir: string, body = "time,height\n"): string => { const f = path.join(dir, "held", "tides.csv"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };

test("downloadName: a page-chosen name loses folders, control and bidirectional characters and a leading dot", () => {
  assert.equal(downloadName("tides.csv"), "tides.csv");
  assert.equal(downloadName("../../etc/tides.csv"), "tides.csv");
  assert.equal(downloadName(".profile"), "profile");
  assert.equal(downloadName("re\u202eport\u0007.csv"), "report_.csv");
  assert.equal(downloadName("a:b.csv"), "a_b.csv");
  assert.equal(downloadName("  "), "download");
});

test("downloadName (M1): every bidirectional, zero-width and line-separator character goes, and the source spells them as escapes", () => {
  const invisible = ["\u061c", "\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u2028", "\u2029", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\ufeff"];
  for (const ch of invisible) assert.equal(downloadName(`tid${ch}es.csv`), "tides.csv", `U+${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  // No literal invisible character in the file that strips them: what it removes is readable in review.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "computer", "downloads.ts"), "utf8");
  assert.equal(src.match(/[\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g), null);
});

test("downloadPath: the name, then `stem (n).ext`, in the folder", () => {
  assert.equal(downloadPath("/d", "tides.csv"), path.join("/d", "tides.csv"));
  assert.equal(downloadPath("/d", "tides.csv", 1), path.join("/d", "tides (1).csv"));
  assert.equal(downloadPath("/d", "tides.csv", 12), path.join("/d", "tides (12).csv"));
  assert.equal(downloadPath("/d", "README", 2), path.join("/d", "README (2)"));
});

test("moveInto: into the free name, the held file gone; a file already there is never touched (`tides (1).csv`)", () => {
  const d = tmp();
  const into = path.join(d, "Downloads");
  fs.mkdirSync(into);
  fs.writeFileSync(path.join(into, "tides.csv"), "theirs");
  const from = held(d, "ours");
  const to = moveInto(from, into, "tides.csv");
  assert.equal(to, path.join(into, "tides (1).csv"));
  assert.equal(fs.readFileSync(to, "utf8"), "ours");
  assert.equal(fs.readFileSync(path.join(into, "tides.csv"), "utf8"), "theirs");
  assert.equal(fs.existsSync(from), false);
});

test("moveInto: a file that appears at the chosen name before the move sends it to the next one, never over it", () => {
  const d = tmp();
  const into = path.join(d, "Downloads");
  fs.mkdirSync(into);
  const from = held(d, "ours");
  // The name was free when it was chosen; something writes it just before the link.
  let raced = false;
  const ops: MoveOps = {
    linkSync: (a, b) => { if (!raced) { raced = true; fs.writeFileSync(b, "arrived meanwhile"); } fs.linkSync(a, b); },
    unlinkSync: (p) => fs.unlinkSync(p),
    copyFileSync: (a, b, m) => fs.copyFileSync(a, b, m),
  };
  const to = moveInto(from, into, "tides.csv", ops);
  assert.equal(to, path.join(into, "tides (1).csv"));
  assert.equal(fs.readFileSync(path.join(into, "tides.csv"), "utf8"), "arrived meanwhile");
  assert.equal(fs.readFileSync(to, "utf8"), "ours");
});

test("moveInto: on another volume it copies with COPYFILE_EXCL, which also moves past an existing file", () => {
  const d = tmp();
  const into = path.join(d, "Downloads");
  fs.mkdirSync(into);
  fs.writeFileSync(path.join(into, "tides.csv"), "theirs");
  const from = held(d, "ours");
  const modes: number[] = [];
  const exdev = Object.assign(new Error("cross-device link"), { code: "EXDEV" });
  const ops: MoveOps = {
    linkSync: () => { throw exdev; },
    unlinkSync: (p) => fs.unlinkSync(p),
    copyFileSync: (a, b, m) => { modes.push(m); fs.copyFileSync(a, b, m); },
  };
  const to = moveInto(from, into, "tides.csv", ops);
  assert.equal(to, path.join(into, "tides (1).csv"));
  assert.equal(fs.readFileSync(to, "utf8"), "ours");
  assert.equal(fs.readFileSync(path.join(into, "tides.csv"), "utf8"), "theirs");
  assert.equal(fs.existsSync(from), false);
  assert.ok(modes.every((m) => (m & fs.constants.COPYFILE_EXCL) !== 0), "every copy refuses an existing file");
  // Any other failure is not swallowed.
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.throws(() => moveInto(held(d), into, "x.csv", { ...ops, linkSync: () => { throw denied; } }), /denied/);
});

test("HeldDownloads: each download a private 0700 folder named with the app's pid; drop and dropAll remove them", () => {
  const d = tmp();
  const h = new HeldDownloads(() => d, 4242);
  const a = h.hold(), b = h.hold();
  for (const dir of [a, b]) {
    assert.ok(path.basename(dir).startsWith(`${HELD_PREFIX}4242-`));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  fs.writeFileSync(path.join(a, "tides.csv"), "x");
  h.drop(a);
  assert.equal(fs.existsSync(a), false);
  assert.equal(h.size, 1);
  fs.writeFileSync(path.join(b, "big.zip.crdownload"), "partial");
  // The browser going (or the app quitting, which destroys every browser) takes every folder still held.
  h.dropAll();
  assert.equal(fs.existsSync(b), false);
  assert.equal(h.size, 0);
});

test("sweepHeld: at start, held folders no running app holds go; this app's and a live app's stay", async () => {
  const d = tmp();
  const mk = (n: string) => { const p = path.join(d, n); fs.mkdirSync(p); fs.writeFileSync(path.join(p, "f"), "x"); return p; };
  const dead = mk(`${HELD_PREFIX}111-aaaaaa`);
  const live = mk(`${HELD_PREFIX}222-bbbbbb`);
  const self = mk(`${HELD_PREFIX}333-cccccc`);
  const old = mk(`${HELD_PREFIX}dddddd`);
  const other = mk("someone-else-111-x");
  fs.writeFileSync(path.join(d, `${HELD_PREFIX}444-file`), "not a folder");
  const removed = await sweepHeld(d, (pid) => pid === 222, 333);
  assert.deepEqual(removed.sort(), [dead, old].sort());
  for (const p of [live, self, other, path.join(d, `${HELD_PREFIX}444-file`)]) assert.ok(fs.existsSync(p), p);
  assert.deepEqual(await sweepHeld(path.join(d, "missing")), [], "no folder, nothing to do");
});

test("sweepHeld: it lists nothing before it returns, so the caller never waits on the folder", async () => {
  const d = tmp();
  const stale = path.join(d, `${HELD_PREFIX}111-aaaaaa`);
  fs.mkdirSync(stale);
  const p = sweepHeld(d, () => false, 1);
  assert.ok(p instanceof Promise);
  // This proves only that nothing was removed before the call returned; "it never uses the synchronous listing" proves
  // that no listing is done synchronously.
  assert.ok(fs.existsSync(stale), "nothing has been removed by the time the call returns");
  assert.deepEqual(await p, [stale]);
  assert.equal(fs.existsSync(stale), false);
});

test("sweepHeld: it never uses the synchronous listing", async () => {
  const d = tmp();
  const stale = path.join(d, `${HELD_PREFIX}111-aaaaaa`);
  fs.mkdirSync(stale);
  // The default export is the module object downloads.ts itself calls, so replacing a function here is what it would use.
  const { readdirSync, opendirSync } = nodeFs;
  const boom = (): never => { throw new Error("synchronous listing"); };
  (nodeFs as { readdirSync: unknown }).readdirSync = boom;
  (nodeFs as { opendirSync: unknown }).opendirSync = boom;
  try {
    assert.deepEqual(await sweepHeld(d, () => false, 1), [stale]);
  } finally {
    (nodeFs as { readdirSync: unknown }).readdirSync = readdirSync;
    (nodeFs as { opendirSync: unknown }).opendirSync = opendirSync;
  }
  assert.equal(fs.existsSync(stale), false);
});

test("sweepHeld: a folder that cannot be listed resolves with nothing, never a rejection", async () => {
  const d = tmp();
  const file = path.join(d, "a-file");
  fs.writeFileSync(file, "x");
  assert.deepEqual(await sweepHeld(path.join(d, "missing"), () => false, 1), []);
  assert.deepEqual(await sweepHeld(file, () => false, 1), []);
});

test("sweepHeld: among many other entries it removes only the held ones", async () => {
  const d = tmp();
  for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(d, `file-${i}`), "");
  for (let i = 0; i < 1000; i++) fs.mkdirSync(path.join(d, i % 2 ? `dir-${i}` : `x-${HELD_PREFIX}${i}`));
  const stale = [111, 222, 444].map((n) => path.join(d, `${HELD_PREFIX}${n}-aaaaaa`));
  for (const s of stale) { fs.mkdirSync(s); fs.writeFileSync(path.join(s, "f"), "x"); }
  const mine = path.join(d, `${HELD_PREFIX}333-cccccc`);
  fs.mkdirSync(mine);
  const removed = await sweepHeld(d, () => false, 333);
  assert.deepEqual(removed.sort(), stale.sort());
  assert.equal(fs.readdirSync(d).length, 2001);
  assert.ok(fs.existsSync(mine));
});

test("sweepHeld: a symlink named like a held folder is left, and so is what it points at", async () => {
  const d = tmp();
  const target = path.join(tmp(), "precious");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "f"), "x");
  const link = path.join(d, `${HELD_PREFIX}111-aaaaaa`);
  fs.symlinkSync(target, link);
  assert.deepEqual(await sweepHeld(d, () => false, 1), []);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(target, "f")));
});
