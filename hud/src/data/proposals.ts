// proposals.ts — readers for the Proposals tab (spec 2026-09-22-todo-and-proposals-tabs D5/D6).
// Pure: file text in, rows out. The tab is read-only; every decision goes through the
// persona-flag-closer skill, which owns the ledger, the backlog and the commits.
// Mirrors, rule for rule: plugin/skills/persona-flag-closer/scripts/collect.js (frontmatter, premise
// table, kinds, surfaces, lint, the workspace key), brain/scripts/persona/backlog.js (section shape),
// brain/scripts/persona/ledger.js summary() (28-day rates) and brain/scripts/persona/recheck.js
// readConfirmations(), and brain/scripts/persona/proposal-html.js pagePath() (spec 2026-09-22-proposal-pages D7).
// proposals.test.ts runs both sides on the same fixtures.

import { workspaceKey } from "./memories";

export const PROPOSALS_DIR = "persona/proposals";
export const LEDGER_PATH = "persona/ledger.jsonl";
export const BACKLOG_PATH = "persona/backlog.md";
export const CONFIRMATIONS_PATH = "persona/flag-closer/confirmations.json";
/** Where proposal-html.js renders each proposal's page: gitignored, and kept after the proposal is decided. */
export const PAGES_DIR = "brain/_index/proposals";

export const KINDS = ["self", "vault", "workflow", "product"];
export const IDEA_KINDS = ["workflow", "product"];
export const SURFACES = ["cli", "plugin", "brain", "hud", "vault-template", "docs"];
/** recheck.js MIN_CONFIRMATIONS: consecutive daily confirmations the auto-apply gate needs. */
export const MIN_CONFIRMATIONS = 2;
const RATE_DAYS = 28;
const DAY_MS = 86_400_000;

export interface Premise { claim: string; status: "VERIFIED" | "ASSUMED"; evidence: string }

export interface Proposal {
  name: string;               // file name inside persona/proposals
  slug: string;
  filed: string;              // YYYY-MM-DD
  kind: string;
  surface: string | null;
  /** The workspace `/propose` filed it from (frontmatter `workspace:`, read as a memory note's is; spaces-redesign D27). */
  workspace: string | null;
  target: string;
  recheck: string | null;
  autoapplyClass: string | null;
  what: string | null;
  why: string | null;
  risk: string | null;
  premises: Premise[];
  lint: string[];
  decision: string;           // "approve / reject" or "accept → backlog / dismiss"
}

/** A pending proposal is any .md in persona/proposals except its README. */
export function isProposalFile(name: string): boolean {
  return name.endsWith(".md") && name !== "README.md";
}

/** proposal-html.js pagePath(): `<date>-<slug>.md` → `brain/_index/proposals/<date>-<slug>.html`. */
export function pageFor(name: string): string {
  return `${PAGES_DIR}/${name.replace(/\.md$/, "")}.html`;
}

/** The newest page for `slug` among the file names in PAGES_DIR — a page outlives its proposal file, so Backlog and
 *  History rows find theirs by slug. Null when none was rendered. */
export function pageForSlug(pages: string[], slug: string): string | null {
  const hits = pages.filter((n) => /^\d{4}-\d{2}-\d{2}-/.test(n) && n.endsWith(".html") && n.slice(11, -5) === slug).sort();
  return hits.length ? `${PAGES_DIR}/${hits[hits.length - 1]}` : null;
}

/** collect.js parseFrontmatter: flat `key: value`, double quotes stripped with \" and \\ unescaped. */
export function parseProposalFrontmatter(text: string): Record<string, string> | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    const q = v.match(/^"(.*)"$/);
    if (q) v = q[1].replace(/\\(["\\])/g, "$1");
    fm[kv[1]] = v;
  }
  return fm;
}

/** collect.js parsePremiseTable: rows under `## Premises` whose second cell is VERIFIED or ASSUMED. */
export function parsePremiseTable(text: string): Premise[] | null {
  const sec = text.split(/^## Premises\s*$/m)[1];
  if (!sec) return null;
  const rows: Premise[] = [];
  for (const line of sec.split("\n")) {
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 3 && /^(VERIFIED|ASSUMED)$/.test(cells[1])) {
      rows.push({ claim: cells[0], status: cells[1] as Premise["status"], evidence: cells.slice(2).join(" | ") });
    }
  }
  return rows.length ? rows : null;
}

/** backlog.js section(): the body of `## <name>` up to the next H2, trimmed; null when missing. */
export function section(text: string, name: string): string | null {
  const m = text.match(new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return m ? m[1].trim() : null;
}

export function decisionFor(kind: string): string {
  return IDEA_KINDS.includes(kind) ? "accept → backlog / dismiss" : "approve / reject";
}

export function parseProposal(name: string, text: string): Proposal {
  const fm = parseProposalFrontmatter(text) ?? {};
  const premises = parsePremiseTable(text);
  const lint: string[] = [];
  if (!fm.recheck) lint.push("missing recheck recipe");
  if (!premises) lint.push("missing premise table");
  const kind = fm.kind || "self";
  if (!KINDS.includes(kind)) lint.push(`unknown kind "${kind}" (self | vault | workflow | product)`);
  const surface = fm.surface || null;
  if (kind === "product" && !surface) lint.push(`product proposal names no surface (${SURFACES.join(" | ")})`);
  if (surface && !SURFACES.includes(surface)) lint.push(`unknown surface "${surface}" (${SURFACES.join(" | ")})`);
  return {
    name,
    slug: fm.slug || name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, ""),
    filed: fm.filed || name.slice(0, 10),
    kind, surface,
    workspace: workspaceKey(fm.workspace ?? null),
    target: fm.target || "(unspecified)",
    recheck: fm.recheck || null,
    autoapplyClass: fm.autoapply_class || null,
    what: section(text, "What"),
    why: section(text, "Why"),
    risk: section(text, "Risk"),
    premises: premises ?? [],
    lint,
    decision: decisionFor(kind),
  };
}

/** Whole days from a YYYY-MM-DD date to `now`, both read as local dates; null for a malformed date. */
export function ageDays(filed: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(filed);
  if (!m) return null;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - then.getTime()) / DAY_MS);
}

