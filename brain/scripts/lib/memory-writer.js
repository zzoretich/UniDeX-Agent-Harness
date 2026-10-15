'use strict';
/**
 * memory-writer.js — script-side port of the Obsidian plugin's memory writer
 * (src/data/memoryWriter.ts). slugify/deriveTitle here, and deriveDescription
 * and the section-aware MEMORY.md index insertion in memory-index.js, are
 * ported verbatim (JS-ified); the two writers must stay behaviorally identical.
 *
 * P4 additions on top of the port: `source`, `session`, `reviewed: false`
 * frontmatter keys, emitted only when `source` is provided. The importer adds
 * `origin` (install-import B8: the host file a memory came from, as `~/…`),
 * emitted only when given; without it the output is the plugin writer's.
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths.js');
const fsx = require('./fsx.js');
// deriveDescription and the index insertion live in memory-index.js (no vault at load), ported from the same TS source.
const { deriveDescription, insertIndexLine } = require('./memory-index.js');

const VAULT = PATHS.VAULT;
const INDEX_PATH = path.join(VAULT, 'MEMORY.md');

// Ported from memoryWriter.ts TYPE_HEADING (line 5).
const TYPE_HEADING = { user: 'User', feedback: 'Feedback', projects: 'Project', reference: 'Reference' };

// Ported verbatim from memoryWriter.ts slugify (line 31).
function slugify(text, maxWords = 6) {
  return (
    text
      .toLowerCase()
      .replace(/[`*_~#>[\]()]/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, maxWords)
      .join('-')
      .slice(0, 80) || 'untitled'
  );
}

// Ported verbatim from memoryWriter.ts deriveTitle (line 43).
function deriveTitle(text, maxChars = 60) {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= maxChars) return single;
  return single.slice(0, maxChars).trimEnd();
}

/** A frontmatter value quoted when YAML would read it as something else (memory-ops yamlValue's rule). */
function yamlScalar(v) {
  const s = String(v).replace(/[\r\n]+/g, ' ').trim();
  return /^[-?:,[\]{}#&*!|>'"%@`~\s]|\s$|:$|: | #|^(?:true|false|yes|no|on|off|null)$|^[-+]?[\d.]+$/i.test(s) ? JSON.stringify(s) : s;
}

function writeMemory({ type, slug, title, description, body, source, session, origin }) {
  const resolvedTitle = title || deriveTitle(description);
  const s = slug || slugify(title || description || 'memory');
  const rel = `brain/memory/${type}/${s}.md`;
  const abs = path.join(VAULT, rel);

  if (fs.existsSync(abs)) throw new Error(`memory already exists: ${rel}`);

  const today = new Date().toISOString().slice(0, 10);
  const autoKeys = source ? `source: ${source}\nsession: ${session ?? 'unknown'}\nreviewed: false\n${origin ? `origin: ${yamlScalar(origin)}\n` : ''}` : '';
  const doc = `---\ntype: memory\ntags: [memory/${type}, status/active]\ncreated: ${today}\nupdated: ${today}\n${autoKeys}---\n\n# ${resolvedTitle}\n\n${body.trim()}\n`;

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, doc);

  const heading = `## ${TYPE_HEADING[type]}`;
  const entry = `- [${resolvedTitle}](${rel}) — ${description}`;
  // Locked read-change-write (spec 2026-09-24-locked-writers D3): auto-wrap, wrap_session and a reconcile's wrap can
  // add lines at once, and a plain rewrite kept only the last one's.
  fsx.updateSync(INDEX_PATH, (idx) => insertIndexLine(idx == null ? '# Index\n' : idx, heading, entry), { timeoutMs: 5000 });

  return { memoryPath: rel, slug: s, indexUpdated: true };
}

module.exports = { slugify, deriveTitle, deriveDescription, writeMemory };
