// agentSessions.ts — what the Sessions tab shows of an agent session (spec 2026-10-07-unidex-sessions S10, §4.2, §4.5;
// spec 2026-10-07-sessions-ux U1–U11). Pure: the threads grouped by workspace, a thread's events as timeline rows (tool
// calls as a verb and a target, the latest plan of a turn, a marker where the model, effort or access changed), a turn's
// footer and elapsed time, the repository card's summary and +/− totals, the day's session spend, which hosts the
// composer offers, and the host and model menu's, access menu's and `/` menu's choices from the host catalog. The
// app's main runs the turns and keeps the threads; views/SessionsTab.ts reaches them through the HudHost (host.ts
// sessions and git).
import type { AgenticosJson, ProviderState, SessionHost } from "./aosConfig";
import { sessionHosts } from "./aosConfig";
import { ago } from "./notifications";
import type { HostCatalog, HostCatalogHost, HostGitStatus, HostSessionAccess, HostSessionEvent, HostSessionThread } from "../host";

export const HOST_LABEL: Record<SessionHost, string> = { claude: "Claude Code", codex: "Codex" };
/** What the composer says in place of Allow commands on a Codex thread (spec S5). */
export const CODEX_SANDBOX_NOTE = "Codex runs commands in its sandbox";

/** Folder names under <vault>/workspaces a session may run in: not hidden (`.git`) and not the team worktrees (`_…`). */
export function workspaceNames(names: string[]): string[] {
  return names.filter((n) => !!n && !n.startsWith(".") && !n.startsWith("_")).sort((a, b) => a.localeCompare(b));
}

export interface ThreadGroup { workspace: string; threads: HostSessionThread[] }

/** Threads by workspace, newest first within each, and the workspace with the newest thread first. */
export function groupThreads(threads: HostSessionThread[]): ThreadGroup[] {
  const newest = (a: HostSessionThread, b: HostSessionThread) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0);
  const by = new Map<string, HostSessionThread[]>();
  for (const t of [...threads].sort(newest)) {
    const list = by.get(t.workspace) ?? [];
    list.push(t);
    by.set(t.workspace, list);
  }
  return [...by.entries()].map(([workspace, list]) => ({ workspace, threads: list }));
}

