// Map (spec 2026-10-11-brain-hub D19, D23; canvas Map): graphify's communities of memories, from brain/_index/brain-map.json
// (the scan writes it; the page never parses graph.json). Three views in a tablist. Communities: bubbles sized by their
// memories, the ring their unreviewed share with the word beside it; the list; the selected community's card (its counts,
// MEMBERS, LINKED COMMUNITIES). Around a memory: a picker over the memories the map holds, then its at most 12 neighbours
// on a ring. Every node: the force view the Memory tab had, memory nodes only, linked by the map's neighbours; settled
// once (data/forceSim.ts), refitted once the sim first rests, then a gentle sim while it shows that rests when nothing
// moves; drag pins a node, ⌘/Ctrl-click unpins it, the wheel zooms; nodes and labels keep a readable size on screen at
// any zoom. A memory opens in Library. Graph off or no map yet: an empty state that says what to do. The logic is in
// data/brainMapView.ts.
//
// A community's card has Consolidate with AI… (spec 2026-10-12-brain-hub-ai A3): what a sweep scoped to its memories
// would cost (`sweep --estimate`, the lead first, at most SWEEP_MAX_PATHS, the most linked, and the card says when it cut
// some), a question, then the sweep (one model call, waited for up to AI_TIMEOUT_MS). That scope's cards show in the card
// with Review and Dismiss (views/brain/SweepCards.ts; data/brainSweep.ts). One sweep runs at a time on this page.
import { Notice, setIcon } from "obsidian";
import { AI_TIMEOUT_MS, clip, hasUsage, parseSweepEstimate, parseSweepResult, type BrainTarget, type HubUsage, type OnceHost } from "../../data/brainModel";
import { consolidateAsk, groupScopes, onceAsk, scopePaths, scopeSummary, sweepDoneText, sweepOffText, sweepTimeoutMs } from "../../data/brainSweep";
import {
  MAP_VIEWS, MAP_VIEW_LABEL, aroundLayout, aroundPicks, aroundRows, bubbleCaption, bubbleLabel, builtAgo, captionWidth,
  communityLine, communityViews, degrees, drawnRadius, everyNodeGraph, fitView, labelFont, layoutBubbles, linkWidth,
  linkedCommunities, mapEmpty, mapEmptyText, mapFooter, memberRows, pickAround, pickCommunity, pickLabels,
  unreviewedShare, type BubbleAt, type CommunityView, type LabelCand, type MapEmpty, type MapView,
} from "../../data/brainMapView";
import type { Graph, GraphNode } from "../../data/graph";
import { settle, tick, type SimParams } from "../../data/forceSim";
import { guardClicks } from "./guardClicks";
import { SweepCards } from "./SweepCards";
import type { BrainCtx, BrainData, BrainModeView } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The panel the view tabs control, and each tab's id. */
const CANVAS_ID = "aos-brain-mapcanvas";
const viewTabId = (v: MapView): string => `aos-brain-mapview-${v}`;
/** The Memory tab's gentle sim: the settle parameters, damped harder. */
const GENTLE: SimParams = { repulsion: 1600, spring: 0.045, restLength: 90, centerGravity: 0.0015, damping: 0.92 };
/** The first settle: the force view's 180 ticks, then this many gentle ones, so the first fit is close to where it rests. */
const SETTLE_GENTLE = 120;
/** The sim rests once no node moves faster than this on screen (px a tick: 2.5 px/s) for REST_TICKS ticks of 40 ms. */
const REST_SPEED = 0.1;
const REST_TICKS = 25;
/** A few hundred nodes are never all that calm at once (near passes kick them), so the sim also rests this many ticks
 *  (10 s) after it was last woken; a drag wakes it again. */
const SIM_MAX_TICKS = 250;
/** While the sim moves, the labels shown are picked again every this many ticks (they follow their nodes in between). */
const RELABEL_TICKS = 10;
/** A press that moves further than this (screen px) is a drag, not a click. */
const DRAG_SLOP = 3;
/** Every node's zoom range. */
const MIN_SCALE = 0.05;
const MAX_SCALE = 4;

const EDGE = "var(--udx-line-2)";
const EDGE_NEAR = "var(--udx-text-2)";
const EDGE_FAR = "var(--udx-line)";

type NodeEl = { el: SVGGElement; circle: SVGCircleElement; n: GraphNode; deg: number };
type EdgeEl = { el: SVGLineElement; a: GraphNode; b: GraphNode };
type LabelEl = { el: SVGTextElement; n: GraphNode };

/** The data-map-key of the focused element inside `scope` (a redraw puts the focus back on the element with that key). */
function focusedKey(scope: HTMLElement): string | null {
  const a = scope.ownerDocument.activeElement as HTMLElement | null;
  return a && scope.contains(a) ? a.closest("[data-map-key]")?.getAttribute("data-map-key") ?? null : null;
}

function refocus(scope: HTMLElement, key: string | null): void {
  if (!key) return;
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>("[data-map-key]"))) {
    if (el.getAttribute("data-map-key") === key) { el.focus({ preventScroll: true }); return; }
  }
}

export class MapMode implements BrainModeView {
  /** Every node's graph, built from brain-map.json and kept across mounts with its places and pins (public: e2e reads
   *  getTab("memory").modes.map.graph; memory nodes only). Null until there is a map. */
  graph: Graph | null = null;
  /** The view on screen (public for e2e): "communities", "around" or "every". */
  view: MapView = "communities";

  private community: string | null = null;
  private around: string | null = null;
  private find = "";

  private root: HTMLElement | null = null;
  /** What the root holds: "map" (the panes) or the empty state's kind. */
  private built = "";
  private lastData: BrainData | null = null;
  private left: HTMLElement | null = null;
  private leftTitle: HTMLElement | null = null;
  private leftMeta: HTMLElement | null = null;
  private findInput: HTMLInputElement | null = null;
  private list: HTMLElement | null = null;
  private foot: HTMLElement | null = null;
  private tabs = new Map<MapView, HTMLButtonElement>();
  private stats: HTMLElement | null = null;
  private legend: HTMLElement | null = null;
  private hint: HTMLElement | null = null;
  private resettleBtn: HTMLButtonElement | null = null;
  private canvas: HTMLElement | null = null;
  private right: HTMLElement | null = null;
  private resize: ResizeObserver | null = null;
  private frame: number | null = null;
  private size = { w: 0, h: 0 };
  /** The last Communities layout and what it was laid out from (bubbleLayout). */
  private bubbles: { key: string; at: BubbleAt[] } | null = null;

