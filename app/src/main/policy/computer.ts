// What the page may ask of the Computer pane (agent-computer D5, D32, R17; session-browser S1 supersedes D3, D30 and D32's
// places). A computer belongs to a session: a Code terminal, `code:<the id of the terminal's first process>`
// (`TerminalSession.originPty`). The page may select only a session the app holds; anything else is refused.

import type { ComputerRect } from "../../shared/ipc";

const MAX_BOUND = 10_000;

/** A Code terminal's key: `code:<the id of the terminal's first process>` (`TerminalSession.originPty`; the page's bridge counts these as t1, t2 … and starts again with each page load). */
export const CODE_KEY = /^code:t[0-9]{1,9}$/;
/** Whether `key` names a session the app holds: a Code key whose terminal `has` knows (S1). */
export function sessionAllowed(key: string, has: { terminal(id: string): boolean }): boolean {
  if (key.length > 64) return false;
  if (CODE_KEY.test(key)) return has.terminal(key.slice("code:".length)) /* a pty id, "t3" */;
  return false;
}

const clamp = (n: number): number => Math.min(MAX_BOUND, Math.max(0, n));

/** The pane's rectangle with every number held to 0–10000 (the schema has already required finite numbers). */
export function clampBounds(r: ComputerRect): ComputerRect {
  return { x: clamp(r.x), y: clamp(r.y), width: clamp(r.width), height: clamp(r.height) };
}
