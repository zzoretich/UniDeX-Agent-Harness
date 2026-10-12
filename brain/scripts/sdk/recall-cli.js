#!/usr/bin/env node
'use strict';
/**
 * recall-cli.js — command-line recall over the vault.
 *
 *   node sdk/recall-cli.js --warm                      # (re)build brain/_index/recall-index.json + recall-wake.md
 *   node sdk/recall-cli.js <query…> [--limit N] [--json]   # ranked hits (self-heals a missing index)
 *
 * Reached as `aos recall …` and by the Brain hub's recall preview (brain-hub D18). Zero model calls unless an embed
 * index exists: then the local Ollama embeds the query, asked directly (ollamaEmbedder), so a query never resolves the
 * provider (no provider-state.json write, no headless login probe). Only Ollama has embeddings, so the ranking is what
 * the provider chain would give: BM25 when the provider is claude, codex or none, or when Ollama does not answer
 * (queryRecallHybrid falls back on its own).
 * Exit: 0 ok · 2 usage.
 */
const { PATHS } = require('../lib/paths.js');
const recall = require('./lib/recall.js');

/** The query's embedder: Ollama's /api/embed at the configured address, or a refusal (→ BM25) for any provider mode but
 *  auto and ollama. Never sdk/lib/provider.js. */
function ollamaEmbedder(cfg) {
  const mode = (cfg && cfg.provider) || 'auto';
  return async (texts, o = {}) => {
    if (mode !== 'auto' && mode !== 'ollama') throw new Error(`the ${mode} provider has no embeddings`);
    const embedMod = require('./lib/embed.js');
    return embedMod.embed(texts, { ...((cfg && cfg.ollama) || {}), ...o, postFn: embedMod.postEmbed });
  };
}

function readConfig() {
  try { return require('../lib/config.js').loadConfig(); } catch { return {}; }
}

function parse(argv) {
  const o = { warm: false, json: false, limit: 5, terms: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--warm') o.warm = true;
    else if (a === '--json') o.json = true;
    else if (a === '--limit') o.limit = Number(argv[++i]) || 5;
    else o.terms.push(a);
  }
  return o;
}

function warm(vault) {
  const index = recall.buildRecallIndex({ vault });
  const p = recall.saveIndex(index, vault);
  recall.writeWakeRecall(index, { vault });
  return { index, p };
}

async function main(argv) {
  const o = parse(argv);
  const vault = PATHS.VAULT;
  if (o.warm) {
    const { index, p } = warm(vault);
    process.stdout.write(`recall: indexed ${index.docCount} docs → ${p}\n`);
    return 0;
  }
  if (!o.terms.length) {
    process.stderr.write('usage: recall-cli.js --warm | <query…> [--limit N] [--json]\n');
    return 2;
  }
  let index = recall.loadIndex(vault);
  if (!index) index = warm(vault).index;
  const embedFn = ollamaEmbedder(readConfig());
  const { hybrid, hits } = await recall.queryRecallHybrid(index, o.terms.join(' '), { vault, limit: o.limit, embedFn });
  if (o.json) { process.stdout.write(JSON.stringify(hits, null, 2) + '\n'); return 0; }
  if (!hits.length) { process.stdout.write(`no recall hits for "${o.terms.join(' ')}"\n`); return 0; }
  process.stdout.write(`${hybrid ? 'hybrid' : 'bm25'} recall for "${o.terms.join(' ')}"\n`);
  for (const h of hits) process.stdout.write(`- ${h.path} (${h.flag}, ${h.score}) — ${h.snippet.slice(0, 140)}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`recall: ${e.message}\n`); process.exit(1); });
}
module.exports = { main, parse, ollamaEmbedder };
