// codeFeeds.ts — each agent terminal's chat, kept for the terminal's whole life (spec 2026-11-09 code-chat C1, C2, C5;
// rulings R3, R28, R31). One feed per agent terminal of the pool, whichever tab started it: `follow` once its first
// process is known (the agent main runs, or the shell a fallback typed its line into), with that pty id, the terminal's key
// and the conversation's id when the deck knows it; `unfollow` when the terminal is closed. The follower's cache
// (vault-relative) is read on each vault change of its path into a bounded buffer (the newest EVENT_CAP events, cut at a
// prompt), and the chat is worked out again only when something new arrived; Show earlier reads the whole cache once.
// A Claude Code terminal's status line is its copy of `aos statusline render`, brain/_index/statusline/<key>.json, read
// on each change of that file and shown whenever it is there (R3; Codex's comes from its screen, Task 12). Which view
// each terminal shows is kept here too, so it survives the Code tab's remounts. No DOM: the HudHost is all it touches.

import * as path from "path";
import { readCacheAll } from "./pastChat";
import { codeChatOn, fs as hostFs, hudHost, type HostCode, type HostFs, type HostResult, type HostSessionEvent } from "../host";
import { CacheTail, chatFromEvents, trimEvents, type ChatState } from "./codeChat";
import { allowCodeHref, ansiLines, type Span } from "./ansiSpans";
import type { TerminalPool } from "./terminalPool";
import type { TerminalSession } from "./terminalSession";
import { listen } from "./listen";

/** Rows a chat shows, and how many more each Show earlier adds. */
export const ROW_CAP = 400;
/** Events a chat keeps in memory (R31); a longer conversation drops its oldest turns until Show earlier. */
export const EVENT_CAP = 4000;
/** How far past the cap the buffer may grow before it is trimmed again (a trim copies it). */
const TRIM_SLACK = 1000;
/** Reads of one change at most (each reads up to 4 MB): a cache that keeps growing is read again at its next change. */
const MAX_READS = 64;

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
  /** The status line's rows, or null when there is none to show (the composer's hint). */
  status: Span[][] | null;
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
  statusText: string | null;
}

const EMPTY: ChatState = { sessionId: null, rows: [], hiddenEarlier: 0, turnOpen: false, error: null, model: null };

export interface CodeFeedsOptions {
  /** The vault folder the follower's cache and the vault's change events are relative to. */
  vaultRoot: () => string;
  /** The host's Code calls (absent outside the app); default: the installed HudHost's. */
  code?: () => HostCode | undefined;
  fs?: HostFs;
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
  private abs(rel: string): string { return path.join(this.o.vaultRoot(), rel); }

  /** Whether the Code chat surface is on for this run of the app (C13). */
  on(): boolean { return codeChatOn(); }

  /** An agent terminal's chat; null for a shell or a terminal the pool no longer has. */
  get(id: string): CodeFeed | null { return this.entries.get(id)?.feed ?? null; }

  /** How many events a chat holds in memory (R31's bound, until Show earlier). */
  buffered(id: string): number { return this.entries.get(id)?.events.length ?? 0; }

  /** What the terminal shows: its chat by default, an agent's only and only while the surface is on (C1, C3, C13). */
  view(id: string): CodeView {
    const s = this.pool.get(id);
    if (!s || s.meta.host === "shell" || !this.on()) return "terminal";
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
    if (this.disposed || !s || s.meta.host === "shell") return;
    let e = this.entries.get(s.id);
    if (!e) {
      const host = s.meta.host;
      const on = this.on() && !!this.code();
      e = {
        feed: { id: s.id, host, follow: on ? "pending" : "off", error: null, cache: null, state: EMPTY, status: null },
        pty: null, asked: false, root: s.meta.place?.dir ?? s.cwd, tail: null, events: [], dropped: 0, full: false,
        maxRows: ROW_CAP, statusRel: null, statusText: null,
      };
      this.entries.set(s.id, e);
      // Only a terminal that carries its key (the surface on) has a status line copy of its own.
      if (on && host === "claude") {
        e.statusRel = `brain/_index/statusline/${s.meta.terminalKey}.json`;
        this.byPath.set(e.statusRel, s.id);
        this.readStatus(e);
      }
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

  /** The terminal was closed: its follower stops (main ends it with the terminal too), and its feed goes. */
  private closed(id: string): void {
    const e = this.entries.get(id);
    this.views.delete(id);
    if (!e) return;
    this.entries.delete(id);
    for (const [p, owner] of [...this.byPath]) if (owner === id) this.byPath.delete(p);
    if (e.pty && e.feed.follow !== "off") {
      try { this.code()?.unfollow(e.pty); } catch { /* the bridge is gone */ }
    }
  }
}
