// brainSweep.ts — the consolidation sweep's cards against the files (spec 2026-10-12-brain-hub-ai A3, A10, A11; brain-hub
// D22; plan PR 4 "HUD › Sweep"). Pure: it takes brain/_index/memory-sweep.json (BrainData.sweep), the memories, the hub's
// clusters and the map, and gives Health and Map each card's state and words, the "last run" line, the cards a scope
// shows, the paths a scoped sweep sends and the questions asked before a card applies. views/brain/SweepCards.ts draws them.
//
// memory-sweep.json says what the sweep saw; the files say what happened since, and win (A10): a card one of whose
// memories was retired (archived, superseded, gone), or whose retitle is now the title, is done; one whose memory changed
// otherwise is stale (its hash differs). A dismissed card is hidden for good. Only open and stale cards are listed, stale
// with its word.
//
// A scoped sweep (Consolidate with AI…, A3) is keyed by sweepScopeKey(paths) (the runtime's key: the sorted paths). A
// group's members change as its memories are merged or archived, which changes that key, so a group also shows the
// cards of an earlier run on the same lead (the first path it sent).
import {
  SWEEP_KIND_LABEL, SWEEP_MAX_PATHS, aiReasonText, capText, estimateText, shortDay, spendText, sweepScopeKey,
  type AiEstimate, type BrainHub, type BrainMap, type BrainMemory, type SweepCard, type SweepEstimate, type SweepFile,
  type SweepKind, type SweepResult, type SweepRun,
} from "./brainModel";
import { liveClusters, pl } from "./brainHealth";

/** What the sweep's words need from a load (views/brain/types.ts BrainData has all of it). */
export interface SweepInput {
  now: Date;
  byPath: ReadonlyMap<string, BrainMemory>;
  hub: BrainHub | null;
  map: BrainMap | null;
  sweep: SweepFile | null;
}

// ── a card's state (A10: the files win) ──

export type SweepState = "open" | "stale" | "done" | "dismissed";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * A card against the files: dismissed (hidden for good, whatever happened since), done (a memory retired or gone, or a
 * retitle whose title is now the memory's), stale (a memory changed since the sweep read it), else open.
 */
export function sweepState(card: SweepCard, byPath: ReadonlyMap<string, Pick<BrainMemory, "live" | "title" | "hash">>): SweepState {
  if (card.state === "dismissed") return "dismissed";
  const ms = card.paths.map((p) => byPath.get(p));
  if (ms.some((m) => !m || !m.live)) return "done";
  if (card.kind === "retitle" && oneLine(card.title) && oneLine(ms[0]!.title) === oneLine(card.title)) return "done";
  if (ms.some((m, i) => !!card.hashes[i] && card.hashes[i] !== m!.hash)) return "stale";
  return "open";
}

// ── a card's words ──

export interface SweepCardView {
  card: SweepCard;
  id: string;
  kind: SweepKind;
  /** Only the listed states: open, or stale (shown with its word). */
  state: "open" | "stale";
  /** The kind as a word: Merge, Archive, Retitle. */
  word: string;
  /** What it does: "3 into “Tide API”", "2 memories", "“Old title” to “New title”". */
  what: string;
  /** Each memory's title as its file says now (its slug when the file is gone). */
  titles: Array<{ path: string; title: string }>;
  why: string;
  /** The state's word: "changed since the sweep" when stale, "" when open. */
  note: string;
  /** Review's accessible name: "Review: Merge 3 into “Tide API”". */
  label: string;
}

const slugOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/, "");
const titleIn = (byPath: ReadonlyMap<string, Pick<BrainMemory, "title">>, p: string): string => byPath.get(p)?.title ?? slugOf(p);

export const STALE_WORD = "changed since the sweep";

