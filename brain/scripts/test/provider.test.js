'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
fs.mkdirSync(path.join(TMP, 'brain', '_index'), { recursive: true });
process.env.BRAIN_VAULT = TMP;
process.env.AOS_CONFIG = path.join(TMP, 'no-agenticos.json');
const provider = require('../sdk/lib/provider.js');
const { STATE_PATH, resolveProvider, getProvider, resetProviderCache, recordSpend, spendToday, ProviderUnavailable, SPEND_PATH } = provider;
const { role, providerFor } = require('../sdk/lib/models.js');

const CONFIG = path.join(TMP, 'brain', 'config.json');
const never = async () => { throw new Error('must not be called'); };
const spent = () => recordSpend({ feature: 't', provider: 'claude', model: 'haiku', usd: 0.5, inputTokens: 1, outputTokens: 1, ms: 1 });

beforeEach(() => {
  resetProviderCache();
  for (const f of [STATE_PATH, SPEND_PATH]) { try { fs.unlinkSync(f); } catch {} }
  fs.writeFileSync(CONFIG, '{}');
});

test('auto: reachable Ollama wins and the state file records the ping', async () => {
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => true, resolveClaudeBin: never, loginProbe: never } });
  assert.equal(p.name, 'ollama');
  assert.equal(p.reason, 'ollama-reachable');
  assert.deepEqual(p.capabilities, { chat: true, embed: true, structured: true });
  const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  assert.equal(st.name, 'ollama');
  assert.equal(st.ollama.reachable, true);
  assert.ok(Date.parse(st.ollama.checkedAt) > 0);
  assert.ok(Date.parse(st.checkedAt) > 0);
});

test('auto: no Ollama, no claude binary → none / no-provider; chat, embed, ping all say no', async () => {
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => null, loginProbe: never } });
  assert.equal(p.name, 'none');
  assert.equal(p.reason, 'no-provider');
  assert.deepEqual(p.capabilities, { chat: false, embed: false, structured: false });
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e instanceof ProviderUnavailable && e.code === 'PROVIDER_NONE' && e.provider === 'none');
  await assert.rejects(() => p.embed(['x']), (e) => e.code === 'PROVIDER_NONE');
  assert.equal(await p.ping(), false);
});

test('auto: claude present but not logged in → none / claude-not-logged-in, and the probe is cached for 24h', async () => {
  let probeOpts;
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => '/home/alice/.local/bin/claude', loginProbe: async (o) => { probeOpts = o; return false; } } });
  assert.equal(p.name, 'none');
  assert.equal(p.reason, 'claude-not-logged-in');
  assert.equal(probeOpts.timeoutMs, 10000, 'hook-sized cap, not loginProbe\'s 60 s default');
  const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  assert.equal(st.claude.loggedIn, false);
  assert.equal(st.claude.bin, '/home/alice/.local/bin/claude');
  let probes = 0;
  const again = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => { probes++; return '/x'; }, loginProbe: async () => { probes++; return true; } } });
  assert.equal(probes, 0, 'fresh state → no probe');
  assert.equal(again.name, 'none');
});

test('auto: logged-in claude → claude provider; chat maps format json → schema and returns structured output as text', async () => {
  const calls = [];
  const fakeCall = async (o) => { calls.push(o); return { text: 'plain', structured: { ok: 1 }, usd: 0.003, usage: {}, ms: 5 }; };
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => '/x/claude', loginProbe: async () => true, claudeCall: fakeCall } });
  assert.equal(p.name, 'claude');
  assert.equal(p.reason, 'claude-logged-in');
  assert.deepEqual(p.capabilities, { chat: true, embed: false, structured: true });
  assert.equal(await p.ping(), true);
  const out = await p.chat({ system: 'sys', prompt: 'hi', format: 'json', feature: 'auto-wrap', numPredict: 2048, model: 'ignored', think: false });
  assert.equal(out, '{"ok":1}');
  assert.deepEqual(calls[0].schema, { type: 'object' });
  assert.equal(calls[0].system, 'sys');
  assert.equal(calls[0].prompt, 'hi');
  assert.equal(calls[0].model, 'haiku');
  assert.equal(calls[0].maxBudgetUsd, 0.05);
  assert.equal(calls[0].feature, 'auto-wrap');
  const plain = await p.chat({ messages: [{ role: 'user', content: 'yo' }] });
  assert.equal(plain, 'plain');
  assert.equal(calls[1].prompt, 'user: yo');
  assert.equal(calls[1].schema, undefined);
  const explicit = await p.chat({ prompt: 'x', schema: { type: 'object', properties: { a: { type: 'string' } } } });
  assert.equal(explicit, '{"ok":1}');
  assert.deepEqual(calls[2].schema, { type: 'object', properties: { a: { type: 'string' } } });
  await assert.rejects(() => p.embed(['x']), (e) => e.code === 'PROVIDER_NONE' && e.provider === 'claude');
});

test('config.ollama host/port reaches the ping seam', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ ollama: { host: '10.0.0.9', port: 4242 } }));
  const pings = [];
  const p = await resolveProvider({
    mode: 'auto',
    deps: { ping: async (...args) => { pings.push(args); return false; }, resolveClaudeBin: () => null, loginProbe: never },
  });
  assert.equal(p.name, 'none');
  assert.deepEqual(pings, [[2000, { host: '10.0.0.9', port: 4242 }]]);
});

test('forced ollama / none skip every probe; forced claude still runs the login probe', async () => {
  let pings = 0, probes = 0;
  const deps = { ping: async () => { pings++; return false; }, resolveClaudeBin: () => '/x', loginProbe: async () => { probes++; return true; } };
  const o = await resolveProvider({ mode: 'ollama', deps });
  assert.equal(o.name, 'ollama'); assert.equal(o.reason, 'forced');
  const n = await resolveProvider({ mode: 'none', deps });
  assert.equal(n.name, 'none'); assert.equal(n.reason, 'forced');
  assert.equal(pings, 0); assert.equal(probes, 0);
  const c = await resolveProvider({ mode: 'claude', deps });
  assert.equal(c.name, 'claude'); assert.equal(c.reason, 'forced');
  assert.equal(probes, 1); assert.equal(pings, 0);
});

