import { Plugin, WorkspaceLeaf, TAbstractFile, Events, Notice } from "obsidian";
import { SidebarHUDView, VIEW_TYPE_SIDEBAR_HUD } from "./src/views/SidebarHUD";
import { BRAND } from "./src/brand";
import { MemoryInspectorView, VIEW_TYPE_MEMORY_INSPECTOR, consumePendingMemory } from "./src/views/MemoryInspectorView";
import { RunInspectorView, VIEW_TYPE_RUN_INSPECTOR, consumePendingRunId } from "./src/views/RunInspectorView";
import { WorkbenchView, VIEW_TYPE_WORKBENCH, WORKBENCH_TAB_IDS, type WorkbenchTarget } from "./src/views/WorkbenchView";
import type { PulseTab } from "./src/views/PulseTab";
import type { RunsTab } from "./src/views/RunsTab";
import type { FilesTab } from "./src/views/files/FilesTab";
import { QuickOpenModal } from "./src/ui/QuickOpenModal";
import { TerminalPool } from "./src/data/terminalPool";
import { TerminalLauncher } from "./src/data/terminalLauncher";
import type { TermTab } from "./src/views/TermTab";
import { loginsUnknown, sessionHosts, signedInHosts } from "./src/data/aosConfig";
import type { TermHost } from "./src/data/terminalLaunch";
import { AgenticOSSettings, AgenticOSSettingTab, DEFAULT_SETTINGS } from "./src/settings";
import { loadSnapshot, SNAPSHOT_PATH, visibleWorkspaces } from "./src/data/snapshot";
import { loadRuns, RUNS_PATH, touchesRuns, formatRelative } from "./src/data/runs";
import { loadStatusline, isStale as statuslineStale, barSegments, workbenchLinkFrom, workbenchTabFrom, STATUSLINE_PATH } from "./src/data/statusline";
import type { BarTone } from "./src/data/statusline";
import { CaptureModal } from "./src/ui/CaptureModal";
import { HeartbeatClient } from "./src/data/heartbeatClient";
import { LiveRunsWatcher } from "./src/data/liveRuns";
import { COMMAND_REGISTRY, executeCommand, setSpawnContext } from "./src/data/commandRegistry";
import { resolveNodeBinary } from "./src/data/nodeResolver";
import { readAgenticosJson, readVaultConfig, readProviderState, claudeConfigDir as defaultClaudeConfigDir } from "./src/data/aosConfig";
import { resolveClaudeBin } from "./src/data/claudeAsk";
import { DEAD_SETTINGS_KEYS, rememberFilesChoice } from "./src/settingsDefaults";
import { runAos, runAosJson } from "./src/data/aosRun";
import type { AosResult, AosJsonResult } from "./src/data/aosRun";
import type { VaultConfig } from "./src/data/aosConfig";
import { loadAllMaps } from "./src/data/workspaceMaps";
import { listMemories } from "./src/data/memories";
import { loadStaff } from "./src/data/staff";
import { loadInventory } from "./src/data/inventory";
import type { FixAction } from "./src/data/fixQueue";
import { buildOmniItems } from "./src/data/omni";
import { OmniModal } from "./src/ui/OmniModal";
import { TourController } from "./src/tour/controller";
import { SESSION_INDEX_PATH, hasHistory } from "./src/data/sessionHistory";
import { runLaunchSequence, type LaunchDeps, type LaunchStep } from "./src/ui/launchSequence";
import * as path from "path";
import { env, fs, spawn } from "./src/host";

// How often to regenerate snapshot.json while Obsidian is open. The HUD nags
// once the snapshot is >30 min old (see briefing.ts); 15 min keeps it ahead of
// that threshold. The only other refresh trigger is the Claude SessionEnd hook.
const SNAPSHOT_REFRESH_MS = 15 * 60_000;
const SNAPSHOT_STALE_MS = 15 * 60_000;

/** Status bar tones → the classes styled under .aos-statusbar (the bar sits outside .aos-root). */
const STATUS_TONE: Record<BarTone, string> = { violet: "aos-text-violet", rose: "aos-text-rose", amber: "aos-text-amber", cyan: "aos-text-cyan", dim: "aos-dim" };

export default class AgenticOSPlugin extends Plugin {
  settings!: AgenticOSSettings;
  private statusBarEl: HTMLElement | null = null;
  private statusBarTimer: number | null = null;
  private statuslineRefreshing = false;
  private runsWatcher: { close(): void } | null = null;
  private runsBytesSeen: number = 0;
  private snapshotRefreshing: boolean = false;

  hb!: HeartbeatClient;
  liveRuns: LiveRunsWatcher | null = null;
  bus: Events = new Events();    // intra-plugin event bus for live-run fan-out
  terminalPool!: TerminalPool;
  termLauncher!: TerminalLauncher;
  /** The guided tour, Help and Getting started (spec 2026-10-14-guided-tour-design). */
  tour!: TourController;