/** One card's words, or null when it is not listed (done or dismissed). */
export function sweepCardView(card: SweepCard, byPath: ReadonlyMap<string, BrainMemory>): SweepCardView | null {
  const state = sweepState(card, byPath);
  if (state !== "open" && state !== "stale") return null;
  const titles = card.paths.map((path) => ({ path, title: titleIn(byPath, path) }));
  const n = card.paths.length;
  const proposed = oneLine(card.title);
  const what = card.kind === "merge" ? (proposed ? `${n} into “${proposed}”` : `${n} memories into one`)
    : card.kind === "archive" ? pl(n, "memory", "memories")
    : `“${titles[0].title}” to “${proposed}”`;
  const word = SWEEP_KIND_LABEL[card.kind];
  return { card, id: card.id, kind: card.kind, state, word, what, titles, why: oneLine(card.why), note: state === "stale" ? STALE_WORD : "", label: `Review: ${word} ${what}` };
}

/** The listed cards among `cards`: open first, then stale, each in the file's order. */
export function sweepViews(cards: readonly SweepCard[], byPath: ReadonlyMap<string, BrainMemory>): SweepCardView[] {
  const vs = cards.map((c) => sweepCardView(c, byPath)).filter((v): v is SweepCardView => !!v);
  return [...vs.filter((v) => v.state === "open"), ...vs.filter((v) => v.state === "stale")];
}

// ── scopes: the whole brain (null), or a community's or a cluster's paths ──

/** A run's scope key (null: the whole brain), as its cards carry it. */
export function runScope(run: Pick<SweepRun, "scope">): string | null {
  return run.scope && run.scope.paths.length ? sweepScopeKey(run.scope.paths) : null;
}

/**
 * The paths a scoped sweep sends for a group (A3): the lead first, then the rest most linked first (`degree`, ties in the
 * order given), at most SWEEP_MAX_PATHS. `of` is the group's size and `cut` how many were left out (the page says so).
 */
export function scopePaths(lead: string | null, paths: readonly string[], degree: (p: string) => number = () => 0): { paths: string[]; of: number; cut: number } {
  const uniq = [...new Set(paths)];
  const rest = uniq.filter((p) => p !== lead).map((p, i) => ({ p, i, d: degree(p) })).sort((a, b) => b.d - a.d || a.i - b.i).map((x) => x.p);
  const all = lead && uniq.includes(lead) ? [lead, ...rest] : rest;
  const sent = all.slice(0, SWEEP_MAX_PATHS);
  return { paths: sent, of: all.length, cut: all.length - sent.length };
}

/**
 * The scope keys a group's panel shows: the key of the paths it would send now, and that of every run whose scope had
 * the same lead (its first path): merging or archiving members since changes the key, never the lead.
 */
export function groupScopes(file: SweepFile | null, paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  const own = sweepScopeKey(paths);
  if (own) out.add(own);
  const lead = paths[0];
  for (const r of file?.runs ?? []) {
    const k = runScope(r);
    if (k && lead && r.scope!.paths[0] === lead) out.add(k);
  }
  return out;
}

/**
 * What a scope is called (A3: its cards show "under the group's name"): the Health cluster with those memories (or that
 * lead), else the Map community it leads, else the lead's title and how many more.
 */
export function scopeName(paths: readonly string[], d: Pick<SweepInput, "byPath" | "hub" | "map">): string {
  if (!paths.length) return "Whole brain";
  const lead = paths[0];
  const key = [...paths].sort().join("\n");
  for (const k of liveClusters(d.hub, d.byPath)) {
    if ([...k.paths].sort().join("\n") === key || k.paths[0] === lead) return k.label || titleIn(d.byPath, k.paths[0]);
  }
  const c = d.map?.communities.find((x) => x.lead === lead);
  if (c) { const m = d.byPath.get(c.lead); return m && m.live ? m.title : c.name; }
  const t = titleIn(d.byPath, lead);
  return paths.length > 1 ? `${t} and ${paths.length - 1} more` : t;
}

/** "today" for an instant on `now`'s day (local time), else "Oct 9" (with the year when not this one). */
export function runDay(at: string, now: Date): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate() ? "today" : shortDay(at, now);
}

