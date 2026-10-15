import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HostChild, HostSpawnOptions } from "../host";
import {
  runClaudeAsk, buildClaudeArgs, claudeChatModel, composePrompt, parseClaudeJson, headlessEnv, resolveClaudeBin, chatRoute, ClaudeAskDeps, CHAT_SYSTEM_PROMPT,
  ALIAS_REASON, aliasCatalog, readReasonSpendToday, reasonSpendToday, vaultAsked, vaultHostChoices, vaultModeLine, vaultRemembered, vaultSpendLine, vaultStart,
  vaultEngine, vaultRoute, localDownOf, localDownText, runOnceLabel,
} from "./claudeAsk";
import { DEFAULT_SETTINGS } from "../settingsDefaults";

function fakeChild(stdout: string, code = 0, stderr = ""): HostChild {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });
  return child as unknown as HostChild;
}

/** A child whose "close" fires (with code null, as a real killed process reports) only when
 *  kill() is called — never on its own, unlike fakeChild's setImmediate. Models the headless
 *  claude process while a user cancel is in flight. */
function cancelableChild(): HostChild {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setImmediate(() => child.emit("close", null)); return true; };
  return child as unknown as HostChild;
}

const CLAUDE_JSON = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "**Answer** from context",
  total_cost_usd: 0.0034, usage: { input_tokens: 1505, output_tokens: 185 }, duration_api_ms: 2911,
});

function harness(children: HostChild[]) {
  const calls: Array<{ file: string; args: string[]; cwd?: string; env?: HostSpawnOptions["env"]; unsetEnv?: string[] }> = [];
  const ledger: string[] = [];
  const deps: ClaudeAskDeps = {
    spawn: (file, args, opts = {}) => { calls.push({ file, args, cwd: opts.cwd, env: opts.env, unsetEnv: opts.unsetEnv }); return children.shift()!; },
    appendFileSync: (_p, s) => { ledger.push(s); },
  };
  return { calls, ledger, deps };
}

const OPTS = { vault: "/tmp/v", node: "/usr/bin/node", claudeBin: "/bin/claude", question: "what did I decide?", model: "haiku", maxBudgetUsd: 0.05 };

test("runClaudeAsk: recall context first, then the exact headless recipe; usd surfaces; spend is ledgered", async () => {
  const h = harness([fakeChild("hit one\nhit two\n"), fakeChild(CLAUDE_JSON)]);
  const r = await runClaudeAsk(OPTS, h.deps).result;
  assert.equal(h.calls[0].file, "/usr/bin/node");
  assert.match(h.calls[0].args[0], /brain\/scripts\/sdk\/recall-cli\.js$/);
  assert.equal(h.calls[0].args[1], "what did I decide?");
  const c = h.calls[1];
  assert.equal(c.file, "/bin/claude");
  assert.equal(c.cwd, "/tmp/v");
  assert.equal(c.env?.AOS_HEADLESS, "1");
  assert.deepEqual(c.unsetEnv, ["CLAUDECODE"]);
  assert.equal(c.args[0], "-p");
  assert.match(c.args[1], /CONTEXT \(recall hits from the vault\):\nhit one\nhit two/);
  assert.match(c.args[1], /QUESTION: what did I decide\?$/);
  for (const pair of [["--model", "haiku"], ["--tools", ""], ["--setting-sources", ""], ["--max-budget-usd", "0.05"], ["--output-format", "json"]]) {
    const i = c.args.indexOf(pair[0]);
    assert.ok(i > 0, `missing ${pair[0]}`);
    assert.equal(c.args[i + 1], pair[1]);
  }
  assert.ok(c.args.includes("--strict-mcp-config") && c.args.includes("--no-session-persistence") && c.args.includes("--system-prompt"));
  assert.equal(r.ok, true);
  assert.equal(r.answer, "**Answer** from context");
  assert.equal(r.usd, 0.0034);
  assert.equal(r.runId, null);
  const row = JSON.parse(h.ledger[0]);
  assert.equal(row.feature, "reason:chat", "chat is a reasoner call: its rows belong to the reasoner cap");
  assert.equal(row.provider, "claude");
  assert.equal(row.usd, 0.0034);
  assert.equal(row.inputTokens, 1505);
  assert.ok(!c.args.includes("--effort"), "no effort given → no flag");
});

