import { App, PluginSettingTab, Setting } from "obsidian";
import type AgenticOSPlugin from "../main";
import { DEFAULT_SETTINGS } from "./settingsDefaults";
import type { AgenticOSSettings } from "./settingsDefaults";
import { readProviderState } from "./data/aosConfig";
import { renderPluginSettings, setSystemSetting } from "./ui/pluginSettingRows";
import type { PluginRowsHandle } from "./ui/pluginSettingRows";

export { DEFAULT_SETTINGS };
export type { AgenticOSSettings };

/**
 * Obsidian's settings pane for the plugin. The Workbench's ⚙ Settings tab is the full control panel (spec
 * 2026-09-24-settings-tab); this pane keeps the plugin's own settings where Obsidian users look for them, rendered by
 * the same renderPluginSettings() the tab uses (D11), plus the two system switches the HUD depends on (D10).
 */
export class AgenticOSSettingTab extends PluginSettingTab {
  plugin: AgenticOSPlugin;
  private rows: PluginRowsHandle | null = null;

  constructor(app: App, plugin: AgenticOSPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Runtime" });

    new Setting(containerEl)
      .setName("Workbench settings")
      .setDesc("Every runtime setting in one place: provider and models, spend limits, the Chief of Staff, routines, the knowledge graph, cross-review, sharing, telemetry and updates.")
      .addButton((b) => b.setButtonText("Open Workbench settings").setCta().onClick(() => {
        // Obsidian has no public API to close its settings modal; the guarded call is a no-op if that ever changes.
        (this.app as unknown as { setting?: { close?: () => void } }).setting?.close?.();
        void this.plugin.openWorkbenchTab("settings");
      }));

    new Setting(containerEl).setName("System").setHeading();

    const state = readProviderState(this.plugin.vaultRoot());
    new Setting(containerEl)
      .setName("Provider")
      .setDesc(state
        ? `${state.name} (${state.reason}) — checked ${state.checkedAt}. Change it in Workbench settings or with \`aos config set provider <auto|ollama|claude|codex|none>\`.`
        : "No provider state yet — run any Claude Code or Codex session (hooks write brain/_index/provider-state.json) or `aos provider`.")
      .addExtraButton((b) => b.setIcon("refresh-cw").setTooltip("Re-read provider state").onClick(() => this.display()));

    const sys = this.plugin.systemConfig();
    new Setting(containerEl)
      .setName("Session costing")
      .setDesc("cost.enabled — cost every session at its end and show the COST row, cost Fix Queue cards and COST DETAIL (with cost.monthlyBudget set). The system switch: this runs `aos config set cost.enabled`, which installs the analyzer when turning it on.")
      .addToggle((t) =>
        t.setValue(sys.cost.enabled === true).onChange(async (v) => {
          await setSystemSetting(this.plugin, "cost.enabled", v);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Telemetry")
      .setDesc("telemetry.enabled — record agent runs (Runs tab, Pulse, spend). The system switch: this runs `aos config set telemetry.enabled`; when off, the hooks record nothing and the plugin neither sweeps crashed runs nor creates brain/_index/agent-runs/live.")
      .addToggle((t) =>
        t.setValue(sys.telemetry.enabled !== false).onChange(async (v) => {
          await setSystemSetting(this.plugin, "telemetry.enabled", v);
          this.display();
        })
      );

    this.rows = renderPluginSettings(containerEl, this.plugin, () => this.display());
  }

  hide(): void {
    void this.rows?.commit();
    this.rows = null;
    super.hide();
  }
}
