// The Import sheet (spec 2026-10-14-install-and-import-design B12, B9, B15; guided-tour C11): asked once per vault by
// the launch sequence (ui/launchSequence.ts) while the upgrade to 2.0 left the `import` migration pending. It shows what
// `aos import` would bring from this Mac (its dry run: counts per host and kind, and the project folders proposed as
// workspaces, all preselected), then **Import** runs `aos migrate import --apply [--accept …]` with its progress (the
// fast phase; the sessions are queued for the import-digest routine) and **Not now** `aos migrate import --decline`:
// one call each through the `migrate` surface, which runs the import and settles the migration together. With nothing
// on this Mac to bring, it says so and OK settles it. While that surface is off (an AOS_APP_WRITE that leaves it out), the
// sheet shows the commands up front, each with a ❯_ for the Code tab, as the Go-local card does. Settings ▸ Import has
// the same import whenever it is wanted later.
import { Modal, Notice, canRun } from "obsidian";
import type AgenticOSPlugin from "../../main";
import { importerFor, type Importer } from "../data/importer";
import {
  IMPORT_HOST_LABEL, IMPORT_KIND_LABEL, IMPORT_HOSTS, digestText, engineLine, importArgs, migrateImportArgs, scanCell, scanEmpty, scanHosts, scanKinds,
  type ImportProgress, type ImportScan,
} from "../data/importModel";
import { dialogId } from "./spaces/SpaceDialogs";

/** imported or declined here; `nothing` to bring (settled); `terminal` handed to the Code tab; `later` closed. */
export type ImportSheetResult = "imported" | "declined" | "nothing" | "terminal" | "later";

export interface ImportSheetOptions {
  /** Runs a command in a Code terminal (WorkbenchView.runInTerm). */
  runInTerm?: (command: string) => void;
  importer?: Importer;
}

/** The sheet's dry run, as data/importer.ts scan() builds it with no narrowing. */
const SCAN_ARGS = importArgs({ from: [...IMPORT_HOSTS], only: ["instructions", "memories", "projects", "mcp", "sessions"] }, { dryRun: true, json: true });

/** Whether an enabled surface runs this `aos` argv (compat's page policy; display only, main checks the spawn). */
function surfaceRuns(args: string[]): boolean {
  try { return canRun("cli/aos.js", args); } catch { return false; }
}

/** `aos migrate import --apply …` as typed in a terminal (the JSON list single-quoted for the shell). */
function command(args: string[]): string {
  return `aos ${args.map((a) => (a.startsWith("[") ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ")}`.replace(/ --json$/, "");
}

export class ImportSheet extends Modal {
  private result: ImportSheetResult = "later";
  private closed = false;
  private busy = false;
  private body!: HTMLElement;
  private foot!: HTMLElement;
  private readonly importer: Importer;

  constructor(private readonly plugin: AgenticOSPlugin, private readonly done: (r: ImportSheetResult) => void = () => {}, private readonly o: ImportSheetOptions = {}) {
    super(plugin.app);
    this.importer = o.importer ?? importerFor(plugin);
  }

  /** Opens the sheet; resolves with what the user chose once it closes. */
  static ask(plugin: AgenticOSPlugin, o: ImportSheetOptions = {}): Promise<ImportSheetResult> {
    return new Promise((resolve) => new ImportSheet(plugin, resolve, o).open());
  }