test("effort and feature: a valid effort becomes --effort after --model; the feature labels the ledger row", async () => {
  const h = harness([fakeChild(""), fakeChild(CLAUDE_JSON)]);
  await runClaudeAsk({ ...OPTS, model: "claude-opus-5", maxBudgetUsd: 0.5, effort: "high", feature: "reason:chat" }, h.deps).result;
  const c = h.calls[1];
  assert.deepEqual(c.args.slice(2, 6), ["--model", "claude-opus-5", "--effort", "high"]);
  assert.equal(JSON.parse(h.ledger[0]).model, "claude-opus-5");
  for (const bad of ["minimal", "ultra", "", undefined]) {
    assert.ok(!buildClaudeArgs({ prompt: "p", model: "m", maxBudgetUsd: 1, effort: bad }).includes("--effort"), `effort=${String(bad)}`);
  }
});

test("buildClaudeArgs: every level claude --effort takes, in the chat surface's argv order", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(buildClaudeArgs({ prompt: "P", model: "opus", maxBudgetUsd: 0.5, effort }), [
      "-p", "P", "--model", "opus", "--effort", effort, "--tools", "", "--setting-sources", "", "--strict-mcp-config",
      "--no-session-persistence", "--system-prompt", CHAT_SYSTEM_PROMPT, "--max-budget-usd", "0.5", "--output-format", "json",
    ]);
  }
});

test("claudeChatModel: a menu pick wins; default or none is the reasoner's; an id the surface would refuse is null", () => {
  assert.equal(claudeChatModel("sonnet", "haiku"), "sonnet");
  assert.equal(claudeChatModel("claude-opus-5", "haiku"), "claude-opus-5");
  for (const none of [undefined, "", "default"]) assert.equal(claudeChatModel(none, "haiku"), "haiku", `chosen=${String(none)}`);
  for (const bad of ["-x", "--tools", "two words"]) assert.equal(claudeChatModel(bad, "haiku"), null, `chosen=${bad}`);
  assert.equal(claudeChatModel("default", ""), null, "no reasoner model either");
});

test("runClaudeAsk: the chosen model runs and is ledgered; default falls back to the reasoner; a bad id spawns nothing", async () => {
  const picked = harness([fakeChild(""), fakeChild(CLAUDE_JSON)]);
  await runClaudeAsk({ ...OPTS, chosenModel: "sonnet", effort: "xhigh" }, picked.deps).result;
  assert.deepEqual(picked.calls[1].args.slice(2, 6), ["--model", "sonnet", "--effort", "xhigh"]);
  assert.equal(JSON.parse(picked.ledger[0]).model, "sonnet");

  const dflt = harness([fakeChild(""), fakeChild(CLAUDE_JSON)]);
  await runClaudeAsk({ ...OPTS, chosenModel: "default" }, dflt.deps).result;
  assert.deepEqual(dflt.calls[1].args.slice(2, 4), ["--model", "haiku"]);

  const bad = harness([]);
  const r = await runClaudeAsk({ ...OPTS, chosenModel: "-x" }, bad.deps).result;
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Not a model id/);
  assert.equal(bad.calls.length, 0);
  assert.equal(bad.ledger.length, 0);
});

