#!/usr/bin/env node
'use strict';
/**
 * briefing.js — the Chief of Staff's paragraph at the top of the Workbench's Pulse tab (spec
 * 2026-10-08-pulse-cockpit-design P6, P7, P13). Run by the `briefing` routine (kind: command, every 30 minutes from
 * 7:00 to 22:00) and by Pulse's ↻ with --force.
 *
 *   node persona/briefing.js [--force] [--root <vault>]
 *
 * Steps: nothing at all while the persona is off (persona.enabled false or persona/DISABLED) or persona.briefing.enabled
 * is false. Otherwise the facts (lib/pulse-facts.js); unchanged facts since the last good paragraph end the run without a
 * model call unless --force. Then the provider; for a hosted one the duty cap (persona.perDayUsd over today's duty:*
 * ledger rows, as run-duty.sh checks before a duty: a command routine is not gated by the runner), then one provider.js
 * chat with a JSON schema. A hosted call is ledgered as `duty:briefing`, so it spends from the Chief of Staff's budget,
 * not the hook cap; the background models are claude.model / codex.model (spec A1); Ollama, when it answers, is free and
 * first. Under provider local the local engine writes it, free and counted in local-usage.json, never held to the duty
 * cap; with the engine down the run is skipped with `local-down` and Pulse shows the facts alone (local-first A1, A3).
 *
 * Output: <vault>/brain/_index/briefing.json (schema 1), written atomically:
 *   { schema, status: ok|skipped|failed, reason, text, mentions[{phrase, area}], persona, provider, model, generatedAt,
 *     attemptedAt, factsHash }
 * A skipped or failed run keeps the last good text, mentions and generatedAt, so the Workbench can say what it shows;
 * it shows the model's text only while status is ok and generatedAt is within persona.briefing.staleHours, and composes
 * the paragraph from the same facts otherwise (P7). The model writes only the text, from words written here for each
 * item ("say"); the mentions are those words found again in its text, each with the Pulse area it opens (A3).
 *
 * Exit 0 for ok, unchanged, off, skipped and busy; 1 when the call or its reply failed, so the routine's fail streak
 * shows a briefing that keeps failing under Routines. One JSON line on stdout says what happened.
 */
const fs = require('fs');
const path = require('path');

const PF = require('../lib/pulse-facts.js');

const SCHEMA = 1;
const LOCK_STALE_MS = 3 * 60e3;
const MAX_TEXT = 700;
const MAX_MENTIONS = 8;
const TOP = 3;

// The areas a mention may open: exactly the Pulse areas.
const AREAS = PF.AREAS;

// The model writes only the text; the clickable phrases are found in it afterwards (spec amendment A3).
const REPLY_SCHEMA = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } };

function defaultDeps(root) {
  const vault = root || require('../lib/paths.js').PATHS.VAULT;
  const RS = require('./record-spend.js');
  return {
    vault,
    now: () => new Date(),
    config: () => require('../lib/config.js').loadConfig(),
    facts: (v, now) => PF.facts(PF.read(v, { now }), now),
    dutySpend: () => RS.dutySpendToday(),
    caps: () => RS.caps(),
    provider: () => require('../sdk/lib/provider.js').getProvider('duty:briefing'),
  };
}

const outPath = (vault) => path.join(vault, 'brain', '_index', 'briefing.json');
const lockPath = (vault) => path.join(vault, 'brain', '_index', 'briefing.lock');

function readOut(vault) {
  try {
    const o = JSON.parse(fs.readFileSync(outPath(vault), 'utf8'));
    return o && typeof o === 'object' && o.schema === SCHEMA ? o : null;
  } catch { return null; }
}

function writeOut(vault, o) {
  require('../lib/fsx.js').writeAtomic(outPath(vault), `${JSON.stringify(o, null, 2)}\n`);
}

function personaOff(cfg, vault) {
  return !!(cfg.persona && cfg.persona.enabled === false) || fs.existsSync(path.join(vault, 'persona', 'DISABLED'));
}
function briefingOff(cfg) {
  const b = cfg.persona && cfg.persona.briefing;
  return !!(b && b.enabled === false);
}

/** Takes the lock, or null when another live run holds it (a lock older than LOCK_STALE_MS is a dead run's: taken over). */
function lock(vault, now) {
  const file = lockPath(vault);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: now.toISOString() }), { flag: 'wx' });
      return () => { try { fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = Infinity;
      // Wall-clock age: a lock's mtime is the OS clock's, whatever `now` the run was given.
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* vanished: retry */ }
      if (age < LOCK_STALE_MS) return null;
      try { fs.unlinkSync(file); } catch { /* raced: retry */ }
    }
  }
  return null;
}

