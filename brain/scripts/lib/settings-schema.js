'use strict';
/**
 * settings-schema.js — one entry per setting `aos config` can show or change (spec 2026-09-24-aos-config D2).
 * Pure: no vault, no fs. Defaults are read from config.default.json, never copied here. The keys `aos init` writes only
 * into agenticos.json (install paths, binaries, hosts) are listed read-only with the command that changes them (D6).
 *
 * An entry: { key, section, label, help, type, values?, min?, gt?, max?, int?, nullable?, risk?, applies, readonly?,
 * machine?, how?, vaultOnly?, followUp? }
 *   type      bool | enum | number | string | model | list | object
 *   gt        exclusive lower bound (a perCallUsd must be more than 0; a perDayUsd of 0 means no spend, D10)
 *   risk      spend | autonomy | privacy — the HUD asks before saving these
 *   applies   when a change takes effect: next-call | next-session | next-scan | next-duty | next-routine | next-sync |
 *             next-check | reinstall
 *   vaultOnly the runtime reads the key from brain/config.json alone, so it is always written there (D4)
 *   followUp  { command, why } — printed as a `next:` line after a set (D7)
 *   host      claude | codex — the setting only matters when that host is enabled (spec 2026-09-24-settings-tab D8)
 *   spend     hooks | duties | reasoner | routines | graph | crossReview — the ledger family a perDayUsd caps (D7)
 *   choices   the presets the Workbench offers in its picker (spec 2026-09-24-settings-pickers D2); `aos config set`
 *             still takes any valid value, and the Workbench keeps showing a value that is not a preset
 *   unit      usd | min | h | days | s | files | notes | tokens — how a number's presets are labelled
 *   pick      "many" — a list (or a comma string) chosen as chips from `choices`
 *   editIn    file | skills | agents — no picker: the Workbench offers a button to where it is edited (D4)
 */
const DEFAULTS = require('../config.default.json');

const SECTIONS = [
  { id: 'provider', label: 'Provider & models' },
  { id: 'spend', label: 'Spend limits' },
  { id: 'memory', label: 'Memory & scanning' },
  { id: 'persona', label: 'Chief of Staff' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'routines', label: 'Routines' },
  { id: 'graph', label: 'Knowledge graph' },
  { id: 'crossReview', label: 'Cross-review' },
  { id: 'sharing', label: 'Skills & agents' },
  { id: 'telemetry', label: 'Telemetry & privacy' },
  { id: 'updates', label: 'Updates' },
  { id: 'statusline', label: 'Status line' },
  { id: 'hosts', label: 'Hosts & install' },
];

const RUNNERS = ['auto', 'claude', 'codex'];
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const REASONER_EFFORTS = ['low', 'medium', 'high'];
const CROSS_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ROUTINES_SYNC = { command: 'aos routines sync', why: 'the schedules carry the duty model' };
const STATUSLINE_INSTALL = { command: 'aos statusline install', why: 'the host config is written only at install' };
const SKILLS_SYNC = { command: 'aos skills sync', why: 'share or unshare now instead of at the next session end' };
const AGENTS_SYNC = { command: 'aos agents sync', why: 'share or unshare now instead of at the next session end' };

const perCall = (key, section, label, help, extra = {}) => ({ key, section, label, help, type: 'number', gt: 0, risk: 'spend', applies: 'next-call', ...extra });
const perDay = (key, section, label, help, extra) => ({ key, section, label, help: `${help} 0 means no spend.`, type: 'number', min: 0, risk: 'spend', applies: 'next-call', ...extra });

