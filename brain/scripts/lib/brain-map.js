'use strict';
/**
 * brain-map.js — the Brain hub's Map, brain/_index/brain-map.json (brain-hub D19). brain-hub.js builds it beside
 * brain-hub.json from graphify's own graph (graph.json, node-link) and the live memories, so the HUD draws a few KB and
 * never parses the multi-megabyte graph. No model call; deterministic for one graph (every list is sorted, every tie
 * broken by id or path).
 *
 *   state        off (graph.enabled false: `aos graph on`), missing (no readable graph.json yet), else ok
 *   hubs         the index notes left out with their links (MEMORY.md, brain/_index/MOC-*.md, brain/_index/BRAIN.md):
 *                every memory hangs off them, so kept in they would make one community of everything
 *   memories     per live memory the graph holds: its community, how many memories it links to, ≤ 12 neighbours
 *   communities  graphify's own communities (Leiden over the whole graph) holding ≥ memory.mapMin live memories, named
 *                by their most-linked memory; the smaller ones are counted, not drawn
 *   links        memory links between two kept communities, summed
 *
 * A memory link is a graph link between nodes of two live memories (each counted), or a node of no memory (a session
 * note's heading, a concept) that both link to, once per such node; a node touching more than SHARED_MAX memories is a
 * hub-like concept and links nothing. An archived or superseded memory is out with its nodes, as if deleted. The shape
 * is obsidian-plugin/src/data/brainModel.ts BrainMap (parseBrainMap is the contract). Takes the vault; resolves nothing
 * at load.
 */
const fs = require('fs');
const path = require('path');
const G = require('../sdk/lib/graph.js');
const { PATH_RE } = require('./memory-ops.js');

const MAP_MIN = 8;
const MAX_NEIGHBOURS = 12;
const SHARED_MAX = 40;
const HUB_FILE = /^(?:MEMORY\.md|brain\/_index\/BRAIN\.md|brain\/_index\/MOC-[^/]*\.md)$/;

function endId(end) { return String(end && typeof end === 'object' ? end.id : end); }
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
/** Community ids in graphify's order: numerically when both are numbers (2 before 10), else as strings. */
function cmpId(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  return cmpStr(a, b);
}

