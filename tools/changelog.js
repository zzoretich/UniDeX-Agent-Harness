#!/usr/bin/env node
'use strict';
/**
 * changelog.js — CHANGELOG.md's version sections (spec 2026-09-23-ci-safety-net-design D7). release.yml publishes a
 * version's section as its GitHub release notes; CI checks that package.json's version has one; bump-version rolls
 * [Unreleased] into the new version.
 *
 *   node tools/changelog.js notes <x.y.z>               print the section's body (without its heading), markers stripped
 *   node tools/changelog.js check <x.y.z|current>       exit 1 when the section is missing or empty, or when a bullet
 *                                                       under [Unreleased] breaks the tour-marker rule (below)
 *   node tools/changelog.js roll <x.y.z> [--date <d>]   [Unreleased] becomes `## [x.y.z] — <d>` (default: today, local)
 *                                                       under a fresh empty [Unreleased]; the compare links follow.
 *                                                       Already rolled: no change. Empty [Unreleased]: exit 1.
 * Exit: 0 ok · 1 missing, empty, a marker problem or nothing to roll · 2 usage
 *
 * The tour-marker rule (tour C3, C13), so the tour and What's new keep up with what ships. Every bullet under
 * [Unreleased]'s `### Added` and `### Changed` carries exactly one marker, best at its end:
 *   <!-- tour: <id>[, <id>…] -->    the tour step or chapter that shows the change. An id is a chapter id (`settings`)
 *                                   or `<chapter>.<step>` (`settings.local`) in hud/src/tour/steps.json:
 *                                   the same refs a What's new entry's "Show me" takes (steps.ts allRefs). Several ids,
 *                                   comma-separated, when the change shows in more than one place.
 *   <!-- no-tour: <reason> -->      why nothing in the app shows it (a CLI verb, the setup wizard, background work);
 *                                   the reason is required.
 * Upgrading, Fixed, Removed and Security need no marker (an instruction, a repair of what a step already explains, or
 * something no longer there), but a marker anywhere under [Unreleased] must still be well formed with known ids.
 * Released sections are never checked: a step can be renamed or dropped after the release that named it. The markers
 * stay in CHANGELOG.md (GitHub hides HTML comments when it renders the file) and `notes` strips them, so the release
 * notes never carry one. `check` lists every problem with its line and the bullet's first words.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const LINK = /^\[[^\]]+\]:\s*\S/;
const STEPS = 'hud/src/tour/steps.json';
/** A tour marker: `<!-- tour: ids -->` or `<!-- no-tour: reason -->`, spaces optional. */
const MARKER = /<!--\s*(tour|no-tour)\s*:([\s\S]*?)-->/g;
/** The subsections whose every bullet needs a marker (tour C3). */
const MARKED = new Set(['Added', 'Changed']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headingRe = (name) => new RegExp(`^## \\[${esc(name)}\\](\\s|$)`);

/** [start, end) line indexes of `## [name]`'s body: up to the next `## ` heading or the link references. */
function bounds(lines, name) {
  const head = lines.findIndex((l) => headingRe(name).test(l));
  if (head === -1) return null;
  let end = head + 1;
  while (end < lines.length && !/^## /.test(lines[end]) && !LINK.test(lines[end])) end++;
  return [head, end];
}

/** The trimmed body of `## [name]`, or null when there is no such section. */
function section(text, name) {
  const lines = text.split('\n');
  const b = bounds(lines, name);
  return b ? lines.slice(b[0] + 1, b[1]).join('\n').trim() : null;
}

/**
 * Every id a tour marker may name: each chapter id and each "<chapter>.<step>" in steps.json (tour C13), the refs
 * steps.ts allRefs gives What's new. Checklist actions are not tour steps. A malformed book yields what it can.
 */
function tourRefs(book) {
  const refs = new Set();
  for (const c of book && Array.isArray(book.chapters) ? book.chapters : []) {
    if (!c || typeof c.id !== 'string') continue;
    refs.add(c.id);
    for (const s of Array.isArray(c.steps) ? c.steps : []) if (s && typeof s.id === 'string') refs.add(`${c.id}.${s.id}`);
  }
  return refs;
}

/**
 * The bullets of `## [name]`: { sub, line, text }, `sub` the `### ` subsection it sits under (null above the first),
 * `line` 1-based, `text` the bullet with its indented continuation lines (nested bullets included).
 */
function bullets(text, name) {
  const lines = text.split('\n');
  const b = bounds(lines, name);
  if (!b) return [];
  const out = [];
  let sub = null;
  let cur = null;
  for (let i = b[0] + 1; i < b[1]; i++) {
    const l = lines[i];
    const h = /^###\s+(.+?)\s*$/.exec(l);
    if (h) { sub = h[1]; cur = null; continue; }
    if (/^[-*+]\s/.test(l)) { cur = { sub, line: i + 1, text: l.replace(/^[-*+]\s+/, '') }; out.push(cur); continue; }
    if (cur && /^\s+\S/.test(l)) cur.text += `\n${l.trim()}`;
    else if (l.trim()) cur = null;
  }
  return out;
}

/** Text without its tour markers (and the space before each): what the release notes show. */
function stripMarkers(text) {
  return text.replace(/[ \t]*<!--\s*(?:tour|no-tour)\s*:[\s\S]*?-->/g, '');
}

/** A bullet's first six words, plain: how a problem names it. */
function firstWords(text) {
  const words = stripMarkers(text).replace(/\*\*|`/g, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 6).join(' ') + (words.length > 6 ? '…' : '');
}

/**
 * The tour-marker problems in [Unreleased] (tour C3, C13), one line each, empty when it keeps the rule: an Added or
 * Changed bullet with no marker, and anywhere in it a second marker, a tour marker with no id or an id `refs` lacks,
 * or a no-tour marker with no reason. Released sections are never read.
 */
function markerProblems(text, refs) {
  const out = [];
  for (const b of bullets(text, 'Unreleased')) {
    const where = `CHANGELOG.md:${b.line}: [Unreleased] ▸ ${b.sub ?? '(no subsection)'} "${firstWords(b.text)}"`;
    const found = [...b.text.matchAll(MARKER)];
    if (!found.length) {
      if (MARKED.has(b.sub)) out.push(`${where}: no tour marker — end it with <!-- tour: <chapter>[.<step>] --> or <!-- no-tour: <reason> -->`);
      continue;
    }
    if (found.length > 1) { out.push(`${where}: ${found.length} markers — keep one (several ids go in one tour marker, comma-separated)`); continue; }
    const [, kind, raw] = found[0];
    const value = raw.trim();
    if (kind === 'no-tour') {
      if (!value) out.push(`${where}: no-tour needs a reason (why nothing in the app shows it)`);
      continue;
    }
    const ids = value.split(',').map((id) => id.trim());
    if (!value || ids.some((id) => !id)) { out.push(`${where}: the tour marker names no id`); continue; }
    const unknown = ids.filter((id) => !refs.has(id));
    if (unknown.length) out.push(`${where}: unknown tour id ${unknown.join(', ')} — not a chapter id or <chapter>.<step> in ${STEPS}`);
  }
  return out;
}

/** steps.json's refs, or the reason it could not be read. */
function loadRefs(root) {
  try { return { refs: tourRefs(JSON.parse(fs.readFileSync(path.join(root, STEPS), 'utf8'))), error: null }; } catch (e) {
    return { refs: new Set(), error: `${STEPS}: cannot read it (${e.code || e.message}), so no tour id can be checked` };
  }
}

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Returns { text, changed, message }; throws when [Unreleased] is missing or empty and the version is not there yet. */
function roll(text, version, date = localDate()) {
  if (section(text, version) != null) return { text, changed: false, message: `CHANGELOG.md already has [${version}]` };
  const lines = text.split('\n');
  const b = bounds(lines, 'Unreleased');
  if (!b) throw new Error('no ## [Unreleased] section to roll');
  if (!lines.slice(b[0] + 1, b[1]).join('\n').trim()) throw new Error(`[Unreleased] is empty — write what ${version} changes first`);
  lines.splice(b[0], 1, '## [Unreleased]', '', `## [${version}] — ${date}`);
  const at = lines.findIndex((l) => /^\[Unreleased\]:\s*\S/.test(l));
  if (at !== -1) {
    const m = lines[at].match(/^\[Unreleased\]:\s*(\S+)\/compare\/(\S+?)\.\.\.HEAD\s*$/);
    if (m) lines.splice(at, 1, `[Unreleased]: ${m[1]}/compare/v${version}...HEAD`, `[${version}]: ${m[1]}/releases/tag/v${version}`);
  }
  return { text: lines.join('\n'), changed: true, message: `CHANGELOG.md: [Unreleased] rolled into [${version}] — ${date}` };
}

function currentVersion(root) { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; }

function main(argv = process.argv.slice(2), { root = ROOT, log = console.log, err = console.error } = {}) {
  const [verb, arg] = argv;
  const version = verb === 'check' && arg === 'current' ? currentVersion(root) : arg;
  if (!['notes', 'check', 'roll'].includes(verb) || !version || !SEMVER.test(version)) {
    err('usage: node tools/changelog.js notes|check|roll <x.y.z> (check also takes `current`; roll takes --date YYYY-MM-DD)');
    return 2;
  }
  const file = path.join(root, 'CHANGELOG.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { err('CHANGELOG.md: not found'); return 1; }
  if (verb === 'roll') {
    const i = argv.indexOf('--date');
    try {
      const r = roll(text, version, i !== -1 ? argv[i + 1] : undefined);
      if (r.changed) fs.writeFileSync(file, r.text);
      log(r.message);
      return 0;
    } catch (e) { err(`CHANGELOG.md: ${e.message}`); return 1; }
  }
  const body = section(text, version);
  const missing = body ? null : `CHANGELOG.md: ${body == null ? 'no' : 'an empty'} ## [${version}] section — run: node tools/changelog.js roll ${version}`;
  if (verb === 'notes') {
    if (missing) { err(missing); return 1; }
    log(stripMarkers(body));
    return 0;
  }
  // check: the version's section, and [Unreleased]'s tour markers (tour C13), every problem at once.
  const { refs, error } = loadRefs(root);
  const markers = markerProblems(text, refs);
  if (error && markers.some((p) => p.includes('unknown tour id'))) markers.unshift(error);
  if (missing) err(missing);
  for (const p of markers) err(p);
  if (markers.length) err(`changelog: ${markers.length} problem(s) in [Unreleased]'s tour markers (tour C13) — the rule is in tools/changelog.js's header`);
  if (missing || markers.length) return 1;
  log(`changelog: [${version}] present; [Unreleased] tour markers ok`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { section, roll, localDate, tourRefs, markerProblems, stripMarkers, main };
