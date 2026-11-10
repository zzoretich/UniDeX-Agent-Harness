// codeFeeds.ts — each agent terminal's chat, kept for the terminal's whole life (spec 2026-11-09 code-chat C1, C2, C5;
// rulings R3, R28, R31). One feed per agent terminal of the pool, whichever tab started it: `follow` once its first
// process is known (the agent main runs, or the shell a fallback typed its line into), with that pty id, the terminal's key
// and the conversation's id when the deck knows it; `unfollow` when the terminal is closed. The follower's cache
// (vault-relative) is read on each vault change of its path into a bounded buffer (the newest EVENT_CAP events, cut at a
// prompt), and the chat is worked out again only when something new arrived; Show earlier reads the whole cache once.
// A Claude Code terminal's status line is its copy of `aos statusline render`, brain/_index/statusline/<key>.json, read
// on each change of that file and shown whenever it is there (R3). Which view each terminal shows is kept here too, so it
// survives the Code tab's remounts. No DOM: the HudHost is all it touches.
//
// While the surface is on, each agent terminal also feeds a headless screen (C4, C5, C10), made with its feed and let go
// when the terminal closes, its agent ends or it exits; it lives as long as the terminal, not the Code tab. Screens are
// read every POLL_MS, and only while their PTY printed in the last PRINT_MS or a card is up, never in the tick the data
// came in (a chunk xterm has not parsed yet waits for the next read): the TUI's prompt is the chat's card and the row's
// Needs you, and a Codex terminal's footer rows are its status line. A card's key reaches the agent only through
// `answer`, which reads the screen again first; Send asks `cardNow`, which reads it too (the poll can be a tick behind),
// once the terminal's last input has had SEND_QUIET_MS (a slash command SLASH_SETTLE_MS) to open whatever prompt it opens
// (R62, R69), and after it pasted images waits on `imagesShown` for their placeholders before its text and ⏎ (R70).

import * as path from "path";
import { readCacheAll } from "./pastChat";
import { codeChatOn, fs as hostFs, hudHost, type HostCode, type HostFs, type HostResult, type HostSessionEvent } from "../host";
import { CacheTail, chatFromEvents, trimEvents, type ChatState } from "./codeChat";
import { allowCodeHref, ansiLines, type Span } from "./ansiSpans";
import type { TerminalPool } from "./terminalPool";
import { hasChat, processKey, type TerminalSession } from "./terminalSession";
import { listen } from "./listen";
import { ClosedRecord } from "./closedRecord";
import { HeadlessScreen } from "./headlessScreen";
import { approvalPrompt, choiceInput, codexFooterRows, screenCard, type ChatCard } from "./termScreen";
import { rowStatus } from "./codeChat";
import { statusInput } from "./termGroups";

/** Rows a chat shows, and how many more each Show earlier adds. */
export const ROW_CAP = 400;
/** Events a chat keeps in memory (R31); a longer conversation drops its oldest turns until Show earlier. */
export const EVENT_CAP = 4000;
/** How far past the cap the buffer may grow before it is trimmed again (a trim copies it). */
const TRIM_SLACK = 1000;
/** Reads of one change at most (each reads up to 4 MB): a cache that keeps growing is read again at its next change. */
const MAX_READS = 64;
/** How often agent terminals' screens are read (C4, C10)… */
export const POLL_MS = 500;
/** …and for how long after their PTY last printed. */
export const PRINT_MS = 2000;
/** How long Send and a card's click wait for a screen's pending chunks to parse before they read what is there. */
export const SEND_SETTLE_MS = 100;
/** How long after the terminal's last input (from the composer, a card or the terminal itself) Send waits before it reads
 *  the screen (R62): a TUI opens a prompt in answer to input it has not drawn yet (a `/model` sent a moment ago, its
 *  picker not up), and the ⏎ that ends a send would answer it. Send waits at most SEND_QUIET_MS + SEND_SETTLE_MS. */
export const SEND_QUIET_MS = 500;
/** How long after a slash command the composer sent (`/model`) a later Send may still wait for the prompt it opens (R69):
 *  a TUI can draw that picker well after SEND_QUIET_MS (Codex 0.167's first `/model` did, live), and the ⏎ that ends the
 *  next send would answer it. Send stops waiting as soon as a card shows, so it waits at most SLASH_SETTLE_MS +
 *  SEND_SETTLE_MS. */