test('daily cap: spend at or over perDayUsd resolves claude to none / daily-cap', async () => {
  spent();
  assert.equal(spendToday(), 0.5);
  const p = await resolveProvider({ mode: 'claude', deps: { resolveClaudeBin: () => '/x', loginProbe: async () => true } });
  assert.equal(p.name, 'none');
  assert.equal(p.reason, 'daily-cap');
});

test('a claude chat that would cross the cap mid-day throws PROVIDER_CAP without spawning', async () => {
  const p = await resolveProvider({ mode: 'claude', deps: { resolveClaudeBin: () => '/x', loginProbe: async () => true, claudeCall: never } });
  spent();
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e instanceof ProviderUnavailable && e.code === 'PROVIDER_CAP');
});

test('duty:* ledger rows never trip the hook cap — persona spend is gated by persona.perDayUsd, not claude.perDayUsd', async () => {
  // Plan 5's run-duty.sh writes feature "duty:<name>" rows (up to $2 each) into the same ledger;
  // the first duty of the day must not turn every hook into none/daily-cap.
  recordSpend({ feature: 'duty:monitor', provider: 'claude', model: 'haiku', usd: 1.9, inputTokens: 1, outputTokens: 1, ms: 1 });
  assert.equal(spendToday(), 0);
  const calls = [];
  const fakeCall = async (o) => { calls.push(o); return { text: 'ok', structured: null, usd: 0.001, usage: {}, ms: 1 }; };
  const p = await resolveProvider({ mode: 'claude', deps: { resolveClaudeBin: () => '/x', loginProbe: async () => true, claudeCall: fakeCall } });
  assert.equal(p.name, 'claude');
  assert.equal(p.reason, 'forced');
  assert.equal(await p.chat({ prompt: 'x', feature: 'session-summary' }), 'ok');
  assert.equal(calls.length, 1);
});

test('a fresh ollama state entry (< 60 s) is reused without pinging', async () => {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ollama: { reachable: true, checkedAt: new Date().toISOString() } }));
  const p = await resolveProvider({ mode: 'auto', deps: { ping: never, resolveClaudeBin: never, loginProbe: never } });
  assert.equal(p.name, 'ollama');
});

test('a stale ollama state entry (> 60 s) is re-pinged', async () => {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ollama: { reachable: true, checkedAt: new Date(Date.now() - 61_000).toISOString() } }));
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => null } });
  assert.equal(p.name, 'none');
});

test('getProvider memoizes per process and takes the mode from config', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  const a = await getProvider('x');
  const b = await getProvider('y');
  assert.equal(a, b);
  assert.equal(a.name, 'none');
  assert.equal(a.reason, 'forced');
});

test('models.js knows the claude role and maps roles to providers', () => {
  assert.equal(role('claude').tag, 'haiku');
  assert.equal(providerFor('claude'), 'claude');
  assert.equal(providerFor('workhorse'), 'ollama');
  assert.equal(providerFor('embedder'), 'ollama');
});

// ---- per-role routing (the reasoner is a Claude model whatever the global provider says) ----
const { resolveProviderForRole, getProviderForRole, reasonSpendToday } = provider;
const loggedIn = { resolveClaudeBin: () => '/x/claude', loginProbe: async () => true };

test('reasoner: resolves claude with reasoner.model and caps while Ollama is up; the state file keeps naming the global provider', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'auto', reasoner: { model: 'claude-sonnet-5', perCallUsd: 0.75, perDayUsd: 9, effort: 'high' } }));
  const g = await resolveProvider({ mode: 'auto', deps: { ping: async () => true, ...loggedIn } });
  assert.equal(g.name, 'ollama');
  const calls = [];
  const fakeCall = async (o) => { calls.push(o); return { text: 'deep', structured: null, usd: 0.2, usage: {}, ms: 1 }; };
  const p = await resolveProviderForRole({ role: 'reasoner', deps: { ping: never, ...loggedIn, claudeCall: fakeCall } });
  assert.equal(p.name, 'claude');
  assert.equal(p.reason, 'role:reasoner');
  assert.equal(p.model, 'claude-sonnet-5');
  assert.equal(await p.chat({ system: 's', prompt: 'why?', feature: 'reason:ask' }), 'deep');
  assert.equal(calls[0].model, 'claude-sonnet-5');
  assert.equal(calls[0].maxBudgetUsd, 0.75);
  assert.equal(calls[0].effort, 'high', 'reasoner.effort is the default dial');
  assert.equal(calls[0].feature, 'reason:ask');
  await p.chat({ prompt: 'x', think: 'low' });
  assert.equal(calls[1].effort, 'low', 'the caller\'s think level wins over the config default');
  const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  assert.equal(st.name, 'ollama', 'a role resolution never rewrites the global name');
  assert.equal(st.claude.loggedIn, true, 'but the login probe cache is shared');
});

test('reasoner: defaults are claude-opus-5 at 0.5/5 with medium effort', async () => {
  const calls = [];
  const fakeCall = async (o) => { calls.push(o); return { text: 'ok', structured: null, usd: 0, usage: {}, ms: 1 }; };
  const p = await resolveProviderForRole({ role: 'reasoner', deps: { ...loggedIn, claudeCall: fakeCall } });
  await p.chat({ prompt: 'x' });
  assert.equal(p.model, 'claude-opus-5');
  assert.equal(calls[0].model, 'claude-opus-5');
  assert.equal(calls[0].maxBudgetUsd, 0.5);
  assert.equal(calls[0].effort, 'medium');
});

test('reasoner: provider none disables it; not logged in → none; no binary → none', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  let p = await resolveProviderForRole({ role: 'reasoner', deps: { resolveClaudeBin: never, loginProbe: never } });
  assert.equal(p.name, 'none'); assert.equal(p.reason, 'forced');
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'ollama' }));
  p = await resolveProviderForRole({ role: 'reasoner', deps: { resolveClaudeBin: () => '/x', loginProbe: async () => false } });
  assert.equal(p.name, 'none'); assert.equal(p.reason, 'claude-not-logged-in');
  try { fs.unlinkSync(STATE_PATH); } catch {}
  p = await resolveProviderForRole({ role: 'reasoner', deps: { resolveClaudeBin: () => null, loginProbe: never } });
  assert.equal(p.name, 'none'); assert.equal(p.reason, 'no-provider');
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e.code === 'PROVIDER_NONE');
});

