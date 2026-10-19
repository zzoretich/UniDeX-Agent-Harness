import type { SnapshotUpdates } from "./snapshot";

export interface UpdateBadge {
  label: string;
  title: string;
}

/**
 * The SidebarHUD's update pill, or null when there is nothing to say.
 *
 * `behind` and `snoozed` come straight from the snapshot. The vault scanner already derived both
 * from brain/_index/update-check.json, and cli/update-check.js's isSnoozed() is the source of truth
 * for the snooze rule — so recomputing either here would add another copy of logic this project has
 * already had to keep in sync by hand twice. Trust the scanner; render what it decided.
 *
 * `formatAge` is injected rather than imported so this stays testable without a clock. The view
 * passes formatRelative from ./runs, which keeps the relative-time formatting in one place.
 *
 * Returning null (rather than an empty label) mirrors the status line fragment's contract: when
 * there is nothing to report, nothing is rendered at all and the HUD's shape does not change.
 */
export function updateBadge(
  u: SnapshotUpdates | undefined,
  formatAge: (iso: string) => string,
): UpdateBadge | null {
  if (!u || !u.behind || u.snoozed || !u.latest) return null;
  const checked = u.checkedAt ? ` · checked ${formatAge(u.checkedAt)}` : "";
  return {
    label: `⬆ ${u.latest}`,
    title: `${u.installed || "(unknown)"} → ${u.latest}${checked} · run \`aos upgrade\``,
  };
}
