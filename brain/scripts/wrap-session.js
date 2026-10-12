#!/usr/bin/env node
/**
 * Session-end wrap — invoked by /wrap slash command or auto-triggered on new session
 * when SESSION.md is stale (from a previous day).
 *
 * 1. Append final summary to today's session log
 * 2. Promote #promote-tagged lines from SESSION.md into permanent memory
 * 3. Reset SESSION.md to clean template
 */

const fs = require('fs');
const path = require('path');
const { PATHS, dailyNotePath } = require('./lib/paths.js');
const { deriveTitle, deriveDescription, writeMemory } = require('./lib/memory-writer.js');
const { appendTrail } = require('./lib/promote-log.js');
const fsx = require('./lib/fsx.js');

const VAULT = PATHS.VAULT;
const SESSION_WM = path.join(VAULT, 'brain/_index/SESSION.md');
const MEMORY_INDEX = path.join(VAULT, 'MEMORY.md');

// user/feedback/project/reference route through lib/memory-writer.js (the
// same writer auto-wrap.js uses) so manual and auto promotions share one
// writer + one trail (spec 5.3). project (singular, our local key) maps to
// memory-writer's `projects` (plural) type/directory.
const WRITER_TYPE = { user: 'user', feedback: 'feedback', project: 'projects', reference: 'reference' };

// `pattern` is the one type memory-writer.js has no bucket for — patterns
// live at brain/patterns/, outside its brain/memory/<type>/ tree — so it
// keeps the local writer below. Destination path is always built from this
// fixed dir + a sanitized slug — never from free-text body content.
const TYPE_DIRS = { pattern: 'brain/patterns' };
const TYPE_SECTION = { pattern: 'Patterns' };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

/**
 * True only for a line carrying #promote as a TAG, not prose about the tag.
 * /remember always appends the tag as the line's terminal token, so a genuine
 * tag may be followed only by other #tags or punctuation — never bare words.
 * Code spans are blanked first so a `#promote` mention can't match. (Live
 * incident 2026-08-07: an auto-summary sentence "…none tagged #promote in this
 * session)." was itself promoted into a junk reference memory.)
 */
function hasPromoteTag(line) {
  const noCode = String(line).replace(/`[^`]*`/g, ' ');
  const m = noCode.match(/#promote\b(.*)$/);
  if (!m) return false;
  const trailingTokens = m[1].split(/\s+/).filter(Boolean);
  return trailingTokens.every((t) => t.startsWith('#') || /^[^\w]+$/.test(t));
}

function promoteToMemory(session) {
  // Find lines tagged with #promote or in a "Promote to Memory on Close" section
  const lines = session.split('\n');
  const promoteLines = [];
  let inPromoteBlock = false;
  for (const line of lines) {
    if (/^##\s+Promote to Memory/i.test(line)) { inPromoteBlock = true; continue; }
    if (inPromoteBlock && /^##\s/.test(line)) { inPromoteBlock = false; }
    // `continue` so a tagged line inside the block is collected exactly once.
    if (inPromoteBlock && line.trim().startsWith('-')) { promoteLines.push(line.trim()); continue; }
    if (hasPromoteTag(line)) promoteLines.push(line.trim());
  }

  const promoted = [];
  const skipped = [];
  for (const raw of promoteLines) {
    let text = raw.replace(/^-+\s*/, '').replace(/#promote\b/g, '').trim();
    if (!text) continue;
    // Optional leading type prefix (feedback:/project:/pattern:/reference:/user:)
    // selects the bucket; default reference. Prefix is stripped from content.
    let type = 'reference';
    const pm = text.match(/^(feedback|project|pattern|reference|user)\s*:\s*(.+)$/i);
    if (pm) { type = pm[1].toLowerCase(); text = pm[2].trim(); }

    const writerType = WRITER_TYPE[type];
    if (writerType) {
      // Shared path: same writer + trail as auto-wrap. Title/slug are
      // self-derived by writeMemory from description when title alone would
      // duplicate that work; here we pass both since a manual promote line
      // is the only source text available for either.
      try {
        const res = writeMemory({
          type: writerType,
          title: deriveTitle(text),
          description: deriveDescription(text),
          body: text,
          source: 'manual-wrap',
        });
        appendTrail({ session: 'unknown', action: 'written', slug: res.slug, type: writerType, title: deriveTitle(text) });
        promoted.push({ text, target: res.memoryPath });
      } catch (e) {
        console.error('promote failed:', e.message);
        skipped.push({ title: deriveTitle(text), reason: e.message });
      }
      continue;
    }

    // pattern: outside memory-writer's brain/memory/ tree — local writer only.
    // Path is ALWAYS dir + sanitized slug — never derived from the body text
    // (which may contain URLs, slashes, backticks, arrows, etc.).
    const name = slug(text).slice(0, 48) || 'note';
    const target = `${TYPE_DIRS[type]}/${name}.md`;
    // Mirrors the shared-writer branch above: appendToMemoryFile throws on
    // failure (still logs via console.error internally) so a failed write is
    // caught here and recorded as skipped, never silently counted as promoted.
    try {
      appendToMemoryFile(path.join(VAULT, target), text, type);
      ensureIndexEntry(target, text, type);
      promoted.push({ text, target });
    } catch (e) {
      skipped.push({ title: deriveTitle(text), reason: e.message });
    }
  }
  return { promoted, skipped };
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function appendToMemoryFile(fullPath, text, type = 'reference') {
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const today = todayStr();
    const title = text.slice(0, 60);
    // One locked create-or-append (spec 2026-09-24-locked-writers D3).
    fsx.updateSync(fullPath, (existing) => {
      if (existing != null) return existing.replace(/updated: \d{4}-\d{2}-\d{2}/, `updated: ${today}`) + `\n- ${today}: ${text}\n`;
      return `---
type: memory
tags: [memory/${type}, status/active]
created: ${today}
updated: ${today}
---

# ${title}

## Detail
${text}

## History
- ${today}: promoted from SESSION.md
`;
    }, { timeoutMs: 5000 });
  } catch (e) {
    console.error('append failed:', e.message);
    throw e;
  }
}

function ensureIndexEntry(relPath, text, type = 'reference') {
  try {
    const title = path.basename(relPath, '.md').replace(/-/g, ' ');
    const section = TYPE_SECTION[type] || 'Reference';
    const entry = `- [${title}](${relPath}) — ${text.slice(0, 80)}\n`;
    // Append under the matching section header. Match the header by prefix so
    // "## Feedback (how to work)" is found (and we don't append a duplicate
    // "## Feedback" section). Locked, against the index as it is now.
    const re = new RegExp(`(##\\s+${section}\\b[^\\n]*\\n(?:[^\\n]*\\n)*?)`, 'i');
    fsx.updateSync(MEMORY_INDEX, (text0) => {
      const idx = text0 == null ? '' : text0;
      if (idx.includes(relPath)) return idx;
      return re.test(idx) ? idx.replace(re, `$1${entry}`) : `${idx}\n## ${section}\n${entry}`;
    }, { timeoutMs: 5000 });
  } catch (_) {}
}

