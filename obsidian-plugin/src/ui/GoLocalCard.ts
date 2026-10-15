// The Go-local card (spec 2026-10-14-local-first A9; guided-tour C11): asked once of an install from before 2.0 by the
// launch sequence (ui/launchSequence.ts), and from Settings ▸ Local engine whenever background work is not local. It
// says what moves to this Mac and what stays hosted, what background work spent in the last 7 days (the ledger), offers
// the model download when the model is missing (the `local` surface's `aos local pull`), and a checked "Move the Chief of
// Staff to Opus 5.5 / gpt-6-sol" worded for this Mac's hosts. Go local runs `aos migrate local-first --apply [--chief]`
// and Keep my settings `--decline`, both through the `migrate` surface; the runtime backs everything up first, and
// Settings can undo it. While that surface is off (its default until a live check), the card shows the exact commands
// up front, each with a ❯_ that runs it in the Code tab, instead of buttons the app would refuse; the same for the
// model download and the `local` surface.
import { Modal, Notice, canRun } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import { fs } from "../host";
import { readAgenticosJson, readProviderState, readVaultConfig, sessionHosts } from "../data/aosConfig";
import { failureText } from "../data/aosRun";
import { localEngineView, readLocalFiles } from "../data/localEngine";
import { MOVES_LOCAL, SPEND_PATH, backgroundSpend, chiefChoice, migrateArgs, migrateCommand, spendText, staysHosted } from "../data/goLocal";
import { dialogId } from "./spaces/SpaceDialogs";

/** applied or declined here; `terminal` when a command was handed to the Code tab; `later` when closed without acting. */
export type GoLocalResult = "applied" | "declined" | "terminal" | "later";

/** Whether an enabled surface runs this `aos` argv (compat's page policy; display only, main checks the spawn). */
function surfaceRuns(args: string[]): boolean {
  try { return canRun("cli/aos.js", args); } catch { return false; }
}

export interface GoLocalOptions {
  /** Runs a command in a Code terminal (WorkbenchView.runInTerm); the card's fallback while a surface is off. */
  runInTerm?: (command: string) => void;
  now?: Date;
}

export class GoLocalCard extends Modal {
  private result: GoLocalResult = "later";
  private busy = false;
  private statusEl: HTMLElement | null = null;
  private buttons: HTMLButtonElement[] = [];

  constructor(private readonly plugin: AgenticOSPlugin, private readonly done: (r: GoLocalResult) => void = () => {}, private readonly o: GoLocalOptions = {}) {
    super(plugin.app);
  }

  /** Opens the card; resolves with what the user chose once it closes. */
  static ask(plugin: AgenticOSPlugin, o: GoLocalOptions = {}): Promise<GoLocalResult> {
    return new Promise((resolve) => new GoLocalCard(plugin, resolve, o).open());
  }