test("chatRoute: claude when the scripts saw a login or resolved claude; local for Ollama alone; none otherwise", () => {
  const base = { checkedAt: "", reason: "" };
  assert.equal(chatRoute(null), "none");
  assert.equal(chatRoute({ ...base, name: "none" }), "none");
  assert.equal(chatRoute({ ...base, name: "ollama" }), "local");
  assert.equal(chatRoute({ ...base, name: "ollama", claude: { loggedIn: false, checkedAt: "" } }), "local");
  assert.equal(chatRoute({ ...base, name: "ollama", claude: { loggedIn: true, checkedAt: "" } }), "claude", "Ollama up but the reasoner is a Claude model");
  assert.equal(chatRoute({ ...base, name: "claude" }), "claude");
  assert.equal(chatRoute({ ...base, name: "codex" }), "local", "Codex-only: the script path, where the reasoner falls back to Codex");
});

test("a failed recall still asks, with no CONTEXT block", async () => {
  const h = harness([fakeChild("", 1, "recall index missing"), fakeChild(CLAUDE_JSON)]);
  const r = await runClaudeAsk(OPTS, h.deps).result;
  assert.equal(r.ok, true);
  assert.equal(h.calls[1].args[1], "QUESTION: what did I decide?");
});

test("a non-zero claude exit surfaces the last stderr line, not 'exit N'", async () => {
  const h = harness([fakeChild(""), fakeChild("", 1, "Invalid API key\nNot logged in · Please run /login\n")]);
  const r = await runClaudeAsk(OPTS, h.deps).result;
  assert.equal(r.ok, false);
  assert.equal(r.error, "Not logged in · Please run /login");
  assert.equal(h.ledger.length, 0);
});

test("parseClaudeJson tolerates non-JSON and reads is_error", () => {
  assert.equal(parseClaudeJson("not json"), null);
  const p = parseClaudeJson(JSON.stringify({ result: "x", is_error: true, total_cost_usd: 0.01, usage: {} }));
  assert.equal(p?.isError, true);
  assert.equal(p?.usd, 0.01);
  assert.equal(p?.inputTokens, 0);
});

test("composePrompt caps the context at 12k chars; buildClaudeArgs emits the recipe order; headlessEnv guards recursion", () => {
  const big = "x".repeat(20_000);
  assert.equal(composePrompt("q", big).length, 12_000 + "CONTEXT (recall hits from the vault):\n".length + "\n\nQUESTION: q".length);
  const args = buildClaudeArgs({ prompt: "P", model: "haiku", maxBudgetUsd: 0.02 });
  assert.deepEqual(args.slice(0, 4), ["-p", "P", "--model", "haiku"]);
  assert.deepEqual(headlessEnv(), { env: { AOS_HEADLESS: "1" }, unsetEnv: ["CLAUDECODE"] });
});

test("a BILLED failure is ledgered anyway (contract §3, claude-cli.js:114) and still reports the error", async () => {
  const BILLED_ERROR = JSON.stringify({
    type: "result", subtype: "error_max_budget", is_error: true, result: "Budget exceeded",
    total_cost_usd: 0.05, usage: { input_tokens: 900, output_tokens: 12 }, duration_api_ms: 1200,
  });
  const h = harness([fakeChild(""), fakeChild(BILLED_ERROR)]);
  const r = await runClaudeAsk(OPTS, h.deps).result;
  assert.equal(r.ok, false);
  assert.equal(r.error, "Budget exceeded");
  assert.equal(h.ledger.length, 1, "the spend happened, so the daily cap must see it");
  const row = JSON.parse(h.ledger[0]);
  assert.equal(row.feature, "reason:chat");
  assert.equal(row.provider, "claude");
  assert.equal(row.usd, 0.05);
  assert.equal(row.inputTokens, 900);
});

