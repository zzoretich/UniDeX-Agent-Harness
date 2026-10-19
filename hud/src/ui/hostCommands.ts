// Commands the host registers beside the plugin's (the app: app/src/shared/ipc.ts HOST_COMMANDS). The rail's foot runs
// them through the command registry, as the palette does, so the HUD needs no bridge of its own for them.

import type { App } from "obsidian";

/** Switches between light and dark (the app's theme engine). */
export const HOST_TOGGLE_THEME = "host:toggle-theme";
/** The settings window: the app's own tab and the plugin's. */
export const HOST_APP_SETTINGS = "host:settings";

/** Runs a host command; false when this host registered none by that id. */
export function runHostCommand(app: App, id: string): boolean {
  const commands = (app as unknown as { commands?: { executeCommandById?: (id: string) => boolean } }).commands;
  return commands?.executeCommandById?.(id) ?? false;
}
