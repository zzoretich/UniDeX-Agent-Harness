import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { createRequire } from "module";
import { VAULT_CONFIG_DEFAULTS, type ProviderState, type VaultConfig } from "./aosConfig";
import type { HostCatalog } from "../host";
import {
  CLAUDE_MODELS, codexModels, defaultEngine, dropPromptOnly, engineChoices, enginePill, localConfigured, modelChoices, parseWrites,
  pulledModels, writesText,
} from "./routineEngines";

const REPO = path.resolve(__dirname, "../../..");
const cfg = (over: Partial<VaultConfig> = {}): VaultConfig => ({ ...structuredClone(VAULT_CONFIG_DEFAULTS), ...over });
const at = "2026-10-15T09:00:00.000Z";
const localState = (models: string[], extra: Partial<ProviderState> = {}): ProviderState =>
  ({ checkedAt: at, name: "ollama", reason: "local-ready", localReason: "local-ready", model: "qwen3.5:9b", local: { engine: "ollama", url: "http://127.0.0.1:11434", reachable: true, models, checkedAt: at }, ...extra });

test("CLAUDE_MODELS is the runtime's list (lib/settings-schema.js)", () => {
  const S = createRequire(__filename)(path.join(REPO, "brain/scripts/lib/settings-schema.js")) as { CLAUDE_MODELS: string[] };
  assert.deepEqual(CLAUDE_MODELS, S.CLAUDE_MODELS);
});

test("localConfigured: provider local or ollama, or the runtime saw the engine answer", () => {
  assert.equal(localConfigured(cfg({ provider: "local" }), null), true);
  assert.equal(localConfigured(cfg({ provider: "ollama" }), null), true);
  assert.equal(localConfigured(cfg({ provider: "none" }), null), false);
  assert.equal(localConfigured(cfg({ provider: "auto" }), { checkedAt: at, name: "claude", reason: "x", ollama: { reachable: true, checkedAt: at } }), true);
  assert.equal(localConfigured(cfg({ provider: "auto" }), { checkedAt: at, name: "claude", reason: "x", local: { reachable: false } }), false);
});

// Host parity: Claude only, Codex only, both, and no host (the local engine alone).
test("engineChoices: Default, Local when set up, and only the enabled hosts; a routine's own engine is kept, marked", () => {
  const v = (c: { value: string }[]) => c.map((x) => x.value);
  assert.deepEqual(v(engineChoices(cfg({ provider: "none" }), null, ["claude"])), ["", "claude"]);
  assert.deepEqual(v(engineChoices(cfg({ provider: "none" }), null, ["codex"])), ["", "codex"]);
  assert.deepEqual(v(engineChoices(cfg({ provider: "local" }), null, ["claude", "codex"])), ["", "local", "claude", "codex"]);
  assert.deepEqual(v(engineChoices(cfg({ provider: "local" }), null, [])), ["", "local"]);
  assert.deepEqual(v(engineChoices(cfg({ provider: "none" }), null, [])), [""]);
  const kept = engineChoices(cfg({ provider: "none" }), null, ["codex"], "claude");
  assert.deepEqual(kept.map((c) => c.label), ["Default (routines.runner)", "Claude Code (not enabled here)", "Codex"]);
  assert.equal(engineChoices(cfg({ provider: "none" }), null, [], "local")[1].label, "Local · this Mac (not set up here)");
  assert.equal(defaultEngine(cfg({ provider: "local" }), null), "local");
  assert.equal(defaultEngine(cfg({ provider: "none" }), null), "");
});

test("modelChoices local: the pulled models from provider-state (embedders out), the resolved model named; never a probe", () => {
  const c = cfg({ provider: "local" });
  const st = localState(["qwen3.5:9b", "qwen3.5:4b", "qwen3-embedding:0.6b", "nomic-embed-text:latest"]);
  assert.deepEqual(pulledModels(c, st), ["qwen3.5:9b", "qwen3.5:4b"]);
  assert.deepEqual(modelChoices("local", c, st, null), [
    { value: "", label: "This Mac's model (qwen3.5:9b)" }, { value: "qwen3.5:9b", label: "qwen3.5:9b" }, { value: "qwen3.5:4b", label: "qwen3.5:4b" },
  ]);
  assert.deepEqual(modelChoices("local", c, st, null, "llama4:8b").at(-1), { value: "llama4:8b", label: "llama4:8b (not downloaded)" });
  // A cache for another address, or none: nothing listed, the current model kept as is.
  const other = localState(["qwen3.5:9b"], { local: { url: "http://127.0.0.1:9", reachable: true, models: ["qwen3.5:9b"] } });
  assert.equal(pulledModels(c, other), null);
  assert.deepEqual(modelChoices("local", c, null, null, "qwen3.5:4b"), [{ value: "", label: "This Mac's model (picked for its memory)" }, { value: "qwen3.5:4b", label: "qwen3.5:4b" }]);
});

test("modelChoices claude, codex and the default runner", () => {
  const c = cfg({ provider: "none" });
  const claude = modelChoices("claude", c, null, null);
  assert.deepEqual(claude[0], { value: "", label: "claude.model (haiku)" });
  assert.deepEqual(claude.slice(1).map((x) => x.value), CLAUDE_MODELS);
  assert.deepEqual(modelChoices("", c, null, null, "my-alias").at(-1), { value: "my-alias", label: "my-alias (not listed)" });
  const cat: HostCatalog = { schema: 1, fetchedAt: at, hosts: { codex: { ok: true, version: "0.158.0", fetchedAt: at, defaultModel: "gpt-6-sol", defaultEffort: "high", commands: [], models: [
    { id: "gpt-5.6-terra", name: "older", description: "", efforts: [], main: false },
    { id: "gpt-6-astra", name: "A", description: "", efforts: [], main: true },
    { id: "gpt-6-sol", name: "S", description: "", efforts: [], main: true },
  ] } } };
  assert.deepEqual(codexModels(cat), ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-terra"]);
  assert.deepEqual(codexModels(null), []);
  const codex = modelChoices("codex", c, null, cat);
  assert.deepEqual(codex.map((x) => x.value), ["", "gpt-6-astra", "gpt-6-sol", "gpt-5.6-terra"]);
  assert.equal(codex[0].label, "Codex's own default");
  const pinned = cfg({ provider: "none", routines: { ...VAULT_CONFIG_DEFAULTS.routines, codexModel: "gpt-6-sol" } });
  assert.equal(modelChoices("codex", pinned, null, null)[0].label, "routines.codexModel (gpt-6-sol)");
});

test("enginePill, dropPromptOnly and the writes text", () => {
  assert.deepEqual(enginePill({ engine: "local", model: "qwen3.5:4b" }), { text: "local", title: "engine: local · model qwen3.5:4b" });
  assert.deepEqual(enginePill({}), { text: "auto", title: "engine: routines.runner (auto)" });
  assert.deepEqual(dropPromptOnly({ engine: "local", maxTurns: 3, output: "notify", writes: ["a/"], model: "m" }, "duty"), { writes: ["a/"], model: "m" });
  assert.deepEqual(dropPromptOnly({ engine: "local", writes: ["a/"] }, "command"), {});
  assert.deepEqual(dropPromptOnly({ engine: "local" }, "prompt"), { engine: "local" });
  assert.equal(writesText(["notes/", "TODO.md"]), "notes/\nTODO.md");
  assert.deepEqual(parseWrites(" notes/ \n\nTODO.md\n"), ["notes/", "TODO.md"]);
  assert.equal(parseWrites("\n "), undefined);
});
