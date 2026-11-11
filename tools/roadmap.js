#!/usr/bin/env node
'use strict';
/**
 * roadmap.js — roadmap/roadmap.md, the public roadmap (spec 2026-11-11-roadmap-design). The owner writes items by hand
 * and an agent reads them as specs; CI checks the file on every pull request.
 *
 *   node tools/roadmap.js check     exit 1 and list every problem as roadmap/roadmap.md:<line>: <message>
 *
 * Exit: 0 ok · 1 problems (or no roadmap file) · 2 usage
 *
 * The format (D2, D3; roadmap/README.md is the guide):
 *   ### UDX-001 · Choose your colour scheme
 *   status: idea · type: feature · area: app
 *
 *   Prose. The first paragraph is the item's summary.
 *
 *   #### Must            optional sections, any name, in the order written
 *   - …
 * Separators in the heading and the metadata line may be `·`, `-`, `–`, `—` or `|`. Keys and the status and type values
 * are case-insensitive. A `shipped` item may carry `release: vX.Y.Z`. Text before the first item is the intro; after the
 * first item every `###` heading must be an item, and a `##` heading ends the item above it. Headings inside a fenced
 * code block are prose. One snapshot is checked: "statuses only move forward" and "an ID is never reused" are kept by
 * convention and review (D9).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = 'roadmap/roadmap.md';
const STATUSES = ['idea', 'planned', 'approved', 'building', 'shipped'];
const TYPES = ['feature', 'function', 'improvement'];
const KEYS = new Set(['status', 'type', 'area', 'release']);
const ID = /^UDX-(\d{3,})$/;
const AREA = /^[a-z][a-z0-9-]*$/;
const RELEASE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
/** `### <id> <separator> <title>`; the id is checked separately so a near miss gets a precise message. */
const HEADING = /^###\s+(\S+)\s*[·|–—-]\s*(.*)$/;
/** A metadata part separator: `·`, `|`, `–`, `—` with optional spaces, or a hyphen with spaces around it. */
const META_SPLIT = /\s*[·|–—]\s*|\s+-\s+/;
const FENCE = /^\s*(```|~~~)/;
const USAGE = 'usage: node tools/roadmap.js check';

/** GitHub's heading anchor: lowercase, punctuation dropped (letters, marks, numbers, `_`, `-` and spaces kept), spaces to hyphens. */
const slug = (s) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');

const trimBlank = (lines) => {
  let a = 0; let b = lines.length;
  while (a < b && lines[a].text.trim() === '') a++;
  while (b > a && lines[b - 1].text.trim() === '') b--;
  return lines.slice(a, b);
};
const join = (lines) => trimBlank(lines).map((l) => l.text).join('\n');

/** The item's metadata line: its values, or errors naming that line. */
function readMeta(line, errors) {
  const meta = {};
  for (const part of line.text.trim().split(META_SPLIT)) {
    if (!part) continue;
    const m = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(part);
    if (!m) { errors.push({ line: line.n, message: `can't read "${part}" in the metadata line (use key: value)` }); continue; }
    const key = m[1].toLowerCase();
    if (!KEYS.has(key)) { errors.push({ line: line.n, message: `unknown key "${m[1]}" (use status, type, area, release)` }); continue; }
    meta[key] = m[2].trim();
  }
  return meta;
}

