'use strict';
// lib/memory-sweep.js (brain-hub D22; brain-ai A3, A6, A10, A11): the input lines and their cap order, scoping, the
// card rules, the store (scopes, dismissed cards, the run cap), dismiss, the sweep off (none, Ollama only, a cap, a
// failed call, an unreadable reply) and the estimate. The model is always a fake seam (opts.ai): no provider is resolved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sw = require('../lib/memory-sweep.js');
const ops = require('../lib/memory-ops.js');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const A = 'brain/memory/projects/release-1-0.md';
const B = 'brain/memory/projects/release-1-1.md';
const C = 'brain/memory/projects/release-1-2.md';
const D = 'brain/memory/feedback/ask-first.md';
const E = 'brain/memory/reference/ports.md';
const F = 'brain/memory/user/role.md';
const G = 'brain/memory/projects/old-plan.md';
const LONG = `Ask before deleting anything outside the vault.\nThen say what will go.\n\n${'Never guess a path. '.repeat(15)}`;

const put = (v, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
  fs.writeFileSync(path.join(v, rel), text);
};
const read = (v, rel) => fs.readFileSync(path.join(v, rel), 'utf8');
const exists = (v, rel) => fs.existsSync(path.join(v, rel));
function mem({ type, status = 'active', created = null, reviewed = 'true', description = null, title, body = 'Body.' }) {
  return ['---', 'type: memory', `tags: [memory/${type}, status/${status}]`, ...(created ? [`created: ${created}`] : []),
    `reviewed: ${reviewed}`, ...(description ? [`description: ${description}`] : []), '---', '', `# ${title}`, '', body, ''].join('\n');
}
const HUB = {
  schema: 1,
  dups: [{ a: A, b: B, score: 0.912 }, { a: B, b: G, score: 0.85 }],
  clusters: [{ paths: [A, B, C], label: 'release' }, { paths: [D, G], label: 'gone' }],
  usage: { since: '2026-09-01T00:00:00.000Z', paths: { [E]: { d30: 3 }, [A]: { d30: 1 } } },
};

function fixture({ hub = HUB } = {}) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'msweep-'));
  put(v, A, mem({ type: 'projects', created: '2026-09-01', description: 'Shipped 1.0', title: 'Release 1.0' }));
  put(v, B, mem({ type: 'projects', created: '2026-09-10', description: 'Shipped 1.1', title: 'Release 1.1' }));
  put(v, C, mem({ type: 'projects', created: '2026-09-20', description: 'Shipped 1.2', title: 'Release 1.2' }));
  put(v, D, mem({ type: 'feedback', created: '2026-10-01', reviewed: 'false', title: 'Ask first', body: LONG }));
  put(v, E, mem({ type: 'reference', created: '2026-10-11', description: 'Ports in use', title: 'Ports' }));
  put(v, F, mem({ type: 'user', title: 'Role', description: 'What I do' }));
  put(v, G, mem({ type: 'projects', status: 'archived', created: '2026-08-01', title: 'Old plan' }));
  put(v, 'MEMORY.md', `# Index\n\n## Feedback\n- [Ask first](${D}) — Ask before deleting files\n`);
  if (hub) put(v, 'brain/_index/brain-hub.json', JSON.stringify(hub));
  else fs.mkdirSync(path.join(v, 'brain/_index'), { recursive: true });
  return v;
}
const store = (v) => JSON.parse(read(v, sw.SWEEP_PATH));

const SENTENCES = {
  forced: 'No model provider is set up.',
  'ollama-only': 'Only Ollama is set up.',
  'reasoner-daily-cap': "Today's model cap is reached ($5.00, reasoner.perDayUsd).",
};
/** A fake lib/memory-ai.js: estimate and call record what they were given; `reply` may be a function of the call. */
function fakeAi({ available = true, reason = null, provider = 'claude', model = 'haiku', reply = { suggestions: [] }, callError = null, onCall = null } = {}) {
  const calls = { estimate: [], call: [] };
  return {
    calls,
    async estimate(kind, o) {
      calls.estimate.push({ kind, ...o });
      return {
        available, reason: available ? null : reason, provider: available ? provider : 'none', model: available ? model : null,
        tokensIn: Math.ceil(o.chars / 4) + 600, tokensOut: o.outTokens, usd: 0.012345, cap: { family: 'reasoner', perDayUsd: 5, spentToday: 0.1, perCallUsd: 0.5 },
      };
    },
    async call(kind, o) {
      calls.call.push({ kind, ...o });
      if (onCall) onCall(o);
      if (callError) throw callError;
      const r = typeof reply === 'function' ? reply(o) : reply;
      return { text: typeof r === 'string' ? r : JSON.stringify(r), provider, model, usd: 0.0123, estimated: provider === 'codex', cap: null };
    },
    reasonSentence(why) {
      if (why && typeof why === 'object' && !why.code && 'reason' in why) return SENTENCES[why.reason] || `No model call possible (${why.reason}).`;
      if (why && typeof why === 'object') return why.code === 'PROVIDER_UNREACHABLE' ? 'Claude did not answer.' : `(${why.code})`;
      return SENTENCES[why] || `No model call possible (${why}).`;
    },
  };
}
const card = (kind, paths, title = '', description = '', why = 'Because.') => ({ kind, paths, title, description, why });
const run = (v, rels, ai, extra = {}) => sw.sweep(v, rels, { ai, now: NOW, ...extra });

