// The e2e harness: launches the built app against the synthetic fixture (scripts/make-fixture-vault.mjs) in an isolated
// environment, collects renderer and main-process errors, records what the app hands to the OS instead of letting it
// open anything, and closes the app cleanly.
//
// Fixture lifecycle: globalSetup generates tests/.fixture once per run and keeps a pristine copy in
// tests/.fixture/.pristine. Each spec file (useApp) restores vault/ and home/ from that copy before it launches, so a
// runtime refresh or an edit in one file never leaks into the next. Its dates are relative to the day it was built, so
// a run that crosses midnight builds it again before the next spec file (restoreFixture, fixtureForToday). The copy is restored to the same paths the
// generator used, because the runtime's caches (snapshot.json, agenticos.json, routine plists) hold absolute paths.
// close() returns only once nothing the app started is still running (the app's processes, below): a runtime refresh
// the app left running would otherwise go on writing into the fixture while the next spec file restores it.

import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { extender } from "./budget";

export const REPO = path.resolve(__dirname, "..", "..");
/** The HUD's version as the app reads it (boot.ts: ../hud/package.json), so a version bump needs no test edit. */
export const HUD_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, "..", "hud", "package.json"), "utf8")) as { version: string }).version;
const ROOT = process.env.AOS_E2E_FIXTURE ? path.resolve(process.env.AOS_E2E_FIXTURE) : path.join(REPO, "tests", ".fixture");

export const FX = {
  root: ROOT,
  vault: path.join(ROOT, "vault"),
  home: path.join(ROOT, "home"),
  claude: path.join(ROOT, "home", ".claude"),
  pristine: path.join(ROOT, ".pristine"),
  /** A path inside the vault. */
  v: (rel: string) => path.join(ROOT, "vault", rel),
};

// ── expected values the generator read back from the runtime ─────────

export interface ExpectedNotification { id: string; from: string; level: string; title: string; created: string; read: boolean; archived: boolean }
export interface Expected {
  generatedAt: string;
  today: string;
  vault: string;
  home: string;
  persona: string;
  todo: {
    open: number; overdue: number; today: number; upcoming: number; someday: number; badge: number; doneThisWeek: number; tags: string[];
    items: Record<"overdue" | "today" | "upcoming" | "someday", Array<[string, string | null, string | null, string | null]>>;
  };
  proposals: {
    pending: Array<{ name: string; slug: string; kind: string; surface?: string; target: string; confirmations?: number; lint?: number }>;
    ledger?: { approvalRate: number | null; acceptRate: number | null; days?: number; counts?: Record<string, number> };
    pages: string[];
    backlog: Array<{ filed: string; kind: string; slug: string }>;
  };
  notifications: { items: ExpectedNotification[]; unread: number; total: number; archived: number; unreadable: number; senders: string[] };
  config?: { settings: Array<{ key: string; source: string; value: unknown; default: unknown; section: string; readonly?: boolean }>; files: { machine: string; vault: string } };
  teams?: unknown;
  teamItems: Array<Record<string, unknown>>;
  runs: string[];
  snapshot: string;
  /**
   * The Brain hub (spec 2026-10-11-brain-hub D3, D11, D12), as the generator read it back from the runtime: the scan's
   * brain-hub.json (counts, batches newest first, duplicate pairs), `aos memory list --json` (every memory path, the
   * drafts, the archived and the unreviewed live ones) and Review's "Older than 30d" queue.
   */
  brain: ExpectedBrain;
  /** Sessions ▸ History (install-import B11): the digests the fixture writes for a Claude Code and a Codex session. */
  history: { digests: Record<"claude" | "codex", { id: string; title: string; summary: string }> };
  /** Skills ▸ MCP servers (install-import B6): the servers in each host's config, and the listing `aos import` wrote. */
  mcp: { claude: string; codex: string; both: string; remote: string; listed: Array<{ name: string; host: string; transport: string; command?: string; url?: string }> };
  /** The Connectors tab's caches (connectors-tab §4.2): the connectors the check named, the server needing sign-in, the
   *  built-in seen in use; what `aos mcp list` found and counted. */
  connectors: {
    failed: string; connected: string; needsAuth: string; builtin: string; checkedAt: string;
    rows: Array<{ host: string; name: string; kind: string; scope: string }>;
    usage: Array<{ host: string; name: string; builtin: boolean; calls: number; perTool: Record<string, number> }>;
  };
}

export interface ExpectedBrainBatch { key: string; session: string | null; title: string; host: string | null; lead: string | null; at: string; paths: string[] }
export interface ExpectedBrain {
  /** The sessions whose memories the fixture seeds: a Claude Code one, a Codex one, and one whose transcript is gone. */
  sessions: { claude: string; codex: string; pruned: string };
  /** The near-duplicate the fixture writes and the kept memory it repeats. */
  duplicate: [string, string];
  counts: {
    memories: number; byType: Record<string, number>; unreviewed: number; drafts: number; patterns: number; reflections: number;
    archived: number; superseded: number;
  };
  batches: ExpectedBrainBatch[];
  dups: Array<{ a: string; b: string; score: number }>;
  /** The feedback drafts' slugs. */
  drafts: string[];
  /** Review's "Older than 30d" queue: live, unreviewed, written more than 30 days before the fixture was generated. */
  older: string[];
  archived: string[];
  /** Every memory path, live or not. */
  memories: string[];
  /** The live memories with `reviewed: false`. */
  unreviewed: string[];

  // Bootstrap, Map and Health (spec 2026-10-11-brain-hub D17–D20, PR 3): what the fixture seeds for them, named once in
  // make-fixture-vault.mjs HUB_FIXTURE, and what the runtime made of it.
  /** The pinned feedback rule approved from a draft; its draft, left behind, is `leftover`. */
  pinned: string;
  leftover: string;
  /** The two active projects that look shipped: a version in the title, "released" in the index line. */
  shipped: { version: string; released: string };
  /** An active project whose index line says "merged" (never "looks shipped", D17). */
  merged: string;
  /** One memory per hygiene finding (`legacy` by its old source label). */
  legacy: Record<"session" | "in-session", string>;
  oldType: string;
  unindexed: string;
  misfiled: string;
  /** The MEMORY.md line to a file that is gone. */
  broken: string;
  ruleSession: string;
  /** The recall preview's two queries: one with hits, one with none. */
  recall: { hit: string; none: string };
  /** brain/_index/brain-sources.json as build-brain-md wrote it. */
  sources: ExpectedSources;
  /** brain/_index/brain-map.json as the scan wrote it from the fixture's graph. */
  map: ExpectedMap;
  /** brain-hub.json's `shipped`, `hygiene` and `clusters`. */
  looksShipped: Array<{ path: string; why: string }>;
  hygiene: { sources: Record<string, number>; oldType: string[]; noDescription: string[]; unindexed: string[]; misfiled: string[]; brokenIndex: string[]; leftoverDrafts: string[] };
  clusters: Array<{ paths: string[]; label: string }>;
  /** The usage log's first row, and the live memories by Dead weight's buckets (memory.neverUsedDays 30). */
  usage: { since: string; used: string[]; quiet: string[]; never: string[] };
  /** Each `aos memory fix <kind> --dry-run --json`, as the runtime answered at generation time. */
  fixes: Record<"sources" | "types" | "descriptions" | "index" | "drafts", ExpectedFix>;
  /** recall-cli.js's hits per query (`--limit 8 --json`). */
  recallHits: Record<string, Array<{ path: string; score: number; flag: string; snippet: string; stale: boolean }>>;
}

export interface ExpectedSources {
  budget: number; tokens: number;
  sections: {
    who: { paths: string[]; tokens: number }; rules: { paths: string[]; tokens: number };
    active: { paths: string[]; omitted: string[]; tokens: number }; links: { tokens: number }; lastSession: { tokens: number };
  };
}
export interface ExpectedMap {
  state: string; mapMin: number; hubs: string[]; unlinked: number;
  graph: { builtAt: string; mode: string | null; nodes: number; edges: number; communities: number };
  communities: Array<{ id: string; name: string; lead: string; paths: string[]; edges: number }>;
  links: Array<{ a: string; b: string; n: number }>;
  memories: Record<string, { community: string | null; degree: number; neighbours: Array<{ path: string; n: number }> }>;
  smaller: { communities: number; memories: number };
}
export interface ExpectedFixChange { path: string; action: string; before: string | null; after: string | null; reason?: "missing" | "retired" | "duplicate" }
export interface ExpectedFix { kind: string; dryRun: boolean; changes: ExpectedFixChange[]; files: number; expect: string; brainMd: unknown }

let cachedExpected: Expected | null = null;
export function expected(): Expected {
  cachedExpected ??= JSON.parse(fs.readFileSync(path.join(ROOT, "expected.json"), "utf8")) as Expected;
  return cachedExpected;
}

export function readVaultJson<T = unknown>(rel: string): T { return JSON.parse(fs.readFileSync(FX.v(rel), "utf8")) as T; }

/** A `prepare` that dates the fixture's Connectors check now (connectors-tab D10): the tab then starts no check of its
 *  own while a spec runs, which on a surface that allows it would start every server the fixture names. */
