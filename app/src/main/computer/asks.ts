// The ask broker (agent-computer D34, D7): an agent's action that needs the person's yes waits here. A tool call holds
// for up to 45 s; if the person has not answered it returns `waiting_for_user` and the ask stays pending, so the agent
// can `wait` on it again. The ask expires as denied at the configured timeout, measured from when it was raised.

import { randomUUID } from "node:crypto";
import type { AskWhy } from "./gate";

export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void }

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

/** `always`: the card offers "Always on <site>" (agent-computer D6, D39); absent or false, an "always" answer counts as
 *  once. */
export interface AskInput { computer: string; session: string; sessionLabel: string; why: AskWhy; title: string; detail: string; site: string | null; always?: boolean }
export interface Ask extends AskInput { id: string; at: number }
export type Answer = "once" | "always" | "deny";
export type Outcome =
  | { state: "allowed" | "denied"; askId: string; answer?: Answer; reason?: string }
  | { state: "waiting_for_user"; askId: string };

const HOLD_MS = 45_000;
const KEEP_MS = 60_000;

interface Settled { outcome: Outcome; drop: unknown }
interface Entry { ask: Ask; expiry: unknown; waiters: Set<(o: Outcome) => void> }

export class AskBroker {
  private entries = new Map<string, Entry>();
  // Outcomes kept after an ask settles, so a wait that comes after the answer still sees it.
  private settled = new Map<string, Settled>();
  private readonly holdMs: number;
  private readonly clock: Clock;

  constructor(private o: { timeoutMs: () => number; holdMs?: number; clock?: Clock; onChange: (pending: readonly Ask[]) => void }) {
    this.holdMs = o.holdMs ?? HOLD_MS;
    this.clock = o.clock ?? realClock;
  }

  hold(input: AskInput): Promise<Outcome> {
    const ask: Ask = { ...input, id: randomUUID(), at: this.clock.now() };
    const entry: Entry = { ask, expiry: null, waiters: new Set() };
    entry.expiry = this.clock.setTimeout(() => this.settle(ask.id, { state: "denied", askId: ask.id, reason: "timed out" }), Math.max(0, this.o.timeoutMs()));
    this.entries.set(ask.id, entry);
    this.o.onChange(this.pending());
    return this.wait(ask.id);
  }

  wait(askId: string): Promise<Outcome> {
    const kept = this.settled.get(askId);
    if (kept) return Promise.resolve(kept.outcome);
    const entry = this.entries.get(askId);
    if (!entry) return Promise.resolve({ state: "denied", askId, reason: "unknown ask" });
    return new Promise<Outcome>((resolve) => {
      const timer = this.clock.setTimeout(() => { entry.waiters.delete(done); resolve({ state: "waiting_for_user", askId }); }, this.holdMs);
      const done = (o: Outcome): void => { this.clock.clearTimeout(timer); resolve(o); };
      entry.waiters.add(done);
    });
  }

  answer(askId: string, a: Answer): boolean {
    if (!this.entries.has(askId)) return false;
    this.settle(askId, a === "once" || a === "always" ? { state: "allowed", askId, answer: a } : { state: "denied", askId, answer: "deny" });
    return true;
  }

  cancel(match: (a: Ask) => boolean, reason: string): number {
    const ids = [...this.entries.values()].filter((e) => match(e.ask)).map((e) => e.ask.id);
    for (const id of ids) this.settle(id, { state: "denied", askId: id, reason });
    return ids.length;
  }

  pending(computer?: string): readonly Ask[] {
    const all = [...this.entries.values()].map((e) => e.ask);
    return computer === undefined ? all : all.filter((a) => a.computer === computer);
  }

  private settle(askId: string, outcome: Outcome): void {
    const entry = this.entries.get(askId);
    if (!entry) return;
    this.entries.delete(askId);
    this.clock.clearTimeout(entry.expiry);
    const keepMs = Math.max(entry.ask.at + this.o.timeoutMs() - this.clock.now(), KEEP_MS);
    this.settled.set(askId, { outcome, drop: this.clock.setTimeout(() => this.settled.delete(askId), keepMs) });
    for (const w of [...entry.waiters]) w(outcome);
    this.o.onChange(this.pending());
  }
}
