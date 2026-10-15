import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CHIEF_MODELS, backgroundSpend, chiefChoice, hostedName, migrateArgs, migrateCommand, parseMigrations, spendText, staysHosted } from "./goLocal";

const NOW = new Date(2026, 9, 15, 12, 0, 0);
const day = (d: number, h = 9) => new Date(2026, 9, d, h, 0, 0).toISOString();
const row = (ts: string, feature: string, usd: number, provider = "claude") => JSON.stringify({ ts, feature, usd, provider });

test("parseMigrations: rows by id as cli/migrations.js writes them; junk is no row", () => {
  const text = JSON.stringify({ schema: 1, migrations: [
    { id: "local-first", state: "applied", since: "2.0.0", at: "2026-10-15T12:00:00.000Z", backup: "brain/_index/migrations/local-first-x.json" },
    { id: "import", state: "pending", since: "2.0.0" }, { id: "x", state: "weird" }, null,
  ] });
  assert.deepEqual(parseMigrations(text), {
    "local-first": { id: "local-first", state: "applied", at: "2026-10-15T12:00:00.000Z", backup: "brain/_index/migrations/local-first-x.json" },
    import: { id: "import", state: "pending", at: null, backup: null },
  });
  assert.deepEqual(parseMigrations(null), {});
  assert.deepEqual(parseMigrations("{"), {});
  assert.deepEqual(parseMigrations('{"migrations":{}}'), {});
});

test("backgroundSpend: the last 7 local days of the work that moves local; duties, routines, sessions and Ollama rows stay out", () => {
  const ledger = [
    row(day(15), "summary", 0.02), row(day(14), "reason:ask", 0.5), row(day(9), "graph:semantic", 1.0), row(day(10), "wrap", 0.1),
    row(day(8, 23), "summary", 9), row(day(15), "duty:sitrep", 2), row(day(15), "routine:ron", 1), row(day(15), "session:turn", 3),
    row(day(15), "team:seat", 1), row(day(15), "cross-review:plan", 1), row(day(15), "summary", 0, "ollama"), "not json", "",
  ].join("\n");
  assert.deepEqual(backgroundSpend(ledger, NOW), { usd: 1.62, calls: 4 });
  assert.deepEqual(backgroundSpend(null, NOW), { usd: 0, calls: 0 });
  assert.equal(spendText({ usd: 1.62, calls: 4 }), "$1.62 over 4 calls in the last 7 days; on this Mac it costs nothing");
  assert.equal(spendText({ usd: 0, calls: 0 }), "nothing: background work spent no money in the last 7 days");
});

test("the Chief of Staff's models are the chief role's (config.default.json), worded for this Mac's hosts", () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "brain", "scripts", "config.default.json"), "utf8"));
  assert.deepEqual([CHIEF_MODELS.claude.model, CHIEF_MODELS.codex.model], [defaults.persona.model, defaults.persona.codexModel]);
  assert.equal(chiefChoice(["claude"]), "Move the Chief of Staff to Opus 5.5");
  assert.equal(chiefChoice(["codex"]), "Move the Chief of Staff to gpt-6-sol");
  assert.equal(chiefChoice(["claude", "codex"]), "Move the Chief of Staff to Opus 5.5 on Claude Code and gpt-6-sol on Codex");
  assert.match(chiefChoice([]), /Opus 5\.5 \/ gpt-6-sol when you add a host/);
  assert.deepEqual([hostedName(["codex"]), hostedName(["claude", "codex"])], ["Codex", "Claude Code and Codex"]);
  assert.match(staysHosted([])[0], /Claude Code or Codex, once you add one/);
});

test("migrateArgs: exactly the argv the migrate surface admits", () => {
  assert.deepEqual(migrateArgs("apply", true), ["migrate", "local-first", "--apply", "--chief", "--json"]);
  assert.deepEqual(migrateArgs("apply"), ["migrate", "local-first", "--apply", "--json"]);
  assert.deepEqual(migrateArgs("decline", true), ["migrate", "local-first", "--decline", "--json"]);
  assert.deepEqual(migrateArgs("undo"), ["migrate", "local-first", "--undo", "--json"]);
  assert.equal(migrateCommand("apply", true), "aos migrate local-first --apply --chief");
});
