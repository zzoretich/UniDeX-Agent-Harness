'use strict';
/**
 * statusline-render.js — the text of the AgenticOS status line (spec 2026-09-28-statusline-design §4.3). Pure: a
 * Claude Code payload, the statusline.json model, the work and git facts the caller gathered, and the terminal width
 * in; at most three lines out.
 *
 *   L1  model ·effort ·think │ work │ dir ⎇ branch* │ #PR
 *   L2  context bar │ 5h/7d limits │ $cost │ cache │ +lines/-lines
 *   L3  ◆ needs you │ ▶ live run │ spend near cap │ health          (omitted when empty)
 *
 * A line wider than the terminal drops its lowest-priority segments instead of wrapping. Links are OSC 8 and built
 * only from allow-listed targets (D10). `subagentRows` renders Claude Code's subagentStatusLine rows (D8), and
 * `summaryLine` the plain one-liner the Codex session-start notice prints (D7).
 */
const path = require('path');
const { links } = require('./hud-host.js');

const REPO_SLUG = 'zzoretich/UniDeX-Agent-Harness'; // mirrors cli/update-check.js (brain/scripts must not require cli/)
const AUTO_COMPACT_BUFFER_PCT = 16.5;
const E = '\x1b[';
const C = { dim: '2', bold: '1', green: '32', yellow: '33', orange: '38;5;208', red: '31', cyan: '36', magenta: '35', boldMagenta: '1;35', boldRed: '1;31' };
const paint = (code, s) => (s ? `${E}${code}m${s}${E}0m` : '');
const SEP = ` ${paint(C.dim, '│')} `;
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const FAMILY_LABEL = { hooks: 'hooks', duties: 'duties', reasoner: 'reasoner', routines: 'routines', graph: 'graph', crossReview: 'cross-review' };
const DEFAULT_SEGMENTS = ['needs-you', 'runs', 'spend', 'health'];

