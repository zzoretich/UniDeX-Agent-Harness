// The Brain hub's shell contract (spec 2026-10-11-brain-hub D2): what BrainTab hands each mode, and what a mode gives back.
// BrainTab owns the data (one load, kept current by vault events), the header and the mode strip; each mode owns its own
// panes and redraws itself from ctx.data() when update() is called.
import type AgenticOSPlugin from "../../../main";
import type { WorkbenchView } from "../WorkbenchView";
import type { TrailEntry } from "../../data/promoteTrail";
import type {
  BrainDraft, BrainHub, BrainMemory, BrainMode, BrainNote, BrainSources, BrainTarget, BrainVerbResult, DupFlag, HubDup,
  MemoryVerb, ReviewBatch,
} from "../../data/brainModel";

/** One load of the hub's data: the files win, the caches fill in (brainModel.ts). */
export interface BrainData {
  now: Date;
  memories: BrainMemory[];
  byPath: Map<string, BrainMemory>;
  drafts: BrainDraft[];
  patterns: BrainNote[];
  reflections: BrainNote[];
  /** brain/_index/brain-hub.json, null before the first scan that writes it. */
  hub: BrainHub | null;
  /** brain/_index/brain-sources.json, null before build-brain-md writes it. */
  sources: BrainSources | null;
  /** promote-log.jsonl, oldest first. */
  trail: TrailEntry[];
  /** type/slug → when the trail says auto-wrap wrote it. */
  written: Map<string, string>;
  /** MEMORY.md's description per memory path. */
  index: Map<string, string>;
  /** The live duplicate pairs, best first, less those dismissed on this page. */
  pairs: HubDup[];
  /** Each memory's best duplicate partner. */
  flags: Map<string, DupFlag>;
  /** Review's batches (the hub's, overlaid with the files). */
  batches: ReviewBatch[];
}

/** What a mode acts through. */
export interface BrainCtx {
  plugin: AgenticOSPlugin;
  view: WorkbenchView;
  /** The current load; never null once a mode is mounted. */
  data(): BrainData;
  /** The header's search text (Library filters by it). */
  query(): string;
  /**
   * Runs one `aos memory` verb through plugin.aosJson (the brain surface), says why in a Notice when it fails, and on
   * success reloads the files and rebuilds brain-hub.json in the background. `label` names the action in a Notice.
   */
  run<T>(verb: MemoryVerb, label: string): Promise<BrainVerbResult<T>>;
  /** keep, archive or restore over any number of paths, in calls of at most MAX_PATHS_PER_CALL; stops at the first failure. */
  runAll(verb: "keep" | "archive" | "restore", paths: readonly string[], label: string): Promise<{ done: number; failed: string | null }>;
  /** Reload the files now (a mode calls it after an action that changed nothing through ctx.run, e.g. dismissing a pair). */
  refresh(): void;
  /** Switch mode, optionally landing on a queue or a memory (⏎ in Review opens Library on it). */
  show(target: BrainTarget): void;
  /** Open a vault file in the app's editor (Edit: it changes nothing by itself, D4). */
  edit(path: string): Promise<void>;
  /** Pop a memory out into the split pane's Memory inspector (⧉, kept from the Memory tab). */
  popOut(path: string): void;
  /** A yes/no dialog (Archive of more than one, a draft's reject, Mark everything before: spec §6). */
  confirm(title: string, message: string, confirmLabel: string): Promise<boolean>;
  /** "Keep both" without waiting for the next scan: this page stops showing the pair (the verb records it for the scan). */
  dismissPair(a: string, b: string): void;
  /** Review was shown: the rail badge counts from now (D16). */
  markReviewSeen(): void;
}

/** A mode: Review, Library, Bootstrap, Map, Health. Built once, mounted each time it is shown. */
export interface BrainModeView {
  /** Build into `host` (empty, owned by the mode until unmount). */
  mount(host: HTMLElement): void;
  /** The data changed: redraw, keeping the selection, the scroll and the focus where they were. */
  update(): void;
  /** Land on a queue or a memory (BrainTarget's queue / memory). */
  reveal?(target: BrainTarget): void;
  /** The mode is hidden (another mode or tab is shown): stop timers, drop listeners. State may stay for the next mount. */
  unmount(): void;
}

export type { BrainMode };
