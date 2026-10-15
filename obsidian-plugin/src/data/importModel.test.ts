import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProgressFollower, digestPending, digestText, engineLine, hostImportText, importArgs, importSteps, lastImports, parseImportState, parseScan,
  progressStep, scanCell, scanEmpty, scanHosts, scanKinds,
} from "./importModel";

/** `aos import --dry-run --json` as the runtime printed it for a home with both hosts' files (brain/scripts/test/import-world.js). */
const REPORT = {
  schema: 1, dryRun: true, since: "90d", windowDays: 90, from: ["claude", "codex"], only: ["instructions", "memories", "projects", "mcp", "sessions"],
  engine: { ready: false, provider: "none", model: null, reason: "forced" },
  hosts: {
    claude: { present: true, configDir: "~/.claude", instructions: { files: 1, rules: 5, new: 5, skipped: [] }, memories: { files: 3, new: 3 }, mcp: { servers: 2 }, sessions: 4 },
    codex: { present: true, configDir: "~/.codex", instructions: { files: 1, rules: 2, new: 2, skipped: [] }, memories: { files: 0, new: 0 }, mcp: { servers: 2 }, sessions: 2 },
  },
  projects: {
    proposals: [
      { id: "~/code/alpha", repo: "~/code/alpha", root: "/h/code/alpha", claude: 3, codex: 1, sessions: 4, reason: "4 sessions in the window", action: "new", slug: "alpha", name: "alpha" },
      { id: "~/code/notes", repo: "~/code/notes", claude: 1, codex: 0, sessions: 1, reason: "active in the last 14 days", action: "link", into: "Notes", slug: "notes", name: "Notes", link: "repo" },
      { id: 7, action: "new" }, { id: "~/x", action: "move" },
    ],
    created: [], linked: [], failed: [], unknown: [],
  },
  mcp: { servers: [] }, sessions: null, written: 0,
};

test("parseScan: counts per host and kind, the proposals that are whole, the engine; anything else is not a scan", () => {
  const s = parseScan(REPORT)!;
  assert.deepEqual(s.from, ["claude", "codex"]);
  assert.deepEqual(s.hosts.claude, { present: true, configDir: "~/.claude", instructions: { files: 1, rules: 5, new: 5 }, memories: { files: 3, new: 3 }, mcp: { servers: 2 }, sessions: 4 });
  assert.equal(s.hosts.codex!.memories, null, "Codex has no auto-memory to read");
  assert.deepEqual(s.proposals.map((p) => [p.id, p.action, p.slug, p.into]), [["~/code/alpha", "new", "alpha", null], ["~/code/notes", "link", "notes", "Notes"]]);
  assert.deepEqual(s.engine, { ready: false, model: null, reason: "forced" });
  for (const bad of [null, [], { dryRun: false, hosts: {} }, { dryRun: true }, "x"]) assert.equal(parseScan(bad), null, JSON.stringify(bad));
});

test("cells, hosts and kinds: what there is to bring, in words; an empty scan is empty", () => {
  const s = parseScan(REPORT)!;
  assert.deepEqual(scanCell(s.hosts.claude!, "instructions"), { count: 5, text: "5 rules" });
  assert.deepEqual(scanCell(s.hosts.claude!, "memories"), { count: 3, text: "3 memories" });
  assert.deepEqual(scanCell(s.hosts.codex!, "sessions"), { count: 2, text: "2 sessions" });
  assert.equal(scanCell(s.hosts.codex!, "memories"), null);
  assert.equal(scanCell(s.hosts.claude!, "projects"), null, "projects are the proposals");
  assert.deepEqual(scanHosts(s), ["claude", "codex"]);
  assert.deepEqual(scanKinds(s), ["instructions", "memories", "projects", "mcp", "sessions"]);
  assert.equal(scanEmpty(s), false);
  const none = parseScan({ dryRun: true, from: ["claude", "codex"], hosts: { claude: { present: false, configDir: "~/.claude" }, codex: { present: false, configDir: "~/.codex" } }, projects: { proposals: [] } })!;
  assert.deepEqual([scanHosts(none), scanKinds(none), scanEmpty(none)], [[], [], true]);
  const bare = parseScan({ dryRun: true, hosts: { claude: { present: true, configDir: "~/.claude", instructions: { files: 0, rules: 0, new: 0 }, memories: { files: 0 }, mcp: { servers: 0 }, sessions: 0 } } })!;
  assert.equal(scanEmpty(bare), true, "a folder with nothing in it is nothing to import");
  assert.match(engineLine(s), /not ready yet: each instruction file comes in as one note, and the sessions wait/);
  assert.match(engineLine({ ...s, engine: { ready: true, model: "qwen3.5:9b", reason: "local-ready" } }), /^The local model \(qwen3\.5:9b\) sorts each rule/);
});

