// brainBootstrap.ts — Bootstrap's data (spec 2026-10-11-brain-hub D17, D18; plan PR 3 "HUD › Bootstrap"). Pure: it takes
// what BrainTab loaded (brain-sources.json, the memory files, MEMORY.md, SESSION.md, recall-wake.md, brain-hub.json) and
// gives views/brain/BootstrapMode.ts its budget bars, BRAIN.md by section, the looks-shipped suggestions and what marking
// them complete frees, the SESSION.md and MEMORY.md cards and the recall preview's rows. Nothing here touches the vault.
//
// The rules mirror the runtime, one rule read twice: build-brain-md.js (parseMemoryIndex, bulletFor, clampToChars,
// BULLET_DESC_CHARS) for what a line of BRAIN.md costs; brain-hub.js SHIPPED for "looks shipped"; sdk/lib/recall.js
// (ageFlag, writeWakeRecall) for a hit's age and recall-wake.md's lines; auto-wrap.js writeWrapStatus and wrap-session.js
// hasPromoteTag for SESSION.md.
//
// BRAIN.md is what brain-sources.json says it was built from (D10); the files win over it only to drop what changed since
// (a rule unpinned, a project marked complete, a memory archived), so a row never offers an action the file already took.
import {
  MEMORY_PATH_RE, PATTERNS_DIR, SESSION_BUDGET, WAKE_MAX, clip, estimateTokens, firstParagraph, indexLineCount,
  type BrainHub, type BrainMemory, type BrainNote, type BrainSources, type RecallHit,
} from "./brainModel";

/** What Bootstrap reads of BrainTab's load (views/brain/types.ts BrainData has every field). */
export interface BootstrapInput {
  sources: BrainSources | null;
  byPath: ReadonlyMap<string, BrainMemory>;
  /** MEMORY.md's first description per path (brainModel parseIndexLines). */
  index: ReadonlyMap<string, string>;
  indexRaw: string | null;
  hub: BrainHub | null;
  session: string | null;
  wake: string | null;
}

const pl = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── a line of BRAIN.md (build-brain-md.js) ──

/** build-brain-md.js BULLET_DESC_CHARS: a Critical rules or Active context line's description is cut to this. */
export const BULLET_DESC_CHARS = 72;

/** build-brain-md.js clampToChars: at most `max` characters, at a word break when one is past 60%, with an ellipsis. */
export function clampToChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const wordBreak = cut.lastIndexOf(" ");
  return `${(wordBreak > max * 0.6 ? cut.slice(0, wordBreak) : cut).trimEnd()}…`;
}

export interface IndexEntry { title: string; description: string }

/** MEMORY.md's title and description per path, as build-brain-md.js parseMemoryIndex reads them (a later line wins). */
export function indexEntries(raw: string | null): Map<string, IndexEntry> {
  const out = new Map<string, IndexEntry>();
  for (const m of String(raw ?? "").matchAll(/^-\s*\[([^\]]+)\]\(([^)]+)\)\s*—\s*(.*)$/gm)) {
    out.set(m[2].trim(), { title: m[1].trim(), description: m[3].trim() });
  }
  return out;
}

const slugOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

/** A memory's line in Critical rules or Active context (build-brain-md.js bulletFor). */
export function brainBullet(path: string, entries: ReadonlyMap<string, IndexEntry>): string {
  const e = entries.get(path);
  if (!e) return `- **${slugOf(path)}** — (no MEMORY.md entry)`;
  return `- **${e.title}** — ${clampToChars(e.description, BULLET_DESC_CHARS)}`;
}

// ── "looks shipped" (D17) ──

/**
 * brain-hub.js SHIPPED (brain-hub D17): a full x.y.z version, "shipped", "released" (not "release") or "superseded" in an
 * active project's title or index line; never "merged" (a merged PR is a step, not the end of a project). A version
 * stands alone (no digit or dot before it, no `.digit` after it): an address such as 127.0.0.1 is not one.
 */
