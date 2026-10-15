'use strict';
/**
 * import/instructions.js — a host's global instructions into memories (install-import B8).
 *
 *   Claude Code  <claude config dir>/CLAUDE.md              (lib/host.js hostDirs('claude').configDir)
 *   Codex        <codex home>/AGENTS.md, AGENTS.override.md  (hostDirs('codex').configDir)
 *
 * A file is split by heading and bullet into rules (splitRules): each top-level bullet, numbered item or paragraph is
 * one rule, its nested lines and code blocks kept with it, under the headings above it. An `@path` include line (the
 * `@<vault>/AGENTICOS.md` line among them) is never followed and never copied, nor is an HTML comment. With the local
 * engine (provider.js resolves `ollama`) the rules are classified as user, feedback or reference, 30 to a call, in JSON
 * through Ollama's `format`; without it (B15: nothing is sent to a hosted model) the whole file becomes one `reference`
 * memory. Each memory goes through common.js: dedup, then writeMemory with `source: import:<host>`, `origin: ~/…`,
 * `reviewed: false`.
 *
 * Skipped: a file whose real path is inside the vault (the vault's own files), and a project's CLAUDE.md or AGENTS.md
 * (only the global files are read: a project's stays in its repository, which its workspace links through `repo:`).
 * Idempotent: a file whose text is unchanged since its last import is skipped whole; a changed one adds only rules
 * whose hash import-state.json has not seen.
 */
const path = require('path');
const C = require('./common.js');

const MAX_FILE = 256 * 1024;
const CHUNK = 30;
const MIN_RULE_CHARS = 8;
const TYPES = ['user', 'feedback', 'reference'];

/** The global instruction files a host keeps: [{ host, file, name }] (missing ones left out). */
function instructionFiles(host, dirs) {
  const names = host === 'codex' ? ['AGENTS.md', 'AGENTS.override.md'] : ['CLAUDE.md'];
  const out = [];
  for (const name of names) {
    const file = path.join(dirs.configDir, name);
    if (C.readRegular(file, MAX_FILE) !== null) out.push({ host, file, name });
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const ITEM = /^( {0,1})(?:[-*+]|\d+[.)])[ \t]+(.*)$/;
const INCLUDE = /^\s*@[^\s@]+\s*$/;
const COMMENT = /^\s*<!--[\s\S]*?-->\s*$/;

/** The text a rule is made of, minus the lines never copied (module comment). */
function cleanText(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n').filter((l) => !INCLUDE.test(l) && !COMMENT.test(l)).join('\n');
}

/** Split markdown into rules: [{ heading: 'A › B' | null, text }] (module comment). */
function splitRules(text) {
  const lines = cleanText(text).split('\n');
  const rules = [];
  const heads = [];
  let cur = null;
  let fence = null;
  const headingPath = () => (heads.length ? heads.map((h) => h.text).join(' › ') : null);
  const flush = () => {
    if (!cur) return;
    const t = cur.lines.join('\n').replace(/\s+$/, '').replace(/^\n+/, '');
    if (C.plain(t).replace(/[^A-Za-z0-9]/g, '').length >= MIN_RULE_CHARS) rules.push({ heading: cur.heading, text: t });
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const f = FENCE.exec(line);
    if (fence) {
      if (cur) cur.lines.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f.index + f[0].length).trim()) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      // An indented fence belongs to the item above it; one at the margin starts a rule of its own.
      if (cur && cur.kind === 'item' && !/^\s/.test(line)) flush();
      if (!cur) cur = { heading: headingPath(), kind: 'para', lines: [] };
      cur.lines.push(line);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      while (heads.length && heads[heads.length - 1].level >= level) heads.pop();
      heads.push({ level, text: C.plain(h[2]) });
      continue;
    }
    const it = ITEM.exec(line);
    if (it) {
      flush();
      cur = { heading: headingPath(), kind: 'item', lines: [it[2]] };
      continue;
    }
    if (!line.trim()) {
      if (cur && cur.kind === 'para') flush();
      else if (cur) cur.lines.push('');
      continue;
    }
    if (cur && cur.kind === 'item' && /^\s/.test(line)) { cur.lines.push(line); continue; }
    if (cur && cur.kind === 'para') { cur.lines.push(line); continue; }
    flush();
    cur = { heading: headingPath(), kind: 'para', lines: [line] };
  }
  flush();
  return rules;
}

/** One rule as a memory candidate of `type`. */
function ruleCandidate(rule, type, { origin }) {
  const flat = C.plain(rule.text);
  return {
    type,
    title: C.safeTitle(flat),
    description: C.safeDesc(rule.heading ? `${rule.heading}: ${flat}` : flat),
    body: `${rule.text.trim()}\n\n_Imported from \`${origin}\`${rule.heading ? ` › ${rule.heading}` : ''}._`,
  };
}

/** The whole file as one reference memory (no engine). */
function fileCandidate(host, text, { origin }) {
  const label = host === 'codex' ? 'Codex global instructions' : 'Claude Code global instructions';
  const body = cleanText(text).trim();
  return {
    type: 'reference',
    title: `${label} (${path.basename(origin)})`,
    description: `The standing instructions in ${origin}, imported whole`,
    body: `${body}\n\n_Imported from \`${origin}\`. It became one note because no local model was available to sort it into rules._`,
  };
}

