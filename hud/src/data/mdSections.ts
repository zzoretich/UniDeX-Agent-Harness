// mdSections.ts — the one "append under a ## heading" rule the HUD's writers share (spec 2026-09-24-hud-deck-fixes
// D6): the MEMORY.md index, SESSION.md notes and the pattern index. Pure.

/**
 * Appends `entry` as the last line of the section under the first line that starts with `heading` (prefix match, case
 * sensitive, no word boundary: "## Project" matches a real "## Projects", "## Feedback" matches "## Feedback (how to
 * work)"; the IDENTICAL rule is in memory-index.js), before the section's trailing blank lines. A missing section is
 * added at the end of the text.
 */
export function appendUnderHeading(text: string, heading: string, entry: string): string {
  const lines = text.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim().startsWith(heading));
  if (headingIdx === -1) {
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push(heading);
    lines.push(entry);
    return lines.join("\n");
  }
  let insertAt = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { insertAt = i; break; }
  }
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, entry);
  return lines.join("\n");
}

/** Sets `key: value` in the leading YAML frontmatter, adding the key when it is missing; text without frontmatter is returned unchanged. */
export function setFrontmatterValue(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") return text;
  const end = lines.indexOf("---", 1);
  if (end === -1) return text;
  const at = lines.slice(1, end).findIndex((l) => l.startsWith(`${key}:`));
  if (at === -1) lines.splice(end, 0, `${key}: ${value}`);
  else lines[at + 1] = `${key}: ${value}`;
  return lines.join("\n");
}