// ── ids ──

test('cardId and scopeKey: 12 hex of sha256 over the sorted paths, whatever their order; null for the whole brain', () => {
  const id = sw.cardId('merge', [B, A]);
  assert.match(id, sw.ID_RE);
  assert.equal(id, crypto.createHash('sha256').update(`merge\n${A}\n${B}`).digest('hex').slice(0, 12));
  assert.equal(sw.cardId('merge', [A, B]), id);
  assert.notEqual(sw.cardId('archive', [A, B]), id);
  assert.equal(sw.scopeKey([]), null);
  assert.equal(sw.scopeKey([C, A]), crypto.createHash('sha256').update(`${A}\n${C}`).digest('hex').slice(0, 12));
  assert.equal(sw.scopeKey([A, C]), sw.scopeKey([C, A]));
  for (const bad of ['0123456789a', '0123456789abc', '0123456789AB', 'g123456789ab']) assert.equal(sw.ID_RE.test(bad), false, bad);
});

test('the schema is strict for both hosts: every key required, nothing else, no count or length keyword', () => {
  const item = sw.SCHEMA.properties.suggestions.items;
  assert.equal(sw.SCHEMA.additionalProperties, false);
  assert.deepEqual(sw.SCHEMA.required, ['suggestions']);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, ['kind', 'paths', 'title', 'description', 'why']);
  assert.deepEqual(item.properties.kind.enum, ['merge', 'archive', 'retitle']);
  assert.doesNotMatch(JSON.stringify(sw.SCHEMA), /maxItems|minItems|maxLength|minLength/);
  assert.match(sw.systemPrompt(20), /At most 20 cards/);
  assert.match(sw.systemPrompt(10), /At most 10 cards/);
});

// ── the input (A11) ──

test('one line per live memory: path, type, status, age, use in 30 days, title, description, the opening in one line', async () => {
  const v = fixture();
  const ai = fakeAi();
  await run(v, [], ai);
  const prompt = ai.calls.call[0].prompt;
  const lines = prompt.split('\n');
  const opening = Array.from(`Ask before deleting anything outside the vault. Then say what will go. ${'Never guess a path. '.repeat(15)}`.trim()).slice(0, 200).join('');
  // No description key: MEMORY.md's line gives it. The hub has been collecting and has no row for it: used 0.
  assert.ok(lines.includes(`${D} | feedback | active | 11 | used 0 | Ask first | Ask before deleting files | ${opening}`), prompt);
  assert.ok(lines.includes(`${E} | reference | active | 1 | used 3 | Ports | Ports in use | Body.`));
  assert.ok(lines.includes(`${F} | user | active | ? | used 0 | Role | What I do | Body.`), 'no date: age ?');
  assert.ok(!prompt.includes(G), 'an archived memory is not sent, nor its pairs and clusters');
  assert.equal(Array.from(opening).length, 200);
  assert.match(lines[0], /^MEMORIES \(6 of 6\)/);
  const at = lines.indexOf('PAIRS (path path score):');
  assert.deepEqual(lines.slice(at + 1, at + 2), [`${A} ${B} 0.912`]);
  const cl = lines.indexOf('CLUSTERS (paths, one group per line):');
  assert.deepEqual(lines.slice(cl + 1), [`${A} ${B} ${C}`]);
  assert.equal(ai.calls.call[0].kind, 'sweep');
  assert.equal(ai.calls.call[0].schema, sw.SCHEMA);
  assert.equal(ai.calls.call[0].timeoutMs, 120_000);
  assert.equal(ai.calls.call[0].numPredict, 3000);
  assert.match(ai.calls.call[0].system, /At most 20 cards/);
});

test('without brain-hub.json: use is "?" and there are no pairs or clusters', () => {
  const v = fixture({ hub: null });
  const rows = ops.listMemories(v).filter((m) => m.live).map((m) => ({ ...m, text: read(v, m.path) }));
  const r = sw.buildInput(rows, null, { now: NOW });
  assert.ok(r.prompt.split('\n').includes(`${E} | reference | active | 1 | used ? | Ports | Ports in use | Body.`));
  assert.match(r.prompt, /PAIRS \(path path score\):\nnone\n\nCLUSTERS \(paths, one group per line\):\nnone$/);
});

