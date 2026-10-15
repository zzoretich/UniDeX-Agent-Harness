import { Graph, GraphNode } from "./graph";

export interface SimParams {
  repulsion: number;
  spring: number;
  restLength: number;
  centerGravity: number;
  damping: number;
}

/**
 * Softens repulsion at close range (px²): two nodes a pixel apart push with repulsion / (d² + SOFTEN) rather than
 * repulsion / d², so a near-collision can no longer fling a node thousands of pixels away and leave it outside the fitted
 * view (a 405- or a 420-memory map did, every time). Beyond about 15 px it changes the force by under a tenth.
 */
export const SOFTEN = 25;

export const DEFAULT_PARAMS: SimParams = {
  repulsion: 1600,
  spring: 0.045,
  restLength: 90,
  centerGravity: 0.0015,
  damping: 0.84,
};

/**
 * The push between two overlapping nodes `i` and `j` (node indices): a direction of length about 1 fixed by the pair,
 * pointing opposite ways for i and for j, so the two separate instead of being kicked the same way.
 */
export function overlapDirection(i: number, j: number): [number, number] {
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  const angle = (((lo * 0.6180339887 + hi * 0.4142135624) % 1) + 1) % 1 * 2 * Math.PI;
  const sign = i < j ? 1 : -1;
  return [sign * Math.cos(angle), sign * Math.sin(angle)];
}

export function tick(graph: Graph, p: SimParams = DEFAULT_PARAMS): void {
  const { nodes, edges } = graph;

  // repulsion: O(n^2) — fine for <300 nodes
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (a.fixed) continue;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        // Nodes on top of each other: push them apart along a direction fixed by the pair, opposite for each node, so the
        // layout is the same on every run (Math.random made the Map, and its test, differ from run to run).
        [dx, dy] = overlapDirection(i, j);
        d2 = dx * dx + dy * dy + 1;
      }
      const f = p.repulsion / (d2 + SOFTEN);
      const inv = 1 / Math.sqrt(d2);
      a.vx += dx * inv * f;
      a.vy += dy * inv * f;
    }
  }

  // spring along edges
  for (const e of edges) {
    const a = graph.byId.get(e.from);
    const b = graph.byId.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const f = p.spring * (dist - p.restLength);
    const fx = (dx / dist) * f;
    const fy = (dy / dist) * f;
    if (!a.fixed) { a.vx += fx; a.vy += fy; }
    if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
  }

  // gravity + integrate
  for (const n of nodes) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx += -n.x * p.centerGravity;
    n.vy += -n.y * p.centerGravity;
    n.vx *= p.damping;
    n.vy *= p.damping;
    n.x += n.vx;
    n.y += n.vy;
  }
}

export function settle(graph: Graph, iterations: number = 180, p?: SimParams): void {
  for (let i = 0; i < iterations; i++) tick(graph, p);
}