  async onload(): Promise<void> {
    await this.loadSettings();
    setSpawnContext({ node: this.nodeBin(), vaultRoot: this.vaultRoot() });

    // heartbeat client — now a thin reflector over the local live watcher.
    // setSource() is called after the LiveRunsWatcher is constructed on onLayoutReady.
    this.hb = new HeartbeatClient();
    this.hb.on("change", () => { this.refreshStatusBar(); });
    this.hb.on("probe", () => { /* keep status bar's "ago" fresh */ });
    this.hb.start();

    // terminal pool — its defaults read the settings at each new terminal, so the Shell and Working directory settings
    // apply without a restart (spec 2026-10-08-term-agent-deck)
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const vaultPath = adapter.getBasePath ? adapter.getBasePath() : env.cwd();
    const settings = () => this.settings;
    this.terminalPool = new TerminalPool({
      get shell() { return settings().terminalShell || env.get("SHELL") || (env.platform() === "win32" ? "cmd.exe" : "/bin/zsh"); },
      get cwd() { return settings().terminalCwd || vaultPath; },
    });
    this.termLauncher = new TerminalLauncher(this);
    this.tour = new TourController(this);

    // views
    this.registerView(VIEW_TYPE_SIDEBAR_HUD, (leaf) => new SidebarHUDView(leaf, this));
    this.registerView(VIEW_TYPE_MEMORY_INSPECTOR, (leaf) => new MemoryInspectorView(leaf));
    this.registerView(VIEW_TYPE_RUN_INSPECTOR, (leaf) => new RunInspectorView(leaf));
    this.registerView(VIEW_TYPE_WORKBENCH, (leaf) => new WorkbenchView(leaf, this));

    // ribbon icons
    this.addRibbonIcon("layout-dashboard", "Workbench",      () => { void this.activate(VIEW_TYPE_WORKBENCH); });
    this.addRibbonIcon("plus", "Quick Capture", () => { new CaptureModal(this.app).open(); });

    // commands
    this.addCommand({ id: "open-workbench",       name: "Open Workbench",        callback: () => { void this.activate(VIEW_TYPE_WORKBENCH); } });
    for (const t of ["todo", "proposals", "notifications", "spaces", "memory", "runs", "routines", "skills", "connectors", "agents", "agent-teams", "chat", "term", "settings"] as const) {
      // The Brain tab keeps the id "memory" (brain-hub D16), so its command id holds and only the name changes.
      const name = t === "todo" ? "To-Do" : t === "agent-teams" ? "Agent Teams" : t === "chat" ? "Sessions" : t === "term" ? "Code" : t === "memory" ? "Brain" : `${t[0].toUpperCase()}${t.slice(1)}`;
      this.addCommand({ id: `open-workbench-${t}`, name: `Open Workbench: ${name}`,
        callback: () => { void this.openWorkbenchTab(t); } });
    }
    this.addCommand({ id: "open-sidebar-hud",     name: "Open Sidebar HUD",     callback: () => { void this.activate(VIEW_TYPE_SIDEBAR_HUD, "right"); } });
    this.addCommand({ id: "open-memory-inspector", name: "Open Memory Inspector", callback: () => { void this.activate(VIEW_TYPE_MEMORY_INSPECTOR); } });
    this.addCommand({ id: "open-run-inspector",   name: "Open Run Inspector",    callback: () => { void this.activate(VIEW_TYPE_RUN_INSPECTOR); } });
    // Starting terminals (spec 2026-10-08-term-agent-deck T2, T3, T6): ⌘T the host used last, ⌥⌘1-3 one host each (only
    // for a host that is on), ⇧⌘T the menu, ⇧⌘N a new workspace. The menu and the keymap are built from these hotkeys.
    this.addCommand({ id: "new-terminal", name: "New terminal", hotkeys: [{ modifiers: ["Mod"], key: "t" }],
      callback: () => { void this.termCommand((v) => v.launchTerminal("quick")); } });
    const on = sessionHosts(readAgenticosJson(this.claudeConfigDir()));
    const perHost: Array<{ host: TermHost; id: string; name: string; key: string }> = [
      { host: "claude", id: "new-terminal-claude", name: "New Claude Code terminal", key: "1" },
      { host: "codex", id: "new-terminal-codex", name: "New Codex terminal", key: "2" },
      { host: "shell", id: "new-terminal-shell", name: "New shell", key: "3" },
    ];
    for (const c of perHost) {
      if (c.host !== "shell" && !on.includes(c.host)) continue;
      this.addCommand({ id: c.id, name: c.name, hotkeys: [{ modifiers: ["Mod", "Alt"], key: c.key }],
        callback: () => { void this.termCommand((v) => v.launchTerminal(c.host)); } });
    }
    this.addCommand({ id: "new-terminal-menu", name: "New terminal…", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "t" }],
      callback: () => { void this.termCommand(async (v) => v.openTermMenu("menu")); } });
    // On the Term tab only (they do nothing elsewhere): ⇧⌘] / ⇧⌘[ the next or previous terminal, ⇧⌘W close it, ⌘F find in it.
    const onTerm = (fn: (t: TermTab) => void) => () => {
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0]?.view;
      if (view instanceof WorkbenchView && view.isTabActive("term")) { const t = view.getTab("term") as TermTab | null; if (t) fn(t); }
    };
    this.addCommand({ id: "term-next", name: "Next terminal", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "]" }], callback: onTerm((t) => t.step(1)) });
    this.addCommand({ id: "term-previous", name: "Previous terminal", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "[" }], callback: onTerm((t) => t.step(-1)) });
    this.addCommand({ id: "term-composer", name: "Write to the agent (composer)", hotkeys: [{ modifiers: ["Mod"], key: "l" }], callback: onTerm((t) => { t.focusComposer(); }) });
    this.addCommand({ id: "term-close", name: "Close terminal", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "w" }], callback: onTerm((t) => t.closeActive()) });
    this.addCommand({ id: "term-find", name: "Find in the terminal", hotkeys: [{ modifiers: ["Mod"], key: "f" }], callback: onTerm((t) => { t.openFind(); }) });
    this.addCommand({ id: "new-workspace", name: "New workspace…", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "n" }],
      callback: () => { void this.termCommand(async (v) => v.openTermMenu("create")); } });
    this.addCommand({
      id: "quick-capture",
      name: "Quick Capture (new memory)",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }],
      callback: () => { new CaptureModal(this.app).open(); },
    });
    this.addCommand({ id: "open-omnisearch", name: "Omnisearch",
      callback: () => { void this.openOmni(); } });
    // The Files tab's two entry points (no default hotkeys: in Obsidian ⌘O and ⌘⇧F are its own; the app's menu binds them).
    this.addCommand({ id: "open-file", name: "Open file…", callback: () => { new QuickOpenModal(this.app, (p) => this.rememberFilesOpened(p)).open(); } });
    this.addCommand({ id: "search-vault", name: "Search vault…",
      callback: () => { void this.openWorkbenchTab("files").then(() => this.currentFilesTab()?.focusSearch()); } });
    // Help (tour C12): Take the tour, Tour this tab, What's new, Getting started, Documentation. The app's Help menu
    // lists these by id.
    this.tour.registerCommands();

    this.addSettingTab(new AgenticOSSettingTab(this.app, this));

    this.rebuildStatusBar();

    this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => {
      if (file.path === SNAPSHOT_PATH || file.path === STATUSLINE_PATH || touchesRuns(file.path)) this.refreshStatusBar();
    }));

    // Terminal status lines link here (statusline spec D10): agenticos://workbench?tab=<rail id>, which the app routes to
    // this handler, or obsidian://agenticos?vault=<name>&tab=<rail id> from before the app. Only a rail tab id opens a
    // tab; anything else just opens the Workbench. A Spaces link may also select a workspace (spaces-redesign D12):
    // agenticos://workbench?tab=spaces&workspace=<name>[&pane=<p>][&thread=<id>], each checked (workbenchLinkFrom).
    this.registerObsidianProtocolHandler("agenticos", (params) => { void this.openLink(params); });

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.autoOpenSidebarOnStart) await this.activate(VIEW_TYPE_SIDEBAR_HUD, "right");
      this.refreshStatusBar();
      // Finish the runs that never got a SessionEnd with the runtime's own reconcile (idle past
      // telemetry.staleAfterMinutes, or a Codex process that exited), the same one both hosts' hooks run.
      // The plugin's old sweep read the hook's pid, which is always dead, and marked every session idle
      // for 5 minutes "crashed" (spec 2026-09-24-no-duplicate-sessions D1). The live watcher drops a run
      // when its file goes. Off when telemetry is disabled: the plugin then writes nothing under agent-runs.
      // AOS_HOST / CLAUDE_PROJECT_DIR blank: an Obsidian started from a session terminal must not look like a hook.
      // It also refreshes the hosts' sign-in, which Sessions follows (local-first A17): so with telemetry off it still runs
      // while provider local has no login recorded for an enabled host (a fresh install), and then writes nothing else.
      // Sessions joins the rail when the answer lands in provider-state.json (WorkbenchView.refreshRailHosts).
      if (this.telemetryOn() || (this.systemConfig().provider === "local" && loginsUnknown(readAgenticosJson(this.claudeConfigDir()), readProviderState(this.vaultRoot())))) {
        this.runBrainScript("brain/scripts/reconcile-sessions.js", [], undefined, { env: { AOS_HOST: "", CLAUDE_PROJECT_DIR: "" }, quiet: true });
      }
      this.startRunsTail();
      this.rebindLiveSources();

      // Keep snapshot.json fresh so the HUD doesn't go stale during a long
      // Obsidian session. Refresh now if already stale, then on a fixed timer.
      void this.refreshSnapshotIfStale();
      this.registerInterval(
        window.setInterval(() => { void this.refreshSnapshot("timer"); }, SNAPSHOT_REFRESH_MS),
      );
    });

    console.log("[agentic-os] loaded");
  }

  async onunload(): Promise<void> {
    if (this.statusBarTimer !== null) window.clearInterval(this.statusBarTimer);
    if (this.runsWatcher) { try { this.runsWatcher.close(); } catch { /* ignore */ } this.runsWatcher = null; }
    if (this.liveRuns) { this.liveRuns.stop(); this.liveRuns = null; }
    this.hb?.stop();
    this.terminalPool?.disposeAll();
    console.log("[agentic-os] unloaded");
  }

  async loadSettings(): Promise<void> {
    const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
    // Field-pick from DEFAULT_SETTINGS's own keys rather than Object.assign-ing
    // raw wholesale: Object.assign({}, DEFAULT_SETTINGS, raw) would copy EVERY
    // own property of raw onto this.settings, including unknown/dead ones —
    // TS interfaces aren't enforced at runtime. Picking only known keys means
    // this.settings structurally cannot carry a stray key forward, which is
    // what actually makes saveData(this.settings) below drop them.
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      merged[key] = Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : defaults[key];
    }
    this.settings = merged as unknown as AgenticOSSettings;

    // One-time prune of dead data.json keys: the pre-P0 paths, and the HUD-only cost/telemetry toggles that the system's
    // own cost.enabled / telemetry.enabled replaced (spec 2026-09-24-settings-tab D10).
    const pruned = DEAD_SETTINGS_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
    if (pruned.length > 0) {
      await this.saveSettings();
      console.info(`[agentic-os] pruned dead settings keys: ${pruned.join(", ")}`);
    }
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  /** A file opened from Files, ⌘O or Quick Look goes to the front of Files' Recents (files-finder D20, D21). */
  rememberFilesOpened(path: string): void {
    this.settings.files = rememberFilesChoice(this.settings.files, { opened: path });
    void this.saveSettings();
  }

  // ── AgenticOS accessors: every read of brain/_index and every spawn goes through these ──

  /** Vault the plugin renders and spawns in: settings.vaultRoot, else this Obsidian vault. */
  /** The open Obsidian vault's own folder: what the status bar reads through the adapter, so it is also what a status
   *  line refresh must rebuild (statusline spec SL-R03), even when the Vault root setting points elsewhere. */
  private obsidianVaultPath(): string {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    return adapter.getBasePath ? adapter.getBasePath() : this.vaultRoot();
  }

  vaultRoot(): string {
    if (this.settings.vaultRoot) return this.settings.vaultRoot;
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    return adapter.getBasePath ? adapter.getBasePath() : env.cwd();
  }

  /**
   * Claude Code config dir: settings → agenticos.json → $CLAUDE_CONFIG_DIR → ~/.claude.
   * The tail delegates to aosConfig.claudeConfigDir() so this method and the data readers can
   * never disagree, and this method is the single source every plugin-side agenticos.json read
   * passes as `configDir` (loadSettings, PulseTab, SystemDrawer, ChatTab, claudeBin) — Ruling A6.
   */
  claudeConfigDir(): string {
    if (this.settings.claudeConfigDir) return this.settings.claudeConfigDir;
    // No argument on purpose: this call is what *resolves* the config dir, so it uses the env chain.
    return readAgenticosJson()?.claudeConfigDir || defaultClaudeConfigDir();
  }

  /** The merged product config (defaults ← brain/config.json ← agenticos.json), read fresh on every call. */
  systemConfig(): VaultConfig { return readVaultConfig(this.vaultRoot(), this.claudeConfigDir()); }
  /** cost.enabled — the COST row, cost Fix Queue cards and COST DETAIL follow the system switch (D10). */
  costOn(): boolean { return this.systemConfig().cost.enabled === true; }
  /** telemetry.enabled — the orphan sweep and agent-runs/live creation follow the system switch (D10). */
  telemetryOn(): boolean { return this.systemConfig().telemetry.enabled !== false; }

  /** Runs the vendored `aos` CLI and waits for it (spec 2026-09-24-settings-tab D3); the Settings tab's only write path. */
  aos(args: string[], timeoutMs?: number): Promise<AosResult> {
    return runAos(args, { node: this.nodeBin(), vault: this.vaultRoot(), configDir: this.claudeConfigDir(), timeoutMs });
  }
  aosJson<T>(args: string[], timeoutMs?: number): Promise<AosJsonResult<T>> {
    return runAosJson<T>(args, { node: this.nodeBin(), vault: this.vaultRoot(), configDir: this.claudeConfigDir(), timeoutMs });
  }
  /** A runtime script under the vault (e.g. brain/scripts/sdk/recall-cli.js), run and waited for like aosJson: its own
   *  surface rule admits it (app/src/shared/surfaces.ts), with the same AOS_VAULT/AOS_CONFIG pins. */
  scriptJson<T>(relScript: string, args: string[], timeoutMs?: number): Promise<AosJsonResult<T>> {
    const vault = this.vaultRoot();
    return runAosJson<T>(args, { node: this.nodeBin(), vault, configDir: this.claudeConfigDir(), timeoutMs, cli: path.join(vault, relScript) });
  }

  /** Node binary for spawns; a login-shell probe result lands in settings and is persisted here. */
  nodeBin(): string {
    const before = this.settings.nodePath;
    const bin = resolveNodeBinary(this.settings);
    if (this.settings.nodePath !== before) void this.saveSettings();
    return bin;
  }

  /**
   * The launch sequence (tour C11): the app's renderer (app/src/renderer/setup/attach.ts) hands over what main knows and
   * its runtime dialog; Go local, What's new or the welcome tour and Getting started follow, one at a time.
   */
  runLaunchSequence(d: Omit<LaunchDeps, "plugin">): Promise<LaunchStep[]> { return runLaunchSequence({ ...d, plugin: this }); }

  /** Sessions follows the hosts (local-first A17): an enabled host is signed in, by the login caches the runtime keeps in
   *  brain/_index/provider-state.json, whatever the background provider (the local engine may be down). */
  chatAvailable(): boolean {
    return signedInHosts(readAgenticosJson(this.claudeConfigDir()), readProviderState(this.vaultRoot())).length > 0;
  }

  /** session-index.json's size and time when it was last read, and whether it named a session History lists. */
  private historyCache: { mtime: number; size: number; has: boolean } | null = null;

  /** Whether Sessions ▸ History has a past session to list (install-import B11): the index the scan keeps names one.
   *  Read again only when the file changed. */
  historyOnDisk(): boolean {
    try {
      const file = path.join(this.vaultRoot(), SESSION_INDEX_PATH);
      const st = fs.statSync(file);
      const c = this.historyCache;
      if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.has;
      const has = hasHistory(fs.readFileSync(file, "utf8"));
      this.historyCache = { mtime: st.mtimeMs, size: st.size, has };
      return has;
    } catch { return false; }
  }

  /** Sessions is on the rail when an enabled host is signed in (local-first A17), or when History has a past session to
   *  show, which needs no host (install-import B11, §5.6): a Mac with no host, or one signed out, still sees its history. */
  sessionsShown(): boolean {
    return this.chatAvailable() || this.historyOnDisk();
  }

  /**
   * claude CLI for the Chat tab's headless calls: agenticos.json `claude.bin` → provider-state
   * bin → ~/.local/bin/claude → PATH. The agenticos.json read is threaded through
   * claudeConfigDir() so the settings override reaches the recorded path (Ruling A6).
   */
  claudeBin(): string {
    const configDir = this.claudeConfigDir();
    return resolveClaudeBin(this.vaultRoot(), { readAgenticosJson: () => readAgenticosJson(configDir) });
  }

  // ── activate any view by type ────────────────────────────────────────

  async activate(viewType: string, where: "tab" | "right" | "split" = "tab"): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType);
    let leaf: WorkspaceLeaf | null = null;
    if (existing.length > 0) {
      leaf = existing[0];
      // An inspector leaf of this type is already open — a fresh pop-out (setPendingMemory/
      // setPendingRunId called just before this activate()) would otherwise be silently
      // dropped, since only the setViewState branches below re-trigger onOpen()'s
      // consumePending*() read. Re-target the existing leaf directly via its own setter
      // instead of tearing it down; every other view type is untouched (instanceof is false).
      const view = leaf.view;
      if (view instanceof MemoryInspectorView) {
        const pending = consumePendingMemory();
        if (pending) await view.setMemoryPath(pending);
      } else if (view instanceof RunInspectorView) {
        const pending = consumePendingRunId();
        if (pending) await view.setRun(pending);
      }
    } else if (where === "right") {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: viewType, active: true });
    } else if (where === "split") {
      leaf = workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: viewType, active: true });
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: viewType, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  // ── Heartbeat / SSE binding ──────────────────────────────────────────

  /** Reconstruct the local live watcher (e.g. after poll-interval setting change). */
  rebindLiveSources(): void {
    if (this.liveRuns) { this.liveRuns.stop(); this.liveRuns = null; }
    this.liveRuns = new LiveRunsWatcher({
      vault: this.vaultRoot(),
      bus: this.bus,
      pollMs: this.settings.liveTailPollMs,
      source: "local",
      createDirs: this.telemetryOn(),
    });
    this.liveRuns.start();
    this.hb.setSource(this.liveRuns);
  }

  // ── Status Bar ───────────────────────────────────────────────────────

  rebuildStatusBar(): void {
    if (this.statusBarEl) { this.statusBarEl.remove(); this.statusBarEl = null; }
    if (this.statusBarTimer !== null) { window.clearInterval(this.statusBarTimer); this.statusBarTimer = null; }
    if (!this.settings.statusBarEnabled) return;
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("aos-statusbar");
    this.statusBarEl.setAttr("aria-label", BRAND.name);
    this.statusBarEl.addEventListener("click", () => { void this.activate(VIEW_TYPE_WORKBENCH); });
    void this.refreshStatusBar();
    this.statusBarTimer = window.setInterval(() => { void this.refreshStatusBar(); }, 30000);
  }

  async refreshStatusBar(): Promise<void> {
    if (!this.statusBarEl) return;
    const [snap, runs, model] = await Promise.all([loadSnapshot(this.app), loadRuns(this.app, 1), loadStatusline(this.app)]);
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    const wrap = this.statusBarEl.createSpan({ cls: "aos-sbar-wrap" });
    const up = this.hb.getStatus().up;
    wrap.createSpan({ text: "⚡", cls: up ? "aos-text-cyan" : "aos-dim" });
    wrap.createSpan({ text: up ? " live" : " idle", cls: up ? "aos-text-cyan" : "aos-dim" });
    if (model) {
      // What needs you, from the runtime's statusline.json (statusline spec §4.4); each segment opens where it is handled.
      const segs = barSegments(model);
      if (!segs.length) wrap.createSpan({ text: " · all clear", cls: "aos-dim" });
      for (const seg of segs) {
        wrap.createSpan({ text: " · " });
        const el = wrap.createSpan({ text: seg.text, cls: STATUS_TONE[seg.tone] });
        el.setAttr("aria-label", seg.title);
        if (!seg.tab && !seg.file) continue;
        el.addClass("aos-sbar-link");
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (seg.tab) void this.openWorkbenchTab(seg.tab);
          else if (seg.file) void this.app.workspace.openLinkText(seg.file, "", false);
        });
      }
    } else if (!snap) {
      wrap.createSpan({ text: " · no snapshot", cls: "aos-text-amber" });
    } else {
      // A runtime that predates the status line model: the inventory it always showed.
      wrap.createSpan({ text: ` · ${snap.capabilities.agents.count}a · ${snap.capabilities.commands.count}c · ${snap.config.memoryMd?.pointers ?? 0}m · ${snap.capabilities.skills.count}s` });
      if (runs[0]) {
        const ok = runs[0].status === "ok";
        wrap.createSpan({ text: " · " });
        wrap.createSpan({ text: `last ${runs[0].script} ${formatRelative(runs[0].started_at)}`, cls: ok ? "aos-text-cyan" : "aos-text-rose" });
      }
    }
    const issues = snap?.health?.issues ?? [];
    const errs = issues.filter(i => i.severity === "error").length;
    const warns = issues.filter(i => i.severity === "warn").length;
    if (errs > 0) wrap.createSpan({ text: ` · ${errs}err`, cls: "aos-text-rose", attr: { "data-tour": "status-bar-health" } });
    else if (warns > 0) wrap.createSpan({ text: ` · ${warns}warn`, cls: "aos-text-amber", attr: { "data-tour": "status-bar-health" } });
    if (statuslineStale(model) && !this.statuslineRefreshing) {
      // D3: a stale or missing model is rebuilt by the runtime in the background, once at a time; the file's modify
      // event repaints the bar. A runtime without statusline.js leaves the flag set, so it is tried once per load.
      this.statuslineRefreshing = true;
      this.runBrainScript("brain/scripts/statusline.js", ["refresh"], () => { this.statuslineRefreshing = false; },
        { quiet: true, env: { AOS_VAULT: this.obsidianVaultPath(), AOS_CONFIG: path.join(this.claudeConfigDir(), "agenticos.json") } });
    }
  }

  // ── Live runs tail (Node fs.watch on absolute path) ──────────────────

  private startRunsTail(): void {
    try {
      const base = this.vaultRoot();
      const abs = path.join(base, RUNS_PATH);
      if (!fs.existsSync(abs)) return;
      this.runsBytesSeen = fs.statSync(abs).size;
      this.runsWatcher = fs.watch(abs, () => {
        try {
          const size = fs.statSync(abs).size;
          if (size > this.runsBytesSeen) {
            this.runsBytesSeen = size;
            void this.refreshStatusBar();
            // Internal fan-out: fs.watch sees the append before Obsidian's indexer does.
            // Subscribers (SidebarHUD, RunsTab) listen for this instead of a synthetic vault event.
            this.bus.trigger("runs-appended");
          }
        } catch { /* ignore */ }
      });
    } catch (err) {
      console.warn("[agentic-os] runs tail unavailable:", err);
    }
  }

  // ── Snapshot auto-refresh ────────────────────────────────────────────

  /** Refresh only if snapshot.json is missing or older than the stale threshold. */
  private async refreshSnapshotIfStale(): Promise<void> {
    try {
      const base = this.vaultRoot();
      const abs = path.join(base, SNAPSHOT_PATH);
      const ageMs = fs.existsSync(abs) ? Date.now() - fs.statSync(abs).mtimeMs : Infinity;
      if (ageMs > SNAPSHOT_STALE_MS) this.refreshSnapshot("stale-on-open");
    } catch {
      this.refreshSnapshot("stale-on-open");
    }
  }

  /** Spawn scan-vault.js detached to regenerate snapshot.json. Quiet, non-blocking. */
  private refreshSnapshot(reason: string): void {
    if (this.snapshotRefreshing) return;
    try {
      const root = this.vaultRoot();
      const script = path.join(root, "brain/scripts/scan-vault.js");
      if (!fs.existsSync(script)) { console.warn(`[agentic-os] scan-vault.js missing at ${script}`); return; }
      this.snapshotRefreshing = true;
      const child = spawn(this.nodeBin(), [script, "--quiet"], {
        cwd: root,
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      child.on("error", (e) => { console.warn("[agentic-os] snapshot refresh failed:", e); this.snapshotRefreshing = false; });
      child.on("close", () => { this.snapshotRefreshing = false; });
      // Safety: clear the in-flight flag even if the process never reports back.
      window.setTimeout(() => { this.snapshotRefreshing = false; }, 60_000);
      console.log(`[agentic-os] snapshot refresh (${reason})`);
    } catch (e) {
      this.snapshotRefreshing = false;
      console.warn("[agentic-os] snapshot refresh error:", e);
    }
  }

  /** Spawn the regen CLI for one workspace; snapshot.json modify triggers the view to refresh. */
  regenWorkspaceInsight(name: string): void {
    try {
      const root = this.vaultRoot();
      const script = path.join(root, "brain/scripts/regen-workspace-insight.js");
      if (!fs.existsSync(script)) { new Notice("regen script missing"); return; }
      const child = spawn(this.nodeBin(), [script, name], { cwd: root, stdio: "ignore", detached: true });
      child.unref();
      child.on("error", (e) => { console.warn("[agentic-os] regen failed:", e); });
    } catch (e) {
      console.warn("[agentic-os] regen error:", e);
    }
  }

  /** Spawn a brain script detached (Fix Queue / Pulse actions). Best-effort;
   *  UI feedback comes from the pipelines ledger, not the exit code. opts.quiet: no notices (background work
   *  on load; a vault with no runtime yet stays silent), the console only. */
  runBrainScript(relScript: string, args: string[] = [], onDone?: () => void, opts: { env?: Record<string, string>; quiet?: boolean } = {}): void {
    try {
      const base = this.vaultRoot();
      const script = path.join(base, relScript);
      if (!fs.existsSync(script)) {
        if (opts.quiet) console.warn(`[agentic-os] script missing: ${relScript}`); else new Notice(`script missing: ${relScript}`);
        // onDone still runs, as after a run that failed: a caller holding a "running" flag (the Brain tab's hub rebuild,
        // the status line refresh) must not wait for a close that never comes.
        if (onDone) window.setTimeout(onDone, 0);
        return;
      }
      // opts.env: the Routines tab pins AOS_VAULT/AOS_CONFIG so the runtime resolves the same vault and config dir the HUD shows.
      const child = spawn(this.nodeBin(), [script, ...args], { cwd: base, stdio: "ignore", detached: true, env: opts.env });
      child.unref();
      child.on("error", (e) => {
        console.warn("[agentic-os] runBrainScript failed:", e);
        if (!opts.quiet) new Notice(`spawn failed: ${relScript}`);
      });
      if (onDone) child.on("close", onDone);
      if (!opts.quiet) new Notice(`▶ ${relScript.split("/").pop()} ${args.join(" ")}`.trim());
    } catch (e) {
      console.warn("[agentic-os] runBrainScript error:", e);
      if (onDone) window.setTimeout(onDone, 0);
    }
  }

  /** Runs a Term launch against the Workbench view (opening it first), and says why when it cannot. */
  async termCommand(run: (view: WorkbenchView) => Promise<void>): Promise<void> {
    await this.activate(VIEW_TYPE_WORKBENCH);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
    if (leaf && typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
    const view = leaf?.view;
    if (!(view instanceof WorkbenchView)) return;
    try { await run(view); } catch (e) { new Notice(`Terminal: ${e instanceof Error ? e.message : String(e)}`); }
  }

  /** A link into the Workbench (statusline spec D10, spaces-redesign D12). The workspace must be a name in the
   *  snapshot, so the snapshot is read only when the link names one. It only selects: never a resume, a terminal, a
   *  draft or a verb. */
  private async openLink(params: Record<string, string | undefined>): Promise<void> {
    const tab = workbenchTabFrom(params, WORKBENCH_TAB_IDS);
    if (!tab) { await this.activate(VIEW_TYPE_WORKBENCH); return; }
    let names: string[] = [];
    if (tab === "spaces" && params.workspace) {
      try { names = ((await loadSnapshot(this.app))?.workspaces ?? []).map((w) => w.name).filter((n): n is string => typeof n === "string"); } catch { /* no snapshot: no workspace */ }
    }
    const link = workbenchLinkFrom(params, WORKBENCH_TAB_IDS, names) ?? { tab };
    if (!(await this.openWorkbench(link))) await this.openWorkbenchTab(tab);
  }

  /** Opens the Workbench on `target` through WorkbenchView.open (spaces-redesign D12): the tab, then what it selects.
   *  False when the view is not there or the tab cannot be shown. */
  async openWorkbench(target: WorkbenchTarget): Promise<boolean> {
    await this.activate(VIEW_TYPE_WORKBENCH);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
    if (leaf && typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
    const view = leaf?.view;
    return view instanceof WorkbenchView ? view.open(target) : false;
  }

  async openWorkbenchTab(tab: string): Promise<void> {
    await this.activate(VIEW_TYPE_WORKBENCH);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
    // A leaf restored from the saved layout stays deferred until shown, and its view is not a WorkbenchView yet: load it
    // so the switch lands (loadIfDeferred is Obsidian 1.7.2+; older builds never defer).
    if (leaf && typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
    const view = leaf?.view;
    if (view instanceof WorkbenchView) view.setTab(tab);
  }

  /** Live FilesTab instance, if the Workbench view is open (as currentRunsTab). */
  private currentFilesTab(): FilesTab | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
    const view = leaf?.view;
    return view instanceof WorkbenchView ? (view.getTab("files") as FilesTab | null) : null;
  }

  /** Live RunsTab instance, if the Workbench view is currently open — same
   *  getLeavesOfType + instanceof pattern as the "new-terminal" command above. */
  private currentRunsTab(): RunsTab | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
    const view = leaf?.view;
    return view instanceof WorkbenchView ? (view.getTab("runs") as RunsTab | null) : null;
  }

  // ── ⌘K omnisearch (Task 7) ────────────────────────────────────────────

  /**
   * Gathers every async source BEFORE opening the modal (OmniModal.getItems()
   * is synchronous per the brief — no async happens inside the modal itself),
   * builds the flat item list via buildOmniItems(), then opens OmniModal with
   * a dispatch callback for the three kinds it can't resolve with `app` alone
   * (run/agent/action — each needs plugin state: openWorkbenchTab, RunsTab,
   * FixAction/deck execution).
   */
  async openOmni(): Promise<void> {
    const app = this.app;
    const snap = await loadSnapshot(app);
    // Same workspace-name source P2 uses everywhere else (PulseTab.refresh(),
    // SpacesTab, and the old Workspaces view all read snapshot.workspaces, never settings) —
    // loadAllMaps() itself tolerates a missing/null map per name. Hidden entries stay out (spaces-redesign D22).
    const wsNames = visibleWorkspaces(snap?.workspaces).map((w) => w.name);

    const [maps, memories, runs, staff, inv] = await Promise.all([
      loadAllMaps(app, wsNames),
      listMemories(app),
      loadRuns(app),
      loadStaff(app),
      loadInventory(app),
    ]);

    // InventorySkill.path is the skill's directory ("skills/<dir>"), not its
    // SKILL.md file — SystemDrawer.openInventoryFile appends "/SKILL.md" before
    // opening it. Mirrored here so the omni item's payload is directly openable
    // via workspace.openLinkText.
    const skills = (inv?.skills ?? []).map((s) => ({
      name: s.name,
      path: s.path ? `${s.path}/SKILL.md` : `skills/${s.name}/SKILL.md`,
    }));

    // Fix-queue actions come from the live PulseTab instance when the Workbench
    // has constructed one; before that (no Workbench open yet) there is no queue
    // to search. Deck commands are a static export and always gathered.
    const wbView = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0]?.view;
    const pulse = wbView instanceof WorkbenchView ? (wbView.getTab("pulse") as PulseTab | null) : null;
    const fixActions: FixAction[] = pulse?.getFixActions() ?? [];
    const deckActions = COMMAND_REGISTRY.map((c) => ({ id: c.name, title: `${c.name} — ${c.desc}` }));

    const items = buildOmniItems({
      maps,
      memories,
      runs: runs.map((r) => ({ id: r.id, label: r.script })),
      agents: staff.map((a) => ({ name: a.name })),
      skills,
      actions: [...fixActions.map((a) => ({ id: a.id, title: a.title })), ...deckActions],
    });

    new OmniModal(app, items, (item) => {
      if (item.kind === "run") {
        void this.openWorkbenchTab("runs").then(() => { void this.currentRunsTab()?.showRun(item.payload); });
      } else if (item.kind === "agent") {
        void this.openWorkbenchTab("runs").then(() => { this.currentRunsTab()?.showAgents(); });
      } else if (item.kind === "action") {
        const fa = fixActions.find((a) => a.id === item.payload);
        if (fa) {
          pulse?.execute(fa);
          return;
        }
        const cmd = COMMAND_REGISTRY.find((c) => c.name === item.payload);
        if (cmd) void executeCommand(this.app, cmd);
      }
    }).open();
  }
}
