// externalSchedules.ts — the read-only "Outside the runtime" rows of the Routines tab (spec D13):
// the Obsidian Git plugin's backup timer (from its data.json) and any launchd label the owner lists
// in `routines.externalLabels` (parsed from ~/Library/LaunchAgents/<label>.plist). Pure parsers over
// text; only readExternalSchedules touches the filesystem. No actions are offered on these rows.
import * as path from "path";
import { describeCalendar } from "./cron";
import { env, fs } from "../host";

export interface ExternalSchedule {
  id: string;             // "obsidian-git" or the launchd label
  name: string;
  cadence: string;
  source: string;         // where it is defined, for the tooltip
  loaded: boolean | null; // launchd: plist present; obsidian-git: timer enabled; null when unknown
}

export const OBSIDIAN_GIT_DATA = ".obsidian/plugins/obsidian-git/data.json";

/** The Obsidian Git timer as a row, or null when the plugin is absent or every timer is off. */
export function parseObsidianGit(raw: string | null): ExternalSchedule | null {
  if (raw == null) return null;
  let d: Record<string, unknown>;
  try { d = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const save = Number(d.autoSaveInterval) || 0;
  const push = Number(d.autoPushInterval) || 0;
  const pull = Number(d.autoPullInterval) || 0;
  const onChange = d.autoBackupAfterFileChange === true;
  const parts: string[] = [];
  if (save > 0) parts.push(`backup every ${save} min${onChange ? " (after a change)" : ""}`);
  if (push > 0) parts.push(`push every ${push} min`);
  if (pull > 0) parts.push(`pull every ${pull} min`);
  if (!parts.length) return null;
  return { id: "obsidian-git", name: "Vault backup", cadence: parts.join(", "), source: `Obsidian Git · ${OBSIDIAN_GIT_DATA}`, loaded: true };
}

/** Minimal plist reader: Label, StartCalendarInterval (dict or array of dicts) and StartInterval. */
export function parseLaunchdPlist(xml: string): { label: string | null; calendar: Array<Record<string, number>>; interval: number | null } {
  const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1] ?? null;
  const interval = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(xml);
  const calendar: Array<Record<string, number>> = [];
  const block = /<key>StartCalendarInterval<\/key>\s*(<array>[\s\S]*?<\/array>|<dict>[\s\S]*?<\/dict>)/.exec(xml)?.[1];
  if (block) {
    const dicts = block.startsWith("<array>") ? [...block.matchAll(/<dict>([\s\S]*?)<\/dict>/g)].map((m) => m[1]) : [block.slice(6, -7)];
    for (const d of dicts) {
      const e: Record<string, number> = {};
      for (const m of d.matchAll(/<key>(Minute|Hour|Day|Month|Weekday)<\/key>\s*<integer>(\d+)<\/integer>/g)) e[m[1]] = Number(m[2]);
      if (Object.keys(e).length) calendar.push(e);
    }
  }
  return { label, calendar, interval: interval ? Number(interval[1]) : null };
}

export function describePlist(p: ReturnType<typeof parseLaunchdPlist>): string {
  if (p.calendar.length) return describeCalendar(p.calendar);
  if (p.interval) return p.interval % 3600 === 0 ? `every ${p.interval / 3600} h` : p.interval % 60 === 0 ? `every ${p.interval / 60} min` : `every ${p.interval} s`;
  return "no schedule (on demand)";
}

export function launchAgentsDir(home = env.homedir()): string { return path.join(home, "Library", "LaunchAgents"); }

/** One row per allow-listed launchd label; a missing plist is reported as not loaded rather than dropped. */
export function readLaunchdRows(labels: string[], dir = launchAgentsDir()): ExternalSchedule[] {
  return labels.filter((l) => typeof l === "string" && /^[A-Za-z0-9._-]+$/.test(l)).map((label) => {
    const file = path.join(dir, `${label}.plist`);
    let xml: string | null = null;
    try { xml = fs.readFileSync(file, "utf8"); } catch { /* absent */ }
    if (xml == null) return { id: label, name: label, cadence: "not loaded (no plist)", source: file, loaded: false };
    const p = parseLaunchdPlist(xml);
    return { id: label, name: p.label ?? label, cadence: describePlist(p), source: file, loaded: true };
  });
}

/** Everything the tab shows under "Outside the runtime". Never throws. */
export function readExternalSchedules(vaultRoot: string, labels: string[], opts: { launchAgents?: string; platform?: string } = {}): ExternalSchedule[] {
  const out: ExternalSchedule[] = [];
  let raw: string | null = null;
  try { raw = fs.readFileSync(path.join(vaultRoot, OBSIDIAN_GIT_DATA), "utf8"); } catch { /* plugin absent */ }
  const git = parseObsidianGit(raw);
  if (git) out.push(git);
  if ((opts.platform ?? env.platform()) === "darwin") out.push(...readLaunchdRows(labels, opts.launchAgents));
  return out;
}
