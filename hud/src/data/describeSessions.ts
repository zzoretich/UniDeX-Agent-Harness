// What the Code page tells main about each Code session (session-browser S6, S7): its title, for the app's own cards, and
// the conversation it runs, so a resumed conversation gets its browser's tabs back. Sent when a row's title or
// conversation differs from what main was last told, not on every redraw.
import type { HostConversation } from "../host";

export type Conversation = HostConversation;
export interface Described { session: string; title: string; conversation?: Conversation }

const sigOf = (r: Described): string => JSON.stringify([r.title, r.conversation?.host ?? null, r.conversation?.id ?? null]);

/** The rows whose title or conversation differs from `seen` (session key → what was last sent), which it updates. A row
 *  that is gone is forgotten, so a session key that comes back is described again. */
export function describeChanged(seen: Map<string, string>, rows: readonly Described[]): Described[] {
  const out: Described[] = [];
  const now = new Set<string>();
  for (const r of rows) {
    now.add(r.session);
    const sig = sigOf(r);
    if (seen.get(r.session) === sig) continue;
    seen.set(r.session, sig);
    out.push(r);
  }
  for (const k of [...seen.keys()]) if (!now.has(k)) seen.delete(k);
  return out;
}
