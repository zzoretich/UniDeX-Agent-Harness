'use strict';
/**
 * recall.js — pure-Node BM25 recall over the vault's living record.
 *
 * Corpus: brain/memory/**, brain/patterns/**, persona/journal/*.md (when present),
 *         and daily notes at <vault>/<YYYY>/<YYYY-MM-Month>/<YYYY-MM-DD>.md.
 * Index:  brain/_index/recall-index.json  (built by scan-vault.js at SessionEnd)
 * Wake:   brain/_index/recall-wake.md     (top-3 auto-recall, injected on session start)
 *
 * Zero external deps. Ranking = BM25 (k1=1.2, b=0.75) x recency boost
 * (1 + 0.5*e^(-ageDays/30)), plus 1-hop [[wiki-link]] expansion (linked docs
 * inherit 25% of the linker's score). Age from frontmatter `updated:` else mtime.
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter, walkMarkdown } = require('./brain.js');
const { VAULT: DEFAULT_VAULT, listDailyNotes } = require('../../lib/paths.js');

const K1 = 1.2;
const B = 0.75;
const RECENCY_WEIGHT = 0.5;
const RECENCY_HALF_LIFE_DAYS = 30;
const LINK_BONUS = 0.25;
const STALE_DAYS = 60;
const WAKE_MAX_SNIPPETS = 3;

const STOP = new Set(('a an and are as at be but by for from had has have i in is it its of on or ' +
  'that the this to was were will with you your we our not no so if then than when what which who ' +
  'how all any can do does did done just also more very much been being over under after before').split(/\s+/));

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && t.length <= 30 && !STOP.has(t));
}

function extractWikiLinks(body) {
  const out = [];
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(String(body || '')))) out.push(m[1].trim().toLowerCase());
  return out;
}

function collectCorpus(vault) {
  const files = [];
  const { loadConfig } = require('../../lib/config.js');
  // `recallRoots: null` in brain/config.json overrides the default array outright (deepMerge copies primitives over);
  // treat it as "no extra roots" instead of throwing.
  for (const root of (loadConfig().recallRoots || [])) files.push(...walkMarkdown(path.join(vault, root)));
  // Daily notes come from the configured layout only (spec §5.3) — a note left over from an earlier layout is not indexed.
  for (const note of listDailyNotes({ vault })) files.push(note.absPath);
  return files;
}

/** An archived or superseded note (brain-hub D5, D7): the recall and embed indexes leave it out. */
function isRetired(frontmatter) {
  const t = frontmatter && frontmatter.tags;
  const tags = Array.isArray(t) ? t : typeof t === 'string' ? t.replace(/[[\]]/g, '').split(/[\s,]+/) : [];
  return tags.some((x) => x === 'status/archived' || x === 'status/superseded');
}

function docAgeDays(abs, frontmatter, now) {
  const upd = frontmatter && typeof frontmatter.updated === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(frontmatter.updated) ? frontmatter.updated.slice(0, 10) : null;
  if (upd) {
    const t = Date.parse(upd);
    if (!Number.isNaN(t)) return Math.max(0, Math.round((now - t) / 86400000));
  }
  try { return Math.max(0, Math.round((now - fs.statSync(abs).mtimeMs) / 86400000)); }
  catch { return 0; }
}