export function freshConnectorsCheck(): void {
  const file = FX.v("brain/_index/connectors-live.json");
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  j.checkedAt = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}

// ── fixture copy ─────────────────────────────────────────────────────

const COPY = { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true } as const;

/**
 * Runs the fixture generator (scripts/make-fixture-vault.mjs) into tests/.fixture and keeps the pristine copy. `env`: the
 * generator's environment (global-setup.ts's AOS_E2E_FIXTURE_DAYS_AGO moves its clock).
 */
export function buildFixture(env: NodeJS.ProcessEnv = process.env): void {
  const t0 = Date.now();
  execFileSync(process.execPath, [path.join(REPO, "scripts", "make-fixture-vault.mjs"), "--out", ROOT, "--quiet"], { stdio: "inherit", env });
  const stages = JSON.parse(fs.readFileSync(path.join(ROOT, "stages.json"), "utf8")) as Array<{ stage: string; ok: boolean; error?: string }>;
  const failed = stages.filter((s) => !s.ok);
  console.log(`fixture: ${stages.length - failed.length}/${stages.length} runtime stages ok in ${((Date.now() - t0) / 1000).toFixed(1)} s${failed.length ? `; tolerated: ${failed.map((s) => `${s.stage} (${s.error})`).join("; ")}` : ""}`);
  snapshotPristine();
  cachedExpected = null;
}

/** A Date's local YYYY-MM-DD, as the generator writes `today`. */
const localYmd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** How near local midnight a spec file may start: none runs this long, so none straddles midnight. */
const MIDNIGHT_MARGIN_MS = 3 * 60_000;

/**
 * The fixture's dates are relative to the day it was built ("today", "3d late", the to-do badge, Review's "today HH:MM"),
 * and the app reads them against its own clock, so a spec file runs on a fixture built that same day. A run that crosses
 * midnight (CI: built at 23:50, the specs after 00:00) regenerates it before the next spec file, and a spec file about to
 * start in the last MIDNIGHT_MARGIN_MS of a day waits for the next one first, so none straddles midnight.
 */
function fixtureForToday(): void {
  // The running test's or hook's budget (a spec file's beforeAll restores the fixture), extended by the wait and the
  // rebuild together: each extension adds to the last (budget.ts says why a second setTimeout replaced the first).
  const moreTime = extender(test);
  const now = new Date();
  const left = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
  if (left < MIDNIGHT_MARGIN_MS) {
    moreTime(left + 5_000);
    console.log(`fixture: ${Math.ceil(left / 1000)} s to midnight; the next spec file starts on the new day`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, left + 5_000);
  }
  if (expected().today === localYmd(new Date())) return;
  moreTime(120_000);
  console.log(`fixture: built on ${expected().today}, today is ${localYmd(new Date())}: building it again`);
  buildFixture();
}

/** globalSetup: keep the freshly generated vault and home as the pristine copy every spec file restores from. */
export function snapshotPristine(): void {
  fs.rmSync(FX.pristine, { recursive: true, force: true });
  fs.mkdirSync(FX.pristine, { recursive: true });
  for (const d of ["vault", "home"]) fs.cpSync(path.join(ROOT, d), path.join(FX.pristine, d), COPY);
}

/**
 * Puts vault/ and home/ back to the pristine copy (the runtime's node_modules is kept: nothing writes to it), from a
 * fixture built today (fixtureForToday).
 */
export function restoreFixture(): void {
  if (!fs.existsSync(path.join(FX.pristine, "vault"))) throw new Error(`no pristine fixture in ${FX.pristine}: run the suite through playwright (globalSetup builds it)`);
  fixtureForToday();
  const keep = path.join(FX.vault, "brain", "scripts", "node_modules");
  const parked = path.join(ROOT, ".node_modules.parked");
  fs.rmSync(parked, { recursive: true, force: true });
  if (fs.existsSync(keep)) fs.renameSync(keep, parked);
  for (const d of ["vault", "home"]) {
    fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
    fs.cpSync(path.join(FX.pristine, d), path.join(ROOT, d), {
      ...COPY,
      filter: (src) => !(fs.existsSync(parked) && src === path.join(FX.pristine, "vault", "brain", "scripts", "node_modules")),
    });
  }
  if (fs.existsSync(parked)) fs.renameSync(parked, keep);
}

// ── launch ───────────────────────────────────────────────────────────

export interface GuardEntry { kind: "read" | "write" | "spawn"; what: string; at: string }
export interface Opened { via: "main" | "renderer"; fn: string; arg: string }

export interface AppHandle {
  app: ElectronApplication;
  win: Page;
  /** Uncaught renderer exceptions and console.error lines from the renderer and the main process. */
  errors: string[];
  /** Every Notice the HUD raised (the compat Notice logs "[notice] …"). */
  notices: string[];
  /** The write guard's log: writes and spawns it refused. */
  guard(): Promise<GuardEntry[]>;
  /** What the app asked the OS to do (shell.openPath / openExternal / showItemInFolder / trashItem), recorded instead. */
  opened(): Promise<Opened[]>;
  /**
   * Quits the app, then waits until every process it started has ended, the detached refreshes it leaves running on
   * quit included; what is still running `graceMs` after the quit (default 10 s) is killed, with its children.
   */
  close(opts?: { graceMs?: number }): Promise<void>;
}

export interface LaunchOptions {
  /** Changes the restored fixture before the app starts (a variant: provider on, cost off, an empty vault …). */
  prepare?: () => void;
  /** Extra environment for the app; undefined removes a variable. */
  env?: Record<string, string | undefined>;
  size?: { width: number; height: number };
  /** What shows once the app is up: the Workbench's rail by default; the wizard's `.aos-setup` with no install. */
  ready?: string;
  /** Whether the app has already shown the fixture vault its one-time "What changed" note (default: yes). */
  noted?: boolean;
  /**
   * Whether the guided tour is already behind this Mac (default: yes): its HUD settings say every tab's chapter was
   * offered, this version's What's new was seen and Getting started was put away, so no other spec meets a chip or the
   * checklist. false leaves the HUD's settings as they are (a fresh fixture has none: tour.spec.ts starts from there).
   */
  tour?: boolean;
  /**
   * Whether the launch sequence (tour C11) already ran on this Mac (default: yes): the HUD's settings say the Go-local
   * card, the Import sheet and this version's What's new card were shown, so no other spec meets one, the way `noted`
   * keeps the vault's first-launch state. A new install's welcome tour is the wizard's (setup specs). launch.spec.ts
   * passes false.
   */
  launch?: boolean;
}

/** A vault path's key in tour.launched: FNV-1a's 32 bits in hex, as hud/src/tour/launch.ts vaultKey has it. */
export function vaultKey(vault: string): string {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(vault, "utf8")) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** The launch sequence's dialogs as tour.launched names them (hud/src/tour/launch.ts): the fixture vault's
 *  Go-local card and Import sheet, and this version's What's new card. */
export const LAUNCHED = [`go-local@${vaultKey(FX.vault)}`, `import@${vaultKey(FX.vault)}`, `whats-new@${HUD_VERSION}`];

/** The app's data folder in the fixture (appEnv's AOS_APP_USER_DATA). */
export const USER_DATA = path.join(FX.home, "Library", "Application Support", "AgenticOS Workbench (e2e)");

/** Records that the app showed `vault` its "What changed" note (src/main/setup/attach.ts), or forgets every vault. */
export function markNoted(vault: string | null): void {
  const file = path.join(USER_DATA, "attach.json");
  if (!vault) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(USER_DATA, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(file, `${JSON.stringify({ vaults: { [path.resolve(vault)]: { firstAt: at, notedAt: at } } }, null, 2)}\n`);
}

/** The tour's chapters, as the HUD ships them (hud/src/tour/steps.json). */
export interface TourBookFile { core: string; chapters: Array<{ id: string; title: string; tab?: string; mode?: string; when?: string; steps: Array<{ id: string; anchor: string; advance: string; when?: string; tab?: string }> }> }
export const TOUR_BOOK = JSON.parse(fs.readFileSync(path.join(REPO, "..", "hud", "src", "tour", "steps.json"), "utf8")) as TourBookFile;
/** The HUD's settings file in the app's data folder (src/main/services/fs.ts loadPluginData). */
export const HUD_SETTINGS = path.join(USER_DATA, "plugins", "agentic-os.json");

/** Marks the tour as behind this Mac in the HUD's settings, keeping whatever else they hold. */
export function markTour(): void {
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(fs.readFileSync(HUD_SETTINGS, "utf8")) as Record<string, unknown>; } catch { /* none yet */ }
  const tabs = [...new Set(TOUR_BOOK.chapters.map((c) => c.tab).filter((t): t is string => !!t))];
  cur.tour = { lastSeenVersion: HUD_VERSION, completed: [], dismissed: [], checklist: { dismissed: true, done: {} }, offered: tabs };
  fs.mkdirSync(path.dirname(HUD_SETTINGS), { recursive: true });
  fs.writeFileSync(HUD_SETTINGS, `${JSON.stringify(cur, null, 2)}\n`);
}