const CLASSIFY_SYSTEM = [
  'You sort a developer\'s standing instructions to their coding agent into memory types.',
  'user: a fact about the person (their role, background, how they like to work or be addressed).',
  'feedback: a rule for how the agent should behave (do, avoid, always, never, prefer, a correction).',
  'reference: where something is or how a tool works (a path, a URL, a command, a system, a credential location).',
  'Answer with JSON only: {"types": [...]}, one type per numbered rule, in order.',
].join(' ');
const CLASSIFY_FORMAT = {
  type: 'object',
  properties: { types: { type: 'array', items: { type: 'string', enum: TYPES } } },
  required: ['types'],
};

/** Types for `rules` from the local model, 30 at a time; throws when the engine fails (the caller goes whole-file). */
async function classify(rules, chat) {
  const { parseAgentJson } = require('../../sdk/lib/json-extract.js');
  const out = [];
  for (let i = 0; i < rules.length; i += CHUNK) {
    const part = rules.slice(i, i + CHUNK);
    const prompt = part.map((r, j) => `${j + 1}. ${C.cut(C.plain(`${r.heading ? `${r.heading}: ` : ''}${r.text}`), 400)}`).join('\n');
    const reply = await chat({ system: CLASSIFY_SYSTEM, prompt, format: CLASSIFY_FORMAT, numPredict: 32 + part.length * 12, feature: 'import' });
    let types = [];
    try { const j = parseAgentJson(reply); types = Array.isArray(j) ? j : Array.isArray(j && j.types) ? j.types : []; } catch { types = []; }
    // A rule the model left out, or typed outside the three, is a rule for the agent: feedback.
    for (let j = 0; j < part.length; j++) out.push(TYPES.includes(types[j]) ? types[j] : 'feedback');
  }
  return out;
}

/** What a scan reports for one host: { files, rules, new } (new: rules, or files, import-state has not seen). */
function scanInstructions({ host, dirs, vault, state }) {
  const res = { files: 0, rules: 0, new: 0, skipped: [] };
  for (const f of instructionFiles(host, dirs)) {
    if (C.insideVault(f.file, vault)) { res.skipped.push({ file: f.name, reason: 'inside the vault' }); continue; }
    const text = C.readRegular(f.file, MAX_FILE);
    const rules = splitRules(text);
    res.files += 1;
    res.rules += rules.length;
    const seen = state.files[`${host}:${f.name}`];
    if (seen && seen.hash === C.contentHash(cleanText(text))) continue;
    res.new += rules.filter((r) => !state.hashes[C.contentHash(r.text)]).length || (rules.length ? 0 : 1);
  }
  return res;
}

/**
 * Import one host's instruction files. deps: { chat (the local engine's chat, or null), dedup (common.Deduper),
 * home, now }. Mutates `state` (hashes, files); writes memories. → counts { files, rules, written, duplicates, skipped,
 * mode: 'rules' | 'whole' | null, paths }
 */
async function importInstructions({ host, dirs, vault, state, chat = null, dedup, home }) {
  const counts = { files: 0, rules: 0, written: 0, duplicates: 0, unchanged: 0, mode: null, paths: [], skipped: [] };
  const at = new Date().toISOString();
  for (const f of instructionFiles(host, dirs)) {
    if (C.insideVault(f.file, vault)) { counts.skipped.push({ file: f.name, reason: 'inside the vault' }); continue; }
    const text = C.readRegular(f.file, MAX_FILE);
    const fileHash = C.contentHash(cleanText(text));
    const key = `${host}:${f.name}`;
    counts.files += 1;
    if (state.files[key] && state.files[key].hash === fileHash) { counts.unchanged += 1; continue; }
    const origin = C.tilde(f.file, home);
    const rules = splitRules(text);
    counts.rules += rules.length;
    let mode = 'whole';
    let types = null;
    if (chat && rules.length) {
      try { types = await classify(rules, chat); mode = 'rules'; } catch { types = null; mode = 'whole'; }
    }
    const cands = mode === 'rules'
      ? rules.map((r, i) => ({ cand: ruleCandidate(r, types[i], { origin }), hash: C.contentHash(r.text) }))
      : (cleanText(text).trim() ? [{ cand: fileCandidate(host, text, { origin }), hash: fileHash }] : []);
    for (const { cand, hash } of cands) {
      if (state.hashes[hash]) { counts.duplicates += 1; continue; }
      const d = await dedup.check(cand);
      if (d.dup) {
        state.hashes[hash] = { kind: mode === 'rules' ? 'rule' : 'instructions', host, path: d.path, duplicate: d.reason, at };
        counts.duplicates += 1;
        continue;
      }
      const rel = C.writeImported(vault, cand, { host, origin });
      dedup.add({ title: C.safeTitle(cand.title), body: cand.body, path: rel });
      state.hashes[hash] = { kind: mode === 'rules' ? 'rule' : 'instructions', host, path: rel, at };
      counts.written += 1;
      counts.paths.push(rel);
    }
    state.files[key] = { hash: fileHash, mode, origin, at };
    counts.mode = counts.mode && counts.mode !== mode ? 'mixed' : mode;
  }
  return counts;
}

module.exports = { instructionFiles, splitRules, cleanText, scanInstructions, importInstructions, classify, CLASSIFY_FORMAT };
