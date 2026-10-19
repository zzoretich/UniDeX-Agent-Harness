// claudeAsk.ts — the Chat tab's headless Claude path (the reasoner role). Two spawns per question:
//   1. node <vault>/brain/scripts/sdk/recall-cli.js <question>   → recall hits (best-effort, 15 s)
//   2. claude -p <prompt> … the exact headless recipe from brain/scripts/sdk/lib/claude-cli.js
//      (--tools "" --setting-sources "" --strict-mcp-config --no-session-persistence
//       --system-prompt … --max-budget-usd <cap> --output-format json), cwd = vault,
//      env AOS_HEADLESS=1 and CLAUDECODE unset so the user's hooks never re-enter.
// Returns the same AskHandle shape as askSpawner.runAsk so ChatTab treats both alike.
// Each answered call appends the contract §3 spend row to brain/_index/provider-spend.jsonl
// (feature "reason:chat" by default: the reasoner cap's family) so `aos status` and the daily
// caps account for chat spend too. chatRoute() decides between this path and askSpawner.
// Vault chat's host and model menu (spec 2026-10-07-sessions-ux U9) reads its hosts, its starting choice, the alias
// list it falls back to and today's reasoner spend from the helpers at the end of this file.
import * as path from "path";
import { env, fs, spawn as hostSpawn, utf8, type HostCatalog, type HostCatalogHost, type HostChild, type HostSpawnOptions, type SpawnFn } from "../host";
import { lastStderrLine, type AskHandle, type AskResult } from "./askSpawner";
import { readAgenticosJson, readProviderState, AgenticosJson, ProviderState, type SessionHost } from "./aosConfig";
import { catalogHost, findModel, hostChoices, usdText, type HostChoice, type RememberedChoice } from "./agentSessions";
import type { VaultChoice } from "../settingsDefaults";

export interface ClaudeAskOptions {
  vault: string;
  node: string;          // Plugin.nodeBin()
  claudeBin: string;     // Plugin.claudeBin()
  question: string;
  model: string;         // readVaultConfig().reasoner.model
  chosenModel?: string;  // the model Vault chat's menu picked (spec U9); "default" or none → `model`
  maxBudgetUsd: number;  // readVaultConfig().reasoner.perCallUsd
  effort?: string;       // the menu's effort or readVaultConfig().reasoner.effort → --effort (one of EFFORTS; anything else is left off)
  feature?: string;      // ledger row feature, default "reason:chat"
  timeoutMs?: number;        // default 120 s
  recallTimeoutMs?: number;  // default 15 s
}

export interface ClaudeAskDeps {
  spawn: SpawnFn;
  appendFileSync: (p: string, s: string) => void;
}

const DEFAULT_DEPS: ClaudeAskDeps = {
  spawn: (file, args, opts) => hostSpawn(file, args, opts),
  appendFileSync: (p, s) => fs.appendFileSync(p, s),
};

export const CHAT_SYSTEM_PROMPT =
  "You answer questions about the user's AgenticOS vault. Use the CONTEXT block when it is relevant and say so when it is not. Answer in concise Markdown.";
const RECALL_CAP_CHARS = 12_000;
export const SPEND_LEDGER_PATH = "brain/_index/provider-spend.jsonl";

export function composePrompt(question: string, recallContext: string): string {
  const ctx = recallContext.trim().slice(0, RECALL_CAP_CHARS);
  return ctx ? `CONTEXT (recall hits from the vault):\n${ctx}\n\nQUESTION: ${question}` : `QUESTION: ${question}`;
}

/** The levels `claude --effort` takes, all of which the chat surface admits (spec 2026-10-07-sessions-ux U9). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const CHAT_FEATURE = "reason:chat";

/** One argument the chat surface reads as a model: no whitespace and no leading "-", so it can never pass for a flag. */
export const MODEL_ID_RE = /^[^\s-]\S*$/;

/**
 * The model `claude -p` runs for a menu pick. The catalog's "default" means "pass no --model", but this spawn rule
 * always names one, so it (or no pick) is the configured reasoner's; an id the surface would refuse is null.
 */
export function claudeChatModel(chosen: string | undefined, reasonerModel: string): string | null {
  const m = chosen === undefined || chosen === "" || chosen === "default" ? reasonerModel : chosen;
  return MODEL_ID_RE.test(m) ? m : null;
}

/**
 * Which spawner answers a Chat question. The reasoner is a Claude model, so headless Claude is
 * the route whenever the scripts' last probe found a login (the cache both resolvers share in
 * provider-state.json) or the global provider is claude; a reachable Ollama alone means the
 * script path, which falls back to the workhorse. No state at all is "none".
 */
