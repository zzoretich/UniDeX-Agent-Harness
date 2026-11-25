'use strict';
/**
 * teams.js — the store behind `aos team` (spec 2026-09-28-agent-teams-design). A team lives in
 * <vault>/persona/teams/<id>/:
 *
 *   TEAM.md           roster and policy in frontmatter: a strict YAML subset (`key: value`, inline `[a, b]` and
 *                     `{a: 1}`, and one `members:` list of flat maps), which `set` and `member` rewrite line by line
 *   board.jsonl       work items, append-only snapshots; the last row for an id is the item (D1)
 *   channel.jsonl     the team's thread, one post per line
 *   runs.jsonl        one row per finished run (team-run.js)
 *   running/<run>.json  a live run's marker: the dispatcher's pid and host, until its row lands (D7)
 *   STATE.md          the lead's three lines; DISABLED  the kill switch
 *
 * Every board write holds the board's fsx lock. `put` is the lead's write; `expect` makes any write a compare-and-set
 * against the item's snapshot (D3). The user's decisions (gates, budgets, pause, set, members) are refused under
 * AOS_HEADLESS=1, so no dispatched seat or duty can record one (D4). Readers skip a line that does not parse: a bad
 * complete line is someone's hand edit, an unparsable last line is an append still in flight.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const fsx = require('./fsx.js');

const KINDS = ['note', 'assign', 'handoff', 'done', 'blocker', 'gate', 'question'];
const DEFAULT_STAGES = ['discuss', 'plan', 'execute', 'verify', 'ship'];
const STATUSES = ['todo', 'working', 'blocked', 'gate', 'paused', 'done'];
const GATE_STATES = ['pending', 'approved', 'redirected'];
const PROVIDERS = ['claude', 'codex', 'opposite'];
const EFFORTS = ['inherit', 'low', 'medium', 'high'];
const SET_KEYS = ['provider', 'model', 'effort'];
const MAX_TEXT = 4000;
const ID_RE = /^[a-z][a-z0-9-]{0,40}$/;
const ITEM_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const AGENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/;
const WAIT_POLL_MS = 2000;
const START_GRACE_MS = 120000;

/** A refusal: the request is well formed, the team's state says no (exit 1). */
class Refusal extends Error {}
/** A malformed request (exit 2). */
class UsageError extends Error {}

function teamsRoot(vault) { return path.join(vault, 'persona', 'teams'); }

// ── TEAM.md ──

function parseScalar(s) {
  s = s.trim();
  if (s === '') return '';
  if (s === 'null' || s === '~') return null;
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) return JSON.parse(s);
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map(parseScalar) : [];
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const o = {};
    const inner = s.slice(1, -1).trim();
    if (inner) for (const part of inner.split(',')) {
      const i = part.indexOf(':');
      if (i < 0) throw new Error(`bad inline map entry: ${part}`);
      o[part.slice(0, i).trim()] = parseScalar(part.slice(i + 1));
    }
    return o;
  }
  return s;
}

/** A value written back into TEAM.md: plain when the subset reads it back unchanged, JSON-quoted otherwise. */
function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return /^[A-Za-z][A-Za-z0-9 ._/@+-]*$/.test(s) && parseScalar(s) === s ? s : JSON.stringify(s);
}

function frontmatterBounds(lines) {
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  return end > 0 ? { start: 1, end } : null;
}

function parseFrontmatter(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const b = frontmatterBounds(lines);
  if (!b) throw new Error('TEAM.md has no frontmatter');
  const out = {};
  let list = null;
  let cur = null;
  for (const raw of lines.slice(b.start, b.end)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    let m;
    if ((m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(raw))) {
      cur = null;
      list = m[2] === '' ? (out[m[1]] = []) : null;
      if (m[2] !== '') out[m[1]] = parseScalar(m[2]);
    } else if (list && (m = /^\s+-\s+([\w-]+):\s*(.*)$/.exec(raw))) {
      cur = { [m[1]]: parseScalar(m[2]) };
      list.push(cur);
    } else if (cur && (m = /^\s+([\w-]+):\s*(.*)$/.exec(raw))) {
      cur[m[1]] = parseScalar(m[2]);
    } else {
      throw new Error(`unsupported TEAM.md line: ${raw.trim()}`);
    }
  }
  return out;
}

