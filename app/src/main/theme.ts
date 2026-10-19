// Light and dark (UniDeX D6). The user's choice (follow macOS, or always light or dark) lives in the app's data,
// <userData>/app-settings.json beside window-state.json. Main hands it to nativeTheme so the window frame, menus,
// scrollbars and the tray popover agree with the page, and tells the page what it resolves to (./ipc/theme.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThemeSource } from "../shared/ipc";

export const THEME_SOURCES: readonly ThemeSource[] = ["system", "light", "dark"];

/** A window's background before the page paints: the tokens' --udx-bg (hud/styles.css). */
export const WINDOW_BG = { light: "#ffffff", dark: "#0b0b0b" } as const;

function file(userData: string): string { return path.join(userData, "app-settings.json"); }

/** The settings file's object, or an empty one when it is missing or not an object. */
function readSettings(userData: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file(userData), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** The saved choice; "system" when there is none or it is not one of the three. */
export function loadThemeSource(userData: string): ThemeSource {
  const t = readSettings(userData).theme;
  return THEME_SOURCES.includes(t as ThemeSource) ? (t as ThemeSource) : "system";
}

/** Saves the choice, keeping whatever else the file holds. Written whole, then renamed into place. */
export function saveThemeSource(userData: string, source: ThemeSource): void {
  const next = { ...readSettings(userData), theme: source };
  fs.mkdirSync(userData, { recursive: true });
  const tmp = `${file(userData)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file(userData));
}

export function windowBackground(dark: boolean): string { return dark ? WINDOW_BG.dark : WINDOW_BG.light; }
