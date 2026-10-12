import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrainMap, parseMemory, shortDay, type BrainMap, type BrainMemory, type HubUsage } from "./brainModel";
import {
  BUBBLE, LABEL_PX, NODE_MIN_PX, aroundLayout, aroundPicks, aroundRows, bubbleCaption, bubbleLabel, bubbleRadius, builtAgo,
  captionWidth, communityLine, communityViews, degrees, drawnRadius, everyNodeGraph, fitView, hashPath, isMapView, labelCap,
  labelFont, layoutBubbles, linkWidth, linkedCommunities, mapEmpty, mapEmptyText, mapFooter, memberRows, nodeRadius,
  packBubbles, pickAround, pickCommunity, pickLabels, thousands, unreviewedShare, type BubbleAt, type BubbleIn,
} from "./brainMapView";
import { settle, type SimParams } from "./forceSim";

const P = (type: string, slug: string): string => `brain/memory/${type}/${slug}.md`;

/** A memory file as the runtime writes one. */
function memText(slug: string, o: { title?: string; reviewed?: boolean; status?: string; created?: string } = {}): string {
  return ["---", "type: memory", `tags: [memory/projects${o.status ? `, status/${o.status}` : ""}]`, `created: ${o.created ?? "2026-09-20"}`,
    ...(o.reviewed === undefined ? [] : [`reviewed: ${o.reviewed}`]), "---", "", `# ${o.title ?? slug}`, "", "Body.", ""].join("\n");
}

function files(spec: Record<string, { title?: string; reviewed?: boolean; status?: string; created?: string }>): Map<string, BrainMemory> {
  const out = new Map<string, BrainMemory>();
  for (const [p, o] of Object.entries(spec)) {
    const m = parseMemory(p, memText(p.split("/").pop()!.replace(/\.md$/, ""), o));
    if (m) out.set(p, m);
  }
  return out;
}

/** A brain-map.json body through the HUD's own parser (the contract). */
function mapOf(doc: Record<string, unknown>): BrainMap {
  return parseBrainMap(JSON.stringify({ schema: 1, builtAt: "2026-10-11T08:00:00Z", state: "ok", mapMin: 2, hubs: [], communities: [], links: [], memories: {}, smaller: { communities: 0, memories: 0 }, unlinked: 0, ...doc }))!;
}

const usage = (paths: Record<string, number>): HubUsage => ({
  since: "2026-09-01T00:00:00Z",
  paths: Object.fromEntries(Object.entries(paths).map(([p, d7]) => [p, { d7, d30: d7, last: null, injected: d7, recalled: 0, read: 0, claude: d7, codex: 0 }])),
});

// A small vault: two communities (garden, release) and a third the files emptied; a link between the first two.
const G1 = P("projects", "garden-plan");
const G2 = P("projects", "garden-soil");
const G3 = P("projects", "garden-tools");
const R1 = P("projects", "release-checklist");
const R2 = P("projects", "release-notes");
const X1 = P("projects", "gone-one");
const LONE = P("projects", "lone-note");
const OLD = P("projects", "old-plan");

const byPath = files({
  [G1]: { title: "Garden plan", reviewed: false },
  [G2]: { title: "Garden soil", reviewed: true },
  [G3]: { title: "Garden tools", reviewed: false },
  [R1]: { title: "Release checklist", reviewed: true },
  [R2]: { title: "Release notes renamed", reviewed: false },
  [LONE]: { title: "Lone note" },
  [OLD]: { title: "Old plan", status: "archived" },
});

const MAP = mapOf({
  graph: { builtAt: "2026-10-11T06:00:00Z", mode: "semantic", nodes: 5265, edges: 9001, communities: 674 },
  hubs: ["MEMORY.md", "brain/_index/BRAIN.md", "brain/_index/MOC-Projects.md", "brain/_index/MOC-Feedback.md"],
  communities: [
    { id: "c3", name: "Garden plan", lead: G1, paths: [G1, G2, G3, OLD], edges: 3 },
    { id: "c7", name: "Release notes", lead: R2, paths: [R2, R1], edges: 1 },
    { id: "c9", name: "Gone one", lead: X1, paths: [X1, OLD], edges: 1 },
  ],
  links: [{ a: "c3", b: "c7", n: 2 }, { a: "c7", b: "c9", n: 5 }],
  memories: {
    [G1]: { community: "c3", degree: 3, neighbours: [{ path: G2, n: 3 }, { path: G3, n: 2 }, { path: R2, n: 1 }, { path: X1, n: 1 }, { path: OLD, n: 1 }] },
    [G2]: { community: "c3", degree: 1, neighbours: [{ path: G1, n: 3 }] },
    [G3]: { community: "c3", degree: 1, neighbours: [{ path: G1, n: 2 }] },
    [R1]: { community: "c7", degree: 1, neighbours: [{ path: R2, n: 1 }] },
    [R2]: { community: "c7", degree: 2, neighbours: [{ path: R1, n: 1 }, { path: G1, n: 1 }] },
    [LONE]: { community: null, degree: 0, neighbours: [] },
    [OLD]: { community: "c3", degree: 1, neighbours: [{ path: G1, n: 1 }] },
  },
  smaller: { communities: 12, memories: 40 }, unlinked: 1,
});