test('the cap takes memories in a pair or cluster first, then unreviewed, then newest; considered and of count them', () => {
  const v = fixture();
  const rows = ops.listMemories(v).filter((m) => m.live).map((m) => ({ ...m, text: read(v, m.path) }));
  const full = sw.buildInput(rows, HUB, { now: NOW });
  // In the cluster (newest first: C, B, A), then D (unreviewed), then E (newest), then F (no date: last).
  assert.deepEqual(full.paths, [C, B, A, D, E, F]);
  assert.equal(full.considered, 6);
  assert.equal(full.of, 6);
  const empty = sw.buildInput(rows, HUB, { now: NOW, maxChars: 0 });
  assert.deepEqual([empty.considered, empty.of], [0, 6]);
  let last = 6;
  for (let max = full.prompt.length; max >= empty.prompt.length; max -= 37) {
    const r = sw.buildInput(rows, HUB, { now: NOW, maxChars: max });
    assert.ok(r.prompt.length <= max, `${r.prompt.length} > ${max}`);
    assert.deepEqual(r.paths, full.paths.slice(0, r.considered), 'always a prefix of the order');
    assert.ok(r.considered <= last, 'fewer as the cap shrinks');
    assert.equal(r.of, 6);
    last = r.considered;
  }
  assert.equal(last, 0);
  const short = sw.buildInput(rows, HUB, { now: NOW, maxChars: full.prompt.length - 1 });
  assert.equal(short.considered, 5, 'one character short drops the last memory');
  // Two of the cluster: the pair A–B is not listed until both are sent, and the cluster is cut to those sent.
  const cut = sw.buildInput(rows, HUB, { now: NOW, maxChars: sw.buildInput(rows.filter((m) => [B, C].includes(m.path)), HUB, { now: NOW }).prompt.length + 40 });
  assert.deepEqual(cut.paths, [C, B]);
  assert.match(cut.prompt, /PAIRS \(path path score\):\nnone\n/);
  assert.match(cut.prompt, new RegExp(`CLUSTERS \\(paths, one group per line\\):\\n${B} ${C}$`), 'in the hub\'s order');
  assert.match(cut.prompt, /^MEMORIES \(2 of 6\)/);
});

test('a big brain is cut to MAX_CHARS and the run says how many it looked at', async () => {
  const v = fixture();
  for (let i = 0; i < 400; i++) {
    put(v, `brain/memory/reference/note-${String(i).padStart(3, '0')}.md`,
      mem({ type: 'reference', created: '2026-01-01', description: 'd'.repeat(150), title: `Note ${i}`, body: 'x '.repeat(200) }));
  }
  const ai = fakeAi();
  const est = await run(v, [], ai, { estimate: true });
  assert.equal(est.of, 406);
  assert.ok(est.considered < 406 && est.considered > 100, String(est.considered));
  const r = await run(v, [], ai);
  assert.ok(ai.calls.call[0].prompt.length <= sw.MAX_CHARS);
  assert.equal(r.run.considered, est.considered);
  assert.equal(r.run.of, 406);
  assert.ok(ai.calls.call[0].prompt.startsWith(`MEMORIES (${est.considered} of 406)`));
});

// ── scope (A3) ──

test('a scoped run sends only those paths, keeps their order as its scope, and asks for at most 10 cards', async () => {
  const v = fixture();
  const ai = fakeAi({ reply: { suggestions: [card('merge', [C, B], 'Releases 1.1 and 1.2', 'ignored'), card('archive', [A])] } });
  const r = await run(v, [C, B], ai);
  const prompt = ai.calls.call[0].prompt;
  assert.ok(prompt.includes(B) && prompt.includes(C));
  for (const p of [A, D, E, F]) assert.ok(!prompt.includes(p), p);
  assert.match(prompt, /^MEMORIES \(2 of 2\)/);
  assert.match(ai.calls.call[0].system, /At most 10 cards/);
  assert.deepEqual(r.run.scope, { paths: [C, B] });
  assert.equal(r.run.considered, 2);
  assert.equal(r.run.of, 2);
  assert.equal(r.suggestions.length, 1, 'A was not sent: its card is dropped');
  assert.equal(r.suggestions[0].scope, sw.scopeKey([B, C]));
  assert.equal(r.suggestions[0].description, '', 'a merge card carries no description');
  assert.equal(store(v).runs[0].scope.paths[0], C);
});

test('a scope must be memory paths, each once, all live, at most 50; nothing is called or written otherwise', async () => {
  const v = fixture();
  const ai = fakeAi();
  await assert.rejects(run(v, [A, G], ai), { code: 'GONE', message: `${G} is archived: a sweep looks at live memories only` });
  await assert.rejects(run(v, [A, 'brain/memory/projects/missing.md'], ai), { code: 'NOT_FOUND' });
  await assert.rejects(run(v, [A, 'notes/a.md'], ai), { code: 'BAD_PATH' });
  await assert.rejects(run(v, [A, A], ai), { code: 'BAD_PATH' });
  await assert.rejects(run(v, Array.from({ length: 51 }, (_, i) => `brain/memory/projects/n-${i}.md`), ai), { code: 'BAD_PATH' });
  await assert.rejects(run(v, [A, G], ai, { estimate: true }), { code: 'GONE' });
  assert.equal(ai.calls.estimate.length + ai.calls.call.length, 0);
  assert.equal(exists(v, sw.SWEEP_PATH), false);
});

// ── the cards (A10) ──

