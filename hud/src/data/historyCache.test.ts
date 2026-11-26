// The Code sidebar's past conversations (code-chat C6, I3): the index and digests are checked at most every CHECK_MS
// (two stats, which are synchronous IPC in the app), unless the Code tab was shown again (a forced check), and parsed
// again only when one of them changed. A counting HudHost over a temp vault stands in for the app's.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { setHudHost } from "../host";
import { createNodeHost } from "../nodeHost";
import { CHECK_MS, HistoryCache } from "./historyCache";
import { SESSION_INDEX_PATH } from "./sessionHistory";

/** `failReads`: how many of the next file reads throw (EACCES), as an unreadable cache would. */
function setup(o: { failReads?: { left: number } } = {}) {
  const vault = fs.mkdtempSync(nodePath.join(os.tmpdir(), "aos-history-cache-"));
  fs.mkdirSync(nodePath.join(vault, "brain", "_index"), { recursive: true });
  const node = createNodeHost();
  const counts = { stat: 0, hosts: 0 };
  const promises = { ...node.fs.promises, readFile: ((...args: Parameters<typeof node.fs.promises.readFile>) => {
    if (o.failReads && o.failReads.left > 0) { o.failReads.left--; return Promise.reject(new Error("EACCES: permission denied")); }
    return node.fs.promises.readFile(...args);
  }) as typeof node.fs.promises.readFile };
  setHudHost({ ...node, fs: { ...node.fs, promises, statSync: (p) => { counts.stat++; return node.fs.statSync(p); } } });
  let now = 1_000_000;
  let changes = 0;
  // A fake timer queue: nothing fires until the test says so, and the clock is the test's own.
  const timers = new Map<number, { fn: () => void; at: number }>();
  let timerId = 0;
  const cache = new HistoryCache({
    vault: () => vault,
    hosts: () => { counts.hosts++; return { choices: [], world: { vault, home: os.tmpdir(), workspaces: [], links: {} } }; },
    now: () => now,
    setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (h) => { timers.delete(h as number); },
  }, () => { changes++; });
  return {
    vault, counts, cache, changes: () => changes,
    tick: (ms: number) => { now += ms; },
    /** Moves the fake clock on and fires the timers that fall due, in order. */
    advance: (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending: () => timers.size,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
/** Waits (real time) for the cache's async file reads, which go through the thread pool, to land. */
async function until(cond: () => boolean): Promise<void> { for (let n = 0; n < 200 && !cond(); n++) await new Promise((r) => setTimeout(r, 5)); }

test("refresh checks the two caches at most every CHECK_MS; a forced refresh (the tab shown again) checks at once", async () => {
  const h = setup();
  h.cache.refresh();
  assert.equal(h.counts.stat, 2, "the first refresh stats the index and the digests");
  await settle();
  for (let n = 0; n < 10; n++) h.cache.refresh();
  assert.equal(h.counts.stat, 2, "renders within CHECK_MS read nothing");
  assert.equal(h.counts.hosts, 1, "nor the hosts (the launcher's choices)");
  h.tick(CHECK_MS);
  h.cache.refresh();
  assert.equal(h.counts.stat, 4);
  h.cache.refresh(true);
  assert.equal(h.counts.stat, 6, "forced");
});

test("a change to the index shows at the next check", async () => {
  const h = setup();
  h.cache.refresh();
  await settle();
  assert.equal(h.cache.rows().length, 0);
  fs.writeFileSync(nodePath.join(h.vault, SESSION_INDEX_PATH), JSON.stringify({
    files: { "/work/demo/a.jsonl": { host: "claude", head: { id: "a1", kind: "interactive", startCwd: "/work/demo", startedAt: "2026-11-09T10:00:00Z" }, lastAt: "2026-11-09T11:00:00Z" } },
  }));
  h.cache.refresh();
  await settle();
  assert.equal(h.cache.rows().length, 0, "not before CHECK_MS");
  h.tick(CHECK_MS);
  h.cache.refresh();
  await settle();
  assert.equal(h.cache.rows().length, 1);
  assert.ok(h.changes() >= 2);
});

test("a change skipped by the throttle is picked up by one trailing check, with no further render (E)", async () => {
  {
    const h = setup();
    h.cache.refresh();
    await settle();
    assert.equal(h.cache.rows().length, 0);
    const before = h.changes();
    fs.writeFileSync(nodePath.join(h.vault, SESSION_INDEX_PATH), JSON.stringify({
      files: { "/work/demo/a.jsonl": { host: "claude", head: { id: "a1", kind: "interactive", startCwd: "/work/demo", startedAt: "2026-11-09T10:00:00Z" }, lastAt: "2026-11-09T11:00:00Z" } },
    }));
    h.tick(500);
    h.cache.refresh();
    h.cache.refresh();
    assert.equal(h.counts.stat, 2, "skipped: inside CHECK_MS");
    // The timer is armed once, for what is left of the window; the fake clock moves with it.
    assert.equal(h.pending(), 1, "armed once");
    h.advance(CHECK_MS - 500);
    assert.equal(h.counts.stat, 4, "the trailing check looked at the caches");
    await until(() => h.cache.rows().length === 1);
    assert.equal(h.cache.rows().length, 1, "and the row shows without another render");
    assert.equal(h.changes(), before + 1);
    assert.equal(h.pending(), 0, "one shot: no timer left after it");
    h.advance(CHECK_MS * 3);
    assert.equal(h.counts.stat, 4);
  }
});

test("remove-sessions D3: loaded() is false before the first read and true after it, with no index on disk too", async () => {
  const h = setup();
  assert.equal(h.cache.loaded(), false, "nothing read yet");
  h.cache.refresh(true);
  await until(() => h.cache.loaded());
  assert.equal(h.cache.loaded(), true);
  assert.deepEqual(h.cache.rows(), []);
  assert.equal(h.cache.error(), null);
});

test("remove-sessions D3: error() names a failed read, and clears on the next good read", async () => {
  const fail = { left: 1 };
  const h = setup({ failReads: fail });
  fs.writeFileSync(nodePath.join(h.vault, SESSION_INDEX_PATH), JSON.stringify({ schema: 1, sessions: [] }));
  h.cache.refresh(true);
  await until(() => h.cache.loaded());
  assert.equal(h.cache.loaded(), true, "a failed read still ends the loading line");
  assert.match(h.cache.error() ?? "", /EACCES/);
  h.cache.refresh(true);
  await until(() => h.cache.error() === null);
  assert.equal(h.cache.error(), null, "the next good read clears it");
});

test("remove-sessions final I1: hostReady() follows the hosts the last refresh read, and reading it reads nothing more", async () => {
  const vault = fs.mkdtempSync(nodePath.join(os.tmpdir(), "aos-history-ready-"));
  fs.mkdirSync(nodePath.join(vault, "brain", "_index"), { recursive: true });
  setHudHost(createNodeHost());
  let reads = 0;
  let ready = false;
  const cache = new HistoryCache({
    vault: () => vault,
    hosts: () => { reads++; return { choices: [{ host: "codex", label: "Codex", hidden: false, ready, reason: ready ? null : "Codex is not logged in", bin: null }], world: { vault, home: os.tmpdir(), workspaces: [], links: {} } }; },
  }, () => {});
  assert.equal(cache.hostReady(), false, "nothing read yet");
  cache.refresh(true);
  await until(() => cache.loaded());
  assert.equal(cache.hostReady(), false);
  const before = reads;
  for (let n = 0; n < 20; n++) cache.hostReady();
  assert.equal(reads, before, "a render asking for it reads no config");
  ready = true;
  cache.refresh(true);
  assert.equal(cache.hostReady(), true, "a sign-in shows at the next refresh");
});
