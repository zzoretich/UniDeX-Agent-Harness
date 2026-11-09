// Phase 5's updates: when the app updates itself (a packaged release build, unless the runtime's updates.check says no),
// how electron-updater's events become the state the page and the menu show, the menu's update item, and the release
// script's pure parts (the feed rewrite after stapling, the upload order, the preconditions).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UpdateState } from "../../src/shared/ipc";
import { UpdateService, updatesConfig, updatesWanted, type UpdaterLike } from "../../src/main/updater";
import { updateItem } from "../../src/main/menu";
import { artifacts, feedEntry, releaseChecks, rewriteFeed, settleFeed, sha512Base64, uploadOrder } from "../../scripts/release-feed.mjs";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-updater-")));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

test("only a packaged release build updates itself, and the runtime's switch turns it off", () => {
  const config = { check: true, intervalHours: 24 };
  assert.deepEqual(updatesWanted({ packaged: false, testBuild: false, env: {}, config }), { on: false, reason: "a development run" });
  assert.deepEqual(updatesWanted({ packaged: true, testBuild: true, env: {}, config }), { on: false, reason: "the smoke build" });
  assert.deepEqual(updatesWanted({ packaged: true, testBuild: false, env: { AOS_APP_NO_UPDATES: "1" }, config }), { on: false, reason: "AOS_APP_NO_UPDATES=1" });
  assert.deepEqual(updatesWanted({ packaged: true, testBuild: false, env: {}, config: { ...config, check: false } }), { on: false, reason: "updates.check is off" });
  assert.deepEqual(updatesWanted({ packaged: true, testBuild: false, env: {}, config }), { on: true, reason: null });
});

test("updates config: brain/config.json, then agenticos.json key by key (update-check.js's precedence)", () => {
  const vault = path.join(ROOT, "vault");
  fs.mkdirSync(path.join(vault, "brain"), { recursive: true });
  const agenticos = path.join(ROOT, "agenticos.json");
  assert.deepEqual(updatesConfig(null, agenticos), { check: true, intervalHours: 24 });
  fs.writeFileSync(path.join(vault, "brain", "config.json"), JSON.stringify({ updates: { check: false, intervalHours: 6 } }));
  assert.deepEqual(updatesConfig(vault, agenticos), { check: false, intervalHours: 6 });
  fs.writeFileSync(agenticos, JSON.stringify({ updates: { check: true, intervalHours: "12" } }));
  assert.deepEqual(updatesConfig(vault, agenticos), { check: true, intervalHours: 6 });
});

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  logger: unknown = console;
  checks = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  async checkForUpdates(): Promise<unknown> { this.checks += 1; return null; }
  quitAndInstall(a?: boolean, b?: boolean): void { this.installs.push([a, b]); }
}