export const SLASH_SETTLE_MS = 2000;
/** How often the screen is read while Send waits (R69): a card read holds at once. */
export const SEND_POLL_MS = 100;
/** How long Send waits, after it pasted its images' paths, for the TUI to show their placeholders (`[Image #1]`) before it
 *  writes the text and ⏎ (R70): Claude Code reads and inserts a pasted image asynchronously, and a ⏎ that comes first
 *  submits the text without it. Past it the text goes anyway. */
export const IMAGE_ATTACH_MS = 3000;
/** How often the screen is read for those placeholders. */
export const IMAGE_POLL_MS = 50;

/** How long Send still waits for the terminal's last input at `lastInput` (Date.now() ms; -Infinity: none) to settle at
 *  `now`: 0 once SEND_QUIET_MS has passed, never more than SEND_QUIET_MS (a clock that moved back included). */
export function sendQuietWait(lastInput: number, now: number): number {
  return Math.min(SEND_QUIET_MS, Math.max(0, lastInput + SEND_QUIET_MS - now));
}

/** How long Send may wait at `now` (R62, R69): what is left of SEND_QUIET_MS since the terminal's last input, or of
 *  SLASH_SETTLE_MS since the slash command the composer last sent (`command`, -Infinity: none), whichever is longer;
 *  never more than SLASH_SETTLE_MS. */
export function sendWait(lastInput: number, command: number, now: number): number {
  return Math.max(sendQuietWait(lastInput, now), Math.min(SLASH_SETTLE_MS, Math.max(0, command + SLASH_SETTLE_MS - now)));
}

/** How many image placeholders (`[Image #…`) a screen shows, over all its rows (R70). */
export function imageMarks(rows: readonly string[]): number {
  let n = 0;
  for (const r of rows) for (let at = r.indexOf("[Image #"); at >= 0; at = r.indexOf("[Image #", at + 1)) n++;
  return n;
}

/** What Send's wait answers (cardNow): a card is up (hold, keep the draft), none is (send), or the agent the draft was
 *  written for is gone: it ended, the terminal exited or closed, or another process took it over (R39's login shell).
 *  Gone sends nothing and keeps the draft, as `answer` writes nothing then. */
export type SendHold = boolean | "gone";


/** Whether a terminal's screen is read on this tick: its PTY printed in the last PRINT_MS, or a card is up (it may be
 *  answered in the terminal). `lastData` is when it last printed, -Infinity before it ever did. */
export function screenDue(now: number, lastData: number, cardUp: boolean): boolean {
  return cardUp || now - lastData < PRINT_MS;
}

/** The poll's clock; tests pass one they move by hand. */
export interface FeedsClock {
  now(): number;
  /** Calls `fn` every `ms` until the returned function runs. */
  every(ms: number, fn: () => void): () => void;
}
const REAL_CLOCK: FeedsClock = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const h = setInterval(fn, ms);
    // Under Node (the HUD's tests) a poll never holds the process open.
    (h as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(h);
  },
};

export type CodeView = "chat" | "terminal";
/** pending: no answer yet (or no process to follow yet); on: following; off: the Code chat surface is off; failed: main
 *  answered why not (`error`). */
export type FollowState = "pending" | "on" | "off" | "failed";

export interface CodeFeed {
  /** The pool's id for the terminal. */
  readonly id: string;
  readonly host: "claude" | "codex";
  follow: FollowState;
  error: string | null;
  /** The follower's cache, vault-relative. */
  cache: string | null;
  /** The chat so far. `hiddenEarlier` also counts the events the buffer dropped, so Show earlier is offered for them. */
  state: ChatState;
  /** The status line's rows, or null when there is none to show (the composer's hint): a Claude Code terminal's copy of
   *  its status line, a Codex terminal's footer rows from its screen. */
  status: Span[][] | null;
  /** What the TUI waits on, read from its screen (C4): the approval with its choices, a dialog the chat can't draw, or
   *  none. The same prompt keeps the same object. */
  card: ChatCard | null;
  /** A C4 prompt is on its screen: the row's Needs you and the rail badge's count (C10). */
  needsYou: boolean;
  /** Its PTY printed in the last PRINT_MS. */
  printing: boolean;
}

