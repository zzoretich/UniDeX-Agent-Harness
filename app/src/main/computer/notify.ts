// Ask notices (agent-computer D27, D26): the agent works off-screen, so an ask raised while the pane does not show its
// computer gets a desktop notification and a Notifications item, and clicking the notification opens the pane on that ask.
// At most one notice per session waits unanswered (M11): its later asks reach the pane only, until that one settles.
// Both carry only app-written text: the ask's notice (its labels, the action's kind and the site's host, I1) and a body
// naming the session. Neither the card's title (which can quote the page's name for the control) nor its detail (page
// text and what the agent types) is ever posted: the Notifications item is a file in the vault that agents read, and
// unread titles reach the briefing's prompt. Nothing here touches Electron, so the unit tests drive it with fakes.
//
// It also holds the test-build switches (agent-computer D18, D39), read once before the app is ready, which a packaged
// build ignores.

import path from "node:path";
import type { Ask } from "./asks";

export interface NotifierOptions {
  /** True when the person can see the ask's computer in the pane now (agent-computer D27: off-screen only). */
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
/** How many noticed ask ids are remembered, so a later pending list never notices one again. */
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
  /** Every ask id noticed, oldest first. An ask found on screen is not: it is noticed if it goes off-screen while still
   *  pending (the app calls `sync` when its window blurs, hides or minimizes). */
  private readonly seen = new Set<string>();
  /** Withdraws a pending ask's desktop notification. */
  private readonly withdraw = new Map<string, () => void>();
  /** M11: each noticed ask still pending, by id, with its session's key on its computer: one unanswered notice each. */
  private readonly unanswered = new Map<string, string>();
  private readonly log: (m: string) => void;

  constructor(private readonly o: NotifierOptions) {
    this.log = o.log ?? ((m) => console.warn(`[main] ${m}`));
  }

  /** An ask not yet noticed: off-screen, a desktop notification (its click reveals the ask) and a Notifications item,
   *  once. M11: while its session (a page's own asks: per computer) already has a notice unanswered, it only reaches the
   *  pane, and is noticed once that one settles if it is still pending and off-screen. Never throws. */
  added(ask: Ask): void {
    if (this.seen.has(ask.id)) return;
    // The person's own Send this form again card: they pressed Reload in this window a moment ago, so no one is waiting
    // for them, and a notice (worded for an agent) would put their own button press into the vault. It stays in the pane
    // and times out harmlessly.
    if (ask.why === "resendown") return;
    const who = `${ask.computer}\u0000${ask.session}`;
    if ([...this.unanswered.values()].includes(who)) return;
    let shown: boolean;
    try { shown = this.o.visible(ask); } catch { shown = false; }
    if (shown) return;
    this.remember(ask.id);
    this.unanswered.set(ask.id, who);
    const title = noticeTitle(ask.notice);
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

  /** The pending asks, after the broker changes or the app's window blurs, hides or minimizes: each one off-screen is
   *  noticed once; a settled one's desktop notification is withdrawn (its Notifications item stays, as a record). */
  sync(pending: readonly Ask[]): void {
    const now = new Set(pending.map((a) => a.id));
    for (const id of [...this.unanswered.keys()]) if (!now.has(id)) this.unanswered.delete(id);
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
 * The e2e suite's switches, all three ignored by a packaged build:
 * - `AOS_E2E_HOST_RULES`: Chromium's `host-resolver-rules`, applied before ready, so the suite's fixture sites get
 *   unmarked `*.test` origins served on 127.0.0.1 (agent-computer D39). One line, or nothing.
 * - `AOS_E2E_TRUSTED_CLI`: comma-separated real paths that admission (and a Code launch's install check) treats as a
 *   vendor-signed CLI, so a stub agent can reach the bridge (D18). Absolute paths only.
 * - `AOS_E2E_START_PAGE`: a test seam for the start page a tab the person opens starts on, whose search the address bar
 *   uses for words (hud/src/data/computerStart.ts; DuckDuckGo otherwise), so the suite's new tabs and searches reach its
 *   local fixture, never the real search engine. An http or https page with no query or fragment (the search adds
 *   `?q=`), as the browser loads it, or nothing.
 */
export function testSwitches(env: NodeJS.ProcessEnv, packaged: boolean): { hostRules: string | null; trustedCli: string[]; startPage: string | null } {
  if (packaged) return { hostRules: null, trustedCli: [], startPage: null };
  const rules = (env.AOS_E2E_HOST_RULES ?? "").trim();
  const trustedCli = (env.AOS_E2E_TRUSTED_CLI ?? "").split(",").map((p) => p.trim()).filter((p) => p && path.isAbsolute(p));
  return { hostRules: rules && !/[\r\n]/.test(rules) ? rules : null, trustedCli, startPage: startSwitch(env.AOS_E2E_START_PAGE) };
}

/** `AOS_E2E_START_PAGE` as the browser loads it, or null for anything but an http or https page with no query or fragment. */
function startSwitch(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v || /[\s?#]/.test(v)) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}