/** Dollars as the HUD shows them: four places under a cent, else two. */
export function usdText(usd: number): string {
  return `$${usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** A thread's line under its title in the list: turns and spend (Codex's is an estimate). */
export function threadMeta(t: HostSessionThread): string {
  const turns = `${t.turns} turn${t.turns === 1 ? "" : "s"}`;
  return t.usd > 0 ? `${turns} · ${t.host === "codex" ? "≈" : ""}${usdText(t.usd)}` : turns;
}

export interface ToolCall { name: string; toolKind: string; filePath: string | null; summary: string }

/** A tool row collapsed to one line: `kind · name · file`. */
export function toolLine(t: ToolCall): string {
  return [t.toolKind || "other", t.name, t.filePath].filter((s) => !!s).join(" · ");
}

export type TimelineRow =
  | { kind: "prompt"; turn: number; text: string }
  | { kind: "text"; turn: number; text: string }
  | { kind: "tool"; turn: number; key: string; tool: ToolCall; result: { ok: boolean; summary: string } | null }
  | { kind: "patch"; turn: number; files: { path: string; change: string }[] }
  | { kind: "error"; turn: number; message: string }
  | { kind: "done"; turn: number; ok: boolean; footer: string };

export type PlanStatus = "pending" | "active" | "done";
export interface PlanItem { text: string; status: PlanStatus }

/** The reader's rows (spec 2026-10-07-sessions-ux U1, U6, U10): TimelineRow's, a tool with its `⏺ Verb(target)` line,
 *  a finished turn with its length, the turn's plan, and a marker where the next turn's model, effort or access changed. */
export type ThreadRow =
  | Extract<TimelineRow, { kind: "prompt" | "text" | "patch" | "error" }>
  | (Extract<TimelineRow, { kind: "tool" }> & { verb: string; target: string })
  | (Extract<TimelineRow, { kind: "done" }> & { ms: number | null })
  | { kind: "plan"; turn: number; items: PlanItem[] }
  | { kind: "change"; turn: number; model: string | null; effort: string | null; access: HostSessionAccess | null; text: string };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A turn's quiet footer: what it cost ("estimated" for Codex), its tokens, and whether it failed. */
export function doneFooter(done: HostSessionEvent, usage: HostSessionEvent | null): string {
  const usd = num(done.usd) ?? num(usage?.usd);
  const parts: string[] = [];
  if (done.ok !== true) parts.push("did not finish");
  parts.push(usd === null ? "no cost recorded" : `${usdText(usd)}${done.estimated === true ? " estimated" : ""}`);
  const tin = num(usage?.in);
  const tout = num(usage?.out);
  if (tin !== null || tout !== null) parts.push(`${(tin ?? 0).toLocaleString("en-US")} in · ${(tout ?? 0).toLocaleString("en-US")} out`);
  return parts.join(" · ");
}

/** `p` under `root` as a relative path; anything else as it is. Claude names files absolutely, the reader shows them
 *  from the workspace. */
export function relPath(p: string, root?: string | null): string {
  if (!root) return p;
  const base = root.replace(/\/+$/, "");
  return p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p;
}

/** One string field of a tool's input summary. The runtime clips the summary at 400 characters, so a long input is not
 *  valid JSON any more: the field is then read out of the text. */
function inputField(summary: string, keys: string[]): string {
  let input: unknown = null;
  try { input = JSON.parse(summary); } catch { /* clipped, or not JSON */ }
  for (const k of keys) {
    if (input && typeof input === "object") {
      const v = (input as Record<string, unknown>)[k];
      if (typeof v === "string" && v) return v;
      continue;
    }
    // An unclosed value is one the clip cut: it runs to the end, ellipsis and all.
    const m = new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)`).exec(summary);
    if (m) {
      try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1].replace(/\\(.)/g, "$1"); }
    }
  }
  return "";
}

/** Codex runs a command as `<shell> -lc '<command>'`: the command alone. */
function unwrapShell(cmd: string): string {
  const m = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(cmd.trim());
  return m ? m[2] : cmd;
}

/** Claude Code's word for each of its tools, and the input field that names its target. */
const TOOL_VERBS: Record<string, { verb: string; keys: string[] }> = {
  Read: { verb: "Read", keys: [] },
  Write: { verb: "Write", keys: [] },
  Edit: { verb: "Update", keys: [] },
  MultiEdit: { verb: "Update", keys: [] },
  NotebookEdit: { verb: "Update", keys: [] },
  Bash: { verb: "Bash", keys: ["command"] },
  Grep: { verb: "Search", keys: ["pattern"] },
  Glob: { verb: "Search", keys: ["pattern"] },
  LS: { verb: "List", keys: ["path"] },
  WebFetch: { verb: "Fetch", keys: ["url"] },
  WebSearch: { verb: "Web search", keys: ["query"] },
  Task: { verb: "Task", keys: ["description"] },
  Agent: { verb: "Agent", keys: ["description"] },
  Skill: { verb: "Skill", keys: ["skill", "command"] },
};

/**
 * A tool call as Claude Code shows it, `⏺ Verb(target)`: Read and Update (Write for a new file) with the file, Bash with
 * the command (Claude's Bash and Codex's shell alike), Search with the pattern (Grep, Glob), an MCP tool as
 * `server/tool` with its arguments, and any other tool by its name with its first plain field.
 */