  // Every node
  private svg: SVGSVGElement | null = null;
  private gWorld: SVGGElement | null = null;
  private gEdges: SVGGElement | null = null;
  private gNodes: SVGGElement | null = null;
  private gLabels: SVGGElement | null = null;
  private hoverLabel: SVGTextElement | null = null;
  private nodeEls: NodeEl[] = [];
  private edgeEls: EdgeEl[] = [];
  private labelEls: LabelEl[] = [];
  private shownLabels = new Set<string>();
  /** What the graph was built from (the map's build and the memories it holds), and whether it still needs its settle. */
  private graphSig = "";
  private unsettled = true;
  /** Refit once when the sim first rests after a settle, unless the person moved the view meanwhile. */
  private refitOnRest = false;
  private userMoved = false;
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
  private ticks = 0;
  private awake = 0;
  private resting = false;
  private bound = false;

  // Consolidate with AI… (brain-ai A3)
  /** The community whose scoped sweep is under way, and its stage; one at a time. */
  private consolidating: { id: string; stage: "check" | "ask" | "run" } | null = null;
  /** Why the last Consolidate could not run (the sweep is off), shown in that community's card until the next try. */
  private offNote: { id: string; text: string } | null = null;
  /** The control to give the keyboard after a dialog, when nothing has it (the one that opened it was redrawn). */
  private focusAfter: string | null = null;
  private cards: SweepCards;

  constructor(private ctx: BrainCtx) {
    this.cards = new SweepCards(ctx, { keyAttr: "data-map-key", redraw: () => this.redrawRight() });
  }

  mount(host: HTMLElement): void {
    this.bind();
    this.root = host.createEl("section", { cls: "aos-brain-map", attr: { "aria-label": "Map" } });
    this.built = "";
    this.draw(true);
  }

  /** The data changed: redraw from it, keeping the view, the selection, the scroll and the focus. */
  update(): void {
    if (this.ctx.data() !== this.lastData) this.draw(true);
  }

  /** A link that names a memory the map holds lands on Around a memory, on it. */
  reveal(t: BrainTarget): void {
    const d = this.ctx.data();
    if (!t.memory || !d.map?.memories[t.memory] || !d.byPath.get(t.memory)?.live) return;
    this.around = t.memory;
    this.view = "around";
    this.draw(true);
  }

  unmount(): void {
    this.unbind();
    this.stopSim();
    this.resize?.disconnect();
    this.resize = null;
    if (this.frame !== null) { window.cancelAnimationFrame(this.frame); this.frame = null; }
    if (this.dragging) { this.dragging.fixed = this.dragMoved || this.dragWasFixed; this.dragging = null; }
    this.dragMoved = false;
    this.panning = false;
    this.hovered = null;
    this.dropPanes();
    this.root = null;
    this.built = "";
    this.lastData = null;
  }

  private dropPanes(): void {
    this.left = this.leftTitle = this.leftMeta = this.list = this.foot = this.stats = this.legend = this.hint = this.canvas = this.right = null;
    this.findInput = null;
    this.resettleBtn = null;
    this.tabs.clear();
    this.dropSvg();
  }

  private dropSvg(): void {
    this.svg = null;
    this.gWorld = this.gEdges = this.gNodes = this.gLabels = null;
    this.hoverLabel = null;
    this.nodeEls = [];
    this.edgeEls = [];
    this.labelEls = [];
    this.shownLabels.clear();
  }

  // ── the frame: the empty state, or the panes ──

  /** Draw everything from the current data; `force` redraws even when the data is the one drawn last. */
  private draw(force = false): void {
    const root = this.root;
    if (!root) return;
    const d = this.ctx.data();
    if (!force && d === this.lastData) return;
    this.lastData = d;
    // On every load, even with no community open: an applied sweep card the files now read done stops being hidden.
    this.cards.sync();
    const empty = mapEmpty(d.map, d.settings.graph);
    const kind = empty ? `empty:${empty.state}` : "map";
    if (kind !== this.built) {
      this.stopSim();
      this.resize?.disconnect();
      this.resize = null;
      root.empty();
      this.dropPanes();
      this.built = kind;
      root.toggleClass("aos-brain-panes", !empty);
      root.toggleClass("is-empty", !!empty);
      if (empty) { this.buildEmpty(root, empty); return; }
      this.buildPanes(root);
    }
    if (empty) return;
    this.ensureGraph(d);
    const key = focusedKey(root);
    const listTop = this.list?.scrollTop ?? 0;
    const cardTop = this.right?.scrollTop ?? 0;
    this.drawTabs();
    this.drawLeft();
    this.drawCanvas();
    this.drawRight();
    if (this.list) this.list.scrollTop = listTop;
    if (this.right) this.right.scrollTop = cardTop;
    refocus(root, key);
  }

  private buildEmpty(root: HTMLElement, e: MapEmpty): void {
    const box = root.createDiv({ cls: "aos-brain-mapnone", attr: { "data-state": e.state, role: "status", "aria-label": mapEmptyText(e) } });
    const p = box.createEl("p", { cls: "aos-brain-mapnonetext" });
    p.createSpan({ text: e.before });
    if (e.command) p.createEl("code", { cls: "aos-brain-mono", text: e.command });
    if (e.after) p.createSpan({ text: e.after });
    box.createEl("p", {
      cls: "aos-brain-mapnonesub aos-brain-dim",
      text: e.state === "off"
        ? "The Map shows graphify's communities of memories. Review, Library, Bootstrap and Health work without it."
        : "The scan at the end of a session writes brain-map.json from graphify's graph, beside brain-hub.json.",
    });
  }