test('cards are kept only when their paths were sent and are live, the count fits, a retitle is new, and the id is new', async () => {
  const v = fixture();
  const reply = {
    suggestions: [
      card('merge', [A, B, C], 'Releases 1.0 to 1.2', 'dropped description', 'One release per step.'),
      card('merge', [C, B, A], 'Again'), // the same id as the first
      card('merge', [A]), // one path
      card('merge', [A, B, C, D, E, F, 'brain/memory/user/x.md']), // seven
      card('merge', [A, 'brain/memory/projects/unknown.md']), // not sent
      card('archive', [G]), // retired: never sent
      card('archive', [F], 'a title', 'a description', `  Never\nused   since ${'it was written. '.repeat(20)}`),
      card('archive', [E]), // archived while the model answered
      card('retitle', [D], ''), // no title
      card('retitle', [A], 'Release 1.0'), // the same title
      card('retitle', [A, B], 'Two'), // two paths
      card('retitle', [A], 't'.repeat(121)), // too long
      card('retitle', [D], 'Ask before\ndeleting', 'Ask before deleting anything outside the vault'),
      card('rename', [A], 'x'),
      { kind: 'merge', paths: [A, 42], title: '', description: '', why: '' },
      'not a card',
    ],
  };
  const ai = fakeAi({ reply, onCall: () => ops.archive(v, [E]) });
  const r = await run(v, [], ai);
  assert.deepEqual(r.suggestions.map((c) => [c.kind, c.paths]), [['merge', [A, B, C]], ['archive', [F]], ['retitle', [D]]]);
  const [m, a, t] = r.suggestions;
  assert.equal(m.title, 'Releases 1.0 to 1.2');
  assert.equal(m.description, '');
  assert.equal(m.why, 'One release per step.');
  assert.equal(a.title, '');
  assert.equal(a.description, '');
  assert.ok(Array.from(a.why).length <= 200 && !/\s{2}|\n/.test(a.why) && a.why.startsWith('Never used since'), a.why);
  assert.equal(t.title, 'Ask before deleting', 'one line');
  assert.equal(t.description, 'Ask before deleting anything outside the vault');
  for (const c of r.suggestions) {
    assert.equal(c.id, sw.cardId(c.kind, c.paths));
    assert.equal(c.run, r.run.id);
    assert.equal(c.scope, null);
    assert.equal(c.state, 'open');
    assert.deepEqual(c.hashes, c.paths.map((p) => ops.readMemory(v, p).hash));
    assert.deepEqual(Object.keys(c), ['id', 'run', 'kind', 'paths', 'hashes', 'title', 'description', 'why', 'scope', 'state']);
  }
  assert.equal(r.run.suggestions, 3);
  assert.deepEqual(Object.keys(r.run), ['id', 'run', 'at', 'scope', 'provider', 'model', 'usd', 'estimated', 'considered', 'of', 'suggestions'].filter((k) => k !== 'run'));
  assert.match(r.run.id, /^20261012-120000-[0-9a-f]{8}$/);
  assert.equal(r.run.at, '2026-10-12T12:00:00.000Z');
  assert.deepEqual([r.run.provider, r.run.model, r.run.usd, r.run.estimated], ['claude', 'haiku', 0.0123, false]);
  assert.deepEqual(store(v).suggestions, r.suggestions);
});

test('keepCards: path counts per kind (merge 2–6, archive 1–10, retitle 1) and the card limit', () => {
  const paths = Array.from({ length: 12 }, (_, i) => `brain/memory/reference/n-${i}.md`);
  const byPath = new Map(paths.map((p) => [p, { path: p, live: true, hash: 'h'.repeat(64), title: p }]));
  const keep = (raw, max = 20) => sw.keepCards(raw, { sent: new Set(paths), byPath, dismissed: new Set(), max, run: 'r', scope: null });
  const sizes = (kind, ns) => ns.filter((n) => keep([card(kind, paths.slice(0, n), 'New title')]).length === 1);
  assert.deepEqual(sizes('merge', [1, 2, 6, 7]), [2, 6]);
  assert.deepEqual(sizes('archive', [1, 10, 11]), [1, 10]);
  assert.deepEqual(sizes('retitle', [1, 2]), [1]);
  assert.equal(keep([card('merge', [paths[0], paths[0], paths[1]])])[0].paths.length, 2, 'a path twice counts once');
  assert.equal(keep(paths.map((p) => card('archive', [p])), 10).length, 10);
  assert.equal(keep([card('archive', [`${paths[0]} `])])[0].paths[0], paths[0], 'trimmed');
});

test('keepCards counts a title and a description as `set` does (UTF-16 units): nothing kept that `set` would refuse', () => {
  const p = 'brain/memory/reference/n-0.md';
  const q = 'brain/memory/reference/n-1.md';
  const byPath = new Map([p, q].map((x) => [x, { path: x, live: true, hash: 'h'.repeat(64), title: 'Old' }]));
  const keep = (c) => sw.keepCards([c], { sent: new Set([p, q]), byPath, dismissed: new Set(), max: 20, run: 'r', scope: null });
  const rocket = (n) => '\u{1F680}'.repeat(n); // each 1 code point, 2 UTF-16 units
  // 61 rockets: 61 code points but 122 units, which memory-ops `set` refuses (title takes 1–120, BAD_FIELD).
  assert.deepEqual(keep(card('retitle', [p], rocket(61))), [], 'a retitle `set` would refuse is dropped');
  assert.equal(keep(card('retitle', [p], rocket(60)))[0].title.length, ops.MAX_TITLE, '120 units is kept');
  // A description and a merge title are cut to what `set` and `merge --into` take, never inside a surrogate pair.
  const loneHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  const d = keep(card('retitle', [p], 'New', rocket(150)))[0].description;
  assert.ok(d.length <= ops.MAX_DESC && !loneHigh.test(d), `${d.length} units`);
  const t = keep(card('merge', [p, q], rocket(100)))[0].title;
  assert.ok(t.length <= ops.MAX_TITLE && !loneHigh.test(t), `${t.length} units`);
});

