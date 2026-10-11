// Map until PR 3 (spec 2026-10-11-brain-hub D19): the force view the Memory tab had, kept as "Every node". Memories,
// patterns, daily notes under dailyNote.layout and agents, linked by their wikilinks (data/graph.ts), settled once
// (data/forceSim.ts), then a gentle sim while the mode is shown that rests when nothing moves. A memory opens in Library,
// any other node in the editor; drag pins a node, ⌘/Ctrl-click unpins it. Communities, Around a memory (brain-map.json)
// and Graph off come with PR 3.
import { setIcon } from "obsidian";
import { buildGraph, type Graph, type GraphNode, type NodeKind } from "../../data/graph";
import { dailyNoteLayout } from "../../data/aosConfig";
import { settle, tick, type SimParams } from "../../data/forceSim";
import type { BrainCtx, BrainModeView } from "./types";

// The categorical chart tokens, as CSS so the graph follows the theme (set through `style`: SVG attributes take no var()).
const KIND_COLOR: Record<NodeKind, string> = {
  memory: "var(--udx-chart-1)",
  pattern: "var(--udx-chart-4)",
  session: "var(--udx-chart-3)",
  agent: "var(--udx-chart-5)",
};
const KINDS: NodeKind[] = ["memory", "pattern", "session", "agent"];
const KIND_TITLE: Record<NodeKind, string> = {
  memory: "Memories", pattern: "Patterns", session: "Daily notes from the last 30 days", agent: "Agents",
};
const EDGE = "var(--udx-line-2)";
const EDGE_NEAR = "var(--udx-text-2)";
const EDGE_FAR = "var(--udx-line)";
const SVG_NS = "http://www.w3.org/2000/svg";
/** The Memory tab's gentle sim: the settle parameters, damped harder. */
const GENTLE: SimParams = { repulsion: 1600, spring: 0.045, restLength: 90, centerGravity: 0.0015, damping: 0.92 };
/** Rebuild at most this often; a mount this long after the last build rebuilds even with no memory changed (daily notes, agents). */
const MIN_GAP_MS = 5000;
/** The sim rests once no node moves faster than this on screen (px a tick: 2.5 px/s) for REST_TICKS ticks of 40 ms. */
const REST_SPEED = 0.1;
const REST_TICKS = 25;
/** A press that moves further than this (screen px) is a drag, not a click. */
const DRAG_SLOP = 3;

type NodeEl = { el: SVGGElement; n: GraphNode };
type EdgeEl = { el: SVGLineElement; a: GraphNode; b: GraphNode };
type LabelEl = { el: SVGTextElement; n: GraphNode; r: number };

export class MapMode implements BrainModeView {
  /** The graph on screen, kept across mounts (public: e2e reads node kinds through getTab("memory").modes.map.graph). */
  graph: Graph | null = null;

  private root: HTMLElement | null = null;
  private canvas: HTMLElement | null = null;
  private stats: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private gWorld: SVGGElement | null = null;
  private gEdges: SVGGElement | null = null;
  private gNodes: SVGGElement | null = null;
  private gLabels: SVGGElement | null = null;
  private hoverLabel: SVGTextElement | null = null;
  private nodeEls: NodeEl[] = [];
  private edgeEls: EdgeEl[] = [];
  private labelEls: LabelEl[] = [];
  private radius = new Map<string, number>();

  private filters: Record<NodeKind, boolean> = { memory: true, pattern: true, session: true, agent: true };
  private hovered: string | null = null;
  private viewX = 0;
  private viewY = 0;
  private viewScale = 1;
  private dragging: GraphNode | null = null;
  private dragOffset = { x: 0, y: 0 };
  private dragFrom = { x: 0, y: 0 };
  private dragMoved = false;
  private dragWasFixed = false;
  private panning = false;
  private panStart = { x: 0, y: 0, viewX: 0, viewY: 0 };

  private timer: number | null = null;
  private calm = 0;
  private resting = false;
  private bound = false;
  /** What the graph was built from (memory paths and hashes, pattern paths), and when. */
  private sig = "";
  private builtAt = 0;
  private building = false;
  private again = false;
  private throttle: number | null = null;

  constructor(private ctx: BrainCtx) {}