export const SHIPPED = /(?<![\d.])\bv?\d+\.\d+\.\d+\b(?!\.\d)|\bshipped\b|\breleased\b|\bsuperseded\b/i;

/** What made a project look shipped (the version or the word, as written), or null. `description` is the memory's own,
 *  else its MEMORY.md line's (brain-hub.js). */
export function shippedWhy(title: string, description: string | null | undefined): string | null {
  const hit = SHIPPED.exec(title) ?? SHIPPED.exec(description ?? "");
  return hit ? hit[0] : null;
}

// ── BRAIN.md by section (D10, D17) ──

export interface BootstrapRow {
  path: string;
  /** As BRAIN.md shows it: MEMORY.md's title, else the memory's H1. */
  title: string;
  /** As BRAIN.md shows it: MEMORY.md's description cut to BULLET_DESC_CHARS ("" when there is none). */
  description: string;
  /** Its whole line in BRAIN.md, and that line's tokens (what leaving it out frees). */
  line: string;
  tokens: number;
  /** The file as this page read it: `set --expect` takes its hash (D17). */
  memory: BrainMemory;
  /** Active context only: the version or word that makes it look shipped, else null. */
  shipped: string | null;
}

export interface BootstrapSections {
  /** "Who you are": user/profile.md's first paragraph, null when BRAIN.md was built without one. */
  who: { row: BootstrapRow | null; tokens: number };
  /** "Critical rules": the pinned memories. */
  rules: { rows: BootstrapRow[]; tokens: number };
  /**
   * "Active context": the projects BRAIN.md shows (newest first) and those its budget left out. `shownCount` and
   * `leftOutCount` are the build's, as BRAIN.md has them; the rows drop what the files changed since.
   */
  active: { shown: BootstrapRow[]; leftOut: BootstrapRow[]; tokens: number; shownCount: number; leftOutCount: number };
  links: { tokens: number };
  lastSession: { tokens: number };
}

/**
 * BRAIN.md by section from brain-sources.json, the memory files and MEMORY.md; null before build-brain-md has recorded
 * its sources. A rule stays while its file is live and pinned, a project while its file is live and `status/active`;
 * `keep` hides more (a row whose verb runs on this page; per section, as a pinned project shows in both).
 */
export function bootstrapSections(x: Pick<BootstrapInput, "sources" | "byPath" | "index" | "indexRaw">, keep: (path: string, section: "rules" | "active") => boolean = () => true): BootstrapSections | null {
  const src = x.sources;
  if (!src) return null;
  const entries = indexEntries(x.indexRaw);
  const row = (path: string, m: BrainMemory, shipped: boolean): BootstrapRow => {
    const e = entries.get(path);
    const line = brainBullet(path, entries);
    return {
      path, title: e?.title || m.title, description: e ? clampToChars(e.description, BULLET_DESC_CHARS) : "", line,
      tokens: estimateTokens(`${line}\n`), memory: m, shipped: shipped ? shippedWhy(m.title, m.description || x.index.get(path)) : null,
    };
  };
  const active = (m: BrainMemory): boolean => m.type === "projects" && m.status === "active";
  const rows = (paths: readonly string[], section: "rules" | "active"): BootstrapRow[] => {
    const out: BootstrapRow[] = [];
    for (const p of paths) {
      const m = x.byPath.get(p);
      if (m && m.live && (section === "rules" ? m.pin : active(m)) && keep(p, section)) out.push(row(p, m, section === "active"));
    }
    return out;
  };
  const profile = src.sections.who.paths.map((p) => x.byPath.get(p)).find((m): m is BrainMemory => !!m);
  const whoText = profile ? firstParagraph(profile.body) : "";
  return {
    who: {
      row: profile && whoText ? { path: profile.path, title: profile.title, description: clip(whoText, 200), line: whoText, tokens: src.sections.who.tokens, memory: profile, shipped: null } : null,
      tokens: src.sections.who.tokens,
    },
    rules: { rows: rows(src.sections.rules.paths, "rules"), tokens: src.sections.rules.tokens },
    active: {
      shown: rows(src.sections.active.paths, "active"), leftOut: rows(src.omitted, "active"), tokens: src.sections.active.tokens,
      shownCount: src.sections.active.paths.length, leftOutCount: src.omitted.length,
    },
    links: { tokens: src.links },
    lastSession: { tokens: src.lastSession },
  };
}

