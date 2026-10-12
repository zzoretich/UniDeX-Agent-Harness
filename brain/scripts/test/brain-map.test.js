'use strict';
// brain/_index/brain-map.json (brain-hub D19): graphify's communities of live memories with the index hubs out, built
// from a synthetic node-link graph.json in a temp vault. Every title, path and note here is invented.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ops = require('../lib/memory-ops.js');
const { buildBrainMap, emptyMap, mapMinOf } = require('../lib/brain-map.js');

const NOW = Date.parse('2026-10-11T12:00:00Z');
const put = (v, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
  fs.writeFileSync(path.join(v, rel), text);
};
const P = (slug, type = 'reference') => `brain/memory/${type}/${slug}.md`;
const memText = (rel, title, status) => {
  const type = rel.split('/')[2];
  return `---\ntype: memory\ntags: [memory/${type}, status/${status}]\ncreated: 2026-10-01\n---\n\n# ${title}\n\nNotes on ${title.toLowerCase()}.\n`;
};
const node = (id, file, community, kind = 'document') => ({ id, label: id, file_type: kind, source_file: file, community });
const link = (source, target, relation = 'references') => ({ source, target, relation, confidence: 'EXTRACTED', weight: 1 });

/**
 * A temp vault holding `mems` ([path, title, status?]) and graph.json (an object, a raw string, or null for none), plus
 * the marker when given. → { v, memories } with memories as memory-ops lists them.
 */
function vaultWith({ mems, graph, marker = null, out = 'brain/graphify-out', prefix = 'bmap-' }) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  put(v, 'brain/_index/.keep', '');
  for (const [rel, title, status = 'active'] of mems) put(v, rel, memText(rel, title, status));
  if (graph !== null) put(v, `${out}/graph.json`, typeof graph === 'string' ? graph : JSON.stringify({ directed: false, multigraph: false, graph: {}, ...graph, hyperedges: [] }));
  if (marker) put(v, `${out}/.aos-graph.json`, JSON.stringify({ schema: 1, ...marker }));
  return { v, memories: ops.listMemories(v) };
}

// ── the shape: what obsidian-plugin/src/data/brainModel.ts parseBrainMap reads, checked field by field ──

const MEMORY_PATH_RE = /^brain\/memory\/(user|feedback|projects|reference)\/([a-z0-9][a-z0-9.-]{0,120})\.md$/;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
function assertShape(doc) {
  assert.deepEqual(Object.keys(doc).sort(), ['builtAt', 'communities', 'graph', 'hubs', 'links', 'mapMin', 'memories', 'schema', 'smaller', 'state', 'unlinked']);
  assert.equal(doc.schema, 1);
  assert.ok(['ok', 'off', 'missing'].includes(doc.state));
  assert.ok(typeof doc.builtAt === 'string' && !Number.isNaN(Date.parse(doc.builtAt)));
  if (doc.state === 'ok') {
    assert.deepEqual(Object.keys(doc.graph).sort(), ['builtAt', 'communities', 'edges', 'mode', 'nodes']);
    for (const k of ['nodes', 'edges', 'communities']) assert.ok(isNum(doc.graph[k]), k);
    for (const k of ['builtAt', 'mode']) assert.ok(doc.graph[k] === null || typeof doc.graph[k] === 'string', k);
  } else {
    assert.equal(doc.graph, null);
  }
  assert.ok(Number.isInteger(doc.mapMin) && doc.mapMin >= 1);
  assert.ok(Array.isArray(doc.hubs) && doc.hubs.every((h) => typeof h === 'string'));
  for (const c of doc.communities) {
    assert.deepEqual(Object.keys(c).sort(), ['edges', 'id', 'lead', 'name', 'paths']);
    assert.match(c.id, /^c.+/);
    assert.equal(typeof c.name, 'string');
    assert.equal(c.lead, c.paths[0]);
    assert.ok(c.paths.length >= doc.mapMin && c.paths.every((p) => MEMORY_PATH_RE.test(p)));
    assert.ok(isNum(c.edges));
  }
  for (const l of doc.links) {
    assert.deepEqual(Object.keys(l).sort(), ['a', 'b', 'n']);
    assert.ok(typeof l.a === 'string' && typeof l.b === 'string' && l.a < l.b && isNum(l.n) && l.n > 0);
  }
  const ids = new Set(doc.communities.map((c) => c.id));
  for (const [p, m] of Object.entries(doc.memories)) {
    assert.match(p, MEMORY_PATH_RE);
    assert.deepEqual(Object.keys(m).sort(), ['community', 'degree', 'neighbours']);
    assert.ok(m.community === null || ids.has(m.community), `${p}: ${m.community}`);
    assert.ok(Number.isInteger(m.degree) && m.degree >= m.neighbours.length);
    assert.ok(m.neighbours.length <= 12);
    for (const n of m.neighbours) { assert.match(n.path, MEMORY_PATH_RE); assert.ok(isNum(n.n) && n.n > 0); }
  }
  assert.deepEqual(Object.keys(doc.smaller).sort(), ['communities', 'memories']);
  assert.ok(isNum(doc.smaller.communities) && isNum(doc.smaller.memories) && isNum(doc.unlinked));
}