interface Entry {
  feed: CodeFeed;
  /** The pty id it was followed with; null until there is one. */
  pty: string | null;
  asked: boolean;
  root: string;
  tail: CacheTail | null;
  events: HostSessionEvent[];
  /** Events the buffer dropped from its start. */
  dropped: number;
  /** Show earlier read the whole cache: the buffer is no longer trimmed. */
  full: boolean;
  maxRows: number;
  /** brain/_index/statusline/<key>.json, for a Claude Code terminal. */
  statusRel: string | null;
  /** What the status line shows, as text (the copy's ANSI, or Codex's footer spans), so the same keeps the same rows. */
  statusText: string | null;
  /** Its headless screen while the surface is on and its agent runs (C10), and the listener that times its output. */
  screen: HeadlessScreen | null;
  offData: (() => void) | null;
  /** When its PTY last printed (the clock's ms); -Infinity before it did. */
  lastData: number;
  /** The card as text: a poll that reads the same prompt keeps the card it had. */
  cardSig: string;
  /** The card a key was written for from here: one answer per prompt. */
  answered: string | null;
}

const EMPTY: ChatState = { sessionId: null, rows: [], hiddenEarlier: 0, turnOpen: false, error: null, model: null };

export interface CodeFeedsOptions {
  /** The vault folder the follower's cache and the vault's change events are relative to. */
  vaultRoot: () => string;
  /** The host's Code calls (absent outside the app); default: the installed HudHost's. */
  code?: () => HostCode | undefined;
  fs?: HostFs;
  /** The screens' poll clock; default: the real one. */
  clock?: FeedsClock;
}

export class CodeFeeds {
  private entries = new Map<string, Entry>();
  /** View choices by terminal id: an agent terminal not listed shows its chat. */
  private views = new Map<string, CodeView>();
  /** Vault-relative path → the terminal id whose cache or status line it is. */
  private byPath = new Map<string, string>();
  private listeners = new Set<(id: string) => void>();
  private unlisten: (() => void) | null;
  private disposed = false;
  /** Stops the screens' poll; null while it is not running. */
  private stopPoll: (() => void) | null = null;
  /** Conversations closed in this app, for the Code sidebar; it lives as long as the plugin, not the Code tab (C6). */
  readonly closedConvs = new ClosedRecord();

  constructor(private readonly pool: TerminalPool, private readonly o: CodeFeedsOptions) {
    this.unlisten = listen(pool, {
      "session-add": (s) => this.ensure(s as TerminalSession),
      "session-update": (s) => this.ensure(s as TerminalSession),
      "session-remove": (id) => this.closed(id as string),
    });
    for (const s of pool.list()) this.ensure(s);
  }

  private code(): HostCode | undefined { return this.o.code ? this.o.code() : hudHost().code; }
  private get fs(): HostFs { return this.o.fs ?? hostFs; }
  private get clock(): FeedsClock { return this.o.clock ?? REAL_CLOCK; }
  private abs(rel: string): string { return path.join(this.o.vaultRoot(), rel); }

  /** Whether the Code chat surface is on for this run of the app (C13). */
  on(): boolean { return codeChatOn(); }

  /** An agent terminal's chat; null for a shell or a terminal the pool no longer has. */
  get(id: string): CodeFeed | null { return this.entries.get(id)?.feed ?? null; }

  /** How many events a chat holds in memory (R31's bound, until Show earlier). */
  buffered(id: string): number { return this.entries.get(id)?.events.length ?? 0; }

  /** Whether the terminal has a headless screen now (an agent's, while the surface is on and its agent runs). */
  screened(id: string): boolean { return !!this.entries.get(id)?.screen; }

  /**
   * A card's choice (C4): writes the key as the TUI takes it (choiceInput: the digit or letter alone, Esc as the escape
   * byte) and nothing else, and only while the agent runs (R39: once it ended, the login shell would take it), its screen
   * still shows the prompt the card shows with that choice (read again now, not taken from the last poll), and that
   * prompt was not answered from here already; `card`, the one the click was drawn on, must still be the live one. A
   * screen with a chunk still to parse is waited for (SEND_SETTLE_MS at most) and checked again; still unparsed, nothing
   * is written. True when it wrote. The panel also refuses while the composer is blocked.
   */
  async answer(id: string, key: string, card?: ChatCard): Promise<boolean> {
    const e = this.entries.get(id);
    const screen = e?.screen;
    if (e && screen?.busy) {
      await screen.settled(SEND_SETTLE_MS);
      if (this.disposed || this.entries.get(id) !== e || e.screen !== screen) return false;
    }
    return this.answerNow(id, key, card);
  }

