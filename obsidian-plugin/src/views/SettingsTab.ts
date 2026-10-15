import { Notice, Setting } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { readAgenticosJson, readProviderState, readVaultConfig, sessionHosts, VAULT_CONFIG_PATH } from "../data/aosConfig";
import { localEngineView, readLocalFiles, todayText } from "../data/localEngine";
import type { SessionHost } from "../data/aosConfig";
import { failureText, listFailure } from "../data/aosRun";
import {
  FollowUps, parseConfigList, groupBySection, changedCount, masterRows, valueArg, sameValue, confirmFor,
  appliesLabel, sourceLabel, sourceTitle, spendLine, hostNote, resultSummary, argsFor,
  controlFor, pickerOptions, stepValue, choiceLabel, manyOptions, manySelected, toggleMany, readonlyText,
} from "../data/settingsModel";
import type { ConfigList, ConfigRow, FollowUp, SetResult } from "../data/settingsModel";
import { ConfirmModal } from "../ui/ConfirmModal";
import { renderPluginSettings } from "../ui/pluginSettingRows";
import type { PluginRowsHandle } from "../ui/pluginSettingRows";
import { shell } from "../host";
import { HostsPanel } from "./settings/HostsPanel";
import { ImportPanel } from "./settings/ImportPanel";

const SOURCE_PILL: Record<string, string> = { machine: "aos-pill-amber", vault: "aos-pill-cyan", default: "aos-pill-dim", unset: "aos-pill-dim" };

/**
 * SETTINGS — the whole system's settings in one tab, opened from ⚙ at the foot of the rail (spec 2026-09-24-settings-tab).
 * It renders what `aos config list --json` returns (D2) and changes a setting only through `aos config set|unset`
 * (D3): the runtime validates, picks the file that wins, writes atomically and runs the side effects; this tab shows the
 * outcome. Master switches head it (D5), risky changes ask first (D6), follow-ups become buttons (D9), and the plugin's
 * own settings render through the same renderer as Obsidian's settings pane (D11). Logic lives in
 * src/data/settingsModel.ts; this class only renders and wires.
 */
