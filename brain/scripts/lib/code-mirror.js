'use strict';
/**
 * code-mirror.js — copies a host transcript into brain/_index/code as session events, so the Code tab's chat view
 * reads a live terminal session without the app ever reading a transcript (spec 2026-11-09-code-chat C2a, C5).
 * `sessions.js mirror` is its command line.
 *
 *   cachePath(vault, key)            <vault>/brain/_index/code/<key>.jsonl; key = a terminal uuid or <host>-<sessionId>
 *   mirrorOnce({ host, id, ... })    the whole transcript, written atomically (a past conversation the user opened)
 *   follow({ host, terminal, ... })  the transcript so far, then each complete new line, until the signal aborts
 *   pickCodexRollout(cands, opts)    which rollout in a folder is this terminal's (R17)
 *   readTee(vault, terminal)         the status-line copy `aos statusline render` keeps per terminal
 *   writeSessionReport / readSessionReport   <terminal>.session.json, the session a terminal's agent just started
 *   pruneCodeCaches(vault, opts)     caches, claims, closed claims and session reports over 14 days, tees over 24 h
 *
 * Claude: the tee names the terminal's session_id; a change (/clear, /resume) writes the new session event at once and
 * switches to its transcript when it exists (looked for every 2 s). Codex: folder mode for the terminal's whole life
 * (R17); with an id, that rollout is the first adoption (R18). An older rollout appended again is followed too (resume
 * --last, a /resume in the TUI: R17a, R17b), judged by when that growth began. Each Codex follower keeps <terminal>.claim.json
 * ({ pid, cwd, since, file, session, held }) from its start, so the others in the folder never take its rollout, nor one it
 * followed before (held), and can tell whose a new one may be; when they can't, the cache gets "Can't tell which
 * conversation". Folders compare by real path. A follower that stops leaves <terminal>.closed.json ({ cwd, held, closedAt }):
 * those rollouts stay claimed until one grows after the close.
 * The `code-session` SessionStart hook names each session the terminal's Codex starts (spec 2026-11-10-codex-session-claim):
 * a new report is acted on once, ahead of the folder guess. Its session is claimed at once; the chat stays on what it
 * shows until that session's rollout exists (found by id) and is an interactive one, then follows it. A new turn in the
 * current conversation meanwhile drops the report (a nested `codex exec`, or a session left before its first prompt). The
 * guess goes on after it for what no report names.
 *
 * A follower lives as long as its terminal (R16): stopped (SIGTERM, the signal) or orphaned (its parent changed: the app
 * crashed), it removes its terminal cache and its claim; when its transcript is gone it keeps the cache (the chat it had)
 * and removes only the claim. It never removes a file a newer follower wrote since. Every line is one event; a batch is
 * one append, so a reader never sees half a line. Reads take at most 8 MiB at a time and loop until caught up.
 */
const fs = require('fs');
const path = require('path');
const H = require('./host.js');
const { writeAtomic } = require('./fsx.js');
const { createTranscriptMapper } = require('./transcript-events.js');
const { codexKind } = require('./transcript.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const AMBIGUOUS_MESSAGE = "Can't tell which conversation · Terminal ⌘J";
/** Two followers with no rollout that started this close can't tell their new rollouts apart. */
const SAME_START_MS = 5000;
/** A rollout may name a start up to this long before its terminal's. */
const START_SLACK_MS = 1000;
/** "Can't tell" is written once a folder guess has been ambiguous this many scans in a row (4–6 s): a new rollout shows a
 *  moment before its terminal's session report claims it, and that moment is no episode. */
const AMBIGUOUS_SCANS = 3;
/** A follower's claim keeps this many rollouts it followed before, so no peer takes them after it moves on. */
const HELD_MAX = 20;
/** Folder scans and transcript lookups: every this many polls (2 s at 250 ms). */
const RESCAN_EVERY = 8;
const GONE_POLLS = 10;
const READ_CAP = 8 * 1024 * 1024;
const TAIL_CHUNK = 65536;
const EMPTY = Buffer.alloc(0);

const validId = (id) => typeof id === 'string' && ID_RE.test(id) && !id.includes('..');
const validTerminal = (t) => typeof t === 'string' && UUID_RE.test(t);
const codeDir = (vault) => path.join(vault, 'brain', '_index', 'code');
/** A folder as the file system resolves it (/tmp and /private/tmp are one); the path itself when it can't. */
const realDir = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

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

const reportPath = (vault, terminal) => path.join(codeDir(vault), `${terminal}.session.json`);

/**
 * The `code-session` hook's write (D1): the session `host`'s agent in `terminal` just started. Only the id is kept, never
 * the payload's transcript_path (D5): the follower finds the transcript by id in the host's own folders. Returns the file,
 * or null when the terminal or id is not valid.
 */
function writeSessionReport(vault, { terminal, host, sessionId, source = null, now = new Date() }) {
  if (!validTerminal(terminal) || !validId(sessionId) || !H.HOSTS.includes(host)) return null;
  const file = reportPath(vault, terminal);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify({ at: now.toISOString(), host, session_id: sessionId, source: typeof source === 'string' ? source : null }));
  return file;
}

