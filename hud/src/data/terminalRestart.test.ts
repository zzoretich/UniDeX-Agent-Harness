// The chip restart's keep-the-old-agent rule (code-chat C12, fix round 1): the running terminal is closed only once the
// new agent has started; a launch that fails leaves it selected and running and removes the new one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { restartKeepingOld } from "./terminalRestart";

function fake(ready: Promise<string | null>) {
  const log: string[] = [];
  const pool = { remove: (id: string) => { log.push(`remove ${id}`); }, select: (id: string) => { log.push(`select ${id}`); } };
  const launch = async () => { log.push("launch"); return { session: { id: "new" }, ready }; };
  return { log, pool, launch };
}

test("restartKeepingOld: the old terminal is removed and the new one selected only when the agent has started", async () => {
  let go: (v: string | null) => void = () => {};
  const f = fake(new Promise((r) => { go = r; }));
  const done = restartKeepingOld(f.pool, "old", f.launch);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.log, ["launch"], "launch resolved, agent not started: the old one stays");
  go(null);
  assert.equal(await done, null);
  assert.deepEqual(f.log, ["launch", "remove old", "select new"]);
});

test("restartKeepingOld: a ready that resolves with a fallback reason is a success", async () => {
  const f = fake(Promise.resolve("the computer is off for this session"));
  assert.equal(await restartKeepingOld(f.pool, "old", f.launch), null);
  assert.deepEqual(f.log, ["launch", "remove old", "select new"]);
});

test("restartKeepingOld: a ready that rejects keeps the old terminal selected, removes the new one and returns the reason", async () => {
  const f = fake(Promise.reject(new Error("Claude Code did not start: not found")));
  assert.equal(await restartKeepingOld(f.pool, "old", f.launch), "Claude Code did not start: not found");
  assert.deepEqual(f.log, ["launch", "remove new", "select old"]);
});

test("restartKeepingOld: a launch that throws before any terminal opens touches nothing and returns the reason", async () => {
  const log: string[] = [];
  const pool = { remove: (id: string) => { log.push(`remove ${id}`); }, select: (id: string) => { log.push(`select ${id}`); } };
  const r = await restartKeepingOld(pool, "old", async () => { throw new Error("bad id"); });
  assert.equal(r, "bad id");
  assert.deepEqual(log, []);
});

test("restartKeepingOld (I1): onReplace runs once the agent has started, before the old terminal is removed; never on a failed start", async () => {
  const ok = fake(Promise.resolve(null));
  assert.equal(await restartKeepingOld(ok.pool, "old", ok.launch, (o, n) => { ok.log.push(`replace ${o} ${n}`); }), null);
  assert.deepEqual(ok.log, ["launch", "replace old new", "remove old", "select new"]);
  const bad = fake(Promise.reject(new Error("not found")));
  assert.equal(await restartKeepingOld(bad.pool, "old", bad.launch, (o, n) => { bad.log.push(`replace ${o} ${n}`); }), "not found");
  assert.deepEqual(bad.log, ["launch", "remove new", "select old"]);
});
