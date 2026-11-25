#!/usr/bin/env node
'use strict';
/**
 * team.js — `aos team`: the one reader and writer of the vault's agent teams (spec 2026-09-28-agent-teams-design).
 * The store is lib/teams.js, a seat's run is lib/team-run.js, and the Workbench's Agent Teams tab calls this same file.
 *
 * Exit 0 on success, 1 when the team's state refuses the request (a pending gate, a stale --expect, a headless run
 * recording the user's decision), 2 on a usage error, 3 when a dispatched run failed, was killed or did not merge.
 * Every verb that names a team first records any run whose dispatcher died (teams.js reapKilledRuns).
 */
const fs = require('fs');
const path = require('path');
const T = require('./lib/teams.js');

const USAGE = `usage: aos team list [--json]
       aos team status|roster|board <team> [--json]
       aos team item <team> <id> [--json]
       aos team tail <team> [--item <id>] [-n 20] [--json]
       aos team post <team> --from <id> [--item <id>] [--kind <kind>] <text...>
       aos team put <team> --from <lead> [--expect '<json>'] '<patch json>'
       aos team dispatch <team> <member> <item> [--wave N[,M]] [--note <text>] [--provider claude|codex] [--max-usd N] [--timeout-min 120] [--dry-run | --detach]
       aos team merge <team> <item> <member> --from <lead>
       aos team wait <team> <item> <member> [--since <iso>] [--timeout-min 180] [--json]
       aos team gate approve|redirect <team> <item> --expect '<json>' [--usd N] [--note <text>]
       aos team budget <team> <item> <usd> --expect '<json>'
       aos team pause|resume <team> [<member>]
       aos team set <team> <member> provider|model|effort <preset>
       aos team member add <team> <agent>  ·  aos team member remove <team> <member>
       aos team init [<id>]
       aos team new <id> --name <text> --lead <agent> [--parent <team>]
`;
const BOOL = new Set(['json', 'dry-run', 'detach']);
const VALUE = new Set(['from', 'item', 'kind', 'expect', 'wave', 'note', 'provider', 'timeout-min', 'since', 'usd', 'max-usd', 'name', 'lead', 'parent']);

/** { flags, positional, pass } — `pass` is argv without --detach, for the detached run to repeat. */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const pass = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n') { flags.n = argv[++i]; pass.push(a, flags.n); continue; }
    if (!a.startsWith('--') || a === '--') { positional.push(a); pass.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) { flags[k] = true; if (k !== 'detach') pass.push(a); continue; }
    if (!VALUE.has(k)) throw new T.UsageError(`unknown flag --${k}`);
    const v = argv[i + 1];
    if (v === undefined) throw new T.UsageError(`--${k} needs a value`);
    i++;
    flags[k] = v;
    pass.push(a, v);
  }
  return { flags, positional, pass };
}

function table(rows) {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c] ?? '').length)));
  return rows.map((r) => r.map((v, c) => String(v ?? '').padEnd(w[c])).join('  ').trimEnd()).join('\n');
}

function templatesDir() {
  const cands = [path.join(__dirname, 'persona', 'templates', 'teams'), path.join(__dirname, '..', '..', 'vault-template', 'persona', 'teams')];
  return cands.find((d) => fs.existsSync(d)) || cands[0];
}

function hostDirs(env) {
  const host = require('./lib/host.js');
  let userCfg = null;
  try { userCfg = require('./lib/paths.js').readUserConfig(); } catch { /* none */ }
  return { claudeDir: host.claudeConfigDir(env), codexDir: host.codexHome(env, userCfg) };
}

function renderBoard(t) {
  const items = [...T.boardItems(t).values()];
  if (!items.length) return `(${t.id} board is empty)`;
  return table([['id', 'stage', 'owner', 'status', 'gate', 'budget', 'title'], ...items.map((i) => [
    i.id, i.stage, T.owners(i).join(','), i.status, i.gate ? `${i.gate.name}:${i.gate.state}` : '',
    i.budget ? `$${i.budget.spentUsd || 0}/$${i.budget.usd}${i.budget.codexRuns ? ` +${i.budget.codexRuns} codex` : ''}` : '', i.title || '',
  ])]);
}

