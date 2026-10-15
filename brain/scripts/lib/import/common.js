'use strict';
/**
 * import/common.js — what the importer's phases share (install-import B7–B10, B15): the state file, content hashes,
 * the `~/…` form of a host path, the duplicate check and the one memory writer.
 *
 *   brain/_index/import-state.json  { schema: 1,
 *     phases: [{ phase, host, done, cursor, counts, at }]   one row per (phase, host); a re-run replaces its row
 *     hashes: { <hash>: { kind, host, path, at } }          every rule, memory and digest memory written or skipped as
 *                                                           a duplicate, so a re-run writes nothing twice
 *     files:  { "<host>:<origin>": { hash, mode, at } }     a global instruction file, whole or by rule (instructions.js)
 *     digest: { … } | null                                  the session queue the import-digest routine works through
 *     runs:   [{ at, from, only, since, dryRun: false }]    the last 20 real runs }
 *   Written under fsx's lock (the CLI and the digest routine both write it).
 *
 * Dedup (B8): a candidate is a duplicate of a live memory, or of one written earlier in the same run, when its text
 * hashes the same, its title is alike (brain-hub's title Jaccard ≥ 0.7), its words are (cosine of BM25-weighted term
 * vectors over the existing memories, with recall.js's tokenizer, ≥ 0.8; or title ≥ 0.4 and text ≥ 0.6), or, when an
 * embedder is at hand and the vault's embed index holds the memory, its meaning is (cosine ≥ 0.92).
 *
 * Nothing here calls a model except an injected `embed` (the local engine's). No vault is resolved at load; the one
 * writer (lib/memory-writer.js) writes to the vault paths.js resolved, which the CLI and the routine set to `vault`.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fsx = require('../fsx.js');

const SCHEMA = 1;
const HOSTS = ['claude', 'codex'];
const HOST_LABEL = { claude: 'Claude Code', codex: 'Codex' };
const TYPES = ['user', 'feedback', 'projects', 'reference'];
const MAX_RUNS = 20;
const MAX_TITLE = 60;
const MAX_DESC = 120;

function sha(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }
/** The content hash a re-run compares: words only, case folded, so a reflowed or repunctuated rule is the same rule. */
function contentHash(text) { return sha(String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).slice(0, 32); }

/** A host path as it is written into the vault: `~/…` under home, else as it is (B8: never an absolute home path). */
function tilde(abs, home = os.homedir()) {
  if (typeof abs !== 'string' || !abs) return abs;
  const rel = path.relative(home, abs);
  if (rel === '') return '~';
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : abs;
}

