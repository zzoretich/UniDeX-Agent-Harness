// Chat with its write surface on (AOS_APP_WRITE=chat). Chat writes two files itself: every turn goes into the chat log
// (brain/_index/agentic-os-chat.jsonl, which the tab reads and rewrites whole), and a billed headless Claude call adds a
// row to the spend ledger (brain/_index/provider-spend.jsonl). It runs recall-cli.js and `claude -p` on the Claude
// route, or ask.js --local on the other one (claudeAsk.ts chatRoute); when a host is ready for Vault, its host and
// model menu picks the question's host, model and effort instead (SE13). No model is ever called: `claude` and `codex` are
// stubs that record their calls (harness installChatStubs), and the vault's Ollama is a stub server on a random port
// that answers only the Chat question. The provider is forced to that Ollama, as on a machine where Ollama is up, and
// each test puts the login caches the runtime publishes in provider-state.json (Claude's decides the route).

import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { buildAskArgs } from "../../../hud/src/data/askSpawner";
import { buildClaudeArgs, composePrompt, SPEND_LEDGER_PATH } from "../../../hud/src/data/claudeAsk";
import {
  CLAUDE_ANSWER, CODEX_ANSWER, FX, USER_DATA, appEnv, chatReply, claudeCalls, codexCalls, content, expectNoErrors, guardWrites, installChatStubs,
  openTab, providerState, useApp,
} from "./harness";

// ── the Ollama stand-in ──────────────────────────────────────────────

interface OllamaChat { model: string; messages: Array<{ role: string; content: string }> }
const ASK_SYSTEM = "You are the user's second-brain assistant.";
const OLLAMA_ANSWER = "The **tide tables**, per `brain/memory/projects/harbor-map.md`.";
const ollama = { port: 0, asks: [] as OllamaChat[], server: null as http.Server | null };

// Registered before useApp, so the port is known when its prepare writes agenticos.json.
test.beforeAll(async () => {
  ollama.server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      let j: OllamaChat | null = null;
      try { j = JSON.parse(body) as OllamaChat; } catch { /* not JSON */ }
      // Only ask.js's question is answered; anything else the runtime asks for finds Ollama unavailable.
      const ask = req.url === "/api/chat" && !!j && String(j.messages?.[0]?.content ?? "").startsWith(ASK_SYSTEM);
      if (ask) ollama.asks.push(j!);
      res.writeHead(ask ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ask ? { model: j!.model, message: { role: "assistant", content: OLLAMA_ANSWER }, done: true } : { error: "fixture: only the Chat question is answered" }));
    });
  });
  await new Promise<void>((resolve) => ollama.server!.listen(0, "127.0.0.1", resolve));
  ollama.port = (ollama.server.address() as AddressInfo).port;
});
test.afterAll(async () => { await new Promise<void>((resolve) => (ollama.server ? ollama.server.close(() => resolve()) : resolve())); });

