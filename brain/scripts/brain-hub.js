'use strict';
/**
 * brain-hub.js — the Brain hub's cache, brain/_index/brain-hub.json (brain-hub D11, D12). scan-vault builds it after the
 * recall, embed and graph passes, whose indexes it reads; the HUD reads it beside the memory files and computes none of
 * it. No model call: everything here is counting and comparing.
 *
 *   counts    memories by type and state, drafts, patterns, reflections
 *   batches   unreviewed live memories by the session that wrote them, titled from session-index.json (D3)
 *   dups      pairs that look like one memory twice: title Jaccard, tf-idf cosine over the recall index, embedding cosine
 *             when the embed index has both (D11); "Not duplicates" (memory-notdup.json) is respected
 *   clusters  groups of three or more linked by near-duplicate pairs (one memory per release step, say)
 *   usage     per path, from memory-usage.jsonl and its rollup (D8)
 *   hygiene   source labels, the old `type:` shape, descriptions only MEMORY.md has, index lines missing, misfiled or
 *             broken, approved drafts left behind (lib/memory-hygiene.js, which `aos memory fix` acts on too)
 *   shipped   active projects that name a full version, "shipped", "released" or "superseded": "looks shipped" (D17)
 *
 * The Map's brain-map.json is written beside it from the same memories (D19; lib/brain-map.js). Takes the vault;
 * `write: false` builds both without writing (a dry run on a real vault). A writing build also prunes the merge records
 * older than 30 days (brain-ai A2; lib/memory-merge.js pruneRecords), swallowing any failure.
 */
const fs = require('fs');
const path = require('path');
const ops = require('./lib/memory-ops.js');
const { readIndexLines, linkedPaths, findHygiene } = require('./lib/memory-hygiene.js');
const usage = require('./lib/memory-usage.js');
const fsx = require('./lib/fsx.js');
const brainMap = require('./lib/brain-map.js');
const { hostDirs } = require('./lib/host.js');
const { readSessionIndex } = require('./lib/transcript.js');

const DEFAULTS = { usageDays: 90, neverUsedDays: 30, dupScore: 0.8, clusterMin: 3, mapMin: 8 };
// Clusters link pairs this far under dupScore; a group larger than MAX_CLUSTER splits on stronger pairs.
const CLUSTER_GAP = 0.1;
const MAX_CLUSTER = 12;
const MAX_DUPS = 200;
const STOP = new Set(('a an and are as at be but by for from has have i in is it its of on or that the this to was were will with ' +
  'you your we our not no so if then than when what which who how all any can do does did also more after before into via').split(' '));
