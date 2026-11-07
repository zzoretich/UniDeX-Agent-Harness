// The Computer pane's settings (agent-computer D7, D31): brain/config.json, then agenticos.json key by key, the same
// precedence as updatesConfig in ../updater.ts. Defaults mirror brain/scripts/config.default.json.

import fs from "node:fs";
import path from "node:path";

export interface ComputerConfig { enabled: boolean; askTimeoutSec: number }

function readJson(file: string): Record<string, unknown> | null {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")) as unknown; return j && typeof j === "object" ? j as Record<string, unknown> : null; } catch { return null; }
}

export function computerConfig(vault: string | null): ComputerConfig {
  const out: ComputerConfig = { enabled: true, askTimeoutSec: 120 };
  const apply = (c: unknown): void => {
    if (!c || typeof c !== "object") return;
    const o = c as { enabled?: unknown; askTimeoutSec?: unknown };
    if (typeof o.enabled === "boolean") out.enabled = o.enabled;
    if (typeof o.askTimeoutSec === "number" && Number.isFinite(o.askTimeoutSec) && o.askTimeoutSec > 0) out.askTimeoutSec = o.askTimeoutSec;
  };
  if (!vault) return out;
  apply(readJson(path.join(vault, "brain", "config.json"))?.computer);
  apply(readJson(path.join(vault, "agenticos.json"))?.computer);
  return out;
}
