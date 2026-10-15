'use strict';
// A world for the importer's tests (install-import B2–B10): a temp vault, a home with a fake Claude Code config folder
// and a fake Codex home copied from test/fixtures/import (CLAUDE.md, AGENTS.md, auto-memory, both hosts' MCP config),
// git repositories under ~/code, and session transcripts in both formats written relative to now, so the import window
// and the 14-day rule always hold. Not a test file itself.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures', 'import');
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function writeLines(file, rows, iso) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t = new Date(iso);
  fs.utimesSync(file, t, t);
  return file;
}

function gitRepo(dir) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

/**
 * opts: { claude = true, codex = true, now }. → { T, vault, home, claudeDir, codexHome, repos: { alpha, beta, notes },
 * cfg (agenticos.json-shaped), userConfig, env, at(days), claudeSession(o), codexSession(o), sessions: { … } }
 */
function makeWorld({ claude = true, codex = true, now = Date.now() } = {}) {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-import-')));
  const vault = path.join(T, 'vault');
  const home = path.join(T, 'home');
  const claudeDir = path.join(home, '.claude');
  const codexHome = path.join(home, '.codex');
  for (const d of ['brain/_index', 'brain/memory/user', 'brain/memory/feedback', 'brain/memory/projects', 'brain/memory/reference', 'brain/routines', 'workspaces']) {
    fs.mkdirSync(path.join(vault, d), { recursive: true });
  }
  fs.writeFileSync(path.join(vault, 'MEMORY.md'), '# Index\n\n## User\n\n## Feedback\n\n## Project\n\n## Reference\n');
  fs.writeFileSync(path.join(vault, 'AGENTICOS.md'), '# conventions\n');
  fs.writeFileSync(path.join(vault, 'brain', 'config.json'), JSON.stringify({ provider: 'none' }));
  fs.mkdirSync(home, { recursive: true });
  if (claude) {
    copyDir(path.join(FIXTURES, 'claude-config'), claudeDir);
    // The line the installer asks users to add: never imported.
    fs.appendFileSync(path.join(claudeDir, 'CLAUDE.md'), `\n@${path.join(vault, 'AGENTICOS.md')}\n`);
  } else fs.mkdirSync(claudeDir, { recursive: true });
  if (codex) copyDir(path.join(FIXTURES, 'codex-home'), codexHome);
  else fs.mkdirSync(codexHome, { recursive: true });
  const repos = {
    alpha: gitRepo(path.join(home, 'code', 'alpha')),
    beta: gitRepo(path.join(home, 'code', 'beta')),
    notes: path.join(home, 'notes'),
  };
  fs.mkdirSync(repos.notes, { recursive: true });
  fs.mkdirSync(path.join(repos.alpha, 'src'), { recursive: true });

  const at = (days, hours = 0) => new Date(now - days * DAY - hours * 60 * 60 * 1000).toISOString();
  const uuid = () => `0199bbbb-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

  const claudeSession = ({ id = uuid(), cwd, days, prompt = 'Fix the failing parser test', reply = 'Fixed the off-by-one and the test passes.', entrypoint = 'cli', title = null } = {}) => {
    const ts = at(days);
    const rows = [
      { type: 'user', sessionId: id, cwd, timestamp: ts, entrypoint, message: { role: 'user', content: prompt } },
      { type: 'assistant', sessionId: id, cwd, timestamp: ts, message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: reply }] } },
      { type: 'user', sessionId: id, cwd, timestamp: ts, message: { role: 'user', content: 'Great, always add a regression test for parser bugs.' } },
    ];
    if (title) rows.push({ type: 'custom-title', customTitle: title, sessionId: id });
    const file = writeLines(path.join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`), rows, ts);
    return { id, file, cwd, ts };
  };

  const codexSession = ({ id = uuid(), cwd, days, prompt = 'Add pagination to the list endpoint', reply = 'Added cursor pagination with tests.', source = 'cli' } = {}) => {
    const ts = at(days);
    const d = new Date(ts);
    const dir = path.join(codexHome, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    const rows = [
      { timestamp: ts, type: 'session_meta', payload: { id, timestamp: ts, cwd, source, cli_version: '0.0.0' } },
      { timestamp: ts, type: 'turn_context', payload: { cwd, model: 'gpt-test' } },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] } },
    ];
    const file = writeLines(path.join(dir, `rollout-${ts.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`), rows, ts);
    return { id, file, cwd, ts };
  };

  const sessions = {};
  if (claude) {
    sessions.alpha1 = claudeSession({ cwd: repos.alpha, days: 5, title: 'Parser fixes' });
    sessions.alpha2 = claudeSession({ cwd: path.join(repos.alpha, 'src'), days: 20 });
    sessions.alpha3 = claudeSession({ cwd: repos.alpha, days: 40 });
    sessions.notes = claudeSession({ cwd: repos.notes, days: 3 });
    sessions.headless = claudeSession({ cwd: repos.alpha, days: 4, entrypoint: 'sdk-cli' });
    sessions.old = claudeSession({ cwd: repos.alpha, days: 120 });
  }
  if (codex) {
    sessions.beta1 = codexSession({ cwd: repos.beta, days: 2 });
    sessions.alphaCx = codexSession({ cwd: repos.alpha, days: 8 });
    sessions.exec = codexSession({ cwd: repos.beta, days: 1, source: 'exec' });
  }

  const userConfig = {
    vault, claudeConfigDir: claudeDir,
    hosts: { claude: { enabled: claude, configDir: claudeDir }, codex: { enabled: codex, home: codexHome } },
  };
  const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome };
  return { T, vault, home, claudeDir, codexHome, repos, userConfig, env, at, now, claudeSession, codexSession, sessions, tmpDirs: [path.join(T, 'tmp')], gitCeiling: T };
}

/** A fake local engine: provider-shaped, answering the classifier and the digest from `answers` (or a default). */
function fakeEngine({ classify = null, digest = null, fail = null, embed = false } = {}) {
  const calls = [];
  return {
    calls,
    provider: async () => ({
      name: 'ollama', engine: 'ollama', model: 'qwen-test', reason: 'local-ready',
      capabilities: { chat: true, embed, structured: true },
      embed: async (texts) => texts.map(() => [1, 0, 0]),
      chat: async (o) => {
        calls.push(o);
        if (fail) throw fail;
        if (o.feature === 'import') {
          const n = (String(o.prompt).match(/^\d+\. /gm) || []).length;
          return JSON.stringify({ types: classify ? classify(o, n) : Array.from({ length: n }, (_, i) => (i === 0 ? 'user' : i % 3 === 0 ? 'reference' : 'feedback')) });
        }
        return JSON.stringify(digest ? digest(o) : {
          summary: 'Fixed a parser bug and added a regression test.',
          workspace: null,
          memories: [{ type: 'feedback', title: 'Add a regression test for parser bugs', description: 'Every parser bug fix comes with a regression test', body: 'Add a regression test with every parser bug fix.\n\n**Why:** the owner asked for it.\n**How to apply:** write the failing test first.' }],
        });
      },
    }),
  };
}

module.exports = { makeWorld, fakeEngine, DAY };
