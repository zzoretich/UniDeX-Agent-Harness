'use strict';
/**
 * embed-vault.js — incremental vault embedder for hybrid recall.
 *
 * Corpus: identical to recall.js (brain/memory, brain/patterns, persona/journal,
 * daily notes). Whole-note embedding for bodies <= 24000 chars; larger bodies
 * split at top-level `## ` headings. Cache key = sha1(raw file); unchanged
 * files are skipped, so steady-state SessionEnd runs embed only the day's
 * edits. Budget caps files embedded per run (default 40 — same convention as
 * fileMap.js); overflow is left pending for the next run.
 *
 * Output: brain/_index/embed-index.json
 *   { version, builtAt, model, dims, files: { relPath: sha1 }, chunks: [{ path, part, vec }] }
 * Vectors are unit-normalized (embed.js) and rounded to 4 decimals.
 *
 * CLI: node brain/scripts/embed-vault.js [--budget=N] [--full]  (--full drops the cache first)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { VAULT } = require('./lib/paths.js');
const { parseFrontmatter } = require('./sdk/lib/brain.js');
const { collectCorpus, isRetired } = require('./sdk/lib/recall.js');
const { role } = require('./sdk/lib/models.js');

const MAX_CHARS = 24000;
const ROUND = 1e4;

function indexPath(vault) { return path.join(vault, 'brain/_index/embed-index.json'); }

function loadIndex(vault) {
  try { return JSON.parse(fs.readFileSync(indexPath(vault), 'utf8')); } catch { return null; }
}

function chunkBody(body) {
  const s = String(body || '').trim();
  if (!s) return [];
  if (s.length <= MAX_CHARS) return [s];
  const parts = [];
  let buf = '';
  for (const piece of s.split(/\n(?=## )/)) {
    if (buf && (buf.length + piece.length + 1) > MAX_CHARS) { parts.push(buf); buf = piece; }
    else { buf = buf ? buf + '\n' + piece : piece; }
    while (buf.length > MAX_CHARS) { parts.push(buf.slice(0, MAX_CHARS)); buf = buf.slice(MAX_CHARS); }
  }
  if (buf) parts.push(buf);
  return parts;
}

async function refreshEmbedIndex(opts = {}) {
  const vault = opts.vault || VAULT;
  const budget = opts.budget == null ? 40 : opts.budget;
  let embedFn = opts.embedFn;
  if (!embedFn) {
    const p = opts.provider || await require('./sdk/lib/provider.js').getProvider('embed');
    if (!p.capabilities.embed) {
      return { embedded: 0, skipped: 0, pending: 0, failed: 0, disabled: true, reason: 'no-embed', provider: p.name };
    }
    embedFn = (texts) => p.embed(texts, { feature: 'embed' });
  }
  let prev = opts.full ? null : loadIndex(vault);
  if (prev && prev.model && prev.model !== role('embedder').tag) prev = null; // embedder changed — vectors are incompatible, full rebuild
  const files = prev && prev.files ? { ...prev.files } : {};
  const keepChunks = [];
  const dirty = [];
  const seen = new Set();

  for (const abs of collectCorpus(vault)) {
    const rel = path.relative(vault, abs).replace(/\\/g, '/');
    let raw;
    try { raw = fs.readFileSync(abs, 'utf8'); } catch { seen.add(rel); continue; }
    // An archived or superseded note goes as a deleted one does: unseen, so its entry and chunks drop (brain-hub D5).
    if (isRetired(parseFrontmatter(raw).frontmatter)) continue;
    seen.add(rel);
    const hash = crypto.createHash('sha1').update(raw).digest('hex');
    if (files[rel] === hash && prev) {
      for (const c of prev.chunks) if (c.path === rel) keepChunks.push(c);
      continue;
    }
    dirty.push({ rel, hash, raw });
  }
  // drop entries for deleted files
  for (const rel of Object.keys(files)) if (!seen.has(rel)) delete files[rel];

  const toEmbed = dirty.slice(0, budget);
  const successfullyEmbedded = new Set();
  let embedded = 0;
  let failed = 0;
  let dims = prev ? prev.dims : null;
  let model = role('embedder').tag;
  for (const f of toEmbed) {
    try {
      const { body } = parseFrontmatter(f.raw);
      const parts = chunkBody(path.basename(f.rel, '.md') + '\n' + body);
      if (!parts.length) { files[f.rel] = f.hash; successfullyEmbedded.add(f.rel); continue; }
      const vecs = await embedFn(parts);
      parts.forEach((_, i) => keepChunks.push({
        path: f.rel, part: i,
        vec: vecs[i].map((x) => Math.round(x * ROUND) / ROUND),
      }));
      files[f.rel] = f.hash;
      dims = vecs[0] ? vecs[0].length : dims;
      embedded++;
      successfullyEmbedded.add(f.rel);
    } catch (e) {
      console.error('[embed-vault] embed failed for ' + f.rel + ': ' + e.message);
      failed++;
    }
  }

  // Carry forward chunks for pending/failed dirty files (preserve recall coverage)
  for (const f of dirty) {
    if (!successfullyEmbedded.has(f.rel) && prev) {
      // This file was not successfully embedded (either pending or failed)
      // Carry its previous chunks if any exist
      for (const c of prev.chunks) {
        if (c.path === f.rel) keepChunks.push(c);
      }
      // Clear hash so file remains dirty and will retry
      delete files[f.rel];
    }
  }

  const index = {
    version: 1, builtAt: new Date().toISOString(), model, dims,
    files, chunks: keepChunks,
  };
  const p = indexPath(vault);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  require('./lib/fsx.js').writeAtomic(p, JSON.stringify(index));

  return { embedded, skipped: seen.size - dirty.length, pending: dirty.length - toEmbed.length, failed };
}

module.exports = { refreshEmbedIndex, loadIndex, chunkBody, indexPath };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const budgetArg = argv.find((a) => a.startsWith('--budget='));
  refreshEmbedIndex({
    budget: budgetArg ? Number(budgetArg.split('=')[1]) : 40,
    full: argv.includes('--full'),
  }).then((r) => {
    if (r.disabled) console.log(`[embed-vault] disabled (${r.reason}; provider ${r.provider})`);
    else console.log(`[embed-vault] embedded=${r.embedded} skipped=${r.skipped} pending=${r.pending} failed=${r.failed}`);
  }).catch((e) => { console.error('[embed-vault] failed:', e.message); process.exit(1); });
}
