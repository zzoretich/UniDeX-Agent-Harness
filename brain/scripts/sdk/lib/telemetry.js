/**
 * telemetry.js — capture every local-reasoner run for the Heartbeat dashboard.
 *
 * Emits three artifacts per run:
 *   1. Append a one-line summary to brain/_index/agent-runs/runs.jsonl
 *   2. Write a full timeline JSON under brain/_index/agent-runs/<YYYY-MM-DD>/<id>.json
 *   3. Stream events to brain/_index/agent-runs/live/<id>.ndjson while running,
 *      delete on endRun.
 *
 * Used directly by the sdk/ CLI entry points (ask.js, reflect-week.js, consolidate-memory.js,
 * standup.js, compress.js) and by heartbeat-writer.js; telemetry-hook.js drives
 * the same on-disk shape from Claude Code's native hooks instead of this module.
 *
 * Redaction: on when config telemetry.redact (default true) or BRAIN_AGENT_REDACT=1 —
 * prompt/reply text is omitted from on-disk records.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const brain = require('./brain.js');

const RUNS_DIR = path.join(brain.PATHS.VAULT, 'brain/_index/agent-runs');
const LIVE_DIR = path.join(RUNS_DIR, 'live');
const SUMMARY_LOG = path.join(RUNS_DIR, 'runs.jsonl');
const TRUNC = 500;
const SUMMARY_MAX = 200;

function isRedacted() {
  if (process.env.BRAIN_AGENT_REDACT === '1') return true;
  try { return require('../../lib/config.js').loadConfig().telemetry.redact !== false; } catch { return true; }
}

function ensureDirs() {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
}

function shortId() {
  return crypto.randomBytes(2).toString('hex');
}

function dayFolder(date) {
  return date.toISOString().slice(0, 10);
}

function truncate(str, n) {
  if (str == null) return null;
  const s = String(str);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function summarize(value, n = SUMMARY_MAX) {
  if (value == null) return '';
  if (typeof value === 'string') return truncate(value, n);
  if (Array.isArray(value)) {
    const text = value
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
    if (text) return truncate(text, n);
    try { return truncate(JSON.stringify(value), n); } catch { return ''; }
  }
  if (typeof value === 'object') {
    try { return truncate(JSON.stringify(value), n); } catch { return ''; }
  }
  return truncate(String(value), n);
}

function mapSdkMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    const texts = [];
    const tools = [];
    for (const block of msg.message.content) {
      if (!block) continue;
      if (block.type === 'text' && block.text) {
        texts.push(block.text);
      } else if (block.type === 'tool_use') {
        const tool = {
          id: block.id,
          name: block.name,
          input_summary: summarize(block.input),
        };
        if ((block.name === 'Task' || block.name === 'Agent') && block.input && block.input.subagent_type) {
          tool.subagent_type = block.input.subagent_type; // survives summarize() truncation
        }
        tools.push(tool);
      }
    }
    if (tools.length) {
      const evt = { type: 'tool_use_batch', tools };
      if (texts.length) evt.text = truncate(texts.join(''), SUMMARY_MAX);
      return evt;
    }
    if (texts.length) {
      return { type: 'assistant_text', text: truncate(texts.join(''), SUMMARY_MAX) };
    }
    return null;
  }

  if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
    const results = [];
    for (const block of msg.message.content) {
      if (!block) continue;
      if (block.type === 'tool_result') {
        results.push({
          tool_use_id: block.tool_use_id,
          output_summary: summarize(block.content),
          is_error: !!block.is_error,
        });
      }
    }
    if (results.length) return { type: 'tool_result_batch', results };
    return null;
  }

  if (msg.type === 'result') {
    return {
      type: 'result',
      subtype: msg.subtype,
      is_error: !!msg.is_error,
      cost_usd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
      turns: typeof msg.num_turns === 'number' ? msg.num_turns : null,
    };
  }

  if (msg.type === 'system') {
    return { type: 'system', subtype: msg.subtype || null };
  }

  return { type: msg.type || 'unknown' };
}

function startRun({ script, prompt }) {
  ensureDirs();
  const startedAt = new Date();
  const startedTs = startedAt.getTime();
  const id = `${Math.floor(startedTs / 1000)}-${script}-${shortId()}`;
  const liveFile = path.join(LIVE_DIR, `${id}.ndjson`);

  const header = {
    type: 'run_start',
    id,
    script,
    started_at: startedAt.toISOString(),
    pid: process.pid,
    prompt: isRedacted() ? null : truncate(prompt, TRUNC),
  };
  try {
    fs.writeFileSync(liveFile, JSON.stringify(header) + '\n');
    // Surface the run id to spawning processes (e.g. the Workbench's
    // askSpawner) so they can subscribe to this run's events live. Stderr
    // keeps stdout reserved for the script's actual output.
    process.stderr.write(`[telemetry] run_id=${id}\n`);
  } catch (err) {
    process.stderr.write(`[telemetry] failed to open live file: ${err.message}\n`);
  }

  return {
    id,
    script,
    startedAt,
    startedTs,
    liveFile,
    events: [],
    prompt,
  };
}

function recordEvent(run, msg) {
  if (!run) return;
  const evt = mapSdkMessage(msg);
  if (!evt) return;
  evt.ts = Date.now();
  run.events.push(evt);
  try {
    fs.appendFileSync(run.liveFile, JSON.stringify(evt) + '\n');
  } catch {
    /* live file write best-effort */
  }
}

