// routines.ts — the plugin-side mirror of brain/scripts/lib/routines-store.js: parse, validate and
// serialize <vault>/brain/routines/<slug>.md, read brain/_index/routines.json, and compute the rows
// the Routines tab renders (next fire times, health). Pure core; only the two loaders touch Obsidian.
// The frontmatter subset (scalars, quoted strings, single-line flow arrays) and the key order are
// the runtime's, so a file this module writes is a file run-routine.js reads — both sides are checked
// against brain/scripts/test/fixtures/routines/*.
import type { App } from "obsidian";
import * as path from "path";
import { describe, next, validateCron } from "./cron";
import { fs, utf8 } from "../host";
import { dutyWritesRefusal, localOutputRefusal, localWritesRefusal } from "../../../brain/scripts/lib/write-areas";

export const ROUTINES_DIR = "brain/routines";
export const ROUTINES_STATE_PATH = "brain/_index/routines.json";
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const KINDS = ["duty", "prompt", "command"] as const;
export const EFFORTS = ["low", "medium", "high"] as const;
/** Where a prompt routine runs (local-first A6): the local agent runner, or one host's CLI. */
export const ENGINES = ["local", "claude", "codex"] as const;
export const MAX_TURNS_LIMIT = 200;
export type RoutineKind = typeof KINDS[number];
export type Effort = typeof EFFORTS[number];
export type RoutineEngine = typeof ENGINES[number];
export const KEY_ORDER = ["schema", "name", "kind", "schedule", "enabled", "guarded", "engine", "model", "effort", "budgetUsd", "maxTurns", "tools", "writes", "output", "argv", "timeoutSec", "tags"];

export type Scalar = string | number | boolean | null;
export type Frontmatter = Record<string, Scalar | Scalar[]>;

export interface Routine {
  slug: string;
  schema?: number;
  name?: string;
  kind?: RoutineKind | string;
  schedule?: string;
  enabled?: boolean;
  guarded?: boolean;
  // prompt only (local-first A6): local | claude | codex. Absent: routines.runner decides, as before.
  engine?: RoutineEngine | string;
  // prompt and duty: the model and the effort for that routine's run; on a duty they override the schedule's. The model
  // is one of the routine's engine, and a Claude model when it names none.
  model?: string;
  effort?: string;
  budgetUsd?: number;
  // prompt: the local agent's turn limit (default 24).
  maxTurns?: number;
  // duty only: the PERSONA_TOOLS allowlist for that duty's run (the runner expands {{NODE}} and {{VAULT}} in it).
  tools?: string;
  // duty: vault-relative paths the duty may write on top of the default scope (brain/scripts/persona/duty-guard.js).
  // prompt: the paths or globs the local agent may write, and nothing else (brain/scripts/lib/local-agent.js).
  writes?: string[];
  // prompt: where the local agent's final message goes — log, notify, or a vault-relative .md file.
  output?: string;
  argv?: string[];
  timeoutSec?: number;
  tags?: string[];
  body: string;
  errors: string[];
}

export interface RoutineStateEntry {
  lastRunAt: string | null; lastExit: number | null; lastCostUsd: number | null; lastDurationMs: number | null;
  failStreak: number; lastTrigger: string | null; lastError: string | null;
  lastSkippedAt?: string | null; lastSkipReason?: string | null;
}
export interface RoutinesState { schema: number; routines: Record<string, RoutineStateEntry>; synced: Record<string, string>; syncedAt: string | null }

export type RoutineHealth = "ok" | "off" | "stale" | "failed" | "missed" | "invalid";
export interface RoutineRow {
  routine: Routine;
  cadence: string;
  next: Date[];
  last: RoutineStateEntry | null;
  health: RoutineHealth;
}

// ── frontmatter ──