/** The lines of the members list and each member block: { listStart, listEnd, blocks: [{ id, start, end }], dash, key }. */
function memberBlocks(lines) {
  const b = frontmatterBounds(lines);
  if (!b) throw new Error('TEAM.md has no frontmatter');
  const at = lines.findIndex((l, i) => i >= b.start && i < b.end && /^members:\s*$/.test(l));
  if (at < 0) return { listStart: -1, listEnd: -1, blocks: [], dash: '  ', key: '    ', fmEnd: b.end };
  let listEnd = at + 1;
  while (listEnd < b.end && (lines[listEnd].trim() === '' || /^\s/.test(lines[listEnd]))) listEnd++;
  const blocks = [];
  let dash = '  ';
  let key = '    ';
  for (let i = at + 1; i < listEnd; i++) {
    const m = /^(\s+)-\s+id:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (blocks.length) blocks[blocks.length - 1].end = i;
    dash = m[1];
    key = `${m[1]}  `;
    blocks.push({ id: String(parseScalar(m[2])), start: i, end: listEnd });
  }
  // Trailing blank lines belong to the list, not to its last member.
  if (blocks.length) { const last = blocks[blocks.length - 1]; while (last.end - 1 > last.start && !lines[last.end - 1].trim()) last.end--; }
  return { listStart: at, listEnd, blocks, dash, key, fmEnd: b.end };
}

/** TEAM.md text with one member's key set to `value` (added when the block lacks it). */
function rewriteMember(text, memberId, key, value) {
  const lines = String(text).split('\n');
  const mb = memberBlocks(lines);
  const blk = mb.blocks.find((x) => x.id === memberId);
  if (!blk) throw new Refusal(`${memberId} is not a member`);
  const re = new RegExp(`^(\\s+)${key}:\\s*(.*)$`);
  for (let i = blk.start + 1; i < blk.end; i++) {
    const m = re.exec(lines[i]);
    if (m) { lines[i] = `${m[1]}${key}: ${formatScalar(value)}`; return lines.join('\n'); }
  }
  lines.splice(blk.end, 0, `${mb.key}${key}: ${formatScalar(value)}`);
  return lines.join('\n');
}

/** TEAM.md text with a member block appended (`fields` in order) or removed. */
function addMemberBlock(text, fields) {
  const lines = String(text).split('\n');
  const mb = memberBlocks(lines);
  const [first, ...rest] = Object.entries(fields);
  const block = [`${mb.dash}- ${first[0]}: ${formatScalar(first[1])}`, ...rest.map(([k, v]) => `${mb.key}${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : formatScalar(v)}`)];
  if (mb.listStart < 0) { lines.splice(mb.fmEnd, 0, 'members:', ...block); return lines.join('\n'); }
  const after = mb.blocks.length ? mb.blocks[mb.blocks.length - 1].end : mb.listStart + 1;
  lines.splice(after, 0, ...block);
  return lines.join('\n');
}
function removeMemberBlock(text, memberId) {
  const lines = String(text).split('\n');
  const blk = memberBlocks(lines).blocks.find((x) => x.id === memberId);
  if (!blk) throw new Refusal(`${memberId} is not a member`);
  lines.splice(blk.start, blk.end - blk.start);
  return lines.join('\n');
}

function teamDir(root, id) {
  if (!ID_RE.test(id || '')) throw new UsageError(`bad team id: ${id || '(none)'}`);
  const dir = path.join(root, id);
  if (!fs.existsSync(path.join(dir, 'TEAM.md'))) throw new Refusal(`no team ${id} (${path.join('persona', 'teams', id, 'TEAM.md')} is missing)`);
  return dir;
}

/** The team as its TEAM.md says, plus { dir, root, vault, disabled, stages }. */
function readTeam(root, id) {
  const dir = teamDir(root, id);
  const t = parseFrontmatter(fs.readFileSync(path.join(dir, 'TEAM.md'), 'utf8'));
  t.id = t.id || id;
  if (!Array.isArray(t.members)) t.members = [];
  t.stages = Array.isArray(t.stages) && t.stages.length ? t.stages.map(String) : DEFAULT_STAGES;
  t.gates = Array.isArray(t.gates) ? t.gates.map(String) : [];
  t.dir = dir;
  t.root = root;
  t.vault = path.resolve(root, '..', '..');
  t.disabled = fs.existsSync(path.join(dir, 'DISABLED'));
  return t;
}

function listTeams(root) {
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.filter((n) => ID_RE.test(n) && fs.existsSync(path.join(root, n, 'TEAM.md'))).sort();
}

// ── JSONL ──

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object' && !Array.isArray(r)) rows.push(r); } catch { /* hand edit or torn append */ }
  }
  return rows;
}
function appendJsonl(file, obj) { fsx.appendLineSync(file, JSON.stringify(obj)); }

function boardItems(t) {
  const latest = new Map();
  for (const r of readJsonl(path.join(t.dir, 'board.jsonl'))) if (typeof r.id === 'string') latest.set(r.id, r);
  return latest;
}
function owners(it) {
  if (it.owner == null || it.owner === '') return [];
  return Array.isArray(it.owner) ? it.owner.map(String) : [String(it.owner)];
}
function member(t, id) { return t.members.find((m) => m.id === id) || null; }
function leadOf(t) { return member(t, t.lead); }

// ── channel ──

