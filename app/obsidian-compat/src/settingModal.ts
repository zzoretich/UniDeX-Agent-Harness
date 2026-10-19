// Obsidian's settings window (`app.setting`): a dialog with the tabs listed on the left, the host's own tabs under
// Options and each plugin's registered tab under Community plugins. The HUD's tab closes it through
// `app.setting.close()` before it opens the Workbench's Settings tab, as it does in Obsidian.

import { Modal } from "./modal";
import type { App, SettingTab } from "./plugin";

export class SettingModal extends Modal {
  /** The host's own tabs (Obsidian's core options), shown above the plugins' tabs. */
  settingTabs: SettingTab[] = [];
  activeTab: SettingTab | null = null;
  private lastId: string | null = null;
  private navEl: HTMLElement | null = null;
  private tabContentEl: HTMLElement | null = null;

  constructor(app: App) {
    super(app);
    this.modalEl.addClass("mod-settings");
  }

  /** The tabs plugins registered with addSettingTab, in load order. */
  get pluginTabs(): SettingTab[] { return this.app.settingTabs; }

  get isOpen(): boolean { return this.containerEl.isConnected; }

  addSettingTab(tab: SettingTab): void { this.settingTabs.push(tab); }

  onOpen(): void {
    this.contentEl.empty();
    const box = this.contentEl.createDiv({ cls: "vertical-tabs-container" });
    this.navEl = box.createDiv({ cls: "vertical-tab-header" });
    this.tabContentEl = box.createDiv({ cls: "vertical-tab-content-container" });
    const group = (title: string, tabs: SettingTab[]) => {
      if (!tabs.length) return;
      const g = this.navEl!.createDiv({ cls: "vertical-tab-header-group" });
      g.createDiv({ cls: "vertical-tab-header-group-title", text: title });
      const items = g.createDiv({ cls: "vertical-tab-header-group-items" });
      for (const tab of tabs) {
        const item = items.createDiv({ cls: "vertical-tab-nav-item", text: tab.name, attr: { "data-tab": tab.id, role: "tab", tabindex: "0" } });
        item.addEventListener("click", () => { this.openTabById(tab.id); });
        item.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.openTabById(tab.id); } });
      }
    };
    group("Options", this.settingTabs);
    group("Community plugins", this.pluginTabs);
    const all = [...this.settingTabs, ...this.pluginTabs];
    // The tab last looked at, else the first plugin's (the HUD's), else the first one there is.
    const start = all.find((t) => t.id === this.lastId) ?? this.pluginTabs[0] ?? all[0];
    if (start) this.show(start);
  }

  onClose(): void {
    this.activeTab?.hide();
    this.activeTab = null;
    this.navEl = null;
    this.tabContentEl = null;
  }

  /** Opens the window if needed and shows the tab with this id (a plugin's is its manifest id). */
  openTabById(id: string): SettingTab | undefined {
    const tab = [...this.settingTabs, ...this.pluginTabs].find((t) => t.id === id);
    if (!tab) return undefined;
    this.lastId = id;
    if (!this.isOpen) this.open();
    else this.show(tab);
    return tab;
  }

  private show(tab: SettingTab): void {
    if (this.activeTab === tab) return;
    this.activeTab?.hide();
    this.activeTab?.containerEl.remove();
    this.activeTab = tab;
    this.lastId = tab.id;
    for (const item of Array.from(this.navEl?.querySelectorAll<HTMLElement>(".vertical-tab-nav-item") ?? [])) {
      item.toggleClass("is-active", item.dataset.tab === tab.id);
    }
    this.tabContentEl?.appendChild(tab.containerEl);
    tab.display();
  }
}