test("mapEmpty: graph off (in the settings or the map) names `aos graph on`; no map or a missing one says the scan writes it; a map draws", () => {
  const off = mapEmpty(MAP, false)!;
  assert.equal(off.state, "off");
  assert.equal(off.command, "aos graph on");
  assert.equal(mapEmptyText(off), "The graph is off. aos graph on builds it, and the next scan draws the map from it.");
  assert.equal(mapEmpty(mapOf({ state: "off" }), true)!.state, "off");
  assert.equal(mapEmptyText(mapEmpty(null, true)!), "No map yet: the next scan writes it.");
  assert.equal(mapEmpty(mapOf({ state: "missing" }), true)!.state, "missing");
  assert.equal(mapEmpty(null, true)!.command, null);
  assert.equal(mapEmpty(MAP, true), null);
  assert.equal(isMapView("around"), true);
  assert.equal(isMapView("graph"), false);
});

test("thousands and builtAgo: counts with separators, times compared as times against an injected now", () => {
  assert.equal(thousands(5265), "5,265");
  assert.equal(thousands(674), "674");
  assert.equal(thousands(1234567), "1,234,567");
  const now = new Date("2026-10-11T10:00:00Z");
  assert.equal(builtAgo("2026-10-11T09:59:30Z", now), "just now");
  assert.equal(builtAgo("2026-10-11T09:48:00Z", now), "12m ago");
  assert.equal(builtAgo("2026-10-11T08:00:00Z", now), "2h ago");
  assert.equal(builtAgo("2026-10-08T10:00:00Z", now), "3d ago");
  const long = new Date(2026, 8, 1, 12, 0).toISOString();   // local noon: the same day in every zone
  assert.equal(builtAgo(long, now), shortDay(long, now));
  assert.equal(builtAgo(long, now), "Sep 1");
  assert.equal(builtAgo(null, now), "");
  assert.equal(builtAgo("not a time", now), "");
});

test("communityViews: members the files retired or lost drop out, an emptied community drops out, counts come from the files", () => {
  const shown = communityViews(MAP, byPath, usage({ [G1]: 4, [G3]: 0, [R1]: 1 }));
  assert.deepEqual(shown.map((c) => c.id), ["c3", "c7"]);
  const [g, r] = shown;
  assert.deepEqual(g.paths, [G1, G2, G3]);
  assert.equal(g.memories, 3);
  assert.equal(g.unreviewed, 2);
  assert.equal(g.usedWeek, 1);
  assert.equal(g.name, "Garden plan");
  // The lead's title as the file says now, not the map's.
  assert.equal(r.name, "Release notes renamed");
  assert.equal(r.usedWeek, 1);
  // Without a usage log there is nothing to say about use.
  assert.equal(communityViews(MAP, byPath, null)[0].usedWeek, null);
});

test("the bubble's words: its accessible name, its caption, the card's line; the ring is the unreviewed share", () => {
  const [g] = communityViews(MAP, byPath, usage({ [G1]: 4 }));
  assert.equal(bubbleLabel(g), "Garden plan, 3 memories, 2 unreviewed");
  assert.equal(bubbleLabel({ name: "Solo", memories: 1, unreviewed: 0 }), "Solo, 1 memory, 0 unreviewed");
  assert.equal(bubbleCaption(g), "3 · 2 unreviewed");
  assert.equal(bubbleCaption({ memories: 9, unreviewed: 0 }), "9");
  assert.equal(communityLine(g), "3 memories · 2 unreviewed · 1 used this week");
  assert.equal(communityLine({ memories: 14, unreviewed: 11, usedWeek: null }), "14 memories · 11 unreviewed");
  assert.equal(unreviewedShare(g), 2 / 3);
  assert.equal(unreviewedShare({ memories: 0, unreviewed: 0 }), 0);
});