function post(t, { from, item, kind = 'note', text }, { now = new Date() } = {}) {
  const allowed = new Set([...t.members.map((m) => m.id), t.reportsTo, 'user', 'dispatch'].filter(Boolean));
  if (!allowed.has(from)) throw new UsageError(`--from must be a member of ${t.id}, user or dispatch: got ${from || 'nothing'}`);
  if (!KINDS.includes(kind)) throw new UsageError(`--kind must be one of ${KINDS.join(', ')}`);
  if (!text || !String(text).trim()) throw new UsageError('nothing to post');
  if (item && !boardItems(t).has(item)) throw new Refusal(`no board item ${item} on ${t.id}`);
  const row = { schema: 1, ts: now.toISOString(), team: t.id, from, item: item || null, kind, text: String(text).trim().slice(0, MAX_TEXT) };
  appendJsonl(path.join(t.dir, 'channel.jsonl'), row);
  return row;
}
function tail(t, { n = 20, item } = {}) {
  let rows = readJsonl(path.join(t.dir, 'channel.jsonl'));
  if (item) rows = rows.filter((r) => r.item === item);
  return rows.slice(-n);
}

// ── board writes ──

function withLock(file, fn) { return fsx.withLockSync(file, fn, { timeoutMs: 10000 }); }
function withBoard(t, fn) { return withLock(path.join(t.dir, 'board.jsonl'), fn); }

/** True when `want`, a partial object, matches `have`: objects key by key (recursively), anything else by JSON equality. */
function matches(have, want) {
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    if (!have || typeof have !== 'object' || Array.isArray(have)) return false;
    return Object.keys(want).every((k) => matches(have[k], want[k]));
  }
  return JSON.stringify(have === undefined ? null : have) === JSON.stringify(want === undefined ? null : want);
}

function checkExpect(id, existing, expect) {
  if (expect === undefined || expect === null) return;
  let want = expect;
  if (typeof expect === 'string') {
    try { want = JSON.parse(expect); } catch (e) { throw new UsageError(`--expect is not JSON: ${e.message}`); }
  }
  if (!want || typeof want !== 'object' || Array.isArray(want)) throw new UsageError('--expect must be a JSON object');
  if (!existing) throw new Refusal(`--expect failed: no board item ${id}; nothing written`);
  const miss = Object.keys(want).filter((k) => !matches(existing[k], want[k]));
  if (miss.length) {
    const now = miss.map((k) => `${k} is ${JSON.stringify(existing[k] === undefined ? null : existing[k])}`).join('; ');
    throw new Refusal(`--expect failed on ${id}: ${now}; nothing written`);
  }
}

/** Validate and append the next snapshot of an item. The caller holds withBoard. */
function writeItem(t, patch, { by, now = new Date(), existing }) {
  const prev = existing || {
    id: patch.id, project: null, path: null, phase: null, title: '', stage: t.stages[0], owner: null, status: 'todo', gate: null,
    budget: { usd: (t.budget && Number(t.budget.default)) || 0, spentUsd: 0, codexRuns: 0 }, builders: { claude: [], codex: [] },
  };
  const next = { ...prev, ...patch };
  if (patch.budget) next.budget = { ...prev.budget, ...patch.budget };
  if (patch.builders) next.builders = { ...prev.builders, ...patch.builders };
  if (!t.stages.includes(next.stage)) throw new UsageError(`stage must be one of ${t.stages.join(', ')}`);
  if (!STATUSES.includes(next.status)) throw new UsageError(`status must be one of ${STATUSES.join(', ')}`);
  const ids = new Set(t.members.map((m) => m.id));
  for (const o of owners(next)) if (!ids.has(o)) throw new UsageError(`owner ${o} is not on ${t.id}`);
  if (next.gate != null) {
    if (!t.gates.includes(next.gate.name)) throw new UsageError(`gate must be one of ${t.gates.join(', ') || '(none: TEAM.md lists no gates)'}`);
    if (!GATE_STATES.includes(next.gate.state)) throw new UsageError(`gate state must be one of ${GATE_STATES.join(', ')}`);
  }
  // An item's snapshots are strictly ordered by ts: one written in the same millisecond as the item's last (or behind
  // it, after a clock step) is stamped 1 ms later, so every change moves ts and an --expect naming it catches the change.
  const last = Date.parse((existing && existing.ts) || '');
  const at = Number.isFinite(last) && now.getTime() <= last ? new Date(last + 1) : now;
  const row = { schema: 1, ...next, ts: at.toISOString(), by };
  appendJsonl(path.join(t.dir, 'board.jsonl'), row);
  return row;
}