  mount(host: HTMLElement): void {
    this.bind();
    const root = this.root = host.createEl("section", { cls: "aos-brain-map", attr: { "aria-label": "Every node" } });
    const head = root.createDiv({ cls: "aos-brain-maphead" });
    head.createEl("h2", { cls: "aos-brain-h2", text: "Every node" });
    head.createEl("p", {
      cls: "aos-brain-mapnote aos-brain-dim",
      text: "The force view the Memory tab had: memories, patterns, daily notes and agents. Communities and Around a memory come with the next update.",
    });

    const bar = root.createDiv({ cls: "aos-cortex-header aos-brain-mapbar" });
    const chips = bar.createDiv({ cls: "aos-cortex-chips", attr: { role: "group", "aria-label": "Kinds shown" } });
    for (const k of KINDS) {
      const chip = chips.createEl("button", { cls: "aos-cortex-chip", attr: { "data-kind": k, title: KIND_TITLE[k] } });
      const dot = chip.createSpan({ cls: "aos-brain-mapdot", attr: { "aria-hidden": "true" } });
      dot.style.background = KIND_COLOR[k];
      chip.createSpan({ text: k });
      const paint = (): void => {
        chip.toggleClass("aos-cortex-chip-off", !this.filters[k]);
        chip.setAttr("aria-pressed", String(this.filters[k]));
      };
      paint();
      chip.addEventListener("click", () => {
        this.filters[k] = !this.filters[k];
        paint();
        this.hovered = null;
        this.draw();
      });
    }
    this.stats = bar.createSpan({ cls: "aos-cortex-stats aos-brain-mono aos-brain-dim" });
    bar.createSpan({ cls: "aos-brain-sp" });
    bar.createSpan({ cls: "aos-brain-maphint aos-brain-dim", text: "Click a memory to open it in Library · drag to pin · ⌘-click to unpin" });
    const re = bar.createEl("button", { cls: "aos-brain-btn is-small aos-brain-mapresettle", attr: { title: "Unpin every node and lay the graph out again" } });
    const ric = re.createSpan({ cls: "aos-brain-ic", attr: { "aria-hidden": "true" } });
    setIcon(ric, "rotate-ccw");
    re.createSpan({ text: "Resettle" });
    re.addEventListener("click", () => this.resettle());

    const canvas = this.canvas = root.createDiv({ cls: "aos-cortex-canvas aos-brain-mapcanvas" });
    const svg = this.svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Every node");
    svg.classList.add("aos-cortex-svg");
    canvas.appendChild(svg);
    this.gWorld = document.createElementNS(SVG_NS, "g");
    this.gEdges = document.createElementNS(SVG_NS, "g");
    this.gNodes = document.createElementNS(SVG_NS, "g");
    this.gLabels = document.createElementNS(SVG_NS, "g");
    const hl = this.hoverLabel = document.createElementNS(SVG_NS, "text");
    hl.classList.add("aos-brain-maphover");
    hl.style.fill = "var(--udx-text)";
    hl.setAttribute("font-size", "9");
    hl.setAttribute("pointer-events", "none");
    this.gWorld.append(this.gEdges, this.gNodes, this.gLabels, hl);
    svg.appendChild(this.gWorld);
    this.empty = canvas.createDiv({ cls: "aos-brain-mapempty aos-brain-empty" });
    this.attachPanZoom(svg);

    if (this.graph) this.present(true);
    else this.setStats("Reading the vault…");
    // Built on the first mount; a later mount reuses the graph (and its pins) unless it is stale.
    if (!this.graph || this.sig !== this.signature() || Date.now() - this.builtAt >= MIN_GAP_MS) this.rebuild();
  }

  update(): void {
    this.maybeRebuild();
  }

  unmount(): void {
    this.unbind();
    this.stopSim();
    if (this.throttle !== null) { window.clearTimeout(this.throttle); this.throttle = null; }
    if (this.dragging) { this.dragging.fixed = this.dragMoved || this.dragWasFixed; this.dragging = null; }
    this.dragMoved = false;
    this.panning = false;
    this.hovered = null;
    this.root = this.canvas = this.stats = this.empty = null;
    this.svg = null;
    this.gWorld = this.gEdges = this.gNodes = this.gLabels = null;
    this.hoverLabel = null;
    this.nodeEls = [];
    this.edgeEls = [];
    this.labelEls = [];
  }

  // ── the graph: build it, keep it current ──

