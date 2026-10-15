import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type { HostCatalog, HostCatalogHost } from "../host";
import type { HostChoice } from "../data/agentSessions";
import type * as Menu from "./HostModelMenu";

// HostModelMenu.ts draws its icons with Obsidian's setIcon, and the obsidian package ships types only: under node:test
// "obsidian" resolves to a stub, so the menu's pure parts load without a DOM.
const STUB = "obsidian-stub";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { setIcon: () => {} } } as unknown as NodeJS.Module;
const { menuHost, menuValue, switchHost, withModel, modelRows, hostOffLine, noHostLine, effortNote, customModelError } = require("./HostModelMenu") as typeof Menu;

const E5 = ["low", "medium", "high", "xhigh", "max"];
const E6 = ["low", "medium", "high", "xhigh", "max", "ultra"];
const model = (id: string, name: string, efforts: string[], main: boolean, description = "") => ({ id, name, description, efforts, main });
const claudeCat: HostCatalogHost = {
  ok: true, version: "2.1.293", fetchedAt: "2026-10-07T09:58:00.000Z", defaultModel: null, defaultEffort: null,
  models: [
    model("default", "Default (recommended)", E5, true, "Opus 5.5 · Best for everyday, complex tasks"),
    model("opus", "Opus 5.5", E5, true, "For complex work and everyday tasks"),
    model("haiku", "Haiku 5.5", E5, true, "Fastest for quick answers"),
    model("claude-opus-4-6", "Opus 4.6", ["low", "medium", "high", "max"], false),
    model("claude-haiku-4-5-20251001", "Haiku 4.5", [], false),
  ],
  commands: [],
};
const codexCat: HostCatalogHost = {
  ok: true, version: "0.158.0", fetchedAt: "2026-10-07T09:00:00.000Z", defaultModel: "gpt-6-sol", defaultEffort: "high",
  models: [
    model("gpt-6-astra", "GPT-6-Astra", E6, true, "Frontier intelligence for the most demanding work"),
    model("gpt-6-sol", "GPT-6-Sol", ["minimal", ...E6], true, "Previous generation workhorse model"),
    model("gpt-5.6-terra", "GPT-5.6-Terra", ["high", "max"], false, "Older balanced model"),
  ],
  commands: [],
};
/** A Codex that did not answer and has no configured default: no models at all (the runtime's fallback). */
const codexDown: HostCatalogHost = { ok: false, reason: "Codex listed no models", version: null, fetchedAt: "2026-10-07T09:00:00.000Z", defaultModel: null, defaultEffort: null, models: [], commands: [] };
const CAT: HostCatalog = { schema: 1, fetchedAt: "2026-10-07T09:58:00.000Z", hosts: { claude: claudeCat, codex: codexCat } };

const ready = (host: "claude" | "codex"): HostChoice => ({ host, label: host === "claude" ? "Claude Code" : "Codex", ready: true, reason: null });
const BOTH: HostChoice[] = [ready("claude"), ready("codex")];
const CLAUDE_ONLY: HostChoice[] = [ready("claude"), { host: "codex", label: "Codex", ready: false, reason: "Codex is off on this machine" }];
const NONE: HostChoice[] = [
  { host: "claude", label: "Claude Code", ready: false, reason: "Claude Code is not logged in" },
  { host: "codex", label: "Codex", ready: false, reason: "Codex is off on this machine" },
];

test("menuHost: a thread keeps its host; a new session or Vault question moves off a host that is not ready", () => {
  assert.equal(menuHost("thread", "codex", CLAUDE_ONLY), "codex");
  assert.equal(menuHost("new", "codex", CLAUDE_ONLY), "claude");
  assert.equal(menuHost("vault", "codex", BOTH), "codex");
  assert.equal(menuHost("new", null, BOTH), "claude");
  assert.equal(menuHost("new", "claude", NONE), null);
});

