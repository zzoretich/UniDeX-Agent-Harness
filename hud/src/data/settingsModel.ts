// settingsModel.ts — the Settings tab's logic (spec 2026-09-24-settings-tab). Pure: the tab renders what
// `aos config list --json` returns (D2) and writes through `aos config set|unset` (D3); everything it decides between
// those two calls lives here so node:test covers it. The runtime schema (brain/scripts/lib/settings-schema.js) owns
// the keys, types, bounds and sources — nothing here names a key except the master switches (D5) and the confirm rules
// (D6), both of which fall back to doing nothing for a key they do not know.
import type { SessionHost } from "./aosConfig";

export type SettingType = "bool" | "enum" | "number" | "string" | "model" | "list" | "object";
export type Source = "machine" | "vault" | "default" | "unset";

export interface ConfigRow {
  key: string; section: string; label: string; help: string; type: SettingType;
  values: (string | boolean)[] | null; min: number | null; gt: number | null; max: number | null; int: boolean; nullable: boolean;
  risk: "spend" | "autonomy" | "privacy" | null; applies: string; readonly: boolean; how: string | null; host: SessionHost | null;
  default: unknown; value: unknown; source: Source; changed: boolean; note: string | null; spentToday: number | null;
  // Picker presets, chips and edit buttons (spec 2026-09-24-settings-pickers); null from a runtime older than 0.19.
  choices?: unknown[] | null; unit?: string | null; pick?: "many" | null; editIn?: "file" | "skills" | "agents" | null;
}
export interface ConfigSection { id: string; label: string }
export interface ConfigList { schema: 1; files: { machine: string; vault: string }; sections: ConfigSection[]; settings: ConfigRow[] }
export interface FollowUp { command: string; why: string }
export interface SetResult { key: string; old: unknown; value: unknown; file: string | null; source: string; dryRun: boolean; effects: string[]; followUps: FollowUp[] }

/** `aos config list --json` → the list, or null when the body is not that shape (an older or broken runtime). */
export function parseConfigList(body: unknown): ConfigList | null {
  const b = body as Partial<ConfigList> | null;
  if (!b || b.schema !== 1 || !Array.isArray(b.sections) || !Array.isArray(b.settings) || !b.files) return null;
  if (!b.settings.every((r) => r && typeof r.key === "string" && typeof r.section === "string" && typeof r.type === "string")) return null;
  return b as ConfigList;
}

/** Sections in the runtime's order, each with its rows; a section with no row is dropped. */
export function groupBySection(list: ConfigList): { section: ConfigSection; rows: ConfigRow[] }[] {
  return list.sections
    .map((section) => ({ section, rows: list.settings.filter((r) => r.section === section.id) }))
    .filter((g) => g.rows.length > 0);
}

export function changedCount(list: ConfigList): number { return list.settings.filter((r) => r.changed).length; }

// ── master switches (D5) ────────────────────────────────────────────────────────────────────────────────────────────

export interface MasterSwitch { key: string; label: string; isOn(value: unknown): boolean; valueFor(on: boolean): unknown }
const flag = (key: string, label: string): MasterSwitch => ({ key, label, isOn: (v) => v === true, valueFor: (on) => on });

export const MASTER_SWITCHES: MasterSwitch[] = [
  { key: "provider", label: "Background AI", isOn: (v) => v !== "none", valueFor: (on) => (on ? "auto" : "none") },
  flag("persona.enabled", "Chief of Staff"),
  flag("routines.enabled", "Routines"),
  flag("graph.enabled", "Knowledge graph"),
  flag("crossReview.enabled", "Cross-review"),
  flag("cost.enabled", "Session costing"),
  flag("telemetry.enabled", "Telemetry"),
  flag("updates.check", "Update checks"),
  flag("skills.sync", "Skill sharing"),
  flag("agents.sync", "Agent sharing"),
];