const SETTINGS = [
  // ── Provider & models ───────────────────────────────────────────────────────
  { key: 'provider', section: 'provider', label: 'Background provider', type: 'enum', values: ['local', 'auto', 'ollama', 'claude', 'codex', 'none'], risk: 'spend', applies: 'next-call',
    help: 'Who answers background work: local runs it on the model on this Mac and never spends (with local.hostedFallback off); auto picks Ollama when it answers, then Claude, then Codex; none turns background model calls off.' },
  { key: 'local.engine', section: 'provider', label: 'Local engine', type: 'enum', values: ['ollama', 'openai'], applies: 'next-call',
    help: 'The local model server: ollama, or any OpenAI-compatible server (LM Studio, llama.cpp) at local.url.' },
  { key: 'local.url', section: 'provider', label: 'Local engine URL', type: 'string', nullable: true, applies: 'next-call',
    help: 'Where the local engine answers; null is Ollama at ollama.host:ollama.port, or LM Studio\'s http://127.0.0.1:1234/v1 for openai.' },
  { key: 'local.model', section: 'provider', label: 'Local model', type: 'model', nullable: true, applies: 'next-call',
    help: 'The local model for background work; null picks one for this Mac\'s memory (qwen3.5:4b under 12 GB, else qwen3.5:9b).' },
  { key: 'local.embedder', section: 'provider', label: 'Local embedding model', type: 'model', applies: 'next-scan',
    help: 'The local model that embeds notes for recall; changing it rebuilds the recall vectors at the next scan.' },
  { key: 'local.keepAlive', section: 'provider', label: 'Keep the local model loaded', type: 'string', nullable: true, applies: 'next-call',
    help: 'How long the local model stays in memory after a call (5m, 30m, -1 for always); null keeps it loaded on Macs with 24 GB or more, else 5m.' },
  { key: 'local.hostedFallback', section: 'provider', label: 'Use Claude or Codex when local is down', type: 'bool', risk: 'spend', applies: 'next-call',
    help: 'With provider local: when the local model cannot answer, send background work to Claude, then Codex, under their hook caps. Off: it waits or uses heuristics.' },
  { key: 'local.onBattery', section: 'provider', label: 'Heavy local work on battery', type: 'enum', values: ['defer', 'run'], applies: 'next-scan',
    help: 'defer holds the heavy local jobs (the semantic graph pass, the history digest) until the Mac is on power.' },
  { key: 'claude.model', section: 'provider', label: 'Claude model', type: 'model', host: 'claude', applies: 'next-call', followUp: ROUTINES_SYNC,
    help: 'Claude model for background calls when the provider is auto or claude (or local with hostedFallback on), and the duty model when the persona interview named none. An alias (haiku) or a full id.' },
  { key: 'codex.model', section: 'provider', label: 'Codex model', type: 'model', host: 'codex', nullable: true, applies: 'next-call',
    help: 'Codex model for background calls; null uses your own Codex default. Never a Claude alias.' },
  { key: 'codex.effort', section: 'provider', label: 'Codex effort', type: 'enum', host: 'codex', values: CODEX_EFFORTS, applies: 'next-call',
    help: 'Reasoning effort for background Codex calls.' },
  { key: 'reasoner.model', section: 'provider', label: 'Reasoner model', type: 'model', host: 'claude', applies: 'next-call',
    help: 'Claude model the Chat tab and other reasoning calls use.' },
  { key: 'reasoner.codexModel', section: 'provider', label: 'Reasoner model on Codex', type: 'model', host: 'codex', nullable: true, applies: 'next-call',
    help: 'Codex model for the reasoner when Codex answers it; null falls back to codex.model.' },
  { key: 'reasoner.effort', section: 'provider', label: 'Reasoner effort', type: 'enum', values: REASONER_EFFORTS, applies: 'next-call',
    help: 'Thinking effort for reasoner calls.' },
  { key: 'ollama.host', section: 'provider', label: 'Ollama host', type: 'string', applies: 'next-call',
    help: 'Where a local Ollama answers.' },
  { key: 'ollama.port', section: 'provider', label: 'Ollama port', type: 'number', int: true, min: 1, max: 65535, applies: 'next-call',
    help: 'Ollama port.' },

  // ── Spend limits ────────────────────────────────────────────────────────────
  perCall('claude.perCallUsd', 'spend', 'Background call cap (Claude)', 'Most one background Claude call may spend, in USD.', { host: 'claude' }),
  perDay('claude.perDayUsd', 'spend', 'Background daily cap (Claude)', 'Most background hook calls may spend per day on Claude, in USD.', { host: 'claude', spend: 'hooks' }),
  perCall('codex.perCallUsd', 'spend', 'Background call cap (Codex)', 'Most one background Codex call may spend, in USD (estimated after the call).', { host: 'codex' }),
  perDay('codex.perDayUsd', 'spend', 'Background daily cap (Codex)', 'Most background hook calls may spend per day on Codex, in USD.', { host: 'codex', spend: 'hooks' }),
  perCall('reasoner.perCallUsd', 'spend', 'Reasoner call cap', 'Most one reasoner call may spend, in USD.'),
  perDay('reasoner.perDayUsd', 'spend', 'Reasoner daily cap', 'Most reasoner calls may spend per day, in USD.', { spend: 'reasoner' }),
  perCall('persona.perDutyUsd', 'spend', 'Duty cap', 'Most one Chief of Staff duty may spend, in USD.'),
  perDay('persona.perDayUsd', 'spend', 'Chief of Staff daily cap', 'Most the Chief of Staff duties may spend per day, in USD, on both hosts together; a capped day is skipped on both.', { spend: 'duties' }),
  perCall('routines.perRunUsd', 'spend', 'Routine run cap', 'Most one prompt routine run may spend, in USD, unless the routine names its own budget.'),
  perDay('routines.perDayUsd', 'spend', 'Routines daily cap', 'Most prompt routines may spend per day, in USD.', { spend: 'routines' }),
  perCall('graph.semantic.perCallUsd', 'spend', 'Semantic graph call cap', 'Most one semantic graph pass may spend, in USD.'),
  perDay('graph.semantic.perDayUsd', 'spend', 'Semantic graph daily cap', 'Most the semantic graph pass may spend per day, in USD.', { spend: 'graph' }),
  perCall('crossReview.perCallUsd', 'spend', 'Cross-review call cap', 'Most one cross-review call may spend, in USD.'),
  perDay('crossReview.perDayUsd', 'spend', 'Cross-review daily cap', 'Most cross-review calls may spend per day, in USD.', { spend: 'crossReview' }),
  perCall('sessions.perTurnUsd', 'spend', 'Session turn cap', 'Most one turn of a session in the Sessions tab may spend, in USD (Claude stops at it; a Codex turn is estimated after it ends).'),
  perDay('sessions.perDayUsd', 'spend', 'Sessions daily cap', 'Most the turns of every session may spend per day, in USD; a turn does not start once it is reached.', { spend: 'sessions' }),
  { key: 'cost.enabled', section: 'spend', label: 'Session costing', type: 'bool', applies: 'next-session',
    help: 'Cost every session at its end (needs python3; turning it on installs the analyzer).' },
  { key: 'cost.monthlyBudget', section: 'spend', label: 'Monthly budget', type: 'number', gt: 0, nullable: true, applies: 'next-session',
    help: 'Monthly budget the cost report compares session cost against. Shown only, never enforced; null for none.' },

  // ── Memory & scanning ───────────────────────────────────────────────────────
  { key: 'dailyNote.layout', section: 'memory', label: 'Daily note layout', type: 'string', vaultOnly: true, applies: 'next-session',
    help: 'Where daily notes go, as a date template ({yyyy}, {MM}, {MMMM}, {dd}).' },
  { key: 'recallRoots', section: 'memory', label: 'Recall roots', type: 'list', applies: 'next-call',
    help: 'Vault folders recall searches, as a JSON list.' },
  { key: 'quickLinks', section: 'memory', label: 'BRAIN.md quick links', type: 'list', applies: 'next-scan',
    help: 'Lines BRAIN.md lists under its quick links, as a JSON list.' },
  { key: 'roster.orchestrators', section: 'memory', label: 'Orchestrator roster', type: 'object', applies: 'next-session',
    help: 'Named orchestrators for the heartbeat roster: {"name": {"nickname", "trigger", "match"}}.' },
  { key: 'scan.fileMapBudget', section: 'memory', label: 'File map budget', type: 'number', int: true, min: 0, applies: 'next-scan',
    help: 'Files a scan may summarize with the local provider.' },
  { key: 'scan.embedBudget', section: 'memory', label: 'Embedding budget', type: 'number', int: true, min: 0, applies: 'next-scan',
    help: 'Notes a scan may embed with the local provider.' },
  { key: 'scan.fileMapBudgetUnderClaude', section: 'memory', label: 'File map budget on Claude', type: 'number', int: true, min: 0, risk: 'spend', applies: 'next-scan',
    help: 'Files a scan may summarize when Claude is the provider (paid; 0 = off).' },
  { key: 'scan.insightsUnderClaude', section: 'memory', label: 'Workspace insights on Claude', type: 'bool', risk: 'spend', applies: 'next-scan',
    help: 'Let scans write workspace insights with Claude (paid).' },
  { key: 'scan.fileMapBudgetUnderCodex', section: 'memory', label: 'File map budget on Codex', type: 'number', int: true, min: 0, risk: 'spend', applies: 'next-scan',
    help: 'Files a scan may summarize when Codex is the provider (paid; 0 = off).' },
  { key: 'scan.insightsUnderCodex', section: 'memory', label: 'Workspace insights on Codex', type: 'bool', risk: 'spend', applies: 'next-scan',
    help: 'Let scans write workspace insights with Codex (paid).' },
  { key: 'scan.autoSweepOrphans', section: 'memory', label: 'Sweep orphaned session residue', type: 'bool', applies: 'next-scan',
    help: 'Let scans delete empty session-env and file-history folders a crashed session left behind. A boolean in brain/_index/scanner-config.json still wins.' },
  { key: 'summary.everyPrompts', section: 'memory', label: 'Session summary every', type: 'number', int: true, min: 1, applies: 'next-reply',
    help: 'Prompts you type in a session between two working-memory summaries (BRAIN.md Last Session, the daily note, SESSION.md). Counted per session; tool results and slash commands do not count.' },
  { key: 'summary.minMinutes', section: 'memory', label: 'Session summary at most every', type: 'number', int: true, min: 0, applies: 'next-reply',
    help: 'Minutes that must pass between two summaries of the same session, however many prompts came in between. 0 turns the floor off.' },
  // Spaces (spec 2026-10-09-spaces-redesign D30): status, counts and git rows the scan works out per workspace.
  { key: 'workspaces.activeDays', section: 'memory', label: 'Workspace active for', type: 'number', int: true, min: 1, applies: 'next-scan',
    help: 'Days after its last session or commit that a workspace reads active in Spaces; after that, one with a plan reads stalled.' },
  { key: 'workspaces.idleDays', section: 'memory', label: 'Workspace idle after', type: 'number', int: true, min: 1, applies: 'next-scan',
    help: 'Days with no session or commit before a workspace reads idle. Session counts cover the same window on both hosts.' },
  { key: 'workspaces.commits', section: 'memory', label: 'Commits per workspace', type: 'number', int: true, min: 0, applies: 'next-scan',
    help: 'Recent commits Spaces lists for a workspace, from its own repository, its linked code folder, or the vault\'s git for its folder.' },
  { key: 'workspaces.recentSessions', section: 'memory', label: 'Sessions per workspace', type: 'number', int: true, min: 1, applies: 'next-scan',
    help: 'Recent Claude Code and Codex sessions the scan keeps per workspace for its history and Resume.' },
  { key: 'workspaces.ignoreCommitSubjects', section: 'memory', label: 'Commits that are not work', type: 'list', applies: 'next-scan',
    help: 'Commit subjects, as regular expressions in a JSON list, that do not count as work in a folder the vault\'s own git tracks (automatic backups), unless the commit adds or changes a file other than workspace.md and the README.md, CLAUDE.md and AGENTS.md stubs.' },
  { key: 'workspaces.attributeByFiles', section: 'memory', label: 'Credit vault-root sessions by files', type: 'bool', applies: 'next-scan',
    help: 'Count a session started at the vault root for the workspace whose files it touched most (at least 3 touches, no tie).' },
  // The Brain hub (spec 2026-10-11-brain-hub D25): the usage log's window and the cache's duplicate thresholds.
  { key: 'memory.usageDays', section: 'memory', label: 'Keep memory use rows for', type: 'number', int: true, min: 30, applies: 'next-scan',
    help: 'Days of rows memory-usage.jsonl keeps (which memories were injected, recalled or read, by path only); older rows fold into totals.' },
  { key: 'memory.neverUsedDays', section: 'memory', label: 'Memory unused after', type: 'number', int: true, min: 7, applies: 'next-scan',
    help: 'Days with no injection, recall or read before Brain lists a memory as dead weight (shown once the log is that old).' },
  { key: 'memory.dupScore', section: 'memory', label: 'Duplicate threshold', type: 'number', min: 0.5, max: 1, applies: 'next-scan',
    help: 'How alike two memories must be (0.5 to 1, against this vault\'s own pairs) before Brain flags them as likely duplicates.' },
  { key: 'memory.clusterMin', section: 'memory', label: 'Cluster size', type: 'number', int: true, min: 2, applies: 'next-scan',
    help: 'Memories that must link up as near duplicates before Brain offers them as one group to consolidate.' },
  { key: 'memory.mapMin', section: 'memory', label: 'Map community size', type: 'number', int: true, min: 1, applies: 'next-scan',
    help: 'Memories a graph community must hold to appear on Brain\'s map.' },

  // ── Chief of Staff ──────────────────────────────────────────────────────────
  { key: 'persona.enabled', section: 'persona', label: 'Chief of Staff', type: 'bool', risk: 'autonomy', applies: 'next-session',
    help: 'The whole Chief of Staff: its context in sessions, the watchdog and the scheduled duties (persona/DISABLED follows it).' },
  { key: 'persona.runner', section: 'persona', label: 'Duty runner', type: 'enum', values: RUNNERS, applies: 'next-duty',
    help: 'Which host runs the duties: auto (Claude Code when it is on and signed in, else Codex), claude or codex.' },
  // local-first A4/A11: the Chief of Staff runs on a hosted model per host (sdk/lib/models.js CHIEF), with failover.
  { key: 'persona.model', section: 'persona', label: 'Duty model on Claude', type: 'model', host: 'claude', nullable: true, applies: 'next-duty', followUp: ROUTINES_SYNC,
    help: 'Claude model for duties (default claude-opus-5-5); null keeps the pre-2.0 chain: the interview answer, then claude.model. A duty routine\'s own model: wins.' },
  { key: 'persona.effort', section: 'persona', label: 'Duty effort', type: 'enum', values: REASONER_EFFORTS, nullable: true, applies: 'next-duty', followUp: ROUTINES_SYNC,
    help: 'Effort for duties on either host; null uses the interview answer, then medium. A duty routine\'s own effort: wins.' },
  { key: 'persona.codexModel', section: 'persona', label: 'Duty model on Codex', type: 'model', host: 'codex', nullable: true, applies: 'next-duty',
    help: 'Codex model for duties (default gpt-6-sol); null uses codex.model, then your Codex default.' },
  { key: 'persona.failover', section: 'persona', label: 'Duty failover', type: 'bool', applies: 'next-duty',
    help: 'With both hosts on, a duty that cannot start on its host (CLI missing or signed out) runs on the other host\'s duty model instead. Off: it is skipped. The daily cap is never a reason to move.' },
  { key: 'persona.watchdog.graceMinutes', section: 'persona', label: 'Watchdog grace', type: 'number', int: true, min: 1, applies: 'next-session',
    help: 'Minutes past its schedule before a missed duty is flagged.' },
  { key: 'persona.watchdog.notify', section: 'persona', label: 'Watchdog notifications', type: 'bool', applies: 'next-session',
    help: 'Send a desktop notification when a duty fails or goes missing.' },
  { key: 'persona.tick.flagAgeDays', section: 'persona', label: 'Stale flag age', type: 'number', int: true, min: 1, applies: 'next-duty',
    help: 'Days before an open flag counts as stale.' },
  { key: 'persona.tick.earlyReflect.corrections', section: 'persona', label: 'Early reflect: corrections', type: 'number', int: true, min: 1, applies: 'next-duty',
    help: 'Corrections in a day that trigger an early reflection.' },
  { key: 'persona.tick.earlyReflect.dutyFailures', section: 'persona', label: 'Early reflect: duty failures', type: 'number', int: true, min: 1, applies: 'next-duty',
    help: 'Duty failures in a day that trigger an early reflection.' },
  { key: 'persona.briefing.enabled', section: 'persona', label: 'Pulse briefing', type: 'bool', risk: 'spend', applies: 'next-duty',
    help: 'The Chief of Staff writes the paragraph at the top of Pulse (the briefing routine, every 30 minutes from 7:00 to 22:00, only when the facts changed), as a duty:briefing call against the daily duty cap. Off: Pulse composes it from the same facts.' },
  { key: 'persona.briefing.staleHours', section: 'persona', label: 'Pulse briefing shown for', type: 'number', int: true, min: 1, applies: 'next-session',
    help: 'Hours a written briefing stays on Pulse; after that, or when the last run failed, Pulse composes the paragraph from the facts.' },
  { key: 'persona.autoapply.minVerified', section: 'persona', label: 'Autoapply threshold', type: 'number', int: true, min: 1, risk: 'autonomy', applies: 'next-duty',
    help: 'Verified outcomes a proposal class needs before the Chief of Staff may apply it without asking. Lower means more autonomy.' },

  // ── Routines ────────────────────────────────────────────────────────────────
  { key: 'notifications.osAlert', section: 'notifications', label: 'Desktop alerts', type: 'bool', applies: 'next-call',
    help: 'Show a desktop notification when an agent posts a breaking or alert item with `aos notify`.' },
  { key: 'notifications.retentionDays', section: 'notifications', label: 'Retention', type: 'number', gt: 0, applies: 'next-call',
    help: 'Days before `aos notify prune` archives an item. Items are archived, never deleted.' },
  { key: 'notifications.maxPerSenderPerHour', section: 'notifications', label: 'Posts per sender per hour', type: 'number', int: true, min: 0, applies: 'next-call',
    help: 'Past this many posts in an hour, a sender\'s items are written as info and raise no desktop alert.' },
  { key: 'routines.enabled', section: 'routines', label: 'Routines', type: 'bool', risk: 'autonomy', applies: 'next-routine',
    help: 'Let scheduled routines run. Off skips every run; the schedules stay loaded.' },
  { key: 'routines.runner', section: 'routines', label: 'Routine runner', type: 'enum', values: RUNNERS, applies: 'next-routine',
    help: 'Which host runs prompt routines: auto, claude or codex.' },
  { key: 'routines.codexModel', section: 'routines', label: 'Routine model on Codex', type: 'model', host: 'codex', nullable: true, applies: 'next-routine',
    help: 'Codex model for prompt routines; null uses codex.model, then your Codex default.' },
  { key: 'routines.tools', section: 'routines', label: 'Routine tools', type: 'string', risk: 'autonomy', applies: 'next-routine',
    help: 'Tools a prompt routine may use, comma-separated (Read,Glob,Grep). Adding a writing tool lets routines change files.' },
  { key: 'routines.externalLabels', section: 'routines', label: 'External schedule labels', type: 'list', applies: 'next-session',
    help: 'launchd labels of your own schedules the Routines tab lists read-only, as a JSON list.' },

  // ── Knowledge graph ─────────────────────────────────────────────────────────
  { key: 'graph.enabled', section: 'graph', label: 'Knowledge graph', type: 'bool', applies: 'next-scan',
    help: 'Rebuild the vault graph on each scan (local, no model).' },
  { key: 'graph.out', section: 'graph', label: 'Graph folder', type: 'string', applies: 'next-scan',
    help: 'Where the graph is written, relative to the vault.' },
  { key: 'graph.timeoutSec', section: 'graph', label: 'Graph build timeout', type: 'number', int: true, gt: 0, applies: 'next-scan',
    help: 'Seconds a structural build may take.' },
  { key: 'graph.staleDays', section: 'graph', label: 'Graph stale after', type: 'number', int: true, min: 1, applies: 'next-scan',
    help: 'Days before doctor calls the graph stale.' },
  { key: 'graph.semantic.enabled', section: 'graph', label: 'Semantic graph pass', type: 'enum', values: [true, false, 'auto'], risk: 'spend', applies: 'next-scan',
    help: 'The daily model pass that adds concepts and links: true, false, or auto (on unless the provider is ollama or none).' },
  { key: 'graph.semantic.runner', section: 'graph', label: 'Semantic pass runner', type: 'enum', values: RUNNERS, applies: 'next-scan',
    help: 'Which host runs the semantic pass: auto, claude or codex.' },
  { key: 'graph.semantic.everyHours', section: 'graph', label: 'Semantic pass interval', type: 'number', gt: 0, applies: 'next-scan',
    help: 'Hours between semantic passes.' },
  { key: 'graph.semantic.tokenBudget', section: 'graph', label: 'Semantic token budget', type: 'number', int: true, gt: 0, risk: 'spend', applies: 'next-scan',
    help: 'Tokens of changed notes one semantic pass may read.' },
  { key: 'graph.semantic.timeoutSec', section: 'graph', label: 'Semantic pass timeout', type: 'number', int: true, gt: 0, applies: 'next-scan',
    help: 'Seconds one semantic pass may take.' },

  // ── Cross-review ────────────────────────────────────────────────────────────
  { key: 'crossReview.enabled', section: 'crossReview', label: 'Cross-review', type: 'bool', applies: 'next-call',
    help: 'Let cross-review and handoff call the other host.' },
  { key: 'crossReview.claudeModel', section: 'crossReview', label: 'Cross-review Claude model', type: 'model', host: 'claude', nullable: true, applies: 'next-call',
    help: 'Claude model for reviews; null uses Claude Code\'s default.' },
  { key: 'crossReview.codexModel', section: 'crossReview', label: 'Cross-review Codex model', type: 'model', host: 'codex', nullable: true, applies: 'next-call',
    help: 'Codex model for reviews; null uses your Codex default.' },
  { key: 'crossReview.effort', section: 'crossReview', label: 'Cross-review effort', type: 'enum', values: CROSS_EFFORTS, nullable: true, applies: 'next-call',
    help: 'Effort for reviews; null uses each CLI\'s default. Claude takes low to max, Codex minimal to xhigh.' },
  { key: 'crossReview.timeoutSec', section: 'crossReview', label: 'Cross-review timeout', type: 'number', int: true, gt: 0, applies: 'next-call',
    help: 'Seconds one review call may take.' },
  { key: 'crossReview.rounds', section: 'crossReview', label: 'Cross-review rounds', type: 'number', int: true, min: 1, max: 20, applies: 'next-call',
    help: 'Most plan-review rounds before the loop stops.' },

  // ── Skills & agents ─────────────────────────────────────────────────────────
  { key: 'skills.sync', section: 'sharing', label: 'Share skills', type: 'bool', applies: 'next-sync', followUp: SKILLS_SYNC,
    help: 'Copy each host\'s own skills to the other host at session end (needs both hosts).' },
  { key: 'skills.exclude', section: 'sharing', label: 'Skills not shared', type: 'list', applies: 'next-sync', followUp: SKILLS_SYNC,
    help: 'Skill names never shared, as a JSON list (aos skills exclude|include edits it too).' },
  { key: 'agents.sync', section: 'sharing', label: 'Share agents', type: 'bool', applies: 'next-sync', followUp: AGENTS_SYNC,
    help: 'Copy each host\'s own subagents to the other host at session end (needs both hosts).' },
  { key: 'agents.exclude', section: 'sharing', label: 'Agents not shared', type: 'list', applies: 'next-sync', followUp: AGENTS_SYNC,
    help: 'Agent names never shared, as a JSON list (aos agents exclude|include edits it too).' },

  // ── Telemetry & privacy ─────────────────────────────────────────────────────
  { key: 'telemetry.enabled', section: 'telemetry', label: 'Telemetry', type: 'bool', applies: 'next-session',
    help: 'Record agent runs under brain/_index/agent-runs/ (Runs tab, Pulse, spend).' },
  { key: 'telemetry.redact', section: 'telemetry', label: 'Redact tool inputs', type: 'bool', risk: 'privacy', applies: 'next-session',
    help: 'Keep tool inputs out of telemetry. Off stores them as typed.' },
  { key: 'telemetry.retentionDays', section: 'telemetry', label: 'Telemetry retention', type: 'number', int: true, min: 1, applies: 'next-scan',
    help: 'Days of run telemetry kept.' },
  { key: 'telemetry.staleAfterMinutes', section: 'telemetry', label: 'Run stale after', type: 'number', int: true, min: 1, applies: 'next-scan',
    help: 'Minutes without activity before a live run counts as crashed.' },

  // ── Updates ─────────────────────────────────────────────────────────────────
  { key: 'updates.check', section: 'updates', label: 'Update checks', type: 'bool', applies: 'next-check',
    help: 'Check for a new release at session start.' },
  { key: 'updates.intervalHours', section: 'updates', label: 'Update check interval', type: 'number', gt: 0, applies: 'next-check',
    help: 'Hours between update checks.' },

  // ── Status line (spec 2026-09-28-statusline-design) ─────────────────────────
  { key: 'statusline.segments', section: 'statusline', label: 'Status line segments', type: 'list', applies: 'next-render',
    help: 'What the third line shows, in order of priority: needs-you, runs, spend, health.' },
  { key: 'statusline.links', section: 'statusline', label: 'Clickable links', type: 'bool', applies: 'next-render',
    help: 'Make status line segments open the Workbench tab they name (terminals with OSC 8 links).' },
  { key: 'statusline.chainPosition', section: 'statusline', label: 'Chained line position', type: 'enum', values: ['top', 'bottom'], applies: 'next-render',
    help: 'With --chain-output, where the previous status line\'s first line goes: top (above ours) or bottom (below).' },
  { key: 'statusline.subagents', section: 'statusline', label: 'Subagent rows', type: 'bool', applies: 'next-install', followUp: STATUSLINE_INSTALL,
    help: 'Also render Claude Code subagent rows (model, effort, context, age).' },
  { key: 'statusline.refreshSeconds', section: 'statusline', label: 'Status line refresh', type: 'number', int: true, min: 1, applies: 'next-install', followUp: STATUSLINE_INSTALL,
    help: 'Seconds between Claude Code status line refreshes while idle.' },
  { key: 'statusline.codexItems', section: 'statusline', label: 'Codex footer items', type: 'list', host: 'codex', applies: 'next-install', followUp: STATUSLINE_INSTALL,
    help: 'Built-in Codex status line items written to config.toml (Codex runs no status line command).' },

  // ── Hosts & install: read-only, D6 ──────────────────────────────────────────
  ...[
    ['version', 'Installed version', 'aos upgrade'],
    ['vault', 'Vault', 'aos init --vault <dir>'],
    ['node', 'Node binary', 'aos upgrade (records the node that runs it)'],
    ['claudeConfigDir', 'Claude Code config folder', 'aos init with CLAUDE_CONFIG_DIR set'],
    ['claude.bin', 'claude binary', 'aos upgrade (re-resolves it)'],
    ['codex.bin', 'codex binary', 'aos upgrade (re-resolves it)'],
    ['graph.bin', 'graphify binary', 'aos upgrade (reinstalls the pinned graphify)'],
    ['hosts.claude.enabled', 'Claude Code host', 'aos init --host claude|both, or aos uninstall --host claude'],
    ['hosts.claude.configDir', 'Claude Code config folder (host)', 'aos init with CLAUDE_CONFIG_DIR set'],
    ['hosts.claude.bin', 'claude binary (host)', 'aos upgrade (re-resolves it)'],
    ['hosts.codex.enabled', 'Codex host', 'aos init --host codex|both, or aos uninstall --host codex'],
    ['hosts.codex.home', 'Codex home', 'aos init with CODEX_HOME set'],
    ['hosts.codex.bin', 'codex binary (host)', 'aos upgrade (re-resolves it)'],
    ['hosts.codex.install', 'Codex wiring', 'aos upgrade (plugin when the Codex CLI supports it, else direct)'],
  ].map(([key, label, how]) => ({ key, section: 'hosts', label, type: 'string', readonly: true, machine: true, applies: 'reinstall', how,
    help: 'Written by the installer into agenticos.json; the launcher, schedules and Codex wiring carry it.' })),
];