export function chatRoute(state: ProviderState | null): "claude" | "local" | "none" {
  if (!state || state.name === "none") return "none";
  if (state.name === "claude" || state.claude?.loggedIn === true) return "claude";
  return "local";
}

/** What Vault chat runs on (local-first A2): `engine` is the local engine (ask.js --local --chat), the rest as chatRoute. */
export type VaultRoute = "engine" | "claude" | "local" | "none";
/** The config Vault chat's route reads: the background provider and ai.chat. */
export interface VaultRouteCfg { provider: string; ai?: { chat?: string } }

/** Where Vault chat runs: under provider local, ai.chat (local by default, the local engine) or a host; elsewhere a host. */
export function vaultEngine(cfg: VaultRouteCfg): "local" | "host" {
  return cfg.provider === "local" && cfg.ai?.chat !== "host" ? "local" : "host";
}

/**
 * The route a Vault question takes. Under provider local with ai.chat local it is the local engine, even when Claude is
 * signed in (local-first A2); with ai.chat host it follows the hosts' logins, never the background provider's state
 * (the local engine may be down: none in provider-state, a host still signed in). Any other provider: chatRoute.
 */
export function vaultRoute(state: ProviderState | null, cfg: VaultRouteCfg): VaultRoute {
  if (cfg.provider !== "local") return chatRoute(state);
  if (vaultEngine(cfg) === "local") return "engine";
  if (state?.claude?.loggedIn === true) return "claude";
  if (state?.codex?.loggedIn === true) return "local";
  return "none";
}

/** The local engine's reason in an answer that failed (ask.js: "the local model cannot answer (local-down): …"), or null. */
export function localDownOf(error: string | null | undefined): "local-down" | "local-model-missing" | null {
  const m = /local model cannot answer \((local-down|local-model-missing)\)/.exec(String(error ?? ""));
  return m ? (m[1] as "local-down" | "local-model-missing") : null;
}

/** Why the local engine cannot answer, as the menu and the composer say it; null while it can. */
export function localDownText(reason: string | null | undefined): string | null {
  if (reason === "local-down") return "The local model is not answering: start Ollama (or your local engine).";
  if (reason === "local-model-missing") return "The local model is not downloaded yet: Settings ▸ Local engine ▸ Pull the model.";
  return null;
}

/** "Run once on Claude Code (reasoner cap: today $0.12 of $5)" — the one-question offer when the local engine is down (A3). */
export function runOnceLabel(label: string, spent: number | null, cap: number): string {
  const capText = cap > 0 ? `reasoner cap: ${spent === null ? "" : `today ${usdText(spent)} of `}${Number.isInteger(cap) ? `$${cap}` : usdText(cap)}` : "no reasoner spend allowed";
  return `Run once on ${label} (${capText})`;
}

export function buildClaudeArgs(o: { prompt: string; model: string; maxBudgetUsd: number; effort?: string }): string[] {
  return [
    "-p", o.prompt,
    "--model", o.model,
    ...(o.effort && EFFORTS.includes(o.effort) ? ["--effort", o.effort] : []),
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--system-prompt", CHAT_SYSTEM_PROMPT,
    "--max-budget-usd", String(o.maxBudgetUsd),
    "--output-format", "json",
  ];
}

/** What a headless claude gets on top of the host's environment: AOS_HEADLESS=1, and no CLAUDECODE, so the user's hooks never re-enter. */
export function headlessEnv(): Pick<HostSpawnOptions, "env" | "unsetEnv"> {
  return { env: { AOS_HEADLESS: "1" }, unsetEnv: ["CLAUDECODE"] };
}

export interface ClaudeJsonResult { text: string; usd: number; inputTokens: number; outputTokens: number; isError: boolean }

export function parseClaudeJson(stdout: string): ClaudeJsonResult | null {
  try {
    const j = JSON.parse(stdout) as { result?: unknown; is_error?: unknown; total_cost_usd?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      text: typeof j.result === "string" ? j.result : "",
      usd: num(j.total_cost_usd),
      inputTokens: num(j.usage?.input_tokens),
      outputTokens: num(j.usage?.output_tokens),
      isError: j.is_error === true,
    };
  } catch { return null; }
}

interface Collected { code: number | null; stdout: string; stderr: string; killed: boolean }

