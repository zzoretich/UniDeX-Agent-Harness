'use strict';
/**
 * recipe.js — the read-only grammar every proposal `recheck` recipe must pass before anything runs it
 * (docs/design/specs/2026-09-23-recipe-guard-design.md D1). ledger.runRecipe() is the one place recipes are
 * spawned (the tick's confirmations, the watchdog's verify, the flag-closer review), and it asks checkRecipe() first.
 *
 * A recipe is one or more pipelines joined by `&&` / `||`; a pipeline is simple commands joined by `|`, optionally led
 * by `!`. Each command starts with a read-only program from READ_ONLY; `git` takes only `-C <dir>` / `--no-pager`, a
 * read-only subcommand and none of the options that write files or run programs. Words are quoted as sh quotes them;
 * `$HOME` / `${HOME}` is the only expansion. Refused: `;`, `&`, redirections, subshells, backticks, other `$`
 * expansions, comments, newlines, variable assignments, and every program not listed. A refusal names its reason.
 */

const READ_ONLY = new Set(['true', 'false', 'exit', 'test', '[', 'grep', 'egrep', 'fgrep', 'ls', 'wc', 'head', 'tail', 'cat', 'cmp', 'diff', 'cut', 'tr', 'stat', 'git']);
const GIT_READ = new Set(['log', 'diff', 'show', 'status', 'ls-files', 'rev-parse', 'rev-list', 'cat-file', 'merge-base', 'describe']);
const GIT_REFUSED = /^(-c|--output(=.*)?|--ext-diff|--textconv|--exec-path(=.*)?|--config-env(=.*)?|--upload-pack(=.*)?|--receive-pack(=.*)?)$/;
const HOME_RE = /^\$(\{HOME\}|HOME(?![A-Za-z0-9_]))/;

class Refused extends Error {}
const refuse = (reason) => { throw new Refused(reason); };

/** Words and operators, as sh would split them; throws Refused on anything outside the grammar. */
function lex(src) {
  const out = [];
  let word = null;
  const add = (s) => { word = (word ?? '') + s; };
  const flush = () => { if (word !== null) { out.push({ word }); word = null; } };
  // A `$` that sh leaves literal (end of text, a blank, or the closing quote) stays text; $HOME is the only expansion.
  const home = (i, quoted) => {
    const next = src[i + 1];
    if (next === undefined || next === ' ' || next === '\t' || (quoted && next === '"')) { add('$'); return i + 1; }
    const m = HOME_RE.exec(src.slice(i));
    if (!m) refuse('a $ expansion other than $HOME');
    add('$HOME');
    return i + m[0].length;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { flush(); i++; }
    else if (c === '\n' || c === '\r') refuse('a newline');
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) refuse('an unclosed quote');
      add(src.slice(i + 1, j));
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      add('');
      for (;;) {
        if (j >= src.length) refuse('an unclosed quote');
        const d = src[j];
        if (d === '"') break;
        if (d === '`') refuse('a backtick');
        if (d === '$') { j = home(j, true); continue; }
        if (d === '\\' && '"\\$`'.includes(src[j + 1] ?? '')) { add(src[j + 1]); j += 2; continue; }
        add(d);
        j++;
      }
      i = j + 1;
    } else if (c === '\\') {
      if (i + 1 >= src.length) refuse('a trailing backslash');
      if (src[i + 1] === '\n') refuse('a newline');
      add(src[i + 1]);
      i += 2;
    } else if (c === '$') i = home(i, false);
    else if (c === '|') { flush(); if (src[i + 1] === '|') { out.push({ op: '||' }); i += 2; } else { out.push({ op: '|' }); i++; } }
    else if (c === '&') { flush(); if (src[i + 1] !== '&') refuse('a background &'); out.push({ op: '&&' }); i += 2; }
    else if (c === ';') refuse('a ;');
    else if (c === '<' || c === '>') refuse('a redirection');
    else if (c === '(' || c === ')') refuse('a subshell');
    else if (c === '`') refuse('a backtick');
    else if (c === '#' && word === null) refuse('a comment');
    else { add(c); i++; }
  }
  flush();
  return out;
}

function checkGit(args) {
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) {
    if (args[k] === '-C') { if (k + 1 >= args.length) refuse('git -C without a directory'); k += 2; }
    else if (args[k] === '--no-pager') k++;
    else refuse(`git option ${args[k]} before the subcommand`);
  }
  const sub = args[k];
  if (!sub) refuse('git without a subcommand');
  if (!GIT_READ.has(sub)) refuse(`git ${sub} is not a read-only git subcommand`);
  const bad = args.slice(k + 1).find((a) => GIT_REFUSED.test(a));
  if (bad) refuse(`git option ${bad}`);
}

function checkCommand(words) {
  if (!words.length) refuse('an empty command');
  const [cmd, ...args] = words;
  if (!READ_ONLY.has(cmd)) refuse(`'${cmd}' is not an allowed read-only command`);
  if (cmd === 'git') checkGit(args);
}

/** { ok: true } when the recipe is inside the read-only grammar, else { ok: false, reason }. */
function checkRecipe(cmd) {
  try {
    if (typeof cmd !== 'string' || !cmd.trim()) refuse('an empty recipe');
    const tokens = lex(cmd);
    let pipeline = [];
    let words = [];
    const endCommand = () => {
      if (words[0] === '!') {
        if (pipeline.length) refuse('a ! inside a pipeline');
        words = words.slice(1);
      }
      checkCommand(words);
      pipeline.push(words);
      words = [];
    };
    for (const t of tokens) {
      if (t.word !== undefined) { words.push(t.word); continue; }
      endCommand();
      if (t.op !== '|') pipeline = [];
    }
    endCommand();
    return { ok: true };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.message };
    throw e;
  }
}

module.exports = { READ_ONLY, GIT_READ, checkRecipe };
