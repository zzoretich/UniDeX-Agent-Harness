import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseSkills, readSkills, skillsStale, groupSkills, filterSkills, skillCounts, sourceLabel, statusChip, runCommand, shq, asOf, SKILLS_PATH,
} from "./skills";

const side = (invoke: string, via = "native") => ({ path: `/x/${invoke}/SKILL.md`, via, invoke });
const CACHE = {
  schema: 1,
  scannedAt: "2026-09-23T12:00:00.000Z",
  hosts: { claude: true, codex: true },
  sync: { on: true, reason: null, at: "2026-09-23T12:00:00.000Z", written: ["deploy"], removed: [], errors: [] },
  skills: [
    { id: "deploy", name: "deploy", description: "Ship the app", origin: { host: "claude", scope: "user", plugin: null, path: "/c/deploy/SKILL.md" },
      on: { claude: side("/deploy"), codex: side("$deploy", "mirror") }, status: "universal", note: null },
    { id: "docx", name: "docx", description: "Word documents", origin: { host: "claude", scope: "synced", plugin: null, path: "/c/synced/u/docx/SKILL.md" },
      on: { claude: side("/docx"), codex: null }, status: "invalid", note: "no YAML frontmatter" },
    { id: "triage", name: "triage", description: "Triage issues", origin: { host: "codex", scope: "user", plugin: null, path: "/a/triage/SKILL.md" },
      on: { claude: side("/triage", "mirror"), codex: side("$triage") }, status: "edited", note: "the copy at /c/triage was edited" },
    { id: "agenticos:wrap", name: "wrap", description: "Session end", origin: { host: "claude", scope: "plugin", plugin: "agenticos", path: "/p/wrap.md" },
      on: { claude: side("/agenticos:wrap", "plugin"), codex: side("$agenticos:wrap", "plugin") }, status: "listed", note: "from the agenticos plugin" },
    { id: "imagegen", name: "imagegen", description: "Images", origin: { host: "codex", scope: "builtin", plugin: null, path: "/s/imagegen/SKILL.md" },
      on: { claude: null, codex: side("$imagegen", "builtin") }, status: "listed", note: "built into Codex" },
    { name: "no id" },
  ],
};

test("parseSkills: rows, hosts and sync state; tolerant fields; missing, corrupt or foreign is empty", () => {
  const c = parseSkills(JSON.stringify(CACHE));
  assert.equal(c.skills.length, 5);
  assert.deepEqual(c.hosts, { claude: true, codex: true });
  assert.deepEqual(c.sync, { on: true, reason: null, at: "2026-09-23T12:00:00.000Z" });
  assert.equal(c.skills[0].on.codex?.invoke, "$deploy");
  assert.equal(c.skills[1].on.codex, null);
  for (const raw of [null, "{nope", JSON.stringify({ schema: 2, skills: [] }), JSON.stringify({ schema: 1 })]) {
    const e = parseSkills(raw);
    assert.deepEqual(e.skills, []);
    assert.equal(e.scannedAt, null);
  }
  const min = parseSkills(JSON.stringify({ schema: 1, skills: [{ id: "a", on: { claude: { invoke: "" } } }] }));
  assert.deepEqual(min.skills[0], { id: "a", name: "a", description: "", origin: { host: "claude", scope: "user", plugin: null, path: "" }, on: { claude: null, codex: null }, status: "listed", note: null });
  assert.deepEqual(min.hosts, { claude: true, codex: false });
});

test("readSkills: the vault file, or empty when absent", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-skills-hud-"));
  assert.deepEqual(readSkills(vault).skills, []);
  fs.mkdirSync(path.join(vault, path.dirname(SKILLS_PATH)), { recursive: true });
  fs.writeFileSync(path.join(vault, SKILLS_PATH), JSON.stringify(CACHE));
  assert.equal(readSkills(vault).skills.length, 5);
});

test("skillsStale: never scanned or older than ten minutes", () => {
  const c = parseSkills(JSON.stringify(CACHE));
  const t = Date.parse("2026-09-23T12:00:00.000Z");
  assert.equal(skillsStale(c, t + 60_000), false);
  assert.equal(skillsStale(c, t + 11 * 60_000), true);
  assert.equal(skillsStale(parseSkills(null), t), true);
});

test("groupSkills / filterSkills / skillCounts", () => {
  const { yours, listed } = groupSkills(parseSkills(JSON.stringify(CACHE)).skills);
  assert.deepEqual(yours.map((r) => r.id), ["deploy", "docx", "triage"]);
  assert.deepEqual(listed.map((r) => r.id), ["agenticos:wrap", "imagegen"]);
  assert.deepEqual(filterSkills(yours, "  WORD "), [yours[1]]);
  assert.deepEqual(filterSkills(listed, "agenticos").map((r) => r.id), ["agenticos:wrap"]);
  assert.equal(filterSkills(yours, "").length, 3);
  assert.deepEqual(skillCounts(yours), { both: 2, claude: 1, codex: 0 });
});

test("sourceLabel and statusChip", () => {
  const rows = parseSkills(JSON.stringify(CACHE)).skills;
  assert.deepEqual(rows.map(sourceLabel), ["claude", "claude.ai", "codex", "agenticos", "built-in"]);
  assert.deepEqual(rows.map((r) => statusChip(r).text), ["on both", "can't share", "copy edited", "both (plugin)", "built-in"]);
  assert.equal(statusChip(rows[0]).cls, "is-ok");
  assert.equal(statusChip(rows[2]).cls, "is-stale");
});

test("runCommand: the host CLI with the invocation single-quoted (a Codex $name must reach Codex unexpanded)", () => {
  const [deploy, docx] = parseSkills(JSON.stringify(CACHE)).skills;
  assert.equal(runCommand(deploy, "claude"), "claude '/deploy'");
  assert.equal(runCommand(deploy, "codex"), "codex '$deploy'");
  assert.equal(runCommand(docx, "codex"), null);
  assert.equal(shq("it's"), "'it'\\''s'");
});

test("asOf: the last sync, else the last scan", () => {
  const c = parseSkills(JSON.stringify(CACHE));
  assert.equal(asOf(c), "2026-09-23T12:00:00.000Z");
  assert.equal(asOf({ ...c, sync: { ...c.sync, at: null }, scannedAt: "2026-09-23T11:00:00.000Z" }), "2026-09-23T11:00:00.000Z");
});