test("memberRows: each member's title and, on the right, N× used this week or the day it was written", () => {
  const [g] = communityViews(MAP, byPath, null);
  const now = new Date("2026-10-11T10:00:00Z");
  const writtenTs = new Date(2026, 9, 2, 9, 30).toISOString();
  const written = new Map([["projects/garden-soil", writtenTs]]);
  const rows = memberRows(g, byPath, usage({ [G1]: 6 }), written, now);
  assert.deepEqual(rows.map((r) => [r.title, r.note, r.used, r.unreviewed]), [
    ["Garden plan", "6× used", true, true],
    ["Garden soil", "Oct 2", false, false],
    ["Garden tools", shortDay("2026-09-20", now), false, true],
  ]);
  assert.equal(rows[2].note, "Sep 20");
  // No usage log: every row says its day.
  assert.equal(memberRows(g, byPath, null, written, now)[0].note, "Sep 20");
});

test("linkedCommunities: both directions summed, only communities shown, most links first; pickCommunity keeps a shown selection", () => {
  const shown = communityViews(MAP, byPath, null);
  assert.deepEqual(linkedCommunities(MAP, "c7", shown), [{ id: "c3", name: "Garden plan", n: 2 }]);
  const doubled = mapOf({ ...MAP, links: [{ a: "c3", b: "c7", n: 2 }, { a: "c7", b: "c3", n: 1 }], communities: MAP.communities, memories: MAP.memories });
  assert.deepEqual(linkedCommunities(doubled, "c3", communityViews(doubled, byPath, null)), [{ id: "c7", name: "Release notes renamed", n: 3 }]);
  assert.equal(pickCommunity(shown, "c7"), "c7");
  assert.equal(pickCommunity(shown, "c9"), "c3");
  assert.equal(pickCommunity(shown, null), "c3");
  assert.equal(pickCommunity([], "c3"), null);
});

/** Whether two packed bubbles' circles overlap (the gap aside). */
const overlap = (a: BubbleAt, b: BubbleAt): boolean => Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - 1e-6;

const ITEMS: BubbleIn[] = [
  { id: "c1", n: 33, labelW: 120 }, { id: "c2", n: 31, labelW: 90 }, { id: "c3", n: 29, labelW: 150 }, { id: "c4", n: 25, labelW: 70 },
  { id: "c5", n: 18, labelW: 110 }, { id: "c6", n: 16, labelW: 130 }, { id: "c7", n: 14, labelW: 100 }, { id: "c8", n: 14, labelW: 80 },
  { id: "c9", n: 9, labelW: 60 }, { id: "c10", n: 8, labelW: 176 },
];

test("packBubbles: deterministic, independent of input order, larger communities larger, no two circles or captions clash", () => {
  const links = [{ a: "c1", b: "c6", n: 9 }, { a: "c2", b: "c9", n: 4 }];
  const a = packBubbles(ITEMS, links, 1.4);
  const b = packBubbles([...ITEMS].reverse(), links, 1.4);
  assert.deepEqual(a, b);
  const r = new Map(a.map((x) => [x.id, x.r]));
  assert.ok(r.get("c1")! > r.get("c5")! && r.get("c5")! > r.get("c10")!);
  assert.equal(r.get("c1"), bubbleRadius(33));
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      assert.ok(Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y) >= a[i].r + a[j].r + BUBBLE.gap - 1e-6, `${a[i].id} and ${a[j].id} overlap`);
    }
  }
  // Captions (the box under each circle) never cross another caption.
  const w = new Map(ITEMS.map((x) => [x.id, x.labelW]));
  const box = (x: BubbleAt) => [x.x - w.get(x.id)! / 2, x.y + x.r + BUBBLE.captionGap, x.x + w.get(x.id)! / 2, x.y + x.r + BUBBLE.captionGap + BUBBLE.captionH];
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const p = box(a[i]);
      const q = box(a[j]);
      assert.ok(!(p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3]), `${a[i].id} and ${a[j].id} captions clash`);
    }
  }
  // The first (largest) sits at the centre; a strongly linked one is drawn near its partner.
  assert.deepEqual([a[0].id, a[0].x, a[0].y], ["c1", 0, 0]);
  const c6 = a.find((x) => x.id === "c6")!;
  const c7 = a.find((x) => x.id === "c7")!;
  assert.ok(Math.hypot(c6.x, c6.y) <= Math.hypot(c7.x, c7.y) + 1e-6, "c6 (linked to c1) is no further from c1 than c7 (unlinked, placed after it)");
});