// ── presets (spec 2026-09-24-settings-pickers): every settable value that is not a bool or an enum is picked, not typed ──
// Claude Code takes the aliases and the pinned ids; the Codex list is the pricing table's, so a model it cannot price
// is never offered. A value outside these still works through `aos config set`.
const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-1'];
const CODEX_MODELS = Object.keys(require('../sdk/lib/codex-pricing.js').MODELS);
// The Chief of Staff's Codex model (local-first A4) leads its own picker, priced at the default rate until the pricing
// table lists it (spend under Codex is an estimate either way).
const CHIEF_CODEX = require('../sdk/lib/models.js').CHIEF.codex;
const CHIEF_CODEX_MODELS = [CHIEF_CODEX, ...CODEX_MODELS.filter((m) => m !== CHIEF_CODEX)];
// local-first A12: the tiers' models and the next size up; LOCAL_EMBEDDERS the recall embedder. Any pulled tag still works.
const LOCAL_MODELS = ['qwen3.5:4b', 'qwen3.5:9b', 'qwen3.5:27b'];
const LOCAL_EMBEDDERS = ['qwen3-embedding:0.6b'];
const USD_CALL = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5];
const USD_RUN = [0.25, 0.5, 1, 2, 3, 5, 10];
const USD_DAY = [0, 0.25, 0.5, 1, 2, 3, 5, 6, 10, 15, 20, 30, 50];
const usd = (choices) => ({ choices, unit: 'usd' });
const PICKS = {
  'claude.model': { choices: CLAUDE_MODELS }, 'reasoner.model': { choices: CLAUDE_MODELS }, 'crossReview.claudeModel': { choices: CLAUDE_MODELS }, 'persona.model': { choices: CLAUDE_MODELS },
  'codex.model': { choices: CODEX_MODELS }, 'reasoner.codexModel': { choices: CODEX_MODELS }, 'persona.codexModel': { choices: CHIEF_CODEX_MODELS },
  'routines.codexModel': { choices: CODEX_MODELS }, 'crossReview.codexModel': { choices: CODEX_MODELS },
  'ollama.host': { choices: ['127.0.0.1', 'localhost'] }, 'ollama.port': { choices: [11434] },
  'local.url': { choices: ['http://127.0.0.1:11434', 'http://127.0.0.1:1234/v1'] },
  'local.model': { choices: LOCAL_MODELS }, 'local.embedder': { choices: LOCAL_EMBEDDERS },
  'local.keepAlive': { choices: ['5m', '30m', '-1'] },
  'claude.perCallUsd': usd(USD_CALL), 'codex.perCallUsd': usd(USD_CALL), 'reasoner.perCallUsd': usd(USD_CALL),
  'graph.semantic.perCallUsd': usd(USD_CALL), 'crossReview.perCallUsd': usd(USD_CALL),
  'persona.perDutyUsd': usd(USD_RUN), 'routines.perRunUsd': usd(USD_RUN), 'sessions.perTurnUsd': usd(USD_RUN),
  'claude.perDayUsd': usd(USD_DAY), 'codex.perDayUsd': usd(USD_DAY), 'reasoner.perDayUsd': usd(USD_DAY), 'persona.perDayUsd': usd(USD_DAY),
  'routines.perDayUsd': usd(USD_DAY), 'graph.semantic.perDayUsd': usd(USD_DAY), 'crossReview.perDayUsd': usd(USD_DAY), 'sessions.perDayUsd': usd(USD_DAY),
  'cost.monthlyBudget': usd([10, 25, 50, 100, 150, 200, 300, 500, 1000]),
  'dailyNote.layout': { choices: ['{yyyy}/{yyyy}-{MM}-{MMMM}/{yyyy}-{MM}-{dd}.md', '{yyyy}/{yyyy}-{MM}-{dd}.md', 'Daily/{yyyy}-{MM}-{dd}.md', 'brain/sessions/{yyyy}-{MM}-{dd}.md', '{yyyy}-{MM}-{dd}.md'] },
  recallRoots: { pick: 'many', choices: ['brain/memory', 'brain/patterns', 'persona/journal', 'brain/notifications', 'brain/sessions', 'brain/reflections', 'workspaces'] },
  quickLinks: { editIn: 'file' }, 'roster.orchestrators': { editIn: 'file' }, 'routines.externalLabels': { editIn: 'file' },
  'skills.exclude': { editIn: 'skills' }, 'agents.exclude': { editIn: 'agents' },
  'scan.fileMapBudget': { choices: [0, 10, 20, 40, 80, 160], unit: 'files' }, 'scan.embedBudget': { choices: [0, 10, 20, 40, 80, 160], unit: 'notes' },
  'scan.fileMapBudgetUnderClaude': { choices: [0, 10, 20, 40, 80], unit: 'files' }, 'scan.fileMapBudgetUnderCodex': { choices: [0, 10, 20, 40, 80], unit: 'files' },
  'summary.everyPrompts': { choices: [3, 5, 10, 15, 20, 30] }, 'summary.minMinutes': { choices: [0, 5, 10, 15, 30, 60], unit: 'min' },
  'workspaces.activeDays': { choices: [3, 5, 7, 10, 14, 21], unit: 'days' }, 'workspaces.idleDays': { choices: [14, 21, 30, 45, 60, 90], unit: 'days' },
  'workspaces.commits': { choices: [0, 5, 10, 20, 30] }, 'workspaces.recentSessions': { choices: [6, 12, 20, 30] },
  'workspaces.ignoreCommitSubjects': { editIn: 'file' },
  'memory.usageDays': { choices: [30, 60, 90, 180, 365], unit: 'days' }, 'memory.neverUsedDays': { choices: [14, 30, 60, 90], unit: 'days' },
  'memory.dupScore': { choices: [0.7, 0.75, 0.8, 0.85, 0.9] }, 'memory.clusterMin': { choices: [2, 3, 4, 5] }, 'memory.mapMin': { choices: [3, 5, 8, 12, 20] },
  'persona.watchdog.graceMinutes': { choices: [15, 30, 45, 60, 90, 120], unit: 'min' }, 'persona.tick.flagAgeDays': { choices: [3, 5, 7, 14, 30], unit: 'days' },
  'persona.briefing.staleHours': { choices: [1, 2, 3, 6, 12], unit: 'h' },
  'persona.tick.earlyReflect.corrections': { choices: [1, 2, 3, 5, 10] }, 'persona.tick.earlyReflect.dutyFailures': { choices: [1, 2, 3, 5, 10] },
  'persona.autoapply.minVerified': { choices: [1, 2, 3, 5, 10] },
  'routines.tools': { pick: 'many', choices: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'Bash'] },
  'graph.out': { choices: ['brain/graphify-out'] }, 'graph.timeoutSec': { choices: [60, 120, 300, 600], unit: 's' },
  'graph.staleDays': { choices: [1, 3, 7, 14, 30], unit: 'days' }, 'graph.semantic.everyHours': { choices: [6, 12, 24, 48, 168], unit: 'h' },
  'graph.semantic.tokenBudget': { choices: [5000, 10000, 20000, 50000, 100000], unit: 'tokens' }, 'graph.semantic.timeoutSec': { choices: [600, 1200, 1800, 3600], unit: 's' },
  'crossReview.timeoutSec': { choices: [300, 600, 900, 1800], unit: 's' }, 'crossReview.rounds': { choices: [1, 2, 3, 4, 5, 6, 8, 10] },
  'telemetry.retentionDays': { choices: [7, 14, 30, 60, 90, 180, 365], unit: 'days' }, 'telemetry.staleAfterMinutes': { choices: [10, 15, 30, 60, 120], unit: 'min' },
  'updates.intervalHours': { choices: [6, 12, 24, 48, 168], unit: 'h' },
  'notifications.retentionDays': { choices: [7, 14, 30, 60, 90, 180], unit: 'days' }, 'notifications.maxPerSenderPerHour': { choices: [0, 1, 3, 6, 10, 20] },
  'statusline.segments': { pick: 'many', strict: true, choices: ['needs-you', 'runs', 'spend', 'health'] },
  'statusline.refreshSeconds': { choices: [1, 2, 5, 10, 30], unit: 's' },
  // Codex's built-in status line items (codex-cli 0.156 StatusLineItem; workspace-headline is Enterprise-only).
  'statusline.codexItems': { pick: 'many', strict: true, choices: ['model', 'model-with-reasoning', 'reasoning', 'current-dir', 'project-name', 'hostname', 'git-branch',
    'pull-request-number', 'branch-changes', 'run-state', 'permissions', 'approval-mode', 'context-remaining', 'context-used', 'five-hour-limit',
    'weekly-limit', 'codex-version', 'context-window-size', 'used-tokens', 'total-input-tokens', 'total-output-tokens', 'thread-credits',
    'estimated-thread-cost', 'thread-id', 'fast-mode', 'raw-output', 'thread-name', 'thread-title', 'task-progress'] },
};
for (const e of SETTINGS) if (PICKS[e.key]) Object.assign(e, PICKS[e.key]);
const UNITS = ['usd', 'min', 'h', 'days', 's', 'files', 'notes', 'tokens'];