/**
 * The sweep's line: "last run today · 6 suggestions · 3 open", with "N changed since" when cards went stale and "340 of
 * 350 memories looked at" when the prompt was capped (A11); `on` names a scoped run's group. "No sweep yet" without a run.
 */
export function sweepLine(run: SweepRun | null, views: readonly Pick<SweepCardView, "state">[], now: Date, on: string | null = null): string {
  if (!run) return "No sweep yet";
  const day = runDay(run.at, now);
  const open = views.filter((v) => v.state === "open").length;
  const stale = views.length - open;
  return [
    `last run${day ? ` ${day}` : ""}${on ? ` on “${on}”` : ""}`,
    pl(run.suggestions, "suggestion"),
    `${open} open`,
    stale ? `${stale} changed since` : "",
    run.of > 0 && run.considered < run.of ? `${run.considered} of ${run.of} memories looked at` : "",
  ].filter(Boolean).join(" · ");
}

export interface SweepGroup {
  /** null: the whole brain; else a scope key. */
  scope: string | null;
  name: string;
  cards: SweepCardView[];
}

/**
 * Health's Consolidation sweep card: the listed cards grouped by scope, the whole brain first, then each scope by its
 * newest run, named (scopeName). `claimed` scopes are drawn elsewhere on the page (under their cluster row) and left out,
 * so a card shows once.
 */
export function sweepGroups(d: SweepInput, claimed: ReadonlySet<string> = new Set()): SweepGroup[] {
  const f = d.sweep;
  if (!f) return [];
  const by = new Map<string | null, SweepCardView[]>();
  for (const v of sweepViews(f.suggestions, d.byPath)) {
    if (v.card.scope && claimed.has(v.card.scope)) continue;
    const list = by.get(v.card.scope) ?? [];
    list.push(v);
    by.set(v.card.scope, list);
  }
  const order: Array<string | null> = [];
  if (by.has(null)) order.push(null);
  for (const r of f.runs) { const k = runScope(r); if (k && by.has(k) && !order.includes(k)) order.push(k); }
  for (const k of by.keys()) if (!order.includes(k)) order.push(k);
  return order.map((k) => {
    const run = k ? f.runs.find((r) => runScope(r) === k) : null;
    return { scope: k, name: k === null ? "Whole brain" : run?.scope ? scopeName(run.scope.paths, d) : "An earlier scoped sweep", cards: by.get(k)! };
  });
}

/** Every listed card, and the sweep line over them (Health's card: the newest run of any scope, named when scoped). */
export function sweepSummary(d: SweepInput): { line: string; run: SweepRun | null; views: SweepCardView[] } {
  const f = d.sweep;
  const views = f ? sweepViews(f.suggestions, d.byPath) : [];
  const run = f?.runs[0] ?? null;
  const on = run?.scope?.paths.length ? scopeName(run.scope.paths, d) : null;
  return { line: sweepLine(run, views, d.now, on), run, views };
}

/** A group's cards and line (a Health cluster row, a Map community's panel): the scopes groupScopes gives. */
export function scopeSummary(d: SweepInput, scopes: ReadonlySet<string>): { line: string; run: SweepRun | null; views: SweepCardView[] } {
  const f = d.sweep;
  if (!f || !scopes.size) return { line: sweepLine(null, [], d.now), run: null, views: [] };
  const views = sweepViews(f.suggestions.filter((c) => c.scope !== null && scopes.has(c.scope)), d.byPath);
  const run = f.runs.find((r) => { const k = runScope(r); return k !== null && scopes.has(k); }) ?? null;
  return { line: sweepLine(run, views, d.now), run, views };
}

// ── the estimate, the questions, the answers ──

