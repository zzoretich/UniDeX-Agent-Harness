// The launch sequence (spec 2026-10-14-guided-tour-design C11): every dialog the app opens on its own at launch, one at
// a time, in order, each remembered so it never opens on its own again:
//   1. the runtime upgrade, when the vault's runtime is behind the app's (the app's own dialog, attach.ts RuntimeModal;
//      offered at every launch while it is behind, as before)
//   2. Go local (local-first A9): the Go-local card, while `aos upgrade` left local-first pending
//   3. Import (install-import B12): the Import sheet — PR 9's second stage plugs it in at IMPORT below
//   4. the welcome: the core tour on a new install (the wizard installed it, first launch), else What's new (C2, C10)
//   5. Getting started, the checklist (the core tour opens it itself at its end)
// The app's renderer hands off to it from attach.ts with what main knows (firstTime, installed, behind) and the runtime
// step; the rest is the HUD's: the migration state the runtime keeps (brain/_index/migrations.json) and the tour's
// memory in the HUD settings (tour.launched, lastSeenVersion); tour/launch.ts decides what is due. A vault's cards are
// remembered per vault, and only once the user acted on one or dismissed it (closing the app with it open asks again).
// The e2e harness pre-marks tour.launched the way it pre-marks the "noted" vault, so other specs never meet a dialog.
import { Modal } from "obsidian";
import type AgenticOSPlugin from "../../main";
import { readMigrations } from "../data/goLocal";
import { goLocalDue, goLocalId, importDue, welcomeStep, whatsNewId, type LaunchInfo, type LaunchStep, type Welcome } from "../tour/launch";
import { boldRuns, fillText, type TourContext } from "../tour/predicates";
import { VIEW_TYPE_WORKBENCH, WorkbenchView } from "../views/WorkbenchView";
import { GoLocalCard } from "./GoLocalCard";
import { dialogId } from "./spaces/SpaceDialogs";

export type { LaunchInfo, LaunchStep } from "../tour/launch";

export interface LaunchDeps {
  plugin: AgenticOSPlugin;
  info: LaunchInfo;
  /** The runtime upgrade dialog (the app's); `then` runs once it closes, whatever the user chose. */
  runtime?: (then: () => void) => void;
  /** Records this vault as opened (main's attach.json), so firstTime is false from the next launch. */
  noted?: () => void;
  /** Each step as it starts (tests read it on aosHost.launchLog). */
  log?: (step: LaunchStep) => void;
}

/** Runs the sequence; resolves with the steps it showed once the last dialog closed. */
export async function runLaunchSequence(d: LaunchDeps): Promise<LaunchStep[]> {
  const ran: LaunchStep[] = [];
  const show = (s: LaunchStep): void => { ran.push(s); d.log?.(s); };
  const { plugin, info } = d;
  const tour = plugin.tour;
  if (info.firstTime) d.noted?.();

  // 1. The runtime: Go local and Import read what `aos upgrade` records, so they wait for it.
  if (info.behind && d.runtime) {
    show("runtime");
    await new Promise<void>((resolve) => d.runtime!(resolve));
  }

  // 2. Go local: remembered for this vault once acted on or dismissed.
  const vault = plugin.vaultRoot();
  const migrations = readMigrations(vault);
  if (goLocalDue(migrations, tour.state(), vault)) {
    show("go-local");
    await GoLocalCard.ask(plugin, { runInTerm: (cmd) => workbench(plugin)?.runInTerm(cmd, { origin: "Go local" }) });
    tour.rememberLaunch(goLocalId(vault));
  }

  // 3. IMPORT (PR 9b): the Import sheet goes here, between Go local and the welcome, remembered as importId(vault).
  if (importDue(migrations, tour.state(), vault)) show("import");

  // 4. The welcome, then 5. Getting started.
  const welcome = welcomeStep(info, tour.state(), plugin.manifest.version);
  if (!welcome) return ran;
  // The welcome tour opens Getting started itself when it ends (unless something else stopped it).
  const core = async (): Promise<LaunchStep[]> => {
    show("core-tour");
    const how = await new Promise<string>((resolve) => tour.startCore((end) => resolve(end)));
    if (how !== "stopped") show("checklist");
    return ran;
  };
  if (welcome.kind === "core") return core();
  show("whats-new");
  tour.rememberLaunch(whatsNewId(plugin.manifest.version));
  tour.markSeenNow();
  const choice = await WhatsNewCard.ask(plugin, welcome, tour.context());
  if (choice.kind === "tour") return core();
  if (choice.kind === "show-me") await new Promise<void>((resolve) => tour.showMe(choice.steps, () => resolve()));
  show("checklist");
  tour.openChecklistIfShown();
  return ran;
}

