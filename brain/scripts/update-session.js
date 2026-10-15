#!/usr/bin/env node
/**
 * Stop hook — runs after every Claude response.
 * - Writes a last-active marker to today's daily note
 * - Every summary.everyPrompts prompts the user typed in this session (default 10), and no sooner than
 *   summary.minMinutes after its last summary (default 15), respawns detached and summarizes through the provider:
 *     ollama/claude → model summary into BRAIN.md "Last Session", the daily note, SESSION.md
 *     none          → heuristic Key Context (last prompts, files touched, commands) into SESSION.md
 * - Parses the transcript from transcript_path (JSONL on disk)
 * - Drops junk model output (empty-log boilerplate) before writing anywhere
 * - Ledger: ok when something was written, skipped otherwise, always with the provider name
 */

const { PATHS, dailyNotePath } = require('./lib/hook-entry.js').hookEntry();
const { finishStop } = require('./lib/hook-entry.js');
const { parseEntries } = require('./lib/transcript.js');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { withReport } = require('./lib/pipeline-report.js');
const { summarize } = require('./sdk/lib/qwen.js');
const { getProvider } = require('./sdk/lib/provider.js');
const { workingMemoryFromTranscript } = require('./lib/heuristics.js');
const { markerPath } = require('./lib/markers.js');
const fsx = require('./lib/fsx.js');

const VAULT = PATHS.VAULT;
const BRAIN = PATHS.BRAIN_MD;
const SESSION_MD = PATHS.SESSION_MD;

const _d = new Date();
const today = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
const sessionFile = dailyNotePath(_d);

// The throttle (spec 2026-09-24-summary-throttle). It used to count every user entry, a Claude tool result
// included, against one marker per day shared by every session: one busy session summarized every few minutes and
// starved the next session of the day.
const DEFAULT_POLICY = { everyPrompts: 10, minMinutes: 15 };

/** summary.everyPrompts / summary.minMinutes from the config; a missing or bad value falls back to the default. */
function summaryPolicy(cfg) {
  let s = {};
  try { s = ((cfg || require('./lib/config.js').loadConfig()) || {}).summary || {}; } catch (_) { /* defaults */ }
  return {
    everyPrompts: Number.isInteger(s.everyPrompts) && s.everyPrompts > 0 ? s.everyPrompts : DEFAULT_POLICY.everyPrompts,
    minMinutes: Number.isFinite(s.minMinutes) && s.minMinutes >= 0 ? s.minMinutes : DEFAULT_POLICY.minMinutes,
  };
}

/** One marker per session: both hosts send session_id to the Stop hook. A payload without one falls back to the day. */
function summaryMarkerName(input, day = today) {
  const id = input && (input.session_id || input.sessionId);
  return `.last-summary-${id ? String(id) : day}`;
}

/** { prompts, at } from a marker's text. An old marker's bare number counted every user entry, so it starts over. */
function parseSummaryMarker(text) {
  try {
    const j = JSON.parse(String(text || '').trim());
    if (j && typeof j === 'object') return { prompts: Number(j.prompts) || 0, at: Number(j.at) || 0 };
  } catch (_) { /* empty or not JSON */ }
  return { prompts: 0, at: 0 };
}

/** Due when everyPrompts prompts came since the last summary and minMinutes have passed. A count below the marker's
 *  (a transcript that started over) counts from zero. */
function shouldSummarize({ prompts, last, now, everyPrompts, minMinutes }) {
  if (!(prompts > 0)) return false;
  const base = prompts >= last.prompts ? last.prompts : 0;
  return prompts - base >= everyPrompts && now - last.at >= minMinutes * 60000;
}

// Detached worker: does the slow model call in the background so the Stop hook
// itself returns instantly.
async function runDetachedSummary() {
  try {
    await withReport('session-summary', async (report) => {
      const transcriptPath = process.env.BRAIN_TRANSCRIPT || '';
      await summaryCycle({
        transcript: loadTranscript(transcriptPath),
        transcriptText: readTranscriptRaw(transcriptPath),
        report,
      });
    });
  } catch (_) {}
  process.exit(0);
}

/**
 * One summary cycle against an explicit provider (tests) or the resolved one.
 *   none          → heuristic Key Context; ok when it wrote, skipped/no-signal otherwise (under provider local this is
 *                   also the local engine down or its model not pulled: local-first A3, never a hosted call)
 *   ollama/claude → summarizeSession through provider.chat; skipped/no-summary or
 *                   skipped/junk-summary when there is nothing worth writing. The local engine failing mid-call
 *                   (a connection-class error) goes heuristic too.
 */
