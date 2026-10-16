import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { BrainStore } from "./load";
import { BRAIN_HUB_PATH, MEMORY_NOTDUP_PATH, healthCount, parseNotDup, touchesBrain } from "../../data/brainModel";

const A = "brain/memory/feedback/prefer-small-diffs.md";
const B = "brain/memory/feedback/one-change-per-sitting.md";
const mem = (title: string): string => ["---", "type: memory", "tags: [memory/feedback, status/active]", "created: 2026-10-01", "---", "", `# ${title}`, "", "A rule.", ""].join("\n");
/** brain-hub.json listing the pair, and five hygiene findings a fix acts on: Health's badge reads 6 while the pair shows. */
const HUB = JSON.stringify({
  schema: 1, builtAt: "2026-10-15T00:00:00.000Z", counts: {},
  dups: [{ a: A, b: B, score: 0.9, title: 1, text: 0.5, meaning: null }],
  hygiene: { oldType: ["x"], unindexed: ["x"], misfiled: ["x"], brokenIndex: ["x"], leftoverDrafts: ["x"] },
});
const NOTDUP = `${JSON.stringify({ schema: 1, pairs: [[A, B].sort()] }, null, 2)}\n`;

/** A vault adapter over a map of files, read as they are at the moment the store asks. */
function vault(files: Map<string, string>): App {
  const adapter = {
    list: async (dir: string) => ({ files: [...files.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")), folders: [] }),
    exists: async (p: string) => files.has(p),
    read: async (p: string) => { const t = files.get(p); if (t === undefined) throw new Error(`ENOENT ${p}`); return t; },
  };
  return { vault: { adapter } } as unknown as App;
}

test("Health's badge counts a pair Keep both dismissed once the files list it again, though no rebuilt brain-hub.json ever dropped it", async () => {
  const files = new Map([[A, mem("Prefer small diffs")], [B, mem("One change per sitting")], [BRAIN_HUB_PATH, HUB]]);
  const store = new BrainStore(vault(files));
  const badge = async (): Promise<number> => { const d = await store.load(); return healthCount(d.pairs.length, d.hub); };
  assert.equal(await badge(), 6);
  // Keep both: `aos memory notdup` writes memory-notdup.json, then the page dismisses the pair; the hub lags until a scan.
  files.set(MEMORY_NOTDUP_PATH, NOTDUP);
  store.dismiss(A, B);
  assert.equal(await badge(), 5);
  // The files are put back (the entry gone) before any brain-hub.json without the pair was read: the pair shows again.
  files.delete(MEMORY_NOTDUP_PATH);
  assert.equal(await badge(), 6);
});

test("a dismissal covers only a read begun before the verb wrote memory-notdup.json; from then on the file says what is hidden", async () => {
  const files = new Map([[A, mem("Prefer small diffs")], [B, mem("One change per sitting")], [BRAIN_HUB_PATH, HUB]]);
  const store = new BrainStore(vault(files));
  assert.equal((await store.load()).pairs.length, 1);
  // A read begins, then the verb writes the file and the page dismisses the pair: that read hides it all the same.
  const inFlight = store.load();
  files.set(MEMORY_NOTDUP_PATH, NOTDUP);
  store.dismiss(A, B);
  assert.equal((await inFlight).pairs.length, 0);
  // The next read goes by the file: hidden while it lists the pair (whatever the hub says), shown once it does not.
  assert.equal((await store.load()).pairs.length, 0);
  assert.equal((await store.load()).flags.size, 0);
  files.set(MEMORY_NOTDUP_PATH, `${JSON.stringify({ schema: 1, pairs: [] })}\n`);
  assert.equal((await store.load()).pairs.length, 1);
  // A pair recorded from a terminal (`aos memory notdup`) hides on the next read, before the next scan.
  files.set(MEMORY_NOTDUP_PATH, NOTDUP);
  assert.equal((await store.load()).pairs.length, 0);
});

test("parseNotDup reads memory-notdup.json as brain-hub.js does; a change to it reloads the hub", () => {
  assert.deepEqual([...parseNotDup(NOTDUP)], [[A, B].sort().join("\n")]);
  assert.deepEqual([...parseNotDup(JSON.stringify({ schema: 1, pairs: [[B, A]] }))], [[A, B].sort().join("\n")]);
  for (const raw of [null, "", "{", "[]", JSON.stringify({ pairs: "x" }), JSON.stringify({ pairs: [[A], [A, B, B], [A, 1], "x"] })]) assert.equal(parseNotDup(raw).size, 0, String(raw));
  assert.ok(touchesBrain(MEMORY_NOTDUP_PATH));
});