test('reasoner cap: reason:* spend at or over reasoner.perDayUsd → none / reasoner-daily-cap; hook and duty rows do not count', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ reasoner: { perDayUsd: 1 } }));
  recordSpend({ feature: 'session-summary', provider: 'claude', model: 'haiku', usd: 0.49, inputTokens: 1, outputTokens: 1, ms: 1 });
  recordSpend({ feature: 'duty:monitor', provider: 'claude', model: 'haiku', usd: 1.9, inputTokens: 1, outputTokens: 1, ms: 1 });
  let p = await resolveProviderForRole({ role: 'reasoner', deps: { ...loggedIn, claudeCall: async () => ({ text: 'ok', structured: null, usd: 0, usage: {}, ms: 1 }) } });
  assert.equal(p.name, 'claude');
  assert.equal(await p.chat({ prompt: 'x' }), 'ok');
  recordSpend({ feature: 'reason:ask', provider: 'claude', model: 'claude-opus-5', usd: 1, inputTokens: 1, outputTokens: 1, ms: 1 });
  assert.equal(reasonSpendToday(), 1);
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e.code === 'PROVIDER_CAP' && /reasoner\.perDayUsd/.test(e.message));
  p = await resolveProviderForRole({ role: 'reasoner', deps: loggedIn });
  assert.equal(p.name, 'none'); assert.equal(p.reason, 'reasoner-daily-cap');
  // and the hook cap is untouched by that reason:* row
  const hook = await resolveProvider({ mode: 'claude', deps: { ...loggedIn, claudeCall: never } });
  assert.equal(hook.name, 'claude');
  assert.equal(spendToday(), 0.49);
});

test('hook provider: reason:* rows never trip claude.perDayUsd, and its PROVIDER_CAP names claude.perDayUsd', async () => {
  recordSpend({ feature: 'reason:reflect-week', provider: 'claude', model: 'claude-opus-5', usd: 4, inputTokens: 1, outputTokens: 1, ms: 1 });
  const p = await resolveProvider({ mode: 'claude', deps: { ...loggedIn, claudeCall: never } });
  assert.equal(p.name, 'claude');
  spent();
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e.code === 'PROVIDER_CAP' && /claude\.perDayUsd/.test(e.message));
});

test('getProviderForRole: Ollama-served roles share getProvider\'s promise; the reasoner is memoized separately', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'ollama' }));
  const w = getProviderForRole('workhorse', 'auto-wrap');
  assert.equal(w, getProvider('auto-wrap'));
  assert.equal((await w).name, 'ollama');
  const r1 = getProviderForRole('reasoner', 'ask');
  const r2 = getProviderForRole('reasoner', 'reflect-week');
  assert.equal(r1, r2);
  assert.notEqual(r1, w);
  resetProviderCache();
  assert.notEqual(getProviderForRole('reasoner', 'ask'), r1);
});

// ── codex: the third leg of the auto chain, joined only when Codex is a configured host ──────────
const codexOn = () => fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { codex: { enabled: true } } }));

test('auto: no Ollama, no claude, Codex unconfigured → none / no-provider and the codex probe never runs', async () => {
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => null, loginProbe: never, resolveCodexBin: never, codexLoginProbe: never } });
  assert.equal(p.name, 'none');
  assert.equal(p.reason, 'no-provider');
});

test('auto: no claude, Codex configured and logged in → codex provider; chat goes through codexCall with the codex budget', async () => {
  codexOn();
  const calls = [];
  const fakeCall = async (o) => { calls.push(o); return { text: 'plain', structured: { ok: 1 }, usd: 0.001, usage: {}, ms: 3, model: 'gpt-5' }; };
  let probeOpts;
  const p = await resolveProvider({ mode: 'auto', deps: {
    ping: async () => false, resolveClaudeBin: () => null, loginProbe: never,
    resolveCodexBin: () => '/x/codex', codexLoginProbe: async (o) => { probeOpts = o; return true; }, codexCall: fakeCall,
  } });
  assert.equal(p.name, 'codex');
  assert.equal(p.reason, 'codex-logged-in');
  assert.equal(p.model, null, 'no codex.model → the user\'s Codex default');
  assert.deepEqual(p.capabilities, { chat: true, embed: false, structured: true });
  assert.equal(probeOpts.timeoutMs, 10000);
  const out = await p.chat({ system: 'sys', prompt: 'hi', format: 'json', feature: 'auto-wrap', think: 'xhigh' });
  assert.equal(out, '{"ok":1}');
  assert.deepEqual(calls[0].schema, { type: 'object' });
  assert.equal(calls[0].model, null);
  assert.equal(calls[0].effort, 'xhigh');
  assert.equal(calls[0].feature, 'auto-wrap');
  await assert.rejects(() => p.embed(['x']), (e) => e.code === 'PROVIDER_NONE' && e.provider === 'codex');
  const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  assert.equal(st.name, 'codex');
  assert.equal(st.codex.loggedIn, true);
  assert.equal(st.codex.bin, '/x/codex');
});

test('auto: claude present but not logged in, Codex configured but not logged in → none / codex-not-logged-in (cached 24h)', async () => {
  codexOn();
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => '/x/claude', loginProbe: async () => false, resolveCodexBin: () => '/x/codex', codexLoginProbe: async () => false } });
  assert.equal(p.name, 'none');
  assert.equal(p.reason, 'codex-not-logged-in');
  let probes = 0;
  const again = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => '/x/claude', loginProbe: async () => false, resolveCodexBin: () => { probes++; return '/x'; }, codexLoginProbe: async () => { probes++; return true; } } });
  assert.equal(probes, 0, 'fresh codex state → no probe');
  assert.equal(again.name, 'none');
});

