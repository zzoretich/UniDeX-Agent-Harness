// The app's own updates (phase 5, I6): electron-updater against this repo's GitHub Releases, which `npm run release:app`
// fills (latest-mac.yml beside the DMG and the zip Squirrel installs from). Only a packaged release build updates
// itself: a dev run has nothing to replace and the smoke build is ad-hoc signed, which Squirrel refuses. The runtime's
// own switch turns it off too (`updates.check: false` in brain/config.json or agenticos.json, the same keys
// `aos update-check` reads), as does $AOS_APP_NO_UPDATES=1. An update downloads in the background and installs when the
// app quits, or at once from Restart to Update. The runtime in the vault is not touched: attach mode offers that next.

import * as fs from "node:fs";
import * as path from "node:path";
import type { UpdateState } from "../shared/ipc";

/** The slice of electron-updater's AppUpdater this uses (the tests pass a fake). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdatesConfig { check: boolean; intervalHours: number }

const DEFAULT_INTERVAL_HOURS = 24;

function readJson(file: string): Record<string, unknown> | null {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")) as unknown; return j && typeof j === "object" ? j as Record<string, unknown> : null; } catch { return null; }
}

/** brain/config.json, then agenticos.json key by key (cli/update-check.js updatesConfig, the same precedence). */
export function updatesConfig(vault: string | null, agenticosFile: string): UpdatesConfig {
  const out: UpdatesConfig = { check: true, intervalHours: DEFAULT_INTERVAL_HOURS };
  const apply = (u: unknown): void => {
    if (!u || typeof u !== "object") return;
    const o = u as { check?: unknown; intervalHours?: unknown };
    if (typeof o.check === "boolean") out.check = o.check;
    if (typeof o.intervalHours === "number" && Number.isFinite(o.intervalHours) && o.intervalHours > 0) out.intervalHours = o.intervalHours;
  };
  if (vault) apply(readJson(path.join(vault, "brain", "config.json"))?.updates);
  apply(readJson(agenticosFile)?.updates);
  return out;
}

/** Whether this run updates itself, and if not, why. */
export function updatesWanted(o: { packaged: boolean; testBuild: boolean; env: NodeJS.ProcessEnv; config: UpdatesConfig }): { on: boolean; reason: string | null } {
  if (!o.packaged) return { on: false, reason: "a development run" };
  if (o.testBuild) return { on: false, reason: "the smoke build" };
  if (o.env.AOS_APP_NO_UPDATES === "1") return { on: false, reason: "AOS_APP_NO_UPDATES=1" };
  if (!o.config.check) return { on: false, reason: "updates.check is off" };
  return { on: true, reason: null };
}

export interface UpdateServiceOptions {
  on: boolean;
  reason: string | null;
  intervalHours: number;
  load: () => UpdaterLike;
  emit: (s: UpdateState) => void;
  /** How long after launch the first check runs. */
  firstCheckMs?: number;
  /**
   * Runs just before Restart to Update hands over to quitAndInstall. Electron closes every window first and emits
   * `before-quit` only after that (electron.d.ts, `before-quit`), so a window that hides instead of closing until the app
   * is quitting must be told here, or the quit stops at the first window and the installer waits for an app that never
   * exits.
   */
  beforeInstall?: () => void;
  /**
   * Runs after beforeInstall: what must end while the app still runs JavaScript (its terminals, R86), as a promise that
   * resolves once it has, or null when nothing runs. quitAndInstall waits for it, so the update's quit finds nothing
   * left to wait for.
   */
  settle?: () => Promise<void> | null;
}

export class UpdateService {
  private updater: UpdaterLike | null = null;
  private timers: NodeJS.Timeout[] = [];
  private s: UpdateState;
  /** Restart to Update waits for `settle`: a second ask meanwhile installs once. */
  private installing = false;

  constructor(private readonly o: UpdateServiceOptions) {
    this.s = { status: o.on ? "idle" : "off", reason: o.reason, version: null, percent: null, error: null };
  }

  get state(): UpdateState { return { ...this.s }; }

  /** Sets the state and tells the page and the menu (tests reach it through __aosMain too). */
  set(next: Partial<UpdateState>): void {
    this.s = { ...this.s, ...next };
    this.o.emit(this.state);
  }

  start(): void {
    if (!this.o.on) return;
    try {
      const u = this.o.load();
      u.autoDownload = true;
      u.autoInstallOnAppQuit = true;
      u.allowPrerelease = false;
      u.logger = null;
      u.on("checking-for-update", () => this.set({ status: "checking", error: null }));
      u.on("update-available", (info) => this.set({ status: "available", version: versionOf(info), percent: 0 }));
      u.on("update-not-available", () => this.set({ status: "none", percent: null }));
      u.on("download-progress", (p) => this.set({ status: "downloading", percent: Math.round(Number((p as { percent?: number }).percent ?? 0)) }));
      u.on("update-downloaded", (info) => this.set({ status: "downloaded", version: versionOf(info) ?? this.s.version, percent: 100 }));
      // A release without the app's files yet (release.yml publishes before release:app uploads), or no network: say
      // so in the state, quietly. The next check tries again.
      u.on("error", (err) => {
        this.set({ status: "error", error: shortError(err), percent: null });
        console.warn(`[updater] ${shortError(err)}`);
      });
      this.updater = u;
    } catch (err) {
      this.set({ status: "off", reason: `the updater did not load: ${shortError(err)}` });
      return;
    }
    this.timers.push(setTimeout(() => this.check(), this.o.firstCheckMs ?? 30_000));
    const every = Math.max(1, this.o.intervalHours) * 3600_000;
    this.timers.push(setInterval(() => this.check(), every));
  }

  check(): void {
    const u = this.updater;
    if (!u || this.s.status === "checking" || this.s.status === "downloading" || this.s.status === "downloaded") return;
    u.checkForUpdates().catch((err: unknown) => this.set({ status: "error", error: shortError(err) }));
  }

  /** Restart to Update: only with an update downloaded. With something to settle first, quitAndInstall follows it. */
  install(): boolean {
    const u = this.updater;
    if (!u || this.s.status !== "downloaded") return false;
    if (this.installing) return true;
    this.o.beforeInstall?.();
    const pending = this.o.settle?.() ?? null;
    if (!pending) { u.quitAndInstall(false, true); return true; }
    this.installing = true;
    void pending.catch(() => undefined).then(() => { this.installing = false; u.quitAndInstall(false, true); });
    return true;
  }

  stop(): void { for (const t of this.timers) clearTimeout(t); this.timers = []; }
}

function versionOf(info: unknown): string | null {
  const v = (info as { version?: unknown } | null)?.version;
  return typeof v === "string" ? v : null;
}

function shortError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split("\n")[0].slice(0, 200);
}
