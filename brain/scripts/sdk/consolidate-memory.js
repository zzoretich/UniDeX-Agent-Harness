#!/usr/bin/env node
/**
 * consolidate-memory.js — scan brain/memory/** + brain/patterns/** for duplicate/
 * overlapping content and propose merges/deletes/renames.
 *
 * SAFE BY DESIGN: never edits or deletes source files. Only writes a review draft
 * at brain/_index/memory-consolidation.md.
 *   --context (default)  print the assembled prompt for Claude-in-session
 *   --write <file>       store the file's contents as the draft
 *   --local              generate through the provider
 *
 * Usage: node brain/scripts/sdk/consolidate-memory.js [--context|--local|--write <file>] [--print]
 */

const fs = require('fs');
const path = require('path');
const brain = require('./lib/brain.js');
const { reason } = require('./lib/qwen.js');
const { parseMode, printContext, readWriteFile, localProvider } = require('./lib/interactive.js');

const log = (...a) => console.error(...a);

function truncate(text, max = 600) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

const CONSOLIDATION_FORMAT = 'The markdown draft described in the system prompt: frontmatter, Summary, Merge candidates, Delete candidates, Rename / reorganize, Leave alone.';

/** Everything the model needs, or null with fewer than two memory files. */
function buildConsolidation() {
  // Archived and superseded memories are already retired (brain-hub D5, D7): never offered for merging or deleting again.
  const { isRetired } = require('./lib/recall.js');
  const mems = brain.listMemories().filter((m) => !isRetired(m.frontmatter));
  const pats = brain.listPatterns();
  const all = [
    ...mems.map((m) => ({ path: m.path, type: m.type, content: brain.readIfExists(m.absPath) || '' })),
    ...pats.map((p) => ({ path: p.path, type: 'pattern', content: brain.readIfExists(p.absPath) || '' })),
  ];
  if (all.length < 2) return null;
  const blob = all.map((f) => `\n=== ${f.path} (${f.type}) ===\n${truncate(f.content)}`).join('\n');
  const now = new Date().toISOString();
  const system = [
    "You are a memory-system janitor. Surface redundancy, overlap, and decay in the user's second-brain memories. You DO NOT edit files — you propose actions the user will review.",
    'Output a single markdown document in this exact shape:',
    '', '---', 'type: memory-consolidation-draft', `generated: ${now}`, 'tags: [consolidation, draft]', '---', '',
    '# Memory Consolidation Draft', '',
    '## Summary', '- total files reviewed: N', '- merge candidates: N', '- delete candidates: N', '- rename/reorganize candidates: N', '',
    '## Merge candidates', '### <suggested merged name>', '- **Merge**: `path/a.md` + `path/b.md` → keep `path/a.md`', '- **Why**: 1 sentence on the overlap.', '- **Delta**: what each brings that must be preserved.', '',
    '## Delete candidates', '- `path/file.md` — 1-line reason (stale, subsumed, contradicted)', '',
    '## Rename / reorganize', '- `path/old.md` → `path/new.md` — reason', '',
    '## Leave alone (high-signal)', '- `path/file.md` — 1-line reason', '',
    'Rules: specific paths, no hedging. Empty section -> "(none)". Never suggest deleting the user profile or active feedback rules unless literally empty/duplicated.',
  ].join('\n');
  const prompt = ['Review these memory files and produce the consolidation draft.', '', `Total files: ${all.length}`, '', blob].join('\n');
  return { system, prompt, now, count: all.length };
}

/** Stores the draft (adds frontmatter when the text has none). Returns the path. */
function writeConsolidation(text, { now }) {
  const output = text.includes('type: memory-consolidation-draft')
    ? text
    : `---\ntype: memory-consolidation-draft\ngenerated: ${now}\ntags: [consolidation, draft]\n---\n\n${text}`;
  const outPath = path.join(brain.PATHS.VAULT, 'brain/_index/memory-consolidation.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, output);
  return outPath;
}

async function main() {
  const { mode, writeFile, rest } = parseMode(process.argv.slice(2));
  const print = rest.includes('--print');
  if (mode === 'write') {
    const outPath = writeConsolidation(readWriteFile(writeFile), { now: new Date().toISOString() });
    log(`[consolidate] wrote ${path.relative(brain.PATHS.VAULT, outPath)}`);
    return;
  }
  const spec = buildConsolidation();
  if (!spec) { log('[consolidate] not enough memory files.'); return; }
  if (mode === 'context') { printContext({ feature: 'consolidate-memory', system: spec.system, context: spec.prompt, format: CONSOLIDATION_FORMAT }); return; }

  const p = await localProvider('reason:consolidate-memory', { role: 'reasoner' });
  log(`[consolidate] reviewing ${spec.count} files via ${p.name}${p.degraded ? ` (reasoner unavailable: ${p.degraded}; workhorse)` : ''}…`);
  let text;
  try { text = await reason(spec.prompt, { system: spec.system, effort: 'medium', numPredict: 3072, feature: 'reason:consolidate-memory', chatFn: (o) => p.chat({ ...o, feature: 'reason:consolidate-memory' }), providerName: p.name }); }
  catch (e) { log('[consolidate] model error:', e.message); process.exit(1); }
  if (!text) { log('[consolidate] empty response; aborting.'); process.exit(1); }
  const outPath = writeConsolidation(text, spec);
  log(`[consolidate] wrote ${path.relative(brain.PATHS.VAULT, outPath)}`);
  if (print) process.stdout.write(fs.readFileSync(outPath, 'utf8') + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[consolidate] ${err.code === 'PROVIDER_NONE' ? err.message : 'fatal: ' + (err?.stack || err)}`);
    process.exit(1);
  });
}

module.exports = { buildConsolidation, writeConsolidation, CONSOLIDATION_FORMAT };
