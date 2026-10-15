#!/usr/bin/env node
/**
 * reflect-week.js — weekly reflection from the last 7 daily notes + git history.
 * Writes brain/reflections/<YYYY-WW>.md.
 *   --context (default)  print the assembled prompt for Claude-in-session
 *   --write <file>       store the file's contents as this week's reflection
 *   --local              generate through the provider: under provider local where ai.reflectWeek says (local-first A2)
 *     --host=claude|codex  with --local: that host once, never another
 *
 * Usage: node brain/scripts/sdk/reflect-week.js [--context|--local|--write <file>] [--weeks=N] [--print]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const brain = require('./lib/brain.js');
const { reason } = require('./lib/qwen.js');
const { parseMode, hostFlag, printContext, readWriteFile, localProvider } = require('./lib/interactive.js');

const log = (...a) => console.error(...a);

function parseFlags(argv) {
  return new Map(argv.map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }));
}

function gitLog(days) {
  try {
    return execSync(`git log --since="${days} days ago" --pretty=format:"%h %ad %s" --date=short`, {
      cwd: brain.PATHS.VAULT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

function truncate(text, max = 2000) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

const REFLECTION_FORMAT = 'The markdown document described in the system prompt: frontmatter, then Highlights / Patterns noticed / Open threads / Lessons / Candidate memory updates.';

/** Everything the model needs, or null when the window has no daily notes. */
function buildReflection({ weeks = 1 } = {}) {
  const days = weeks * 7;
  const sessions = brain.listSessions(days + 5);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const inWindow = sessions.filter((s) => new Date(s.date) >= cutoff);
  if (!inWindow.length) return null;

  const sessionBlob = inWindow.map((s) => `### ${s.date}\n${truncate(brain.readIfExists(s.absPath) || '')}`).join('\n\n');
  const gitBlob = gitLog(days);
  const snap = brain.loadSnapshot();
  const week = brain.isoWeek(new Date());
  const now = new Date().toISOString();

  const system = [
    "You are the user's reflective journal. Surface patterns, wins, losses, and open questions across a week of work — do not just restate what happened.",
    'Output a single markdown document in this exact shape:',
    '',
    '---', 'type: reflection', `week: ${week}`, 'tags: [reflection, weekly]', `generated: ${now}`, '---', '',
    `# Reflection — ${week}`, '',
    '## Highlights (what actually moved)', '- Concrete wins with date anchors in backticks, 3-6 bullets max.', '',
    '## Patterns noticed', '- Recurring behaviors, decision tendencies, friction points. 2-5 bullets.', '',
    '## Open threads', '- Things still in flight, carrying over. Action-oriented.', '',
    '## Lessons', '- 1-3 distilled learnings. Terse. As rules if applicable.', '',
    '## Candidate memory updates', '- Propose new feedback/pattern memories. Format: `- [type] <filename>.md — <summary>`. Proposals only.', '',
    'Rules: no preamble, no hedging, no meta-commentary, no emoji. Terse. Empty section -> "(nothing of note)".',
  ].join('\n');

  const prompt = [
    `Reflect on the last ${days} days (${inWindow[inWindow.length - 1].date} → ${inWindow[0].date}). Write the reflection for week ${week}.`,
    '', '## Daily notes', sessionBlob,
    '', '## Git history', gitBlob || '(no commits in window)',
    '', '## Current vault state',
    snap ? `memories=${snap.brain?.counts?.memoryTotal || 0}, patterns=${snap.brain?.counts?.patterns || 0}, plans=${snap.plans?.summary?.total || 0}` : 'snapshot unavailable',
  ].join('\n');

  return { system, prompt, week, now, notes: inWindow.length };
}

/** Stores the reflection (adds frontmatter when the text has none). Returns the path. */
function writeReflection(text, { week, now }) {
  const output = text.includes('type: reflection')
    ? text
    : `---\ntype: reflection\nweek: ${week}\ntags: [reflection, weekly]\ngenerated: ${now}\n---\n\n${text}`;
  const outPath = path.join(brain.PATHS.REFLECTIONS_DIR, `${week}.md`);
  fs.mkdirSync(brain.PATHS.REFLECTIONS_DIR, { recursive: true });
  fs.writeFileSync(outPath, output);
  return outPath;
}

async function main() {
  let host;
  let argv;
  try { ({ host, rest: argv } = hostFlag(process.argv.slice(2))); } catch (e) { log(`[reflect] ${e.message}`); process.exit(2); }
  const { mode, writeFile, rest } = parseMode(argv);
  const flags = parseFlags(rest);
  const weeks = parseInt(flags.get('weeks') || '1', 10);
  const print = !!flags.get('print');

  if (mode === 'write') {
    const outPath = writeReflection(readWriteFile(writeFile), { week: brain.isoWeek(new Date()), now: new Date().toISOString() });
    log(`[reflect] wrote ${path.relative(brain.PATHS.VAULT, outPath)}`);
    return;
  }
  const spec = buildReflection({ weeks });
  if (!spec) { log('[reflect] no daily notes in window; nothing to reflect on.'); return; }
  if (mode === 'context') { printContext({ feature: 'reflect-week', system: spec.system, context: spec.prompt, format: REFLECTION_FORMAT }); return; }

  const p = await localProvider('reason:reflect-week', { role: 'reasoner', prefer: host || undefined });
  log(`[reflect] week=${spec.week} notes=${spec.notes} days=${weeks * 7} — calling ${p.name}${p.degraded ? ` (reasoner unavailable: ${p.degraded}; workhorse)` : ''}…`);
  let text;
  try { text = await reason(spec.prompt, { system: spec.system, effort: 'medium', numPredict: 3072, feature: 'reason:reflect-week', noFallback: !!host, chatFn: (o) => p.chat({ ...o, feature: 'reason:reflect-week' }), providerName: p.name }); }
  catch (e) { log('[reflect] model error:', e.message); process.exit(1); }
  if (!text) { log('[reflect] empty response; aborting.'); process.exit(1); }
  const outPath = writeReflection(text, spec);
  log(`[reflect] wrote ${path.relative(brain.PATHS.VAULT, outPath)}`);
  if (print) process.stdout.write(fs.readFileSync(outPath, 'utf8') + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[reflect] ${err.code === 'PROVIDER_NONE' ? err.message : 'fatal: ' + (err?.stack || err)}`);
    process.exit(1);
  });
}

module.exports = { buildReflection, writeReflection, REFLECTION_FORMAT };
