'use strict';
/**
 * mcp.js — the vault's view of both hosts' MCP servers and connectors.
 *
 * `aos mcp list [--json]` (connectors-tab D8, D15): every MCP server and connector each enabled host can use, read from
 *   files alone (brain/scripts/lib/connectors/discover.js), with each one's use in the last connectors.usageDays from
 *   both hosts' transcripts; writes brain/_index/connectors.json, connectors-usage.json and mcp-servers.json, as every
 *   scan-vault does. Starts nothing.
 * `aos mcp check [--json]` (D10, D11): the live check (lib/connectors/check.js): `claude mcp list`, `codex mcp list
 *   --json`, and the runtime's own MCP client listing each server's tools, for the servers each host would start
 *   itself; writes brain/_index/connectors-live.json, then lists again. One check at a time: a second is refused.
 *
 * `aos mcp copy <name> --to claude|codex [--dry-run] [--expect <hash>] [--json]`: make one MCP server of one
 * host available on the other, per item and on request (install-import B6; the Workbench's Connectors sheet runs it on a
 * click, connectors-tab D20).
 *
 *   1. The server's full config is read at run time from the SOURCE host's own file, never from the vault's listing
 *      (brain/_index/mcp-servers.json keeps the program alone): Claude Code's user-scope `mcpServers` in .claude.json
 *      (lib/import/mcp.js claudeUserFile), or Codex's config.toml, where lib/import/mcp.js codexServerMap reads every
 *      form a server may take. A Codex server declared by dotted keys (whose values are not read) or in more than one
 *      form is refused as a source, and any form counts as "already there" as a target, so `codex mcp add` never
 *      overwrites one. A server turned off on its host is refused: neither CLI's add takes an off state.
 *   2. The target command is the host's own CLI: `claude mcp add-json --scope user <name> <json>`, or
 *      `codex mcp add <name> [--env K=V]… -- <command> [args…]` (the form cli/codex-host.js mcpAddArgs uses) for a
 *      stdio server and `codex mcp add <name> --url <url> [--bearer-token-env-var VAR]` for a remote one (D20: Codex's
 *      `--url` takes a streamable HTTP server, so an SSE one is refused). What the target cannot express (a working
 *      folder, timeouts, Codex's env_vars, tool filters, dotted keys, a header Codex's `mcp add` has no flag for) is
 *      named in `dropped`; a header refused that way comes with a `note` naming bearer_token_env_var, Codex's one way to
 *      send a token. An environment value that is a variable reference (`${VAR}`, which Claude Code expands, A2) goes
 *      to Codex as connectors-tab A1 has it: not as a value, but as the one `env_vars = [...]` line to paste (`paste`,
 *      `pasteFile`, `pasteUnder`), since `codex mcp add` takes values only.
 *   3. `--dry-run` writes nothing in the vault or a host's config (it makes this install's key once, below). It prints
 *      that command with these hidden: every environment and header value (one that only names a variable, `${VAR}`,
 *      shows as written: it is a name, not a value); in a URL, its credentials, every query value
 *      and a token-like path segment (lib/import/mcp.js maskUrl); the argument after a flag whose name has a secret word
 *      (lib/import/mcp.js secretName: token, secret, pass, password, key, auth, credential, cookie, session, … as whole
 *      words of the name; `--name` or `-name`), or after `-p`, `-k`, `-t`, whatever that argument starts with; the value
 *      of such a `--name=` or `KEY=`; a `-H`/`--header` value (`--header=` too) and an `Authorization:`-style argument;
 *      inside a JSON argument, every secret-named key's value, every token-like string, and a list of strings read as
 *      arguments by these rules; an argument with blanks or quotes (`sh -c "…"`, a command such as `env KEY=… node`)
 *      split into words as a shell would and each word read by these rules, or hidden whole when its quotes do not
 *      close; and any value, or `:`/`=`-separated part of one, that looks like a token (tokenLike: a known prefix, 32+
 *      hex digits or lowercase letters and digits, or 20+ characters of mixed-case base64). The command is read the
 *      same way. That is recognition by name and shape: a secret that has neither (a short lowercase password after a
 *      flag named otherwise) is shown as written. The dry run also prints `expect`, an HMAC-SHA256 under this install's
 *      own key (~/.local/share/unidex/keys/mcp-plan.key, 0600) of the source entry and the exact target command; the
 *      Workbench shows the dry run, and its confirm runs the copy with `--expect <hash>`, which is refused when either
 *      changed since.
 *   4. A real run holds a lock per target host (two writes never rewrite one config at once), checks again, backs the
 *      target's config file up OUTSIDE the vault (~/.local/share/unidex/backups/mcp/: each component a real folder this
 *      user owns, never a link; the folder 0700, files 0600, created exclusively with a millisecond stamp, the newest 10
 *      per host kept: each holds every server's secrets, and the Workbench's page never reads that folder), runs the
 *      command, checks the target lists the server, and lists both hosts again into mcp-servers.json. A failing CLI's
 *      own output is shown with every value hidden above replaced, as written and JSON-escaped (one or two characters
 *      long: only as a whole word).
 *   Refused, writing nothing: a name either CLI would reject (letters, digits, `-` and `_` only), the vault's own
 *   `agenticos` server, a server the source does not declare (or declares in a form not read) or the target already
 *   has, one turned off, a target host that is off in agenticos.json (`aos hosts add <host>`), a target CLI that is not
 *   installed, a stale `--expect`, and a copy to a host another write holds.
 *
 * The other writes (connectors-tab D16–D18, A1, A2), each the same dry run → hash → `--expect` run under the same lock
 * per host, the host's config file backed up first, written only through that host's own CLI, then listed again
 * (lib/connectors/index.js refresh: connectors.json, connectors-usage.json and mcp-servers.json):
 *
 * `aos mcp park <name> --host claude|codex [--dry-run] [--expect <hash>] [--json]` (D16): a user-scope server off its
 *   host, its exact entry kept. The entry as the host's file holds it (secrets included) is saved to
 *   ~/.local/share/unidex/parked/mcp/<host>-<name>.json (0600, created exclusively; the folders 0700 and real folders of
 *   this user's, ownDir; outside the vault, and denied to the Workbench's page by name), then `claude mcp remove <name>
 *   --scope user` or `codex mcp remove <name>` runs; a failing remove deletes the stash again. Only an entry that unpark
 *   can put back as it is gets parked: Claude Code's keys type (stdio, http or sse), command, args, env, url and
 *   headers; Codex's command, args, env, url, bearer_token_env_var and env_vars (the last as A1's paste line on Turn
 *   on). Refused besides: a server turned off, one already parked, and a row that is not the user's own (D17): a Claude
 *   Code plugin's server (`claude plugin disable <plugin>`, which turns off its skills too), a Codex plugin's (Codex's
 *   plugin settings: it has no CLI verb), a connector (claude.ai's or ChatGPT's connector settings), a project's.
 * `aos mcp unpark <name> --host claude|codex [...]`: the stash put back through the command copy uses
 *   (`claude mcp add-json --scope user` with the entry as it was; `codex mcp add`), refused when the host already has
 *   that name. The stash is deleted only once the host lists the server again.
 * `aos mcp remove <name> --host claude|codex [...]`: park's checks and remove, with no stash (the backup is kept).
 * `aos mcp add <name> --to claude|codex|both (--command <cmd> [--arg <a>]… | --url <url> [--bearer-env '$VAR'])
 *   [--env 'KEY=$VAR']… [...]` (D18): a new user-scope server, from names alone. A secret is never a value here:
 *   every `--env` is `KEY=$VAR` and `--bearer-env` is `$VAR` (one that is not, a value the shell put in, is refused).
 *   Claude Code gets `add-json` with `"env": {"KEY": "${VAR}"}` and, for a remote server, `"headers":
 *   {"Authorization": "Bearer ${VAR}"}`, which it expands at start (A2: checked with Claude Code 2.1.310); Codex gets
 *   `codex mcp add <name> --url <url> [--bearer-token-env-var VAR]`, or for a command `codex mcp add <name> -- <cmd>
 *   <args>` with no environment and, in the report, the one `env_vars = ["KEY", …]` line to paste under
 *   [mcp_servers.<name>] (A1: Codex then passes each to the server, by that name, from its own environment). Refused:
 *   a name either CLI rejects, the vault's own, a name a target already has or keeps parked, a target host that is off.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOSTS = ['claude', 'codex'];
const HOST_LABEL = { claude: 'Claude Code', codex: 'Codex' };
const USAGE = [
  'aos mcp list [--json]', 'aos mcp check [--json]',
  'aos mcp copy <name> --to claude|codex [--dry-run] [--expect <hash>] [--json]',
  'aos mcp park|unpark|remove <name> --host claude|codex [--dry-run] [--expect <hash>] [--json]',
  "aos mcp add <name> --to claude|codex|both (--command <cmd> [--arg <a>]… | --url <url> [--bearer-env '$VAR']) [--env 'KEY=$VAR']… [--dry-run] [--expect <hash>] [--json]",
].join(' | ');
/** What both CLIs accept as a server name (and the Workbench's surface rule), at most 64 characters. */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A variable's name as `aos mcp add` takes it (`$VAR`): never a value (connectors-tab D18). */
const VAR_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
/** A value that only names a variable, as Claude Code expands it (`${VAR}`, `Bearer ${VAR}`, A2): a name, not a secret. */
const VAR_REF = /^(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const OWN = 'agenticos';
const KEEP_BACKUPS = 10;
const RUN_TIMEOUT_MS = 60 * 1000;
const LOCK_TIMEOUT_MS = 10 * 1000;
const HIDDEN = '<redacted>';
/** Short flags whose value is taken as a secret (-p a password, -k a key, -t a token): hiding a port too is the price. */
const SECRET_SHORT = new Set(['-p', '-P', '-k', '-K', '-t', '-T']);
const HEADER_FLAGS = new Set(['-H', '--header', '--headers', '--http-header']);
/** `Name: value`, as a header is written in an argument. */
const HEADER_ARG = /^([A-Za-z0-9-]+)\s*:\s*(\S[\s\S]*)$/;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i;
/** Keys each host's entry may carry that the copy itself handles. */
const CARRIED = {
  claude: new Set(['type', 'transport', 'command', 'args', 'env', 'url', 'headers', 'disabled', 'enabled']),
  codex: new Set(['command', 'args', 'env', 'url', 'bearer_token_env_var', 'enabled', 'type', 'transport']),
};
/** Keys an entry may hold for park to put it back as it is (unpark goes through the same CLI as copy). Codex's env_vars
 *  comes back as A1's paste line: `codex mcp add` takes no variable names. */
const RESTORABLE = {
  claude: new Set(['type', 'command', 'args', 'env', 'url', 'headers']),
  codex: new Set(['command', 'args', 'env', 'url', 'bearer_token_env_var', 'env_vars', 'enabled']),
};
const WRITE_VERBS = ['copy', 'park', 'unpark', 'remove', 'add'];

class UsageError extends Error {}
class Refused extends Error {}

function resolveScript(rel) {
  for (const p of [path.join(__dirname, '..', rel), path.join(__dirname, '..', 'brain', 'scripts', rel)]) if (fs.existsSync(p)) return p;
  throw new Error(`${rel} not found beside cli/mcp.js — run \`aos upgrade\``);
}
function lib() { return require(resolveScript('lib/import/mcp.js')); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' && v.trim() ? v : null; }
function tilde(p, home) { return home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p; }

const VALUE_FLAGS = new Set(['to', 'host', 'expect', 'command', 'url', 'bearer-env']);
const LIST_FLAGS = new Set(['arg', 'env']);
const FLAG_KEY = { to: 'to', host: 'host', expect: 'expect', command: 'command', url: 'url', 'bearer-env': 'bearerEnv' };

/**
 * The words and flags after `aos mcp` (USAGE). `--arg` and `--env` repeat; every other flag is given once. A value flag
 * takes the next argument whatever it is (`--arg -y`), or the part after `=`. Neither `--env` nor `--bearer-env` echoes
 * what it was given when it refuses it: a value the shell expanded there is a secret.
 */
function parseMcpArgs(argv) {
  const words = [];
  const f = { dryRun: false, json: false, to: null, host: null, expect: null, command: null, url: null, bearerEnv: null, arg: [], env: [] };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--')) { words.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (VALUE_FLAGS.has(name) || LIST_FLAGS.has(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') throw new UsageError(`aos mcp: --${name} needs a value`);
      if (LIST_FLAGS.has(name)) f[name].push(String(v));
      else if (seen.has(name)) throw new UsageError(`aos mcp: --${name} is given twice`);
      else f[FLAG_KEY[name]] = String(v);
    } else if ((name === 'dry-run' || name === 'json') && eq === -1) f[name === 'json' ? 'json' : 'dryRun'] = true;
    else throw new UsageError(`aos mcp: unknown flag ${a} (${USAGE})`);
    seen.add(name);
  }
  const [verb, name, ...rest] = words;
  const not = (allowed) => [...seen].find((k) => !allowed.includes(k));
  if (verb === 'list' || verb === 'check') {
    if (name !== undefined || not(['json'])) throw new UsageError(`aos mcp ${verb} takes only --json`);
    return { verb, json: f.json };
  }
  if (!WRITE_VERBS.includes(verb) || !name || rest.length) throw new UsageError(USAGE);
  const base = { verb, name, dryRun: f.dryRun, json: f.json, expect: f.expect };
  const takes = (allowed, words_) => {
    const bad = not([...allowed, 'dry-run', 'expect', 'json']);
    if (bad) throw new UsageError(`aos mcp ${verb} takes ${words_}, --dry-run, --expect and --json, not --${bad}`);
  };
  if (verb === 'copy') {
    takes(['to'], '--to');
    if (!HOSTS.includes(f.to)) throw new UsageError('aos mcp copy: --to takes claude or codex');
  } else if (verb === 'add') {
    takes(['to', 'command', 'arg', 'url', 'bearer-env', 'env'], '--to, --command, --arg, --url, --bearer-env, --env');
    if (![...HOSTS, 'both'].includes(f.to)) throw new UsageError('aos mcp add: --to takes claude, codex or both');
    if ((f.command === null) === (f.url === null)) throw new UsageError('aos mcp add: give --command (a local server) or --url (a remote one)');
    if (f.url !== null && f.arg.length) throw new UsageError('aos mcp add: --arg is for a local server (--command)');
    if (f.url !== null && f.env.length) throw new UsageError("aos mcp add: a remote server takes its secret as --bearer-env '$VAR', not --env");
    if (f.command !== null && f.bearerEnv !== null) throw new UsageError('aos mcp add: --bearer-env is for a remote server (--url)');
  } else {
    takes(['host'], '--host');
    if (!HOSTS.includes(f.host)) throw new UsageError(`aos mcp ${verb}: --host takes claude or codex`);
  }
  if (f.expect !== null && !HASH_RE.test(f.expect)) throw new UsageError(`aos mcp ${verb}: --expect takes the 64-character hash a dry run printed`);
  if (f.expect !== null && f.dryRun) throw new UsageError(`aos mcp ${verb}: --expect is for the real run, after a --dry-run`);
  if (verb === 'copy') return { ...base, to: f.to };
  if (verb !== 'add') return { ...base, host: f.host };
  const env = [];
  for (const kv of f.env) {
    const eq = kv.indexOf('=');
    const key = eq === -1 ? kv : kv.slice(0, eq);
    const v = eq === -1 ? null : VAR_RE.exec(kv.slice(eq + 1));
    if (!ENV_KEY_RE.test(key)) throw new UsageError('aos mcp add: --env takes KEY=$VAR, KEY a variable name (letters, digits and _)');
    if (!v) throw new UsageError(`aos mcp add: --env ${key}= takes the name of a variable, $NAME, never its value: quote it ('${key}=$NAME') so the shell leaves it as written`);
    if (env.some((e) => e.key === key)) throw new UsageError(`aos mcp add: --env ${key} is given twice`);
    env.push({ key, var: v[1] });
  }
  let bearer = null;
  if (f.bearerEnv !== null) {
    const v = VAR_RE.exec(f.bearerEnv);
    if (!v) throw new UsageError("aos mcp add: --bearer-env takes the name of a variable, $NAME, never its value: quote it ('$NAME') so the shell leaves it as written");
    bearer = v[1];
  }
  return { ...base, to: f.to, command: f.command, args: f.arg, url: f.url, env, bearerEnv: bearer };
}

