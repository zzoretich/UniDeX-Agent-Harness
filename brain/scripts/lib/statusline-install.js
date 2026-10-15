'use strict';
/**
 * statusline-install.js — puts the AgenticOS status line into each host's own config and takes it out again (spec
 * 2026-09-28-statusline-design D1, D2, D7, D8, D9). Only `aos statusline install` calls it; `init` never does.
 *
 *   Claude Code  user-scope settings.json: `statusLine` (+ `subagentStatusLine`) run the vendored launcher. The value
 *                found there is recorded and chained (D2), and uninstall puts it back.
 *   Codex        config.toml: `[tui] status_line = [<built-in items>]` (Codex runs no status line command, D7). An
 *                existing status_line is never replaced without --force; uninstall removes only our unchanged line.
 *
 * Install state is machine-local, in agenticos-statusline.json beside agenticos.json — never under `hosts`, which would
 * change what enabledHosts() reports. Each host file is copied once to <file>.aos-statusline.bak before the first
 * write; a clean uninstall deletes that copy again, and one that found the file changed keeps it. Under AOS_HEADLESS=1
 * nothing is written: a host's config is the user's to change.
 */
const fs = require('fs');
const path = require('path');
const H = require('./host.js');
const CW = require('./config-write.js');
const S = require('./settings-schema.js');
const fsx = require('./fsx.js');

const SCHEMA = 1;
const MARK = '# agenticos statusline';
const BAK = '.aos-statusline.bak';
const DEFAULT_ITEMS = ['model-with-reasoning', 'task-progress', 'project-name', 'git-branch', 'context-used', 'five-hour-limit', 'weekly-limit'];
const ITEM_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** A request that is well formed but that the host's config or the run's mode refuses (exit 1). */
class Refusal extends Error {}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const launcherOf = (vault) => path.join(vault, 'brain', 'scripts', 'bin', 'aos');
const commandFor = (vault, verb) => `sh ${shq(launcherOf(vault))} statusline ${verb}`;
/** True for a command this module wrote (for any vault): the vendored launcher running `statusline <verb>`. */
function isOurs(command, verb) {
  return typeof command === 'string' && new RegExp(`brain/scripts/bin/aos'?\\s+statusline\\s+${verb}\\s*$`).test(command);
}

function statePath(userConfigFile) { return path.join(path.dirname(userConfigFile), 'agenticos-statusline.json'); }
function readState(userConfigFile) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(userConfigFile), 'utf8'));
    if (isPlainObject(s) && s.schema === SCHEMA) return s;
  } catch { /* none yet */ }
  return { schema: SCHEMA };
}
function writeState(userConfigFile, state) {
  const keep = Object.keys(state).filter((k) => k !== 'schema');
  if (!keep.length) { try { fs.unlinkSync(statePath(userConfigFile)); } catch { /* already gone */ } return; }
  fsx.writeAtomic(statePath(userConfigFile), `${JSON.stringify(state, null, 2)}\n`);
}

function claudeSettingsFile({ userCfg = null, env = process.env } = {}) {
  return path.join(path.resolve((userCfg && userCfg.claudeConfigDir) || H.claudeConfigDir(env)), 'settings.json');
}
function codexConfigFile({ userCfg = null, env = process.env } = {}) { return path.join(H.codexHome(env, userCfg), 'config.toml'); }

/** The hosts an install targets: --host, else every enabled host, else Claude Code (a config with no hosts block). */
function targetHosts(userCfg, host = null) {
  if (host) {
    if (!H.HOSTS.includes(host)) throw new Refusal(`unknown host "${host}" (claude or codex)`);
    return [host];
  }
  const on = H.enabledHosts(userCfg);
  if (on.length) return on;
  // SL-R08: only a config that predates the hosts block means Claude Code; one that enables no host means none.
  if (userCfg && isPlainObject(userCfg.hosts)) throw new Refusal('agenticos.json enables no host; add one first (aos hosts add claude|codex)');
  return ['claude'];
}

