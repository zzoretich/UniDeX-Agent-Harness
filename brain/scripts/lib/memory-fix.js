'use strict';
/**
 * memory-fix.js — `aos memory fix <kind> [--dry-run]` (brain-hub D20; plan PR 3 "Mechanics"): one click, no model, each
 * kind acting on exactly what lib/memory-hygiene.js finds (brain-hub.json's `hygiene`), read from the files as they are
 * now, never from the cache:
 *   sources       source: session | in-session | wrap → manual-wrap (what /wrap writes; auto-wrap and none stay)
 *   types         the old `type:` shape → type: memory (replaced, or the first key), and `tags:` gains memory/<type>; no
 *                 status is invented (status/active would put an old project into BRAIN.md's Active context unasked);
 *                 name:, description:, metadata: stay
 *   descriptions  description: copied from the memory's MEMORY.md line (one line, ≤ 200 characters, as archive keeps one)
 *   index         under one MEMORY.md lock: a missing line added under its type's heading, a misfiled one moved there
 *                 (its text unchanged; a retired memory's goes instead), a line to a missing file removed
 *   drafts        a feedback draft whose memory is live, removed (spec §6's one delete)
 * Only live memories change (never archived or superseded), and only those keys: memory-ops' line edits keep every
 * other byte. Every target is read before anything is written. A dry run returns the same changes and writes nothing,
 * no trail row either; a real run writes each file and logs one `fixed` trail row per memory or draft, each field with
 * its before and after. Not undoable (the user, 2026-10-11): the page shows the dry run and asks first.
 *
 * → { kind, dryRun, changes: [{ path, action, before, after }], files } (files: the files changed, MEMORY.md once).
 */
const fs = require('fs');
const path = require('path');
const ops = require('./memory-ops.js');
const hyg = require('./memory-hygiene.js');
const { deriveDescription, insertIndexLine } = require('./memory-index.js');

const KINDS = ['sources', 'types', 'descriptions', 'index', 'drafts'];
const DRAFTS = 'brain/memory/feedback/_drafts';
const CONTROL_ALL = new RegExp(ops.CONTROL.source, 'g');

function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }

/** The store as it is now: every memory's describe() row by path, and the live ones in list order. */
function readStore(vault) {
  const memories = ops.listMemories(vault);
  return { live: memories.filter((m) => m.live), byPath: new Map(memories.map((m) => [m.path, m])) };
}

/** The trail's per-field record of a change: { field, before, after } (field: the key, or the index or draft action). */
function asField(c) { return { field: c.action, before: c.before, after: c.after }; }

/**
 * Plan a frontmatter edit per memory: each re-read now (a link or a vanished file refuses the whole call before any
 * write), skipped unless it still has frontmatter and is still live; edit(fm, m) changes fm.lines and returns its rows.
 */
function planMemories(vault, rels, edit) {
  const out = [];
  for (const m of rels.map((r) => ops.readMemory(vault, r))) {
    const fm = ops.splitFm(m.text);
    if (!fm || !ops.describe(m).live) continue;
    const rows = edit(fm, m);
    const text = ops.joinFm(fm);
    if (rows.length && text !== m.text) out.push({ m, text, rows });
  }
  return out;
}

// ── sources ──

function editSource(fm) {
  const before = ops.getKey(fm.lines, 'source');
  if (!hyg.LEGACY_SOURCES.includes(before)) return [];
  ops.setKey(fm, 'source', hyg.CANON_SOURCE);
  return [{ action: 'source', before, after: hyg.CANON_SOURCE }];
}

// ── types ──

const TAGS_INLINE = /^tags:[ \t]*\[(.*)\][ \t]*(\r?\n)?$/;
const TAGS_BLOCK = /^tags:[ \t]*(\r?\n)?$/;
const TAGS_SCALAR = /^tags:[ \t]*(.*?)[ \t]*(\r?\n)?$/;
const ITEM = /^([ \t]+)-[ \t]*(.*?)[ \t]*(\r?\n)?$/;