// ── the main fixture (mapMin 3) ──
// Community 1: four tide notes, plus a project graphify filed only beside MEMORY.md (community 9, a hub community)
// whose links lead to the tide notes. Community 2: three sail notes. Community 3: two knot notes (under mapMin).
// Community 4: one note linked to nothing but MEMORY.md. MEMORY.md, a MOC and BRAIN.md would link everything to
// everything; a retired note in each of communities 1 and 2 must not count.
const T = { tables: P('tide-tables'), alerts: P('tide-alerts'), charts: P('tide-charts'), units: P('tide-units') };
const S = { trim: P('sail-trim', 'feedback'), reefing: P('sail-reefing', 'feedback'), repair: P('sail-repair', 'feedback') };
const K = { bowline: P('knot-bowline'), cleat: P('knot-cleat') };
const FEES = P('harbour-fees', 'projects');
const ANCHOR = P('anchor-chain');
const OLD = { tide: P('tide-old'), sail: P('sail-old', 'feedback') };
const MEMS = [
  [T.tables, 'Tide tables'], [T.alerts, 'Tide alerts'], [T.charts, 'Tide charts'], [T.units, 'Tide units'],
  [S.trim, 'Sail trim'], [S.reefing, 'Sail reefing'], [S.repair, 'Sail repair'],
  [K.bowline, 'Knot bowline'], [K.cleat, 'Knot cleat'], [FEES, 'Harbour fees'], [ANCHOR, 'Anchor chain'],
  [OLD.tide, 'Old tide note', 'archived'], [OLD.sail, 'Old sail note', 'superseded'],
];
function mainGraph({ reverse = false } = {}) {
  const nodes = [
    ...Object.values(T).map((p) => node(p, p, 1)), node(`${T.tables}#h`, T.tables, 1),
    ...Object.values(S).map((p) => node(p, p, 2)),
    ...Object.values(K).map((p) => node(p, p, 3)),
    node(FEES, FEES, 9), node(`${FEES}#h`, FEES, 9),
    node(ANCHOR, ANCHOR, 4),
    node(OLD.tide, OLD.tide, 1), node(OLD.sail, OLD.sail, 2),
    node('MEMORY.md', 'MEMORY.md', 9), node('MEMORY.md#feedback', 'MEMORY.md', 9),
    node('moc-boats', 'brain/_index/MOC-boats.md', 9), node('brain-md', 'brain/_index/BRAIN.md', 9),
    node('session-note', 'brain/sessions/2026-10-01.md', 5),
  ];
  const links = [
    link(T.tables, `${T.tables}#h`, 'contains'),
    link(T.tables, T.alerts), link(T.tables, T.charts), link(`${T.tables}#h`, T.units), link(T.alerts, T.charts),
    link(S.reefing, S.trim), link(S.reefing, S.repair), link(S.reefing, T.tables),
    link(K.bowline, K.cleat),
    link(FEES, `${FEES}#h`, 'contains'), link(`${FEES}#h`, T.alerts), link(FEES, T.charts), link(FEES, S.trim),
    link(OLD.tide, T.tables), link(OLD.sail, S.trim), link(OLD.sail, S.repair),
    ...MEMS.filter(([, , st]) => !st).map(([p]) => link('MEMORY.md#feedback', p)), link('MEMORY.md', 'MEMORY.md#feedback', 'contains'),
    link('moc-boats', S.trim), link('moc-boats', K.cleat), link('brain-md', T.units), link('brain-md', S.repair),
  ];
  return reverse ? { nodes: nodes.reverse(), links: links.reverse() } : { nodes, links };
}
const CFG3 = { memory: { mapMin: 3 } };

