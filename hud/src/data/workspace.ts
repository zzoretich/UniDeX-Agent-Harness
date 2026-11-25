// workspace.ts — the Agent Workspace's data side (spec 2026-11-12-agent-workspace-design, D7). Pure over a Team, which
// is itself built only from the team's own files; nothing here reads storage.
import { runTone, usd, titleCase } from "./teams";
import type { BoardItem, Team, Tone } from "./teams";

export const ACTIVITY_PAGE = 50;

export type ActivityKind = "run-start" | "run-end" | "item-new" | "stage" | "gate-open" | "gate-decided" | "budget" | "post";
export interface ActivityEvent { ts: string; kind: ActivityKind; member: string | null; item: string | null; text: string; tone: Tone }

const who = (id: string | null | undefined): string => (!id ? "Someone" : id === "user" ? "You" : titleCase(id));

const isPending = (it: BoardItem | undefined): boolean => !!it && it.status === "gate" && it.gate?.state === "pending";

/** What happened on the team, newest first: board snapshots, finished runs, live markers and channel posts. */
export function activityOf(t: Team): ActivityEvent[] {
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