test('keepCards drops a retitle `set` would refuse for MEMORY.md\'s sake: a bracket in the title, `](` in the description', () => {
  const p = 'brain/memory/reference/n-0.md';
  const other = 'brain/memory/user/other.md';
  const byPath = new Map([[p, { path: p, live: true, hash: 'h'.repeat(64), title: 'Old' }]]);
  const keep = (c) => sw.keepCards([c], { sent: new Set([p]), byPath, dismissed: new Set(), max: 20, run: 'r', scope: null });
  assert.deepEqual(keep(card('retitle', [p], `New](${other}) — x [y`)), [], 'a title that would link other.md');
  assert.deepEqual(keep(card('retitle', [p], '[WIP] new')), []);
  assert.deepEqual(keep(card('retitle', [p], 'New', `see [it](${other})`)), [], 'a description that would');
  const ok = keep(card('retitle', [p], 'New (v2)', 'a [note] (kept)'));
  assert.deepEqual([ok[0].title, ok[0].description], ['New (v2)', 'a [note] (kept)']);
  // Every kept retitle is one `set` takes as it is.
  const v = fixture();
  assert.doesNotThrow(() => ops.setFields(v, A, { title: ok[0].title, description: ok[0].description }));
});

// ── the store ──

test('a run replaces the open cards of its own scope; other scopes and every dismissed card stay; ids stay unique', async () => {
  const v = fixture();
  const one = await run(v, [], fakeAi({ reply: { suggestions: [card('merge', [A, B], 'Releases'), card('archive', [F])] } }));
  const archiveF = one.suggestions[1].id;
  assert.deepEqual(sw.dismiss(v, archiveF), { dismissed: archiveF, already: false });

  const scoped = await run(v, [A, B, C], fakeAi({ reply: { suggestions: [card('merge', [B, C], 'Late releases')] } }));
  const k = sw.scopeKey([A, B, C]);
  assert.equal(scoped.suggestions[0].scope, k);

  await run(v, [], fakeAi({ reply: { suggestions: [card('retitle', [E], 'Ports in use')] } }));
  let s = store(v).suggestions;
  assert.deepEqual(s.map((c) => [c.kind, c.paths.join(','), c.scope, c.state]).sort(), [
    ['archive', F, null, 'dismissed'],
    ['merge', `${B},${C}`, k, 'open'],
    ['retitle', E, null, 'open'],
  ].sort(), 'the first run\'s open merge is replaced; the scoped card and the dismissed one stay');

  // A dismissed card is never suggested again; a card made again moves to the run that made it (one card per id).
  const again = await run(v, [], fakeAi({ reply: { suggestions: [card('archive', [F]), card('merge', [C, B], 'Releases 1.1 and 1.2')] } }));
  assert.deepEqual(again.suggestions.map((c) => c.kind), ['merge']);
  s = store(v).suggestions;
  assert.deepEqual(s.map((c) => [c.kind, c.scope, c.state]).sort(), [['archive', null, 'dismissed'], ['merge', null, 'open']].sort());
  assert.equal(new Set(s.map((c) => c.id)).size, s.length);
  assert.equal(s.find((c) => c.kind === 'merge').title, 'Releases 1.1 and 1.2');
  assert.equal(store(v).schema, 1);
  assert.equal(store(v).runs.length, 4);
  assert.equal(store(v).runs[0].id, again.run.id, 'newest first');
});

test('a scoped run also replaces the open cards of earlier runs on its lead: a group re-run after a member left it', async () => {
  const v = fixture();
  await run(v, [], fakeAi({ reply: { suggestions: [card('retitle', [E], 'Ports in use')] } }));
  await run(v, [D, E], fakeAi({ reply: { suggestions: [card('archive', [E])] } }));
  const first = await run(v, [A, B, C], fakeAi({ reply: { suggestions: [card('archive', [C]), card('merge', [A, B], 'Releases')] } }));
  sw.dismiss(v, first.suggestions[1].id);
  // B is merged away: the group (its lead still A) now sends [A, C], which is another scope key.
  put(v, B, mem({ type: 'projects', status: 'superseded', created: '2026-09-10', description: 'Shipped 1.1', title: 'Release 1.1' }));
  assert.notEqual(sw.scopeKey([A, C]), sw.scopeKey([A, B, C]));
  const again = await run(v, [A, C], fakeAi({ reply: { suggestions: [] } }));
  assert.equal(again.run.suggestions, 0);
  assert.deepEqual(store(v).suggestions.map((c) => [c.kind, c.paths.join(','), c.scope, c.state]).sort(), [
    ['archive', E, sw.scopeKey([D, E]), 'open'],
    ['merge', `${A},${B}`, sw.scopeKey([A, B, C]), 'dismissed'],
    ['retitle', E, null, 'open'],
  ].sort(), 'the earlier run\'s open card on lead A is gone; another lead\'s, the whole brain\'s and the dismissed one stay');
});

test('runs keep the newest 20', async () => {
  const v = fixture();
  const ids = [];
  for (let i = 0; i < 22; i++) ids.push((await run(v, [], fakeAi(), { now: NOW + i * 1000 })).run.id);
  const runs = store(v).runs;
  assert.equal(runs.length, 20);
  assert.deepEqual(runs.map((r) => r.id), ids.slice(2).reverse());
});