test('communities from graphify with the index hubs out: members, lead and name, edges, links, smaller and unlinked', () => {
  const { v, memories } = vaultWith({ mems: MEMS, graph: mainGraph(), marker: { mode: 'structural', builtAt: '2026-10-10T08:00:00.000Z' } });
  const map = buildBrainMap({ vault: v, cfg: CFG3, memories, now: NOW });
  assertShape(map);
  assert.equal(map.state, 'ok');
  assert.equal(map.builtAt, '2026-10-11T12:00:00.000Z');
  assert.deepEqual(map.graph, { builtAt: '2026-10-10T08:00:00.000Z', mode: 'structural', nodes: 20, edges: mainGraph().links.length, communities: 6 });
  assert.equal(map.mapMin, 3);
  assert.deepEqual(map.hubs, ['MEMORY.md', 'brain/_index/BRAIN.md', 'brain/_index/MOC-boats.md']);
  assert.deepEqual(map.communities, [
    // The most-linked memory leads and names it; then by degree, then path.
    { id: 'c1', name: 'Tide tables', lead: T.tables, paths: [T.tables, FEES, T.alerts, T.charts, T.units], edges: 6 },
    { id: 'c2', name: 'Sail reefing', lead: S.reefing, paths: [S.reefing, S.trim, S.repair], edges: 2 },
  ]);
  // reefing → tables and fees → trim.
  assert.deepEqual(map.links, [{ a: 'c1', b: 'c2', n: 2 }]);
  assert.deepEqual(map.smaller, { communities: 2, memories: 3 });
  assert.equal(map.unlinked, 1);
  assert.deepEqual(map.memories[ANCHOR], { community: null, degree: 0, neighbours: [] });
  assert.deepEqual(map.memories[K.bowline], { community: null, degree: 1, neighbours: [{ path: K.cleat, n: 1 }] });
  assert.deepEqual(Object.keys(map.memories), [...Object.keys(map.memories)].sort(), 'paths in order');
});

test('a memory whose nodes sit only in a hub community goes where its links go', () => {
  const { v, memories } = vaultWith({ mems: MEMS, graph: mainGraph() });
  const map = buildBrainMap({ vault: v, cfg: CFG3, memories, now: NOW });
  // Its own nodes are all in community 9 (MEMORY.md's): two links into community 1 outweigh one into community 2.
  assert.deepEqual(map.memories[FEES], {
    community: 'c1', degree: 3, neighbours: [{ path: S.trim, n: 1 }, { path: T.alerts, n: 1 }, { path: T.charts, n: 1 }],
  });
  assert.ok(!map.communities.some((c) => c.id === 'c9'));
});

test('the hubs link nothing: two memories under one MOC, BRAIN.md or MEMORY.md stay apart', () => {
  const { v, memories } = vaultWith({ mems: MEMS, graph: mainGraph() });
  const map = buildBrainMap({ vault: v, cfg: CFG3, memories, now: NOW });
  const nbs = (p) => map.memories[p].neighbours.map((n) => n.path);
  assert.ok(!nbs(S.trim).includes(K.cleat), 'MOC-boats');
  assert.ok(!nbs(T.units).includes(S.repair), 'BRAIN.md');
  assert.deepEqual(nbs(T.units), [T.tables], 'MEMORY.md links every memory');
});

test('archived and superseded memories are absent, and their nodes link no one', () => {
  const { v, memories } = vaultWith({ mems: MEMS, graph: mainGraph() });
  const map = buildBrainMap({ vault: v, cfg: CFG3, memories, now: NOW });
  const everywhere = JSON.stringify(map);
  assert.ok(!everywhere.includes(OLD.tide) && !everywhere.includes(OLD.sail));
  assert.equal(Object.keys(map.memories).length, 11);
  // The superseded note links to both trim and repair; they are not neighbours through it.
  assert.ok(!map.memories[S.trim].neighbours.some((n) => n.path === S.repair));
});