test("importArgs: the flags in the surface's one order; a choice the runtime would refuse throws first", () => {
  const all = ["instructions", "memories", "projects", "mcp", "sessions"] as const;
  assert.deepEqual(importArgs({ from: ["codex", "claude"], only: [...all] }, { dryRun: true, json: true }), ["import", "--from", "all", "--dry-run", "--json"]);
  assert.deepEqual(importArgs({ from: ["claude"], only: ["sessions", "instructions"], since: "all" }), ["import", "--from", "claude", "--since", "all", "--only", "instructions,sessions"]);
  assert.deepEqual(importArgs({ from: ["claude", "codex"], only: [...all], accept: ["~/code/alpha", "~/code/alpha", "/srv/x"] }),
    ["import", "--from", "all", "--accept", '["~/code/alpha","/srv/x"]']);
  assert.deepEqual(importArgs({ from: ["codex"], only: ["instructions"], accept: ["~/code/alpha"] }), ["import", "--from", "codex", "--only", "instructions"], "no projects, no accept");
  assert.deepEqual(importArgs({ from: ["codex"], only: [...all], accept: [] }), ["import", "--from", "codex"]);
  assert.throws(() => importArgs({ from: [], only: [...all] }), /no host/);
  assert.throws(() => importArgs({ from: ["claude"], only: [] }), /nothing chosen/);
  assert.throws(() => importArgs({ from: ["claude"], only: [...all], accept: ["--dry-run"] }), /named by its folder/);
  assert.throws(() => importArgs({ from: ["claude"], only: [...all], accept: ["relative/x"] }), /named by its folder/);
  assert.throws(() => importArgs({ from: ["claude"], only: [...all], accept: ["~/a\nb"] }), /named by its folder/);
  assert.throws(() => importArgs({ from: ["claude"], only: [...all], accept: ["~/a"] }, { dryRun: true }), /dry run/);
  assert.throws(() => importArgs({ from: ["claude"], only: [...all], accept: Array.from({ length: 101 }, (_, i) => `~/r${i}`) }), /at most 100/);
});

test("progress: a run's step lines, counted against the steps it will print, across chunk boundaries", () => {
  assert.equal(importSteps({ from: ["claude", "codex"], only: ["instructions", "memories", "projects", "mcp", "sessions"] }), 7);
  assert.equal(importSteps({ from: ["codex"], only: ["instructions", "mcp"] }), 2);
  assert.deepEqual(progressStep("- instructions (Claude Code): 1 written, 0 already in the vault (whole file: no local model)"),
    { kind: "instructions", host: "Claude Code", text: "1 written, 0 already in the vault (whole file: no local model)" });
  assert.deepEqual(progressStep("- mcp: 2 on Claude Code, 2 on Codex listed"), { kind: "mcp", host: null, text: "2 on Claude Code, 2 on Codex listed" });
  for (const l of ["import: the last 90 days of Claude Code", "  created workspaces/alpha (repo: ~/code/alpha)", "- something else: x"]) assert.equal(progressStep(l), null, l);
  const seen: string[] = [];
  const f = new ProgressFollower(3, (p) => seen.push(`${p.done}/${p.steps} ${p.label}`));
  f.push("import: the last 90 days of Codex\n- instructions (Co");
  f.push("dex): 1 written, 0 already in the vault\n- memories (Codex): none to read\n");
  f.push("- mcp: 2 on Codex listed");
  assert.equal(seen.length, 2);
  f.end();
  assert.deepEqual(seen, ["1/3 Instructions from Codex: 1 written, 0 already in the vault", "2/3 Memories from Codex: none to read", "3/3 MCP servers: 2 on Codex listed"]);
  assert.equal(f.lines.length, 4);
});

