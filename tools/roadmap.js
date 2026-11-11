#!/usr/bin/env node
'use strict';
/**
 * roadmap.js — roadmap/roadmap.md, the public roadmap (spec 2026-11-11-roadmap-design). The owner writes items by hand
 * and an agent reads them as specs; CI checks the file on every pull request.
 *
 *   node tools/roadmap.js check     exit 1 and list every problem as roadmap/roadmap.md:<line>: <message>
 *   node tools/roadmap.js build --out <dir> [--updated YYYY-MM-DD] [--repo-url <url>]
 *                                   the page (D6) from roadmap/site/'s template into <dir>; writes nothing when check
 *                                   fails. --updated defaults to today, --repo-url to https://github.com/$GITHUB_REPOSITORY
 *                                   (else the public repo). .github/workflows/roadmap.yml deploys <dir> to GitHub Pages.
 *
 * Exit: 0 ok · 1 problems (or no roadmap file) · 2 usage
 *
 * The page escapes every character of the file and renders a small Markdown subset only: paragraphs, lists, fenced code,
 * bold, italic, inline code and http(s) links (D10). An agent writes to this file too, and the page is public.
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
const USAGE = 'usage: node tools/roadmap.js check | build --out <dir> [--updated YYYY-MM-DD] [--repo-url <url>]';
const PUBLIC_REPO = 'https://github.com/zzoretich/UniDeX-Agent-Harness';
const SITE = 'roadmap/site';
const ASSETS = ['style.css', 'app.js'];
const LABEL = { idea: 'Idea', planned: 'Planned', approved: 'Approved', building: 'Building', shipped: 'Shipped',
  feature: 'Features', function: 'Functions', improvement: 'Improvements' };
/** Layout B (D6): which statuses fill each lane, in order. Shipped items go to the release list below the lanes. */
const LANES = [
  { key: 'now', title: 'Now', sub: 'Being built', statuses: ['building'] },
  { key: 'next', title: 'Next', sub: 'Approved or planned', statuses: ['approved', 'planned'] },
  { key: 'later', title: 'Later', sub: 'Ideas we’re exploring', statuses: ['idea'] },
];

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