// "Looks shipped" (D17): a full x.y.z version, "shipped", "released" (not "release") or "superseded"; never "merged",
// which every project in flight says of its PRs. A version stands alone: no digit or dot before it, no `.digit` after
// it, so an address (127.0.0.1) is not one, while "Tagged v1.2.0." at a sentence's end is. brainBootstrap.ts's SHIPPED
// is its twin.
const SHIPPED = /(?<![\d.])\bv?\d+\.\d+\.\d+\b(?!\.\d)|\bshipped\b|\breleased\b|\bsuperseded\b/i;

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function mdCount(dir) { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').length; } catch { return 0; } }

function words(s) { return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)); }
/** noise-gate.js's jaccard over title words (stop words left out, so "the" never makes two titles alike). */
function jaccard(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** tf-idf vectors from the recall index's per-document term counts, unit length: Map path → Map term → weight. */
function textVectors(recallIdx, paths) {
  const out = new Map();
  if (!recallIdx || !Array.isArray(recallIdx.docs)) return out;
  const N = recallIdx.docCount || recallIdx.docs.length || 1;
  const df = recallIdx.df || {};
  const want = new Set(paths);
  for (const d of recallIdx.docs) {
    if (!want.has(d.path) || !d.tf) continue;
    const v = new Map();
    let norm = 0;
    for (const [t, n] of Object.entries(d.tf)) {
      const w = (1 + Math.log(n)) * Math.log(1 + N / (df[t] || 1));
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    out.set(d.path, v);
  }
  return out;
}
function sparseDot(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [t, w] of a) { const x = b.get(t); if (x) s += w * x; }
  return s;
}

/** One unit vector per path: the mean of its chunks in the embed index (Ollama's), or none. */
function meaningVectors(embedIdx, paths) {
  const out = new Map();
  if (!embedIdx || !Array.isArray(embedIdx.chunks)) return out;
  const want = new Set(paths);
  const sum = new Map();
  for (const c of embedIdx.chunks) {
    if (!want.has(c.path) || !Array.isArray(c.vec)) continue;
    const s = sum.get(c.path);
    if (!s) { sum.set(c.path, c.vec.slice()); continue; }
    for (let i = 0; i < s.length && i < c.vec.length; i++) s[i] += c.vec[i];
  }
  for (const [p, s] of sum) {
    const n = Math.sqrt(s.reduce((a, x) => a + x * x, 0)) || 1;
    out.set(p, s.map((x) => x / n));
  }
  return out;
}
function dense(a, b) { let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s; }

function pairKey(a, b) { return a < b ? `${a}\n${b}` : `${b}\n${a}`; }
function round(x) { return Math.round(x * 1000) / 1000; }

/** The value at fraction q of the sorted numbers (nearest rank); 0 for none. */
function quantile(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : 0; }
function sortedOf(xs) { return Float64Array.from(xs).sort(); }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/**
 * Each signal against this vault's own pairs (D11): its median scores 0 and its 99.9th percentile 1, never closer than
 * SPAN apart, so an embedding model's high floor of similarity (two unrelated notes on one vault can sit near 0.4) and a
 * small vault's best pair are not mistaken for duplicates. Calibrated on a real vault of 334 memories, where every pair
 * a person called a duplicate sat above the 99th percentile of meaning and of text.
 */
const SPAN = { meaning: 0.4, text: 0.3 };
const WEIGHTS = { withMeaning: { meaning: 0.5, text: 0.3, title: 0.2 }, textOnly: { text: 0.65, title: 0.35 } };
function scaler(values, span) {
  const s = sortedOf(values);
  const lo = quantile(s, 0.5);
  const hi = Math.max(quantile(s, 0.999), lo + span);
  return (x) => clamp01((x - lo) / (hi - lo));
}

/**
 * Likely duplicates among live memories (D11). → { pairs: [{ a, b, score, title, text, meaning }] ≥ dupScore, best
 * first (at most MAX_DUPS), near: every pair ≥ the cluster edge }. `meaning` is null without an embed index entry.
 */
function findDuplicates(live, { recallIdx, embedIdx, notdup, dupScore }) {
  const paths = live.map((m) => m.path);
  const tv = textVectors(recallIdx, paths);
  const mv = meaningVectors(embedIdx, paths);
  const raw = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      const ta = tv.get(a.path);
      const tb = tv.get(b.path);
      const ma = mv.get(a.path);
      const mb = mv.get(b.path);
      raw.push({ a: a.path, b: b.path, title: jaccard(a.title, b.title), text: ta && tb ? sparseDot(ta, tb) : 0, meaning: ma && mb ? dense(ma, mb) : null });
    }
  }
  const textN = scaler(raw.map((r) => r.text), SPAN.text);
  const meaningN = scaler(raw.filter((r) => r.meaning !== null).map((r) => r.meaning), SPAN.meaning);
  const edge = Math.max(0.5, dupScore - CLUSTER_GAP);
  const out = [];
  for (const r of raw) {
    if (notdup.has(pairKey(r.a, r.b))) continue;
    const w = r.meaning === null ? WEIGHTS.textOnly : WEIGHTS.withMeaning;
    const score = (w.meaning ? w.meaning * meaningN(r.meaning) : 0) + w.text * textN(r.text) + w.title * r.title;
    if (score >= edge) out.push({ a: r.a, b: r.b, score: round(score), title: round(r.title), text: round(r.text), meaning: r.meaning === null ? null : round(r.meaning) });
  }
  out.sort((x, y) => y.score - x.score || (x.a < y.a ? -1 : 1));
  return { pairs: out.filter((p) => p.score >= dupScore).slice(0, MAX_DUPS), near: out };
}

function components(pairs) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const p of pairs) {
    for (const x of [p.a, p.b]) if (!parent.has(x)) parent.set(x, x);
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map();
  for (const x of parent.keys()) { const r = find(x); (groups.get(r) || groups.set(r, []).get(r)).push(x); }
  return [...groups.values()];
}

/**
 * Groups of ≥ clusterMin linked by near pairs, labelled by the words most of their titles share. A group past
 * MAX_CLUSTER is a topic, not a cluster to merge: it splits again on stronger pairs until each part fits or dissolves.
 */
function findClusters(near, byPath, clusterMin) {
  const out = [];
  const visit = (pairs, edge) => {
    for (const g of components(pairs)) {
      if (g.length < clusterMin) continue;
      if (g.length > MAX_CLUSTER) {
        const inside = new Set(g);
        const next = edge + 0.05;
        if (next <= 1) visit(pairs.filter((p) => p.score >= next && inside.has(p.a) && inside.has(p.b)), next);
        continue;
      }
      g.sort();
      const freq = new Map();
      for (const p of g) for (const w of new Set(words(byPath.get(p).title))) freq.set(w, (freq.get(w) || 0) + 1);
      const shared = [...freq.entries()].filter(([, n]) => n >= Math.ceil(g.length / 2)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([w]) => w);
      out.push({ paths: g, label: shared.length ? shared.join(' ') : byPath.get(g[0]).title });
    }
  };
  visit(near, near.length ? Math.min(...near.map((p) => p.score)) : 0);
  return out.sort((a, b) => b.paths.length - a.paths.length || (a.paths[0] < b.paths[0] ? -1 : 1));
}

