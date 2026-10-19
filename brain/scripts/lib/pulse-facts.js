'use strict';
/**
 * pulse-facts.js — what the Workbench's Pulse tab and the Chief of Staff's briefing say about the vault (spec
 * 2026-10-08-pulse-cockpit-design P8, P9): the items that need the user, in one order, and a summary per area.
 *
 *   read(vault, { now })   the raw inputs, read from files and caches only (never a transcript); every source on its own,
 *                          so one unreadable file drops one input, never the whole read
 *   facts(inputs, now)     pure: { schema, at, needsYou[], summary, hash }
 *
 * hud/src/data/pulseFacts.ts is this module's twin over the same inputs (the HUD builds them from its own
 * loaders); its test loads this file and checks both give the same facts for the fixture vault, so change both.
 *
 * Order (P9, amendment A2): tier 0 is what is broken (health errors); 1 what waits on a decision (team gates, proposals,
 * flags, feedback drafts); 2 stale or failing work (pipelines, routines on a fail streak, overdue to-dos); 3 breaking
 * unread notifications; 4 other unread and to-dos due today; 5 memories to review. Inside a tier the oldest comes first and an
 * item with no date last; ties keep the order above. A `routine:<slug>` pipeline row is the routine's own run, judged by its
 * fail streak under Routines, never by a pipeline's freshness window (an hourly window would call every daily routine
 * stale), so pipelines leave those rows out. The hash covers the items and the summary without spend, so the
 * briefing's own call never makes the next one look new.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 1;
const AREAS = ['needs', 'health', 'agents', 'workspaces', 'todo', 'proposals', 'notifications', 'routines', 'spend', 'memory'];
const MAX_NOTIFICATIONS = 300;

// hud/src/data/pipelines.ts PIPELINES_MANIFEST (staleMs) and DIED_AFTER_MS; a name outside it is stale after an hour.
const PIPELINE_STALE_MS = {
  'scan-vault': 45 * 60e3, 'session-summary': 24 * 3600e3, 'auto-cost': 24 * 3600e3, 'auto-cost-backfill': 7 * 24 * 3600e3,
  'heartbeat-writer': 45 * 60e3, 'file-map': null, 'auto-wrap': 24 * 3600e3, 'build-brain-md': 45 * 60e3, 'embed-vault': null,
  'graph-build': null, 'graph-semantic': null, 'brain-hub': null,
};
const UNKNOWN_STALE_MS = 60 * 60e3;
const DIED_AFTER_MS = 10 * 60e3;

// hud/src/data/todos.ts ITEM_RE, DUE_RE, DONE_RE.
const ITEM_RE = /^([-*]) \[([ xX])\] ?(.*)$/;
const DUE_RE = /\s*📅️?\s*(\d{4}-\d{2}-\d{2})/u;

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** A `YYYY-MM-DD` as local midnight, an ISO time as itself; null when neither. */
function sinceMs(since) {
  if (typeof since !== 'string' || !since) return null;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime();
  const t = Date.parse(since);
  return Number.isFinite(t) ? t : null;
}

/** Whole local days from a `YYYY-MM-DD` to `now` (proposals.ts ageDays); null for a malformed date. */
function ageDays(day, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return null;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - then.getTime()) / 86400e3);
}

/** A proposal file's title and filing date: its first `# ` heading (else its slug) and `filed:` (else the name's date). */
function proposalOf(name, text) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(String(text || ''));
  const meta = {};
  if (fm) for (const line of fm[1].split('\n')) { const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line); if (kv) meta[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1'); }
  const h1 = /^# (.+?)\s*$/m.exec(String(text || '').slice(fm ? fm[0].length : 0));
  const slug = meta.slug || name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
  return { title: h1 ? h1[1] : slug, filed: meta.filed || name.slice(0, 10) };
}

/** pipelines.ts classifyPipeline, reduced to the health: ok | stale | failed | died | neutral. */
function pipelineHealth(name, state, nowMs) {
  const last = state && state.lastRun;
  if (!last) return 'neutral';
  const staleAfter = Object.prototype.hasOwnProperty.call(PIPELINE_STALE_MS, name) ? PIPELINE_STALE_MS[name] : UNKNOWN_STALE_MS;
  const age = nowMs - Date.parse(last.startedAt);
  if (last.status === 'disabled' || last.status === 'skipped') return 'neutral';
  if (last.status === 'running') return age > DIED_AFTER_MS ? 'died' : 'ok';
  if (last.status === 'error') return 'failed';
  if (staleAfter !== null && age > staleAfter) return 'stale';
  return 'ok';
}