test('auto: Codex configured but no codex binary → the claude reason survives; logged-in claude still wins over codex', async () => {
  // Both hosts, as aos init writes them (a hosts block without a claude entry is a Claude host turned off).
  fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { claude: { enabled: true }, codex: { enabled: true } } }));
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => '/x/claude', loginProbe: async () => false, resolveCodexBin: () => null, codexLoginProbe: never } });
  assert.equal(p.reason, 'claude-not-logged-in');
  try { fs.unlinkSync(STATE_PATH); } catch {} // drop the cached "not logged in" verdict from the call above
  const c = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => '/x/claude', loginProbe: async () => true, resolveCodexBin: never, codexLoginProbe: never } });
  assert.equal(c.name, 'claude');
});

// install-import B2 (inspection F1): only a host the user enabled may spend. A signed-in claude on a Codex-only install, or
// on one installed with --host none, is never asked, let alone called; `provider: claude` still names it explicitly.
const noClaude = { resolveClaudeBin: never, loginProbe: never, claudeCall: never };

test('auto on a Codex-only install: a signed-in claude is never probed or called; Codex answers, else none', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { claude: { enabled: false }, codex: { enabled: true } } }));
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, ...noClaude, resolveCodexBin: () => '/x/codex', codexLoginProbe: async () => true } });
  assert.deepEqual([p.name, p.reason], ['codex', 'codex-logged-in']);
  fs.unlinkSync(STATE_PATH);
  const out = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, ...noClaude, resolveCodexBin: () => '/x/codex', codexLoginProbe: async () => false } });
  assert.deepEqual([out.name, out.reason], ['none', 'codex-not-logged-in']);
  assert.equal(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).claude, undefined, 'no Claude login was even looked up');
});

test('no host enabled (aos init --host none): auto, and local with its hosted fallback, call no hosted model', async () => {
  const none = { hosts: { claude: { enabled: false }, codex: { enabled: false } } };
  fs.writeFileSync(CONFIG, JSON.stringify(none));
  const p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, ...noClaude, resolveCodexBin: never, codexLoginProbe: never } });
  assert.deepEqual([p.name, p.reason], ['none', 'no-provider']);
  fs.unlinkSync(STATE_PATH);
  fs.writeFileSync(CONFIG, JSON.stringify({ ...none, provider: 'local', local: { hostedFallback: true } }));
  const local = await resolveProvider({ deps: { localModels: async () => null, ...noClaude, resolveCodexBin: never, codexLoginProbe: never } });
  assert.deepEqual([local.name, local.reason], ['none', 'local-down']);
  // A hook-budget role through resolveProviderForRole skips the disabled host too.
  fs.writeFileSync(CONFIG, JSON.stringify(none));
  const r = await provider.resolveProviderForRole({ role: 'claude', deps: { ...noClaude, resolveCodexBin: never, codexLoginProbe: never } });
  assert.deepEqual([r.name, r.reason], ['none', 'no-provider']);
});

test('provider claude names the host itself: it is still used when hosts.claude is off', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { claude: { enabled: false }, codex: { enabled: false } } }));
  const p = await resolveProvider({ mode: 'claude', deps: { ping: never, ...loggedIn } });
  assert.deepEqual([p.name, p.reason], ['claude', 'forced']);
});

test('forced codex: skips Ollama and claude, honours the codex daily cap with its own cap key', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ codex: { perDayUsd: 0.2 } }));
  const p = await resolveProvider({ mode: 'codex', deps: { ping: never, resolveClaudeBin: never, loginProbe: never, resolveCodexBin: () => '/x/codex', codexLoginProbe: async () => true } });
  assert.equal(p.name, 'codex');
  assert.equal(p.reason, 'forced');
  recordSpend({ feature: 'hook', provider: 'codex', model: 'gpt-5', usd: 0.2, inputTokens: 1, outputTokens: 1, ms: 1 });
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e.code === 'PROVIDER_CAP' && e.provider === 'codex' && /codex\.perDayUsd/.test(e.message));
  for (const f of [STATE_PATH]) { try { fs.unlinkSync(f); } catch {} }
  const capped = await resolveProvider({ mode: 'codex', deps: { ping: never, resolveClaudeBin: never, loginProbe: never, resolveCodexBin: () => '/x/codex', codexLoginProbe: async () => true } });
  assert.equal(capped.name, 'none');
  assert.equal(capped.reason, 'daily-cap');
});

// ---- the reasoner and the hook budget under Codex (spec 2026-09-23-codex-parity-gaps D1, D2) ----
const codexLoggedIn = { resolveCodexBin: () => '/x/codex', codexLoginProbe: async () => true };
const replyCall = (calls) => async (o) => { calls.push(o); return { text: 'deep', structured: null, usd: 0.01, usage: {}, ms: 1, model: 'gpt-5' }; };

test('reasoner on a Codex-only machine: codex with the reasoner caps, reasoner.codexModel, reasoner.effort, reason:* ledger family', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { claude: { enabled: false }, codex: { enabled: true } }, codex: { model: 'gpt-5-mini' }, reasoner: { codexModel: 'gpt-5', effort: 'high', perDayUsd: 2 } }));
  const calls = [];
  const p = await resolveProviderForRole({ role: 'reasoner', deps: { resolveClaudeBin: never, loginProbe: never, ...codexLoggedIn, codexCall: replyCall(calls) } });
  assert.equal(p.name, 'codex');
  assert.equal(p.reason, 'role:reasoner');
  assert.equal(p.model, 'gpt-5');
  assert.equal(await p.chat({ prompt: 'why?', feature: 'reason:ask' }), 'deep');
  assert.equal(calls[0].model, 'gpt-5');
  assert.equal(calls[0].effort, 'high');
  assert.equal(calls[0].feature, 'reason:ask');
  recordSpend({ feature: 'reason:ask', provider: 'codex', model: 'gpt-5', usd: 2, inputTokens: 1, outputTokens: 1, ms: 1 });
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e.code === 'PROVIDER_CAP' && /reasoner\.perDayUsd/.test(e.message));
  const capped = await resolveProviderForRole({ role: 'reasoner', deps: { resolveClaudeBin: never, loginProbe: never, ...codexLoggedIn } });
  assert.equal(capped.name, 'none'); assert.equal(capped.reason, 'reasoner-daily-cap');
});