/**
 * session id → { title, host } from session-index.json (written by the runtime from both hosts' sessions), titled the way
 * collectors/hostSessions.js titles a session for Spaces and Sessions: its own title, else Codex's thread name
 * (session_index.jsonl in the Codex home lib/host.js resolves; a rollout carries no title), else its first prompt.
 */
function sessionTitles(vault, { cfg, env = process.env } = {}) {
  const idx = readJson(path.join(vault, 'brain', '_index', 'session-index.json'));
  const out = new Map();
  if (!idx || !idx.files) return out;
  let codexNames = null;
  const codexName = (id) => {
    if (codexNames === null) {
      try { codexNames = readSessionIndex(hostDirs('codex', { env, userConfig: cfg }).index); } catch { codexNames = {}; }
    }
    return codexNames[id] ? codexNames[id].title : null;
  };
  for (const row of Object.values(idx.files)) {
    const head = (row && row.head) || {};
    const id = head.id;
    if (!id || out.has(id)) continue;
    const prompt = typeof head.firstPrompt === 'string' ? head.firstPrompt.replace(/\s+/g, ' ').trim() : '';
    const title = row.title || head.title || (row.host === 'codex' ? codexName(id) : null) || prompt || null;
    out.set(id, { title, host: row.host || null });
  }
  return out;
}

/** slug/type → { ts, session } of the trail's `written` row (when auto-wrap wrote it). */
function writtenAt(vault) {
  const out = new Map();
  const raw = readText(path.join(vault, 'brain', '_index', 'promote-log.jsonl'));
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.action === 'written' && r.slug && r.type) out.set(`${r.type}/${r.slug}`, { ts: r.ts, session: r.session || null });
    } catch { /* torn line */ }
  }
  return out;
}

// What the history import writes (install-import B5): one Review batch per host, whatever session or day each came from.
const IMPORT_SOURCE = /^import:(claude|codex)$/;
const IMPORT_TITLE = { claude: 'Imported from Claude Code', codex: 'Imported from Codex' };