export class SettingsTab {
  private host: HTMLElement | null = null;
  private list: ConfigList | null = null;
  private failure: { text: string; upgrade: boolean } | null = null;
  private hosts: SessionHost[] = ["claude"];
  private loading = false;
  private busy = new Set<string>();
  private rowErrors = new Map<string, string>();
  private followUps = new FollowUps();
  private pluginRows: PluginRowsHandle | null = null;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;
  private refreshAgain = false;
  // Settings ▸ Hosts and Import (install-import B2, B4): panels of their own that keep their state across renders.
  private readonly hostsPanel: HostsPanel;
  private readonly importPanel: ImportPanel;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {
    this.hostsPanel = new HostsPanel(plugin, view, () => this.render());
    this.importPanel = new ImportPanel(plugin, view, () => this.render());
  }

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      // A hand edit to brain/config.json (or another host's `aos config`) re-reads the list; agenticos.json lives
      // outside the vault, so its changes show on the next open or ⟳.
      const watch = (f: TAbstractFile) => { if (f.path === VAULT_CONFIG_PATH && this.view.isTabActive("settings")) this.schedule(); };
      this.view.registerEvent(this.plugin.app.vault.on("modify", watch));
    }
    this.hostsPanel.reopen();
    this.render();
  }

  unmount(): void {
    void this.pluginRows?.commit();
    this.pluginRows = null;
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    // A refresh asked for while one runs (a change's own, a file event's, ⟳) reads again when it ends: the one in flight
    // may have read the files before the change, and its list alone would show the old value until the next ⟳.
    if (this.loading) { this.refreshAgain = true; return; }
    this.loading = true;
    try {
      do {
        this.refreshAgain = false;
        this.hosts = sessionHosts(readAgenticosJson(this.plugin.claudeConfigDir()));
        const r = await this.plugin.aosJson<unknown>(["config", "list", "--json"]);
        const list = r.code === 0 ? parseConfigList(r.json) : null;
        if (list) this.list = list;
        this.failure = listFailure(r, !!list);
      } while (this.refreshAgain);
    } finally {
      this.loading = false;
    }
    this.render();
  }

  // ── writes (every one is `aos config`; the refreshed list is the source of truth afterwards) ──

  private async change(row: ConfigRow, next: unknown): Promise<void> {
    if (sameValue(row.value, next)) return;
    const ask = confirmFor(row, next);
    if (ask && !(await ConfirmModal.ask(this.plugin.app, ask.title, ask.message, ask.cta))) { this.render(); return; }
    await this.write(row.key, ["config", "set", row.key, valueArg(next), "--json"]);
  }

  private async reset(row: ConfigRow): Promise<void> {
    const ask = confirmFor(row, row.default);
    if (ask && !(await ConfirmModal.ask(this.plugin.app, ask.title, ask.message, ask.cta))) return;
    await this.write(row.key, ["config", "unset", row.key, "--json"]);
  }

  private async write(key: string, args: string[]): Promise<void> {
    this.busy.add(key);
    this.rowErrors.delete(key);
    this.render();
    const r = await this.plugin.aosJson<SetResult>(args);
    this.busy.delete(key);
    if (r.code === 0 && r.json) {
      new Notice(resultSummary(r.json), 6000);
      this.followUps.add(r.json.followUps);
      this.view.setBadge("settings", this.followUps.size);
      if (key === "telemetry.enabled") this.plugin.rebindLiveSources();
    } else if (r.code === 2) {
      this.rowErrors.set(key, failureText(r));
    } else {
      new Notice(`${key} not changed: ${failureText(r)}`, 8000);
    }
    await this.refresh();
  }

  private async runFollowUp(f: FollowUp): Promise<void> {
    const args = argsFor(f.command);
    if (!args) return;
    new Notice(`▶ ${f.command}`);
    const r = await this.plugin.aos(args, 300_000);
    if (r.code === 0) { this.followUps.remove(f.command); new Notice(`${f.command}: done`); }
    else new Notice(`${f.command} failed: ${failureText(r)}`, 8000);
    this.view.setBadge("settings", this.followUps.size);
    this.render();
  }

  // ── render ──

  private render(): void {
    if (!this.view.isTabActive("settings")) return;
    const host = this.host;
    if (!host) return;
    void this.pluginRows?.commit();
    host.empty();

    const head = host.createDiv({ cls: "aos-rt-head", attr: { "data-tour": "settings-head" } });
    head.createSpan({ cls: "aos-rt-title", text: "Settings" });
    head.createSpan({ cls: "aos-dim aos-rt-count", text: this.list ? `${changedCount(this.list)} changed from the defaults` : this.loading || !this.failure ? "loading…" : "" });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    const reload = actions.createEl("button", { cls: "aos-ws-action", text: "⟳ reload" });
    reload.setAttr("title", "Read every setting again (aos config list)");
    reload.addEventListener("click", () => void this.refresh());

    if (this.list) {
      const files = host.createDiv({ cls: "aos-rt-note aos-dim", attr: { "data-tour": "settings-sources" } });
      files.appendText("Values come from ");
      files.createSpan({ cls: "aos-pill aos-pill-amber", text: "this machine", attr: { title: this.list.files.machine } });
      files.appendText(" (agenticos.json), ");
      files.createSpan({ cls: "aos-pill aos-pill-cyan", text: "this vault", attr: { title: this.list.files.vault } });
      files.appendText(" (brain/config.json) or the ");
      files.createSpan({ cls: "aos-pill aos-pill-dim", text: "default" });
      files.appendText(". A change is written to the file that wins; ↺ goes back to the default.");
    }

    if (this.failure) this.renderFailure(host);
    if (this.followUps.size) this.renderFollowUps(host);
    if (this.list) {
      this.renderMaster(host, this.list);
      this.renderLocal(host);
    }
    // Neither needs the settings list: they read the runtime's own answers and files.
    this.hostsPanel.render(host);
    this.importPanel.render(host);
    if (this.list) {
      for (const { section, rows } of groupBySection(this.list)) {
        if (section.id === "hosts") continue;
        host.createDiv({ cls: "aos-rt-subhead aos-dim", text: section.label.toUpperCase() });
        const box = host.createDiv({ cls: "aos-st-section" });
        for (const row of rows) this.renderRow(box, row);
      }
    }

    host.createDiv({ cls: "aos-rt-subhead aos-dim", text: "WORKBENCH — THIS APP" });
    this.pluginRows = renderPluginSettings(host.createDiv({ cls: "aos-st-section aos-st-plugin" }), this.plugin, () => this.render());

    if (this.list) this.renderHosts(host, this.list);
  }

  /**
   * Settings ▸ Local engine (local-first A8, A13, A18, A3): the engine and its address, whether it answers, the model
   * background work runs on and whether it is downloaded, the embedder, today's local calls and the session wraps waiting
   * for it, from the files the runtime writes (data/localEngine.ts). Pull the model runs `aos local pull` through the
   * `local` surface; ❯_ shows the same in a Code terminal, with its progress.
   */
  private renderLocal(host: HTMLElement): void {
    const vault = this.plugin.vaultRoot();
    const cfg = readVaultConfig(vault, this.plugin.claudeConfigDir());
    const files = readLocalFiles(vault, new Date());
    const v = localEngineView(cfg, readProviderState(vault), files.today, files.queued);
    host.createDiv({ cls: "aos-rt-subhead aos-dim", text: "LOCAL ENGINE" });
    const box = host.createDiv({ cls: "aos-st-section aos-st-local", attr: { "data-tour": "settings-local", "data-state": v.state, "data-active": String(v.active) } });
    const line = (label: string, value: string, key: string) => {
      const r = box.createDiv({ cls: "aos-st-localrow", attr: { "data-row": key } });
      r.createSpan({ cls: "aos-st-locallabel aos-dim", text: label });
      r.createSpan({ cls: "aos-st-localvalue", text: value });
    };
    box.createDiv({ cls: `aos-st-localstate is-${v.state}`, text: v.stateText });
    line("Engine", `${v.engine === "openai" ? "OpenAI-compatible server" : "Ollama"} at ${v.url}`, "engine");
    line("Model", `${v.model ?? "not chosen yet"} · ${v.modelNote}`, "model");
    line("Embedder", `${v.embedder}${v.embedderPulled === false ? " · not downloaded (recall uses keyword search)" : v.embedderPulled ? " · downloaded" : ""}`, "embedder");
    line("Today", todayText(v.today), "today");
    if (v.queued) line("Waiting", `${v.queued} session wrap${v.queued === 1 ? "" : "s"} queued until the model answers`, "queued");
    const acts = box.createDiv({ cls: "aos-st-localacts" });
    if (v.canPull) {
      const pulling = this.busy.has("local:pull");
      const pull = acts.createEl("button", { cls: "aos-ws-action", text: pulling ? "Pulling…" : "Pull the model", attr: { "data-act": "local-pull" } });
      pull.disabled = pulling;
      pull.setAttr("title", "Download this Mac's model and the embedder through Ollama (aos local pull); it can take a while");
      pull.addEventListener("click", () => void this.pullModel());
    }
    const term = acts.createEl("button", { cls: "aos-ws-action", text: "❯_ aos local", attr: { "data-act": "local-status" } });
    term.setAttr("title", "Ask the engine now and show what it serves, in the Code tab");
    term.addEventListener("click", () => this.view.runInTerm("aos local", { origin: "Settings" }));
  }

  /** `aos local pull`: this Mac's model and the embedder, through Ollama. Long: a download of several GB. */
  private async pullModel(): Promise<void> {
    if (this.busy.has("local:pull")) return;
    this.busy.add("local:pull");
    this.render();
    new Notice("Pulling the local model… (aos local pull)");
    const r = await this.plugin.aos(["local", "pull"], 60 * 60_000);
    this.busy.delete("local:pull");
    if (r.code === 0) new Notice("Local model downloaded: background work runs on it at the next call.", 8000);
    else new Notice(`Pull the model: ${failureText(r)} — or run aos local pull in the Code tab`, 10000);
    this.render();
  }

  private renderFailure(host: HTMLElement): void {
    const box = host.createDiv({ cls: "aos-st-failure" });
    box.createDiv({ text: this.failure!.upgrade
      ? "This vault's runtime has no `aos config` yet: run `aos upgrade` to control every setting from here. The plugin's own settings below still work."
      : `Could not read the settings: ${this.failure!.text}` });
    if (this.failure!.upgrade) {
      const b = box.createEl("button", { cls: "aos-ws-action", text: "❯_ aos upgrade" });
      b.addEventListener("click", () => this.view.runInTerm("aos upgrade", { origin: "Settings" }));
    }
  }

  private renderFollowUps(host: HTMLElement): void {
    const bar = host.createDiv({ cls: "aos-st-follow" });
    bar.createSpan({ text: `⚠ ${this.followUps.size} step${this.followUps.size === 1 ? "" : "s"} left:` });
    for (const f of this.followUps.list()) {
      const b = bar.createEl("button", { cls: "aos-ws-action", text: f.command });
      b.setAttr("title", f.why);
      b.addEventListener("click", () => void this.runFollowUp(f));
    }
  }

  private renderMaster(host: HTMLElement, list: ConfigList): void {
    host.createDiv({ cls: "aos-rt-subhead aos-dim", text: "MASTER SWITCHES" });
    const grid = host.createDiv({ cls: "aos-st-master" });
    for (const { sw, row, on } of masterRows(list)) {
      const chip = grid.createEl("label", { cls: `aos-st-switch${on ? " is-on" : ""}${this.busy.has(row.key) ? " is-busy" : ""}` });
      chip.setAttr("title", `${row.key} — ${row.help}`);
      const box = chip.createEl("input", { attr: { type: "checkbox" } });
      box.checked = on;
      box.addEventListener("change", () => void this.change(row, sw.valueFor(box.checked)));
      chip.createSpan({ cls: "aos-st-switchlabel", text: sw.label });
    }
  }

  private renderRow(box: HTMLElement, row: ConfigRow): void {
    const s = new Setting(box).setName(row.label);
    const dimmed = hostNote(row, this.hosts);
    s.settingEl.addClass("aos-st-row");
    if (dimmed) s.settingEl.addClass("is-dim");
    const busy = this.busy.has(row.key);

    const desc = s.descEl;
    desc.empty();
    desc.createDiv({ text: row.help });
    const meta = desc.createDiv({ cls: "aos-st-meta" });
    meta.createSpan({ cls: "aos-st-key", text: row.key });
    if (this.list) meta.createSpan({ cls: `aos-pill ${SOURCE_PILL[row.source] ?? "aos-pill-dim"}`, text: sourceLabel(row.source), attr: { title: sourceTitle(row.source, this.list.files) } });
    meta.createSpan({ cls: "aos-dim", text: row.readonly && row.how ? `change with: ${row.how}` : appliesLabel(row.applies) });
    const spent = spendLine(row);
    if (spent) meta.createSpan({ cls: "aos-st-spend", text: spent });
    if (dimmed) desc.createDiv({ cls: "aos-st-hostnote", text: dimmed });
    if (row.note) desc.createDiv({ cls: "aos-st-hostnote", text: row.note });
    const err = this.rowErrors.get(row.key);
    if (err) desc.createDiv({ cls: "aos-st-err", text: err });

    // Every control is a toggle, a picker (with − / + on numbers), chips or a button — never a text box (spec
    // 2026-09-24-settings-pickers D1). A value outside the presets stays visible as "(custom)" and is set with the CLI.
    const control = controlFor(row);
    if (control === "readonly") {
      s.controlEl.createSpan({ cls: "aos-st-value", text: readonlyText(row), attr: { title: typeof row.value === "string" ? row.value : "" } });
      if (!row.readonly) desc.createDiv({ cls: "aos-st-hostnote", text: "Run `aos upgrade` to change this here: this vault's runtime sends no presets yet." });
      return;
    }
    if (control === "toggle") {
      s.addToggle((t) => t.setValue(row.value === true).setDisabled(busy).onChange((v) => void this.change(row, v)));
    } else if (control === "picker" || control === "stepper") {
      if (control === "stepper") this.addStep(s, row, -1, busy);
      const opts = pickerOptions(row);
      s.addDropdown((d) => {
        for (const o of opts) d.addOption(o.key, o.label);
        d.setValue(valueArg(row.value));
        d.setDisabled(busy);
        d.selectEl.setAttr("title", `Other values: aos config set ${row.key} <value>`);
        d.onChange((k) => { const o = opts.find((x) => x.key === k); if (o) void this.change(row, o.value); });
      });
      if (control === "stepper") this.addStep(s, row, 1, busy);
    } else if (control === "chips") {
      const on = new Set(manySelected(row));
      const wrap = s.controlEl.createDiv({ cls: "aos-st-chips" });
      for (const item of manyOptions(row)) {
        const chip = wrap.createEl("label", { cls: `aos-st-switch aos-st-chip${on.has(item) ? " is-on" : ""}${busy ? " is-busy" : ""}` });
        const box = chip.createEl("input", { attr: { type: "checkbox" } });
        box.checked = on.has(item);
        // A comma-string setting (routines.tools) cannot be emptied: its last chip stays on.
        box.disabled = busy || (row.type === "string" && on.size === 1 && on.has(item));
        box.addEventListener("change", () => void this.change(row, toggleMany(row, item, box.checked)));
        chip.createSpan({ text: item });
      }
    } else if (control === "button") {
      desc.querySelector(".aos-st-meta")?.createSpan({ cls: "aos-dim", text: `now: ${readonlyText(row)}` });
      const file = row.source === "machine" ? this.list?.files.machine : this.list?.files.vault;
      s.addButton((b) => {
        if (row.editIn === "skills" || row.editIn === "agents") {
          const tab = row.editIn;
          b.setButtonText(`Manage in ${tab === "skills" ? "Skills" : "Agents"}`).onClick(() => this.view.setTab(tab));
        } else {
          b.setButtonText(`Edit ${row.source === "machine" ? "agenticos.json" : "brain/config.json"}`).onClick(() => { if (file) this.openFile(file); });
        }
      });
    }
    if (row.source !== "default" && row.source !== "unset") {
      s.addExtraButton((b) => b.setIcon("rotate-ccw").setDisabled(busy)
        .setTooltip(`Back to the default (${valueArg(row.default)}): aos config unset ${row.key}`)
        .onClick(() => void this.reset(row)));
    }
  }

  /** D9: − / + step to the adjacent preset; disabled at the ends. The change goes through the same confirm rules. */
  private addStep(s: Setting, row: ConfigRow, dir: -1 | 1, busy: boolean): void {
    const next = stepValue(row, dir);
    s.addExtraButton((b) => b.setIcon(dir === -1 ? "minus" : "plus").setDisabled(busy || next === null)
      .setTooltip(next === null ? (dir === -1 ? "lowest preset" : "highest preset") : `${dir === -1 ? "Lower" : "Raise"} to ${choiceLabel(row, next)}`)
      .onClick(() => { if (next !== null) void this.change(row, next); }));
  }

  private openFile(file: string): void {
    try {
      void shell.openPath(file).then((err: string) => { if (err) new Notice(`Cannot open ${file}: ${err}`); });
    } catch { new Notice(`Cannot open ${file}`); }
  }

  private renderHosts(host: HTMLElement, list: ConfigList): void {
    const rows = list.settings.filter((r) => r.section === "hosts");
    if (!rows.length) return;
    host.createDiv({ cls: "aos-rt-subhead aos-dim", text: "HOSTS & INSTALL — CHANGED ONLY THROUGH THE INSTALLER" });
    host.createDiv({ cls: "aos-rt-note aos-dim", text: "Add a host under Hosts above (aos hosts add); paths and binaries change with aos upgrade." });
    const acts = host.createDiv({ cls: "aos-st-actions" });
    const doctor = acts.createEl("button", { cls: "aos-ws-action", text: "❯_ aos doctor" });
    doctor.setAttr("title", "Check every install path, binary, host and hook in the Code tab");
    doctor.addEventListener("click", () => this.view.runInTerm("aos doctor", { origin: "Settings" }));
    const upgrade = acts.createEl("button", { cls: "aos-ws-action", text: "❯_ aos upgrade" });
    upgrade.setAttr("title", "Refresh the runtime and both plugins, and re-resolve the binaries, in the Code tab");
    upgrade.addEventListener("click", () => this.view.runInTerm("aos upgrade", { origin: "Settings" }));
    const box = host.createDiv({ cls: "aos-st-section" });
    for (const row of rows) this.renderRow(box, row);
  }
}
