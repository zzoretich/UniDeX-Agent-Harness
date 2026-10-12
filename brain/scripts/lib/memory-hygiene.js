'use strict';
/**
 * memory-hygiene.js — what the Brain hub calls hygiene (brain-hub D12, D20): the findings brain-hub.json's `hygiene`
 * lists and `aos memory fix <kind>` (lib/memory-fix.js) acts on, computed in one place so the two always agree. Pure:
 * the callers read the store (memory-ops listMemories, listDrafts, readIndex) and hand the rows in.
 *
 *   sources         live memories per `source:` label; LEGACY_SOURCES are the in-session writes `fix sources` relabels
 *   oldType         frontmatter whose top-level `type:` is not `memory` or is missing (a host's auto-memory shape)
 *   noDescription   a memory with frontmatter but no `description:` of its own while its MEMORY.md line has one
 *   unindexed       a live memory with no MEMORY.md line (no bullet links it, memory-index.js's rule)
 *   misfiled        a line under another type's heading (or under no heading)
 *   brokenIndex     a line to a memory path with nothing at all there (a link or an unreadable file is not broken)
 *   leftoverDrafts  a feedback draft with the slug and the title of a live feedback memory (approved, then left behind)
 */
const ops = require('./memory-ops.js');

// Every in-session write's label before /wrap settled on one (brain-hub plan PR 3): `fix sources` rewrites them to
// CANON_SOURCE, the label /wrap writes today. `auto-wrap` and no source stay as they are.
const LEGACY_SOURCES = ['session', 'in-session', 'wrap'];
const CANON_SOURCE = 'manual-wrap';

/** A MEMORY.md `## ` heading's text, or null. */
function headingOf(line) { const h = /^##\s+(.+?)\s*$/.exec(line); return h ? h[1] : null; }

// A bullet's link text may hold brackets ("[[wiki-links]]", which /wrap keeps in a promoted title): only a `]` followed
// by `(` ends it, so the first memory link on the line is the bullet's own.
const ENTRY = /^\s*-\s*\[((?:[^\]]|\](?!\())*)\]\((brain\/memory\/[^)]+\.md)\)\s*(?:—\s*(.*))?$/;
const LEAD = /^\s*-\s*\[((?:[^\]]|\](?!\())*)\]\((brain\/memory\/[^)]+\.md)\)/;

/**
 * A MEMORY.md bullet `- [Title](brain/memory/….md) — description`: { title, path, description }, or null. A CRLF line
 * reads as its LF twin. A bullet that opens with the link but goes on another way (a typed ` - ` for the dash) is still
 * that memory's line, with no description to copy.
 */
function entryOf(line) {
  const s = String(line).replace(/\r$/, '');
  const b = ENTRY.exec(s);
  if (b) return { title: b[1], path: b[2], description: (b[3] || '').trim() };
  const l = LEAD.exec(s);
  return l ? { title: l[1], path: l[2], description: '' } : null;
}

/** Every memory path some MEMORY.md bullet links (`](brain/memory/….md)`, memory-index.js's linksTo rule). */
function linkedPaths(raw) {
  const out = new Set();
  for (const l of String(raw || '').split('\n')) {
    if (!/^\s*-\s/.test(l)) continue;
    for (const m of l.matchAll(/\]\((brain\/memory\/[^)]+\.md)\)/g)) out.add(m[1]);
  }
  return out;
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

/** Titles compared as a person reads them: spaces folded, case ignored. */
function sameTitle(a, b) {
  const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return n(a) !== '' && n(a) === n(b);
}

/**
 * The findings, from the store as the caller read it: `live` and `byPath` are memory-ops describe() rows (byPath holds
 * every memory, archived and superseded too, so their lines are not broken), `indexLines` readIndexLines' map, `drafts`
 * listDrafts' rows. `linked` (linkedPaths) counts a bullet that links a memory some other way as its line; `exists(rel)`
 * says whether anything at all is at a path, so a line to a link or a file too big to read is not broken (the index fix
 * removes only a line whose file is gone). → brain-hub.json's `hygiene`.
 */
function findHygiene({ live, byPath, indexLines, drafts, linked = new Set(), exists = () => false }) {
  const sources = {};
  for (const m of live) { const s = m.source || '(none)'; sources[s] = (sources[s] || 0) + 1; }
  // A draft is left behind only when its rule is the live one: the same slug and the same title. A new rule whose first
  // six words match an old one's slug (memory-writer slugify) is a draft nobody has reviewed yet.
  const liveRule = new Map(live.filter((m) => m.type === 'feedback').map((m) => [m.slug, m.title]));
  return {
    sources,
    oldType: live.filter(oldType).map((m) => m.path),
    // Frontmatter needed, as oldType: the descriptions fix edits an existing block, it never makes one.
    noDescription: live.filter((m) => m.hasFrontmatter && !m.description && (indexLines.get(m.path) || []).some((e) => e.description)).map((m) => m.path),
    unindexed: live.filter((m) => !indexLines.has(m.path) && !linked.has(m.path)).map((m) => m.path),
    misfiled: [...indexLines.entries()].filter(([p, es]) => byPath.has(p) && es.some((e) => !ownHeading(byPath.get(p).type, e.heading))).map(([p]) => p),
    brokenIndex: [...indexLines.keys()].filter((p) => !byPath.has(p) && ops.PATH_RE.test(p) && !exists(p)),
    leftoverDrafts: drafts.filter((d) => liveRule.has(d.slug) && sameTitle(liveRule.get(d.slug), d.title)).map((d) => d.slug),
  };
}

module.exports = { LEGACY_SOURCES, CANON_SOURCE, headingOf, entryOf, linkedPaths, readIndexLines, findHygiene, ownHeading, legacySource, oldType };