function parsePatch(json) {
  let patch = json;
  if (typeof json === 'string') {
    try { patch = JSON.parse(json); } catch (e) { throw new UsageError(`patch is not JSON: ${e.message}`); }
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new UsageError('patch must be a JSON object');
  if (!ITEM_RE.test(patch.id || '')) throw new UsageError('patch needs an "id" (lowercase letters, digits, . _ -)');
  return patch;
}

/** What `put` may never change, because the user decides it (gates, budgets) or dispatch records it (spend, builders):
 *  a seat that calls `put --from <lead>` can still not approve its own gate or raise its budget (AT-01). */
function guardPut(existing, patch) {
  const cur = existing || {};
  const g = patch.gate;
  if (g && g.state && g.state !== 'pending' && !matches(cur.gate, g)) throw new Refusal(`a ${g.state} gate is the user's decision: aos team gate approve|redirect records it`);
  // A pending gate is closed only by the user's decision: put can neither clear, replace nor walk past it (AT-R1).
  if (cur.gate && cur.gate.state === 'pending') {
    if (patch.gate !== undefined && !matches(cur.gate, patch.gate)) throw new Refusal(`${cur.id} waits on the user at the ${cur.gate.name} gate; aos team gate approve|redirect closes it`);
    if ((patch.status !== undefined && patch.status !== cur.status) || (patch.stage !== undefined && patch.stage !== cur.stage)) throw new Refusal(`${cur.id} waits on the user at the ${cur.gate.name} gate; its stage and status stay until the user decides`);
  }
  const b = patch.budget || {};
  for (const k of ['usd', 'spentUsd', 'codexRuns']) {
    if (b[k] !== undefined && Number(b[k]) !== Number((cur.budget || {})[k] || 0)) throw new Refusal(k === 'usd' ? "the phase budget is the user's decision: aos team budget sets it" : `budget.${k} is recorded by dispatch`);
  }
  if (patch.builders !== undefined && !matches(cur.builders || null, patch.builders)) throw new Refusal('builders are recorded by dispatch when a seat merges its work');
}

/** The lead's board write: merges `json` into the item's last snapshot. Holds the lock unless `locked` says the caller does. */
function put(t, { from, json, expect, now, locked = false }) {
  const run = () => {
    if (from !== t.lead) throw new Refusal(`only the lead (${t.lead}) writes the ${t.id} board`);
    const patch = parsePatch(json);
    const existing = boardItems(t).get(patch.id) || null;
    checkExpect(patch.id, existing, expect);
    guardPut(existing, patch);
    return writeItem(t, patch, { by: from, now, existing });
  };
  return locked ? run() : withBoard(t, run);
}

// ── the user's decisions (D4, D10) ──

function assertInteractive(env, what) {
  if (env && env.AOS_HEADLESS === '1') throw new Refusal(`${what} is the user's decision, and a headless run cannot record it`);
}
function titleCase(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
function usdOf(v, flag = '--usd') {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) throw new UsageError(`${flag} must be a dollar amount above 0`);
  return Math.round(n * 100) / 100;
}

/** Approve or redirect the gate pending on an item. Approve moves it to the next stage with the lead as owner. */
function decideGate(t, { item, verb, usd, note, expect, env = process.env, now = new Date() }) {
  assertInteractive(env, `A ${verb === 'redirect' ? 'redirect' : 'gate approval'}`);
  if (!['approve', 'redirect'].includes(verb)) throw new UsageError('gate takes approve or redirect');
  if (expect === undefined) throw new UsageError('--expect is required: pass the state you decided on');
  if (verb === 'redirect' && !(note && String(note).trim())) throw new UsageError('a redirect needs --note saying what should change');
  const row = withBoard(t, () => {
    const cur = boardItems(t).get(item) || null;
    if (!cur) throw new Refusal(`no board item ${item} on ${t.id}`);
    checkExpect(item, cur, expect);
    const g = cur.gate || null;
    if (cur.status !== 'gate' || !g || g.state !== 'pending') throw new Refusal(`no gate is pending on ${item} (it is ${cur.stage}/${cur.status})`);
    const gate = { name: g.name, state: verb === 'approve' ? 'approved' : 'redirected', by: 'user', ts: now.toISOString(), note: String(note || '').trim() };
    const patch = { id: item, status: 'working', owner: t.lead, gate };
    if (verb === 'approve') {
      const i = t.stages.indexOf(cur.stage);
      patch.stage = t.stages[Math.min(i + 1, t.stages.length - 1)] || cur.stage;
      if (usd !== undefined) {
        const amount = usdOf(usd);
        const spent = Number((cur.budget && cur.budget.spentUsd) || 0);
        const held = liveMarkers(t).filter((x) => x.item === item && x.provider === 'claude').reduce((s, x) => s + (Number(x.reservedUsd) || 0), 0);
        if (amount < spent + held) throw new Refusal(`${item} has spent $${spent} and live runs hold $${held}, so its budget cannot go below $${Math.round((spent + held) * 100) / 100}`); // AT-REV-06
        patch.budget = { usd: amount };
      }
    }
    return writeItem(t, patch, { by: 'user', now, existing: cur });
  });
  const amount = verb === 'approve' && usd !== undefined ? ` at $${row.budget.usd}` : '';
  const text = `${titleCase(row.gate.name)} gate ${row.gate.state} by the user${amount}${row.gate.note ? `: ${row.gate.note}` : ''}; @${t.lead} takes the next step`;
  post(t, { from: 'user', item, kind: 'gate', text }, { now });
  return row;
}

/** Set an item's phase budget (the new total). A paused item goes back to working. */
function setBudget(t, { item, usd, expect, env = process.env, now = new Date() }) {
  assertInteractive(env, 'A budget change');
  if (expect === undefined) throw new UsageError('--expect is required: pass the state you decided on');
  const amount = usdOf(usd, 'the budget');
  const row = withBoard(t, () => {
    const cur = boardItems(t).get(item) || null;
    if (!cur) throw new Refusal(`no board item ${item} on ${t.id}`);
    checkExpect(item, cur, expect);
    // A total below what is spent plus what live runs hold would not bind those runs (AT-R5).
    const spent = Number((cur.budget && cur.budget.spentUsd) || 0);
    const held = liveMarkers(t).filter((x) => x.item === item && x.provider === 'claude').reduce((s, x) => s + (Number(x.reservedUsd) || 0), 0);
    if (amount < spent + held) throw new Refusal(`${item} has spent $${spent} and live runs hold $${held}, so its budget cannot go below $${Math.round((spent + held) * 100) / 100} until they end`);
    const patch = { id: item, budget: { usd: amount } };
    if (cur.status === 'paused') patch.status = 'working';
    return writeItem(t, patch, { by: 'user', now, existing: cur });
  });
  post(t, { from: 'user', item, kind: 'note', text: `Budget for ${item} set to $${amount} by the user; @${t.lead} takes the next step` }, { now });
  return row;
}

function rewriteTeamMd(t, fn) {
  const file = path.join(t.dir, 'TEAM.md');
  fsx.updateSync(file, (text) => {
    const next = fn(text);
    parseFrontmatter(next); // never write a TEAM.md the parser would refuse
    return next;
  });
}

/** Pause or resume a whole team (the DISABLED file) or one member (its `paused` key). */
function setPaused(t, { memberId, paused, env = process.env }) {
  assertInteractive(env, paused ? 'Pausing' : 'Resuming');
  if (!memberId) {
    const file = path.join(t.dir, 'DISABLED');
    if (paused) fs.writeFileSync(file, 'Paused from aos team pause. Delete this file, or run aos team resume, to resume.\n');
    else fs.rmSync(file, { force: true });
    return { team: t.id, paused };
  }
  if (!member(t, memberId)) throw new Refusal(`${memberId} is not on ${t.id}`);
  rewriteTeamMd(t, (text) => rewriteMember(text, memberId, 'paused', !!paused));
  return { team: t.id, member: memberId, paused: !!paused };
}

/** The presets `set` accepts for a key (D4: pickers only, no free text). */
function presetsFor(key) {
  if (key === 'provider') return PROVIDERS;
  if (key === 'effort') return EFFORTS;
  const S = require('./settings-schema.js');
  return ['inherit', ...S.CLAUDE_MODELS, ...S.CODEX_MODELS];
}
function setMember(t, { memberId, key, value, env = process.env }) {
  assertInteractive(env, 'Changing a member');
  if (!SET_KEYS.includes(key)) throw new UsageError(`set takes ${SET_KEYS.join(', ')}`);
  if (!presetsFor(key).includes(value)) throw new UsageError(`${key} must be one of ${presetsFor(key).join(', ')}`);
  if (!member(t, memberId)) throw new Refusal(`${memberId} is not on ${t.id}`);
  if (key === 'provider' && memberId === t.lead && value === 'opposite') throw new Refusal('the lead runs interactively, so it has no opposite provider');
  rewriteTeamMd(t, (text) => rewriteMember(text, memberId, key, value));
  return { team: t.id, member: memberId, key, value };
}

/** Where an agent is defined: { claude: path|null, codex: path|null }. */
function agentFiles(agent, { claudeDir, codexDir }) {
  const f = (dir, ext) => { const p = dir && path.join(dir, 'agents', `${agent}${ext}`); return p && fs.existsSync(p) ? p : null; };
  return { claude: f(claudeDir, '.md'), codex: f(codexDir, '.toml') };
}

/** The member id an agent gets on a team: its name, lowercased, without the team's prefix. */
function memberIdFor(teamId, agent) {
  return agent.toLowerCase().replace(new RegExp(`^${teamId}-`), '').replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 40);
}

