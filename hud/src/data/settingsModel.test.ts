import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseConfigList, groupBySection, changedCount, masterRows, MASTER_SWITCHES, valueArg, confirmFor,
  appliesLabel, sourceLabel, sourceTitle, spendLine, hostNote, resultSummary, FollowUps, argsFor,
  controlFor, choiceLabel, pickerOptions, stepIn, stepValue, manySelected, manyOptions, toggleMany, readonlyText,
} from "./settingsModel";
import type { ConfigRow, ConfigList } from "./settingsModel";

const row = (over: Partial<ConfigRow>): ConfigRow => ({
  key: "k", section: "provider", label: "K", help: "Help.", type: "bool", values: null, min: null, gt: null, max: null, int: false,
  nullable: false, risk: null, applies: "next-call", readonly: false, how: null, host: null, default: true, value: true,
  source: "default", changed: false, note: null, spentToday: null, ...over,
});

const LIST: ConfigList = {
  schema: 1,
  files: { machine: "/cfg/agenticos.json", vault: "/v/brain/config.json" },
  sections: [{ id: "provider", label: "Provider & models" }, { id: "spend", label: "Spend limits" }, { id: "empty", label: "Nothing" }],
  settings: [
    row({ key: "provider", type: "enum", values: ["auto", "ollama", "claude", "codex", "none"], value: "none", default: "auto", changed: true, risk: "spend" }),
    row({ key: "claude.perDayUsd", section: "spend", type: "number", min: 0, value: 0.5, default: 0.5, risk: "spend", spentToday: 0.12, host: "claude" }),
    row({ key: "persona.enabled", section: "spend", value: false, default: true, changed: true, risk: "autonomy" }),
  ],
};

test("parseConfigList accepts schema 1 only, and every row needs a key, section and type", () => {
  assert.equal(parseConfigList(LIST), LIST);
  assert.equal(parseConfigList({ ...LIST, schema: 2 }), null);
  assert.equal(parseConfigList({ ...LIST, settings: [{ key: 1 }] }), null);
  assert.equal(parseConfigList(null), null);
  assert.equal(parseConfigList("x"), null);
});

test("groupBySection keeps the runtime's order and drops an empty section; changedCount counts *", () => {
  assert.deepEqual(groupBySection(LIST).map((g) => [g.section.id, g.rows.map((r) => r.key)]), [["provider", ["provider"]], ["spend", ["claude.perDayUsd", "persona.enabled"]]]);
  assert.equal(changedCount(LIST), 2);
});

test("master switches (D5): Background AI is provider none ↔ auto; flags are true/false; unknown keys skipped", () => {
  const m = masterRows(LIST);
  assert.deepEqual(m.map((x) => [x.sw.key, x.on]), [["provider", false], ["persona.enabled", false]]);
  const ai = MASTER_SWITCHES[0];
  assert.equal(ai.valueFor(true), "auto");
  assert.equal(ai.valueFor(false), "none");
  assert.equal(ai.isOn("ollama"), true);
  assert.equal(MASTER_SWITCHES.length, 11);
  assert.equal(new Set(MASTER_SWITCHES.map((s) => s.key)).size, 11);
});

test("valueArg: strings as typed, null as `null`, the rest as JSON", () => {
  assert.equal(valueArg("auto"), "auto");
  assert.equal(valueArg(null), "null");
  assert.equal(valueArg(false), "false");
  assert.equal(valueArg(["a"]), '["a"]');
});

test("confirmFor (D6): raising spend asks; lowering does not", () => {
  const cap = row({ key: "claude.perDayUsd", label: "Background daily cap (Claude)", type: "number", min: 0, value: 0.5, risk: "spend" });
  assert.deepEqual(confirmFor(cap, 5), { title: "Raise Background daily cap (Claude)?", message: "claude.perDayUsd: $0.50 → $5.00.", cta: "Raise" });
  assert.equal(confirmFor(cap, 0.1), null);
  assert.equal(confirmFor(cap, 0.5), null, "no change, no question");
  const files = row({ key: "scan.fileMapBudgetUnderClaude", type: "number", min: 0, value: 0, risk: "spend" });
  assert.match(confirmFor(files, 10)!.message, /: 0 → 10\.$/, "not money");
});

test("confirmFor (D6): the provider asks only when moving from free to paid", () => {
  const p = row({ key: "provider", type: "enum", value: "none", risk: "spend" });
  assert.equal(confirmFor(p, "auto")!.cta, "Turn on");
  assert.match(confirmFor(p, "codex")!.message, /your Codex login/);
  assert.equal(confirmFor({ ...p, value: "ollama" }, "claude")!.cta, "Turn on");
  assert.equal(confirmFor({ ...p, value: "claude" }, "none"), null);
  assert.equal(confirmFor({ ...p, value: "auto" }, "claude"), null, "already paid");
  assert.equal(confirmFor(p, "ollama"), null);
});

