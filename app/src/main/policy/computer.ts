// What the page may ask of the Computer pane (agent-computer D5, D32, R17; session-browser S1 supersedes D3, D30 and D32's
// places). A computer belongs to a session: `code:<the id of the terminal's first process>` (`TerminalSession.originPty`) for a Code terminal, `chat:<thread>` for a Sessions
// thread. The page may select only a session the app holds; anything else is refused.

import type { ComputerRect } from "../../shared/ipc";

const MAX_BOUND = 10_000;

/** A Code terminal's key: `code:<the id of the terminal's first process>` (`TerminalSession.originPty`; the page's bridge counts these as t1, t2 … and starts again with each page load). */
export const CODE_KEY = /^code:t[0-9]{1,9}$/;
/** A Sessions thread's key: the thread is a v4 UUID, lower case (the session service makes it with randomUUID). */
export const CHAT_KEY = /^chat:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether `key` names a session the app holds: a key of the right shape whose terminal or thread `has` knows (S1). */
export function sessionAllowed(key: string, has: { terminal(id: string): boolean; thread(id: string): boolean }): boolean {
  if (key.length > 64) return false;
  if (CODE_KEY.test(key)) return has.terminal(key.slice("code:".length)) /* a pty id, "t3" */;
  if (CHAT_KEY.test(key)) return has.thread(key.slice("chat:".length));
  return false;
}

const clamp = (n: number): number => Math.min(MAX_BOUND, Math.max(0, n));

/** The pane's rectangle with every number held to 0–10000 (the schema has already required finite numbers). */
export function clampBounds(r: ComputerRect): ComputerRect {
  return { x: clamp(r.x), y: clamp(r.y), width: clamp(r.width), height: clamp(r.height) };
}