test('reasoner with both hosts: Claude first; Codex when Claude is not logged in; Codex first under provider codex; no reasoner.codexModel → codex.model', async () => {
  const both = (extra = {}) => fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { claude: { enabled: true }, codex: { enabled: true } }, codex: { model: 'gpt-5-mini' }, ...extra }));
  both();
  let p = await resolveProviderForRole({ role: 'reasoner', deps: { ...loggedIn, resolveCodexBin: never, codexLoginProbe: never } });
  assert.equal(p.name, 'claude');
  try { fs.unlinkSync(STATE_PATH); } catch {}
  p = await resolveProviderForRole({ role: 'reasoner', deps: { resolveClaudeBin: () => '/x/claude', loginProbe: async () => false, ...codexLoggedIn } });
  assert.equal(p.name, 'codex');
  assert.equal(p.model, 'gpt-5-mini');
  try { fs.unlinkSync(STATE_PATH); } catch {}
  both({ provider: 'codex' });
  p = await resolveProviderForRole({ role: 'reasoner', deps: { resolveClaudeBin: never, loginProbe: never, ...codexLoggedIn } });
  assert.equal(p.name, 'codex', 'an explicit provider codex puts Codex first');
  try { fs.unlinkSync(STATE_PATH); } catch {}
  both();
  p = await resolveProviderForRole({ role: 'reasoner', deps: { resolveClaudeBin: () => null, loginProbe: never, resolveCodexBin: () => '/x/codex', codexLoginProbe: async () => false } });
  assert.equal(p.name, 'none'); assert.equal(p.reason, 'codex-not-logged-in');
});

test('codex hook calls without a think level use codex.effort, default low, never the user\'s Codex default', async () => {
  codexOn();
  const calls = [];
  const deps = { ping: async () => false, resolveClaudeBin: () => null, loginProbe: never, ...codexLoggedIn, codexCall: replyCall(calls) };
  let p = await resolveProvider({ mode: 'auto', deps });
  await p.chat({ prompt: 'summarise' });
  assert.equal(calls[0].effort, 'low');
  fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { codex: { enabled: true } }, codex: { effort: 'minimal' } }));
  resetProviderCache();
  p = await resolveProvider({ mode: 'auto', deps });
  await p.chat({ prompt: 'summarise' });
  assert.equal(calls[1].effort, 'minimal');
});

test('a daily cap of 0 means no spend (spec 2026-09-24-aos-config D10): codex and the reasoner resolve to none before any call', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ codex: { perDayUsd: 0 }, reasoner: { perDayUsd: 0 } }));
  const c = await resolveProvider({ mode: 'codex', deps: { ping: never, resolveClaudeBin: never, loginProbe: never, resolveCodexBin: () => '/x/codex', codexLoginProbe: async () => true } });
  assert.equal(c.name, 'none');
  assert.equal(c.reason, 'daily-cap');
  const r = await resolveProviderForRole({ role: 'reasoner', deps: { ...loggedIn, claudeCall: never } });
  assert.equal(r.name, 'none');
  assert.equal(r.reason, 'reasoner-daily-cap');
});

test('reasoner with a chosen host, model and effort (Vault chat, sessions-ux U9): only that host, and the effort is fixed', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { claude: { enabled: true }, codex: { enabled: true } }, reasoner: { model: 'claude-opus-5', codexModel: 'gpt-5', effort: 'medium' } }));
  const calls = [];
  let p = await resolveProviderForRole({ role: 'reasoner', prefer: 'codex', model: 'gpt-6-luna', effort: 'xhigh', deps: { resolveClaudeBin: never, loginProbe: never, ...codexLoggedIn, codexCall: replyCall(calls) } });
  assert.equal(p.name, 'codex', 'Codex although Claude is the usual first choice');
  assert.equal(p.model, 'gpt-6-luna');
  await p.chat({ prompt: 'x', think: 'low' });
  assert.deepEqual([calls[0].model, calls[0].effort], ['gpt-6-luna', 'xhigh'], 'a caller\'s think never overrides the chosen effort');

  const claudeCalls = [];
  p = await resolveProviderForRole({ role: 'reasoner', prefer: 'claude', model: 'sonnet', effort: 'high', deps: { ...loggedIn, resolveCodexBin: never, codexLoginProbe: never, claudeCall: replyCall(claudeCalls) } });
  await p.chat({ prompt: 'x', think: 'low' });
  assert.deepEqual([p.name, claudeCalls[0].model, claudeCalls[0].effort], ['claude', 'sonnet', 'high']);

  fs.unlinkSync(STATE_PATH);   // the login checks above are cached for a day
  p = await resolveProviderForRole({ role: 'reasoner', prefer: 'claude', deps: { resolveClaudeBin: () => '/x/claude', loginProbe: async () => false, ...codexLoggedIn } });
  assert.deepEqual([p.name, p.reason], ['none', 'claude-not-logged-in'], 'a chosen host that cannot answer is not swapped for the other');

  fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { claude: { enabled: true } } }));
  p = await resolveProviderForRole({ role: 'reasoner', prefer: 'codex', deps: { resolveClaudeBin: never, loginProbe: never, resolveCodexBin: never, codexLoginProbe: never } });
  assert.deepEqual([p.name, p.reason], ['none', 'codex-not-configured']);

  const ignored = [];
  fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { codex: { enabled: true } } }));
  p = await resolveProviderForRole({ role: 'reasoner', prefer: 'codex', effort: 'ultra', deps: { resolveClaudeBin: never, loginProbe: never, ...codexLoggedIn, codexCall: replyCall(ignored) } });
  await p.chat({ prompt: 'x' });
  assert.notEqual(ignored[0].effort, 'ultra', 'a level the wrapper does not take is not forced through');
});

// ---- hostOpts: a model and an effort per host (brain-ai A6, the memory sweep: the reasoner's caps on the background models) ----
const sweepOpts = { claude: { model: 'haiku', effort: null }, codex: { model: 'gpt-5-mini', effort: 'low' } };
const bothHosts = (extra = {}) => fs.writeFileSync(CONFIG, JSON.stringify({
  hosts: { claude: { enabled: true }, codex: { enabled: true } }, reasoner: { model: 'claude-opus-5', codexModel: 'gpt-5', effort: 'high', perCallUsd: 0.6, perDayUsd: 4 }, ...extra,
}));