async function summaryCycle({ transcript, transcriptText = '', provider, chatFn, report, date = today,
  now = new Date().toLocaleString('en-US', { hour12: false }) }) {
  const p = provider || await getProvider('session-summary');
  report.provider = p.name;

  const heuristic = () => {
    const { keyContext } = workingMemoryFromTranscript(transcriptText);
    if (!keyContext.length) { report.skip('no-signal'); return { status: 'skipped' }; }
    const summary = keyContext.map((l) => `- ${l}`).join('\n');
    updateSessionWorkingMemory(summary, now);
    report.counts.written = 1;
    report.wrote.push('brain/_index/SESSION.md');
    return { status: 'ok', summary };
  };
  if (p.name === 'none') {
    if (p.reason === 'local-down' || p.reason === 'local-model-missing') report.counts.localDown = 1;
    return heuristic();
  }

  // summarizeSession swallows every throw and returns null, so the provider's own failure is
  // captured here: a daily cap is an honest skip, anything else must surface as an error
  // instead of being reported as "no-summary".
  let providerErr = null;
  const fn = chatFn || (async (o) => {
    try { return await p.chat({ ...o, feature: 'session-summary' }); }
    catch (e) { providerErr = e; throw e; }
  });
  const summary = await summarizeSession(transcript, date, fn);
  if (!summary && providerErr) {
    if (providerErr.code === 'PROVIDER_CAP') {
      report.counts.skipped = 1;
      report.skip('daily-cap');
      return { status: 'skipped' };
    }
    // The local engine went away mid-call (A3): the heuristic summary, as when it was down at resolve.
    if (p.engine && require('./lib/wrap-queue.js').isRetryable(providerErr)) {
      report.provider = 'none';
      report.counts.localDown = 1;
      return heuristic();
    }
    throw providerErr;
  }
  if (!summary || isJunkSummary(summary)) {
    report.counts.skipped = 1;
    report.skip(summary ? 'junk-summary' : 'no-summary');
    return { status: 'skipped' };
  }
  writeSessionSummary(summary, now);
  updateBrainLastSession(summary, date);
  updateSessionWorkingMemory(summary, now);
  report.counts.written = 1;
  report.wrote.push('brain/_index/SESSION.md', 'brain/_index/BRAIN.md', path.relative(VAULT, sessionFile));
  return { status: 'ok', summary };
}

function readStdinAndRun() {
  let raw = '';
  process.stdin.on('data', chunk => raw += chunk);
  process.stdin.on('end', () => {
    let input = {};
    try {
      input = JSON.parse(raw || '{}');
      const transcriptPath = input.transcript_path || input.transcriptPath || '';
      const transcript = loadTranscript(transcriptPath);
      const parsed = parseEntries(transcript);
      const turnCount = parsed.userTurns;

      const now = new Date().toLocaleString('en-US', { hour12: false });
      writeLastActive(now, turnCount); // fast: marker only

      const marker = markerPath(summaryMarkerName(input));
      const nowMs = Date.now();
      if (shouldSummarize({ prompts: parsed.prompts, last: readSummaryMarker(marker), now: nowMs, ...summaryPolicy() })) {
        writeSummaryMarker(marker, { prompts: parsed.prompts, at: nowMs }); // mark now so we don't spawn twice
        const child = spawn(process.execPath, [__filename], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, BRAIN_SUMMARIZE_DETACHED: '1', BRAIN_TRANSCRIPT: transcriptPath, BRAIN_TURN: String(parsed.prompts) },
        });
        child.unref();
      }
    } catch (_) {}
    finishStop(input);
    process.exit(0);
  });
}

if (require.main === module) {
  if (process.env.BRAIN_SUMMARIZE_DETACHED === '1') {
    runDetachedSummary();
  } else {
    readStdinAndRun();
  }
}

function readTranscriptRaw(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  try { return fs.readFileSync(transcriptPath, 'utf8'); } catch (_) { return ''; }
}

function loadTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch (_) {}
    }
    return entries;
  } catch (_) { return []; }
}

function writeLastActive(now, turns) {
  const marker = `\n<!-- last-active: ${now} | turns: ${turns} -->\n`;
  try {
    // Locked, and brief: this runs inside the Stop hook, so a busy note skips one marker rather than wait.
    if (fs.existsSync(sessionFile)) {
      fsx.updateSync(sessionFile, (content) => (content == null ? null : content.replace(/\n<!-- last-active:.*-->\n/g, '') + marker), { timeoutMs: 500 });
    }
  } catch (_) {}
}

function readSummaryMarker(file) {
  try { return parseSummaryMarker(fs.readFileSync(file, 'utf8')); }
  catch (_) { return { prompts: 0, at: 0 }; }
}

function writeSummaryMarker(file, state) {
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch (_) {}
}

function writeSessionSummary(summary, now) {
  try {
    const block = `\n\n## Auto-Summary @ ${now}\n${summary}\n`;
    fsx.updateSync(sessionFile, (t) => (t == null ? '' : t) + block, { timeoutMs: 5000 }); // the note's lock: see writeLastActive
  } catch (_) {}
}