test("menuValue: a new session starts on a model and an effort the catalog lists for that host", () => {
  const value = { host: "codex" as const, model: null, effort: null };
  assert.deepEqual(menuValue({ mode: "new", catalog: CAT, choices: BOTH, value }), { host: "codex", model: "gpt-6-sol", effort: "high" });
  // An effort the model does not take falls back to the catalog's default level.
  assert.deepEqual(menuValue({ mode: "new", catalog: CAT, choices: BOTH, value: { host: "codex", model: "gpt-5.6-terra", effort: "low" } }), { host: "codex", model: "gpt-5.6-terra", effort: "high" });
  // A host that is off: the first ready one, from what was remembered for it.
  const remembered = { claude: { model: "haiku", effort: "low" } };
  assert.deepEqual(menuValue({ mode: "new", catalog: CAT, choices: CLAUDE_ONLY, value, remembered }), { host: "claude", model: "haiku", effort: "low" });
  assert.deepEqual(menuValue({ mode: "new", catalog: CAT, choices: NONE, value }), { host: null, model: null, effort: null });
});

test("menuValue: a thread keeps what it ran on, nulls included (no change marker for an untouched turn)", () => {
  const value = { host: "codex" as const, model: null, effort: null };
  assert.deepEqual(menuValue({ mode: "thread", catalog: CAT, choices: CLAUDE_ONLY, value }), value);
});

test("menuValue: Vault keeps to the one-shot levels (Codex has no max or ultra there)", () => {
  const value = { host: "codex" as const, model: "gpt-6-astra", effort: "ultra" };
  assert.deepEqual(menuValue({ mode: "vault", catalog: CAT, choices: BOTH, value }), { host: "codex", model: "gpt-6-astra", effort: "high" });
  assert.deepEqual(menuValue({ mode: "new", catalog: CAT, choices: BOTH, value }), value);
});

test("menuValue: in Vault with the local engine on offer, a null host is the local engine, not \"no host ready\" (local-first A2)", () => {
  const local = { model: "qwen3.5:9b", down: null };
  const none = { host: null, model: null, effort: null };
  assert.deepEqual(menuValue({ mode: "vault", catalog: CAT, choices: BOTH, value: none, local }), none);
  // Without it a null host moves to the first ready host, as before.
  assert.equal(menuValue({ mode: "vault", catalog: CAT, choices: BOTH, value: none }).host, "claude");
  // A host picked over the local engine is that host.
  assert.equal(menuValue({ mode: "vault", catalog: CAT, choices: BOTH, value: { host: "codex", model: null, effort: null }, local }).host, "codex");
  // Never in a new session or a thread.
  assert.equal(menuValue({ mode: "new", catalog: CAT, choices: BOTH, value: none, local }).host, "claude");
});

test("switchHost: the other host's remembered model and effort, else its defaults", () => {
  assert.deepEqual(switchHost("claude", CAT, null), { host: "claude", model: "default", effort: "medium" });
  assert.deepEqual(switchHost("codex", CAT, { codex: { model: "gpt-6-astra", effort: "ultra" } }), { host: "codex", model: "gpt-6-astra", effort: "ultra" });
  assert.deepEqual(switchHost("codex", CAT, { codex: { model: "gpt-6-astra", effort: "ultra" } }, true), { host: "codex", model: "gpt-6-astra", effort: "high" });
  // A Codex that listed nothing: its own default, at the session levels.
  assert.deepEqual(switchHost("codex", { ...CAT, hosts: { codex: codexDown } }, null), { host: "codex", model: null, effort: "medium" });
});

