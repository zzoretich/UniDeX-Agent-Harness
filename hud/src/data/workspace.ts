// workspace.ts — the Agent Workspace's data side (spec 2026-11-12-agent-workspace-design, D7). Pure over a Team, which
// is itself built only from the team's own files; nothing here reads storage.
import { runTone, usd, titleCase, orderTeams, memberStatus, gateCards, memberTone, pendingGates } from "./teams";
import type { BoardItem, Team, Tone, MemberStatus, RunRow } from "./teams";
import { groupAgents, filterAgents } from "./agents";
import type { AgentsCache, AgentRow } from "./agents";

export const ACTIVITY_PAGE = 50;

export type ActivityKind = "run-start" | "run-end" | "item-new" | "stage" | "gate-open" | "gate-decided" | "budget" | "post";
export interface ActivityEvent { ts: string; kind: ActivityKind; member: string | null; item: string | null; text: string; tone: Tone }

/** How the feed names who did something (agent-workspace R18): as the team's roster names the member, so the feed and the
 *  tree agree; the title-cased id for one not on the roster (dispatch, a member since removed); "You" for the user. */
function namer(t: Team): (id: string | null | undefined) => string {
  const names = new Map(t.members.map((m) => [m.id, m.name]));
  return (id) => (!id ? "Someone" : id === "user" ? "You" : names.get(id) ?? titleCase(id));
}

const isPending = (it: BoardItem | undefined): boolean => !!it && it.status === "gate" && it.gate?.state === "pending";

/** What happened on the team, newest first: board snapshots, finished runs, live markers and channel posts. */
export function activityOf(t: Team): ActivityEvent[] {
  const who = namer(t);
  const out: ActivityEvent[] = [];
  const prev = new Map<string, BoardItem>();
  for (const it of t.history) {
    const p = prev.get(it.id);
    prev.set(it.id, it);
    if (!p) {
      out.push({ ts: it.ts, kind: "item-new", member: it.by, item: it.id, tone: "is-neutral", text: `${who(it.by)} added ${it.id}${it.title ? `: ${it.title}` : ""}` });
    } else if (p.stage !== it.stage) {
      out.push({ ts: it.ts, kind: "stage", member: it.by, item: it.id, tone: "is-neutral", text: `${who(it.by)} moved ${it.id} from ${p.stage || "none"} to ${it.stage}` });
    }
    if (isPending(it) && !(isPending(p) && p?.gate?.name === it.gate?.name)) {
      // The lead's pitch rides on the event: its latest gate post on the item at or before this snapshot.
      const pitch = [...t.channel].reverse().find((c) => c.item === it.id && c.kind === "gate" && c.from === t.lead && c.ts && c.ts <= it.ts);
      out.push({ ts: it.ts, kind: "gate-open", member: it.by, item: it.id, tone: "is-gate", text: `${who(it.by)} opened the ${it.gate?.name} gate on ${it.id}${pitch?.text ? `: "${pitch.text}"` : ""}` });
    }
    const g = it.gate;
    if (g && g.by === "user" && g.ts && (!p?.gate || p.gate.name !== g.name || p.gate.ts !== g.ts)) {
      const verb = g.state === "approved" ? "approved" : g.state === "redirected" ? "redirected" : g.state === "rejected" ? "rejected" : `decided (${g.state})`;
      out.push({ ts: g.ts, kind: "gate-decided", member: "user", item: it.id, tone: g.state === "approved" ? "is-ok" : "is-stale", text: `You ${verb} the ${g.name} gate on ${it.id}` });
    }
    if (p && p.budget.usd !== it.budget.usd) {
      out.push({ ts: it.ts, kind: "budget", member: it.by, item: it.id, tone: "is-neutral", text: `${who(it.by)} set the budget for ${it.id} to ${usd(it.budget.usd)} (was ${usd(p.budget.usd)})` });
    }
  }
  for (const r of t.runs) {
    const bits = [r.status === "?" ? "" : r.status, r.provider ?? "", r.usd != null ? usd(r.usd) : ""].filter(Boolean).join(" · ");
    out.push({ ts: r.ts, kind: "run-end", member: r.member || null, item: r.item, tone: runTone(r.status), text: `${who(r.member)} finished ${r.item ?? "a run"}${bits ? `: ${bits}` : ""}` });
  }
  for (const m of t.live) {
    if (!m.startedAt) continue;
    const stage = m.item ? t.board.find((b) => b.id === m.item)?.stage : "";
    out.push({
      ts: m.startedAt, kind: "run-start", member: m.member || null, item: m.item, tone: "is-live",
      text: `${who(m.member)} started ${m.item ?? "a run"}${stage ? ` (${stage})` : ""}${m.provider ? ` on ${m.provider}` : ""}`,
    });
  }
  // Gate posts are already gate-open (with the pitch) and gate-decided events; the rest of the channel is the team talking.
  for (const p of t.channel) {
    if (p.kind === "gate") continue;
    out.push({ ts: p.ts, kind: "post", member: p.from, item: p.item, tone: p.kind === "blocker" ? "is-failed" : "is-neutral", text: `${who(p.from)}: ${p.text}` });
  }
  // Newest first; a stable sort keeps one row's events in the order they were pushed.
  return out.filter((e) => e.ts).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

export type StripCell = "done" | "current" | "gate" | "blocked" | "todo";

/** One cell per team stage: done before the item's stage, its state at it, todo after. A finished item is all done;
 *  an item whose stage the team no longer lists is all todo. */
export function stageStrip(t: Team, it: BoardItem): StripCell[] {
  if (it.status === "done") return t.stages.map(() => "done");
  const at = t.stages.indexOf(it.stage);
  if (at < 0) return t.stages.map(() => "todo");
  const here: StripCell = it.status === "gate" ? "gate" : it.status === "blocked" ? "blocked" : "current";
  return t.stages.map((_, i) => (i < at ? "done" : i === at ? here : "todo"));
}

const rank = (it: BoardItem): number =>
  isPending(it) ? 0 : it.status === "blocked" ? 1 : it.status === "working" ? 2 : it.status === "paused" ? 4 : 3;

/** The Items list: what needs the user first (pending gate, blocked), then working, other open, paused; done apart. Ties keep board order. */
export function itemOrder(t: Team): { open: BoardItem[]; done: BoardItem[] } {
  const done = t.board.filter((i) => i.status === "done");
  const open = t.board.map((it, i) => ({ it, i })).filter((x) => x.it.status !== "done")
    .sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i).map((x) => x.it);
  return { open, done };
}

