// App, Plugin, SettingTab and PluginSettingTab. The host builds one App over one vault root and hands it the chrome
// elements (ribbon, status bar); the plugin's commands, views, protocol handlers and settings tab are registered on it.

import { bridge, callError } from "./bridge";
import { Component } from "./events";
import { setIcon } from "./notice";
import { SettingModal } from "./settingModal";
import { Vault } from "./vault";
import { Workspace, type View, type WorkspaceLeaf } from "./workspace";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  dir?: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
  isDesktopOnly?: boolean;
}

export interface Hotkey { modifiers: Array<"Mod" | "Ctrl" | "Meta" | "Shift" | "Alt">; key: string }

export interface Command {
  id: string;
  name: string;
  icon?: string;
  hotkeys?: Hotkey[];
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

export class Commands {
  readonly commands = new Map<string, Command>();
  add(cmd: Command): void { this.commands.set(cmd.id, cmd); }
  list(): Command[] { return [...this.commands.values()]; }
  executeCommandById(id: string): boolean {
    const c = this.commands.get(id);
    if (!c) return false;
    if (c.checkCallback) {
      if (!c.checkCallback(true)) return false;
      c.checkCallback(false);
      return true;
    }
    void c.callback?.();
    return true;
  }
}

export interface AppOptions {
  vaultRoot: string;
  workspaceEl: HTMLElement;
  ribbonEl: HTMLElement;
  statusBarEl: HTMLElement;
}

export class App {
  vault: Vault;
  workspace: Workspace;
  commands = new Commands();
  viewRegistry = new Map<string, (leaf: WorkspaceLeaf) => View>();
  settingTabs: PluginSettingTab[] = [];
  protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();
  ribbonEl: HTMLElement;
  statusBarEl: HTMLElement;
  /** The settings window: the host's tabs and every tab a plugin registered (settingModal.ts). */
  setting: SettingModal;

  constructor(opts: AppOptions) {
    this.vault = new Vault(opts.vaultRoot);
    this.ribbonEl = opts.ribbonEl;
    this.statusBarEl = opts.statusBarEl;
    this.workspace = new Workspace(this, opts.workspaceEl);
    this.setting = new SettingModal(this);
  }

  /** Routes an agenticos:// URL's query to the handler a plugin registered for that action. */
  handleProtocol(action: string, params: Record<string, string>): boolean {
    const h = this.protocolHandlers.get(action);
    if (!h) return false;
    void h({ action, ...params });
    return true;
  }
}

export class Plugin extends Component {
  app: App;
  manifest: PluginManifest;

  constructor(app: App, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  addCommand(command: Command): Command {
    const full = { ...command, id: `${this.manifest.id}:${command.id}` };
    this.app.commands.add(full);
    return full;
  }

  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = this.app.ribbonEl.createDiv({ cls: "side-dock-ribbon-action clickable-icon", attr: { "aria-label": title, title, role: "button", tabindex: "0" } });
    setIcon(el, icon);
    el.addEventListener("click", (e) => void callback(e));
    this.register(() => el.remove());
    return el;
  }

  addStatusBarItem(): HTMLElement {
    const el = this.app.statusBarEl.createDiv({ cls: `status-bar-item plugin-${this.manifest.id}` });
    this.register(() => el.remove());
    return el;
  }

  registerView(type: string, creator: (leaf: WorkspaceLeaf) => View): void {
    this.app.viewRegistry.set(type, creator);
    this.register(() => { this.app.workspace.detachLeavesOfType(type); this.app.viewRegistry.delete(type); });
  }

  addSettingTab(tab: PluginSettingTab): void { this.app.settingTabs.push(tab); }

  registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void {
    this.app.protocolHandlers.set(action, handler);
    this.register(() => this.app.protocolHandlers.delete(action));
  }

  registerExtensions(_exts: string[], _viewType: string): void {}
  registerMarkdownPostProcessor(_fn: unknown): void {}

  /**
   * The plugin's settings, from the app's data folder (main reads <userData>/plugins/<id>.json). Until the app has saved
   * any, the ones Obsidian keeps for this plugin in the vault are read instead (never written), so a vault that ran the
   * HUD in Obsidian opens the same way; the first save gives the app its own copy.
   */
  async loadData(): Promise<unknown> {
    const r = bridge().plugin.loadData(this.manifest.id);
    return r.ok ? r.data : null;
  }

  async saveData(data: unknown): Promise<void> {
    const r = bridge().plugin.saveData(this.manifest.id, `${JSON.stringify(data, null, 2)}\n`);
    if (!r.ok) throw callError(r, `save the ${this.manifest.id} settings`);
  }
}

/** One tab of the settings window: `display()` draws it into containerEl when shown, `hide()` clears it. */
export class SettingTab {
  app: App;
  containerEl: HTMLElement;
  id = "";
  name = "";

  constructor(app: App) {
    this.app = app;
    this.containerEl = createDiv({ cls: "vertical-tab-content" });
  }

  display(): void {}
  hide(): void { this.containerEl.empty(); }
}

/** A plugin's tab, named after the plugin as in Obsidian's Community plugins list. */
export class PluginSettingTab extends SettingTab {
  plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    super(app);
    this.plugin = plugin;
    this.id = plugin.manifest.id;
    this.name = plugin.manifest.name;
  }
}