test("confirmFor (D6): spend switches, autonomy, privacy", () => {
  const sem = row({ key: "graph.semantic.enabled", label: "Semantic graph pass", type: "enum", values: [true, false, "auto"], value: false, risk: "spend" });
  assert.equal(confirmFor(sem, "auto")!.title, "Turn on Semantic graph pass?");
  assert.equal(confirmFor({ ...sem, value: true }, false), null);
  const cos = row({ key: "persona.enabled", label: "Chief of Staff", value: false, risk: "autonomy" });
  assert.equal(confirmFor(cos, true)!.cta, "Turn on");
  assert.equal(confirmFor({ ...cos, value: true }, false), null, "turning it off never asks");
  const min = row({ key: "example.threshold", label: "A threshold", type: "number", value: 3, risk: "autonomy" });
  assert.equal(confirmFor(min, 1)!.cta, "Lower");
  assert.equal(confirmFor(min, 5), null);
  assert.equal(confirmFor(row({ key: "routines.tools", type: "string", value: "Read,Glob,Grep", risk: "autonomy" }), "Read,Write")!.cta, "Change");
  const redact = row({ key: "telemetry.redact", label: "Redact tool inputs", value: true, risk: "privacy" });
  assert.equal(confirmFor(redact, false)!.cta, "Turn off");
  assert.equal(confirmFor({ ...redact, value: false }, true), null);
  assert.equal(confirmFor(row({ key: "updates.check", value: true }), false), null, "no risk class, no question");
});

test("labels: applies, source and its tooltip", () => {
  assert.equal(appliesLabel("next-scan"), "applies at the next scan");
  assert.equal(appliesLabel("later"), "applies: later");
  assert.equal(sourceLabel("machine"), "this machine");
  assert.equal(sourceLabel("vault"), "this vault");
  assert.equal(sourceTitle("machine", LIST.files), "set in /cfg/agenticos.json");
  assert.match(sourceTitle("default", LIST.files), /neither file/);
});

test("spendLine (D7): today against the cap; 0 means no spend; other rows none", () => {
  assert.equal(spendLine(row({ type: "number", value: 0.5, spentToday: 0.12 })), "today $0.12 of $0.50");
  assert.equal(spendLine(row({ type: "number", value: 0, spentToday: 0 })), "today $0.00 · no spend allowed");
  assert.equal(spendLine(row({ type: "number", value: 0.05, spentToday: null })), null);
});

test("hostNote (D8): only a host-specific row on a machine without that host", () => {
  assert.equal(hostNote(row({ host: "codex" }), ["claude"]), "Codex is off on this machine; Add Codex under Hosts (`aos hosts add codex`) turns it on");
  assert.match(hostNote(row({ host: "claude" }), ["codex"])!, /^Claude Code is off/);
  assert.equal(hostNote(row({ host: "codex" }), ["claude", "codex"]), null);
  assert.equal(hostNote(row({ host: null }), ["claude"]), null);
});

test("resultSummary: the change, then each effect on its own line", () => {
  assert.equal(resultSummary({ key: "provider", old: "auto", value: "none", file: "/f", source: "machine", dryRun: false, effects: ["cleared the cached provider probe"], followUps: [] }),
    "provider: auto → none\ncleared the cached provider probe");
  assert.equal(resultSummary({ key: "codex.model", old: null, value: "gpt-5", file: "/f", source: "vault", dryRun: false, effects: [], followUps: [] }), "codex.model: null → gpt-5");
});

test("FollowUps (D9): deduped, removable, and only plain aos commands are kept", () => {
  const f = new FollowUps();
  f.add([{ command: "aos routines sync", why: "schedules" }, { command: "aos routines sync", why: "again" }, { command: "rm -rf /", why: "no" }]);
  f.add(undefined);
  assert.equal(f.size, 1);
  assert.deepEqual(f.list(), [{ command: "aos routines sync", why: "again" }]);
  f.remove("aos routines sync");
  assert.equal(f.size, 0);
  assert.deepEqual(argsFor("aos skills sync"), ["skills", "sync"]);
  assert.equal(argsFor("aos routines sync; rm x"), null);
  assert.equal(argsFor("routines sync"), null);
});

// ── no text boxes (spec 2026-09-24-settings-pickers) ──

test("controlFor: every row is a toggle, a picker, a stepper, chips, a button or read-only — never a text box", () => {
  assert.equal(controlFor(row({ type: "bool" })), "toggle");
  assert.equal(controlFor(row({ type: "enum", values: ["a", "b"] })), "picker");
  assert.equal(controlFor(row({ type: "number", choices: [1, 2] })), "stepper");
  assert.equal(controlFor(row({ type: "model", choices: ["haiku"] })), "picker");
  assert.equal(controlFor(row({ type: "string", choices: ["x"] })), "picker");
  assert.equal(controlFor(row({ type: "list", choices: ["a"], pick: "many" })), "chips");
  assert.equal(controlFor(row({ type: "list", editIn: "skills" })), "button");
  assert.equal(controlFor(row({ type: "object", editIn: "file" })), "button");
  assert.equal(controlFor(row({ readonly: true })), "readonly");
  assert.equal(controlFor(row({ type: "number", choices: null })), "readonly", "a 0.18 runtime sends no presets");
});

