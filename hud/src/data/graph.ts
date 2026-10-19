// graph.ts — the force view's graph (brain-hub D19): Map's Every node draws the memories brain-map.json holds, linked
// by their graphify neighbours (data/brainMapView.ts builds it; data/forceSim.ts lays it out). PR 3 replaced the
// Memory tab's own wikilink graph, so a node is a memory and nothing else.
export type NodeKind = "memory";

export interface GraphNode {
  id: string;
  path: string;
  label: string;
  kind: NodeKind;
  mtime: number;
  // simulation state
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
}