function collect(child: HostChild, timeoutMs: number): Promise<Collected> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", killed = false, done = false;
    const finish = (c: Collected) => { if (!done) { done = true; clearTimeout(timer); resolve(c); } };
    const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch { /* ignore */ } }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish({ code: null, stdout, stderr: `${stderr}${e.message}`, killed }));
    child.on("close", (code) => finish({ code, stdout, stderr, killed }));
  });
}

export interface ClaudeBinDeps {
  readAgenticosJson: () => AgenticosJson | null;
  readProviderState: (v: string) => ProviderState | null;
  existsSync: (p: string) => boolean;
  homedir: () => string;
}

const DEFAULT_BIN_DEPS: ClaudeBinDeps = {
  readAgenticosJson: () => readAgenticosJson(),
  readProviderState,
  existsSync: (p) => fs.existsSync(p),
  homedir: () => env.homedir(),
};

/**
 * `deps` is a Partial so a caller can override one reader and keep the rest: main.ts supplies
 * `readAgenticosJson: () => readAgenticosJson(this.claudeConfigDir())` so the settings-level
 * config dir reaches the recorded claude.bin (Ruling A6); the tests supply all four.
 */
export function resolveClaudeBin(vaultRoot: string, deps: Partial<ClaudeBinDeps> = {}): string {
  const d: ClaudeBinDeps = { ...DEFAULT_BIN_DEPS, ...deps };
  // Contract §2: the path `aos init` recorded outranks every probe; a recorded path that is gone falls through.
  const recorded = d.readAgenticosJson()?.claude?.bin;
  if (recorded && d.existsSync(recorded)) return recorded;
  const fromState = d.readProviderState(vaultRoot)?.claude?.bin;
  if (fromState && d.existsSync(fromState)) return fromState;
  const local = path.join(d.homedir(), ".local", "bin", "claude");
  if (d.existsSync(local)) return local;
  return "claude";
}