// ── the source's full entry ──────────────────────────────────────────────────

/** What the copy carries from an entry: { transport, command, args, env, url, headers, bearerEnv, envVars, dropped,
 *  disabled } (bearerEnv and envVars: Codex's bearer_token_env_var and env_vars). */
function normalize(host, raw, extra = []) {
  const url = str(raw.url);
  const type = str(raw.type) || str(raw.transport);
  const transport = type === 'http' || type === 'sse' || type === 'stdio' ? type : (url ? 'http' : 'stdio');
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const env = {};
  if (isPlainObject(raw.env)) for (const [k, v] of Object.entries(raw.env)) env[k] = String(v);
  const headers = {};
  if (isPlainObject(raw.headers)) for (const [k, v] of Object.entries(raw.headers)) headers[k] = String(v);
  const bearerEnv = host === 'codex' ? str(raw.bearer_token_env_var) : null;
  const envVars = host === 'codex' && Array.isArray(raw.env_vars) ? raw.env_vars.map(String) : [];
  const dropped = [...Object.keys(raw).filter((k) => !CARRIED[host].has(k)), ...extra].sort();
  return { transport, command: str(raw.command), args, env, url, headers, bearerEnv, envVars, dropped, disabled: raw.enabled === false || raw.disabled === true };
}