const app = useApp({
  // CLAUDECODE as when the app is started from a Claude Code terminal: headless calls must not inherit it.
  env: { AOS_APP_WRITE: "chat", CLAUDECODE: "1" },
  prepare: () => {
    installChatStubs();
    const file = path.join(FX.claude, "agenticos.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    Object.assign(j, { provider: "ollama", ollama: { host: "127.0.0.1", port: ollama.port } });
    fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
    providerState("ollama", { claude: true, codex: false });
  },
});

// ── helpers ──────────────────────────────────────────────────────────

const CHAT_LOG = FX.v("brain/_index/agentic-os-chat.jsonl");
const LEDGER = FX.v(SPEND_LEDGER_PATH);
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const linesAfter = (file: string, before: string) => read(file).slice(before.length).split("\n").filter(Boolean);

const C = (win: Page) => content(win);
const input = (win: Page) => C(win).locator("textarea.aos-asst-input");
const mode = (win: Page) => C(win).locator(".aos-asst-mode");
/** The finished turns (the in-flight one is `.aos-asst-live`). */
const turns = (win: Page) => C(win).locator(".aos-asst-log .aos-asst-turn:not(.aos-asst-live)");

async function ask(win: Page, q: string): Promise<void> {
  await input(win).fill(q);
  await C(win).locator(".aos-asst-actions button", { hasText: "Send (⌘↵)" }).click();
}

/** The two lines a question and its answer add to the chat log, once both are there; the rest of the log is untouched. */
async function newTurns(before: string): Promise<[string, string]> {
  await expect.poll(() => linesAfter(CHAT_LOG, before).length, { timeout: 60_000 }).toBe(2);
  expect(read(CHAT_LOG).startsWith(before)).toBe(true);
  const [q, a] = linesAfter(CHAT_LOG, before);
  expect(read(CHAT_LOG)).toBe(`${before}${q}\n${a}\n`);
  return [q, a];
}

/** The question's line, in ChatTab's shape. */
function expectQuestion(line: string, q: string, since: number): void {
  const e = JSON.parse(line) as { ts: number };
  expect(line).toBe(JSON.stringify({ ts: e.ts, role: "user", text: q }));
  expect(e.ts).toBeGreaterThanOrEqual(since);
}

/** What recall-cli.js prints for the question, as the tab runs it (the recall block of the prompt). */
function recall(q: string): string {
  const r = spawnSync(path.join(FX.root, "bin", "node"), [FX.v("brain/scripts/sdk/recall-cli.js"), q], { cwd: FX.vault, env: { ...appEnv(), AOS_VAULT: FX.vault }, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

/** Opens Chat again, so it re-reads the provider state (as switching back to the tab does). */
async function reopen(win: Page): Promise<void> {
  await openTab(win, "pulse");
  await openTab(win, "chat");
}

/** The HUD's saved settings: the app keeps the plugin's data.json as <userData>/plugins/agentic-os.json. */
function savedSettings(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(path.join(USER_DATA, "plugins", "agentic-os.json"), "utf8")) as Record<string, any>; } catch { return {}; }
}

test.beforeEach(async () => { await openTab(app().win, "chat"); });

test.afterEach(async () => {
  // Chat's writes and spawns all ran; the next test starts from the Claude route and the stub's default answer.
  expectNoErrors(app());
  expect(await guardWrites(app())).toEqual([]);
  expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
  chatReply(null);
  providerState("ollama", { claude: true, codex: false });
});

// ── tests ────────────────────────────────────────────────────────────

test("Chat is the one surface on: the status bar names it and what it may write and run", async () => {
  const mode = app().win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Chat");
  await expect(mode).toHaveAttribute("title", /^Chat: brain\/_index\/agentic-os-chat\.jsonl, brain\/_index\/provider-spend\.jsonl, sdk\/recall-cli\.js, sdk\/ask\.js, claude\n/);
});

test("claude (CH4): recall, then one capped headless call; the answer with its cost, two log lines and one spend row", async () => {
  const { win } = app();
  await expect(mode(win)).toHaveText(" · Claude Code (claude-opus-5, capped)");
  const log0 = read(CHAT_LOG), ledger0 = read(LEDGER), calls0 = claudeCalls().length, t0 = Date.now();
  const q = "What comes first on the harbor map?";
  await ask(win, q);

  const [ql, al] = await newTurns(log0);
  expectQuestion(ql, q, t0);
  const a = JSON.parse(al) as { ts: number; elapsedMs: number };
  expect(al).toBe(JSON.stringify({ ts: a.ts, role: "assistant", text: CLAUDE_ANSWER.text, elapsedMs: a.elapsedMs, usd: CLAUDE_ANSWER.usd }));

  // One call: data/claudeAsk.ts's recipe over the recall hits, from the vault, headless and outside any Claude Code session.
  const calls = claudeCalls().slice(calls0);
  expect(calls).toHaveLength(1);
  const context = recall(q);
  expect(context).toContain(q);
  expect(calls[0].argv).toEqual(buildClaudeArgs({ prompt: composePrompt(q, context), model: "claude-opus-5", maxBudgetUsd: 0.5, effort: "medium" }));
  expect(calls[0]).toMatchObject({ cwd: fs.realpathSync(FX.vault), env: { AOS_HEADLESS: "1", CLAUDECODE: null } });

  // The billed call's row, in the runtime's ledger shape, timed like the turn.
  expect(read(LEDGER).startsWith(ledger0)).toBe(true);
  const rows = linesAfter(LEDGER, ledger0);
  expect(rows).toHaveLength(1);
  const row = JSON.parse(rows[0]) as { ts: string };
  expect(rows[0]).toBe(JSON.stringify({
    ts: row.ts, feature: "reason:chat", provider: "claude", model: "claude-opus-5", usd: CLAUDE_ANSWER.usd,
    inputTokens: CLAUDE_ANSWER.inputTokens, outputTokens: CLAUDE_ANSWER.outputTokens, ms: a.elapsedMs,
  }));

  // The tab: the question, then the answer rendered as Markdown with its time and cost; the composer is free again.
  await expect(turns(win).nth(-2).locator(".aos-asst-body")).toHaveText(q);
  const last = turns(win).last();
  await expect(last.locator(".aos-asst-body strong")).toHaveText("Tide tables");
  await expect(last.locator(".aos-asst-meta")).toHaveText(`${(a.elapsedMs / 1000).toFixed(1)}s · $0.0123`);
  await expect(input(win)).toBeEnabled();
  await expect(input(win)).toHaveValue("");
});

test("a question typed as a bullet is still a question: recall runs, and its hits reach the prompt", async () => {
  const { win } = app();
  const log0 = read(CHAT_LOG), calls0 = claudeCalls().length;
  const q = "- what comes first on the harbor map?";
  await ask(win, q);
  await newTurns(log0);
  const context = recall(q);
  expect(context).toContain(q);
  const calls = claudeCalls().slice(calls0);
  expect(calls).toHaveLength(1);
  expect(calls[0].argv[1]).toBe(composePrompt(q, context));
  expect(calls[0].argv[1]).toMatch(/^CONTEXT \(recall hits from the vault\):\n/);
});

test("the log is read back: a draft survives a tab switch, another HUD's turn shows on return and survives ⌘↵", async () => {
  const { win } = app();
  await input(win).fill("half a thought");
  await reopen(win);
  await expect(input(win)).toHaveValue("half a thought");

  // A turn the other HUD logged while this one was open: shown once the tab re-reads the log.
  const now = Date.now();
  fs.appendFileSync(CHAT_LOG, `${JSON.stringify({ ts: now, role: "user", text: "Asked in the other HUD" })}\n${JSON.stringify({ ts: now + 1, role: "assistant", text: "Answered there.", elapsedMs: 1200 })}\n`);
  const log0 = read(CHAT_LOG);
  await reopen(win);
  await expect(turns(win).filter({ hasText: "Asked in the other HUD" })).toHaveCount(1);
  await expect(turns(win).last().locator(".aos-asst-meta")).toHaveText("1.2s");

  // ⌘↵ sends. Each write re-reads the log, so the other HUD's lines stay.
  const q = "And after the tide tables?";
  await input(win).fill(q);
  await input(win).press("Meta+Enter");
  const [ql] = await newTurns(log0);
  expectQuestion(ql, q, now);
  await expect(turns(win).last().locator(".aos-asst-body strong")).toHaveText("Tide tables");
});

test("a failed call that still cost something shows the error and records its spend", async () => {
  const { win } = app();
  chatReply({
    stdout: JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.5, usage: { input_tokens: 900, output_tokens: 2100 } }),
    stderr: "Error: Exceeded USD budget (0.5)\n", code: 1,
  });
  const log0 = read(CHAT_LOG), ledger0 = read(LEDGER), t0 = Date.now();
  await ask(win, "Summarise every workspace in detail");
  const [ql, al] = await newTurns(log0);
  expectQuestion(ql, "Summarise every workspace in detail", t0);
  const a = JSON.parse(al) as { ts: number };
  expect(al).toBe(JSON.stringify({ ts: a.ts, role: "assistant", text: "", error: "Error: Exceeded USD budget (0.5)" }));
  const rows = linesAfter(LEDGER, ledger0);
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0])).toMatchObject({ feature: "reason:chat", provider: "claude", model: "claude-opus-5", usd: 0.5, inputTokens: 900, outputTokens: 2100 });
  await expect(turns(win).last().locator(".aos-asst-body .aos-text-rose")).toHaveText("Error: Exceeded USD budget (0.5)");
  await expect(turns(win).last().locator(".aos-asst-meta")).toHaveCount(0);
});

