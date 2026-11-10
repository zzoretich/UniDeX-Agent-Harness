// badges.ts — the rail's count badges (spec 2026-09-22-todo-and-proposals-tabs D7). Pure.
// WorkbenchView recomputes them on vault events whether or not the tab is mounted.
import { PROPOSALS_DIR, isProposalFile } from "./proposals";
import { TODO_PATH, todoBadgeCount } from "./todos";
import { NOTIFICATIONS_DIR } from "./notifications";
import { touchesTeams } from "./teams";
import { CONNECTOR_FILES } from "./connectorsModel";
import { rowStatus, type RowStatusInput } from "./codeChat";

/** Pending proposals among a listing of persona/proposals (vault paths or bare names). */
export function proposalBadge(paths: string[]): number {
  return paths.filter((p) => isProposalFile(p.split("/").pop() ?? "")).length;
}

/** Open todos overdue or due today (`today` is the local YYYY-MM-DD); a missing TODO.md counts 0. */
export function todoBadge(text: string | null, today: string): number {
  return todoBadgeCount(text, today);
}

/** Code's count (spec 2026-11-09-code-chat C10): the agent terminals whose row reads Needs you, read from their screens
 *  for every terminal, not only the one in view (termGroups.statusInput gives each one's inputs). */
export function needsYouBadge(rows: RowStatusInput[]): number {
  return rows.filter((r) => rowStatus(r).status === "needs").length;
}

/** Rail text for a count: "" hides the badge; anything past 99 reads "99+". */
export function badgeText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n > 99 ? "99+" : String(Math.floor(n));
}

/** Whether a vault event on `path` can change a badge. */
export function touchesBadges(path: string): boolean {
  return path === TODO_PATH || path === PROPOSALS_DIR || path.startsWith(`${PROPOSALS_DIR}/`) ||
    path === NOTIFICATIONS_DIR || path.startsWith(`${NOTIFICATIONS_DIR}/`) || touchesTeams(path) || CONNECTOR_FILES.includes(path);
}
