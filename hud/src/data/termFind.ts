// termFind.ts — the Term find bar (⌘F; spec 2026-10-08-term-agent-deck §4, with @xterm/addon-search). Pure: what its
// count says. ui/TermFind.ts draws it.

/** How many matches the addon highlights and counts; past it, the count reads "1000+". */
export const FIND_LIMIT = 1000;

/** What the addon reports after each find: the selected match's index (-1 for none) and how many it highlighted. */
export interface FindResults { resultIndex: number; resultCount: number }

/** "2 of 7", "3 of 1000+" past the limit, "No results", or nothing while the box is empty. */
export function findCountLabel(query: string, r: FindResults | null, limit = FIND_LIMIT): string {
  if (!query) return "";
  if (!r || r.resultCount <= 0) return "No results";
  const total = r.resultCount >= limit ? `${limit}+` : String(r.resultCount);
  if (r.resultIndex >= 0) return `${r.resultIndex + 1} of ${total}`;
  return `${total} ${r.resultCount === 1 ? "match" : "matches"}`;
}
