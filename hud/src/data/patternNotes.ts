// patternNotes.ts — the command deck's /pattern (spec 2026-09-24-hud-deck-fixes D5). Pure. The same file shape as the
// in-session plugin/commands/pattern.md: one brain/patterns/<area>.md per area, one ### subsection per pattern.
import { appendUnderHeading, setFrontmatterValue } from "./mdSections";

export const PATTERNS_DIR = "brain/patterns";
export const PATTERNS_HEADING = "## Patterns";
export const PATTERN_AREAS = ["debugging", "architecture", "code-quality", "testing", "other"] as const;
export type PatternArea = (typeof PATTERN_AREAS)[number];

export interface PatternDraft {
  title: string;
  body: string;
  today: string;
}

export function patternPath(area: PatternArea): string {
  return `${PATTERNS_DIR}/${area}.md`;
}

/** "code-quality" → "Code Quality". */
export function areaTitle(area: PatternArea): string {
  return area.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function subsection(d: PatternDraft): string {
  const title = d.title.replace(/\s+/g, " ").trim();
  const body = d.body.trim();
  if (!title || !body) throw new Error("a pattern needs a title and a body");
  return `### ${title}\n${body}\n`;
}

/** A new area file with its first pattern. */
export function newPatternFile(area: PatternArea, d: PatternDraft): string {
  return [
    "---",
    "type: pattern",
    `tags: [pattern/${area}, status/active]`,
    `created: ${d.today}`,
    `updated: ${d.today}`,
    "---",
    "",
    `# ${areaTitle(area)} Patterns`,
    "",
    subsection(d),
  ].join("\n");
}

/** An existing area file with the pattern added as its last subsection and `updated:` set to today. */
export function appendPattern(text: string, d: PatternDraft): string {
  const sub = subsection(d);
  const trimmed = setFrontmatterValue(text, "updated", d.today).replace(/\s+$/, "");
  return `${trimmed}\n\n${sub}`;
}

/** The MEMORY.md line for a new area file. */
export function patternIndexEntry(area: PatternArea): string {
  const t = areaTitle(area);
  return `- [${t} Patterns](${patternPath(area)}) — ${t.toLowerCase()} decision heuristics`;
}

/** MEMORY.md with the area's line under ## Patterns, unless some line already links the file. */
export function addPatternIndexEntry(index: string, area: PatternArea): string {
  if (index.includes(`](${patternPath(area)})`)) return index;
  return appendUnderHeading(index, PATTERNS_HEADING, patternIndexEntry(area));
}