export interface ShippedSummary {
  /** The active projects that look shipped, BRAIN.md's first, then those its budget left out. */
  rows: BootstrapRow[];
  /** How many active projects there are (shown and left out). */
  of: number;
  /** How many of `rows` BRAIN.md shows now, and about how many tokens their lines take there. */
  inBrain: number;
  tokens: number;
}

/** The looks-shipped suggestions (D17) and what marking them complete frees: the characters of their lines over 4. */
export function shippedSummary(s: BootstrapSections): ShippedSummary {
  const shown = s.active.shown.filter((r) => r.shipped);
  const rows = [...shown, ...s.active.leftOut.filter((r) => r.shipped)];
  const chars = shown.reduce((n, r) => n + r.line.length + 1, 0);
  return { rows, of: s.active.shown.length + s.active.leftOut.length, inBrain: shown.length, tokens: Math.ceil(chars / 4) };
}

/** The lede over the sections (canvas Bootstrap), null when nothing looks shipped. */
export function shippedLede(x: ShippedSummary): string | null {
  const n = x.rows.length;
  if (!n) return null;
  const head = `${n} of the ${pl(x.of, "active project")} ${n === 1 ? "looks" : "look"} shipped.`;
  if (x.inBrain) return `${head} Marking ${n === 1 ? "it" : "them"} complete frees about ${pl(x.tokens, "token")} of BRAIN.md for work that is live.`;
  return `${head} ${n === 1 ? "It does not fit" : "None of them fits"} in BRAIN.md now; marking ${n === 1 ? "it" : "them"} complete takes ${n === 1 ? "it" : "them"} off the active list.`;
}

/** The lede's button: it lands on the list (BrainTarget.anchor "shipped"). */
export function reviewShippedLabel(n: number): string { return n === 1 ? "Review it…" : `Review the ${n}…`; }

/** The bulk action's button, and what its ConfirmModal says (spec §6: a bulk change asks first; D17: suggestions only). */
export function completeAllLabel(n: number): string { return n === 1 ? "Mark it complete…" : `Mark the ${n} complete…`; }

export function completeConfirm(rows: readonly Pick<BootstrapRow, "title">[]): { title: string; message: string; label: string } {
  const n = rows.length;
  const named = rows.map((r) => `“${r.title}”`);
  const list = n <= 4 ? joinAnd(named) : `${named.slice(0, 3).join(", ")} and ${n - 3} more`;
  return {
    title: n === 1 ? `Mark ${named[0]} complete?` : `Mark ${n} projects complete?`,
    message: `Sets status/complete on ${list}. ${n === 1 ? "It leaves" : "They leave"} Active context and BRAIN.md is rebuilt. Nothing is archived or deleted, and Library's Status sets ${n === 1 ? "it" : "one"} back.`,
    label: n === 1 ? "Mark complete" : `Mark ${n} complete`,
  };
}

const joinAnd = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * Runs `run` on each item in turn and stops at the first that fails (the bulk Mark complete: each `set` checks the hash
 * this page read, so one memory changed elsewhere stops the rest rather than marking past it).
 */
export async function eachUntilFailure<T>(items: readonly T[], run: (item: T) => Promise<{ ok: boolean; reason?: string }>): Promise<{ done: number; failed: string | null; at: T | null }> {
  let done = 0;
  for (const it of items) {
    let r: { ok: boolean; reason?: string };
    try { r = await run(it); } catch (e) { return { done, failed: e instanceof Error ? e.message : String(e), at: it }; }
    if (!r.ok) return { done, failed: r.reason || "it did not go through", at: it };
    done++;
  }
  return { done, failed: null, at: null };
}