function parseScalar(text: string): Scalar {
  const t = text.trim();
  if (t === "" || t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return t;
}

export function parseFlowArray(text: string): Scalar[] {
  const inner = text.trim().slice(1, -1);
  const items: string[] = [];
  let cur = "", quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) { cur += inner[++i]; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") { quote = ch; cur += ch; }
    else if (ch === ",") { items.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim() !== "" || items.length) items.push(cur);
  return items.map(parseScalar).filter((v) => v !== null);
}

export function parseRoutineFrontmatter(content: string): { frontmatter: Frontmatter; body: string; hasFrontmatter: boolean } {
  const text = String(content ?? "");
  if (!text.startsWith("---")) return { frontmatter: {}, body: text, hasFrontmatter: false };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: text, hasFrontmatter: false };
  const block = text.slice(4, end);
  const fm: Frontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const val = m[2].trim();
    fm[m[1]] = val.startsWith("[") && val.endsWith("]") ? parseFlowArray(val) : parseScalar(val);
  }
  return { frontmatter: fm, body: text.slice(end + 4).replace(/^(\r?\n)+/, ""), hasFrontmatter: true };
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
function serializeScalar(v: Scalar | undefined): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  if (/^[A-Za-z][A-Za-z0-9 _./-]*$/.test(s) && !["true", "false", "null"].includes(s)) return s;
  return quote(s);
}
export function serializeRoutineFrontmatter(fm: Frontmatter): string {
  const keys = [...KEY_ORDER.filter((k) => k in fm), ...Object.keys(fm).filter((k) => !KEY_ORDER.includes(k))];
  const lines: string[] = [];
  for (const k of keys) {
    const v = fm[k];
    if (v === undefined) continue;
    lines.push(Array.isArray(v) ? `${k}: [${v.map(serializeScalar).join(", ")}]` : `${k}: ${serializeScalar(v)}`);
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

// ── routines ──

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
const isMoney = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** Where a routine may never write, and why: the runners' own rule (brain/scripts/lib/write-areas.js, imported as it is,
 *  never copied), so the editor refuses before saving what duty-guard.js or the local agent would refuse when it runs. */
export { LOCAL_DENY, localDenied } from "../../../brain/scripts/lib/write-areas";

/** A vault-relative path (or glob): not absolute, no `..` segment, no backslash. */
export function isVaultRel(p: unknown): boolean {
  const s = String(p ?? "").trim();
  return !!s && !s.startsWith("/") && !s.startsWith("~") && !s.includes("\\") && !s.split("/").includes("..");
}

/** Human-readable problems; empty means valid. Mirrors routines-store.js validate() rule for rule. */
export function validateRoutine(r: Partial<Routine>): string[] {
  const errors: string[] = [];
  if (!SLUG_RE.test(String(r.slug ?? ""))) errors.push('slug must be 2-41 chars of a-z, 0-9 and "-" and start with a letter or digit');
  if (r.schema !== 1) errors.push("schema must be 1");
  if (typeof r.name !== "string" || !r.name.trim()) errors.push("name is required");
  if (!(KINDS as readonly string[]).includes(String(r.kind))) errors.push(`kind must be one of ${KINDS.join(", ")}`);
  if (typeof r.schedule !== "string" || !r.schedule.trim()) errors.push("schedule is required");
  else { const e = validateCron(r.schedule); if (e) errors.push(`schedule: ${e}`); }
  if (typeof r.enabled !== "boolean") errors.push("enabled must be true or false");
  if (r.guarded !== undefined && typeof r.guarded !== "boolean") errors.push("guarded must be true or false");
  if (r.timeoutSec !== undefined && !(Number.isInteger(r.timeoutSec) && (r.timeoutSec as number) > 0)) errors.push("timeoutSec must be a positive integer");
  if (r.tags !== undefined && !isStringArray(r.tags)) errors.push("tags must be an array of strings");
  if (r.kind === "prompt" || r.kind === "duty") {
    if (r.model !== undefined && (typeof r.model !== "string" || !r.model.trim())) errors.push("model must be a string");
    if (r.effort !== undefined && !(EFFORTS as readonly string[]).includes(String(r.effort))) errors.push(`effort must be one of ${EFFORTS.join(", ")}`);
  }
  if (r.engine !== undefined) {
    if (r.kind !== "prompt") errors.push("engine is for prompt routines only");
    else if (!(ENGINES as readonly string[]).includes(String(r.engine)) || typeof r.engine !== "string") errors.push(`engine must be one of ${ENGINES.join(", ")}`);
  }
  if (r.kind === "prompt") {
    if (typeof r.body !== "string" || !r.body.trim()) errors.push("a prompt routine needs a body");
    if (r.budgetUsd !== undefined && !isMoney(r.budgetUsd)) errors.push("budgetUsd must be a non-negative number");
    if (r.maxTurns !== undefined && !(Number.isInteger(r.maxTurns) && (r.maxTurns as number) > 0 && (r.maxTurns as number) <= MAX_TURNS_LIMIT)) errors.push(`maxTurns must be a whole number from 1 to ${MAX_TURNS_LIMIT}`);
    if (r.writes !== undefined && (!isStringArray(r.writes) || r.writes.some((w) => !isVaultRel(w) || w.includes(",")))) errors.push("writes must be an array of vault-relative paths or globs (no commas)");
    if (r.output !== undefined && !(r.output === "log" || r.output === "notify" || (typeof r.output === "string" && /\.md$/.test(r.output) && isVaultRel(r.output)))) errors.push("output must be log, notify or a vault-relative .md file");
    // An entry or a file that is a vault-relative path, checked against the rule its runner applies (one message each).
    for (const w of isStringArray(r.writes) ? r.writes.filter((x) => isVaultRel(x) && !x.includes(",")) : []) { const why = localWritesRefusal(w); if (why) errors.push(`writes: ${w} is off limits to a local routine (${why})`); }
    if (typeof r.output === "string" && /\.md$/.test(r.output) && isVaultRel(r.output)) { const why = localOutputRefusal(r.output); if (why) errors.push(`output: ${r.output} is off limits to a local routine (${why})`); }
  }
  if (r.kind === "duty") {
    if (r.budgetUsd !== undefined && !isMoney(r.budgetUsd)) errors.push("budgetUsd must be a non-negative number");
    if (r.tools !== undefined && (typeof r.tools !== "string" || !r.tools.trim())) errors.push("tools must be a non-empty string");
    if (r.writes !== undefined && (!isStringArray(r.writes) || r.writes.some((w) => !w.trim() || w.includes(",")))) errors.push("writes must be an array of vault-relative paths (no commas)");
    for (const w of isStringArray(r.writes) ? r.writes.filter((x) => x.trim() && !x.includes(",")) : []) { const why = dutyWritesRefusal(w); if (why) errors.push(`writes: ${w} is off limits to a duty (${why})`); }
  }
  if (r.kind === "command") {
    if (!isStringArray(r.argv) || r.argv.length === 0) errors.push("a command routine needs argv: a non-empty array of strings");
  }
  return errors;
}

export function routineFromFile(slug: string, content: string): Routine {
  const { frontmatter, body, hasFrontmatter } = parseRoutineFrontmatter(content);
  const routine = { slug, ...(frontmatter as Record<string, unknown>), body } as unknown as Omit<Routine, "errors">;
  const errors = hasFrontmatter ? validateRoutine(routine as Partial<Routine>) : ["no frontmatter block"];
  return { ...routine, errors } as Routine;
}

export function routineToFile(routine: Omit<Routine, "errors"> & { errors?: string[] }): string {
  const { slug, body, errors, ...fm } = routine;   // eslint-disable-line @typescript-eslint/no-unused-vars
  void slug; void errors;
  const text = String(body ?? "").replace(/\s+$/, "");
  return serializeRoutineFrontmatter(fm as Frontmatter) + (text ? `\n${text}\n` : "");
}

/** What the installed schedule depends on (kind|schedule|on/off) — a mismatch with the last sync means "stale". */
export function fingerprint(r: Pick<Routine, "kind" | "schedule" | "enabled">): string {
  return `${r.kind}|${String(r.schedule ?? "").trim().replace(/\s+/g, " ")}|${r.enabled ? "on" : "off"}`;
}

export function emptyState(): RoutinesState { return { schema: 1, routines: {}, synced: {}, syncedAt: null }; }
export function parseState(raw: string | null): RoutinesState {
  try {
    const parsed = JSON.parse(raw ?? "") as Partial<RoutinesState>;
    if (parsed && typeof parsed === "object" && parsed.routines && typeof parsed.routines === "object") return { ...emptyState(), ...parsed, schema: 1 };
  } catch { /* missing or corrupt */ }
  return emptyState();
}

export function health(r: Routine, entry: RoutineStateEntry | null, now: Date, opts: { missedGraceMs?: number; synced?: string; syncedAt?: string | null } = {}): RoutineHealth {
  const grace = opts.missedGraceMs ?? 15 * 60_000;
  if (r.errors.length) return "invalid";
  if (!r.enabled) return "off";
  if (opts.synced !== undefined && opts.synced !== fingerprint(r)) return "stale";
  if (entry && typeof entry.lastExit === "number" && entry.lastExit !== 0) return "failed";
  const from = entry?.lastRunAt ? new Date(entry.lastRunAt) : opts.syncedAt ? new Date(opts.syncedAt) : null;
  if (from && r.schedule) {
    const due = next(r.schedule, from, 1)[0];
    if (due && now.getTime() - due.getTime() > grace) return "missed";
  }
  return "ok";
}

// ── duty log fallback (spec host-routines D1; mirrors routines-store.js dutyLogLast/mergeDutyLog) ──

export const DUTY_LOG_DIR = "persona/journal/logs";
export interface DutyLogRun { at: string; exit: number }

/** The tail of duty-<slug>.log plus the file's mtime → the last completed run, or null when the last line is a `start`. */
export function parseDutyLogTail(tail: string, mtimeIso: string): DutyLogRun | null {
  const lines = String(tail ?? "").replace(/\s+$/, "").split("\n");
  const m = /duty=\S+ done \(exit (\d+)\)$/.exec(lines[lines.length - 1]);
  return m ? { at: mtimeIso, exit: Number(m[1]) } : null;
}

/** Reads the last 4 KiB of <vault>/persona/journal/logs/duty-<slug>.log; null when absent, empty or unreadable. */
export function readDutyLogLast(vaultRoot: string, slug: string): DutyLogRun | null {
  if (!SLUG_RE.test(slug)) return null;
  const file = path.join(vaultRoot, DUTY_LOG_DIR, `duty-${slug}.log`);
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || !st.size) return null;
    const len = Math.min(st.size, 4096);
    return parseDutyLogTail(utf8(fs.readBytesSync(file, st.size - len, len)), new Date(st.mtimeMs).toISOString());
  } catch { return null; }
}