function addMember(t, { agent, env = process.env, claudeDir, codexDir }) {
  assertInteractive(env, 'Adding a member');
  if (!AGENT_RE.test(agent || '')) throw new UsageError(`bad agent name: ${agent || '(none)'}`);
  const where = agentFiles(agent, { claudeDir, codexDir });
  if (!where.claude && !where.codex) throw new Refusal(`no agent named ${agent} in either host's agents folder`);
  const id = memberIdFor(t.id, agent);
  if (!ID_RE.test(id)) throw new UsageError(`cannot derive a member id from ${agent}`);
  if (member(t, id)) throw new Refusal(`${t.id} already has a member ${id}`);
  const fields = {
    id, name: titleCase(id), role: 'Member', agent, provider: where.claude ? 'claude' : 'codex',
    model: 'inherit', effort: 'inherit', stage: ['all'], skills: [], voice: '', paused: false,
  };
  rewriteTeamMd(t, (text) => addMemberBlock(text, fields));
  return { team: t.id, member: id, agent };
}

function removeMember(t, { memberId, env = process.env }) {
  assertInteractive(env, 'Removing a member');
  if (memberId === t.lead) throw new Refusal('the lead cannot be removed; make another member the lead in TEAM.md first');
  if (!member(t, memberId)) throw new Refusal(`${memberId} is not on ${t.id}`);
  const busy = [...boardItems(t).values()].filter((it) => it.status !== 'done' && owners(it).includes(memberId)).map((it) => it.id);
  if (busy.length) throw new Refusal(`${memberId} still owns ${busy.join(', ')}; reassign first`);
  rewriteTeamMd(t, (text) => removeMemberBlock(text, memberId));
  return { team: t.id, member: memberId, removed: true };
}

