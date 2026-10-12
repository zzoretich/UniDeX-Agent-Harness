'use strict';
/**
 * memory-ops.js — the Brain hub's operations on memory files (brain-hub D5–D7, D13): list, keep, set, archive, restore
 * and supersede, each keeping MEMORY.md's line in step and logging the trail. Every function takes the vault, so `aos
 * memory` (which resolves its own) and the runtime share them; nothing is resolved at load, like memory-index.js.
 *
 * Safety (spec §6): a memory is `brain/memory/<type>/<slug>.md` for one of the four types (PATH_RE; a folder's
 * README.md never matches); every folder on the way is a plain folder whose real path is the vault's own; the file is a
 * regular file opened O_NOFOLLOW; it is rewritten through fsx.writeAtomic (a link that appears there is replaced, never
 * written through) and MEMORY.md through fsx.updateSync, refused when it is a link. A frontmatter edit touches only its
 * own keys and the status/ entry of `tags:`, keeping every other byte; `updated:` is not bumped (BRAIN.md orders Active
 * context by it, and a status change is not new content). `set`'s title (brain-ai A10) rewrites the body's first H1 line
 * and nothing else in the body; the slug never changes. Nothing is deleted (D6).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx.js');
const { deriveDescription, removeIndexLine, upsertIndexLine } = require('./memory-index.js');

const TYPES = ['user', 'feedback', 'projects', 'reference'];
const PATH_RE = /^brain\/memory\/(user|feedback|projects|reference)\/([a-z0-9][a-z0-9.-]{0,120})\.md$/;
const SLUG_RE = /^[a-z0-9][a-z0-9.-]{0,120}$/;
const HASH_RE = /^(?:none|[0-9a-f]{16,64})$/;
// MEMORY.md's heading per type, as memory-writer.js writes it: "## Project" prefix-matches a "## Projects" heading.
const TYPE_HEADING = { user: 'User', feedback: 'Feedback', projects: 'Project', reference: 'Reference' };
// The statuses `set` offers; the hub sets the two GONE ones itself, and recall, the MOCs and BRAIN.md skip them (D5, D7).
const STATUSES = ['active', 'complete', 'paused'];
const GONE = ['archived', 'superseded'];
const MAX_FILE = 1024 * 1024;
const MAX_DESC = 200;
// A title is one line of 1\u2013120 characters (brain-ai A8, A10): the H1 and the MEMORY.md line carry it.
const MAX_TITLE = 120;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

class OpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function today() { return new Date().toISOString().slice(0, 10); }

/** { rel, type, slug } for a memory path, or OpsError BAD_PATH. */
function checkPath(rel) {
  const m = PATH_RE.exec(String(rel == null ? '' : rel));
  if (!m) throw new OpsError('BAD_PATH', `not a memory path: ${rel} (brain/memory/<user|feedback|projects|reference>/<slug>.md)`);
  return { rel: m[0], type: m[1], slug: m[2] };
}

/**
 * A vault folder by its relative path (cli/workspace.js runtimeDir): every part a plain folder, never a link or a file,
 * and its real path the vault's own. → the real path, or null when a part is missing; OpsError UNSAFE otherwise.
 */
function plainDir(vault, rel) {
  const realVault = fs.realpathSync(vault);
  const segs = rel.split('/');
  let cur = vault;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    const st = lstatOrNull(cur);
    if (!st) return null;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new OpsError('UNSAFE', `${segs.slice(0, i + 1).join('/')} is not a plain folder (a link or a file): refusing to touch it`);
    }
  }
  const real = fs.realpathSync(cur);
  if (real !== path.join(realVault, ...segs)) throw new OpsError('UNSAFE', `${rel} resolves outside the vault`);
  return real;
}