test('mapMin cuts communities under it into `smaller`; the default is memory.mapMin 8', () => {
  const { v, memories } = vaultWith({ mems: MEMS, graph: mainGraph() });
  const at6 = buildBrainMap({ vault: v, cfg: { memory: { mapMin: 6 } }, memories, now: NOW });
  assertShape(at6);
  assert.deepEqual(at6.communities, []);
  assert.deepEqual(at6.links, []);
  assert.deepEqual(at6.smaller, { communities: 4, memories: 11 });
  assert.ok(Object.values(at6.memories).every((m) => m.community === null));
  assert.equal(at6.memories[T.tables].degree, 4, 'links stay when the community goes');
  assert.equal(at6.mapMin, 6);
  assert.equal(buildBrainMap({ vault: v, cfg: {}, memories, now: NOW }).mapMin, 8);
  assert.equal(mapMinOf({ memory: { mapMin: 'many' } }), 8);
  assert.equal(mapMinOf({ memory: { mapMin: 0 } }), 8);
});

test('two memories sharing a node of neither count once per node; a node touching more than 40 memories is skipped', () => {
  const notes = Array.from({ length: 45 }, (_, i) => P(`note-${String(i).padStart(2, '0')}`));
  const nodes = [
    ...notes.map((p) => node(p, p, 1)), node(`${notes[0]}#h`, notes[0], 1),
    node('concept-shared', 'brain/sessions/2026-10-02.md', 7, 'concept'),
    node('concept-wide', 'brain/sessions/2026-10-03.md', 7, 'concept'),
  ];
  const links = [
    link(notes[0], notes[1]),
    link('concept-shared', notes[0]), link('concept-shared', `${notes[0]}#h`), link('concept-shared', notes[1]),
    link(`${notes[0]}#h`, notes[43]),
    ...notes.slice(2, 43).map((p) => link('concept-wide', p)),
  ];
  const { v, memories } = vaultWith({ mems: notes.map((p, i) => [p, `Note ${i}`]), graph: { nodes, links } });
  const map = buildBrainMap({ vault: v, cfg: CFG3, memories, now: NOW });
  assertShape(map);
  // 0 ~ 1: one direct link and one shared node (reached twice from note 0, counted once). 0 ~ 43: its heading's link.
  assert.deepEqual(map.memories[notes[0]].neighbours, [{ path: notes[1], n: 2 }, { path: notes[43], n: 1 }]);
  assert.equal(map.memories[notes[1]].degree, 1);
  // concept-wide touches 41 memories: it links none of them.
  for (const p of notes.slice(2, 43)) assert.equal(map.memories[p].degree, 0, p);
  assert.equal(map.unlinked, 42, 'notes 2–42 and note 44');
});

test('a node touching exactly 40 memories still links them', () => {
  const notes = Array.from({ length: 40 }, (_, i) => P(`note-${String(i).padStart(2, '0')}`));
  const nodes = [...notes.map((p) => node(p, p, 1)), node('concept-forty', 'brain/sessions/2026-10-04.md', 2, 'concept')];
  const { v, memories } = vaultWith({ mems: notes.map((p, i) => [p, `Note ${i}`]), graph: { nodes, links: notes.map((p) => link('concept-forty', p)) } });
  const map = buildBrainMap({ vault: v, cfg: CFG3, memories, now: NOW });
  assert.equal(map.memories[notes[5]].degree, 39);
  assert.equal(map.communities[0].edges, (40 * 39) / 2);
});

test('neighbours: at most 12, the strongest first, then by path; degree counts them all', () => {
  const center = P('mooring-plan', 'projects');
  const spokes = Array.from({ length: 15 }, (_, i) => P(`spoke-${String(i + 1).padStart(2, '0')}`));
  const nodes = [node(center, center, 1), ...spokes.map((p) => node(p, p, 1))];
  const links = [...spokes.map((p) => link(center, p)), ...spokes.slice(12).map((p) => link(p, center, 'conceptually_related_to'))];
  const { v, memories } = vaultWith({ mems: [[center, 'Mooring plan'], ...spokes.map((p, i) => [p, `Spoke ${i + 1}`])], graph: { nodes, links } });
  const map = buildBrainMap({ vault: v, cfg: CFG3, memories, now: NOW });
  assertShape(map);
  const m = map.memories[center];
  assert.equal(m.degree, 15);
  assert.deepEqual(m.neighbours.map((n) => [path.basename(n.path, '.md'), n.n]), [
    ['spoke-13', 2], ['spoke-14', 2], ['spoke-15', 2],
    ...Array.from({ length: 9 }, (_, i) => [`spoke-${String(i + 1).padStart(2, '0')}`, 1]),
  ]);
  assert.equal(map.communities[0].name, 'Mooring plan');
  assert.equal(map.communities[0].edges, 18);
});