/** Marks the launch sequence as run on this Mac (tour.launched), keeping whatever else the HUD's settings hold. */
export function markLaunch(): void {
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(fs.readFileSync(HUD_SETTINGS, "utf8")) as Record<string, unknown>; } catch { /* none yet */ }
  const tour = (cur.tour && typeof cur.tour === "object" ? cur.tour : {}) as Record<string, unknown>;
  cur.tour = { ...tour, launched: LAUNCHED };
  fs.mkdirSync(path.dirname(HUD_SETTINGS), { recursive: true });
  fs.writeFileSync(HUD_SETTINGS, `${JSON.stringify(cur, null, 2)}\n`);
}

/** The environment the generator ran the runtime with, pointed at the fixture, plus the app's own vault and data dirs. */
export function appEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env = JSON.parse(fs.readFileSync(path.join(ROOT, "env.json"), "utf8")) as Record<string, string>;
  Object.assign(env, {
    AOS_APP_VAULT: FX.vault,
    // The other branch's userData override; on this one CFFIXED_USER_HOME already puts userData under the fake HOME.
    AOS_APP_USER_DATA: USER_DATA,
    ELECTRON_ENABLE_LOGGING: "0",
    // Read-only unless a spec turns surfaces on with its own AOS_APP_WRITE. The app's own default (every verified
    // surface) is what a spec gets with `AOS_APP_WRITE: undefined` (variants.spec.ts covers it).
    AOS_APP_WRITE: "",
    // The Computer pane's start page and its search (the test seam in computer/notify.ts testSwitches): a loopback
    // address, so no run's new tab or search reaches the real search engine; computer.spec.ts serves its own.
    AOS_E2E_START_PAGE: "http://127.0.0.1/",
  });
  // The runtime runs above used AOS_HEADLESS=1; an app launched from Finder has no such variable, and under it the
  // runtime refreshes the app is allowed to start (scan-vault, reconcile-sessions) would exit without doing anything.
  delete env.AOS_HEADLESS;
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

/**
 * A `prepare` for a machine with both session hosts: Codex turned on in agenticos.json, then the vault's own
 * `aos skills sync` and `aos agents sync`, as a session's end would run them. Sharing is on, and each of the fixture's
 * Claude Code skills and agents gets its mirror in Codex's folders (home/.agents/skills, home/.codex/agents).
 */
export function shareBothHosts(): void {
  const file = path.join(FX.claude, "agenticos.json");
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as { hosts: { codex: { enabled: boolean } } };
  j.hosts.codex.enabled = true;
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
  for (const kind of ["skills", "agents"]) {
    const r = spawnSync("/bin/sh", [FX.v("brain/scripts/bin/aos"), kind, "sync"], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
    if (r.status !== 0) throw new Error(`aos ${kind} sync exited ${r.status}: ${r.stderr}`);
  }
}

// ── Chat's stand-ins for the model CLIs ──────────────────────────────

/** The chat stubs' folder: their scripts, call logs and canned replies. Outside vault/ and home/; each prepare rewrites it. */
export const STUBS = path.join(ROOT, "chat-stubs");
export const CLAUDE_STUB = path.join(STUBS, "claude");
export const CODEX_STUB = path.join(STUBS, "codex");

export interface ClaudeCall { argv: string[]; cwd: string; env: { AOS_HEADLESS: string | null; CLAUDECODE: string | null } }
export interface CodexCall { argv: string[]; stdin: string; cwd: string }
/** What the claude stub answers next: stdout, stderr and exit code, after a delay. Unset fields keep the default answer's. */
export interface StubReply { stdout?: string; stderr?: string; code?: number; delayMs?: number }

/** The claude stub's default answer: a `--output-format json` result, as headless Claude prints it. */
export const CLAUDE_ANSWER = { text: "**Tide tables** come first, then the harbour chart.", usd: 0.0123, inputTokens: 321, outputTokens: 45 };
/** The codex stub's answer, which it writes to the `-o` file as `codex exec` does. */
export const CODEX_ANSWER = { text: "Codex says: the harbour chart is **next**.", inputTokens: 1200, outputTokens: 80 };

/**
 * A `prepare` for Chat: `claude` and `codex` stubs that record every call and answer from a canned reply, so no model is
 * ever called. Their paths go where `aos init` records the real ones (`claude.bin`, and the legacy `codex.bin`, which
 * lets the reasoner fall back to Codex without switching on the Codex host). claude answers as `chatReply` last set;
 * codex answers CODEX_ANSWER the way `codex exec --json -o <file>` does.
 */
export function installChatStubs(): void {
  fs.rmSync(STUBS, { recursive: true, force: true });
  fs.mkdirSync(STUBS, { recursive: true });
  const node = path.join(ROOT, "bin", "node");
  const answer = JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: CLAUDE_ANSWER.text, total_cost_usd: CLAUDE_ANSWER.usd,
    usage: { input_tokens: CLAUDE_ANSWER.inputTokens, output_tokens: CLAUDE_ANSWER.outputTokens },
  });
  fs.writeFileSync(CLAUDE_STUB, `#!${node}
// fixture stub: never reaches the real claude. Records the call, then answers as reply.json says.
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(path.join(STUBS, "claude-calls.jsonl"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: { AOS_HEADLESS: process.env.AOS_HEADLESS ?? null, CLAUDECODE: process.env.CLAUDECODE ?? null } }) + "\\n");
let r = { stdout: ${JSON.stringify(answer)}, stderr: "", code: 0, delayMs: 0 };
try { r = { ...r, ...JSON.parse(fs.readFileSync(${JSON.stringify(path.join(STUBS, "claude-reply.json"))}, "utf8")) }; } catch {}
setTimeout(() => { process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.code; }, r.delayMs);
`, { mode: 0o755 });
  fs.writeFileSync(CODEX_STUB, `#!${node}
// fixture stub: never reaches the real codex. Records the call and its stdin, writes the answer to -o, prints the events.
const fs = require("fs");
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(path.join(STUBS, "codex-calls.jsonl"))}, JSON.stringify({ argv, stdin, cwd: process.cwd() }) + "\\n");
  const out = argv[argv.indexOf("-o") + 1];
  if (argv.includes("-o") && out) fs.writeFileSync(out, ${JSON.stringify(CODEX_ANSWER.text)});
  process.stdout.write([
    { type: "thread.started", thread_id: "fixture" },
    { type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(CODEX_ANSWER.text)} } },
    { type: "turn.completed", usage: { input_tokens: ${CODEX_ANSWER.inputTokens}, cached_input_tokens: 0, output_tokens: ${CODEX_ANSWER.outputTokens} } },
  ].map((e) => JSON.stringify(e)).join("\\n") + "\\n");
});
`, { mode: 0o755 });
  const file = path.join(FX.claude, "agenticos.json");
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as { claude: Record<string, unknown>; codex?: Record<string, unknown> };
  j.claude.bin = CLAUDE_STUB;
  j.codex = { ...(j.codex ?? {}), bin: CODEX_STUB };
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}

