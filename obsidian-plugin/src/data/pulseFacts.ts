// What the Pulse cockpit says about the vault (spec 2026-10-08-pulse-cockpit-design P8, P9, A2): the items that need the
// user, in one order, and a summary per area. The pure core is the twin of brain/scripts/lib/pulse-facts.js `facts()`
// over the same inputs; pulseFacts.test.ts loads that file and checks both agree on its fixture vault, so change both.
// This side reuses the HUD's own readers (pipelines.ts classifyPipeline, todos.ts parseTodos, proposals.ts).
// The obsidian import is type-only, so node:test can load this module.
import type { App } from "obsidian";
import { PIPELINES_MANIFEST, classifyPipeline, type PipelineState } from "./pipelines";
import { groupTodos, localDay, parseTodos } from "./todos";
import { ageDays, isProposalFile, parseProposal, PROPOSALS_DIR } from "./proposals";
import { NOTIFICATIONS_DIR, STATE_PATH, notificationId, parseNotification, parseState } from "./notifications";
import { TRAIL_PATH, parseTrail } from "./promoteTrail";
import { BRAIN_HUB_PATH, BRAIN_SOURCES_PATH, brainMdPercent, parseBrainHub, parseBrainSources } from "./brainModel";
import { SNAPSHOT_PATH } from "./snapshot";
import { ROUTINES_STATE_PATH } from "./routines";
import { diskAdapter, pendingGates, readTeams } from "./teams";
import { personaName } from "./aosConfig";

export const AREAS = ["needs", "health", "agents", "workspaces", "todo", "proposals", "notifications", "routines", "spend", "memory"] as const;
export type Area = typeof AREAS[number];
export type Tone = "ok" | "warn" | "danger" | "info" | "gate" | "off";

export interface PulseInputs {
  personaName: string | null;
  proposals: { name: string; text: string }[];
  stateMd: string | null;
  drafts: number;
  gates: { team: string; item: string; stage?: string | null; title: string | null; since: string | null }[];
  issues: { severity: string; area: string; message: string }[];
  workspaces: { name: string; status: string }[];
  pipelines: Record<string, PipelineState | undefined>;
  routines: Record<string, { lastRunAt?: string | null; failStreak?: number | null } | undefined>;
  todo: string | null;
  notifications: { id: string; level: string; title: string; from: string; created: string; read: boolean; archived: boolean }[];
  trail: { ts: string; action: string; slug: string; type: string; title: string; pending: boolean }[];
  spend: { usd: number; calls: number };
  // The Brain tile's numbers (brain-hub D10, D12, D15), from the runtime's caches; the facts do not read them, so the twin
  // in lib/pulse-facts.js has no such inputs.
  /** brain-hub.json's counts.unreviewed: the live memories still to review; null before a scan has written it. */
  toReview: number | null;
  /** BRAIN.md against its budget, a whole percent (brain-sources.json); null before build-brain-md.js has written it. */
  brainPct: number | null;
}

export interface NeedItem { tier: number; area: Area; kind: string; tone: Tone; title: string; since: string | null; ref: string }

export interface PulseSummary {
  health: { errors: number; warnings: number; notes: number; pipelines: { total: number; ok: number; neutral: number; stale: number; failed: number } };
  decisions: { proposals: number; gates: number; flags: number; drafts: number; oldestDays: number | null };
  notifications: { total: number; unread: number; breaking: number; alerts: number; latest: { title: string; from: string; created: string } | null };
  todo: { open: number; done: number; overdue: number; today: number };
  routines: { total: number; failing: number };
  memory: { writtenToday: number; pendingReview: number; drafts: number };
  workspaces: { total: number; active: number };
  spend: { usd: number; calls: number };
}

export interface PulseFacts { schema: 1; at: string; persona: string | null; needsYou: NeedItem[]; summary: PulseSummary }

export const EMPTY_INPUTS: PulseInputs = {
  personaName: null, proposals: [], stateMd: null, drafts: 0, gates: [], issues: [], workspaces: [], pipelines: {}, routines: {},
  todo: null, notifications: [], trail: [], spend: { usd: 0, calls: 0 }, toReview: null, brainPct: null,
};

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/** A `YYYY-MM-DD` as local midnight, an ISO time as itself; null when neither (lib/pulse-facts.js sinceMs). */
export function sinceMs(since: string | null | undefined): number | null {
  if (typeof since !== "string" || !since) return null;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime();
  const t = Date.parse(since);
  return Number.isFinite(t) ? t : null;
}