/** "557 tokens · 21 shown, 54 left out": the Active context header, the counts as the build made them. */
export function activeHeader(a: BootstrapSections["active"]): { text: string; leftOut: string | null } {
  return { text: `${pl(a.tokens, "token")} · ${a.shownCount} shown`, leftOut: a.leftOutCount ? `${a.leftOutCount} left out` : null };
}

// ── the budget bars (D17) ──

export interface BudgetBar {
  key: "brain" | "session" | "wake";
  name: string;
  /** "847 / 850 tokens", "2 of 3 hits · 96 tokens", "not built yet". */
  value: string;
  /** The bar's measure against `max`; `known` false when there is nothing to measure yet (no bar is drawn as a meter). */
  now: number;
  max: number;
  known: boolean;
  /** 0–100, the bar's width. */
  pct: number;
  /** Over its budget, or full and leaving something out: the note says so in words (D23). */
  warn: boolean;
  note: string;
}

const pctOf = (now: number, max: number): number => (max > 0 ? Math.max(0, Math.min(100, Math.round((now / max) * 100))) : 0);

/** One snippet line of recall-wake.md (sdk/lib/recall.js writeWakeRecall: "- `path` (flag) — snippet"). */
export function wakeHits(text: string | null): Array<{ path: string; flag: string }> {
  const out: Array<{ path: string; flag: string }> = [];
  for (const m of String(text ?? "").matchAll(/^- `([^`\n]+)` \(([^)\n]*)\)/gm)) out.push({ path: m[1], flag: m[2] });
  return out;
}

/** BRAIN.md (brain-sources.json's tokens over its budget), SESSION.md (its tokens over 400), recall-wake.md (its hits over 3). */
export function budgetBars(x: Pick<BootstrapInput, "sources" | "session" | "wake">): BudgetBar[] {
  const out: BudgetBar[] = [];
  const s = x.sources;
  if (!s || s.budget <= 0) {
    out.push({ key: "brain", name: "BRAIN.md", value: "not built yet", now: 0, max: 0, known: false, pct: 0, warn: false, note: "The next scan builds it and records what it holds" });
  } else {
    const left = s.omitted.length;
    const over = s.tokens - s.budget;
    out.push({
      key: "brain", name: "BRAIN.md", value: `${s.tokens} / ${s.budget} tokens`, now: s.tokens, max: s.budget, known: true, pct: pctOf(s.tokens, s.budget),
      warn: over > 0 || left > 0,
      note: over > 0 ? `Over budget by ${pl(over, "token")}` : left ? `Full: ${pl(left, "older active project")} left out` : `${pl(s.budget - s.tokens, "token")} free`,
    });
  }
  if (x.session === null) {
    out.push({ key: "session", name: "SESSION.md", value: "none yet", now: 0, max: SESSION_BUDGET, known: false, pct: 0, warn: false, note: "No working memory yet: the session hooks write it" });
  } else {
    const t = estimateTokens(x.session);
    out.push({
      key: "session", name: "SESSION.md", value: `${t} / ${SESSION_BUDGET} tokens`, now: t, max: SESSION_BUDGET, known: true, pct: pctOf(t, SESSION_BUDGET),
      warn: t > SESSION_BUDGET, note: t > SESSION_BUDGET ? `Over budget by ${pl(t - SESSION_BUDGET, "token")}: a wrap resets it` : "Working memory, reset at each wrap",
    });
  }
  const hits = x.wake === null ? 0 : wakeHits(x.wake).length;
  out.push({
    key: "wake", name: "recall-wake.md", value: x.wake === null ? "no hits" : `${hits} of ${WAKE_MAX} hits · ${pl(estimateTokens(x.wake), "token")}`,
    now: Math.min(hits, WAKE_MAX), max: WAKE_MAX, known: true, pct: pctOf(hits, WAKE_MAX), warn: false,
    note: x.wake === null ? "Nothing recalled at the last session end" : "Recalled at session end; the next first prompt carries it",
  });
  return out;
}

// ── SESSION.md (auto-wrap.js, wrap-session.js) ──

/**
 * wrap-session.js hasPromoteTag: `#promote` as a tag, not prose about it: after it only other #tags or punctuation, and
 * never inside a code span. /wrap promotes these lines.
 */
export function hasPromoteTag(line: string): boolean {
  const m = /#promote\b(.*)$/.exec(String(line).replace(/`[^`]*`/g, " "));
  if (!m) return false;
  return m[1].split(/\s+/).filter(Boolean).every((t) => t.startsWith("#") || /^[^\w]+$/.test(t));
}

export interface SessionLine {
  text: string;
  /** /wrap promotes it: tagged #promote, or under "Promote to Memory on Close". */
  promote: boolean;
  section: "remember" | "promote" | "other";
}
export interface SessionCard {
  lines: SessionLine[];
  tokens: number;
  /** auto-wrap.js writeWrapStatus left its "not wrapped" line under "## Wrap Status". */
  notWrapped: boolean;
  /** How that line says to wrap ("/wrap", "$agenticos:wrap", or both hosts' forms), null when it names none. */
  wrapHint: string | null;
}

/** SESSION.md's lines to remember: "Things to Remember", "Promote to Memory on Close" and any #promote line; null without a file. */
export function sessionCard(text: string | null): SessionCard | null {
  if (text === null) return null;
  const lines: SessionLine[] = [];
  let section: SessionLine["section"] = "other";
  let status = false;
  let notWrapped = false;
  let wrapHint: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^##\s/.test(raw)) {
      section = /^##\s+Things to Remember\b/i.test(raw) ? "remember" : /^##\s+Promote to Memory/i.test(raw) ? "promote" : "other";
      status = /^##\s+Wrap Status\b/.test(raw);
      continue;
    }
    if (status && /not wrapped/.test(raw)) {
      notWrapped = true;
      wrapHint ??= /— run (.+?)\.?\s*$/.exec(raw)?.[1] ?? null;
      continue;
    }
    const bullet = /^\s*[-*]\s+/.test(raw);
    const tagged = hasPromoteTag(raw);
    if (!(bullet && section !== "other") && !tagged) continue;
    const t = raw.replace(/^\s*[-*]\s+/, "").replace(/#promote\b/g, "").replace(/\s+/g, " ").trim();
    if (t) lines.push({ text: t, promote: tagged || section === "promote", section });
  }
  return { lines, tokens: estimateTokens(text), notWrapped, wrapHint };
}