function renderRoster(t) {
  const head = `${t.name || t.id} team · lead ${t.lead}${t.reportsTo ? ` · reports to ${t.reportsTo}` : ''}${t.disabled ? ' · DISABLED' : ''}`;
  const rows = t.members.map((m) => [m.id, m.role, m.provider, m.model, m.effort, [].concat(m.stage || []).join(','), m.paused ? 'paused' : '']);
  return `${head}\n${table([['id', 'role', 'provider', 'model', 'effort', 'stage', ''], ...rows])}`;
}

function statusOf(t) {
  return {
    schema: 1, team: t.id, name: t.name || t.id, lead: t.lead, reportsTo: t.reportsTo || null, parent: t.parent || null,
    disabled: t.disabled, stages: t.stages, gates: t.gates, state: T.readState(t), members: T.memberStatus(t),
    pendingGates: T.pendingGates(t).map((i) => ({ id: i.id, title: i.title || '', gate: i.gate.name, ts: i.ts, budget: i.budget || null })),
    live: T.liveMarkers(t).map((m) => ({ run: m.run, member: m.member, item: m.item, provider: m.provider, startedAt: m.startedAt })),
  };
}

function renderStatus(s) {
  const lines = [`${s.name} team · lead ${s.lead}${s.disabled ? ' · DISABLED' : ''}`, ...s.state.map((l) => `  ${l}`)];
  lines.push(table([['member', 'status', 'provider', 'item', 'last run'], ...s.members.map((m) => [
    `${m.id}${m.lead ? ' (lead)' : ''}`, m.status, m.provider || '', m.item || '',
    m.lastRun ? `${m.lastRun.status} ${m.lastRun.usd == null ? '' : `$${Number(m.lastRun.usd).toFixed(2)}`}`.trim() : '',
  ])]));
  if (s.pendingGates.length) lines.push(...s.pendingGates.map((g) => `gate pending: ${g.id} ${g.gate}${g.title ? ` (${g.title})` : ''}`));
  if (s.live.length) lines.push(...s.live.map((m) => `running: ${m.member} on ${m.item} via ${m.provider} since ${m.startedAt}`));
  return lines.join('\n');
}