function workbench(plugin: AgenticOSPlugin): WorkbenchView | null {
  const v = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0]?.view;
  return v instanceof WorkbenchView ? v : null;
}

type WhatsNewChoice = { kind: "done" } | { kind: "tour" } | { kind: "show-me"; steps: string[] };

/** What's new in x.y as a card at launch (C2): each change with its Show me; an install new to the tour gets the tour. */
export class WhatsNewCard extends Modal {
  private choice: WhatsNewChoice = { kind: "done" };

  constructor(plugin: AgenticOSPlugin, private readonly card: Extract<Welcome, { kind: "whats-new" }>, private readonly ctx: TourContext, private readonly done: (c: WhatsNewChoice) => void) {
    super(plugin.app);
  }

  static ask(plugin: AgenticOSPlugin, card: Extract<Welcome, { kind: "whats-new" }>, ctx: TourContext): Promise<WhatsNewChoice> {
    return new Promise((resolve) => new WhatsNewCard(plugin, card, ctx, resolve).open());
  }

  onOpen(): void {
    const id = dialogId("whatsnew-title");
    this.modalEl.addClass("aos-whatsnew-modal");
    this.modalEl.setAttr("role", "dialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.modalEl.setAttr("aria-labelledby", id);
    this.titleEl.setText(`What's new in ${this.card.line}`);
    this.titleEl.id = id;
    const c = this.contentEl;
    c.addClass("aos-whatsnew-card");
    if (this.card.firstTime) {
      c.createEl("p", { cls: "aos-whatsnew-intro", text: "The Workbench has a guided tour now: ten stops around the app, ending at a Getting started checklist. Every tab also offers its own tour the first time you open it, and Help at the rail's foot has them all." });
    }
    const list = c.createDiv({ cls: "aos-whatsnew-list" });
    for (const r of this.card.releases) {
      if (this.card.releases.length > 1) list.createDiv({ cls: "aos-whatsnew-version", text: r.version });
      for (const e of r.entries) {
        const row = list.createDiv({ cls: "aos-whatsnew-entry", attr: { "data-entry": e.id } });
        const text = row.createDiv({ cls: "aos-whatsnew-text" });
        text.createDiv({ cls: "aos-whatsnew-title", text: fillText(e.title, this.ctx) });
        const body = text.createDiv({ cls: "aos-whatsnew-body" });
        for (const run of boldRuns(fillText(e.body, this.ctx))) {
          if (run.bold) body.createEl("strong", { text: run.text });
          else body.appendText(run.text);
        }
        if (e.steps.length) {
          const b = row.createEl("button", { cls: "aos-whatsnew-show", text: "Show me", attr: { type: "button" } });
          b.addEventListener("click", () => { this.choice = { kind: "show-me", steps: [...e.steps] }; this.close(); });
        }
      }
    }
    const foot = c.createDiv({ cls: "aos-whatsnew-foot" });
    foot.createDiv({ cls: "aos-whatsnew-note", text: "Help ▸ What's new keeps this list." });
    foot.createDiv({ cls: "aos-whatsnew-spacer" });
    if (this.card.firstTime) {
      const t = foot.createEl("button", { cls: "aos-whatsnew-tour", text: "Take the full tour", attr: { type: "button" } });
      t.addEventListener("click", () => { this.choice = { kind: "tour" }; this.close(); });
    }
    const ok = foot.createEl("button", { cls: "mod-cta aos-whatsnew-ok", text: "Got it", attr: { type: "button" } });
    ok.addEventListener("click", () => this.close());
    ok.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.done(this.choice);
  }
}
