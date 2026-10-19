// Page entry: builds the Obsidian-compatible App over the vault, then constructs and loads the real Workbench plugin
// from ../hud, exactly as Obsidian would. The page is sandboxed with no Node (phase 4): it reaches main only
// through window.aos (src/preload), and the HUD's own I/O goes through the bridge host installed here before the plugin
// loads. Main feeds it vault changes, menu commands and agenticos:// links.

import { App, Notice, guardState, setBridge, setMarkdownHost, setWriteGuard, type PluginManifest } from "obsidian";
import AgenticOSPlugin from "@workbench/hud";
import { version as hudVersion } from "@workbench/hud-package";
import { setHudHost } from "../../../hud/src/host";
import { HOST_COMMANDS, type AosBridge, type ProtocolRequest, type ReadyInfo, type WriteSource } from "../shared/ipc";
import { AppSettingTab } from "./appSettingTab";
import { createBridgeHost } from "./bridgeHost";
import { PagePolicy } from "./pagePolicy";
import { attachUi } from "./setup/attach";
import { runSetup } from "./setup/wizard";
import { openPopover } from "./popover";
import { CommandPalette } from "./palette";
import { PageTheme, applyTheme } from "./theme";

/**
 * The HUD as a plugin, the manifest Obsidian read from its plugin folder. The id keys the HUD's settings
 * (<userData>/plugins/agentic-os.json, first copied from an Obsidian-era <vault>/.obsidian/plugins/agentic-os/data.json),
 * its command ids and its CSS class, so it never changes; the name is its tab in the settings window. No `dir`: the HUD
 * keeps no files of its own beside its settings, which main stores.
 */
const HUD: PluginManifest = { id: "agentic-os", name: "Runtime", version: hudVersion };

/**
 * The status bar's first item, shown only while $AOS_APP_WRITE narrows the writes (tests, one-off runs): READ-ONLY, or
 * which surfaces may write, with what each one writes on hover. By default every surface writes and the item is hidden.
 */
function showWriteMode(el: HTMLElement, policy: PagePolicy, source: WriteSource): void {
  el.toggleClass("is-hidden", source === "default");
  const on = policy.surfaces;
  el.toggleClass("is-writing", on.length > 0);
  el.setText(on.length ? `WRITES: ${on.map((s) => s.label).join(", ")}` : "READ-ONLY");
  const what = (s: PagePolicy["surfaces"][number]): string =>
    [...new Set([...s.writes, ...s.spawns.map((r) => r.script ?? r.bin)])].join(", ") + (s.except?.length ? ` (not ${s.except.join(", ")})` : "");
  el.setAttr("title", on.length
    ? `${on.map((s) => `${s.label}: ${what(s)}`).join("\n")}\nEverything else is refused for this run (AOS_APP_WRITE); the runtime's own background refreshes still run.`
    : "Content writes are refused for this run (AOS_APP_WRITE); the runtime's own background refreshes still run.");
}