  private buildPanes(root: HTMLElement): void {
    const left = this.left = root.createEl("aside", { cls: "aos-brain-left aos-brain-mapleft" });
    const head = left.createDiv({ cls: "aos-brain-maplhead" });
    const title = head.createDiv({ cls: "aos-brain-maptitle" });
    this.leftTitle = title.createEl("h2", { cls: "aos-brain-maph2" });
    this.leftMeta = title.createSpan({ cls: "aos-brain-mono aos-brain-dim aos-brain-mapmeta" });
    const find = this.findInput = head.createEl("input", {
      cls: "aos-brain-mapfind",
      attr: { type: "search", placeholder: "Find a memory…", "aria-label": "Find a memory in the map", spellcheck: "false", "data-map-key": "find" },
    });
    find.value = this.find;
    find.addEventListener("input", () => { this.find = find.value; this.drawLeft(); });
    find.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && find.value) { e.preventDefault(); find.value = ""; this.find = ""; this.drawLeft(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); this.list?.querySelector<HTMLElement>(".aos-brain-maprow")?.focus(); }
    });
    this.list = left.createDiv({ cls: "aos-brain-maplist", attr: { role: "listbox" } });
    this.list.addEventListener("keydown", (e) => this.listKey(e));
    this.foot = left.createDiv({ cls: "aos-brain-mapfoot" });

    const main = root.createDiv({ cls: "aos-brain-main aos-brain-mapmain" });
    const bar = main.createDiv({ cls: "aos-brain-mapbar" });
    const tabs = bar.createDiv({ cls: "aos-brain-mapviews", attr: { role: "tablist", "aria-label": "Map views" } });
    for (const v of MAP_VIEWS) {
      const b = tabs.createEl("button", {
        cls: "aos-brain-mapview", text: MAP_VIEW_LABEL[v],
        attr: { type: "button", role: "tab", id: viewTabId(v), "aria-controls": CANVAS_ID, "aria-selected": "false", tabindex: "-1", "data-map-view": v, "data-map-key": `view:${v}` },
      });
      b.addEventListener("click", () => this.setView(v));
      this.tabs.set(v, b);
    }
    // The tablist pattern: ←/→ (and Home/End) move between the views and show them.
    tabs.addEventListener("keydown", (e) => {
      const i = MAP_VIEWS.findIndex((v) => this.tabs.get(v) === e.target);
      if (i < 0) return;
      const n = MAP_VIEWS.length;
      const j = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i + n - 1) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
      if (j < 0) return;
      e.preventDefault();
      this.setView(MAP_VIEWS[j]);
      this.tabs.get(MAP_VIEWS[j])?.focus();
    });
    bar.createSpan({ cls: "aos-brain-sp" });
    this.stats = bar.createSpan({ cls: "aos-brain-mono aos-brain-dim aos-brain-mapstats" });
    this.legend = bar.createSpan({ cls: "aos-brain-maplegend" });
    this.hint = bar.createSpan({ cls: "aos-brain-maphint", text: "Click a memory to open it in Library · drag to pin · ⌘-click to unpin" });
    const re = this.resettleBtn = bar.createEl("button", {
      cls: "aos-brain-btn is-small aos-brain-mapresettle", attr: { type: "button", title: "Unpin every node and lay the graph out again", "data-map-key": "resettle" },
    });
    const ric = re.createSpan({ cls: "aos-brain-ic", attr: { "aria-hidden": "true" } });
    setIcon(ric, "rotate-ccw");
    re.createSpan({ text: "Resettle" });
    re.addEventListener("click", () => this.resettle());
    this.canvas = main.createDiv({ cls: "aos-brain-mapcanvas", attr: { id: CANVAS_ID, role: "tabpanel", "data-tour": "brain-map-canvas" } });
    this.right = root.createEl("aside", { cls: "aos-brain-right aos-brain-mapcard" });

    // Communities and Around lay out to the canvas's size: a resize lays them out again (once a frame).
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(() => {
        if (this.frame !== null) return;
        this.frame = window.requestAnimationFrame(() => {
          this.frame = null;
          const c = this.canvas;
          if (!c || (c.clientWidth === this.size.w && c.clientHeight === this.size.h)) return;
          this.size = { w: c.clientWidth, h: c.clientHeight };
          if (this.view === "every") { if (!this.userMoved) this.fitToView(); return; }
          const key = this.root ? focusedKey(this.root) : null;
          this.drawCanvas();
          if (this.root) refocus(this.root, key);
        });
      });
      this.resize.observe(this.canvas);
    }
  }

  private setView(v: MapView): void {
    if (this.view === v && this.root?.getAttribute("data-view") === v) return;
    this.view = v;
    this.draw(true);
  }

  private usage(d: BrainData): HubUsage | null {
    return d.settings.telemetry && hasUsage(d.hub) ? d.hub!.usage : null;
  }

  private shown(d: BrainData): CommunityView[] {
    const shown = communityViews(d.map!, d.byPath, this.usage(d));
    this.community = pickCommunity(shown, this.community);
    return shown;
  }

  private drawTabs(): void {
    this.root?.setAttr("data-view", this.view);
    for (const [v, b] of this.tabs) {
      const on = v === this.view;
      b.toggleClass("is-on", on);
      b.setAttr("aria-selected", String(on));
      b.setAttr("tabindex", on ? "0" : "-1");
    }
    this.canvas?.setAttr("aria-labelledby", viewTabId(this.view));
    const every = this.view === "every";
    if (this.left) this.left.hidden = every;
    if (this.right) this.right.hidden = every;
    if (this.hint) this.hint.hidden = !every;
    if (this.resettleBtn) this.resettleBtn.hidden = !every;
    if (this.stats) this.stats.hidden = !every;
  }

  // ── the left pane: the communities, or the memories to centre on ──

  private drawLeft(): void {
    const { list, foot, leftTitle, leftMeta, findInput, left } = this;
    if (!list || !foot || !leftTitle || !leftMeta || !findInput || !left || this.view === "every") return;
    const d = this.ctx.data();
    const map = d.map!;
    const shown = this.shown(d);
    const top = list.scrollTop;
    const key = focusedKey(list);
    list.empty();
    if (this.view === "communities") {
      leftTitle.textContent = "Communities";
      const ago = builtAgo(map.graph?.builtAt ?? map.builtAt, d.now);
      leftMeta.textContent = ago ? `from graphify · ${ago}` : "from graphify";
      findInput.hidden = true;
      left.setAttr("aria-label", "Communities");
      list.setAttr("aria-label", "Communities");
      if (!shown.length) list.createDiv({ cls: "aos-brain-empty aos-brain-maplempty", text: `No community holds ${map.mapMin} memories yet.` });
      for (const c of shown) {
        const on = c.id === this.community;
        const b = list.createEl("button", {
          cls: `aos-brain-maprow${on ? " is-selected" : ""}`,
          attr: { type: "button", role: "option", "aria-selected": String(on), tabindex: on ? "0" : "-1", "data-community": c.id, "data-map-key": `c:${c.id}`, "aria-label": bubbleLabel(c) },
        });
        b.createSpan({ cls: "aos-brain-maprowname", text: c.name });
        b.createSpan({ cls: "aos-brain-mono aos-brain-maprown", text: String(c.memories) });
        b.addEventListener("click", () => this.selectCommunity(c.id));
      }
    } else {
      this.around = pickAround(map, d.byPath, this.around, shown.find((c) => c.id === this.community)?.lead ?? null);
      const picks = aroundPicks(map, d.byPath, shown, this.find);
      const all = this.find ? aroundPicks(map, d.byPath, shown).length : picks.length;
      leftTitle.textContent = "Memories";
      leftMeta.textContent = `${all} in the map`;
      findInput.hidden = false;
      left.setAttr("aria-label", "Memories in the map");
      list.setAttr("aria-label", "Memories in the map");
      if (!picks.length) list.createDiv({ cls: "aos-brain-empty aos-brain-maplempty", text: this.find ? "No memory in the map matches." : "The map holds no memory yet." });
      for (const p of picks) {
        const on = p.path === this.around;
        const b = list.createEl("button", {
          cls: `aos-brain-maprow${on ? " is-selected" : ""}`,
          attr: {
            type: "button", role: "option", "aria-selected": String(on), tabindex: on ? "0" : "-1", "data-path": p.path, "data-map-key": `m:${p.path}`,
            "aria-label": `${p.title}, ${p.degree} linked`,
          },
        });
        b.createSpan({ cls: "aos-brain-maprowname", text: p.title });
        b.createSpan({ cls: "aos-brain-mono aos-brain-maprown", text: String(p.degree), attr: { title: `Linked to ${p.degree} other ${p.degree === 1 ? "memory" : "memories"}` } });
        b.addEventListener("click", () => this.selectAround(p.path));
      }
    }
    // One Tab stop: the selected row, else the first.
    if (!list.querySelector('.aos-brain-maprow[tabindex="0"]')) list.querySelector<HTMLElement>(".aos-brain-maprow")?.setAttribute("tabindex", "0");
    list.scrollTop = top;
    refocus(list, key);
    foot.empty();
    for (const line of mapFooter(map)) foot.createEl("p", { text: line });
  }

  /** ↑↓ (and Home, End) move the selection through the rows, the focus with it. */
  private listKey(e: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey || !this.list) return;
    const rows = Array.from(this.list.querySelectorAll<HTMLButtonElement>(".aos-brain-maprow"));
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.indexOf(e.target as HTMLButtonElement);
    const n = rows.length;
    const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : i < 0 ? 0 : e.key === "ArrowDown" ? Math.min(n - 1, i + 1) : Math.max(0, i - 1);
    const next = rows[j];
    const c = next.getAttribute("data-community");
    const p = next.getAttribute("data-path");
    if (c) this.selectCommunity(c);
    else if (p) this.selectAround(p);
    const again = this.list.querySelector<HTMLElement>(`[data-map-key="${CSS.escape(next.getAttribute("data-map-key") ?? "")}"]`);
    again?.focus();
    again?.scrollIntoView({ block: "nearest" });
  }

  /** Show community `id`; `focus` names the element to focus afterwards (a chip that took the person there is gone). */
  private selectCommunity(id: string, focus: string | null = null): void {
    if (this.view !== "communities") this.view = "communities";
    this.community = id;
    this.draw(true);
    if (focus && this.root) refocus(this.root, focus);
  }

  private selectAround(path: string): void {
    this.around = path;
    if (this.view !== "around") this.view = "around";
    this.draw(true);
  }

  private openMemory(path: string): void {
    if (this.ctx.data().byPath.has(path)) this.ctx.show({ mode: "library", memory: path });
  }

  // ── the canvas ──

  private drawCanvas(): void {
    const canvas = this.canvas;
    const legend = this.legend;
    if (!canvas || !legend) return;
    this.size = { w: canvas.clientWidth, h: canvas.clientHeight };
    if (this.view === "every") { this.drawEvery(); return; }
    this.stopSim();
    this.dropSvg();
    canvas.empty();
    canvas.removeClass("is-every");
    legend.empty();
    if (this.view === "communities") this.drawBubbles(canvas, legend);
    else this.drawAround(canvas, legend);
  }

  private canvasSize(): { w: number; h: number } {
    return { w: this.size.w || 640, h: this.size.h || 480 };
  }

  /**
   * layoutBubbles, kept while its inputs hold: the bubbles, the links between them and the canvas size. Selecting a
   * community, an arrow key in the list or a reload that leaves the communities as they were only moves aria-current.
   */
  private bubbleLayout(items: ReadonlyArray<{ id: string; n: number; labelW: number }>, links: ReadonlyArray<{ a: string; b: string; n: number }>, w: number, h: number): BubbleAt[] {
    const key = JSON.stringify([w, h, items.map((i) => [i.id, i.n, i.labelW]), links.map((l) => [l.a, l.b, l.n])]);
    if (this.bubbles?.key !== key) this.bubbles = { key, at: layoutBubbles(items, links, w, h) };
    return this.bubbles.at;
  }

  private drawBubbles(canvas: HTMLElement, legend: HTMLElement): void {
    legend.createSpan({ text: "Size = memories · " });
    legend.createSpan({ cls: "aos-brain-mapswatch is-ring", attr: { "aria-hidden": "true" } });
    legend.createSpan({ text: "ring = unreviewed share" });
    const d = this.ctx.data();
    const map = d.map!;
    const shown = this.shown(d);
    if (!shown.length) {
      canvas.createDiv({ cls: "aos-brain-mapempty", text: `No community holds ${map.mapMin} memories yet. Around a memory and Every node show every memory the map holds.` });
      return;
    }
    const { w, h } = this.canvasSize();
    const items = shown.map((c) => ({ id: c.id, n: c.memories, labelW: captionWidth(c.name, bubbleCaption(c)) }));
    const ids = new Set(shown.map((c) => c.id));
    const links = map.links.filter((l) => ids.has(l.a) && ids.has(l.b));
    const at = new Map(this.bubbleLayout(items, links, w, h).map((b) => [b.id, b]));
    const lines = document.createElementNS(SVG_NS, "svg");
    lines.classList.add("aos-brain-maplines");
    lines.setAttribute("aria-hidden", "true");
    for (const l of links) {
      const a = at.get(l.a);
      const b = at.get(l.b);
      if (!a || !b) continue;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x));
      line.setAttribute("y2", String(b.y));
      line.setAttribute("stroke-width", String(linkWidth(l.n)));
      lines.appendChild(line);
    }
    canvas.appendChild(lines);
    for (const c of shown) {
      const b = at.get(c.id);
      if (!b) continue;
      const on = c.id === this.community;
      const btn = canvas.createEl("button", {
        cls: "aos-brain-bubble",
        attr: { type: "button", "aria-label": bubbleLabel(c), "data-community": c.id, "data-map-key": `b:${c.id}`, ...(on ? { "aria-current": "true" } : {}) },
      });
      btn.style.left = `${b.x}px`;
      btn.style.top = `${b.y - b.r}px`;
      const disc = btn.createSpan({ cls: "aos-brain-bubbledisc", attr: { "aria-hidden": "true" } });
      disc.style.width = disc.style.height = `${2 * b.r}px`;
      disc.style.setProperty("--aos-brain-ring", `${Math.round(unreviewedShare(c) * 360)}deg`);
      disc.createSpan({ cls: "aos-brain-bubblefill" });
      btn.createSpan({ cls: "aos-brain-bubblename", text: clip(c.name, 26), attr: { "aria-hidden": "true" } });
      const cap = btn.createSpan({ cls: "aos-brain-mono aos-brain-bubblecap", attr: { "aria-hidden": "true" } });
      cap.createSpan({ text: String(c.memories) });
      if (c.unreviewed > 0) {
        cap.createSpan({ text: " · " });
        cap.createSpan({ cls: "aos-brain-bubbleun", text: `${c.unreviewed} unreviewed` });
      }
      btn.addEventListener("click", () => this.selectCommunity(c.id));
    }
  }

  private drawAround(canvas: HTMLElement, legend: HTMLElement): void {
    legend.createSpan({ text: "Line weight = links between the two" });
    const d = this.ctx.data();
    const map = d.map!;
    const shown = this.shown(d);
    this.around = pickAround(map, d.byPath, this.around, shown.find((c) => c.id === this.community)?.lead ?? null);
    const p = this.around;
    const m = p ? d.byPath.get(p) : undefined;
    if (!p || !m) {
      canvas.createDiv({ cls: "aos-brain-mapempty", text: "The map holds no memory to centre on yet." });
      return;
    }
    const rows = aroundRows(map, p, d.byPath, shown);
    const { w, h } = this.canvasSize();
    const at = aroundLayout(rows.length, w, h);
    const lines = document.createElementNS(SVG_NS, "svg");
    lines.classList.add("aos-brain-maplines");
    lines.setAttribute("aria-hidden", "true");
    rows.forEach((r, i) => {
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(w / 2));
      line.setAttribute("y1", String(h / 2));
      line.setAttribute("x2", String(at[i].x));
      line.setAttribute("y2", String(at[i].y));
      line.setAttribute("stroke-width", String(linkWidth(r.n)));
      lines.appendChild(line);
    });
    canvas.appendChild(lines);
    const centre = canvas.createEl("button", {
      cls: "aos-brain-arcentre",
      attr: { type: "button", "aria-label": `${m.title}: open in Library`, "data-path": p, "data-map-key": `ac:${p}` },
    });
    centre.style.left = `${w / 2}px`;
    centre.style.top = `${h / 2}px`;
    centre.createSpan({ cls: "aos-brain-ardot", attr: { "aria-hidden": "true" } });
    centre.createSpan({ cls: "aos-brain-arname", text: clip(m.title, 40), attr: { "aria-hidden": "true" } });
    centre.addEventListener("click", () => this.openMemory(p));
    rows.forEach((r, i) => {
      const b = canvas.createEl("button", {
        cls: `aos-brain-arnode is-${at[i].side}`,
        attr: { type: "button", "aria-label": `${r.title}, ${r.n} ${r.n === 1 ? "link" : "links"}: open in Library`, "data-path": r.path, "data-map-key": `an:${r.path}` },
      });
      b.style.left = `${at[i].x}px`;
      b.style.top = `${at[i].y}px`;
      b.createSpan({ cls: "aos-brain-ardot", attr: { "aria-hidden": "true" } });
      const name = b.createSpan({ cls: "aos-brain-arname", text: clip(r.title, 28), attr: { "aria-hidden": "true" } });
      // As wide as its side of the canvas allows, so a long name ends in an ellipsis, never cut at the edge.
      name.style.maxWidth = `${Math.max(40, Math.min(180, Math.floor(at[i].room)))}px`;
      b.addEventListener("click", () => this.openMemory(r.path));
    });
    if (!rows.length) canvas.createDiv({ cls: "aos-brain-mapempty is-below", text: "It links to no other memory in the map." });
  }

  // ── the right pane: the community's card, or the memory's ──

  private drawRight(): void {
    const right = this.right;
    if (!right || this.view === "every") return;
    right.empty();
    const d = this.ctx.data();
    const map = d.map!;
    const shown = this.shown(d);
    if (this.view === "communities") {
      const c = shown.find((x) => x.id === this.community);
      if (!c) { right.setAttr("aria-label", "Community"); right.createDiv({ cls: "aos-brain-empty", text: "Pick a community to see its members." }); return; }
      right.setAttr("aria-label", c.name);
      const head = right.createDiv({ cls: "aos-brain-mapcardhead" });
      head.createEl("h2", { cls: "aos-brain-mapcardtitle", text: c.name });
      head.createSpan({ cls: "aos-brain-mono aos-brain-mapcardline", text: communityLine(c) });
      this.drawConsolidate(right, d, c);
      const mem = right.createEl("section", { cls: "aos-brain-mapsec", attr: { "aria-label": "Members" } });
      mem.createEl("h3", { cls: "aos-brain-label", text: "Members" });
      for (const r of memberRows(c, d.byPath, this.usage(d), d.written, d.now)) {
        const b = mem.createEl("button", {
          cls: "aos-brain-mapmember",
          attr: { type: "button", "data-path": r.path, "data-map-key": `mem:${r.path}`, title: `Open ${r.title} in Library` },
        });
        b.createSpan({ cls: "aos-brain-mapmembername", text: r.title });
        if (r.unreviewed) b.createSpan({ cls: "aos-brain-pill is-warn aos-brain-mapmemberun", text: "unreviewed" });
        if (r.note) b.createSpan({ cls: `aos-brain-mono aos-brain-mapmembernote${r.used ? " is-used" : ""}`, text: r.note });
        b.addEventListener("click", () => this.openMemory(r.path));
      }
      const linked = right.createEl("section", { cls: "aos-brain-mapsec", attr: { "aria-label": "Linked communities" } });
      linked.createEl("h3", { cls: "aos-brain-label", text: "Linked communities" });
      const rows = linkedCommunities(map, c.id, shown);
      if (!rows.length) linked.createDiv({ cls: "aos-brain-empty", text: "None: no member links to another community shown here." });
      else {
        const wrap = linked.createDiv({ cls: "aos-brain-maplinked" });
        for (const l of rows) {
          const b = wrap.createEl("button", {
            cls: "aos-brain-chip aos-brain-maplink",
            attr: { type: "button", "data-community": l.id, "data-map-key": `lc:${l.id}`, "aria-label": `${l.name}, ${l.n} ${l.n === 1 ? "link" : "links"}` },
          });
          b.createSpan({ text: l.name });
          b.createSpan({ cls: "aos-brain-chipn", text: String(l.n) });
          b.addEventListener("click", () => this.selectCommunity(l.id, `c:${l.id}`));
        }
      }
      return;
    }
    const p = this.around;
    const m = p ? d.byPath.get(p) : undefined;
    if (!p || !m) { right.setAttr("aria-label", "Memory"); right.createDiv({ cls: "aos-brain-empty", text: "Pick a memory on the left to see what it links to." }); return; }
    right.setAttr("aria-label", m.title);
    const mm = map.memories[p];
    const community = mm?.community ? shown.find((c) => c.id === mm.community) ?? null : null;
    const head = right.createDiv({ cls: "aos-brain-mapcardhead" });
    head.createEl("h2", { cls: "aos-brain-mapcardtitle", text: m.title });
    head.createSpan({ cls: "aos-brain-mono aos-brain-mapcardline", text: `${m.type} · linked to ${mm?.degree ?? 0}` });
    const acts = right.createDiv({ cls: "aos-brain-mapcardacts" });
    const open = acts.createEl("button", { cls: "aos-brain-btn is-small", text: "Open in Library", attr: { type: "button", "data-map-key": "open" } });
    open.addEventListener("click", () => this.openMemory(p));
    if (community) {
      const cb = acts.createEl("button", {
        cls: "aos-brain-btn is-small aos-brain-mapincomm",
        attr: { type: "button", "data-community": community.id, "data-map-key": "incommunity", title: "Show its community" },
      });
      cb.createSpan({ text: `In ${clip(community.name, 28)}` });
      cb.addEventListener("click", () => this.selectCommunity(community.id, `c:${community.id}`));
    }
    const sec = right.createEl("section", { cls: "aos-brain-mapsec", attr: { "aria-label": "Neighbours" } });
    sec.createEl("h3", { cls: "aos-brain-label", text: "Neighbours" });
    const rows = aroundRows(map, p, d.byPath, shown);
    if (!rows.length) sec.createDiv({ cls: "aos-brain-empty", text: "It links to no other memory in the map." });
    for (const r of rows) {
      const b = sec.createEl("button", {
        cls: "aos-brain-mapmember",
        attr: { type: "button", "data-path": r.path, "data-map-key": `nb:${r.path}`, title: `Open ${r.title} in Library` },
      });
      const t = b.createSpan({ cls: "aos-brain-mapmembername" });
      t.createSpan({ text: r.title });
      if (r.community) t.createSpan({ cls: "aos-brain-dim aos-brain-mapmembercomm", text: ` · ${r.community}` });
      b.createSpan({ cls: "aos-brain-mono aos-brain-mapmembernote", text: `${r.n} ${r.n === 1 ? "link" : "links"}` });
      b.addEventListener("click", () => this.openMemory(r.path));
    }
  }

  // ── Consolidate with AI… (brain-ai A3): a sweep scoped to the community, and that scope's cards ──

  /** The paths a community's sweep sends: the lead first, then the most linked, at most SWEEP_MAX_PATHS. */
  private sweepPaths(d: BrainData, c: CommunityView): { paths: string[]; of: number; cut: number } {
    return scopePaths(c.lead, c.paths, (p) => d.map?.memories[p]?.degree ?? 0);
  }

  /** The button, what it says while it runs or why it is off, the cut it makes, then the community's suggestions. */
  private drawConsolidate(right: HTMLElement, d: BrainData, c: CommunityView): void {
    const sent = this.sweepPaths(d, c);
    const acts = right.createDiv({ cls: "aos-brain-mapcardacts aos-brain-sw-mapacts" });
    const mine = this.consolidating?.id === c.id ? this.consolidating.stage : null;
    const text = mine === "run" ? "Consolidating…" : mine ? "Checking…" : "Consolidate with AI…";
    const busy = !!this.consolidating;
    const b = acts.createEl("button", {
      cls: `aos-brain-btn is-small aos-brain-sw-consolidate${busy ? " is-busy" : ""}`, text,
      attr: {
        type: "button", "data-map-key": "consolidate", "data-act": "consolidate", "data-community": c.id,
        "aria-label": mine ? `Consolidate “${c.name}”: ${text}` : `Consolidate “${c.name}” with AI`, ...(busy ? { "aria-disabled": "true" } : {}), ...(mine ? { "aria-busy": "true" } : {}),
      },
    });
    guardClicks(b, () => { if (b.getAttribute("aria-disabled") !== "true") void this.consolidate(c); });
    const status = right.createEl("p", { cls: "aos-brain-sw-status", attr: { role: "status" } });
    if (mine === "run") status.createSpan({ text: "A model reads these memories' titles, descriptions and first lines; this can take up to two minutes." });
    else if (this.offNote?.id === c.id) {
      status.addClass("is-off");
      status.createSpan({ cls: "aos-brain-pill is-off aos-brain-sw-off", text: "off" });
      status.createSpan({ text: this.offNote.text });
    }
    if (sent.cut) right.createEl("p", { cls: "aos-brain-sw-cut aos-brain-dim", text: `A sweep looks at the ${sent.paths.length} most linked of its ${sent.of} memories.` });
    const scopes = groupScopes(d.sweep, sent.paths);
    const sum = scopeSummary(d, scopes);
    if (!sum.run && !sum.views.length) return;
    const sec = right.createEl("section", { cls: "aos-brain-mapsec aos-brain-sw-mapsec", attr: { "aria-label": "Suggestions" } });
    sec.createEl("h3", { cls: "aos-brain-label", text: "Suggestions" });
    sec.createEl("p", { cls: "aos-brain-sw-line", text: sum.line });
    this.cards.render(sec, sum.views, { label: `Suggestions for ${c.name}`, empty: "Nothing open: every suggestion was applied or dismissed." });
  }

  /**
   * Consolidate with AI… (brain-ai A3, A5): the scoped estimate (no model call), a question naming the cost and any
   * members left out, then the scoped sweep; its cards show in the card once the files reload. Off: the reason, in a
   * Notice and in the card. A confirm runs the sweep even when the person moved to another mode meanwhile.
   */
  private async consolidate(c: CommunityView): Promise<void> {
    if (this.consolidating || !this.root) return;
    const label = "Consolidate with AI";
    const sent = this.sweepPaths(this.ctx.data(), c);
    if (!sent.paths.length) return;
    this.offNote = null;
    this.consolidating = { id: c.id, stage: "check" };
    this.redrawRight();
    try {
      const pre = await this.ctx.preview<unknown>({ verb: "sweep", paths: sent.paths, estimate: true }, label);
      if (!pre.ok) return;
      const e = parseSweepEstimate(pre.json);
      if (!e) { new Notice(`${label}: aos answered in an unexpected shape`); return; }
      // The local engine down (local-first A3): a signed-in host may run it once, asked first; else why it is off.
      const once = !e.estimate.available ? e.estimate.once[0] ?? null : null;
      if (!e.estimate.available && !once) {
        const why = sweepOffText(e.estimate);
        this.offNote = { id: c.id, text: why };
        new Notice(`${label}: ${why}`);
        return;
      }
      // Left the Map while the estimate ran: no question over a page the person moved to.
      if (!this.root) return;
      this.consolidating = { id: c.id, stage: "ask" };
      this.redrawRight();
      const q = once ? onceAsk(label, once, e.estimate.reason) : consolidateAsk(c.name, e, sent);
      if (!(await this.ctx.confirm(q.title, q.message, q.confirm))) return;
      this.consolidating = { id: c.id, stage: "run" };
      this.redrawRight();
      const host = once ? (once.provider as OnceHost) : undefined;
      const r = await this.ctx.run<unknown>({ verb: "sweep", paths: sent.paths, estimate: false, ...(host ? { host } : {}) }, label, { timeoutMs: host ? AI_TIMEOUT_MS : sweepTimeoutMs(e) });
      if (r.ok) new Notice(sweepDoneText(parseSweepResult(r.json), c.name));
    } catch (err) {
      new Notice(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.consolidating = null;
      this.focusAfter = "consolidate";
      this.redrawRight();
    }
  }

  /** The right pane again (a busy state changed), keeping its scroll and the keyboard where they were. */
  private redrawRight(): void {
    const root = this.root;
    const right = this.right;
    if (!root || !right || this.view === "every" || this.built !== "map") return;
    const key = focusedKey(root);
    const top = right.scrollTop;
    this.drawRight();
    right.scrollTop = top;
    refocus(root, key);
    const want = this.focusAfter;
    this.focusAfter = null;
    const a = root.ownerDocument.activeElement;
    if (want && (!a || a === root.ownerDocument.body)) refocus(root, want);
  }

  // ── Every node: the graph, built from the map; kept, with its places and pins, while the map holds the same memories ──

  private ensureGraph(d: BrainData): void {
    const map = d.map;
    if (!map || map.state !== "ok") return;
    const live = Object.keys(map.memories).filter((p) => d.byPath.get(p)?.live).sort();
    const sig = `${map.builtAt ?? ""}|${live.join("\n")}`;
    if (this.graph && sig === this.graphSig) return;
    const g = everyNodeGraph(map, d.byPath);
    const old = this.graph;
    let kept = 0;
    if (old) for (const n of g.nodes) {
      const o = old.byId.get(n.id);
      if (o) { n.x = o.x; n.y = o.y; n.fixed = o.fixed; kept++; }
    }
    // A graph that is mostly new settles from its seeds when it is first shown; one that kept most places settles only its
    // new nodes, holding the kept ones, so a rebuild does not reshuffle the view.
    if (old && kept >= g.nodes.length / 2 && kept < g.nodes.length) {
      const held = g.nodes.filter((n) => old.byId.has(n.id) && !n.fixed);
      for (const n of held) n.fixed = true;
      settle(g, 180);
      for (const n of held) n.fixed = false;
      this.unsettled = false;
    } else if (!old || kept < g.nodes.length / 2) {
      this.unsettled = true;
    }
    if (this.dragging) this.dragging = g.byId.get(this.dragging.id) ?? null;
    this.graph = g;
    this.graphSig = sig;
  }

  private drawEvery(): void {
    const canvas = this.canvas;
    const legend = this.legend;
    if (!canvas || !legend) return;
    legend.empty();
    legend.createSpan({ cls: "aos-brain-mapswatch is-dot", attr: { "aria-hidden": "true" } });
    legend.createSpan({ text: "unreviewed" });
    canvas.addClass("is-every");
    if (!this.svg) {
      canvas.empty();
      const svg = this.svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Every node");
      svg.classList.add("aos-brain-mapsvg");
      canvas.appendChild(svg);
      this.gWorld = document.createElementNS(SVG_NS, "g");
      this.gEdges = document.createElementNS(SVG_NS, "g");
      this.gNodes = document.createElementNS(SVG_NS, "g");
      this.gLabels = document.createElementNS(SVG_NS, "g");
      const hl = this.hoverLabel = document.createElementNS(SVG_NS, "text");
      hl.classList.add("aos-brain-maphover");
      hl.setAttribute("pointer-events", "none");
      this.gWorld.append(this.gEdges, this.gNodes, this.gLabels, hl);
      svg.appendChild(this.gWorld);
      this.attachPanZoom(svg);
      this.present();
    } else if (this.unsettled) {
      this.present();
    } else {
      this.drawGraph();
    }
  }

  /** Put the graph on screen: settled and fitted the first time it shows (and refitted when the sim first rests). */
  private present(): void {
    const g = this.graph;
    if (!this.svg || !g) return;
    if (this.unsettled) {
      settle(g, 180);
      settle(g, SETTLE_GENTLE, GENTLE);
      this.unsettled = false;
      this.userMoved = false;
      this.refitOnRest = true;
    }
    this.fitToView();
    this.drawGraph();
    this.wake();
    this.startSim();
  }

  // ── the sim ──

  private startSim(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      const g = this.graph;
      if (!g || this.resting || this.view !== "every" || !this.svg?.isConnected || !this.ctx.view.isTabActive("memory")) return;
      tick(g, GENTLE);
      let fast = 0;
      for (const n of g.nodes) fast = Math.max(fast, Math.abs(n.vx) + Math.abs(n.vy));
      this.calm = fast * this.viewScale < REST_SPEED ? this.calm + 1 : 0;
      if ((this.calm >= REST_TICKS || ++this.awake >= SIM_MAX_TICKS) && !this.dragging) {
        this.resting = true;
        if (this.refitOnRest) {
          this.refitOnRest = false;
          if (!this.userMoved) this.fitToView();
        }
        this.relabel();
      } else if (++this.ticks % RELABEL_TICKS === 0) {
        this.relabel();
      }
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
    this.awake = 0;
  }

  /** Unpin every node and lay the graph out again from its seeds (the same picture each time). */
  private resettle(): void {
    const d = this.ctx.data();
    const g = this.graph;
    if (!g || !d.map) return;
    const seeds = everyNodeGraph(d.map, d.byPath);
    for (const n of g.nodes) {
      const s = seeds.byId.get(n.id);
      n.fixed = false;
      n.vx = 0; n.vy = 0;
      if (s) { n.x = s.x; n.y = s.y; }
    }
    this.unsettled = true;
    this.present();
  }

  // ── pan, zoom, drag ──

  private fitToView(): void {
    const g = this.graph;
    const c = this.canvas;
    if (!g || !c) return;
    const v = fitView(g.nodes, c.clientWidth || 800, c.clientHeight || 600, 48, MIN_SCALE, 1.4);
    this.viewX = v.x;
    this.viewY = v.y;
    this.viewScale = v.scale;
    this.applyTransform(true);
  }

  /** The world's transform; with `rescale`, the sizes that hold on screen (nodes, labels) and the labels shown. */
  private applyTransform(rescale = false): void {
    this.gWorld?.setAttribute("transform", `translate(${this.viewX} ${this.viewY}) scale(${this.viewScale})`);
    if (!rescale) return;
    for (const ne of this.nodeEls) ne.circle.setAttribute("r", String(drawnRadius(ne.deg, this.viewScale)));
    const font = String(labelFont(this.viewScale));
    for (const { el } of this.labelEls) el.setAttribute("font-size", font);
    this.hoverLabel?.setAttribute("font-size", font);
    this.relabel();
    this.updatePositions();
  }

  /** A pointer position in the graph's own coordinates. */
  private world(e: MouseEvent): { x: number; y: number } {
    const rect = this.svg?.getBoundingClientRect();
    return { x: (e.clientX - (rect?.left ?? 0) - this.viewX) / this.viewScale, y: (e.clientY - (rect?.top ?? 0) - this.viewY) / this.viewScale };
  }

  /** The svg's own listeners (a fresh <svg> each time Every node is drawn); the window's are bound in bind(). */
  private attachPanZoom(svg: SVGSVGElement): void {
    svg.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const wx = (mx - this.viewX) / this.viewScale;
      const wy = (my - this.viewY) / this.viewScale;
      this.viewScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.viewScale * factor));
      this.viewX = mx - wx * this.viewScale;
      this.viewY = my - wy * this.viewScale;
      this.userMoved = true;
      this.applyTransform(true);
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
      if (!this.dragMoved && Math.hypot(e.clientX - this.dragFrom.x, e.clientY - this.dragFrom.y) > DRAG_SLOP) { this.dragMoved = true; this.userMoved = true; }
      if (!this.dragMoved) return;
      const w = this.world(e);
      this.dragging.x = w.x - this.dragOffset.x;
      this.dragging.y = w.y - this.dragOffset.y;
      this.dragging.vx = 0;
      this.dragging.vy = 0;
      this.wake();
      this.updatePositions();
    } else if (this.panning) {
      if (e.clientX !== this.panStart.x || e.clientY !== this.panStart.y) this.userMoved = true;
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
      this.relabel();
    } else if (this.panning) {
      this.relabel();
    }
    this.panning = false;
  };

  // ── draw the graph ──

  private drawGraph(): void {
    const g = this.graph;
    const { gEdges, gNodes, gLabels, svg } = this;
    if (!g || !gEdges || !gNodes || !gLabels || !svg) return;
    gEdges.replaceChildren();
    gNodes.replaceChildren();
    gLabels.replaceChildren();
    this.nodeEls = [];
    this.edgeEls = [];
    this.labelEls = [];
    this.shownLabels.clear();
    const d = this.ctx.data();
    const deg = degrees(g);
    const font = String(labelFont(this.viewScale));

    for (const e of g.edges) {
      const a = g.byId.get(e.from);
      const b = g.byId.get(e.to);
      if (!a || !b) continue;
      const line = document.createElementNS(SVG_NS, "line");
      line.style.stroke = EDGE;
      line.setAttribute("stroke-width", "0.8");
      line.setAttribute("vector-effect", "non-scaling-stroke");
      line.dataset.from = a.id;
      line.dataset.to = b.id;
      gEdges.appendChild(line);
      this.edgeEls.push({ el: line, a, b });
    }

    for (const n of g.nodes) {
      const el = document.createElementNS(SVG_NS, "g");
      el.classList.add("aos-brain-mapnode");
      el.dataset.id = n.id;
      el.dataset.kind = n.kind;
      const k = deg.get(n.id) ?? 0;
      const unreviewed = d.byPath.get(n.path)?.reviewed === false;
      if (unreviewed) el.classList.add("is-unreviewed");
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = `${n.label}${unreviewed ? " (unreviewed)" : ""}`;
      el.appendChild(title);
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("r", String(drawnRadius(k, this.viewScale)));
      circle.setAttribute("stroke-width", "1");
      circle.setAttribute("vector-effect", "non-scaling-stroke");
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
        this.openMemory(n.path);
      });
      el.addEventListener("mouseenter", () => { this.hovered = n.id; this.applyHoverStyling(); });
      el.addEventListener("mouseleave", () => { if (this.hovered === n.id) this.hovered = null; this.applyHoverStyling(); });
      gNodes.appendChild(el);
      this.nodeEls.push({ el, circle, n, deg: k });

      const text = document.createElementNS(SVG_NS, "text");
      text.classList.add("aos-brain-maplabel");
      text.setAttribute("font-size", font);
      text.setAttribute("pointer-events", "none");
      text.textContent = n.label;
      text.dataset.id = n.id;
      text.style.display = "none";
      gLabels.appendChild(text);
      this.labelEls.push({ el: text, n });
    }
    this.hoverLabel?.setAttribute("font-size", font);

    const stats = `${g.nodes.length} ${g.nodes.length === 1 ? "memory" : "memories"} · ${g.edges.length} ${g.edges.length === 1 ? "link" : "links"}`;
    if (this.stats) this.stats.textContent = stats;
    svg.setAttribute("aria-label", `Every node: ${stats}`);
    if (this.canvas) {
      let empty = this.canvas.querySelector<HTMLElement>(".aos-brain-mapempty");
      if (!g.nodes.length) {
        empty ??= this.canvas.createDiv({ cls: "aos-brain-mapempty" });
        empty.textContent = "The map holds no memory to draw yet.";
      } else empty?.remove();
    }
    this.relabel();
    this.updatePositions();
    this.applyHoverStyling();
  }

  /** Which labels show: the most linked that fit on screen without overlapping (pickLabels), at the current zoom. */
  private relabel(): void {
    const c = this.canvas;
    if (!c || !this.labelEls.length) return;
    const w = c.clientWidth || 800;
    const h = c.clientHeight || 600;
    const cands: LabelCand[] = this.nodeEls.map((ne) => ({
      id: ne.n.id, deg: ne.deg, text: ne.n.label,
      x: this.viewX + ne.n.x * this.viewScale, y: this.viewY + ne.n.y * this.viewScale, r: drawnRadius(ne.deg, this.viewScale) * this.viewScale,
    }));
    this.shownLabels = pickLabels(cands, w, h);
    for (const { el, n } of this.labelEls) el.style.display = this.shownLabels.has(n.id) ? "" : "none";
    this.placeHoverLabel();
  }

  private updatePositions(): void {
    const gap = 3 / this.viewScale;
    for (const { el, n } of this.nodeEls) el.setAttribute("transform", `translate(${n.x} ${n.y})`);
    for (const { el, a, b } of this.edgeEls) {
      el.setAttribute("x1", String(a.x));
      el.setAttribute("y1", String(a.y));
      el.setAttribute("x2", String(b.x));
      el.setAttribute("y2", String(b.y));
    }
    for (let i = 0; i < this.labelEls.length; i++) {
      const { el, n } = this.labelEls[i];
      if (!this.shownLabels.has(n.id)) continue;
      el.setAttribute("x", String(n.x + drawnRadius(this.nodeEls[i].deg, this.viewScale) + gap));
      el.setAttribute("y", String(n.y + labelFont(this.viewScale) * 0.35));
    }
    this.placeHoverLabel();
  }

  /** The hovered node's name, for a node that carries no label of its own at this zoom. */
  private placeHoverLabel(): void {
    const t = this.hoverLabel;
    if (!t) return;
    const ne = this.hovered ? this.nodeEls.find((x) => x.n.id === this.hovered) : undefined;
    if (!ne || this.shownLabels.has(ne.n.id)) { t.textContent = ""; return; }
    t.textContent = ne.n.label;
    t.setAttribute("x", String(ne.n.x + drawnRadius(ne.deg, this.viewScale) + 3 / this.viewScale));
    t.setAttribute("y", String(ne.n.y + labelFont(this.viewScale) * 0.35));
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
}
