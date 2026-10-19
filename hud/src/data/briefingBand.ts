// The paragraph at the top of Pulse (spec 2026-10-08-pulse-cockpit-design P6, P7, P10, A3): the Chief of Staff's own,
// from brain/_index/briefing.json (brain/scripts/persona/briefing.js), while it is good and fresh; otherwise one composed
// here from the same facts, in the same words the writer hands its model (sayOf, fineOf), so both read alike.
import type { Area, NeedItem, PulseFacts, PulseInputs, PulseSummary } from "./pulseFacts";
import { ageDays } from "./proposals";
import { localDay } from "./todos";

export const BRIEFING_PATH = "brain/_index/briefing.json";
const TOP = 3;

export interface Mention { phrase: string; area: Area }
export interface BriefingFile {
  status: "ok" | "skipped" | "failed"; reason: string | null; text: string | null; mentions: Mention[];
  persona: string | null; provider: string | null; model: string | null; generatedAt: string | null; attemptedAt: string | null;
}
export interface Paragraph { text: string; mentions: Mention[]; source: "model" | "template"; at: string | null; reason: string | null }

const AREA_SET = new Set<string>(["needs", "health", "agents", "workspaces", "todo", "proposals", "notifications", "routines", "spend", "memory"]);

/** briefing.json, coerced; null when missing, unparseable or another schema. */
export function parseBriefing(raw: string | null): BriefingFile | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object" || o.schema !== 1) return null;
  const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const status = o.status === "ok" || o.status === "skipped" || o.status === "failed" ? o.status : "failed";
  const mentions = (Array.isArray(o.mentions) ? o.mentions : [])
    .filter((m): m is Mention => !!m && typeof m === "object" && typeof (m as Mention).phrase === "string" && AREA_SET.has(String((m as Mention).area)));
  return {
    status, reason: s(o.reason), text: s(o.text), mentions, persona: s(o.persona), provider: s(o.provider), model: s(o.model),
    generatedAt: s(o.generatedAt), attemptedAt: s(o.attemptedAt),
  };
}

export function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** `s` cut to `max` characters at a word boundary, with an ellipsis (briefing.js clip). */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/** The words for an item (briefing.js sayOf). */
export function sayOf(n: Pick<NeedItem, "kind" | "title">): string {
  if (n.kind === "proposal") return /\bproposal$/i.test(n.title) ? `the “${clip(n.title, 60)}”` : `the “${clip(n.title, 60)}” proposal`;
  return clip(n.title, n.kind === "flag" ? 70 : 80);
}

