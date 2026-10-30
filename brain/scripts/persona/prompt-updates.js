#!/usr/bin/env node
'use strict';
/**
 * prompt-updates.js — a release's Chief of Staff prompts reach an existing vault as proposals (spec
 * 2026-10-24-persona-learning-loop-design D13). IDENTITY.md and duties/*.md are rendered once by the interview and are
 * the user's from then on, and guarded: `aos upgrade` never rewrites them. So after the runtime is re-vendored, each one
 * whose render from the new templates (with this vault's answers, interview.js's own templateVars) differs from the file
 * becomes a `self` proposal: the What is the whole new text, the Why the diff, and the review applies it like any other —
 * or the user rejects it and keeps their own. The render is kept at brain/_index/persona-prompts/<rel>, so the
 * proposal's recheck (`! cmp -s <file> <render>`) can tell when it is applied.
 *
 *   node prompt-updates.js [--root <vault>] [--node <path>] [--version <x.y.z>] [--dry-run]
 *       prints { filed: [slug…], unchanged: [rel…], pending: [slug…], declined: [slug…] } or { skipped: reason }
 *
 * A proposal already pending for a file is rewritten only when the render changed; a render the user rejected (its hash
 * is the `filed` ledger line's note) is not filed again. IDENTITY.md's `updated:` date never counts as a change. Nothing
 * runs when the persona was never set up (no persona/answers.json) or is off (persona/DISABLED). Exit 0 on every path
 * but a usage error (2).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const RENDERS = 'brain/_index/persona-prompts';
const DECIDED = new Set(['rejected', 'dismissed', 'stale-dropped', 'approved']);

function localDay(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function hash(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12); }
function readOr(file, fallback = null) { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } }
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
/** The `updated: <date>` line is the render's date, not its content. */
function withoutDate(text) { return String(text).replace(/^updated: \d{4}-\d{2}-\d{2}$/m, 'updated: —'); }
function dateIn(text) { const m = /^updated: (\d{4}-\d{2}-\d{2})$/m.exec(String(text || '')); return m ? m[1] : null; }

/** The slug a file's update proposal uses: update-identity, update-duty-<name>. */
function slugFor(rel) { return rel === 'IDENTITY.md' ? 'update-identity' : `update-duty-${path.basename(rel, '.md')}`; }