const jsonl = <T>(file: string): T[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
export const claudeCalls = (): ClaudeCall[] => jsonl<ClaudeCall>(path.join(STUBS, "claude-calls.jsonl"));
export const codexCalls = (): CodexCall[] => jsonl<CodexCall>(path.join(STUBS, "codex-calls.jsonl"));
/** Sets the claude stub's next answers; null goes back to CLAUDE_ANSWER. */
export function chatReply(r: StubReply | null): void {
  const file = path.join(STUBS, "claude-reply.json");
  if (r) fs.writeFileSync(file, JSON.stringify(r)); else fs.rmSync(file, { force: true });
}

/**
 * Puts what the scripts' provider probe publishes in provider-state.json: the global provider, and fresh login caches
 * for both CLIs, which the runtime trusts for 24 hours instead of probing. Chat routes on these (claudeAsk.ts chatRoute).
 */
export function providerState(name: string, logins: { claude: boolean; codex: boolean }): void {
  const file = FX.v("brain/_index/provider-state.json");
  const at = new Date().toISOString();
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  Object.assign(j, {
    name, reason: "forced", checkedAt: at,
    claude: { loggedIn: logins.claude, checkedAt: at, bin: CLAUDE_STUB },
    codex: { loggedIn: logins.codex, checkedAt: at, bin: CODEX_STUB },
  });
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}

// ── the Computer pane's stand-in agents (agent-computer D18, D39) ────

/**
 * Agent CLIs for the Computer pane's spec. The app spawns one as it spawns Claude Code or Codex (a Chat turn's CLI, a
 * Code launch's terminal process), so the bridge admits it by spawn ownership, as it admits the real ones. Each starts
 * the plugin launcher's MCP server (`sh <launcher> mcp-server`, which execs the vault's mcp-server.js, so the server is
 * the CLI's own child) and calls the computer_* tools when the spec asks, over a port on 127.0.0.1 it records in
 * `runs/<pid>.json`. They run on `node`, a copy of the fixture's Node that nothing else runs: the test switch
 * AOS_E2E_TRUSTED_CLI names it (admission judges the running process, whose executable is a script's interpreter) and
 * the two scripts (a Code launch's install check judges the file it starts), never the Node every runtime script uses.
 */
export const AGENT = {
  dir: path.join(ROOT, "computer-agent"),
  node: path.join(ROOT, "computer-agent", "bin", "node"),
  bin: { claude: path.join(ROOT, "computer-agent", "claude"), codex: path.join(ROOT, "computer-agent", "codex") },
  runs: path.join(ROOT, "computer-agent", "runs"),
};
/**
 * The app's data folder (USER_DATA) through a short link in the temp folder, for the Computer pane's spec: the bridge's
 * socket lives in it (computer/bridge.sock), and a Unix socket's path holds at most 103 bytes, which the fixture's
 * folder alone nearly fills.
 */
export const USER_DATA_LINK = path.join(os.tmpdir(), `aos-e2e-${crypto.createHash("sha256").update(ROOT).digest("hex").slice(0, 8)}`);

/** The plugin launcher an agent's MCP server starts through: the vault's copy of plugin/bin/aos. */
const LAUNCHER = path.join(ROOT, "vault", "brain", "scripts", "bin", "aos");

/** A path with its existing part resolved (the fixture may not exist yet when a spec file loads). */
function resolvedPath(p: string): string {
  const rest: string[] = [];
  for (let at = p; ; at = path.dirname(at)) {
    try { return path.join(fs.realpathSync(at), ...rest.reverse()); } catch { /* not there yet */ }
    if (path.dirname(at) === at) return p;
    rest.push(path.basename(at));
  }
}

/** The test-build switches the Computer pane's spec launches with (computer/notify.ts testSwitches), both CLIs found, and
 *  the app's data folder through its short link (installComputerAgents makes it). */
export function computerEnv(): Record<string, string | undefined> {
  return {
    AOS_E2E_TRUSTED_CLI: [AGENT.node, AGENT.bin.claude, AGENT.bin.codex].map(resolvedPath).join(","),
    // Every *.test site the spec opens is the fixture server on 127.0.0.1, at its own unmarked origin.
    AOS_E2E_HOST_RULES: "MAP *.test 127.0.0.1",
    AOS_APP_USER_DATA: USER_DATA_LINK,
    AOS_NO_CLAUDE: undefined,
    AOS_NO_CODEX: undefined,
  };
}

/** What a stand-in agent recorded when it started. `mode`: a Chat turn, a Code launch, or started by the spec itself.
 *  `rc`: its $AOS_E2E_RC_ONLY, which only the fixture's shell rc file sets when a spec adds it (RC_ONLY). */
export interface AgentRun { pid: number; port: number; host: "claude" | "codex"; mode: "chat" | "code" | "outsider"; argv: string[]; cwd: string; prompt: string; at: number; rc: string | null }

/** A variable only the fixture HOME's .zshrc exports, once a spec calls addRcOnly (agent-computer C1: a Code launch's
 *  agent sees what the login shell's rc files export, as a launch typed into a shell did). */
export const RC_ONLY = { name: "AOS_E2E_RC_ONLY", value: "set by the fixture HOME zshrc" };
/** Appends RC_ONLY's export to the fixture HOME's .zshrc (restored from the pristine copy before each spec file). */
export function addRcOnly(): void {
  fs.appendFileSync(path.join(FX.home, ".zshrc"), `export ${RC_ONLY.name}='${RC_ONLY.value}'\n`);
}
/** A tool's result as the MCP server returned it; `at` is when the agent had it (its clock, Date.now()). */
export interface AgentReply { text: string; isError: boolean; image: string | null; at: number }
/** Which MCP server answers: the agent's own, a second one it starts as its child, or one behind a shell (a grandchild). */
export type AgentServer = "main" | "second" | "grandchild";

/**
 * Writes the two stand-ins and records them as the hosts' binaries, where the runtime looks first (the vault config's
 * hosts.<host>.bin and agenticos.json's legacy <host>.bin), so a Chat turn's plan and a Code launch's `sessions.js bin`
 * both name them.
 */
export function installComputerAgents(): void {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.rmSync(USER_DATA_LINK, { force: true });
  fs.symlinkSync(USER_DATA, USER_DATA_LINK);
  fs.mkdirSync(AGENT.dir, { recursive: true });
  fs.rmSync(AGENT.runs, { recursive: true, force: true });
  fs.mkdirSync(AGENT.runs, { recursive: true });
  const real = fs.realpathSync(path.join(ROOT, "bin", "node"));
  if (!fs.existsSync(AGENT.node) || fs.statSync(AGENT.node).size !== fs.statSync(real).size) {
    fs.mkdirSync(path.dirname(AGENT.node), { recursive: true });
    fs.rmSync(AGENT.node, { force: true });
    fs.copyFileSync(real, AGENT.node, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(AGENT.node, 0o755);
  }
  // A Node linked against its own libnode (Homebrew's) finds it at @executable_path/../lib: the copy's lib is the original's.
  const lib = path.join(path.dirname(path.dirname(real)), "lib");
  const libLink = path.join(path.dirname(path.dirname(AGENT.node)), "lib");
  fs.rmSync(libLink, { recursive: true, force: true });
  if (fs.existsSync(lib)) fs.symlinkSync(lib, libLink);
  for (const host of ["claude", "codex"] as const) fs.writeFileSync(AGENT.bin[host], agentScript(host), { mode: 0o755 });
  const edit = (file: string, fn: (j: Record<string, any>) => void) => {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    fn(j);
    fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
  };
  edit(FX.v("brain/config.json"), (j) => {
    j.hosts = { ...(j.hosts ?? {}) };
    for (const h of ["claude", "codex"]) j.hosts[h] = { ...(j.hosts[h] ?? {}), bin: AGENT.bin[h as "claude" | "codex"] };
  });
  edit(path.join(FX.claude, "agenticos.json"), (j) => {
    j.claude = { ...(j.claude ?? {}), bin: AGENT.bin.claude };
    j.codex = { ...(j.codex ?? {}), bin: AGENT.bin.codex };
  });
}

/** One stand-in's script: the host catalog's questions answered from a one-model list; else a turn, a Code session or
 *  (with FIXTURE_AGENT_OUTSIDER=1, started by the spec) an outsider, each serving the spec's calls until it is told to
 *  finish or its time is up. */
function agentScript(host: "claude" | "codex"): string {
  return `#!${AGENT.node}
// fixture stub: never reaches the real ${host}. The Computer pane's spec drives it (tests/e2e/harness.ts AGENT).
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const HOST = ${JSON.stringify(host)};
const RUNS = ${JSON.stringify(AGENT.runs)};
const LAUNCHER = ${JSON.stringify(LAUNCHER)};
const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");

function catalog() {
  if (argv[0] === "--version") { process.stdout.write(HOST === "claude" ? "2.1.318 (Claude Code)\\n" : "codex-cli 0.167.0\\n"); return true; }
  // Main asks a Codex CLI's help whether it takes --no-daemon (agent-computer R70), as codex-cli 0.167.0's lists it, and
  // for a resume line the resume subcommand's (R77), which lists it too.
  if (argv[0] === "resume" && argv[1] === "--help" && HOST === "codex") {
    process.stdout.write("Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]\\n\\nOptions:\\n      --last\\n      --no-daemon\\n");
    return true;
  }
  if (argv[0] === "--help") {
    process.stdout.write(HOST === "codex"
      ? "Usage: codex [OPTIONS] [PROMPT]\\n\\nOptions:\\n      --no-daemon\\n          Run without the shared background server, even if it is already running\\n"
      : "Usage: claude [options] [command] [prompt]\\n");
    return true;
  }
  if (HOST === "claude" && argv.includes("--input-format")) {
    let buf = "", answered = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\\n");
      if (answered || i < 0) return;
      answered = true;
      const req = JSON.parse(buf.slice(0, i));
      out({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response: { models: [{ value: "default", displayName: "Default", description: "The fixture's model", supportedEffortLevels: [] }], commands: [] } } });
    });
    setInterval(() => {}, 1000);
    return true;
  }
  if (HOST === "codex" && argv[0] === "debug") {
    if (argv[1] === "models") out({ models: [{ slug: "gpt-tide-3", display_name: "GPT-Tide-3", description: "The fixture's model.", visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "low", description: "low" }] }] });
    else if (argv[1] === "prompt-input") out([]);
    else process.exitCode = 2;
    return true;
  }
  return false;
}

/** An MCP client over the stdio of a server it starts: the plugin launcher, as the host starts it (direct), or behind a
 *  shell that runs one more command after it, so the server is a grandchild (indirect). */
function mcp(indirect) {
  const env = { ...process.env, AOS_HOST: HOST };
  const child = indirect
    ? spawn("/bin/sh", ["-c", '"$0" "$1" mcp-server; :', "/bin/sh", LAUNCHER], { env, stdio: ["pipe", "pipe", "ignore"] })
    : spawn("/bin/sh", [LAUNCHER, "mcp-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let buf = "", id = 0, gone = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m && m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const end = () => { gone = true; for (const r of pending.values()) r({ error: { message: "the MCP server exited" } }); pending.clear(); };
  child.on("exit", end);
  child.on("error", end);
  const rpc = (method, params) => new Promise((resolve) => {
    if (gone) return resolve({ error: { message: "the MCP server exited" } });
    const n = ++id;
    pending.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\\n");
  });
  const ready = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-agent", version: "1.0.0" } })
    .then(() => { if (!gone) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n"); });
  return {
    child,
    async call(name, args) {
      await ready;
      const m = await rpc("tools/call", { name, arguments: args || {} });
      const at = Date.now();
      if (m.error) return { text: String(m.error.message || "error"), isError: true, image: null, at };
      const content = (m.result && m.result.content) || [];
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\\n");
      const img = content.find((c) => c.type === "image");
      return { text, isError: m.result.isError === true, image: img ? img.data : null, at };
    },
    stop() { try { child.stdin.end(); } catch {} },
  };
}

function main() {
  if (catalog()) return;
  const mode = process.env.FIXTURE_AGENT_OUTSIDER === "1" ? "outsider" : (HOST === "claude" ? argv[0] === "-p" : argv[0] === "exec") ? "chat" : "code";
  const prompt = mode === "chat" ? argv[argv.length - 1] : "";
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  const sessionId = at("--session-id") || at("--resume");
  if (mode === "chat") out(HOST === "claude" ? { type: "system", subtype: "init", session_id: sessionId } : { type: "thread.started", thread_id: "fixture-computer" });
  else if (mode === "code") process.stdout.write("[fixture " + HOST + " agent] ready\\r\\n");
  // The CLI starts its MCP servers before it runs any tool (D18: the first connection wins).
  const servers = { main: mcp(false) };
  const server = (which) => {
    if (which === "second") return (servers.second = servers.second || mcp(false));
    if (which === "grandchild") return (servers.grandchild = servers.grandchild || mcp(true));
    return servers.main;
  };
  const finish = () => {
    for (const s of Object.values(servers)) s.stop();
    const done = () => process.exit(0);
    if (mode !== "chat") return done();
    const text = "Done with the computer.";
    if (HOST === "claude") {
      out({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text }] } });
      process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } }) + "\\n", done);
    } else {
      out({ type: "item.completed", item: { id: "m1", type: "agent_message", text } });
      process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }) + "\\n", done);
    }
  };
  const httpd = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { body += d; });
    req.on("end", async () => {
      const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      try {
        const j = body ? JSON.parse(body) : {};
        if (req.url === "/finish") { send({ ok: true }); setTimeout(finish, 10); return; }
        if (req.url !== "/call") { res.writeHead(404).end(); return; }
        const s = server(j.server);
        const first = await s.call(j.tool, j.args);
        // The next call goes the moment the first answers, for a spec timing what follows it.
        if (j.then) send({ first, then: await s.call(j.then.tool, j.then.args) });
        else send(first);
      } catch (e) { send({ text: String(e && e.message || e), isError: true, image: null, at: Date.now() }); }
    });
  });
  httpd.listen(0, "127.0.0.1", () => {
    const run = { pid: process.pid, port: httpd.address().port, host: HOST, mode, argv, cwd: process.cwd(), prompt, at: Date.now(), rc: process.env.${RC_ONLY.name} ?? null };
    const file = path.join(RUNS, process.pid + ".json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(run));
    fs.renameSync(file + ".tmp", file);
  });
  // Nothing outlives a spec: a stand-in nobody finished ends on its own.
  setTimeout(finish, 5 * 60_000).unref();
}
main();
`;
}

/** A running stand-in agent, called over its port. */
export class Agent {
  constructor(readonly run: AgentRun) {}

  private async post<T>(route: string, body: unknown): Promise<T> {
    const r = await fetch(`http://127.0.0.1:${this.run.port}${route}`, { method: "POST", body: JSON.stringify(body) });
    return (await r.json()) as T;
  }

  /** Calls a tool and waits for its result. */
  call(tool: string, args: Record<string, unknown> = {}, server: AgentServer = "main"): Promise<AgentReply> {
    return this.post<AgentReply>("/call", { tool, args, server });
  }

  /** Calls a tool, then another the moment the first answers; both results. */
  chain(first: { tool: string; args?: Record<string, unknown> }, then: { tool: string; args?: Record<string, unknown> }): Promise<{ first: AgentReply; then: AgentReply }> {
    return this.post("/call", { tool: first.tool, args: first.args ?? {}, then: { tool: then.tool, args: then.args ?? {} } });
  }

  /** Ends the turn (a Chat turn prints its last text and result) or the session; resolves once the process has gone. */
  async finish(): Promise<void> {
    try { await this.post("/finish", {}); } catch { /* already gone */ }
    for (const until = Date.now() + 10_000; Date.now() < until; await sleep(50)) {
      try { process.kill(this.run.pid, 0); } catch { return; }
    }
  }
}

const taken = new Set<number>();
/** The newest stand-in that started after `after` and matches, once it has recorded its port. */
export async function agentRun(match: (r: AgentRun) => boolean, after: number, timeoutMs = 30_000): Promise<Agent> {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await sleep(100)) {
    let names: string[] = [];
    try { names = fs.readdirSync(AGENT.runs).filter((n) => n.endsWith(".json")); } catch { /* none yet */ }
    const runs = names.map((n) => { try { return JSON.parse(fs.readFileSync(path.join(AGENT.runs, n), "utf8")) as AgentRun; } catch { return null; } })
      .filter((r): r is AgentRun => !!r && r.at >= after && !taken.has(r.pid) && match(r))
      .sort((a, b) => b.at - a.at);
    if (runs[0]) { taken.add(runs[0].pid); return new Agent(runs[0]); }
  }
  throw new Error(`no stand-in agent started within ${timeoutMs} ms`);
}

/** A stand-in started by the spec, not by the app: a process outside the app, as a CLI typed by hand would be (D17, D18). */
export async function startOutsider(host: "claude" | "codex" = "claude"): Promise<{ agent: Agent; kill(): void }> {
  const after = Date.now();
  const child = spawn(AGENT.bin[host], [], { env: appEnv({ FIXTURE_AGENT_OUTSIDER: "1", AOS_HEADLESS: undefined }), stdio: "ignore", detached: false });
  const agent = await agentRun((r) => r.pid === child.pid, after - 1, 15_000);
  return { agent, kill: () => { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
}

// ── the app's processes ──────────────────────────────────────────────

const run = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Proc { pid: number; ppid: number; pgid: number; command: string }

/** Every process now, but zombies (ended, waiting for their parent to collect them). */
async function processes(): Promise<Proc[]> {
  const { stdout } = await run("ps", ["-Aww", "-o", "pid=,ppid=,pgid=,stat=,command="], { maxBuffer: 64 << 20 });
  const all: Proc[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m && !m[4].startsWith("Z")) all.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[5] });
  }
  return all;
}