  onOpen(): void {
    const ids = { title: dialogId("import-title"), body: dialogId("import-body") };
    this.modalEl.addClass("aos-importsheet-modal");
    this.modalEl.setAttr("role", "dialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.modalEl.setAttr("aria-labelledby", ids.title);
    this.modalEl.setAttr("aria-describedby", ids.body);
    this.titleEl.setText("Bring in your Claude Code and Codex history");
    this.titleEl.id = ids.title;
    const c = this.contentEl;
    c.addClass("aos-importsheet");
    c.createEl("p", {
      cls: "aos-importsheet-intro", attr: { id: ids.body },
      text: "2.0 can bring in what your hosts left on this Mac: your global instructions as rules, Claude Code's memories, both hosts' MCP servers, your project folders as workspaces, and the last 90 days of sessions, digested on the local model. Nothing leaves this Mac, and every memory waits in Brain ▸ Review until you keep it.",
    });
    this.body = c.createDiv({ cls: "aos-importsheet-body", attr: { "aria-live": "polite" } });
    this.foot = c.createDiv({ cls: "aos-importsheet-foot" });
    if (!surfaceRuns(SCAN_ARGS) || !surfaceRuns(migrateImportArgs("apply"))) { this.renderCommands(); return; }
    this.body.setAttr("data-state", "scanning");
    this.body.setText("Looking at what is on this Mac… (aos import --dry-run)");
    const later = this.foot.createEl("button", { cls: "aos-importsheet-later", text: "Not now", attr: { type: "button" } });
    later.addEventListener("click", () => void this.decline());
    void this.importer.scan().then((r) => {
      if (this.closed) return;
      if (r.ok) this.renderScan(r.scan);
      else this.renderFailure(`Could not look at what is on this Mac: ${r.error}.`);
    });
  }

  // ── what there is ──

  private renderScan(scan: ImportScan): void {
    this.body.empty();
    this.foot.empty();
    if (scanEmpty(scan)) {
      this.body.setAttr("data-state", "empty");
      this.body.createDiv({ cls: "aos-importsheet-empty", text: "There is nothing from Claude Code or Codex on this Mac to bring in: no instructions, memories, MCP servers or past sessions. Settings ▸ Import brings them in whenever there are." });
      this.spacer();
      const ok = this.foot.createEl("button", { cls: "mod-cta aos-importsheet-ok", text: "OK", attr: { type: "button" } });
      ok.addEventListener("click", () => void this.decline("nothing"));
      ok.focus();
      return;
    }
    this.body.setAttr("data-state", "ready");
    const hosts = scanHosts(scan);
    const kinds = scanKinds(scan).filter((k) => k !== "projects");
    const table = this.body.createEl("table", { cls: "aos-importsheet-table" });
    const head = table.createEl("tr");
    head.createEl("th", { text: "" });
    for (const h of hosts) head.createEl("th", { text: IMPORT_HOST_LABEL[h], attr: { "data-host": h } });
    for (const k of kinds) {
      const row = table.createEl("tr", { attr: { "data-kind": k } });
      row.createEl("th", { text: IMPORT_KIND_LABEL[k] });
      for (const h of hosts) row.createEl("td", { text: scanCell(scan.hosts[h]!, k)?.text ?? "—", attr: { "data-host": h, "data-kind": k } });
    }
    this.body.createDiv({ cls: "aos-importsheet-engine", text: engineLine(scan) });
    const boxes: Array<{ id: string; box: HTMLInputElement }> = [];
    if (scan.proposals.length) {
      const list = this.body.createDiv({ cls: "aos-importsheet-proposals" });
      list.createDiv({ cls: "aos-importsheet-head", text: "MAKE THESE PROJECT FOLDERS WORKSPACES" });
      for (const p of scan.proposals) {
        const label = list.createEl("label", { cls: "aos-importsheet-proposal", attr: { "data-id": p.id } });
        const box = label.createEl("input", { attr: { type: "checkbox" } });
        box.checked = true;
        const what = label.createDiv({ cls: "aos-importsheet-what" });
        what.createDiv({ text: `${p.id} → ${p.action === "new" ? `new workspace ${p.slug}` : `linked to ${p.into ?? p.slug}`}` });
        if (p.reason) what.createDiv({ cls: "aos-importsheet-reason", text: p.reason });
        boxes.push({ id: p.id, box });
      }
    }
    const status = this.body.createDiv({ cls: "aos-importsheet-status", attr: { role: "status" } });
    this.spacer();
    const later = this.foot.createEl("button", { cls: "aos-importsheet-later", text: "Not now", attr: { type: "button" } });
    const go = this.foot.createEl("button", { cls: "mod-cta aos-importsheet-import", text: "Import", attr: { type: "button" } });
    later.addEventListener("click", () => void this.decline());
    go.addEventListener("click", () => void this.run(boxes.filter((b) => b.box.checked).map((b) => b.id), status, [later, go]));
    go.focus();
  }

  // ── Import, Not now ──

  private async run(accept: string[], status: HTMLElement, buttons: HTMLButtonElement[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    for (const b of buttons) b.disabled = true;
    status.empty();
    status.removeClass("is-warn");
    const bar = status.createDiv({ cls: "aos-importsheet-progress", attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuenow": "0", "aria-label": "Importing" } });
    const fill = bar.createDiv({ cls: "aos-importsheet-fill" });
    const label = status.createDiv({ cls: "aos-importsheet-step", text: "Importing… (aos migrate import --apply)" });
    const onProgress = (p: ImportProgress): void => {
      bar.setAttr("aria-valuemax", String(p.steps));
      bar.setAttr("aria-valuenow", String(p.done));
      fill.style.width = `${p.steps ? Math.round((p.done / p.steps) * 100) : 0}%`;
      label.setText(`Importing… ${p.done} of ${p.steps}: ${p.label}`);
    };
    const r = await this.importer.applyMigration(accept, onProgress);
    this.busy = false;
    if (r.ok) {
      this.result = "imported";
      const d = this.importer.digest();
      new Notice(`Your history is in. New memories wait in Brain ▸ Review${d ? `; ${digestText(d).replace(/^Digesting history/, "the digest works through the sessions")}, every 30 minutes on the local model` : ""}.`, 10000);
      this.close();
      return;
    }
    for (const b of buttons) b.disabled = false;
    status.empty();
    this.fail(status, r.error ?? "unknown error", migrateImportArgs("apply", accept));
  }

  private async decline(result: ImportSheetResult = "declined"): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const r = await this.importer.declineMigration();
    this.busy = false;
    if (r.ok) {
      this.result = result;
      this.close();
      return;
    }
    const s = this.contentEl.querySelector<HTMLElement>(".aos-importsheet-status") ?? this.body.createDiv({ cls: "aos-importsheet-status" });
    this.fail(s, r.error ?? "unknown error", migrateImportArgs("decline"));
  }

  // ── the Code tab instead ──

  /** The scan could not run: say why, then the commands. */
  private renderFailure(text: string): void {
    this.body.empty();
    this.foot.empty();
    this.body.setAttr("data-state", "failed");
    this.body.createDiv({ cls: "aos-importsheet-failure", text });
    this.renderCommands(false);
  }

  /** The commands for the Code tab, each with ❯_: what the sheet's buttons would run. */
  private renderCommands(intro = true): void {
    this.body.removeAttribute("data-state");
    const cmds = this.body.createDiv({ cls: "aos-importsheet-cmds", attr: { "data-state": "commands" } });
    if (intro) cmds.createDiv({ cls: "aos-importsheet-cmdnote", text: "Importing from here needs the Go local write surface, which stays off until it has been checked on a live vault. Run your choice in the Code tab instead:" });
    const row = (key: string, label: string, args: string[]): void => {
      const r = cmds.createDiv({ cls: "aos-importsheet-cmd", attr: { "data-cmd": key } });
      r.createSpan({ cls: "aos-importsheet-cmdlabel", text: label });
      r.createEl("code", { cls: "aos-importsheet-cmdtext", text: command(args) });
      this.termButton(r, command(args));
    };
    row("scan", "See what it would bring", ["import", "--dry-run"]);
    row("apply", "Import", migrateImportArgs("apply"));
    row("decline", "Not now", migrateImportArgs("decline"));
    this.spacer();
    const later = this.foot.createEl("button", { cls: "aos-importsheet-close", text: "Later", attr: { type: "button" } });
    later.addEventListener("click", () => this.close());
    later.focus();
  }

  private fail(host: HTMLElement, why: string, args: string[]): void {
    host.empty();
    host.addClass("is-warn");
    host.createSpan({ text: `That did not run: ${why.replace(/\.$/, "")}. ` });
    this.termButton(host, command(args));
  }

  private termButton(host: HTMLElement, cmd: string): void {
    if (!this.o.runInTerm) { host.createSpan({ text: `Run ${cmd} in a terminal.` }); return; }
    const b = host.createEl("button", { cls: "aos-importsheet-term", text: "❯_ Run in Code", attr: { type: "button", title: "Opens a Code terminal running this command" } });
    b.addEventListener("click", () => { this.o.runInTerm?.(cmd); this.result = "terminal"; this.close(); });
  }

  private spacer(): void { this.foot.createDiv({ cls: "aos-importsheet-spacer" }); }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.done(this.result);
  }
}
