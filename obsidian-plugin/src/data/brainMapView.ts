// The Map's pure logic (spec 2026-10-11-brain-hub D19, D23; views/brain/MapMode.ts, canvas Map): what the three views
// draw from brain-map.json (brainModel.ts parseBrainMap) and the files. Communities: a deterministic bubble packing sized
// by memories, each community's counts (memories, unreviewed from the files, used this week from brain-hub.json's usage),
// its members and the communities it links to. Around a memory: the memories the map holds, and one's neighbours on a
// ring. Every node: the force view's graph, memory nodes only, linked by the map's neighbours. The footer's counts. No
// DOM and no clock of its own ("now" comes in), so node:test can load it.
import type { Graph, GraphEdge, GraphNode } from "./graph";
import { clip, matchesQuery, shortDay, writtenAt, type BrainMap, type BrainMemory, type HubUsage } from "./brainModel";

// ── the views and the empty states ──

export const MAP_VIEWS = ["communities", "around", "every"] as const;
export type MapView = (typeof MAP_VIEWS)[number];
export const MAP_VIEW_LABEL: Record<MapView, string> = { communities: "Communities", around: "Around a memory", every: "Every node" };
export function isMapView(x: unknown): x is MapView { return typeof x === "string" && (MAP_VIEWS as readonly string[]).includes(x); }

/** Why the Map has nothing to draw (D19): the graph is off (the command that turns it on), or no map was written yet. */
export interface MapEmpty { state: "off" | "missing"; before: string; command: string | null; after: string }

/**
 * The Map's empty state, or null when there is a map to draw. graph.enabled false wins over a map an earlier scan left
 * (it says what turns the graph on); a missing file reads as "missing" (the scan writes brain-map.json beside brain-hub.json).
 */
export function mapEmpty(map: BrainMap | null, graphOn: boolean): MapEmpty | null {
  if (!graphOn || map?.state === "off") {
    return { state: "off", before: "The graph is off. ", command: "aos graph on", after: " builds it, and the next scan draws the map from it." };
  }
  if (!map || map.state !== "ok") return { state: "missing", before: "No map yet: the next scan writes it.", command: null, after: "" };
  return null;
}

/** The empty state as one line (tests, the region's label). */
export function mapEmptyText(e: MapEmpty): string { return `${e.before}${e.command ?? ""}${e.after}`; }

// ── words ──

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** 5265 → "5,265" (no locale: the same on every machine). */
export function thousands(n: number): string { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

/** "just now", "12m ago", "2h ago", "3d ago", else "Oct 2"; "" for anything that is not a time. Compared as times. */
export function builtAgo(iso: string | null | undefined, now: Date): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now.getTime() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return shortDay(iso, now);
}

// ── Communities (D19): counts, members, links ──

/** One community as the page shows it: the map's members the files still hold live, counted against the files. */
export interface CommunityView {
  id: string;
  /** The lead's title as the file says now (the map's name when the file is gone). */
  name: string;
  lead: string;
  /** Its live members, most linked first (the map's order). */
  paths: string[];
  memories: number;
  /** Members with `reviewed: false` (BrainMemory.reviewed). */
  unreviewed: number;
  /** Members used in the last 7 days (brain-hub.json usage d7); null without a usage log. */
  usedWeek: number | null;
  /** Links between its own memories (brain-map.json). */
  edges: number;
}

const liveIn = (byPath: ReadonlyMap<string, BrainMemory>, p: string): BrainMemory | null => {
  const m = byPath.get(p);
  return m && m.live ? m : null;
};

/**
 * The map's communities against the files: members gone or retired since the scan drop out, a community left with none
 * drops out, the map's order (largest first) stays. `usage` is brain-hub.json's usage when there is a log to read
 * (telemetry on and a `since`), else null.
 */
export function communityViews(map: BrainMap, byPath: ReadonlyMap<string, BrainMemory>, usage: HubUsage | null): CommunityView[] {
  const out: CommunityView[] = [];
  for (const c of map.communities) {
    const paths = c.paths.filter((p) => liveIn(byPath, p));
    if (!paths.length) continue;
    out.push({
      id: c.id, name: liveIn(byPath, c.lead)?.title ?? c.name, lead: c.lead, paths, memories: paths.length,
      unreviewed: paths.filter((p) => byPath.get(p)!.reviewed === false).length,
      usedWeek: usage ? paths.filter((p) => (usage.paths[p]?.d7 ?? 0) > 0).length : null,
      edges: c.edges,
    });
  }
  return out;
}

