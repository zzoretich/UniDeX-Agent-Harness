// Session browsers' records (session-browser S6, S7, §4.1): per session key, whether its browser was on, its tabs'
// addresses and which tab was active, so a quit and a relaunch bring each browser back. Tab addresses are stored with a
// user name and password removed, otherwise as they are, like the profile's own history; this file stays in main and is
// never sent anywhere. Scrubbing happens where an address is given to an agent, which is not this module's job.
// Stored at <file>, written 0600 by temp file and rename. A key is opaque here except for three prefixes: `code:` (a
// Code terminal's session, alive only while its page lives), `chat:` (a Sessions thread, stable across runs) and
// `orphan:` (what orphanCode() makes of a code record: kept by conversation so a resumed conversation can adopt it).

import fs from "node:fs";
import path from "node:path";
import { navAllowed, withoutUserinfo } from "../policy/computer-url";

export interface Conversation { host: "claude" | "codex"; id: string }
export interface BrowserRecord { on: boolean; tabs: string[]; active: number; conversation?: Conversation; at: number }

export const ORPHAN_DAYS = 30;
export const ORPHAN_MAX = 200;
/** One limit for tabs: a record keeps no more than a live browser can hold (session-browser S6). */
export const TABS_MAX = 20;
export const FILE_MAX = 4 * 1024 * 1024;
/** The app's own limit for an address (computer_open, the address bar). A longer one is dropped, so a few huge addresses
 *  cannot push the file past FILE_MAX and lose every record. */
export const ADDRESS_MAX = 8192;

const DAY_MS = 24 * 60 * 60 * 1000;
const ORPHAN = "orphan:";

export const orphanKey = (c: Conversation): string => `orphan:${c.host}:${c.id}`;

function webAddress(x: unknown): x is string {
  if (typeof x !== "string" || !navAllowed(x)) return false;
  try { const p = new URL(x).protocol; return p === "http:" || p === "https:"; } catch { return false; }
}

function conversationOf(x: unknown): Conversation | undefined {
  if (!x || typeof x !== "object") return undefined;
  const { host, id } = x as Record<string, unknown>;
  return (host === "claude" || host === "codex") && typeof id === "string" && id !== "" ? { host, id } : undefined;
}

/** A clean copy of a stored record, or null when it is not one. */
function clean(x: unknown): BrowserRecord | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.on !== "boolean" || typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  // `active` points at the same tab after the ones that are not kept are dropped, or at the first when that tab was dropped.
  const all = Array.isArray(r.tabs) ? r.tabs : [];
  const a = r.active;
  const tabs: string[] = [];
  let active = 0;
  for (const [i, x] of all.entries()) {
    if (tabs.length >= TABS_MAX) break;
    if (!webAddress(x) || x.length > ADDRESS_MAX) continue;
    if (i === a) active = tabs.length;
    tabs.push(withoutUserinfo(x));
  }
  const conversation = conversationOf(r.conversation);
  return conversation ? { on: r.on, tabs, active, conversation, at: r.at } : { on: r.on, tabs, active, at: r.at };
}

export class BrowserRecords {
  private readonly file: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private map: Map<string, BrowserRecord> | null = null;
  /** A read problem and a write problem are each logged once, separately (one must not hide the other). */
  private warnedRead = false;
  private warnedWrite = false;
  private warnedDrop = false;