const BY_KEY = new Map(SETTINGS.map((e) => [e.key, e]));
/** The ledger families a daily cap can govern (D7); cli/aos.js sums today's spend per family for `list --json`. */
const SPEND_FAMILIES = ['hooks', 'duties', 'reasoner', 'routines', 'graph', 'crossReview', 'sessions'];

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** The value at a dotted key, or undefined. */
function getPath(obj, key) {
  let o = obj;
  for (const k of key.split('.')) {
    if (!isPlainObject(o) || !Object.prototype.hasOwnProperty.call(o, k)) return undefined;
    o = o[k];
  }
  return o;
}

function entry(key) { return BY_KEY.get(key) || null; }
/** True when `key` is an ancestor of a setting (e.g. `graph.semantic`), so a config walk descends into it. */
function isPrefix(key) { return SETTINGS.some((e) => e.key.startsWith(`${key}.`)); }
function defaultOf(e) { return e.machine ? undefined : structuredClone(getPath(DEFAULTS, e.key)); }

/** Every leaf of a config object as a dotted key: a scalar, an array, or an empty object ends a branch. */
function leafKeys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && Object.keys(v).length) out.push(...leafKeys(v, key));
    else out.push(key);
  }
  return out;
}

const BOOL_WORDS = { true: true, on: true, yes: true, false: false, off: false, no: false };