test('ties: a memory split evenly between two communities goes to the lower id; equal sizes order by id', () => {
  const a = P('split-note');
  const xs = [P('x-1'), P('x-2'), P('x-3'), P('x-4')];
  const ys = [P('y-1'), P('y-2'), P('y-3')];
  const nodes = [node(a, a, 10), node(`${a}#h`, a, 2), ...xs.map((p) => node(p, p, 10)), ...ys.map((p) => node(p, p, 2))];
  const { v, memories } = vaultWith({ mems: [[a, 'Split note'], ...xs.map((p) => [p, p]), ...ys.map((p) => [p, p])], graph: { nodes, links: [] } });
  const map = buildBrainMap({ vault: v, cfg: CFG3, memories, now: NOW });
  assert.equal(map.memories[a].community, 'c2', 'community 2 before community 10, numerically');
  assert.deepEqual(map.communities.map((c) => [c.id, c.paths.length]), [['c2', 4], ['c10', 4]]);
});

test('deterministic: the same graph in another order gives the same doc', () => {
  const one = vaultWith({ mems: MEMS, graph: mainGraph(), marker: { mode: 'semantic', builtAt: '2026-10-10T08:00:00.000Z' } });
  const two = vaultWith({ mems: MEMS, graph: mainGraph({ reverse: true }), marker: { mode: 'semantic', builtAt: '2026-10-10T08:00:00.000Z' } });
  const a = buildBrainMap({ vault: one.v, cfg: CFG3, memories: one.memories, now: NOW });
  const b = buildBrainMap({ vault: two.v, cfg: CFG3, memories: two.memories, now: NOW });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('state off: graph.enabled false, even with a graph on disk', () => {
  const { v, memories } = vaultWith({ mems: MEMS, graph: mainGraph() });
  const map = buildBrainMap({ vault: v, cfg: { graph: { enabled: false }, ...CFG3 }, memories, now: NOW });
  assertShape(map);
  assert.deepEqual(map, emptyMap('off', { now: NOW, mapMin: 3 }));
  assert.deepEqual(map.memories, {});
  assert.equal(map.unlinked, 0);
});

test('state missing: no graph.json, a torn one, or one that is not node-link', () => {
  for (const [why, graph] of [['none', null], ['torn', '{"nodes": [{"id": "a"'], ['not node-link', '{"elements": []}']]) {
    const { v, memories } = vaultWith({ mems: MEMS, graph });
    const map = buildBrainMap({ vault: v, cfg: CFG3, memories, now: NOW });
    assertShape(map);
    assert.equal(map.state, 'missing', why);
    assert.equal(map.graph, null, why);
    assert.deepEqual([map.communities, map.links, map.hubs, map.memories, map.smaller], [[], [], [], {}, { communities: 0, memories: 0 }], why);
  }
});

test('graph.out is followed, and without the marker the graph is dated by its file', () => {
  const { v, memories } = vaultWith({ mems: MEMS, graph: mainGraph(), out: 'graphs/vault' });
  const map = buildBrainMap({ vault: v, cfg: { graph: { out: 'graphs/vault' }, ...CFG3 }, memories, now: NOW });
  assert.equal(map.state, 'ok');
  assert.equal(map.graph.mode, null);
  assert.equal(map.graph.builtAt, fs.statSync(path.join(v, 'graphs/vault/graph.json')).mtime.toISOString());
  assert.equal(buildBrainMap({ vault: v, cfg: CFG3, memories, now: NOW }).state, 'missing', 'the default folder has none');
});

test('graphify paths are read as vault paths: absolute or ./-prefixed source files still match', () => {
  const { v } = vaultWith({ mems: [], graph: null });
  const a = P('abs-note');
  const b = P('dot-note');
  const c = P('plain-note');
  const graph = { nodes: [node('a', path.join(v, a), 1), node('b', `./${b}`, 1), node('c', c, 1), node('m', path.join(v, 'MEMORY.md'), 9)], links: [link('a', 'b'), link('b', 'c')] };
  for (const [p, t] of [[a, 'Abs'], [b, 'Dot'], [c, 'Plain']]) put(v, p, memText(p, t, 'active'));
  put(v, 'brain/graphify-out/graph.json', JSON.stringify(graph));
  const map = buildBrainMap({ vault: v, cfg: CFG3, memories: ops.listMemories(v), now: NOW });
  assert.deepEqual(map.hubs, ['MEMORY.md']);
  assert.deepEqual(map.communities.map((x) => x.paths), [[b, a, c]]);
});
