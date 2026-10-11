'use strict';
/**
 * feedback-drafts.js — draft feedback rules awaiting the owner's batch approval.
 * Drafts live in brain/memory/feedback/_drafts/ (deliberately NOT indexed in
 * MEMORY.md); approval promotes a draft through memory-writer.js writeMemory so
 * an applied rule is byte-identical to a hand-written one. Every capture /
 * recurrence / apply / reject appends to feedback-metrics.jsonl — the raw feed
 * for the weekly captured-vs-recurred counter (feedback-metrics.js).
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths.js');
const { slugify, writeMemory } = require('./memory-writer.js');
const { appendTrail } = require('./promote-log.js');

const DRAFTS_DIR = path.join(PATHS.MEMORY_DIR, 'feedback', '_drafts');
const METRICS_PATH = path.join(PATHS.INDEX, 'feedback-metrics.jsonl');

function logEvent(entry) {
  const row = { ts: new Date().toISOString(), ...entry };
  fs.mkdirSync(path.dirname(METRICS_PATH), { recursive: true });
  fs.appendFileSync(METRICS_PATH, JSON.stringify(row) + '\n');
  return row;
}

function readEvents({ sinceDays = 7 } = {}) {
  let raw;
  try { raw = fs.readFileSync(METRICS_PATH, 'utf8'); } catch { return []; }
  const cutoff = Date.now() - sinceDays * 86_400_000;
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (Date.parse(r.ts) >= cutoff) rows.push(r);
    } catch { /* corrupt line — skip */ }
  }
  return rows;
}

function writeDraft({ title, description, body, session, needsReview = false }) {
  const slug = slugify(title);
  const abs = path.join(DRAFTS_DIR, `${slug}.md`);
  if (fs.existsSync(abs)) throw new Error(`draft already exists: ${slug}`);
  const today = new Date().toISOString().slice(0, 10);
  // needs-review: produced by the regex prefilter with no model to distill a rule —
  // the reviewer rewrites or rejects it (feedback-review skill).
  const status = needsReview ? 'status/needs-review' : 'status/draft';
  const source = needsReview ? 'prefilter' : 'feedback-autoloop';
  const doc = `---\ntype: memory\ntags: [memory/feedback, ${status}]\ncreated: ${today}\nupdated: ${today}\nsource: ${source}\nsession: ${session ?? 'unknown'}\ndescription: ${String(description ?? '').replace(/\n/g, ' ')}\n---\n\n# ${title}\n\n${String(body ?? '').trim()}\n`;
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  fs.writeFileSync(abs, doc);
  return { draftPath: abs, slug };
}

function parseDraft(abs) {
  const raw = fs.readFileSync(abs, 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2];
    }
  }
  const h1 = raw.match(/^# (.+)$/m);
  const bodyStart = h1 ? raw.indexOf(h1[0]) + h1[0].length : 0;
  return {
    slug: path.basename(abs, '.md'),
    path: abs,
    title: h1 ? h1[1].trim() : path.basename(abs, '.md'),
    description: meta.description || '',
    session: meta.session || 'unknown',
    body: raw.slice(bodyStart).trim(),
  };
}

function listDrafts() {
  let names;
  try { names = fs.readdirSync(DRAFTS_DIR); } catch { return []; }
  return names.filter((n) => n.endsWith('.md')).sort()
    .map((n) => parseDraft(path.join(DRAFTS_DIR, n)));
}

function applyDraft(slug) {
  const d = parseDraft(path.join(DRAFTS_DIR, `${slug}.md`));
  const res = writeMemory({
    type: 'feedback', slug: d.slug, title: d.title, description: d.description,
    body: d.body, source: 'feedback-autoloop', session: d.session,
  });
  fs.unlinkSync(d.path);
  logEvent({ event: 'applied', session: d.session, title: d.title, slug: d.slug });
  return res;
}

function rejectDraft(slug) {
  const d = parseDraft(path.join(DRAFTS_DIR, `${slug}.md`));
  fs.unlinkSync(d.path);
  appendTrail({ session: d.session, action: 'reverted', slug: d.slug, type: 'feedback', title: d.title });
  logEvent({ event: 'rejected', session: d.session, title: d.title, slug: d.slug });
  return { slug: d.slug };
}

/** H1 titles of ACTIVE rules in brain/memory/feedback/ (excludes _drafts/, and a rule archived or superseded in the
 *  Brain tab: it no longer covers a correction, so a repeat of it is drafted again; brain-hub D5, D7). */
function activeRuleTitles() {
  const { splitFm, getStatus, GONE } = require('./memory-ops.js');
  const dir = path.join(PATHS.MEMORY_DIR, 'feedback');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const titles = [];
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    try {
      const text = fs.readFileSync(path.join(dir, n), 'utf8');
      if (GONE.includes(getStatus((splitFm(text) || { lines: [] }).lines))) continue;
      const m = text.match(/^# (.+)$/m);
      titles.push(m ? m[1].trim() : n.replace(/\.md$/, ''));
    } catch { /* unreadable — skip */ }
  }
  return titles;
}

module.exports = {
  DRAFTS_DIR, METRICS_PATH, logEvent, readEvents, writeDraft, parseDraft,
  listDrafts, applyDraft, rejectDraft, activeRuleTitles,
};
