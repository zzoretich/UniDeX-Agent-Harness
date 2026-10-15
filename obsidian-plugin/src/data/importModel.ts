// importModel.ts — what `aos import` reports and what brain/_index/import-state.json records, as the app shows them: the
// setup wizard's "Bring in your history" step (install-import B13), Settings ▸ Import (B4), Pulse's digest line (spec §4
// HUD) and, in PR 9, the Import sheet (B12). It also builds the one argv the app sends `aos import` (B7), which the
// `import` write surface (app/src/shared/surfaces.ts) admits. Pure and import-free: the wizard's page bundles it too.
//
// The runtime's shapes (brain/scripts/lib/import/index.js runImport, common.js state): a scan is the `--dry-run --json`
// report { schema, dryRun, since, windowDays, from, only, engine, hosts: { <host>: { present, configDir, instructions:
// { files, rules, new }, memories: { files, new }, mcp: { servers }, sessions } }, projects: { proposals } }; the state
// file is { schema, phases: [{ phase, host, done, cursor, counts, at }], digest: { processed, total, done, finishedAt,
// lastRun, queue }, runs: [{ at, from, only, since, written }] }.

export type ImportHost = "claude" | "codex";
export type ImportKind = "instructions" | "memories" | "projects" | "mcp" | "sessions";
/** How far back sessions are digested: the last 90 days (B4's default), or everything ("Import older history"). */
export type ImportSince = "90d" | "all";

export const IMPORT_HOSTS: readonly ImportHost[] = ["claude", "codex"];
export const IMPORT_KINDS: readonly ImportKind[] = ["instructions", "memories", "projects", "mcp", "sessions"];
/** The fast phases (B10): what an import does while you wait; sessions are queued for the digest routine. */
export const FAST_KINDS: readonly ImportKind[] = ["instructions", "memories", "projects", "mcp"];
export const IMPORT_HOST_LABEL: Record<ImportHost, string> = { claude: "Claude Code", codex: "Codex" };
export const IMPORT_KIND_LABEL: Record<ImportKind, string> = {
  instructions: "Instructions", memories: "Memories", projects: "Projects", mcp: "MCP servers", sessions: "Sessions",
};
/** At most this many workspace proposals in one `--accept` (the surface's rule holds the same). */
export const MAX_ACCEPT = 100;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const pl = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── the scan (`aos import --dry-run --json`) ──

export interface ImportHostScan {
  /** The host's folder is on this Mac (its CLI need not be). */
  present: boolean;
  /** `~/.claude`, `~/.codex`: as the runtime writes it, never an absolute home path. */
  configDir: string;
  instructions: { files: number; rules: number; new: number } | null;
  /** Claude Code's auto-memory files (Codex has none to read). */
  memories: { files: number; new: number } | null;
  mcp: { servers: number } | null;
  /** Sessions in the window the digest would queue. */
  sessions: number | null;
}

export interface ImportProposal {
  /** The `~/…` repository path `--accept` names it by. */
  id: string;
  action: "new" | "link";
  /** The workspace it makes (new) or the one it links to (link). */
  slug: string;
  into: string | null;
  reason: string;
  claude: number;
  codex: number;
  sessions: number;
}

export interface ImportScan {
  since: string;
  /** null: all history. */
  windowDays: number | null;
  from: ImportHost[];
  /** The local model (B15): with none, rules import whole-file and the digest waits. */
  engine: { ready: boolean; model: string | null; reason: string };
  hosts: Partial<Record<ImportHost, ImportHostScan>>;
  proposals: ImportProposal[];
}

function counts<K extends string>(v: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isObj(v)) return null;
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = num(v[k]);
  return out;
}