test("layoutBubbles stays quick with many communities (mapMin lowered): 35 with full-width captions in well under a frame budget", () => {
  const many: BubbleIn[] = Array.from({ length: 35 }, (_, i) => ({ id: `c${i}`, n: 3 + ((i * 7) % 20), labelW: BUBBLE.labelMax }));
  const links = many.slice(1).map((c, i) => ({ a: many[i].id, b: c.id, n: 1 + (i % 4) }));
  layoutBubbles(many, links, 640, 480);
  const t = performance.now();
  const at = layoutBubbles(many, links, 640, 480);
  const ms = performance.now() - t;
  assert.equal(at.length, 35);
  // The checks against every placed bubble used to take most of a second here; boxes and a grid make it tens of ms.
  assert.ok(ms < 250, `layoutBubbles took ${ms.toFixed(0)} ms for 35 communities`);
});

test("layoutBubbles: fits a roomy and a tight canvas, centred, circles apart; the same input gives the same picture", () => {
  const roomy = layoutBubbles(ITEMS, [], 900, 600);
  assert.deepEqual(roomy, layoutBubbles(ITEMS, [], 900, 600));
  for (const b of roomy) {
    assert.ok(b.x - b.r >= -1e-6 && b.x + b.r <= 900 + 1e-6, `${b.id} inside horizontally`);
    assert.ok(b.y - b.r >= -1e-6 && b.y + b.r + BUBBLE.captionGap + BUBBLE.captionH <= 600 + 1e-6, `${b.id} inside vertically`);
  }
  for (let i = 0; i < roomy.length; i++) for (let j = i + 1; j < roomy.length; j++) assert.ok(!overlap(roomy[i], roomy[j]));
  // A tight canvas shrinks the circles (captions keep their size) and still keeps them apart.
  const tight = layoutBubbles(ITEMS, [], 420, 360);
  assert.ok(tight.find((b) => b.id === "c1")!.r < roomy.find((b) => b.id === "c1")!.r);
  for (let i = 0; i < tight.length; i++) for (let j = i + 1; j < tight.length; j++) assert.ok(!overlap(tight[i], tight[j]));
  // A single community sits in the middle.
  const one = layoutBubbles([{ id: "c1", n: 12, labelW: 80 }], [], 600, 400);
  assert.equal(one.length, 1);
  assert.ok(Math.abs(one[0].x - 300) < 1e-6);
  assert.deepEqual(layoutBubbles([], [], 600, 400), []);
  assert.equal(captionWidth("A".repeat(60), "12 · 3 unreviewed"), BUBBLE.labelMax);
});

test("aroundPicks and aroundRows: the memories the map holds that the files hold live, most linked first; neighbours without the gone ones", () => {
  const shown = communityViews(MAP, byPath, null);
  const picks = aroundPicks(MAP, byPath, shown);
  assert.deepEqual(picks.map((p) => p.path), [G1, R2, G2, G3, R1, LONE]);
  assert.equal(picks[0].community, "Garden plan");
  assert.equal(picks.find((p) => p.path === LONE)!.community, null);
  assert.deepEqual(aroundPicks(MAP, byPath, shown, "garden SOIL").map((p) => p.path), [G2]);
  assert.deepEqual(aroundPicks(MAP, byPath, shown, "release-checklist").map((p) => p.path), [R1]);
  const rows = aroundRows(MAP, G1, byPath, shown);
  assert.deepEqual(rows.map((r) => [r.path, r.n, r.community]), [[G2, 3, "Garden plan"], [G3, 2, "Garden plan"], [R2, 1, "Release notes renamed"]]);
  assert.deepEqual(aroundRows(MAP, LONE, byPath, shown), []);
  assert.deepEqual(aroundRows(MAP, "brain/memory/projects/nowhere.md", byPath, shown), []);
});

test("pickAround: the selection while it is held, else the community's lead, else the most linked memory (ties by path)", () => {
  assert.equal(pickAround(MAP, byPath, G2, R2), G2);
  assert.equal(pickAround(MAP, byPath, OLD, R2), R2);   // archived: not offered
  assert.equal(pickAround(MAP, byPath, null, X1), G1);  // a lead the files lost
  assert.equal(pickAround(mapOf({}), byPath, G1, null), null);
});