/** Why the sweep is off, and what still works: Merge drafts on Ollama when only Ollama answers (A7), else by hand (A4). */
export function sweepOffText(e: Pick<AiEstimate, "reason" | "cap">): string {
  return `${aiReasonText(e.reason, e.cap)} ${e.reason === "ollama-only" ? "Merge with AI still works, on Ollama." : "Merge with AI still works by hand."}`;
}

/**
 * Health's estimate line before a run (A5): "about $0.06 · haiku · Claude · today $0.12 of $0.50", with "looks at 340
 * of 350 memories" when the prompt would be capped (A11); off: the reason and what still works.
 */
export function sweepEstimateLine(e: SweepEstimate): { off: boolean; text: string } {
  if (!e.estimate.available) return { off: true, text: sweepOffText(e.estimate) };
  const cap = capText(e.estimate.cap);
  const part = e.of > 0 && e.considered < e.of ? `looks at ${e.considered} of ${e.of} memories` : "";
  return { off: false, text: [estimateText(e.estimate), cap, part].filter(Boolean).join(" · ") };
}

/** Consolidate with AI…'s question (A3): the group, what a model does, what it costs, and the members left out. */
export function consolidateAsk(name: string, e: SweepEstimate, sent: { paths: readonly string[]; of: number; cut: number }): { title: string; message: string; confirm: string } {
  const n = sent.paths.length;
  const reads = e.of > 0 && e.considered < e.of ? `${e.considered} of these ${e.of} memories` : n === 1 ? "this memory" : `these ${n} memories`;
  const cut = sent.cut > 0 ? ` It looks at the ${n} most linked of the ${sent.of}.` : "";
  const cap = capText(e.estimate.cap);
  return {
    title: `Consolidate “${name}” with AI?`,
    message: `A model reads ${reads} and suggests merges, archives and retitles; nothing changes until you apply one.${cut} Cost: ${estimateText(e.estimate)}${cap ? `, ${cap}` : ""}.`,
    confirm: "Run the sweep",
  };
}

/** The Notice after a sweep: "Sweep: 4 suggestions · swept by haiku · Claude · $0.06", with the memories it looked at. */
export function sweepDoneText(r: SweepResult | null, name: string | null = null): string {
  const head = name ? `Sweep of “${name}”` : "Sweep";
  if (!r) return `${head}: done`;
  const n = r.suggestions.length;
  const capped = r.run.of > 0 && r.run.considered < r.run.of ? ` · ${r.run.considered} of ${r.run.of} memories looked at` : "";
  return `${head}: ${n ? pl(n, "suggestion") : "nothing to suggest"} · ${spendText({ ...r.run, cap: null }, "swept by")}${capped}`;
}

/** A card's Archive question (spec §6: the count, the titles, the way back, and why the sweep suggests it). */
export function archiveAsk(v: Pick<SweepCardView, "titles" | "why">): { title: string; message: string; confirm: string } {
  const n = v.titles.length;
  const names = v.titles.map((t) => `“${t.title}”`);
  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return {
    title: `Archive ${pl(n, "memory", "memories")}?`,
    message: `Archives ${list}. ${n === 1 ? "It leaves" : "They leave"} recall, the MOCs and BRAIN.md. Nothing is deleted: Restore in Library puts ${n === 1 ? "it" : "each one"} back.${v.why ? ` The sweep's reason: ${v.why}` : ""}`,
    confirm: n === 1 ? "Archive" : `Archive ${n}`,
  };
}

/** A card's Retitle question (A10): the slug stays, so links keep working. */
export function retitleAsk(old: string, card: Pick<SweepCard, "title" | "description" | "why">): { title: string; message: string; confirm: string } {
  const desc = oneLine(card.description);
  const why = oneLine(card.why);
  return {
    title: `Retitle '${oneLine(old)}' to '${oneLine(card.title)}'?`,
    message: `The heading and its MEMORY.md line change; the file name stays, so links keep working.${desc ? ` The description becomes “${desc}”.` : ""}${why ? ` The sweep's reason: ${why}` : ""}`,
    confirm: "Retitle",
  };
}