// ── the org tree (spec D4, D5, D11, D12, D15) ──

/** "needs", "team:<team>", "agent:<agentId>", or "member:<team>/<member>" (a member whose agent is not in agents.json). */
export type NodeKey = string;
export interface TreeRow { key: NodeKey; kind: "needs" | "section" | "team" | "member" | "agent"; label: string; depth: number; tone: Tone | null; lead?: boolean; broken?: boolean; count?: number }

export interface Seat { team: Team; member: MemberStatus }

/** Every seat the agent holds, one per team that lists it (a team that failed to parse has no seats). */
export function seatsOf(teams: Team[], agentId: string): Seat[] {
  const out: Seat[] = [];
  for (const team of teams) {
    if (team.error) continue;
    for (const member of memberStatus(team)) if (member.agent === agentId) out.push({ team, member });
  }
  return out;
}

/** Your own agents that sit in no team. */
export function benchOf(agents: AgentsCache, teams: Team[]): AgentRow[] {
  const seated = new Set<string>();
  for (const t of teams) if (!t.error) for (const m of t.members) if (m.agent) seated.add(m.agent);
  return groupAgents(agents.agents).yours.filter((a) => !seated.has(a.id));
}

const DAY_MS = 86_400_000;
/** Dollars spent in the last 7 × 24 h; a run with no cost counts nothing. */
export function weekUsd(runs: RunRow[], now: Date): number {
  const from = now.getTime() - 7 * DAY_MS;
  return runs.reduce((n, r) => { const at = Date.parse(r.ts); return Number.isFinite(at) && at >= from && r.usd != null ? n + r.usd : n; }, 0);
}

/** Every run made by the agent's seats, newest first, with the team it ran in, and what they cost this week. */
export function agentRuns(teams: Team[], agentId: string, now: Date): { runs: (RunRow & { team: string })[]; weekUsd: number } {
  const runs: (RunRow & { team: string })[] = [];
  for (const { team, member } of seatsOf(teams, agentId)) for (const r of team.runs) if (r.member === member.id) runs.push({ ...r, team: team.id });
  runs.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { runs, weekUsd: weekUsd(runs, now) };
}

// Teams and the bench start open and the plugins section starts folded; `folded` holds the sections the user has toggled
// away from that start, so a section is folded when its default differs from its being in the set. A search ignores folds.
// Passed as `folded` itself, it opens every section (the tab picks its node from that whole tree).
export const FOLDED_BY_DEFAULT: ReadonlySet<NodeKey> = new Set(["section:plugins"]);
/** The notes the tree holds when there is nothing to list (D15): under TEAMS with no team (the tab draws Seed the example
 *  team and + New team with it), and under BENCH when the agents list has none of yours. Rows of kind "section", never
 *  picked or folded, like the unscanned note. */
export const NO_TEAMS: NodeKey = "teams:none";
export const NO_AGENTS: NodeKey = "bench:none";
const hasText = (q: string, ...parts: (string | null | undefined)[]): boolean => parts.some((p) => !!p && p.toLowerCase().includes(q));

/** The left tree: Needs you, TEAMS (nested by parent, each team then its members, lead first), BENCH, PLUGINS & CONFIG.TOML.
 *  The query matches team, member and agent names and descriptions; a matching member keeps its team and the team's parents.
 *  With no team, TEAMS holds the NO_TEAMS note and BENCH every agent of yours; with none of yours, BENCH holds NO_AGENTS. */