/** Seed persona/teams/<id>/ from the template folder (D13). */
function initTeam(root, { templatesDir, id = 'example' }) {
  if (!ID_RE.test(id)) throw new UsageError(`bad team id: ${id}`);
  const src = path.join(templatesDir, 'example');
  if (!fs.existsSync(path.join(src, 'TEAM.md'))) throw new Refusal(`no example team template in ${templatesDir}`);
  const dest = path.join(root, id);
  if (fs.existsSync(dest)) throw new Refusal(`persona/teams/${id} already exists`);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  if (id !== 'example') {
    const file = path.join(dest, 'TEAM.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^id: example$/m, `id: ${id}`));
  }
  return { team: id, dir: dest };
}

/** Make persona/teams/<id>/ with one member, the lead the user picked, and the example template's gates, notify and budget. */
function newTeam(root, { id, name, lead, parent = null, templatesDir, env = process.env, claudeDir, codexDir, now = new Date() }) {
  assertInteractive(env, 'Creating a team');
  if (!ID_RE.test(id || '')) throw new UsageError(`bad team id: ${id || '(none)'}`);
  const title = String(name || '').trim();
  if (!title || title.length > 60 || /[\0-\x1f\x7f-\x9f\u2028\u2029]/.test(String(name))) throw new UsageError('--name must be 1 to 60 characters on one line, with no control character');
  if (!AGENT_RE.test(lead || '')) throw new UsageError(`bad agent name: ${lead || '(none)'}`);
  const where = agentFiles(lead, { claudeDir, codexDir });
  if (!where.claude && !where.codex) throw new Refusal(`no agent named ${lead} in either host's agents folder`);
  const memberId = memberIdFor(id, lead);
  if (!ID_RE.test(memberId)) throw new UsageError(`cannot derive a member id from ${lead}`);
  const tpl = path.join(templatesDir, 'example', 'TEAM.md');
  if (!fs.existsSync(tpl)) throw new Refusal(`no example team template in ${templatesDir}`);
  const base = parseFrontmatter(fs.readFileSync(tpl, 'utf8'));
  fs.mkdirSync(root, { recursive: true });
  return withLock(path.join(root, '.new-team'), () => {
    let parentLead = null;
    if (parent) {
      if (!listTeams(root).includes(parent)) throw new Refusal(`no team ${parent}`);
      parentLead = readTeam(root, parent).lead;
    }
    const dest = path.join(root, id);
    if (fs.existsSync(dest)) throw new Refusal(`persona/teams/${id} already exists`);
    const budget = base.budget || {};
    const list = (v) => `[${[].concat(v || []).join(', ')}]`;
    const head = [
      '---', 'type: team', `id: ${id}`, `name: ${formatScalar(title)}`, `lead: ${formatScalar(memberId)}`,
      ...(parent ? [`parent: ${formatScalar(parent)}`, `reportsTo: ${formatScalar(parentLead)}`] : []),
      `gates: ${list(base.gates)}`, `notify: ${list(base.notify)}`,
      `budget: {${Object.entries(budget).map(([k, v]) => `${k}: ${v}`).join(', ')}}`,
      `updated: ${now.toISOString().slice(0, 10)}`, '---', '',
    ].join('\n');
    const text = addMemberBlock(head, {
      id: memberId, name: titleCase(memberId), role: 'Team lead', agent: lead, provider: where.claude ? 'claude' : 'codex',
      model: 'inherit', effort: 'inherit', stage: ['all'], skills: [], voice: '', paused: false,
    });
    const full = `${text.replace(/\n*$/, '\n')}\n# ${title} team\n`;
    parseFrontmatter(full); // never write a TEAM.md the parser would refuse
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'TEAM.md'), full);
    return { team: id, member: memberId, agent: lead, dir: dest };
  });
}