/** Open flags in persona/STATE.md (lib/statusline-model.js openFlags): `- [ ]` and bare bullets under `## Flags`. */
export function openFlags(text: string | null): { date: string | null; text: string }[] {
  if (!text) return [];
  let inFlags = false;
  const out: { date: string | null; text: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { inFlags = /^##\s+Flags\b/.test(line); continue; }
    if (!inFlags || !/^[-*]\s+\S/.test(line)) continue;
    if (/^[-*]\s+\[[xX]\]/.test(line) || /^[-*]\s+\(?none\)?\.?\s*$/i.test(line)) continue;
    const body = line.replace(/^[-*]\s+(\[ \]\s*)?/, "").trim();
    const d = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(body);
    out.push({ date: d ? d[1] : null, text: d ? d[2] : body });
  }
  return out;
}

/** A proposal's title (its first `# ` heading after the frontmatter, else its slug) and filing date. */
export function proposalTitle(name: string, text: string): { title: string; filed: string } {
  const p = parseProposal(name, text);
  const fm = /^---\n[\s\S]*?\n---\n/.exec(text);
  const h1 = /^# (.+?)\s*$/m.exec(text.slice(fm ? fm[0].length : 0));
  return { title: h1 ? h1[1] : p.slug, filed: p.filed };
}

/** The facts. Pure over (inputs, now). */
export function pulseFacts(inp: PulseInputs, now: Date = new Date()): PulseFacts {
  const today = localDay(now);
  const nowMs = now.getTime();
  const items: (NeedItem & { seq: number })[] = [];
  const push = (tier: number, it: Omit<NeedItem, "tier">): void => { items.push({ tier, seq: items.length, ...it }); };

  // 0: what is broken
  const issues = inp.issues ?? [];
  for (const i of issues) if (i && i.severity === "error") push(0, { area: "health", kind: "error", tone: "danger", title: String(i.message ?? ""), since: null, ref: String(i.area ?? "") });

  // 1: decisions waiting on the user
  for (const g of inp.gates ?? []) push(1, { area: "proposals", kind: "gate", tone: "gate", title: `${g.team} gate: ${g.title || g.item}`, since: g.since || null, ref: `${g.team}/${g.item}` });
  const proposals = (inp.proposals ?? []).map((p) => ({ name: p.name, ...proposalTitle(p.name, p.text) }));
  for (const p of proposals) push(1, { area: "proposals", kind: "proposal", tone: "gate", title: p.title, since: p.filed, ref: p.name });
  const flags = openFlags(inp.stateMd);
  for (const f of flags) push(1, { area: "proposals", kind: "flag", tone: "warn", title: f.text, since: f.date, ref: f.text });
  const drafts = Number(inp.drafts) || 0;
  if (drafts > 0) push(1, { area: "proposals", kind: "drafts", tone: "gate", title: `${drafts} feedback ${plural(drafts, "draft")} waiting for review`, since: null, ref: "feedback-drafts" });

  // 2: stale or failing work
  const pipes = inp.pipelines ?? {};
  const names = Object.keys(PIPELINES_MANIFEST);
  for (const n of Object.keys(pipes)) if (!names.includes(n) && !n.startsWith("routine:")) names.push(n);
  const pipeline = { total: names.length, ok: 0, neutral: 0, stale: 0, failed: 0 };
  for (const n of names) {
    const h = classifyPipeline(n, pipes[n], nowMs).health;
    if (h === "died") pipeline.failed++; else pipeline[h]++;
    if (!(n in PIPELINES_MANIFEST) || (h !== "stale" && h !== "failed" && h !== "died")) continue;
    const verb = h === "stale" ? "is stale" : h === "died" ? "died mid-run" : "failed";
    push(2, { area: "health", kind: "pipeline", tone: h === "stale" ? "warn" : "danger", title: `${n} ${verb}`, since: pipes[n]?.lastRun?.startedAt ?? null, ref: n });
  }
  const routines = inp.routines ?? {};
  const slugs = Object.keys(routines).sort();
  let failing = 0;
  for (const s of slugs) {
    const n = Number(routines[s]?.failStreak) || 0;
    if (n <= 0) continue;
    failing++;
    push(2, { area: "routines", kind: "routine", tone: "danger", title: `${s} failed ${n} ${plural(n, "time")} in a row`, since: routines[s]?.lastRunAt ?? null, ref: s });
  }
  const todos = parseTodos(inp.todo ?? "");
  const groups = groupTodos(todos, today);
  const open = todos.filter((t) => !t.done);
  if (groups.overdue.length) push(2, { area: "todo", kind: "overdue", tone: "warn", title: `${groups.overdue.length} overdue ${plural(groups.overdue.length, "to-do")}`, since: groups.overdue.map((t) => t.due!).sort()[0], ref: "overdue" });

  // 3 and 4: unread notifications (breaking first), to-dos due today
  const notes = (inp.notifications ?? []).filter((n) => n && typeof n.title === "string");
  const unread = notes.filter((n) => !n.read && !n.archived);
  for (const n of unread) if (n.level === "breaking") push(3, { area: "notifications", kind: "breaking", tone: "danger", title: n.title, since: n.created || null, ref: n.id });
  const rest = unread.filter((n) => n.level !== "breaking");
  if (rest.length) push(4, { area: "notifications", kind: "unread", tone: "info", title: `${rest.length} unread: ${rest.slice(0, 3).map((n) => n.title).join(", ")}`, since: null, ref: "unread" });
  if (groups.today.length) push(4, { area: "todo", kind: "today", tone: "info", title: `${groups.today.length} ${plural(groups.today.length, "to-do")} due today`, since: null, ref: "today" });

  // 5: memories written today and not yet reviewed
  const written = new Map<string, PulseInputs["trail"][number]>();
  for (const r of inp.trail ?? []) {
    if (!r || r.action !== "written" || !r.slug) continue;
    const t = new Date(r.ts);
    if (Number.isNaN(t.getTime()) || localDay(t) !== today) continue;
    written.set(`${r.type}/${r.slug}`, r);
  }
  const pending = [...written.values()].filter((r) => r.pending === true);
  if (pending.length) push(5, { area: "memory", kind: "review", tone: "off", title: `${pending.length} ${plural(pending.length, "memory", "memories")} written today, not yet reviewed`, since: null, ref: "review" });

  items.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const sa = sinceMs(a.since);
    const sb = sinceMs(b.since);
    if (sa !== sb) return sa === null ? 1 : sb === null ? -1 : sa - sb;
    return a.seq - b.seq;
  });
  const needsYou = items.map(({ tier, area, kind, tone, title, since, ref }) => ({ tier, area, kind, tone, title, since, ref }));

  const ws = inp.workspaces ?? [];
  const ages = proposals.map((p) => ageDays(p.filed, now)).filter((d): d is number => d !== null);
  const latest = unread[0] ?? null;
  return {
    schema: 1, at: now.toISOString(), persona: inp.personaName || null, needsYou,
    summary: {
      health: {
        errors: issues.filter((i) => i?.severity === "error").length,
        warnings: issues.filter((i) => i?.severity === "warn").length,
        notes: issues.filter((i) => i?.severity === "info").length,
        pipelines: pipeline,
      },
      decisions: { proposals: proposals.length, gates: (inp.gates ?? []).length, flags: flags.length, drafts, oldestDays: ages.length ? Math.max(...ages) : null },
      notifications: {
        total: notes.length, unread: unread.length,
        breaking: unread.filter((n) => n.level === "breaking").length, alerts: unread.filter((n) => n.level === "alert").length,
        latest: latest ? { title: latest.title, from: latest.from || "", created: latest.created || "" } : null,
      },
      todo: { open: open.length, done: todos.length - open.length, overdue: groups.overdue.length, today: groups.today.length },
      routines: { total: slugs.length, failing },
      memory: { writtenToday: written.size, pendingReview: pending.length, drafts },
      workspaces: { total: ws.length, active: ws.filter((w) => w?.status === "active").length },
      spend: { usd: Math.round((Number(inp.spend?.usd) || 0) * 100) / 100, calls: Number(inp.spend?.calls) || 0 },
    },
  };
}