  /** What a rebuild follows: the memories (path and hash, so a new wikilink counts) and the patterns. */
  private signature(): string {
    const d = this.ctx.data();
    return `${d.memories.length}|${d.memories.map((m) => `${m.path}:${m.hash}`).join(",")}|${d.patterns.map((p) => `${p.path}:${p.body.length}`).join(",")}`;
  }

  /** The data changed: rebuild when a memory or a pattern did, at most every MIN_GAP_MS. */
  private maybeRebuild(): void {
    if (this.graph && this.sig === this.signature()) return;
    const wait = this.builtAt + MIN_GAP_MS - Date.now();
    if (wait > 0) {
      this.throttle ??= window.setTimeout(() => { this.throttle = null; this.maybeRebuild(); }, wait);
      return;
    }
    this.rebuild();
  }

  /** One build at a time, and one more after it when asked for meanwhile. */
  private rebuild(): void {
    if (this.building) { this.again = true; return; }
    this.building = true;
    const sig = this.signature();
    void (async () => {
      try {
        const g = await buildGraph(this.ctx.plugin.app, dailyNoteLayout(this.ctx.plugin.vaultRoot()));
        const first = !this.graph;
        this.place(g);
        if (this.dragging) this.dragging = g.byId.get(this.dragging.id) ?? null;
        this.graph = g;
        this.sig = sig;
        this.builtAt = Date.now();
        this.present(first);
      } catch (e) {
        this.setStats(`Could not read the vault: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.building = false;
        if (this.again) { this.again = false; if (this.root) this.maybeRebuild(); }
      }
    })();
  }

  /** Settle a fresh graph. Nodes the last one had keep their place and pin, so a rebuild does not reshuffle the view. */
  private place(g: Graph): void {
    const old = this.graph;
    let kept = 0;
    if (old) for (const n of g.nodes) {
      const o = old.byId.get(n.id);
      if (o) { n.x = o.x; n.y = o.y; n.fixed = o.fixed; kept++; }
    }
    if (!old || kept < g.nodes.length / 2) { settle(g, 180); return; }
    // Hold the kept nodes while the new ones find their place, then let go of those that were not pinned.
    const held = g.nodes.filter((n) => old.byId.has(n.id) && !n.fixed);
    for (const n of held) n.fixed = true;
    settle(g, 180);
    for (const n of held) n.fixed = false;
  }

  /** Put the graph on screen (fitted on the first build and on each mount) and let the sim run. */
  private present(fit: boolean): void {
    if (!this.svg || !this.graph) return;
    if (fit) this.fitToView();
    else this.applyTransform();
    this.draw();
    this.wake();
    this.startSim();
  }

  private setStats(text: string): void {
    if (this.stats) this.stats.textContent = text;
  }

  // ── the sim ──

  private startSim(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      const g = this.graph;
      if (!g || this.resting || !this.svg?.isConnected || !this.ctx.view.isTabActive("memory")) return;
      tick(g, GENTLE);
      let fast = 0;
      for (const n of g.nodes) fast = Math.max(fast, Math.abs(n.vx) + Math.abs(n.vy));
      this.calm = fast * this.viewScale < REST_SPEED ? this.calm + 1 : 0;
      if (this.calm >= REST_TICKS && !this.dragging) this.resting = true;
      this.updatePositions();
    }, 40);
  }

  private stopSim(): void {
    if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
  }

  /** Something moved a node: tick again until everything rests. */
  private wake(): void {
    this.resting = false;
    this.calm = 0;
  }

  private resettle(): void {
    if (!this.graph) return;
    for (const n of this.graph.nodes) {
      n.fixed = false;
      n.vx = 0; n.vy = 0;
      n.x = (Math.random() - 0.5) * 400;
      n.y = (Math.random() - 0.5) * 400;
    }
    settle(this.graph, 180);
    this.present(true);
  }

  // ── pan, zoom, drag ──

  private fitToView(): void {
    if (!this.graph || !this.canvas) return;
    if (this.graph.nodes.length === 0) { this.viewX = this.viewY = 0; this.viewScale = 1; this.applyTransform(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.graph.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    const pad = 60;
    this.viewScale = Math.max(0.2, Math.min((w - pad * 2) / ((maxX - minX) || 1), (h - pad * 2) / ((maxY - minY) || 1), 1.4));
    this.viewX = w / 2 - ((minX + maxX) / 2) * this.viewScale;
    this.viewY = h / 2 - ((minY + maxY) / 2) * this.viewScale;
    this.applyTransform();
  }

  private applyTransform(): void {
    this.gWorld?.setAttribute("transform", `translate(${this.viewX} ${this.viewY}) scale(${this.viewScale})`);
  }

  /** A pointer position in the graph's own coordinates. */
  private world(e: MouseEvent): { x: number; y: number } {
    const rect = this.svg?.getBoundingClientRect();
    return { x: (e.clientX - (rect?.left ?? 0) - this.viewX) / this.viewScale, y: (e.clientY - (rect?.top ?? 0) - this.viewY) / this.viewScale };
  }

  /** The svg's own listeners (a fresh <svg> each mount); the window's are bound in bind(). */
  private attachPanZoom(svg: SVGSVGElement): void {
    svg.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const wx = (mx - this.viewX) / this.viewScale;
      const wy = (my - this.viewY) / this.viewScale;
      this.viewScale = Math.max(0.2, Math.min(4, this.viewScale * factor));
      this.viewX = mx - wx * this.viewScale;
      this.viewY = my - wy * this.viewScale;
      this.applyTransform();
    }, { passive: false });
    svg.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0 || this.dragging) return;
      e.preventDefault();   // no text selection while panning
      this.panning = true;
      this.panStart = { x: e.clientX, y: e.clientY, viewX: this.viewX, viewY: this.viewY };
    });
  }

  /** The window's mousemove and mouseup: bound on mount, dropped on unmount, never twice. */
  private bind(): void {
    if (this.bound) return;
    this.bound = true;
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
  }

  private unbind(): void {
    if (!this.bound) return;
    this.bound = false;
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (this.dragging) {
      if (!this.dragMoved && Math.hypot(e.clientX - this.dragFrom.x, e.clientY - this.dragFrom.y) > DRAG_SLOP) this.dragMoved = true;
      if (!this.dragMoved) return;
      const w = this.world(e);
      this.dragging.x = w.x - this.dragOffset.x;
      this.dragging.y = w.y - this.dragOffset.y;
      this.dragging.vx = 0;
      this.dragging.vy = 0;
      this.wake();
      this.updatePositions();
    } else if (this.panning) {
      this.viewX = this.panStart.viewX + (e.clientX - this.panStart.x);
      this.viewY = this.panStart.viewY + (e.clientY - this.panStart.y);
      this.applyTransform();
    }
  };

  private onMouseUp = (): void => {
    if (this.dragging) {
      // A drag pins the node where it was let go; a plain click leaves its pin as it was.
      this.dragging.fixed = this.dragMoved || this.dragWasFixed;
      this.dragging = null;
    }
    this.panning = false;
  };

  // ── draw ──

  private draw(): void {
    const g = this.graph;
    const { gEdges, gNodes, gLabels, svg } = this;
    if (!g || !gEdges || !gNodes || !gLabels || !svg) return;
    gEdges.replaceChildren();
    gNodes.replaceChildren();
    gLabels.replaceChildren();
    this.nodeEls = [];
    this.edgeEls = [];
    this.labelEls = [];
    this.radius.clear();

    const deg = new Map<string, number>();
    for (const e of g.edges) {
      deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
      deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    }
    const visible = (n: GraphNode): boolean => this.filters[n.kind];

    for (const e of g.edges) {
      const a = g.byId.get(e.from);
      const b = g.byId.get(e.to);
      if (!a || !b || !visible(a) || !visible(b)) continue;
      const line = document.createElementNS(SVG_NS, "line");
      line.style.stroke = EDGE;
      line.setAttribute("stroke-width", "0.8");
      line.dataset.from = a.id;
      line.dataset.to = b.id;
      gEdges.appendChild(line);
      this.edgeEls.push({ el: line, a, b });
    }

    for (const n of g.nodes) {
      if (!visible(n)) continue;
      const el = document.createElementNS(SVG_NS, "g");
      el.classList.add("aos-cortex-node");
      el.dataset.id = n.id;
      el.dataset.kind = n.kind;
      const d = deg.get(n.id) ?? 0;
      const r = 4 + Math.min(4, d * 0.6);
      this.radius.set(n.id, r);
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = `${n.label} (${n.kind})`;
      el.appendChild(title);
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("r", String(r));
      circle.style.fill = KIND_COLOR[n.kind];
      circle.style.stroke = "var(--udx-bg)";
      circle.setAttribute("stroke-width", "0.5");
      el.appendChild(circle);

      el.addEventListener("mousedown", (e: MouseEvent) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const w = this.world(e);
        this.dragOffset = { x: w.x - n.x, y: w.y - n.y };
        this.dragFrom = { x: e.clientX, y: e.clientY };
        this.dragMoved = false;
        this.dragWasFixed = !!n.fixed;
        this.dragging = n;
        n.fixed = true;   // held while pressed, so the sim does not pull it from under the pointer
      });
      el.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        if (this.dragMoved) { this.dragMoved = false; return; }   // the end of a drag, not a click
        if (e.metaKey || e.ctrlKey) { n.fixed = false; this.wake(); return; }
        this.open(n);
      });
      el.addEventListener("mouseenter", () => { this.hovered = n.id; this.applyHoverStyling(); });
      el.addEventListener("mouseleave", () => { if (this.hovered === n.id) this.hovered = null; this.applyHoverStyling(); });
      gNodes.appendChild(el);
      this.nodeEls.push({ el, n });

      if (d >= 2) {
        const text = document.createElementNS(SVG_NS, "text");
        text.style.fill = "var(--udx-text)";
        text.setAttribute("font-size", "9");
        text.setAttribute("pointer-events", "none");
        text.textContent = n.label;
        text.dataset.id = n.id;
        gLabels.appendChild(text);
        this.labelEls.push({ el: text, n, r });
      }
    }

    this.setStats(`${g.nodes.length} nodes · ${g.edges.length} edges`);
    svg.setAttribute("aria-label", `Every node: ${this.nodeEls.length} nodes and ${this.edgeEls.length} links shown`);
    if (this.empty) {
      const text = g.nodes.length === 0 ? "No memories, patterns, daily notes or agents to draw yet."
        : this.nodeEls.length === 0 ? "Every kind is hidden. Turn one on above." : "";
      this.empty.textContent = text;
      this.empty.toggleClass("is-shown", text !== "");
    }
    this.updatePositions();
    this.applyHoverStyling();
  }

  private updatePositions(): void {
    for (const { el, n } of this.nodeEls) el.setAttribute("transform", `translate(${n.x} ${n.y})`);
    for (const { el, a, b } of this.edgeEls) {
      el.setAttribute("x1", String(a.x));
      el.setAttribute("y1", String(a.y));
      el.setAttribute("x2", String(b.x));
      el.setAttribute("y2", String(b.y));
    }
    for (const { el, n, r } of this.labelEls) {
      el.setAttribute("x", String(n.x + r + 3));
      el.setAttribute("y", String(n.y + 3));
    }
    this.placeHoverLabel();
  }

  /** The hovered node's name, for a node too sparsely linked to carry a label of its own. */
  private placeHoverLabel(): void {
    const t = this.hoverLabel;
    if (!t) return;
    const n = this.hovered ? this.graph?.byId.get(this.hovered) : undefined;
    if (!n || this.labelEls.some((l) => l.n === n)) { t.textContent = ""; return; }
    const r = this.radius.get(n.id) ?? 4;
    t.textContent = n.label;
    t.setAttribute("x", String(n.x + r + 3));
    t.setAttribute("y", String(n.y + 3));
  }

  private applyHoverStyling(): void {
    const hover = this.hovered;
    const g = this.graph;
    if (!hover || !g) {
      for (const { el } of this.edgeEls) { el.style.stroke = EDGE; el.setAttribute("stroke-width", "0.8"); }
      for (const { el } of this.nodeEls) el.style.opacity = "1";
      this.placeHoverLabel();
      return;
    }
    const near = new Set<string>([hover]);
    for (const e of g.edges) {
      if (e.from === hover) near.add(e.to);
      if (e.to === hover) near.add(e.from);
    }
    for (const { el, a, b } of this.edgeEls) {
      const touches = a.id === hover || b.id === hover;
      el.style.stroke = touches ? EDGE_NEAR : EDGE_FAR;
      el.setAttribute("stroke-width", touches ? "1.4" : "0.6");
    }
    for (const { el, n } of this.nodeEls) el.style.opacity = near.has(n.id) ? "1" : "0.25";
    this.placeHoverLabel();
  }

  /** A memory shows in Library (no drawer any more); any other node, or a memory the hub does not list, opens in the editor. */
  private open(n: GraphNode): void {
    if (n.kind === "memory" && this.ctx.data().byPath.has(n.path)) this.ctx.show({ mode: "library", memory: n.path });
    else void this.ctx.edit(n.path);
  }
}