test('an unreadable store starts over; a link where the store goes is refused', async () => {
  const v = fixture();
  put(v, sw.SWEEP_PATH, '{ not json');
  const r = await run(v, [], fakeAi({ reply: { suggestions: [card('archive', [F])] } }));
  assert.deepEqual(store(v), { schema: 1, runs: [r.run], suggestions: r.suggestions });

  const w = fixture();
  const target = path.join(w, 'elsewhere.json');
  fs.writeFileSync(target, '{"schema":1,"runs":[],"suggestions":[]}');
  fs.symlinkSync(target, path.join(w, sw.SWEEP_PATH));
  const ai = fakeAi();
  await assert.rejects(run(w, [], ai), { code: 'UNSAFE' });
  assert.equal(ai.calls.call.length, 0, 'refused before the model call');
  assert.throws(() => sw.dismiss(w, '0123456789ab'), { code: 'UNSAFE' });
  assert.equal(fs.readFileSync(target, 'utf8'), '{"schema":1,"runs":[],"suggestions":[]}');
});

// ── dismiss ──

test('dismiss hides a card for good, says when it already was, and refuses an id no card has', async () => {
  const v = fixture();
  assert.throws(() => sw.dismiss(v, '0123456789ab'), { code: 'NOT_FOUND' });
  assert.equal(exists(v, sw.SWEEP_PATH), false, 'no store: nothing is created');
  assert.throws(() => sw.dismiss(v, 'nope'), { code: 'BAD_ID' });
  const r = await run(v, [], fakeAi({ reply: { suggestions: [card('archive', [F]), card('merge', [A, B])] } }));
  const id = r.suggestions[0].id;
  assert.deepEqual(sw.dismiss(v, id), { dismissed: id, already: false });
  const before = read(v, sw.SWEEP_PATH);
  assert.deepEqual(sw.dismiss(v, id), { dismissed: id, already: true });
  assert.equal(read(v, sw.SWEEP_PATH), before, 'already: nothing rewritten');
  assert.deepEqual(store(v).suggestions.map((c) => c.state), ['dismissed', 'open']);
  assert.throws(() => sw.dismiss(v, 'ffffffffffff'), { code: 'NOT_FOUND', message: /no sweep card ffffffffffff/ });
});

// ── off, failures and the estimate ──

test('off with no model: none, an older runtime\'s Ollama only, a cap; the estimate says why, a real run refuses and writes nothing', async () => {
  for (const reason of ['forced', 'ollama-only', 'reasoner-daily-cap']) {
    const v = fixture();
    const ai = fakeAi({ available: false, reason });
    const est = await run(v, [], ai, { estimate: true });
    assert.equal(est.estimate.available, false);
    assert.equal(est.estimate.reason, reason);
    await assert.rejects(run(v, [], ai), { code: 'NO_MODEL', message: `the sweep cannot run (${SENTENCES[reason]})` });
    assert.equal(ai.calls.call.length, 0);
    assert.equal(exists(v, sw.SWEEP_PATH), false);
  }
});

test('the refusal reads the seam\'s own sentences: the cap that stopped it, Ollama only, none', async () => {
  const { reasonSentence } = require('../lib/memory-ai.js');
  const cases = [
    ['reasoner-daily-cap', "Today's model cap is reached ($5.00, reasoner.perDayUsd)."],
    ['ollama-only', 'Only Ollama is available, and a local model cannot hold the whole brain.'],
    ['forced', 'No model provider is set up.'],
    ['codex-not-logged-in', 'Codex is not signed in.'],
  ];
  for (const [reason, said] of cases) {
    const v = fixture();
    const ai = { ...fakeAi({ available: false, reason }), reasonSentence };
    await assert.rejects(run(v, [], ai), { code: 'NO_MODEL', message: `the sweep cannot run (${said})` }, reason);
  }
});

test('a cap or none during the call refuses as off; a failed call and an unreadable reply refuse; nothing is written', async () => {
  const err = (code) => Object.assign(new Error(code), { code });
  const v = fixture();
  await assert.rejects(run(v, [], fakeAi({ callError: err('PROVIDER_CAP') })), { code: 'NO_MODEL', message: 'the sweep cannot run ((PROVIDER_CAP))' });
  await assert.rejects(run(v, [], fakeAi({ callError: err('PROVIDER_NONE') })), { code: 'NO_MODEL' });
  await assert.rejects(run(v, [], fakeAi({ callError: err('PROVIDER_UNREACHABLE') })), { code: 'MODEL_FAILED', message: 'the sweep did not run (Claude did not answer.)' });
  for (const reply of ['not json', '{"cards": []}', '[1, 2]', '{"suggestions": "none"}']) {
    await assert.rejects(run(v, [], fakeAi({ reply })), { code: 'BAD_REPLY', message: /The model's reply could not be read\./ }, reply);
  }
  assert.equal(exists(v, sw.SWEEP_PATH), false);
  // A fenced reply still reads, and Codex's cost is marked estimated.
  const r = await run(v, [], fakeAi({ provider: 'codex', model: 'gpt-5-codex', reply: `\`\`\`json\n${JSON.stringify({ suggestions: [card('archive', [F])] })}\n\`\`\`` }));
  assert.deepEqual([r.run.provider, r.run.model, r.run.estimated, r.suggestions.length], ['codex', 'gpt-5-codex', true, 1]);
});

test('a brain with no live memory: the estimate says 0 of 0, a real run refuses', async () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'msweep-empty-'));
  fs.mkdirSync(path.join(v, 'brain/_index'), { recursive: true });
  const ai = fakeAi();
  const est = await run(v, [], ai, { estimate: true });
  assert.deepEqual([est.considered, est.of], [0, 0]);
  await assert.rejects(run(v, [], ai), { code: 'EMPTY' });
  assert.equal(ai.calls.call.length, 0);
});

