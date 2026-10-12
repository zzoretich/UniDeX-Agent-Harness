'use strict';
/**
 * memory-hygiene.js — what the Brain hub calls hygiene (brain-hub D12, D20): the findings brain-hub.json's `hygiene`
 * lists and `aos memory fix <kind>` (lib/memory-fix.js) acts on, computed in one place so the two always agree. Pure:
 * the callers read the store (memory-ops listMemories, listDrafts, readIndex) and hand the rows in.
 *
 *   sources         live memories per `source:` label; LEGACY_SOURCES are the in-session writes `fix sources` relabels
 *   oldType         frontmatter whose top-level `type:` is not `memory` or is missing (a host's auto-memory shape)
 *   noDescription   no `description:` of its own while its MEMORY.md line has one
 *   unindexed       a live memory with no MEMORY.md line
 *   misfiled        a line under another type's heading (or under no heading)
 *   brokenIndex     a line to a memory path with no memory behind it
 *   leftoverDrafts  a feedback draft whose slug is a live feedback memory (approved, then left behind)
 */
const ops = require('./memory-ops.js');

// Every in-session write's label before /wrap settled on one (brain-hub plan PR 3): `fix sources` rewrites them to
// CANON_SOURCE, the label /wrap writes today. `auto-wrap` and no source stay as they are.
const LEGACY_SOURCES = ['session', 'in-session', 'wrap'];
const CANON_SOURCE = 'manual-wrap';

/** A MEMORY.md `## ` heading's text, or null. */
function headingOf(line) { const h = /^##\s+(.+?)\s*$/.exec(line); return h ? h[1] : null; }
/** A MEMORY.md bullet `- [Title](brain/memory/….md) — description`: { title, path, description }, or null. */
function entryOf(line) {
  const b = /^\s*-\s*\[([^\]]*)\]\((brain\/memory\/[^)]+\.md)\)\s*(?:—\s*(.*))?$/.exec(line);
  return b ? { title: b[1], path: b[2], description: (b[3] || '').trim() } : null;
}

/** MEMORY.md's bullets by heading: { path → [{ heading, description, line }] }, in file order. */
function readIndexLines(raw) {
  const lines = new Map();
  let heading = '';
  for (const l of String(raw || '').split('\n')) {
    const h = headingOf(l);
    if (h !== null) { heading = h; continue; }
    const b = entryOf(l);
    if (!b) continue;
    (lines.get(b.path) || lines.set(b.path, []).get(b.path)).push({ heading, description: b.description, line: l });
  }
  return lines;
}

/** Whether a MEMORY.md heading is the type's own: "## Project" prefix-matches "## Projects" (memory-index.js's rule). */
function ownHeading(type, heading) { return String(heading || '').startsWith(ops.TYPE_HEADING[type]); }

function legacySource(m) { return LEGACY_SOURCES.includes(m.source); }
function oldType(m) { return m.hasFrontmatter && m.kind !== 'memory'; }

/**
 * The findings, from the store as the caller read it: `live` and `byPath` are memory-ops describe() rows (byPath holds
 * every memory, archived and superseded too, so their lines are not broken), `indexLines` readIndexLines' map, `drafts`
 * listDrafts' rows. → brain-hub.json's `hygiene`.
 */
function findHygiene({ live, byPath, indexLines, drafts }) {
  const sources = {};
  for (const m of live) { const s = m.source || '(none)'; sources[s] = (sources[s] || 0) + 1; }
  const liveSlugs = new Set(live.filter((m) => m.type === 'feedback').map((m) => m.slug));
  return {
    sources,
    oldType: live.filter(oldType).map((m) => m.path),
    noDescription: live.filter((m) => !m.description && (indexLines.get(m.path) || []).some((e) => e.description)).map((m) => m.path),
    unindexed: live.filter((m) => !indexLines.has(m.path)).map((m) => m.path),
    misfiled: [...indexLines.entries()].filter(([p, es]) => byPath.has(p) && es.some((e) => !ownHeading(byPath.get(p).type, e.heading))).map(([p]) => p),
    brokenIndex: [...indexLines.keys()].filter((p) => !byPath.has(p) && ops.PATH_RE.test(p)),
    leftoverDrafts: drafts.filter((d) => liveSlugs.has(d.slug)).map((d) => d.slug),
  };
}

module.exports = { LEGACY_SOURCES, CANON_SOURCE, headingOf, entryOf, readIndexLines, findHygiene, ownHeading, legacySource, oldType };