function buildRecallIndex(opts = {}) {
  const vault = opts.vault || DEFAULT_VAULT;
  const now = opts.now || Date.now();
  const docs = [];
  const df = {};
  for (const abs of collectCorpus(vault)) {
    let raw;
    try { raw = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const { frontmatter, body } = parseFrontmatter(raw);
    if (isRetired(frontmatter)) continue;
    const toks = tokenize(path.basename(abs, '.md') + ' ' + body);
    const tf = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    for (const t of Object.keys(tf)) df[t] = (df[t] || 0) + 1;
    docs.push({
      path: path.relative(vault, abs).replace(/\\/g, '/'),
      name: path.basename(abs, '.md').toLowerCase(),
      ageDays: docAgeDays(abs, frontmatter, now),
      len: toks.length,
      tf,
      links: extractWikiLinks(body),
    });
  }
  const avgLen = docs.length ? docs.reduce((a, d) => a + d.len, 0) / docs.length : 0;
  return { version: 1, builtAt: new Date(now).toISOString(), vault, docCount: docs.length, avgLen, df, docs };
}

function indexPath(vault) { return path.join(vault, 'brain/_index/recall-index.json'); }
function wakePath(vault) { return path.join(vault, 'brain/_index/recall-wake.md'); }

function saveIndex(index, vault) {
  const p = indexPath(vault || index.vault);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  require('../../lib/fsx.js').writeAtomic(p, JSON.stringify(index));
  return p;
}

function loadIndex(vault) {
  try { return JSON.parse(fs.readFileSync(indexPath(vault || DEFAULT_VAULT), 'utf8')); }
  catch { return null; }
}

function ageFlag(ageDays) {
  return ageDays > STALE_DAYS ? `stale: ${ageDays}d` : `${ageDays}d`;
}

function snippetFor(vault, relPath, terms) {
  let raw;
  try { raw = fs.readFileSync(path.join(vault, relPath), 'utf8'); } catch { return ''; }
  const { body } = parseFrontmatter(raw);
  const lower = body.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  const start = idx < 0 ? 0 : Math.max(0, idx - 60);
  const chunk = body.slice(start, start + 200).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + chunk + (start + 200 < body.length ? '…' : '');
}

function queryRecall(index, query, opts = {}) {
  if (!index || !index.docs || !index.docs.length) return [];
  const vault = opts.vault || index.vault;
  const limit = Math.max(1, Math.min(10, opts.limit || 5));
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const N = index.docCount;
  const scores = new Map();
  index.docs.forEach((d, i) => {
    let s = 0;
    for (const t of terms) {
      const tf = d.tf[t];
      if (!tf) continue;
      const dfT = index.df[t] || 1;
      const idf = Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
      s += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (d.len / (index.avgLen || 1))));
    }
    if (s > 0) {
      s *= 1 + RECENCY_WEIGHT * Math.exp(-d.ageDays / RECENCY_HALF_LIFE_DAYS);
      scores.set(i, s);
    }
  });
  // 1-hop wiki-link expansion from the top-10 seed docs
  const byName = new Map();
  index.docs.forEach((d, i) => { if (!byName.has(d.name)) byName.set(d.name, i); });
  const seeds = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [i, s] of seeds) {
    for (const link of index.docs[i].links || []) {
      const j = byName.get(link);
      if (j != null && j !== i) scores.set(j, (scores.get(j) || 0) + LINK_BONUS * s);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([i, s]) => {
      const d = index.docs[i];
      return {
        path: d.path,
        score: Math.round(s * 100) / 100,
        ageDays: d.ageDays,
        flag: ageFlag(d.ageDays),
        stale: d.ageDays > STALE_DAYS,
        snippet: snippetFor(vault, d.path, terms),
      };
    });
}

const RRF_K = 60;
const HYBRID_SEED = 10; // each leg contributes its top-10 to the fusion