test("a call that cost nothing (not logged in) shows the CLI's message and records no spend", async () => {
  const { win } = app();
  chatReply({ stdout: "", stderr: "Not logged in · Please run /login\n", code: 1 });
  const log0 = read(CHAT_LOG), ledger0 = read(LEDGER);
  await ask(win, "Anything due today?");
  const [, al] = await newTurns(log0);
  expect(JSON.parse(al)).toEqual({ ts: expect.any(Number), role: "assistant", text: "", error: "Not logged in · Please run /login" });
  expect(read(LEDGER)).toBe(ledger0);
  await expect(turns(win).last().locator(".aos-asst-body .aos-text-rose")).toHaveText("Not logged in · Please run /login");
});

test("Cancel ends a call in flight: the turn says cancelled and nothing is billed", async () => {
  const { win } = app();
  chatReply({ delayMs: 60_000 });
  const log0 = read(CHAT_LOG), ledger0 = read(LEDGER), calls0 = claudeCalls().length;
  await ask(win, "Take your time");
  const live = C(win).locator(".aos-asst-live");
  // The Claude route has no telemetry run, so no live events either.
  await expect(live.locator(".aos-asst-run-meta")).toHaveText("(no run id — events may be unavailable)");
  await expect(live.locator(".aos-asst-timeline")).toContainText("no run id from telemetry — answer still incoming");
  await expect(input(win)).toBeDisabled();
  await expect(C(win).locator(".aos-asst-actions button")).toHaveText("…");
  await expect.poll(() => claudeCalls().length).toBe(calls0 + 1);
  await live.locator("button.aos-asst-cancel").click();
  const [, al] = await newTurns(log0);
  expect(JSON.parse(al)).toEqual({ ts: expect.any(Number), role: "assistant", text: "", error: "cancelled" });
  expect(read(LEDGER)).toBe(ledger0);
  await expect(live).toHaveCount(0);
  await expect(turns(win).last().locator(".aos-asst-body .aos-text-rose")).toHaveText("cancelled");
  await expect(input(win)).toBeEnabled();
});

