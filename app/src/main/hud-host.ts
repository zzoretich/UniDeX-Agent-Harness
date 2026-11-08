// The app's record in the vault (spec 2026-10-05-workbench-app-design D11): <vault>/brain/_index/hud-host.json, which
// `aos doctor` and the update check read through brain/scripts/lib/hud-host.js. Main writes it each time the app starts
// with a vault, so the runtime sees which app version the vault is used with without knowing where the app is
// installed. brain/_index is the runtime's cache folder: nothing a person writes lives there.

import * as fs from "node:fs";
import * as path from "node:path";

export const HUD_HOST_REL = "brain/_index/hud-host.json";

export interface HudHostMarker { schema: 1; host: "app"; name: string; version: string; at: string; pid?: number; computerSocket?: string; computer?: "off" | "failed" }

/** What the marker says of the app: its name and version; the pid of its main process, so a reader can tell a marker a
 *  crash left behind; and the Computer pane's state (agent-computer D26): where its bridge listens, or that its surface
 *  is off, or that it is on but its bridge did not start. */
export interface HudHostInfo { name: string; version: string; pid?: number; computerSocket?: string; computerOff?: boolean; computerFailed?: boolean }

/**
 * Writes the marker atomically: a temp file in the same folder, then a rename, so a reader (a hook, doctor) sees the
 * whole old file or the whole new one, never a partial write. Returns the marker's path.
 */
export function writeHudHostMarker(vault: string, info: HudHostInfo, now: Date = new Date()): string {
  const file = path.join(vault, HUD_HOST_REL);
  const marker: HudHostMarker = { schema: 1, host: "app", name: info.name, version: info.version, at: now.toISOString() };
  if (typeof info.pid === "number" && Number.isInteger(info.pid) && info.pid > 0) marker.pid = info.pid;
  // agent-computer D26: where the computer bridge listens, once it does; the agenticos MCP server reads it back.
  if (info.computerSocket) marker.computerSocket = info.computerSocket;
  // The Computer surface is off for this run, so no bridge listens: the MCP server says the pane is off, not that the
  // app is missing. The surfaces are fixed while the app runs.
  else if (info.computerOff) marker.computer = "off";
  // On, but the bridge did not start (no peer addon, no socket path, a failed listen): the tools say so.
  else if (info.computerFailed) marker.computer = "failed";
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