test('hostOpts on Claude: its model replaces the reasoner\'s, effort null sends no --effort whatever think says, the reasoner caps stay', async () => {
  bothHosts();
  const calls = [];
  const p = await resolveProviderForRole({ role: 'reasoner', feature: 'reason:memory-sweep', hostOpts: sweepOpts, deps: { ...loggedIn, resolveCodexBin: never, codexLoginProbe: never, claudeCall: replyCall(calls) } });
  assert.deepEqual([p.name, p.reason, p.model], ['claude', 'role:reasoner', 'haiku']);
  await p.chat({ prompt: 'x', feature: 'reason:memory-sweep' });
  await p.chat({ prompt: 'x', think: 'high' });
  assert.equal(calls[0].model, 'haiku');
  assert.equal(calls[0].effort, undefined, 'no --effort: reasoner.effort (high) is not used');
  assert.equal(calls[1].effort, undefined, 'a caller\'s think never adds one');
  assert.equal(calls[0].maxBudgetUsd, 0.6, 'reasoner.perCallUsd, not claude.perCallUsd');
  assert.equal(calls[0].feature, 'reason:memory-sweep');
  recordSpend({ feature: 'reason:memory-sweep', provider: 'claude', model: 'haiku', usd: 4, inputTokens: 1, outputTokens: 1, ms: 1 });
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e.code === 'PROVIDER_CAP' && /reasoner\.perDayUsd/.test(e.message), 'the reasoner day cap');
  assert.equal(spendToday(), 0, 'a reason:* row never counts against the hook cap');
});

test('hostOpts on Codex: its model and level, fixed; the reasoner\'s codexModel and effort are not used', async () => {
  bothHosts();
  const calls = [];
  const p = await resolveProviderForRole({ role: 'reasoner', hostOpts: sweepOpts, deps: { resolveClaudeBin: () => '/x/claude', loginProbe: async () => false, ...codexLoggedIn, codexCall: replyCall(calls) } });
  assert.deepEqual([p.name, p.model], ['codex', 'gpt-5-mini']);
  await p.chat({ prompt: 'x', think: 'xhigh' });
  assert.deepEqual([calls[0].model, calls[0].effort], ['gpt-5-mini', 'low']);
});

test('hostOpts: a Claude alias never reaches Codex, and a host\'s entry wins over model and effort', async () => {
  bothHosts({ provider: 'codex' });
  const calls = [];
  // The caller's model is a Claude alias; Codex has its own entry with model null: no -m at all (the user's own Codex
  // default), never sonnet, haiku or the reasoner's reasoner.codexModel (brain-ai A6: the sweep's background model).
  let p = await resolveProviderForRole({ role: 'reasoner', model: 'sonnet', effort: 'high', hostOpts: { claude: { model: 'haiku', effort: null }, codex: { model: null, effort: 'minimal' } }, deps: { resolveClaudeBin: never, loginProbe: never, ...codexLoggedIn, codexCall: replyCall(calls) } });
  assert.equal(p.name, 'codex');
  assert.equal(p.model, null, 'no model: never gpt-5 (reasoner.codexModel), sonnet or haiku');
  await p.chat({ prompt: 'x' });
  assert.deepEqual([calls[0].model, calls[0].effort], [null, 'minimal']);
  // An entry that names no model at all (no `model` key) keeps the role's, as before.
  try { fs.unlinkSync(STATE_PATH); } catch {}
  const kept = [];
  p = await resolveProviderForRole({ role: 'reasoner', hostOpts: { codex: { effort: 'minimal' } }, deps: { resolveClaudeBin: never, loginProbe: never, ...codexLoggedIn, codexCall: replyCall(kept) } });
  await p.chat({ prompt: 'x' });
  assert.deepEqual([p.model, kept[0].model], ['gpt-5', 'gpt-5']);

  bothHosts();
  try { fs.unlinkSync(STATE_PATH); } catch {}
  const claudeCalls = [];
  p = await resolveProviderForRole({ role: 'reasoner', model: 'sonnet', effort: 'high', hostOpts: { claude: { model: 'haiku', effort: 'low' } }, deps: { ...loggedIn, claudeCall: replyCall(claudeCalls) } });
  await p.chat({ prompt: 'x', think: 'medium' });
  assert.deepEqual([p.model, claudeCalls[0].model, claudeCalls[0].effort], ['haiku', 'haiku', 'low'], 'the entry wins over model and effort');
});

test('hostOpts: a host without an entry takes model and effort as before; a level the host does not take, or an empty model, keeps the role\'s', async () => {
  bothHosts();
  const calls = [];
  let p = await resolveProviderForRole({ role: 'reasoner', prefer: 'claude', model: 'sonnet', effort: 'high', hostOpts: { codex: { model: 'gpt-5-mini', effort: 'low' } }, deps: { ...loggedIn, claudeCall: replyCall(calls) } });
  await p.chat({ prompt: 'x', think: 'low' });
  assert.deepEqual([p.model, calls[0].effort], ['sonnet', 'high']);

  const odd = [];
  p = await resolveProviderForRole({ role: 'reasoner', prefer: 'claude', hostOpts: { claude: { model: '  ', effort: 'xhigh' } }, deps: { ...loggedIn, claudeCall: replyCall(odd) } });
  await p.chat({ prompt: 'x' });
  assert.deepEqual([p.model, odd[0].effort], ['claude-opus-5', 'high'], 'xhigh is not a claude level: reasoner.effort, and the role\'s model');

  try { fs.unlinkSync(STATE_PATH); } catch {}
  const cx = [];
  p = await resolveProviderForRole({ role: 'reasoner', prefer: 'codex', hostOpts: { codex: { model: 'gpt-5-mini', effort: null } }, deps: { ...codexLoggedIn, codexCall: replyCall(cx) } });
  await p.chat({ prompt: 'x' });
  assert.deepEqual([p.model, cx[0].effort], ['gpt-5-mini', 'high'], 'Codex with effort null keeps the role\'s level, never the user\'s own default');
});