export function workspaceTree(teams: Team[], agents: AgentsCache, o: { query: string; folded: ReadonlySet<NodeKey> }): TreeRow[] {
  const q = o.query.trim().toLowerCase();
  const byId = new Map(agents.agents.map((a) => [a.id, a]));
  const open = (key: NodeKey): boolean => !!q || FOLDED_BY_DEFAULT.has(key) === o.folded.has(key);
  const rows: TreeRow[] = [];
  const gates = gateCards(teams).length;
  rows.push({ key: "needs", kind: "needs", label: "Needs you", depth: 0, tone: gates ? "is-gate" : null, count: gates });

  // TEAMS
  const ordered = orderTeams(teams);
  type Shown = { team: Team; depth: number; all: boolean; members: MemberStatus[] };
  const shown = new Map<string, Shown>();
  for (const { team, depth } of ordered) {
    const members = team.error ? [] : memberStatus(team).sort((a, b) => Number(b.lead) - Number(a.lead));
    const agent = (m: MemberStatus) => (m.agent ? byId.get(m.agent) : undefined);
    const all = !q || hasText(q, team.name, team.id);
    const mine = all ? members : members.filter((m) => hasText(q, m.name, m.id, m.role, agent(m)?.name, agent(m)?.description));
    if (all || mine.length) shown.set(team.id, { team, depth, all, members: mine });
  }
  // A kept team keeps its parents, so a child never floats at the wrong depth.
  for (const id of [...shown.keys()]) {
    let p = shown.get(id)!.team.parent;
    for (let n = 0; p && n < teams.length; n++) {
      const up = ordered.find((x) => x.team.id === p);
      if (!up) break;
      if (!shown.has(up.team.id)) shown.set(up.team.id, { team: up.team, depth: up.depth, all: false, members: [] });
      p = up.team.parent;
    }
  }
  const teamRows = ordered.filter((x) => shown.has(x.team.id));
  rows.push({ key: "section:teams", kind: "section", label: "TEAMS", depth: 0, tone: null, count: teamRows.length });
  if (open("section:teams") && !teams.length && !q) rows.push({ key: NO_TEAMS, kind: "section", label: "No teams yet", depth: 1, tone: null });
  if (open("section:teams")) {
    for (const { team } of teamRows) {
      const s = shown.get(team.id)!;
      const pending = team.error ? 0 : pendingGates(team).length;
      const working = s.members.some((m) => m.status === "working");
      const tone: Tone | null = team.error ? "is-failed" : pending ? "is-gate" : team.disabled ? "is-off" : working ? "is-live" : null;
      rows.push({ key: `team:${team.id}`, kind: "team", label: team.name || team.id, depth: 1 + s.depth, tone, ...(team.error ? { broken: true } : {}), ...(pending ? { count: pending } : {}) });
      for (const m of s.members) {
        const a = m.agent ? byId.get(m.agent) : undefined;
        rows.push({ key: a ? `agent:${a.id}` : `member:${team.id}/${m.id}`, kind: "member", label: m.name || m.id, depth: 2 + s.depth, tone: memberTone(m.status), ...(m.lead ? { lead: true } : {}) });
      }
    }
  }

  // BENCH
  const bench = filterAgents(benchOf(agents, teams), q);
  rows.push({ key: "section:bench", kind: "section", label: "BENCH", depth: 0, tone: null, count: bench.length });
  if (open("section:bench")) {
    if (agents.scannedAt === null) rows.push({ key: "bench:unscanned", kind: "section", label: "not scanned yet — sync now", depth: 1, tone: null });
    else if (!q && !groupAgents(agents.agents).yours.length) {
      rows.push({ key: NO_AGENTS, kind: "section", label: "none yet — an agent is a .md file in Claude Code's agents folder or a .toml file in Codex's", depth: 1, tone: null });
    }
    for (const a of bench) rows.push({ key: `agent:${a.id}`, kind: "agent", label: a.name, depth: 1, tone: null });
  }

  // PLUGINS & CONFIG.TOML
  const listed = filterAgents(groupAgents(agents.agents).listed, q);
  rows.push({ key: "section:plugins", kind: "section", label: "PLUGINS & CONFIG.TOML", depth: 0, tone: null, count: listed.length });
  if (open("section:plugins")) for (const a of listed) rows.push({ key: `agent:${a.id}`, kind: "agent", label: a.name, depth: 1, tone: null });
  return rows;
}

/** Which node the tab shows: the one asked for (a link or the router) if it is in the tree; Needs you when a link arrives
 *  with gates waiting; the saved node if it is still there; Needs you when gates wait; else the first team that is not broken (the first team if all are), then the first agent. */
export function pickNode(o: { saved: NodeKey | null; via: "rail" | "link"; asked: NodeKey | null; gates: number; tree: TreeRow[] }): NodeKey {
  const has = (k: NodeKey | null): k is NodeKey => !!k && o.tree.some((r) => r.key === k);
  if (has(o.asked)) return o.asked;
  if (o.via === "link" && o.gates > 0) return "needs";
  if (has(o.saved)) return o.saved;
  if (o.gates > 0) return "needs";
  const teams = o.tree.filter((r) => r.kind === "team");
  return (teams.find((r) => !r.broken) ?? teams[0])?.key ?? o.tree.find((r) => r.kind === "agent" || r.kind === "member")?.key ?? "needs";
}
