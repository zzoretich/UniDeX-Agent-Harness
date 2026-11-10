// closedRecord.ts — the conversations whose terminal was closed in this app (code-chat C6): a closed terminal stays
// listed from the pool's own record until the session index has it. Owned by CodeFeeds, so it lives as long as the plugin,
// not the Code tab (which rebuilds its panel on every visit). The newest CLOSED_CAP are kept; one conversation is one row.

import type { TermRowInput } from "./termGroups";

/** Closed conversations kept for the whole app session. */
export const CLOSED_CAP = 50;

export class ClosedRecord {
  private rows: TermRowInput[] = [];

  /** Remembers a closed terminal's row, newest first; a shell or a terminal with no known conversation is not kept. */
  add(r: TermRowInput): void {
    if (r.host === "shell" || !r.sessionId) return;
    const keep = { ...r, exited: true, turnOpen: false, needsYou: false, printing: false };
    this.rows = [keep, ...this.rows.filter((c) => c.sessionId !== r.sessionId || c.host !== r.host)].slice(0, CLOSED_CAP);
  }

  /** The kept rows, newest first (groupSidebar drops the ones the index lists). */
  list(): TermRowInput[] { return this.rows; }
}