/** { atMs, host, sessionId } from <terminal>.session.json, or null when it is missing or not a valid report. */
function readSessionReport(vault, terminal) {
  if (!validTerminal(terminal)) return null;
  try {
    const r = JSON.parse(fs.readFileSync(reportPath(vault, terminal), 'utf8'));
    const atMs = Date.parse(r && r.at);
    if (Number.isNaN(atMs) || !H.HOSTS.includes(r.host) || !validId(r.session_id)) return null;
    return { atMs, host: r.host, sessionId: r.session_id };
  } catch { return null; }
}

/**
 * Which rollout a Codex follower in folder mode adopts now (R17): { file, id }, { ambiguous: true }, or null.
 *   cands  [{ file, id, cwd, startedAt, mtimeMs }]  the folder's rollouts, cwd a real path
 *   me     { cwd, since, file, mtimeMs }            this follower: its terminal's start, its rollout (or null) and that
 *                                                   rollout's last append
 *   peers  [{ since, file, mtimeMs, session, held }]  the other live followers in this folder, from their claims
 *   closed [{ held, closedAt }]                     the followers of terminals closed in this folder (D9)
 *   beginOf(cand, from) → ms | null                 a rollout's activity start: its first entry at or after `from`
 * A peer's `session` (the one it follows or a report told it to wait for) and the rollouts it `held` before are claimed
 * like its file, and a peer that waits for a reported session with no file yet never contends for another rollout, nor
 * counts for the 5 s rule.
 * A rollout's activity start (R17a, R17b) is its start when it began after my reference point, else its first growth at
 * or after it: my file's last append when I have a file (a /resume in the TUI), since − 1 s when I have none (resume
 * --last). A follower X is a contender for a rollout whose activity started at b when X has no file and could adopt it
 * itself (R25/R61: it started at or after X.since − 1 s, however long after, or is older and first grew at or after X.since − 1 s), or
 * X's file was last appended before b (X went quiet before it: a /new or a resume there). I adopt
 * only when I am the one contender. With a file, only a rollout whose activity started after its last append counts, so
 * I never switch while mine is appended after that. With none, a new rollout must have started at or after
 * since − 1 s, with no upper bound (R61: Codex starts its session only after its startup dialogs, folder trust and hook
 * review, which can take any time), and a peer with no file that started within 5 s of me makes it ambiguous. More than one candidate, or a
 * candidate with another contender, is ambiguous.
 */
function pickCodexRollout(cands, { me, peers = [], closed = [], beginOf = () => null }) {
  const claimed = new Set(peers.flatMap((p) => [p.file, ...(p.held || [])]).filter(Boolean));
  // D9: a closed terminal's rollouts stay claimed until one grows after its close (a resume somewhere).
  const heldAt = new Map();
  for (const x of closed) for (const f of x.held || []) heldAt.set(f, Math.max(heldAt.get(f) ?? 0, x.closedAt));
  const claimedIds = new Set(peers.map((p) => p.session).filter(Boolean));
  const after = me.file ? me.mtimeMs : me.since - START_SLACK_MS;
  const considered = [];
  for (const c of cands || []) {
    if (c.cwd !== me.cwd || c.mtimeMs < me.since || c.file === me.file || claimed.has(c.file) || (c.id && claimedIds.has(c.id))) continue;
    if (heldAt.has(c.file) && c.mtimeMs <= heldAt.get(c.file) + START_SLACK_MS) continue;
    if (c.startedAt > after) {
      considered.push({ c, begin: c.startedAt });
    } else if (c.mtimeMs > after) {
      // An older rollout appended again: resume --last (no file), or a /resume in the TUI (R17b).
      const begin = beginOf(c, after);
      if (typeof begin === 'number' && (me.file ? begin > after : begin >= after)) considered.push({ c, begin });
    }
  }
  if (!considered.length) return null;
  if (!me.file && peers.some((p) => !p.file && !p.session && Math.abs(p.since - me.since) < SAME_START_MS)) return { ambiguous: true };
  // R25: a follower with no file contends for a rollout only when it could adopt it itself (the same rule as mine).
  const contends = (x, c, begin) => {
    if (x.file) return x.mtimeMs < begin;
    if (x.session) return false; // it waits for the session its report named
    if (c.mtimeMs < x.since) return false;
    const from = x.since - START_SLACK_MS;
    if (c.startedAt > from) return true;
    if (c.mtimeMs <= from) return false;
    const b = beginOf(c, from);
    return typeof b === 'number' && b >= from;
  };
  if (considered.length === 1 && !peers.some((p) => contends(p, considered[0].c, considered[0].begin))) {
    const { c } = considered[0];
    return { file: c.file, id: c.id ?? null };
  }
  return { ambiguous: true };
}

