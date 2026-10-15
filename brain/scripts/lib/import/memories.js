'use strict';
/**
 * import/memories.js — Claude Code's auto-memory into the vault (install-import B8).
 *
 *   <claude config dir>/projects/<project>/memory/<name>.md   (lib/host.js hostDirs('claude').sessions)
 *
 * Each file is one memory in the host's own shape (`name:`, `description:`, `type:` at the top or under `metadata:`;
 * lib/memory-fix.js's "types" fix reads the same shape): it keeps its type (user, feedback, reference; `project`
 * becomes the vault's `projects`; an unknown one is `reference`), its name as the title and its description, and is
 * written by common.js (dedup, then writeMemory with `source: import:claude`, `origin: ~/…`, `reviewed: false`).
 * The folder's MEMORY.md is its index, not a memory, and is skipped, as is a link, a file inside the vault and anything
 * over 256 KB. The same text in two projects' folders is imported once (its content hash).
 *
 * Codex keeps no memory files the importer reads: its built-in memories stay Codex's (`aos doctor` says so), and its
 * instructions come in through instructions.js. So this phase is Claude Code only.
 */
const fs = require('fs');
const path = require('path');
const C = require('./common.js');

const MAX_FILE = 256 * 1024;
const TYPE_MAP = { user: 'user', feedback: 'feedback', project: 'projects', projects: 'projects', reference: 'reference' };

function listDir(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }

/** Every auto-memory file: [{ file, project }] (project: its projects/<slug> folder name). */
function memoryFiles(dirs) {
  const out = [];
  if (!dirs || !dirs.sessions) return out;
  for (const p of listDir(dirs.sessions)) {
    if (!p.isDirectory()) continue;
    const dir = path.join(dirs.sessions, p.name, 'memory');
    for (const e of listDir(dir)) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.toLowerCase() === 'memory.md') continue;
      out.push({ file: path.join(dir, e.name), project: p.name });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function unquote(v) {
  const s = String(v || '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    if (s[0] === '"') { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** The host's frontmatter: { name, description, type, body } (any key missing is null). */
function parseAutoMemory(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*\n?/.exec(t);
  const out = { name: null, description: null, type: null, body: m ? t.slice(m[0].length) : t };
  if (!m) return out;
  let block = null;
  for (const line of m[1].split('\n')) {
    const top = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (top) {
      block = top[2] ? null : top[1];
      const v = unquote(top[2]);
      if (top[1] === 'name' && v) out.name = v;
      else if (top[1] === 'description' && v) out.description = v;
      else if (top[1] === 'type' && v) out.type = v.toLowerCase();
      continue;
    }
    const nested = /^[ \t]+([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (nested && block === 'metadata' && nested[1] === 'type' && !out.type) out.type = unquote(nested[2]).toLowerCase();
  }
  return out;
}

/** One auto-memory file as a candidate, or null when it holds nothing. */
function candidateOf(text, file) {
  const p = parseAutoMemory(text);
  let body = p.body.trim();
  const h1 = /^#[ \t]+(.+?)[ \t]*\n/.exec(body + '\n');
  const title = p.name || (h1 && h1[1]) || path.basename(file, '.md').replace(/[-_]+/g, ' ');
  // The writer puts the title as the body's heading: an H1 that says the same goes.
  if (h1 && C.plain(h1[1]).toLowerCase() === C.plain(title).toLowerCase()) body = body.slice(h1[0].length).trim();
  if (!body && !p.description) return null;
  return {
    type: TYPE_MAP[p.type] || 'reference',
    title,
    description: p.description || C.plain(body),
    body: body || p.description,
  };
}

/** What a scan reports: { files, new } (new: files whose text import-state.json has not seen). */
function scanMemories({ host, dirs, vault, state }) {
  const res = { files: 0, new: 0 };
  if (host !== 'claude') return res;
  for (const f of memoryFiles(dirs)) {
    if (C.insideVault(f.file, vault)) continue;
    const text = C.readRegular(f.file, MAX_FILE);
    if (text === null) continue;
    const cand = candidateOf(text, f.file);
    if (!cand) continue;
    res.files += 1;
    if (!state.hashes[C.contentHash(cand.body)]) res.new += 1;
  }
  return res;
}

/** Import Claude Code's auto-memory (module comment). Mutates `state.hashes`. → counts */
async function importMemories({ host, dirs, vault, state, dedup, home }) {
  const counts = { files: 0, written: 0, duplicates: 0, paths: [], byType: {} };
  if (host !== 'claude') return counts;
  const at = new Date().toISOString();
  for (const f of memoryFiles(dirs)) {
    if (C.insideVault(f.file, vault)) continue;
    const text = C.readRegular(f.file, MAX_FILE);
    if (text === null) continue;
    const cand = candidateOf(text, f.file);
    if (!cand) continue;
    counts.files += 1;
    const hash = C.contentHash(cand.body);
    if (state.hashes[hash]) { counts.duplicates += 1; continue; }
    const d = await dedup.check(cand);
    if (d.dup) {
      state.hashes[hash] = { kind: 'memory', host, path: d.path, duplicate: d.reason, at };
      counts.duplicates += 1;
      continue;
    }
    const rel = C.writeImported(vault, cand, { host, origin: C.tilde(f.file, home) });
    dedup.add({ title: C.safeTitle(cand.title), body: cand.body, path: rel });
    state.hashes[hash] = { kind: 'memory', host, path: rel, at };
    counts.written += 1;
    counts.paths.push(rel);
    counts.byType[cand.type] = (counts.byType[cand.type] || 0) + 1;
  }
  return counts;
}

module.exports = { memoryFiles, parseAutoMemory, candidateOf, scanMemories, importMemories, TYPE_MAP };