export function runClaudeAsk(opts: ClaudeAskOptions, deps: ClaudeAskDeps = DEFAULT_DEPS): AskHandle {
  const start = Date.now();
  let cancelled = false;
  let current: HostChild | null = null;
  const fail = (error: string, extra: Partial<AskResult> = {}): AskResult =>
    ({ ok: false, runId: null, answer: "", stderr: "", elapsedMs: Date.now() - start, exitCode: null, error, ...extra });

  const model = claudeChatModel(opts.chosenModel, opts.model);

  const result = (async (): Promise<AskResult> => {
    if (model === null) return fail(`Not a model id: ${opts.chosenModel ?? opts.model}`);
    // 1. recall context (best-effort)
    let context = "";
    try {
      const rc = deps.spawn(opts.node, [path.join(opts.vault, "brain", "scripts", "sdk", "recall-cli.js"), opts.question],
        { cwd: opts.vault, env: { AOS_VAULT: opts.vault } });
      current = rc;
      const r = await collect(rc, opts.recallTimeoutMs ?? 15_000);
      if (r.code === 0) context = r.stdout;
    } catch { context = ""; }
    if (cancelled) return fail("cancelled");

    // 2. headless claude
    let child: HostChild;
    try {
      child = deps.spawn(opts.claudeBin,
        buildClaudeArgs({ prompt: composePrompt(opts.question, context), model, maxBudgetUsd: opts.maxBudgetUsd, effort: opts.effort }),
        { cwd: opts.vault, ...headlessEnv() });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    current = child;
    const r = await collect(child, opts.timeoutMs ?? 120_000);
    const elapsedMs = Date.now() - start;
    if (r.killed || cancelled) return fail(cancelled ? "cancelled" : "cancelled (timeout)", { stderr: r.stderr, exitCode: r.code, elapsedMs });

    const parsed = parseClaudeJson(r.stdout);

    // One contract §3 spend row per BILLED call, exactly like claude-cli.js:114 `if (usd > 0)
    // ledger();`. A failed result can still carry cost (subtype error_max_budget does), so the
    // failure path ledgers too — otherwise the scripts' claude.perDayUsd cap under-counts chat.
    // A cost-free failure (non-JSON, non-zero exit, "Not logged in") records nothing.
    const ledger = (): void => {
      if (!parsed) return;
      try {
        deps.appendFileSync(path.join(opts.vault, SPEND_LEDGER_PATH), JSON.stringify({
          ts: new Date().toISOString(), feature: opts.feature ?? CHAT_FEATURE, provider: "claude", model,
          usd: parsed.usd, inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, ms: elapsedMs,
        }) + "\n");
      } catch { /* ledger is best-effort */ }
    };

    if (r.code !== 0 || !parsed || parsed.isError) {
      if (parsed && parsed.usd > 0) ledger();
      const msg = lastStderrLine(r.stderr) || lastStderrLine(parsed?.text ?? "") || lastStderrLine(r.stdout) || `exit ${r.code}`;
      return { ok: false, runId: null, answer: parsed?.text ?? "", stderr: r.stderr, elapsedMs, exitCode: r.code, error: msg.slice(0, 400) };
    }

    ledger();

    return { ok: true, runId: null, answer: parsed.text.trim(), stderr: r.stderr, elapsedMs, exitCode: r.code, usd: parsed.usd };
  })();

  return {
    runIdPromise: Promise.resolve<string | null>(null),
    result,
    cancel: () => { cancelled = true; try { current?.kill("SIGKILL"); } catch { /* ignore */ } },
  };
}

// ── Vault chat's host and model menu (spec 2026-10-07-sessions-ux U9) ──

/**
 * The hosts a Vault question may go to: the composer's (on in agenticos.json, login not known missing), except that
 * Claude also needs the login this path checks (chatRoute), since `claude -p` without one answers nothing.
 */
export function vaultHostChoices(cfg: AgenticosJson | null, state: ProviderState | null, opts: { local?: boolean } = {}): HostChoice[] {
  // Under provider local the background provider may be none (the engine down) with Claude still signed in (A17).
  const claudeIn = opts.local ? state?.claude?.loggedIn === true : chatRoute(state) === "claude";
  return hostChoices(cfg, state).map((c) =>
    c.host === "claude" && c.ready && !claudeIn ? { ...c, ready: false, reason: `${c.label} is not logged in` } : c);
}

/** Why the menu shows only the aliases: the app's catalog was not there to ask. */
export const ALIAS_REASON = "Only the aliases: the hosts' own lists are not available";

/** The runtime's fallback (lib/host-catalog.js, spec U4) for a window without the catalog: Claude's aliases, which
 *  always resolve, and Codex's own default. */
export function aliasCatalog(now: Date, reason = ALIAS_REASON): HostCatalog {
  const at = now.toISOString();
  const entry = (models: HostCatalogHost["models"]): HostCatalogHost =>
    ({ ok: false, reason, version: null, fetchedAt: at, defaultModel: null, defaultEffort: null, models, commands: [] });
  const alias = (id: string, name: string, description: string) => ({ id, name, description, efforts: [...EFFORTS], main: true });
  return {
    schema: 1, fetchedAt: at,
    hosts: {
      claude: entry([
        alias("default", "Default", "The reasoner model"),
        alias("opus", "Opus", "The latest Opus"),
        alias("fable", "Fable", "The latest Fable"),
        alias("sonnet", "Sonnet", "The latest Sonnet"),
        alias("haiku", "Haiku", "The latest Haiku"),
      ]),
      codex: entry([]),
    },
  };
}

/**
 * Where each host's menu starts: the stored pick (settings' vaultChoice), else the reasoner's own (its Claude effort,
 * its Codex model). A model the host's answered list no longer has is dropped, so the host's default takes over;
 * defaultChoice then keeps the effort only when the model takes it.
 */
export function vaultRemembered(choice: VaultChoice, catalog: HostCatalog | null, reasoner: { effort: string; codexModel: string | null }): Record<SessionHost, RememberedChoice> {
  const one = (host: SessionHost, model: string | null, effort: string | null): RememberedChoice => {
    const entry = catalogHost(catalog, host);
    return { model: model && entry?.ok && !findModel(entry, model) ? null : model, effort };
  };
  return {
    claude: one("claude", choice.models.claude, choice.efforts.claude ?? (EFFORTS.includes(reasoner.effort) ? reasoner.effort : null)),
    codex: one("codex", choice.models.codex ?? reasoner.codexModel, choice.efforts.codex),
  };
}

/** A Vault question's host, model and effort (HostModelMenu's value; a null host is today's route). */
export interface VaultValue { host: SessionHost | null; model: string | null; effort: string | null }

/**
 * What Vault chat's menu starts from, and whether a host was chosen. A pick made in the menu this session is kept as it
 * is, through a catalog refresh too, so a custom id the catalog never lists stays (as SessionsTab keeps its draft);
 * else the stored host with its remembered model and effort. Only a chosen host is asked by name (U9: no fallback for
 * a host the user picked); without one the question takes today's route, with its provider fallback.
 */
export function vaultStart(pick: VaultValue | null, stored: VaultChoice, remembered: Record<SessionHost, RememberedChoice>): { value: VaultValue; chosen: boolean } {
  if (pick) return { value: pick, chosen: pick.host !== null };
  const host = stored.host;
  if (!host) return { value: { host: null, model: null, effort: null }, chosen: false };
  return { value: { host, model: remembered[host].model ?? null, effort: remembered[host].effort ?? null }, chosen: true };
}

/**
 * What a Vault question runs on, given the chip's value (menuValue) and whether its host was chosen (vaultStart).
 * Claude answers as the chip says either way: it is ready for Vault only with the login chatRoute needs, so claude -p
 * is today's route too, and it has no fallback to lose. Codex nobody chose is not named: ask.js --local keeps its
 * provider fallback, so a Codex login never checked does not fail a question Ollama would answer.
 */
export function vaultAsked(value: VaultValue, chosen: boolean): VaultValue {
  return chosen || value.host === "claude" ? value : { host: null, model: null, effort: null };
}

/**
 * The header's route line. A host from the menu names it and the model it runs: on Claude the configured reasoner for
 * `default`, capped per call; on Codex through ask.js, under the reasoner's caps. With no host ready the route is
 * today's: headless Claude, or ask.js under whichever provider the scripts resolved.
 */
export function vaultModeLine(host: SessionHost | null, modelLabel: string | null, o: { reasonerModel: string; route: VaultRoute; provider: string; localModel?: string | null }): string {
  if (host === "claude") return ` · Claude Code (${modelLabel || o.reasonerModel}, capped)`;
  if (host === "codex") return ` · Codex via ask.js (${modelLabel || "Codex default"}, reasoner caps)`;
  if (o.route === "engine") return ` · This Mac (${o.localModel || "the local model"}, no spend)`;
  if (o.route === "claude") return ` · claude (${o.reasonerModel}, capped)`;
  // Under provider local the script route is ai.chat host on Codex (vaultRoute).
  return o.provider === "codex" || o.provider === "local" ? " · codex via ask.js (reasoner caps)" : " · local ask.js";
}

const REASON_ROWS = /^reason:/;
const SPEND_TAIL_BYTES = 256 * 1024;

function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Today's (local calendar day) reasoner spend in ledger text: the reason:* rows reasoner.perDayUsd caps, as the
 *  runtime's spend-ledger.js reasonSpendToday counts them. Torn lines are skipped. */
export function reasonSpendToday(text: string, now: Date): number {
  const day = localDay(now);
  let sum = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: { ts?: unknown; feature?: unknown; usd?: unknown };
    try { r = JSON.parse(line) as typeof r; } catch { continue; }
    const t = new Date(typeof r.ts === "string" ? r.ts : NaN);
    if (Number.isNaN(t.getTime()) || localDay(t) !== day || !REASON_ROWS.test(String(r.feature ?? ""))) continue;
    sum += Number(r.usd) || 0;
  }
  return Math.round(sum * 1e6) / 1e6;
}

