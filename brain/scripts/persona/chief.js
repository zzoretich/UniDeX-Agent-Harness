#!/usr/bin/env node
'use strict';
/**
 * chief.js — where the Chief of Staff's next duty runs, for persona/run-duty.sh (local-first A4). A small wrapper around
 * lib/headless.js resolveChief: the host (persona.runner, auto → Claude when it is on and signed in, else Codex), the CoS
 * model for that host (sdk/lib/models.js chiefModel: claude-opus-5-5 / gpt-6-sol on a 2.0 install), the effort, and the
 * failover to the other host when the primary cannot start (CLI missing, signed out). persona.perDayUsd is one cap over
 * both hosts: a capped day is skipped, never moved.
 * The shell runner never scans agenticos.json for a "model" key again.
 *
 *   node persona/chief.js --resolve [--json]
 *     exit 0: `host<TAB>bin<TAB>model<TAB>effort<TAB>codex home<TAB>reason` (model or home may be empty)
 *     exit 3: `reason<TAB>detail` — reason daily-cap (today's duty spend over both hosts is at persona.perDayUsd) or
 *             waiting-for-host (no host can start it); the duty is skipped, not failed; detail says why, host by host
 *     exit 2: usage
 *   --json prints resolveChief's whole answer instead (same exit codes).
 * Env: PERSONA_MODEL / PERSONA_EFFORT (a duty routine's own, or its schedule's), AOS_RUNNER, PERSONA_CLAUDE_BIN,
 * AOS_CODEX_BIN, AOS_NO_CLAUDE / AOS_NO_CODEX — the same overrides lib/headless.js honours. Every dependency is injectable.
 */
const EXIT_SKIP = 3;

/** One line per answer (the module comment's shapes). */
function format(r) {
  if (r.host) return [r.host, r.bin || '', r.model || '', r.effort || '', r.home || '', r.reason || ''].join('\t');
  return [r.reason, detail(r)].join('\t');
}
/** "claude: signed out; codex: CLI not found" — what the journal line and the duty log say. */
function detail(r) {
  const parts = (r.skipped || []).map((s) => (s.host ? `${s.host}: ${s.why}` : s.why));
  return parts.length ? parts.join('; ') : 'no host enabled';
}

async function main(argv, { resolve, cfg, env = process.env, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  if (!argv.includes('--resolve')) { err('usage: chief.js --resolve [--json]\n'); return 2; }
  let r;
  try {
    const run = resolve || require('../lib/headless.js').resolveChief;
    r = await run(cfg, { env });
  } catch (e) {
    err(`chief: ${e.message}\n`);
    return 1;
  }
  out((argv.includes('--json') ? JSON.stringify(r) : format(r)) + '\n');
  return r.host ? 0 : EXIT_SKIP;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`chief: ${e.message}\n`); process.exit(1); });
module.exports = { main, format, detail, EXIT_SKIP };