export function toolCallLine(t: ToolCall, root?: string | null): { verb: string; target: string } {
  const file = t.filePath ? relPath(t.filePath, root) : "";
  if (t.toolKind === "mcp" || t.name.startsWith("mcp__")) {
    const [, server = "mcp", ...rest] = t.name.split("__");
    const args = t.summary && t.summary !== "{}" ? oneLine(t.summary, 80) : "";
    return { verb: `${server}/${rest.join("__") || "call"}`, target: args };
  }
  const known = TOOL_VERBS[t.name];
  if (t.toolKind === "bash" || t.name === "shell") {
    const cmd = inputField(t.summary, ["command"]) || unwrapShell(t.summary);
    return { verb: "Bash", target: oneLine(cmd, 120) };
  }
  if (known && (t.name === "Grep" || t.name === "Glob")) {
    const pattern = inputField(t.summary, ["pattern"]);
    const where = inputField(t.summary, ["path"]);
    return { verb: known.verb, target: oneLine(where ? `${pattern} in ${relPath(where, root)}` : pattern, 120) };
  }
  if (t.toolKind === "read") return { verb: "Read", target: file };
  if (t.toolKind === "edit") return { verb: t.name === "Write" ? "Write" : "Update", target: file };
  if (known) return { verb: known.verb, target: file || oneLine(inputField(t.summary, known.keys), 120) };
  const field = inputField(t.summary, ["description", "path", "query", "url", "command", "prompt"]);
  return { verb: t.name || "Tool", target: file || oneLine(field, 120) };
}

/** `+a −b` for a file or a set of files; "" when the counts are unknown (a binary file). */
export function countsText(c: { added: number | null; removed: number | null }): string {
  return c.added === null || c.removed === null ? "" : `+${c.added} −${c.removed}`;
}

/**
 * A tool call's `⎿` line: nothing while it runs; the first words of a failure; for an edit, the file's +/− against
 * HEAD from git status when the tab has them (U10: the same for both hosts); else the start of what it returned.
 */
export function toolResultText(row: Extract<ThreadRow, { kind: "tool" }>, counts?: { added: number | null; removed: number | null } | null): string | null {
  const r = row.result;
  if (!r) return null;
  if (!r.ok) return oneLine(r.summary, 120) || "Failed";
  if (row.tool.toolKind === "read") return "Read the file";
  if (row.tool.toolKind === "edit") {
    const c = counts ? countsText(counts) : "";
    return c ? `${c} · open to see the file's diff` : "Done";
  }
  return oneLine(r.summary, 120) || "Done";
}

/** The model, effort and access a prompt event recorded; a field an older thread's prompt lacks is undefined. */
function choiceOf(e: HostSessionEvent): { model?: string | null; effort?: string | null; access?: HostSessionAccess } {
  const out: { model?: string | null; effort?: string | null; access?: HostSessionAccess } = {};
  if ("model" in e) out.model = str(e.model) || null;
  if ("effort" in e) out.effort = str(e.effort) || null;
  if ("access" in e && isAccess(e.access)) out.access = e.access;
  return out;
}

export interface ThreadRowOptions {
  /** The thread's host and its catalog entry, to name models in the change marker. */
  host?: SessionHost;
  catalog?: HostCatalogHost | null;
  /** The workspace's folder: file paths under it show relative. */
  root?: string | null;
}

/**
 * A thread's events as the reader draws them: each tool with its line and the result of the same id folded in; only
 * the latest plan of a turn, where that turn's first plan was; before a prompt whose model, effort or access differ
 * from the previous prompt's, a "Next turn on …" marker (a field only one of the two recorded is no change); a turn's
 * usage folded into its footer, with the turn's length; and the host's session id (resume bookkeeping) left out.
 */
