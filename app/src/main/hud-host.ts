// The app's record in the vault (spec 2026-10-05-workbench-app-design D11): <vault>/brain/_index/hud-host.json, which
// `aos doctor` and the update check read through brain/scripts/lib/hud-host.js. Main writes it each time the app starts
// with a vault, so the runtime sees which app version the vault is used with without knowing where the app is
// installed. brain/_index is the runtime's cache folder: nothing a person writes lives there.

import * as fs from "node:fs";
import * as path from "node:path";

export const HUD_HOST_REL = "brain/_index/hud-host.json";

export interface HudHostMarker { schema: 1; host: "app"; name: string; version: string; at: string; computerSocket?: string }

/**
 * Writes the marker atomically: a temp file in the same folder, then a rename, so a reader (a hook, doctor) sees the
 * whole old file or the whole new one, never a partial write. Returns the marker's path.
 */
export function writeHudHostMarker(vault: string, info: { name: string; version: string; computerSocket?: string }, now: Date = new Date()): string {
  const file = path.join(vault, HUD_HOST_REL);
  const marker: HudHostMarker = { schema: 1, host: "app", name: info.name, version: info.version, at: now.toISOString() };
  // agent-computer D26: where the computer bridge listens, once it does; the agenticos MCP server reads it back.
  if (info.computerSocket) marker.computerSocket = info.computerSocket;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
  return file;
}