/**
 * The line under SESSION.md's lines: "Not wrapped yet · /wrap promotes the tagged lines" (canvas Bootstrap), or null. It
 * names the command the not-wrapped line names, else `wrapHint` (/wrap as this machine's hosts invoke it, BrainSettings).
 */
export function wrapNote(c: SessionCard, wrapHint: string): { text: string; warn: boolean } | null {
  const tagged = c.lines.some((l) => l.promote);
  const how = c.wrapHint ?? wrapHint;
  if (c.notWrapped) return { text: tagged ? `Not wrapped yet · ${how} promotes the tagged lines` : `Not wrapped yet · run ${how}`, warn: true };
  return tagged ? { text: "The next wrap promotes the tagged lines", warn: false } : null;
}

// ── MEMORY.md ──

export interface IndexCard {
  /** "67.6 KB · about 17k tokens · 342 lines" (non-blank lines: brainModel indexLineCount, as Health's tile). */
  size: string;
  bytes: number;
  tokens: number;
  lines: number;
  /** What Health's index fix finds (brain-hub.json hygiene), each as a sentence; empty with no hub. */
  findings: string[];
  fixable: number;
}

const tokensAbout = (t: number): string => (t < 1000 ? `about ${pl(t, "token")}` : t < 10_000 ? `about ${(t / 1000).toFixed(1)}k tokens` : `about ${Math.round(t / 1000)}k tokens`);