/** The switches whose key the runtime listed, with their row and state; an unknown key is skipped, never faked. */
export function masterRows(list: ConfigList): { sw: MasterSwitch; row: ConfigRow; on: boolean }[] {
  const byKey = new Map(list.settings.map((r) => [r.key, r]));
  return MASTER_SWITCHES.flatMap((sw) => {
    const row = byKey.get(sw.key);
    return row ? [{ sw, row, on: sw.isOn(row.value) }] : [];
  });
}

// ── values ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function sameValue(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** A value as `aos config set <key> <value>` takes it: strings as typed, null as `null`, the rest as JSON. */
export function valueArg(v: unknown): string { return typeof v === "string" ? v : v === null ? "null" : JSON.stringify(v); }

// ── controls (spec 2026-09-24-settings-pickers): a toggle, a picker, chips or a button — never a text box ──────────

export type Control = "toggle" | "picker" | "stepper" | "chips" | "button" | "readonly";

/** How a row is edited. A runtime that sends no presets (0.18) leaves those rows read-only with an upgrade hint. */
export function controlFor(row: ConfigRow): Control {
  if (row.readonly) return "readonly";
  if (row.editIn) return "button";
  if (row.type === "bool") return "toggle";
  if (row.type === "enum") return "picker";
  if (!Array.isArray(row.choices) || !row.choices.length) return "readonly";
  if (row.pick === "many") return "chips";
  return row.type === "number" ? "stepper" : "picker";
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const UNIT_LABEL: Record<string, (n: number) => string> = {
  min: (n) => `${n} min`, h: (n) => `${n} h`, days: (n) => plural(n, "day", "days"), s: (n) => `${n} s`, ms: (n) => `${n} ms`, px: (n) => `${n} px`,
  files: (n) => plural(n, "file", "files"), notes: (n) => plural(n, "note", "notes"), tokens: (n) => plural(n, "token", "tokens"), lines: (n) => plural(n, "line", "lines"),
};

/** A preset as the picker shows it: "$0.50", "$0 — no spend", "45 min", "host default", or the value itself. */
export function choiceLabel(row: Pick<ConfigRow, "unit" | "min">, v: unknown): string {
  if (v === null) return row.unit === "usd" ? "none" : "host default";
  if (typeof v === "number" && row.unit === "usd") return v === 0 && row.min === 0 ? "$0 — no spend" : `$${v.toFixed(2)}`;
  if (typeof v === "number" && row.unit && UNIT_LABEL[row.unit]) return UNIT_LABEL[row.unit](v);
  return valueArg(v);
}

export interface PickOption { key: string; value: unknown; label: string; custom: boolean }

/**
 * The picker's options: null ("host default" / "none") first when the row is nullable, then the presets (or an enum's
 * values), and the current value marked "(custom)" when it is none of them — so opening the tab never hides or
 * rewrites a value set by hand (D3). Numbers are kept in order with the custom value slotted in.
 */
export function pickerOptions(row: ConfigRow): PickOption[] {
  const base = (row.type === "enum" ? row.values : row.choices) ?? [];
  const opt = (value: unknown, custom = false): PickOption => ({ key: valueArg(value), value, label: `${choiceLabel(row, value)}${custom ? " (custom)" : ""}`, custom });
  const out = base.map((v) => opt(v));
  if (!out.some((o) => sameValue(o.value, row.value)) && row.value !== null && row.value !== undefined) {
    const custom = opt(row.value, true);
    const at = typeof row.value === "number" ? out.findIndex((o) => typeof o.value === "number" && o.value > (row.value as number)) : -1;
    if (at === -1) out.push(custom); else out.splice(at, 0, custom);
  }
  if (row.nullable && !out.some((o) => o.value === null)) out.unshift(opt(null));
  return out;
}

/** D9: the next preset below (-1) or above (+1) `current`, from a custom value the nearest one on that side; null at the ends. */
export function stepIn(presets: number[], current: unknown, dir: -1 | 1): number | null {
  const sorted = [...new Set(presets)].sort((a, b) => a - b);
  if (typeof current !== "number") return dir === 1 ? sorted[0] ?? null : null;
  const next = dir === 1 ? sorted.find((n) => n > current) : [...sorted].reverse().find((n) => n < current);
  return next === undefined ? null : next;
}
export function stepValue(row: ConfigRow, dir: -1 | 1): number | null {
  return stepIn((row.choices ?? []).filter((v): v is number => typeof v === "number"), row.value, dir);
}

/** The items a chips row currently has on: a list as is, a comma string split (routines.tools). */
export function manySelected(row: ConfigRow): string[] {
  if (Array.isArray(row.value)) return row.value.map(String);
  return typeof row.value === "string" ? row.value.split(",").map((t) => t.trim()).filter(Boolean) : [];
}
/** The chips to show: the presets, then any item that is on but not a preset (kept, never dropped). */
export function manyOptions(row: ConfigRow): string[] {
  const presets = (row.choices ?? []).map(String);
  return [...presets, ...manySelected(row).filter((x) => !presets.includes(x))];
}
/** The row's new value after turning `item` on or off, in the chips' order, as the type it is stored as. */
export function toggleMany(row: ConfigRow, item: string, on: boolean): string[] | string {
  const chosen = new Set(manySelected(row));
  if (on) chosen.add(item); else chosen.delete(item);
  const next = manyOptions(row).filter((x) => chosen.has(x));
  if (on && !next.includes(item)) next.push(item);
  return row.type === "list" ? next : next.join(",");
}

/** What a read-only row shows: the value as text (a list joined), "not set" when absent. */
export function readonlyText(row: ConfigRow): string {
  if (row.value === null || row.value === undefined || row.value === "") return "not set";
  if (Array.isArray(row.value)) return row.value.length ? row.value.map(String).join(", ") : "none";
  return typeof row.value === "object" ? `${Object.keys(row.value as object).length} entries` : choiceLabel(row, row.value);
}

// ── confirmations (D6) ──────────────────────────────────────────────────────────────────────────────────────────────

export interface Confirm { title: string; message: string; cta: string }

const PAID_PROVIDERS = new Set(["auto", "claude", "codex"]);
function money(key: string, v: unknown): string {
  if (typeof v !== "number") return valueArg(v);
  return /Usd$/.test(key) ? `$${v.toFixed(2)}` : String(v);
}

/**
 * Whether changing `row` to `next` needs a yes first, and what to say. Only changes that raise spend, widen autonomy or
 * store more data ask; lowering a cap, turning something off and every other edit go straight through.
 */
export function confirmFor(row: ConfigRow, next: unknown): Confirm | null {
  if (sameValue(row.value, next)) return null;
  if (row.key === "provider") {
    if (PAID_PROVIDERS.has(String(next)) && !PAID_PROVIDERS.has(String(row.value))) {
      const who = next === "claude" ? "your Claude login" : next === "codex" ? "your Codex login" : "your Claude or Codex login";
      return { title: "Turn on paid background calls?", message: `provider ${valueArg(row.value)} → ${valueArg(next)}: background work may spend on ${who}, up to the daily caps (claude.perDayUsd, codex.perDayUsd).`, cta: "Turn on" };
    }
    return null;
  }
  if (row.risk === "spend") {
    if (row.type === "number" && typeof next === "number" && typeof row.value === "number" && next > row.value) {
      return { title: `Raise ${row.label}?`, message: `${row.key}: ${money(row.key, row.value)} → ${money(row.key, next)}.`, cta: "Raise" };
    }
    if ((row.type === "bool" || row.type === "enum") && row.value === false && (next === true || next === "auto")) {
      return { title: `Turn on ${row.label}?`, message: `${row.key} spends on your model login. ${row.help}`, cta: "Turn on" };
    }
    return null;
  }
  if (row.risk === "autonomy") {
    if (row.type === "bool" && next === true) return { title: `Turn on ${row.label}?`, message: `${row.key}: agents act on their schedule without asking each time. ${row.help}`, cta: "Turn on" };
    if (row.type === "number" && typeof next === "number" && typeof row.value === "number" && next < row.value) {
      return { title: `Lower ${row.label}?`, message: `${row.key}: ${row.value} → ${next}. ${row.help}`, cta: "Lower" };
    }
    if (row.type === "string") return { title: `Change ${row.label}?`, message: `${row.key}: ${valueArg(row.value)} → ${valueArg(next)}. ${row.help}`, cta: "Change" };
    return null;
  }
  if (row.risk === "privacy" && next === false) return { title: `Turn off ${row.label}?`, message: `${row.key}: ${row.help}`, cta: "Turn off" };
  return null;
}

// ── labels ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const APPLIES: Record<string, string> = {
  "next-call": "applies at the next model call", "next-session": "applies from the next session", "next-scan": "applies at the next scan",
  "next-reply": "applies from the next reply",
  "next-duty": "applies at the next duty", "next-routine": "applies at the next routine run", "next-sync": "applies at the next sync",
  "next-check": "applies at the next update check", "next-render": "applies at the next status line refresh",
  "next-connectors-check": "applies at the next Connectors check",
  "next-install": "applies at the next aos statusline install", reinstall: "changes only through the installer",
};
export function appliesLabel(applies: string): string { return APPLIES[applies] ?? `applies: ${applies}`; }

