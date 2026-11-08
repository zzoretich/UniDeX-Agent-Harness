// Ask notices (agent-computer D27, D26): the agent works off-screen, so an ask raised while the pane does not show its
// computer gets a desktop notification and a Notifications item, and clicking the notification opens the pane on that ask.
// Both carry only app-written text: the ask's title (which the service builds from app-written labels and scrubbed names,
// D9) and a body naming the session. The ask's detail is never posted: it can quote page text and what the agent types,
// and the Notifications item is a file in the vault. Nothing here touches Electron, so the unit tests drive it with fakes.
//
// It also holds the test-build switches (Task 13), read once before the app is ready, which a packaged build ignores.

import path from "node:path";
import type { Ask } from "./asks";

export interface NotifierOptions {
  /** True when the pane shows the ask's computer (agent-computer D27: off-screen only). */
  visible: (ask: Ask) => boolean;
  /** Shows a desktop notification; may return a function that withdraws it (called once the ask has settled). */
  desktop: (title: string, body: string, onClick: () => void) => (() => void) | void;
  /** Posts the Notifications item (the runtime's notify.js, at level info so it raises no second alert). */
  post: (title: string, body: string) => Promise<void>;
  /** Opens the pane on the ask. */
  reveal: (askId: string) => void;
  /** Where a failed notice is reported (console.warn by default). */
  log?: (message: string) => void;
}

/** notify.js's MAX_TITLE. */
const TITLE_MAX = 160;
const LABEL_MAX = 80;
const FALLBACK_TITLE = "An agent is asking in the Computer pane";
/** How many ask ids are remembered, so a late repeat of the pending list never notices one again. */
const SEEN_MAX = 500;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One line of text: no control, bidirectional or zero-width characters, whitespace collapsed, and at most `max` UTF-16
 *  units (the runtime's measure), clipped with an ellipsis between characters, never inside one. */
function line(s: string, max: number): string {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let out = "";
  for (const ch of t) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** An ask's title as the runtime takes it (`notify.js post --title`): one line of 1–160 characters that cannot read as a
 *  flag (the `computer` surface's spawn rule). */
export function noticeTitle(title: string): string {
  return line(line(title, TITLE_MAX * 2).replace(/^[-\s]+/, ""), TITLE_MAX) || FALLBACK_TITLE;
}

function noticeBody(ask: Ask): string {
  const who = line(ask.sessionLabel, LABEL_MAX) || "An agent";
  return `${who} is waiting for your answer in the Computer pane. Open the pane to allow or deny it; with no answer in time it is denied.`;
}

export class AskNotifier {
  /** Every ask id noticed (or found on screen), oldest first. */
  private readonly seen = new Set<string>();
  /** Withdraws a pending ask's desktop notification. */
  private readonly withdraw = new Map<string, () => void>();
  private readonly log: (m: string) => void;

  constructor(private readonly o: NotifierOptions) {
    this.log = o.log ?? ((m) => console.warn(`[main] ${m}`));
  }

  /** A new ask: off-screen, a desktop notification (its click reveals the ask) and a Notifications item. Never throws. */
  added(ask: Ask): void {
    this.remember(ask.id);
    let shown: boolean;
    try { shown = this.o.visible(ask); } catch { shown = false; }
    if (shown) return;
    const title = noticeTitle(ask.title);
    const body = noticeBody(ask);
    try {
      const off = this.o.desktop(title, body, () => this.o.reveal(ask.id));
      if (typeof off === "function") this.withdraw.set(ask.id, off);
    } catch (e) {
      this.log(`the computer's desktop notification failed: ${message(e)}`);
    }
    void Promise.resolve()
      .then(() => this.o.post(title, body))
      .catch((e: unknown) => this.log(`the computer's Notifications item was not posted: ${message(e)}`));
  }

  /** The broker's pending asks after a change: each new one is noticed once; a settled one's desktop notification is
   *  withdrawn (its Notifications item stays, as a record). */
  sync(pending: readonly Ask[]): void {
    const now = new Set(pending.map((a) => a.id));
    for (const [id, off] of [...this.withdraw]) {
      if (now.has(id)) continue;
      this.withdraw.delete(id);
      try { off(); } catch { /* already gone */ }
    }
    for (const a of pending) if (!this.seen.has(a.id)) this.added(a);
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
  }
}

/**
 * The e2e suite's switches (agent-computer Task 13), both ignored by a packaged build:
 * - `AOS_E2E_HOST_RULES`: Chromium's `host-resolver-rules`, applied before ready, so the suite's fixture sites get
 *   unmarked `*.test` origins served on 127.0.0.1. One line, or nothing.
 * - `AOS_E2E_TRUSTED_CLI`: comma-separated real paths that admission (and a Code launch's install check) treats as a
 *   vendor-signed CLI, so a stub agent can reach the bridge. Absolute paths only.
 */
export function testSwitches(env: NodeJS.ProcessEnv, packaged: boolean): { hostRules: string | null; trustedCli: string[] } {
  if (packaged) return { hostRules: null, trustedCli: [] };
  const rules = (env.AOS_E2E_HOST_RULES ?? "").trim();
  const trustedCli = (env.AOS_E2E_TRUSTED_CLI ?? "").split(",").map((p) => p.trim()).filter((p) => p && path.isAbsolute(p));
  return { hostRules: rules && !/[\r\n]/.test(rules) ? rules : null, trustedCli };
}