test("resolveClaudeBin prefers agenticos.json claude.bin, then provider-state, then ~/.local/bin/claude, then the bare name", () => {
  const state = () => ({ checkedAt: "", name: "claude" as const, reason: "", claude: { loggedIn: true, checkedAt: "", bin: "/opt/claude" } });
  const d0 = { readAgenticosJson: () => ({ claude: { bin: "/cfg/claude" } }), readProviderState: state, existsSync: (p: string) => p === "/cfg/claude" || p === "/opt/claude", homedir: () => "/home/alice" };
  assert.equal(resolveClaudeBin("/v", d0), "/cfg/claude");
  const d1 = { readAgenticosJson: () => ({ claude: { bin: "/cfg/gone" } }), readProviderState: state, existsSync: (p: string) => p === "/opt/claude", homedir: () => "/home/alice" };
  assert.equal(resolveClaudeBin("/v", d1), "/opt/claude", "a recorded path that is gone falls through (contract §2)");
  const d2 = { readAgenticosJson: () => null, readProviderState: () => null, existsSync: (p: string) => p === "/home/alice/.local/bin/claude", homedir: () => "/home/alice" };
  assert.equal(resolveClaudeBin("/v", d2), "/home/alice/.local/bin/claude");
  const d3 = { readAgenticosJson: () => null, readProviderState: () => null, existsSync: () => false, homedir: () => "/home/alice" };
  assert.equal(resolveClaudeBin("/v", d3), "claude");
});

test('a user cancel under claude reports "cancelled", never "exit null"', async () => {
  const h = harness([fakeChild(""), cancelableChild()]);
  const handle = runClaudeAsk(OPTS, h.deps);
  while (h.calls.length < 2) await new Promise((r) => setImmediate(r));
  handle.cancel();
  const r = await handle.result;
  assert.equal(r.ok, false);
  assert.equal(r.error, "cancelled");
  assert.equal(h.ledger.length, 0);
});

// ── Vault chat's host and model menu (spec 2026-10-07-sessions-ux U9) ──

const BOTH = { hosts: { claude: { enabled: true }, codex: { enabled: true } } };
const ps = (name: "claude" | "codex" | "ollama" | "none", claude?: boolean, codex?: boolean) => ({
  checkedAt: "", name, reason: "",
  ...(claude === undefined ? {} : { claude: { loggedIn: claude, checkedAt: "" } }),
  ...(codex === undefined ? {} : { codex: { loggedIn: codex, checkedAt: "" } }),
});

test("vaultHostChoices: Claude needs the login chatRoute checks; Codex is the composer's choice", () => {
  const ready = (c: ReturnType<typeof vaultHostChoices>) => c.map((x) => `${x.host}:${x.ready ? "ready" : x.reason}`);
  assert.deepEqual(ready(vaultHostChoices(BOTH, ps("claude"))), ["claude:ready", "codex:ready"]);
  assert.deepEqual(ready(vaultHostChoices(BOTH, ps("ollama", true, false))), ["claude:ready", "codex:Codex is not logged in"]);
  assert.deepEqual(ready(vaultHostChoices(BOTH, ps("ollama"))), ["claude:Claude Code is not logged in", "codex:ready"],
    "a login no probe confirmed is not enough for claude -p");
  assert.deepEqual(ready(vaultHostChoices({ hosts: { codex: { enabled: true } } }, ps("claude", true))), ["claude:Claude Code is off on this machine", "codex:ready"]);
  assert.deepEqual(ready(vaultHostChoices(null, ps("codex", false))), ["claude:Claude Code is not logged in", "codex:Codex is off on this machine"]);
});

test("aliasCatalog: Claude's aliases at Vault's levels, Codex's own default, both marked as a short list", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const c = aliasCatalog(now);
  assert.equal(c.fetchedAt, now.toISOString());
  assert.deepEqual(c.hosts.claude!.models.map((m) => m.id), ["default", "opus", "fable", "sonnet", "haiku"]);
  assert.ok(c.hosts.claude!.models.every((m) => m.main && m.efforts.join() === "low,medium,high,xhigh,max"));
  assert.deepEqual(c.hosts.codex!.models, []);
  assert.equal(c.hosts.claude!.ok, false);
  assert.equal(c.hosts.codex!.reason, ALIAS_REASON);
  assert.equal(aliasCatalog(now, "why").hosts.claude!.reason, "why");
  c.hosts.claude!.models[0].efforts.push("ultra");
  assert.equal(aliasCatalog(now).hosts.claude!.models[0].efforts.length, 5, "each call is a fresh copy");
});