/**
 * The processes one app started, followed from the app's own: their pids and their process groups. Main starts the
 * runtime's refreshes (scan-vault.js after a new workspace or Scratch, regen-workspace-insight …) detached and leaves
 * them running on quit (ProcService.killAttached), as a user's app should. Each leads its own group, which its own
 * children (the scan's git) join; once the app has gone they are re-parented away from it, so the groups are what
 * still ties them, and their children, to it.
 */
class AppProcesses {
  private readonly pids = new Set<number>();
  private readonly groups = new Set<number>();
  constructor(app: number) { this.pids.add(app); }

  /**
   * Takes in what now runs under the app's processes or in their groups, and anything whose command line names the
   * fixture (runtime scripts run as `node <fixture>/vault/brain/scripts/…`, and a detached respawn keeps that path), so a
   * script orphaned before close() began is still waited for; returns the app's processes still running.
   */
  async update(): Promise<Proc[]> {
    const all = await processes();
    const own = all.find((p) => p.pid === process.pid)?.pgid; // this worker's group is never the app's
    const fixture = ROOT + path.sep;
    for (let grew = true; grew;) {
      grew = false;
      for (const p of all) {
        const ours = this.pids.has(p.ppid) || this.groups.has(p.pgid) || (p.pid !== process.pid && p.command.includes(fixture));
        if (!this.pids.has(p.pid) && ours) { this.pids.add(p.pid); grew = true; }
        if (this.pids.has(p.pid) && p.pgid > 1 && p.pgid !== own && !this.groups.has(p.pgid)) { this.groups.add(p.pgid); grew = true; }
      }
    }
    return all.filter((p) => this.pids.has(p.pid));
  }

  /**
   * Waits until none of them runs. What still does after `graceMs` is killed, with its group. The grace comes first
   * because a refresh killed mid-write can leave its lock behind (scan-vault's .snapshot.lock goes stale only after
   * 60 s), which a relaunch in the same spec file would trip over.
   */
  async settle(graceMs: number): Promise<void> {
    let running = await this.update();
    for (const until = Date.now() + graceMs; running.length && Date.now() < until; running = await this.update()) await sleep(25);
    if (!running.length) return;
    console.warn(`close(): killed what the app left running ${graceMs} ms after it quit:\n${running.map((p) => `  ${p.pid} ${p.command}`).join("\n")}`);
    for (const g of new Set(running.map((p) => p.pgid))) if (this.groups.has(g)) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
    for (const p of running) { try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } }
    for (const until = Date.now() + 5_000; running.length; running = await this.update()) {
      if (Date.now() > until) throw new Error(`close(): the app's processes would not end:\n${running.map((p) => `  ${p.pid} ${p.command}`).join("\n")}`);
      await sleep(25);
    }
  }
}