const SOURCES: Record<Source, string> = { machine: "this machine", vault: "this vault", default: "default", unset: "not set" };
export function sourceLabel(s: Source): string { return SOURCES[s] ?? s; }
/** The pill's tooltip: which file holds the value. */
export function sourceTitle(s: Source, files: ConfigList["files"]): string {
  if (s === "machine") return `set in ${files.machine}`;
  if (s === "vault") return `set in ${files.vault}`;
  return s === "default" ? "the shipped default (neither file sets it)" : "not in agenticos.json";
}

/** D7: "today $0.12 of $0.50" on a daily cap; null on every other row or when the runtime sent no total. */
export function spendLine(row: ConfigRow): string | null {
  if (row.spentToday === null || typeof row.value !== "number") return null;
  if (row.value === 0) return `today $${row.spentToday.toFixed(2)} · no spend allowed`;
  return `today $${row.spentToday.toFixed(2)} of $${row.value.toFixed(2)}`;
}

const HOST_NAME: Record<SessionHost, string> = { claude: "Claude Code", codex: "Codex" };
/** D8: a host-specific row on a machine where that host is off — still editable, dimmed, with the way to turn it on
 *  (install-import B2: Settings ▸ Hosts' Add, or `aos hosts add`). */
export function hostNote(row: ConfigRow, hosts: SessionHost[]): string | null {
  if (!row.host || hosts.includes(row.host)) return null;
  return `${HOST_NAME[row.host]} is off on this machine; Add ${HOST_NAME[row.host]} under Hosts (\`aos hosts add ${row.host}\`) turns it on`;
}

/** The Notice after a write: the change, then what it did. */
export function resultSummary(r: SetResult): string {
  const head = `${r.key}: ${valueArg(r.old)} → ${valueArg(r.value)}`;
  return r.effects.length ? `${head}\n${r.effects.join("\n")}` : head;
}

// ── follow-ups (D9) ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Steps a write left for the user (`next:` lines), kept until run; the ⚙ badge counts them. */
export class FollowUps {
  private items = new Map<string, string>();
  add(list: FollowUp[] | undefined): void { for (const f of list ?? []) if (argsFor(f.command)) this.items.set(f.command, f.why); }
  remove(command: string): void { this.items.delete(command); }
  list(): FollowUp[] { return [...this.items].map(([command, why]) => ({ command, why })); }
  get size(): number { return this.items.size; }
}

/** `aos routines sync` → ["routines", "sync"]; anything that is not a plain `aos <words>` command is never run. */
export function argsFor(command: string): string[] | null {
  const m = /^aos((?: [a-z][a-z-]*)+)$/.exec(command.trim());
  return m ? m[1].trim().split(" ") : null;
}