  constructor(o: { file: string; now?: () => number; log?: (line: string) => void }) {
    this.file = o.file;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  get(key: string): BrowserRecord | undefined {
    const r = this.load().get(key);
    return r && structuredClone(r);
  }

  put(key: string, r: Omit<BrowserRecord, "at">): void {
    const c = clean({ ...r, at: this.now() });
    if (!c) return;
    this.load().set(key, c);
    this.save();
  }

  forget(key: string): void {
    if (this.load().delete(key)) this.save();
  }

  /** Moves a record to another key. A record already at `to` is replaced (the caller has decided `to` keeps nothing). */
  move(from: string, to: string): void {
    const m = this.load();
    const r = m.get(from);
    if (!r || from === to) return;
    m.delete(from);
    m.set(to, r);
    this.save();
  }

  /** Every code:* record becomes an orphan under its conversation, off; one with no conversation is dropped; then expiry. */
  orphanCode(): void {
    const m = this.load();
    for (const [key, r] of [...m]) {
      if (!key.startsWith("code:")) continue;
      m.delete(key);
      if (!r.conversation) continue;
      const to = orphanKey(r.conversation);
      const prior = m.get(to);
      if (!prior || prior.at < r.at) m.set(to, { ...r, on: false });
    }
    const orphans = [...m].filter(([k]) => k.startsWith(ORPHAN));
    const oldest = this.now() - ORPHAN_DAYS * DAY_MS;
    const live = orphans.filter(([, r]) => r.at >= oldest).sort((a, b) => b[1].at - a[1].at);
    const keep = new Set(live.slice(0, ORPHAN_MAX).map(([k]) => k));
    for (const [k] of orphans) if (!keep.has(k)) m.delete(k);
    this.save();
  }

  /** The orphan of `c`, re-keyed to `key` and off; undefined when there is none or `key` has a record with tabs or one
   *  that is on. A record with no tabs that is off (a terminal's conversation became known after its empty record was
   *  first written) is replaced. */
  adopt(key: string, c: Conversation): BrowserRecord | undefined {
    const m = this.load();
    const from = orphanKey(c);
    const r = m.get(from);
    const mine = m.get(key);
    if (!r || (mine && (mine.on || mine.tabs.length))) return undefined;
    m.delete(from);
    const adopted = { ...r, on: false };
    m.set(key, adopted);
    this.save();
    return structuredClone(adopted);
  }

  keys(): string[] { return [...this.load().keys()]; }

  private warn(line: string, kind: "read" | "write" | "drop" = "read"): void {
    if (kind === "write" ? this.warnedWrite : kind === "drop" ? this.warnedDrop : this.warnedRead) return;
    if (kind === "write") this.warnedWrite = true; else if (kind === "drop") this.warnedDrop = true; else this.warnedRead = true;
    try { this.log(line); } catch { /* a failing logger must not break the store */ }
  }

  private load(): Map<string, BrowserRecord> {
    if (this.map) return this.map;
    const m = new Map<string, BrowserRecord>();
    this.map = m;
    let text: string;
    try {
      if (fs.statSync(this.file).size > FILE_MAX) { this.warn("browser records: file too large, ignored"); return m; }
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.warn("browser records: unreadable, ignored");
      return m;
    }
    try {
      const j = JSON.parse(text) as { schema?: unknown; browsers?: unknown } | null;
      if (!j || j.schema !== 1 || !j.browsers || typeof j.browsers !== "object" || Array.isArray(j.browsers)) {
        this.warn("browser records: unrecognised file, ignored");
        return m;
      }
      for (const [k, v] of Object.entries(j.browsers)) { const c = clean(v); if (c) m.set(k, c); }
    } catch {
      this.warn("browser records: damaged file, ignored");
    }
    return m;
  }

  private render(m: Map<string, BrowserRecord>): string {
    return JSON.stringify({ schema: 1, browsers: Object.fromEntries(m) }, null, 2) + "\n";
  }

  /** The file's text, never longer than FILE_MAX (load() would ignore the whole file). While it is, records go from the
   *  map too: orphans first, then the others, oldest first. Each record's size is estimated once and the estimate is used
   *  to drop in one pass; the text is then confirmed, and one more record goes per round if it is still too long. */
  private fit(m: Map<string, BrowserRecord>): string {
    let text = this.render(m);
    if (Buffer.byteLength(text, "utf8") <= FILE_MAX) return text;
    const order = [...m].sort(([ka, a], [kb, b]) =>
      Number(kb.startsWith(ORPHAN)) - Number(ka.startsWith(ORPHAN)) || a.at - b.at);
    const size = new Map(order.map(([k, r]) => [k, Buffer.byteLength(JSON.stringify(k) + JSON.stringify(r, null, 2), "utf8") + 8]));
    let est = Buffer.byteLength(text, "utf8");
    let i = 0;
    while (i < order.length && est > FILE_MAX) { est -= size.get(order[i][0]) ?? 0; m.delete(order[i][0]); i++; }
    text = this.render(m);
    while (i < order.length && Buffer.byteLength(text, "utf8") > FILE_MAX) { m.delete(order[i][0]); i++; text = this.render(m); }
    if (i > 0) this.warn("browser records: too large, the oldest were dropped", "drop");
    return text;
  }

  private save(): void {
    const m = this.load();
    const text = this.fit(m);
    const dir = path.dirname(this.file);
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // A folder or file that already existed keeps its old mode otherwise, and a stale temp file's mode and owner too.
      fs.chmodSync(dir, 0o700);
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
      this.warn("browser records: could not be saved", "write");
    }
  }
}