/** CLI text → a value of the entry's type. Throws with a message that names the key and an example. */
function parseValue(e, text) {
  const t = String(text).trim();
  if (e.nullable && t === 'null') return null;
  if (e.type === 'bool') {
    const b = BOOL_WORDS[t.toLowerCase()];
    if (b === undefined) throw new Error(`${e.key} takes true or false (got "${t}")`);
    return b;
  }
  if (e.type === 'enum') {
    if (e.values.includes(t)) return t;
    const b = BOOL_WORDS[t.toLowerCase()];
    if (b !== undefined && e.values.includes(b)) return b;
    throw new Error(`${e.key} takes ${e.values.map(String).join(' | ')}${e.nullable ? ' | null' : ''} (got "${t}")`);
  }
  if (e.type === 'number') {
    const n = t === '' ? NaN : Number(t);
    if (!Number.isFinite(n)) throw new Error(`${e.key} takes a number (got "${t}")`);
    return n;
  }
  if (e.type === 'list' || e.type === 'object') {
    try { return JSON.parse(t); } catch { throw new Error(`${e.key} takes JSON, e.g. ${e.type === 'list' ? '\'["a","b"]\'' : '\'{"name":{}}\''} (got "${t}")`); }
  }
  return t;
}

/** null when `value` is valid for the entry, else a one-line reason. */
function validate(e, value) {
  if (value === null) return e.nullable ? null : `${e.key} cannot be null`;
  switch (e.type) {
    case 'bool': return typeof value === 'boolean' ? null : `${e.key} must be true or false`;
    case 'enum': return e.values.includes(value) ? null : `${e.key} must be one of ${e.values.map(String).join(' | ')}`;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${e.key} must be a number`;
      if (e.int && !Number.isInteger(value)) return `${e.key} must be a whole number`;
      if (e.gt !== undefined && !(value > e.gt)) return `${e.key} must be more than ${e.gt}${e.risk === 'spend' ? ' (to stop spending, set the matching perDayUsd to 0 or turn the feature off)' : ''}`;
      if (e.min !== undefined && value < e.min) return `${e.key} must be at least ${e.min}`;
      if (e.max !== undefined && value > e.max) return `${e.key} must be at most ${e.max}`;
      return null;
    case 'string': case 'model': return typeof value === 'string' && value.trim() !== '' ? null : `${e.key} must be a non-empty string`;
    case 'list': {
      if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) return `${e.key} must be a JSON list of strings`;
      // `strict` lists accept only their choices (the status line's segments and Codex's built-in footer items).
      const bad = e.strict && Array.isArray(e.choices) ? value.filter((x) => !e.choices.includes(x)) : [];
      return bad.length ? `${e.key}: unknown ${bad.length === 1 ? 'item' : 'items'} ${bad.join(', ')} (choose from: ${e.choices.join(', ')})` : null;
    }
    case 'object': return isPlainObject(value) ? null : `${e.key} must be a JSON object`;
    default: return `${e.key} has an unknown type`;
  }
}

/**
 * A daily cap from config (D10): 0 means no spend; only a missing, empty or non-numeric value takes the default.
 * `Number(v) || d` turned a 0 back into the default for the codex, reasoner, semantic graph and cross-review caps.
 */
function dayCap(v, d) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : d;
}

module.exports = { SECTIONS, SETTINGS, SPEND_FAMILIES, PICKS, UNITS, CLAUDE_MODELS, CODEX_MODELS, LOCAL_MODELS, LOCAL_EMBEDDERS, DEFAULTS, entry, isPrefix, defaultOf, getPath, leafKeys, parseValue, validate, dayCap, isPlainObject };
