// Attach mode (phase 5, I5): an existing install opens straight into the Workbench. What opens on its own at launch is
// the HUD's launch sequence (tour C11, hud/src/ui/launchSequence.ts), one dialog at a time: this app's
// runtime update when the vault's runtime is older than the one the app carries (the dialog below, which runs
// `aos upgrade` from it with its output shown), then Go local and Import while that upgrade left them pending, then the
// welcome tour (a vault the wizard just installed) or What's new, then Getting started. The runtime update is never run
// on its own: an upgrade re-renders the routine schedules and refreshes both plugins, so the user picks the moment; the
// status bar item offers it again. The app's own update sits beside it (Restart to Update).

import { Modal, type App } from "obsidian";
import type AgenticOSPlugin from "@workbench/hud";
import type { AosBridge, AttachInfo, UpdateState } from "../../shared/ipc";
import { JobTerminal } from "./jobTerminal";

class RuntimeModal extends Modal {
  private term: JobTerminal | null = null;
  private off: (() => void) | null = null;

  constructor(app: App, private readonly aos: AosBridge, private readonly info: AttachInfo, private readonly updated: () => void, private readonly closed?: () => void) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("aos-attach-modal", "aos-runtime-modal");
    this.titleEl.setText("Update the runtime in your vault");
    this.contentEl.createEl("p", {
      text: `Your vault's runtime is ${this.info.runtimeVersion ?? "(unknown)"}; this app carries ${this.info.payloadVersion}. Updating re-vendors brain/scripts, refreshes the Claude Code and Codex plugins and re-renders your routine schedules. Notes, memory and persona are not touched.`,
    });
    const status = this.contentEl.createDiv({ cls: "aos-setup-status" });
    const foot = this.contentEl.createDiv({ cls: "aos-setup-foot" });
    foot.createDiv({ cls: "aos-setup-spacer" });
    const later = foot.createEl("button", { text: "Later" });
    later.addEventListener("click", () => this.close());
    const go = foot.createEl("button", { text: "Update now", cls: "mod-cta aos-runtime-go" });
    go.addEventListener("click", () => {
      this.term ??= new JobTerminal(this.contentEl, { rows: 14 });
      this.term.clear();
      const r = this.aos.setup.upgrade();
      if (!r.ok) { status.setText(r.error); status.addClass("is-warn"); return; }
      go.disabled = true;
      later.setText("Close");
      later.disabled = true;
      status.removeClass("is-warn");
      status.setText("Running aos upgrade…");
    });
    this.off = this.aos.setup.onEvent((ev) => {
      if (ev.job !== "upgrade" || ev.type === "progress") return;
      if (ev.type === "data") { this.term?.write(ev.data); return; }
      later.disabled = false;
      if (ev.code === 0) {
        status.setText(`Updated to ${this.info.payloadVersion}.`);
        this.updated();
      } else {
        status.addClass("is-warn");
        status.setText(`aos upgrade stopped (exit ${ev.code ?? ev.signal ?? "?"}). The output above says why.`);
        go.disabled = false;
        go.setText("Try again");
      }
    });
  }

  onClose(): void { this.off?.(); this.term?.dispose(); this.closed?.(); }
}

/** The status bar's update item: hidden, downloading, or Restart to Update. */
function updateItem(statusBarEl: HTMLElement, aos: AosBridge): void {
  const el = statusBarEl.createDiv({ cls: "status-bar-item aos-host-update is-hidden" });
  const render = (s: UpdateState): void => {
    el.toggleClass("is-hidden", s.status !== "downloaded" && s.status !== "downloading");
    el.toggleClass("is-ready", s.status === "downloaded");
    el.setText(s.status === "downloaded" ? `⬆ Restart to update${s.version ? ` to ${s.version}` : ""}` : `Downloading ${s.version ?? "update"}${s.percent ? ` ${s.percent}%` : ""}`);
    el.setAttr("title", s.status === "downloaded" ? "Quits the app and opens the new version" : "The update installs when you quit, or when you choose Restart to update");
  };
  el.addEventListener("click", () => { if (el.hasClass("is-ready")) aos.update.install(); });
  aos.update.onState(render);
  render(aos.update.state());
}

/**
 * The status bar's update items, then the launch sequence (tour C11), which this hands what main knows and the runtime
 * dialog. Returns the steps the sequence showed, in order, as they start (the e2e suite reads it on aosHost.launchLog).
 */
export function attachUi(app: App, plugin: AgenticOSPlugin, aos: AosBridge, info: AttachInfo | null, statusBarEl: HTMLElement): string[] {
  const log: string[] = [];
  updateItem(statusBarEl, aos);
  if (!info) return log;
  let runtimeEl: HTMLElement | null = null;
  const openRuntime = (then?: () => void): void => new RuntimeModal(app, aos, info, () => runtimeEl?.addClass("is-hidden"), then).open();
  if (info.behind) {
    runtimeEl = statusBarEl.createDiv({ cls: "status-bar-item aos-host-runtime", text: `⬆ Runtime ${info.runtimeVersion ?? "?"} → ${info.payloadVersion}` });
    runtimeEl.setAttr("title", "The runtime in your vault is older than this app's: update it");
    runtimeEl.addEventListener("click", () => openRuntime());
  }
  void plugin.runLaunchSequence({
    info,
    runtime: (then) => openRuntime(then),
    noted: () => aos.setup.noted(),
    log: (s) => log.push(s),
  }).catch((err: unknown) => console.warn("[host] launch sequence stopped", err));
  return log;
}
