// Settings ▸ Import (install-import B4, B10): each host's last import and what it brought, the digest working through the
// sessions, Import (again) per host, and Import older history (`--since all`). A run is the fast phase with its progress
// (data/importer.ts, through the `import` write surface); the sessions it queues are digested by the import-digest routine
// on the local model, which Pulse follows too. Whatever a host left on disk is imported, whether or not it is on.
import { Notice } from "obsidian";
import type AgenticOSPlugin from "../../../main";
import type { WorkbenchView } from "../WorkbenchView";
import { importerFor, type Importer } from "../../data/importer";
import {
  IMPORT_HOSTS, IMPORT_HOST_LABEL, IMPORT_KINDS, digestText, hostImportText, lastImports, progressStep,
  type ImportHost, type ImportProgress, type ImportRequest,
} from "../../data/importModel";
import { formatRelative } from "../../data/runs";

const SURFACE_OFF = /no write surface (?:that allows it is on|runs it)/;
type Job = ImportHost | "older";

export class ImportPanel {
  private busy: Job | null = null;
  private progress: ImportProgress | null = null;
  private result: { job: Job; ok: boolean; text: string; command: string | null } | null = null;
  private readonly importer: Importer;

  constructor(private readonly plugin: AgenticOSPlugin, private readonly view: WorkbenchView, private readonly rerender: () => void, importer?: Importer) {
    this.importer = importer ?? importerFor(plugin);
  }

  render(parent: HTMLElement): void {
    const state = this.importer.state();
    const last = lastImports(state);
    parent.createDiv({ cls: "aos-rt-subhead aos-dim", text: "IMPORT" });
    const box = parent.createDiv({ cls: "aos-st-section aos-st-import", attr: { "data-tour": "settings-import" } });
    box.createDiv({
      cls: "aos-st-hostintro aos-dim",
      text: "Your Claude Code and Codex history, from what each left on this Mac: instructions and memories (to Brain ▸ Review), the MCP server list, project folders to adopt in Spaces, and the last 90 days of sessions, which the import-digest routine summarises on the local model. Nothing leaves this Mac, and a second import brings only what is new.",
    });
    if (state.digest) box.createDiv({ cls: `aos-st-importdigest${state.digest.done ? " is-done" : ""}`, attr: { "data-row": "digest" }, text: digestText(state.digest) });
    for (const h of IMPORT_HOSTS) {
      const x = last[h];
      const row = box.createDiv({ cls: "aos-st-hostrow", attr: { "data-host": h } });
      const head = row.createDiv({ cls: "aos-st-hosthead" });
      head.createSpan({ cls: "aos-st-hostname", text: IMPORT_HOST_LABEL[h] });
      head.createSpan({
        cls: "aos-st-hoststate", attr: { "data-row": "last" },
        text: x ? `Last imported ${formatRelative(x.at)}: ${hostImportText(x)}${x.older ? " · all history" : ""}` : "Not imported yet",
      });
      const acts = head.createDiv({ cls: "aos-st-hostacts" });
      this.button(acts, h, x ? "Import again" : "Import", `aos import --from ${h}: what is new since the last import`, { from: [h], only: [...IMPORT_KINDS] });
      if (this.busy === h || this.result?.job === h) this.renderRun(row, h);
    }
    const foot = box.createDiv({ cls: "aos-st-hostfoot" });
    this.button(foot, "older", "Import older history", "aos import --since all: every session either host kept, not just the last 90 days, queued for the digest", { from: [...IMPORT_HOSTS], only: [...IMPORT_KINDS], since: "all" });
    if (this.busy === "older" || this.result?.job === "older") this.renderRun(box, "older");
  }

  private button(parent: HTMLElement, job: Job, text: string, title: string, req: ImportRequest): void {
    const running = this.busy === job;
    const b = parent.createEl("button", { cls: "aos-ws-action", text: running ? "Importing…" : text, attr: { "data-act": `import-${job}` } });
    b.disabled = this.busy !== null || this.importer.busy;
    b.setAttr("title", title);
    b.addEventListener("click", () => void this.run(job, req));
  }

  private renderRun(parent: HTMLElement, job: Job): void {
    const box = parent.createDiv({ cls: "aos-st-hostresult", attr: { "data-row": "run" } });
    if (this.busy === job) {
      const p = this.progress;
      box.addClass("is-running");
      box.setText(p ? `Importing… ${p.done} of ${p.steps}: ${p.label}` : "Importing…");
      return;
    }
    const r = this.result!;
    box.addClass(r.ok ? "is-ok" : "is-err");
    box.createDiv({ text: r.text });
    if (r.command) {
      const cmd = r.command;
      const b = box.createEl("button", { cls: "aos-ws-action", text: `❯_ ${cmd}`, attr: { "data-act": `import-term-${job}` } });
      b.setAttr("title", "Run it in a Code terminal instead");
      b.addEventListener("click", () => this.view.runInTerm(cmd, { origin: "Settings" }));
    }
  }

  private async run(job: Job, req: ImportRequest): Promise<void> {
    if (this.busy || this.importer.busy) return;
    this.busy = job;
    this.progress = null;
    this.result = null;
    this.rerender();
    const r = await this.importer.run(req, (p) => { this.progress = p; this.rerender(); });
    this.busy = null;
    const command = job === "older" ? "aos import --since all" : `aos import --from ${job}`;
    if (r.ok) {
      const projects = r.lines.map(progressStep).find((s) => s?.kind === "projects");
      const proposed = projects && /^(\d+) proposed/.exec(projects.text);
      const parts = [job === "older" ? "Older history queued." : `${IMPORT_HOST_LABEL[job]}: imported.`];
      const d = r.state.digest;
      if (d && !d.done) parts.push(`${digestText(d)}; the import-digest routine works through them every 30 minutes on the local model.`);
      if (proposed && Number(proposed[1]) > 0) parts.push(`${proposed[1]} project folder${proposed[1] === "1" ? "" : "s"} proposed as workspaces: adopt them under Spaces ▸ Outside workspaces.`);
      parts.push("New memories wait in Brain ▸ Review.");
      this.result = { job, ok: true, text: parts.join(" "), command: null };
      new Notice(job === "older" ? "Older history queued for the digest." : `${IMPORT_HOST_LABEL[job]} history imported.`, 6000);
    } else {
      const off = !!r.error && SURFACE_OFF.test(r.error);
      this.result = {
        job, ok: false, command,
        text: off ? "Importing from here is off under the app's write surfaces (Import). Run it in a Code terminal instead." : `Import stopped: ${r.error ?? "unknown error"}`,
      };
    }
    this.rerender();
  }
}
