// What the page may ask of the Computer pane (agent-computer D5, D32, R17). A place is `ws:<workspace>` (a folder of
// <vault>/workspaces, which includes Scratch), `vault`, `home` or `dir:<absolute path>` (an existing directory).
// Anything else is refused: no `..`, no slash in a workspace name, no relative path.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ComputerRect } from "../../shared/ipc";

const MAX_BOUND = 10_000;

/** Whether `place` names a computer the pane may show. `vault` is the vault root (null when none is attached). */
export function placeAllowed(place: string, vault: string | null): boolean {
  if (place.length === 0 || place.length > 512 || place.includes("\0")) return false;
  if (place === "home") return true;
  if (place === "vault") return vault !== null;
  if (place.startsWith("ws:")) {
    const name = place.slice(3);
    if (!vault || !name || name === "." || name === ".." || /[/\\]/.test(name) || name.includes("..")) return false;
    // The name must be an entry of the folder exactly as spelled (case-sensitive), as the HUD's placeKey writes it.
    try {
      const root = path.join(vault, "workspaces");
      return fs.readdirSync(root).includes(name) && fs.statSync(path.join(root, name)).isDirectory();
    } catch { return false; }
  }
  if (place.startsWith("dir:")) {
    const dir = place.slice(4);
    // Canonical only (the HUD's placeKey is path.resolve): no `.`, `..`, doubled or trailing slash.
    if (!path.isAbsolute(dir) || path.normalize(dir) !== dir || (dir.length > 1 && dir.endsWith("/"))) return false;
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  }
  return false;
}

const clamp = (n: number): number => Math.min(MAX_BOUND, Math.max(0, n));

/** The pane's rectangle with every number held to 0–10000 (the schema has already required finite numbers). */
export function clampBounds(r: ComputerRect): ComputerRect {
  return { x: clamp(r.x), y: clamp(r.y), width: clamp(r.width), height: clamp(r.height) };
}