function hostDirsOf(host, ctx) {
  const { hostDirs } = require(resolveScript('lib/host.js'));
  return hostDirs(host, { env: ctx.env, userConfig: ctx.userConfig });
}

/** The file a host keeps its user-scope servers in. */
function configFileOf(host, ctx) {
  const dirs = hostDirsOf(host, ctx);
  if (host === 'codex') return path.join(dirs.configDir, 'config.toml');
  return lib().claudeUserFile({ dirs, home: ctx.home });
}

/** config.toml's servers by name (lib/import/mcp.js codexServerMap), or a Refused naming why it cannot be read. */
function codexMap(file, why) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
  try { return lib().codexServerMap(text); } catch (e) { throw new Refused(`${why}: Codex's config.toml does not parse (${e.message})`); }
}

/**
 * The host's user-scope entry for `name`. → { file, server (normalize), raw (the entry as the file holds it: Codex's with
 * its `.env` folded in) } or null. Throws Refused for a form that is not read (`verb` names the command that refuses).
 */
function readEntry(host, name, ctx, verb = 'copy') {
  const file = configFileOf(host, ctx);
  if (host === 'claude') {
    const j = readJson(file);
    const all = j && isPlainObject(j.mcpServers) ? j.mcpServers : {};
    if (!Object.prototype.hasOwnProperty.call(all, name) || !isPlainObject(all[name])) return null;
    return { file, server: normalize('claude', all[name]), raw: all[name] };
  }
  const e = codexMap(file, `cannot read ${name}`).get(name);
  if (!e) return null;
  if (e.forms.has('dotted') || e.forms.size > 1) {
    const how = e.forms.has('dotted') ? 'dotted keys' : 'more than one place';
    throw new Refused(`Codex declares ${name} in a form aos mcp ${verb} does not read (${how}): write it as an [mcp_servers.${name}] table`);
  }
  const spec = { ...(e.spec || {}) };
  const env = { ...(isPlainObject(spec.env) ? spec.env : {}), ...e.env };
  delete spec.env;
  if (Object.keys(env).length) spec.env = env;
  return { file, server: normalize('codex', spec, [...e.dotted, ...e.subtables]), raw: spec };
}

/** Whether `host` declares `name` in its config file, in any form. */
function declares(host, name, ctx) {
  if (host === 'claude') return !!readEntry('claude', name, ctx);
  return codexMap(configFileOf('codex', ctx), `cannot tell whether Codex already has ${name}`).has(name);
}

// ── the target command, and what is shown of it ──────────────────────────────

/** A value that should be hidden, with what to scrub for it (the value, and its last word: `Bearer <token>`). */
function secretParts(v) {
  const out = [v];
  const last = String(v).trim().split(/\s+/).pop();
  if (last && last !== v) out.push(last);
  return out;
}

/** A flag: `--name`, `-name` (Go's long flags) or `-x`. */
const FLAG_NAME = /^-{1,2}([A-Za-z][A-Za-z0-9_.-]*)$/;
/** `name=value`: a flag's (`--name=`, `-name=`) or an environment-style `KEY=`. */
const KV = /^(-{0,2}[A-Za-z_][A-Za-z0-9_.-]*)=([\s\S]+)$/;

/** A header written `Name: value`, its value hidden. → { shown, secrets } */
function hiddenHeader(h) { return { shown: `${h[1]}: ${HIDDEN}`, secrets: [h[0], ...secretParts(h[2])] }; }

/** A JSON value with every secret-named key's value and every token-like or URL string hidden. */
function redactJson(v, secrets, key = null) {
  // A list of strings is an argument list (`["--token", "<t>"]`): read it as one, flag by value.
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string') && !(key !== null && lib().secretName(key))) {
    const r = redactArgs(v);
    secrets.push(...r.secrets);
    return r.shown;
  }
  if (Array.isArray(v)) return v.map((x) => redactJson(x, secrets, key));
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactJson(x, secrets, k);
    return out;
  }
  if (key !== null && lib().secretName(key) && (typeof v === 'string' || typeof v === 'number')) { secrets.push(String(v)); return HIDDEN; }
  if (typeof v !== 'string') return v;
  const r = redactValue(v);
  secrets.push(...r.secrets);
  return r.shown;
}

/**
 * A shell string's words, POSIX-style: blanks split; '…' is literal; "…" keeps its text, with \ escaping " \ $ ` and a
 * newline; a bare \ escapes the next character. → string[], or null when a quote or an escape does not close.
 */
function shellWords(text) {
  const words = [];
  let cur = '';
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) { if (open) { words.push(cur); cur = ''; open = false; } continue; }
    open = true;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += text.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1])) { cur += text[j + 1]; j++; } else cur += text[j];
      }
      if (j >= text.length) return null;
      i = j;
    } else if (c === '\\') {
      if (i + 1 >= text.length) return null;
      cur += text[++i];
    } else cur += c;
  }
  if (open) words.push(cur);
  return words;
}

