// cron.ts — TypeScript mirror of brain/scripts/lib/cron.js for the Routines tab's live preview
// (parse, next fire times, human cadence). Keep the two in lockstep: the runtime is the source of
// truth for what a schedule means, and this file only exists so the drawer can validate and describe
// an expression before the file is written. Pure (no imports) so node:test can load it.

export interface CronSpec {
  minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>;
  restricted: { dom: boolean; dow: boolean };
  raw: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const LAUNCHD_MAX = 64;
const SEARCH_DAYS = 366;

interface Field { name: keyof Omit<CronSpec, "restricted" | "raw">; min: number; max: number; names?: string[] }
const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "dow", min: 0, max: 7, names: DAYS },
];

export class CronError extends Error {
  constructor(msg: string) { super(msg); this.name = "CronError"; }
}

function atom(token: string, field: Field): number {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  if (field.names) {
    const i = field.names.indexOf(t.slice(0, 3));
    if (i !== -1 && t.length === 3) return i + field.min;
  }
  throw new CronError(`${field.name}: "${token}" is not a number${field.names ? " or a name" : ""}`);
}

function parseField(text: string, field: Field): { set: Set<number>; restricted: boolean } {
  const out = new Set<number>();
  let restricted = false;
  for (const part of String(text).split(",")) {
    if (part === "") throw new CronError(`${field.name}: empty list item`);
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) throw new CronError(`${field.name}: "${part}" is malformed`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new CronError(`${field.name}: step must be ≥ 1`);
    let lo: number, hi: number;
    if (m[1] === "*") { lo = field.min; hi = field.max; }
    else {
      restricted = true;
      const r = m[1].split("-");
      if (r.length > 2) throw new CronError(`${field.name}: "${part}" is malformed`);
      lo = atom(r[0], field);
      hi = r.length === 2 ? atom(r[1], field) : lo;
      if (m[2] !== undefined && r.length === 1) hi = field.max;
    }
    if (lo < field.min || hi > field.max) throw new CronError(`${field.name}: ${lo}-${hi} is outside ${field.min}-${field.max}`);
    if (lo > hi) throw new CronError(`${field.name}: range ${lo}-${hi} runs backwards`);
    for (let v = lo; v <= hi; v += step) out.add(field.name === "dow" && v === 7 ? 0 : v);
  }
  const full = field.name === "dow" ? 7 : field.max - field.min + 1;
  if (out.size === full) restricted = false;
  return { set: out, restricted };
}

export function calendarSize(c: CronSpec): number {
  return c.minute.size * c.hour.size * (c.restricted.dom ? c.dom.size : 1) *
    (c.month.size === 12 ? 1 : c.month.size) * (c.restricted.dow ? c.dow.size : 1);
}