const jsonLines = (events) => events.map((e) => `${JSON.stringify(e)}\n`).join('');

/**
 * Reads a file from where it left off and maps each complete new line, at most `readCap` bytes at a time, looping until
 * caught up; a partial last line waits for its newline (`final` maps it too). read(sink) → false when the file can't be
 * stat'ed, opened or read (a missing poll); sink(events) gets each chunk's events, and an error it throws passes through.
 */
function makeTail(file, host, readCap = READ_CAP) {
  const mapper = createTranscriptMapper(host, { model: null });
  let pos = 0;
  let carry = EMPTY;
  const mapLines = (buf, sink) => {
    const events = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      events.push(...mapper.push(entry));
    }
    if (events.length) sink(events);
  };
  return {
    file,
    get turn() { return mapper.state.turn; },
    read(sink, { final = false } = {}) {
      let fd;
      let sinkError = null;
      const out = (events) => { try { sink(events); } catch (e) { sinkError = e; throw e; } };
      try {
        const size = fs.statSync(file).size;
        if (size < pos) { pos = 0; carry = EMPTY; }
        if (size > pos) {
          fd = fs.openSync(file, 'r');
          while (pos < size) {
            const buf = Buffer.alloc(Math.min(readCap, size - pos));
            const n = fs.readSync(fd, buf, 0, buf.length, pos);
            if (n <= 0) break;
            pos += n;
            const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
            const end = data.lastIndexOf(10);
            if (end === -1) { carry = Buffer.from(data); continue; }
            carry = Buffer.from(data.subarray(end + 1));
            mapLines(data.subarray(0, end), out);
          }
        }
        if (final && carry.length) { const last = carry; carry = EMPTY; mapLines(last, out); }
        return true;
      } catch (e) {
        if (e === sinkError) throw e;
        return false;
      } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
    },
  };
}

function mirrorOnce({ host, id, vault, dirs, readCap = READ_CAP }) {
  if (!H.HOSTS.includes(host)) return { ok: false, reason: `no such host ${host}` };
  if (!validId(id)) return { ok: false, reason: 'bad session id' };
  const file = H.findTranscript(host, id, dirs);
  if (!file) return { ok: false, reason: 'no transcript found' };
  try {
    const cache = cachePath(vault, `${host}-${id}`);
    const parts = [];
    if (!makeTail(file, host, readCap).read((events) => parts.push(jsonLines(events)), { final: true })) return { ok: false, reason: 'the transcript could not be read' };
    writeAtomic(cache, parts.join(''));
    return { ok: true, cache };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** The first line of a rollout is its session_meta: id, cwd (a real path) and start time, which never change. */
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
    const id = p.id || p.session_id;
    return { id: validId(id) ? id : null, cwd: realDir(p.cwd), startedAt: Number.isNaN(startedAt) ? 0 : startedAt, interactive: codexKind(p).kind === 'interactive' };
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

/** A rollout's activity start from `from` (R17a, R17b): the earliest entry timestamp at or after it, read backwards from
 *  the end (at most READ_CAP), or null when it has none. */
function activityStart(file, from) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let pos = fs.fstatSync(fd).size;
    let rest = EMPTY;
    let first = null;
    let read = 0;
    while (pos > 0 && read < READ_CAP) {
      const len = Math.min(TAIL_CHUNK, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, pos);
      read += len;
      const data = rest.length ? Buffer.concat([chunk, rest]) : chunk;
      const nl = pos > 0 ? data.indexOf(10) : -1;
      if (pos > 0 && nl === -1) { rest = data; continue; }
      rest = pos > 0 ? Buffer.from(data.subarray(0, nl)) : EMPTY;
      const lines = data.subarray(nl + 1).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        let ts = NaN;
        try { ts = Date.parse(JSON.parse(lines[i]).timestamp); } catch { continue; }
        if (Number.isNaN(ts)) continue;
        if (ts < from) return first;
        first = ts;
      }
    }
    return first;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
};

