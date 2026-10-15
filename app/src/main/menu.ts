// The app menu. Built from the plugin's own commands once the renderer reports them, so a Workbench release that adds
// a tab or a command shows up here without a change to the app.

import { Menu, shell, type MenuItemConstructorOptions } from "electron";
import { BRAND } from "../shared/brand";
import { HOST_COMMANDS, TOUR_COMMANDS, type CommandInfo, type ThemeSource, type UpdateState } from "../shared/ipc";

const WORKBENCH = "agentic-os:open-workbench";
/** ⌘1 opens the Workbench; ⌘2–⌘9 these eight tabs, a fixed set: a learned key keeps its tab when the rail's order
 *  changes (spec 2026-10-09-rail-sections-code). */
const NUMBERED_TABS = ["todo", "proposals", "notifications", "spaces", "memory", "runs", "routines", "skills"];

/** The HUD's Help commands (tour C12): they live in the Help menu, not under Commands. */
const HELP_IDS: readonly string[] = Object.values(TOUR_COMMANDS);

/** Obsidian hotkey → Electron accelerator ("Mod" is ⌘ on macOS). */
export function accelerator(cmd: CommandInfo): string | undefined {
  const h = cmd.hotkeys?.[0];
  if (!h) return undefined;
  const mods = h.modifiers.map((m) => ({ Mod: "CmdOrCtrl", Ctrl: "Ctrl", Meta: "Cmd", Shift: "Shift", Alt: "Alt" } as Record<string, string>)[m]).filter(Boolean);
  return [...mods, h.key.length === 1 ? h.key.toUpperCase() : h.key].join("+");
}

function tabAccelerator(id: string): string | undefined {
  if (id === WORKBENCH) return "CmdOrCtrl+1";
  if (id === `${WORKBENCH}-settings`) return "CmdOrCtrl+,";
  const i = NUMBERED_TABS.findIndex((t) => id === `${WORKBENCH}-${t}`);
  return i >= 0 ? `CmdOrCtrl+${i + 2}` : undefined;
}

export interface MenuUpdate { state: UpdateState; check: () => void; install: () => void }

/** The app menu's update item: Check for Updates…, what it is doing, or Restart to Update once one is downloaded. */
export function updateItem(u: MenuUpdate): MenuItemConstructorOptions {
  const s = u.state;
  if (s.status === "downloaded") return { label: `Restart to Update${s.version ? ` to ${s.version}` : ""}`, click: () => u.install() };
  if (s.status === "off") return { label: "Check for Updates…", enabled: false, toolTip: s.reason ?? undefined };
  if (s.status === "checking") return { label: "Checking for Updates…", enabled: false };
  if (s.status === "available" || s.status === "downloading") return { label: `Downloading ${s.version ?? "Update"}${s.percent ? ` (${s.percent}%)` : ""}…`, enabled: false };
  return { label: "Check for Updates…", click: () => u.check() };
}

export interface MenuTheme { source: ThemeSource; set: (source: ThemeSource) => void }

/** View ▸ Appearance: follow macOS, or always light or dark (UniDeX D6). */
export function appearanceItem(t: MenuTheme): MenuItemConstructorOptions {
  const choices: Array<[ThemeSource, string]> = [["system", "Match macOS"], ["light", "Light"], ["dark", "Dark"]];
  return { label: "Appearance", submenu: choices.map(([source, label]) => ({ label, type: "radio", checked: t.source === source, click: () => t.set(source) })) };
}

export function buildAppMenu(commands: CommandInfo[], run: (id: string) => void, opts: { dev: boolean; setup?: boolean; update?: MenuUpdate; theme?: MenuTheme }): Menu {
  const item = (id: string, label?: string, accel?: string): MenuItemConstructorOptions => {
    const cmd = commands.find((c) => c.id === id);
    return { label: label ?? cmd?.name ?? id, accelerator: accel ?? (cmd ? accelerator(cmd) : undefined), enabled: !!cmd || id.startsWith("host:"), click: () => run(id) };
  };
  const tabs = commands.filter((c) => c.id === WORKBENCH || c.id.startsWith(`${WORKBENCH}-`))
    .map((c) => item(c.id, c.id === WORKBENCH ? "Workbench" : c.name.replace(/^Open Workbench:\s*/, ""), tabAccelerator(c.id)));
  const others = commands.filter((c) => !c.id.startsWith(WORKBENCH) && !HELP_IDS.includes(c.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => item(c.id));

  const template: MenuItemConstructorOptions[] = [
    {
      label: BRAND.name,
      submenu: [
        { role: "about" },
        ...(opts.update ? [updateItem(opts.update)] : []),
        { type: "separator" },
        item(`${WORKBENCH}-settings`, "Settings…", "CmdOrCtrl+,"),
        item(HOST_COMMANDS.settings, "App Settings…", "CmdOrCtrl+Shift+,"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        item("agentic-os:open-file", "Open File…", "CmdOrCtrl+O"),
        item("agentic-os:search-vault", "Search Vault…", "CmdOrCtrl+Shift+F"),
        { type: "separator" },
        item("agentic-os:quick-capture"),
        item("agentic-os:new-terminal"),
        { type: "separator" },
        item(HOST_COMMANDS.closeTab, "Close Tab", "CmdOrCtrl+W"),
      ],
    },
    // The edit roles are what make ⌘C/⌘V/⌘A work in text fields and the terminal on macOS.
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        item(HOST_COMMANDS.palette, "Command Palette…", "CmdOrCtrl+P"),
        item("agentic-os:open-omnisearch", "Search…", "CmdOrCtrl+K"),
        { type: "separator" },
        ...(tabs.length ? tabs : [{ label: "Workbench", enabled: false } as MenuItemConstructorOptions]),
        { type: "separator" },
        ...(opts.theme ? [appearanceItem(opts.theme), { type: "separator" } as MenuItemConstructorOptions] : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(opts.dev ? [{ type: "separator" } as MenuItemConstructorOptions, { role: "reload" } as MenuItemConstructorOptions, { role: "toggleDevTools" } as MenuItemConstructorOptions] : []),
      ],
    },
    { label: "Commands", submenu: others.length ? others : [{ label: opts.setup ? `Set up ${BRAND.name} first` : "Loading…", enabled: false }] },
    { role: "windowMenu" },
    {
      role: "help",
      // The tour's commands (tour C12): the menu cannot be spotlit, so each opens the in-app tour, checklist or drawer.
      submenu: [
        item(TOUR_COMMANDS.start, "Take the Tour"),
        item(TOUR_COMMANDS.tab, "Tour This Tab"),
        item(TOUR_COMMANDS.whatsNew, "What's New"),
        item(TOUR_COMMANDS.gettingStarted, "Getting Started"),
        { type: "separator" },
        item(TOUR_COMMANDS.docs, `${BRAND.name} Documentation`),
        { label: `${BRAND.name} on GitHub`, click: () => void shell.openExternal("https://github.com/zzoretich/UniDeX-Agent-Harness") },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
