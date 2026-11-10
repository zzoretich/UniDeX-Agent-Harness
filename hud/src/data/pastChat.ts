// pastChat.ts — a past conversation as the Code sidebar opens it (spec 2026-11-09 code-chat C6): main mirrors it once
// (`code.view`) into brain/_index/code/<host>-<id>.jsonl and answers the cache; this reads that file whole and draws it as
// Sessions' rows. Read-only, so no tail is kept: Show earlier asks for more rows from the same events.
import type { HostFs, HostSessionEvent } from "../host";
import type { SessionHost } from "./aosConfig";
import { CacheTail, chatFromEvents, type ChatState } from "./codeChat";

/** The chat row cap and Show earlier's step (the live chat's, codeFeeds ROW_CAP). */
const ROW_CAP = 400;

/** Reads at most this many times (4 MB each): a transcript larger than that shows its newest part. */
const MAX_READS = 16;

/** Every event in a cache file; none when it is missing. */
export function readCacheAll(fs: HostFs, abs: string): HostSessionEvent[] {
  const tail = new CacheTail(fs, abs);
  const all: HostSessionEvent[] = [];
  for (let n = 0; n < MAX_READS; n++) {
    const got = tail.read();
    if (!got.length) break;
    for (const ev of got) all.push(ev);
  }
  return all;
}

export interface PastView { events: HostSessionEvent[]; maxRows: number }

export function pastView(events: HostSessionEvent[]): PastView { return { events, maxRows: ROW_CAP }; }

/** The chat of a past conversation: the newest `maxRows` rows; nothing in the cache is an error line, not an empty chat. */
export function pastState(v: PastView, host: SessionHost, root: string | null): ChatState {
  const s = chatFromEvents(v.events, { maxRows: v.maxRows, host, root });
  return s.rows.length || s.error ? s : { ...s, error: "This conversation has no messages to show." };
}

/** Show earlier: 400 more rows. */
export function pastEarlier(v: PastView): PastView { return { events: v.events, maxRows: v.maxRows + ROW_CAP }; }
