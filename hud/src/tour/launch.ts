// What the launch sequence (ui/launchSequence.ts, tour C11) shows at this launch, decided from what main says
// (firstTime, installed), the migrations the runtime recorded (brain/_index/migrations.json, data/goLocal.ts) and the
// tour's memory (tour.launched, lastSeenVersion). Pure, so node:test can load it.
import type { MigrationRow } from "../data/goLocal";
import type { TourState } from "./state";
import { WHATS_NEW, launchWhatsNew, type WhatsNewRelease } from "./whatsnew";

/** What main says about this launch (app/src/shared/ipc.ts AttachInfo). */
export interface LaunchInfo {
  /** The first time this app opens this vault. */
  firstTime: boolean;
  /** The app's wizard installed it: a new install. */
  installed: boolean;
  /** Its runtime is behind the app's. */
  behind: boolean;
}

/** The steps in order; "checklist" is Getting started at the end. */
export type LaunchStep = "runtime" | "go-local" | "import" | "core-tour" | "whats-new" | "checklist";

/** The id tour.launched keeps for a release's What's new card (per Mac: the release is the app's). */
export const whatsNewId = (version: string): string => `whats-new@${version}`;

/**
 * A short, stable key for a vault path (FNV-1a, 32 bits, as 8 hex digits): the HUD's settings are the app's, one per
 * Mac, while a migration is pending in one vault, so the cards it asks are remembered per vault. The e2e harness
 * computes the same key to pre-mark them.
 */
export function vaultKey(vault: string): string {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(vault)) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** The id tour.launched keeps once this vault's Go-local card was acted on or dismissed. */
export const goLocalId = (vault: string): string => `go-local@${vaultKey(vault)}`;
/** The same for the Import sheet (install-import B12). */
export const importId = (vault: string): string => `import@${vaultKey(vault)}`;

/** Go local is due while the upgrade left it pending in this vault and its card was not acted on or dismissed here. */
export function goLocalDue(migrations: Record<string, MigrationRow>, tour: TourState, vault: string): boolean {
  return migrations["local-first"]?.state === "pending" && !tour.launched.includes(goLocalId(vault));
}

/**
 * The Import sheet (install-import B12) is due while the upgrade left `import` pending in this vault and its sheet was
 * not acted on or dismissed here (the harness pre-marks importId for every other spec).
 */
export function importDue(migrations: Record<string, MigrationRow>, tour: TourState, vault: string): boolean {
  return migrations["import"]?.state === "pending" && !tour.launched.includes(importId(vault));
}

export type Welcome =
  | { kind: "core" }
  | { kind: "whats-new"; line: string; releases: WhatsNewRelease[]; firstTime: boolean };

/** The welcome step (C10): a new install's core tour, else What's new when there is something to show, else none. */
export function welcomeStep(info: LaunchInfo, tour: TourState, version: string, releases: readonly WhatsNewRelease[] = WHATS_NEW.releases): Welcome | null {
  if (info.firstTime && info.installed) return tour.completed.includes("core") ? null : { kind: "core" };
  if (tour.launched.includes(whatsNewId(version))) return null;
  const card = launchWhatsNew(releases, tour.lastSeenVersion, version);
  return card ? { kind: "whats-new", ...card } : null;
}