test("vaultRemembered: the stored pick, else the reasoner's; a model the host's list dropped is forgotten", () => {
  const reasoner = { effort: "high", codexModel: "gpt-x" };
  const empty = DEFAULT_SETTINGS.vaultChoice;
  assert.deepEqual(vaultRemembered(empty, null, reasoner), { claude: { model: null, effort: "high" }, codex: { model: "gpt-x", effort: null } });
  assert.deepEqual(vaultRemembered(empty, null, { effort: "turbo", codexModel: null }).claude, { model: null, effort: null }, "a level claude -p does not take");

  const stored = { host: "codex" as const, models: { claude: "opus", codex: "gpt-old" }, efforts: { claude: "max", codex: "low" } };
  const answered = {
    schema: 1 as const, fetchedAt: "",
    hosts: {
      claude: { ok: true, version: "2", fetchedAt: "", defaultModel: null, defaultEffort: null, models: [{ id: "opus", name: "Opus", description: "", efforts: ["low"], main: true }], commands: [] },
      codex: { ok: true, version: "1", fetchedAt: "", defaultModel: "gpt-new", defaultEffort: "high", models: [{ id: "gpt-new", name: "GPT new", description: "", efforts: ["low"], main: true }], commands: [] },
    },
  };
  assert.deepEqual(vaultRemembered(stored, answered, reasoner), { claude: { model: "opus", effort: "max" }, codex: { model: null, effort: "low" } });
  // A host that did not answer keeps the id: its short list proves nothing.
  assert.deepEqual(vaultRemembered(stored, aliasCatalog(new Date()), reasoner).codex, { model: "gpt-old", effort: "low" });
});

test("vaultStart: a pick made in the menu is kept as it is, a custom id included; else the stored host's remembered choice", () => {
  const answered = {
    schema: 1 as const, fetchedAt: "",
    hosts: {
      claude: { ok: true, version: "2", fetchedAt: "", defaultModel: null, defaultEffort: null, models: [{ id: "opus", name: "Opus", description: "", efforts: ["low"], main: true }], commands: [] },
      codex: { ok: true, version: "1", fetchedAt: "", defaultModel: "gpt-new", defaultEffort: "high", models: [], commands: [] },
    },
  };
  const reasoner = { effort: "high", codexModel: null };
  // The user typed an id the catalog never lists, and it was stored; a refresh brings an answered catalog.
  const stored = { host: "claude" as const, models: { claude: "claude-sonnet-4-5-20250929", codex: null }, efforts: { claude: "high", codex: null } };
  const remembered = vaultRemembered(stored, answered, reasoner);
  assert.equal(remembered.claude.model, null, "the stored id alone is dropped by an answered list");
  const pick = { host: "claude" as const, model: "claude-sonnet-4-5-20250929", effort: "high" };
  assert.deepEqual(vaultStart(pick, stored, remembered), { value: pick, chosen: true }, "the pick made this session survives the refresh");
  // No pick yet: the stored host with what the list still has.
  assert.deepEqual(vaultStart(null, stored, remembered), { value: { host: "claude", model: null, effort: "high" }, chosen: true });
  // Nothing stored and nothing picked: no host was chosen.
  const none = DEFAULT_SETTINGS.vaultChoice;
  assert.deepEqual(vaultStart(null, none, vaultRemembered(none, null, reasoner)), { value: { host: null, model: null, effort: null }, chosen: false });
});