/** Errors that are part of the app's read-only phase, not faults: none so far. Add a pattern here only with a reason. */
const KNOWN_ERRORS: RegExp[] = [];

export async function launchApp(opts: LaunchOptions = {}): Promise<AppHandle> {
  const main = path.join(REPO, "out", "main", "index.js");
  if (!fs.existsSync(main)) throw new Error("out/ is missing: run `npm run build` (npm run test:e2e builds first)");
  markNoted(opts.noted === false ? null : FX.vault);
  if (opts.tour !== false) markTour();
  if (opts.launch !== false) markLaunch();
  opts.prepare?.();
  const app = await electron.launch({ args: [REPO], cwd: REPO, env: appEnv(opts.env), timeout: 60_000 });
  // AOS_E2E_STRAGGLER=1: a scan the app starts holds its writes for the next restoreFixture (straggler.cjs). Playwright
  // drops NODE_OPTIONS from the launch environment, so it goes into main's own, which every child the app spawns inherits.
  if (process.env.AOS_E2E_STRAGGLER === "1") {
    await app.evaluate((_e, pre) => { process.env.NODE_OPTIONS = `--require ${JSON.stringify(pre)}`; }, path.join(__dirname, "straggler.cjs"));
  }
  const errors: string[] = [];
  const notices: string[] = [];
  const known = (t: string) => KNOWN_ERRORS.some((re) => re.test(t));
  app.on("console", (m) => { if (m.type() === "error" && !known(m.text())) errors.push(`[main] ${m.text()}`); });
  const win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? ""}`));
  win.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[notice]")) notices.push(t.slice("[notice]".length).trim());
    if (m.type() === "error" && !known(t)) errors.push(`[renderer] ${t}`);
    // A read main refused is a gap in the read scope (src/main/policy/read-scope.ts): the HUD reads only what it shows.
    if (t.startsWith("[guard] refused read") && !known(t)) errors.push(`[renderer] ${t}`);
  });
  const size = opts.size ?? { width: 1480, height: 920 };
  // The main window (the app page), not the tray popover, which is about:blank.
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://hud/"))?.setContentSize(s.width, s.height), size);

  // Nothing the specs click may reach the desktop: record the OS hand-offs instead. The page has no Node (phase 4), so
  // every one of them happens in main, behind the bridge. The Trash is the fixture's, not the desktop's: the file leaves
  // the vault as it would, into <home>/.Trash. Notifications are kept, not shown.
  await app.evaluate(({ shell, Notification }, trashDir) => {
    const g = globalThis as unknown as { __aosOpened: Array<{ via: string; fn: string; arg: string }>; __aosNotified: unknown[] };
    g.__aosOpened = [];
    // The Computer pane's desktop notifications (agent-computer D27) are kept here, never shown: a spec emits a kept
    // one's "click" to stand in for the person clicking it.
    g.__aosNotified = [];
    Notification.prototype.show = function show(this: unknown) { g.__aosNotified.push(this); };
    const s = shell as unknown as Record<string, unknown>;
    s.openExternal = async (url: string) => { g.__aosOpened.push({ via: "main", fn: "openExternal", arg: String(url) }); };
    s.openPath = async (p: string) => { g.__aosOpened.push({ via: "main", fn: "openPath", arg: String(p) }); return ""; };
    s.showItemInFolder = (p: string) => { g.__aosOpened.push({ via: "main", fn: "showItemInFolder", arg: String(p) }); };
    s.trashItem = async (p: string) => {
      g.__aosOpened.push({ via: "main", fn: "trashItem", arg: String(p) });
      const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
      const path = process.getBuiltinModule("node:path") as typeof import("node:path");
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(p, path.join(trashDir, path.basename(p)));
    };
  }, path.join(FX.home, ".Trash"));
  await win.waitForSelector(opts.ready ?? ".aos-wb-railbtn", { timeout: 30_000 });

  // Taken now: once the app has quit and Playwright has let its handle go, app.process() throws (R73: the R46 spec quits
  // the app itself, before useApp's close).
  const appProc = app.process();
  const handle: AppHandle = {
    app, win, errors, notices,
    guard: () => win.evaluate(() => (window as unknown as { aosHost: { guard: { log: GuardEntry[] } } }).aosHost.guard.log.map((e) => ({ ...e }))),
    opened: () => app.evaluate(() => (globalThis as unknown as { __aosOpened: Opened[] }).__aosOpened.map((e) => ({ ...e }))),
    close: async ({ graceMs = 10_000 } = {}) => {
      const proc = appProc;
      // Already gone (it quit by itself, and its test waited for that): nothing left to close.
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const started = new AppProcesses(proc.pid!);
      await started.update();
      // Followed while the app quits as well: what it starts on the way out is its too.
      let quitting = true;
      const following = (async () => { while (quitting) { await started.update().catch(() => undefined); await sleep(25); } })();
      const closed = app.close().then(() => true, () => false);
      const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 15_000));
      if (!(await Promise.race([closed, timeout]))) proc.kill("SIGKILL");
      quitting = false;
      await following;
      // The app has gone, but not necessarily what it started: a scan still writing under vault/brain fails the next
      // restoreFixture() (ENOTEMPTY) or writes into its fresh copy.
      await started.settle(graceMs);
    },
  };
  return handle;
}

/**
 * Registers one app for the spec file: restore the fixture, launch before the first test, close after the last.
 * Playwright re-runs beforeAll in a fresh worker after a failure, so a failed test never poisons the rest of the file.
 */
export function useApp(opts: LaunchOptions = {}): () => AppHandle {
  let h: AppHandle | null = null;
  test.beforeAll(async () => {
    restoreFixture();
    h = await launchApp(opts);
  });
  test.afterAll(async () => { await h?.close(); h = null; });
  return () => {
    if (!h) throw new Error("the app is not running (beforeAll failed?)");
    return h;
  };
}

// ── helpers the specs share ──────────────────────────────────────────

/** The rail's three sections (spec 2026-10-09-rail-sections-code D1), a line between each; "chat" (Sessions) only with a host
 *  signed in (local-first A17) or past sessions on disk for its History (install-import B11). */
export const RAIL_SECTIONS = [
  ["notifications", "pulse", "term", "chat"],
  ["todo", "spaces", "files", "routines", "proposals"],
  ["memory", "agent-teams", "agents", "skills", "connectors", "runs"],
];
export const RAIL_ORDER = RAIL_SECTIONS.flat();

export const rail = (win: Page, id: string) => win.locator(`.aos-wb-railbtn[data-tab="${id}"]`);
export const badge = (win: Page, id: string) => rail(win, id).locator(".aos-wb-railbadge");
export const content = (win: Page) => win.locator(".aos-wb-content");
export const drawer = (win: Page) => win.locator(".aos-wb-drawer");

/** Clicks a rail button and waits until the tab is the active one and has drawn something. */
/** Opens the Pulse popup on an area (spec 2026-10-08-pulse-cockpit-design P3): its tile, or the popup's list when it is
 *  already open. Returns the popup. */
export async function pulseArea(win: Page, area: string): Promise<Locator> {
  const modal = win.locator(".modal.mod-pulse");
  if (await modal.count()) await modal.locator(`.aos-pp-navbtn[data-area="${area}"]`).click();
  // Needs you and Brain are cards whose body holds buttons of its own: their head opens the popup.
  else await win.locator(area === "needs" || area === "memory" ? `.aos-pulse-tile[data-area="${area}"] .aos-pulse-tile-headbtn` : `.aos-pulse-tile[data-area="${area}"]`).click();
  await expect(modal.locator(".aos-pp-navbtn.is-on")).toHaveAttribute("data-area", area);
  return modal;
}

/** Closes the Pulse popup when it is open (Esc). */
export async function closePulse(win: Page): Promise<void> {
  if (await win.locator(".modal.mod-pulse").count()) await win.keyboard.press("Escape");
  await expect(win.locator(".modal.mod-pulse")).toHaveCount(0);
}

/** Sets the HUD window's content size, as launchApp does. */
export async function resizeHud(app: ElectronApplication, size: { width: number; height: number }): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://hud/"))?.setContentSize(s.width, s.height), size);
}

/**
 * Lays the page out at `size` whatever the screen, and returns the undo. Electron keeps a window within its screen
 * (setContentSize clamps unless the window was made larger-than-screen), and CI's macOS runners have a 1024 px one, so
 * launchApp's 1480 × 920 is 1024 wide there: a test that needs a layout wider than the screen emulates the viewport.
 */
export async function emulateViewport(win: Page, size: { width: number; height: number }): Promise<() => Promise<void>> {
  const cdp = await win.context().newCDPSession(win);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(size.width);
  return async () => {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
  };
}

export async function openTab(win: Page, id: string): Promise<void> {
  await rail(win, id).click();
  await expect(rail(win, id)).toHaveClass(/is-active/);
  await expect(content(win)).not.toBeEmpty();
}

/** Runs a plugin command by id, as the palette or a hotkey would. */
export async function command(win: Page, id: string): Promise<boolean> {
  return win.evaluate((cmd) => (window as unknown as { aosHost: { app: { commands: { executeCommandById(id: string): boolean } } } }).aosHost.app.commands.executeCommandById(cmd), id);
}

/** The runtime's background cache refreshes the HUD spawns on its own (phase-0 decision: allowed on the next branch). */
export const BACKGROUND_SPAWNS: RegExp[] = [
  /reconcile-sessions\.js/,
  /statusline\.js refresh/,
  /scan-vault\.js --quiet/,
  /aos\.js routines hosts --refresh/,
  /aos\.js skills sync/,
  /aos\.js agents sync/,
  /team\.js list/,
  // The Connectors tab (connectors-tab D10): its check, and the list after a copy. The guard cuts the vault path, so a tail.
  /mcp check --json$/,
  /mcp list --json$/,
];

/** Fails the test when the app raised renderer or main-process errors since `from` (an index into handle.errors). */
export function expectNoErrors(h: AppHandle, from = 0): void {
  expect(h.errors.slice(from), `renderer/main errors:\n${h.errors.slice(from).join("\n")}`).toEqual([]);
}

/** The fixture's day (its `today`, local YYYY-MM-DD), offset by `n` days. */
export function day(n = 0): string {
  // The fixture's own day (restoreFixture keeps it today's), so what a spec expects of its dated lines matches them.
  const [y, m, d] = expected().today.split("-").map(Number);
  return localYmd(new Date(y, m - 1, d + n));
}

/** Text of every element matching `selector` under `scope`, trimmed. */
export async function texts(scope: ReturnType<Page["locator"]>, selector: string): Promise<string[]> {
  return (await scope.locator(selector).allTextContents()).map((t) => t.trim());
}

/** The writes the write guard refused so far (what the HUD tried to write). */
export async function guardWrites(h: AppHandle): Promise<string[]> {
  return (await h.guard()).filter((e) => e.kind === "write").map((e) => e.what);
}

/** Brings the Workbench tab back to the front of the main pane. */
export async function showWorkbench(win: Page): Promise<void> {
  await win.locator(".aos-host-tab", { has: win.locator(".aos-host-tab-title", { hasText: /^Workbench$/ }) }).click();
  await expect(win.locator(".aos-wb-rail")).toBeVisible();
}

/** Closes every note tab (main and split) the specs opened, leaving the Workbench. */
export async function closeNotes(win: Page): Promise<void> {
  const notes = win.locator(".aos-host-tab", { hasNot: win.locator(".aos-host-tab-title", { hasText: /^Workbench$/ }) });
  for (let n = await notes.count(), tries = 0; n > 0 && tries < 50; n = await notes.count(), tries++) {
    // A tab that is already closing (its note saving first: WorkspaceLeaf.detach) can go between count() and the click,
    // which would then wait for a ✕ that is gone. Click whichever is first now; one that closed on its own needs none.
    await notes.first().locator(".aos-host-tab-close").click({ timeout: 2_000 }).catch(() => undefined);
    await expect(notes).not.toHaveCount(n, { timeout: 5_000 }).catch(() => undefined);
  }
  await expect(notes).toHaveCount(0);
  await showWorkbench(win);
}

/** The visible text of the active terminal (xterm's DOM renderer). */
/** What the terminal shows plus every session's scrollback, so output that scrolled out of view still counts. */
export async function terminalText(win: Page): Promise<string> {
  return win.evaluate(() => {
    const visible = Array.from(document.querySelectorAll<HTMLElement>(".aos-wb-content .xterm")).filter((x) => x.offsetParent !== null);
    const rows = visible.map((x) => Array.from(x.querySelectorAll(".xterm-rows > div")).map((r) => r.textContent ?? "").join("\n")).join("\n");
    const pool = (window as unknown as { aosHost?: { plugin?: { terminalPool?: { list(): Array<{ getScrollback(): string }> } } } }).aosHost?.plugin?.terminalPool;
    // Raw pty output: drop the escape sequences (CSI, OSC) and carriage returns.
    const scrollback = (pool?.list() ?? []).map((s) => s.getScrollback()).join("\n")
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b[()][A-Z0-9]/g, "").replace(/\r/g, "");
    return `${rows}\n${scrollback}`;
  });
}

/** The note open in the main pane's active leaf (other note leaves stay in the DOM, hidden). */
const activeLeaf = (win: Page) => win.locator(".aos-host-pane.is-main > .workspace-leaf.is-active");
export const notePath = (win: Page) => activeLeaf(win).locator(".aos-note-path");
export const noteBody = (win: Page) => activeLeaf(win).locator(".aos-note-body");
export const noteBar = (win: Page) => activeLeaf(win).locator(".aos-note-bar");

// ── setup's stand-ins (phase 5; install-import B1): the tools the wizard checks for, its downloads, and the runtime the app carries ──

export const SETUP = {
  root: path.join(ROOT, "setup"),
  /** The wizard's whole PATH ($AOS_SETUP_PATH): stand-ins for node, claude, codex, ollama and curl. uv is missing until the wizard downloads it. */
  bin: path.join(ROOT, "setup", "bin"),
  /** The models the curl stand-in has pulled through /api/pull, one per line; its /api/tags answers with them. */
  models: path.join(ROOT, "setup", "ollama-models.txt"),
  /** A release tree whose cli/aos.js records its calls and writes agenticos.json as `aos init` would. */
  payload: path.join(ROOT, "setup", "payload"),
  calls: path.join(ROOT, "setup", "aos-calls.jsonl"),
  /** What the stand-in's `aos import --dry-run --json` prints (install-import B13); with no file, nothing on this Mac. */
  importScan: path.join(ROOT, "setup", "import-scan.json"),
  /** What the toolchain server serves (uv's stand-in archive) and the development manifest that pins it ($AOS_TOOLCHAIN_MANIFEST). */
  archives: path.join(ROOT, "setup", "archives"),
  manifest: path.join(ROOT, "setup", "toolchain-manifest.json"),
};

/** 16 GB: the e2e Mac's memory, so the wizard's models (local-first A12) are qwen3.5:9b and the embedder on any runner. */
export const SETUP_TOTALMEM = String(16 * 1024 ** 3);

export interface AosCall { argv: string[]; persona: Record<string, unknown> | null; uvBin: string | null }
export const aosCalls = (): AosCall[] => jsonl<AosCall>(SETUP.calls);

/** The toolchain's stand-in downloads, served from 127.0.0.1 as a development manifest may name them. */
export interface ToolchainServer {
  port: number;
  /** Every path asked for, in order. */
  served: string[];
  /** Names whose next download is corrupted (same size, other bytes), once each. */
  corruptNext: Set<string>;
  close(): Promise<void>;
}

/** Serves SETUP.archives/<name> at /<name>; anything else is a 404, so a pin the suite did not stand in for never installs. */
export async function toolchainServer(): Promise<ToolchainServer> {
  const served: string[] = [];
  const corruptNext = new Set<string>();
  const server = http.createServer((req, res) => {
    const name = (req.url ?? "/").slice(1);
    served.push(name);
    const file = path.join(SETUP.archives, path.basename(name));
    if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const bytes = fs.readFileSync(file);
    if (corruptNext.delete(name)) bytes[0] ^= 0xff;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length }).end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, served, corruptNext, close: () => new Promise((resolve) => { server.close(() => resolve()); }) };
}

/**
 * The development manifest (src/main/setup/toolchain.ts loadManifest): every tool served by `port`, unsigned. uv's
 * archive is a stand-in built here (uv answers `uv <pinned version>`); the others point at nothing, with the shipped
 * pins' hashes, so a click on them fails rather than installs.
 */
export function writeToolchainManifest(port: number): { uv: { size: number; sha256: string } } {
  const shipped = JSON.parse(fs.readFileSync(path.join(REPO, "src", "main", "setup", "toolchain-manifest.json"), "utf8")) as {
    schema: 1; tools: Record<string, { version: string; teamId: string | null; assets: Record<string, { url: string; sha256: string; size: number }> }>;
  };
  const src = path.join(SETUP.archives, "uv-src", "uv-aarch64-apple-darwin");
  fs.mkdirSync(src, { recursive: true });
  for (const [name, out] of [["uv", `uv ${shipped.tools.uv.version} (e2e stand-in)`], ["uvx", "uvx (e2e stand-in)"]]) {
    fs.writeFileSync(path.join(src, name), `#!/bin/sh\necho "${out}"\n`, { mode: 0o755 });
  }
  const archive = path.join(SETUP.archives, "uv");
  const r = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", path.dirname(src), "uv-aarch64-apple-darwin"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
  const bytes = fs.readFileSync(archive);
  const uv = { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  for (const [id, t] of Object.entries(shipped.tools)) {
    t.teamId = null;
    for (const arch of Object.keys(t.assets)) t.assets[arch] = { ...(id === "uv" ? uv : t.assets[arch]), url: `http://127.0.0.1:${port}/${id}` };
  }
  fs.writeFileSync(SETUP.manifest, `${JSON.stringify(shipped, null, 2)}\n`);
  return { uv };
}