// ── live runs: the markers, the killed-run sweep, and wait (D7, D11) ──

function runningDir(t) { return path.join(t.dir, 'running'); }

/** When a process started, in ms (ps lstart, to the second), or null when ps cannot say. */
function processStart(pid) {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (r.error || r.status !== 0) return null;
  const ms = Date.parse(r.stdout.trim());
  return Number.isFinite(ms) ? ms : null;
}

/** Whether a marker's dispatcher is still running: its pid is alive and is the same process that wrote the marker (its
 *  start time matches), not a pid the system has since reused. A marker without a start time is judged by the command. */
function dispatchAlive(pid, started) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (!e || e.code !== 'EPERM') return false; }
  if (Number.isFinite(started)) {
    const now = processStart(pid);
    return now === null ? true : Math.abs(now - started) <= 2000;
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (r.error) return true; // no ps to ask: trust the live pid
  return r.status === 0 && /\bteam(\.js)?\s+dispatch\b/.test(r.stdout);
}

function liveMarkers(t) {
  let names;
  try { names = fs.readdirSync(runningDir(t)).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.map((n) => { try { return JSON.parse(fs.readFileSync(path.join(runningDir(t), n), 'utf8')); } catch { return null; } }).filter(Boolean);
}

/** Close every run whose dispatcher died without finishing it: one `killed` row and one blocker each, exactly once
 *  (under the runs.jsonl lock; the marker goes with its row). Markers from another host, or of a live dispatcher, stay. */
function reapKilledRuns(t, { alive = dispatchAlive, host = os.hostname(), now = Date.now(), seatGraceMs = 5000 } = {}) {
  const dir = runningDir(t);
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  if (!names.length) return [];
  const runsFile = path.join(t.dir, 'runs.jsonl');
  return withLock(runsFile, () => {
    const closed = new Set(readJsonl(runsFile).map((r) => r.run).filter(Boolean));
    const reaped = [];
    for (const name of names) {
      const file = path.join(dir, name);
      let m;
      try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!m || !m.run || m.host !== host || alive(m.pid, m.pidStart)) continue;
      // A seat that outlived its dispatcher (SIGKILL) is stopped before the run is recorded (AT-08).
      let orphan = null;
      // A live seat whose identity cannot be checked (no ps) keeps its marker until it is gone (AT-REV-04).
      if (Number.isInteger(m.seatPid) && !Number.isFinite(m.seatStart)) { try { process.kill(m.seatPid, 0); continue; } catch { /* gone */ } }
      if (Number.isInteger(m.seatPid) && Number.isFinite(m.seatStart)) {
        try {
          process.kill(m.seatPid, 0);
          const s = processStart(m.seatPid);
          if (s !== null && Math.abs(s - m.seatStart) <= 2000) { process.kill(m.seatPid, 'SIGTERM'); orphan = m.seatPid; }
        } catch { /* gone */ }
        // Confirm it stopped before the run is recorded: SIGKILL after the grace period (AT-R6).
        if (orphan) {
          const gone = () => { try { process.kill(orphan, 0); return false; } catch { return true; } };
          const until = Date.now() + seatGraceMs;
          while (!gone() && Date.now() < until) sleepSync(50);
          if (!gone()) { try { process.kill(orphan, 'SIGKILL'); } catch { /* gone */ } sleepSync(100); }
          if (!gone()) continue; // still there: keep the marker, and the next sweep tries again
        }
      }
      if (!closed.has(m.run)) {
        const started = Date.parse(m.startedAt || '');
        const ms = Number.isFinite(started) ? Math.max(0, now - started) : null;
        appendJsonl(runsFile, {
          schema: 1, ts: new Date(now).toISOString(), team: t.id, member: m.member, item: m.item, provider: m.provider,
          model: m.model == null ? null : m.model, effort: m.effort == null ? null : m.effort, run: m.run, startedAt: m.startedAt,
          ms, usd: null, status: 'killed', error: `dispatcher pid ${m.pid} on ${m.host} ended without finishing the run`, log: m.log,
        });
        closed.add(m.run);
        const mins = ms == null ? '?' : (ms / 60000).toFixed(1);
        const wt = m.worktree && fs.existsSync(path.resolve(t.vault, m.worktree)) ? `${m.worktree} is still there` : `${m.worktree || '?'} is gone`;
        const text = `${m.member}'s ${m.provider} run on ${m.item} was killed: its dispatcher (pid ${m.pid}) is gone ${mins} min after the run started, and it wrote no end row.${orphan ? ` Its seat (pid ${orphan}) was still running and was stopped.` : ''} Worktree ${wt}; log ${m.log}.*`;
        try { post(t, { from: 'dispatch', item: m.item, kind: 'blocker', text }); } catch { post(t, { from: 'dispatch', kind: 'blocker', text }); }
        reaped.push({ ...m, ms });
      }
      try { fs.unlinkSync(file); } catch { /* removed by a parallel sweep */ }
    }
    return reaped;
  });
}

