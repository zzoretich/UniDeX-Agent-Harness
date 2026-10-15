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

/** The id tour.launched keeps for a release's What's new card. */
export const whatsNewId = (version: string): string => `whats-new@${version}`;

/** Go local is due while the upgrade left it pending and the card has not been shown on this Mac. */
export function goLocalDue(migrations: Record<string, MigrationRow>, tour: TourState): boolean {
  return migrations["local-first"]?.state === "pending" && !tour.launched.includes("go-local");
}

/**
 * IMPORT — install-import B12, PR 9's second stage: the Import sheet (ui/ImportSheet.ts) is due while the upgrade left
 * `import` pending and tour.launched lacks "import" (the harness pre-marks it already). Off until the sheet exists.
 */
export function importDue(_migrations: Record<string, MigrationRow>, _tour: TourState): boolean {
  return false;
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
