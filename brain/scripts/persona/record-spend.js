#!/usr/bin/env node
'use strict';
/**
 * record-spend.js — duty spend → provider ledger, plus the daily-cap check run-duty.sh
 * consults before starting a duty. Contract §1/§6: persona.perDayUsd gates duties by
 * summing only ledger rows whose feature starts with "duty:"; persona.perDutyUsd is one
 * run's --max-budget-usd; claude.perDayUsd belongs to background hook calls, not duties.
 *
 *   node persona/record-spend.js --check
 *       prints {allowed, spentToday, perDayUsd, perDutyUsd}; exit 0 when allowed, 3 when capped. One cap over both hosts:
 *       every duty:* row counts, whichever provider (local-first A4: a capped day is skipped on every host, never moved)
 *   node persona/record-spend.js --file <output> --feature duty:<name> --model <model> [--allowed <allowlist>]
 *       parses `claude -p --output-format json` output — or, when the file holds a `codex exec --json`
 *       event stream (codex runner, codex-parity D5), prices its usage block — and appends one ledger row.
 *       A Claude run that was refused tool calls (`permission_denials`) also appends one line to
 *       <vault>/brain/_index/duty-denials.jsonl, each call paired with the --allowed rule that names the same script
 *       (spec 2026-10-24-persona-learning-loop-design D11); tick.js turns it into a `duty-denied` signal
 *
 * Rows go through sdk/lib/provider.js recordSpend when that module loads; otherwise they are
 * appended to <vault>/brain/_index/provider-spend.jsonl with the same row shape. The duty sum
 * is always read from that file with dutySpendFrom(): provider.spendToday() sums the hook rows
 * only (it excludes duty:* by default — contract §3), so it cannot serve as the duty cap.
 */
const fs = require('fs');
const path = require('path');

/** Last line that parses as a JSON object (claude may print stray lines first). */
function parseClaudeJson(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o && typeof o === 'object') return o; } catch { /* try the previous line */ }
  }
  return null;
}

/** The allowlist rule a denied Bash command came closest to: the first `Bash(…)` rule naming one of the scripts the
 *  command runs (a path whose last segment has an extension, such as …/tick.js), so a wrong node spelling reads as
 *  such. A folder argument (`git -C <vault>`) names no script. Null when none. */
function nearRule(command, allowed) {
  const rules = String(allowed || '').match(/Bash\([^)]*\)/g) || [];
  const keys = String(command || '').split(/\s+/).filter((w) => w.includes('/')).map((w) => w.split('/').pop()).filter((k) => /^[\w.-]+\.[a-z0-9]+$/i.test(k));
  return rules.find((r) => keys.some((k) => r.includes(`/${k}`))) || null;
}

/** A Claude run's refused calls: [{ tool, input, near }], at most 10, the input clipped to 300 characters. Codex has no
 *  per-tool allowlist (its sandbox is the guard), so its event stream has none. */
function deniedCalls(json, allowed = '') {
  const list = json && Array.isArray(json.permission_denials) ? json.permission_denials : [];
  return list.slice(0, 10).map((d) => {
    const input = (d && d.tool_input) || {};
    const what = String(input.command || input.file_path || input.notebook_path || '').slice(0, 300);
    const tool = String((d && d.tool_name) || 'unknown');
    return { tool, input: what, near: tool === 'Bash' ? nearRule(what, allowed) : null };
  });
}

/** The `codex exec --json` event stream → { isCodex, usage, errors } (codex-parity D5). Mirrors sdk/lib/codex-cli.js parseEvents
 *  without its vault-bound requires, so run-duty.sh can call this file in a bare sandbox. */
function parseCodexEvents(text) {
  let usage = null;
  let isCodex = false;
  const errors = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') continue;
    if (/^(thread|turn|item)\./.test(ev.type)) isCodex = true;
    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      usage = {
        inputTokens: ev.usage.input_tokens || 0,
        cachedInputTokens: ev.usage.cached_input_tokens || 0,
        outputTokens: ev.usage.output_tokens || 0,
        reasoningOutputTokens: ev.usage.reasoning_output_tokens || 0,
      };
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      errors.push(String((ev.error && ev.error.message) || ev.message || ev.type));
    } else if (ev.type === 'item.completed' && ev.item && ev.item.type === 'error' && ev.item.message) {
      errors.push(String(ev.item.message));
    }
  }
  return { isCodex, usage, errors };
}

/** A ledger row for a codex runner run: the spend is an estimate from the usage block (Codex reports tokens,
 *  never dollars); `model` empty → the Codex default from config.toml when readable, else the default rate. */
function rowFromCodex(text, { feature, model, ms = 0 }) {
  const { usage } = parseCodexEvents(text);
  let priced = model && model !== 'codex-default' ? model : null;
  if (!priced) { try { priced = require('../sdk/lib/codex-cli.js').defaultModelFromConfig() || null; } catch { priced = null; } }
  let usd = 0;
  if (usage) { try { usd = require('../sdk/lib/codex-pricing.js').priceUsd(priced, usage); } catch { usd = 0; } }
  return {
    ts: new Date().toISOString(),
    feature, provider: 'codex', model: priced || 'codex-default',
    usd: Number(usd) || 0,
    inputTokens: usage ? usage.inputTokens : 0,
    outputTokens: usage ? usage.outputTokens : 0,
    ms: Number(ms) || 0,
  };
}

