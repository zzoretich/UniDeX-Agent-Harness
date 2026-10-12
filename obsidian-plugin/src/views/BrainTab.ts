// The Brain tab (spec 2026-10-11-brain-hub; rail id "memory", D16): one hub for what agents wrote. Five modes as tabs
// across the top (D2): Review (session batches, D3–D7), Library (find and read, three panes), Bootstrap (what every
// session starts with, D17, D18), Map (graphify's communities, D19) and Health (D20). The tab owns the data and the
// header; each mode (views/brain/*) owns its panes. Actions are `aos memory` verbs through plugin.aosJson and the brain
// surface (D13, D14): the page writes no memory file itself, and no memory is deleted (D6).
import { Notice, TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { RevealTarget, WorkbenchView } from "./WorkbenchView";
import {
  BRAIN_OFF_TEXT, BUILD_BRAIN_MD, MEMORY_PATH_RE, RECALL_CLI, brainMdPercent, brainVerbResult, chunks, headerStats, healthCount, isBrainMode,
  isReviewQueue, memoryArgs, modeBadges, parseRecallHits, recallArgs, recallQuery, touchesBrain, type BrainMode, type BrainTarget,
  type BrainVerbResult, type MemoryVerb,
} from "../data/brainModel";
import { CaptureModal } from "../ui/CaptureModal";
import { ConfirmModal } from "../ui/ConfirmModal";
import { setPendingMemory, VIEW_TYPE_MEMORY_INSPECTOR } from "./MemoryInspectorView";
import { BRAIN_PANEL_ID, BrainHeader, brainTabId } from "./brain/Header";
import { BrainStore } from "./brain/load";
import { ReviewMode } from "./brain/ReviewMode";
import { LibraryMode } from "./brain/LibraryMode";
import { MapMode } from "./brain/MapMode";
import { BootstrapMode } from "./brain/BootstrapMode";
import { HealthMode } from "./brain/HealthMode";
import { openMerge } from "./brain/MergeModal";
import { brainSettings } from "./brain/load";
import { readAgenticosJson } from "../data/aosConfig";
import type { BrainCtx, BrainData, BrainModeView, BrainRunOptions, RecallPreview } from "./brain/types";
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
  /** The next scheduled load reads every file again (after a fix, which can touch any of them). */
  private scheduleFull = false;
  private hubRunning = false;
  private hubAgain = false;
  /** The unchecked memories the last rebuild on showing was for (checkHub): one rebuild per set of them. */
  private hubAsked = "";
  /** Review was on screen since the badge's marker last moved (D16): leaving it, by a mode or a tab, moves it again. */
  private reviewOnScreen = false;
  private seenQueued = false;
  private ctx: BrainCtx;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {
    this.store = new BrainStore(plugin.app, () => brainSettings(plugin.systemConfig(), readAgenticosJson(plugin.claudeConfigDir())));
    this.ctx = {
      plugin, view,
      data: () => this.data!,
      query: () => this.header?.query() ?? "",
      run: (v, label, opts) => this.run(v, label, opts),
      preview: (v, label, opts) => this.preview(v, label, opts),
      merge: (paths) => openMerge(this.ctx, paths),
      recall: (text) => this.recall(text),
      rescan: () => this.rebuildHub(),
      brainMd: () => this.brainMd(),
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
        // Hidden, the next showing reads everything again (refresh): no load in the background on each write. The tab is
        // never unmounted on the way out, so whether it shows is the view's to say, not this.root's.
        if (hit && this.root && this.view.isTabActive("memory")) this.schedule();
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
    // The panel the mode tabs control (§4: a tablist); render() labels it by the tab shown.
    this.body = this.root.createDiv({ cls: "aos-brain-body", attr: { id: BRAIN_PANEL_ID, role: "tabpanel" } });
    if (this.data) this.render();
    else this.body.createDiv({ cls: "aos-brain-loading", text: "Reading the brain…" });
  }

  /** Showing the tab: read everything again (the rail badge's marker moves when Review is drawn: render, D16). */
  async refresh(): Promise<void> {
    this.data = await this.store.load(true);
    this.render();
    this.checkHub();
  }

  /** A vault event or an action: re-read what changed, after `ms`. */
  private schedule(ms = 250, full = false): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.scheduleFull ||= full;
    this.refreshDebounce = window.setTimeout(() => {
      this.refreshDebounce = null;
      const all = this.scheduleFull;
      this.scheduleFull = false;
      void this.store.load(all).then((d) => { this.data = d; this.render(); this.checkHub(); });
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
    if (m !== "review") this.leaveReview();
    this.mode = m;
    this.pending = t.queue || t.memory || t.use || t.anchor || t.pair ? t : null;
    this.render();
  }

  /**
   * Review is on screen: the rail badge counts from now (D16), so memories that land while it shows are seen as they
   * appear rather than badged. Checked once the current task ends: a link that shows the tab and then another mode
   * (WorkbenchView.open mounts the tab, then reveals the mode) never counts as having opened Review.
   */
  private noteReview(): void {
    if (this.seenQueued) return;
    this.seenQueued = true;
    queueMicrotask(() => {
      this.seenQueued = false;
      if (this.mode !== "review" || this.shown !== "review" || !this.root || !this.view.isTabActive("memory")) return;
      this.reviewOnScreen = true;
      this.view.markBrainSeen();
    });
  }

  /** Review leaves the screen (another mode, another tab, the view closing): what lands after now counts (D16). */
  private leaveReview(): void {
    if (!this.reviewOnScreen) return;
    this.reviewOnScreen = false;
    this.view.markBrainSeen();
  }

  /** WorkbenchView shows another tab; it never unmounts this one on the way out. Review leaves the screen, and a load a
   *  vault event scheduled is dropped: the next showing reads everything again. */
  leave(): void {
    this.leaveReview();
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = null;
  }

  private modeView(m: BrainMode): BrainModeView {
    return (this.modes[m] ??= m === "review" ? new ReviewMode(this.ctx)
      : m === "library" ? new LibraryMode(this.ctx)
      : m === "map" ? new MapMode(this.ctx)
      : m === "bootstrap" ? new BootstrapMode(this.ctx)
      : new HealthMode(this.ctx));
  }

  private render(): void {
    if (!this.view.isTabActive("memory") || !this.root || !this.header || !this.body || !this.data) return;
    const d = this.data;
    const toReview = d.batches.reduce((n, b) => n + b.paths.length, 0);
    this.header.update({
      stats: headerStats(d.memories, d.patterns.length, d.reflections.length, d.written, d.now),
      mode: this.mode,
      badges: modeBadges({ toReview, live: d.memories.filter((x) => x.live).length, brainPct: brainMdPercent(d.sources), health: healthCount(d.pairs.length, d.hub) }),
    });
    this.body.setAttr("data-mode", this.mode);
    this.body.setAttr("aria-labelledby", brainTabId(this.mode));
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
    if (this.mode === "review") this.noteReview();
  }

  // ── actions ──

  private async run<T>(v: MemoryVerb, label: string, opts: BrainRunOptions = {}): Promise<BrainVerbResult<T>> {
    let args: string[];
    try { args = memoryArgs(v); } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (!opts.quiet) new Notice(`${label}: ${reason}`);
      return { ok: false, reason, refused: false, outdated: false, stale: false };
    }
    const r = brainVerbResult<T>(await this.plugin.aosJson<T>(args, opts.timeoutMs));
    if (!r.ok && !opts.quiet) new Notice(`${label}: ${r.reason}`);
    for (const p of touched(v)) this.store.touch(p);
    if (r.ok) this.rebuildHub();
    // A fix can touch any memory, MEMORY.md and a draft: read everything again rather than guess which.
    this.schedule(0, v.verb === "fix");
    return r;
  }

  /** A verb that writes nothing (`fix … --dry-run`, an `--estimate`): its answer, a Notice when it fails, no reload, no rebuild. */
  private async preview<T>(v: MemoryVerb, label: string, opts: BrainRunOptions = {}): Promise<BrainVerbResult<T>> {
    let args: string[];
    try { args = memoryArgs(v); } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (!opts.quiet) new Notice(`${label}: ${reason}`);
      return { ok: false, reason, refused: false, outdated: false, stale: false };
    }
    if (!args.includes("--dry-run") && !args.includes("--estimate")) throw new Error("preview runs only a --dry-run or an --estimate");
    const r = brainVerbResult<T>(await this.plugin.aosJson<T>(args, opts.timeoutMs));
    if (!r.ok && !opts.quiet) new Notice(`${label}: ${r.reason}`);
    return r;
  }

  /** The recall preview (D18): sdk/recall-cli.js on the typed text, through the brain surface; no usage is logged (D9). */
  private async recall(text: string): Promise<RecallPreview> {
    let args: string[];
    try { args = recallArgs(text); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
    const r = await this.plugin.scriptJson<unknown>(RECALL_CLI, args);
    if (r.error && /\brefused\b/.test(r.error)) return { ok: false, reason: "Brain's write surface is off in this app: run aos recall in a terminal instead" };
    if (r.timedOut) return { ok: false, reason: "recall did not answer in time" };
    if (r.error) return { ok: false, reason: `could not run recall: ${r.error}` };
    if (r.code !== 0 || !Array.isArray(r.json)) {
      const line = String(r.stderr ?? "").split("\n").map((l) => l.trim()).find(Boolean);
      return { ok: false, reason: (line ?? `recall exited ${r.code}`).replace(/^recall: /, "") };
    }
    return { ok: true, query: recallQuery(text), hits: parseRecallHits(r.json) };
  }

  /** build-brain-md.js through the brain surface, waited for (Bootstrap's bulk Mark complete rebuilds BRAIN.md once). */
  private async brainMd(): Promise<{ ok: boolean; error?: string }> {
    const r = await this.plugin.scriptJson<unknown>(BUILD_BRAIN_MD, []);
    this.schedule(0);
    if (r.error && /\brefused\b/.test(r.error)) return { ok: false, error: BRAIN_OFF_TEXT };
    if (r.timedOut) return { ok: false, error: "build-brain-md did not answer in time" };
    if (r.error) return { ok: false, error: r.error };
    if (r.code !== 0) return { ok: false, error: String(r.stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? `exit ${r.code}` };
    return { ok: true };
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

  /**
   * brain-hub.json lags the files until the next scan (D12): auto-wrap writes after the SessionEnd scan has run, and an
   * in-session /wrap or an approved draft adds a memory no batch holds, with no session title, host or duplicate check.
   * Shown with any such, the tab rebuilds the cache, once per set of them; Review calls them unchecked meanwhile and ⇧K
   * leaves them (D3, D11).
   */
  private checkHub(): void {
    const d = this.data;
    if (!d || !this.root || !this.view.isTabActive("memory")) return;
    const unseen = d.batches.flatMap((b) => b.unchecked).sort();
    const sig = unseen.join("\n");
    if (sig === this.hubAsked) return;
    this.hubAsked = sig;
    if (unseen.length) this.rebuildHub();
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
    this.leaveReview();
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
    case "merge": return [...always, ...v.paths];
    case "unmerge": return [...always, v.path];
    // A draft, an estimate and a sweep write no memory; memory-sweep.json is read whole on every load.
    case "notdup": case "fix": case "merge-draft": case "sweep": case "sweep-dismiss": return [];
  }
}