/** The other live followers in `cwd` (a real path), from their claims: { since, file, mtimeMs, session, held }. */
function peerClaims(vault, terminal, cwd) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(codeDir(vault)); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.claim.json') || n === `${terminal}.claim.json`) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(codeDir(vault), n), 'utf8'));
      if (!c || typeof c.cwd !== 'string' || realDir(c.cwd) !== cwd || !pidAlive(c.pid)) continue;
      const file = typeof c.file === 'string' ? c.file : null;
      let mtimeMs = 0;
      if (file) { try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* gone: counted as quiet */ } }
      const held = Array.isArray(c.held) ? c.held.filter((f) => typeof f === 'string') : [];
      out.push({ since: Number.isFinite(c.since) ? c.since : 0, file, mtimeMs, session: validId(c.session) ? c.session : null, held });
    } catch { /* unreadable claim */ }
  }
  return out;
}

/** The closed terminals in `cwd` (a real path), other than `terminal`: { held, closedAt } from <terminal>.closed.json (D9). */
function closedClaims(vault, terminal, cwd) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(codeDir(vault)); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.closed.json') || n === `${terminal}.closed.json`) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(codeDir(vault), n), 'utf8'));
      if (!c || typeof c.cwd !== 'string' || realDir(c.cwd) !== cwd || !Number.isFinite(c.closedAt) || !Array.isArray(c.held)) continue;
      out.push({ held: c.held.filter((f) => typeof f === 'string'), closedAt: c.closedAt });
    } catch { /* unreadable */ }
  }
  return out;
}

/** Removes `file` when it is still the one this follower last wrote (its inode), not a newer follower's. */
function removeOwn(file, ino) {
  if (!file || ino === null) return;
  try { if (fs.statSync(file).ino === ino) fs.unlinkSync(file); } catch { /* gone already */ }
}