/** import-state.json after `aos import` on both hosts and two digest runs. */
const STATE = JSON.stringify({
  schema: 1,
  phases: [
    { phase: "instructions", host: "claude", done: true, cursor: null, counts: { files: 1, rules: 5, written: 5, duplicates: 0 }, at: "2026-10-14T10:00:01.000Z" },
    { phase: "instructions", host: "codex", done: true, cursor: null, counts: { files: 1, written: 1 }, at: "2026-10-14T10:00:02.000Z" },
    { phase: "memories", host: "claude", done: true, cursor: null, counts: { files: 3, written: 2, duplicates: 1 }, at: "2026-10-14T10:00:03.000Z" },
    { phase: "projects", host: "all", done: true, cursor: null, counts: { proposed: 2, created: 1 }, at: "2026-10-14T10:00:04.000Z" },
    { phase: "mcp", host: "claude", done: true, cursor: null, counts: { servers: 2 }, at: "2026-10-14T10:00:05.000Z" },
    { phase: "mcp", host: "codex", done: true, cursor: null, counts: { servers: 0 }, at: "2026-10-14T10:00:05.000Z" },
    { phase: "sessions", host: "all", done: true, cursor: null, counts: { added: 412, queued: 412 }, at: "2026-10-14T10:00:06.000Z" },
    { phase: "digest", host: "all", done: false, cursor: 140, counts: { processed: 140, total: 412 }, at: "2026-10-14T11:00:00.000Z" },
  ],
  hashes: {}, files: {},
  digest: { since: "90d", processed: 140, total: 412, done: false, finishedAt: null, lastRun: { status: "ran", processed: 40, at: "2026-10-14T11:00:00.000Z" }, queue: Array.from({ length: 272 }, (_, i) => ({ key: `claude:${i}` })) },
  runs: [{ at: "2026-10-14T10:00:06.000Z", from: ["claude", "codex"], only: ["instructions"], since: "90d", written: 8 }],
});

test("import-state: the digest's progress until it is done, and each host's last import", () => {
  const s = parseImportState(STATE);
  const d = digestPending(s)!;
  assert.deepEqual([d.processed, d.total, d.left, d.done], [140, 412, 272, false]);
  assert.equal(digestText(d), "Digesting history: 140 of 412 sessions");
  assert.equal(digestText({ ...d, lastRun: { status: "waiting", reason: "no local model", at: null } }), "Digesting history: 140 of 412 sessions · waiting (no local model)");
  assert.equal(digestText({ ...d, lastRun: { status: "deferred", reason: "on battery", at: null } }), "Digesting history: 140 of 412 sessions · waiting (on battery)");
  const done = parseImportState(JSON.stringify({ digest: { processed: 412, total: 412, done: true, finishedAt: "2026-10-15T00:00:00.000Z", queue: [] } }));
  assert.equal(digestPending(done), null, "Pulse shows nothing once it is done");
  assert.equal(digestText(done.digest!), "History digested: 412 sessions");
  const last = lastImports(s);
  assert.deepEqual(last.claude, { at: "2026-10-14T10:00:05.000Z", rules: 5, memories: 2, servers: 2, sessions: 412, older: false });
  assert.equal(hostImportText(last.claude!), "5 rules and 2 memories written · 2 MCP servers listed · 412 sessions queued");
  assert.equal(hostImportText(last.codex!), "1 rule written · 412 sessions queued");
  assert.deepEqual(lastImports(parseImportState(null)), { claude: null, codex: null });
  assert.deepEqual(parseImportState("{not json"), { phases: [], digest: null, runs: [] });
  const older = parseImportState(JSON.stringify({ phases: [{ phase: "mcp", host: "codex", counts: { servers: 1 }, at: "2026-10-14T10:00:00.000Z" }], runs: [{ at: "x", from: ["codex"], since: "all" }] }));
  assert.equal(lastImports(older).codex!.older, true);
  assert.equal(hostImportText(lastImports(older).codex!), "nothing new written · 1 MCP server listed");
});