/** `diff -u` of the two texts, clipped; '' when diff is missing. */
function unifiedDiff(a, b, label) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aos-prompt-diff-'));
  try {
    const fa = path.join(dir, 'current'), fb = path.join(dir, 'new');
    fs.writeFileSync(fa, a); fs.writeFileSync(fb, b);
    const r = spawnSync('diff', ['-u', '--label', `${label} (this vault)`, '--label', `${label} (this release)`, fa, fb], { encoding: 'utf8' });
    const lines = String(r.stdout || '').split('\n');
    return lines.length > 240 ? `${lines.slice(0, 240).join('\n')}\n… (${lines.length - 240} more lines)` : lines.join('\n').trimEnd();
  } catch { return ''; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The fence for a text: one more backtick than the longest run inside it, at least four. */
function fenceFor(text) { return '`'.repeat(Math.max(4, ...(String(text).match(/`+/g) || ['']).map((s) => s.length + 1))); }

function proposalText({ rel, slug, next, current, renderHash, today, version }) {
  const release = version ? `UniDeX ${version}` : 'this release';
  const what = rel === 'IDENTITY.md' ? 'the Chief of Staff\'s identity' : `the ${path.basename(rel, '.md')} duty's prompt`;
  const fence = fenceFor(next);
  const diff = unifiedDiff(current, next, `persona/${rel}`);
  const change = [{ path: `persona/${rel}`, op: 'replace', base: `sha256:${crypto.createHash('sha256').update(current).digest('hex')}`, content: next }];
  const changes = JSON.stringify(change, null, 2).split('\n').map((line) => `  ${line}`).join('\n');
  return `---
slug: ${slug}
filed: ${today}
kind: self
target: persona/${rel} (guarded)
recheck: "! cmp -s persona/${rel} ${RENDERS}/${rel}"
render: ${renderHash}
changes: |
${changes}
---

# Update ${what} to the one ${release} ships

## What
Replace \`persona/${rel}\` with exactly this text:

${fence}markdown
${next.replace(/\n$/, '')}
${fence}

## Why
${release} changed the template this file is rendered from (the CHANGELOG says why). This vault's copy differs from the new render with your answers; the diff is what approving it changes, a line you edited by hand included.

${diff ? `${fenceFor(diff)}diff\n${diff}\n${fenceFor(diff)}` : '(no `diff` on this machine: compare the What with the file.)'}

## Risk
Approving replaces the whole file: a line you edited by hand that the new text lacks is lost (a \`-\` line above). Reject it to keep yours; the same render is not proposed again.

## Premises
| Premise | Status | Evidence |
|---|---|---|
| \`persona/${rel}\` differs from the new render | VERIFIED | compared at \`aos upgrade\`, ${today} |
| the new render uses this vault's answers | VERIFIED | \`persona/answers.json\`, the recorded Node and the vault path |
`;
}

/** The proposals already in persona/proposals/ for a slug: [{ file, render }]. */
function pendingFor(proposalsDir, slug) {
  let names = [];
  try { names = fs.readdirSync(proposalsDir).filter((f) => f.endsWith(`-${slug}.md`)); } catch { return []; }
  return names.map((f) => {
    const text = readOr(path.join(proposalsDir, f), '');
    const m = /^render: ([0-9a-f]+)$/m.exec(text);
    return { file: path.join(proposalsDir, f), render: m ? m[1] : null };
  });
}

/** True when the ledger shows this render was filed and then decided (rejected, dismissed, dropped or approved). */
function decidedBefore(records, slug, renderHash) {
  const evs = records.filter((r) => r.slug === slug);
  const filedAt = evs.findIndex((r) => r.event === 'filed' && String(r.note || '').includes(`render ${renderHash}`));
  return filedAt >= 0 && evs.slice(filedAt + 1).some((r) => DECIDED.has(r.event));
}

/**
 * → { filed, unchanged, pending, declined } or { skipped }. `deps` (tests): templatesDir, interview, ledger, html, now.
 */
function file({ vault, node, version = null, dryRun = false, deps = {} } = {}) {
  if (!vault) throw new Error('prompt-updates needs a vault');
  const persona = path.join(vault, 'persona');
  if (fs.existsSync(path.join(persona, 'DISABLED'))) return { skipped: 'the Chief of Staff is off (persona/DISABLED)' };
  const answersText = readOr(path.join(persona, 'answers.json'));
  if (!answersText) return { skipped: 'no Chief of Staff on this vault (persona/answers.json is missing)' };
  const I = deps.interview || require('./interview.js');
  const L = deps.ledger || require('./ledger.js');
  const now = deps.now || new Date();
  const today = localDay(now);
  const templatesDir = deps.templatesDir || I.defaultTemplatesDir();
  let answers;
  try { answers = I.normalizeAnswers(JSON.parse(answersText), {}); } catch (e) { return { skipped: `persona/answers.json unreadable (${e.message})` }; }
  const tmpl = (rel) => fs.readFileSync(path.join(templatesDir, rel), 'utf8');
  const sources = { 'IDENTITY.md': 'identity.template.md', ...Object.fromEntries(I.DUTIES.map((d) => [`duties/${d}.md`, path.join('duties', `${d}.md`)])) };
  const ledgerFile = path.join(persona, 'ledger.jsonl');
  const records = (() => { try { return L.read({ file: ledgerFile }); } catch { return []; } })();
  const proposalsDir = path.join(persona, 'proposals');
  const out = { filed: [], unchanged: [], pending: [], declined: [] };
  const written = [];
  for (const [rel, src] of Object.entries(sources)) {
    const current = readOr(path.join(persona, rel));
    if (current === null) continue;   // a missing prompt is the interview's to write, not a proposal's
    let template;
    try { template = tmpl(src); } catch { continue; }
    // Compared at the file's own date, filed with today's: a new day is not a new prompt.
    const at = dateIn(current);
    const sameDay = I.renderTemplate(template, I.templateVars(answers, { vault, node, now: at ? new Date(`${at}T12:00:00`) : now }));
    if (withoutDate(sameDay) === withoutDate(current)) { out.unchanged.push(rel); continue; }
    const next = I.renderTemplate(template, I.templateVars(answers, { vault, node, now }));
    const renderHash = hash(withoutDate(next));
    const slug = slugFor(rel);
    const open = pendingFor(proposalsDir, slug);
    if (open.some((p) => p.render === renderHash)) { out.pending.push(slug); continue; }
    if (decidedBefore(records, slug, renderHash)) { out.declined.push(slug); continue; }
    out.filed.push(slug);
    if (dryRun) continue;
    for (const p of open) fs.rmSync(p.file, { force: true });   // an older render of the same file, superseded
    const proposal = path.join(proposalsDir, `${today}-${slug}.md`);
    writeAtomic(path.join(vault, ...RENDERS.split('/'), ...rel.split('/')), next);
    writeAtomic(proposal, proposalText({ rel, slug, next, current, renderHash, today, version }));
    L.append({ event: 'filed', slug, kind: 'self', target: `persona/${rel} (guarded)`, by: 'upgrade', note: `render ${renderHash}` }, { file: ledgerFile, now });
    written.push(proposal);
  }
  if (written.length) {
    try { (deps.html || require('./proposal-html.js')).render({ root: vault, files: written, now }); } catch (e) { out.htmlError = e.message; }
  }
  return out;
}

function main(argv, { stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const known = new Set(['--root', '--node', '--version', '--dry-run']);
  const bad = argv.filter((a, i) => a.startsWith('--') && !known.has(a) && !(i > 0 && ['--root', '--node', '--version'].includes(argv[i - 1])));
  if (bad.length) { stderr(`usage: prompt-updates.js [--root <vault>] [--node <path>] [--version <x.y.z>] [--dry-run] (unknown ${bad.join(' ')})\n`); return 2; }
  try {
    const vault = val('--root') || require('../lib/paths.js').PATHS.VAULT;
    stdout(`${JSON.stringify(file({ vault, node: val('--node') || process.execPath, version: val('--version'), dryRun: argv.includes('--dry-run') }))}\n`);
  } catch (e) { stderr(`prompt-updates: ${e.message}\n`); }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { RENDERS, slugFor, withoutDate, fenceFor, decidedBefore, file, main };
