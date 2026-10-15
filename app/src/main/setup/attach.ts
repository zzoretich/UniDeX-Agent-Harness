// Attach mode (phase 5, I5): what the app remembers about the vaults it has opened, in its own data folder
// (<userData>/attach.json, nothing in the vault), so the first-launch UI shows once per vault; which vaults its own
// wizard installed (they get the tour, not the "What changed" note: tour C10); and whether the vault's runtime is behind
// the one the app carries.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AttachInfo } from "../../shared/ipc";
import { cmpVersion } from "./payload";

interface AttachRecord { vaults: Record<string, { firstAt: string; notedAt?: string; installedAt?: string }> }

const file = (userData: string): string => path.join(userData, "attach.json");

function read(userData: string): AttachRecord {
  try {
    const j = JSON.parse(fs.readFileSync(file(userData), "utf8")) as AttachRecord;
    return j && typeof j.vaults === "object" && j.vaults ? j : { vaults: {} };
  } catch { return { vaults: {} }; }
}

function write(userData: string, rec: AttachRecord): void {
  fs.mkdirSync(userData, { recursive: true });
  const tmp = `${file(userData)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  fs.renameSync(tmp, file(userData));
}

export interface AgenticosFacts {
  version?: unknown;
  hosts?: { claude?: { enabled?: unknown }; codex?: { enabled?: unknown } };
}

/** Which hosts agenticos.json enables; a config from before `hosts` existed is a Claude-only install (cli/aos.js hostsOf). */
export function hostsOf(cfg: AgenticosFacts | null): { claude: boolean; codex: boolean } {
  const h = cfg?.hosts;
  if (!h || typeof h !== "object") return { claude: true, codex: false };
  return { claude: !!h.claude?.enabled, codex: !!h.codex?.enabled };
}

/** Records the vault the first time it is seen and says what attach mode shows. */
export function attachInfo(userData: string, vault: string, cfg: AgenticosFacts | null, payloadVersion: string | null, now: Date = new Date()): AttachInfo {
  const rec = read(userData);
  const key = path.resolve(vault);
  if (!rec.vaults[key]) {
    rec.vaults[key] = { firstAt: now.toISOString() };
    try { write(userData, rec); } catch { /* the note shows again next time */ }
  }
  const runtimeVersion = typeof cfg?.version === "string" ? cfg.version : null;
  return {
    firstTime: !rec.vaults[key].notedAt,
    installed: !!rec.vaults[key].installedAt,
    runtimeVersion,
    payloadVersion,
    behind: cmpVersion(runtimeVersion, payloadVersion) === -1,
    hosts: hostsOf(cfg),
  };
}

/** The wizard's `aos init` finished in `vault`: a brand-new install. */
export function markInstalled(userData: string, vault: string, now: Date = new Date()): void {
  const rec = read(userData);
  const key = path.resolve(vault);
  rec.vaults[key] = { ...(rec.vaults[key] ?? { firstAt: now.toISOString() }), installedAt: now.toISOString() };
  write(userData, rec);
}

export function markNoted(userData: string, vault: string, now: Date = new Date()): void {
  const rec = read(userData);
  const key = path.resolve(vault);
  rec.vaults[key] = { ...(rec.vaults[key] ?? { firstAt: now.toISOString() }), notedAt: now.toISOString() };
  write(userData, rec);
}