/**
 * Today's reasoner spend from the vault's ledger, read from its tail only (the ledger is append-only, so today is at
 * the end). 0 without a ledger; null when the tail starts inside today, since the sum would then be short.
 */
export function readReasonSpendToday(vault: string, now: Date, tailBytes = SPEND_TAIL_BYTES): number | null {
  const file = path.join(vault, SPEND_LEDGER_PATH);
  try {
    if (!fs.existsSync(file)) return 0;
    const size = fs.statSync(file).size;
    const from = Math.max(0, size - tailBytes);
    let text = utf8(fs.readBytesSync(file, from, size - from));
    if (from > 0) {
      text = text.slice(text.indexOf("\n") + 1);
      const first = text.split("\n").find((l) => l.trim());
      let ts: unknown;
      try { ts = first ? (JSON.parse(first) as { ts?: unknown }).ts : undefined; } catch { ts = undefined; }
      const t = new Date(typeof ts === "string" ? ts : NaN);
      if (Number.isNaN(t.getTime()) || localDay(t) === localDay(now)) return null;
    }
    return reasonSpendToday(text, now);
  } catch { return null; }
}

/** The composer's spend note: `Vault today $0.12 of $5 (reasoner cap)`; null when the spend is not known or there is no cap. */
export function vaultSpendLine(spent: number | null, cap: number): string | null {
  if (spent === null || !(cap > 0)) return null;
  return `Vault today ${usdText(spent)} of ${Number.isInteger(cap) ? `$${cap}` : usdText(cap)} (reasoner cap)`;
}