/** The report `aos import --dry-run --json` prints, checked and narrowed; null when it is not one. */
export function parseScan(j: unknown): ImportScan | null {
  if (!isObj(j) || j.dryRun !== true || !isObj(j.hosts)) return null;
  const from = Array.isArray(j.from) ? (j.from.filter((h) => IMPORT_HOSTS.includes(h as ImportHost)) as ImportHost[]) : [];
  const hosts: Partial<Record<ImportHost, ImportHostScan>> = {};
  for (const h of IMPORT_HOSTS) {
    const x = j.hosts[h];
    if (!isObj(x)) continue;
    hosts[h] = {
      present: x.present === true,
      configDir: str(x.configDir) ?? "",
      instructions: counts(x.instructions, ["files", "rules", "new"] as const),
      memories: h === "claude" ? counts(x.memories, ["files", "new"] as const) : null,
      mcp: counts(x.mcp, ["servers"] as const),
      sessions: typeof x.sessions === "number" ? num(x.sessions) : null,
    };
  }
  const projects = isObj(j.projects) && Array.isArray(j.projects.proposals) ? j.projects.proposals : [];
  const proposals: ImportProposal[] = [];
  for (const p of projects) {
    if (!isObj(p) || !str(p.id) || (p.action !== "new" && p.action !== "link")) continue;
    proposals.push({
      id: p.id as string, action: p.action, slug: str(p.slug) ?? str(p.name) ?? "", into: str(p.into), reason: str(p.reason) ?? "",
      claude: num(p.claude), codex: num(p.codex), sessions: num(p.sessions),
    });
  }
  const e = isObj(j.engine) ? j.engine : {};
  return {
    since: str(j.since) ?? "90d",
    windowDays: typeof j.windowDays === "number" ? j.windowDays : null,
    from,
    engine: { ready: e.ready === true, model: str(e.model), reason: str(e.reason) ?? "" },
    hosts,
    proposals,
  };
}

/** One cell of the wizard's table: how many of a kind a host would bring, in words. */
export interface ScanCell { count: number; text: string }

/** A host's cell for a kind (projects are listed apart, as proposals); null where the host has none of that kind. */
export function scanCell(h: ImportHostScan, kind: ImportKind): ScanCell | null {
  switch (kind) {
    case "instructions": return h.instructions && h.instructions.files ? { count: h.instructions.rules, text: pl(h.instructions.rules, "rule") } : null;
    case "memories": return h.memories && h.memories.files ? { count: h.memories.files, text: pl(h.memories.files, "memory", "memories") } : null;
    case "mcp": return h.mcp && h.mcp.servers ? { count: h.mcp.servers, text: pl(h.mcp.servers, "server") } : null;
    case "sessions": return h.sessions ? { count: h.sessions, text: pl(h.sessions, "session") } : null;
    case "projects": return null;
  }
}

/** The hosts with something to bring, in order. */
export function scanHosts(scan: ImportScan): ImportHost[] {
  return IMPORT_HOSTS.filter((h) => {
    const x = scan.hosts[h];
    return !!x && x.present && (["instructions", "memories", "mcp", "sessions"] as ImportKind[]).some((k) => scanCell(x, k));
  });
}

/** The kinds that have anything to bring, from any host (projects when there are proposals). */
export function scanKinds(scan: ImportScan): ImportKind[] {
  return IMPORT_KINDS.filter((k) => (k === "projects" ? scan.proposals.length > 0 : scanHosts(scan).some((h) => scanCell(scan.hosts[h]!, k))));
}

/** Nothing on this Mac to bring in (no host folder, or nothing in any): the wizard skips its step (B13). */
export function scanEmpty(scan: ImportScan): boolean {
  return scanKinds(scan).length === 0;
}

/** One line for the engine (B15): what happens to rules and sessions with or without the local model. */
export function engineLine(scan: ImportScan): string {
  return scan.engine.ready
    ? `The local model${scan.engine.model ? ` (${scan.engine.model})` : ""} sorts each rule by type and digests the sessions; nothing leaves this Mac.`
    : "The local model is not ready yet: each instruction file comes in as one note, and the sessions wait for it. Nothing leaves this Mac.";
}

// ── the request and its argv (B7) ──

export interface ImportRequest {
  from: ImportHost[];
  only: ImportKind[];
  /** Default 90d; "all" is Settings ▸ Import's "Import older history" (B4). */
  since?: ImportSince;
  /** The proposals to create (B9), by id; none creates none. */
  accept?: string[];
}

/** An id `--accept` may name: a `~/…` or absolute path the scan printed, no NUL or line break, never a flag. */
const ACCEPT_ID = /^(?:~\/|\/)[^\0\n\r\u2028\u2029]{0,1023}$/;

/**
 * `aos import`'s argv for a request, flags in the one order the `import` surface admits: --from, --since, --only,
 * --accept, then --dry-run or --json. Throws on a request the runtime would refuse, before anything runs.
 */