/** Open to-dos with their due dates (todos.ts parseTodos: the item line only; children and sections do not matter here). */
function todoItems(text) {
  const out = [];
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const m = ITEM_RE.exec(line);
    if (!m) continue;
    const due = DUE_RE.exec(m[3]);
    out.push({ done: m[2] !== ' ', due: due ? due[1] : null });
  }
  return out;
}

/** The facts. Pure over (inputs, now). */
function facts(inputs, now = new Date()) {
  const inp = inputs || {};
  const today = localDay(now);
  const nowMs = now.getTime();
  const items = [];
  const push = (tier, it) => items.push({ tier, seq: items.length, ...it });

  // tier 0: what is broken
  const issues = Array.isArray(inp.issues) ? inp.issues : [];
  for (const i of issues) if (i && i.severity === 'error') push(0, { area: 'health', kind: 'error', tone: 'danger', title: String(i.message || ''), since: null, ref: String(i.area || '') });

  // tier 1: decisions waiting on the user
  for (const g of inp.gates || []) push(1, { area: 'proposals', kind: 'gate', tone: 'gate', title: `${g.team} gate: ${g.title || g.item}`, since: g.since || null, ref: `${g.team}/${g.item}` });
  const proposals = (inp.proposals || []).map((p) => ({ name: p.name, ...proposalOf(p.name, p.text) }));
  for (const p of proposals) push(1, { area: 'proposals', kind: 'proposal', tone: 'gate', title: p.title, since: p.filed, ref: p.name });
  const flags = openFlags(inp.stateMd);
  for (const f of flags) push(1, { area: 'proposals', kind: 'flag', tone: 'warn', title: f.text, since: f.date, ref: f.text });
  const drafts = Number(inp.drafts) || 0;
  if (drafts > 0) push(1, { area: 'proposals', kind: 'drafts', tone: 'gate', title: `${drafts} feedback ${plural(drafts, 'draft')} waiting for review`, since: null, ref: 'feedback-drafts' });

  // tier 2: stale or failing work
  const pipes = inp.pipelines || {};
  const names = Object.keys(PIPELINE_STALE_MS);
  for (const n of Object.keys(pipes)) if (!names.includes(n) && !n.startsWith('routine:')) names.push(n);
  const pipeline = { total: names.length, ok: 0, neutral: 0, stale: 0, failed: 0 };
  for (const n of names) {
    const h = pipelineHealth(n, pipes[n], nowMs);
    if (h === 'died') pipeline.failed++; else pipeline[h]++;
    if (!Object.prototype.hasOwnProperty.call(PIPELINE_STALE_MS, n) || (h !== 'stale' && h !== 'failed' && h !== 'died')) continue;
    const verb = h === 'stale' ? 'is stale' : h === 'died' ? 'died mid-run' : 'failed';
    push(2, { area: 'health', kind: 'pipeline', tone: h === 'stale' ? 'warn' : 'danger', title: `${n} ${verb}`, since: pipes[n].lastRun.startedAt || null, ref: n });
  }
  const routines = inp.routines || {};
  const slugs = Object.keys(routines).sort();
  let failing = 0;
  for (const s of slugs) {
    const n = Number(routines[s] && routines[s].failStreak) || 0;
    if (n <= 0) continue;
    failing++;
    push(2, { area: 'routines', kind: 'routine', tone: 'danger', title: `${s} failed ${n} ${plural(n, 'time')} in a row`, since: routines[s].lastRunAt || null, ref: s });
  }
  const todos = todoItems(inp.todo);
  const open = todos.filter((t) => !t.done);
  const overdue = open.filter((t) => t.due && t.due < today);
  const dueToday = open.filter((t) => t.due === today);
  if (overdue.length) push(2, { area: 'todo', kind: 'overdue', tone: 'warn', title: `${overdue.length} overdue ${plural(overdue.length, 'to-do')}`, since: overdue.map((t) => t.due).sort()[0], ref: 'overdue' });

  // tiers 3 and 4: unread notifications (breaking first), to-dos due today
  const notes = (inp.notifications || []).filter((n) => n && typeof n.title === 'string');
  const unread = notes.filter((n) => !n.read && !n.archived);
  for (const n of unread) if (n.level === 'breaking') push(3, { area: 'notifications', kind: 'breaking', tone: 'danger', title: n.title, since: n.created || null, ref: n.id });
  const rest = unread.filter((n) => n.level !== 'breaking');
  if (rest.length) push(4, { area: 'notifications', kind: 'unread', tone: 'info', title: `${rest.length} unread: ${rest.slice(0, 3).map((n) => n.title).join(', ')}`, since: null, ref: 'unread' });
  if (dueToday.length) push(4, { area: 'todo', kind: 'today', tone: 'info', title: `${dueToday.length} ${plural(dueToday.length, 'to-do')} due today`, since: null, ref: 'today' });

  // tier 5: memories written today and not yet reviewed
  const written = new Map();
  for (const r of inp.trail || []) {
    if (!r || r.action !== 'written' || !r.slug) continue;
    const t = new Date(r.ts);
    if (Number.isNaN(t.getTime()) || localDay(t) !== today) continue;
    written.set(`${r.type}/${r.slug}`, r);
  }
  const pending = [...written.values()].filter((r) => r.pending === true);
  if (pending.length) push(5, { area: 'memory', kind: 'review', tone: 'off', title: `${pending.length} ${plural(pending.length, 'memory', 'memories')} written today, not yet reviewed`, since: null, ref: 'review' });

  items.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const sa = sinceMs(a.since);
    const sb = sinceMs(b.since);
    if (sa !== sb) return sa === null ? 1 : sb === null ? -1 : sa - sb;
    return a.seq - b.seq;
  });
  const needsYou = items.map(({ tier, area, kind, tone, title, since, ref }) => ({ tier, area, kind, tone, title, since, ref }));

  const ws = Array.isArray(inp.workspaces) ? inp.workspaces : [];
  const ages = proposals.map((p) => ageDays(p.filed, now)).filter((d) => d !== null);
  const latest = unread[0] || null;
  const summary = {
    health: {
      errors: issues.filter((i) => i && i.severity === 'error').length,
      warnings: issues.filter((i) => i && i.severity === 'warn').length,
      notes: issues.filter((i) => i && i.severity === 'info').length,
      pipelines: pipeline,
    },
    decisions: { proposals: proposals.length, gates: (inp.gates || []).length, flags: flags.length, drafts, oldestDays: ages.length ? Math.max(...ages) : null },
    notifications: {
      total: notes.length, unread: unread.length,
      breaking: unread.filter((n) => n.level === 'breaking').length, alerts: unread.filter((n) => n.level === 'alert').length,
      latest: latest ? { title: latest.title, from: latest.from || '', created: latest.created || '' } : null,
    },
    todo: { open: open.length, done: todos.length - open.length, overdue: overdue.length, today: dueToday.length },
    routines: { total: slugs.length, failing },
    memory: { writtenToday: written.size, pendingReview: pending.length, drafts },
    workspaces: { total: ws.length, active: ws.filter((w) => w && w.status === 'active').length },
    spend: { usd: Math.round((Number(inp.spend && inp.spend.usd) || 0) * 100) / 100, calls: Number(inp.spend && inp.spend.calls) || 0 },
  };
  const { spend: _spend, ...hashed } = summary;
  const hash = crypto.createHash('sha1').update(JSON.stringify({ needsYou: needsYou.map(({ since, ...k }) => k), summary: hashed })).digest('hex').slice(0, 16);
  return { schema: SCHEMA, at: now.toISOString(), persona: inp.personaName || null, needsYou, summary, hash };
}

