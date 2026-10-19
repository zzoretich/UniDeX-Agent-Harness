// Vault-relative daily-note paths. formatLayout() is the twin of
// brain/scripts/lib/paths.js formatLayout(): same tokens ({yyyy} {MM} {MMMM} {dd}), same
// replacement order, so one layout string in <vault>/brain/config.json ("dailyNote.layout")
// yields the same path on both sides. The layout itself comes from
// aosConfig.dailyNoteLayout(vaultRoot); this module stays pure so it is testable.
export const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

export const DEFAULT_LAYOUT = "{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md";

export function formatLayout(layout: string, d: Date): string {
  const yyyy = String(d.getFullYear());
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return layout.replace(/\{yyyy\}/g, yyyy).replace(/\{MMMM\}/g, MONTHS[d.getMonth()]).replace(/\{MM\}/g, MM).replace(/\{dd\}/g, dd);
}

export function dailyNotePath(d: Date = new Date(), layout: string = DEFAULT_LAYOUT): string {
  return formatLayout(layout, d);
}

const TOKEN_RE = /\{(yyyy|MMMM|MM|dd)\}/g;
// Same per-token patterns as paths.js segmentMatcher(): {MMMM} is one of the twelve month names, never a free word.
const TOKEN_PATTERN: Record<string, string> = { yyyy: "\\d{4}", MMMM: `(?:${MONTHS.join("|")})`, MM: "\\d{2}", dd: "\\d{2}" };
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Anchored regex that matches exactly the paths a layout can produce. A layout that cannot name
 *  a single day — no {yyyy}, no {dd}, or no month token — matches NOTHING (`/(?!)/`), which is the
 *  answer brain/scripts/lib/paths.js:135 gives the scripts for the same layout. Without this the
 *  regex would still string-match on the literal parts and the Memory graph alone would keep
 *  emitting session nodes while every other surface returned zero. */
export function layoutRegex(layout: string): RegExp {
  const hasMonth = layout.includes("{MM}") || layout.includes("{MMMM}");
  if (!layout.includes("{yyyy}") || !layout.includes("{dd}") || !hasMonth) return /(?!)/;
  let out = "";
  let last = 0;
  for (const m of layout.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    out += escapeRe(layout.slice(last, at)) + TOKEN_PATTERN[m[1]];
    last = at + m[0].length;
  }
  out += escapeRe(layout.slice(last));
  return new RegExp(`^${out}$`);
}

/** Strict to the layout, like brain/scripts/lib/paths.js listDailyNotes(): a stray at the year root or a note
 *  under a legacy folder is not a daily note on any surface (spec §5.3; Plan 3b Open issue 2). */
export function isDailyNotePath(p: string, layout: string = DEFAULT_LAYOUT): boolean {
  return layoutRegex(layout).test(p);
}
