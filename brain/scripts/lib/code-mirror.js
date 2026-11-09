'use strict';
/**
 * code-mirror.js — copies a host transcript into brain/_index/code as session events, so the Code tab's chat view
 * reads a live terminal session without the app ever reading a transcript (spec 2026-11-09-code-chat C2a, C5).
 * `sessions.js mirror` is its command line.
 *
 *   cachePath(vault, key)            <vault>/brain/_index/code/<key>.jsonl; key = a terminal uuid or <host>-<sessionId>
 *   mirrorOnce({ host, id, ... })    the whole transcript, written atomically (a past conversation the user opened)
 *   follow({ host, terminal, ... })  the transcript so far, then each complete new line, until the signal aborts
 *   pickCodexRollout(cands, opts)    which rollout in a folder is this terminal's
 *   readTee(vault, terminal)         the status-line copy `aos statusline render` keeps per terminal
 *   pruneCodeCaches(vault, opts)     caches over 14 days, tees over 24 h
 *
 * Claude: the tee names the terminal's session_id; a change (/clear, /resume) switches the transcript. Codex without an
 * id: folder mode, the most recently appended rollout of the cwd that no other live follower claims
 * (<terminal>.claim.json). Every line is one event; a batch is one append, so a reader never sees half a line.
 */
const fs = require('fs');
const path = require('path');
const H = require('./host.js');
const { writeAtomic } = require('./fsx.js');
const { createTranscriptMapper, eventsOfText } = require('./transcript-events.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const AMBIGUOUS_MESSAGE = "Can't tell which conversation · Terminal ⌘J";
const SAME_START_MS = 5000;
const RESCAN_EVERY = 8;
const GONE_POLLS = 10;

const validId = (id) => typeof id === 'string' && ID_RE.test(id) && !id.includes('..');
const validTerminal = (t) => typeof t === 'string' && UUID_RE.test(t);
const codeDir = (vault) => path.join(vault, 'brain', '_index', 'code');

function validKey(key) {
  if (validTerminal(key)) return true;
  const m = typeof key === 'string' && key.match(/^(claude|codex)-(.+)$/);
  return !!m && validId(m[2]);
}

function cachePath(vault, key) {
  if (!validKey(key)) throw new Error(`code-mirror: bad cache key ${JSON.stringify(key)}`);
  return path.join(codeDir(vault), `${key}.jsonl`);
}

function readTee(vault, terminal) {
  if (!validTerminal(terminal)) return null;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(vault, 'brain', '_index', 'statusline', `${terminal}.json`), 'utf8'));
    if (!t || typeof t !== 'object') return null;
    return { at: t.at ?? null, session_id: t.session_id ?? null, transcript_path: t.transcript_path ?? null, ansi: typeof t.ansi === 'string' ? t.ansi : '' };
  } catch { return null; }
}

function pickCodexRollout(cands, { cwd, since, claimed }) {
  const live = (cands || []).filter((c) => c.cwd === cwd && c.mtimeMs >= since && !(claimed && claimed.has(c.file)));
  if (!live.length) return null;
  live.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) if (Math.abs(live[i].startedAt - live[j].startedAt) < SAME_START_MS) return { ambiguous: true };
  }
  return { file: live[0].file };
}

const jsonLines = (events) => events.map((e) => `${JSON.stringify(e)}\n`).join('');

function mirrorOnce({ host, id, vault, dirs }) {
  if (!H.HOSTS.includes(host)) return { ok: false, reason: `no such host ${host}` };
  if (!validId(id)) return { ok: false, reason: 'bad session id' };
  const file = H.findTranscript(host, id, dirs);
  if (!file) return { ok: false, reason: 'no transcript found' };
  try {
    const cache = cachePath(vault, `${host}-${id}`);
    writeAtomic(cache, jsonLines(eventsOfText(fs.readFileSync(file, 'utf8'), host)));
    return { ok: true, cache };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** The first line of a rollout is its session_meta: cwd and start time, which never change. */
function readMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    const buf = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl === -1 ? n : nl)));
      total += n;
      if (nl !== -1 || total > 1 << 20) break;
    }
    const e = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const p = e && e.type === 'session_meta' && e.payload;
    if (!p || typeof p.cwd !== 'string') return null;
    const startedAt = Date.parse(p.timestamp || e.timestamp);
    return { cwd: p.cwd, startedAt: Number.isNaN(startedAt) ? 0 : startedAt };
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
};

/** Rollouts the other live followers in `cwd` follow. */
function claimedFiles(vault, terminal, cwd) {
  const out = new Set();
  let names = [];
  try { names = fs.readdirSync(codeDir(vault)); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.claim.json') || n === `${terminal}.claim.json`) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(codeDir(vault), n), 'utf8'));
      if (c && c.cwd === cwd && typeof c.file === 'string' && pidAlive(c.pid)) out.add(c.file);
    } catch { /* unreadable claim */ }
  }
  return out;
}

/** Reads a file from an offset, maps each complete new line. A partial last line waits for its newline. */
function makeTail(file, host) {
  const mapper = createTranscriptMapper(host, { model: null });
  let offset = 0;
  return {
    file,
    read() {
      let st;
      try { st = fs.statSync(file); } catch { return null; }
      if (st.size < offset) offset = 0;
      if (st.size === offset) return [];
      const fd = fs.openSync(file, 'r');
      let buf;
      try { buf = Buffer.alloc(st.size - offset); fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
      const end = buf.lastIndexOf(10);
      if (end === -1) return [];
      offset += end + 1;
      const events = [];
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        events.push(...mapper.push(entry));
      }
      return events;
    },
  };
}