test("withModel: the effort stays when the new model takes it; a model without efforts drops it; null stays null", () => {
  assert.deepEqual(withModel("claude", claudeCat, "opus", "xhigh"), { host: "claude", model: "opus", effort: "xhigh" });
  assert.deepEqual(withModel("claude", claudeCat, "claude-opus-4-6", "xhigh"), { host: "claude", model: "claude-opus-4-6", effort: "medium" });
  assert.deepEqual(withModel("claude", claudeCat, "claude-haiku-4-5-20251001", "high"), { host: "claude", model: "claude-haiku-4-5-20251001", effort: null });
  assert.deepEqual(withModel("codex", codexCat, null, "max"), { host: "codex", model: null, effort: "max" });
  // A custom id takes the host's session levels.
  assert.deepEqual(withModel("codex", codexCat, "my-model", "ultra"), { host: "codex", model: "my-model", effort: "ultra" });
});

test("modelRows: current models, older ones folded behind a count, and a search through all of them", () => {
  const folded = modelRows("claude", claudeCat, "opus", "", false);
  assert.deepEqual(folded.rows.map((r) => r.id), ["default", "opus", "haiku"]);
  assert.deepEqual(folded.rows.map((r) => r.selected), [false, true, false]);
  assert.equal(folded.olderCount, 2);
  assert.equal(folded.foldable, true);
  assert.deepEqual(modelRows("claude", claudeCat, "opus", "", true).rows.map((r) => r.id), ["default", "opus", "haiku", "claude-opus-4-6", "claude-haiku-4-5-20251001"]);
  const found = modelRows("claude", claudeCat, "opus", "haiku", false);
  assert.deepEqual(found.rows.map((r) => r.id), ["haiku", "claude-haiku-4-5-20251001"]);
  assert.equal(found.foldable, false);
  assert.deepEqual(modelRows("claude", claudeCat, "opus", "nothing like it", false).rows, []);
});

test("modelRows: Claude's null model is its default; a custom id or Codex's own default leads the list, checked", () => {
  assert.equal(modelRows("claude", claudeCat, null, "", false).rows.find((r) => r.selected)?.id, "default");
  const custom = modelRows("codex", codexCat, "my-model", "", false).rows[0];
  assert.deepEqual(custom, { id: "my-model", name: "my-model", description: "Custom model id", selected: true, custom: true, tag: null });
  const own = modelRows("codex", codexDown, null, "", false);
  assert.deepEqual(own.rows, [{ id: null, name: "Codex default", description: "Codex's own default model", selected: true, custom: true, tag: null }]);
  assert.equal(own.foldable, false);
  // Claude's aliases when the host never answered: "default" still has a row.
  assert.equal(modelRows("claude", null, "default", "", false).rows[0].name, "Default");
  // A search that misses the custom row leaves it out.
  assert.deepEqual(modelRows("codex", codexCat, "my-model", "astra", false).rows.map((r) => r.id), ["gpt-6-astra"]);
});

test("modelRows: an older model chosen through the search keeps its checked row once the search is cleared", () => {
  const folded = modelRows("claude", claudeCat, "claude-opus-4-6", "", false);
  assert.deepEqual(folded.rows.map((r) => r.id), ["default", "opus", "haiku", "claude-opus-4-6"]);
  assert.equal(folded.rows.find((r) => r.selected)?.id, "claude-opus-4-6");
  assert.equal(folded.olderCount, 2);
  assert.equal(folded.foldable, true);
  // Unfolded, it sits among the older ones, once.
  assert.deepEqual(modelRows("claude", claudeCat, "claude-opus-4-6", "", true).rows.map((r) => r.id), ["default", "opus", "haiku", "claude-opus-4-6", "claude-haiku-4-5-20251001"]);
});