export function parse(expr: string): CronSpec {
  if (typeof expr !== "string") throw new CronError("schedule must be a string");
  const raw = expr.trim().replace(/\s+/g, " ");
  const parts = raw.split(" ");
  if (parts.length !== 5) throw new CronError(`expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  const parsed = FIELDS.map((f, i) => parseField(parts[i], f));
  const out: CronSpec = {
    minute: parsed[0].set, hour: parsed[1].set, dom: parsed[2].set, month: parsed[3].set, dow: parsed[4].set,
    restricted: { dom: parsed[2].restricted, dow: parsed[4].restricted }, raw,
  };
  if (out.restricted.dom && out.restricted.dow) {
    throw new CronError("day-of-month and weekday cannot both be restricted (cron ORs them, launchd ANDs them)");
  }
  const entries = calendarSize(out);
  if (entries > LAUNCHD_MAX) throw new CronError(`expands to ${entries} calendar entries; the limit is ${LAUNCHD_MAX}`);
  return out;
}

/** null when the expression is valid, else the message the runtime would reject it with. */
export function validateCron(expr: string): string | null {
  try { parse(expr); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

function matchesDay(c: CronSpec, d: Date): boolean {
  if (c.month.size !== 12 && !c.month.has(d.getMonth() + 1)) return false;
  if (c.restricted.dom && !c.dom.has(d.getDate())) return false;
  if (c.restricted.dow && !c.dow.has(d.getDay())) return false;
  return true;
}

/** Next `count` fire times strictly after `after`, local time, minute resolution, bounded to a year. */
export function next(expr: string | CronSpec, after: Date = new Date(), count = 1): Date[] {
  const c = typeof expr === "string" ? parse(expr) : expr;
  const out: Date[] = [];
  const floor = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  const hours = sorted(c.hour);
  const minutes = sorted(c.minute);
  for (let i = 0; i < SEARCH_DAYS && out.length < count; i++) {
    const day = new Date(floor.getFullYear(), floor.getMonth(), floor.getDate() + i);
    if (!matchesDay(c, day)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        if (t.getHours() !== h || t.getMinutes() !== m) continue;   // skipped by a DST jump
        if (t <= after) continue;
        out.push(t);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
function times(c: CronSpec): string[] {
  const out: string[] = [];
  for (const h of sorted(c.hour)) for (const m of sorted(c.minute)) out.push(`${pad(h)}:${pad(m)}`);
  return out;
}
const sameSet = (set: Set<number>, arr: number[]) => set.size === arr.length && arr.every((v) => set.has(v));

/** Human cadence for the common shapes; the raw expression otherwise. */
export function describe(expr: string | CronSpec): string {
  let c: CronSpec;
  try { c = typeof expr === "string" ? parse(expr) : expr; } catch { return String(expr); }
  const anyMonth = c.month.size === 12;
  const anyDay = !c.restricted.dom && !c.restricted.dow;
  if (c.hour.size === 24 && anyDay && anyMonth) {
    const m = sorted(c.minute);
    const step = m.length > 1 ? m[1] - m[0] : null;
    if (step && m.every((v, i) => v === m[0] + i * step) && m[0] === 0 && 60 % step === 0) return `Every ${step} minutes`;
    if (m.length === 1) return `Hourly at :${pad(m[0])}`;
  }
  if (c.minute.size === 1 && anyDay && anyMonth && c.hour.size > 1) {
    const h = sorted(c.hour);
    const step = h[1] - h[0];
    if (h.every((v, i) => v === h[0] + i * step) && h[0] === 0 && 24 % step === 0 && sorted(c.minute)[0] === 0) return `Every ${step} hours`;
  }
  if (c.hour.size > 4 || c.minute.size > 4) return c.raw;
  const at = times(c).join(", ");
  if (!anyMonth) return c.raw;
  if (anyDay) return `Every day at ${at}`;
  if (c.restricted.dom) {
    const d = sorted(c.dom);
    return d.length === 1 ? `Monthly on day ${d[0]} at ${at}` : `Monthly on days ${d.join(", ")} at ${at}`;
  }
  const d = sorted(c.dow);
  if (sameSet(c.dow, [1, 2, 3, 4, 5])) return `Weekdays at ${at}`;
  if (sameSet(c.dow, [0, 6])) return `Weekends at ${at}`;
  if (d.length === 1) return `${DAY_NAMES[d[0]]}s at ${at}`;
  return `${d.map((v) => DAY_NAMES[v].slice(0, 3)).join(", ")} at ${at}`;
}

/** Cadence for a launchd StartCalendarInterval array (external plists): the cron shape when it maps, else a summary. */
export function describeCalendar(entries: Array<Record<string, number>>): string {
  if (!entries.length) return "no calendar";
  const pick = (k: string) => new Set(entries.map((e) => e[k]).filter((v) => v !== undefined));
  const minutes = pick("Minute"), hours = pick("Hour"), days = pick("Day"), months = pick("Month"), weekdays = pick("Weekday");
  const f = (s: Set<number>) => (s.size ? sorted(s).join(",") : "*");
  const expr = `${f(minutes)} ${f(hours)} ${f(days)} ${f(months)} ${f(weekdays)}`;
  const out = describe(expr);
  return out === expr ? `${entries.length} calendar entries` : out;
}