function aggregateRunStats(run) {
  let toolCount = 0;
  const subagents = new Set();
  for (const e of run.events) {
    if (e.type !== 'tool_use_batch') continue;
    toolCount += e.tools.length;
    for (const t of e.tools) {
      if (t.name !== 'Task' && t.name !== 'Agent') continue;
      if (t.subagent_type) { subagents.add(t.subagent_type); continue; } // robust, untruncated
      if (t.input_summary) {                                            // legacy fallback
        const m = t.input_summary.match(/"subagent_type"\s*:\s*"([^"]+)"/);
        if (m) subagents.add(m[1]);
      }
    }
  }
  return { toolCount, subagents: Array.from(subagents) };
}

async function endRun(run, opts = {}) {
  if (!run) return null;
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - run.startedTs;

  const resultEvent = run.events.find(e => e.type === 'result');
  const finalCost = opts.costUsd != null ? opts.costUsd : (resultEvent ? resultEvent.cost_usd : null);
  const finalTurns = opts.turns != null ? opts.turns : (resultEvent ? resultEvent.turns : null);
  const errorMsg = opts.error ? String(opts.error.message || opts.error.subtype || opts.error) : null;
  const finalStatus = opts.status
    || (errorMsg ? 'error' : (resultEvent && resultEvent.is_error ? 'error' : 'ok'));

  const { toolCount, subagents } = aggregateRunStats(run);

  const summary = {
    id: run.id,
    script: run.script,
    started_at: run.startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: durationMs,
    cost_usd: finalCost,
    turns: finalTurns,
    status: finalStatus,
    prompt: isRedacted() ? null : truncate(run.prompt, TRUNC),
    reply: isRedacted() ? null : truncate(opts.reply, TRUNC),
    tool_count: toolCount,
    subagents,
    error: errorMsg,
  };

  const dayDir = path.join(RUNS_DIR, dayFolder(run.startedAt));
  try {
    fs.mkdirSync(dayDir, { recursive: true });
    const timelineFile = path.join(dayDir, `${run.id}.json`);
    fs.writeFileSync(
      timelineFile,
      JSON.stringify({ id: run.id, summary, events: run.events }, null, 2)
    );
  } catch (err) {
    process.stderr.write(`[telemetry] failed to write timeline: ${err.message}\n`);
  }

  try {
    require('../../lib/fsx.js').appendLineSync(SUMMARY_LOG, JSON.stringify(summary), { lock: true }); // never lost to a retention rewrite
  } catch (err) {
    process.stderr.write(`[telemetry] failed to append runs.jsonl: ${err.message}\n`);
  }

  try { fs.unlinkSync(run.liveFile); } catch { /* may already be gone */ }

  return summary;
}

function attachTelemetry({ script, prompt }) {
  const run = startRun({ script, prompt });
  return {
    run,
    onMessage: (msg) => recordEvent(run, msg),
  };
}

module.exports = {
  startRun,
  recordEvent,
  endRun,
  attachTelemetry,
  RUNS_DIR,
  LIVE_DIR,
  SUMMARY_LOG,
};