test('--estimate: { scope, considered, of, estimate }, no model call, nothing written', async () => {
  const v = fixture();
  const ai = fakeAi();
  const r = await run(v, [], ai, { estimate: true, deps: { marker: 1 } });
  assert.deepEqual(Object.keys(r), ['scope', 'considered', 'of', 'estimate']);
  assert.deepEqual([r.scope, r.considered, r.of], [null, 6, 6]);
  assert.equal(r.estimate.usd, 0.012345);
  assert.equal(ai.calls.call.length, 0);
  assert.equal(exists(v, sw.SWEEP_PATH), false);
  const e = ai.calls.estimate[0];
  assert.equal(e.kind, 'sweep');
  assert.deepEqual(e.deps, { marker: 1 });
  assert.equal(e.outTokens, 1600);
  const full = await run(v, [], fakeAi());
  assert.ok(full.run, 'the same vault sweeps for real');
  const ai2 = fakeAi();
  await run(v, [], ai2);
  assert.equal(e.chars, ai2.calls.call[0].system.length + ai2.calls.call[0].prompt.length, 'the estimate counts what the call sends');
  const scoped = await run(v, [B, A], ai, { estimate: true });
  assert.deepEqual([scoped.scope, scoped.considered, scoped.of], [{ paths: [B, A] }, 2, 2]);
  assert.equal(ai.calls.estimate[1].outTokens, 800);
});

test('aos memory sweep runs this module: --estimate, a scoped run, dismiss, and the refusal as `aos: …`', async () => {
  const { main } = require('../../../cli/memory.js');
  const v = fixture();
  const out = [];
  const io = { log: (s) => out.push(s) };
  const ai = fakeAi({ reply: { suggestions: [card('merge', [A, B], 'Releases')] } });
  await main(['sweep', '--estimate', '--json'], { vault: v, ai, io });
  assert.deepEqual(Object.keys(JSON.parse(out.pop())), ['scope', 'considered', 'of', 'estimate']);
  await main(['sweep', A, B, '--json'], { vault: v, ai, io });
  const r = JSON.parse(out.pop());
  assert.deepEqual(Object.keys(r), ['run', 'suggestions']);
  assert.deepEqual(r.run.scope, { paths: [A, B] });
  await main(['sweep', 'dismiss', r.suggestions[0].id, '--json'], { vault: v, ai, io });
  assert.deepEqual(JSON.parse(out.pop()), { dismissed: r.suggestions[0].id, already: false });
  await assert.rejects(main(['sweep', '--json'], { vault: v, ai: fakeAi({ available: false, reason: 'forced' }), io }),
    { message: 'the sweep cannot run (No model provider is set up.)' });
});

// ── the local engine (local-first A15): brain-hub's groups in chunks within the model's context ──

const localAi = (o = {}) => fakeAi({ provider: 'ollama', model: 'qwen3.5:9b', ...o });

test('hubGroups: pairs and clusters joined where they share a memory, among the live memories only', () => {
  const v = fixture();
  const memories = ops.listMemories(v).filter((m) => m.live);
  const hub = JSON.parse(read(v, 'brain/_index/brain-hub.json'));
  // A–B and B–G (G archived) and the clusters [A, B, C] and [D, G] (G out): one group, A, B and C.
  assert.deepEqual(sw.hubGroups(memories, hub).map((g) => g.map((m) => m.path).sort()), [[A, B, C].sort()]);
  const two = { ...hub, dups: [...hub.dups, { a: E, b: F, score: 0.8 }] };
  assert.deepEqual(sw.hubGroups(memories, two).map((g) => g.length), [3, 2], 'biggest first');
  assert.deepEqual(sw.hubGroups(memories, null), []);
});

test('localChunks: groups packed into prompts within maxChars; a group too big goes on in the next chunk; at most maxChunks', () => {
  const v = fixture();
  const memories = ops.listMemories(v).filter((m) => m.live).map((m) => ({ ...m, text: read(v, m.path) }));
  const hub = { ...HUB, dups: [...HUB.dups, { a: E, b: F, score: 0.8 }] };
  const one = sw.localChunks(memories, hub, { now: NOW });
  assert.equal(one.length, 1, 'two small groups share one chunk');
  assert.deepEqual(one[0].paths.sort(), [A, B, C, E, F].sort());
  assert.match(one[0].prompt, /^MEMORIES \(5 of 5\)/);
  const tight = sw.localChunks(memories, hub, { now: NOW, maxChars: 900 });
  assert.ok(tight.length > 1, 'split');
  for (const c of tight) assert.ok(c.prompt.length <= 900, `${c.prompt.length}`);
  assert.deepEqual(tight.flatMap((c) => c.paths).sort(), [A, B, C, E, F].sort(), 'every grouped memory once');
  assert.equal(sw.localChunks(memories, hub, { now: NOW, maxChars: 900, maxChunks: 1 }).length, 1);
  assert.deepEqual(sw.localChunks([memories[0]], null, { scoped: true, now: NOW })[0].paths, [memories[0].path], 'a scope is its own group');
});