function realOrNull(p) { try { return fs.realpathSync(p); } catch { return null; } }
/** Whether `file` (by its real path) is the vault or inside it: the vault's own files are never imported. */
function insideVault(file, vault) {
  const f = realOrNull(file) || path.resolve(file);
  const v = realOrNull(vault) || path.resolve(vault);
  const rel = path.relative(v, f);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A regular file's text (never a link, a folder or anything over `max` bytes); null otherwise. */
function readRegular(file, max = 512 * 1024) {
  let st;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (!st.isFile() || st.size > max) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// ── state ──

function stateFile(vault) { return path.join(vault, 'brain', '_index', 'import-state.json'); }

function emptyState() { return { schema: SCHEMA, phases: [], hashes: {}, files: {}, digest: null, runs: [] }; }

function normalize(j) {
  const s = emptyState();
  if (!j || typeof j !== 'object' || Array.isArray(j)) return s;
  if (Array.isArray(j.phases)) s.phases = j.phases.filter((p) => p && typeof p === 'object');
  if (j.hashes && typeof j.hashes === 'object' && !Array.isArray(j.hashes)) s.hashes = j.hashes;
  if (j.files && typeof j.files === 'object' && !Array.isArray(j.files)) s.files = j.files;
  if (j.digest && typeof j.digest === 'object' && Array.isArray(j.digest.queue)) s.digest = j.digest;
  if (Array.isArray(j.runs)) s.runs = j.runs.slice(-MAX_RUNS);
  return s;
}

function readState(vault) { return normalize(readJson(stateFile(vault))); }

/** Read, change and write the state under fsx's lock; fn mutates the state (its return value is passed back). */
function updateState(vault, fn) {
  let out;
  fsx.updateSync(stateFile(vault), (text) => {
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    const s = normalize(j);
    out = fn(s);
    return JSON.stringify(s, null, 2) + '\n';
  }, { timeoutMs: 10000 });
  return out;
}

/** Replace the (phase, host) row. */
function recordPhase(state, phase, host, { done = true, cursor = null, counts = {}, at = new Date().toISOString() } = {}) {
  state.phases = state.phases.filter((p) => !(p.phase === phase && p.host === host));
  state.phases.push({ phase, host, done, cursor, counts, at });
}

// ── text helpers ──

/** Markdown down to words: links to their text, emphasis and code ticks out, one line. */
function plain(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (m, a, b) => b || a)
    .replace(/[*_`~]+/g, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** At most `n` characters, cut at a word when one is near. */
function cut(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const sp = head.lastIndexOf(' ');
  return (sp > n * 0.6 ? head.slice(0, sp) : head).replace(/[\s,;:.–—-]+$/, '');
}

/** A title MEMORY.md's line can carry: one line, no brackets (they would end the link text). */
function safeTitle(s) { return cut(plain(s).replace(/\[/g, '(').replace(/\]/g, ')'), MAX_TITLE) || 'Imported note'; }
/** A description MEMORY.md's line can carry: one line, never `](`. */
function safeDesc(s) { return cut(plain(s).replace(/\]\(/g, '] ('), MAX_DESC); }

// ── dedup ──

const STOP = new Set(('a an and are as at be but by for from had has have i in is it its of on or that the this to was were will with ' +
  'you your we our not no so if then than when what which who how all any can do does did done just also more very much been being over under after before').split(' '));
function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && t.length <= 30 && !STOP.has(t));
}
/** brain-hub's title Jaccard (stop words out), the hub's own duplicate signal. */
function jaccard(a, b) { return require('../../brain-hub.js').jaccard(a, b); }
function counts(text) {
  const tf = new Map();
  for (const t of tokens(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}
/** A memory file's body without its frontmatter and the `# Title` heading the writer puts first. */
function bodyOf(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '').replace(/^\s*#[ \t]+[^\n]*\n/, '');
}

const K1 = 1.2;
const B = 0.75;
const THRESH = { title: 0.7, text: 0.8, both: [0.4, 0.6], meaning: 0.92 };

/**
 * The duplicate check over the vault's live memories (module comment). `embed` (texts → vectors) is the local engine's
 * embedder, used only when the embed index holds vectors; any failure there leaves the text and title signals.
 */
class Deduper {
  constructor(vault, { embed = null } = {}) {
    this.vault = vault;
    this.embed = embed;
    this.docs = [];
    this.hashes = new Map();
    this.df = new Map();
    this.totalLen = 0;
    let ops = null;
    try { ops = require('../memory-ops.js'); } catch { ops = null; }
    const live = ops ? ops.listMemories(vault).filter((m) => m.live) : [];
    for (const m of live) {
      let text = '';
      try { text = ops.readMemory(vault, m.path).text; } catch { continue; }
      this.add({ title: m.title, body: bodyOf(text), path: m.path });
    }
    this.vectors = new Map();
    if (embed) {
      const idx = readJson(path.join(vault, 'brain', '_index', 'embed-index.json'));
      const sums = new Map();
      for (const c of (idx && Array.isArray(idx.chunks) ? idx.chunks : [])) {
        if (!c || typeof c.path !== 'string' || !Array.isArray(c.vec)) continue;
        const s = sums.get(c.path);
        if (!s) sums.set(c.path, c.vec.slice());
        else for (let i = 0; i < s.length && i < c.vec.length; i++) s[i] += c.vec[i];
      }
      for (const [p, s] of sums) this.vectors.set(p, unit(s));
    }
  }

  add({ title, body, path: p }) {
    const tf = counts(`${title} ${body}`);
    let len = 0;
    for (const [t, n] of tf) { len += n; this.df.set(t, (this.df.get(t) || 0) + 1); }
    this.totalLen += len;
    this.docs.push({ path: p, title, tf, len });
    this.hashes.set(contentHash(body), p);
  }

  /** BM25-weighted unit vector of a term-count map against the current collection. */
  weigh(tf, len) {
    const N = Math.max(1, this.docs.length);
    const avg = this.totalLen / N || 1;
    const v = new Map();
    let norm = 0;
    for (const [t, n] of tf) {
      const df = this.df.get(t) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const w = idf * (n * (K1 + 1)) / (n + K1 * (1 - B + B * (len / avg)));
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  }

  /** → { dup: false } or { dup: true, reason, path, score } */
  async check({ title, body }) {
    const h = contentHash(body);
    if (this.hashes.has(h)) return { dup: true, reason: 'same text', path: this.hashes.get(h), score: 1 };
    const tf = counts(`${title} ${body}`);
    let len = 0;
    for (const n of tf.values()) len += n;
    const mine = this.weigh(tf, len);
    let best = null;
    for (const d of this.docs) {
      const t = jaccard(title, d.title);
      const other = this.weigh(d.tf, d.len);
      let s = 0;
      for (const [k, w] of mine) { const x = other.get(k); if (x) s += w * x; }
      const hit = t >= THRESH.title ? 'similar title' : s >= THRESH.text ? 'similar text' : (t >= THRESH.both[0] && s >= THRESH.both[1]) ? 'similar title and text' : null;
      if (hit && (!best || Math.max(t, s) > best.score)) best = { dup: true, reason: hit, path: d.path, score: Math.round(Math.max(t, s) * 1000) / 1000 };
    }
    if (best) return best;
    if (this.embed && this.vectors.size) {
      try {
        const [vec] = await this.embed([`${title}\n\n${body}`.slice(0, 4000)]);
        if (Array.isArray(vec) && vec.length) {
          const u = unit(vec);
          for (const [p, v] of this.vectors) {
            const c = dot(u, v);
            if (c >= THRESH.meaning) return { dup: true, reason: 'similar meaning', path: p, score: Math.round(c * 1000) / 1000 };
          }
        }
      } catch { /* the text and title signals stand */ }
    }
    return { dup: false };
  }
}

function unit(v) { const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map((x) => x / n); }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s; }

// ── the one writer ──

/**
 * Write one imported memory: memory-writer.writeMemory with source `import:<host>`, `reviewed: false` and `origin`,
 * a free slug (`-2`, `-3`… when the title's is taken), and a `written` trail row. → its vault-relative path.
 */
function writeImported(vault, cand, { host, origin = null, session = 'import' }) {
  const { writeMemory, slugify } = require('../memory-writer.js');
  // memory-writer writes to the vault lib/paths.js resolved at load: never let that be another vault than this run's.
  const resolved = require('../paths.js').PATHS.VAULT;
  if ((realOrNull(resolved) || resolved) !== (realOrNull(vault) || path.resolve(vault))) {
    throw new Error(`the importer runs for ${vault} but this process writes memories to ${resolved}: set AOS_VAULT first`);
  }
  const type = TYPES.includes(cand.type) ? cand.type : 'reference';
  const title = safeTitle(cand.title);
  const description = safeDesc(cand.description || cand.body) || title;
  const base = slugify(title);
  let slug = base;
  for (let i = 2; fs.existsSync(path.join(vault, 'brain', 'memory', type, `${slug}.md`)); i++) {
    if (i > 99) throw new Error(`no free name for ${base}`);
    slug = `${base}-${i}`;
  }
  const body = String(cand.body || '').trim() || description;
  const r = writeMemory({ type, slug, title, description, body, source: `import:${host}`, session, origin });
  try {
    require('../promote-log.js').appendTrail({ session, action: 'written', slug: r.slug, type, title, source: `import:${host}` });
  } catch { /* the trail is history, not the memory */ }
  return r.memoryPath;
}

/** brain-hub.json again after an import wrote memories, so Review shows the batch before the next scan. Never throws. */
function rebuildHub(vault) {
  try {
    const cfg = require('../config.js').loadConfig();
    require('../../brain-hub.js').buildBrainHub({ vault, cfg });
    return true;
  } catch { return false; }
}

module.exports = {
  SCHEMA, HOSTS, HOST_LABEL, TYPES,
  sha, contentHash, tilde, insideVault, readRegular, readJson,
  stateFile, emptyState, readState, updateState, recordPhase,
  plain, cut, safeTitle, safeDesc, jaccard, Deduper, writeImported, rebuildHub,
};