/** Today's spend from provider-spend.jsonl text: the local day's rows, a call each, their usd summed. */
export function spendToday(text: string | null, now: Date): { usd: number; calls: number } {
  const day = localDay(now);
  const out = { usd: 0, calls: 0 };
  for (const line of (text ?? "").split("\n")) {
    let r: { ts?: string; usd?: unknown };
    try { r = JSON.parse(line); } catch { continue; }
    const t = new Date(String(r?.ts));
    if (!r || Number.isNaN(t.getTime()) || localDay(t) !== day) continue;
    out.calls++;
    if (typeof r.usd === "number" && Number.isFinite(r.usd)) out.usd += r.usd;
  }
  return out;
}

const MAX_NOTIFICATIONS = 300;

/** The inputs, read through the vault adapter (and the teams' disk adapter at the vault root). Each source on its own. */
export async function gatherPulseInputs(app: App, vaultRoot: string, now: Date = new Date()): Promise<PulseInputs> {
  const a = app.vault.adapter;
  const read = async (p: string): Promise<string | null> => { try { return (await a.exists(p)) ? await a.read(p) : null; } catch { return null; } };
  const list = async (p: string): Promise<{ files: string[]; folders: string[] }> => { try { return await a.list(p); } catch { return { files: [], folders: [] }; } };
  const json = async <T>(p: string): Promise<T | null> => { const t = await read(p); if (!t) return null; try { return JSON.parse(t) as T; } catch { return null; } };
  const base = (p: string): string => p.split("/").pop() ?? p;

  const proposals: PulseInputs["proposals"] = [];
  for (const f of (await list(PROPOSALS_DIR)).files.map(base).filter(isProposalFile).sort()) proposals.push({ name: f, text: (await read(`${PROPOSALS_DIR}/${f}`)) ?? "" });

  let gates: PulseInputs["gates"] = [];
  try {
    const teams = await readTeams(diskAdapter(vaultRoot), { boardOnly: true });
    gates = teams.filter((t) => !t.error).flatMap((t) => pendingGates(t).map((it) => ({ team: t.id, item: it.id, stage: it.stage || it.gate?.name || null, title: it.title || null, since: it.ts || null })))
      .sort((x, y) => String(x.since ?? "").localeCompare(String(y.since ?? "")));
  } catch { /* no teams */ }

  const snapshot = await json<{ health?: { issues?: { severity: string; area: string; message: string }[] }; workspaces?: { name: string; status: string; hidden?: boolean }[] }>(SNAPSHOT_PATH);
  const state = parseState(await read(STATE_PATH));
  const notifications: PulseInputs["notifications"] = [];
  const years = (await list(NOTIFICATIONS_DIR)).folders.filter((f) => /\/\d{4}$/.test(f));
  const files = (await Promise.all(years.map(async (y) => (await list(y)).files))).flat().filter((f) => notificationId(f)).sort().reverse().slice(0, MAX_NOTIFICATIONS);
  for (const f of files) {
    const n = parseNotification(f, (await read(f)) ?? "");
    if (!n) continue;
    notifications.push({ id: n.id, level: n.level, title: n.title, from: n.from, created: n.created, read: !!state[n.id]?.read, archived: !!state[n.id]?.archived });
  }

  const trail: PulseInputs["trail"] = [];
  const today = localDay(now);
  for (const r of parseTrail((await read(TRAIL_PATH)) ?? "", Infinity).reverse()) {
    if (r.action !== "written" || localDay(new Date(r.ts)) !== today) continue;
    const file = await read(`brain/memory/${r.type}/${r.slug}.md`);
    trail.push({ ts: r.ts, action: r.action, slug: r.slug, type: r.type, title: r.title || r.slug, pending: !!file && /^reviewed: false$/m.test(file) });
  }

  const pipelines = (await json<{ pipelines?: Record<string, PipelineState> }>("brain/_index/pipelines.json"))?.pipelines ?? {};
  const routines = (await json<{ routines?: PulseInputs["routines"] }>(ROUTINES_STATE_PATH))?.routines ?? {};
  const hub = parseBrainHub(await read(BRAIN_HUB_PATH));
  return {
    personaName: personaName(vaultRoot),
    proposals,
    stateMd: await read("persona/STATE.md"),
    drafts: (await list("brain/memory/feedback/_drafts")).files.filter((f) => f.endsWith(".md")).length,
    gates,
    issues: (snapshot?.health?.issues ?? []).map((i) => ({ severity: i.severity, area: i.area, message: i.message })),
    // Hidden entries (`_` folders, _archive/) are never counted (spaces-redesign D22); the twin read in lib/pulse-facts.js filters the same way.
    workspaces: (snapshot?.workspaces ?? []).filter((w) => w && !w.hidden).map((w) => ({ name: w.name, status: w.status })),
    pipelines,
    routines,
    todo: await read("TODO.md"),
    notifications,
    trail,
    spend: spendToday(await read("brain/_index/provider-spend.jsonl"), now),
    toReview: hub ? hub.counts.unreviewed : null,
    brainPct: brainMdPercent(parseBrainSources(await read(BRAIN_SOURCES_PATH))),
  };
}