test('a local sweep: one call per chunk, cards only on that chunk\'s memories, merged once, free', async () => {
  const v = fixture();
  put(v, 'brain/_index/brain-hub.json', JSON.stringify({ ...HUB, dups: [...HUB.dups, { a: E, b: F, score: 0.8 }] }));
  let n = 0;
  const ai = localAi({
    reply: (o) => {
      n++;
      // Each chunk proposes the release merge, and one card naming a memory it was not sent (D is in no group).
      return { suggestions: [card('merge', [A, B], 'Releases'), card('archive', [D]), card('retitle', [E], 'Ports in use now')] };
    },
  });
  const est = await run(v, [], ai, { estimate: true });
  assert.deepEqual([est.considered, est.of, est.chunks], [5, 6, 1]);
  const r = await sw.sweep(v, [], { ai, now: NOW, cfg: {} });
  assert.equal(n, 1);
  assert.deepEqual(r.suggestions.map((c) => c.kind).sort(), ['merge', 'retitle']);
  assert.deepEqual([r.run.provider, r.run.model, r.run.usd, r.run.considered, r.run.of, r.run.chunks, r.run.failedChunks], ['ollama', 'qwen3.5:9b', 0.0123, 5, 6, 1, 0]);
  assert.match(ai.calls.call[0].system, /At most 10 cards/, 'a chunk asks for at most a scope\'s cards');
});

test('a local sweep over several chunks: a card stands only in the chunk that sent its memories, once; a failed chunk is left out; all failing refuses', async () => {
  const v = fixture();
  put(v, 'brain/_index/brain-hub.json', JSON.stringify({ ...HUB, dups: [...HUB.dups, { a: E, b: F, score: 0.8 }] }));
  const sent = [];
  // Every chunk proposes both merges: each is kept from the one chunk that sent both of its memories.
  const ai = localAi({ reply: (o) => { sent.push(o.prompt); return { suggestions: [card('merge', [A, B], 'Releases'), card('merge', [E, F], 'Ports')] }; } });
  const est = await sw.sweep(v, [], { ai, now: NOW, estimate: true, chunkChars: 900 });
  assert.ok(est.chunks >= 2, `${est.chunks} chunks`);
  const r = await sw.sweep(v, [], { ai, now: NOW, chunkChars: 900 });
  assert.equal(sent.length, est.chunks);
  assert.deepEqual(r.suggestions.map((c) => c.paths.slice().sort().join(' ')).sort(), [[A, B].sort().join(' '), [E, F].sort().join(' ')].sort());
  assert.deepEqual([r.run.chunks, r.run.failedChunks, r.run.considered], [est.chunks, 0, 5]);

  // The first chunk fails (the engine went away mid-run): the rest still stand.
  let k = 0;
  const flaky = localAi({ reply: () => ({ suggestions: [card('merge', [E, F], 'Ports')] }), onCall: () => { if (k++ === 0) throw Object.assign(new Error('socket hang up'), { code: 'PROVIDER_UNREACHABLE' }); } });
  const part = await sw.sweep(v, [], { ai: flaky, now: NOW, chunkChars: 900 });
  assert.equal(part.run.failedChunks, 1);
  // Every chunk failing refuses as one call would, and writes nothing new.
  const before = read(v, sw.SWEEP_PATH);
  const down = localAi({ callError: Object.assign(new Error('x'), { code: 'PROVIDER_NONE' }) });
  await assert.rejects(sw.sweep(v, [], { ai: down, now: NOW, chunkChars: 900 }), { code: 'NO_MODEL' });
  assert.equal(read(v, sw.SWEEP_PATH), before);
});

test('a local whole-brain sweep with no duplicates or clusters has nothing to send: EMPTY, saying why', async () => {
  const v = fixture({ hub: null });
  const ai = localAi();
  const est = await run(v, [], ai, { estimate: true });
  assert.deepEqual([est.considered, est.of, est.chunks], [0, 6, 0]);
  await assert.rejects(run(v, [], ai), { code: 'EMPTY', message: /no duplicates or clusters to sweep yet/ });
  assert.equal(ai.calls.call.length, 0);
  // A scoped run sends its scope, linked or not.
  const scoped = await run(v, [E, F], localAi({ reply: { suggestions: [card('retitle', [F], 'My role')] } }));
  assert.deepEqual([scoped.run.considered, scoped.run.chunks, scoped.suggestions.length], [2, 1, 1]);
});

test('host: "Run once on Claude/Codex" reaches the seam on the estimate and the call', async () => {
  const v = fixture();
  const ai = fakeAi({ reply: { suggestions: [] } });
  await sw.sweep(v, [A, B], { ai, now: NOW, host: 'claude' });
  assert.equal(ai.calls.estimate[0].host, 'claude');
  assert.equal(ai.calls.call[0].host, 'claude');
});