export function threadRows(events: HostSessionEvent[], opts: ThreadRowOptions = {}): ThreadRow[] {
  const host = opts.host ?? "claude";
  const rows: ThreadRow[] = [];
  const tools = new Map<string, Extract<ThreadRow, { kind: "tool" }>>();
  const plans = new Map<number, Extract<ThreadRow, { kind: "plan" }>>();
  const usage = new Map<number, HostSessionEvent>();
  const started = new Map<number, string>();
  let last: ReturnType<typeof choiceOf> | null = null;
  events.forEach((e, i) => {
    const turn = typeof e.turn === "number" ? e.turn : 0;
    if (e.kind === "prompt") {
      const now = choiceOf(e);
      if (last) {
        const prev = last;
        const differs = (k: "model" | "effort" | "access") => k in prev && k in now && prev[k] !== now[k];
        if (differs("model") || differs("effort") || differs("access")) {
          const model = "model" in now ? now.model ?? null : prev.model ?? null;
          const effort = "effort" in now ? now.effort ?? null : prev.effort ?? null;
          const access = now.access ?? prev.access ?? null;
          const parts = [choiceText(host, opts.catalog ?? null, model, effort)];
          if (differs("access") && access) parts.push(accessLabel(access));
          rows.push({ kind: "change", turn, model, effort, access, text: `Next turn on ${parts.join(" · ")}` });
        }
      }
      last = { ...(last ?? {}), ...now };
      if (!started.has(turn)) started.set(turn, e.t);
      rows.push({ kind: "prompt", turn, text: str(e.text) });
    } else if (e.kind === "text") rows.push({ kind: "text", turn, text: str(e.text) });
    else if (e.kind === "tool") {
      const id = str(e.id);
      const tool: ToolCall = { name: str(e.name), toolKind: str(e.toolKind), filePath: str(e.filePath) || null, summary: str(e.summary) };
      const row: Extract<ThreadRow, { kind: "tool" }> = { kind: "tool", turn, key: `${turn}:${id || i}`, result: null, tool, ...toolCallLine(tool, opts.root) };
      if (id) tools.set(`${turn}:${id}`, row);
      rows.push(row);
    } else if (e.kind === "tool_result") {
      const row = tools.get(`${turn}:${str(e.id)}`);
      if (row) row.result = { ok: e.ok !== false, summary: str(e.summary) };
    } else if (e.kind === "plan") {
      const items = planItems(e.items);
      const row = plans.get(turn);
      if (row) row.items = items;
      else {
        const fresh: Extract<ThreadRow, { kind: "plan" }> = { kind: "plan", turn, items };
        plans.set(turn, fresh);
        rows.push(fresh);
      }
    } else if (e.kind === "patch") {
      const files = Array.isArray(e.files) ? (e.files as Array<Record<string, unknown>>).map((f) => ({ path: str(f?.path), change: str(f?.change) || "update" })) : [];
      rows.push({ kind: "patch", turn, files });
    } else if (e.kind === "usage") usage.set(turn, e);
    else if (e.kind === "error") rows.push({ kind: "error", turn, message: str(e.message) || str(e.error) || "error" });
    else if (e.kind === "done") {
      const from = Date.parse(started.get(turn) ?? "");
      const to = Date.parse(e.t);
      const ms = Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : null;
      rows.push({ kind: "done", turn, ok: e.ok === true, footer: doneFooter(e, usage.get(turn) ?? null), ms });
    }
  });
  return rows;
}

const PLAN_STATUSES: PlanStatus[] = ["pending", "active", "done"];

/** A plan event's items, each with a text and a known status (pending when it names another). */
function planItems(v: unknown): PlanItem[] {
  if (!Array.isArray(v)) return [];
  return v.map((d: unknown) => {
    const o = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
    const status = PLAN_STATUSES.find((s) => s === o.status) ?? "pending";
    return { text: str(o.text), status };
  }).filter((d) => !!d.text);
}

/**
 * A thread's events as the rows the first timeline drew: threadRows without its plan and change rows. Kept for the
 * views that switch over TimelineRow's kinds.
 */
export function timelineRows(events: HostSessionEvent[]): TimelineRow[] {
  const out: TimelineRow[] = [];
  for (const r of threadRows(events)) if (r.kind !== "plan" && r.kind !== "change") out.push(r);
  return out;
}

/** How long the thread's last turn has run (to now while it runs, to its `done` once it ended); null with no prompt. */
export function turnElapsed(events: HostSessionEvent[], now: Date): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind !== "prompt") continue;
    const turn = events[i].turn;
    const from = Date.parse(events[i].t);
    if (!Number.isFinite(from)) return null;
    const done = events.slice(i + 1).find((e) => e.kind === "done" && e.turn === turn);
    const to = done ? Date.parse(done.t) : now.getTime();
    return Number.isFinite(to) ? Math.max(0, to - from) : null;
  }
  return null;
}