/** A duty's entry, or one synthesized from its log when the log's run end falls after the recorded run's window
 *  (start + duration + a minute of slack): a run that bypassed run-routine.js, shown with trigger "duty-log". */
export function mergeDutyLog(routine: Pick<Routine, "kind">, entry: RoutineStateEntry | null, log: DutyLogRun | null | undefined): RoutineStateEntry | null {
  if (routine.kind !== "duty" || !log) return entry;
  if (entry?.lastRunAt) {
    const end = Date.parse(entry.lastRunAt) + (Number(entry.lastDurationMs) || 0) + 60_000;
    if (Date.parse(log.at) <= end) return entry;
  }
  const prevStreak = entry && Number.isFinite(entry.failStreak) ? entry.failStreak : 0;
  return {
    ...(entry ?? {}),
    lastRunAt: log.at, lastExit: log.exit, lastCostUsd: null, lastDurationMs: null,
    failStreak: log.exit === 0 ? 0 : prevStreak + 1, lastTrigger: "duty-log", lastError: log.exit === 0 ? null : `exit ${log.exit} (from the duty log)`,
  };
}

export function buildRows(routines: Routine[], state: RoutinesState, now = new Date(), dutyLogs: Record<string, DutyLogRun | null> = {}): RoutineRow[] {
  return routines.map((r) => {
    const entry = mergeDutyLog(r, state.routines[r.slug] ?? null, dutyLogs[r.slug]);
    const valid = r.errors.length === 0;
    return {
      routine: r,
      cadence: valid && r.schedule ? describe(r.schedule) : String(r.schedule ?? ""),
      next: valid && r.enabled && r.schedule ? next(r.schedule, now, 3) : [],
      last: entry && entry.lastRunAt ? entry : null,
      health: health(r, entry, now, { synced: state.synced[r.slug], syncedAt: state.syncedAt }),
    };
  });
}