async function boot(): Promise<void> {
  const aos = (window as unknown as { aos?: AosBridge }).aos;
  if (!aos) throw new Error("The app's bridge to the main process is missing (the preload did not run).");
  const info = aos.boot();
  const root = document.getElementById("app")!;
  if (!info) throw new Error("The main process did not answer the boot request.");
  // Light or dark before anything is drawn, the wizard included; main says when it changes.
  const theme = new PageTheme(aos, info.theme);
  theme.track(document);
  // Before the plugin loads: the compat layer's and the HUD's every file, process and OS call go to main from here on.
  setBridge(aos);
  const bridgeHost = createBridgeHost(aos, info);
  setHudHost(bridgeHost.host);
  const policy = new PagePolicy(info.vaultRoot, info.writeSurfaces);
  setWriteGuard(policy);

  // No vault: the first-run wizard (phase 5), which ends by asking main to attach the vault it installed.
  if (!info.vaultRoot) {
    runSetup(root, aos, info);
    return;
  }

  const shellEl = root.createDiv({ cls: "aos-host" });
  const ribbonEl = shellEl.createDiv({ cls: "aos-host-ribbon" });
  const workspaceEl = shellEl.createDiv();
  const statusBarEl = root.createDiv({ cls: "aos-host-status status-bar" });
  const modeEl = statusBarEl.createDiv({ cls: "status-bar-item aos-host-mode" });
  showWriteMode(modeEl, policy, info.writeSource);

  const app = new App({
    vaultRoot: info.vaultRoot,
    workspaceEl,
    ribbonEl,
    statusBarEl,
  });
  setMarkdownHost(app);

  const plugin = new AgenticOSPlugin(app, HUD);
  await plugin.load();
  app.workspace.markLayoutReady();

  // The settings window: the app's own tab beside the one the plugin registered. It opens from the Workbench rail's
  // foot (App settings), UniDeX ▸ App Settings… (⌘⇧,) and the palette; ⌘, stays the Workbench's Settings
  // tab. The ribbon is hidden (UniDeX D3): the rail runs these two commands.
  app.setting.addSettingTab(new AppSettingTab(app, {
    vaultRoot: info.vaultRoot, vaultSource: info.vaultSource, userData: info.userData, appVersion: info.appVersion,
    hudVersion: HUD.version, electron: info.electron, policy: () => policy, writeSource: () => info.writeSource, aos, theme,
  }));
  const openSettings = (): void => { if (!app.setting.isOpen) app.setting.open(); };
  app.commands.add({ id: HOST_COMMANDS.settings, name: "Open app settings", callback: openSettings });
  // Light and dark: one click flips what shows now (App settings and View ▸ Appearance can go back to Match macOS).
  app.commands.add({ id: HOST_COMMANDS.toggleTheme, name: "Toggle light and dark", callback: () => theme.toggle() });

  app.vault.startWatching(info.mainWatcher ? (onPaths) => bridgeHost.onVaultChanges(onPaths) : undefined);

  // One keypress could reach both the page's listener below and a menu accelerator. The same command arriving by the
  // other route within 250 ms is that same keypress and is dropped; repeats by one route always run.
  let last: { id: string; via: "key" | "menu" | "app"; at: number } = { id: "", via: "app", at: 0 };
  const runCommand = (id: string, via: "key" | "menu" | "app" = "app"): void => {
    const now = performance.now();
    const echo = id === last.id && via !== "app" && last.via !== "app" && via !== last.via && now - last.at < 250;
    last = { id, via, at: now };
    if (echo) return;
    if (id === HOST_COMMANDS.palette) new CommandPalette(app, (next) => runCommand(next)).open();
    else if (id === HOST_COMMANDS.closeTab) app.workspace.activeLeaf?.detach();
    else if (!app.commands.executeCommandById(id)) new Notice(`Unknown command: ${id}`);
  };

  const routeLink = (req: ProtocolRequest): void => {
    if (req.action === "workbench") app.handleProtocol("agenticos", req.params);
    else if (req.action === "note" && req.params.file) void app.workspace.openLinkText(req.params.file, "", true);
    else if (!app.handleProtocol(req.action, req.params)) new Notice(`Unknown link: agenticos://${req.action}`);
  };

  // Chromium offers ⌘-key presses to the page before the app menu; a handled one (preventDefault) never reaches the
  // menu, so the plugin's hotkeys, ⌘K and ⌘P fire once whether the key comes from the keyboard or from a test driver.
  // Everything else (⌘1–⌘9, ⌘W, ⌘,) falls through to the menu's accelerators.
  const hotkeys: Array<{ id: string; mod: boolean; shift: boolean; alt: boolean; key: string }> = [
    { id: "agentic-os:open-omnisearch", mod: true, shift: false, alt: false, key: "k" },
    { id: HOST_COMMANDS.palette, mod: true, shift: false, alt: false, key: "p" },
    ...app.commands.list().flatMap((c) => (c.hotkeys ?? []).map((h) => ({
      id: c.id, mod: h.modifiers.includes("Mod"), shift: h.modifiers.includes("Shift"), alt: h.modifiers.includes("Alt"), key: h.key.toLowerCase(),
    }))),
  ];
  window.addEventListener("keydown", (e) => {
    const hit = hotkeys.find((h) => h.mod === e.metaKey && h.shift === e.shiftKey && h.alt === e.altKey && !e.ctrlKey && e.key.toLowerCase() === h.key);
    if (!hit) return;
    e.preventDefault();
    runCommand(hit.id, "key");
  });

  aos.onCommand((id) => runCommand(id, "menu"));
  aos.onProtocol((req) => routeLink(req));

  runCommand("agentic-os:open-workbench");

  const ready: ReadyInfo = {
    commands: app.commands.list().map((c) => ({ id: c.id, name: c.name, hotkeys: c.hotkeys?.map((h) => ({ modifiers: [...h.modifiers], key: h.key })) })),
  };
  aos.ready(ready);

  // Attach mode (phase 5): the app's own update in the status bar, then the launch sequence (tour C11): the runtime
  // update when this app carries a newer one, Go local, What's new or the welcome tour, Getting started.
  const launchLog = attachUi(app, plugin, aos, info.attach, statusBarEl);

  // The tray popover (hidden until the menubar icon is clicked): the plugin's SidebarHUD in a window of its own.
  void openPopover(app).then((child) => { if (child) theme.track(child.document); })
    .catch((err: unknown) => console.warn("[host] tray popover unavailable", err));

  // A handle for the Playwright suites and for poking at the host from DevTools.
  (window as unknown as { aosHost: unknown }).aosHost = { app, plugin, info, guard: guardState(), runCommand, routeLink, launchLog };
  console.info(`[host] AgenticOS HUD ${HUD.version} loaded on Electron ${info.electron}; writes ${policy.ids.join(",") || "none"} (${info.writeSource}); main watcher ${info.mainWatcher}`);
}

boot().catch((err: unknown) => {
  console.error("[host] boot failed", err);
  // A boot that failed before main answered: draw the error in macOS's own appearance.
  if (!/\btheme-(light|dark)\b/.test(document.body.className)) {
    applyTheme(document, { source: "system", dark: window.matchMedia("(prefers-color-scheme: dark)").matches });
  }
  const pre = document.body.createEl("pre", { cls: "aos-host-fatal" });
  pre.setText(err instanceof Error ? err.stack ?? err.message : String(err));
});