test("aroundLayout: the first at the top, then clockwise; captions sit outward; all inside the canvas", () => {
  assert.deepEqual(aroundLayout(0, 600, 400), []);
  const four = aroundLayout(4, 600, 400);
  assert.deepEqual(four.map((a) => a.side), ["top", "right", "bottom", "left"]);
  assert.equal(four[0].x, 300);
  assert.ok(four[0].y < 200 && four[2].y > 200 && four[1].x > 300 && four[3].x < 300);
  for (const a of aroundLayout(12, 600, 400)) assert.ok(a.x >= 0 && a.x <= 600 && a.y >= 0 && a.y <= 400);
  assert.deepEqual(aroundLayout(12, 600, 400), aroundLayout(12, 600, 400));
  // A narrow canvas (the Map's middle pane in a 960 px window): each name's room, as MapMode caps it (40 to 180), keeps
  // its button inside the canvas, so a long title ends in an ellipsis rather than being cut at the edge.
  for (const w of [386, 466, 512, 900]) {
    for (const a of aroundLayout(12, w, 480)) {
      const name = Math.max(40, Math.min(180, Math.floor(a.room)));
      const [x0, x1] = a.side === "right" ? [a.x - 10, a.x + 16 + name] : a.side === "left" ? [a.x - 16 - name, a.x + 10] : [a.x - (name + 8) / 2, a.x + (name + 8) / 2];
      assert.ok(x0 >= 0 && x1 <= w, `w ${w}: a ${a.side} node spans ${x0.toFixed(1)}…${x1.toFixed(1)}`);
    }
  }
  assert.equal(linkWidth(1), 1);
  assert.equal(linkWidth(2), 2);
  assert.equal(linkWidth(1000), 5);
});

test("mapFooter: graphify's whole graph, the index hubs left out, what fell under mapMin, the unlinked, where names come from", () => {
  assert.deepEqual(mapFooter(MAP), [
    "674 communities · 5,265 nodes · 9,001 links in graphify's graph.",
    "Index hubs left out: MEMORY.md, BRAIN.md, 2 MOCs.",
    "12 smaller groups (under 2 memories) hold 40 memories.",
    "1 memory links to no other.",
    "Names come from each community's most-linked memory.",
  ]);
  assert.deepEqual(mapFooter(mapOf({ smaller: { communities: 1, memories: 1 }, unlinked: 3 })), [
    "1 smaller group (under 2 memories) hold 1 memory.",
    "3 memories link to no other.",
    "Names come from each community's most-linked memory.",
  ]);
});

test("everyNodeGraph: memory nodes only, from the map's memories the files hold live; each neighbour pair once; seeded the same each time", () => {
  const g = everyNodeGraph(MAP, byPath);
  assert.deepEqual(g.nodes.map((n) => [n.kind, n.path]), [G1, G2, G3, LONE, R1, R2].map((p) => ["memory", p]));
  assert.ok(g.nodes.every((n) => n.kind === "memory" && n.id === n.path && g.byId.get(n.id) === n));
  // G1–G2 is listed from both ends, G1–X1 and G1–OLD have no node: each pair once, the lower path first.
  assert.deepEqual(g.edges.map((e) => `${e.from.split("/").pop()} ${e.to.split("/").pop()}`).sort(), [
    "garden-plan.md garden-soil.md", "garden-plan.md garden-tools.md", "garden-plan.md release-notes.md", "release-checklist.md release-notes.md",
  ]);
  assert.ok(g.edges.every((e) => e.from < e.to));
  const again = everyNodeGraph(MAP, byPath);
  assert.deepEqual(again.nodes.map((n) => [n.x, n.y]), g.nodes.map((n) => [n.x, n.y]));
  assert.equal(g.nodes.find((n) => n.path === R2)!.label, "Release notes renamed");
  assert.equal(hashPath("a"), hashPath("a"));
  assert.notEqual(hashPath("a"), hashPath("b"));
  assert.deepEqual([...degrees(g)].sort(), [[G1, 3], [G2, 1], [G3, 1], [R1, 1], [R2, 2]].sort());
});