test('hostOpts changes nothing for a role served by Ollama, and provider none still wins', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'none' }));
  const p = await resolveProviderForRole({ role: 'reasoner', hostOpts: sweepOpts, deps: { resolveClaudeBin: never, loginProbe: never, resolveCodexBin: never, codexLoginProbe: never } });
  assert.deepEqual([p.name, p.reason], ['none', 'forced']);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'ollama' }));
  const w = await resolveProviderForRole({ role: 'workhorse', hostOpts: sweepOpts, deps: { ping: never, resolveClaudeBin: never, loginProbe: never } });
  assert.deepEqual([w.name, w.reason], ['ollama', 'forced']);
});

// ---- deps.unbilled (brain-ai A5: an estimate makes no billed call) ----
test('unbilled: Claude\'s login probe (a billed claude -p) never runs and nothing is written; a stale cache reads as signed in when claude is installed', async () => {
  const stale = { claude: { loggedIn: false, checkedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), bin: '/x/claude' } };
  fs.writeFileSync(STATE_PATH, JSON.stringify(stale));
  const deps = { unbilled: true, ping: async () => false, resolveClaudeBin: () => '/x/claude', loginProbe: never };
  let p = await resolveProvider({ mode: 'auto', deps });
  assert.deepEqual([p.name, p.reason], ['claude', 'claude-logged-in']);
  p = await resolveProviderForRole({ role: 'reasoner', deps });
  assert.equal(p.name, 'claude');
  assert.deepEqual(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')), stale, 'the cache is left for the next real resolve to probe');
  assert.equal(fs.existsSync(SPEND_PATH), false, 'no login-probe row');
  fs.unlinkSync(STATE_PATH);
  p = await resolveProvider({ mode: 'auto', deps: { ...deps, resolveClaudeBin: () => null } });
  assert.deepEqual([p.name, p.reason], ['none', 'no-provider'], 'no binary: no provider');
  assert.equal(fs.existsSync(STATE_PATH), false, 'nothing written');

  // A fresh cache is used as it is; a real resolve still probes and records.
  await resolveProvider({ mode: 'auto', deps: { ping: async () => false, resolveClaudeBin: () => '/x/claude', loginProbe: async () => false } });
  p = await resolveProvider({ mode: 'auto', deps });
  assert.deepEqual([p.name, p.reason], ['none', 'claude-not-logged-in']);
});

test('a daily cap\'s none names the host whose cap it is', async () => {
  spent();
  let p = await resolveProvider({ mode: 'auto', deps: { ping: async () => false, ...loggedIn } });
  assert.deepEqual([p.name, p.reason, p.host], ['none', 'daily-cap', 'claude']);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'codex' }));
  p = await resolveProvider({ deps: { ...codexLoggedIn, spendToday: () => 9 } });
  assert.deepEqual([p.name, p.reason, p.host], ['none', 'daily-cap', 'codex']);
  fs.writeFileSync(CONFIG, JSON.stringify({ hosts: { claude: { enabled: true }, codex: { enabled: true } } }));
  p = await resolveProviderForRole({ role: 'reasoner', deps: { ...loggedIn, reasonSpendToday: () => 99 } });
  assert.deepEqual([p.reason, p.host], ['reasoner-daily-cap', 'claude']);
  try { fs.unlinkSync(STATE_PATH); } catch {}
  p = await resolveProviderForRole({ role: 'reasoner', prefer: 'codex', deps: { ...codexLoggedIn, reasonSpendToday: () => 99 } });
  assert.deepEqual([p.reason, p.host], ['reasoner-daily-cap', 'codex']);
  p = await resolveProvider({ mode: 'none' });
  assert.equal(p.host, null, 'any other none names no host');
});

// ── provider local (local-first A1, A3, A8, A10, A13, A18) ─────────────────────────────────────────────────────────────
const GB = 1024 ** 3;
const pulled = (...models) => ({ localModels: async () => models });
const localCfg = (local = {}) => fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'local', local }));

test('local: engine up with the workhorse pulled → the local provider, on that model, counted not ledgered', async () => {
  localCfg();
  const calls = [];
  const counted = [];
  const p = await resolveProvider({ deps: { ...pulled('qwen3.5:9b', 'qwen3-embedding:0.6b'), ollamaChat: async (o) => { calls.push(o); return 'hi'; }, recordLocalCall: (r) => counted.push(r), resolveClaudeBin: never, loginProbe: never } });
  assert.deepEqual([p.name, p.engine, p.reason, p.model, p.embedder], ['ollama', 'ollama', 'local-ready', 'qwen3.5:9b', 'qwen3-embedding:0.6b']);
  assert.deepEqual(p.capabilities, { chat: true, embed: true, structured: true });
  assert.equal(await p.chat({ prompt: 'x', feature: 'session-summary' }), 'hi');
  assert.equal(calls[0].model, 'qwen3.5:9b');
  assert.equal(calls[0].keepAlive, -1, 'the suite runs as a 32 GB Mac: resident');
  assert.deepEqual([calls[0].host, calls[0].port], ['127.0.0.1', 11434], 'ollama.host/port from the defaults');
  assert.deepEqual(counted.map((c) => c.feature), ['session-summary']);
  assert.equal(fs.existsSync(SPEND_PATH), false, 'a local call writes no spend row');
  const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  assert.deepEqual([st.name, st.reason, st.engine, st.model, st.localReason], ['ollama', 'local-ready', 'ollama', 'qwen3.5:9b', 'local-ready']);
  assert.deepEqual(st.local.models, ['qwen3.5:9b', 'qwen3-embedding:0.6b']);
});

test('local: nothing answers → none/local-down; not pulled → none/local-model-missing; no hosted call either way', async () => {
  localCfg();
  let p = await resolveProvider({ deps: { localModels: async () => null, resolveClaudeBin: never, loginProbe: never } });
  assert.deepEqual([p.name, p.reason], ['none', 'local-down']);
  await assert.rejects(() => p.chat({ prompt: 'x' }), (e) => e.code === 'PROVIDER_NONE');
  fs.unlinkSync(STATE_PATH);
  p = await resolveProvider({ deps: { ...pulled('llama3.2:latest'), resolveClaudeBin: never, loginProbe: never } });
  assert.deepEqual([p.name, p.reason], ['none', 'local-model-missing']);
});