function partOfDay(d) { const h = d.getHours(); return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; }

/** `s` cut to `max` characters at a word boundary, with an ellipsis. */
function clip(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

/** The words the paragraph uses for an item. Written here, not by the model, so it only joins them and Pulse can find
 *  them again in the text. A proposal's title is quoted, so "the “An idea with loose ends” proposal" still reads. */
function sayOf(n) {
  if (n.kind === 'proposal') return /\bproposal$/i.test(n.title) ? `the “${clip(n.title, 60)}”` : `the “${clip(n.title, 60)}” proposal`;
  return clip(n.title, n.kind === 'flag' ? 70 : 80);
}

/** The top items: the words to use, the area each opens, and how long it has waited (two days or more). */
function briefItems(f, now) {
  return f.needsYou.slice(0, TOP).map((n) => {
    const days = n.since ? PF.ageDays(String(n.since).slice(0, 10), now) : null;
    return { say: sayOf(n), area: n.area, ...(days !== null && days >= 2 ? { waiting: `${days} days` } : {}) };
  });
}

/** What is fine: short phrases from the summary, each with the area it opens. */
function fineOf(s) {
  const out = [];
  if (s.routines && s.routines.total && !s.routines.failing) out.push({ say: `${s.routines.total} routines green`, area: 'routines' });
  const p = s.health && s.health.pipelines;
  if (p && !p.failed && !p.stale && p.ok) out.push({ say: 'pipelines healthy', area: 'health' });
  if (s.todo && s.todo.open && !s.todo.overdue) out.push({ say: 'no overdue to-dos', area: 'todo' });
  if (s.spend && s.spend.usd) out.push({ say: `$${s.spend.usd.toFixed(2)} spent today`, area: 'spend' });
  return out;
}

/** The system prompt: the persona's voice and the rules. */
function systemPrompt(name) {
  const who = name ? `You are ${name}, the user's Chief of Staff` : "You are the user's Chief of Staff";
  return [
    `${who}. Write the short briefing at the top of the user's dashboard from the items given.`,
    'Rules:',
    '- Two or three sentences, under 70 words, plain prose: no lists, headings, markdown or emoji.',
    '- Start with "Good morning", "Good afternoon" or "Good evening", as the time says.',
    '- Use each "say" text exactly as written, quotation marks included; only its first letter may change case.',
    '- First sentence: the first item, with its "waiting" when it has one.',
    '- Then the other items, then "and N more" when "more" is above 0.',
    '- End with what is fine, from the "fine" texts, when there are any.',
    '- Add nothing else: no dates, times, causes, advice or other names.',
    'Reply with JSON only: {"text": "..."}.',
  ].join('\n');
}

/** The user prompt: the time of day, the top items, how many more, and what is fine. */
function userPrompt(f, now) {
  return [
    `Time: ${partOfDay(now)}.`,
    `items (most urgent first): ${JSON.stringify(briefItems(f, now))}`,
    `more: ${Math.max(0, f.needsYou.length - TOP)}`,
    `fine: ${JSON.stringify(fineOf(f.summary || {}))}`,
  ].join('\n');
}

/** The clickable phrases, in text order: each item's and each fine phrase's words where the text has them (any case),
 *  and "N more", which opens the whole list. Overlapping finds keep the first. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const MORE_RE = new RegExp(`\\b(?:\\d+|${NUMBER_WORDS.slice(1).join('|')}) (?:more|others?)\\b`, 'i');

/** Text folded for finding a phrase: any case, and any double quote as `"`, one character for one so an index into the
 *  folded text is an index into the text. */
const fold = (s) => s.toLowerCase().replace(/[“”„‟″"]/g, '"');

function mentionsFor(text, items, fine) {
  const lower = fold(text);
  const found = [];
  const add = (say, area) => {
    // A model may spell a leading count out ("Two hook paths" for "2 hook paths"): both are the same words.
    const lead = /^(\d+)(\s.*)$/.exec(say);
    const forms = lead && NUMBER_WORDS[Number(lead[1])] ? [say, NUMBER_WORDS[Number(lead[1])] + lead[2]] : [say];
    // It may also drop a title's quotes ("the Weekly digest proposal"), or write straight ones (folded above).
    if (/[“”"]/.test(say)) forms.push(say.replace(/[“”"]/g, ''));
    for (const w of forms) {
      const at = lower.indexOf(fold(w));
      if (at < 0) continue;
      if (!found.some((m) => at < m.at + m.len && m.at < at + w.length)) found.push({ at, len: w.length, area });
      return;
    }
  };
  for (const it of items) add(it.say, it.area);
  for (const f of fine) add(f.say, f.area);
  const more = MORE_RE.exec(text);
  if (more) add(more[0], 'needs');
  return found.sort((a, b) => a.at - b.at).slice(0, MAX_MENTIONS).map((m) => ({ phrase: text.slice(m.at, m.at + m.len), area: m.area }));
}

/** The reply's text: JSON, or the first {...} in it; null when neither parses or there is no text. */
function parseReply(reply) {
  const s = String(reply || '').trim();
  let o = null;
  try { o = JSON.parse(s); } catch {
    const m = /\{[\s\S]*\}/.exec(s);
    if (m) { try { o = JSON.parse(m[0]); } catch { o = null; } }
  }
  if (!o || typeof o !== 'object' || typeof o.text !== 'string' || !o.text.trim()) return null;
  return { text: o.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) };
}

/** One run. Resolves to { status, reason?, wrote } and never throws. */
async function run({ deps = defaultDeps(), force = false } = {}) {
  const now = deps.now();
  const vault = deps.vault;
  let cfg = {};
  try { cfg = deps.config() || {}; } catch { /* defaults */ }
  if (personaOff(cfg, vault)) return { status: 'off', reason: 'persona-off', wrote: false };
  if (briefingOff(cfg)) return { status: 'off', reason: 'briefing-off', wrote: false };

  const release = lock(vault, now);
  if (!release) return { status: 'busy', wrote: false };
  try {
    const f = deps.facts(vault, now);
    const prev = readOut(vault);
    if (!force && prev && prev.status === 'ok' && prev.factsHash === f.hash) return { status: 'unchanged', wrote: false };
    const keep = prev ? { text: prev.text || null, mentions: prev.mentions || [], persona: prev.persona || null, provider: prev.provider || null, model: prev.model || null, generatedAt: prev.generatedAt || null } : { text: null, mentions: [], persona: null, provider: null, model: null, generatedAt: null };
    const end = (status, reason, extra = {}) => {
      writeOut(vault, { schema: SCHEMA, status, reason: reason || null, ...keep, ...extra, attemptedAt: now.toISOString(), factsHash: extra.factsHash || (prev && prev.factsHash) || null });
      return { status, reason, wrote: true };
    };

    let p;
    try { p = await deps.provider(); } catch (e) { return end('skipped', `provider: ${e.message}`); }
    // The local engine spends nothing (local-first A1, A18): only a hosted answer is held to the duty cap. With no
    // provider (under provider local: the engine down, `local-down`) Pulse composes the paragraph from the facts (A3).
    if (!p || p.name === 'none') return end('skipped', (p && p.reason) || 'no-provider');
    if (!p.engine) {
      const caps = deps.caps();
      if (!(caps.perDayUsd > 0) || deps.dutySpend() >= caps.perDayUsd) return end('skipped', 'daily-cap');
    }

    let reply;
    try {
      reply = await p.chat({
        system: systemPrompt(f.persona), prompt: userPrompt(f, now), schema: REPLY_SCHEMA, format: REPLY_SCHEMA,
        feature: 'duty:briefing', timeoutMs: 80000, numPredict: 400,
      });
    } catch (e) {
      if (e && (e.code === 'PROVIDER_CAP' || e.code === 'PROVIDER_NONE')) return end('skipped', e.code === 'PROVIDER_CAP' ? 'daily-cap' : 'no-provider');
      return end('failed', String((e && e.message) || e).slice(0, 200));
    }
    const parsed = parseReply(reply);
    if (!parsed) return end('failed', 'unreadable reply');
    return end('ok', null, {
      text: parsed.text, mentions: mentionsFor(parsed.text, briefItems(f, now), fineOf(f.summary || {})), persona: f.persona, provider: p.name, model: p.model || null,
      generatedAt: now.toISOString(), factsHash: f.hash,
    });
  } catch (e) {
    return { status: 'failed', reason: String((e && e.message) || e).slice(0, 200), wrote: false };
  } finally {
    release();
  }
}

async function main(argv) {
  const at = argv.indexOf('--root');
  const root = at !== -1 ? argv[at + 1] : null;
  const r = await run({ deps: defaultDeps(root ? path.resolve(root) : null), force: argv.includes('--force') });
  process.stdout.write(`${JSON.stringify(r)}\n`);
  return r.status === 'failed' ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));

module.exports = { SCHEMA, AREAS, REPLY_SCHEMA, defaultDeps, outPath, readOut, systemPrompt, userPrompt, sayOf, briefItems, fineOf, mentionsFor, parseReply, run, lock };