test("Every node keeps nodes and labels readable: a minimum size on screen at any zoom, labels that never overlap, more as you zoom in", () => {
  assert.equal(nodeRadius(0), 4);
  assert.equal(nodeRadius(20), 8);
  // Zoomed in, the degree's own radius; zoomed far out, at least NODE_MIN_PX on screen, the most linked still larger.
  assert.equal(drawnRadius(0, 2), 4);
  assert.ok(Math.abs(drawnRadius(0, 0.2) * 0.2 - NODE_MIN_PX) < 1e-9);
  assert.ok(drawnRadius(10, 0.2) * 0.2 > drawnRadius(0, 0.2) * 0.2);
  assert.ok(Math.abs(labelFont(0.25) * 0.25 - LABEL_PX) < 1e-9);
  // Labels: the most linked first, none that overlaps one kept before it, none off the canvas.
  const cands = [
    { id: "a", x: 100, y: 100, r: 5, text: "Alpha", deg: 9 },
    { id: "b", x: 104, y: 104, r: 5, text: "Beta", deg: 3 },
    { id: "c", x: 100, y: 200, r: 5, text: "Gamma", deg: 1 },
    { id: "d", x: 790, y: 300, r: 5, text: "Off the edge", deg: 8 },
    { id: "e", x: 300, y: 300, r: 5, text: "Epsilon", deg: 0 },
  ];
  assert.deepEqual([...pickLabels(cands, 800, 600)], ["a", "c", "e"]);
  assert.deepEqual([...pickLabels(cands, 800, 600, 1)], ["a"]);
  // Zooming in spreads the same nodes: b clears a.
  const zoomed = cands.map((c) => ({ ...c, x: c.x * 6 - 150, y: c.y * 6 - 200 }));
  assert.ok(pickLabels(zoomed, 4800, 3600).has("b"));
  assert.equal(labelCap(900, 560), 50);
  assert.equal(labelCap(100, 100), 12);
  // fitView centres the nodes and keeps the scale in range.
  const v = fitView([{ x: -100, y: -50 }, { x: 100, y: 50 }], 400, 200, 0);
  assert.deepEqual(v, { x: 200, y: 100, scale: 1.4 });
  assert.deepEqual(fitView([], 400, 200), { x: 200, y: 100, scale: 1 });
  assert.equal(fitView([{ x: -1e6, y: 0 }, { x: 1e6, y: 0 }], 400, 200, 0, 0.05).scale, 0.05);
});

test("Every node on a vault-sized map (~350 memories): after the settle the fitted view keeps every node and label readable", () => {
  // An invented map shaped like a real one: a few communities, most memories linked to one or two others, a third alone.
  const memories: Record<string, { community: string | null; degree: number; neighbours: Array<{ path: string; n: number }> }> = {};
  const spec: Record<string, { title: string }> = {};
  const paths = Array.from({ length: 350 }, (_, i) => P("reference", `note-${String(i).padStart(3, "0")}`));
  paths.forEach((p, i) => {
    spec[p] = { title: `Note ${i}` };
    const nbs = i % 3 === 0 ? [] : [{ path: paths[(i * 7 + 3) % 350], n: 1 + (i % 4) }, ...(i % 5 === 0 ? [{ path: paths[(i + 1) % 350], n: 1 }] : [])];
    memories[p] = { community: i < 60 ? `c${i % 5}` : null, degree: nbs.length, neighbours: nbs.filter((x) => x.path !== p) };
  });
  const big = mapOf({ communities: [0, 1, 2, 3, 4].map((k) => ({ id: `c${k}`, name: `Group ${k}`, lead: paths[k], paths: paths.filter((_, i) => i < 60 && i % 5 === k), edges: 4 })), memories });
  const files350 = files(spec);
  const g = everyNodeGraph(big, files350);
  assert.equal(g.nodes.length, 350);
  const GENTLE: SimParams = { repulsion: 1600, spring: 0.045, restLength: 90, centerGravity: 0.0015, damping: 0.92 };
  settle(g, 180);
  settle(g, 120, GENTLE);
  const w = 900;
  const h = 560;
  const v = fitView(g.nodes, w, h, 48, 0.05, 1.4);
  assert.ok(v.scale >= 0.05 && v.scale <= 1.4);
  for (const n of g.nodes) {
    const sx = v.x + n.x * v.scale;
    const sy = v.y + n.y * v.scale;
    assert.ok(sx >= 0 && sx <= w && sy >= 0 && sy <= h, "every node on the canvas");
  }
  const deg = degrees(g);
  assert.ok(g.nodes.every((n) => drawnRadius(deg.get(n.id) ?? 0, v.scale) * v.scale >= NODE_MIN_PX - 1e-9));
  const shown = pickLabels(g.nodes.map((n) => ({ id: n.id, x: v.x + n.x * v.scale, y: v.y + n.y * v.scale, r: drawnRadius(deg.get(n.id) ?? 0, v.scale) * v.scale, text: n.label, deg: deg.get(n.id) ?? 0 })), w, h);
  assert.ok(shown.size >= 12 && shown.size <= labelCap(w, h), `${shown.size} labels`);
});