async function follow({ host, terminal, id, cwd, since = 0, vault, dirs, pollMs = 250, signal }) {
  if (!H.HOSTS.includes(host)) throw new Error(`code-mirror: no such host ${host}`);
  if (id !== undefined && !validId(id)) throw new Error('code-mirror: bad session id');
  if (terminal !== undefined && !validTerminal(terminal)) throw new Error('code-mirror: bad terminal id');
  const folderMode = host === 'codex' && id === undefined;
  if (id === undefined && !terminal) throw new Error('code-mirror: a terminal id is needed without a session id');
  if (host === 'claude' && id === undefined && !cwd) throw new Error('code-mirror: claude without an id needs --cwd');
  if (folderMode && !cwd) throw new Error('code-mirror: codex without an id needs --cwd');
  const cache = cachePath(vault, terminal || `${host}-${id}`);
  const claimFile = path.join(codeDir(vault), `${terminal}.claim.json`);
  const ac = signal || new AbortController().signal;

  let cur = null; // { tail, id, missing }
  let fresh = true; // the cache holds nothing of a transcript yet
  let ambiguous = false;
  const emit = (events) => {
    if (!events.length) return;
    if (fresh) writeAtomic(cache, jsonLines(events));
    else fs.appendFileSync(cache, jsonLines(events));
  };
  const start = (file, sessionId) => {
    const tail = makeTail(file, host);
    let events = tail.read() || [];
    if (host === 'claude') events = [{ t: null, kind: 'session', id: sessionId }, ...events.filter((e) => !(e.kind === 'session' && e.id === sessionId))];
    if (fresh) writeAtomic(cache, jsonLines(events)); else emit(events);
    fresh = false;
    cur = { tail, id: sessionId, missing: 0 };
    if (folderMode) {
      try { writeAtomic(claimFile, JSON.stringify({ pid: process.pid, cwd, file })); } catch { /* a claim is best effort */ }
    }
  };
  const scanCodex = () => {
    const cands = [];
    for (const f of H.sessionFiles('codex', { dirs })) {
      if (f.archived || f.mtimeMs < since) continue;
      let m = metaCache.get(f.file);
      if (!m) { m = readMeta(f.file); if (m) metaCache.set(f.file, m); }
      if (m) cands.push({ file: f.file, cwd: m.cwd, startedAt: m.startedAt, mtimeMs: f.mtimeMs });
    }
    const pick = pickCodexRollout(cands, { cwd, since, claimed: claimedFiles(vault, terminal, cwd) });
    if (pick && pick.file) {
      ambiguous = false;
      if (!cur || cur.tail.file !== pick.file) start(pick.file, null);
    } else if (pick && pick.ambiguous && !cur && !ambiguous) {
      ambiguous = true;
      emit([{ t: null, kind: 'error', message: AMBIGUOUS_MESSAGE }]);
    }
  };
  const metaCache = new Map();

  const poll = (n) => {
    if (host === 'claude') {
      const tee = terminal ? readTee(vault, terminal) : null;
      const want = tee && validId(tee.session_id) ? tee.session_id : (cur ? cur.id : id);
      if (want && (!cur || cur.id !== want)) {
        const file = H.findTranscript('claude', want, dirs);
        if (file) start(file, want);
      }
    } else if (!folderMode) {
      if (!cur) { const file = H.findTranscript('codex', id, dirs); if (file) start(file, id); }
    } else if (n % RESCAN_EVERY === 0) scanCodex();
    if (!cur) return false;
    const events = cur.tail.read();
    if (events === null) return ++cur.missing >= GONE_POLLS;
    cur.missing = 0;
    emit(events);
    return false;
  };

  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); ac.removeEventListener('abort', done); resolve(); }
    ac.addEventListener('abort', done, { once: true });
  });

  try {
    for (let n = 0; !ac.aborted; n++) {
      if (poll(n)) break;
      await sleep(pollMs);
    }
  } finally {
    if (folderMode) try { fs.unlinkSync(claimFile); } catch { /* none written */ }
  }
}

function pruneCodeCaches(vault, { now = new Date(), codeDays = 14, statusHours = 24 } = {}) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  let pruned = 0;
  const sweep = (dir, ext, maxAgeMs) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!n.endsWith(ext)) continue;
      const f = path.join(dir, n);
      try {
        if (at - fs.statSync(f).mtimeMs <= maxAgeMs) continue;
        if (n.endsWith('.claim.json') && pidAlive(JSON.parse(fs.readFileSync(f, 'utf8')).pid)) continue;
        fs.unlinkSync(f);
        pruned++;
      } catch { /* gone or unreadable: next sweep */ }
    }
  };
  sweep(codeDir(vault), '.jsonl', codeDays * 86400000);
  sweep(codeDir(vault), '.claim.json', codeDays * 86400000);
  sweep(path.join(vault, 'brain', '_index', 'statusline'), '.json', statusHours * 3600000);
  return { pruned };
}

module.exports = { cachePath, readTee, pickCodexRollout, mirrorOnce, follow, pruneCodeCaches, UUID_RE, validId };