/** A length of time as the working line and a turn's footer show it: 48s, 2m 14s, 1h 5m. */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The line under a running turn: `Working… (48s · esc to stop)`, or Stopping… once a stop was asked for. */
export function workingText(ms: number | null, stopping = false): string {
  if (stopping) return "Stopping…";
  return ms === null ? "Working… (esc to stop)" : `Working… (${durationText(ms)} · esc to stop)`;
}

/** The model and effort each turn's first prompt recorded; a turn whose prompt recorded neither (an older thread) is
 *  left out, so its footer names no model. */
export function turnChoices(events: HostSessionEvent[]): Map<number, { model: string | null; effort: string | null }> {
  const out = new Map<number, { model: string | null; effort: string | null }>();
  for (const e of events) {
    if (e.kind !== "prompt" || out.has(e.turn) || !("model" in e || "effort" in e)) continue;
    out.set(e.turn, { model: str(e.model) || null, effort: str(e.effort) || null });
  }
  return out;
}

/** A finished turn's line: `Done · Opus 5.5 · High · 2m 14s · $0.18 estimated · 1,200 in · 80 out`, "Did not finish"
 *  for one that failed, and no model part when its prompt recorded none. */
export function doneLine(row: Extract<ThreadRow, { kind: "done" }>, choice?: string | null): string {
  const cost = row.footer.replace(/^did not finish · /, "");
  return [row.ok ? "Done" : "Did not finish", choice || "", row.ms === null ? "" : durationText(row.ms), cost].filter((s) => !!s).join(" · ");
}

/** The last finished turn's spend (its `done`, else its usage), for the status line; null before any turn ends. */
export function lastTurnUsd(events: HostSessionEvent[]): { usd: number; estimated: boolean } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== "done") continue;
    const usage = events.find((u) => u.kind === "usage" && u.turn === e.turn);
    const usd = num(e.usd) ?? num(usage?.usd);
    return usd === null ? null : { usd, estimated: e.estimated === true };
  }
  return null;
}

/** Whether the thread's last turn is still running: it has a prompt and no `done` after it. */
export function turnOpen(events: HostSessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "done") return false;
    if (events[i].kind === "prompt") return true;
  }
  return false;
}

/**
 * `extra` appended to `base`, each record once. A thread is read from its file while its turn may still be sending
 * events; main writes a record before it sends it, so the two can overlap but never miss one.
 */