/** A skip newer than the last run (the local engine down, a capped day: run-routine.js records lastSkippedAt and why),
 *  for the row's last-run cell; null when the last thing that happened was a run, or nothing. */
export function lastSkip(entry: RoutineStateEntry | null | undefined): { at: string; reason: string; short: string } | null {
  if (!entry || !entry.lastSkippedAt || !entry.lastSkipReason) return null;
  const skipped = Date.parse(entry.lastSkippedAt);
  if (!Number.isFinite(skipped) || (entry.lastRunAt && Date.parse(entry.lastRunAt) >= skipped)) return null;
  const reason = String(entry.lastSkipReason);
  return { at: entry.lastSkippedAt, reason, short: reason.split(/[:(]/)[0].trim() || reason };
}

/** Enabled routines whose fingerprint differs from the last sync, plus synced slugs with no file: "apply schedules" is due. */
export function schedulesOutOfDate(routines: Routine[], state: RoutinesState): string[] {
  const out: string[] = [];
  for (const r of routines) {
    if (r.errors.length) continue;
    const want = r.enabled ? fingerprint(r) : undefined;
    if (state.synced[r.slug] !== want) out.push(r.slug);
  }
  for (const slug of Object.keys(state.synced)) if (!routines.some((r) => r.slug === slug)) out.push(slug);
  return out;
}

// ── IO ──

export async function listRoutines(app: App): Promise<Routine[]> {
  const adapter = app.vault.adapter;
  let files: string[] = [];
  try { files = (await adapter.list(ROUTINES_DIR)).files.filter((f) => f.endsWith(".md") && !f.split("/").pop()!.startsWith(".") && f.split("/").pop()!.toLowerCase() !== "readme.md"); } catch { return []; }
  const out: Routine[] = [];
  for (const f of files.sort()) {
    const slug = f.split("/").pop()!.replace(/\.md$/, "");
    try { out.push(routineFromFile(slug, await adapter.read(f))); } catch (e) { out.push({ slug, body: "", errors: [`unreadable: ${e instanceof Error ? e.message : String(e)}`] }); }
  }
  return out;
}

export async function readRoutinesState(app: App): Promise<RoutinesState> {
  try { return parseState(await app.vault.adapter.read(ROUTINES_STATE_PATH)); } catch { return emptyState(); }
}