export function importArgs(req: ImportRequest, o: { dryRun?: boolean; json?: boolean } = {}): string[] {
  const from = IMPORT_HOSTS.filter((h) => req.from.includes(h));
  if (!from.length) throw new Error("import: no host chosen");
  const only = IMPORT_KINDS.filter((k) => req.only.includes(k));
  if (!only.length) throw new Error("import: nothing chosen to import");
  const accept = [...new Set(req.accept ?? [])];
  if (accept.length > MAX_ACCEPT) throw new Error(`import: at most ${MAX_ACCEPT} workspaces at once`);
  if (accept.some((id) => !ACCEPT_ID.test(id))) throw new Error("import: a workspace proposal is named by its folder");
  if (accept.length && o.dryRun) throw new Error("import: a dry run creates no workspaces");
  const args = ["import", "--from", from.length === 2 ? "all" : from[0]];
  if (req.since === "all") args.push("--since", "all");
  if (only.length < IMPORT_KINDS.length) args.push("--only", only.join(","));
  if (accept.length && only.includes("projects")) args.push("--accept", JSON.stringify(accept));
  if (o.dryRun) args.push("--dry-run");
  if (o.json) args.push("--json");
  return args;
}

/**
 * The launch sequence's Import sheet (install-import B12) settles the upgrade's `import` migration in one call through
 * the `migrate` surface: `aos migrate import --apply [--accept <json list>]` runs the import (every kind, both hosts,
 * 90 days; its progress lines are `aos import`'s) and records it applied, or `aos migrate import --decline --json`
 * records the choice. The accepted proposals are checked as importArgs checks them; throws before anything runs.
 */
export function migrateImportArgs(action: "apply" | "decline", accept: readonly string[] = []): string[] {
  if (action === "decline") return ["migrate", "import", "--decline", "--json"];
  const ids = [...new Set(accept)];
  if (ids.length > MAX_ACCEPT) throw new Error(`import: at most ${MAX_ACCEPT} workspaces at once`);
  if (ids.some((id) => !ACCEPT_ID.test(id))) throw new Error("import: a workspace proposal is named by its folder");
  return ["migrate", "import", "--apply", ...(ids.length ? ["--accept", JSON.stringify(ids)] : [])];
}

/** The sheet's request as `aos import` would run it: what its progress counts against (importSteps). */
export const MIGRATE_IMPORT_REQUEST: Pick<ImportRequest, "from" | "only"> = { from: [...IMPORT_HOSTS], only: [...IMPORT_KINDS] };

// ── progress (the lines a run prints, `- <phase> …`) ──

/** How many progress lines a run prints: instructions and memories per host, then projects, mcp and sessions once. */
export function importSteps(req: Pick<ImportRequest, "from" | "only">): number {
  const hosts = IMPORT_HOSTS.filter((h) => req.from.includes(h)).length;
  return req.only.reduce((n, k) => n + (k === "instructions" || k === "memories" ? hosts : 1), 0);
}

const STEP_RE = /^- (instructions|memories|projects|mcp|sessions)\b(?: \(([^)]*)\))?:? ?(.*)$/;

/** A line of `aos import`'s output that ends a step: its kind, host and what it did; null for any other line. */
export function progressStep(line: string): { kind: ImportKind; host: string | null; text: string } | null {
  const m = STEP_RE.exec(line.trim());
  return m ? { kind: m[1] as ImportKind, host: m[2] ?? null, text: m[3].replace(/^:\s*/, "") } : null;
}

export interface ImportProgress { done: number; steps: number; label: string }

/** Follows a run's output as it streams: feed it chunks, read the progress. */
export class ProgressFollower {
  private buf = "";
  private done = 0;
  readonly lines: string[] = [];
  constructor(readonly steps: number, private readonly onStep?: (p: ImportProgress) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.line(line);
    }
  }

  end(): void { if (this.buf) { this.line(this.buf); this.buf = ""; } }

  private line(line: string): void {
    if (!line.trim()) return;
    this.lines.push(line);
    const s = progressStep(line);
    if (!s) return;
    this.done = Math.min(this.steps, this.done + 1);
    const what = `${IMPORT_KIND_LABEL[s.kind]}${s.host ? ` from ${s.host}` : ""}`;
    this.onStep?.({ done: this.done, steps: this.steps, label: s.text ? `${what}: ${s.text}` : what });
  }
}

// ── import-state.json ──

export interface PhaseRow { phase: string; host: string; done: boolean; counts: Record<string, unknown>; at: string | null }
export interface DigestLastRun { status: string; reason: string | null; at: string | null }
export interface DigestState { processed: number; total: number; left: number; done: boolean; finishedAt: string | null; lastRun: DigestLastRun | null; since: string | null }
export interface ImportState { phases: PhaseRow[]; digest: DigestState | null; runs: Array<{ at: string; from: string[]; since: string | null; written: number }> }