/** Open flags in persona/STATE.md — the status line's reader (lib/statusline-model.js), so both count the same flags. */
function openFlags(text) { return require('./statusline-model.js').openFlags(text); }

/**
 * Whether a memory's text still waits for review: `reviewed: false` and live, read as lib/memory-ops.js reads
 * frontmatter. Archive and supersede leave `reviewed:` as it was (memory-ops retire), so `reviewed: false` alone would
 * keep counting what the Brain tab retired (brain-hub D5, D7). hud/src/data/brainModel.ts pendingReview.
 */
function pendingReview(text) {
  if (!text) return false;
  const ops = require('./memory-ops.js');
  const fm = ops.splitFm(text);
  return !!fm && ops.getKey(fm.lines, 'reviewed') === 'false' && !ops.GONE.includes(ops.getStatus(fm.lines));
}

/** The raw inputs from a vault. Each source on its own: a missing or unreadable file gives its empty value. */
function read(vault, { now = new Date() } = {}) {
  const SL = require('./statusline-model.js');
  const N = require('./notifications.js');
  const idx = path.join(vault, 'brain', '_index');
  const part = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
  const identity = readText(path.join(vault, 'persona', 'IDENTITY.md'));
  const name = identity && /^#\s+(.+?)\s*$/m.exec(identity.replace(/^---\n[\s\S]*?\n---\n/, ''));
  const snapshot = readJson(path.join(idx, 'snapshot.json')) || {};
  const ledger = part(() => SL.ledgerToday(path.join(idx, 'provider-spend.jsonl'), now), '');
  const spend = { usd: 0, calls: 0 };
  for (const line of ledger.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const t = r && new Date(r.ts);
    if (!r || !t || Number.isNaN(t.getTime()) || localDay(t) !== localDay(now)) continue;
    spend.calls++;
    if (typeof r.usd === 'number' && Number.isFinite(r.usd)) spend.usd += r.usd;
  }
  return {
    personaName: name ? name[1] : null,
    proposals: part(() => fs.readdirSync(path.join(vault, 'persona', 'proposals')).filter((n) => n.endsWith('.md') && n !== 'README.md').sort()
      .map((n) => ({ name: n, text: readText(path.join(vault, 'persona', 'proposals', n)) || '' })), []),
    stateMd: readText(path.join(vault, 'persona', 'STATE.md')),
    drafts: part(() => fs.readdirSync(path.join(vault, 'brain', 'memory', 'feedback', '_drafts')).filter((n) => n.endsWith('.md')).length, 0),
    gates: part(() => SL.gatesOf(SL.readTeams(vault)), []),
    issues: snapshot.health && Array.isArray(snapshot.health.issues) ? snapshot.health.issues.map((i) => ({ severity: i.severity, area: i.area, message: i.message })) : [],
    // Hidden entries (`_` folders, _archive/) are never counted (spaces-redesign D22); the twin read in pulseFacts.ts filters the same way.
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces.filter((w) => w && !w.hidden).map((w) => ({ name: w.name, status: w.status })) : [],
    pipelines: part(() => readJson(path.join(idx, 'pipelines.json')).pipelines || {}, {}),
    routines: part(() => readJson(path.join(idx, 'routines.json')).routines || {}, {}),
    todo: readText(path.join(vault, 'TODO.md')),
    notifications: part(() => {
      const state = N.readState(vault).items;
      return N.itemFiles(vault).slice(0, MAX_NOTIFICATIONS).map((f) => {
        const it = N.parse(readText(f.file));
        if (!it || typeof it.meta.title !== 'string') return null;
        const s = state[f.id] || {};
        return { id: f.id, level: it.meta.level, title: it.meta.title, from: String(it.meta.from || ''), created: String(it.meta.created || ''), read: !!s.read, archived: !!s.archived };
      }).filter(Boolean);
    }, []),
    trail: part(() => {
      const raw = readText(path.join(idx, 'promote-log.jsonl')) || '';
      const out = [];
      for (const line of raw.split('\n')) {
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r || r.action !== 'written' || localDay(new Date(r.ts)) !== localDay(now)) continue;
        const file = readText(path.join(vault, 'brain', 'memory', String(r.type), `${r.slug}.md`));
        out.push({ ts: r.ts, action: r.action, slug: r.slug, type: r.type, title: r.title || r.slug, pending: pendingReview(file) });
      }
      return out;
    }, []),
    spend,
  };
}

module.exports = { SCHEMA, AREAS, PIPELINE_STALE_MS, read, facts, pipelineHealth, todoItems, proposalOf, sinceMs, ageDays, pendingReview };