const plain = (s) => String(s).replace(ANSI_RE, '');
function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd);
}
/** Terminal cells a string takes once its escapes are stripped (wide CJK and emoji count 2, joiners 0). */
function width(s) {
  let w = 0;
  for (const ch of plain(s)) {
    const cp = ch.codePointAt(0);
    if (cp < 32 || (cp >= 0x300 && cp < 0x370) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}
/** Printable text only: C0/C1 controls (ESC, BEL, CR…) and DEL become spaces, so no task title, branch or model name can
 *  drive the terminal. Every dynamic value passes through here or through clip. */
const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const clip = (s, max) => { const t = clean(s).replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t; };
/** An https URL re-encoded by the URL parser (controls percent-encoded), or null. */
function safeHttps(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' && !/[\u0000-\u001f\u007f-\u009f\s]/.test(x.href) ? x.href : null; } catch { return null; }
}
const osc8 = (url, text, on) => (on && url ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : text);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "2h05m", "42m", "3d4h": a countdown to an epoch in ms. */
function until(ms) {
  if (!(ms > 0)) return '0m';
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function compactModel(name) {
  return String(name || '').replace(/^Claude\s+/i, '').replace(/\s*\((\d+[KkMm])\s+context\)/, ' ($1)').trim();
}
/** A model id as a short name: claude-opus-5-5 → Opus 5.5, claude-haiku-4-5-20251001 → Haiku 4.5. */
function shortModel(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(id || ''));
  if (!m) return String(id || '');
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** Context used, scaled to the usable window: Claude Code reserves an auto-compact buffer (16.5 % unless overridden). */
function contextUsed(cw, env = {}) {
  if (!cw) return null;
  const rem = num(cw.remaining_percentage) ?? (num(cw.used_percentage) === null ? null : 100 - cw.used_percentage);
  if (rem === null) return null;
  const total = num(cw.context_window_size) || num(cw.total_tokens) || 200000;
  const acw = parseInt(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
  const buffer = acw > 0 ? Math.min(100, Math.max(0, (1 - acw / total) * 100)) : AUTO_COMPACT_BUFFER_PCT;
  const usable = Math.max(0, ((rem - buffer) / (100 - buffer)) * 100);
  return Math.max(0, Math.min(100, Math.round(100 - usable)));
}

/** Link targets (D10): Workbench tabs by rail id and a vault file (agenticos://, lib/hud-host.js), the release page, an
 *  https PR. The app registers agenticos:// for itself, so a link names no vault. */
function targets() {
  const l = links();
  return {
    tab: l.tab,
    file: l.file,
    release: (ver) => (/^\d+\.\d+\.\d+[\w.-]*$/.test(ver) ? `https://github.com/${REPO_SLUG}/releases/tag/v${ver}` : null),
  };
}

// ── L1 ──

function modelSeg(p) {
  const badges = [];
  if (p.effort && p.effort.level) badges.push(clip(p.effort.level, 12));
  if (p.thinking && p.thinking.enabled) badges.push('think');
  if (p.fast_mode) badges.push('fast');
  if (p.vim && p.vim.mode) badges.push(clip(p.vim.mode, 12).toLowerCase());
  const name = clip(compactModel(p.model && (p.model.display_name || p.model.id)), 40) || 'Claude';
  const agent = p.agent && p.agent.name ? ` ${paint(C.cyan, `@${clip(p.agent.name, 24)}`)}` : '';
  return paint(C.dim, [name, ...badges].join(' ·')) + agent;
}

function workSeg(work) {
  if (!work || !work.text) return '';
  return work.kind === 'task' ? paint(C.bold, clip(work.text, 48)) : paint(C.dim, clip(work.text, 48));
}

function dirSeg(p, git) {
  const ws = p.workspace || {};
  const dir = ws.project_dir || ws.current_dir || p.cwd || '';
  let s = paint(C.dim, clip(path.basename(String(dir)) || dir, 40));
  if (git && git.branch) {
    const marks = `${git.dirty ? '*' : ''}${git.ahead ? `↑${git.ahead}` : ''}${git.behind ? `↓${git.behind}` : ''}`;
    s += ` ${paint(C.magenta, `⎇ ${clip(git.branch, 32)}`)}${marks ? paint(C.yellow, marks) : ''}`;
  }
  return s;
}

function prSeg(p, links) {
  const pr = p.pr;
  const n = pr ? Number(pr.number) : NaN;
  if (!Number.isInteger(n) || n <= 0) return '';
  const state = { approved: ['✓', C.green], changes_requested: ['changes', C.red], pending: ['review', C.yellow], review_required: ['review', C.yellow] }[pr.review_state] || null;
  const text = `#${n}${state ? ` ${state[0]}` : ''}`;
  const url = safeHttps(pr.url);
  return paint(state ? state[1] : C.dim, osc8(url, text, links));
}

// ── L2 ──

function contextSeg(p, env) {
  const used = contextUsed(p.context_window, env);
  if (used === null) return '';
  const filled = Math.floor(used / 10);
  const color = used < 50 ? C.green : used < 65 ? C.yellow : used < 80 ? C.orange : C.red;
  return paint(color, `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${used}%`);
}

function limitSeg(label, w, now) {
  const pct = w && num(w.used_percentage);
  if (pct === null || pct === undefined) return '';
  const p = Math.round(pct);
  const reset = p >= 80 && num(w.resets_at) ? ` ↻${until(w.resets_at * 1000 - now)}` : '';
  return paint(p >= 80 ? C.red : p >= 50 ? C.yellow : C.dim, `${label} ${p}%${reset}`);
}

function limitsSeg(p, now) {
  const r = p.rate_limits || {};
  return [limitSeg('5h', r.five_hour, now), limitSeg('7d', r.seven_day, now), limitSeg('cap', r.spend_limit, now)].filter(Boolean).join(paint(C.dim, ' · '));
}

function costSeg(p) {
  const usd = p.cost && num(p.cost.total_cost_usd);
  return usd === null || usd === undefined ? '' : paint(C.dim, `$${usd.toFixed(2)}`);
}

function cacheSeg(p, now) {
  const pc = p.prompt_cache;
  if (!pc) return '';
  const hit = num(pc.hit_ratio) === null ? '' : `${Math.round(pc.hit_ratio * 100)}%`;
  if (pc.warm === false) return paint(C.yellow, `cache ${hit ? `${hit} · ` : ''}cold`);
  const ttl = pc.warm && num(pc.expires_at) ? until(pc.expires_at * 1000 - now) : '';
  const text = [hit, ttl].filter(Boolean).join(' · ');
  return text ? paint(C.dim, `cache ${text}`) : '';
}

function linesSeg(p) {
  const a = p.cost && num(p.cost.total_lines_added);
  const r = p.cost && num(p.cost.total_lines_removed);
  if (!a && !r) return '';
  return `${paint(C.green, `+${a || 0}`)}${paint(C.dim, '/')}${paint(C.red, `-${r || 0}`)}`;
}

// ── L3 ──

function needsSeg(model, t, links) {
  const n = (model && model.needs) || {};
  const out = [];
  const gates = (Array.isArray(n.gates) ? n.gates : []).filter((g) => g && typeof g.item === 'string');
  if (gates.length === 1) out.push(paint(C.boldMagenta, osc8(t.tab('agent-teams'), `◆ gate ${clip(gates[0].item, 24)}${gates[0].stage ? ` (${clip(gates[0].stage, 16)})` : ''}`, links)));
  else if (gates.length > 1) out.push(paint(C.boldMagenta, osc8(t.tab('agent-teams'), `◆ ${gates.length} gates`, links)));
  const alerts = (num(n.alerts) || 0) + (num(n.breaking) || 0);
  if (alerts) out.push(paint(n.breaking ? C.boldRed : C.yellow, osc8(t.tab('notifications'), n.breaking ? `${n.breaking} breaking${n.alerts ? ` +${n.alerts}` : ''}` : plural(alerts, 'alert'), links)));
  if (n.flags) out.push(paint(C.yellow, osc8(t.file('persona/STATE.md'), plural(n.flags, 'flag'), links)));
  return out.join(paint(C.dim, ' · '));
}

function runsSeg(model, t, links) {
  const runs = ((model && Array.isArray(model.runs) && model.runs) || []).filter((r) => r && typeof r === 'object');
  if (!runs.length) return '';
  const r = runs[0];
  const text = `▶ ${[r.member, r.stage, r.item].filter(Boolean).map((x) => clip(x, 20)).join(' ')}${runs.length > 1 ? ` +${runs.length - 1}` : ''}`;
  return paint(C.cyan, osc8(t.tab('agent-teams'), text, links));
}

function spendSeg(model, t, links) {
  const s = model && model.spend;
  if (!s || !s.family || num(s.usd) === null || !num(s.cap)) return '';
  const text = `${FAMILY_LABEL[s.family] || clip(s.family, 16)} $${s.usd.toFixed(2)}/$${s.cap}`;
  return paint(s.usd / s.cap >= 0.8 ? C.red : C.yellow, osc8(t.tab('settings'), text, links));
}

function healthSeg(model, t, links) {
  const h = (model && model.health) || {};
  const out = [];
  if (h.update) out.push(paint(C.yellow, osc8(t.release(h.update), `↑ ${clip(h.update, 20)}`, links)));
  if (h.provider) out.push(paint(C.red, osc8(t.tab('settings'), `provider none (${clip(h.provider, 24)})`, links)));
  if (h.unwrapped) out.push(paint(C.yellow, 'not wrapped'));
  if (h.drafts) out.push(paint(C.dim, plural(h.drafts, 'draft')));
  return out.join(paint(C.dim, ' · '));
}

const TOKEN_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/y;
/** The first `cols` cells of a styled string, escapes kept whole, ending in … with any open link closed and a reset. */
function clipStyled(s, cols) {
  if (width(s) <= cols) return s;
  let out = '';
  let w = 0;
  let linkOpen = false;
  for (let i = 0; i < s.length;) {
    TOKEN_RE.lastIndex = i;
    const m = TOKEN_RE.exec(s);
    if (m) {
      out += m[0];
      if (m[0].startsWith('\x1b]8;;')) linkOpen = !/^\x1b\]8;;(?:\x07|\x1b\\)$/.test(m[0]);
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    const cw = width(ch);
    if (w + cw > cols - 1) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return `${out}…${linkOpen ? '\x1b]8;;\x07' : ''}${E}0m`;
}

/** Join a line's segments, dropping the highest `drop` first until it fits `columns` (0 = no limit); a last segment
 *  still too wide is clipped rather than left to wrap. */
function fit(segs, columns) {
  let live = segs.filter((s) => s.text);
  const total = (list) => list.reduce((w, s) => w + width(s.text), 0) + width(SEP) * Math.max(0, list.length - 1);
  while (columns > 0 && live.length > 1 && total(live) > columns) {
    const worst = live.reduce((a, b) => (b.drop > a.drop ? b : a));
    live = live.filter((s) => s !== worst);
  }
  const line = live.map((s) => s.text).join(SEP);
  return columns > 0 && width(line) > columns ? clipStyled(line, columns) : line;
}

/** SL-07: a segment that throws on bad data is dropped alone, never the whole line. */
const safe = (fn) => { try { return fn() || ''; } catch { return ''; } };

/**
 * The status line: an array of up to three lines.
 * @param {object} o  { payload, model, work, git, columns, links, segments, env, now }
 */
function render({ payload = {}, model = null, work = null, git = null, columns = 0, links = true, segments = DEFAULT_SEGMENTS, env = {}, now = Date.now() } = {}) {
  const p = payload || {};
  const t = targets();
  const on = new Set(segments || DEFAULT_SEGMENTS);
  const lines = [
    fit([{ text: safe(() => modelSeg(p)) || 'Claude', drop: 0 }, { text: safe(() => workSeg(work)), drop: 2 }, { text: safe(() => dirSeg(p, git)), drop: 1 }, { text: safe(() => prSeg(p, links)), drop: 3 }], columns),
    fit([{ text: safe(() => contextSeg(p, env)), drop: 0 }, { text: safe(() => limitsSeg(p, now)), drop: 1 }, { text: safe(() => costSeg(p)), drop: 2 }, { text: safe(() => cacheSeg(p, now)), drop: 3 }, { text: safe(() => linesSeg(p)), drop: 4 }], columns),
    fit([
      { text: on.has('needs-you') ? safe(() => needsSeg(model, t, links)) : '', drop: 0 },
      { text: on.has('runs') ? safe(() => runsSeg(model, t, links)) : '', drop: 1 },
      { text: on.has('spend') ? safe(() => spendSeg(model, t, links)) : '', drop: 2 },
      { text: on.has('health') ? safe(() => healthSeg(model, t, links)) : '', drop: 3 },
    ], columns),
  ];
  return lines.filter((l) => l);
}

/** The plain one-liner for a session-start notice (the Codex footer cannot run a command, D7); '' when all is quiet. */
function summaryLine(model, segments = DEFAULT_SEGMENTS) {
  if (!model) return '';
  const on = new Set(segments || DEFAULT_SEGMENTS);
  const n = model.needs || {};
  const parts = [];
  if (on.has('needs-you')) {
    const gates = Array.isArray(n.gates) ? n.gates : [];
    if (gates.length) parts.push(`${plural(gates.length, 'gate')} need${gates.length === 1 ? 's' : ''} you (${gates.slice(0, 3).map((g) => `${g.item}${g.stage ? ` ${g.stage}` : ''}`).join(', ')}${gates.length > 3 ? ', …' : ''})`);
    if (n.breaking) parts.push(`${n.breaking} breaking`);
    if (n.alerts) parts.push(plural(n.alerts, 'alert'));
    if (n.flags) parts.push(plural(n.flags, 'open flag'));
  }
  if (on.has('runs') && Array.isArray(model.runs) && model.runs.length) {
    const r = model.runs[0];
    parts.push(`running: ${[r.member, r.stage, r.item].filter(Boolean).join(' ')}${model.runs.length > 1 ? ` +${model.runs.length - 1}` : ''}`);
  }
  if (on.has('spend') && model.spend && model.spend.family) parts.push(`${FAMILY_LABEL[model.spend.family] || model.spend.family} spend $${model.spend.usd.toFixed(2)} of $${model.spend.cap} today`);
  if (on.has('health') && model.health) {
    const h = model.health;
    if (h.update) parts.push(`update ${h.update} available`);
    if (h.provider) parts.push(`background provider is none (${h.provider})`);
    if (h.unwrapped) parts.push('last session not wrapped');
  }
  return parts.length ? clean(`AgenticOS: ${parts.join(' · ')}`) : '';
}

function startedMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Claude Code subagentStatusLine rows: one `{"id","content"}` JSON line per task (D8). A task without an id is left
 * to Claude Code's default row.
 */
function subagentRows(input, { now = Date.now(), columns = 0 } = {}) {
  const tasks = input && Array.isArray(input.tasks) ? input.tasks : [];
  const cols = num(input && input.columns) || columns;
  const out = [];
  for (const task of tasks) {
    if (!task || task.id === undefined || task.id === null) continue;
    const model = shortModel(task.model);
    const pct = num(task.tokenCount) && num(task.contextWindowSize) ? Math.min(100, Math.round((task.tokenCount / task.contextWindowSize) * 100)) : null;
    const start = startedMs(task.startTime);
    const segs = [
      { text: paint(C.bold, clip(task.name || task.type || 'agent', 28)), drop: 0 },
      { text: task.description ? paint(C.dim, clip(task.description, 48)) : '', drop: 3 },
      { text: model ? paint(C.dim, `${clip(model, 24)}${typeof task.effort === 'string' ? ` ·${clip(task.effort, 12)}` : ''}`) : '', drop: 2 },
      { text: pct === null ? '' : paint(pct < 50 ? C.green : pct < 80 ? C.yellow : C.red, `ctx ${pct}%`), drop: 1 },
      { text: start === null ? '' : paint(C.dim, until(now - start)), drop: 4 },
    ];
    out.push(JSON.stringify({ id: task.id, content: fit(segs, cols) }));
  }
  return out;
}

module.exports = {
  REPO_SLUG, DEFAULT_SEGMENTS, width, plain, clean, clip, clipStyled, safeHttps, until, compactModel, shortModel, contextUsed, targets, fit,
  render, summaryLine, subagentRows,
};