test('local: the engine list is cached 60 s, and a changed engine or address re-asks at once', async () => {
  localCfg();
  let asked = 0;
  const deps = { localModels: async () => { asked++; return ['qwen3.5:9b']; } };
  await resolveProvider({ deps });
  await resolveProvider({ deps });
  assert.equal(asked, 1);
  localCfg({ url: 'http://127.0.0.1:11500' });
  const p = await resolveProvider({ deps: { ...deps, ollamaChat: async (o) => o.port } });
  assert.equal(asked, 2);
  assert.equal(await p.chat({ prompt: 'x' }), 11500, 'local.url reaches ollama.js as host and port');
});

test('local: a tier model gives way to another pulled tier model; a model the user named never does (A13)', async (t) => {
  const saved = process.env.AOS_TOTALMEM;
  t.after(() => { process.env.AOS_TOTALMEM = saved; });
  process.env.AOS_TOTALMEM = String(8 * GB);
  localCfg();
  const seen = [];
  let p = await resolveProvider({ deps: { ...pulled('qwen3.5:9b'), ollamaChat: async (o) => { seen.push(o); return 'x'; } } });
  assert.deepEqual([p.name, p.model], ['ollama', 'qwen3.5:9b'], 'an 8 GB Mac that already has the 9b keeps using it');
  await p.chat({ prompt: 'x', model: 'qwen3.5:4b' });
  assert.equal(seen[0].model, 'qwen3.5:9b', 'a caller passing the role\'s own tag gets the resolved model');
  assert.equal(seen[0].keepAlive, '5m', 'under 24 GB the workhorse unloads after 5 minutes');
  await p.chat({ prompt: 'x', model: 'llama3.2' });
  assert.equal(seen[1].model, 'llama3.2', 'any other model a caller names is kept');
  fs.unlinkSync(STATE_PATH);
  localCfg({ model: 'qwen3.5:4b' });
  p = await resolveProvider({ deps: pulled('qwen3.5:9b') });
  assert.deepEqual([p.name, p.reason], ['none', 'local-model-missing'], 'local.model is what the user asked for');
});

test('local: the embedder not pulled → chat works, embed refuses (recall falls back to BM25)', async () => {
  localCfg();
  const p = await resolveProvider({ deps: pulled('qwen3.5:9b') });
  assert.deepEqual([p.name, p.embedder, p.capabilities.embed], ['ollama', null, false]);
  await assert.rejects(() => p.embed(['x']), (e) => e.code === 'PROVIDER_NONE' && /qwen3-embedding/.test(e.message));
});

test('local: hostedFallback off never reaches Claude; on, a local outage goes to Claude, then Codex, under the hook caps', async () => {
  localCfg({ hostedFallback: false });
  let p = await resolveProvider({ deps: { localModels: async () => null, resolveClaudeBin: never, loginProbe: never } });
  assert.deepEqual([p.name, p.reason], ['none', 'local-down']);
  fs.unlinkSync(STATE_PATH);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'local', local: { hostedFallback: true } }));
  p = await resolveProvider({ deps: { localModels: async () => null, ...loggedIn } });
  assert.deepEqual([p.name, p.reason], ['claude', 'claude-logged-in']);
  assert.equal(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).localReason, 'local-down', 'the state says why it spent');
  fs.unlinkSync(STATE_PATH);
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'local', local: { hostedFallback: true }, hosts: { codex: { enabled: true } } }));
  p = await resolveProvider({ deps: { localModels: async () => null, resolveClaudeBin: () => null, loginProbe: never, ...codexLoggedIn } });
  assert.deepEqual([p.name, p.reason], ['codex', 'codex-logged-in']);
  fs.unlinkSync(STATE_PATH);
  spent();
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'local', local: { hostedFallback: true } }));
  p = await resolveProvider({ deps: { localModels: async () => null, ...loggedIn } });
  assert.deepEqual([p.name, p.reason, p.host], ['none', 'daily-cap', 'claude'], 'a hosted cap still says so');
  fs.unlinkSync(STATE_PATH);
  p = await resolveProvider({ deps: { localModels: async () => null, resolveClaudeBin: () => null, loginProbe: never } });
  assert.deepEqual([p.name, p.reason], ['none', 'local-down'], 'nobody hosted either: the local reason is the one to fix');
});

test('local, engine openai: an OpenAI-compatible server answers as the local provider (A8)', async () => {
  localCfg({ engine: 'openai', model: 'qwen3.5-9b-instruct' });
  const calls = [];
  const asked = [];
  const p = await resolveProvider({ deps: { localModels: async (lc) => { asked.push(lc.url); return ['qwen3.5-9b-instruct']; }, openaiChat: async (o) => { calls.push(o); return '{"a":1}'; }, recordLocalCall: () => {} } });
  assert.deepEqual([p.name, p.engine, p.model, p.capabilities.embed], ['ollama', 'openai', 'qwen3.5-9b-instruct', false]);
  assert.deepEqual(asked, ['http://127.0.0.1:1234/v1'], 'LM Studio\'s address by default');
  assert.equal(await p.chat({ prompt: 'x', format: 'json' }), '{"a":1}');
  assert.deepEqual([calls[0].url, calls[0].model, calls[0].format], ['http://127.0.0.1:1234/v1', 'qwen3.5-9b-instruct', 'json']);
});

test('auto keeps its pre-2.0 behaviour: a reachable Ollama wins on the 9b with no pulled check', async () => {
  fs.writeFileSync(CONFIG, JSON.stringify({ provider: 'auto' }));
  const p = await resolveProvider({ deps: { ping: async () => true, localModels: never } });
  assert.deepEqual([p.name, p.reason], ['ollama', 'ollama-reachable']);
  const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  assert.equal(st.localReason, undefined);
  assert.equal(role('workhorse').tag, 'qwen3.5:9b');
});