/** The unreviewed share, 0 to 1 (the bubble's ring, D23: with its word beside it). */
export function unreviewedShare(c: Pick<CommunityView, "memories" | "unreviewed">): number {
  return c.memories > 0 ? Math.min(1, Math.max(0, c.unreviewed / c.memories)) : 0;
}

/** A bubble's accessible name: "Release notes, 14 memories, 11 unreviewed". */
export function bubbleLabel(c: Pick<CommunityView, "name" | "memories" | "unreviewed">): string {
  return `${c.name}, ${plural(c.memories, "memory", "memories")}, ${c.unreviewed} unreviewed`;
}

/** The bubble's second line: "14", or "14 · 11 unreviewed" (the ring's word). */
export function bubbleCaption(c: Pick<CommunityView, "memories" | "unreviewed">): string {
  return c.unreviewed > 0 ? `${c.memories} · ${c.unreviewed} unreviewed` : String(c.memories);
}

/** The card's line: "14 memories · 11 unreviewed · 2 used this week" (the last part only with a usage log). */
export function communityLine(c: Pick<CommunityView, "memories" | "unreviewed" | "usedWeek">): string {
  const parts = [plural(c.memories, "memory", "memories"), `${c.unreviewed} unreviewed`];
  if (c.usedWeek !== null) parts.push(`${c.usedWeek} used this week`);
  return parts.join(" · ");
}

/** One MEMBERS row: its title and what it says on the right ("6× used" this week, else the day it was written). */
export interface MemberRow { path: string; title: string; note: string; used: boolean; unreviewed: boolean }

export function memberRows(c: Pick<CommunityView, "paths">, byPath: ReadonlyMap<string, BrainMemory>, usage: HubUsage | null, written: ReadonlyMap<string, string>, now: Date): MemberRow[] {
  const out: MemberRow[] = [];
  for (const p of c.paths) {
    const m = liveIn(byPath, p);
    if (!m) continue;
    const d7 = usage?.paths[p]?.d7 ?? 0;
    out.push({ path: p, title: m.title, note: d7 > 0 ? `${d7}× used` : shortDay(writtenAt(m, written), now), used: d7 > 0, unreviewed: m.reviewed === false });
  }
  return out;
}

/** A LINKED COMMUNITIES row: another shown community and how many links join the two. */
export interface LinkedRow { id: string; name: string; n: number }

