import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseAgents, readAgents, agentsStale, groupAgents, filterAgents, agentCounts, sourceLabel, statusChip, runCommand, asOf, AGENTS_PATH,
} from "./agents";

const claude = (name: string, via = "native") => ({ path: `/c/agents/${name}.md`, via, invoke: `@agent-${name}`, run: `claude --agent ${name}` });
const codex = (name: string, via = "native") => ({ path: `/x/agents/${name}.toml`, via, invoke: name, run: `codex 'Use the ${name} agent.'` });
const CACHE = {
  schema: 1,
  scannedAt: "2026-09-23T12:00:00.000Z",
  hosts: { claude: true, codex: true },
  codexAgents: { on: true, reason: null },
  sync: { on: true, reason: null, at: "2026-09-23T12:00:00.000Z", written: ["reviewer"], removed: [], errors: [] },
  agents: [
    { id: "reviewer", name: "reviewer", description: "Reviews diffs", origin: { host: "claude", scope: "user", plugin: null, path: "/c/agents/reviewer.md" },
      on: { claude: claude("reviewer"), codex: codex("reviewer", "mirror") }, readOnly: true, status: "universal", note: null },
    { id: "explorer", name: "explorer", description: "Explores", origin: { host: "claude", scope: "user", plugin: null, path: "/c/agents/explorer.md" },
      on: { claude: claude("explorer"), codex: null }, readOnly: false, status: "invalid", note: "would replace Codex's built-in explorer agent" },
    { id: "pr-explorer", name: "pr_explorer", description: "Maps code paths", origin: { host: "codex", scope: "user", plugin: null, path: "/x/agents/pr_explorer.toml" },
      on: { claude: claude("pr-explorer", "mirror"), codex: codex("pr_explorer") }, readOnly: false, status: "edited", note: "the copy was edited" },
    { id: "kit:planner", name: "planner", description: "Plans", origin: { host: "claude", scope: "plugin", plugin: "kit", path: "/p/agents/planner.md" },
      on: { claude: claude("kit:planner", "plugin"), codex: null }, readOnly: false, status: "listed", note: "from the kit plugin" },
    { id: "docs_researcher", name: "docs_researcher", description: "Checks APIs", origin: { host: "codex", scope: "config", plugin: null, path: "/x/config.toml" },
      on: { claude: null, codex: codex("docs_researcher", "config") }, readOnly: false, status: "listed", note: "declared in config.toml" },
    { name: "no id" },
  ],
};

test("parseAgents: rows, hosts, Codex subagent state and sync state; missing, corrupt or foreign is empty", () => {
  const c = parseAgents(JSON.stringify(CACHE));
  assert.equal(c.agents.length, 5);
  assert.deepEqual(c.hosts, { claude: true, codex: true });
  assert.deepEqual(c.codexAgents, { on: true, reason: null });
  assert.deepEqual(c.sync, { on: true, reason: null, at: "2026-09-23T12:00:00.000Z" });
  assert.equal(c.agents[0].readOnly, true);
  assert.equal(c.agents[0].on.codex?.invoke, "reviewer");
  assert.equal(c.agents[1].on.codex, null);
  for (const raw of [null, "{nope", JSON.stringify({ schema: 2, agents: [] }), JSON.stringify({ schema: 1 })]) {
    const e = parseAgents(raw);
    assert.deepEqual(e.agents, []);
    assert.equal(e.scannedAt, null);
  }
  const min = parseAgents(JSON.stringify({ schema: 1, codexAgents: { on: false, reason: "off" }, agents: [{ id: "a", on: { claude: { invoke: "" } } }] }));
  assert.deepEqual(min.agents[0], { id: "a", name: "a", description: "", origin: { host: "claude", scope: "user", plugin: null, path: "" }, on: { claude: null, codex: null }, readOnly: false, status: "listed", note: null });
  assert.deepEqual(min.codexAgents, { on: false, reason: "off" });
});

test("parseAgents: a run command that does not start the host's own CLI is dropped", () => {
  const c = parseAgents(JSON.stringify({ schema: 1, agents: [{ id: "a", on: {
    claude: { invoke: "@agent-a", run: "rm -rf ~; claude --agent a" },
    codex: { invoke: "a", run: "claude --agent a" },
  } }] }));
  assert.equal(c.agents[0].on.claude?.run, null);
  assert.equal(c.agents[0].on.codex?.run, null);
  assert.equal(runCommand(c.agents[0], "claude"), null);
});

test("readAgents: the vault file, or empty when absent", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-agents-hud-"));
  assert.deepEqual(readAgents(vault).agents, []);
  fs.mkdirSync(path.join(vault, path.dirname(AGENTS_PATH)), { recursive: true });
  fs.writeFileSync(path.join(vault, AGENTS_PATH), JSON.stringify(CACHE));
  assert.equal(readAgents(vault).agents.length, 5);
});

test("agentsStale: never scanned or older than ten minutes", () => {
  const c = parseAgents(JSON.stringify(CACHE));
  const t = Date.parse("2026-09-23T12:00:00.000Z");
  assert.equal(agentsStale(c, t + 60_000), false);
  assert.equal(agentsStale(c, t + 11 * 60_000), true);
  assert.equal(agentsStale(parseAgents(null), t), true);
});

test("groupAgents / filterAgents / agentCounts", () => {
  const { yours, listed } = groupAgents(parseAgents(JSON.stringify(CACHE)).agents);
  assert.deepEqual(yours.map((r) => r.id), ["reviewer", "explorer", "pr-explorer"]);
  assert.deepEqual(listed.map((r) => r.id), ["kit:planner", "docs_researcher"]);
  assert.deepEqual(filterAgents(yours, "  CODE PATHS "), [yours[2]]);
  assert.deepEqual(filterAgents(listed, "kit").map((r) => r.id), ["kit:planner"]);
  assert.equal(filterAgents(yours, "").length, 3);
  assert.deepEqual(agentCounts(yours), { both: 2, claude: 1, codex: 0 });
});

test("sourceLabel and statusChip", () => {
  const rows = parseAgents(JSON.stringify(CACHE)).agents;
  assert.deepEqual(rows.map(sourceLabel), ["claude", "claude", "codex", "kit", "config.toml"]);
  assert.deepEqual(rows.map((r) => statusChip(r).text), ["on both", "can't share", "copy edited", "plugin", "config.toml"]);
  assert.equal(statusChip(rows[0]).cls, "is-ok");
  assert.equal(statusChip(rows[1]).cls, "is-failed");
});

test("runCommand: the row's own command per host, null where the host lacks the agent", () => {
  const [reviewer, explorer] = parseAgents(JSON.stringify(CACHE)).agents;
  assert.equal(runCommand(reviewer, "claude"), "claude --agent reviewer");
  assert.equal(runCommand(reviewer, "codex"), "codex 'Use the reviewer agent.'");
  assert.equal(runCommand(explorer, "codex"), null);
});

test("asOf: the last sync, else the last scan", () => {
  const c = parseAgents(JSON.stringify(CACHE));
  assert.equal(asOf(c), "2026-09-23T12:00:00.000Z");
  assert.equal(asOf({ ...c, sync: { ...c.sync, at: null }, scannedAt: "2026-09-23T11:00:00.000Z" }), "2026-09-23T11:00:00.000Z");
});