/** MEMORY.md's size, its tokens and lines, and the index's hygiene findings (misfiled, unindexed, broken); null without a file. */
export function indexCard(raw: string | null, hub: BrainHub | null): IndexCard | null {
  if (raw === null) return null;
  const bytes = new TextEncoder().encode(raw).length;
  // Non-blank lines, as Health's MEMORY.md tile counts them.
  const lines = indexLineCount(raw);
  const tokens = estimateTokens(raw);
  const kb = bytes < 1024 ? pl(bytes, "byte") : `${(bytes / 1024).toFixed(1)} KB`;
  const hy = hub?.hygiene ?? {};
  const n = (k: string): number => (Array.isArray(hy[k]) ? (hy[k] as unknown[]).length : 0);
  const mis = n("misfiled");
  const unindexed = n("unindexed");
  const broken = n("brokenIndex");
  const findings = [
    mis ? (mis === 1 ? "1 line sits under the wrong heading." : `${mis} lines sit under the wrong heading.`) : "",
    unindexed ? (unindexed === 1 ? "1 memory has no line in it." : `${unindexed} memories have no line in it.`) : "",
    broken ? (broken === 1 ? "1 line points at a missing file." : `${broken} lines point at a missing file.`) : "",
  ].filter(Boolean);
  return { size: `${kb} · ${tokensAbout(tokens)} · ${pl(lines, "line")}`, bytes, tokens, lines, findings, fixable: mis + unindexed + broken };
}

// ── the recall preview (D18) ──

export interface RecallRow {
  path: string;
  title: string;
  /** The memory's type, "pattern", "journal", "daily note" or "note". */
  kind: string;
  score: string;
  /** "12d" (sdk/lib/recall.js ageFlag's days), "" when the hit has no age. */
  age: string;
  /** Not updated in over 60 days (the flag reads "stale: …"). */
  stale: boolean;
  snippet: string;
  /** What a click does: Library on the memory, the file in the editor, or nothing (a memory gone since the index). */
  open: "memory" | "file" | "none";
}

/** A score in three significant figures: BM25's "4.21", the hybrid's reciprocal-rank "0.0328". */
export function scoreText(n: number): string {
  if (!Number.isFinite(n)) return "";
  return String(Number(n.toPrecision(3)));
}

/** sdk/lib/recall.js ageFlag ("12d", "stale: 61d") as an age and whether it is stale. */
export function hitAge(flag: string): { age: string; stale: boolean } {
  const m = /^\s*(stale)?\s*:?\s*(\d+d)\s*$/i.exec(flag);
  if (m) return { age: m[2], stale: !!m[1] };
  return { age: "", stale: /^\s*stale\b/i.test(flag) };
}

/** A vault-relative markdown path the editor may open: no absolute path, no `..`, no control characters. */
export function openablePath(p: string): boolean {
  return /\.md$/.test(p) && !p.startsWith("/") && !/[\u0000-\u001f]/.test(p) && !p.split("/").includes("..");
}

/** The preview's hits as rows: titles from the files, the kind, the score and the age. */
export function recallRows(hits: readonly RecallHit[], byPath: ReadonlyMap<string, BrainMemory>, patterns: readonly BrainNote[] = []): RecallRow[] {
  return hits.map((h) => {
    const { age, stale } = hitAge(h.flag);
    const base = { path: h.path, score: scoreText(h.score), age, stale, snippet: h.snippet };
    const mp = MEMORY_PATH_RE.exec(h.path);
    if (mp) {
      const m = byPath.get(h.path);
      return m ? { ...base, title: m.title, kind: m.type, open: "memory" as const } : { ...base, title: mp[2], kind: "gone from the store", open: "none" as const };
    }
    const name = slugOf(h.path);
    const pat = h.path.startsWith(`${PATTERNS_DIR}/`) ? patterns.find((n) => n.path === h.path) : undefined;
    const kind = h.path.startsWith(`${PATTERNS_DIR}/`) ? "pattern" : h.path.startsWith("persona/journal/") ? "journal" : /^\d{4}-\d{2}-\d{2}$/.test(name) ? "daily note" : "note";
    return { ...base, title: pat?.title ?? name, kind, open: openablePath(h.path) ? "file" as const : "none" as const };
  });
}