test("choiceLabel: money, no spend, units, null", () => {
  assert.equal(choiceLabel({ unit: "usd", min: 0 }, 0), "$0 — no spend");
  assert.equal(choiceLabel({ unit: "usd", min: null }, 0.5), "$0.50");
  assert.equal(choiceLabel({ unit: "usd", min: null }, null), "none");
  assert.equal(choiceLabel({ unit: null, min: null }, null), "host default");
  assert.equal(choiceLabel({ unit: "min", min: null }, 45), "45 min");
  assert.equal(choiceLabel({ unit: "days", min: null }, 1), "1 day");
  assert.equal(choiceLabel({ unit: "tokens", min: null }, 20000), "20,000 tokens");
  assert.equal(choiceLabel({ unit: null, min: null }, "haiku"), "haiku");
});

test("pickerOptions (D3): presets, null first when nullable, the current value kept as (custom) in order", () => {
  const cap = row({ type: "number", unit: "usd", min: 0, choices: [0, 1, 5, 10], value: 7 });
  assert.deepEqual(pickerOptions(cap).map((o) => o.label), ["$0 — no spend", "$1.00", "$5.00", "$7.00 (custom)", "$10.00"]);
  assert.equal(pickerOptions(cap).find((o) => o.custom)?.key, "7");
  assert.deepEqual(pickerOptions({ ...cap, value: 99 }).map((o) => o.value).at(-1), 99);
  const model = row({ type: "model", nullable: true, choices: ["gpt-5", "o3"], value: null });
  assert.deepEqual(pickerOptions(model).map((o) => o.label), ["host default", "gpt-5", "o3"]);
  assert.deepEqual(pickerOptions({ ...model, value: "gpt-9" }).map((o) => o.label), ["host default", "gpt-5", "o3", "gpt-9 (custom)"]);
  const en = row({ type: "enum", values: [true, false, "auto"], value: "auto" });
  assert.deepEqual(pickerOptions(en).map((o) => o.key), ["true", "false", "auto"]);
  const budget = row({ type: "number", unit: "usd", nullable: true, choices: [10, 150], value: null });
  assert.equal(pickerOptions(budget)[0].label, "none");
});

test("stepValue (D9): the adjacent preset, nearest from a custom value, null at the ends", () => {
  const cap = row({ type: "number", choices: [0, 1, 5, 10], value: 5 });
  assert.equal(stepValue(cap, 1), 10);
  assert.equal(stepValue(cap, -1), 1);
  assert.equal(stepValue({ ...cap, value: 10 }, 1), null);
  assert.equal(stepValue({ ...cap, value: 0 }, -1), null);
  assert.equal(stepValue({ ...cap, value: 7 }, 1), 10);
  assert.equal(stepValue({ ...cap, value: 7 }, -1), 5);
  assert.equal(stepIn([10, 150], null, 1), 10, "from none, + goes to the first preset");
  assert.equal(stepIn([10, 150], null, -1), null);
});

test("chips: a list or a comma string, in the presets' order, custom items kept", () => {
  const roots = row({ type: "list", pick: "many", choices: ["brain/memory", "brain/patterns", "persona/journal"], value: ["persona/journal", "my/notes"] });
  assert.deepEqual(manySelected(roots), ["persona/journal", "my/notes"]);
  assert.deepEqual(manyOptions(roots), ["brain/memory", "brain/patterns", "persona/journal", "my/notes"]);
  assert.deepEqual(toggleMany(roots, "brain/memory", true), ["brain/memory", "persona/journal", "my/notes"]);
  assert.deepEqual(toggleMany(roots, "my/notes", false), ["persona/journal"]);
  const tools = row({ type: "string", pick: "many", choices: ["Read", "Glob", "Grep", "Write"], value: "Read,Glob,Grep" });
  assert.equal(toggleMany(tools, "Write", true), "Read,Glob,Grep,Write");
  assert.equal(toggleMany(tools, "Glob", false), "Read,Grep");
});

test("readonlyText: a value, a list, an object, nothing", () => {
  assert.equal(readonlyText(row({ value: "/v" })), "/v");
  assert.equal(readonlyText(row({ value: null })), "not set");
  assert.equal(readonlyText(row({ value: ["a", "b"] })), "a, b");
  assert.equal(readonlyText(row({ value: [] })), "none");
  assert.equal(readonlyText(row({ value: { a: {}, b: {} } })), "2 entries");
  assert.equal(readonlyText(row({ value: 0.5, unit: "usd" })), "$0.50");
});