  onOpen(): void {
    const now = this.o.now ?? new Date();
    const vault = this.plugin.vaultRoot();
    const configDir = this.plugin.claudeConfigDir();
    const hosts = sessionHosts(readAgenticosJson(configDir));
    const cfg = readVaultConfig(vault, configDir);
    const files = readLocalFiles(vault, now);
    // As the engine would look once background work runs on it: the provider's resolved model and reason count only when
    // it is the local engine's (under auto with Claude answering, `model` names a hosted one); its engine cache always.
    const ps = readProviderState(vault);
    const local = ps && ps.name !== "ollama" ? { ...ps, model: undefined, localReason: undefined } : ps;
    const engine = localEngineView({ ...cfg, provider: "local" }, local, files.today, files.queued);
    let ledger: string | null = null;
    try { ledger = fs.readFileSync(path.join(vault, SPEND_PATH), "utf8"); } catch { ledger = null; }

    const ids = { title: dialogId("golocal-title"), body: dialogId("golocal-body") };
    this.modalEl.addClass("aos-golocal-modal");
    this.modalEl.setAttr("role", "dialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.modalEl.setAttr("aria-labelledby", ids.title);
    this.modalEl.setAttr("aria-describedby", ids.body);
    this.titleEl.setText("Run background work on this Mac");
    this.titleEl.id = ids.title;
    const c = this.contentEl;
    c.addClass("aos-golocal");
    c.createEl("p", {
      cls: "aos-golocal-intro",
      text: `Background work can now run on a model on this Mac instead of ${cfg.provider === "none" ? "heuristics" : "Claude Code or Codex"}: it never spends, and nothing leaves the Mac. Your settings are backed up first, and Settings ▸ Local engine can undo it.`,
      attr: { id: ids.body },
    });
    const cols = c.createDiv({ cls: "aos-golocal-cols" });
    const col = (title: string, items: readonly string[], key: string): void => {
      const box = cols.createDiv({ cls: "aos-golocal-col", attr: { "data-col": key } });
      box.createDiv({ cls: "aos-golocal-head", text: title });
      const ul = box.createEl("ul", { cls: "aos-golocal-list" });
      for (const it of items) ul.createEl("li", { text: it });
    };
    col("MOVES TO THIS MAC", MOVES_LOCAL, "local");
    col("STAYS HOSTED", staysHosted(hosts), "hosted");

    const spend = c.createDiv({ cls: "aos-golocal-spend" });
    spend.createSpan({ cls: "aos-golocal-label", text: "Background spend " });
    spend.createSpan({ text: spendText(backgroundSpend(ledger, now)) });

    const model = c.createDiv({ cls: "aos-golocal-model", attr: { "data-state": engine.state } });
    const name = engine.model ?? "the model picked for this Mac's memory";
    model.createSpan({
      text: engine.state === "missing" ? `This Mac's model${engine.model ? `, ${engine.model},` : " (qwen3.5:4b under 12 GB of memory, else qwen3.5:9b)"} is not downloaded yet: until it is, background work waits or uses heuristics.`
        : engine.state === "down" ? `${engine.engine === "openai" ? "The local server" : "Ollama"} is not answering at ${engine.url}: background work waits or uses heuristics until it does.`
          : engine.state === "answering" ? `${name} is downloaded and answering.`
            : `Runs on ${name} through ${engine.engine === "openai" ? "your OpenAI-compatible server" : "Ollama"}.`,
    });
    if (engine.state === "missing" && engine.canPull) {
      if (surfaceRuns(["local", "pull"])) {
        const pull = model.createEl("button", { cls: "aos-golocal-pull", text: "Download the model", attr: { type: "button", "data-act": "golocal-pull" } });
        pull.addEventListener("click", () => void this.pull(pull));
      } else this.termButton(model, "aos local pull", "aos-golocal-pull");
    }

    const chief = c.createEl("label", { cls: "aos-golocal-chief" });
    const box = chief.createEl("input", { attr: { type: "checkbox" } });
    box.checked = true;
    chief.createSpan({ text: chiefChoice(hosts) });

    this.statusEl = c.createDiv({ cls: "aos-golocal-status", attr: { role: "status", "aria-live": "polite" } });
    const foot = c.createDiv({ cls: "aos-golocal-foot" });
    if (!surfaceRuns(migrateArgs("apply", true))) {
      // The `migrate` surface is off: the commands, not buttons the app would refuse.
      const cmds = c.createDiv({ cls: "aos-golocal-cmds" });
      cmds.createDiv({ cls: "aos-golocal-cmdnote", text: "Going local from here needs the Go local write surface, which stays off until it has been checked on a live vault. Run your choice in the Code tab instead:" });
      const row = (key: "apply" | "decline", label: string, command: () => string): void => {
        const r = cmds.createDiv({ cls: "aos-golocal-cmd", attr: { "data-cmd": key } });
        r.createSpan({ cls: "aos-golocal-cmdlabel", text: label });
        const code = r.createEl("code", { cls: "aos-golocal-cmdtext", text: command() });
        if (key === "apply") box.addEventListener("change", () => code.setText(command()));
        this.termButton(r, command, "aos-golocal-cmdgo");
      };
      row("apply", "Go local", () => migrateCommand("apply", box.checked));
      row("decline", "Keep my settings", () => migrateCommand("decline"));
      foot.createDiv({ cls: "aos-golocal-spacer" });
      const later = foot.createEl("button", { cls: "aos-golocal-later", text: "Not now", attr: { type: "button" } });
      later.addEventListener("click", () => this.close());
      later.focus();
      return;
    }
    foot.createDiv({ cls: "aos-golocal-spacer" });
    const keep = foot.createEl("button", { cls: "aos-golocal-keep", text: "Keep my settings", attr: { type: "button" } });
    const go = foot.createEl("button", { cls: "mod-cta aos-golocal-go", text: "Go local", attr: { type: "button" } });
    this.buttons = [keep, go];
    keep.addEventListener("click", () => void this.run("decline", false));
    go.addEventListener("click", () => void this.run("apply", box.checked));
    go.focus();
  }

  /** A ❯_ button that runs `command` in a Code terminal and closes the card (or names it when there is no Code tab). */
  private termButton(host: HTMLElement, command: string | (() => string), cls: string): void {
    const text = (): string => (typeof command === "string" ? command : command());
    if (!this.o.runInTerm) { host.createSpan({ cls, text: `Run ${text()} in a terminal.` }); return; }
    const b = host.createEl("button", { cls: `aos-golocal-term ${cls}`, text: "❯_ Run in Code", attr: { type: "button", title: "Opens a Code terminal running this command" } });
    b.addEventListener("click", () => { this.o.runInTerm?.(text()); this.result = "terminal"; this.close(); });
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    for (const btn of this.buttons) btn.disabled = b;
  }

  private async run(action: "apply" | "decline", chief: boolean): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    this.statusEl?.removeClass("is-warn");
    this.statusEl?.setText(action === "apply" ? "Going local… (aos migrate local-first)" : "Keeping your settings…");
    const r = await this.plugin.aosJson<{ changed?: string[]; tick?: string }>(migrateArgs(action, chief), 120_000);
    this.setBusy(false);
    if (r.code === 0) {
      this.result = action === "apply" ? "applied" : "declined";
      if (action === "apply") {
        // What actually changed (a re-apply sets only what no longer held, or nothing).
        const moved = (r.json?.changed?.length ?? 0) > 0 || r.json?.tick === "rewrite";
        new Notice(moved ? "Background work now runs on this Mac. Settings ▸ Local engine can undo it."
          : "Nothing to change: background work already runs on this Mac with these settings.", 8000);
      }
      this.close();
      return;
    }
    this.fail(failureText(r), migrateCommand(action, chief));
  }

  /** What went wrong, and the same command for the Code tab. */
  private fail(why: string, command: string): void {
    const s = this.statusEl;
    if (!s) return;
    s.empty();
    s.addClass("is-warn");
    s.createSpan({ text: `That did not run: ${why}. ` });
    if (this.o.runInTerm) {
      const b = s.createEl("button", { cls: "aos-golocal-term", text: `❯_ ${command}`, attr: { type: "button" } });
      b.addEventListener("click", () => { this.o.runInTerm?.(command); this.close(); });
    } else s.createSpan({ text: `Run ${command} in a terminal.` });
  }

  /** `aos local pull` through the `local` surface: this Mac's model and the embedder (several GB). */
  private async pull(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.setText("Downloading…");
    const r = await this.plugin.aos(["local", "pull"], 60 * 60_000);
    if (r.code === 0) { btn.setText("Downloaded"); return; }
    btn.disabled = false;
    btn.setText("Download the model");
    this.fail(failureText(r), "aos local pull");
  }

  onClose(): void {
    this.contentEl.empty();
    this.done(this.result);
  }
}