/** A regular file's text, opened O_NOFOLLOW; null when missing; OpsError UNSAFE for a link or a folder. */
function readRegular(abs, label) {
  const st = lstatOrNull(abs);
  if (!st) return null;
  if (!st.isFile()) throw new OpsError('UNSAFE', `${label} is not a regular file (a link or a folder): refusing to touch it`);
  if (st.size > MAX_FILE) throw new OpsError('TOO_BIG', `${label} is over ${MAX_FILE} bytes`);
  let fd = null;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!fs.fstatSync(fd).isFile()) throw new OpsError('UNSAFE', `${label} is not a regular file: refusing to touch it`);
    return fs.readFileSync(fd, 'utf8');
  } catch (e) {
    if (e instanceof OpsError) throw e;
    throw new OpsError('UNSAFE', `${label} could not be read safely (${e.code || e.message})`);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** One memory as it is now: { rel, type, slug, abs, text, hash }. */
function readMemory(vault, rel) {
  const p = checkPath(rel);
  const dir = plainDir(vault, `brain/memory/${p.type}`);
  const abs = dir && path.join(dir, `${p.slug}.md`);
  const text = abs ? readRegular(abs, p.rel) : null;
  if (text === null) throw new OpsError('NOT_FOUND', `no such memory: ${p.rel}`);
  return { ...p, abs, text, hash: sha256(text) };
}

// ── frontmatter, byte for byte ──

/** The frontmatter split for editing: { head, lines (each with its own line end), tail (from the closing ---) }. */
function splitFm(text) {
  const open = text.startsWith('---\r\n') ? 5 : text.startsWith('---\n') ? 4 : 0;
  if (!open) return null;
  const m = /(^|\n)---[ \t]*(?:\r?\n|$)/.exec(text.slice(open));
  if (!m) return null;
  const close = open + m.index + m[1].length;
  const block = text.slice(open, close);
  return { head: text.slice(0, open), lines: block ? block.split(/(?<=\n)/) : [], tail: text.slice(close), eol: open === 5 ? '\r\n' : '\n' };
}
function joinFm(fm) { return fm.head + fm.lines.join('') + fm.tail; }

function keyRe(key) { return new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*\\r?\\n?$`); }
/** A scalar's text: surrounding quotes stripped, and a single-quoted one's `''` read back as `'` (YAML's own escape). */
function unquote(v) {
  const q = /^(["'])(.*)\1$/.exec(v);
  if (!q) return v;
  return q[1] === "'" ? q[2].replace(/''/g, "'") : q[2];
}

// What YAML would not read back as the same plain string: a leading indicator or space, `: ` or ` #` inside, a trailing
// colon or space, a boolean or null word, a bare number.
const YAML_PLAIN_UNSAFE = /^[-?:,[\]{}#&*!|>'"%@`\s]|\s$|:$|: | #|^(?:true|false|yes|no|on|off|null|~)$|^[-+]?[\d.]+$/i;

/**
 * A one-line value as a frontmatter scalar that every reader here gets back unchanged (getKey, the HUD's brainModel
 * fmKey and sdk/lib/brain.js strip the surrounding quotes and read a single-quoted `''` as `'`, nothing more) and that
 * strict YAML (Obsidian's Properties) parses as the same string: plain when it can be, else double-quoted when it holds
 * no `"` or `\`, else single-quoted with each `'` doubled. A description like "Rule: ask first" needs the quotes.
 */
function yamlValue(v) {
  const s = String(v);
  if (!YAML_PLAIN_UNSAFE.test(s)) return s;
  if (!/["\\]/.test(s)) return `"${s}"`;
  return `'${s.replace(/'/g, "''")}'`;
}

/** A top-level key's value (quotes stripped), or null. */
function getKey(lines, key) {
  const re = keyRe(key);
  for (const l of lines) { const m = re.exec(l); if (m) return unquote(m[1]); }
  return null;
}

/** Set a key (its first line rewritten, later ones dropped), append it when missing, or remove it when value is null. */
function setKey(fm, key, value) {
  const re = keyRe(key);
  let done = false;
  const out = [];
  for (const l of fm.lines) {
    if (!re.test(l)) { out.push(l); continue; }
    if (value === null || done) continue;
    out.push(`${key}: ${value}${/\r?\n$/.exec(l)?.[0] || fm.eol}`);
    done = true;
  }
  if (value !== null && !done) out.push(`${key}: ${value}${fm.eol}`);
  fm.lines = out;
}

const TAGS_INLINE = /^tags:[ \t]*\[(.*)\][ \t]*(\r?\n)?$/;
const STATUS_TAG = /^status\/([A-Za-z0-9_-]+)$/;
// A block list's item: a dash at any indent, zero included (YAML allows `tags:\n- a`), then a space or the line's end.
const BLOCK_ITEM = /^[ \t]*-(?:[ \t]|\r?\n?$)/;
const BLOCK_ITEM_INDENT = /^([ \t]*)-(?:[ \t]|\r?\n?$)/;

/** The `status/<x>` tag's x, inline `tags: [...]` or a block list; null when there is none. */
function getStatus(lines) {
  for (let i = 0; i < lines.length; i++) {
    const inline = TAGS_INLINE.exec(lines[i]);
    if (inline) {
      for (const t of inline[1].split(',')) { const m = STATUS_TAG.exec(unquote(t.trim())); if (m) return m[1]; }
      return null;
    }
    if (/^tags:[ \t]*\r?\n?$/.test(lines[i])) {
      for (let j = i + 1; j < lines.length && BLOCK_ITEM.test(lines[j]); j++) {
        const m = STATUS_TAG.exec(unquote(lines[j].replace(/^[ \t]*-[ \t]*/, '').trim()));
        if (m) return m[1];
      }
      return null;
    }
  }
  return null;
}

/** Replace the status/ tag (or add one; a memory with no `tags:` gets `[memory/<type>, status/<x>]`). */
function setStatus(fm, type, status) {
  const tag = `status/${status}`;
  for (let i = 0; i < fm.lines.length; i++) {
    const inline = TAGS_INLINE.exec(fm.lines[i]);
    if (inline) {
      const items = inline[1].split(',').map((t) => t.trim()).filter(Boolean);
      const at = items.findIndex((t) => STATUS_TAG.test(unquote(t)));
      if (at >= 0) items[at] = tag; else items.push(tag);
      fm.lines[i] = `tags: [${items.join(', ')}]${inline[2] || fm.eol}`;
      return;
    }
    if (/^tags:[ \t]*\r?\n?$/.test(fm.lines[i])) {
      let j = i + 1;
      for (; j < fm.lines.length && BLOCK_ITEM.test(fm.lines[j]); j++) {
        if (STATUS_TAG.test(unquote(fm.lines[j].replace(/^[ \t]*-[ \t]*/, '').trim()))) {
          fm.lines[j] = fm.lines[j].replace(/^([ \t]*-[ \t]*).*?(\r?\n)?$/, (_, lead, eol) => `${lead}${tag}${eol || ''}`);
          return;
        }
      }
      // The list's own indent, none included (`tags:\n- a`, as PyYAML writes it); two spaces for an empty list.
      const first = BLOCK_ITEM_INDENT.exec(fm.lines[i + 1] || '');
      fm.lines.splice(j, 0, `${first ? first[1] : '  '}- ${tag}${fm.eol}`);
      return;
    }
  }
  fm.lines.push(`tags: [memory/${type}, ${tag}]${fm.eol}`);
}

/** The body's first H1, else the slug. */
function titleOf(text, slug) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  return m ? m[1] : slug;
}
function firstParagraph(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
  const p = body.split(/\r?\n\s*\r?\n/).map((b) => b.trim()).find((b) => b && !b.startsWith('#'));
  return p ? p.replace(/\s+/g, ' ') : '';
}

/**
 * The title in the body (brain-ai A10): the first H1 rewritten, the line titleOf reads, keeping its line end; else a
 * `# <title>` line inserted after the frontmatter with a blank line on each side. fm.tail starts at the closing `---`.
 */
function setTitleLine(fm, title) {
  const close = /^---[ \t]*(?:\r?\n|$)/.exec(fm.tail)[0];
  const rest = fm.tail.slice(close.length);
  const h1 = /^#[ \t]+.+$/m;
  // A function, so a `$&` or `$1` in the title is text, never a replacement pattern.
  if (h1.test(rest)) { fm.tail = close + rest.replace(h1, () => `# ${title}`); return; }
  const lead = /\n$/.test(close) ? close : close + fm.eol;
  fm.tail = `${lead}${fm.eol}# ${title}${fm.eol}${rest === '' || /^\r?\n/.test(rest) ? '' : fm.eol}${rest}`;
}

/** What a memory says about itself: the keys the hub reads, its status, title and live/gone state. */
function describe(m) {
  const fm = splitFm(m.text);
  const lines = fm ? fm.lines : [];
  const status = getStatus(lines);
  return {
    path: m.rel, type: m.type, slug: m.slug, title: titleOf(m.text, m.slug), kind: getKey(lines, 'type'),
    description: getKey(lines, 'description'), status, live: !GONE.includes(status),
    pin: getKey(lines, 'pin') === 'true', reviewed: getKey(lines, 'reviewed'),
    source: getKey(lines, 'source'), session: getKey(lines, 'session'),
    created: getKey(lines, 'created'), updated: getKey(lines, 'updated'),
    supersededBy: getKey(lines, 'superseded_by'), hash: m.hash, hasFrontmatter: !!fm,
  };
}

function oneLine(text) { return String(text).replace(/\s+/g, ' ').trim(); }

// ── MEMORY.md and the trail ──

function indexFile(vault) { return path.join(vault, 'MEMORY.md'); }

/** MEMORY.md's line for a memory: { title, description } or null. */
function indexEntry(raw, rel) {
  for (const l of String(raw || '').split('\n')) {
    if (!/^\s*-\s/.test(l) || !l.includes(`](${rel})`)) continue;
    const m = /^\s*-\s*\[([^\]]*)\]\([^)]*\)\s*(?:—\s*(.*))?$/.exec(l);
    return m ? { title: m[1].trim(), description: (m[2] || '').trim() } : { title: '', description: '' };
  }
  return null;
}

function readIndex(vault) {
  const st = lstatOrNull(indexFile(vault));
  if (st && !st.isFile()) throw new OpsError('UNSAFE', 'MEMORY.md is not a regular file (a link or a folder): refusing to touch it');
  return st ? fs.readFileSync(indexFile(vault), 'utf8') : null;
}

/** Locked read-change-write of MEMORY.md (never through a link: the check above, then an atomic rename over it). */
function editIndex(vault, fn) {
  readIndex(vault);
  fsx.updateSync(indexFile(vault), (raw) => fn(raw == null ? '# Index\n' : raw), { timeoutMs: 5000 });
}

function indexLine(title, rel, description) { return `- [${oneLine(title)}](${rel}) — ${oneLine(description)}`; }

function appendTrail(vault, m, action, extra = {}) {
  const d = describe(m);
  appendTrailRow(vault, { session: d.session || null, action, slug: m.slug, type: m.type, title: d.title, path: m.rel, ...extra });
}

/** One trail row as given, stamped first with its time (`fix` logs rows for a draft or a MEMORY.md line this way). */
function appendTrailRow(vault, fields) {
  const dir = plainDir(vault, 'brain/_index');
  if (!dir) return;
  const row = { ts: new Date().toISOString(), ...fields };
  try { fsx.appendLineSync(path.join(dir, 'promote-log.jsonl'), JSON.stringify(row), { lock: true }); } catch { /* the trail is a record, never a gate */ }
}

function write(m, text) {
  fsx.writeAtomic(m.abs, text);
  return { ...m, text, hash: sha256(text) };
}

function needFm(m) {
  const fm = splitFm(m.text);
  if (!fm) throw new OpsError('NO_FRONTMATTER', `${m.rel} has no frontmatter block`);
  return fm;
}

/** Read every path first, so a bad one refuses the whole call before anything is written. */
function readAll(vault, rels) {
  if (!Array.isArray(rels) || !rels.length) throw new OpsError('BAD_PATH', 'no memory path given');
  const seen = new Set();
  return rels.map((r) => readMemory(vault, r)).filter((m) => (seen.has(m.rel) ? false : seen.add(m.rel)));
}

// ── the verbs ──

/** `reviewed: true` (D4). → { kept, already } */
function keep(vault, rels) {
  const kept = [];
  const already = [];
  for (const m of readAll(vault, rels)) {
    const fm = needFm(m);
    if (getKey(fm.lines, 'reviewed') === 'true') { already.push(m.rel); continue; }
    setKey(fm, 'reviewed', 'true');
    appendTrail(vault, write(m, joinFm(fm)), 'kept');
    kept.push(m.rel);
  }
  return { kept, already };
}

/**
 * Validate `set`'s object: only pin (boolean), status (STATUSES), description (one line, ≤ MAX_DESC) and title (one
 * line, ≤ MAX_TITLE; brain-ai A10: a sweep's Retitle card).
 */
function checkFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new OpsError('BAD_FIELD', '--set takes a JSON object');
  const keys = Object.keys(fields);
  if (!keys.length) throw new OpsError('BAD_FIELD', '--set names no key (pin, status, description, title)');
  const out = {};
  for (const k of keys) {
    const v = fields[k];
    if (k === 'pin') {
      if (typeof v !== 'boolean') throw new OpsError('BAD_FIELD', 'pin takes true or false');
      out.pin = v;
    } else if (k === 'status') {
      if (!STATUSES.includes(v)) throw new OpsError('BAD_FIELD', `status takes ${STATUSES.join(', ')} (archive, restore and supersede set the others)`);
      out.status = v;
    } else if (k === 'description') {
      if (typeof v !== 'string' || CONTROL.test(v)) throw new OpsError('BAD_FIELD', 'description takes one line of text');
      const d = v.trim();
      if (!d || d.length > MAX_DESC) throw new OpsError('BAD_FIELD', `description takes 1–${MAX_DESC} characters`);
      out.description = d;
    } else if (k === 'title') {
      if (typeof v !== 'string' || CONTROL.test(v)) throw new OpsError('BAD_FIELD', 'title takes one line of text');
      const t = v.trim();
      if (!t || t.length > MAX_TITLE) throw new OpsError('BAD_FIELD', `title takes 1–${MAX_TITLE} characters`);
      out.title = t;
    } else {
      throw new OpsError('BAD_FIELD', `--set cannot change ${k} (pin, status, description, title)`);
    }
  }
  return out;
}

/**
 * Change pin, status, description (D17) or title (brain-ai A10), refused when the file's hash is not `expect` or the
 * memory is archived or superseded (restore it first). A title rewrites the body's first H1 (or adds one) and never the
 * slug; a description or a title upserts the MEMORY.md line, a title keeping the line's description (else the memory's
 * own, else its opening). dryRun returns the text it would write. → { path, fields, written, hash, … }
 */
function setFields(vault, rel, fields, { expect = null, dryRun = false } = {}) {
  const f = checkFields(fields);
  const m = readMemory(vault, rel);
  if (expect !== null) {
    if (!HASH_RE.test(expect)) throw new OpsError('BAD_HASH', `--expect takes a hash as \`aos memory list --json\` prints it`);
    if (expect !== m.hash) throw new OpsError('CHANGED', `${m.rel} changed since it was read: read it again`);
  }
  const fm = needFm(m);
  const status = getStatus(fm.lines);
  if (GONE.includes(status)) throw new OpsError('GONE', `${m.rel} is ${status}: restore it first`);
  if ('pin' in f) setKey(fm, 'pin', f.pin ? 'true' : null);
  if ('status' in f) setStatus(fm, m.type, f.status);
  if ('description' in f) setKey(fm, 'description', yamlValue(f.description));
  if ('title' in f) setTitleLine(fm, f.title);
  const text = joinFm(fm);
  const out = { path: m.rel, fields: Object.keys(f), written: text !== m.text, hash: sha256(text) };
  if (dryRun) return { ...out, written: false, wouldWrite: text !== m.text, text, beforeText: m.text };
  if (!out.written) return out;
  const after = write(m, text);
  if ('description' in f || 'title' in f) {
    const title = titleOf(text, m.slug);
    editIndex(vault, (raw) => {
      const e = 'description' in f ? null : indexEntry(raw, m.rel);
      const desc = 'description' in f ? f.description
        : (e && e.description) || getKey(fm.lines, 'description') || deriveDescription(firstParagraph(text) || title);
      return upsertIndexLine(raw, `## ${TYPE_HEADING[m.type]}`, indexLine(title, m.rel, desc), m.rel);
    });
  }
  appendTrail(vault, after, 'set', { fields: Object.keys(f) });
  return out;
}

/** The description a memory keeps while it is out of MEMORY.md: its own key, else its index line's, else its opening. */
function keepDescription(fm, m, raw) {
  if (getKey(fm.lines, 'description')) return;
  const e = indexEntry(raw, m.rel);
  const d = oneLine((e && e.description) || deriveDescription(firstParagraph(m.text) || titleOf(m.text, m.slug)));
  if (d) setKey(fm, 'description', yamlValue(d.replace(CONTROL, ' ').slice(0, MAX_DESC).trim()));
}

/**
 * One live memory's frontmatter taken out (D5, D7): the description kept (`raw` is MEMORY.md as read), the status before
 * recorded, the `extra` keys set (archived:, superseded_by:), then the status tag. lib/memory-merge.js retires a merge's
 * losers with it, under its own single MEMORY.md edit.
 */
function retireFm(fm, m, raw, status, extra) {
  const before = getStatus(fm.lines);
  keepDescription(fm, m, raw);
  setKey(fm, 'status_before', before || 'active');
  for (const [k, v] of Object.entries(extra)) setKey(fm, k, v);
  setStatus(fm, m.type, status);
}

/** Take memories out (D5, D7): the status recorded, the description kept, the MEMORY.md lines removed together. */
function retire(vault, rels, status, extra) {
  const ms = readAll(vault, rels);
  const raw = readIndex(vault) || '';
  const done = [];
  const already = [];
  for (const m of ms) {
    const fm = needFm(m);
    if (GONE.includes(getStatus(fm.lines))) { already.push(m.rel); continue; }
    retireFm(fm, m, raw, status, extra);
    done.push(write(m, joinFm(fm)));
  }
  if (done.length) editIndex(vault, (text) => done.reduce((t, m) => removeIndexLine(t, m.rel), text));
  return { done, already };
}

/** status/archived, out of MEMORY.md (D5). → { archived, already } */
function archive(vault, rels, { date = today() } = {}) {
  const r = retire(vault, rels, 'archived', { archived: date });
  for (const m of r.done) appendTrail(vault, m, 'archived');
  return { archived: r.done.map((m) => m.rel), already: r.already };
}

/** status/superseded with superseded_by (D7): the winner must be another live memory. → { path, by } */
function supersede(vault, rel, byRel) {
  const m = readMemory(vault, rel);
  const by = readMemory(vault, byRel);
  if (by.rel === m.rel) throw new OpsError('BAD_PATH', 'a memory cannot supersede itself');
  if (!describe(by).live) throw new OpsError('GONE', `${by.rel} is ${describe(by).status}: pick a live memory`);
  const r = retire(vault, [m.rel], 'superseded', { superseded_by: by.rel });
  for (const x of r.done) appendTrail(vault, x, 'superseded', { by: by.rel });
  return { path: m.rel, by: by.rel, already: r.already.length > 0 };
}

/** One retired memory's frontmatter put back: its status before (else active), the retire keys removed. */
function restoreFm(fm, type) {
  const before = getKey(fm.lines, 'status_before');
  for (const k of ['status_before', 'archived', 'superseded_by']) setKey(fm, k, null);
  setStatus(fm, type, STATUSES.includes(before) ? before : 'active');
}

/** MEMORY.md with a memory's line upserted from its H1 and `description:` (else its opening), as restore writes it. */
function upsertOwnLine(raw, m) {
  const d = describe(m);
  const desc = d.description || deriveDescription(firstParagraph(m.text) || d.title);
  return upsertIndexLine(raw, `## ${TYPE_HEADING[m.type]}`, indexLine(d.title, m.rel, desc), m.rel);
}

/** Put archived or superseded memories back: their status before, their MEMORY.md line again. → { restored, already } */
function restore(vault, rels) {
  const done = [];
  const already = [];
  for (const m of readAll(vault, rels)) {
    const fm = needFm(m);
    if (!GONE.includes(getStatus(fm.lines))) { already.push(m.rel); continue; }
    restoreFm(fm, m.type);
    done.push(write(m, joinFm(fm)));
  }
  if (done.length) editIndex(vault, (raw) => done.reduce(upsertOwnLine, raw));
  for (const m of done) appendTrail(vault, m, 'restored');
  return { restored: done.map((m) => m.rel), already };
}

// ── reading the store ──

function readdirSafe(dir) { try { return fs.readdirSync(dir).sort(); } catch { return []; } }

/** Every memory in the four type folders (top level; links, folders and README.md skipped): describe() rows. */
function listMemories(vault) {
  const out = [];
  for (const type of TYPES) {
    let dir;
    try { dir = plainDir(vault, `brain/memory/${type}`); } catch { continue; }
    if (!dir) continue;
    for (const f of readdirSafe(dir)) {
      const rel = `brain/memory/${type}/${f}`;
      if (!PATH_RE.test(rel)) continue;
      try { out.push(describe(readMemory(vault, rel))); } catch { /* a link or an unreadable file: not listed */ }
    }
  }
  return out;
}

/** The feedback drafts (brain/memory/feedback/_drafts, D3): { slug, title, description, session, created }. */
function listDrafts(vault) {
  let dir;
  try { dir = plainDir(vault, 'brain/memory/feedback/_drafts'); } catch { return []; }
  if (!dir) return [];
  const out = [];
  for (const f of readdirSafe(dir)) {
    const slug = f.replace(/\.md$/, '');
    if (!f.endsWith('.md') || !SLUG_RE.test(slug)) continue;
    let text = null;
    try { text = readRegular(path.join(dir, f), f); } catch { continue; }
    if (text === null) continue;
    const lines = (splitFm(text) || { lines: [] }).lines;
    out.push({ slug, title: titleOf(text, slug), description: getKey(lines, 'description'), session: getKey(lines, 'session'), created: getKey(lines, 'created') });
  }
  return out;
}

module.exports = {
  TYPES, PATH_RE, SLUG_RE, HASH_RE, TYPE_HEADING, STATUSES, GONE, OpsError,
  checkPath, plainDir, readRegular, readMemory, splitFm, joinFm, getKey, getStatus, titleOf, firstParagraph, describe,
  indexEntry, keep, setFields, archive, restore, supersede, listMemories, listDrafts, sha256,
  // lib/memory-fix.js's building blocks (brain-hub plan PR 3): the same line edits, writes, index lock and trail.
  MAX_DESC, CONTROL, STATUS_TAG, BLOCK_ITEM, setKey, yamlValue, oneLine, indexLine, readIndex, editIndex, write, appendTrail, appendTrailRow,
  // lib/memory-merge.js's (brain-ai A1, A2, A9): retire and restore one file at a time, under the merge's one index edit.
  MAX_TITLE, retireFm, restoreFm, upsertOwnLine, setTitleLine,
};