function rowFrom(json, { feature, model, provider = 'claude' }) {
  const usage = (json && json.usage) || {};
  return {
    ts: new Date().toISOString(),
    feature, provider, model,
    usd: Number(json && json.total_cost_usd) || 0,
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    ms: Number(json && (json.duration_api_ms || json.duration_ms)) || 0,
  };
}

function check({ spendToday, perDayUsd }) {
  const spentToday = spendToday();
  return { allowed: spentToday < perDayUsd, spentToday, perDayUsd };
}

/** USD sum of ledger rows whose feature starts with "duty:" and whose ts is on `day` (local calendar day), any provider. */
function dutySpendFrom(text, day = new Date()) {
  const key = day.toDateString();
  let sum = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.feature !== 'string' || !r.feature.startsWith('duty:')) continue;
    if (new Date(r.ts).toDateString() !== key) continue;
    sum += Number(r.usd) || 0;
  }
  return sum;
}

function provider() {
  try { return require('../sdk/lib/provider.js'); } catch { return null; }   // Plan 2 module; absent → local fallback
}
function ledgerPath() {
  const p = provider();
  if (p && typeof p.SPEND_PATH === 'string') return p.SPEND_PATH;
  return path.join(require('../lib/paths.js').PATHS.INDEX, 'provider-spend.jsonl');
}
/** Appends one row and returns the row as written — provider.recordSpend re-stamps `ts`, so the printed row
 *  must be its return value, not the input (execution amendment 2026-09-15, A27). */
function recordSpend(row) {
  const p = provider();
  if (p && typeof p.recordSpend === 'function') return p.recordSpend(row) || row;
  const file = ledgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}
/** brain/_index/duty-denials.jsonl, beside the spend ledger. */
function denialsPath() { return path.join(path.dirname(ledgerPath()), 'duty-denials.jsonl'); }
/** Appends { schema: 1, ts, duty, model, count, denied } when the run was refused any call; returns the record or null. */
function recordDenials({ duty, model, denied, now = new Date(), file = denialsPath() }) {
  if (!denied.length) return null;
  const rec = { schema: 1, ts: now.toISOString(), duty, model: model || null, count: denied.length, denied };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  return rec;
}
function dutySpendToday() {
  try { return dutySpendFrom(fs.readFileSync(ledgerPath(), 'utf8')); } catch { return 0; }   // no ledger yet
}
/** Null-ish numeric guard: an explicit finite, non-negative number (including 0) is honoured; anything
 *  else (missing, NaN, negative, non-number) falls back to the default. Final review F6/spec-8: the old
 *  `Number(v) || d` turned an explicit 0 into the default, silently handing "$0/day" users $6/day. */
function n(v, d) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d; }
function caps() {
  let persona = {};
  try { persona = require('../lib/config.js').loadConfig().persona || {}; } catch { /* contract defaults below */ }
  return { perDayUsd: n(persona.perDayUsd, 6), perDutyUsd: n(persona.perDutyUsd, 2) };
}

function main(argv) {
  const arg = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : null; };
  if (argv.includes('--check')) {
    const { perDayUsd, perDutyUsd } = caps();
    const r = { ...check({ spendToday: dutySpendToday, perDayUsd }), perDutyUsd };
    r.allowed = r.allowed && perDutyUsd > 0;   // a $0 per-duty budget refuses to start (F6): undefined --max-budget-usd 0 semantics otherwise
    process.stdout.write(JSON.stringify(r) + '\n');
    return r.allowed ? 0 : 3;
  }
  const file = arg('--file');
  if (!file) { process.stderr.write('usage: record-spend.js --check | --file <json> --feature duty:<name> --model <model>\n'); return 2; }
  const text = fs.readFileSync(file, 'utf8');
  const feature = arg('--feature') || 'duty:unknown';
  // A codex runner writes its `--json` event stream to the same file; the row is then an estimate (D5).
  const isCodex = parseCodexEvents(text).isCodex;
  const json = isCodex ? null : parseClaudeJson(text);
  const row = isCodex
    ? rowFromCodex(text, { feature, model: arg('--model') || null })
    : rowFrom(json, { feature, model: arg('--model') || 'unknown' });
  const written = recordSpend(row);   // execution amendment 2026-09-15 (A27): print what the ledger wrote
  process.stdout.write(JSON.stringify(written) + '\n');
  try {
    const rec = recordDenials({ duty: feature.replace(/^duty:/, ''), model: row.model, denied: deniedCalls(json, arg('--allowed')) });
    if (rec) process.stdout.write(JSON.stringify({ denials: rec.count, near: rec.denied.map((d) => d.near).filter(Boolean) }) + '\n');
  } catch (e) { process.stderr.write(`record-spend: could not record the denials (${e.message})\n`); }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { parseClaudeJson, parseCodexEvents, rowFrom, rowFromCodex, check, dutySpendFrom, dutySpendToday, caps, deniedCalls, nearRule, recordDenials };