/** The communities `id` links to, the most links first (then the name); only those the page shows. */
export function linkedCommunities(map: BrainMap, id: string, shown: readonly CommunityView[]): LinkedRow[] {
  const byId = new Map(shown.map((c) => [c.id, c]));
  const n = new Map<string, number>();
  for (const l of map.links) {
    const other = l.a === id ? l.b : l.b === id ? l.a : null;
    if (other === null || other === id || !byId.has(other) || l.n <= 0) continue;
    n.set(other, (n.get(other) ?? 0) + l.n);
  }
  return [...n].map(([o, k]) => ({ id: o, name: byId.get(o)!.name, n: k })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/** The selection after the data changed: `sel` while it is shown, else the first (largest) community, else null. */
export function pickCommunity(shown: readonly Pick<CommunityView, "id">[], sel: string | null): string | null {
  return sel !== null && shown.some((c) => c.id === sel) ? sel : shown[0]?.id ?? null;
}

// ── the bubble packing (deterministic: the same communities and canvas give the same picture) ──

/** What one bubble needs: its id, its size in memories, and its caption's width estimate in px. */
export interface BubbleIn { id: string; n: number; labelW: number }
/** A packed bubble: its centre and radius, in canvas px. */
export interface BubbleAt { id: string; x: number; y: number; r: number }

export const BUBBLE = {
  /** r = minR + k·√n: area grows with the memories. */
  minR: 10, k: 5,
  /** Space between two bubbles' footprints. */
  gap: 10,
  /** Between a circle and its caption, and the caption's two lines. */
  captionGap: 4, captionH: 30,
  /** A caption's width estimate: characters at 12 px Inter (name) and 10.5 px mono (count), capped. */
  charW: 6.6, monoW: 6.4, labelMax: 176,
  /** The canvas edge, and how far a roomy canvas scales the picture up (a map of five communities fills its pane). */
  pad: 16, maxScale: 2,
} as const;

/** A bubble's radius at scale 1. */
export function bubbleRadius(n: number): number { return BUBBLE.minR + BUBBLE.k * Math.sqrt(Math.max(0, n)); }

/** A caption's width estimate (the name as drawn, clipped to 26 characters, and its count line). */
export function captionWidth(name: string, caption: string): number {
  return Math.min(BUBBLE.labelMax, Math.max(clip(name, 26).length * BUBBLE.charW, caption.length * BUBBLE.monoW) + 8);
}

interface Foot { x: number; y: number; r: number; w: number }
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const SPIRAL_STEPS = 24000;

/** Whether two footprints (a circle and the caption box under it) come closer than `gap`. */
function clash(a: Foot, b: Foot, gap: number): boolean {
  const rect = (f: Foot): [number, number, number, number] => [f.x - f.w / 2, f.y + f.r + BUBBLE.captionGap, f.x + f.w / 2, f.y + f.r + BUBBLE.captionGap + BUBBLE.captionH];
  const circleRect = (c: Foot, r: [number, number, number, number]): boolean => {
    const dx = c.x - Math.max(r[0], Math.min(c.x, r[2]));
    const dy = c.y - Math.max(r[1], Math.min(c.y, r[3]));
    return dx * dx + dy * dy < (c.r + gap) * (c.r + gap);
  };
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  if (dx * dx + dy * dy < (a.r + b.r + gap) * (a.r + b.r + gap)) return true;
  const ra = rect(a);
  const rb = rect(b);
  if (ra[0] < rb[2] + gap && rb[0] < ra[2] + gap && ra[1] < rb[3] + gap && rb[1] < ra[3] + gap) return true;
  return circleRect(a, rb) || circleRect(b, ra);
}

/**
 * Packs the bubbles around (0, 0), largest first (ties by id): each goes to the first free place on a sunflower spiral
 * that starts at the centre of the bubbles already placed that it links to (weighted by links), so linked communities sit
 * together. `aspect` (width / height) stretches the spiral to the canvas. Radii are bubbleRadius × `rScale`; captions keep
 * their size.
 */
export function packBubbles(items: readonly BubbleIn[], links: ReadonlyArray<{ a: string; b: string; n: number }>, aspect = 1, rScale = 1): BubbleAt[] {
  const order = [...items].sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sx = Math.sqrt(Math.min(2.2, Math.max(0.5, Number.isFinite(aspect) && aspect > 0 ? aspect : 1)));
  const placed: Foot[] = [];
  const at = new Map<string, Foot>();
  const out: BubbleAt[] = [];
  for (const it of order) {
    const r = bubbleRadius(it.n) * rScale;
    let tx = 0, ty = 0, wsum = 0;
    for (const l of links) {
      const other = l.a === it.id ? l.b : l.b === it.id ? l.a : null;
      const f = other === null ? undefined : at.get(other);
      if (!f || l.n <= 0) continue;
      tx += f.x * l.n; ty += f.y * l.n; wsum += l.n;
    }
    if (wsum > 0) { tx /= wsum; ty /= wsum; }
    let foot: Foot | null = null;
    for (let i = 0; i < SPIRAL_STEPS && !foot; i++) {
      const rho = 3 * Math.sqrt(i);
      const c: Foot = { x: tx + rho * Math.cos(i * GOLDEN) * sx, y: ty + rho * Math.sin(i * GOLDEN) / sx, r, w: it.labelW };
      if (!placed.some((p) => clash(p, c, BUBBLE.gap))) foot = c;
    }
    // Never reached for the few dozen communities a map holds; to the right of everything, which is always free.
    if (!foot) foot = { x: Math.max(...placed.map((p) => p.x + Math.max(p.r, p.w / 2))) + BUBBLE.gap + Math.max(r, it.labelW / 2), y: 0, r, w: it.labelW };
    placed.push(foot);
    at.set(it.id, foot);
    out.push({ id: it.id, x: foot.x, y: foot.y, r });
  }
  return out;
}

/** The box the bubbles and their captions take. */
function extent(bs: readonly BubbleAt[], widths: ReadonlyMap<string, number>): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of bs) {
    const w = (widths.get(b.id) ?? 0) / 2;
    x0 = Math.min(x0, b.x - Math.max(b.r, w));
    x1 = Math.max(x1, b.x + Math.max(b.r, w));
    y0 = Math.min(y0, b.y - b.r);
    y1 = Math.max(y1, b.y + b.r + BUBBLE.captionGap + BUBBLE.captionH);
  }
  return { x0, y0, x1, y1 };
}

