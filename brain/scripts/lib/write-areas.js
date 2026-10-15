'use strict';
/**
 * write-areas.js — where a routine may never write, and why: the one rule its runners enforce when it runs and its
 * editors check before it is saved. The runners are persona/duty-guard.js (a duty's write scope, spec
 * 2026-09-23-duty-write-scope D5/D6) and lib/local-agent.js (a prompt routine on the local engine, local-first A7); the
 * editors are lib/routines-store.js validate() and the Workbench's Routines editor, whose obsidian-plugin/src/data/
 * routines.ts imports this file as it is. So it stays pure: no file system, nothing from Node but `path.posix` (the
 * app's page gives `path` its POSIX shim); write-areas.d.ts types it for the TypeScript that imports it.
 *
 *   refusal(rel)               a path no write scope may name, hold or sit in: the vault itself, an absolute path, `..`,
 *                              a dot-segment, the guarded persona files (GUARDED, LEDGER) and the executable areas
 *                              (EXECUTABLE: the runtime, the routine files, workspaces/), compared folded (fold)
 *   localDenied(p)             what feeds hosted sessions (LOCAL_DENY), which a local routine never writes (PR 4 review)
 *   vaultRel(p, opts)          a path the local agent is given → { rel } (vault-relative, POSIX) or { why }
 *   localPathRefusal(rel)      a path a local routine writes: refusal, then localDenied (local-agent.js writable)
 *   localWritesRefusal(entry)  a prompt routine's `writes` entry as the local agent compiles it (compileWrites): a glob
 *                              by its folder part
 *   localOutputRefusal(file)   a prompt routine's `output` file as the local agent appends its answer to it (deliver)
 *   dutyWritesRefusal(entry)   a duty's `writes` entry as duty-guard.js's write scope takes it (writeScope)
 * Each refusal is the reason as the runner logs it, or null.
 */
const path = require('path');

/** D6: what decides what runs and what is trusted. The ledger is guarded separately (append-only, `filed` only). */
const GUARDED = ['persona/IDENTITY.md', 'persona/duties/', 'persona/routines/', 'persona/autoapply.json', 'persona/flag-closer/', 'persona/repos.json'];
const LEDGER = 'persona/ledger.jsonl';
/** Never writable by a routine, on top of GUARDED: code, schedules, other projects. */
const EXECUTABLE = ['brain/scripts/', 'brain/routines/', 'workspaces/'];

/**
 * What a local routine may never write, as a writes entry or an output target (the PR 4 security review): the files
 * that feed hosted sessions. A folder holds everything under it; a name is any file of that name; AGENTICOS.md only at
 * the vault root. On top of refusal(), and only for local routines: duties keep their own rule.
 */
const LOCAL_DENY = [
  { label: 'persona/', dir: true, why: "the Chief of Staff's files" },
  { label: 'brain/memory/', dir: true, why: 'memories feed every session' },
  { label: 'brain/_index/', dir: true, why: "the session bootstrap and the runtime's caches" },
  { label: 'AGENTICOS.md', root: true, why: 'it feeds every session' },
  { label: 'MEMORY.md', why: 'it feeds every session' },
  { label: 'CLAUDE.md', why: 'host instructions feed every session' },
  { label: 'AGENTS.md', why: 'host instructions feed every session' },
];

const GLOB = /[*?]/;

/** A path as a case-insensitive, normalization-insensitive file system (APFS) sees it: NFC, case-folded (upper then
 *  lower, so U+017F LONG S and the Kelvin sign fold to s and k as they do there). */
function fold(p) { return String(p).normalize('NFC').toUpperCase().toLowerCase().normalize('NFC'); }

/** Why a write-scope path is refused, or null. `rel` is posix, normalized, without a trailing slash. The guarded and
 *  executable areas are compared folded (fold), so `Persona/IDENTITY.md` is refused like `persona/IDENTITY.md`. */
function refusal(rel) {
  if (!rel || rel === '.' || rel === '/') return 'the vault itself';
  if (path.posix.isAbsolute(rel)) return 'an absolute path';
  const segs = rel.split('/');
  if (segs.includes('..')) return 'a path leaving the vault';
  if (segs.some((s) => s.startsWith('.'))) return 'a dot-folder or dot-file';
  const f = fold(rel);
  for (const g of [...GUARDED, LEDGER, ...EXECUTABLE]) {
    const gr = fold(g.replace(/\/$/, ''));
    if (f === gr || f.startsWith(`${gr}/`)) return `guarded (${g})`;
    if (gr.startsWith(`${f}/`)) return `it holds a guarded path (${g})`;
  }
  return null;
}

