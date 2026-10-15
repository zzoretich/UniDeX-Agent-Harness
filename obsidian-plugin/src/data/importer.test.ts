import { test } from "node:test";
import assert from "node:assert/strict";
import { Importer, RUN_MS, SCAN_MS } from "./importer";
import type { AosResult } from "./aosRun";

const ok = (stdout: string): AosResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const SCAN = { dryRun: true, from: ["claude"], hosts: { claude: { present: true, configDir: "~/.claude", instructions: { files: 1, rules: 3, new: 3 }, memories: { files: 0, new: 0 }, mcp: { servers: 1 }, sessions: 9 } }, projects: { proposals: [] }, engine: { ready: true, model: "qwen3.5:9b", reason: "local-ready" } };

function world(over: Partial<{ run: (args: string[], o: { timeoutMs: number; onStdout?: (s: string) => void }) => Promise<AosResult>; state: string | null }> = {}) {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const files: Record<string, string | null> = { "brain/_index/import-state.json": over.state ?? null };
  const imp = new Importer({
    run: async (args, o) => { calls.push({ args, timeoutMs: o.timeoutMs }); return over.run ? over.run(args, o) : ok(JSON.stringify(SCAN)); },
    read: (rel) => files[rel] ?? null,
  });
  return { imp, calls, files };
}

test("scan: the dry run as JSON, every kind, both hosts unless narrowed; a failure is the CLI's own line", async () => {
  const w = world();
  const r = await w.imp.scan();
  assert.ok(r.ok);
  assert.equal(r.ok && r.scan.hosts.claude?.sessions, 9);
  assert.deepEqual(w.calls[0], { args: ["import", "--from", "all", "--dry-run", "--json"], timeoutMs: SCAN_MS });
  await w.imp.scan({ from: ["codex"], since: "all" });
  assert.deepEqual(w.calls[1].args, ["import", "--from", "codex", "--since", "all", "--dry-run", "--json"]);
  const refused = world({ run: async () => ({ code: 1, stdout: "", stderr: "aos: no vault configured (run `aos init` first)\n", timedOut: false }) });
  assert.deepEqual(await refused.imp.scan(), { ok: false, error: "no vault configured (run `aos init` first)" });
  const garbled = world({ run: async () => ok("{\"dryRun\": false}") });
  assert.deepEqual(await garbled.imp.scan(), { ok: false, error: "aos import answered in an unexpected shape" });
  const notJson = world({ run: async () => ok("import scan (nothing written)") });
  assert.deepEqual(await notJson.imp.scan(), { ok: false, error: "aos import sent output that does not parse" });
});

test("run: the fast phase with its progress, one at a time, then the state the runtime wrote", async () => {
  let release: (r: AosResult) => void = () => undefined;
  const w = world({
    run: (_args, o) => new Promise((resolve) => {
      o.onStdout?.("- instructions (Claude Code): 3 written, 0 already in the vault\n- memo");
      o.onStdout?.("ries (Claude Code): 0 written, 0 already in the vault\n");
      release = (r) => { w.files["brain/_index/import-state.json"] = JSON.stringify({ phases: [{ phase: "mcp", host: "claude", counts: { servers: 1 }, at: "2026-10-15T09:00:00.000Z" }], digest: { processed: 0, total: 9, queue: new Array(9).fill({}) } }); resolve(r); };
    }),
  });
  const seen: string[] = [];
  const p = w.imp.run({ from: ["claude"], only: ["instructions", "memories", "mcp", "sessions"] }, (s) => seen.push(`${s.done}/${s.steps}`));
  assert.equal(w.imp.busy, true);
  const second = await w.imp.run({ from: ["claude"], only: ["mcp"] });
  assert.deepEqual([second.ok, second.error], [false, "an import is already running"]);
  assert.deepEqual(w.calls.map((c) => c.args), [["import", "--from", "claude", "--only", "instructions,memories,mcp,sessions"]]);
  assert.equal(w.calls[0].timeoutMs, RUN_MS);
  release(ok("- mcp: 1 on Claude Code listed\n- sessions: 9 queued for the digest"));
  const r = await p;
  assert.equal(w.imp.busy, false);
  assert.deepEqual([r.ok, r.error], [true, null]);
  assert.deepEqual(seen, ["1/4", "2/4"], "the lines that streamed; the rest is in the result");
  assert.equal(r.state.digest?.left, 9);
  assert.equal(w.imp.digest()?.total, 9);
  const bad = world({ run: async () => ({ code: 1, stdout: "", stderr: "aos: import: --accept takes a JSON list\n", timedOut: false }) });
  const b = await bad.imp.run({ from: ["codex"], only: ["projects"], accept: ["~/code/a"] });
  assert.deepEqual([b.ok, b.error], [false, "import: --accept takes a JSON list"]);
  const refused = await bad.imp.run({ from: [], only: ["projects"] });
  assert.deepEqual([refused.ok, refused.error], [false, "import: no host chosen"]);
  assert.equal(bad.calls.length, 1, "a request the runtime would refuse never runs");
});

test("state and digest: nothing before any import", () => {
  const w = world();
  assert.deepEqual(w.imp.state(), { phases: [], digest: null, runs: [] });
  assert.equal(w.imp.digest(), null);
});