/**
 * The bubbles laid out in a w × h canvas: packed, then fitted (centred, scaled up to BUBBLE.maxScale on a roomy canvas).
 * On a tight canvas the radii shrink and the packing runs again, since captions keep their size; at most four rounds.
 */
export function layoutBubbles(items: readonly BubbleIn[], links: ReadonlyArray<{ a: string; b: string; n: number }>, w: number, h: number): BubbleAt[] {
  if (!items.length) return [];
  const widths = new Map(items.map((i) => [i.id, i.labelW]));
  const W = Math.max(80, w - 2 * BUBBLE.pad);
  const H = Math.max(80, h - 2 * BUBBLE.pad);
  let rScale = 1;
  let packed: BubbleAt[] = [];
  let s = 1;
  for (let round = 0; round < 4; round++) {
    packed = packBubbles(items, links, W / H, rScale);
    const e = extent(packed, widths);
    s = Math.min(W / Math.max(1, e.x1 - e.x0), H / Math.max(1, e.y1 - e.y0));
    if (s >= 0.97 || rScale <= 0.35) break;
    rScale = Math.max(0.35, rScale * s * 0.97);
  }
  const scale = Math.min(BUBBLE.maxScale, s);
  const e = extent(packed, widths);
  const cx = (e.x0 + e.x1) / 2;
  const cy = (e.y0 + e.y1) / 2;
  return packed.map((b) => ({ id: b.id, x: w / 2 + (b.x - cx) * scale, y: h / 2 + (b.y - cy) * scale, r: Math.max(6, b.r * scale) }));
}

// ── Around a memory (D19): the picker and the neighbours ──

/** A memory the map holds, as the picker lists it. */
export interface AroundPick { path: string; title: string; degree: number; community: string | null }

/** The memories the map holds that the files hold live, matching `query` (title or path), most linked first, then by title. */
export function aroundPicks(map: BrainMap, byPath: ReadonlyMap<string, BrainMemory>, shown: readonly CommunityView[], query = ""): AroundPick[] {
  const names = new Map(shown.map((c) => [c.id, c.name]));
  const out: AroundPick[] = [];
  for (const [p, mm] of Object.entries(map.memories)) {
    const m = liveIn(byPath, p);
    if (!m || !matchesQuery(query, m.title, p)) continue;
    out.push({ path: p, title: m.title, degree: mm.degree, community: mm.community ? names.get(mm.community) ?? null : null });
  }
  return out.sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title) || (a.path < b.path ? -1 : 1));
}

/** One neighbour row: the memory, how many links join the two, and its community's name (null: none shown). */
export interface AroundRow { path: string; title: string; n: number; community: string | null }

/** `path`'s neighbours (at most 12, the strongest first, as the map lists them) that the files hold live. */
export function aroundRows(map: BrainMap, path: string, byPath: ReadonlyMap<string, BrainMemory>, shown: readonly CommunityView[]): AroundRow[] {
  const names = new Map(shown.map((c) => [c.id, c.name]));
  const out: AroundRow[] = [];
  for (const nb of map.memories[path]?.neighbours ?? []) {
    const m = liveIn(byPath, nb.path);
    if (!m || nb.path === path) continue;
    const c = map.memories[nb.path]?.community ?? null;
    out.push({ path: nb.path, title: m.title, n: nb.n, community: c ? names.get(c) ?? null : null });
  }
  return out.slice(0, 12);
}

/**
 * Which memory Around shows: `sel` while the map and the files hold it, else the selected community's lead, else the most
 * linked memory the map holds; null when it holds none.
 */
export function pickAround(map: BrainMap, byPath: ReadonlyMap<string, BrainMemory>, sel: string | null, lead: string | null): string | null {
  const ok = (p: string | null): p is string => p !== null && !!map.memories[p] && !!liveIn(byPath, p);
  if (ok(sel)) return sel;
  if (ok(lead)) return lead;
  let best: string | null = null;
  let deg = -1;
  for (const [p, m] of Object.entries(map.memories)) {
    if (!liveIn(byPath, p)) continue;
    if (m.degree > deg || (m.degree === deg && best !== null && p < best)) { best = p; deg = m.degree; }
  }
  return best;
}