// ---- the page ---------------------------------------------------------------------------------------------------------

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** One line of prose: escaped, then inline code, http(s) links, bold and italic. Any other link keeps only its text. */
function inline(s) {
  const codes = [];
  let t = String(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = escapeHtml(t)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => (/^https?:\/\//i.test(url) ? `<a href="${url}" rel="noopener">${label}</a>` : label))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

/** The Markdown subset (D10): paragraphs, - and 1. lists, fenced code; everything else is escaped text. */
function renderMarkdown(md) {
  const out = [];
  let para = []; let list = null; let fence = null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
  const flushFence = () => { out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`); fence = null; };
  for (const line of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) { if (FENCE.test(line)) flushFence(); else fence.push(line); continue; }
    if (FENCE.test(line)) { flushPara(); flushList(); fence = []; continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    if (list && /^\s+\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList();
    para.push(line.trim());
  }
  if (fence) flushFence();
  flushPara(); flushList();
  return out.join('');
}

/** v2.10.0 > v2.9.0 > v2.9.0-rc.1: newest release first. */
function compareReleases(a, b) {
  const parts = (v) => { const [core, pre] = v.replace(/^v/, '').split('-'); return { n: core.split('.').map(Number), pre: pre || null }; };
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return y.n[i] - x.n[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return -1;
  if (!y.pre) return 1;
  return y.pre.localeCompare(x.pre, 'en', { numeric: true });
}

const attrs = (i) => `data-type="${escapeHtml(i.type)}" data-area="${escapeHtml(i.area)}" data-status="${escapeHtml(i.status)}"`;

function card(i) {
  return `<a class="card" href="#${i.id}" ${attrs(i)}><span class="card-id">${i.id} · ${LABEL[i.status].toLowerCase()}</span>`
    + `<span class="card-title">${escapeHtml(i.title)}</span>`
    + `<span class="tags"><span class="tag">${escapeHtml(i.type)}</span><span class="tag">${escapeHtml(i.area)}</span></span></a>`;
}

function detail(i, repoUrl) {
  const at = STATUSES.indexOf(i.status);
  const steps = STATUSES.map((s, n) => `<li class="${n < at ? 'done' : n === at ? 'now' : ''}"${n === at ? ' aria-current="step"' : ''}>${LABEL[s]}</li>`).join('');
  const sections = i.sections.map((s) => `<h3>${escapeHtml(s.title)}</h3><div class="prose">${renderMarkdown(s.body)}</div>`).join('');
  const release = i.release
    ? `<a href="${escapeHtml(repoUrl)}/releases/tag/${escapeHtml(i.release)}" rel="noopener">Shipped in ${escapeHtml(i.release)} ↗</a>` : '';
  return `<article class="detail" id="${i.id}" data-status="${escapeHtml(i.status)}" aria-labelledby="${i.id}-title" tabindex="-1">`
    + `<header><p class="detail-meta">${i.id} · ${escapeHtml(i.type)} · ${escapeHtml(i.area)}</p>`
    + `<h2 id="${i.id}-title">${escapeHtml(i.title)}</h2><a class="close" href="#" aria-label="Close">✕</a></header>`
    + `<ol class="steps" aria-label="Progress">${steps}</ol>`
    + `<div class="prose">${renderMarkdown(i.body)}</div>${sections}`
    + `<footer><a href="#${i.id}">Link to this item</a>`
    + `<a href="${escapeHtml(repoUrl)}/blob/main/${FILE}#${escapeHtml(i.anchor)}" rel="noopener">View in roadmap.md ↗</a>${release}</footer></article>`;
}

/** The page: the template's {{PLACEHOLDERS}} filled from a parse with no errors. */
function buildPage(parsed, { repoUrl, updated, template }) {
  const items = [...parsed.items].sort((a, b) => a.num - b.num);
  const lanes = LANES.map((l) => {
    const inLane = l.statuses.flatMap((s) => items.filter((i) => i.status === s));
    const cards = inLane.map(card).join('');
    return `<section class="lane" data-lane="${l.key}" aria-labelledby="lane-${l.key}"><header><h2 id="lane-${l.key}">${l.title} <span class="count">${inLane.length}</span></h2>`
      + `<p class="lane-sub">${l.sub}</p></header>${cards || '<p class="empty">Nothing here yet</p>'}</section>`;
  }).join('');
  const shipped = items.filter((i) => i.status === 'shipped');
  const groups = [];
  const pending = shipped.filter((i) => !i.release);
  if (pending.length) groups.push({ key: 'next', title: 'Next release', items: pending });
  for (const r of [...new Set(shipped.map((i) => i.release).filter(Boolean))].sort(compareReleases)) {
    groups.push({ key: r, title: `<a href="${escapeHtml(repoUrl)}/releases/tag/${escapeHtml(r)}" rel="noopener">${escapeHtml(r)}</a>`, items: shipped.filter((i) => i.release === r) });
  }
  const rows = (list) => list.map((i) => `<li><a class="row" href="#${i.id}" ${attrs(i)}><span class="card-id">${i.id}</span>`
    + `<span class="row-title">${escapeHtml(i.title)}</span><span class="tag">${escapeHtml(i.type)}</span></a></li>`).join('');
  const shippedHtml = '<section class="shipped" aria-labelledby="shipped-title"><h2 id="shipped-title">Recently shipped</h2>'
    + (groups.map((g) => `<div class="release" data-release="${escapeHtml(g.key)}"><h3>${g.title}</h3><ul>${rows(g.items)}</ul></div>`).join('')
      || '<p class="empty">Nothing shipped yet</p>') + '</section>';
  const areas = [...new Set(items.map((i) => i.area))].sort();
  const button = (kind, value, label, on) => `<button type="button" data-filter-${kind}="${escapeHtml(value)}" aria-pressed="${on}">${escapeHtml(label)}</button>`;
  const filters = `<div class="filter-group" role="group" aria-label="Type">${button('type', 'all', 'All', true)}${TYPES.map((t) => button('type', t, LABEL[t], false)).join('')}</div>`
    + `<div class="filter-group" role="group" aria-label="Area">${button('area', 'all', 'All areas', true)}${areas.map((a) => button('area', a, a, false)).join('')}</div>`;
  const tagline = parsed.intro.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#')) || '';
  const values = {
    UPDATED: escapeHtml(updated), INTRO: inline(tagline), FILTERS: filters, LANES: lanes, SHIPPED: shippedHtml,
    DETAILS: items.map((i) => detail(i, repoUrl)).join(''), REPO_URL: escapeHtml(repoUrl),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? values[k] : m));
}

const defaultRepoUrl = () => (process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : PUBLIC_REPO);

/** roadmap/roadmap.md + roadmap/site/ under root → outDir. Writes nothing when the file has errors. */
function build(root, outDir, { repoUrl = defaultRepoUrl(), updated = '' } = {}) {
  const parsed = parse(fs.readFileSync(path.join(root, FILE), 'utf8'));
  if (parsed.errors.length) return { errors: parsed.errors, written: [] };
  const site = path.join(root, SITE);
  const html = buildPage(parsed, { repoUrl, updated: updated || require('./changelog.js').localDate(), template: fs.readFileSync(path.join(site, 'index.html'), 'utf8') });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  for (const f of ASSETS) fs.copyFileSync(path.join(site, f), path.join(outDir, f));
  return { errors: [], written: ['index.html', ...ASSETS], items: parsed.items.length };
}

function main(argv = process.argv.slice(2), { root = ROOT, log = console.log, err = console.error } = {}) {
  const [cmd, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd !== 'check' && !(cmd === 'build' && flag('--out'))) { err(USAGE); return 2; }
  let text;
  try { text = fs.readFileSync(path.join(root, FILE), 'utf8'); } catch (e) { err(`roadmap: cannot read ${FILE} (${e.code || e.message})`); return 1; }
  const { items, errors } = parse(text);
  for (const e of errors) err(`${FILE}:${e.line}: ${e.message}`);
  if (cmd === 'check' || errors.length) {
    log(`roadmap: ${items.length} item(s), ${errors.length} error(s)`);
    return errors.length ? 1 : 0;
  }
  const out = path.resolve(root, flag('--out'));
  build(root, out, { repoUrl: flag('--repo-url') || defaultRepoUrl(), updated: flag('--updated') });
  log(`roadmap: built ${items.length} item(s) into ${path.relative(root, out) || '.'}`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { parse, slug, escapeHtml, renderMarkdown, buildPage, build, main, STATUSES, TYPES };