// ── ledger ───────────────────────────────────────────────────────────────────

export interface LedgerRecord {
  ts: string;
  event: string;
  slug: string;
  kind: string;
  target: string | null;
  by: string | null;
  note?: string;
  commit?: string;
}

/** ledger.js read(): one JSON event per line; blank and corrupt lines are skipped. */
export function parseLedger(text: string): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object" && typeof r.event === "string" && typeof r.slug === "string") out.push(r);
    } catch { /* corrupt line: skipped, as ledger.js does */ }
  }
  return out;
}

export interface LedgerRates { days: number; approvalRate: number | null; acceptRate: number | null; counts: Record<string, number> }

/** ledger.js summary() rates over the last `days`: approved/(approved+rejected), accepted/(accepted+dismissed). */
export function ledgerRates(records: LedgerRecord[], now: Date, days = RATE_DAYS): LedgerRates {
  const since = now.getTime() - days * DAY_MS;
  const counts: Record<string, number> = {};
  for (const r of records) {
    if (!(Date.parse(r.ts) >= since)) continue;
    counts[r.event] = (counts[r.event] ?? 0) + 1;
  }
  const n = (e: string) => counts[e] ?? 0;
  const rate = (yes: number, no: number) => (yes + no ? Math.round((yes / (yes + no)) * 100) / 100 : null);
  return { days, counts, approvalRate: rate(n("approved"), n("rejected")), acceptRate: rate(n("accepted"), n("dismissed")) };
}

/** Outcomes newest first (every event but `filed`, which the Pending group already shows). */
export function historyRows(records: LedgerRecord[], limit = 20): LedgerRecord[] {
  return records
    .filter((r) => r.event !== "filed")
    .map((r, i) => ({ r, i, t: Date.parse(r.ts) }))
    .sort((a, b) => (b.t - a.t) || (b.i - a.i))
    .slice(0, limit)
    .map((x) => x.r);
}

// ── backlog ──────────────────────────────────────────────────────────────────

export interface BacklogEntry {
  filed: string;
  kind: string;
  slug: string;
  target: string | null;
  surface: string | null;
  accepted: string | null;    // "YYYY-MM-DD" or "YYYY-MM-DD by <who>"
  body: string;               // the ### What / ### Why block, Markdown
}

/** backlog.js renderSection: `## <filed> · <kind> · <slug>`, `- key: value` lines, then the body. Newest last in the file. */
export function parseBacklog(text: string): BacklogEntry[] {
  const out: BacklogEntry[] = [];
  const parts = text.split(/^(?=## )/m);
  for (const part of parts) {
    const head = /^## (\S+) · (\S+) · (\S+)\s*$/m.exec(part.split("\n")[0]);
    if (!head) continue;
    const meta: Record<string, string> = {};
    const lines = part.split("\n").slice(1);
    let i = 0;
    for (; i < lines.length; i++) {
      const kv = /^- (target|surface|accepted): (.*)$/.exec(lines[i]);
      if (!kv) break;
      meta[kv[1]] = kv[2].trim();
    }
    out.push({
      filed: head[1], kind: head[2], slug: head[3],
      target: meta.target ?? null, surface: meta.surface ?? null, accepted: meta.accepted ?? null,
      body: lines.slice(i).join("\n").trim(),
    });
  }
  return out;
}

// ── confirmations ────────────────────────────────────────────────────────────

/** recheck.js readConfirmations(): { schema, recordedDay, slugs } or a legacy flat { slug: n }; bad input → {}. */
export function parseConfirmations(text: string | null): Record<string, number> {
  if (!text) return {};
  let j: unknown;
  try { j = JSON.parse(text); } catch { return {}; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return {};
  const obj = j as Record<string, unknown>;
  const src = obj.slugs && typeof obj.slugs === "object" ? (obj.slugs as Record<string, unknown>) : obj;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k !== "schema" && k !== "recordedDay" && Number.isInteger(v) && (v as number) >= 0) out[k] = v as number;
  }
  return out;
}