/** Where a neighbour's caption goes: beside it, away from the centre (above or below at the top and the bottom). */
export type AroundSide = "left" | "right" | "top" | "bottom";
export interface AroundAt { x: number; y: number; side: AroundSide }

/**
 * The neighbours on an ellipse round the centre of a w × h canvas, the first at the top, then clockwise; captions sit
 * outward, so neighbours on the right read left to right and those on the left end at their dot.
 */
export function aroundLayout(count: number, w: number, h: number): AroundAt[] {
  const n = Math.max(0, Math.floor(count));
  const cx = w / 2;
  const cy = h / 2;
  // Side captions read outward and run up to ~200 px: the ellipse leaves them that much room.
  const rx = Math.max(60, w / 2 - 205);
  const ry = Math.max(60, h / 2 - 46);
  const out: AroundAt[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const side: AroundSide = c > 0.3 ? "right" : c < -0.3 ? "left" : s < 0 ? "top" : "bottom";
    out.push({ x: cx + rx * (Math.abs(c) < 1e-9 ? 0 : c), y: cy + ry * (Math.abs(s) < 1e-9 ? 0 : s), side });
  }
  return out;
}

/** A link's stroke width in px, for `n` links: 1 to 5, growing slowly. */
export function linkWidth(n: number): number { return Math.min(5, 1 + Math.log2(Math.max(1, n))); }

// ── the footer (D19): the graph, the hubs left out, what fell under mapMin ──

/** The footer's lines: graphify's whole graph, the index hubs left out, the smaller groups and the unlinked memories. */
export function mapFooter(map: BrainMap): string[] {
  const out: string[] = [];
  const g = map.graph;
  if (g) out.push(`${thousands(g.communities)} communities · ${thousands(g.nodes)} nodes · ${thousands(g.edges)} links in graphify's graph.`);
  if (map.hubs.length) {
    const mocs = map.hubs.filter((h) => /(^|\/)MOC-[^/]*\.md$/.test(h)).length;
    const named = map.hubs.filter((h) => !/(^|\/)MOC-[^/]*\.md$/.test(h)).map((h) => h.slice(h.lastIndexOf("/") + 1));
    const parts = [...named, ...(mocs ? [plural(mocs, "MOC", "MOCs")] : [])];
    out.push(`Index hubs left out: ${parts.join(", ")}.`);
  }
  const sm = map.smaller;
  if (sm.communities > 0) out.push(`${plural(sm.communities, "smaller group", "smaller groups")} (under ${map.mapMin} memories) hold ${plural(sm.memories, "memory", "memories")}.`);
  if (map.unlinked > 0) out.push(`${plural(map.unlinked, "memory links", "memories link")} to no other.`);
  out.push("Names come from each community's most-linked memory.");
  return out;
}

// ── Every node (D19): the force view, memory nodes only ──

/** A path's 32-bit FNV-1a hash: the seed for its place, so a fresh build starts from the same picture. */
export function hashPath(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * The force view's graph from brain-map.json: a node per memory the map holds and the files hold live (kind "memory",
 * labelled by its title), an edge per neighbour pair (once, the lower path first). Seeded deterministically: each
 * community's members round a point on a circle (the map's order), the rest round the middle.
 */