test("vaultAsked: a Codex nobody chose is not named (ask.js keeps its fallback); a chosen host, or Claude, runs as the chip says", () => {
  const codex = { host: "codex" as const, model: null, effort: "medium" };
  const claude = { host: "claude" as const, model: "default", effort: "medium" };
  assert.deepEqual(vaultAsked(codex, false), { host: null, model: null, effort: null });
  assert.deepEqual(vaultAsked(codex, true), codex);
  assert.deepEqual(vaultAsked(claude, false), claude);
  assert.deepEqual(vaultAsked(claude, true), claude);
  assert.deepEqual(vaultAsked({ host: null, model: null, effort: null }, true), { host: null, model: null, effort: null });
});

test("vaultModeLine names the menu's host and model, else today's route", () => {
  const o = { reasonerModel: "claude-opus-5", route: "claude" as const, provider: "claude" };
  assert.equal(vaultModeLine("claude", null, o), " · Claude Code (claude-opus-5, capped)");
  assert.equal(vaultModeLine("claude", "Sonnet", o), " · Claude Code (Sonnet, capped)");
  assert.equal(vaultModeLine("codex", "GPT-6-Luna", o), " · Codex via ask.js (GPT-6-Luna, reasoner caps)");
  assert.equal(vaultModeLine("codex", null, o), " · Codex via ask.js (Codex default, reasoner caps)");
  assert.equal(vaultModeLine(null, null, o), " · claude (claude-opus-5, capped)");
  assert.equal(vaultModeLine(null, null, { ...o, route: "local", provider: "codex" }), " · codex via ask.js (reasoner caps)");
  assert.equal(vaultModeLine(null, null, { ...o, route: "local", provider: "ollama" }), " · local ask.js");
});

const row = (ts: string, feature: string, usd: number) => JSON.stringify({ ts, feature, provider: "claude", model: "m", usd });

test("reasonSpendToday sums today's reason:* rows on the local day, skipping other families and torn lines", () => {
  const now = new Date(2026, 9, 7, 15, 0, 0);
  const at = (h: number, d = 7) => new Date(2026, 9, d, h, 30).toISOString();
  const text = [
    row(at(9, 6), "reason:chat", 1), row(at(9), "reason:chat", 0.1), row(at(10), "reason:ask", 0.02),
    row(at(11), "session:turn", 3), row(at(12), "chat", 0.5), "{torn", "", row(at(13), "reason:chat", 0.0034),
  ].join("\n");
  assert.equal(reasonSpendToday(text, now), 0.1234);
  assert.equal(reasonSpendToday("", now), 0);
});

test("readReasonSpendToday reads the ledger's tail; 0 without one, null when the tail starts inside today", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-vault-spend-"));
  const now = new Date(2026, 9, 7, 15, 0, 0);
  assert.equal(readReasonSpendToday(vault, now), 0);
  const ledger = path.join(vault, "brain", "_index", "provider-spend.jsonl");
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const old = row(new Date(2026, 9, 6, 9).toISOString(), "reason:chat", 9);
  const today = row(new Date(2026, 9, 7, 9).toISOString(), "reason:chat", 0.25);
  fs.writeFileSync(ledger, `${old}\n${old}\n${today}\n${today}\n`);
  assert.equal(readReasonSpendToday(vault, now), 0.5);
  const tail = Buffer.byteLength(`${old}\n${today}\n${today}\n`) + 3;
  assert.equal(readReasonSpendToday(vault, now, tail), 0.5, "the tail opens on yesterday: today is whole");
  assert.equal(readReasonSpendToday(vault, now, Buffer.byteLength(`${today}\n`) + 3), null, "the tail opens inside today");
  fs.rmSync(vault, { recursive: true, force: true });
});

test("vaultSpendLine: today's spend against the reasoner cap, or nothing", () => {
  assert.equal(vaultSpendLine(0.12, 5), "Vault today $0.12 of $5 (reasoner cap)");
  assert.equal(vaultSpendLine(0.0034, 0.5), "Vault today $0.0034 of $0.50 (reasoner cap)");
  assert.equal(vaultSpendLine(0, 5), "Vault today $0.00 of $5 (reasoner cap)");
  assert.equal(vaultSpendLine(null, 5), null);
  assert.equal(vaultSpendLine(1, 0), null);
});