/** A word as a shell string shows it: single-quoted when it holds a blank, a quote or a backslash. */
function showWord(w) { return /[\s'"\\]/.test(w) || w === '' ? `'${w.replace(/'/g, "'\\''")}'` : w; }

/**
 * A value on its own (a bare argument, the part after `=`): JSON with its secrets hidden; words of a shell string each
 * redacted as arguments; a URL masked; each `:`- or `=`-separated part that looks like a token hidden; a token hidden.
 * → { shown, secrets }
 */
function redactValue(a) {
  const L = lib();
  if (/^\s*[[{]/.test(a)) {
    let j;
    try { j = JSON.parse(a); } catch { j = undefined; }
    if (j !== undefined) {
      const secrets = [];
      const shown = JSON.stringify(redactJson(j, secrets));
      return { shown, secrets: secrets.length ? [a, ...secrets] : [] };
    }
  }
  if (/[\s'"\\]/.test(a.trim())) {
    // A shell string (`sh -c "curl -H 'Authorization: …' …"`): its words as a shell splits them, each read as an
    // argument; shown again as words, quoted where they need it. One whose quotes do not close is hidden whole.
    const words = shellWords(a);
    if (words === null) return { shown: HIDDEN, secrets: [a] };
    if (words.length > 1 || words[0] !== a) {
      const r = redactArgs(words);
      if (!r.secrets.length) return { shown: a, secrets: [] };
      return { shown: r.shown.map(showWord).join(' '), secrets: [a, ...r.secrets] };
    }
  }
  const u = L.maskUrl(a, { query: 'mask' });
  if (u.shown !== null) return { shown: u.shown, secrets: u.shown === a ? [] : [a, ...u.secrets] };
  if (L.tokenLike(a)) return { shown: HIDDEN, secrets: [a] };
  if (/[:=]/.test(a)) {
    const parts = a.split(/([:=])/);
    const secrets = [];
    const shown = parts.map((x, i) => (i % 2 === 0 && L.tokenLike(x) ? (secrets.push(x), HIDDEN) : x)).join('');
    return { shown, secrets: secrets.length ? [a, ...secrets] : [] };
  }
  return { shown: a, secrets: [] };
}

/** One argument as shown, given the one before it. → { shown, secrets } */
function redactArg(a, prev) {
  const L = lib();
  const flag = prev !== null ? FLAG_NAME.exec(prev) : null;
  if (prev !== null && HEADER_FLAGS.has(prev)) {
    const h = HEADER_ARG.exec(a);
    return h ? hiddenHeader(h) : { shown: HIDDEN, secrets: [a] };
  }
  // The value of a secret-named flag: --token, -token, --api-key, --pass, and the short -p, -k, -t.
  // Whatever it looks like, even `-abc`: a secret may start with a dash.
  if (flag && (SECRET_SHORT.has(prev) || (flag[1].length > 1 && L.secretName(flag[1])))) return { shown: HIDDEN, secrets: [a] };
  const kv = KV.exec(a);
  if (kv) {
    if (HEADER_FLAGS.has(kv[1])) {
      const h = HEADER_ARG.exec(kv[2]);
      if (h) { const r = hiddenHeader(h); return { shown: `${kv[1]}=${r.shown}`, secrets: [a, ...r.secrets] }; }
      return { shown: `${kv[1]}=${HIDDEN}`, secrets: [a, kv[2]] };
    }
    if (L.secretName(kv[1])) return { shown: `${kv[1]}=${HIDDEN}`, secrets: [a, kv[2]] };
    const r = redactValue(kv[2]);
    return { shown: `${kv[1]}=${r.shown}`, secrets: r.shown === kv[2] ? [] : [a, ...r.secrets] };
  }
  const h = HEADER_ARG.exec(a);
  if (h && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(a) && (SECRET_HEADER.test(h[1]) || L.secretName(h[1]))) return hiddenHeader(h);
  return redactValue(a);
}

/** Arguments with their secrets hidden. → { shown, secrets } */
function redactArgs(args) {
  const shown = [];
  const secrets = [];
  args.forEach((a, i) => {
    const r = redactArg(String(a), i > 0 ? String(args[i - 1]) : null);
    shown.push(r.shown);
    secrets.push(...r.secrets);
  });
  return { shown, secrets };
}

/** Every value hidden, but one that only names a variable (`${VAR}`): that is a name, which the host expands. */
function hideValues(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = VAR_REF.test(v) ? v : HIDDEN;
  return out;
}

/** The secrets of an entry's values, for the scrub: every value but a variable reference, and its last word. */
function valueSecrets(obj) { return Object.values(obj).filter((v) => v && !VAR_REF.test(v)).flatMap(secretParts); }

/** A word as a shell would need it written, for showing. */
function shq(w) { return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, "'\\''")}'`; }

/** `${VAR}` → VAR (the variable a value names), else null. */
function varOf(v) { const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(v)); return m ? m[1] : null; }

/**
 * The target CLI's arguments (after its binary) and the same with every secret it recognises hidden. → { argv, shown,
 * secrets, dropped (what this target cannot express), paste (Codex: the variable names for A1's `env_vars` line), note }.
 * `raw` (Claude Code only) is an entry to put back exactly as it was (unpark): its keys as written, shown as `s` is.
 * Throws Refused when the target cannot take this server.
 */
function targetCommand(to, name, s, raw = null) {
  const secrets = [...valueSecrets(s.env), ...valueSecrets(s.headers)].filter(Boolean);
  // The command too: `env API_KEY=<v> node` is a command line some configs carry.
  const cmdShown = s.command ? redactValue(s.command) : { shown: s.command, secrets: [] };
  secrets.push(...cmdShown.secrets);
  if (to === 'claude') {
    let json;
    let shownJson;
    if (s.transport === 'stdio') {
      if (!s.command) throw new Refused(`${name} names no command to run`);
      const r = redactArgs(s.args);
      secrets.push(...r.secrets);
      json = { type: 'stdio', command: s.command, ...(s.args.length ? { args: s.args } : {}), ...(Object.keys(s.env).length ? { env: s.env } : {}) };
      shownJson = { ...json, command: cmdShown.shown, ...(s.args.length ? { args: r.shown } : {}), ...(Object.keys(s.env).length ? { env: hideValues(s.env) } : {}) };
    } else {
      if (!s.url) throw new Refused(`${name} is a remote server with no URL`);
      const u = lib().maskUrl(s.url, { query: 'mask' });
      if (u.shown !== s.url) secrets.push(s.url, ...u.secrets);
      // Codex's bearer_token_env_var is Claude Code's `Authorization: Bearer ${VAR}`, which it expands (A2).
      const headers = { ...s.headers };
      if (s.bearerEnv && !Object.keys(headers).some((k) => /^authorization$/i.test(k))) headers.Authorization = `Bearer \${${s.bearerEnv}}`;
      json = { type: s.transport, url: s.url, ...(Object.keys(headers).length ? { headers } : {}) };
      shownJson = { ...json, url: u.shown || HIDDEN, ...(Object.keys(headers).length ? { headers: hideValues(headers) } : {}) };
    }
    if (raw) {
      // Unpark: the entry exactly as the file held it, keys and all; shown by the same rules.
      json = raw;
      shownJson = { ...raw, ...Object.fromEntries(Object.keys(shownJson).filter((k) => k !== 'type' && k in raw).map((k) => [k, shownJson[k]])) };
    }
    const head = ['mcp', 'add-json', '--scope', 'user', name];
    return { argv: [...head, JSON.stringify(json)], shown: [...head, JSON.stringify(shownJson)], secrets, dropped: [], paste: [], note: null };
  }
  if (s.transport !== 'stdio') {
    // D20: `codex mcp add --url` takes a streamable HTTP server, its token only as the name of a variable.
    if (s.transport !== 'http') throw new Refused(`${name} is a remote (${s.transport}) server, and \`codex mcp add --url\` takes a streamable HTTP server only: Codex cannot reach it`);
    if (!s.url) throw new Refused(`${name} is a remote server with no URL`);
    const u = lib().maskUrl(s.url, { query: 'mask' });
    if (u.shown !== s.url) secrets.push(s.url, ...u.secrets);
    let bearer = s.bearerEnv;
    const dropped = [];
    for (const [k, v] of Object.entries(s.headers)) {
      const m = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
      if (/^authorization$/i.test(k) && m && !bearer) bearer = m[1];
      else dropped.push(`headers.${k}`);
    }
    const tail = bearer ? ['--bearer-token-env-var', bearer] : [];
    return {
      argv: ['mcp', 'add', name, '--url', s.url, ...tail], shown: ['mcp', 'add', name, '--url', u.shown || HIDDEN, ...tail], secrets, dropped, paste: [],
      note: dropped.length ? `\`codex mcp add\` takes no header values: to send a token, name the variable that holds it with bearer_token_env_var = "NAME" under [mcp_servers.${name}] in Codex's config.toml` : null,
    };
  }
  if (!s.command) throw new Refused(`${name} names no command to run`);
  const bad = [...Object.keys(s.env), ...s.envVars].find((k) => !ENV_KEY_RE.test(k));
  if (bad) throw new Refused(`${name}'s environment names ${JSON.stringify(bad)}, which \`codex mcp add --env\` cannot take`);
  const r = redactArgs(s.args);
  secrets.push(...r.secrets);
  // A1: a variable reference is not a value Codex can take; the server gets it through env_vars, pasted by hand.
  const pass = Object.entries(s.env).filter(([, v]) => !varOf(v));
  const paste = [...new Set([...Object.entries(s.env).filter(([, v]) => varOf(v)).map(([k]) => k), ...s.envVars])];
  const envArgs = pass.flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const envShown = pass.flatMap(([k]) => ['--env', `${k}=${HIDDEN}`]);
  return {
    argv: ['mcp', 'add', name, ...envArgs, '--', s.command, ...s.args],
    shown: ['mcp', 'add', name, ...envShown, '--', cmdShown.shown, ...r.shown],
    secrets, dropped: [], paste, note: null,
  };
}

/** A1's line for Codex: `env_vars = ["KEY", …]`. */
function envVarsLine(keys) { return `env_vars = [${keys.map((k) => JSON.stringify(k)).join(', ')}]`; }

/**
 * `text` with every secret replaced, as written and JSON-escaped (add-json echoes its JSON): a failing CLI's own output
 * is shown only through this. A secret of one or two characters is replaced only as a whole word, so it never cuts
 * into another.
 */
function scrub(text, secrets) {
  let out = String(text || '');
  const forms = new Set();
  for (const x of secrets) {
    if (!x) continue;
    forms.add(String(x));
    forms.add(JSON.stringify(String(x)).slice(1, -1));
  }
  for (const x of [...forms].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (x.length >= 3) out = out.split(x).join(HIDDEN);
    else out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'g'), HIDDEN);
  }
  return out;
}

/**
 * The plan's hash: an HMAC-SHA256, under this install's key (planKey), of the verb, the source entry as read and the
 * exact target command, so a confirm runs only what it showed. Keyed, because the page holds the hash and the entry holds secrets: a
 * plain hash of a weak one could be guessed back offline. 64 hex digits either way.
 */
function planHash(p, key) {
  return crypto.createHmac('sha256', key).update(JSON.stringify({ v: 1, verb: p.verb || 'copy', name: p.name, from: p.from, to: p.to, server: p.server, argv: p.argv })).digest('hex');
}

// ── this install's own folders: real, and the user's ─────────────────────────

/**
 * ~/<parts…>, each component made (0700) or entered only when it is a real folder (never a link) owned by this user:
 * a planted link would otherwise send a backup of the host's config, a stash, or the key, wherever it points. With
 * `create: false` nothing is made: → null when a component is missing. → the folder
 */
function ownDir(home, parts, what, { create = true } = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let cur = path.resolve(home);
  for (const part of parts) {
    cur = path.join(cur, part);
    let st = null;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!st) {
      if (!create) return null;
      try { fs.mkdirSync(cur, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      st = fs.lstatSync(cur);
    }
    const why = st.isSymbolicLink() ? 'a link' : !st.isDirectory() ? 'not a folder' : uid !== null && st.uid !== uid ? 'owned by another user' : null;
    if (why) throw new Refused(`${tilde(cur, path.resolve(home))} is not a folder of your own (${why}): aos mcp keeps its ${what} only in real folders you own`);
  }
  return cur;
}

/** The folder of this install's keys: ~/.local/share/unidex/keys, 0700 (the Workbench's page never reads it). */
function keyDir(home) { return path.join(home, '.local', 'share', 'unidex', 'keys'); }

/**
 * This install's key for planHash: 32 random bytes in ~/.local/share/unidex/keys/mcp-plan.key, made on first use (0600,
 * written to a file of its own and linked into place, so parallel first runs agree) and read without following a link;
 * one that is a link, not a regular file of this user's, open to others, or not 32 bytes is refused rather than used.
 */
function planKey(home) {
  const dir = ownDir(home, ['.local', 'share', 'unidex', 'keys'], 'key');
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'mcp-plan.key');
  if (!fs.existsSync(file)) {
    // Written whole under a name of its own, then linked into place: a first run beside this one either wins the link or
    // reads the key the winner wrote, never a file half written.
    const tmp = path.join(dir, `.mcp-plan.key.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeSync(fd, crypto.randomBytes(32)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { fs.unlinkSync(tmp); }
  }
  const refuse = (why) => new Refused(`${tilde(file, path.resolve(home))} is not a key file of your own (${why}): remove it, and the next dry run makes a new one`);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch (e) { if (e.code === 'ELOOP') throw refuse('a link'); throw e; }
  try {
    const st = fs.fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!st.isFile()) throw refuse('not a file');
    if (uid !== null && st.uid !== uid) throw refuse('owned by another user');
    if (st.mode & 0o077) throw refuse('others can read it');
    if (st.size !== 32) throw refuse('not 32 bytes');
    const key = Buffer.alloc(32);
    fs.readSync(fd, key, 0, 32, 0);
    return key;
  } finally { fs.closeSync(fd); }
}

// ── backup ───────────────────────────────────────────────────────────────────

/** Where backups go: outside the vault and every folder the Workbench's page reads (app read-scope.ts deniedDirs). */
function backupDir(home) { return path.join(home, '.local', 'share', 'unidex', 'backups', 'mcp'); }

/** A backup's file name at `now`, to the millisecond. */
function backupName(to, file, now, n = 1) {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '');
  return `${to}-${path.basename(file).replace(/^\./, '')}-${stamp}${n > 1 ? `-${n}` : ''}.bak`;
}

/** Make the backups folder, 0700 (and its parent `backups`), each component a real folder of this user's (ownDir). */
function ensureBackupDir(home) {
  const dir = ownDir(home, ['.local', 'share', 'unidex', 'backups', 'mcp'], 'backups');
  for (const d of [path.dirname(dir), dir]) fs.chmodSync(d, 0o700);
  return dir;
}

/** Copy the target's config file into the backups (0600, created exclusively), keeping the newest KEEP_BACKUPS per host. */
function backup(home, to, file, now) {
  if (!fs.existsSync(file)) return null;
  const dir = ensureBackupDir(home);
  let dest = null;
  for (let n = 1; !dest; n++) {
    const p = path.join(dir, backupName(to, file, now, n));
    try { fs.copyFileSync(file, p, fs.constants.COPYFILE_EXCL); dest = p; } catch (e) { if (e.code !== 'EEXIST' || n > 99) throw e; }
  }
  fs.chmodSync(dest, 0o600);
  const mine = fs.readdirSync(dir).filter((n) => n.startsWith(`${to}-`) && n.endsWith('.bak'))
    .sort((a, b) => (a.replace(/\.bak$/, '') < b.replace(/\.bak$/, '') ? -1 : 1));
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) { try { fs.unlinkSync(path.join(dir, old)); } catch { /* gone */ } }
  return dest;
}

// ── the parked servers' stash (connectors-tab D16) ───────────────────────────

const PARK_PARTS = ['.local', 'share', 'unidex', 'parked', 'mcp'];
/** Where park keeps each server's exact entry: outside the vault and every folder the Workbench's page reads. */
function parkDir(home) { return path.join(home, ...PARK_PARTS); }
function stashName(host, name) { return `${host}-${name}.json`; }
const MAX_STASH = 1024 * 1024;

/**
 * The stash of `host`'s `name`, read without following a link: → { file, body } or null when there is none. One that is
 * not a regular file of this user's, that others can read, or that does not parse is refused rather than used.
 */
function readStash(home, host, name) {
  const dir = ownDir(home, PARK_PARTS, 'parked servers', { create: false });
  if (!dir) return null;
  const file = path.join(dir, stashName(host, name));
  const refuse = (why) => new Refused(`${tilde(file, path.resolve(home))} is not a stash of your own (${why}): move it away, and park the server again`);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'ELOOP') throw refuse('a link');
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!st.isFile()) throw refuse('not a file');
    if (uid !== null && st.uid !== uid) throw refuse('owned by another user');
    if (st.mode & 0o077) throw refuse('others can read it');
    if (st.size > MAX_STASH) throw refuse('too large');
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    let body;
    try { body = JSON.parse(buf.toString('utf8')); } catch { throw refuse('it does not parse'); }
    if (!isPlainObject(body) || body.host !== host || body.name !== name || !isPlainObject(body.entry)) throw refuse('not a parked server');
    return { file, body };
  } finally { fs.closeSync(fd); }
}

/** Save a stash: 0600, created exclusively, in its 0700 folders (ownDir). → its path */
function writeStash(home, host, name, body) {
  const dir = ownDir(home, PARK_PARTS, 'parked servers');
  for (const d of [path.dirname(dir), dir]) fs.chmodSync(d, 0o700);
  const file = path.join(dir, stashName(host, name));
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeSync(fd, `${JSON.stringify(body, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(file, 0o600);
  return file;
}

// ── the run ──────────────────────────────────────────────────────────────────

function hostsOn(user) {
  const h = user && user.hosts;
  if (!isPlainObject(h)) return { claude: true, codex: false };
  return { claude: !!(h.claude && h.claude.enabled), codex: !!(h.codex && h.codex.enabled) };
}

/**
 * The environment the target CLI runs with, so it writes the file that was backed up: Codex its home; Claude Code its
 * config folder only when the file is inside it (with CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json there), and
 * none when the file sits beside the default folder.
 */
function cliEnv(to, ctx) {
  const env = { ...ctx.env };
  const dir = hostDirsOf(to, ctx).configDir;
  if (to === 'codex') env.CODEX_HOME = dir;
  else if (path.dirname(configFileOf('claude', ctx)) === path.resolve(dir)) env.CLAUDE_CONFIG_DIR = dir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function defaultSpawn(bin, args, opts) {
  const r = spawnSync(bin, args, { encoding: 'utf8', env: opts.env, timeout: RUN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.error ? String(r.error.message) : r.stderr || '' };
}

/** A server name both CLIs take, and never the vault's own. Throws Refused. */
function checkName(name) {
  if (!NAME_RE.test(name)) throw new Refused(`${JSON.stringify(name)} is not a server name both CLIs take (letters, digits, - and _, at most 64)`);
  if (name === OWN) throw new Refused('agenticos is the vault\'s own server: `aos init` and `aos hosts add` wire it on each host');
}
function checkHostOn(host, ctx) {
  if (!hostsOn(ctx.user)[host]) throw new Refused(`${HOST_LABEL[host]} is off on this Mac: \`aos hosts add ${host}\` turns it on`);
}
function binFor(host, ctx, opts) {
  const binOf = host === 'claude' ? opts.claudeBin : opts.codexBin;
  const bin = binOf ? binOf(ctx.user) : null;
  if (!bin) throw new Refused(`the ${host} CLI was not found: install ${HOST_LABEL[host]}, then try again`);
  return bin;
}

/** What a copy would do now: every check, the command and its hash. Throws Refused. */
function plan(args, ctx, opts) {
  const { name, to } = args;
  const from = to === 'claude' ? 'codex' : 'claude';
  checkName(name);
  checkHostOn(to, ctx);
  const src = readEntry(from, name, ctx);
  if (!src) throw new Refused(`${HOST_LABEL[from]} declares no MCP server named ${name} (${tilde(configFileOf(from, ctx), ctx.home)})`);
  if (src.server.disabled) throw new Refused(`${name} is turned off on ${HOST_LABEL[from]}: turn it on there first, or add it to ${HOST_LABEL[to]} yourself`);
  const target = configFileOf(to, ctx);
  if (declares(to, name, ctx)) throw new Refused(`${HOST_LABEL[to]} already has an MCP server named ${name} (${tilde(target, ctx.home)}); nothing to do`);
  const cmd = targetCommand(to, name, src.server);
  const bin = binFor(to, ctx, opts);
  const hash = planHash({ name, from, to, server: src.server, argv: cmd.argv }, planKey(ctx.home));
  return { name, from, to, src, target, cmd, bin, hash };
}

/** A1's paste, for a report: the line, where it goes, and how Codex passes each. {} when there is nothing to paste. */
function pasteOf(cmd, name, file, home, env = []) {
  if (!cmd.paste.length) return {};
  const renamed = env.filter((e) => cmd.paste.includes(e.key) && e.key !== e.var);
  return {
    paste: envVarsLine(cmd.paste), pasteUnder: `[mcp_servers.${name}]`, pasteFile: tilde(file, home),
    pasteNote: `Codex passes each of these to the server from its own environment, by that name${renamed.length ? `: set ${renamed.map((e) => `${e.key} from $${e.var}`).join(', ')} where Codex starts` : ''}`,
  };
}

/** The backup a real run would make now, for a dry run's report (null when the file does not exist yet). */
function backupShown(ctx, host, file, now) {
  return fs.existsSync(file) ? tilde(path.join(backupDir(ctx.home), backupName(host, file, now)), ctx.home) : null;
}

/**
 * Run `fn` holding `host`'s lock: one write to a host's MCP config at a time, whatever the verb (the file is named for
 * copy, its first user). The lock's folder is the backups' own, made first. Busy → Refused(`busy`).
 */
function withHost(ctx, host, opts, busy, fn) {
  const fsx = require(resolveScript('lib/fsx.js'));
  ensureBackupDir(ctx.home);
  const lockFile = path.join(backupDir(ctx.home), `${host}-copy`);
  try {
    return fsx.withLockSync(lockFile, fn, { timeoutMs: opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS, staleMs: 3 * RUN_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof fsx.LockBusy) throw new Refused(busy);
    throw e;
  }
}

/** Run the host's CLI; a failure is Refused with its own words scrubbed and the backup named. */
function runCli(host, bin, cmd, ctx, opts, savedShown) {
  const out = (opts.spawn || defaultSpawn)(bin, cmd.argv, { env: cliEnv(host, ctx) });
  if (out.status !== 0) {
    const said = scrub(`${out.stderr}\n${out.stdout}`, cmd.secrets).split('\n').map((l) => l.trim()).filter(Boolean)[0] || `exit ${out.status}`;
    throw new Refused(`${host} ${cmd.argv.slice(0, 2).join(' ')} failed (${said})${savedShown ? `; the backup is ${savedShown}` : ''}`);
  }
}

/** List again (connectors.json, connectors-usage.json, mcp-servers.json), so the Workbench shows the change. */
function relist(ctx, now) {
  connectors('index.js').refresh({ vault: ctx.vault, cfg: ctx.cfg, env: ctx.env, home: ctx.home, now });
}

/**
 * Plan (and, unless dryRun, make) one copy. opts: { env, configDir, vault, home, now, claudeBin(user), codexBin(user),
 * spawn(bin, args, { env }), lockTimeoutMs }. → the report printed with --json.
 */
function copy(args, opts = {}) {
  const I = require('./import.js');
  const ctx = I.resolveCtx(opts);
  const now = opts.now || Date.now();
  const report = (p, extra) => ({
    ok: true, dryRun: !!args.dryRun, name: p.name, from: p.from, to: p.to, transport: p.src.server.transport,
    command: [p.to, ...p.cmd.shown].map(shq).join(' '),
    source: tilde(p.src.file, ctx.home), file: tilde(p.target, ctx.home),
    backup: backupShown(ctx, p.to, p.target, now),
    dropped: [...p.src.server.dropped, ...p.cmd.dropped].sort(), ...(p.cmd.note ? { note: p.cmd.note } : {}),
    ...pasteOf(p.cmd, p.name, p.target, ctx.home), expect: p.hash, ...extra,
  });
  if (args.dryRun) return report(plan(args, ctx, opts), {});

  const checked = () => {
    const p = plan(args, ctx, opts);
    if (args.expect && args.expect !== p.hash) throw new Refused(`${p.name}'s config or its command changed since the dry run: run the dry run again`);
    return p;
  };
  // Checked before the lock's folder is made, so a refusal leaves nothing behind; then again under the lock.
  checked();
  return withHost(ctx, args.to, opts, `another copy to ${HOST_LABEL[args.to]} is running: try again in a moment`, () => {
    // What the dry run showed must still be what runs.
    const p = checked();
    const saved = backup(ctx.home, p.to, p.target, now);
    const r = report(p, { backup: saved ? tilde(saved, ctx.home) : null });
    runCli(p.to, p.bin, p.cmd, ctx, opts, r.backup);
    // List both hosts again, so the Workbench shows the server on both.
    const L = lib();
    const byHost = {};
    for (const h of HOSTS) byHost[h] = L.listServers(h, { env: ctx.env, userConfig: ctx.userConfig, dirs: hostDirsOf(h, ctx), home: ctx.home }).servers;
    L.writeServers(ctx.vault, HOSTS, byHost, { now: new Date(now) });
    r.listed = byHost[p.to].some((s) => s.name === p.name);
    return r;
  });
}

// ── park, unpark, remove (connectors-tab D16, D17) ───────────────────────────

/**
 * Why `name` is not one of `host`'s user-scope servers, when discovery knows it as something else (D17): a plugin's
 * server, a connector, a project's. → the sentence, or null.
 */
function notTheUsers(host, name, ctx, verb) {
  let rows = [];
  try { rows = connectors('discover.js').discover({ vault: ctx.vault, userConfig: ctx.cfg, env: ctx.env, home: ctx.home, hosts: [host] }).rows; } catch { return null; }
  const low = name.toLowerCase();
  const plugin = rows.find((r) => r.scope === 'plugin' && (r.name === name || r.name === `plugin:${r.plugin}:${name}`));
  if (plugin && host === 'claude') return `${name} comes from the Claude Code plugin ${plugin.plugin}: turn the plugin off with \`claude plugin disable ${plugin.plugin}\` (that turns off its skills too)`;
  if (plugin) return `${name} comes from the Codex plugin ${plugin.plugin}, and Codex has no command that turns one off: turn the plugin off in Codex's plugin settings`;
  const con = rows.find((r) => r.kind === 'connector' && (r.name.toLowerCase() === low || String(r.displayName || '').toLowerCase() === low));
  if (con && host === 'claude') return `${name} is a claude.ai connector: turn it off in claude.ai's connector settings (https://claude.ai/settings/connectors)`;
  if (con) return `${name} is a ChatGPT app${con.plugin ? ` of the Codex plugin ${con.plugin}` : ''}: turn it off in ChatGPT's connector settings`;
  const proj = rows.find((r) => (r.scope === 'project' || r.scope === 'local') && r.name === name);
  if (proj) return `${name} is the workspace ${proj.workspace}'s own (${proj.scope}, ${proj.file}): aos mcp ${verb} takes user-scope servers only, so change it there`;
  return null;
}

/** The user-scope entry a park or a remove takes, or a Refused saying why there is none. */
function userEntry(host, name, ctx, verb) {
  const e = readEntry(host, name, ctx, verb);
  if (e) return e;
  const other = notTheUsers(host, name, ctx, verb);
  if (other) throw new Refused(other);
  if (readStash(ctx.home, host, name)) throw new Refused(`${name} is parked: \`aos mcp unpark ${name} --host ${host}\` puts it back on ${HOST_LABEL[host]}`);
  throw new Refused(`${HOST_LABEL[host]} declares no user-scope MCP server named ${name} (${tilde(configFileOf(host, ctx), ctx.home)})`);
}

/** The host's remove: Claude Code's for user scope only. */
function removeCommand(host, name) {
  const argv = host === 'claude' ? ['mcp', 'remove', name, '--scope', 'user'] : ['mcp', 'remove', name];
  return { argv, shown: argv, secrets: [], dropped: [], paste: [], note: null };
}

/** What unpark would run for a stash's entry: the copy's command, Claude Code's with the entry exactly as it was. */
function restoreCommand(host, name, entry) {
  return host === 'claude' ? targetCommand('claude', name, normalize('claude', entry), entry) : targetCommand('codex', name, normalize('codex', entry));
}

/** What park, unpark or remove would do now: every check, the command and its hash. Throws Refused. */
function hostPlan(args, ctx, opts) {
  const { verb, name, host } = args;
  checkName(name);
  checkHostOn(host, ctx);
  const file = configFileOf(host, ctx);
  let raw;
  let cmd;
  let transport;
  if (verb === 'unpark') {
    const st = readStash(ctx.home, host, name);
    if (!st) throw new Refused(`${HOST_LABEL[host]} has no parked MCP server named ${name} (\`aos mcp park ${name} --host ${host}\` parks one)`);
    if (declares(host, name, ctx)) throw new Refused(`${HOST_LABEL[host]} already has an MCP server named ${name} (${tilde(file, ctx.home)}): remove it first, or keep it and delete ${tilde(st.file, ctx.home)}`);
    raw = st.body.entry;
    cmd = restoreCommand(host, name, raw);
    transport = normalize(host, raw).transport;
  } else {
    const e = userEntry(host, name, ctx, verb);
    raw = e.raw;
    transport = e.server.transport;
    if (verb === 'park') {
      if (e.server.disabled) throw new Refused(`${name} is turned off on ${HOST_LABEL[host]} already: \`aos mcp remove ${name} --host ${host}\` takes it out`);
      const lost = [...Object.keys(raw).filter((k) => !RESTORABLE[host].has(k)), ...e.server.dropped.filter((k) => !RESTORABLE[host].has(k))];
      const type = str(raw.type);
      if (type && !['stdio', 'http', 'sse'].includes(type)) lost.push(`type ${type}`);
      if (lost.length) throw new Refused(`${HOST_LABEL[host]}'s CLI could not put ${name} back as it is (it cannot take ${[...new Set(lost)].sort().join(', ')}), so it is not parked: \`aos mcp remove ${name} --host ${host}\` removes it, its backup kept`);
      if (readStash(ctx.home, host, name)) throw new Refused(`a parked ${name} is already kept for ${HOST_LABEL[host]} (${tilde(path.join(parkDir(ctx.home), stashName(host, name)), ctx.home)}): turn that one on, or move it away, first`);
      // The entry must come back through the CLI: refused now, not at Turn on.
      restoreCommand(host, name, raw);
    }
    cmd = removeCommand(host, name);
  }
  const bin = binFor(host, ctx, opts);
  const hash = planHash({ verb, name, from: host, to: host, server: raw, argv: cmd.argv }, planKey(ctx.home));
  return { verb, name, host, file, raw, cmd, bin, hash, transport };
}

const DONE = { park: 'parked', unpark: 'turned on', remove: 'removed' };

/** Plan (and, unless dryRun, make) a park, an unpark or a remove. opts as copy's. → the report printed with --json. */
function hostWrite(args, opts = {}) {
  const ctx = require('./import.js').resolveCtx(opts);
  const now = opts.now || Date.now();
  const stash = tilde(path.join(parkDir(ctx.home), stashName(args.host, args.name)), ctx.home);
  const report = (p, extra) => ({
    ok: true, dryRun: !!args.dryRun, verb: p.verb, name: p.name, host: p.host, transport: p.transport,
    command: [p.host, ...p.cmd.shown].map(shq).join(' '), file: tilde(p.file, ctx.home), backup: backupShown(ctx, p.host, p.file, now),
    ...(p.verb === 'remove' ? {} : { stash }), ...pasteOf(p.cmd, p.name, p.file, ctx.home), expect: p.hash, ...extra,
  });
  if (args.dryRun) return report(hostPlan(args, ctx, opts), {});
  const checked = () => {
    const p = hostPlan(args, ctx, opts);
    if (args.expect && args.expect !== p.hash) throw new Refused(`${p.name}'s config or its command changed since the dry run: run the dry run again`);
    return p;
  };
  checked();
  return withHost(ctx, args.host, opts, `another change to ${HOST_LABEL[args.host]}'s MCP servers is running: try again in a moment`, () => {
    const p = checked();
    const saved = backup(ctx.home, p.host, p.file, now);
    const r = report(p, { backup: saved ? tilde(saved, ctx.home) : null });
    // Park: the exact entry is kept before the host loses it, and dropped again when the host keeps it after all.
    const kept = p.verb === 'park' ? writeStash(ctx.home, p.host, p.name, { schema: 1, host: p.host, name: p.name, parkedAt: new Date(now).toISOString(), file: r.file, entry: p.raw }) : null;
    try { runCli(p.host, p.bin, p.cmd, ctx, opts, r.backup); } catch (e) {
      if (kept) { try { fs.unlinkSync(kept); } catch { /* gone */ } }
      throw e;
    }
    const there = declares(p.host, p.name, ctx);
    if (p.verb === 'unpark') {
      r.listed = there;
      // The stash goes only once the host lists the server again.
      if (there) { const st = readStash(ctx.home, p.host, p.name); if (st) fs.unlinkSync(st.file); }
    } else r.removed = !there;
    relist(ctx, now);
    return r;
  });
}

// ── add (connectors-tab D18, A1, A2) ─────────────────────────────────────────

/** A URL `aos mcp add` takes: http or https with a host, and no credentials in it (a secret goes in --bearer-env). */
function checkUrl(url) {
  let u = null;
  try { u = new URL(url); } catch { /* below */ }
  const shown = lib().maskUrl(url, { query: 'mask' }).shown || HIDDEN;
  if (!u || !/^https?:$/.test(u.protocol) || !u.host) throw new Refused(`${shown} is not an http or https URL`);
  if (u.username || u.password) throw new Refused(`${shown} carries credentials: give the token's variable with --bearer-env '$VAR' instead`);
}

/** What an add would do now, per target host. Throws Refused. */
function addPlan(args, ctx, opts) {
  const { name } = args;
  checkName(name);
  const targets = args.to === 'both' ? HOSTS : [args.to];
  for (const h of targets) checkHostOn(h, ctx);
  if (args.url !== null) checkUrl(args.url);
  if (args.command !== null && !str(args.command)) throw new Refused('--command names no program');
  // The server as both CLIs get it: every secret a variable's name, never a value (D18).
  const s = args.url !== null
    ? { transport: 'http', command: null, args: [], env: {}, url: args.url, headers: {}, bearerEnv: args.bearerEnv, envVars: [], dropped: [], disabled: false }
    : { transport: 'stdio', command: args.command, args: args.args, env: Object.fromEntries(args.env.map((e) => [e.key, `\${${e.var}}`])), url: null, headers: {}, bearerEnv: null, envVars: [], dropped: [], disabled: false };
  if (s.bearerEnv) s.headers = { Authorization: `Bearer \${${s.bearerEnv}}` };
  const parts = targets.map((host) => {
    const file = configFileOf(host, ctx);
    if (declares(host, name, ctx)) throw new Refused(`${HOST_LABEL[host]} already has an MCP server named ${name} (${tilde(file, ctx.home)})`);
    if (readStash(ctx.home, host, name)) throw new Refused(`${name} is parked on ${HOST_LABEL[host]}: \`aos mcp unpark ${name} --host ${host}\` puts it back`);
    // Codex's remote gets the variable's name as its own flag, not as a header.
    const cmd = targetCommand(host, name, host === 'codex' ? { ...s, headers: {} } : { ...s, bearerEnv: null });
    return { host, file, cmd, bin: binFor(host, ctx, opts) };
  });
  const spec = { transport: s.transport, command: s.command, args: s.args, env: args.env, url: s.url, bearerEnv: s.bearerEnv };
  const hash = planHash({ verb: 'add', name, from: null, to: args.to, server: spec, argv: parts.map((p) => [p.host, ...p.cmd.argv]) }, planKey(ctx.home));
  return { name, to: args.to, transport: s.transport, parts, hash };
}

/** Plan (and, unless dryRun, make) an add on one host or both. opts as copy's. → the report printed with --json. */
function add(args, opts = {}) {
  const ctx = require('./import.js').resolveCtx(opts);
  const now = opts.now || Date.now();
  const part = (q, extra = {}) => ({
    host: q.host, command: [q.host, ...q.cmd.shown].map(shq).join(' '), file: tilde(q.file, ctx.home), backup: backupShown(ctx, q.host, q.file, now),
    ...pasteOf(q.cmd, args.name, q.file, ctx.home, args.env), ...extra,
  });
  const report = (p, hosts) => ({
    ok: true, dryRun: !!args.dryRun, verb: 'add', name: p.name, to: p.to, transport: p.transport,
    secrets: [...args.env.map((e) => `${e.key} ← $${e.var}`), ...(args.bearerEnv ? [`Authorization ← Bearer $${args.bearerEnv}`] : [])],
    hosts, expect: p.hash,
  });
  if (args.dryRun) { const p = addPlan(args, ctx, opts); return report(p, p.parts.map((q) => part(q))); }
  const p0 = addPlan(args, ctx, opts);
  if (args.expect && args.expect !== p0.hash) throw new Refused(`${args.name}'s command changed since the dry run, or a host has that name now: run the dry run again`);
  const done = [];
  for (const q0 of p0.parts) {
    done.push(withHost(ctx, q0.host, opts, `another change to ${HOST_LABEL[q0.host]}'s MCP servers is running: try again in a moment`, () => {
      // Under the lock, this host's part again: still free, still the same command.
      if (declares(q0.host, args.name, ctx)) throw new Refused(`${HOST_LABEL[q0.host]} has an MCP server named ${args.name} now${done.length ? `; ${done.map((d) => HOST_LABEL[d.host]).join(' and ')} has it from this add` : ''}`);
      const saved = backup(ctx.home, q0.host, q0.file, now);
      const r = part(q0, { backup: saved ? tilde(saved, ctx.home) : null });
      try { runCli(q0.host, q0.bin, q0.cmd, ctx, opts, r.backup); } catch (e) {
        if (done.length) throw new Refused(`${e.message}; ${done.map((d) => HOST_LABEL[d.host]).join(' and ')} has ${args.name} from this add`);
        throw e;
      }
      r.listed = declares(q0.host, args.name, ctx);
      return r;
    }));
  }
  relist(ctx, now);
  return report(p0, done);
}

// ── what the terminal prints ─────────────────────────────────────────────────

function lines(r) {
  const out = [];
  out.push(`${r.dryRun ? 'would make' : 'made'} ${r.name} (${r.transport}) from ${HOST_LABEL[r.from]} available on ${HOST_LABEL[r.to]}`);
  out.push(`  from:    ${r.source}`);
  out.push(`  writes:  ${r.file}`);
  out.push(`  backup:  ${r.backup || 'none (the file does not exist yet)'}`);
  out.push(`  runs:    ${r.command}`);
  out.push('  (environment and header values, URL credentials, queries and token-like segments, and arguments named or shaped like secrets are hidden here; one it does not recognise is shown as written)');
  if (r.dropped.length) out.push(`  not carried over: ${r.dropped.join(', ')}`);
  if (r.note) out.push(`  note:    ${r.note}`);
  if (r.paste) out.push(...pasteLines(r));
  if (r.dryRun) out.push(`  confirm with: --expect ${r.expect}`);
  else out.push(r.listed ? '  listed in brain/_index/mcp-servers.json' : `  warning: ${HOST_LABEL[r.to]} does not list it yet; check ${r.file}`);
  return out;
}

function pasteLines(r, pad = '  ') {
  return [`${pad}paste:   ${r.paste}`, `${pad}         under ${r.pasteUnder} in ${r.pasteFile} (\`codex mcp add\` takes values only); ${r.pasteNote}`];
}

function hostLines(r) {
  const verb = { park: 'park', unpark: 'turn on', remove: 'remove' }[r.verb];
  const out = [`${r.dryRun ? `would ${verb}` : DONE[r.verb]} ${r.name} (${r.transport}) on ${HOST_LABEL[r.host]}`];
  out.push(`  writes:  ${r.file}`);
  out.push(`  backup:  ${r.backup || 'none (the file does not exist yet)'}`);
  if (r.verb === 'park') out.push(`  stash:   ${r.stash} (its exact entry, 0600; \`aos mcp unpark ${r.name} --host ${r.host}\` puts it back)`);
  if (r.verb === 'unpark') out.push(`  from:    ${r.stash} (deleted once ${HOST_LABEL[r.host]} lists it)`);
  out.push(`  runs:    ${r.command}`);
  if (r.paste) out.push(...pasteLines(r));
  if (r.dryRun) out.push(`  confirm with: --expect ${r.expect}`);
  else if (r.verb === 'unpark' && !r.listed) out.push(`  warning: ${HOST_LABEL[r.host]} does not list it yet; the stash is kept: ${r.stash}`);
  else if (r.verb !== 'unpark' && !r.removed) out.push(`  warning: ${HOST_LABEL[r.host]} still lists it; check ${r.file}`);
  return out;
}

function addLines(r) {
  const on = r.hosts.map((h) => HOST_LABEL[h.host]).join(' and ');
  const out = [`${r.dryRun ? 'would add' : 'added'} ${r.name} (${r.transport}) to ${on}`];
  if (r.secrets.length) out.push(`  secrets: ${r.secrets.join(', ')} (names only: each is read from your environment when the server starts)`);
  for (const h of r.hosts) {
    out.push(`  ${HOST_LABEL[h.host]}:`);
    out.push(`    writes:  ${h.file}`);
    out.push(`    backup:  ${h.backup || 'none (the file does not exist yet)'}`);
    out.push(`    runs:    ${h.command}`);
    if (h.paste) out.push(...pasteLines(h, '    '));
    if (!r.dryRun && !h.listed) out.push(`    warning: ${HOST_LABEL[h.host]} does not list it yet; check ${h.file}`);
  }
  if (r.dryRun) out.push(`  confirm with: --expect ${r.expect}`);
  return out;
}

// ── list and check (connectors-tab) ──────────────────────────────────────────

function connectors(rel) { return require(resolveScript(`lib/connectors/${rel}`)); }

/** `aos mcp list`: discovery and usage into the caches, from files alone. opts as copy's. */
function list(opts = {}) {
  const ctx = require('./import.js').resolveCtx(opts);
  const { connectors: c, usage } = connectors('index.js').refresh({ vault: ctx.vault, cfg: ctx.cfg, env: ctx.env, home: ctx.home, now: opts.now || Date.now() });
  return { ok: true, updatedAt: c.updatedAt, hosts: c.hosts, rows: c.rows, usage: usage.rows };
}

/** `aos mcp check`: the live check, then the list again (it may have named new claude.ai connectors). opts as copy's,
 *  plus run and probe (check.js's stand-ins, for tests). */
async function checkNow(opts = {}) {
  const ctx = require('./import.js').resolveCtx(opts);
  const K = connectors('check.js');
  let live;
  try {
    live = await K.check({
      vault: ctx.vault, userConfig: ctx.cfg, cfg: ctx.cfg, env: ctx.env, home: ctx.home,
      claudeBin: () => (opts.claudeBin ? opts.claudeBin(ctx.user) : null), codexBin: () => (opts.codexBin ? opts.codexBin(ctx.user) : null),
      ...(opts.run ? { run: opts.run } : {}), ...(opts.probe ? { probe: opts.probe } : {}),
    });
  } catch (e) {
    if (e instanceof K.Busy) throw new Refused(`${e.message}: try again in a moment`);
    throw e;
  }
  connectors('index.js').refresh({ vault: ctx.vault, cfg: ctx.cfg, env: ctx.env, home: ctx.home, now: opts.now || Date.now() });
  return { ok: true, checkedAt: live.checkedAt, durationMs: live.durationMs, hosts: live.hosts, rows: live.rows };
}

const MARK = { connected: '✔', failed: '✘', 'needs-auth': '!', pending: '⏸', off: '–', unknown: '?' };

function listLines(r) {
  const used = new Map(r.usage.map((u) => [`${u.host}\t${u.name}`, u]));
  const out = [`${r.rows.length} MCP servers and connectors (${Object.entries(r.hosts).filter(([, h]) => h.enabled).map(([h, x]) => `${HOST_LABEL[h]} ${x.rows}`).join(', ')})`];
  for (const x of r.rows) {
    const u = used.get(`${x.host}\t${x.name}`);
    const where = x.kind === 'connector' ? 'connector' : `${x.scope}${x.workspace ? ` · ${x.workspace}` : ''}`;
    out.push(`  ${x.host.padEnd(6)} ${x.name.padEnd(32)} ${where.padEnd(18)} ${x.enabled === false ? 'off' : (x.approval === 'pending' ? 'pending' : 'on ')}  ${u ? `${u.calls} calls` : ''}`);
  }
  const builtins = r.usage.filter((u) => u.builtin);
  if (builtins.length) out.push(`  built in, seen in use: ${builtins.map((u) => `${u.name} (${u.calls})`).join(', ')}`);
  return out;
}

function checkLines(r) {
  const out = [`checked in ${(r.durationMs / 1000).toFixed(1)} s`];
  for (const [h, x] of Object.entries(r.hosts)) if (x.enabled && !x.ran) out.push(`  ${HOST_LABEL[h]}: not checked (${x.error})`);
  for (const x of r.rows) {
    const tools = x.tools ? `${x.tools.length} tools` : '';
    out.push(`  ${MARK[x.status] || '?'} ${x.host.padEnd(6)} ${x.name.padEnd(32)} ${x.status.padEnd(10)} ${tools.padEnd(9)} ${x.detail || ''}`.trimEnd());
  }
  return out;
}

/** `argv` = the words after `aos mcp`. → exit code (a promise for `check`) */
function main(argv, opts = {}) {
  const io = opts.io || console;
  const args = parseMcpArgs(argv);
  const print = (r, toLines) => { if (args.json) io.log(JSON.stringify(r, null, 2)); else for (const l of toLines(r)) io.log(l); return 0; };
  if (args.verb === 'list') return print(list({ home: os.homedir(), ...opts }), listLines);
  if (args.verb === 'check') return checkNow({ home: os.homedir(), ...opts }).then((r) => print(r, checkLines));
  const o = { home: os.homedir(), ...opts };
  if (args.verb === 'add') return print(add(args, o), addLines);
  if (args.verb !== 'copy') return print(hostWrite(args, o), hostLines);
  return print(copy(args, o), lines);
}

module.exports = {
  main, copy, add, hostWrite, list, checkNow, parseMcpArgs, readEntry, normalize, targetCommand, redactArgs, scrub, backup, backupDir, backupName, configFileOf,
  planHash, planKey, keyDir, parkDir, readStash, envVarsLine,
  UsageError, Refused, USAGE, NAME_RE, VAR_RE, KEEP_BACKUPS, HIDDEN,
};
