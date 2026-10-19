// The Obsidian side of the AgenticOS status line (spec 2026-09-28-statusline-design §4.4). The runtime writes
// brain/_index/statusline.json (schema 1, brain/scripts/lib/statusline-model.js); the status bar only reads it and asks
// the runtime to refresh a stale one (D3). The same file feeds Claude Code's status line and the Codex session line, so
// the three surfaces never disagree. Links into the Workbench arrive as agenticos://workbench?tab=<rail id> from the
// UniDeX app, or as obsidian://agenticos?tab=<rail id> from a status line written before it (D10); a Spaces link may also
// name a workspace, a pane and a thread (spaces-redesign D12, workbenchLinkFrom).
import type { App } from "obsidian";
import { BRAND } from "../brand";

export const STATUSLINE_PATH = "brain/_index/statusline.json";
/** D3: a model older than 15 s is rebuilt, the same threshold the terminal uses (the bar ticks every 30 s). */
export const STALE_MS = 15_000;

export interface Gate { team: string; item: string; stage: string | null }
export interface LiveRun { team: string; member: string | null; stage: string | null; item: string | null }
export interface Spend { family: string; usd: number; cap: number }
export interface StatuslineModel {
  schema: 1;
  at: string;
  vault: string;
  needs: { gates: Gate[]; alerts: number; breaking: number; flags: number };
  runs: LiveRun[];
  spend: Spend | null;
  health: { update: string | null; provider: string | null; unwrapped: boolean; drafts: number };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The model, or null for anything that is not a schema-1 statusline.json. Every field is coerced, never trusted. */
export function parseStatusline(raw: string | null | undefined): StatuslineModel | null {
  let j: unknown;
  try { j = JSON.parse(String(raw ?? "")); } catch { return null; }
  if (!isObj(j) || j.schema !== 1 || typeof j.at !== "string") return null;
  const needs = isObj(j.needs) ? j.needs : {};
  const health = isObj(j.health) ? j.health : {};
  const spend = isObj(j.spend) && typeof j.spend.usd === "number" && typeof j.spend.cap === "number" && j.spend.cap > 0 && typeof j.spend.family === "string"
    ? { family: j.spend.family, usd: j.spend.usd, cap: j.spend.cap } : null;
  return {
    schema: 1,
    at: j.at,
    vault: typeof j.vault === "string" ? j.vault : "",
    needs: {
      gates: (Array.isArray(needs.gates) ? needs.gates : []).filter(isObj).filter((g) => typeof g.item === "string")
        .map((g) => ({ team: String(g.team ?? ""), item: String(g.item), stage: str(g.stage) })),
      alerts: count(needs.alerts),
      breaking: count(needs.breaking),
      flags: count(needs.flags),
    },
    runs: (Array.isArray(j.runs) ? j.runs : []).filter(isObj)
      .map((r) => ({ team: String(r.team ?? ""), member: str(r.member), stage: str(r.stage), item: str(r.item) })),
    spend,
    health: { update: str(health.update), provider: str(health.provider), unwrapped: health.unwrapped === true, drafts: count(health.drafts) },
  };
}

export async function loadStatusline(app: App): Promise<StatuslineModel | null> {
  try { return parseStatusline(await app.vault.adapter.read(STATUSLINE_PATH)); } catch { return null; }
}

/** Absent, older than staleMs, or stamped in the future (clock skew). */
export function isStale(m: StatuslineModel | null, now = Date.now(), staleMs = STALE_MS): boolean {
  const t = m ? Date.parse(m.at) : NaN;
  return !Number.isFinite(t) || now - t > staleMs || t - now > 60_000;
}

export type BarTone = "violet" | "rose" | "amber" | "cyan" | "dim";
export interface BarSegment { text: string; tone: BarTone; tab?: string; file?: string; title: string }

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const FAMILY: Record<string, string> = { crossReview: "cross-review" };

/** The status bar: what needs you, the live run, spend near its cap, health — each opening where it is handled. */
export function barSegments(m: StatuslineModel): BarSegment[] {
  const out: BarSegment[] = [];
  const g = m.needs.gates;
  if (g.length === 1) out.push({ text: `◆ gate ${g[0].item}`, tone: "violet", tab: "agent-teams", title: `${g[0].item}${g[0].stage ? ` · ${g[0].stage} gate` : ""} waits on you` });
  else if (g.length > 1) out.push({ text: `◆ ${g.length} gates`, tone: "violet", tab: "agent-teams", title: g.map((x) => `${x.item}${x.stage ? ` (${x.stage})` : ""}`).join(", ") });
  if (m.needs.breaking) out.push({ text: `${m.needs.breaking} breaking`, tone: "rose", tab: "notifications", title: "Unread breaking notifications" });
  if (m.needs.alerts) out.push({ text: plural(m.needs.alerts, "alert"), tone: "amber", tab: "notifications", title: "Unread alerts" });
  if (m.needs.flags) out.push({ text: plural(m.needs.flags, "flag"), tone: "amber", file: "persona/STATE.md", title: "Open flags in persona/STATE.md" });
  if (m.runs.length) {
    const r = m.runs[0];
    const more = m.runs.length > 1 ? ` +${m.runs.length - 1}` : "";
    out.push({ text: `▶ ${[r.member, r.stage].filter(Boolean).join(" ")}${more}`, tone: "cyan", tab: "agent-teams", title: `Running: ${[r.member, r.stage, r.item].filter(Boolean).join(" ")}` });
  }
  if (m.spend) {
    const s = m.spend;
    out.push({ text: `${FAMILY[s.family] ?? s.family} $${s.usd.toFixed(2)}/$${s.cap}`, tone: s.usd / s.cap >= 0.8 ? "rose" : "amber", tab: "settings", title: `Today's ${FAMILY[s.family] ?? s.family} spend against its daily cap` });
  }
  const h = m.health;
  if (h.update) out.push({ text: `↑ ${h.update}`, tone: "amber", tab: "settings", title: `${BRAND.name} ${h.update} is available — run aos upgrade` });
  if (h.provider) out.push({ text: "provider none", tone: "rose", tab: "settings", title: `Background provider is none (${h.provider})` });
  if (h.unwrapped) out.push({ text: "not wrapped", tone: "amber", title: "The last session was not wrapped" });
  if (h.drafts) out.push({ text: plural(h.drafts, "draft"), tone: "dim", title: "Feedback drafts waiting for review" });
  return out;
}

/**
 * The Workbench tab a link's query names, only when it is a rail tab (D10); null otherwise. Both link forms reach the
 * plugin's "agenticos" handler with the same params: the app routes agenticos://workbench?tab=<id> to it, and Obsidian
 * routes obsidian://agenticos?tab=<id>.
 */
export function workbenchTabFrom(params: Record<string, string | undefined>, ids: readonly string[]): string | null {
  const t = params.tab;
  return typeof t === "string" && ids.includes(t) ? t : null;
}

/** The panes an agenticos://workbench?tab=spaces&workspace=<name>&pane=<p> link may name (spaces-redesign D12): the
 *  centre's Overview and Files, and the right pane's History and Linked. Any other value is dropped. */
export const SPACES_PANES = ["overview", "files", "history", "linked"] as const;
export type SpacesPane = (typeof SPACES_PANES)[number];

/** A thread id as the app takes one: the ThreadId of app/src/main/ipc/schemas.ts (statusline.test.ts pins the two). */
export const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a link may select: a tab, and for Spaces a workspace with its pane and thread (WorkbenchView.open's target). */
export interface WorkbenchLink { tab: string; workspace?: string; pane?: SpacesPane; thread?: string }

/**
 * What an agenticos://workbench link selects (spaces-redesign D12), every parameter checked: the tab as
 * workbenchTabFrom reads it, then for Spaces only, `workspace` when it is exactly the name of an entry in the snapshot
 * (`workspaces`), `pane` when it is one of SPACES_PANES and `thread` when it is a thread id. A value that fails its check
 * is dropped, as are `pane` and `thread` without a workspace; every other parameter is ignored. Null when the tab is
 * not a rail tab. A link only selects: nothing it carries resumes, opens a terminal, drafts or runs a verb.
 */
export function workbenchLinkFrom(params: Record<string, string | undefined>, ids: readonly string[], workspaces: readonly string[]): WorkbenchLink | null {
  const tab = workbenchTabFrom(params, ids);
  if (!tab) return null;
  const out: WorkbenchLink = { tab };
  const ws = params.workspace;
  if (tab !== "spaces" || typeof ws !== "string" || !ws || !workspaces.includes(ws)) return out;
  out.workspace = ws;
  const pane = params.pane;
  if (typeof pane === "string" && (SPACES_PANES as readonly string[]).includes(pane)) out.pane = pane as SpacesPane;
  const thread = params.thread;
  if (typeof thread === "string" && THREAD_ID_RE.test(thread)) out.thread = thread;
  return out;
}

/** The rail tab a whole link names: agenticos://workbench?tab=<id>, or the older obsidian://agenticos?tab=<id>. Any
 *  other URL, and a tab that is not a rail id, is null. */
export function workbenchTabFromUrl(raw: string, ids: readonly string[]): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  // Both schemes are non-special, so the word after // is the URL's host.
  const target = url.hostname.toLowerCase();
  const ours = (url.protocol === "agenticos:" && target === "workbench") || (url.protocol === "obsidian:" && target === "agenticos");
  return ours ? workbenchTabFrom({ tab: url.searchParams.get("tab") ?? undefined }, ids) : null;
}