function runLine(r) {
  const mins = r.ms == null ? '?' : (r.ms / 60000).toFixed(1);
  const cost = r.usd == null ? 'cost unknown' : `$${Number(r.usd).toFixed(2)}${r.provider === 'codex' ? ' (estimated)' : ''}`;
  return `${r.member} on ${r.item} via ${r.provider}: ${r.status} after ${mins} min · ${cost}`
    + (r.commits != null ? ` · ${r.commits} commit(s)${r.merged === false ? ' NOT merged' : ''}` : '')
    + (r.posted ? ` · posted ${r.posted}` : '') + (r.error ? ` · ${r.error}` : '');
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Block until <member>'s run on <item> that started at or after `since` has its runs.jsonl row, sweeping killed runs
 *  as it polls. Gives up when no run of that seat started within START_GRACE_MS, or at the timeout. → { code, row?, err? } */
function waitForRun(t, { item, member: who, since, timeoutMin = 180, pollMs = WAIT_POLL_MS, sleep = sleepSync }) {
  if (!item || !who) throw new UsageError('wait needs <item> <member>');
  const from = since ? Date.parse(since) : Date.now();
  if (!Number.isFinite(from)) throw new UsageError(`--since is not a date: ${since}`);
  const timeoutMs = Number(timeoutMin) * 60000;
  if (!(timeoutMs > 0)) throw new UsageError('--timeout-min must be a positive number');
  const grace = Math.min(START_GRACE_MS, timeoutMs / 2);
  const t0 = Date.now();
  const runsFile = path.join(t.dir, 'runs.jsonl');
  const mine = (r) => r && r.item === item && r.member === who && Date.parse(r.startedAt || r.ts || '') >= from;
  for (;;) {
    reapKilledRuns(t);
    // Markers before rows: a run writes its row before removing its marker, so this order never sees neither.
    const live = liveMarkers(t).some(mine);
    const row = readJsonl(runsFile).filter(mine).pop();
    if (row) return { code: 0, row };
    if (!live && Date.now() - Math.max(from, t0) > grace) {
      return { code: 1, err: `no run of ${who} on ${item} started since ${new Date(from).toISOString()}; check the dispatch log` };
    }
    if (Date.now() - t0 > timeoutMs) return { code: 1, err: `${who}'s run on ${item} is still going after ${timeoutMin} min; wait again, or stop it` };
    sleep(pollMs);
  }
}

// ── status ──

/** Each member with what the files say about it now: working (a live marker), blocked (owns a blocked item), paused, idle. */
function memberStatus(t) {
  const items = [...boardItems(t).values()];
  const live = liveMarkers(t);
  const runs = readJsonl(path.join(t.dir, 'runs.jsonl'));
  return t.members.map((m) => {
    const marker = live.find((x) => x.member === m.id);
    const owned = items.filter((it) => it.status !== 'done' && owners(it).includes(m.id));
    const last = runs.filter((r) => r.member === m.id).pop() || null;
    const status = m.paused || t.disabled ? 'paused' : marker ? 'working' : owned.some((it) => it.status === 'blocked') ? 'blocked' : 'idle';
    return {
      id: m.id, name: m.name || m.id, role: m.role || '', agent: m.agent || null, provider: m.provider || null, model: m.model || null,
      effort: m.effort || null, lead: m.id === t.lead, status, item: marker ? marker.item : (owned[0] && owned[0].id) || null,
      lastRun: last ? { item: last.item, status: last.status, ms: last.ms == null ? null : last.ms, usd: last.usd == null ? null : last.usd, ts: last.ts } : null,
    };
  });
}

function pendingGates(t) {
  return [...boardItems(t).values()].filter((it) => it.status === 'gate' && it.gate && it.gate.state === 'pending');
}

function readState(t) {
  try {
    const text = fs.readFileSync(path.join(t.dir, 'STATE.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '');
    return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(0, 3);
  } catch { return []; }
}

module.exports = {
  KINDS, DEFAULT_STAGES, STATUSES, GATE_STATES, PROVIDERS, EFFORTS, SET_KEYS, ID_RE, ITEM_RE, Refusal, UsageError,
  teamsRoot, parseScalar, formatScalar, parseFrontmatter, rewriteMember, addMemberBlock, removeMemberBlock, readTeam, listTeams,
  guardPut, readJsonl, appendJsonl, boardItems, owners, member, leadOf, post, tail, withLock, withBoard, matches, checkExpect, writeItem, put,
  decideGate, setBudget, setPaused, presetsFor, setMember, agentFiles, memberIdFor, addMember, removeMember, initTeam, newTeam,
  runningDir, processStart, dispatchAlive, liveMarkers, reapKilledRuns, runLine, waitForRun, memberStatus, pendingGates, readState,
};