/** Why a local routine may not write `p` (a vault-relative path, or a writes entry with * ** ?), or null. Compared
 *  folded; a glob by its folder part. */
function localDenied(p) {
  const s = fold(String(p || '').trim().replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const segs = s.split('/');
  const g = segs.findIndex((x) => GLOB.test(x));
  const fixed = (g === -1 ? segs : segs.slice(0, g)).join('/');
  const name = g === -1 ? segs[segs.length - 1] : null;
  for (const d of LOCAL_DENY) {
    const f = fold(d.label).replace(/\/$/, '');
    if (d.dir ? (fixed === f || fixed.startsWith(`${f}/`) || f.startsWith(`${fixed}/`) || !fixed) : d.root ? (g === -1 && s === f) : name === f) return `${d.label}: ${d.why}`;
  }
  return null;
}

/** A path the local agent is given → { rel } under the vault (POSIX, normalized, no trailing slash), or { why } it is
 *  refused. `allowRoot` lets nothing, '' or '.' name the vault itself (rel ''). */
function vaultRel(p, { allowRoot = false } = {}) {
  if (p === undefined || p === null) return allowRoot ? { rel: '' } : { why: 'path is required' };
  if (typeof p !== 'string') return { why: 'path must be a string' };
  const s = p.trim().replace(/\\/g, '/');
  if (s.includes('\0')) return { why: 'a NUL in the path' };
  if (s === '' || s === '.' || s === './') return allowRoot ? { rel: '' } : { why: 'path is required' };
  if (s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:/.test(s)) return { why: 'an absolute path: paths are relative to the vault' };
  const rel = path.posix.normalize(s).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const segs = rel.split('/');
  if (segs.includes('..')) return { why: 'a path leaving the vault' };
  if (rel === '.' || rel === '') return allowRoot ? { rel: '' } : { why: 'path is required' };
  if (segs.some((x) => x.startsWith('.'))) return { why: 'a dot-folder or dot-file' };
  return { rel };
}

/** Why a local routine may not write the vault-relative path `rel`, or null. */
function localPathRefusal(rel) { return refusal(rel) || localDenied(rel); }

/** A `writes` entry as the local agent reads it: `s` as written (trimmed, forward slashes), `dir` (a trailing /),
 *  `body` (normalized, no trailing /), and for a glob its folder part `fixed` (the segments before the first wildcard). */
function writesEntry(entry) {
  const s = String(entry).trim().replace(/\\/g, '/');
  const body = path.posix.normalize(s.replace(/\/+$/, '') || '.').replace(/^(\.\/)+/, '');
  const glob = GLOB.test(body);
  const segs = body.split('/');
  return { s, dir: s.endsWith('/'), body, glob, fixed: glob ? segs.slice(0, segs.findIndex((x) => GLOB.test(x))).join('/') : body };
}

/** Why the local agent refuses a prompt routine's `writes` entry, or null. */
function localWritesRefusal(entry) {
  const e = writesEntry(entry);
  return refusal(e.fixed) || localDenied(e.s);
}

/** Why the local agent cannot append its answer to `file` (a prompt routine's `output`), as far as the name tells. */
function localOutputRefusal(file) {
  const v = vaultRel(file);
  return v.why || localPathRefusal(v.rel);
}

/** A write-scope entry as duty-guard.js reads it: `rel` (posix, normalized, no trailing /) and `dir` (a trailing /). */
function normEntry(entry) {
  const dir = entry.endsWith('/');
  const rel = path.posix.normalize(entry.replace(/\\/g, '/').replace(/\/+$/, ''));
  return { rel, dir };
}

/** Why duty-guard.js leaves a duty's `writes` entry out of its write scope, or null. */
function dutyWritesRefusal(entry) { return refusal(normEntry(String(entry).trim()).rel); }

module.exports = {
  GUARDED, LEDGER, EXECUTABLE, LOCAL_DENY,
  fold, refusal, localDenied, vaultRel, localPathRefusal, writesEntry, localWritesRefusal, localOutputRefusal, normEntry, dutyWritesRefusal,
};
