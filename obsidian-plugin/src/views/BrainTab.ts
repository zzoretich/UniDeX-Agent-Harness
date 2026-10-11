// The Brain tab (spec 2026-10-11-brain-hub; rail id "memory", D16): one hub for what agents wrote. Five modes as tabs
// across the top (D2): Review (session batches, D3–D7), Library (find and read, three panes), and Bootstrap, Map and
// Health (stand-ins until PR 3; Map keeps the old force graph as "Every node", D19). The tab owns the data and the
// header; each mode (views/brain/*) owns its panes. Actions are `aos memory` verbs through plugin.aosJson and the brain
// surface (D13, D14): the page writes no memory file itself, and nothing is deleted (D6).
import { Notice, TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { RevealTarget, WorkbenchView } from "./WorkbenchView";
import {
  MEMORY_PATH_RE, brainMdPercent, brainVerbResult, chunks, headerStats, isBrainMode, isReviewQueue, memoryArgs,
  modeBadges, touchesBrain, type BrainMode, type BrainTarget, type BrainVerbResult, type MemoryVerb,
} from "../data/brainModel";
import { CaptureModal } from "../ui/CaptureModal";
import { ConfirmModal } from "../ui/ConfirmModal";
import { setPendingMemory, VIEW_TYPE_MEMORY_INSPECTOR } from "./MemoryInspectorView";
import { BrainHeader } from "./brain/Header";
import { BrainStore } from "./brain/load";
import { ReviewMode } from "./brain/ReviewMode";
import { LibraryMode } from "./brain/LibraryMode";
import { MapMode } from "./brain/MapMode";
import { StandInMode } from "./brain/StandIn";
import type { BrainCtx, BrainData, BrainModeView } from "./brain/types";
import * as path from "path";

export class BrainTab {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private header: BrainHeader | null = null;
  private body: HTMLElement | null = null;
  private store: BrainStore;
  private data: BrainData | null = null;
  private mode: BrainMode = "review";
  private shown: BrainMode | null = null;
  private modes: Partial<Record<BrainMode, BrainModeView>> = {};
  private pending: BrainTarget | null = null;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;
  private hubRunning = false;
  private hubAgain = false;
  private ctx: BrainCtx;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {
    this.store = new BrainStore(plugin.app);
    this.ctx = {
      plugin, view,
      data: () => this.data!,
      query: () => this.header?.query() ?? "",
      run: (v, label) => this.run(v, label),
      runAll: (verb, paths, label) => this.runAll(verb, paths, label),
      refresh: () => this.schedule(0),
      show: (t) => this.show(t),
      edit: async (p) => { await this.plugin.app.workspace.openLinkText(p, "", true); },
      popOut: (p) => { setPendingMemory(p); void this.plugin.activate(VIEW_TYPE_MEMORY_INSPECTOR, "split"); },
      confirm: (title, message, label) => ConfirmModal.ask(this.plugin.app, title, message, label),
      dismissPair: (a, b) => { this.store.dismiss(a, b); this.schedule(0); },
      markReviewSeen: () => this.view.markBrainSeen(),
    };
  }

  mount(host: HTMLElement): void {
    // WorkbenchView mounts a tab each time it is shown and never unmounts it on the way out: the mode drawn last time
    // lets go of its old panes first (Library's list signature, Map's sim), so it draws into the new ones from scratch.
    if (this.shown) this.modes[this.shown]?.unmount();
    this.shown = null;
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const on = (f: TAbstractFile, old?: string): void => {
        let hit = false;
        for (const p of old === undefined ? [f.path] : [f.path, old]) if (touchesBrain(p)) { this.store.touch(p); hit = true; }
        // Hidden, the next showing reads everything again (refresh): no load in the background on each write.
        if (hit && this.root) this.schedule();
      };
      this.view.registerEvent(this.plugin.app.vault.on("create", (f) => on(f)));
      this.view.registerEvent(this.plugin.app.vault.on("modify", (f) => on(f)));
      this.view.registerEvent(this.plugin.app.vault.on("delete", (f) => on(f)));
      this.view.registerEvent(this.plugin.app.vault.on("rename", (f, old) => on(f, old)));
    }
    this.root = host.createDiv({ cls: "aos-brain" });
    this.root.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); this.header?.focusSearch(); }
    });
    this.header = new BrainHeader(this.root, {
      mode: (m) => this.show({ mode: m }),
      search: () => { if (this.mode !== "library") this.show({ mode: "library" }); else this.modes.library?.update(); },
      capture: () => new CaptureModal(this.plugin.app).open(),
    });
    this.body = this.root.createDiv({ cls: "aos-brain-body" });
    if (this.data) this.render();
    else this.body.createDiv({ cls: "aos-brain-loading", text: "Reading the brain…" });
  }

  /** Showing the tab: read everything again. Shown on Review, Review is open: the rail badge counts from now (D16). */
  async refresh(): Promise<void> {
    if (this.mode === "review") this.view.markBrainSeen();
    this.data = await this.store.load(true);
    this.render();
  }

  /** A vault event or an action: re-read what changed, after `ms`. */
  private schedule(ms = 250): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => {
      this.refreshDebounce = null;
      void this.store.load().then((d) => { this.data = d; this.render(); });
    }, ms);
  }

  /** Where open() lands (brain-hub D15): a mode, Review's queue, a memory to show in Library. Select only. */
  reveal(target: RevealTarget): void {
    const t: BrainTarget = {};
    if (isBrainMode(target.mode)) t.mode = target.mode;
    if (isReviewQueue(target.queue)) { t.queue = target.queue; t.mode ??= "review"; }
    if (typeof target.memory === "string" && MEMORY_PATH_RE.test(target.memory)) { t.memory = target.memory; t.mode ??= "library"; }
    if (t.mode) this.show(t);
  }

  private show(t: BrainTarget): void {
    const m = t.mode ?? this.mode;
    if (m !== this.mode && this.mode === "review") this.view.markBrainSeen();   // leaving Review: counted from now
    this.mode = m;
    this.pending = t.queue || t.memory ? t : null;
    if (m === "review") this.view.markBrainSeen();
    this.render();
  }

  private modeView(m: BrainMode): BrainModeView {
    return (this.modes[m] ??= m === "review" ? new ReviewMode(this.ctx)
      : m === "library" ? new LibraryMode(this.ctx)
      : m === "map" ? new MapMode(this.ctx)
      : new StandInMode(this.ctx, m));
  }

  private render(): void {
    if (!this.view.isTabActive("memory") || !this.root || !this.header || !this.body || !this.data) return;
    const d = this.data;
    const toReview = d.batches.reduce((n, b) => n + b.paths.length, 0);
    this.header.update({
      stats: headerStats(d.memories, d.patterns.length, d.reflections.length, d.written, d.now),
      mode: this.mode,
      badges: modeBadges({ toReview, live: d.memories.filter((x) => x.live).length, brainPct: brainMdPercent(d.sources) }),
    });
    this.body.setAttr("data-mode", this.mode);
    if (this.shown !== this.mode) {
      if (this.shown) this.modes[this.shown]?.unmount();
      this.body.empty();
      this.shown = this.mode;
      this.modeView(this.mode).mount(this.body);
    } else {
      this.modeView(this.mode).update();
    }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.modeView(this.mode).reveal?.(p);
    }
  }

  // ── actions ──

  private async run<T>(v: MemoryVerb, label: string): Promise<BrainVerbResult<T>> {
    let args: string[];
    try { args = memoryArgs(v); } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      new Notice(`${label}: ${reason}`);
      return { ok: false, reason, refused: false, outdated: false, stale: false };
    }
    const r = brainVerbResult<T>(await this.plugin.aosJson<T>(args));
    if (!r.ok) new Notice(`${label}: ${r.reason}`);
    for (const p of touched(v)) this.store.touch(p);
    if (r.ok) this.rebuildHub();
    this.schedule(0);
    return r;
  }

  private async runAll(verb: "keep" | "archive" | "restore", paths: readonly string[], label: string): Promise<{ done: number; failed: string | null }> {
    let done = 0;
    for (const part of chunks(paths)) {
      const r = await this.run<unknown>({ verb, paths: part }, label);
      if (!r.ok) return { done, failed: r.reason };
      done += part.length;
    }
    return { done, failed: null };
  }

  /** brain-hub.json follows the files after an action (else only the next scan rebuilds it); one run at a time. */
  private rebuildHub(): void {
    if (this.hubRunning) { this.hubAgain = true; return; }
    this.hubRunning = true;
    const env = { AOS_VAULT: this.plugin.vaultRoot(), AOS_CONFIG: path.join(this.plugin.claudeConfigDir(), "agenticos.json") };
    this.plugin.runBrainScript("brain/scripts/brain-hub.js", [], () => {
      this.hubRunning = false;
      if (this.hubAgain) { this.hubAgain = false; this.rebuildHub(); }
    }, { quiet: true, env });
  }

  unmount(): void {
    if (this.mode === "review") this.view.markBrainSeen();
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = null;
    if (this.shown) this.modes[this.shown]?.unmount();
    this.shown = null;
    this.host?.empty();
    this.host = null;
    this.root = null;
    this.header = null;
    this.body = null;
  }
}

/** The files a verb changes besides MEMORY.md and the trail, so the next load re-reads them without waiting for events. */
function touched(v: MemoryVerb): string[] {
  const always = ["MEMORY.md", "brain/_index/promote-log.jsonl"];
  switch (v.verb) {
    case "keep": case "archive": case "restore": return [...always, ...v.paths];
    case "set": return [...always, v.path];
    case "supersede": return [...always, v.path, v.by];
    case "draft": return [...always, `brain/memory/feedback/_drafts/${v.slug}.md`, `brain/memory/feedback/${v.slug}.md`];
    case "notdup": return [];
  }
}