test("ollama without a Claude login (CH3): ask.js --local, spawned by a relative path, answers from the local model; nothing billed", async () => {
  const { win } = app();
  providerState("ollama", { claude: false, codex: false });
  await reopen(win);
  await expect(mode(win)).toHaveText(" · local ask.js");
  const log0 = read(CHAT_LOG), ledger0 = read(LEDGER), asks0 = ollama.asks.length, claude0 = claudeCalls().length, codex0 = codexCalls().length, t0 = Date.now();
  const q = "Which workspace is the harbor map in?";
  await ask(win, q);

  const [ql, al] = await newTurns(log0);
  expectQuestion(ql, q, t0);
  const a = JSON.parse(al) as { ts: number; elapsedMs: number };
  // ask.js prints the answer; a local answer carries no cost.
  expect(al).toBe(JSON.stringify({ ts: a.ts, role: "assistant", text: OLLAMA_ANSWER, elapsedMs: a.elapsedMs }));

  // The runtime asked the local model once, with the vault context and the question; no CLI ran and no row was added.
  const asks = ollama.asks.slice(asks0);
  expect(asks).toHaveLength(1);
  expect(asks[0].messages.at(-1)).toEqual({ role: "user", content: q });
  expect(claudeCalls()).toHaveLength(claude0);
  expect(codexCalls()).toHaveLength(codex0);
  expect(read(LEDGER)).toBe(ledger0);

  const last = turns(win).last();
  await expect(last.locator(".aos-asst-body strong")).toHaveText("tide tables");
  await expect(last.locator(".aos-asst-meta")).toHaveText(`${(a.elapsedMs / 1000).toFixed(1)}s`);
});