/** → exit code. Every dependency is injectable so tests run in-process. */
async function main(argv, {
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
  vault = null,
  cfg = null,
  env = process.env,
  dirs = null,
  platform = process.platform,
} = {}) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { stderr(`team: ${e.message}\n${USAGE}`); return 2; }
  const { flags, positional, pass } = parsed;
  const [verb, ...rest] = positional;
  const say = (s) => stdout(`${s}\n`);
  const json = (o) => stdout(`${JSON.stringify(o, null, 2)}\n`);
  try {
    const v = vault || require('./lib/paths.js').VAULT;
    const root = T.teamsRoot(v);
    const team = (id) => {
      const t = T.readTeam(root, id);
      for (const k of T.reapKilledRuns(t)) stderr(`team: found a killed run: ${k.member} on ${k.item} (${k.run}); recorded it and posted a blocker\n`);
      return t;
    };
    const need = (n, what) => { if (rest.length < n) throw new T.UsageError(`${verb} needs ${what}`); };
    switch (verb) {
      case undefined:
      case 'list': {
        // One unreadable TEAM.md is a row with its error, not a failed list: the Agent Teams tab sweeps through this verb.
        const rows = T.listTeams(root).map((id) => {
          let t;
          try { t = team(id); } catch (e) { return { schema: 1, team: id, error: e.message }; }
          return { ...statusOf(t), open: [...T.boardItems(t).values()].filter((i) => i.status !== 'done').length };
        });
        // The presets `set` accepts, so a picker offers exactly those (D4: no free text), and which models each provider
        // runs: a seat on one provider ignores the other's model (team-run.js modelFor).
        const S = require('./lib/settings-schema.js');
        const presets = { ...Object.fromEntries(T.SET_KEYS.map((k) => [k, T.presetsFor(k)])), models: { claude: S.CLAUDE_MODELS, codex: S.CODEX_MODELS } };
        if (flags.json) { json({ schema: 1, teams: rows, presets }); return 0; }
        if (!rows.length) { say('No teams yet. `aos team init` seeds an example team in persona/teams/example/.'); return 0; }
        say(table([['team', 'lead', 'members', 'open', 'gates', ''], ...rows.map((r) => (r.error
          ? [r.team, '', '', '', '', `unreadable: ${r.error}`]
          : [r.team, r.lead, r.members.length, r.open, r.pendingGates.length, r.disabled ? 'DISABLED' : '']))]));
        return 0;
      }
      case 'status': { need(1, '<team>'); const s = statusOf(team(rest[0])); if (flags.json) json(s); else say(renderStatus(s)); return 0; }
      case 'roster': { need(1, '<team>'); const t = team(rest[0]); if (flags.json) json({ schema: 1, id: t.id, lead: t.lead, disabled: t.disabled, members: t.members }); else say(renderRoster(t)); return 0; }
      case 'board': { need(1, '<team>'); const t = team(rest[0]); if (flags.json) json([...T.boardItems(t).values()]); else say(renderBoard(t)); return 0; }
      case 'item': {
        need(2, '<team> <id>');
        const it = T.boardItems(team(rest[0])).get(rest[1]);
        if (!it) throw new T.Refusal(`no board item ${rest[1]} on ${rest[0]}`);
        json(it);
        return 0;
      }
      case 'tail': {
        need(1, '<team>');
        const n = Number(flags.n);
        const rows = T.tail(team(rest[0]), { n: Number.isFinite(n) && n > 0 ? n : 20, item: flags.item });
        if (flags.json) { for (const r of rows) stdout(`${JSON.stringify(r)}\n`); return 0; }
        say(rows.length ? rows.map((r) => `${String(r.ts).slice(0, 16).replace('T', ' ')}  ${r.from} [${r.kind}]${r.item ? ` ${r.item}` : ''}: ${r.text}`).join('\n') : flags.item ? `(no posts on ${flags.item})` : '(the channel is empty)');
        return 0;
      }
      case 'post': {
        need(2, '<team> <text>');
        const r = T.post(team(rest[0]), { from: flags.from, item: flags.item, kind: flags.kind || 'note', text: rest.slice(1).join(' ') });
        say(`posted ${r.kind} as ${r.from}${r.item ? ` on ${r.item}` : ''}`);
        return 0;
      }
      case 'put': {
        need(2, '<team> <patch json>');
        const t = team(rest[0]);
        const existed = T.boardItems(t).has((() => { try { return JSON.parse(rest[1]).id; } catch { return null; } })());
        const row = T.put(t, { from: flags.from, json: rest[1], expect: flags.expect });
        say(`${existed ? 'updated' : 'created'} ${row.id}: ${row.stage}/${row.status}${T.owners(row).length ? ` → ${T.owners(row).join(', ')}` : ''}`);
        return 0;
      }
      case 'dispatch': {
        need(3, '<team> <member> <item>');
        if (flags['dry-run'] && flags.detach) throw new T.UsageError('--dry-run and --detach do not mix');
        if (flags.wave && !/^\d+(,\d+)*$/.test(flags.wave)) throw new T.UsageError('--wave takes N or N,M');
        const TR = require('./lib/team-run.js');
        const c = cfg || require('./lib/config.js').loadConfig();
        const r = await TR.dispatch({
          team: rest[0], member: rest[1], item: rest[2], waves: flags.wave, note: flags.note, provider: flags.provider,
          timeoutMin: flags['timeout-min'], maxUsd: flags['max-usd'], dryRun: !!flags['dry-run'], detach: !!flags.detach, args: pass.slice(1),
        }, { vault: v, cfg: c, env, stderr, platform, ...(dirs || hostDirs(env)) });
        if (r.out) say(r.out);
        return r.code;
      }
      case 'merge': {
        need(3, '<team> <item> <member>');
        team(rest[0]);
        const r = require('./lib/team-run.js').mergeSeat({ team: rest[0], item: rest[1], member: rest[2], from: flags.from }, { vault: v, env });
        say(r.out);
        return r.code;
      }
      case 'wait': {
        need(3, '<team> <item> <member>');
        const r = T.waitForRun(team(rest[0]), { item: rest[1], member: rest[2], since: flags.since, timeoutMin: flags['timeout-min'] || 180 });
        if (r.code !== 0) { stderr(`team: ${r.err}\n`); return 1; }
        if (flags.json) json(r.row); else say(`run ended: ${T.runLine(r.row)}`);
        return r.row.status === 'ok' ? 0 : 3; // failed, killed or blocked: the lead has a blocker to read (AT-07)
      }
      case 'gate': {
        need(3, 'approve|redirect <team> <item>');
        const row = T.decideGate(team(rest[1]), { item: rest[2], verb: rest[0], usd: flags.usd, note: flags.note, expect: flags.expect, env });
        if (flags.json) json(row); else say(`${row.gate.name} gate ${row.gate.state} on ${row.id}: now ${row.stage}/${row.status} with ${T.owners(row).join(', ')}`);
        return 0;
      }
      case 'budget': {
        need(3, '<team> <item> <usd>');
        const row = T.setBudget(team(rest[0]), { item: rest[1], usd: rest[2], expect: flags.expect, env });
        if (flags.json) json(row); else say(`${row.id}'s budget is now $${row.budget.usd} (spent $${row.budget.spentUsd || 0})`);
        return 0;
      }
      case 'pause':
      case 'resume': {
        need(1, '<team> [<member>]');
        const r = T.setPaused(team(rest[0]), { memberId: rest[1], paused: verb === 'pause', env });
        say(`${r.member ? `${r.member} on ${r.team}` : `team ${r.team}`} ${r.paused ? 'paused' : 'resumed'}`);
        return 0;
      }
      case 'set': {
        need(4, '<team> <member> provider|model|effort <preset>');
        const r = T.setMember(team(rest[0]), { memberId: rest[1], key: rest[2], value: rest[3], env });
        say(`${r.member} on ${r.team}: ${r.key} is now ${r.value}`);
        return 0;
      }
      case 'member': {
        need(3, 'add|remove <team> <agent|member>');
        const t = team(rest[1]);
        if (rest[0] === 'add') { const r = T.addMember(t, { agent: rest[2], env, ...(dirs || hostDirs(env)) }); say(`added ${r.member} (agent ${r.agent}) to ${r.team}`); return 0; }
        if (rest[0] === 'remove') { T.removeMember(t, { memberId: rest[2], env }); say(`removed ${rest[2]} from ${t.id}`); return 0; }
        throw new T.UsageError('member takes add or remove');
      }
      case 'init': {
        const r = T.initTeam(root, { templatesDir: templatesDir(), id: rest[0] || 'example' });
        say(`seeded persona/teams/${r.team}/ from the example team; edit its TEAM.md to point each member at one of your agents`);
        return 0;
      }
      case 'new': {
        need(1, '<id> --name <text> --lead <agent>');
        if (!flags.name || !flags.lead) throw new T.UsageError('new needs --name and --lead');
        const r = T.newTeam(root, { id: rest[0], name: flags.name, lead: flags.lead, parent: flags.parent || null, templatesDir: templatesDir(), env, ...(dirs || hostDirs(env)) });
        say(`created persona/teams/${r.team}/ with ${r.member} (agent ${r.agent}) as its lead`);
        return 0;
      }
      default:
        throw new T.UsageError(`unknown verb ${verb}`);
    }
  } catch (e) {
    if (e instanceof T.UsageError) { stderr(`team: ${e.message}\n${USAGE}`); return 2; }
    if (e instanceof T.Refusal) { stderr(`team: refused: ${e.message}\n`); return 1; }
    stderr(`team: ${e.message}\n`);
    return verb === 'dispatch' ? 3 : 1;
  }
}

if (require.main === module) {
  // A closing terminal must not turn the last summary line into a crash after the run's trace is already written.
  for (const s of [process.stdout, process.stderr]) s.on('error', () => {});
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { main, parseArgs, USAGE };