function settingsOf(cfg) {
  const s = (cfg && cfg.statusline) || {};
  const items = Array.isArray(s.codexItems) ? s.codexItems : [];
  return {
    refreshSeconds: Number.isInteger(s.refreshSeconds) && s.refreshSeconds >= 1 ? s.refreshSeconds : 5,
    subagents: s.subagents !== false,
    codexItems: items.length ? items : DEFAULT_ITEMS,
  };
}
/** SL-R06: Codex drops an item it does not know with a warning, so an unknown one is refused before anything is written. */
function checkCodexItems(items) {
  const known = (S.entry('statusline.codexItems') || {}).choices || [];
  const bad = items.filter((i) => typeof i !== 'string' || !ITEM_RE.test(i) || (known.length && !known.includes(i)));
  if (bad.length) throw new Refusal(`statusline.codexItems names ${bad.join(', ')}, which Codex does not show; choose from: ${known.join(', ')}`);
  return items;
}

function backupOnce(file) {
  if (!fs.existsSync(file) || fs.existsSync(file + BAK)) return;
  fs.copyFileSync(file, file + BAK);
}
function dropBackup(file) { try { fs.unlinkSync(file + BAK); } catch { /* never made */ } }
function guardHeadless(env) {
  if (env && env.AOS_HEADLESS === '1') throw new Refusal("a host's status line is the user's to change, and a headless run cannot change it");
}

// ── Claude Code ──

const serialize = (s) => `${JSON.stringify(s, null, 2)}\n`;
const readRaw = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
/** Raised when settings.json changed between our read and our write (SL-R01). */
class Changed extends Error {}
const MAX_TRIES = 3;
/** SL-R01: replace (or remove, for data null) settings.json only while it still holds the bytes we read; Claude Code's
 *  own writes (/config, /statusline) between the two are re-merged by the caller instead of lost. */
function replaceIfUnchanged(ctx, file, raw, data) {
  if (typeof ctx.onBeforeReplace === 'function') ctx.onBeforeReplace(file); // test seam: a write racing ours
  if (readRaw(file) !== raw) throw new Changed(file);
  if (data === null) fs.unlinkSync(file); else fsx.writeAtomic(file, data);
}
/** Run fn(raw, settings) until it lands on an unchanged file, at most MAX_TRIES times. */
function withSettings(ctx, file, fn) {
  for (let i = 0; ; i++) {
    const raw = readRaw(file);
    let settings = {};
    if (raw !== null) {
      try { settings = JSON.parse(raw); } catch (e) { throw new Refusal(`${file} is not valid JSON; fix it first (${e.message})`); }
      if (!isPlainObject(settings)) throw new Refusal(`${file} is not a JSON object`);
    }
    try { return fn(raw, settings); } catch (e) {
      if (!(e instanceof Changed) || i + 1 >= MAX_TRIES) {
        if (e instanceof Changed) throw new Refusal(`${file} kept changing while the status line was being written; try again`);
        throw e;
      }
    }
  }
}

/** SL-02: an entry is ours only when it runs a command we recorded (or this vault's own, when the record is gone); another
 *  vault's launcher is someone else's line. */