/** One item from its heading and the lines under it. */
function readItem(head, lines, seen, errors) {
  const id = head.rawId.toUpperCase();
  const idMatch = ID.exec(id);
  if (!idMatch) errors.push({ line: head.n, message: `malformed ID "${head.rawId}" (use UDX- and at least three digits)` });
  else if (seen.has(id)) errors.push({ line: head.n, message: `${id} is used twice (first on line ${seen.get(id)})` });
  else seen.set(id, head.n);
  if (!head.title) errors.push({ line: head.n, message: `missing title after ${head.rawId}` });

  let k = 0;
  while (k < lines.length && lines[k].text.trim() === '') k++;
  const metaLine = lines[k];
  const item = {
    id, num: idMatch ? Number(idMatch[1]) : null, title: head.title, status: null, type: null, area: null, release: null,
    line: head.n, summary: '', body: '', sections: [], anchor: slug(head.text),
  };
  let rest = lines;
  if (!metaLine || metaLine.fenced || !/^\s*[A-Za-z]+\s*:/.test(metaLine.text)) {
    errors.push({ line: metaLine ? metaLine.n : head.n, message: 'missing the metadata line under the heading (status: … · type: … · area: …)' });
  } else {
    rest = lines.slice(k + 1);
    const meta = readMeta(metaLine, errors);
    const status = (meta.status || '').toLowerCase();
    const type = (meta.type || '').toLowerCase();
    const area = (meta.area || '').toLowerCase();
    if (!status) errors.push({ line: metaLine.n, message: 'missing status' });
    else if (!STATUSES.includes(status)) errors.push({ line: metaLine.n, message: `unknown status "${meta.status}" (use ${STATUSES.join(', ')})` });
    else item.status = status;
    if (!type) errors.push({ line: metaLine.n, message: 'missing type' });
    else if (!TYPES.includes(type)) errors.push({ line: metaLine.n, message: `unknown type "${meta.type}" (use ${TYPES.join(', ')})` });
    else item.type = type;
    if (!area) errors.push({ line: metaLine.n, message: 'missing area' });
    else if (!AREA.test(area)) errors.push({ line: metaLine.n, message: `area must be one lowercase word, got "${meta.area}"` });
    else item.area = area;
    if (meta.release !== undefined) {
      const r = RELEASE.exec(meta.release);
      if (!r) errors.push({ line: metaLine.n, message: `malformed release "${meta.release}" (use v1.2.3)` });
      else if (status !== 'shipped') errors.push({ line: metaLine.n, message: 'release only on a shipped item' });
      else item.release = `v${r[1]}`;
    }
  }

  let body = [];
  let section = null;
  for (const l of rest) {
    const s = !l.fenced && /^####(?!#)\s*(.*)$/.exec(l.text);
    if (s) { section = { title: s[1].trim(), lines: [] }; item.sections.push(section); continue; }
    (section ? section.lines : body).push(l);
  }
  item.body = join(body);
  item.summary = item.body.split(/\n\s*\n/)[0].trim();
  item.sections = item.sections.map((x) => ({ title: x.title, body: join(x.lines) }));
  if (item.status === 'planned' && item.sections.length === 0) {
    errors.push({ line: head.n, message: 'a planned item needs at least one #### section (Must, Not, Done when, …)' });
  }
  return item;
}

/** roadmap.md → { intro, items, errors }. Errors carry 1-based line numbers, in file order. */
function parse(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((t, i) => ({ text: t.replace(/\s+$/, ''), n: i + 1, fenced: false }));
  const errors = [];
  const items = [];
  const intro = [];
  const seen = new Map();
  let inFence = false;
  let seenItem = false;
  let cur = null;
  const finish = () => { if (cur) items.push(readItem(cur.head, cur.lines, seen, errors)); cur = null; };
  for (const l of lines) {
    if (FENCE.test(l.text)) { inFence = !inFence; l.fenced = true; } else if (inFence) l.fenced = true;
    if (!l.fenced && /^###(?!#)/.test(l.text)) {
      finish();
      const m = HEADING.exec(l.text);
      if (m && /^UDX/i.test(m[1])) {
        seenItem = true;
        cur = { head: { rawId: m[1], title: m[2].trim(), text: l.text.replace(/^###\s+/, ''), n: l.n }, lines: [] };
      } else if (seenItem) {
        errors.push({ line: l.n, message: `item heading must be "### UDX-NNN · Title", got "${l.text}"` });
      } else intro.push(l);
      continue;
    }
    if (!l.fenced && /^##(?!#)/.test(l.text)) { finish(); if (!seenItem) intro.push(l); continue; }
    if (cur) cur.lines.push(l);
    else if (!seenItem) intro.push(l);
  }
  finish();
  errors.sort((a, b) => a.line - b.line);
  return { intro: join(intro), items, errors };
}

function main(argv = process.argv.slice(2), { root = ROOT, log = console.log, err = console.error } = {}) {
  const [cmd] = argv;
  if (cmd !== 'check') { err(USAGE); return 2; }
  let text;
  try { text = fs.readFileSync(path.join(root, FILE), 'utf8'); } catch (e) { err(`roadmap: cannot read ${FILE} (${e.code || e.message})`); return 1; }
  const { items, errors } = parse(text);
  for (const e of errors) err(`${FILE}:${e.line}: ${e.message}`);
  log(`roadmap: ${items.length} item(s), ${errors.length} error(s)`);
  return errors.length ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { parse, slug, main, STATUSES, TYPES };
