// computer:* — the Computer pane's calls (agent-computer D5, D32). Every handler checks the sender (ipc/trust.ts) and
// parses its arguments; none reaches the service while the Computer surface is off, or answers anything but a refusal.

import { CH, type ComputerState, type Result } from "../../shared/ipc";
import { clampBounds, placeAllowed } from "../policy/computer";
import { ComputerAnswerArgs, ComputerMarkArgs, ComputerNavigateArgs, ComputerSelectArgs, ComputerShowArgs, ComputerTabArgs, NoArgs } from "./schemas";
import { onInvoke, onSend, type Trust } from "./trust";

/** The part of the service the page drives (main/computer/service.ts). */
export interface ComputerPageService {
  select(place: string | null): ComputerState | null;
  show(bounds: { x: number; y: number; width: number; height: number } | null): void;
  navigate(url: string): Promise<Result<null>>;
  tab(op: { kind: "new" } | { kind: "close" | "select"; index: number }): void;
  takeOver(): void;
  handBack(): void;
  answer(askId: string, a: "once" | "always" | "deny"): void;
  mark(origin: string, on: boolean): void;
  popOut(): void;
}

export interface ComputerIpc {
  /** Whether the Computer surface is on (read per call). */
  enabled: () => boolean;
  service: () => ComputerPageService;
  vaultRoot: () => string | null;
}

export const OFF: Extract<Result<never>, { ok: false }> = { ok: false, error: "The Computer pane is off", code: "EPERM" };

export function registerComputerIpc(trust: Trust, c: ComputerIpc): void {
  /** Runs `fn` on the service while the surface is on; a one-way call that finds it off is logged and dropped. */
  const when = (channel: string, fn: (s: ComputerPageService) => void): void => {
    if (!c.enabled()) { console.warn(`[main] ${channel}: ${OFF.error}`); return; }
    fn(c.service());
  };
  onInvoke(CH.computerSelect, trust, ComputerSelectArgs, async ({ place }) => {
    if (!c.enabled()) return { ok: true, data: null };
    if (place !== null && !placeAllowed(place, c.vaultRoot())) return { ok: false, error: "That place is not allowed", code: "EINVAL" };
    return { ok: true, data: c.service().select(place) };
  });
  onInvoke(CH.computerNavigate, trust, ComputerNavigateArgs, async ({ url }) => (c.enabled() ? c.service().navigate(url) : OFF));
  onSend(CH.computerShow, trust, ComputerShowArgs, ({ bounds }) => when(CH.computerShow, (s) => s.show(bounds ? clampBounds(bounds) : null)));
  onSend(CH.computerTab, trust, ComputerTabArgs, ({ op }) => when(CH.computerTab, (s) => s.tab(op)));
  onSend(CH.computerTakeOver, trust, NoArgs, () => when(CH.computerTakeOver, (s) => s.takeOver()));
  onSend(CH.computerHandBack, trust, NoArgs, () => when(CH.computerHandBack, (s) => s.handBack()));
  onSend(CH.computerAnswer, trust, ComputerAnswerArgs, ({ askId, a }) => when(CH.computerAnswer, (s) => s.answer(askId, a)));
  onSend(CH.computerMark, trust, ComputerMarkArgs, ({ origin, on }) => when(CH.computerMark, (s) => s.mark(origin, on)));
  onSend(CH.computerPopOut, trust, NoArgs, () => when(CH.computerPopOut, (s) => s.popOut()));
}
