// computerStore.ts — the HUD's one view of main's computers (agent-computer D27, D32, D35; ruling R51). Main sends the
// state of every computer it knows on each change (each state names its place) and a reveal when the person clicks an
// ask's desktop notification. One store per host keeps the latest state per place, subscribed once, and every reader
// takes what it needs from it: both pages' Computer panes, the Code and Sessions rail badges, and the dots on the Code
// and Sessions rows. No DOM; the host is the only thing it touches.

import { hudHost, type HostComputer, type HostComputerAsk, type HostComputerState } from "../host";

/** The two pages with a Computer pane: Code (the deck) and Sessions (its tab id stays "chat"). */
export type ComputerPage = "code" | "chat";

/** What a row of the Code or Sessions list shows for its session (D32, D35): a dot while its agent holds a computer that
 *  no pane shows, or waits on an ask; and waiting while it waits on one. */
export interface RowMarks { dot: boolean; waiting: boolean }

/** Where an ask is shown (M5): its page, and the agent session there to select (null: the page alone). */
export interface AskRoute { page: ComputerPage; session: string | null }

const NO_MARKS: RowMarks = { dot: false, waiting: false };

/** The page an agent key belongs to: `code:<terminal id>` is Code, `chat:<thread>` is Sessions; null for anything else. */
export function pageOfSession(session: string): ComputerPage | null {
  if (session.startsWith("code:")) return "code";
  if (session.startsWith("chat:")) return "chat";
  return null;
}

/** The agent key of a Sessions thread. */
export const chatSession = (thread: string): string => `chat:${thread}`;

/**
 * Where a Computer notification's Open the Computer pane goes (ruling R50): the page whose sessions wait on an ask, the
 * oldest ask's page when both pages' do, else the page that last showed the pane, else Sessions.
 */
export function pageToOpen(asks: readonly HostComputerAsk[], last: ComputerPage | null, pageOf: (a: HostComputerAsk) => ComputerPage | null = (a) => pageOfSession(a.session)): ComputerPage {
  const paged = asks.filter((a) => pageOf(a) !== null);
  const code = paged.some((a) => pageOf(a) === "code");
  const chat = paged.some((a) => pageOf(a) === "chat");
  if (code && !chat) return "code";
  if (chat && !code) return "chat";
  if (code && chat) return pageOf([...paged].sort((a, b) => a.at - b.at)[0]) as ComputerPage;
  return last ?? "chat";
}

export class ComputerStore {
  private states = new Map<string, HostComputerState>();
  private listeners = new Set<() => void>();
  private revealers = new Set<(askId: string) => void>();
  /** The place each page's pane gives a rectangle now; null when it gives none. */
  private onScreen: Record<ComputerPage, string | null> = { code: null, chat: null };
  /** The place main has selected (the last a pane in front selected), and whether it is popped out (every state carries
   *  main's one pop-out flag): a popped-out computer is on screen whatever the pane does, as main counts it. */
  private selected: string | null = null;
  private popped = false;
  /** The page whose pane was last in front (R50's fallback). */
  private lastPage: ComputerPage | null = null;
  /** M5: the agent session that last held each computer's wheel (a page's own ask goes where it drove), and the place each
   *  page's pane follows now. */
  private drivers = new Map<string, string>();
  private followed: Record<ComputerPage, string | null> = { code: null, chat: null };
  /** The ask a notification click asked to show, until the pane that shows it has scrolled to it. */
  private reveal: string | null = null;
  private off: (() => void) | null;

  constructor(readonly host: HostComputer) {
    this.off = host.onEvent((ev) => {
      if (ev.type === "state") this.put(ev.state);
      else this.revealAsk(ev.askId);
    });
  }

  /** A computer's state, from main's events or the pane's select. */
  put(s: HostComputerState): void {
    this.states.set(s.place, s);
    const driver = s.holder?.kind === "agent" ? s.holder.session : s.holder?.kind === "user" ? s.holder.resume?.session : undefined;
    if (driver && pageOfSession(driver)) this.drivers.set(s.place, driver);
    this.popped = s.poppedOut;
    if (this.reveal && !this.ask(this.reveal)) this.reveal = null;
    this.changed();
  }

  state(place: string): HostComputerState | null { return this.states.get(place) ?? null; }