function appendSessionWrap(promoted, skipped = []) {
  const today = todayStr();
  const logFile = dailyNotePath(new Date());
  const now = new Date().toLocaleString('en-US', { hour12: false });
  const lines = [`\n\n## Session Wrap @ ${now}`];
  if (promoted.length) {
    lines.push('Promoted to memory:');
    for (const p of promoted) lines.push(`- ${p.text} → \`${p.target}\``);
  } else {
    lines.push('_No items promoted._');
  }
  for (const s of skipped) lines.push(`Skipped: ${s.title} — ${s.reason}`);
  try {
    // Under the daily note's lock: the Stop hook rewrites the note's last-active marker under it, and an append that
    // landed mid-rewrite was lost.
    fsx.updateSync(logFile, (t) => (t == null ? `---\ntype: daily-note\ndate: ${today}\ntags: [daily-note]\n---\n\n# ${today}\n\n## Claude Code Sessions\n` : t) + lines.join('\n') + '\n', { timeoutMs: 5000 });
  } catch (_) {}
}

function resetSessionWM() {
  const template = `---
type: session
updated: ${todayStr()}
---

# Current Session Working Memory

> Ephemeral — cleared/promoted at session end. Max ~400 tokens.
> Use this to track context within the current conversation.

## Active Task

## Key Context This Session

## Decisions Made

## Things to Remember

## Promote to Memory on Close
`;
  try { fsx.updateSync(SESSION_WM, () => template, { timeoutMs: 5000 }); } catch (_) {}
}

/**
 * brain/_index/brain-hub.json (and the map beside it) again after a wrap promoted something, so the Brain tab shows it
 * before the next scan (brain-hub plan, PR 2 follow-ups). `build` is injectable for tests. A failure is logged and never
 * fails the wrap: the next scan rebuilds it.
 */
function rebuildBrainHub(build) {
  try {
    const run = build || require('./brain-hub.js').buildBrainHub;
    run({ vault: VAULT, cfg: require('./lib/config.js').loadConfig() });
    return true;
  } catch (e) {
    console.error('brain-hub rebuild failed:', e.message);
    return false;
  }
}

function main() {
  const session = readFile(SESSION_WM);
  if (!session.trim()) { resetSessionWM(); return; }
  const { promoted, skipped } = promoteToMemory(session);
  appendSessionWrap(promoted, skipped);
  resetSessionWM();
  if (promoted.length) rebuildBrainHub();
  const skipSuffix = skipped.length
    ? `, skipped ${skipped.length} (reasons: ${skipped.map(s => `${s.title}: ${s.reason}`).join('; ')})`
    : '';
  console.log(`Wrap complete. Promoted ${promoted.length} item(s)${skipSuffix}.`);
  if (promoted.length) {
    for (const p of promoted) console.log(`  - ${p.text} → ${p.target}`);
  }
  if (skipped.length) {
    for (const s of skipped) console.log(`  ! skipped: ${s.title} — ${s.reason}`);
  }
}

if (require.main === module) main();

module.exports = { promoteToMemory, slug, appendToMemoryFile, ensureIndexEntry, rebuildBrainHub };