// ── local-first A2, A3, A17: Vault chat on the local engine ──

test("vaultEngine and vaultRoute: provider local with ai.chat local is the local engine, even signed in; host follows the logins", () => {
  const local = { provider: "local", ai: { chat: "local" } };
  const host = { provider: "local", ai: { chat: "host" } };
  assert.equal(vaultEngine(local), "local");
  assert.equal(vaultEngine({ provider: "local" }), "local", "local is the default");
  assert.equal(vaultEngine(host), "host");
  assert.equal(vaultEngine({ provider: "auto", ai: { chat: "local" } }), "host", "other providers ignore ai.chat");
  assert.equal(vaultRoute(ps("claude", true), local), "engine");
  // The engine down: provider-state's name is none, the hosts' logins still say who is signed in.
  const down = { ...ps("none", true, true), localReason: "local-down" };
  assert.equal(vaultRoute(down, host), "claude");
  assert.equal(vaultRoute({ ...ps("none", false, true), localReason: "local-down" }, host), "local", "Codex through ask.js --chat");
  assert.equal(vaultRoute(ps("none", false, false), host), "none");
  assert.equal(vaultRoute(ps("claude", true), { provider: "auto" }), chatRoute(ps("claude", true)), "elsewhere chatRoute decides");
});

test("vaultHostChoices under provider local: Claude ready by its login, whatever the background provider is", () => {
  const ready = (c: ReturnType<typeof vaultHostChoices>) => c.map((x) => `${x.host}:${x.ready ? "ready" : x.reason}`);
  const down = { ...ps("none", true, true), localReason: "local-down" };
  assert.deepEqual(ready(vaultHostChoices(BOTH, down, { local: true })), ["claude:ready", "codex:ready"]);
  assert.deepEqual(ready(vaultHostChoices(BOTH, down)), ["claude:Claude Code is not logged in", "codex:ready"], "elsewhere as before");
});

test("localDownOf, localDownText and runOnceLabel: the answer that failed, what to do, and the cap a host would count against", () => {
  assert.equal(localDownOf("[ask] the local model cannot answer (local-down): start Ollama (or your local engine); or run once…"), "local-down");
  assert.equal(localDownOf("the local model cannot answer (local-model-missing): pull the model"), "local-model-missing");
  assert.equal(localDownOf("claude did not answer"), null);
  assert.match(localDownText("local-down") ?? "", /not answering: start Ollama/);
  assert.match(localDownText("local-model-missing") ?? "", /Pull the model/);
  assert.equal(localDownText("local-ready"), null);
  assert.equal(runOnceLabel("Claude Code", 0.12, 5), "Run once on Claude Code (reasoner cap: today $0.12 of $5)");
  assert.equal(runOnceLabel("Codex", null, 2.5), "Run once on Codex (reasoner cap: $2.50)");
  assert.equal(runOnceLabel("Codex", 0, 0), "Run once on Codex (no reasoner spend allowed)");
});

test("vaultModeLine on the local engine names the model and no spend; a host picked for the question names that host", () => {
  const o = { reasonerModel: "claude-opus-5", route: "engine" as const, provider: "local", localModel: "qwen3.5:9b" };
  assert.equal(vaultModeLine(null, null, o), " · This Mac (qwen3.5:9b, no spend)");
  assert.equal(vaultModeLine(null, null, { ...o, localModel: null }), " · This Mac (the local model, no spend)");
  assert.equal(vaultModeLine("claude", null, o), " · Claude Code (claude-opus-5, capped)");
  assert.equal(vaultModeLine(null, null, { ...o, route: "local" }), " · codex via ask.js (reasoner caps)");
});