/** What is fine (briefing.js fineOf). */
export function fineOf(s: PulseSummary): Mention[] {
  const out: Mention[] = [];
  if (s.routines.total && !s.routines.failing) out.push({ phrase: `${s.routines.total} routines green`, area: "routines" });
  const p = s.health.pipelines;
  if (!p.failed && !p.stale && p.ok) out.push({ phrase: "pipelines healthy", area: "health" });
  if (s.todo.open && !s.todo.overdue) out.push({ phrase: "no overdue to-dos", area: "todo" });
  if (s.spend.usd) out.push({ phrase: `$${s.spend.usd.toFixed(2)} spent today`, area: "spend" });
  return out;
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The paragraph composed from the facts: the first item (and how long it has waited), up to two more, "and N more",
 *  then what is fine. Every mention is a span this function wrote. */
export function templateParagraph(f: PulseFacts, now: Date): { text: string; mentions: Mention[] } {
  const mentions: Mention[] = [];
  let text = `${greeting(now)}.`;
  const put = (s: string, area: Area | null): void => { if (area) mentions.push({ phrase: s, area }); text += s; };
  const top = f.needsYou.slice(0, TOP);
  if (!top.length) text += " Nothing needs you right now.";
  else {
    const first = top[0];
    const days = first.since ? ageDays(String(first.since).slice(0, 10), now) : null;
    text += " ";
    put(cap(sayOf(first)), first.area);
    text += days !== null && days >= 2 ? `, waiting ${days} days.` : ".";
    const others = top.slice(1);
    const more = f.needsYou.length - top.length;
    if (others.length) {
      text += " Also ";
      others.forEach((n, i) => { if (i) text += others.length > 1 && i === others.length - 1 && !more ? " and " : ", "; put(sayOf(n), n.area); });
      if (more > 0) { text += ", and "; put(`${more} more`, "needs"); }
      text += ".";
    } else if (more > 0) { text += " "; put(`${more} more`, "needs"); text += " need you."; }
  }
  const fine = fineOf(f.summary);
  if (fine.length) {
    text += " ";
    fine.forEach((m, i) => {
      if (i) text += i === fine.length - 1 ? " and " : ", ";
      put(i === 0 ? cap(m.phrase) : m.phrase, m.area);
    });
    text += ".";
  }
  return { text, mentions };
}

/** Which paragraph to show (P7): the model's while it is ok and younger than staleHours, else the composed one. */
export function chooseParagraph(file: BriefingFile | null, facts: PulseFacts, now: Date, staleHours: number): Paragraph {
  if (file && file.status === "ok" && file.text && file.generatedAt) {
    const age = now.getTime() - Date.parse(file.generatedAt);
    if (Number.isFinite(age) && age >= -60_000 && age <= staleHours * 3600_000) {
      return { text: file.text, mentions: file.mentions, source: "model", at: file.generatedAt, reason: null };
    }
  }
  const t = templateParagraph(facts, now);
  const reason = !file ? "not written yet" : file.status === "skipped" ? file.reason ?? "skipped" : file.status === "failed" ? "last run failed" : "out of date";
  return { ...t, source: "template", at: null, reason };
}

/** Text folded for finding a phrase (briefing.js fold): any case, any double quote as `"`, one character for one. */
const fold = (s: string): string => s.toLowerCase().replace(/[“”„‟″"]/g, '"');

/** The text cut into plain runs and mention runs, in order: each mention at its first place not already taken. */
export function mentionParts(text: string, mentions: Mention[]): { text: string; area: Area | null }[] {
  const lower = fold(text);
  const spans: { at: number; len: number; area: Area }[] = [];
  for (const m of mentions) {
    const p = fold(m.phrase);
    let at = lower.indexOf(p);
    while (at >= 0 && spans.some((s) => at < s.at + s.len && s.at < at + p.length)) at = lower.indexOf(p, at + 1);
    if (at >= 0 && p) spans.push({ at, len: p.length, area: m.area });
  }
  spans.sort((a, b) => a.at - b.at);
  const out: { text: string; area: Area | null }[] = [];
  let i = 0;
  for (const s of spans) {
    if (s.at > i) out.push({ text: text.slice(i, s.at), area: null });
    out.push({ text: text.slice(s.at, s.at + s.len), area: s.area });
    i = s.at + s.len;
  }
  if (i < text.length) out.push({ text: text.slice(i), area: null });
  return out;
}

/** "Since you last looked" (P10): what arrived after `seenAt`. Null before the first visit. */
export function sinceLine(inp: PulseInputs, seenAt: string | null, now: Date): { parts: string[]; at: string } | null {
  const t = seenAt ? Date.parse(seenAt) : NaN;
  if (!Number.isFinite(t) || t > now.getTime()) return null;
  const after = (iso: string | null | undefined): boolean => { const x = iso ? Date.parse(iso) : NaN; return Number.isFinite(x) && x > t; };
  const n = (k: number, one: string, many = `${one}s`): string => `+${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  const notes = inp.notifications.filter((x) => after(x.created)).length;
  if (notes) parts.push(n(notes, "notification"));
  const mem = inp.trail.filter((x) => x.action === "written" && after(x.ts)).length;
  if (mem) parts.push(n(mem, "memory", "memories"));
  // A proposal carries only its filing day: one filed on a later day than the last look is new.
  const filed = inp.proposals.filter((p) => { const d = /^(\d{4}-\d{2}-\d{2})/.exec(p.name); return !!d && d[1] > localDay(new Date(t)); }).length;
  const gates = inp.gates.filter((g) => after(g.since)).length;
  if (filed + gates) parts.push(n(filed + gates, "decision"));
  const failed = Object.values(inp.routines).filter((r) => r && (r.failStreak ?? 0) > 0 && after(r.lastRunAt ?? null)).length;
  if (failed) parts.push(`${failed} routine${failed === 1 ? "" : "s"} failed`);
  return { parts: parts.length ? parts : ["nothing new"], at: seenAt! };
}