export const IMPORT_STATE_PATH = "brain/_index/import-state.json";

/** import-state.json's text → what the app shows; an empty state for no file or one that does not parse. */
export function parseImportState(text: string | null): ImportState {
  const empty: ImportState = { phases: [], digest: null, runs: [] };
  let j: unknown;
  try { j = JSON.parse(text ?? ""); } catch { return empty; }
  if (!isObj(j)) return empty;
  const phases: PhaseRow[] = Array.isArray(j.phases)
    ? j.phases.filter(isObj).map((p) => ({ phase: str(p.phase) ?? "", host: str(p.host) ?? "", done: p.done === true, counts: isObj(p.counts) ? p.counts : {}, at: str(p.at) }))
    : [];
  let digest: DigestState | null = null;
  if (isObj(j.digest)) {
    const d = j.digest;
    const left = Array.isArray(d.queue) ? d.queue.length : 0;
    const lr = isObj(d.lastRun) ? d.lastRun : null;
    digest = {
      processed: num(d.processed), total: Math.max(num(d.total), num(d.processed) + left), left,
      done: d.done === true && left === 0, finishedAt: str(d.finishedAt), since: str(d.since),
      lastRun: lr ? { status: str(lr.status) ?? "", reason: str(lr.reason) ?? str(lr.stopped), at: str(lr.at) } : null,
    };
  }
  const runs = Array.isArray(j.runs)
    ? j.runs.filter(isObj).map((r) => ({ at: str(r.at) ?? "", from: Array.isArray(r.from) ? r.from.map(String) : [], since: str(r.since), written: num(r.written) }))
    : [];
  return { phases, digest, runs };
}

/** The digest's progress while it has sessions to work through (Pulse shows it until done); null when there is none. */
export function digestPending(state: ImportState): DigestState | null {
  const d = state.digest;
  return d && !d.done && d.left > 0 ? d : null;
}

/** "Digesting history: 140 of 412 sessions", with why it waits when its last run waited. */
export function digestText(d: DigestState): string {
  if (d.done) return `History digested: ${pl(d.processed, "session")}`;
  const head = `Digesting history: ${d.processed} of ${pl(d.total, "session")}`;
  const lr = d.lastRun;
  if (lr && (lr.status === "waiting" || lr.status === "deferred")) return `${head} · waiting${lr.reason ? ` (${lr.reason})` : ""}`;
  return head;
}

export interface HostImport {
  /** When this host's last import ran (its newest phase row). */
  at: string;
  /** Rules and memories written, MCP servers listed, sessions queued, by that run's rows. */
  rules: number;
  memories: number;
  servers: number;
  sessions: number | null;
  /** Whether any row was for all history (`--since all`). */
  older: boolean;
}

/** Each host's last import, from the state's phase rows (a both-host projects or sessions row counts for each). */
export function lastImports(state: ImportState): Record<ImportHost, HostImport | null> {
  const out: Record<ImportHost, HostImport | null> = { claude: null, codex: null };
  for (const h of IMPORT_HOSTS) {
    const rows = state.phases.filter((p) => (p.host === h || p.host === "all") && p.at && p.phase !== "digest");
    const own = rows.filter((p) => p.host === h);
    if (!own.length) continue;
    const at = own.map((p) => p.at as string).sort().pop() as string;
    const of = (phase: string, key: string): number => num(own.find((p) => p.phase === phase)?.counts[key]);
    const sess = rows.filter((p) => p.phase === "sessions").sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    out[h] = {
      at, rules: of("instructions", "written"), memories: of("memories", "written"), servers: of("mcp", "servers"),
      sessions: sess ? num(sess.counts.added) : null,
      older: state.runs.some((r) => r.since === "all" && r.from.includes(h)),
    };
  }
  return out;
}

/** "12 rules and 4 memories written · 3 MCP servers listed · 82 sessions queued" */
export function hostImportText(x: HostImport): string {
  const parts: string[] = [];
  if (x.rules || x.memories) parts.push(`${[x.rules && pl(x.rules, "rule"), x.memories && pl(x.memories, "memory", "memories")].filter(Boolean).join(" and ")} written`);
  else parts.push("nothing new written");
  if (x.servers) parts.push(`${pl(x.servers, "MCP server")} listed`);
  if (x.sessions !== null) parts.push(`${pl(x.sessions, "session")} queued`);
  return parts.join(" · ");
}