test("modelRows: Codex's configured model is tagged your default; a thread's earlier model used so far", () => {
  const fresh = modelRows("codex", codexCat, "gpt-6-astra", "", false);
  assert.deepEqual(fresh.rows.map((r) => [r.id, r.tag]), [["gpt-6-astra", null], ["gpt-6-sol", "your default"]]);
  // Claude has no configured model to tag.
  assert.deepEqual(modelRows("claude", claudeCat, "opus", "", false).rows.map((r) => r.tag), [null, null, null]);
  // A thread that ran on Sol, with Astra picked for the next turn.
  const thread = modelRows("codex", codexCat, "gpt-6-astra", "", false, "gpt-6-sol");
  assert.deepEqual(thread.rows.map((r) => [r.id, r.tag]), [["gpt-6-astra", null], ["gpt-6-sol", "your default · used so far"]]);
  // The model it ran on and still picked: no used-so-far tag.
  assert.deepEqual(modelRows("codex", codexCat, "gpt-6-sol", "", false, "gpt-6-sol").rows.map((r) => r.tag), [null, "your default"]);
  // An older model it ran on stays shown while the fold is shut; Claude's null is its default.
  const olderUsed = modelRows("codex", codexCat, "gpt-6-astra", "", false, "gpt-5.6-terra");
  assert.deepEqual(olderUsed.rows.map((r) => [r.id, r.tag]), [["gpt-6-astra", null], ["gpt-6-sol", "your default"], ["gpt-5.6-terra", "used so far"]]);
  assert.equal(modelRows("claude", claudeCat, "opus", "", false, null).rows.find((r) => r.tag)?.id, "default");
  // No used model given: no row is tagged used so far.
  assert.equal(modelRows("claude", claudeCat, "opus", "", false).rows.some((r) => r.tag), false);
});

test("hostOffLine: how to turn an off host on without turning the other off; a host that is not logged in says so", () => {
  assert.equal(hostOffLine(CLAUDE_ONLY[0]), null);
  // The other host is on: --host codex alone would turn Claude Code off.
  assert.equal(hostOffLine(CLAUDE_ONLY[1], CLAUDE_ONLY), "Codex is off on this Mac: aos init --host both turns it on");
  const codexOnly: HostChoice[] = [{ host: "claude", label: "Claude Code", ready: false, reason: "Claude Code is off on this machine" }, ready("codex")];
  assert.equal(hostOffLine(codexOnly[0], codexOnly), "Claude Code is off on this Mac: aos init --host both turns it on");
  // On but not logged in still counts as on.
  assert.equal(hostOffLine(NONE[1], NONE), "Codex is off on this Mac: aos init --host both turns it on");
  // No other host on (or none given): that host alone.
  const allOff: HostChoice[] = [codexOnly[0], CLAUDE_ONLY[1]];
  assert.equal(hostOffLine(allOff[1], allOff), "Codex is off on this Mac: aos init --host codex turns it on");
  assert.equal(hostOffLine(CLAUDE_ONLY[1]), "Codex is off on this Mac: aos init --host codex turns it on");
  assert.equal(hostOffLine(NONE[0], NONE), "Claude Code is not logged in");
});

test("noHostLine: the init commands only when every host is off", () => {
  const allOff: HostChoice[] = [
    { host: "claude", label: "Claude Code", ready: false, reason: "Claude Code is off on this machine" },
    { host: "codex", label: "Codex", ready: false, reason: "Codex is off on this machine" },
  ];
  assert.match(noHostLine(allOff), /aos init --host claude or aos init --host codex/);
  assert.equal(noHostLine(NONE), "No host is ready on this Mac.");
});

test("effortNote: Codex names its configured level; Claude has none", () => {
  assert.equal(effortNote("codex", codexCat), "Your Codex default: High");
  assert.equal(effortNote("codex", codexDown), "");
  assert.equal(effortNote("claude", claudeCat), "");
});

test("customModelError: refuses an empty id, a leading dash and anything the settings would not keep", () => {
  assert.equal(customModelError("  "), "Type a model id.");
  assert.equal(customModelError("--model"), "A model id cannot start with a dash.");
  assert.match(customModelError("two words") ?? "", /one word/);
  assert.match(customModelError("x".repeat(81)) ?? "", /80 characters/);
  assert.equal(customModelError(" claude-opus-5-5[1m] "), null);
  assert.equal(customModelError("gpt-5.6-terra"), null);
});
