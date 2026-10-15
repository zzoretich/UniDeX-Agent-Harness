// Attach mode (phase 5, I5): an existing install opens straight into the Workbench. Once per vault the app shows its
// first-launch UI: the welcome tour for a vault its wizard just installed, the "What changed" note for one that existed
// before (tour C10); when the vault's runtime is older than the one the app carries, a status bar item and a dialog
// offer `aos upgrade` from it, with its output shown. Never on their own: an upgrade re-renders the routine schedules
// and refreshes both plugins, so the user picks the moment. The app's own update sits beside them (Restart to Update).

import { Modal, type App } from "obsidian";
import { TOUR_COMMANDS, type AosBridge, type AttachInfo, type UpdateState } from "../../shared/ipc";
import { BRAND } from "../../shared/brand";
import { JobTerminal } from "./jobTerminal";

const CHANGES = [
  "The Workbench is this app. Obsidian is no longer needed; your vault is still plain Markdown, so any editor opens it.",
  "Notes open here: the Files tab (⌘O to open a file, ⌘⇧F to search) and the note editor.",
  "Links from the status line and proposal pages open here (agenticos://).",
  "The app updates itself from GitHub Releases, and offers to update the runtime in your vault when it carries a newer one.",
];

class WhatChangedModal extends Modal {
  constructor(app: App, private readonly done: () => void) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("aos-attach-modal");
    this.titleEl.setText(`${BRAND.name} is an app now`);
    const ul = this.contentEl.createEl("ul", { cls: "aos-attach-list" });
    for (const c of CHANGES) ul.createEl("li", { text: c });
    const foot = this.contentEl.createDiv({ cls: "aos-setup-foot" });
    foot.createDiv({ cls: "aos-setup-spacer" });
    const ok = foot.createEl("button", { text: "Got it", cls: "mod-cta aos-attach-ok" });
    ok.addEventListener("click", () => this.close());
  }

  onClose(): void { this.done(); }
}

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
 * What the app opens on its own at launch, one at a time. THE SEAM for the launch sequence (tour C11): PR 9 replaces
 * this one function (and WhatChangedModal with it) by `launchSequence`, which owns every first-launch dialog in order.
 * Until then: a vault this app's wizard installed starts the welcome tour (after the runtime update when there is one;
 * it ends on Getting started), and is recorded as noted at once; an existing vault opened for the first time gets the
 * "What changed" note, then the runtime update; any later launch only the runtime update, when the vault's is behind.
 */
export function firstLaunch(app: App, aos: AosBridge, info: AttachInfo, openRuntime: (then?: () => void) => void): void {
  const tour = (): void => { app.commands.executeCommandById(TOUR_COMMANDS.start); };
  if (info.firstTime && info.installed) {
    aos.setup.noted();
    if (info.behind) openRuntime(tour);
    else tour();
    return;
  }
  // The note first, once per vault; the runtime dialog after it (once per launch).
  if (info.firstTime) new WhatChangedModal(app, () => { aos.setup.noted(); if (info.behind) openRuntime(); }).open();
  else if (info.behind) openRuntime();
}

export function attachUi(app: App, aos: AosBridge, info: AttachInfo | null, statusBarEl: HTMLElement): void {
  updateItem(statusBarEl, aos);
  if (!info) return;
  let runtimeEl: HTMLElement | null = null;
  const openRuntime = (then?: () => void): void => new RuntimeModal(app, aos, info, () => runtimeEl?.addClass("is-hidden"), then).open();
  if (info.behind) {
    runtimeEl = statusBarEl.createDiv({ cls: "status-bar-item aos-host-runtime", text: `⬆ Runtime ${info.runtimeVersion ?? "?"} → ${info.payloadVersion}` });
    runtimeEl.setAttr("title", "The runtime in your vault is older than this app's: update it");
    runtimeEl.addEventListener("click", () => openRuntime());
  }
  firstLaunch(app, aos, info, openRuntime);
}