function bare(tag) { return String(tag).trim().replace(/^(["'])(.*)\1$/, '$2').replace(/^#/, ''); }
/** The type's tag is there: memory/<type>, or the singular memory/project some older project memories carry. */
function hasTypeTag(items, type) {
  return items.some((t) => { const b = bare(t); return b === `memory/${type}` || (type === 'projects' && b === 'memory/project'); });
}

/**
 * `tags:` gains what an old-shape memory lacks: memory/<type> (never a status: one it has stays, none stays none). An inline
 * list is rewritten as memory-ops setStatus rewrites it, a block list gains items at its own indent, a scalar becomes a
 * list, and a missing `tags:` is inserted after `type:`. → the row ({ before, after } as one-line lists), or null.
 */
function addTags(fm, type) {
  const at = fm.lines.findIndex((l) => /^tags:/.test(l));
  const missing = (items) => (hasTypeTag(items, type) ? [] : [`memory/${type}`]);
  if (at === -1) {
    const want = missing([]);
    const after = fm.lines.findIndex((l) => /^type:/.test(l)) + 1;
    fm.lines.splice(after, 0, `tags: [${want.join(', ')}]${fm.eol}`);
    return { action: 'tags', before: null, after: `[${want.join(', ')}]` };
  }
  const line = fm.lines[at];
  const inline = TAGS_INLINE.exec(line);
  if (inline) {
    const items = inline[1].split(',').map((t) => t.trim()).filter(Boolean);
    const add = missing(items);
    if (!add.length) return null;
    fm.lines[at] = `tags: [${[...items, ...add].join(', ')}]${inline[2] || fm.eol}`;
    return { action: 'tags', before: `[${inline[1].trim()}]`, after: `[${[...items, ...add].join(', ')}]` };
  }
  if (TAGS_BLOCK.test(line)) {
    let end = at + 1;
    const items = [];
    for (; end < fm.lines.length; end++) { const it = ITEM.exec(fm.lines[end]); if (!it) break; items.push(it[2]); }
    const add = missing(items);
    if (!add.length) return null;
    const indent = (ITEM.exec(fm.lines[at + 1] || '') || [])[1] || '  ';
    fm.lines.splice(end, 0, ...add.map((t) => `${indent}- ${t}${fm.eol}`));
    return { action: 'tags', before: `[${items.join(', ')}]`, after: `[${[...items, ...add].join(', ')}]` };
  }
  const scalar = TAGS_SCALAR.exec(line);
  const items = scalar[1].split(',').map((t) => t.trim()).filter(Boolean);
  const add = missing(items);
  if (!add.length) return null;
  fm.lines[at] = `tags: [${[...items, ...add].join(', ')}]${scalar[2] || fm.eol}`;
  return { action: 'tags', before: scalar[1], after: `[${[...items, ...add].join(', ')}]` };
}

function editType(fm, m) {
  const before = ops.getKey(fm.lines, 'type');
  if (before === 'memory') return [];
  // A top-level `type:` is rewritten in place (memory-ops setKey); none, and it becomes the first key.
  if (before === null) fm.lines.unshift(`type: memory${fm.eol}`);
  else ops.setKey(fm, 'type', 'memory');
  const tags = addTags(fm, m.type);
  return [{ action: 'type', before: before || null, after: 'memory' }, ...(tags ? [tags] : [])];
}

// ── descriptions ──

/** One line, control characters out, at most MAX_DESC characters (memory-ops keepDescription's clip). */
function cleanDescription(s) { return ops.oneLine(String(s).replace(CONTROL_ALL, ' ')).slice(0, ops.MAX_DESC).trimEnd(); }

function editDescription(indexLines) {
  return (fm, m) => {
    if (ops.getKey(fm.lines, 'description')) return [];
    const e = (indexLines.get(m.rel) || []).find((x) => x.description);
    const after = e ? cleanDescription(e.description) : '';
    if (!after) return [];
    // Quoted only when YAML needs it (memory-ops yamlValue); the row and every reader see the text itself.
    ops.setKey(fm, 'description', ops.yamlValue(after));
    return [{ action: 'description', before: null, after }];
  };
}

// ── index ──

/** The line for a memory missing from MEMORY.md, as restore writes it; null when it would not read back as its own. */
function addLine(m) {
  const d = ops.describe(m);
  const desc = d.description || deriveDescription(ops.firstParagraph(m.text) || d.title);
  // `[` or `]` in a title would end the link text early: the line would never read back, and the next run add it again.
  const line = ops.indexLine(d.title.replace(/[[\]]/g, ''), m.rel, desc);
  const e = hyg.entryOf(line);
  return e && e.path === m.rel ? line : null;
}

/** The heading insertIndexLine files a type's line under: the first `## <TYPE_HEADING>…` line, else the one it adds. */
function targetHeading(text, type) {
  const want = `## ${ops.TYPE_HEADING[type]}`;
  const l = text.split('\n').find((x) => x.trim().startsWith(want));
  return (l && hyg.headingOf(l.trim())) || ops.TYPE_HEADING[type];
}

/** `rel`'s lines under another type's heading (or none), taken out: → { text, dropped: [{ line, heading }] }. */
function dropMisfiled(text, rel, type) {
  let heading = '';
  const out = [];
  const dropped = [];
  for (const l of text.split('\n')) {
    const h = hyg.headingOf(l);
    if (h !== null) heading = h;
    else if ((hyg.entryOf(l) || {}).path === rel && !hyg.ownHeading(type, heading)) { dropped.push({ line: l, heading }); continue; }
    out.push(l);
  }
  return { text: out.join('\n'), dropped };
}

/** Every bullet line for `rel` taken out (the same rule readIndexLines reads them by). */
function dropAll(text, rel) { return text.split('\n').filter((l) => (hyg.entryOf(l) || {}).path !== rel).join('\n'); }

/**
 * MEMORY.md's fixes on `raw` (editIndex's '# Index' when there is none): broken lines out, misfiled lines moved, missing
 * lines added, in that order. A misfiled line of an archived or superseded memory goes instead of moving: a retired
 * memory has no line (D5, D7), and its file is not touched. `memory(rel)` reads a memory once.
 * → { text, changes, touched: Map rel → rows (live memories), removed: [{ rel, title, rows }] (lines out) }
 */
function planIndex(vault, raw, store, memory) {
  let text = raw;
  const lines = hyg.readIndexLines(text);
  const h = hyg.findHygiene({ live: store.live, byPath: store.byPath, indexLines: lines, drafts: [] });
  const changes = [];
  const touched = new Map();
  const removed = [];
  const note = (rel, row) => { changes.push({ path: rel, ...row }); (touched.get(rel) || touched.set(rel, []).get(rel)).push(row); };
  const out = (rel, gone) => {
    const rows = gone.map((line) => ({ action: 'index-remove', before: line, after: null }));
    for (const r of rows) changes.push({ path: 'MEMORY.md', ...r });
    removed.push({ rel, title: (hyg.entryOf(gone[0]) || {}).title || '', rows });
  };
  for (const rel of h.brokenIndex) {
    // Only a line whose file is gone: a link or an unreadable file there is not listed, and not this fix's to drop.
    if (lstatOrNull(path.join(vault, rel))) continue;
    out(rel, lines.get(rel).map((e) => e.line));
    text = dropAll(text, rel);
  }
  for (const rel of h.misfiled) {
    const m = store.byPath.get(rel);
    const r = dropMisfiled(text, rel, m.type);
    if (!r.dropped.length) continue;
    text = r.text;
    if (!m.live) { out(rel, r.dropped.map((d) => d.line)); continue; }
    memory(rel); // read now, as every memory this plan names: the trail row after the write needs it
    // Its own heading may hold a copy already: then the misfiled one just goes.
    if (!hyg.readIndexLines(text).has(rel)) text = insertIndexLine(text, `## ${ops.TYPE_HEADING[m.type]}`, r.dropped[0].line);
    note(rel, { action: 'index-move', before: r.dropped[0].heading || null, after: targetHeading(text, m.type) });
  }
  for (const rel of h.unindexed) {
    const m = memory(rel);
    const line = addLine(m);
    if (!line) continue;
    text = insertIndexLine(text, `## ${ops.TYPE_HEADING[m.type]}`, line);
    note(rel, { action: 'index-add', before: null, after: line });
  }
  return { text, changes, touched, removed };
}

function fixIndex(vault, store, dryRun) {
  const cache = new Map();
  const memory = (rel) => cache.get(rel) || cache.set(rel, ops.readMemory(vault, rel)).get(rel);
  const raw = ops.readIndex(vault);
  const dry = planIndex(vault, raw == null ? '# Index\n' : raw, store, memory);
  if (dryRun || !dry.changes.length) return { changes: dry.changes, files: dry.changes.length ? 1 : 0 };
  // The real run plans again under the lock, on MEMORY.md as it is then: one read-change-write for every line.
  let plan = null;
  ops.editIndex(vault, (now) => { plan = planIndex(vault, now, store, memory); return plan.text; });
  for (const [rel, rows] of plan.touched) ops.appendTrail(vault, memory(rel), 'fixed', { kind: 'index', changes: rows.map(asField) });
  // A line out is MEMORY.md's change, not a memory's: its row names no slug (the plan's trail shape).
  for (const r of plan.removed) {
    const type = ops.PATH_RE.exec(r.rel)[1];
    ops.appendTrailRow(vault, { session: null, action: 'fixed', kind: 'index', type, title: r.title, path: 'MEMORY.md', changes: r.rows.map(asField) });
  }
  return { changes: plan.changes, files: plan.changes.length ? 1 : 0 };
}

// ── drafts ──

function fixDrafts(vault, store, dryRun) {
  const drafts = ops.listDrafts(vault);
  const h = hyg.findHygiene({ live: store.live, byPath: store.byPath, indexLines: new Map(), drafts });
  const plan = [];
  for (const slug of h.leftoverDrafts) {
    const dir = ops.plainDir(vault, DRAFTS);
    const rel = `${DRAFTS}/${slug}.md`;
    const abs = dir && path.join(dir, `${slug}.md`);
    // A regular file only, read O_NOFOLLOW (a link refuses the call); the unlink then removes that name, never a target.
    if (!abs || ops.readRegular(abs, rel) === null) continue;
    const d = drafts.find((x) => x.slug === slug);
    plan.push({ slug, rel, abs, title: d.title, session: d.session || null });
  }
  const changes = plan.map((p) => ({ path: p.rel, action: 'draft-remove', before: p.title, after: null }));
  if (!dryRun) {
    for (const p of plan) {
      fs.unlinkSync(p.abs);
      const changes = [{ field: 'draft-remove', before: p.title, after: null }];
      ops.appendTrailRow(vault, { session: p.session, action: 'fixed', kind: 'drafts', slug: p.slug, type: 'feedback', title: p.title, path: p.rel, changes });
    }
  }
  return { changes, files: plan.length };
}

// ── the verb ──

function fix(vault, kind, { dryRun = false } = {}) {
  if (!KINDS.includes(kind)) throw new ops.OpsError('BAD_KIND', `not a fix: ${kind} (${KINDS.join(', ')})`);
  if (!ops.plainDir(vault, 'brain/_index')) throw new ops.OpsError('NO_INDEX', 'brain/_index is missing: run `aos init` or `aos upgrade`');
  const store = readStore(vault);
  let r;
  if (kind === 'index') r = fixIndex(vault, store, dryRun);
  else if (kind === 'drafts') r = fixDrafts(vault, store, dryRun);
  else {
    let rels;
    let edit;
    if (kind === 'sources') { rels = store.live.filter(hyg.legacySource).map((m) => m.path); edit = editSource; }
    else if (kind === 'types') { rels = store.live.filter(hyg.oldType).map((m) => m.path); edit = editType; }
    else {
      const indexLines = hyg.readIndexLines(ops.readIndex(vault));
      rels = hyg.findHygiene({ live: store.live, byPath: store.byPath, indexLines, drafts: [] }).noDescription;
      edit = editDescription(indexLines);
    }
    const plan = planMemories(vault, rels, edit);
    if (!dryRun) for (const p of plan) ops.appendTrail(vault, ops.write(p.m, p.text), 'fixed', { kind, changes: p.rows.map(asField) });
    r = { changes: plan.flatMap((p) => p.rows.map((row) => ({ path: p.m.rel, ...row }))), files: plan.length };
  }
  return { kind, dryRun: !!dryRun, changes: r.changes, files: r.files };
}

module.exports = { KINDS, fix };