/** Unreviewed live memories grouped by the session that wrote them, newest first (D3); imported ones by host (B5). */
function buildBatches(live, vault, cfg) {
  const titles = sessionTitles(vault, { cfg });
  const lead = new Map(live.map((m) => [m.path, m.title]));
  const trail = writtenAt(vault);
  const groups = new Map();
  for (const m of live) {
    if (m.reviewed !== 'false') continue;
    const w = trail.get(`${m.type}/${m.slug}`);
    const at = (w && w.ts) || m.created || '';
    const imported = IMPORT_SOURCE.exec(m.source || '');
    if (imported) {
      const key = m.source;
      const g = groups.get(key) || { key, session: null, host: imported[1], title: IMPORT_TITLE[imported[1]], at: '', paths: [], when: [], imported: true };
      g.paths.push(m.path);
      g.when.push(at);
      if (at > g.at) g.at = at;
      groups.set(key, g);
      continue;
    }
    const session = m.session || (w && w.session) || null;
    const real = session && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(session);
    const key = real ? session : `${session || 'none'}:${String(at).slice(0, 10)}`;
    const g = groups.get(key) || { key, session: real ? session : null, host: null, title: null, at: '', paths: [], when: [] };
    g.paths.push(m.path);
    g.when.push(at);
    if (at > g.at) g.at = at;
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    const info = g.session ? titles.get(g.session) : null;
    if (!g.imported) g.host = info ? info.host : null;
    const day = String(g.at).slice(0, 10) || 'undated';
    g.title = g.imported ? g.title : (info && info.title) || (g.session ? `Session ${g.session.slice(0, 8)} · ${day}` : g.key.startsWith('in-session') ? `In-session wrap · ${day}` : `Wrap · ${day}`);
    const order = g.paths.map((p, i) => [p, g.when[i]]).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
    // `lead`: the first memory's title, so sessions that share one custom name still read apart in Review.
    out.push({ key: g.key, session: g.session, host: g.host, title: g.title, lead: lead.get(order[0][0]) || null, at: g.at, paths: order.map(([p]) => p) });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** brain-hub.json's doc and, through `buildMap` (lib/brain-map.js; injectable), brain-map.json's; `write` writes both. */
function buildBrainHub({ vault, cfg = {}, now = Date.now(), write = true, buildMap = brainMap.buildBrainMap } = {}) {
  const c = { ...DEFAULTS, ...(cfg.memory || {}) };
  const idx = path.join(vault, 'brain', '_index');
  const memories = ops.listMemories(vault);
  const live = memories.filter((m) => m.live);
  const byPath = new Map(memories.map((m) => [m.path, m]));
  const indexRaw = readText(path.join(vault, 'MEMORY.md'));
  const indexLines = readIndexLines(indexRaw);
  const drafts = ops.listDrafts(vault);

  const byType = {};
  for (const t of ops.TYPES) byType[t] = live.filter((m) => m.type === t).length;
  const counts = {
    memories: live.length, byType,
    unreviewed: live.filter((m) => m.reviewed === 'false').length,
    drafts: drafts.length,
    patterns: mdCount(path.join(vault, 'brain', 'patterns')),
    reflections: mdCount(path.join(vault, 'brain', 'reflections')),
    archived: memories.filter((m) => m.status === 'archived').length,
    superseded: memories.filter((m) => m.status === 'superseded').length,
  };

  const notdupDoc = readJson(path.join(idx, 'memory-notdup.json'));
  const notdup = new Set(((notdupDoc && notdupDoc.pairs) || []).filter((p) => Array.isArray(p) && p.length === 2).map(([a, b]) => pairKey(a, b)));
  const { pairs, near } = findDuplicates(live, {
    recallIdx: readJson(path.join(idx, 'recall-index.json')), embedIdx: readJson(path.join(idx, 'embed-index.json')),
    notdup, dupScore: c.dupScore,
  });
  const clusters = findClusters(near, byPath, c.clusterMin);

  // Computed by lib/memory-hygiene.js, as `aos memory fix` finds them, so the hub and the fix agree (brain-hub D20): a
  // bullet that links a memory some other way is its line, and a line to a link or a file too big to read is not broken.
  const exists = (rel) => { try { fs.lstatSync(path.join(vault, rel)); return true; } catch { return false; } };
  const hygiene = findHygiene({ live, byPath, indexLines, drafts, linked: linkedPaths(indexRaw), exists });

  const shipped = [];
  for (const m of live) {
    if (m.type !== 'projects' || m.status !== 'active') continue;
    const desc = m.description || ((indexLines.get(m.path) || [])[0] || {}).description || '';
    const hit = SHIPPED.exec(m.title) || SHIPPED.exec(desc);
    if (hit) shipped.push({ path: m.path, why: hit[0] });
  }

  const hub = {
    schema: 1, builtAt: new Date(now).toISOString(), counts,
    batches: buildBatches(live, vault, cfg),
    dups: pairs, clusters,
    usage: usage.summarize(vault, { now }),
    hygiene, shipped,
  };
  // The Map (D19): graphify's communities of these same memories, written beside the hub. A map that fails to build is
  // written as "missing" and never costs the hub. It rides on the returned hub unenumerated (`hub.map`, for the scan's
  // report), so brain-hub.json and --json stay the hub alone.
  let map;
  try {
    map = buildMap({ vault, cfg: { ...cfg, memory: c }, memories, now });
  } catch (e) {
    console.error('[brain-hub] map:', e.message);
    map = brainMap.emptyMap('missing', { now, mapMin: brainMap.mapMinOf({ memory: c }) });
  }
  Object.defineProperty(hub, 'map', { value: map });
  if (write) {
    fsx.writeAtomic(path.join(idx, 'brain-hub.json'), JSON.stringify(hub) + '\n');
    try { fsx.writeAtomic(path.join(idx, 'brain-map.json'), JSON.stringify(map) + '\n'); } catch (e) { console.error('[brain-hub] brain-map.json:', e.message); }
    // Merge records past their 30 days of Undo merge go (brain-ai A2); a failure never costs the hub.
    try {
      const merges = require('./lib/memory-merge.js');
      merges.pruneRecords(vault, { days: merges.UNDO_DAYS, now });
    } catch (e) { console.error('[brain-hub] merge records:', e.message); }
  }
  return hub;
}

if (require.main === module) {
  const { PATHS } = require('./lib/paths.js');
  const { loadConfig } = require('./lib/config.js');
  try {
    const hub = buildBrainHub({ vault: PATHS.VAULT, cfg: loadConfig(), write: !process.argv.includes('--dry-run') });
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(hub, null, 2) + '\n');
  } catch (e) {
    console.error('[brain-hub]', e.message);
    process.exit(1);
  }
}

module.exports = { buildBrainHub, findDuplicates, findClusters, jaccard, sessionTitles, DEFAULTS, SHIPPED };
