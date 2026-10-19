// sessionNotes.ts — the command deck's /remember (spec 2026-09-24-hud-deck-fixes D4). Pure. The same rules as the
// in-session plugin/commands/remember.md, so /wrap promotes a note the same way whichever wrote it.
import { appendUnderHeading, setFrontmatterValue } from "./mdSections";

export const SESSION_PATH = "brain/_index/SESSION.md";
export const REMEMBER_HEADING = "## Things to Remember";
export const PROMOTE_HEADING = "## Promote to Memory on Close";

// wrap-session.js reads the same prefixes, case-insensitively, to pick the memory type.
const TYPED = /^(feedback|project|pattern)\s*:/i;

/** The section a note goes under: the promote block for a typed note (`feedback:`, `project:`, `pattern:`), else Things to Remember. */
export function rememberTarget(note: string): string {
  return TYPED.test(note.trim()) ? PROMOTE_HEADING : REMEMBER_HEADING;
}

/** The note as one bullet ending in exactly one #promote tag. */
export function rememberLine(note: string): string {
  const text = note.replace(/(^|\s)#promote\b/g, " ").replace(/\s+/g, " ").trim();
  return `- ${text} #promote`;
}

/** SESSION.md with the note appended and `updated:` set to `today`; a missing file (null or empty) starts from a minimal one. */
export function appendRemember(text: string | null, note: string, today: string): string {
  if (!note.replace(/#promote\b/g, "").trim()) throw new Error("nothing to remember");
  const base = text && text.trim()
    ? text
    : `---\ntype: session\nupdated: ${today}\n---\n\n# Current Session Working Memory\n\n${REMEMBER_HEADING}\n\n${PROMOTE_HEADING}\n`;
  return setFrontmatterValue(appendUnderHeading(base, rememberTarget(note), rememberLine(note)), "updated", today);
}
