#!/usr/bin/env node
/**
 * UserPromptSubmit hook — injects BRAIN.md + SESSION.md on the first user turn of a session.
 * Uses a per-session marker file under the OS temp dir (lib/markers.js) for idempotency. Both hosts pipe hook input as JSON to stdin.
 */

const { PATHS, dailyNotePath } = require('./lib/hook-entry.js').hookEntry();
const fs = require('fs');
const path = require('path');
const { markerPath } = require('./lib/markers.js');
const { readTranscriptFile, isRealPrompt } = require('./lib/transcript.js');

const VAULT = PATHS.VAULT;
const BRAIN = PATHS.BRAIN_MD;
const SESSION = PATHS.SESSION_MD;

/**
 * How many prompts the user typed before this one, from either host's transcript (lib/transcript.js isRealPrompt:
 * not Claude's isMeta entries, command envelopes or tool results, not Codex's injected context). The host may already
 * have written the prompt being submitted, so a last typed prompt equal to `current` (whitespace aside) is this one.
 */
function earlierPrompts(t, current) {
  const typed = ((t && t.turns) || []).filter(isRealPrompt);
  let n = typed.length;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (n && current != null && norm(typed[n - 1].text) === norm(current)) n--;
  return n;
}

let raw = '';
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const sessionId = input.session_id || input.sessionId || 'unknown';
    const transcriptPath = input.transcript_path || input.transcriptPath || '';

    // Ensure today's daily note exists (user's 2026/<month>/<date>.md structure)
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const sessionFile = dailyNotePath(d);
    if (!fs.existsSync(sessionFile)) {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      const template = `---\ntype: daily-note\ndate: ${today}\ntags: [daily-note]\n---\n\n# ${today}\n\n## Claude Code Sessions\n`;
      fs.writeFileSync(sessionFile, template);
    }

    // Per-session idempotency: only inject once per session_id
    const marker = markerPath(`.injected-${sessionId}`);
    if (fs.existsSync(marker)) process.exit(0);

    // Secondary safety, for a marker lost mid-session (its temp folder cleared): a session that already had a prompt
    // the user typed gets nothing. Only typed prompts before this one count (earlierPrompts): a session started after
    // /clear opens with Claude Code's local-command caveat and the command, which `userTurns` counted, so no such session
    // was ever injected.
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      if (earlierPrompts(readTranscriptFile(transcriptPath), input.prompt) > 0) {
        fs.writeFileSync(marker, String(Date.now()));
        process.exit(0);
      }
    }

    const brainContent = fs.existsSync(BRAIN) ? fs.readFileSync(BRAIN, 'utf8') : '';
    const sessionContent = fs.existsSync(SESSION) ? fs.readFileSync(SESSION, 'utf8') : '';

    // Surface today's morning brief if fresh (< 18h old).
    const briefPath = path.join(VAULT, 'brain/_index/brief.md');
    let briefBlock = '';
    try {
      if (fs.existsSync(briefPath)) {
        const st = fs.statSync(briefPath);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs < 18 * 60 * 60 * 1000) {
          briefBlock = `\n\n---\n${fs.readFileSync(briefPath, 'utf8')}`;
        }
      }
    } catch (_) {}

    // Auto-recall (brain-recall skill): top-3 ranked snippets if fresh (< 48h old).
    const recallPath = path.join(VAULT, 'brain/_index/recall-wake.md');
    let recallBlock = '';
    try {
      if (fs.existsSync(recallPath)) {
        const st = fs.statSync(recallPath);
        if (Date.now() - st.mtimeMs < 48 * 60 * 60 * 1000) {
          recallBlock = `\n\n---\n${fs.readFileSync(recallPath, 'utf8')}`;
        }
      }
    } catch (_) {}

    // Persona sitrep (internal work state) — injected while fresh (< 18h), like the brief.
    const sitrepPath = path.join(VAULT, 'brain/_index/sitrep.md');
    let sitrepBlock = '';
    try {
      if (fs.existsSync(sitrepPath)) {
        const st = fs.statSync(sitrepPath);
        if (Date.now() - st.mtimeMs < 18 * 60 * 60 * 1000) {
          sitrepBlock = `\n\n---\n${fs.readFileSync(sitrepPath, 'utf8')}`;
        }
      }
    } catch (_) {}

    // Persona identity layer (<vault>/persona/): every session wakes as the user's named agent.
    // Off when persona.enabled=false (merged config; agenticos.json wins) or persona/DISABLED exists (kill switch). Fails open.
    let personaBlock = '';
    try {
      const PERSONA = PATHS.PERSONA;
      const identityPath = path.join(PERSONA, 'IDENTITY.md');
      const personaOn = require('./lib/config.js').loadConfig().persona.enabled !== false;
      if (personaOn && !fs.existsSync(path.join(PERSONA, 'DISABLED')) && fs.existsSync(identityPath)) {
        const identity = fs.readFileSync(identityPath, 'utf8');
        let state = '';
        try { state = fs.readFileSync(path.join(PERSONA, 'STATE.md'), 'utf8'); } catch (_) {}
        personaBlock = `<persona>\n${identity}\n\n---\n${state}\n</persona>\n`;
      }
    } catch (_) {}

    if (personaBlock || brainContent || sessionContent || briefBlock || sitrepBlock || recallBlock) {
      process.stdout.write(
        `${personaBlock}<brain-context>\n${brainContent}\n\n---\n${sessionContent}${briefBlock}${sitrepBlock}${recallBlock}\n</brain-context>\n`
      );
    }

    fs.writeFileSync(marker, String(Date.now()));

    // Which memories this session started with (brain-hub D9): BRAIN.md's sources by path (build-brain-md writes them,
    // its bullets name titles only) and the recall-wake paths, when their blocks went out. After the write and the
    // marker, on its own: a usage row never delays or changes what the session receives.
    try {
      const usage = require('./lib/memory-usage.js');
      const paths = [];
      if (brainContent) {
        try {
          const src = JSON.parse(fs.readFileSync(path.join(VAULT, 'brain/_index/brain-sources.json'), 'utf8'));
          const s = (src && src.sections) || {};
          for (const k of ['who', 'rules', 'active']) if (s[k] && Array.isArray(s[k].paths)) paths.push(...s[k].paths);
        } catch (_) { /* BRAIN.md built before brain-sources.json existed: its rows start with the next build */ }
      }
      if (recallBlock) paths.push(...usage.wakePaths(recallBlock));
      if (paths.length) {
        usage.logUsage({
          vault: VAULT, how: 'injected', paths,
          host: require('./lib/host.js').currentHost(process.env, input),
          cfg: require('./lib/config.js').loadConfig(),
        });
      }
    } catch (_) { /* no sources yet, or telemetry off: nothing to log */ }
  } catch (_) {
    // Never block the user's message on error
    process.exit(0);
  }
});
