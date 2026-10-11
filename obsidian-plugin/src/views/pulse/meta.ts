// Names, icons and constants the Pulse cockpit and its popup share (spec 2026-10-08-pulse-cockpit-design).
import { clip } from "../../data/briefingBand";
import type { Area, NeedItem, Tone } from "../../data/pulseFacts";
import type { BrainTarget } from "../../data/brainModel";

export const AREA_LABEL: Record<Area, string> = {
  needs: "Needs you", health: "System health", agents: "Agents", workspaces: "Workspaces", todo: "To-Do",
  proposals: "Decisions", notifications: "Notifications", routines: "Routines", spend: "Spend", memory: "Brain",
};
export const AREA_ICON: Record<Area, string> = {
  needs: "inbox", health: "shield", agents: "bot", workspaces: "folder", todo: "square-check",
  proposals: "gavel", notifications: "bell", routines: "repeat", spend: "dollar-sign", memory: "brain",
};
/** The tab each area's "Open the … tab" button opens (Health opens the System drawer instead). The Brain area keeps the
 *  id "memory", the Brain tab's rail id (brain-hub D16). */
export const AREA_TAB: Partial<Record<Area, string>> = {
  agents: "agents", workspaces: "spaces", todo: "todo", proposals: "proposals", notifications: "notifications",
  routines: "routines", spend: "runs", memory: "memory",
};

const BAND_WORDS: Record<string, string> = {
  error: "See the error →", proposal: "Review the proposal →", flag: "Review the flag →", gate: "Open the gate →",
  drafts: "Review the drafts →", overdue: "Open the to-dos →", today: "Open the to-dos →", review: "Review the memories →",
};

/** The band's buttons for its top items: what each does to its item, "→" when it jumps; `label` is the action's own, for
 *  a kind with no words here. Two that would read alike ("Review the proposal →" twice) name their items instead. */
export function bandLabels(top: Array<{ n: Pick<NeedItem, "kind" | "title" | "ref">; label: string; jump: boolean }>): string[] {
  const labels = top.map(({ n, label, jump }) =>
    n.kind === "pipeline" || n.kind === "routine" ? (jump ? `See ${n.ref} →` : `Run ${n.ref}`) : BAND_WORDS[n.kind] ?? label);
  if (labels.length !== 2 || labels[0] !== labels[1]) return labels;
  return top.map(({ n, jump }, i) => `${labels[i].split(" ")[0]} “${clip(n.title, 24)}”${jump ? " →" : ""}`);
}

// The vault paths whose changes redraw Pulse: its facts, its caches (the Brain tile's two among them) and the briefing.
const WATCH = [/^brain\/_index\/(snapshot|pipelines|routines|briefing|promote-log|provider-spend|brain-hub|brain-sources)\./, /^persona\/(proposals\/|STATE\.md|teams\/)/,
  /^brain\/notifications\//, /^brain\/memory\//, /^TODO\.md$/, /^brain\/routines\//];
export function touchesPulse(p: string): boolean { return WATCH.some((re) => re.test(p)); }

// ── the Brain tile and area (brain-hub D15, canvas PulseAfter): Pulse summarises, the Brain tab acts ──

/** One of the Brain tile's three numbers, and the popup's row for it: each lands on a mode of the Brain tab. */
export interface BrainLink {
  id: "review" | "drafts" | "bootstrap";
  /** The tile's number; "—" while the runtime's cache that counts it is missing. */
  value: string;
  /** Under the number on the tile, before its "→". */
  label: string;
  /** Colour for state only: warn while memories wait or BRAIN.md is over its budget, gate while drafts wait. */
  tone: Tone;
  /** The popup's row: its title, what it counts and where it lands, and its button. */
  row: string;
  meta: string;
  act: string;
  /** Where it lands, in words ("Brain › Review › Drafts"), and as a target for view.open. */
  dest: string;
  target: BrainTarget;
}

/** The tile's three numbers in their order: to review (brain-hub.json), feedback drafts, BRAIN.md against its budget. */
export function brainLinks(o: { toReview: number | null; drafts: number; brainPct: number | null }): BrainLink[] {
  const { toReview: n, drafts: d, brainPct: p } = o;
  const link = (l: Omit<BrainLink, "meta"> & { what: string }): BrainLink => {
    const { what, ...rest } = l;
    return { ...rest, meta: `${what} · ${l.dest}` };
  };
  return [
    link({ id: "review", value: n === null ? "—" : String(n), label: "to review", tone: n ? "warn" : "off",
      row: n === null ? "Memories to review: counted at the next scan" : `${n} to review`, what: "unreviewed memories by session",
      act: "Review →", dest: "Brain › Review", target: { mode: "review", queue: "session" } }),
    link({ id: "drafts", value: String(d), label: d === 1 ? "draft" : "drafts", tone: d ? "gate" : "off",
      row: `${d} feedback ${d === 1 ? "draft" : "drafts"}`, what: "brain/memory/feedback/_drafts",
      act: "Review →", dest: "Brain › Review › Drafts", target: { mode: "review", queue: "drafts" } }),
    link({ id: "bootstrap", value: p === null ? "—" : `${p}%`, label: "BRAIN.md", tone: p !== null && p >= 100 ? "warn" : "off",
      row: p === null ? "BRAIN.md: measured at its next build" : `BRAIN.md ${p}% of its budget`, what: "what every session starts with",
      act: "Open →", dest: "Brain › Bootstrap", target: { mode: "bootstrap" } }),
  ];
}

/** The tile's headline under its number: today's writes, and those since Review was last open (the rail badge, D16). */
export function brainTodayLabel(sinceLooked: number): string { return `today · ${sinceLooked} since you looked`; }

/** The tile's way into Review: today's still unreviewed, or Review itself when none of today's waits. */
export function brainReviewLabel(pendingToday: number): string {
  return pendingToday > 0 ? `Review today’s ${pendingToday} in Brain →` : "Open Review in Brain →";
}

/** The briefing routine as the vault template seeds it: vault-template/brain/routines/briefing.md, pinned by a test. */
export const BRIEFING_ROUTINE = `---
schema: 1
name: Briefing
kind: command
schedule: "*/30 7-22 * * *"
enabled: true
guarded: false
argv: ["{{NODE}}", "{{VAULT}}/brain/scripts/persona/briefing.js"]
timeoutSec: 90
tags: [persona]
---
The Chief of Staff's paragraph at the top of the Workbench's Pulse tab (\`brain/scripts/persona/briefing.js\`). Every 30 minutes from 7:00 to 22:00 it reads the facts Pulse shows (what needs you, health, decisions, to-dos, notifications, routines, spend) and makes one model call only when they changed since the last paragraph, as a \`duty:briefing\` call against the daily duty cap (\`persona.perDayUsd\`). It writes \`brain/_index/briefing.json\`; Pulse composes the paragraph from the same facts whenever there is none or it is out of date. Nothing runs while the persona is off; \`persona.briefing.enabled: false\` turns this one off. Disable it with \`aos routines disable briefing\`.
`;
