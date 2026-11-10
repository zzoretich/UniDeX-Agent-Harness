// The Code sidebar's past conversations (code-chat C6, I3): the index and digests are checked at most every CHECK_MS
// (two stats, which are synchronous IPC in the app), unless the Code tab was shown again (a forced check), and parsed
// again only when one of them changed. A counting HudHost over a temp vault stands in for the app's.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { setHudHost } from "../host";
import { createNodeHost } from "../nodeHost";
import { CHECK_MS, HistoryCache } from "./historyCache";
import { SESSION_INDEX_PATH } from "./sessionHistory";

function setup() {
  const vault = fs.mkdtempSync(nodePath.join(os.tmpdir(), "aos-history-cache-"));
  fs.mkdirSync(nodePath.join(vault, "brain", "_index"), { recursive: true });
  const node = createNodeHost();
  const counts = { stat: 0, hosts: 0 };
  setHudHost({ ...node, fs: { ...node.fs, statSync: (p) => { counts.stat++; return node.fs.statSync(p); } } });
  let now = 1_000_000;
  let changes = 0;
  const cache = new HistoryCache({
    vault: () => vault,
    hosts: () => { counts.hosts++; return { choices: [], world: { vault, home: os.tmpdir(), workspaces: [], links: {} } }; },
    now: () => now,
  }, () => { changes++; });
  return { vault, counts, cache, tick: (ms: number) => { now += ms; }, changes: () => changes };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

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
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = setup();
    h.cache.refresh();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
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
    h.tick(CHECK_MS - 500);
    mock.timers.tick(CHECK_MS - 500);
    assert.equal(h.counts.stat, 4, "the trailing check looked at the caches");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.cache.rows().length, 1, "and the row shows without another render");
    assert.equal(h.changes(), before + 1);
    mock.timers.tick(CHECK_MS * 3);
    assert.equal(h.counts.stat, 4, "one shot: no timer left after it");
  } finally { mock.timers.reset(); }
});