/** A node's source_file as a vault path: forward slashes, no leading `./`, an absolute one made vault-relative. */
function fileOf(vault, n) {
  let f = n.source_file;
  if (typeof f !== 'string' || !f) return null;
  if (path.isAbsolute(f)) f = path.relative(vault, f);
  return f.replace(/\\/g, '/').replace(/^\.\//, '');
}
/** A node's graphify community as a key, or null when it has none. */
function commOf(n) {
  const c = n.community;
  if (typeof c === 'number' && Number.isFinite(c)) return String(c);
  if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
}
/** The key with the largest weight; a tie goes to the lower community id; none → null. */
function heaviest(weights) {
  let best = null;
  for (const [k, w] of weights) if (best === null || w > weights.get(best) || (w === weights.get(best) && cmpId(k, best) < 0)) best = k;
  return best;
}

/** memory.mapMin when it is a positive integer, else MAP_MIN. */
function mapMinOf(cfg) {
  const want = cfg && cfg.memory && cfg.memory.mapMin;
  return Number.isInteger(want) && want >= 1 ? want : MAP_MIN;
}

/** A doc with nothing in it (brain-hub D19: not ok → every list empty, counts 0). */
function emptyMap(state, { now = Date.now(), mapMin = MAP_MIN } = {}) {
  return {
    schema: 1, builtAt: new Date(now).toISOString(), state, graph: null, mapMin,
    hubs: [], communities: [], links: [], memories: {}, smaller: { communities: 0, memories: 0 }, unlinked: 0,
  };
}

/** The whole graph as graphify built it: built time and mode from our marker (.aos-graph.json), else the file's mtime. */
function graphInfo(dir, file, g) {
  const marker = G.readMarker(dir);
  let builtAt = marker && (typeof marker.builtAt === 'string' ? marker.builtAt : typeof marker.lastStructural === 'string' ? marker.lastStructural : null);
  if (!builtAt) { try { builtAt = fs.statSync(file).mtime.toISOString(); } catch { builtAt = null; } }
  const communities = new Set();
  for (const n of g.nodes) { const c = commOf(n); if (c !== null) communities.add(c); }
  return {
    builtAt, mode: marker && typeof marker.mode === 'string' ? marker.mode : null,
    nodes: g.nodes.length, edges: g.links.length, communities: communities.size,
  };
}

/**
 * brain-map.json's doc (brain-hub D19) from <vault>/<graph.out>/graph.json and `memories` (memory-ops listMemories rows;
 * only live ones are mapped). `now` stamps builtAt. Never writes; brain-hub.js writes it.
 */
function buildBrainMap({ vault, cfg = {}, memories = [], now = Date.now() } = {}) {
  const mapMin = mapMinOf(cfg);
  const graphCfg = cfg.graph || {};
  if (graphCfg.enabled === false) return emptyMap('off', { now, mapMin });
  const dir = G.outDir(vault, graphCfg);
  const file = path.join(dir, 'graph.json');
  const g = G.loadGraph(file);
  if (!g) return emptyMap('missing', { now, mapMin });

  // 1. Hubs, and each live memory's nodes (a node is a memory's when its source_file is that memory's path).
  const titles = new Map(memories.filter((m) => m && m.live && typeof m.path === 'string').map((m) => [m.path, m.title || m.path]));
  const hubFiles = new Set();
  const hubIds = new Set();
  const hubComms = new Set();
  const memOf = new Map();       // node id → live memory path
  const retired = new Set();     // node ids of archived or superseded memories
  const commsOf = new Map();     // live memory path → its nodes' communities (null for none)
  for (const n of g.nodes) {
    const id = String(n.id);
    const f = fileOf(vault, n);
    if (f && HUB_FILE.test(f)) {
      hubFiles.add(f);
      hubIds.add(id);
      const c = commOf(n);
      if (c !== null) hubComms.add(c);
    } else if (f && titles.has(f)) {
      memOf.set(id, f);
      (commsOf.get(f) || commsOf.set(f, []).get(f)).push(commOf(n));
    } else if (f && PATH_RE.test(f)) {
      retired.add(id);
    }
  }

  // 2. Memory links: direct links, then a shared node of no memory (never a hub: hubs and their links are out).
  const pairs = new Map();       // "a\nb" (a < b) → count
  const bump = (a, b) => {
    if (a === b) return;
    const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  };
  for (const l of g.links) {
    const s = endId(l.source);
    const t = endId(l.target);
    if (hubIds.has(s) || hubIds.has(t)) continue;
    const a = memOf.get(s);
    const b = memOf.get(t);
    if (a && b) bump(a, b);
  }
  for (const n of g.nodes) {
    const id = String(n.id);
    if (hubIds.has(id) || memOf.has(id) || retired.has(id)) continue;
    const touched = new Set();
    for (const x of g.adj.get(id) || []) { const p = memOf.get(x.id); if (p) touched.add(p); }
    if (touched.size < 2 || touched.size > SHARED_MAX) continue;
    const list = [...touched].sort(cmpStr);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) bump(list[i], list[j]);
  }
  const nb = new Map();          // memory path → Map(memory path → count)
  for (const [key, n] of pairs) {
    const [a, b] = key.split('\n');
    (nb.get(a) || nb.set(a, new Map()).get(a)).set(b, n);
    (nb.get(b) || nb.set(b, new Map()).get(b)).set(a, n);
  }
  const degree = (p) => (nb.get(p) ? nb.get(p).size : 0);

  // 3. A memory's community: its own nodes' most common one outside the hub communities; else its neighbours' nodes',
  // weighted by link count (a memory graphify filed only beside MEMORY.md goes where its links go).
  const commOfMem = new Map();
  for (const [p, comms] of commsOf) {
    const own = new Map();
    for (const c of comms) if (c !== null && !hubComms.has(c)) own.set(c, (own.get(c) || 0) + 1);
    let c = heaviest(own);
    if (c === null) {
      const via = new Map();
      for (const [q, n] of nb.get(p) || []) for (const x of commsOf.get(q)) if (x !== null && !hubComms.has(x)) via.set(x, (via.get(x) || 0) + n);
      c = heaviest(via);
    }
    commOfMem.set(p, c);
  }

  // 4. Kept: ≥ mapMin memories; the rest count in `smaller` and their memories have no community.
  const members = new Map();
  for (const [p, c] of commOfMem) if (c !== null) (members.get(c) || members.set(c, []).get(c)).push(p);
  const kept = new Set();
  const smaller = { communities: 0, memories: 0 };
  for (const [c, ps] of members) {
    if (ps.length >= mapMin) kept.add(c);
    else { smaller.communities += 1; smaller.memories += ps.length; }
  }
  const keptOf = (p) => { const c = commOfMem.get(p); return c !== null && kept.has(c) ? c : null; };

  // 5. Edges inside each kept community and links between two of them.
  const inside = new Map();
  const between = new Map();
  for (const [key, n] of pairs) {
    const [a, b] = key.split('\n');
    const ca = keptOf(a);
    const cb = keptOf(b);
    if (ca === null || cb === null) continue;
    if (ca === cb) { inside.set(ca, (inside.get(ca) || 0) + n); continue; }
    const [x, y] = [`c${ca}`, `c${cb}`].sort(cmpStr);
    const k = `${x}\n${y}`;
    between.set(k, (between.get(k) || 0) + n);
  }
  const communities = [...kept].sort((x, y) => members.get(y).length - members.get(x).length || cmpId(x, y)).map((c) => {
    const paths = members.get(c).slice().sort((a, b) => degree(b) - degree(a) || cmpStr(a, b));
    return { id: `c${c}`, name: titles.get(paths[0]), lead: paths[0], paths, edges: inside.get(c) || 0 };
  });
  const links = [...between].map(([k, n]) => { const [a, b] = k.split('\n'); return { a, b, n }; })
    .sort((x, y) => y.n - x.n || cmpStr(x.a, y.a) || cmpStr(x.b, y.b));

  const out = {};
  let unlinked = 0;
  for (const p of [...commsOf.keys()].sort(cmpStr)) {
    const c = keptOf(p);
    const neighbours = [...(nb.get(p) || [])].sort((x, y) => y[1] - x[1] || cmpStr(x[0], y[0])).slice(0, MAX_NEIGHBOURS).map(([q, n]) => ({ path: q, n }));
    if (!degree(p)) unlinked += 1;
    out[p] = { community: c === null ? null : `c${c}`, degree: degree(p), neighbours };
  }

  return {
    schema: 1, builtAt: new Date(now).toISOString(), state: 'ok', graph: graphInfo(dir, file, g), mapMin,
    hubs: [...hubFiles].sort(cmpStr), communities, links, memories: out, smaller, unlinked,
  };
}

module.exports = { buildBrainMap, emptyMap, mapMinOf, MAP_MIN, MAX_NEIGHBOURS, SHARED_MAX, HUB_FILE };
