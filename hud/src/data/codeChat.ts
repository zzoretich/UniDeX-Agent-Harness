// codeChat.ts — the Code tab's chat as pure data (spec 2026-11-09 code-chat). The runtime's follower appends one
// HostSessionEvent per line to a vault cache (brain/_index/code/<terminal>.jsonl); CacheTail reads what is new,
// chatFromEvents draws it as Sessions' rows, rowStatus words a terminal's state for the rail.
import type { HostFs, HostSessionEvent } from "../host";
import type { SessionHost } from "./aosConfig";
import type { ThreadRow } from "./agentSessions";
import { threadRows, turnOpen } from "./agentSessions";

const NL = 0x0a;
const MAX_READ = 4 * 1024 * 1024;

/**
 * The complete new lines of a cache file, from a byte offset. A partial last line waits for its newline (the split is
 * on the last newline byte, before decoding, so a multi-byte character is never cut); a malformed line is skipped; a
 * missing file reads as nothing. A file that shrank restarts at 0 and sets `truncated` for that read, so the caller
 * clears what it accumulated; `reset()` rewinds by hand (main answered `follow` with `fresh: true`).
 */
export class CacheTail {
  private offset = 0;
  truncated = false;

  constructor(private readonly fs: HostFs, private readonly path: string) {}

  reset(): void { this.offset = 0; this.truncated = false; }

  read(): HostSessionEvent[] {
    this.truncated = false;
    let size: number;
    try { size = this.fs.statSync(this.path).size; } catch { return []; }
    if (size < this.offset) { this.offset = 0; this.truncated = true; }
    if (size === this.offset) return [];
    let bytes: Uint8Array;
    try { bytes = this.fs.readBytesSync(this.path, this.offset, Math.min(size - this.offset, MAX_READ)); } catch { return []; }
    const end = bytes.lastIndexOf(NL);
    if (end < 0) return [];
    this.offset += end + 1;
    const out: HostSessionEvent[] = [];
    for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e === "object" && typeof e.kind === "string") out.push(e as HostSessionEvent);
      } catch { /* a malformed complete line is skipped */ }
    }
    return out;
  }
}

export interface ChatState {
  sessionId: string | null;
  rows: ThreadRow[];
  /** Rows dropped from the start to stay under the cap. */
  hiddenEarlier: number;
  turnOpen: boolean;
  /** The latest error event's message, cleared by any later non-error event. */
  error: string | null;
  /** The newest model named by a session or done event. */
  model: string | null;
}

export interface ChatOptions {
  /** Rows kept (the chat's cap, 400); "Show earlier" asks for more. */
  maxRows?: number;
  /** The terminal's host: it names a default model in a change marker ("Codex default"). */
  host?: SessionHost;
  /** The terminal's folder: file paths under it show relative. */
  root?: string | null;
}

/**
 * The events as a chat. A `session` event with a new id starts the conversation over (rows, error and model are those
 * after it); the same id only updates the model. The cap is on rows: a cut lands on the first turn boundary that
 * brings the rows under it, so a turn is not half-shown; one turn longer than the cap is cut hard, and so is a cut whose
 * boundary would keep fewer than half the cap (a long turn just after the excess).
 */
export function chatFromEvents(events: HostSessionEvent[], o: ChatOptions = {}): ChatState {
  const maxRows = Math.max(1, o.maxRows ?? 400);
  let sessionId: string | null = null;
  let from = 0;
  events.forEach((e, i) => {
    if (e.kind !== "session" || typeof e.id !== "string") return;
    if (sessionId !== null && e.id !== sessionId) from = i;
    sessionId = e.id;
  });
  const live = events.slice(from);
  let model: string | null = null;
  let error: string | null = null;
  for (const e of live) {
    if ((e.kind === "session" || e.kind === "done") && typeof e.model === "string" && e.model) model = e.model;
    if (e.kind === "error") error = typeof e.message === "string" && e.message ? e.message : "error";
    else error = null;
  }
  const all = threadRows(live, { host: o.host, root: o.root ?? null });
  let cut = 0;
  if (all.length > maxRows) {
    const excess = all.length - maxRows;
    cut = excess;
    for (let i = excess; i < all.length; i++) {
      if (all[i].turn !== all[i - 1].turn) { cut = i; break; }
    }
    if (all.length - cut < maxRows / 2) cut = excess;
  }
  return { sessionId, rows: all.slice(cut), hiddenEarlier: cut, turnOpen: turnOpen(live), error, model };
}

/**
 * The newest events of a long chat, at most `max` (R31: the HUD keeps a bounded buffer per terminal): from the first
 * prompt in the last `max`, so no turn starts half-way, or a hard cut when that window holds no prompt. The last session
 * event among the dropped ones is kept at the front, so the conversation's id and model survive the trim. `dropped`
 * counts the events left out.
 */
export function trimEvents(events: HostSessionEvent[], max: number): { events: HostSessionEvent[]; dropped: number } {
  if (events.length <= max) return { events, dropped: 0 };
  const from = events.length - Math.max(1, max);
  let start = from;
  for (let i = from; i < events.length; i++) {
    if (events[i].kind === "prompt") { start = i; break; }
  }
  let session: HostSessionEvent | null = null;
  for (let i = start - 1; i >= 0; i--) {
    if (events[i].kind === "session") { session = events[i]; break; }
  }
  const kept = events.slice(start);
  return { events: session ? [session, ...kept] : kept, dropped: start };
}

export interface RowStatusInput { exited: boolean; exitCode: number | null; turnOpen: boolean; printing: boolean; needsYou: boolean }

/**
 * A terminal's state in a word. Precedence: exited, needs you, working, idle. Working is an open turn (the agent may be
 * thinking while the terminal is quiet); a quiet terminal with no open turn is idle, and output with no open turn is
 * not work of the agent's.
 */
export function rowStatus(i: RowStatusInput): { status: "working" | "needs" | "idle" | "exited"; text: string } {
  if (i.exited) return { status: "exited", text: i.exitCode === null ? "Exited" : `Exited ${i.exitCode}` };
  if (i.needsYou) return { status: "needs", text: "Needs you" };
  if (i.turnOpen) return { status: "working", text: "Working" };
  return { status: "idle", text: "Idle" };
}