export function everyNodeGraph(map: BrainMap, byPath: ReadonlyMap<string, BrainMemory>): Graph {
  const paths = Object.keys(map.memories).filter((p) => liveIn(byPath, p)).sort();
  const ci = new Map(map.communities.map((c, i) => [c.id, i]));
  const k = Math.max(1, map.communities.length);
  const ring = 120 + 40 * Math.sqrt(k);
  const nodes: GraphNode[] = paths.map((p) => {
    const h = hashPath(p);
    const c = map.memories[p].community;
    const i = c !== null ? ci.get(c) : undefined;
    const a = i === undefined ? 0 : (i * 2 * Math.PI) / k;
    const R = i === undefined ? 0 : ring;
    const t = ((h & 0xffff) / 0x10000) * 2 * Math.PI;
    const d = 20 + ((h >>> 16) / 0x10000) * (i === undefined ? 160 : 70);
    return { id: p, path: p, label: clip(byPath.get(p)!.title, 32), kind: "memory", mtime: 0, x: R * Math.cos(a) + d * Math.cos(t), y: R * Math.sin(a) + d * Math.sin(t), vx: 0, vy: 0 };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    for (const nb of map.memories[p].neighbours) {
      if (nb.path === p || !byId.has(nb.path)) continue;
      const [from, to] = p < nb.path ? [p, nb.path] : [nb.path, p];
      const key = `${from}\n${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to });
    }
  }
  return { nodes, edges, byId };
}

/** Degree per node id (the drawn radius, and which nodes carry a label). */
export function degrees(g: Pick<Graph, "edges">): Map<string, number> {
  const deg = new Map<string, number>();
  for (const e of g.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  return deg;
}

/** A node's radius in graph units, by its degree (the force view's 4 to 8). */
export function nodeRadius(deg: number): number { return 4 + Math.min(4, Math.max(0, deg) * 0.6); }

/** On screen, however far the view is zoomed out: a node's smallest radius and a label's font size (px). */
export const NODE_MIN_PX = 3;
export const LABEL_PX = 11;

/**
 * The radius to draw in graph units at `scale`: the degree's radius, or, zoomed out so far that it would fall under
 * NODE_MIN_PX on screen, NODE_MIN_PX plus a little for its degree (3 to 5.4 px), so the most linked still stand out.
 */
export function drawnRadius(deg: number, scale: number): number {
  const s = Math.max(1e-6, scale);
  const r = nodeRadius(deg);
  return Math.max(r, (NODE_MIN_PX + (r - 4) * 0.6) / s);
}

/** The label font size in graph units: LABEL_PX on screen at any zoom. */
export function labelFont(scale: number): number { return LABEL_PX / Math.max(1e-6, scale); }

/** A label candidate in screen px: its node's centre and drawn radius, and its text. */
export interface LabelCand { id: string; x: number; y: number; r: number; text: string; deg: number }

/** At most this many labels on a w × h canvas: one per 10,000 px², 12 to 80. */
export function labelCap(w: number, h: number): number { return Math.max(12, Math.min(80, Math.round((w * h) / 10000))); }

/**
 * The labels to show (ids): the most linked first (then by text), each kept only when its box (right of its node, 11 px
 * text) is on the canvas and clear of every label kept before it and of the other kept nodes, up to `cap`. Zoomed in, the
 * same graph covers more screen and more labels fit.
 */
export function pickLabels(cands: readonly LabelCand[], w: number, h: number, cap = labelCap(w, h)): Set<string> {
  const ranked = [...cands].sort((a, b) => b.deg - a.deg || a.text.localeCompare(b.text) || (a.id < b.id ? -1 : 1));
  const boxes: Array<[number, number, number, number]> = [];
  const out = new Set<string>();
  for (const c of ranked) {
    if (out.size >= cap) break;
    const x0 = c.x + c.r + 3;
    const box: [number, number, number, number] = [x0, c.y - LABEL_PX * 0.65, x0 + c.text.length * LABEL_PX * 0.56, c.y + LABEL_PX * 0.65];
    if (box[0] < 0 || box[1] < 0 || box[2] > w || box[3] > h) continue;
    if (boxes.some((b) => box[0] < b[2] + 4 && b[0] < box[2] + 4 && box[1] < b[3] + 2 && b[1] < box[3] + 2)) continue;
    boxes.push(box);
    out.add(c.id);
  }
  return out;
}

/** The view that fits every node in a w × h canvas: translate and scale, clamped to [minScale, maxScale]. */
export function fitView(pts: ReadonlyArray<{ x: number; y: number }>, w: number, h: number, pad = 48, minScale = 0.05, maxScale = 1.4): { x: number; y: number; scale: number } {
  if (!pts.length) return { x: w / 2, y: h / 2, scale: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const scale = Math.max(minScale, Math.min(maxScale, (w - 2 * pad) / Math.max(1, x1 - x0), (h - 2 * pad) / Math.max(1, y1 - y0)));
  return { x: w / 2 - ((x0 + x1) / 2) * scale, y: h / 2 - ((y0 + y1) / 2) * scale, scale };
}