test("the updater's events become the page's state; Restart to Update only once one is downloaded", async () => {
  const u = new FakeUpdater();
  const states: UpdateState[] = [];
  const svc = new UpdateService({ on: true, reason: null, intervalHours: 24, load: () => u, emit: (s) => states.push(s), firstCheckMs: 5 });
  assert.equal(svc.state.status, "idle");
  svc.start();
  assert.equal(u.autoDownload, true);
  assert.equal(u.autoInstallOnAppQuit, true);
  assert.equal(u.allowPrerelease, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(u.checks, 1, "the first check runs after the delay");
  assert.equal(svc.install(), false);
  u.emit("checking-for-update");
  u.emit("update-available", { version: "1.0.1" });
  u.emit("download-progress", { percent: 41.6 });
  assert.deepEqual(svc.state, { status: "downloading", reason: null, version: "1.0.1", percent: 42, error: null });
  svc.check();
  assert.equal(u.checks, 1, "no second check while downloading");
  u.emit("update-downloaded", { version: "1.0.1" });
  assert.equal(svc.state.status, "downloaded");
  assert.equal(svc.install(), true);
  assert.deepEqual(u.installs, [[false, true]]);
  assert.deepEqual(states.map((s) => s.status), ["checking", "available", "downloading", "downloaded"]);
  svc.stop();
});

test("a missing feed or no network is an error state, quietly; the next check tries again", async () => {
  const u = new FakeUpdater();
  const svc = new UpdateService({ on: true, reason: null, intervalHours: 24, load: () => u, emit: () => { /* nothing */ }, firstCheckMs: 60_000 });
  svc.start();
  u.emit("error", new Error("Cannot find latest-mac.yml in the latest release artifacts\nHttpError: 404"));
  assert.deepEqual(svc.state, { status: "error", reason: null, version: null, percent: null, error: "Cannot find latest-mac.yml in the latest release artifacts" });
  svc.check();
  assert.equal(u.checks, 1);
  svc.stop();
});

test("off: nothing loads, nothing runs", () => {
  let loaded = false;
  const svc = new UpdateService({ on: false, reason: "a development run", intervalHours: 24, load: () => { loaded = true; return new FakeUpdater(); }, emit: () => { /* nothing */ } });
  svc.start();
  svc.check();
  assert.equal(loaded, false);
  assert.deepEqual(svc.state, { status: "off", reason: "a development run", version: null, percent: null, error: null });
  assert.equal(svc.install(), false);
});

test("the menu's update item follows the state", () => {
  const calls: string[] = [];
  const u = (s: Partial<UpdateState>) => updateItem({ state: { status: "idle", reason: null, version: null, percent: null, error: null, ...s }, check: () => calls.push("check"), install: () => calls.push("install") });
  const idle = u({});
  assert.equal(idle.label, "Check for Updates…");
  (idle.click as () => void)();
  assert.equal(u({ status: "off", reason: "a development run" }).enabled, false);
  assert.equal(u({ status: "checking" }).label, "Checking for Updates…");
  assert.equal(u({ status: "downloading", version: "1.0.1", percent: 40 }).label, "Downloading 1.0.1 (40%)…");
  const ready = u({ status: "downloaded", version: "1.0.1" });
  assert.equal(ready.label, "Restart to Update to 1.0.1");
  (ready.click as () => void)();
  assert.equal(u({ status: "error", error: "x" }).label, "Check for Updates…");
  assert.deepEqual(calls, ["check", "install"]);
});

// ── release:app ──────────────────────────────────────────────────────

const FEED = `version: 1.0.1
files:
  - url: AgenticOS-Workbench-1.0.1-arm64.zip
    sha512: ZIPSHA
    size: 100
  - url: AgenticOS-Workbench-1.0.1-arm64.dmg
    sha512: OLDDMG
    size: 200
path: AgenticOS-Workbench-1.0.1-arm64.zip
sha512: ZIPSHA
releaseDate: '2026-10-05T12:00:00.000Z'
`;

test("the feed gets the stapled DMG's size and checksum; the zip's entry and the top-level pair are kept", () => {
  const a = artifacts("1.0.1");
  const out = rewriteFeed(FEED, a.dmg, { sha512: "NEWDMG", size: 250 });
  assert.equal(out, FEED.replace("sha512: OLDDMG\n    size: 200", "sha512: NEWDMG\n    size: 250"));
  // When the top-level path names the file, its sha512 follows.
  assert.match(rewriteFeed(FEED, a.zip, { sha512: "Z2", size: 101 }), /^path: AgenticOS-Workbench-1\.0\.1-arm64\.zip\nsha512: Z2$/m);
  assert.throws(() => rewriteFeed(FEED, "other.dmg", { sha512: "x", size: 1 }), /does not list other\.dmg/);
  assert.equal(sha512Base64(Buffer.from("abc")).length, 88);
});

// What electron-builder 26 writes for the dmg + zip targets (1.0.0's feed): the zip alone, which the updater downloads.
const FEED_ZIP_ONLY = `version: 1.0.1
files:
  - url: AgenticOS-Workbench-1.0.1-arm64.zip
    sha512: ZIPSHA
    size: 100
path: AgenticOS-Workbench-1.0.1-arm64.zip
sha512: ZIPSHA
releaseDate: '2026-10-06T04:44:08.962Z'
`;

test("feedEntry reads a listed file's checksum and size, and null for one the feed does not list", () => {
  const a = artifacts("1.0.1");
  assert.deepEqual(feedEntry(FEED, a.dmg), { sha512: "OLDDMG", size: 200 });
  assert.deepEqual(feedEntry(FEED_ZIP_ONLY, a.zip), { sha512: "ZIPSHA", size: 100 });
  assert.equal(feedEntry(FEED_ZIP_ONLY, a.dmg), null);
});

test("the feed release:app uploads: a zip-only feed is kept as written; a listed DMG is rewritten; the zip must match", () => {
  const a = artifacts("1.0.1");
  const sums = { dmg: { sha512: "NEWDMG", size: 250 }, zip: { sha512: "ZIPSHA", size: 100 } };
  // electron-builder 26: nothing to rewrite (1.0.0's release:app stopped here, on rewriteFeed's throw).
  assert.equal(settleFeed(FEED_ZIP_ONLY, a, sums), FEED_ZIP_ONLY);
  // A feed that lists the DMG too gets the stapled DMG's checksum and size, as before.
  assert.equal(settleFeed(FEED, a, sums), FEED.replace("sha512: OLDDMG\n    size: 200", "sha512: NEWDMG\n    size: 250"));
  // A feed that does not match the zip on disk is never uploaded.
  assert.throws(() => settleFeed(FEED_ZIP_ONLY, a, { ...sums, zip: { sha512: "ZIPSHA", size: 101 } }), /does not match AgenticOS-Workbench-1\.0\.1-arm64\.zip: the feed says 100 bytes, the zip is 101$/);
  assert.throws(() => settleFeed(FEED_ZIP_ONLY, a, { ...sums, zip: { sha512: "OTHER", size: 100 } }), /and the checksums differ/);
  assert.throws(() => settleFeed(FEED_ZIP_ONLY.replace(/-arm64\.zip/g, "-x64.zip"), a, sums), /does not list AgenticOS-Workbench-1\.0\.1-arm64\.zip/);
});

test("uploads go feed last, and the release waits on every precondition", () => {
  assert.deepEqual(uploadOrder("1.0.1"), ["AgenticOS-Workbench-1.0.1-arm64.dmg", "AgenticOS-Workbench-1.0.1-arm64.zip", "AgenticOS-Workbench-1.0.1-arm64.zip.blockmap", "latest-mac.yml"]);
  const ok = { version: "1.0.1", rootVersion: "1.0.1", tags: ["v1.0.1"], clean: true, profile: "aos-notary", gh: true, release: true };
  assert.ok(releaseChecks(ok).every((c) => c.ok));
  const bad = releaseChecks({ ...ok, rootVersion: "1.0.0", tags: [], clean: false, profile: undefined, gh: false, release: false });
  assert.deepEqual(bad.filter((c) => !c.ok).length, 6);
});

test("Restart to Update marks the app as quitting before quitAndInstall closes its windows, and only when it installs", () => {
  const order: string[] = [];
  const u = new FakeUpdater();
  const quit = u.quitAndInstall.bind(u);
  u.quitAndInstall = (a?: boolean, b?: boolean) => { order.push("quitAndInstall"); quit(a, b); };
  const svc = new UpdateService({ on: true, reason: null, intervalHours: 24, load: () => u, emit: () => {}, firstCheckMs: 60_000, beforeInstall: () => order.push("beforeInstall") });
  svc.start();
  assert.equal(svc.install(), false);
  assert.deepEqual(order, [], "nothing downloaded: the app is not marked as quitting");
  u.emit("update-downloaded", { version: "1.3.1" });
  assert.equal(svc.install(), true);
  assert.deepEqual(order, ["beforeInstall", "quitAndInstall"]);
  svc.stop();
});

test("Restart to Update with terminals running: quitAndInstall waits until they have ended, and a second ask installs once (R86)", async () => {
  const order: string[] = [];
  const u = new FakeUpdater();
  const quit = u.quitAndInstall.bind(u);
  u.quitAndInstall = (a?: boolean, b?: boolean) => { order.push("quitAndInstall"); quit(a, b); };
  let finish: () => void = () => {};
  let running = true;
  const svc = new UpdateService({
    on: true, reason: null, intervalHours: 24, load: () => u, emit: () => {}, firstCheckMs: 60_000,
    beforeInstall: () => order.push("beforeInstall"),
    settle: () => (running ? new Promise<void>((resolve) => { order.push("settle"); finish = () => { running = false; order.push("ended"); resolve(); }; }) : null),
  });
  svc.start();
  u.emit("update-downloaded", { version: "1.3.1" });
  assert.equal(svc.install(), true);
  assert.equal(svc.install(), true, "asked again while it waits");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["beforeInstall", "settle"], "the app is marked as quitting at once; nothing installs yet");
  finish();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["beforeInstall", "settle", "ended", "quitAndInstall"]);
  assert.deepEqual(u.installs, [[false, true]]);
  // Nothing left running: quitAndInstall at once, as before.
  assert.equal(svc.install(), true);
  assert.deepEqual(order.slice(4), ["beforeInstall", "quitAndInstall"]);
  svc.stop();
});

test("Restart to Update installs even when the wait for the terminals fails (R86)", async () => {
  const u = new FakeUpdater();
  const svc = new UpdateService({ on: true, reason: null, intervalHours: 24, load: () => u, emit: () => {}, firstCheckMs: 60_000, settle: () => Promise.reject(new Error("boom")) });
  svc.start();
  u.emit("update-downloaded", { version: "1.3.1" });
  assert.equal(svc.install(), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(u.installs, [[false, true]]);
  svc.stop();
});
