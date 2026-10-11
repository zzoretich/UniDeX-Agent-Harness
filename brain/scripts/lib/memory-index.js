'use strict';
/**
 * memory-index.js — the pure half of the memory writer: the MEMORY.md index-line insertion and the description clip,
 * ported from the Obsidian plugin's memoryWriter.ts. No vault is resolved at load, so a caller that names its vault
 * (duty-guard.js's feedback backfill, spec 2026-09-28-reflect-memory-writes-design D3) can use them; memory-writer.js
 * requires them from here. The two writers must stay behaviorally identical.
 */

// Ported verbatim from memoryWriter.ts deriveDescription (line 49).
function deriveDescription(text, maxChars = 90) {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= maxChars) return single;
  return single.slice(0, maxChars).trimEnd();
}

// Faithful port of appendToMemoryIndex's insertion logic (memoryWriter.ts
// lines 120-139): section-aware if a matching `## ` heading exists, else
// append a new section at EOF. Pure string transform — I/O lives in the callers.
function insertIndexLine(raw, heading, entry) {
  const lines = raw.split('\n');
  // Prefix match, case-sensitive, no word-boundary: "## Project" must match a
  // real "## Projects" heading; "## Feedback" must match "## Feedback (how to
  // work)". First matching heading wins. IDENTICAL rule in memoryWriter.ts —
  // behavioral parity between the two writers is a standing P4 contract.
  const headingIdx = lines.findIndex((l) => l.trim().startsWith(heading));

  if (headingIdx === -1) {
    // append new section at end
    if (lines[lines.length - 1] !== '') lines.push('');
    lines.push(heading);
    lines.push(entry);
  } else {
    // find end of this section (next ## heading or EOF)
    let insertAt = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { insertAt = i; break; }
    }
    // trim trailing blanks before next section
    while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, entry);
  }

  return lines.join('\n');
}

// The Brain hub's two index edits (brain-hub D5, D7; no memoryWriter.ts twin: only `aos memory` writes these). A line
// belongs to a memory when it links `](<rel>)`, whatever its title or description says.
function linksTo(line, rel) { return /^\s*-\s/.test(line) && line.includes(`](${rel})`); }

/** Every index line for `rel` removed; the rest kept byte for byte. */
function removeIndexLine(raw, rel) {
  return raw.split('\n').filter((l) => !linksTo(l, rel)).join('\n');
}

/** `rel`'s first line replaced in place by `entry` (any later one dropped), else inserted as insertIndexLine does. */
function upsertIndexLine(raw, heading, entry, rel) {
  const lines = raw.split('\n');
  const at = lines.findIndex((l) => linksTo(l, rel));
  if (at === -1) return insertIndexLine(raw, heading, entry);
  const out = [];
  lines.forEach((l, i) => { if (i === at) out.push(entry); else if (!linksTo(l, rel)) out.push(l); });
  return out.join('\n');
}

module.exports = { deriveDescription, insertIndexLine, removeIndexLine, upsertIndexLine };