  /** Every pending ask across the computers, oldest first; only those routed to `page` when it is given. */
  asks(page?: ComputerPage): HostComputerAsk[] {
    const all: HostComputerAsk[] = [];
    for (const s of this.states.values()) for (const a of s.asks) if (!page || this.route(a)?.page === page) all.push(a);
    return all.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Where an ask is shown (M5): an agent's ask on its session's page; a page's own ask (a download, a permission, a file
   * chooser, raised with no agent at the wheel) by its place, ask.computer: the page and session of the agent that last
   * drove that computer, else the page whose pane follows it now; null when nothing here can show it.
   */
  route(a: HostComputerAsk): AskRoute | null {
    const own = pageOfSession(a.session);
    if (own) return { page: own, session: a.session };
    const driver = this.drivers.get(a.computer);
    const page = driver ? pageOfSession(driver) : null;
    if (driver && page) return { page, session: driver };
    for (const p of ["code", "chat"] as const) if (this.followed[p] === a.computer) return { page: p, session: null };
    return null;
  }

  /** The place `page`'s pane follows (its selected terminal's or thread's), or null (M5). */
  noteFollowed(page: ComputerPage, place: string | null): void {
    if (this.followed[page] === place) return;
    this.followed[page] = place;
    this.changed();
  }

  /** A page's rail badge: the pending asks routed to it, wherever their computer is. */
  badge(page: ComputerPage): number { return this.asks(page).length; }

  ask(id: string): HostComputerAsk | null { return this.asks().find((a) => a.id === id) ?? null; }

  /** A row's marks for its session's agent key (null: a shell, a fallback, a Vault row). */
  marks(session: string | null): RowMarks {
    if (!session) return NO_MARKS;
    const waiting = this.asks().some((a) => a.session === session);
    const shown = new Set([this.onScreen.code, this.onScreen.chat, this.popped ? this.selected : null].filter((p): p is string => p !== null));
    let driving = false;
    for (const s of this.states.values()) {
      if (s.holder?.kind === "agent" && s.holder.session === session && !shown.has(s.place)) driving = true;
    }
    return { dot: waiting || driving, waiting };
  }

  /** The place a pane in front asked main to select (null: none). */
  noteSelected(place: string | null): void {
    if (this.selected === place) return;
    this.selected = place;
    this.changed();
  }

  /** The place `page`'s pane gives a rectangle now, or null. */
  setOnScreen(page: ComputerPage, place: string | null): void {
    if (this.onScreen[page] === place) return;
    this.onScreen[page] = place;
    this.changed();
  }

  /** `page`'s pane is in front: it becomes the page Open the Computer pane falls back to. */
  noteShown(page: ComputerPage): void { this.lastPage = page; }

  /** R50: the page Open the Computer pane goes to. */
  pageToOpen(): ComputerPage { return pageToOpen(this.asks(), this.lastPage, (a) => this.route(a)?.page ?? null); }

  /** Shows an ask (a notification's click, or Open the Computer pane): its readers route to its page and session, and
   *  the pane that shows it takes it. */
  revealAsk(askId: string): void {
    this.reveal = askId;
    for (const cb of [...this.revealers]) {
      try { cb(askId); } catch (err) { console.warn("[agentic-os] computer reveal:", err); }
    }
  }

  /** The ask waiting to be shown, if any. */
  revealing(): string | null { return this.reveal; }

  /** The pane showing `askId` takes the reveal; false when another ask (or none) is waiting. */
  takeReveal(askId: string): boolean {
    if (this.reveal !== askId) return false;
    this.reveal = null;
    return true;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  onReveal(cb: (askId: string) => void): () => void {
    this.revealers.add(cb);
    return () => { this.revealers.delete(cb); };
  }

  destroy(): void {
    this.off?.();
    this.off = null;
    this.listeners.clear();
    this.revealers.clear();
    if (stores.get(this.host) === this) stores.delete(this.host);
  }

  private changed(): void {
    for (const cb of [...this.listeners]) {
      try { cb(); } catch (err) { console.warn("[agentic-os] computer listener:", err); }
    }
  }
}

const stores = new Map<HostComputer, ComputerStore>();

/** The one store of a host's computers: made, and subscribed to the host, on first use. */
export function storeFor(host: HostComputer): ComputerStore {
  let s = stores.get(host);
  if (!s) { s = new ComputerStore(host); stores.set(host, s); }
  return s;
}

/** The installed host's store; null outside the app, which has no computer. */
export function computerStore(): ComputerStore | null {
  const c = hudHost().computer;
  return c ? storeFor(c) : null;
}

/** Lets every store go (the plugin unloads). */
export function closeComputerStores(): void {
  for (const s of [...stores.values()]) s.destroy();
  stores.clear();
}