async function follow({ host, terminal, id, cwd, since = 0, vault, dirs, pollMs = 250, signal, readCap = READ_CAP, parentPid = () => process.ppid }) {
  if (!H.HOSTS.includes(host)) throw new Error(`code-mirror: no such host ${host}`);
  if (id !== undefined && !validId(id)) throw new Error('code-mirror: bad session id');
  if (terminal !== undefined && !validTerminal(terminal)) throw new Error('code-mirror: bad terminal id');
  if (id === undefined && !terminal) throw new Error('code-mirror: a terminal id is needed without a session id');
  if (id === undefined && !cwd) throw new Error(`code-mirror: ${host} without an id needs --cwd`);
  // R17, R18: Codex follows the terminal's folder for its whole life; with an id, that rollout is its first adoption.
  const folder = host === 'codex' && !!cwd && !!terminal;
  const cache = cachePath(vault, terminal || `${host}-${id}`);
  const claimFile = folder ? path.join(codeDir(vault), `${terminal}.claim.json`) : null;
  const myCwd = cwd ? realDir(cwd) : null;
  const ac = signal || new AbortController().signal;
  const parent = parentPid();
  const startedAt = Date.now();
  const reportFile = folder ? reportPath(vault, terminal) : null;
  let reportStamp = null; // the session report's inode and mtime when last read
  let actedKey = null; // the last report acted on: `${atMs}|${sessionId}`
  let pending = null; // { id, key, turn }: a reported session whose interactive rollout is not found yet
  const held = []; // the rollouts this follower followed, the last HELD_MAX, kept claimed after it moves on

  let cur = null; // { tail, file, id, missing, mtimeMs }
  let fresh = true; // the cache holds nothing yet
  let cacheIno = null;
  let claimIno = null;
  let announced = null; // { id, model } of the last session event written
  let ambiguous = false; // a "can't tell" episode is on; its error is written once
  let ambiguousScans = 0; // folder guesses in a row that were ambiguous
  let target = id ?? null; // claude: the session the terminal shows
  let lookupAt = 0; // the poll of the next transcript lookup
  const metaCache = new Map();
  const starts = new Map(); // rollout → { from, at }: its activity start from `from`

  const writeCache = (text) => {
    if (!fresh) { fs.appendFileSync(cache, text); return; }
    writeAtomic(cache, text);
    fresh = false;
    try { cacheIno = fs.statSync(cache).ino; } catch { /* removed already */ }
  };
  // A session event that repeats the id and model already written says nothing new (the transcript's own, after ours).
  const write = (events) => {
    const out = [];
    for (const e of events) {
      if (e.kind === 'session') {
        const model = e.model ?? null;
        if (announced && announced.id === e.id && announced.model === model) continue;
        announced = { id: e.id, model };
      }
      out.push(e);
    }
    if (out.length) writeCache(jsonLines(out));
  };
  const announce = (sessionId) => write([{ t: new Date().toISOString(), kind: 'session', id: sessionId, model: null, turn: 0 }]);
  const claim = (file) => {
    if (!claimFile) return;
    try {
      const session = pending ? pending.id : cur ? cur.id : null;
      writeAtomic(claimFile, JSON.stringify({ pid: process.pid, cwd: myCwd, since, file, session, held }));
      claimIno = fs.statSync(claimFile).ino;
    } catch { /* a claim is best effort */ }
  };
  const start = (file, sessionId) => {
    if (sessionId && !(announced && announced.id === sessionId)) announce(sessionId);
    let mtimeMs = Number.MAX_SAFE_INTEGER; // unknown: nothing counts as newer
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* the poll counts it */ }
    cur = { tail: makeTail(file, host, readCap), file, id: sessionId, missing: 0, mtimeMs };
    if (claimFile && !held.includes(file)) { held.push(file); if (held.length > HELD_MAX) held.shift(); }
    claim(file);
  };
  const lookup = (n, sessionId) => {
    if (n < lookupAt) return;
    const file = H.findTranscript(host, sessionId, dirs);
    if (file) start(file, sessionId); else lookupAt = n + RESCAN_EVERY;
  };
  const scanCodex = () => {
    const d = dirs || H.hostDirs('codex');
    const cands = [];
    for (const f of H.sessionFiles('codex', { dirs: { ...d, archived: null } })) {
      if (f.mtimeMs < since) continue;
      let m = metaCache.get(f.file);
      if (!m) { m = readMeta(f.file); if (m) metaCache.set(f.file, m); }
      // R26: a subagent thread or an exec run shares the folder but is no terminal's conversation.
      if (m && m.interactive) cands.push({ file: f.file, id: m.id, cwd: m.cwd, startedAt: m.startedAt, mtimeMs: f.mtimeMs });
    }
    // D: a rollout that can't be stat'ed keeps its last known append, so a gone file unlocks no new candidates.
    if (cur) { try { cur.mtimeMs = fs.statSync(cur.file).mtimeMs; } catch { /* gone: the poll counts it */ } }
    const mtimeMs = cur ? cur.mtimeMs : 0;
    const pick = pickCodexRollout(cands, {
      me: { cwd: myCwd, since, file: cur ? cur.file : null, mtimeMs },
      peers: peerClaims(vault, terminal, myCwd),
      closed: closedClaims(vault, terminal, myCwd),
      beginOf: (c, from) => {
        // A found start does not move while `from` stays (the file only grows); none found is asked again next scan.
        const known = starts.get(c.file);
        if (known && known.from === from) return known.at;
        const at = activityStart(c.file, from);
        if (at !== null) starts.set(c.file, { from, at });
        return at;
      },
    });
    if (pick && pick.ambiguous) {
      ambiguousScans++;
      if (!ambiguous && ambiguousScans >= AMBIGUOUS_SCANS) {
        write([{ t: new Date().toISOString(), kind: 'error', message: AMBIGUOUS_MESSAGE, turn: cur ? cur.tail.turn : 0 }]);
        ambiguous = true;
      }
      return;
    }
    ambiguous = false;
    ambiguousScans = 0;
    if (pick && pick.file) start(pick.file, pick.id);
  };
  /**
   * D3, D4: a new session report from this terminal's life (since its start; since this follower's own start when it was
   * given an id) is acted on once. The claim names its session at once, so no peer takes its rollout, while the chat stays
   * on what it shows; the rollout is looked up by id (D5) until it exists, with no folder guess meanwhile.
   */
  const checkReport = (n) => {
    let stamp;
    try { const st = fs.statSync(reportFile); stamp = `${st.ino}:${st.mtimeMs}`; } catch { return; }
    if (stamp === reportStamp) return;
    reportStamp = stamp;
    const r = readSessionReport(vault, terminal);
    if (!r || r.host !== 'codex') return;
    const key = `${r.atMs}|${r.sessionId}`;
    if (key === actedKey || (pending && pending.key === key)) return;
    if (r.atMs < since - START_SLACK_MS || (id !== undefined && r.atMs < startedAt - START_SLACK_MS)) return;
    if (cur && cur.id === r.sessionId) { dropReport(key); return; } // a resume or compact of what it shows
    pending = { id: r.sessionId, key, turn: cur ? cur.tail.turn : 0 };
    claim(cur ? cur.file : null);
    lookupAt = n;
  };
  /** The report is done with, adopted or not: the claim goes back to naming what the chat shows. */
  const dropReport = (key) => {
    actedKey = key;
    pending = null;
    claim(cur ? cur.file : null);
  };
  /** Adopts the reported rollout once it exists and is a terminal's own conversation (R26: not an exec or a subagent). */
  const resolveReport = (n) => {
    if (n < lookupAt) return;
    lookupAt = n + RESCAN_EVERY;
    const file = H.findTranscript('codex', pending.id, dirs);
    if (!file) return;
    let m = metaCache.get(file);
    if (!m) { m = readMeta(file); if (m) metaCache.set(file, m); }
    if (!m) return; // its first line is not written yet
    if (!m.interactive) { dropReport(pending.key); return; }
    const sessionId = pending.id;
    actedKey = pending.key;
    pending = null;
    ambiguous = false;
    ambiguousScans = 0;
    start(file, sessionId);
  };

  /** One poll; true when the transcript is gone. */
  const poll = (n) => {
    if (host === 'claude') {
      const tee = terminal ? readTee(vault, terminal) : null;
      if (tee && validId(tee.session_id) && tee.session_id !== target) {
        // M5: the new conversation shows at once (a /clear empties the chat), its transcript when it exists.
        target = tee.session_id;
        cur = null;
        lookupAt = n;
        announce(target);
      }
      if (target && !cur) lookup(n, target);
    } else {
      if (folder) checkReport(n);
      if (pending) resolveReport(n);
      else if (!cur && id !== undefined) lookup(n, id);
      else if (folder && n % RESCAN_EVERY === 0) scanCodex();
    }
    if (!cur) return false;
    if (!cur.tail.read(write)) return ++cur.missing >= GONE_POLLS;
    cur.missing = 0;
    // A new prompt in the conversation it shows: the terminal's agent is still there, so the report was not its own.
    if (pending && cur.tail.turn > pending.turn) dropReport(pending.key);
    return false;
  };

  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); ac.removeEventListener('abort', done); resolve(); }
    ac.addEventListener('abort', done, { once: true });
  });

  let gone = false;
  try {
    claim(null);
    for (let n = 0; !ac.aborted; n++) {
      if (parentPid() !== parent) break; // orphaned: the app that ran it is gone, and its terminal with it
      if (poll(n)) { gone = true; break; }
      await sleep(pollMs);
    }
  } finally {
    // D9: what this terminal followed stays claimed after it closes, so a quiet neighbour doesn't take its conversation.
    if (claimFile && held.length) {
      try { writeAtomic(path.join(codeDir(vault), `${terminal}.closed.json`), JSON.stringify({ cwd: myCwd, held, closedAt: Date.now() })); } catch { /* best effort */ }
    }
    removeOwn(claimFile, claimIno);
    if (!gone && terminal) removeOwn(cache, cacheIno);
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
  sweep(codeDir(vault), '.session.json', codeDays * 86400000);
  sweep(codeDir(vault), '.closed.json', codeDays * 86400000);
  sweep(path.join(vault, 'brain', '_index', 'statusline'), '.json', statusHours * 3600000);
  return { pruned };
}

module.exports = {
  cachePath, readTee, writeSessionReport, readSessionReport, pickCodexRollout, mirrorOnce, follow, pruneCodeCaches, UUID_RE, validId,
};