/**
 * Writes the stand-ins. The payload's `aos init` copies the pristine fixture's agenticos.json to $AOS_CONFIG with the
 * vault it was given, so the Workbench the wizard ends in is the fixture's; `aos upgrade` moves its version to the
 * payload's and, from before 2.0.0, records the migrations and pins what the vault runs on (cli/migrations.js, the real
 * code); `aos uninstall --host <h>` turns that host off in agenticos.json; `aos import --dry-run --json` prints
 * SETUP.importScan (nothing on this Mac without one) and `aos import` prints its steps and queues the sessions in the
 * vault's import-state.json. `codex` is installed but not logged in (`hosts: false` leaves both CLIs out); uv is missing until the wizard
 * downloads it. Ollama (0.40.4) answers (curl) with no models until /api/pull pulls them.
 */
export function installSetupStubs(version: string, o: { hosts?: boolean } = {}): void {
  fs.rmSync(SETUP.root, { recursive: true, force: true });
  fs.mkdirSync(SETUP.bin, { recursive: true });
  fs.mkdirSync(SETUP.archives, { recursive: true });
  fs.mkdirSync(path.join(SETUP.payload, "cli"), { recursive: true });
  const sh = (name: string, body: string) => fs.writeFileSync(path.join(SETUP.bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, "bin", "node")), path.join(SETUP.bin, "node"));
  if (o.hosts !== false) {
    sh("claude", `case "$1" in --version) echo "2.1.0 (Claude Code)";; auth) echo '{"loggedIn": true, "authMethod": "claude.ai"}';; *) exit 1;; esac`);
    sh("codex", `case "$1" in --version) echo "codex-cli 0.150.0";; login) echo "Not logged in"; exit 1;; *) exit 1;; esac`);
  }
  sh("ollama", `case "$1" in --version) echo "ollama version is 0.40.4";; *) exit 1;; esac`);
  // Ollama's API as the wizard asks it: /api/tags lists what was pulled; a probe that throws its answer away (-o /dev/null)
  // only learns it answers; /api/pull streams Ollama's progress lines for the model in its JSON body and records it.
  sh("curl", `case " $* " in *" -o /dev/null "*) exit 0;; esac
case " $* " in *"/api/pull "*)
  m=; prev=
  for a in "$@"; do [ "$prev" = "--data-binary" ] && m=$(printf '%s' "$a" | /usr/bin/sed -n 's/.*"model":"\\([^"]*\\)".*/\\1/p'); prev=$a; done
  echo '{"status":"pulling manifest"}'
  echo '{"status":"pulling 0123456789abcdef0123","digest":"sha256:0123","total":2000,"completed":1000}'
  echo '{"status":"pulling 0123456789abcdef0123","digest":"sha256:0123","total":2000,"completed":2000}'
  echo "$m" >> "${SETUP.models}"
  echo '{"status":"success"}'
  exit 0;;
esac
printf '{"models":['; sep=
[ -f "${SETUP.models}" ] && while read -r m; do printf '%s{"name":"%s"}' "$sep" "$m"; sep=,; done < "${SETUP.models}"
printf ']}\\n'`);
  fs.writeFileSync(path.join(SETUP.payload, "payload.json"), `${JSON.stringify({ schema: 1, version, commit: null, builtAt: new Date().toISOString(), runtimeDeps: false })}\n`);
  fs.writeFileSync(path.join(SETUP.payload, "package.json"), `${JSON.stringify({ name: "agenticos-workbench", version })}\n`);
  fs.writeFileSync(path.join(SETUP.payload, "cli", "aos.js"), `// e2e stand-in for the payload's cli/aos.js: records the call, then does what init or upgrade would to agenticos.json.
const fs = require("fs");
const argv = process.argv.slice(2);
const at = (f) => argv[argv.indexOf(f) + 1];
const persona = argv.includes("--persona-json") ? JSON.parse(fs.readFileSync(at("--persona-json"), "utf8")) : null;
fs.appendFileSync(${JSON.stringify(SETUP.calls)}, JSON.stringify({ argv, persona, uvBin: process.env.AOS_UV_BIN ?? null }) + "\\n");
const file = process.env.AOS_CONFIG;
if (argv[0] === "init") {
  console.log("preflight: node " + process.version + " (stand-in)");
  console.log("vault: " + at("--vault"));
  const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(FX.pristine, "home", ".claude", "agenticos.json"))}, "utf8"));
  cfg.vault = at("--vault");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\\n");
  if (!argv.includes("--no-superpowers")) for (const h of ["claude", "codex"]) if (at("--host") === h || at("--host") === "both") console.log("   Superpowers " + h + ": installed v" + (h === "claude" ? "7.0.0" : "7.0.1"));
  console.log("done.");
} else if (argv[0] === "upgrade") {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const from = cfg.version;
  cfg.version = ${JSON.stringify(version)};
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\\n");
  // What the real upgrade records for an install from before 2.0.0 (local-first A9, B12), and what it pins in
  // brain/config.json until the owner answers (the model the Chief of Staff ran on, no failover), by the real code.
  const M = require(${JSON.stringify(path.join(REPO, "..", "cli", "migrations.js"))});
  const added = M.recordPending({ vault: cfg.vault, from });
  if (added.length) console.log("pending: " + added.join(", "));
  const kept = M.pinPrevious({ vault: cfg.vault, from });
  if (kept.length) console.log("kept until you answer: " + kept.join(", "));
  console.log("upgraded to v" + cfg.version);
} else if (argv[0] === "uninstall" && argv[1] === "--host") {
  // An earlier install's host taken out (inspection F7): agenticos.json says it is off.
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.hosts[at("--host")].enabled = false;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\\n");
  console.log("hosts now: " + ["claude", "codex"].filter((h) => cfg.hosts[h] && cfg.hosts[h].enabled).join(", "));
} else if (argv[0] === "import") {
  let scan;
  try { scan = JSON.parse(fs.readFileSync(${JSON.stringify(SETUP.importScan)}, "utf8")); } catch {
    scan = { schema: 1, dryRun: true, since: "90d", windowDays: 90, from: ["claude", "codex"], engine: { ready: false, provider: "none", model: null, reason: "forced" },
      hosts: { claude: { present: false, configDir: "~/.claude" }, codex: { present: false, configDir: "~/.codex" } }, projects: { proposals: [] } };
  }
  if (argv.includes("--dry-run")) { process.stdout.write(JSON.stringify(scan)); process.exit(0); }
  // The fast phase, printed as cli/import.js prints it, then the sessions queued in the vault's import-state.json.
  const from = !argv.includes("--from") || at("--from") === "all" ? ["claude", "codex"] : [at("--from")];
  const only = argv.includes("--only") ? at("--only").split(",") : ["instructions", "memories", "projects", "mcp", "sessions"];
  const label = { claude: "Claude Code", codex: "Codex" };
  console.log("import: the last 90 days of " + from.map((h) => label[h]).join(" and "));
  if (only.includes("instructions")) for (const h of from) console.log("- instructions (" + label[h] + "): " + ((scan.hosts[h] || {}).instructions || { rules: 0 }).rules + " written, 0 already in the vault");
  if (only.includes("memories")) for (const h of from) console.log("- memories (" + label[h] + "): " + ((scan.hosts[h] || {}).memories || { files: 0 }).files + " written, 0 already in the vault");
  const accept = argv.includes("--accept") ? JSON.parse(at("--accept")) : [];
  if (only.includes("projects")) console.log("- projects: " + scan.projects.proposals.length + " proposed, " + accept.length + " created, 0 linked");
  if (only.includes("mcp")) console.log("- mcp: " + from.map((h) => ((scan.hosts[h] || {}).mcp || { servers: 0 }).servers + " on " + label[h]).join(", ") + " listed");
  const sessions = only.includes("sessions") ? from.reduce((n, h) => n + ((scan.hosts[h] || {}).sessions || 0), 0) : 0;
  if (only.includes("sessions")) console.log("- sessions: " + sessions + " queued for the digest (" + sessions + " waiting in all)");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const at0 = new Date().toISOString();
  const state = { schema: 1, phases: from.map((h) => ({ phase: "mcp", host: h, done: true, cursor: null, counts: { servers: ((scan.hosts[h] || {}).mcp || { servers: 0 }).servers }, at: at0 })), hashes: {}, files: {},
    digest: sessions ? { since: "90d", processed: 0, total: sessions, done: false, finishedAt: null, lastRun: null, queue: Array.from({ length: sessions }, (_, i) => ({ key: "s" + i })) } : null,
    runs: [{ at: at0, from, only, since: "90d", written: 0 }] };
  fs.mkdirSync(require("path").join(cfg.vault, "brain", "_index"), { recursive: true });
  fs.writeFileSync(require("path").join(cfg.vault, "brain", "_index", "import-state.json"), JSON.stringify(state, null, 2) + "\\n");
} else process.exit(2);
`);
}