// Phrases only an I-saw-nothing summary uses — a single hit is junk regardless
// of bullet count. Live incident 2026-08-07: qwen paraphrased around the weak
// list ("no actual user or assistant conversation logs") and 4 bullets of
// nothing sailed into BRAIN.md + the daily note.
const STRONG_JUNK_PATTERNS = [
  /only metadata/i,
  /no actual (user|assistant|conversation|interaction)/i,
  /absence of (interaction|conversation) history/i,
  /no (instructions|user request)s? (were |was )?provided/i,
];
const JUNK_PATTERNS = [
  /log (was|is|contains) empty/i,
  /no (actual|substantive) (conversation|content|history)/i,
  /lacks? substantive/i,
  /empty state/i,
  /could not be identified/i,
  /no code (changes|files)/i,
  /fields? (remain|are|with no) empty/i,
  /missing (interaction|context) data/i,
];
function isJunkSummary(s) {
  if (!s || !s.trim()) return true;
  if (STRONG_JUNK_PATTERNS.some((re) => re.test(s))) return true;
  const bullets = s.split('\n').filter((l) => /^\s*[-*•]/.test(l));
  const hits = JUNK_PATTERNS.filter((re) => re.test(s)).length;
  if (hits >= 2) return true;                 // clearly boilerplate
  if (bullets.length > 0 && bullets.length < 2) return true; // one-bullet nothing
  return hits >= 1 && bullets.length <= 3;    // short AND smells empty
}

function renderLastSession(brainContent, summary, date) {
  const firstLine = summary.split('\n').find((l) => l.trim()) || summary.slice(0, 120);
  const newSection = `## Last Session\n- **Date**: ${date}\n- **Auto-summary**: ${firstLine.trim()}`;
  if (/\n## Last [Ss]ession/.test(brainContent)) {
    return brainContent.replace(/\n+## Last [Ss]ession[\s\S]*$/, `\n\n${newSection}\n`);
  }
  return brainContent.replace(/\s*$/, `\n\n${newSection}\n`);
}

// BRAIN.md and SESSION.md are shared with build-brain-md, auto-wrap and /wrap: every write takes the file's lock and
// changes the file as it is now, not as it was read earlier (spec 2026-09-24-locked-writers D3).
function updateBrainLastSession(summary, date) {
  try {
    fsx.updateSync(BRAIN, (brain) => (brain == null ? null : renderLastSession(brain, summary, date)), { timeoutMs: 5000 });
  } catch (_) {}
}

function renderWorkingMemory(sessionContent, summary, now) {
  const bullets = summary.split('\n').filter((l) => /^\s*[-*•]/.test(l)).slice(0, 5)
    .map((l) => l.replace(/^\s*[•]/, '-'));
  const block = `## Key Context This Session\n\n_Auto-updated ${now}_\n${bullets.join('\n')}\n\n`;
  if (/## Key Context This Session/.test(sessionContent)) {
    return sessionContent.replace(/## Key Context This Session[\s\S]*?(?=## )/, block);
  }
  return sessionContent + '\n' + block;
}

function updateSessionWorkingMemory(summary, now) {
  try {
    fsx.updateSync(SESSION_MD, (s) => (s == null ? null : renderWorkingMemory(s, summary, now)), { timeoutMs: 5000 });
  } catch (_) {}
}

// Live incident 2026-08-07: slice(-10) on RAW JSONL entries handed qwen a
// window of tool-results and slash-command envelopes (extracted text mostly
// empty), and it truthfully summarized "only metadata headers, no conversation
// logs". Select actual dialogue instead: user/assistant entries with real text,
// no command envelopes, no isMeta — then fill a char budget newest-first.
// 12KB keeps summarize() in its single-call path (DEFAULT_MAX_CHARS).
const MAX_SUMMARY_INPUT = 12000;
function conversationTail(transcript) {
  const msgs = [];
  for (const t of parseEntries(transcript).turns) {
    const role = t.role;
    if (t.meta) continue;
    const text = String(t.text || '').trim();
    if (!text) continue; // tool_result-only user entries flatten to ''
    if (/^<(command-name|command-message|local-command)/.test(text)) continue;
    msgs.push(`${role}: ${text.slice(0, 500)}`);
  }
  const out = [];
  let size = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    size += msgs[i].length + 1;
    if (size > MAX_SUMMARY_INPUT) break;
    out.unshift(msgs[i]);
  }
  return out.join('\n');
}

/**
 * Summarize via the shared qwen helper — brings think:false, <think> stripping,
 * empty-reply retry, and request-sized num_ctx (the same serving default that
 * truncated auto-wrap would clip any larger hand-rolled call here too).
 * Resolves null on any failure; callers treat null as "skip this cycle".
 */
async function summarizeSession(transcript, date, chatFn) {
  const formatted = conversationTail(transcript);
  if (!formatted) return null;
  try {
    return await summarize(`Session ${date}:\n${formatted}`, {
      style: 'bullets',
      maxWords: 150,
      focus: 'what was built/changed, decisions made, open threads',
      timeoutMs: 120000,
      chatFn,
    });
  } catch (_) {
    return null;
  }
}

module.exports = { isJunkSummary, renderLastSession, renderWorkingMemory, conversationTail, summarizeSession, summaryCycle, readTranscriptRaw,
  summaryPolicy, summaryMarkerName, parseSummaryMarker, shouldSummarize };