export function mergeEvents(base: HostSessionEvent[], extra: HostSessionEvent[]): HostSessionEvent[] {
  const seen = new Set(base.map((e) => JSON.stringify(e)));
  const out = [...base];
  for (const e of extra) {
    const k = JSON.stringify(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** A `git status --porcelain=v2` code in words. */
export function fileStatusLabel(code: string): string {
  if (code === "??") return "new";
  if (/U/.test(code) || code === "AA" || code === "DD") return "conflict";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

/** The repository card's first line. */
export function statusSummary(st: HostGitStatus): string {
  if (!st.repo) return "Not a git repository";
  const n = st.files.length;
  if (!n) return "No changes";
  return `${n} file${n === 1 ? "" : "s"} changed`;
}

export interface HostChoice { host: SessionHost; label: string; ready: boolean; reason: string | null }

/**
 * The hosts the composer offers, in a fixed order: one is ready when it is on in agenticos.json (aosConfig
 * sessionHosts) and its login is not known to be missing (the provider probe's cache). Off: disabled, with why.
 */
export function hostChoices(cfg: AgenticosJson | null, state: ProviderState | null): HostChoice[] {
  const on = sessionHosts(cfg);
  return (["claude", "codex"] as SessionHost[]).map((host) => {
    const label = HOST_LABEL[host];
    if (!on.includes(host)) return { host, label, ready: false, reason: `${label} is off on this machine` };
    if (state?.[host]?.loggedIn === false) return { host, label, ready: false, reason: `${label} is not logged in` };
    return { host, label, ready: true, reason: null };
  });
}

/** `+a −b` across a status's files, how many files it counts, and how many have no counts (binary: git says null). */
export function diffTotals(st: HostGitStatus | null): { added: number; removed: number; files: number; unknown: number } {
  const out = { added: 0, removed: 0, files: 0, unknown: 0 };
  for (const f of st?.repo ? st.files : []) {
    out.files++;
    if (f.added === null || f.removed === null) out.unknown++;
    else { out.added += f.added; out.removed += f.removed; }
  }
  return out;
}

/** One file's counts in a status, by its path in the workspace (or absolute under `root`); null when it has none. */
export function fileCounts(st: HostGitStatus | null, path: string, root?: string | null): { added: number | null; removed: number | null } | null {
  const rel = relPath(path, root);
  const f = st?.repo ? st.files.find((x) => x.path === rel) : undefined;
  return f ? { added: f.added, removed: f.removed } : null;
}

// ── the list (spec 2026-10-07-sessions-ux U1: New session, Vault, then each workspace folder with its threads) ──

/** A thread's age in the list, as short as it fits: now, 12m, 3h, 2d, then the date. */
export function threadAge(iso: string, now: Date): string {
  const text = ago(iso, now);
  return text === "just now" ? "now" : text.replace(/ ago$/, "");
}

/**
 * Today's session spend from the spend ledger's text (brain/_index/provider-spend.jsonl): the `session:*` rows of the
 * local day of `now`, as the runtime's sessionSpendToday sums them against sessions.perDayUsd. Torn lines are skipped.
 */
export function sessionSpendToday(ledger: string, now: Date): number {
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = day(now);
  let sum = 0;
  for (const line of ledger.split("\n")) {
    if (!line.includes("\"session:")) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!r || !str(r.feature).startsWith("session:")) continue;
    const t = new Date(str(r.ts));
    if (Number.isNaN(t.getTime()) || day(t) !== today) continue;
    sum += num(r.usd) ?? 0;
  }
  return Math.round(sum * 1e6) / 1e6;
}

/** The list's spend footer, `$1.84 of $10`, and how much of the day's cap that is (0 to 1; a cap of 0 is full). */
export function spendLine(spent: number, cap: number): { text: string; ratio: number } {
  const capText = Number.isInteger(cap) ? `$${cap}` : usdText(cap);
  return { text: `${usdText(spent)} of ${capText}`, ratio: cap > 0 ? Math.min(1, Math.max(0, spent / cap)) : 1 };
}

// ── the host and model menu (spec 2026-10-07-sessions-ux U2–U4, U9, U12) ──

export type CatalogModel = HostCatalogHost["models"][number];
export type CatalogCommand = HostCatalogHost["commands"][number];

/** The levels a session turn takes on each host (the runtime's headless.js SESSION_EFFORTS), in order. */
export const SESSION_EFFORTS: Record<SessionHost, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};
/** The levels Vault chat's one-shot paths take: `claude -p --effort` and `ask.js --effort=` (U9). */
export const VAULT_EFFORTS: Record<SessionHost, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

const EFFORT_LABEL: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max", ultra: "Ultra" };

/** An effort level in words; a level this list does not know, capitalised. */
export function effortLabel(effort: string): string {
  return EFFORT_LABEL[effort] ?? (effort ? effort[0].toUpperCase() + effort.slice(1) : "");
}

/** What the menu calls each host's effort row (Picker 2). */
export const EFFORT_TITLE: Record<SessionHost, string> = { claude: "Effort", codex: "Reasoning" };

/** A host's entry in the catalog, or null when the catalog has none for it. */
export function catalogHost(cat: HostCatalog | null, host: SessionHost): HostCatalogHost | null {
  return cat?.hosts?.[host] ?? null;
}

/** A host's models: the current ones first in the menu, the older ones folded under Older models. */
export function splitModels(entry: HostCatalogHost | null): { current: CatalogModel[]; older: CatalogModel[] } {
  const models = entry?.models ?? [];
  return { current: models.filter((m) => m.main), older: models.filter((m) => !m.main) };
}

/** A model of the catalog by id, or null (a custom id, or a host that listed nothing). */
export function findModel(entry: HostCatalogHost | null, id: string | null): CatalogModel | null {
  return id ? entry?.models.find((m) => m.id === id) ?? null : null;
}

/**
 * The model's name on the chip, the status line and the change marker. No model is the host's own default ("Default"
 * on Claude, whose `default` alias means the same; "Codex default" on Codex); a listed model is its name without
 * Claude's "(recommended)"; a custom id shows itself.
 */
export function modelName(host: SessionHost, entry: HostCatalogHost | null, id: string | null): string {
  const m = findModel(entry, id);
  if (m) return m.name.replace(/\s*\(recommended\)\s*$/i, "") || m.id;
  if (!id) return host === "claude" ? "Default" : "Codex default";
  if (host === "claude" && id === "default") return "Default";
  return id;
}

/**
 * The effort levels the menu offers for a model: the ones the catalog lists for it. No model is the host's default
 * (Claude's `default` alias, Codex's configured model); a model the catalog does not know takes the host's session
 * levels, since the runtime drops any its host does not take. In Vault mode only the one-shot path's levels are left.
 */
export function effortsFor(host: SessionHost, entry: HostCatalogHost | null, model: string | null, vault = false): string[] {
  const m = findModel(entry, model ?? (host === "claude" ? "default" : entry?.defaultModel ?? null));
  const levels = m ? m.efforts : SESSION_EFFORTS[host];
  return vault ? levels.filter((l) => VAULT_EFFORTS[host].includes(l)) : [...levels];
}

/** A choice remembered in the HUD's settings for one host (U12). */
export interface RememberedChoice { model?: string | null; effort?: string | null }

/**
 * Where a new session (or a Vault question) starts on a host. Model: the remembered one; else on Claude `default`, on
 * Codex the configured default, else its first current model, else none (Codex's own). Effort: the remembered level
 * when the model takes it, else the catalog's default, else medium, else the model's first, else none.
 */
export function defaultChoice(host: SessionHost, entry: HostCatalogHost | null, remembered?: RememberedChoice | null, vault = false): { model: string | null; effort: string | null } {
  const model = remembered?.model
    || (host === "claude" ? "default" : entry?.defaultModel || entry?.models.find((m) => m.main)?.id || entry?.models[0]?.id || null);
  const levels = effortsFor(host, entry, model, vault);
  const pick = [remembered?.effort, entry?.defaultEffort, "medium"].find((l) => !!l && levels.includes(l));
  return { model, effort: pick ?? levels[0] ?? null };
}

/** The `--model` a turn passes: none for Claude's `default` alias or no choice, else the id. */
export function modelArg(host: SessionHost, model: string | null): string | null {
  return !model || (host === "claude" && model === "default") ? null : model;
}

/** `Opus 5.5 · High`: the model and, when the model takes efforts and one is chosen, the effort. */
export function choiceText(host: SessionHost, entry: HostCatalogHost | null, model: string | null, effort: string | null, vault = false): string {
  const name = modelName(host, entry, model);
  return effort && effortsFor(host, entry, model, vault).includes(effort) ? `${name} · ${effortLabel(effort)}` : name;
}

/** The chip: `Claude Code · Opus 5.5 · High`, with no effort part for a model that takes none. */
export function chipText(host: SessionHost, entry: HostCatalogHost | null, model: string | null, effort: string | null, vault = false): string {
  return `${HOST_LABEL[host]} · ${choiceText(host, entry, model, effort, vault)}`;
}

/** Models whose name, id or description holds the query, ignoring case; all of them for an empty query. */
export function searchModels(models: CatalogModel[], query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter((m) => `${m.name}\n${m.id}\n${m.description}`.toLowerCase().includes(q));
}

/** The menu's footnote on where the list came from: the host and its version and how old the list is, or why the list
 *  is short (U4). */
export function catalogSource(host: SessionHost, entry: HostCatalogHost | null, now: Date): string {
  const label = HOST_LABEL[host];
  if (!entry) return `${label} has not been asked yet`;
  if (!entry.ok) return entry.reason || `${label} did not answer`;
  const from = entry.version ? `From ${label} ${entry.version}` : `From ${label}`;
  return entry.fetchedAt ? `${from} · ${ago(entry.fetchedAt, now)}` : from;
}

// ── access levels (spec 2026-10-07-sessions-ux U7) ──

export interface AccessLevel {
  id: HostSessionAccess;
  label: string;
  description: string;
  /** What the level runs as on each host. */
  hosts: Record<SessionHost, string>;
}

export const DEFAULT_ACCESS: HostSessionAccess = "edit";

export const ACCESS_LEVELS: AccessLevel[] = [
  { id: "read", label: "Read only", description: "Reads, searches and plans. Changes nothing.", hosts: { claude: "plan mode", codex: "read-only sandbox" } },
  { id: "edit", label: "Edit files", description: "Edits files in this workspace. The default.", hosts: { claude: "acceptEdits", codex: "workspace-write" } },
  { id: "run", label: "Edit and run commands", description: "Also runs shell commands: tests, builds, git status.", hosts: { claude: "acceptEdits + Bash", codex: "same as Edit files" } },
];

/** What the access menu says under its levels: Codex has no level that edits without running commands (spec §5). */
export const CODEX_ACCESS_NOTE = "Codex runs commands inside its sandbox at every level that edits, with no network.";

/** Whether a value is one of the three levels (a prompt event read from an older thread may carry none). */
export function isAccess(v: unknown): v is HostSessionAccess {
  return v === "read" || v === "edit" || v === "run";
}

/** An access level in words. */
export function accessLabel(access: HostSessionAccess): string {
  return ACCESS_LEVELS.find((l) => l.id === access)?.label ?? access;
}

/** A level's mapping line in the menu: `Claude: plan mode · Codex: read-only sandbox`, or one host's part alone. */
export function accessHostLine(level: AccessLevel, host?: SessionHost): string {
  const short: Record<SessionHost, string> = { claude: "Claude", codex: "Codex" };
  return (host ? [host] : (["claude", "codex"] as SessionHost[])).map((h) => `${short[h]}: ${level.hosts[h]}`).join(" · ");
}

// ── the `/` menu (spec 2026-10-07-sessions-ux U8) ──

/**
 * What the composer holds while a command is being typed: the text after its leading `/` (or `$`, Codex's own way to
 * name a skill), up to the first whitespace; null once a space follows or the text starts otherwise.
 */
export function commandQuery(text: string, host: SessionHost): string | null {
  const lead = text.charAt(0);
  if (lead !== "/" && !(host === "codex" && lead === "$")) return null;
  const rest = text.slice(1);
  return /\s/.test(rest) ? null : rest;
}

/** Whether the composer is typing a command (the `/` menu is open). */
export function commandTyping(text: string, host: SessionHost): boolean {
  return commandQuery(text, host) !== null;
}

/**
 * The host's commands that match what follows the `/`: names that start with it first, then names with a part (after
 * `:`, `-` or `_`) that starts with it, then names and descriptions that hold it; each group in the catalog's order.
 * At most `limit` of them, and how many matched in all (the menu's footnote).
 */
export function filterCommands(commands: CatalogCommand[], query: string, limit = 50): { items: CatalogCommand[]; total: number } {
  const q = query.trim().toLowerCase();
  const rank = (c: CatalogCommand): number => {
    const name = c.name.toLowerCase();
    if (!q || name.startsWith(q)) return 0;
    if (name.split(/[:_-]/).some((p) => p.startsWith(q))) return 1;
    if (name.includes(q)) return 2;
    return c.description.toLowerCase().includes(q) ? 3 : -1;
  };
  const ranked = commands.map((c, i) => ({ c, i, r: rank(c) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r || a.i - b.i);
  return { items: ranked.slice(0, Math.max(0, limit)).map((x) => x.c), total: ranked.length };
}
