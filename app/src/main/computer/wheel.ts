// Who holds the wheel of a computer (agent-computer D31, D34): one agent session at a time, or the person. An agent's hold
// frees after 30 s idle (never while the computer is reserved by an ask or a running action) and when its turn ends.
// R81 (AC-R3-01): each computer has a cancellation generation, bumped by Take over, Hand back and the end of a turn, so
// an acting call that started under an older one delivers nothing more, even once the same session holds it again.

import { realClock, type Clock } from "./asks";

export type Holder =
  | { kind: "agent"; session: string; label: string }
  | { kind: "user"; resume: { session: string; label: string } | null }
  | null;

const IDLE_MS = 30_000;

export class Wheel {
  private holders = new Map<string, Holder>();
  private timers = new Map<string, unknown>();
  private gens = new Map<string, number>();
  private readonly idleMs: number;
  private readonly clock: Clock;

  constructor(private o: { idleMs?: number; clock?: Clock; reserved: (computer: string) => boolean; onChange: (computer: string, h: Holder) => void }) {
    this.idleMs = o.idleMs ?? IDLE_MS;
    this.clock = o.clock ?? realClock;
  }

  holder(computer: string): Holder { return this.holders.get(computer) ?? null; }

  /** R81: the computer's cancellation generation (0 until its first Take over, Hand back or turn end). */
  gen(computer: string): number { return this.gens.get(computer) ?? 0; }

  take(computer: string, session: string, label: string): { ok: true } | { ok: false; busy: string } {
    const h = this.holder(computer);
    if (h?.kind === "user") return { ok: false, busy: "the user is driving" };
    if (h && h.session !== session) return { ok: false, busy: `${h.label} is driving` };
    if (!h) this.set(computer, { kind: "agent", session, label });
    this.arm(computer);
    return { ok: true };
  }

  touch(computer: string, session: string): void {
    const h = this.holder(computer);
    if (h?.kind === "agent" && h.session === session) this.arm(computer);
  }

  /** The session's turn ended (or its CLI's registration did): the computers it held or would resume get a new
   *  generation (R81). */
  turnEnded(session: string): void {
    for (const [computer, h] of [...this.holders]) {
      if (h?.kind === "agent" && h.session === session) { this.bump(computer); this.set(computer, null); }
      else if (h?.kind === "user" && h.resume?.session === session) { this.bump(computer); this.set(computer, { kind: "user", resume: null }); }
    }
  }

  takeOver(computer: string): void {
    const h = this.holder(computer);
    const resume = h?.kind === "agent" ? { session: h.session, label: h.label } : h?.kind === "user" ? h.resume : null;
    this.bump(computer);
    this.set(computer, { kind: "user", resume });
  }

  handBack(computer: string): void {
    const h = this.holder(computer);
    if (h?.kind !== "user") return;
    this.bump(computer);
    this.set(computer, h.resume ? { kind: "agent", session: h.resume.session, label: h.resume.label } : null);
    if (h.resume) this.arm(computer);
  }

  /** session-browser S5: the person ended whatever the agent was doing (the browser switched off, the active tab closed): a
   *  new generation, so a call that started under the old one delivers nothing more. With `free`, nobody holds the wheel
   *  afterwards (the browser is gone); without, the holder keeps it. */
  interrupt(computer: string, free = false): void {
    this.bump(computer);
    if (free && this.holder(computer)) this.set(computer, null);
  }

  /** session-browser S22: a Code session's browser now has another key (its terminal was replaced): the hold, its idle
   *  timer and the generation move with it, so a call that started under the old key still reads the same generation. */
  rekey(from: string, to: string): void {
    if (from === to) return;
    this.disarm(from);
    const h = this.holders.get(from);
    const gen = this.gens.get(from);
    this.holders.delete(from);
    this.gens.delete(from);
    this.disarm(to);
    this.holders.delete(to);
    if (gen !== undefined) this.gens.set(to, gen); else this.gens.delete(to);
    // The holder names its session: renamed too, so the old terminal's late `turnEnded(from)` frees nothing here.
    if (h) {
      const moved: Holder = h.kind === "agent" ? { ...h, session: h.session === from ? to : h.session } : { kind: "user", resume: h.resume ? { ...h.resume, session: h.resume.session === from ? to : h.resume.session } : null };
      this.holders.set(to, moved);
      if (moved?.kind === "agent") this.arm(to);
    }
  }

  private bump(computer: string): void { this.gens.set(computer, this.gen(computer) + 1); }

  private set(computer: string, h: Holder): void {
    this.disarm(computer);
    if (h) this.holders.set(computer, h); else this.holders.delete(computer);
    this.o.onChange(computer, h);
  }

  private arm(computer: string): void {
    this.disarm(computer);
    this.timers.set(computer, this.clock.setTimeout(() => {
      this.timers.delete(computer);
      if (this.holder(computer)?.kind !== "agent") return;
      if (this.o.reserved(computer)) this.arm(computer); else this.set(computer, null);
    }, this.idleMs));
  }

  private disarm(computer: string): void {
    const t = this.timers.get(computer);
    if (t !== undefined) this.clock.clearTimeout(t);
    this.timers.delete(computer);
  }
}