/** One question answered by the reasoner's Codex fallback: the answer, the one `codex exec`, and the runtime's spend row. */
async function askCodex(win: Page, q: string): Promise<void> {
  const log0 = read(CHAT_LOG), ledger0 = read(LEDGER), asks0 = ollama.asks.length, claude0 = claudeCalls().length, codex0 = codexCalls().length, t0 = Date.now();
  await ask(win, q);
  const [ql, al] = await newTurns(log0);
  expectQuestion(ql, q, t0);
  const a = JSON.parse(al) as { ts: number; elapsedMs: number };
  expect(al).toBe(JSON.stringify({ ts: a.ts, role: "assistant", text: CODEX_ANSWER.text, elapsedMs: a.elapsedMs }));

  const calls = codexCalls().slice(codex0);
  expect(calls).toHaveLength(1);
  expect(calls[0].argv.slice(0, 9)).toEqual(["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-c", "features.hooks=false", "--json", "-o"]);
  expect(calls[0].argv).toContain('model_reasoning_effort="medium"');
  expect(calls[0].stdin.startsWith(ASK_SYSTEM)).toBe(true);
  expect(calls[0].stdin.endsWith(q)).toBe(true);
  expect(ollama.asks).toHaveLength(asks0);
  expect(claudeCalls()).toHaveLength(claude0);

  // The row is ask.js's own (the runtime's codex-cli.js), not the tab's: the tab ledgers only its Claude route.
  const rows = linesAfter(LEDGER, ledger0);
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0])).toMatchObject({ feature: "reason:ask", provider: "codex", usd: expect.any(Number), inputTokens: CODEX_ANSWER.inputTokens, outputTokens: CODEX_ANSWER.outputTokens });
  await expect(turns(win).last().locator(".aos-asst-body strong")).toHaveText("next");
}

test("codex (CH1): the header names Codex via ask.js; Codex answers and the runtime records the spend row", async () => {
  const { win } = app();
  providerState("codex", { claude: false, codex: true });
  await reopen(win);
  await expect(mode(win)).toHaveText(" · codex via ask.js (reasoner caps)");
  await askCodex(win, "What is next on the harbor map?");
});

test("Ollama up, a Codex login and no Claude: the header says local ask.js, yet Codex answers and bills (finding 19)", async () => {
  const { win } = app();
  providerState("ollama", { claude: false, codex: true });
  await reopen(win);
  await expect(mode(win)).toHaveText(" · local ask.js");
  await askCodex(win, "Is the harbor map next?");
});

