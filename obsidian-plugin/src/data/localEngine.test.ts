import { test } from "node:test";
import assert from "node:assert/strict";
import { localEngineView, localUrl, sameModel, todayText, usageToday } from "./localEngine";
import { VAULT_CONFIG_DEFAULTS, type ProviderState } from "./aosConfig";

const cfg = (over: Partial<typeof VAULT_CONFIG_DEFAULTS.local> = {}, provider = "local") =>
  ({ provider, ollama: VAULT_CONFIG_DEFAULTS.ollama, local: { ...VAULT_CONFIG_DEFAULTS.local, ...over } }) as Parameters<typeof localEngineView>[0];
const state = (o: Partial<ProviderState>): ProviderState => ({ checkedAt: "", name: "ollama", reason: "local-ready", ...o });
const URL = "http://127.0.0.1:11434";

test("localUrl: local.url, else Ollama's address, else LM Studio's for an OpenAI-compatible server", () => {
  assert.equal(localUrl(cfg()), URL);
  assert.equal(localUrl(cfg({ url: "http://127.0.0.1:11500/" })), "http://127.0.0.1:11500");
  assert.equal(localUrl(cfg({ engine: "openai" })), "http://127.0.0.1:1234/v1");
});

test("the engine answering with the model: its name, downloaded, the embedder known; today's calls", () => {
  const v = localEngineView(cfg(), state({ model: "qwen3.5:9b", localReason: "local-ready", local: { url: URL, reachable: true, models: ["qwen3.5:9b"] } }), { calls: 3, ms: 4200 }, 0);
  assert.deepEqual([v.active, v.state, v.model, v.pulled, v.embedderPulled, v.canPull], [true, "answering", "qwen3.5:9b", true, false, true]);
  assert.equal(v.modelNote, "picked for this Mac's memory · downloaded");
  assert.equal(v.stateText, `Ollama answers at ${URL}.`);
  assert.equal(todayText(v.today), "3 local calls today · 4 s");
});

test("down, not downloaded, not checked; another provider; an OpenAI-compatible server cannot pull", () => {
  const down = localEngineView(cfg(), state({ name: "none", reason: "local-down", localReason: "local-down", local: { url: URL, reachable: false, models: [] } }), { calls: 0, ms: 0 }, 2);
  assert.deepEqual([down.state, down.queued], ["down", 2]);
  assert.match(down.stateText, /not answering at http:\/\/127\.0\.0\.1:11434/);
  const missing = localEngineView(cfg({ model: "qwen3.5:4b" }), state({ name: "none", localReason: "local-model-missing", local: { url: URL, reachable: true, models: ["llama3.2"] } }), { calls: 0, ms: 0 }, 0);
  assert.deepEqual([missing.state, missing.model, missing.pulled, missing.modelNote], ["missing", "qwen3.5:4b", false, "set in local.model · not downloaded"]);
  const none = localEngineView(cfg(), null, { calls: 0, ms: 0 }, 0);
  assert.deepEqual([none.state, none.model], ["unknown", null]);
  const auto = localEngineView(cfg({}, "auto"), state({ name: "ollama", model: "qwen3.5:9b" }), { calls: 0, ms: 0 }, 0);
  assert.equal(auto.active, false);
  assert.match(auto.stateText, /^Background work runs on auto/);
  assert.equal(localEngineView(cfg({ engine: "openai" }), null, { calls: 0, ms: 0 }, 0).canPull, false);
});

test("usageToday and sameModel", () => {
  const now = new Date(2026, 9, 15, 10);
  assert.deepEqual(usageToday(JSON.stringify({ days: { "2026-10-15": { calls: 5, ms: 900 }, "2026-10-14": { calls: 9 } } }), now), { calls: 5, ms: 900 });
  assert.deepEqual(usageToday("not json", now), { calls: 0, ms: 0 });
  assert.deepEqual(usageToday(null, now), { calls: 0, ms: 0 });
  assert.equal(sameModel("llama3.2", "llama3.2:latest"), true);
  assert.equal(sameModel("qwen3.5:9b", "qwen3.5:4b"), false);
});