function loadEmbedIndex(vault) {
  try { return JSON.parse(fs.readFileSync(path.join(vault || DEFAULT_VAULT, 'brain/_index/embed-index.json'), 'utf8')); }
  catch { return null; }
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * queryRecallHybrid(index, query, opts) -> { hybrid, hits }
 * BM25 leg + vector leg (best-chunk cosine per doc) fused with Reciprocal
 * Rank Fusion: score(doc) = Σ 1/(RRF_K + rank). Falls back to BM25-only
 * ({hybrid:false}) when the embed index or the embedder is unavailable —
 * recall must never fail because Ollama is down.
 */
async function queryRecallHybrid(index, query, opts = {}) {
  const vault = opts.vault || index.vault;
  const limit = Math.max(1, Math.min(10, opts.limit || 5));
  const bm25 = queryRecall(index, query, { ...opts, vault, limit: HYBRID_SEED });
  const embIdx = opts.embedIndex !== undefined ? opts.embedIndex : loadEmbedIndex(vault);
  if (!embIdx || !Array.isArray(embIdx.chunks) || !embIdx.chunks.length) {
    return { hybrid: false, hits: bm25.slice(0, limit) };
  }
  let qvec;
  try {
    const embedFn = opts.embedFn || require('./embed.js').embed;
    qvec = (await embedFn([query], { timeoutMs: 5000 }))[0];
  } catch {
    return { hybrid: false, hits: bm25.slice(0, limit) };
  }
  if (!qvec) return { hybrid: false, hits: bm25.slice(0, limit) };
  if (typeof embIdx.dims === 'number' && qvec.length !== embIdx.dims) {
    return { hybrid: false, hits: bm25.slice(0, limit) };
  }

  const best = new Map(); // path -> best chunk cosine
  for (const c of embIdx.chunks) {
    const s = dot(qvec, c.vec);
    if (!best.has(c.path) || s > best.get(c.path)) best.set(c.path, s);
  }
  const vecRank = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, HYBRID_SEED).map(([p]) => p);

  const rrf = new Map();
  bm25.forEach((h, i) => rrf.set(h.path, (rrf.get(h.path) || 0) + 1 / (RRF_K + i + 1)));
  vecRank.forEach((p, i) => rrf.set(p, (rrf.get(p) || 0) + 1 / (RRF_K + i + 1)));

  const byPath = new Map(bm25.map((h) => [h.path, h]));
  const terms = [...new Set(tokenize(query))];
  const hits = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p, s]) => {
    const known = byPath.get(p);
    if (known) return { ...known, score: Math.round(s * 10000) / 10000 };
    const d = index.docs.find((dd) => dd.path === p);
    const ageDays = d ? d.ageDays : 0;
    return {
      path: p,
      score: Math.round(s * 10000) / 10000,
      ageDays,
      flag: ageFlag(ageDays),
      stale: ageDays > STALE_DAYS,
      snippet: snippetFor(vault, p, terms),
    };
  });
  return { hybrid: true, hits };
}

function writeWakeRecall(index, opts = {}) {
  const vault = opts.vault || index.vault;
  const wp = wakePath(vault);
  let session = '';
  try { session = fs.readFileSync(path.join(vault, 'brain/_index/SESSION.md'), 'utf8'); } catch { /* no session */ }
  const freq = {};
  for (const t of tokenize(session)) freq[t] = (freq[t] || 0) + 1;
  const topTerms = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
  const hits = topTerms.length
    ? queryRecall(index, topTerms.join(' '), { vault, limit: WAKE_MAX_SNIPPETS + 2 })
        .filter(h => !h.path.startsWith('brain/_index/'))
        .slice(0, WAKE_MAX_SNIPPETS)
    : [];
  if (!hits.length) {
    try { fs.unlinkSync(wp); } catch { /* already absent */ }
    return null;
  }
  const lines = [
    '<!-- generated by brain/scripts/sdk/lib/recall.js at SessionEnd — auto-recall, hard cap 3 snippets -->',
    '## Recall (auto)',
    ...hits.map(h => `- \`${h.path}\` (${h.flag}) — ${h.snippet.slice(0, 160)}`),
  ];
  fs.writeFileSync(wp, lines.join('\n') + '\n');
  return wp;
}

module.exports = {
  tokenize, extractWikiLinks, collectCorpus, isRetired, buildRecallIndex,
  saveIndex, loadIndex, queryRecall, queryRecallHybrid, loadEmbedIndex, writeWakeRecall,
  indexPath, wakePath, STALE_DAYS,
};