test("with only Chat on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});

// ── Vault chat's host and model menu (spec 2026-10-07-sessions-ux U9) ──

test("SE13 Vault chat's picker: a fixed Read only chip; a question on Claude passes --model and --effort to claude -p, one on Codex runs ask.js on that host with its model and effort", async () => {
  test.setTimeout(150_000);
  const { win } = app();
  // Codex as a Vault host too: on in agenticos.json, with a login on record. Put back at the end.
  const agenticos = path.join(FX.claude, "agenticos.json");
  const saved = fs.readFileSync(agenticos, "utf8");
  const cfg = JSON.parse(saved) as { hosts: { codex: { enabled: boolean } } };
  cfg.hosts.codex.enabled = true;
  fs.writeFileSync(agenticos, `${JSON.stringify(cfg, null, 2)}\n`);
  providerState("ollama", { claude: true, codex: true });
  const tools = C(win).locator(".aos-asst-composer .aos-asst-bar .aos-asst-tools");
  const menu = tools.locator('.aos-hm[data-mode="vault"]');
  const chip = menu.locator(".aos-hm-trigger");
  const pop = menu.locator(".aos-hm-pop");
  const ids = (sel: string, attr: string) => pop.locator(sel).evaluateAll((els, a) => els.map((e) => e.getAttribute(a)), attr);
  const close = async () => {
    await pop.locator(".aos-hm-search").press("Escape");
    await expect(pop).toHaveCount(0);
    await expect(chip).toBeFocused();
  };
  try {
    await reopen(win);
    // Read only, fixed: a Vault question never changes files, so there is no menu to open.
    const fixed = tools.locator('.aos-am[data-access="read"] .aos-am-trigger');
    await expect(fixed).toHaveClass(/is-fixed/);
    await expect(fixed).toHaveText("Read only");
    await expect(fixed).toHaveAttribute("title", "Vault questions never change files");
    await expect(tools.locator("button.aos-am-trigger")).toHaveCount(0);
    await expect(C(win).locator(".aos-asst-actions button")).toHaveText("Send (⌘↵)");
    await expect(C(win).locator(".aos-asst-foot")).toContainText("Each question can use any host");
    await expect(C(win).locator(".aos-asst-foot .aos-asst-spend")).toHaveText(/^Vault today \$\d+\.\d{2,4} of \$\d+(\.\d+)? \(reasoner cap\)$/);
    await expect(chip.locator(".aos-hm-chiphost")).toHaveText("Claude Code");
    await expect(chip.locator(".aos-hm-chiprest")).toHaveText("· Default · Medium");
    await expect(mode(win)).toHaveText(" · Claude Code (claude-opus-5, capped)");

    // Claude: Sonnet at High. With only Chat on, the menu offers the aliases, and says why its list is short.
    await chip.click();
    await expect(pop.locator(".aos-hm-host")).toHaveText(["Claude Code", "Codex"]);
    await expect(pop.locator(".aos-hm-source")).toHaveText("Only the aliases: the hosts' own lists are not available");
    await expect(pop.locator(".aos-hm-caption")).toHaveText("Each question can use any host");
    expect(await ids(".aos-hm-model", "data-model")).toEqual(["default", "opus", "fable", "sonnet", "haiku"]);
    await pop.locator('.aos-hm-model[data-model="sonnet"]').click();
    await expect.poll(() => ids(".aos-hm-effort", "data-effort")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    await pop.locator('.aos-hm-effort[data-effort="high"]').click();
    await close();
    await expect(chip.locator(".aos-hm-chiprest")).toHaveText("· Sonnet · High");
    await expect(mode(win)).toHaveText(" · Claude Code (Sonnet, capped)");
    // The pick is saved (U12): the host, and that host's model and effort. Back on the tab, the chip keeps it.
    await expect.poll(() => savedSettings().vaultChoice).toMatchObject({ host: "claude", models: { claude: "sonnet" }, efforts: { claude: "high" } });
    await reopen(win);
    await expect(chip.locator(".aos-hm-chiphost")).toHaveText("Claude Code");
    await expect(chip.locator(".aos-hm-chiprest")).toHaveText("· Sonnet · High");
    await expect(mode(win)).toHaveText(" · Claude Code (Sonnet, capped)");

    const log0 = read(CHAT_LOG), ledger0 = read(LEDGER), claude0 = claudeCalls().length, codex0 = codexCalls().length;
    const q = "Which tide tables come first?";
    chatReply({ delayMs: 1500 });
    await ask(win, q);
    await expect(chip).toBeDisabled();   // no other pick while a question runs
    await newTurns(log0);
    chatReply(null);
    await expect(chip).toBeEnabled();
    const calls = claudeCalls().slice(claude0);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(buildClaudeArgs({ prompt: composePrompt(q, recall(q)), model: "sonnet", maxBudgetUsd: 0.5, effort: "high" }));
    expect(codexCalls()).toHaveLength(codex0);
    const rows = linesAfter(LEDGER, ledger0);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0])).toMatchObject({ feature: "reason:chat", provider: "claude", model: "sonnet" });

    // Codex: its own default first, then a model id typed in, at High; the levels are the ones ask.js passes on.
    await chip.click();
    await pop.locator('.aos-hm-host[data-host="codex"]').click();
    await expect(pop.locator('.aos-hm-host[data-host="codex"]')).toHaveAttribute("aria-pressed", "true");
    await expect(mode(win)).toHaveText(" · Codex via ask.js (Codex default, reasoner caps)");
    await expect(pop.locator(".aos-hm-efforttitle")).toHaveText("Reasoning");
    expect(await ids(".aos-hm-effort", "data-effort")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    await pop.locator(".aos-hm-custom").click();
    await pop.locator("input.aos-hm-custominput").fill("gpt-tide-3");
    await pop.locator(".aos-hm-customuse").click();
    await expect(pop.locator('.aos-hm-model.is-custom[data-model="gpt-tide-3"]')).toHaveAttribute("aria-selected", "true");
    await pop.locator('.aos-hm-effort[data-effort="high"]').click();
    await close();
    await expect(chip.locator(".aos-hm-chiphost")).toHaveText("Codex");
    await expect(chip.locator(".aos-hm-chiprest")).toHaveText("· gpt-tide-3 · High");
    await expect(mode(win)).toHaveText(" · Codex via ask.js (gpt-tide-3, reasoner caps)");
    await expect.poll(() => savedSettings().vaultChoice).toMatchObject({
      host: "codex", models: { claude: "sonnet", codex: "gpt-tide-3" }, efforts: { claude: "high", codex: "high" },
    });
    await reopen(win);
    await expect(chip.locator(".aos-hm-chiphost")).toHaveText("Codex");
    await expect(chip.locator(".aos-hm-chiprest")).toHaveText("· gpt-tide-3 · High");

    const log1 = read(CHAT_LOG), ledger1 = read(LEDGER), asks1 = ollama.asks.length, claude1 = claudeCalls().length, codex1 = codexCalls().length, t1 = Date.now();
    const q2 = "What is next on the harbour chart?";
    await ask(win, q2);
    const [ql, al] = await newTurns(log1);
    expectQuestion(ql, q2, t1);
    expect(JSON.parse(al)).toMatchObject({ role: "assistant", text: CODEX_ANSWER.text });
    // The tab's spawn (askSpawner.ts), which the chat surface admitted (afterEach: no refused spawn): ask.js on Codex
    // only, the model and the effort as single arguments.
    expect(buildAskArgs({ question: q2, host: "codex", model: "gpt-tide-3", effort: "high" })).toEqual(["brain/scripts/sdk/ask.js", "--local", "--host=codex", "--model=gpt-tide-3", "--effort=high", q2]);
    // It reached `codex exec` with both, and Claude, logged in and first in the reasoner's order, was never asked.
    const cx = codexCalls().slice(codex1);
    expect(cx).toHaveLength(1);
    expect(cx[0].argv.slice(0, 9)).toEqual(["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-c", "features.hooks=false", "--json", "-o"]);
    expect(cx[0].argv.slice(cx[0].argv.indexOf("-m"), cx[0].argv.indexOf("-m") + 2)).toEqual(["-m", "gpt-tide-3"]);
    expect(cx[0].argv).toContain('model_reasoning_effort="high"');
    expect(cx[0].stdin.endsWith(q2)).toBe(true);
    expect(claudeCalls()).toHaveLength(claude1);
    expect(ollama.asks).toHaveLength(asks1);
    const rows2 = linesAfter(LEDGER, ledger1);
    expect(rows2).toHaveLength(1);
    expect(JSON.parse(rows2[0])).toMatchObject({ feature: "reason:ask", provider: "codex" });
    await expect(turns(win).last().locator(".aos-asst-body strong")).toHaveText("next");

    // Back to Claude Code: the switch starts from Claude's remembered Sonnet at High. Then its default, where the
    // other tests start.
    await chip.click();
    await pop.locator('.aos-hm-host[data-host="claude"]').click();
    await expect(chip.locator(".aos-hm-chiprest")).toHaveText("· Sonnet · High");
    await pop.locator('.aos-hm-model[data-model="default"]').click();
    await pop.locator('.aos-hm-effort[data-effort="medium"]').click();
    await close();
    await expect(chip.locator(".aos-hm-chiprest")).toHaveText("· Default · Medium");
  } finally {
    fs.writeFileSync(agenticos, saved);
  }
});
