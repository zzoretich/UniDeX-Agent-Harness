// computer:* — the Computer pane's calls (agent-computer D5; session-browser S1). Every handler checks the sender (ipc/trust.ts) and
// parses its arguments; none reaches the service while the Computer surface is off, or answers anything but a refusal.

import { CH, type ComputerState, type Result } from "../../shared/ipc";
import { clampBounds, sessionAllowed } from "../policy/computer";
import { ComputerAnswerArgs, ComputerDescribeArgs, ComputerMarkArgs, ComputerMoveArgs, ComputerNavArgs, ComputerNavigateArgs, ComputerOpenLinkArgs, ComputerPowerArgs, ComputerSelectArgs, ComputerShowArgs, ComputerTabArgs, NoArgs } from "./schemas";
import { onInvoke, onSend, type Trust } from "./trust";

/** The part of the service the page drives (main/computer/service.ts). */
export interface ComputerPageService {
  select: (session: string | null) => ComputerState | null;
  show: (bounds: { x: number; y: number; width: number; height: number } | null, inView?: boolean) => void;
  navigate: (url: string) => Promise<Result<null>>;
  openLink: (session: string, url: string) => Promise<Result<null>>;
  openOutside: () => Promise<Result<null>>;
  tab: (op: { kind: "new" } | { kind: "close" | "select"; index: number }) => void;
  nav: (go: "back" | "forward" | "reload") => void;
  takeOver: () => void;
  handBack: () => void;
  answer: (askId: string, a: "once" | "always" | "deny") => void;
  mark: (origin: string, on: boolean) => void;
  popOut: () => void;
  power: (session: string, on: boolean) => void;
  describe: (session: string, d: { title?: string; conversation?: { host: "claude" | "codex"; id: string } }) => void;
  move: (from: string, to: string) => boolean;
}

export interface ComputerIpc {
  /** Whether the Computer surface is on (read per call). */
  enabled: () => boolean;
  service: () => ComputerPageService;
  /** Whether main holds this terminal or thread (PtyService.holdsOrigin, SessionService.has). */
  sessions: { terminal(id: string): boolean; thread(id: string): boolean };
  /** Called after the service completed a `move` for two terminals main holds, whether it answered true or false (not when
   *  it threw or the keys were refused): the app's door moves its ids with the terminal row (session-browser A8). */
  moved?: (from: string, to: string) => void;
}

export const OFF: Extract<Result<never>, { ok: false }> = { ok: false, error: "The Computer pane is off", code: "EPERM" };

export function registerComputerIpc(trust: Trust, c: ComputerIpc): void {
  /** Runs `fn` on the service while the surface is on; a one-way call that finds it off is logged and dropped. */
  const when = (channel: string, fn: (s: ComputerPageService) => void): void => {
    if (!c.enabled()) { console.warn(`[main] ${channel}: ${OFF.error}`); return; }
    fn(c.service());
  };
  onInvoke(CH.computerSelect, trust, ComputerSelectArgs, async ({ session }) => {
    if (!c.enabled()) { console.warn(`[main] ${CH.computerSelect}: ${OFF.error}`); return OFF; }
    if (session !== null && !sessionAllowed(session, c.sessions)) return { ok: false, error: "That session is not allowed", code: "EINVAL" };
    return { ok: true, data: c.service().select(session) };
  });
  onInvoke(CH.computerNavigate, trust, ComputerNavigateArgs, async ({ url }) => (c.enabled() ? c.service().navigate(url) : OFF));
  onInvoke(CH.computerOpenLink, trust, ComputerOpenLinkArgs, async ({ session, url }) => {
    if (!c.enabled()) return OFF;
    if (!sessionAllowed(session, c.sessions)) return { ok: false, error: "That session is not allowed", code: "EPERM" };
    return c.service().openLink(session, url);
  });
  // session-browser S24: no argument; main reads the active tab's real address, so the page cannot name what leaves.
  onInvoke(CH.computerOpenOutside, trust, NoArgs, async () => (c.enabled() ? c.service().openOutside() : OFF));
  onSend(CH.computerShow, trust, ComputerShowArgs, ({ bounds, inView }) => when(CH.computerShow, (s) => s.show(bounds ? clampBounds(bounds) : null, inView)));
  onSend(CH.computerTab, trust, ComputerTabArgs, ({ op }) => when(CH.computerTab, (s) => s.tab(op)));
  onSend(CH.computerNav, trust, ComputerNavArgs, ({ go }) => when(CH.computerNav, (s) => s.nav(go)));
  onSend(CH.computerTakeOver, trust, NoArgs, () => when(CH.computerTakeOver, (s) => s.takeOver()));
  onSend(CH.computerHandBack, trust, NoArgs, () => when(CH.computerHandBack, (s) => s.handBack()));
  onSend(CH.computerAnswer, trust, ComputerAnswerArgs, ({ askId, a }) => when(CH.computerAnswer, (s) => s.answer(askId, a)));
  onSend(CH.computerMark, trust, ComputerMarkArgs, ({ origin, on }) => when(CH.computerMark, (s) => s.mark(origin, on)));
  onSend(CH.computerPopOut, trust, NoArgs, () => when(CH.computerPopOut, (s) => s.popOut()));
  onSend(CH.computerPower, trust, ComputerPowerArgs, ({ session, on }) => when(CH.computerPower, (s) => {
    if (!sessionAllowed(session, c.sessions)) { console.warn(`[main] ${CH.computerPower}: that session is not allowed`); return; }
    s.power(session, on);
  }));
  onSend(CH.computerDescribe, trust, ComputerDescribeArgs, ({ session, title, conversation }) => when(CH.computerDescribe, (s) => {
    if (!sessionAllowed(session, c.sessions)) { console.warn(`[main] ${CH.computerDescribe}: that session is not allowed`); return; }
    s.describe(session, { ...(title !== undefined ? { title } : {}), ...(conversation ? { conversation } : {}) });
  }));
  // session-browser S22: both ends must be terminals main holds (the old one is still open while its replacement starts).
  onInvoke(CH.computerMove, trust, ComputerMoveArgs, async ({ from, to }) => {
    if (!c.enabled()) { console.warn(`[main] ${CH.computerMove}: ${OFF.error}`); return { ok: true, data: false }; }
    if (!sessionAllowed(from, c.sessions) || !sessionAllowed(to, c.sessions)) return { ok: true, data: false };
    const moved = c.service().move(from, to);
    // The ids belong to the terminal row, not to whichever browser won (A8); a thrown move never gets here.
    try { c.moved?.(from, to); } catch { /* the app's map is not the page's concern */ }
    return { ok: true, data: moved };
  });
}