const mine = (entry, ...commands) => !!entry && typeof entry.command === 'string' && commands.filter(Boolean).includes(entry.command);
/** JSON with object keys sorted: two settings objects that differ only in key order compare equal. */
const canonical = (v) => JSON.stringify(v, (k, x) => (isPlainObject(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/** SL-04: the record goes first and is rolled back if the host file cannot be written, so an interrupted install never
 *  leaves a host running a line that nothing can undo. */
function commit(ctx, next, before, writeHost) {
  writeState(ctx.userConfigFile, next);
  try { writeHost(); } catch (e) { writeState(ctx.userConfigFile, before); throw e; }
}

function installClaude(ctx, { chainOutput = false } = {}) {
  const file = claudeSettingsFile(ctx);
  if (!fs.existsSync(path.dirname(file))) return { host: 'claude', ok: false, skipped: true, message: `no Claude Code config folder at ${path.dirname(file)}` };
  const opts = settingsOf(ctx.cfg);
  const command = commandFor(ctx.vault, 'render');
  const subCommand = commandFor(ctx.vault, 'subagents');
  return withSettings(ctx, file, (raw, settings) => {
    const before = readState(ctx.userConfigFile);
    const was = before.claude || null;
    const cur = settings.statusLine;
    const curSub = settings.subagentStatusLine;
    const curMine = mine(cur, was && was.command, command);
    const curSubMine = mine(curSub, was && was.subagentCommand, subCommand);
    // D9: re-installing over our own line keeps what we first chained; a slot someone else took chains the newcomer.
    const previous = curMine ? (was ? was.previous : null) : (cur === undefined ? null : cur);
    const previousSubagent = curSubMine ? (was ? was.previousSubagent : null) : (curSub === undefined ? null : curSub);
    settings.statusLine = { type: 'command', command, padding: 0, refreshInterval: opts.refreshSeconds, hideVimModeIndicator: true };
    if (opts.subagents) settings.subagentStatusLine = { type: 'command', command: subCommand };
    else if (curSubMine) { if (previousSubagent) settings.subagentStatusLine = previousSubagent; else delete settings.subagentStatusLine; }
    const next = {
      ...before,
      claude: {
        installedAt: (ctx.now || new Date()).toISOString(), command, subagentCommand: opts.subagents ? subCommand : null,
        previous, previousSubagent: opts.subagents ? previousSubagent : null, chainOutput: !!chainOutput,
        createdFile: was ? !!was.createdFile : raw === null,
      },
    };
    backupOnce(file);
    commit(ctx, next, before, () => replaceIfUnchanged(ctx, file, raw, serialize(settings)));
    const chained = previous && typeof previous.command === 'string' && previous.command !== command ? previous.command : null;
    return { host: 'claude', ok: true, file, chained, retook: !!(was && cur && !curMine) };
  });
}

function uninstallClaude(ctx) {
  const state = readState(ctx.userConfigFile);
  const was = state.claude;
  if (!was) return { host: 'claude', ok: true, skipped: true, message: 'not installed' };
  const file = claudeSettingsFile(ctx);
  const notes = [];
  if (fs.existsSync(file)) {
    withSettings(ctx, file, (raw, settings) => {
      notes.length = 0;
      let changed = false;
      for (const [key, own, prev] of [['statusLine', was.command, was.previous], ['subagentStatusLine', was.subagentCommand, was.previousSubagent]]) {
        const cur = settings[key];
        if (mine(cur, own)) {
          if (prev) settings[key] = prev; else delete settings[key];
          changed = true;
        } else if (cur && key === 'statusLine') notes.push(`the status line is now ${cur.command}; left as it is`);
      }
      if (!changed) return;
      // SL-05: when the result is what the file held before install, put back its exact bytes, not a re-serialization.
      let bak = null;
      try { bak = CW.readStrict(file + BAK); } catch { bak = null; }
      if (bak !== null && canonical(bak) === canonical(settings)) replaceIfUnchanged(ctx, file, raw, fs.readFileSync(file + BAK));
      else if (was.createdFile && !Object.keys(settings).length) replaceIfUnchanged(ctx, file, raw, null);
      else replaceIfUnchanged(ctx, file, raw, serialize(settings));
    });
    if (!notes.length) dropBackup(file);
  }
  delete state.claude;
  writeState(ctx.userConfigFile, state);
  return { host: 'claude', ok: true, file, restored: was.previous && was.previous.command ? was.previous.command : null, notes };
}

// ── Codex (config.toml, line-based: no TOML library, D7) ──

const HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const unquote = (s) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
const tableName = (raw) => raw.split('.').map(unquote).join('.');

/** The last line of the value that starts on line i (brackets counted outside strings and comments). */
function valueEnd(lines, i) {
  let depth = 0;
  let started = false;
  for (let j = i; j < lines.length; j++) {
    const s = j === i ? lines[j].slice(lines[j].indexOf('=') + 1) : lines[j];
    let quote = null;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (quote) { if (ch === '\\' && quote === '"') k++; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '#') break;
      if (ch === '[') { depth++; started = true; } else if (ch === ']') depth--;
    }
    if (!started || depth <= 0) return j;
  }
  return lines.length - 1;
}

/** Where tui.status_line lives (or could) in a config.toml. */
function scanToml(text) {
  const lines = text.split('\n');
  let table = '';
  const out = { lines, tui: null, key: null, inlineTui: false, lastTopDotted: -1, firstHeader: -1 };
  for (let i = 0; i < lines.length; i++) {
    const h = HEADER_RE.exec(lines[i]);
    if (h && !/=/.test(lines[i].split('#')[0])) {
      if (out.firstHeader < 0) out.firstHeader = i;
      if (out.tui && out.tui.end === null) out.tui.end = i;
      const arrayOfTables = lines[i].trim().startsWith('[[');
      table = arrayOfTables ? `[[${tableName(h[1])}]]` : tableName(h[1]);
      if (table === 'tui') out.tui = { start: i, end: null };
      continue;
    }
    if (table === '') {
      if (/^\s*"?tui"?\s*=\s*\{/.test(lines[i])) out.inlineTui = true;
      if (/^\s*"?tui"?\s*\./.test(lines[i])) out.lastTopDotted = i;
      if (/^\s*"?tui"?\s*\.\s*"?status_line"?\s*=/.test(lines[i])) out.key = { start: i, end: valueEnd(lines, i), dotted: true };
    } else if (table === 'tui' && /^\s*"?status_line"?\s*=/.test(lines[i])) {
      out.key = { start: i, end: valueEnd(lines, i), dotted: false };
    }
  }
  if (out.tui && out.tui.end === null) out.tui.end = lines.length;
  return out;
}

const ourLine = (items, dotted) => `${dotted ? 'tui.' : ''}status_line = [${items.map((i) => JSON.stringify(i)).join(', ')}]  ${MARK}`;

/** Pure: config.toml text with our status_line in it. The existing line is ours only when it is exactly `own`, the line
 *  recorded at install (SL-03); anything else, the marker comment included, is refused without `force`. */
function tomlInstall(text, items, { force = false, own = null } = {}) {
  const t = scanToml(text);
  if (t.inlineTui) throw new Refusal('config.toml sets `tui` as an inline table; add status_line there yourself, or run /statusline in Codex');
  const lines = t.lines.slice();
  if (t.key) {
    const found = lines.slice(t.key.start, t.key.end + 1).join('\n');
    const line = ourLine(items, t.key.dotted);
    if (own && found.trim() === String(own).trim()) {
      lines.splice(t.key.start, t.key.end - t.key.start + 1, line);
      return { text: lines.join('\n'), written: line, previous: undefined, createdTable: undefined };
    }
    if (!force) {
      const why = found.includes(MARK) ? 'changed since install' : 'is already set';
      throw new Refusal(`config.toml's tui.status_line ${why} (${found.replace(/\s+/g, ' ').trim()}); pass --force to replace it (uninstall puts it back)`);
    }
    lines.splice(t.key.start, t.key.end - t.key.start + 1, line);
    return { text: lines.join('\n'), written: line, previous: found, createdTable: false };
  }
  if (t.tui) {
    const line = ourLine(items, false);
    lines.splice(t.tui.start + 1, 0, line);
    return { text: lines.join('\n'), written: line, previous: null, createdTable: false };
  }
  if (t.lastTopDotted >= 0) {
    const line = ourLine(items, true);
    lines.splice(t.lastTopDotted + 1, 0, line);
    return { text: lines.join('\n'), written: line, previous: null, createdTable: false };
  }
  const line = ourLine(items, false);
  const body = text.replace(/\n*$/, '');
  return { text: `${body}${body ? '\n\n' : ''}[tui]\n${line}\n`, written: line, previous: null, createdTable: true };
}

/** Pure: config.toml text without our line (the previous value back in its place). `found` false when it changed. */
function tomlUninstall(text, rec) {
  // SL-R07: only the effective tui.status_line, and only when it is still exactly the line we wrote.
  const t = scanToml(text);
  if (!t.key) return { text, found: false };
  const lines = t.lines.slice();
  const span = t.key.end - t.key.start + 1;
  if (lines.slice(t.key.start, t.key.end + 1).join('\n').trim() !== String(rec.written || '').trim()) return { text, found: false };
  if (rec.previous) lines.splice(t.key.start, span, ...String(rec.previous).split('\n'));
  else lines.splice(t.key.start, span);
  if (rec.createdTable) {
    const h = lines.findIndex((l) => { const m = HEADER_RE.exec(l); return m && tableName(m[1]) === 'tui' && !l.trim().startsWith('[['); });
    if (h >= 0) {
      let j = h + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || HEADER_RE.test(lines[j])) lines.splice(h, j - h); // the header we added, now empty
    }
  }
  const out = lines.join('\n');
  return { text: out.trim() ? out : '', found: true };
}

/** Whether the effective tui.status_line in a config.toml is exactly the recorded line. */
function holdsLine(text, written) {
  const t = scanToml(String(text || ''));
  return !!t.key && t.lines.slice(t.key.start, t.key.end + 1).join('\n').trim() === String(written || '').trim();
}

function installCodex(ctx, { force = false } = {}) {
  const file = codexConfigFile(ctx);
  if (!fs.existsSync(path.dirname(file))) return { host: 'codex', ok: false, skipped: true, message: `no Codex home at ${path.dirname(file)}` };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const before = readState(ctx.userConfigFile);
  const was = before.codex || null;
  const r = tomlInstall(text, checkCodexItems(settingsOf(ctx.cfg).codexItems), { force, own: was && was.written });
  const next = {
    ...before,
    codex: {
      installedAt: (ctx.now || new Date()).toISOString(),
      written: r.written,
      previous: r.previous === undefined ? (was ? was.previous : null) : r.previous,
      createdTable: r.createdTable === undefined ? !!(was && was.createdTable) : r.createdTable,
    },
  };
  if (r.text !== text) backupOnce(file);
  commit(ctx, next, before, () => { if (r.text !== text) fsx.writeAtomic(file, r.text); });
  return { host: 'codex', ok: true, file, replaced: !!r.previous };
}

function uninstallCodex(ctx) {
  const state = readState(ctx.userConfigFile);
  const was = state.codex;
  if (!was) return { host: 'codex', ok: true, skipped: true, message: 'not installed' };
  const file = codexConfigFile(ctx);
  const notes = [];
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* gone: nothing to take out */ }
  if (text !== null) {
    const r = tomlUninstall(text, was);
    if (!r.found) notes.push('the status_line in config.toml changed since install; left as it is');
    else {
      if (r.text !== text) fsx.writeAtomic(file, r.text);
      dropBackup(file);
    }
  }
  delete state.codex;
  writeState(ctx.userConfigFile, state);
  return { host: 'codex', ok: true, file, notes };
}

// ── Verbs ──

function install(ctx, { host = null, force = false, chainOutput = false } = {}) {
  guardHeadless(ctx.env);
  return targetHosts(ctx.userCfg, host).map((h) => (h === 'claude' ? installClaude(ctx, { chainOutput }) : installCodex(ctx, { force })));
}

function uninstall(ctx, { host = null } = {}) {
  guardHeadless(ctx.env);
  const hosts = host ? targetHosts(ctx.userCfg, host) : H.HOSTS;
  return hosts.map((h) => (h === 'claude' ? uninstallClaude(ctx) : uninstallCodex(ctx)));
}

/** Per host: installed, whether our line still holds the slot, and what it chains. Read-only. */
function status(ctx) {
  const state = readState(ctx.userConfigFile);
  const out = {};
  const cfile = claudeSettingsFile(ctx);
  let current = null;
  try { const s = CW.readStrict(cfile); current = s && s.statusLine && typeof s.statusLine.command === 'string' ? s.statusLine.command : null; } catch { current = null; }
  // SL-R04: a project's .claude/settings.local.json or settings.json overrides the user's statusLine in that project.
  // The project folder is always `.claude` (CLAUDE_CONFIG_DIR moves only the user's config dir, which host.js resolves).
  let projectOverride = null;
  const cwd = ctx.cwd || process.cwd();
  for (const f of [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json')]) {
    if (path.resolve(f) === path.resolve(cfile)) continue;
    let p = null;
    try { p = CW.readStrict(f); } catch { p = null; }
    if (p && isPlainObject(p.statusLine) && typeof p.statusLine.command === 'string') { projectOverride = { file: f, command: p.statusLine.command }; break; }
  }
  out.claude = {
    projectOverride,
    installed: !!state.claude,
    ownsSlot: !!(state.claude && current && current === state.claude.command),
    current,
    chained: state.claude && state.claude.previous && typeof state.claude.previous.command === 'string' ? state.claude.previous.command : null,
    chainOutput: !!(state.claude && state.claude.chainOutput),
    subagents: !!(state.claude && state.claude.subagentCommand),
    file: cfile,
  };
  const xfile = codexConfigFile(ctx);
  let text = '';
  try { text = fs.readFileSync(xfile, 'utf8'); } catch { /* none */ }
  out.codex = {
    installed: !!state.codex,
    present: !!(state.codex && holdsLine(text, state.codex.written)),
    file: xfile,
  };
  return out;
}

/** After `aos upgrade`: point our own entries at this vault's launcher and current items. Never retakes a lost slot (D9). */
function reapply(ctx) {
  const state = readState(ctx.userConfigFile);
  const done = [];
  if (state.claude) {
    const file = claudeSettingsFile(ctx);
    const raw = readRaw(file);
    let settings = null;
    try { settings = raw === null ? null : JSON.parse(raw); } catch { settings = null; }
    if (isPlainObject(settings) && mine(settings.statusLine, state.claude.command)) {
      const next = { ...settings, statusLine: { ...settings.statusLine, command: commandFor(ctx.vault, 'render') } };
      const subOurs = mine(settings.subagentStatusLine, state.claude.subagentCommand);
      if (subOurs) next.subagentStatusLine = { ...settings.subagentStatusLine, command: commandFor(ctx.vault, 'subagents') };
      state.claude = { ...state.claude, command: next.statusLine.command, subagentCommand: subOurs ? next.subagentStatusLine.command : state.claude.subagentCommand };
      if (JSON.stringify(next) !== JSON.stringify(settings)) {
        try { replaceIfUnchanged(ctx, file, raw, serialize(next)); writeState(ctx.userConfigFile, state); done.push('claude'); } catch (e) { if (!(e instanceof Changed)) throw e; }
      }
    }
  }
  if (state.codex) {
    const file = codexConfigFile(ctx);
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    let items = null;
    try { items = checkCodexItems(settingsOf(ctx.cfg).codexItems); } catch { items = null; }
    if (text !== null && items && holdsLine(text, state.codex.written)) {
      const r = tomlInstall(text, items, { own: state.codex.written });
      state.codex = { ...state.codex, written: r.written };
      if (r.text !== text) { writeState(ctx.userConfigFile, state); fsx.writeAtomic(file, r.text); done.push('codex'); }
    }
  }
  if (state.claude || state.codex) writeState(ctx.userConfigFile, state);
  return done;
}

/** For the Claude session-start notice: the command now in our recorded slot, or null while we hold it (D9). */
function slotTakenBy(ctx) {
  const s = status(ctx).claude;
  return s.installed && !s.ownsSlot ? (s.current || '(none)') : null;
}

module.exports = {
  SCHEMA, MARK, DEFAULT_ITEMS, Refusal, isOurs, commandFor, statePath, readState, claudeSettingsFile, codexConfigFile,
  targetHosts, settingsOf, checkCodexItems, scanToml, holdsLine, tomlInstall, tomlUninstall, install, uninstall, status, reapply, slotTakenBy,
};