  private answerNow(id: string, key: string, card?: ChatCard): boolean {
    const e = this.entries.get(id);
    const s = this.pool.get(id);
    if (!e || !s || !e.screen || s.agentEnded || s.isExited || e.screen.busy) return false;
    const shown = e.feed.card;
    if (!shown || shown.kind !== "approval" || e.answered === e.cardSig) return false;
    // The card the user saw, not whatever is latest: a click on a card that was replaced writes nothing.
    if (card !== undefined && JSON.stringify(card) !== e.cardSig) return false;
    const choice = shown.choices.find((c) => c.key === key);
    const input = choice ? choiceInput(key) : null;
    if (!choice || input === null) return false;
    const now = approvalPrompt(e.screen.snapshot(), e.feed.host);
    if (!now || now.title !== shown.title || now.detail !== shown.detail || !now.choices.some((c) => c.key === key && c.label === choice.label)) return false;
    e.answered = e.cardSig;
    s.write(input);
    return true;
  }

  /**
   * Whether Send must hold: a card is up. The poll can see a prompt a tick or more after it printed (POLL_MS, and a tick
   * skipped while a chunk parses), so with no card known the screen is always read now (a snapshot and a parse, well under
   * a millisecond), after its pending chunks are parsed when there are any (waited for at most SEND_SETTLE_MS: after that,
   * whatever is parsed is read). Busy alone never holds (R56); only a card the read finds does, and it is the feed's from
   * then on. Input written to the terminal less than SEND_QUIET_MS ago may still open a prompt the screen does not show
   * yet (R62), and a slash command the composer sent less than SLASH_SETTLE_MS ago may open one later still (R69): the
   * read waits that long (sendWait), reading the screen every SEND_POLL_MS meanwhile and holding as soon as a card shows,
   * so Send waits at most SLASH_SETTLE_MS + SEND_SETTLE_MS. "gone" when the agent did not outlast the wait (it ended, the
   * terminal closed, another process took it over: C1): the draft must not go to whatever runs there now.
   */
  async cardNow(id: string): Promise<SendHold> {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.feed.card) return true;
    const screen = e.screen;
    if (!screen) return false;
    const s = this.pool.get(id);
    const proc = processKey(s);
    const gone = (): boolean => this.disposed || this.entries.get(id) !== e || e.screen !== screen || processKey(this.pool.get(id)) !== proc;
    // Date.now(), as TerminalSession stamps its input and commands with (the poll's clock is the screens' own).
    const until = Date.now() + sendWait(s?.lastInputAt ?? Number.NEGATIVE_INFINITY, s?.commandAt ?? Number.NEGATIVE_INFINITY, Date.now());
    for (let left = until - Date.now(); left > 0; left = until - Date.now()) {
      await new Promise<void>((r) => setTimeout(r, Math.min(SEND_POLL_MS, left)));
      if (gone()) return "gone";
      if (!e.feed.card && this.readScreen(e)) this.notify(id);
      if (e.feed.card) return true;
    }
    if (screen.busy) {
      await screen.settled(SEND_SETTLE_MS);
      if (gone()) return "gone";
    }
    if (this.readScreen(e, true)) this.notify(id);
    return e.feed.card !== null;
  }

  /** How many image placeholders the terminal's screen shows now (R70), or null when it has no screen to read. */
  imageMarks(id: string): number | null {
    const screen = this.entries.get(id)?.screen;
    return screen ? imageMarks(screen.snapshot().rows) : null;
  }

  /**
   * Waits after Send pasted `count` images' paths (R70) until the screen shows `count` more image placeholders than
   * `before` (read every IMAGE_POLL_MS), or IMAGE_ATTACH_MS passed: "attached" or "timeout", and the text and ⏎ may go.
   * "gone" when the agent did not outlast the wait (C1): nothing more may be written to that terminal.
   */
  async imagesShown(id: string, before: number, count: number): Promise<"attached" | "timeout" | "gone"> {
    const e = this.entries.get(id);
    const screen = e?.screen;
    if (!e || !screen) return "gone";
    const proc = processKey(this.pool.get(id));
    const gone = (): boolean => this.disposed || this.entries.get(id) !== e || e.screen !== screen || processKey(this.pool.get(id)) !== proc;
    const until = Date.now() + IMAGE_ATTACH_MS;
    for (let left = until - Date.now(); left > 0; left = until - Date.now()) {
      await new Promise<void>((r) => setTimeout(r, Math.min(IMAGE_POLL_MS, left)));
      if (gone()) return "gone";
      // What is parsed is enough: a placeholder still in a pending chunk is counted on the next read.
      if (imageMarks(screen.snapshot().rows) >= before + count) return "attached";
    }
    return gone() ? "gone" : "timeout";
  }

  /** What the terminal shows: its chat by default, an agent's only and only while the surface is on (C1, C3, C13). */
  view(id: string): CodeView {
    const s = this.pool.get(id);
    if (!s || !hasChat(s.meta) || !this.on()) return "terminal";
    return this.views.get(id) ?? "chat";
  }

  setView(id: string, v: CodeView): void { this.views.set(id, v); }

  /** Calls `cb` with a terminal's id when its chat, status line or follow state changed. */
  subscribe(cb: (id: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** A vault path changed (created, modified or deleted): the chat or status line it belongs to is read again. */
  vaultChanged(rel: string): void {
    if (this.disposed || !rel.startsWith("brain/_index/")) return;
    const id = this.byPath.get(rel);
    const e = id ? this.entries.get(id) : undefined;
    if (!id || !e) return;
    let changed = false;
    if (rel === e.feed.cache && this.drain(e)) changed = true;
    if (rel === e.statusRel && this.readStatus(e)) changed = true;
    if (changed) this.notify(id);
  }

  /**
   * Show earlier (R31): the whole cache read once, and room for ROW_CAP more rows; from then on this chat's buffer is not
   * trimmed. The new tail starts where that read ended, so nothing is read twice.
   */
  showEarlier(id: string): void {
    const e = this.entries.get(id);
    if (!e || !e.feed.cache) return;
    if (!e.full) {
      const tail = new CacheTail(this.fs, this.abs(e.feed.cache));
      const all: HostSessionEvent[] = [];
      for (let n = 0; n < MAX_READS * 4; n++) {
        const got = tail.read();
        if (!got.length) break;
        for (const ev of got) all.push(ev);
      }
      e.tail = tail;
      e.events = all;
      e.dropped = 0;
      e.full = true;
    }
    e.maxRows += ROW_CAP;
    this.compute(e);
    this.notify(id);
  }

  /** A cache `code.view` wrote, read whole (the Code sidebar's past conversations): the vault-relative path it answered. */
  readCache(rel: string): HostSessionEvent[] {
    if (!rel.startsWith("brain/_index/code/") || rel.includes("..")) return [];
    return readCacheAll(this.fs, this.abs(rel));
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    this.stopPoll?.();
    this.stopPoll = null;
    for (const e of this.entries.values()) this.dropScreen(e);
    this.listeners.clear();
    this.entries.clear();
    this.byPath.clear();
  }

  // ── private ──

  private notify(id: string): void {
    for (const l of this.listeners) {
      try { l(id); } catch (err) { console.warn("[agentic-os] code feed listener:", err); }
    }
  }

  /** A terminal was added or changed: an agent gets its feed, and its follow once it has a process (R28). */
  private ensure(s: TerminalSession): void {
    if (this.disposed || !s || s.meta.host === "shell" || !hasChat(s.meta)) return;
    let e = this.entries.get(s.id);
    if (!e) {
      const host = s.meta.host;
      const on = this.on() && !!this.code();
      e = {
        feed: { id: s.id, host, follow: on ? "pending" : "off", error: null, cache: null, state: EMPTY, status: null, card: null, needsYou: false, printing: false },
        pty: null, asked: false, root: s.meta.place?.dir ?? s.cwd, tail: null, events: [], dropped: 0, full: false,
        maxRows: ROW_CAP, statusRel: null, statusText: null,
        screen: null, offData: null, lastData: Number.NEGATIVE_INFINITY, cardSig: "", answered: null,
      };
      this.entries.set(s.id, e);
      // Only a terminal that carries its key (the surface on) has a status line copy of its own.
      if (on && host === "claude") {
        e.statusRel = `brain/_index/statusline/${s.meta.terminalKey}.json`;
        this.byPath.set(e.statusRel, s.id);
        this.readStatus(e);
      }
      // Its screen, while the surface is on (with it off there is no chat to show a card in); a terminal made late still
      // shows its TUI, from what it printed.
      if (on && !s.agentEnded && !s.isExited) {
        const entry = e;
        entry.screen = new HeadlessScreen(s);
        entry.offData = s.onData(() => this.printed(entry));
      }
    }
    // Its agent ended (the login shell runs in its terminal, D18) or it exited: nothing on that screen is the agent's.
    if (e.screen && (s.agentEnded || s.isExited)) {
      if (this.dropScreen(e)) this.notify(s.id);
      this.pollIfLive();
    }
    if (e.feed.follow === "pending" && !e.asked && s.originPty) {
      e.asked = true;
      e.pty = s.originPty;
      void this.follow(e, s);
    }
  }

  private async follow(e: Entry, s: TerminalSession): Promise<void> {
    const code = this.code();
    const id = s.id;
    if (!code || !e.pty) { e.feed.follow = "off"; this.notify(id); return; }
    let r: HostResult<{ cache: string; fresh: boolean }>;
    try {
      r = await code.follow({ pty: e.pty, host: e.feed.host, terminal: s.meta.terminalKey, id: s.meta.sessionId ?? null });
    } catch (err) {
      r = { ok: false, error: err instanceof Error ? err.message : String(err), code: "EIO" };
    }
    // Closed while main answered: its follower stops with it (main ends it with the terminal too).
    if (this.disposed || this.entries.get(id) !== e) { if (r.ok) { try { code.unfollow(e.pty); } catch { /* gone */ } } return; }
    if (!r.ok) {
      e.feed.follow = r.code === "EROFS" ? "off" : "failed";
      e.feed.error = r.error || r.code;
      this.notify(id);
      return;
    }
    e.feed.follow = "on";
    e.feed.cache = r.data.cache;
    this.byPath.set(r.data.cache, id);
    e.tail = new CacheTail(this.fs, this.abs(r.data.cache));
    // A new follower writes its cache from the start (R16b): what was read before is not the conversation any more.
    if (r.data.fresh) { e.tail.reset(); e.events = []; e.dropped = 0; e.full = false; e.maxRows = ROW_CAP; }
    this.drain(e);
    this.compute(e);
    this.notify(id);
  }

  /** Reads what the cache has new, until it has nothing (R31); true when the chat changed. */
  private drain(e: Entry): boolean {
    const tail = e.tail;
    if (!tail) return false;
    let changed = false;
    for (let n = 0; n < MAX_READS; n++) {
      const got = tail.read();
      // The file was rewritten (a follower replaced, a /clear's new cache): start over with what it holds now.
      if (tail.truncated) { e.events = []; e.dropped = 0; e.full = false; e.maxRows = ROW_CAP; changed = true; }
      if (!got.length) break;
      for (const ev of got) e.events.push(ev);
      changed = true;
      if (!e.full && e.events.length > EVENT_CAP + TRIM_SLACK) {
        const t = trimEvents(e.events, EVENT_CAP);
        e.events = t.events;
        e.dropped += t.dropped;
      }
    }
    if (changed) this.compute(e);
    return changed;
  }

  private compute(e: Entry): void {
    const s = chatFromEvents(e.events, { maxRows: e.maxRows, host: e.feed.host, root: e.root });
    e.feed.state = e.dropped ? { ...s, hiddenEarlier: s.hiddenEarlier + e.dropped } : s;
  }

  /** The status line copy, read again; true when what it shows changed. Missing or unreadable is no status line (R3). */
  private readStatus(e: Entry): boolean {
    if (!e.statusRel) return false;
    let text: string | null = null;
    try {
      const j = JSON.parse(this.fs.readFileSync(this.abs(e.statusRel), "utf8")) as { ansi?: unknown };
      text = typeof j?.ansi === "string" ? j.ansi : null;
    } catch { text = null; }
    if (text === e.statusText) return false;
    e.statusText = text;
    e.feed.status = text === null ? null : ansiLines(text, allowCodeHref);
    return true;
  }

  // ── each agent terminal's screen (C4, C5, C10) ──

  /** Its PTY printed: the screen is read on the next ticks, never in this one (xterm parses the chunk on a timer). */
  private printed(e: Entry): void {
    if (this.disposed || !e.screen) return;
    e.lastData = this.clock.now();
    if (!e.feed.printing && this.setPrinting(e, true)) this.notify(e.feed.id);
    if (!this.stopPoll) this.stopPoll = this.clock.every(POLL_MS, () => this.poll());
  }

  /** Sets `printing`; true when that changes what the terminal's row says (rowStatus). */
  private setPrinting(e: Entry, on: boolean): boolean {
    const s = this.pool.get(e.feed.id);
    const word = (): string => (s ? rowStatus(statusInput(s, e.feed)).status : "");
    const before = word();
    e.feed.printing = on;
    return word() !== before;
  }

  /** One tick: every screen that is due is read; when none is (all quiet, no card up) the poll stops until one prints. */
  private poll(): void {
    if (this.disposed) return;
    const now = this.clock.now();
    for (const e of this.entries.values()) {
      if (!e.screen) continue;
      const printing = now - e.lastData < PRINT_MS;
      const quieted = e.feed.printing && !printing;
      let changed = quieted && this.setPrinting(e, false);
      // The tick it went quiet reads it once more, so its last screen is the one shown.
      if ((screenDue(now, e.lastData, e.feed.card !== null) || quieted) && this.readScreen(e)) changed = true;
      if (changed) this.notify(e.feed.id);
    }
    this.pollIfLive();
  }

  /** Stops the poll when no screen is due. */
  private pollIfLive(): void {
    if (!this.stopPoll) return;
    const now = this.clock.now();
    for (const e of this.entries.values()) if (e.screen && screenDue(now, e.lastData, e.feed.card !== null)) return;
    this.stopPoll();
    this.stopPoll = null;
  }

  /** Reads the screen into the card, Needs you and (Codex) the status line; true when any changed. A screen with a chunk
   *  still to parse is read on the next tick. */
  private readScreen(e: Entry, force = false): boolean {
    const screen = e.screen;
    if (!screen || (screen.busy && !force)) return false;
    const snap = screen.snapshot();
    let changed = false;
    const card = screenCard(snap, e.feed.host);
    const sig = card ? JSON.stringify(card) : "";
    if (sig !== e.cardSig) {
      e.cardSig = sig;
      e.answered = null;
      e.feed.card = card;
      e.feed.needsYou = card !== null;
      changed = true;
    }
    // Codex's status line is its footer, as the terminal draws it (C5); covered by a prompt, or not found, the hint.
    if (e.feed.host === "codex") {
      const rows = codexFooterRows(snap);
      const lines = rows ? dedent(rows.map((y) => screen.rowSpans(y))) : null;
      const text = lines ? JSON.stringify(lines) : null;
      if (text !== e.statusText) { e.statusText = text; e.feed.status = lines; changed = true; }
    }
    return changed;
  }

  /** Lets the terminal's screen go, and what it read; true when the feed showed any of it. */
  private dropScreen(e: Entry): boolean {
    if (!e.screen) return false;
    e.screen.dispose();
    e.screen = null;
    e.offData?.();
    e.offData = null;
    const codex = e.feed.host === "codex";
    const had = e.feed.card !== null || e.feed.printing || (codex && e.feed.status !== null);
    e.feed.card = null;
    e.feed.needsYou = false;
    e.feed.printing = false;
    e.cardSig = "";
    e.answered = null;
    if (codex) { e.feed.status = null; e.statusText = null; }
    return had;
  }

  /** The terminal was closed: its follower stops (main ends it with the terminal too), and its feed and screen go. */
  private closed(id: string): void {
    const e = this.entries.get(id);
    this.views.delete(id);
    if (!e) return;
    this.entries.delete(id);
    this.dropScreen(e);
    this.pollIfLive();
    for (const [p, owner] of [...this.byPath]) if (owner === id) this.byPath.delete(p);
    if (e.pty && e.feed.follow !== "off") {
      try { this.code()?.unfollow(e.pty); } catch { /* the bridge is gone */ }
    }
  }
}

/** Rows without the indent they all share (Codex draws its footer two columns in), so the status line starts where the
 *  composer does, as Claude Code's does. */
function dedent(rows: Span[][]): Span[][] {
  const lead = (r: Span[]): number => {
    let n = 0;
    for (const sp of r) {
      const m = /^ */.exec(sp.text)?.[0].length ?? 0;
      n += m;
      if (m < sp.text.length) return n;
    }
    return Number.POSITIVE_INFINITY;
  };
  const cut = Math.min(...rows.map(lead));
  if (!Number.isFinite(cut) || cut <= 0) return rows;
  return rows.map((r) => {
    let left = cut;
    const out: Span[] = [];
    for (const sp of r) {
      if (left <= 0) { out.push(sp); continue; }
      const take = Math.min(left, sp.text.length);
      left -= take;
      if (sp.text.length > take) out.push({ ...sp, text: sp.text.slice(take) });
    }
    return out;
  });
}
