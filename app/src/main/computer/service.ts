// The computer service (agent-computer D3, D17, D21, D30–D35, D39): takes an admitted agent's tool call to its session's
// browser and runs it through the wheel (one driver, D31), the gate (go, ask or refuse, D17, D39, D43), the ask broker
// (D7, D34) and the browser, and serves the operations the pane calls (D5, D32). D9: text that leaves the main process
// (ask titles and details, replies, log lines, notes) never carries a raw page-derived name: a target's name goes out as
// `Resolved.shown` / `Focus.shown`, other page text through `browser.scrub(text, tab)`, while the gate judges the raw
// target. I1: even scrubbed, a page's name for a control stays on the person's side (the card, the activity log, a Chat
// thread's live lines); a notice and every reply to an agent name an ask by its app-written labels, the action's kind and
// the site's host only (`AskInput.notice`). Nothing here touches Electron, so the unit tests drive it with a fake browser
// and a fake clock.

import { realClock, type Answer, type Ask, type AskBroker, type AskInput, type Clock, type Outcome } from "./asks";
import type { BrowserHooks, ComputerBrowser, FocusId, Judged, Resolved, TabInfo } from "./browser";
import { FocusMoved, forPerson, PageChanged, Told } from "./cdp";
import type { ToolCall, ToolReply } from "./bridge";
import { categoriesOf, type AskCategory, type Target } from "./categories";
import type { ComputerConfig } from "./config";
import { judge, type AskWhy, type Focus, type Verdict } from "./gate";
import type { Rect } from "./mask";
import { REFUSAL } from "./refusals";
import type { Point, Pointer } from "./pointer";
import { OUTLINE_MAX, UNREAD, withPage } from "./reply";
import type { AgentRef } from "./registry";
import { cleanTitle, tagText } from "./title";
import type { SiteMarks } from "./sites";
import type { Holder, Wheel } from "./wheel";
import { CODE_KEY } from "../policy/computer";
import { linkUrl, navAllowed, siteOf, withoutUserinfo } from "../policy/computer-url";
import { externalAllowed } from "../policy/shell";
import type { BrowserRecords, Conversation } from "./records";
import type { ComputerNavGo, ComputerPower, Result } from "../../shared/ipc";
import { START_PAGE } from "../../../../hud/src/data/computerStart";

export interface LogLine { at: number; session: string; text: string }
export interface ComputerState { session: string; label: string; tabs: TabInfo[]; holder: Holder; asks: readonly Ask[]; log: readonly LogLine[]; marked: boolean; poppedOut: boolean; power: ComputerPower }

/** The part of `ComputerBrowser` the service drives. */
export type BrowserLike = Pick<ComputerBrowser, "tabs" | "activeWebContentsId" | "pageToken" | "open" | "openTab" | "select" | "close" | "nav" | "snapshot" | "console" | "screenshot" | "resolve" | "focus" | "scrub" | "click" | "hoverAt" | "entry" | "navEntry" | "mayHoldForm" | "tabUid" | "tabIndex" | "ownTab" | "tabToken" | "type" | "key" | "scroll" | "show" | "destroy" | "sleep" | "wake" | "asleep" | "restore" | "realAddresses" | "activeAddress" | "settled" | "viewBox" | "windowPoint" | "focusCorner">;

/** The tabs without `about:blank` (a tab that has not loaded yet is not worth restoring), the active index following its tab. */
function withoutBlank(t: { urls: string[]; active: number }): { urls: string[]; active: number } {
  const urls = t.urls.filter((u) => u !== "about:blank");
  const active = t.urls.slice(0, t.active).filter((u) => u !== "about:blank").length;
  return { urls, active: Math.min(active, Math.max(0, urls.length - 1)) };
}

export interface ServiceOptions {
  /** Makes the browser of a session (once per session); its hooks route page asks, notes and changes back here. */
  browser: (session: string, hooks: BrowserHooks) => BrowserLike;
  /** The service destroyed that session's browser (the page went); the app forgets its handle. */
  destroyed?: (session: string) => void;
  /** Main's own name for a session key, for a state when no agent of the session is registered: a thread's title. */
  label?: (session: string) => string | undefined;
  /** The app tells main's browser handle map that a Code session's browser now belongs to another key (`move`). */
  moved?: (from: string, to: string) => void;
  /** Whether a Sessions thread still exists; `boot` forgets the record of one that is confirmed missing (session-browser S6).
   *  `undefined` means "cannot tell" (no vault attached, its sessions folder unreadable): the record is kept. */
  threadExists?: (session: string) => boolean | undefined;
  /** Each browser's power and tabs, kept across a quit (session-browser S6, S7). */
  records: BrowserRecords;
  broker: AskBroker;
  /** Built with `reserved: (c) => service.reserved(c)` and `onChange: (c) => service.refresh(c)`. */
  wheel: Wheel;
  sites: SiteMarks;
  config: () => ComputerConfig;
  emit: (s: ComputerState) => void;
  /** A line for the agent's Chat thread (a live `computer` event) or Code session (D35). The service has already put it
   *  in the session's activity log (`ComputerState.log`). */
  note: (agent: AgentRef, line: string) => void;
  /** Moves the session's browser into the pop-out window (the app's window code). `front` is set only by the user's own
   *  Pop out press: the window comes forward even when it already exists; a follow never sets it. */
  popOut?: (session: string | null, show: { label: string; on: boolean; front?: boolean }) => void;
  /** The live agent the app's registry holds for a session key (AgentRegistry.byKey), so a late `agentGone` from a
   *  session's previous process is ignored. */
  liveAgent?: (key: string) => AgentRef | undefined;
  /** Where a tab the person opens (the pane's +) starts: START_PAGE (hud/src/data/computerStart.ts, DuckDuckGo) unless
   *  main was given the e2e suite's fixture (computer/notify.ts testSwitches). */
  startPage?: string;
  /** Whether the app holds this session (a terminal or a thread): the check the page's calls use. A program's open for any
   *  other session is dropped and makes no slot (session-browser S23). Absent: no session is held. */
  held?: (session: string) => boolean;
  /** Sends an address to the Mac's own browser (index.ts) and says, once the system has taken it, whether it went: true only
   *  when the hand-off resolved, false for anything but https (session-browser S24, X4). It may reject. */
  outside: (url: string) => Promise<boolean>;
  /** A line for main's log. Never an address or an id (session-browser S23). */
  log?: (line: string) => void;
  /** The pointer main draws above the browser (session-browser S18): a click, a hover and typing travel it to the target before
   *  the page's mouse moves and before anything is delivered, and it hides at once at a Take over, a switch off and when the page
   *  under it goes. Absent: no pointer, no delay. */
  pointer?: Pick<Pointer, "moveTo" | "pulse" | "touch" | "hide" | "warm" | "keepWithin">;
  clock?: Clock;
}

type Reply = Omit<ToolReply, "id">;

/** What each ask is, in app-written text at the head of its card, so a scrubbed or page-chosen name cannot hide what the
 *  action is (agent-computer D6, D9, D43). */
export const ASK_LABELS: Readonly<Record<AskWhy, string>> = Object.freeze({
  submit: "Submit", purchase: "Purchase", send: "Send", delete: "Delete", merge: "Merge", signin: "Sign in", download: "Download",
  unmarked: "Act on a site you haven't marked", return: "Press Return", file: "Choose a file", permission: "Grant a permission",
  frame: "Act inside a frame from another site", power: "Turn on the browser",
  closetab: "Close a tab it did not open", resend: "Load a page again, which may send a form again",
  // The person's own Reload on a form's result page (session-browser S13): no agent raised it.
  resendown: "Send a form again",
});

const CATEGORIES: ReadonlySet<string> = new Set<AskCategory>(["submit", "purchase", "send", "delete", "merge", "signin", "download"]);
const isCategory = (w: AskWhy): w is AskCategory => CATEGORIES.has(w);
/** agent-computer D6, D39: "Always on <site>" marks the site (unmarked) or allows a category for it. Return, file,
 *  download, permission and frame asks are asked every time. */
const offersAlways = (w: AskWhy): boolean => w === "unmarked" || (isCategory(w) && w !== "download");

const LOOK: ReadonlySet<string> = new Set(["computer_status", "computer_snapshot", "computer_screenshot", "computer_wait", "computer_console"]);
/** S3: after a Not now (or a switch off) a session's opens answer the same sentence, no card, for this long on Code. */
export const QUIET_MS = 60_000;
/** The most addresses held for one Turn on card (session-browser S23); a seventh while it is up is dropped. */
const PROGRAM_HOLD = 6;
/** The `session` of a Turn on card a program's open raised: not an agent's, so a turn's end never cancels it and an agent's
 *  own open never mistakes it for its card. */
const PROGRAM = "program";
/** The cancel reason of a program's Turn on card that gives way to an agent's for the same session (one card a session): its
 *  held addresses ride the agent's card, so `settleProgram` ignores this reason. */
const PROGRAM_YIELD = "an agent's Turn on card replaces it";
/** The cancel reason of a power ask the person answered by turning the browser on by hand: the held open then runs. */
const ON_BY_HAND = "the user turned the browser on";
/** The cancel reason main gives every ask when the page goes (index.ts `endPageWork`): the pages a program held for a card
 *  that ended so are dropped with a line, never given a new card for a page that has gone (session-browser A2). */
export const PAGE_GONE = "the app's window closed or reloaded";
/** Why a program's open or its held pages are dropped while the Computer setting is off (main's log line, never an address). */
const SETTING_OFF = "the computer is off in Settings";
const PAGE = { session: "page", label: "the page" } as const;
/** The `session` of a card the person's own press raised (the Reload of a form's result page): not an agent's, so no turn's end,
 *  no call's wait and no wheel reservation ever meets it, and not "the page", which would blame the site. */
const PERSON = "person";
/** The busy reply's sentence for a session whose hold is gone: freed, or (R81) its process no longer the registered one. */
const NOT_HELD = "this session no longer holds the wheel";
const USER = "You";
/** What a double click says when the first click ran and the second press was not sent (PR 5, A2: the page changed under the
 *  first, the call stopped being current, or a check before the second failed): the end of both the agent's reply and the
 *  person's log line, after `Clicked <what> once: `. A change after the second press went is the ordinary double-click line
 *  (the browser answers `once: false`), since that press was sent. */
const DOUBLE_ONCE = "the second click was not sent";
const LOG_MAX = 200;
/** The most a read of the focused field's corner may take before typing goes on with no pointer (session-browser S18). */
const CORNER_MS = 150;
/** How long a settled ask's reply stays for `computer_wait`. */
const KEEP_MS = 120_000;
const POLL_MS = 500;
const WAIT_MAX_SEC = 40;
const TEXT_WAIT_SEC = 10;

/** One session's browser (session-browser S1; this design supersedes agent-computer D3, D30 and D32's per-place computers). */
interface Slot {
  key: string;
  browser: BrowserLike | null;
  /** S2: a slot starts off, with no browser; only the user (or a Turn on answer) turns it on. */
  power: ComputerPower;
  /** The REAL addresses Off closed and the one that was active, for On to reopen (S5). Main only: they reopen through
   *  `restore`, so the agent sees them only in the hidden form (S9). */
  remembered: { urls: string[]; active: number } | null;
  /** S3: the sentence a `computer_open` gets without a card, until `until` (a time on the service's clock; null on Chat:
   *  until the agent's turn ends). Cleared by a manual On. A timestamp, not a timer, so dropping a slot leaves nothing. */
  quiet: { sentence: string; until: number | null; pid: number | null } | null;
  /** The tabs On is reopening, until it has finished: Off before then remembers these, not the half-made set. */
  reopening: { urls: string[]; active: number } | null;
  /** S5: why the calls started before the wheel's generation `gen` were stopped by the person. */
  stopped: { gen: number; sentence: string } | null;
  /** Every stop of the last few (session-browser S16): a call's reply names the first one after it started, whatever followed. */
  stops: { gen: number; sentence: string }[];
  /** The agent's reply reads (the settle wait and the outline), one after another in the order their steps ended; nothing of
   *  the person's ever waits on it. */
  replies: Promise<unknown>;
  /** Reply reads in progress: like a look in flight, the browser is not put to sleep and the wheel not freed under them. */
  reading: number;
  log: LogLine[];
  /** The agent that called on this computer last: where a page's own notes go when no agent holds the wheel. */
  last: AgentRef | null;
  /** Actions under way (the wheel never frees under one, D31). */
  running: number;
  /** S9: a counter value, higher the more recently the session was used (selected, or an agent called). */
  used: number;
  /** S9: the wake in progress (it runs in the slot's queue); calls and the user's navigate wait for it. */
  waking: Promise<void> | null;
  /** Steps in the queue, waiting or running: a browser with any never goes to sleep (S9). */
  queued: number;
  /** Look calls (snapshot, screenshot) in flight: they run outside the queue, and a browser with one never sleeps (S9). */
  looking: number;
  /** S6: the name the Code page described this session by (cleaned), ahead of every other name. */
  title: string | null;
  /** The name main gave the session (`ServiceOptions.label`, cleaned) as last read, "" when it had none; null when not read
   *  yet. Read once per slot: `retitled` and `select` drop it, so a state emit never reads a thread's file. */
  named: string | null;
  /** S7: the conversation this Code session runs, kept with its record. */
  conversation: Conversation | null;
  /** The record last scheduled for writing, as JSON, so only a change schedules another. */
  sig: string;
  /** The pending write of the record (a timer on the service's clock), or null. */
  save: unknown | null;
  /** The last real addresses the browser answered with: while the slot is on but its browser object is gone (the app is
   *  quitting) the record keeps these, never "no tabs" (session-browser S6). */
  known: { urls: string[]; active: number } | null;
  /** Addresses a program opened while the browser was off, waiting for the Turn on card (session-browser S23). They open, in
   *  order, when the browser is turned on, and are dropped by a Not now, a switch off or the end of the session. */
  programOpens: string[];
  /** Serialises the computer's acting steps, so one action's hover, check and press never interleave with another's. */
  queue: Promise<unknown>;
  /** The person's Send this form again card for this session, and the tab and page it was raised for. It lives on the slot,
   *  not in a map by key: a terminal hand-over renames the slot and the record goes with it. */
  ownCard: { askId: string; uid: number; token: string } | null;
}

/** An action the gate asks about. `whys` is never empty; the first names the card. */
interface AskSpec {
  whys: AskWhy[];
  /** App-written title and notice that replace the composed ones (the power ask). */
  card?: { title: string; notice: string };
  /** The action for the card: may quote the control's (scrubbed) page name. */
  action: string;
  /** The same action in app-written words only ("Click", "Type 5 characters", "Press Space"), for the notice (I1). */
  kind: string;
  detail: string;
  site: string | null;
  /** The control whose categories "Always" allows. */
  target: Target | null;
  /** True when the action is still the one the person approved (agent-computer D31). */
  revalidate: () => Promise<boolean>;
  run: () => Promise<Reply>;
}
type Step = { reply: Reply } | { ask: AskSpec };
/** An asked action: the session that asked, whether its ask has settled, and its reply once it has run. */
interface Job {
  session: string; answered: boolean; done: Promise<Reply>;
  /** The slot, to read the page of the reply once it is collected; and that read, made once (PR 5, A5). */
  slot: Slot; collected: Promise<Reply> | null;
}
/** R81 (AC-R3-01): what an acting call holds from its start: its session's cancellation generation (Wheel.gen). The call's
 *  own AgentRef is its registration identity (its pid). Both are checked after every await in the call's path, before an
 *  ask is raised and in the predicate before each input event (`current`, `stale`). */
interface Lease {
  gen: number;
  /** session-browser S16: the call's 45 s (a time on the service's clock) while it is the call that holds the reply: the
   *  wait behind earlier reads, the settle wait and the start of the read never run past it. null once the call was turned
   *  into an ask, whose reply `computer_wait` carries (it has its own limit). */
  until: number | null;
}

type By = { ref: string } | { x: number; y: number };
type Parsed =
  | { kind: "open"; url: string; newTab: boolean }
  | { kind: "click"; by: By; double: boolean }
  | { kind: "type"; text: string; ref: string | null }
  | { kind: "key"; key: string }
  | { kind: "scroll"; dx: number; dy: number; ref: string | null }
  | { kind: "tab"; index: number; close: boolean }
  | { kind: "nav"; go: ComputerNavGo }
  | { kind: "hover"; by: By };

export { cleanTitle } from "./title";
/** How long after a change a record is written (session-browser S6). */
export const SAVE_MS = 500;

const fail = (text: string): Reply => ({ text, isError: true });
/** A refusal that also names the page where it stands (the sentence from the table, then the page line). */
const refuseAt = (sentence: string, url: string | null): Reply => fail(`${sentence} ${pageLine(url)}`);
/** The reads `done` noted for the replies it made, finished once the queue is free (session-browser S16). */
const deferred = new WeakMap<Reply, { run: () => Promise<Reply>; unread: () => Reply; late: () => boolean; lease: Lease }>();
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const waiting = (id: string): string => `waiting_for_user: call computer_wait with askId "${id}"`;
const running = (id: string): string => `running: the user allowed it and the action is still running; call computer_wait with askId "${id}" again`;
/** D21 (R69): a page's address as page text: its path and query are the page's to choose, so it goes to the agent inside
 *  the untrusted wrapper, after its origin, as snapshots carry page text. The URL is the one `tabs()` gives (already
 *  scrubbed, D9); a parsed URL holds no `<` or `>`, and one that did would be percent-encoded here, so it cannot close
 *  the wrapper. */
export function untrustedUrl(url: string): string {
  return `<untrusted-page origin="${siteOf(url) ?? "null"}">${url.replace(/</g, "%3C").replace(/>/g, "%3E")}</untrusted-page>`;
}
const pageLine = (url: string | null): string => (url ? `Page: ${untrustedUrl(url)}` : "No page is open.");
/** R77: the same for the person's card, whose text is shown as text, not read by a model: the address as it is, never
 *  in the wrapper's markup. */
const cardPage = (url: string | null): string => (url ? `Page: ${url}` : "No page is open.");
const bare = (title: string): string => title.replace(/\?$/, "");

/** Text for an app-written sentence (already scrubbed when it came from the page): no control or bidirectional
 *  characters, so it cannot read differently in a card than on the page; whitespace collapsed; clipped. */
function clean(s: string, max = 120): string {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
const quoted = (shown: string): string => `“${clean(shown)}”`;

function hostOf(site: string | null): string {
  if (!site) return "this page";
  try { return new URL(site).host || site; } catch { return site; }
}

const same = (x: Target | null, y: Target | null): boolean =>
  x === y || (!!x && !!y && x.role === y.role && x.name === y.name && x.inForm === y.inForm && x.fileInput === y.fileInput && !!x.opaque === !!y.opaque);
const sameSet = (a: readonly number[], b: readonly number[]): boolean => {
  const x = new Set(a), y = new Set(b);
  return x.size === y.size && [...x].every((n) => y.has(n));
};
/** R76: the same focused element, by its node and frame as well as by what it is, so focus moving to a same-named control
 *  fails; a target whose node could not be read never counts as the same (fails closed). */
const sameFocus = (a: Focus, b: Focus): boolean => a.node === b.node && a.frame === b.frame && !(a.target && a.node === null)
  && same(a.target, b.target) && a.sensitive === b.sensitive && a.plainTextarea === b.plainTextarea;
const idOf = (f: Focus): FocusId => ({ node: f.node, frame: f.frame });

function typeAction(text: string, shown: string): string {
  const n = Array.from(text).length;
  const lines = text.split(/\r\n|\r|\n/).length;
  return `Type ${n} character${n === 1 ? "" : "s"}${lines > 1 ? ` on ${lines} lines` : ""}${shown ? ` into ${quoted(shown)}` : ""}`;
}

function parse(call: ToolCall): Parsed | string {
  const a = call.args;
  if (a.ref !== undefined && (typeof a.ref !== "string" || !a.ref || a.ref.length > 32)) return REFUSAL.badRef;
  const ref = typeof a.ref === "string" ? a.ref : null;
  switch (call.tool) {
    case "computer_open":
      return typeof a.url === "string" && a.url && a.url.length <= 8192 ? { kind: "open", url: a.url, newTab: a.newTab === true } : REFUSAL.noUrl;
    case "computer_click": {
      if (a.double !== undefined && typeof a.double !== "boolean") return REFUSAL.badDouble;
      const double = a.double === true;
      if (ref) return { kind: "click", by: { ref }, double };
      return finite(a.x) && finite(a.y) ? { kind: "click", by: { x: a.x, y: a.y }, double } : REFUSAL.noTarget;
    }
    case "computer_tab":
      if (typeof a.index !== "number" || !Number.isInteger(a.index) || a.index < 0) return REFUSAL.badTab;
      if (a.close !== undefined && typeof a.close !== "boolean") return REFUSAL.badClose;
      return { kind: "tab", index: a.index, close: a.close === true };
    case "computer_nav":
      return a.go === "back" || a.go === "forward" || a.go === "reload" ? { kind: "nav", go: a.go } : REFUSAL.badGo;
    case "computer_hover":
      if (ref) return { kind: "hover", by: { ref } };
      return finite(a.x) && finite(a.y) ? { kind: "hover", by: { x: a.x, y: a.y } } : REFUSAL.noHover;
    case "computer_type":
      return typeof a.text === "string" && a.text && a.text.length <= 20_000 ? { kind: "type", text: a.text, ref } : REFUSAL.noText;
    case "computer_key":
      return typeof a.key === "string" && a.key && a.key.length <= 40 ? { kind: "key", key: a.key } : REFUSAL.noKey;
    case "computer_scroll":
      return finite(a.dy) && (a.dx === undefined || finite(a.dx)) ? { kind: "scroll", dx: finite(a.dx) ? a.dx : 0, dy: a.dy, ref } : REFUSAL.noDistance;
    default:
      return REFUSAL.unknownTool;
  }
}

function tabArg(a: Record<string, unknown>): number | undefined | null {
  if (a.tab === undefined) return undefined;
  return typeof a.tab === "number" && Number.isInteger(a.tab) && a.tab >= 0 ? a.tab : null;
}

function outcomeLine(o: Outcome, input: AskInput): string {
  if (o.state === "allowed") return o.answer === "always" && input.always ? `Allowed always on ${hostOf(input.site)}: ${input.title}` : `Allowed once: ${input.title}`;
  if (o.state === "denied") return o.answer === "deny" ? `Denied: ${input.title}` : o.reason === "timed out" ? `No answer in time, so denied: ${input.title}` : `Cancelled because ${o.reason ?? "it was cancelled"}: ${input.title}`;
  return `Still waiting: ${input.title}`;
}

/** The reply to an ask that was not allowed, naming it by its app-written notice only (I1). */
function deniedText(o: Outcome, notice: string): string {
  if (o.state !== "denied" || o.answer === "deny") return REFUSAL.denied(bare(notice));
  if (o.reason === "timed out") return REFUSAL.timedOut(bare(notice));
  return REFUSAL.cancelled(`${o.reason ?? "it was cancelled"} (${bare(notice)})`);
}

export class ComputerService {
  /** Each session's browser, by session key (`code:<the id of the terminal's first process>` (`TerminalSession.originPty`), `chat:<thread>`). */
  private readonly slots = new Map<string, Slot>();
  /** Each asked action's reply by ask id, for `computer_wait`; the session that asked. */
  private readonly jobs = new Map<string, Job>();
  /** The latest ref of each session that called, by session key. */
  private readonly agents = new Map<string, AgentRef>();
  private selected: string | null = null;
  /** Whether the page says the pane is in view (session-browser S12); false until it says so, and after pageGone. */
  private inView = false;
  private stamp = 0;
  private bounds: Rect | null = null;
  private popped = false;
  /** The session whose browser the pointer last travelled in (session-browser S18): a hide for another session is none. */
  private pointerFor: string | null = null;
  /** The uid of the tab the pointer was last drawn over: a tab brought in front that is this one covers nothing new. */
  private pointerTab: number | null = null;
  /** Set by `flushForQuit`: records are closed, nothing is tracked or written. A browser made later (a quit that failed)
   *  opens them again. */
  private closed = false;
  /** From `flushForQuit` until `quitCancelled`: no browser or view is made, nothing is written, calls are refused. */
  private quitting = false;
  private readonly clock: Clock;
  /** The one scheduled `trim(null)` that `released()` asks for, if it has not run yet (coalesces repeated releases). */
  private releasing: unknown = null;

  constructor(private readonly o: ServiceOptions) {
    this.clock = o.clock ?? realClock;
  }

  // ---- agent calls

  async call(given: AgentRef, call: ToolCall): Promise<Reply> {
    // A label that did not come through the registry is cleaned here the same way (session-browser S22).
    const agent: AgentRef = { ...given, label: cleanTitle(given.label) || "Agent" };
    if (!this.o.config().enabled) return fail(REFUSAL.off);
    if (this.quitting) return fail(REFUSAL.quitting);
    // session-browser S1: the session is its own browser (it supersedes D3 and D30, where the folder was).
    const p = this.slot(agent.key);
    this.agents.set(agent.key, agent);
    try {
      // S9: an agent's call is a use, and an asleep browser wakes before it runs (its reloads hold the queue). The call's
      // 45 s count from here, so the time spent waiting for the wake is inside them.
      const deadline = this.clock.now() + this.o.broker.holdMs;
      this.touch(p);
      this.wakeUp(p);
      if (p.waking && !(await this.within(p.waking, deadline))) return fail(REFUSAL.late);
      if (this.slots.get(p.key) !== p) return fail(REFUSAL.restarted);
      return LOOK.has(call.tool) ? await this.look(agent, p, call) : await this.act(agent, p, call, deadline);
    } catch (e) {
      return fail(message(e));
    }
  }

  /** Look tools never take the wheel and answer while another session or the user drives (agent-computer D31). */
  private async look(agent: AgentRef, p: Slot, call: ToolCall): Promise<Reply> {
    // S9: a read in flight keeps its browser awake (looks run outside the queue and the wheel, so trim cannot see them).
    p.looking++;
    // When the look ends the awake limit is applied again, as the reply reads do: a browser that turned on meanwhile may have left
    // this one over it (PR 5, X4).
    try { return await this.lookTool(agent, p, call); } finally { p.looking--; this.released(); }
  }

  private async lookTool(agent: AgentRef, p: Slot, call: ToolCall): Promise<Reply> {
    const a = call.args;
    if (call.tool === "computer_status") return { text: this.status(agent, p) };
    // S3: an ask's id still works while the browser is off (it is how the agent waits on the Turn on ask).
    if (call.tool === "computer_wait") return p.power === "off" && a.askId === undefined ? fail(REFUSAL.isOff) : this.wait(agent, p, a);
    if (p.power === "off") return fail(REFUSAL.isOff);
    const tab = tabArg(a);
    if (tab === null) return fail(REFUSAL.badTab);
    const b = this.browserOf(p);
    // D21: the snapshot is page text, already scrubbed and wrapped as untrusted data with its origin.
    // I2: its refs are this session's own.
    if (call.tool === "computer_snapshot") return { text: (await b.snapshot(tab, agent.key)).text };
    // session-browser: the tab's console log, already scrubbed and wrapped as untrusted page text; a look, so no outline.
    if (call.tool === "computer_console") return { text: await b.console(tab) };
    const png = await b.screenshot(tab);
    const shot = tab === undefined ? b.tabs().find((t) => t.active) : b.tabs()[tab];
    return { image: { data: png.toString("base64"), mimeType: "image/png" }, text: `A screenshot of ${shot?.url ? untrustedUrl(shot.url) : "the page"}, with password fields painted over.` };
  }

  /** True once `work` settles, false when the clock reaches `deadline` first (`work` goes on). */
  private within(work: Promise<void>, deadline: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = this.clock.setTimeout(() => resolve(false), Math.max(0, deadline - this.clock.now()));
      void work.then(() => { this.clock.clearTimeout(timer); resolve(true); });
    });
  }

  private async act(agent: AgentRef, p: Slot, call: ToolCall, start?: number): Promise<Reply> {
    // D34 (R76): an asked call returns by the broker's hold (45 s) counted from the call's start, whatever it waits on.
    const deadline = start ?? this.clock.now() + this.o.broker.holdMs;
    // R81 (AC-R3-01): the call is bound to its place's generation as it is now, and to the calling process.
    const lease: Lease = { gen: this.o.wheel.gen(p.key), until: deadline };
    const parsed = parse(call);
    if (typeof parsed === "string") return fail(parsed);
    if (p.power === "off") {
      // S3: off, only an open gets anywhere, and a Read only session is told to ask the user instead.
      if (parsed.kind !== "open") return fail(REFUSAL.isOff);
      if (agent.access === "read") return fail(REFUSAL.offReadOnly);
    } else {
      // D17: a Read only session is refused before it can hold the wheel.
      const ro = judge({ kind: "scroll" }, { access: agent.access, marked: false });
      if ("refuse" in ro) return fail(ro.refuse);
    }
    if (parsed.kind === "open") {
      const v = judge({ kind: "open", url: parsed.url }, { access: agent.access, marked: false });
      if ("refuse" in v) return fail(v.refuse);
      if (p.power === "off") {
        const q = this.quietReply(p, agent);
        if (q) return q;
      }
    }
    // R81: a process the registry no longer holds for its key (the thread's next CLI replaced it) never takes the wheel.
    if (!this.registered(agent)) return fail(this.busy(p.key, NOT_HELD));
    const took = this.o.wheel.take(p.key, agent.key, agent.label);
    if (!took.ok) return fail(this.busy(p.key, took.busy));
    // Only a session that acted gets the page's own notes when no one holds the wheel (a look never does).
    p.last = agent;
    try {
      // R78: the deadline bounds the queue and the target read too: a call that has not taken the computer by then
      // returns, and its step never delivers input or raises an ask.
      const reply = await this.bounded(deadline, async (g) => {
        const step = await this.serial(p, () => (g.alive() ? this.step(agent, p, parsed, g.take, lease) : Promise.resolve<Step>({ reply: fail(REFUSAL.late) })));
        if ("reply" in step) return step.reply;
        // R81: writing the card awaited the page's text; no ask is raised for a call that is no longer current.
        const gone = this.stale(p, agent, lease);
        if (gone) return gone;
        return g.take() ? this.ask(agent, p, step.ask, deadline, lease) : fail(REFUSAL.late);
      });
      // The queue is free: the settle wait and the outline (session-browser S16).
      return await this.finished(p, reply);
    } catch (e) {
      // S5: a browser destroyed under the call rejects it with the browser's own error; the person's stop is the answer.
      return this.stopped(p, lease) ?? fail(message(e));
    } finally {
      this.o.wheel.touch(p.key, agent.key);
    }
  }

  /** S3: the quiet sentence while this agent's opens are being refused without a card, else null (and the period is over).
   *  A Chat period belongs to the turn (the process) it started in; a Code period to the clock. */
  private quietReply(p: Slot, agent: AgentRef): Reply | null {
    const q = p.quiet;
    return this.quietOn(p, agent.pid) && q ? fail(q.sentence) : null;
  }

  /** Whether the quiet period of S3 is on for a caller whose turn is `pid`; an ended period is cleared. */
  private quietOn(p: Slot, pid: number | undefined): boolean {
    const q = p.quiet;
    if (q && (q.until === null ? q.pid !== null && q.pid === pid : this.clock.now() < q.until)) return true;
    p.quiet = null;
    return false;
  }

  /** Whether the quiet period of S3 is on for a program's open (it has no process of its own: a Chat period lasts until the
   *  turn it started in ends); an ended period is cleared. */
  private quietNow(p: Slot): boolean {
    // A period with no end time lasts while the turn it started in is the session's live one; with no turn (the person's Off
    // between turns made it) it is over at once, for a program as for an agent.
    return this.quietOn(p, (this.o.liveAgent?.(p.key) ?? this.agents.get(p.key))?.pid);
  }

  /** D34 (R76, R78): `work`'s reply, bound to the call's deadline until it takes the computer. `take()`, called just
   *  before an action delivers input and before an ask is raised, is false once the deadline has passed; at the deadline
   *  a call that has not taken it returns LATE, and its work, still queued or reading, does nothing more. Once taken, the
   *  work runs on (an ask then keeps its own deadline) and its reply is the call's. */
  private bounded(deadline: number, work: (g: { take: () => boolean; alive: () => boolean }) => Promise<Reply>): Promise<Reply> {
    let gone = false, taken = false;
    const alive = (): boolean => !gone && this.clock.now() < deadline;
    const take = (): boolean => {
      if (!alive()) { gone = true; return false; }
      taken = true;
      return true;
    };
    return new Promise<Reply>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => { if (!taken) { gone = true; resolve(fail(REFUSAL.late)); } }, Math.max(0, deadline - this.clock.now()));
      void work({ take, alive }).then((r) => { this.clock.clearTimeout(timer); resolve(r); }, (e: unknown) => { this.clock.clearTimeout(timer); reject(e); });
    });
  }

  /** The open itself. The person may switch the browser off while it loads (S5): the reply is then theirs. */
  private async doOpen(agent: AgentRef, p: Slot, a: { url: string; newTab: boolean }, lease: Lease): Promise<Reply> {
    const b = this.browserOf(p);
    try {
      // The agent's own open: the one place a tab becomes the agent's own (session-browser PR 5, X2).
      await b.open(a.url, { newTab: a.newTab, by: agent.label, own: true });
    } catch (e) {
      // The person may switch the browser off or close the tab while it loads: the load then rejects (S5).
      return this.stopped(p, lease) ?? fail(message(e));
    }
    const since = this.clock.now();
    if (p.browser !== b) return this.stopped(p, lease) ?? fail(REFUSAL.isOff);
    const url = this.url(b);
    // D39: a URL the agent opens itself is logged, not asked.
    this.line(p, agent.label, `Opened ${url ?? a.url}`, agent);
    return this.done(p, b, "Opened the page.", since, lease);
  }

  /** Resolves the target, judges it, and runs the action when the verdict is go; returns the ask otherwise. `take` claims
   *  the computer just before input is delivered (R78: false once the call's deadline has passed). R81: after the queue,
   *  and after each read of the page, the call must still be current (`lease`). */
  private async step(agent: AgentRef, p: Slot, a: Parsed, take: () => boolean, lease: Lease): Promise<Step> {
    const busy = this.stale(p, agent, lease);
    if (busy) return { reply: busy };
    if (p.power === "off") {
      // S3: the open that finds the browser off asks the user to turn it on; the allowed ask turns it on and runs the open.
      if (a.kind !== "open") return { reply: fail(REFUSAL.isOff) };
      // Inside the queue: a denied ask ahead of this call has started the quiet period by now (S3), and a Turn on card
      // already up is the one this call waits on, so a retry never raises a second.
      const quiet = this.quietReply(p, agent);
      if (quiet) return { reply: quiet };
      const up = this.o.broker.pending(p.key).find((x) => x.why === "power" && x.session === agent.key);
      if (up) return { reply: { text: waiting(up.id) } };
      // One Turn on card a session, whoever asked first: a program's card gives way to this one, and the addresses a program
      // held ride it (session-browser S23).
      this.o.broker.cancel((x) => x.computer === p.key && x.why === "power" && x.session === PROGRAM, PROGRAM_YIELD);
      const host = hostOf(siteOf(a.url));
      return { ask: {
        whys: ["power"], card: { title: `${p.title ?? agent.label} wants to turn its browser on and open ${host}`, notice: "turn the browser on" },
        action: "Turn on the browser", kind: "Turn on the browser", detail: cardPage(withoutUserinfo(a.url)), site: null, target: null,
        revalidate: () => Promise.resolve(true),
        run: async () => {
          // A session forgotten while its card was up opens nothing (S22).
          if (this.slots.get(p.key) !== p) return fail(REFUSAL.isOff);
          if (p.power === "off") this.turnOn(p);
          // Turn on through any card leaves no other Turn on card up, as turning on by hand does.
          this.o.broker.cancel((x) => x.computer === p.key && x.why === "power", ON_BY_HAND);
          // What a program opened behind this card follows the agent's own page, in the slot's queue.
          this.flushProgramOpens(p);
          return this.doOpen(agent, p, a, lease);
        },
      } };
    }
    const b = this.browserOf(p);
    switch (a.kind) {
      case "open": {
        if (!take()) return { reply: fail(REFUSAL.late) };
        return { reply: await this.doOpen(agent, p, a, lease) };
      }
      case "click": return this.click(agent, p, b, a.by, a.double, take, lease);
      case "tab": return this.tabStep(agent, p, b, a, take, lease);
      case "nav": return this.navStep(agent, p, b, a.go, take, lease);
      case "hover": return this.hoverStep(agent, p, b, a.by, take, lease);
      case "type": return this.typeStep(agent, p, b, a.text, a.ref, take, lease);
      case "key": return this.keyStep(agent, p, b, a.key, take, lease);
      case "scroll": {
        const at = a.ref ? await b.resolve({ ref: a.ref }, agent.key) : undefined;
        const late = this.stale(p, agent, lease);
        if (late) return { reply: late };
        if (!take()) return { reply: fail(REFUSAL.late) };
        const lost = await this.deliver(p, agent, lease, (valid) => b.scroll(a.dx, a.dy, valid, at));
        if (lost) return { reply: lost };
        return { reply: await this.done(p, b, `Scrolled by (${a.dx}, ${a.dy}).`, this.clock.now(), lease) };
      }
    }
  }

  private async click(agent: AgentRef, p: Slot, b: BrowserLike, by: By, double: boolean, take: () => boolean, lease: Lease): Promise<Step> {
    // session-browser S18: the pointer arrives before the page's mouse moves (inside the read, after the box is read).
    const got = await this.resolveFirst(p, agent, lease, b, by, "arrow");
    if ("reply" in got) return { reply: got.reply };
    const r = got.r;
    // R81: a Take over and Hand back (or the process's replacement) during the target read ends the call here.
    const read = this.stale(p, agent, lease);
    if (read) return { reply: read };
    const site = this.siteAt(b, r.tab);
    const need = this.need(judge({ kind: "click", target: r.target }, { access: agent.access, marked: this.markedAt(b, r.tab) }), r.target, site);
    if (need && typeof need === "object") return { reply: fail(need.refuse) };
    const did = "ref" in by ? by.ref : `at (${by.x}, ${by.y})`;
    // A double click is a second act on the page, so the card and the log say so (session-browser S17).
    const verb = double ? "Double-click" : "Click", done = double ? "Double-clicked" : "Clicked";
    const run = async (x: Resolved): Promise<Reply> => {
      // session-browser S18: the pointer shows (again, after a card) at the target the press will land on: where it already is
      // this costs nothing. The travel is an await, so it goes BEFORE the look below: R81, nothing is awaited between that look
      // and the delivery.
      const went = await this.travel(p, agent, lease, b, "arrow", x.tab, x.point);
      if (went.reply) return went.reply;
      const late = this.stale(p, agent, lease);
      if (late) return late;
      let once = false;
      const lost = await this.deliver(p, agent, lease, async (valid) => { once = (await b.click(x, valid, { double })).once; });
      if (lost) return lost;
      if (went.moved) this.pulse(p);
      const since = this.clock.now();
      // A double click whose first click changed the page (PR 5, A2): the first click happened, so this is an answer, not a
      // failure (a retry would raise a second card for what already ran), with the page as it is now.
      const what = x.shown ? quoted(x.shown) : "an unnamed control";
      if (once) {
        this.line(p, agent.label, `Clicked ${what} once: ${DOUBLE_ONCE}`, agent);
        return this.done(p, b, `Clicked ${did} once: ${DOUBLE_ONCE}.`, since, lease);
      }
      this.line(p, agent.label, `${done} ${what}`, agent);
      return this.done(p, b, `${done} ${did}.`, since, lease);
    };
    if (!need) return { reply: take() ? await run(r) : fail(REFUSAL.late) };
    let fresh = r;
    return {
      ask: {
        whys: [need], site, target: r.target,
        action: r.shown ? `${verb} ${quoted(r.shown)}` : `${verb} an unnamed control`, kind: verb,
        detail: `${await this.described(b, r.target, r.shown, r.tab)}. ${cardPage(b.tabs()[r.tab]?.url ?? null)}`,
        revalidate: async () => {
          const r2 = await this.reresolve(b, by, r, agent.key);
          if (!r2) return false;
          fresh = r2;
          return true;
        },
        run: () => run(fresh),
      },
    };
  }

  /** session-browser S17: switches to a tab, or closes one. X2: the agent closes without asking only a tab that its own
   *  `computer_open` made (or a popup its own click made: the tab's `own` fact, which never leaves main); every other (the
   *  person's, a program's, another agent's, one restored from the record) asks `closetab`, whatever name it was opened under.
   *  Closing the last tab makes a start tab first, so the browser stays on (S5). The tab is known by its uid from here on
   *  and the page on the card by the tab's page token (D1): another page in the same tab is not the card's. */
  private async tabStep(agent: AgentRef, p: Slot, b: BrowserLike, a: { index: number; close: boolean }, take: () => boolean, lease: Lease): Promise<Step> {
    const tab = b.tabs()[a.index];
    if (!tab) return { reply: fail(REFUSAL.noTab(String(a.index))) };
    // The tab is known by its uid from here on: an index shifts when another tab closes while a card is up.
    const uid = b.tabUid(a.index);
    const token = uid === null ? null : b.tabToken(uid);
    const url = tab.url;
    const site = this.siteAt(b, a.index);
    const need = this.need(judge({ kind: "tab", close: a.close, byUser: a.close && !(uid !== null && b.ownTab(uid)) }, { access: agent.access, marked: this.markedAt(b, a.index) }), null, site);
    if (need && typeof need === "object") return { reply: fail(need.refuse) };
    // Where the tab is now (-1: it is gone), and whether it still shows the page the card was raised for.
    const where = (): number => (uid === null ? -1 : b.tabIndex(uid));
    const same = (): boolean => uid !== null && token !== null && b.tabToken(uid) === token;
    const run = async (): Promise<Reply> => {
      const late = this.stale(p, agent, lease);
      if (late) return late;
      if (!a.close) {
        b.select(a.index);
        const since = this.clock.now();
        this.line(p, agent.label, `Switched to tab ${a.index}`, agent);
        return this.done(p, b, `Switched to tab ${a.index}.`, since, lease);
      }
      const already = (): Reply => this.done(p, b, "That tab is already closed.", this.clock.now(), lease);
      if (where() < 0) return already();
      if (!same()) return refuseAt(REFUSAL.changed, this.url(b));
      if (b.tabs().length === 1) {
        // The last tab: the browser stays on with one new tab (S5), made first. Its making is the one await (milliseconds):
        // `openTab` answers the tab's uid once it exists and never waits on the start page, whose load the reply's settle wait
        // covers; a load that fails leaves the tab on its error page. Not the agent's own tab (no `own`): the person's to keep,
        // as the one "+" makes is (X2 sets it only for computer_open).
        let made: number;
        try {
          made = await b.openTab(this.o.startPage ?? START_PAGE, { by: agent.label });
        } catch {
          // The tab could not be made: nothing is closed, and the reply is the person's stop or a sentence of ours, never the
          // browser's text.
          return this.stopped(p, lease) ?? (p.browser === b ? fail(REFUSAL.startTab) : fail(REFUSAL.isOff));
        }
        // From here to the close nothing is awaited, so what is checked is what the close meets. The new tab is known by the uid
        // `openTab` answered, never as "a tab not there before". When the call cannot go on, nothing of the person's is closed:
        // the new tab goes again only if it is still there and not the tab in front (nobody can be looking at it).
        const undo = (): void => {
          const i = b.tabIndex(made);
          if (i >= 0 && !b.tabs()[i].active && b.tabs().length > 1) b.close(i);
        };
        const interrupted = this.stale(p, agent, lease);
        if (interrupted) { undo(); return interrupted; }
        if (p.browser !== b) return fail(REFUSAL.isOff);
        if (where() < 0) { undo(); return already(); }
        if (!same()) { undo(); return refuseAt(REFUSAL.changed, this.url(b)); }
        if (b.tabIndex(made) < 0) return fail(REFUSAL.tabClosed);
      }
      const at = where();
      b.close(at);
      const since = this.clock.now();
      this.line(p, agent.label, `Closed tab ${at}`, agent);
      return this.done(p, b, "Closed the tab.", since, lease);
    };
    if (!need) return { reply: take() ? await run() : fail(REFUSAL.late) };
    const title = clean(tab.title, 80);
    return {
      ask: {
        whys: [need], site, target: null,
        action: `Close tab ${a.index}`, kind: "Close tab",
        detail: `${title ? `${quoted(title)}. ` : ""}${cardPage(url)}`,
        // A tab that is gone is for `run` to say ("already closed"); one still there on another page is not the card's.
        revalidate: () => Promise.resolve(where() < 0 || same()),
        run,
      },
    };
  }

  /** session-browser S17: Back, Forward or Reload of the active tab. Back and Forward never ask and never read the history: on
   *  this Electron they cannot send a form again (the plan's F7), so the method of the entry does not matter; nothing to go back
   *  or forward to is a refusal, not an ask. A Reload reads the method the entry would load by: a GET goes, anything else asks
   *  `resend`, and an allowed reload of an entry that was not a GET goes through the protocol, which sends the form again
   *  (Electron's own reload does nothing for it). */
  private async navStep(agent: AgentRef, p: Slot, b: BrowserLike, go: ComputerNavGo, take: () => boolean, lease: Lease): Promise<Step> {
    const tab = this.active(b);
    const here = b.tabs()[tab];
    if (!here) return { reply: fail(REFUSAL.noPage) };
    if ((go === "back" && !here.canBack) || (go === "forward" && !here.canForward)) return { reply: refuseAt(REFUSAL.noHistory(go), this.url(b)) };
    const free = (went: string): Reply => {
      const since = this.clock.now();
      this.line(p, agent.label, went, agent);
      return this.done(p, b, `${went}.`, since, lease);
    };
    if (go !== "reload") {
      // The method is not read, so only the access level is judged. Nothing is awaited between the check and the move.
      const need = this.need(judge({ kind: "nav", go, method: "unknown" }, { access: agent.access, marked: this.markedAt(b, tab) }), null, this.siteAt(b, tab));
      if (need && typeof need === "object") return { reply: fail(need.refuse) };
      const late = this.stale(p, agent, lease);
      if (late) return { reply: late };
      if (!take()) return { reply: fail(REFUSAL.late) };
      return { reply: b.nav(go, tab) ? free(go === "back" ? "Went back" : "Went forward") : refuseAt(REFUSAL.pageChanged, this.url(b)) };
    }
    const token = b.pageToken();
    const entry = await b.entry(go, tab);
    // The history was an await: the call must still be current, and the page the one the entry was read for.
    const read = this.stale(p, agent, lease);
    if (read) return { reply: read };
    if (!entry || b.pageToken() !== token || this.active(b) !== tab) return { reply: refuseAt(REFUSAL.changed, this.url(b)) };
    // An entry with no id cannot be bound to a card: only a tab still waking (its reload loads the kept address) has none.
    if (entry.id === null && entry.method !== "GET") return { reply: refuseAt(REFUSAL.noHistoryRead, this.url(b)) };
    const site = this.siteAt(b, tab);
    const need = this.need(judge({ kind: "nav", go, method: entry.method }, { access: agent.access, marked: this.markedAt(b, tab) }), null, site);
    if (need && typeof need === "object") return { reply: fail(need.refuse) };
    if (!need) {
      // Free: a GET entry. Nothing is awaited between the check above and the move.
      const late = this.stale(p, agent, lease);
      if (late) return { reply: late };
      if (!take()) return { reply: fail(REFUSAL.late) };
      return { reply: b.nav(go, tab) ? free("Reloaded") : refuseAt(REFUSAL.pageChanged, this.url(b)) };
    }
    // Asked: what the person allows is this entry of this tab. The run reads the history again and moves only if it is still so.
    const run = async (): Promise<Reply> => {
      const late = this.stale(p, agent, lease);
      if (late) return late;
      // R81: the move is sent only while the call is still current after the history read (the same delivery path as a click).
      let moved = false;
      const lost = await this.deliver(p, agent, lease, async (valid) => { moved = await b.navEntry(entry, valid); });
      if (lost) return lost;
      if (!moved) return refuseAt(REFUSAL.changed, this.url(b));
      return free("Reloaded");
    };
    return {
      ask: {
        whys: [need], site, target: null,
        action: "Reload", kind: "Reload",
        detail: `Loading this page again may send a form again. ${cardPage(here.url)}`,
        revalidate: () => Promise.resolve(b.pageToken() === token && this.active(b) === tab),
        run,
      },
    };
  }

  /** session-browser S17: the page's mouse moved onto a ref or a point (hover styles and menus), nothing pressed. The target is
   *  resolved as a click's is; the gate lets a hover go, but a Read only session never gets here. */
  private async hoverStep(agent: AgentRef, p: Slot, b: BrowserLike, by: By, take: () => boolean, lease: Lease): Promise<Step> {
    // The move IS the act (PR 5, A4): the call takes the computer before anything moves the page's mouse, and the target read's
    // own move onto the point goes only while the call is current, so a person who holds the wheel never sees the page react.
    if (!take()) return { reply: fail(REFUSAL.late) };
    // session-browser S18: the pointer arrives before the page's mouse moves (for a hover the move IS the act).
    const got = await this.resolveFirst(p, agent, lease, b, by, "arrow");
    if ("reply" in got) return { reply: got.reply };
    const r = got.r;
    const read = this.stale(p, agent, lease);
    if (read) return { reply: read };
    const need = this.need(judge({ kind: "hover" }, { access: agent.access, marked: this.markedAt(b, r.tab) }), null, this.siteAt(b, r.tab));
    if (need && typeof need === "object") return { reply: fail(need.refuse) };
    const did = "ref" in by ? by.ref : `at (${by.x}, ${by.y})`;
    // The look again after the gate (R81: nothing is awaited between it and the delivery).
    const late = this.stale(p, agent, lease);
    if (late) return { reply: late };
    const lost = await this.deliver(p, agent, lease, (valid) => b.hoverAt(r, valid));
    if (lost) return { reply: lost };
    const since = this.clock.now();
    this.line(p, agent.label, r.shown ? `Hovered ${quoted(r.shown)}` : "Hovered an unnamed control", agent);
    return { reply: this.done(p, b, `Hovered ${did}.`, since, lease) };
  }

  /** D39: typing into a ref is a click on it and the typing, under one ask; after the click the focus is judged again. */
  private async typeStep(agent: AgentRef, p: Slot, b: BrowserLike, text: string, ref: string | null, take: () => boolean, lease: Lease): Promise<Step> {
    // A typed ref: the caret arrives at the field's corner before the page's mouse moves onto it (session-browser S18).
    let r: Resolved | null = null;
    if (ref) {
      const got = await this.resolveFirst(p, agent, lease, b, { ref }, "caret");
      if ("reply" in got) return { reply: got.reply };
      r = got.r;
    }
    // The page token and tab are read before the focus and compared after it, so a navigation during the read refuses.
    const token = r ? r.pageToken : b.pageToken();
    const tab = r ? r.tab : this.active(b);
    // A ref's field stands in for the focus until the click lands; plainTextarea false asks Return (fails closed).
    const f: Focus = r ? { target: r.target, shown: r.shown, sensitive: r.sensitive, plainTextarea: false, node: r.backendNodeId, frame: null } : await b.focus();
    // R81: the target or focus read was an await: the call must still be current after it.
    const read = this.stale(p, agent, lease);
    if (read) return { reply: read };
    // I3b: the focus judged is this page's in this tab, or nothing goes.
    if (!r && (b.pageToken() !== token || this.active(b) !== tab)) return { reply: refuseAt(REFUSAL.moved, this.url(b)) };
    const site = this.siteAt(b, tab);
    const ctx = { access: agent.access, marked: this.markedAt(b, tab) };
    const whys: AskWhy[] = [];
    const tv = this.need(judge({ kind: "type", text, focus: f }, ctx), f.target, site);
    if (tv && typeof tv === "object") return { reply: fail(tv.refuse) };
    if (tv) whys.push(tv);
    if (r) {
      const cv = this.need(judge({ kind: "click", target: r.target }, ctx), r.target, site);
      if (cv && typeof cv === "object") return { reply: fail(cv.refuse) };
      if (cv && !whys.includes(cv)) whys.push(cv);
    }
    let fresh = r;
    const run = async (approved: readonly AskWhy[]): Promise<Reply> => {
      // session-browser S18: the caret shows at the field's top-left corner (again, after a card; where it is, this costs nothing)
      // before the first look below (the field's own click is not pulsed). With no ref the field is the one with focus, whose
      // corner is read only when a pointer would show, and for 150 ms at most.
      const spot = fresh ? { tab: fresh.tab, corner: fresh.corner as Point | null } : { tab, corner: this.pointerOn(p) ? await this.cornerOf(b, p, agent, lease) : null };
      const went = await this.travel(p, agent, lease, b, "caret", spot.tab, spot.corner);
      if (went.reply) return went.reply;
      const late = this.stale(p, agent, lease);
      if (late) return late;
      // R76: the typing goes into the element judged: the focus read now (after a ref's click) or the one the gate judged.
      let into = idOf(f);
      if (fresh) {
        const x = fresh;
        const lost = await this.deliver(p, agent, lease, async (valid) => { await b.click(x, valid); });
        if (lost) return lost;
        const now = await b.focus();
        const after = this.stale(p, agent, lease);
        if (after) return after;
        // I3b: the click and the focus read must leave the page the gate judged in front; the typing is bound to it.
        if (b.pageToken() !== fresh.pageToken || this.active(b) !== fresh.tab) return refuseAt(REFUSAL.moved, this.url(b));
        const v = this.need(judge({ kind: "type", text, focus: now }, { access: agent.access, marked: this.markedAt(b, fresh.tab) }), now.target, this.siteAt(b, fresh.tab));
        if (v && typeof v === "object") return fail(v.refuse);
        if (v && !approved.includes(v)) return refuseAt(REFUSAL.clickMovedFocus, this.url(b));
        into = idOf(now);
      }
      return this.typeInto(agent, p, b, text, fresh ? { tab: fresh.tab, pageToken: fresh.pageToken } : { tab, pageToken: token }, into, lease, went.moved);
    };
    if (!whys.length) return { reply: take() ? await run([]) : fail(REFUSAL.late) };
    return {
      ask: {
        whys, site, target: r ? r.target : f.target,
        action: typeAction(text, f.shown), kind: typeAction(text, ""),
        detail: `Text: “${clean(text, 200)}”. ${f.target ? `${await this.described(b, f.target, f.shown, tab)}. ` : ""}${cardPage(b.tabs()[tab]?.url ?? null)}`,
        revalidate: async () => {
          if (r) {
            const r2 = await this.reresolve(b, { ref: ref! }, r, agent.key);
            if (!r2) return false;
            fresh = r2;
            return true;
          }
          if (b.pageToken() !== token || this.active(b) !== tab) return false;
          const now = await b.focus().catch(() => null);
          return !!now && sameFocus(now, f);
        },
        run: () => run(whys),
      },
    };
  }

  private async keyStep(agent: AgentRef, p: Slot, b: BrowserLike, key: string, take: () => boolean, lease: Lease): Promise<Step> {
    // Read before the focus, so a navigation during the read refuses (below) or fails the revalidation.
    const token = b.pageToken();
    const tab = this.active(b);
    const f = await b.focus();
    // R81: the focus read was an await: the call must still be current after it.
    const read = this.stale(p, agent, lease);
    if (read) return { reply: read };
    // I3b: and checked again after it: a navigation or a tab switch during the read refuses the key at once.
    if (b.pageToken() !== token || this.active(b) !== tab) return { reply: refuseAt(REFUSAL.moved, this.url(b)) };
    const site = this.siteAt(b, tab);
    const need = this.need(judge({ kind: "key", key, focus: f }, { access: agent.access, marked: this.markedAt(b, tab) }), f.target, site);
    if (need && typeof need === "object") return { reply: fail(need.refuse) };
    const shownKey = clean(key, 40);
    const run = async (): Promise<Reply> => {
      const late = this.stale(p, agent, lease);
      if (late) return late;
      const lost = await this.deliver(p, agent, lease, (valid) => b.key(key, valid, { tab, pageToken: token }, idOf(f)));
      if (lost) return lost;
      const since = this.clock.now();
      this.line(p, agent.label, `Pressed ${shownKey}`, agent);
      return this.done(p, b, `Pressed ${shownKey}.`, since, lease);
    };
    if (!need) return { reply: take() ? await run() : fail(REFUSAL.late) };
    return {
      ask: {
        whys: [need], site, target: f.target,
        action: f.shown ? `Press ${shownKey} with ${quoted(f.shown)} focused` : `Press ${shownKey}`, kind: `Press ${shownKey}`,
        detail: `Key: ${shownKey}. ${f.target ? `${await this.described(b, f.target, f.shown, tab)}. ` : ""}${cardPage(b.tabs()[tab]?.url ?? null)}`,
        revalidate: async () => {
          if (b.pageToken() !== token || this.active(b) !== tab) return false;
          const now = await b.focus().catch(() => null);
          return !!now && sameFocus(now, f);
        },
        run,
      },
    };
  }

  /** session-browser S18: the read of the target a click, a hover or a typed ref acts on, with the pointer's travel inside it: the
   *  pointer arrives (at the point; a caret at the field's corner) after the target's box is read and before the page's mouse moves,
   *  so a page that reacts to its mouse (a menu, a tooltip) reacts after the person has seen the pointer arrive. Only while a
   *  pointer would show (R2): no hook otherwise. The hook answering false (the call stopped being current on the way) moves nothing
   *  and the step answers as a call that is no longer current does. R81 inside `resolve`: `valid` is looked at again after the hook,
   *  with nothing awaited between that look and the move. */
  private async resolveFirst(p: Slot, agent: AgentRef, lease: Lease, b: BrowserLike, by: By, kind: "arrow" | "caret"): Promise<{ r: Resolved } | { reply: Reply }> {
    let cut: Reply | null = null;
    const arrive = this.pointerOn(p) ? async (at: Point, corner: Point, tab: number): Promise<boolean> => {
      const went = await this.travel(p, agent, lease, b, kind, tab, kind === "caret" ? corner : at);
      cut = went.reply;
      return !went.reply;
    } : undefined;
    try {
      return { r: await b.resolve(by, agent.key, () => this.current(p, agent, lease), arrive) };
    } catch (e) {
      if (cut) return { reply: cut };
      const late = e instanceof PageChanged ? this.stale(p, agent, lease) : null;
      if (late) return { reply: late };
      throw e;
    }
  }

  /** The focused field's corner for the caret, read for 150 ms at most on the service's clock: a read that is late or fails gives
   *  no pointer, and the typing goes on at once (session-browser S18). */
  private cornerOf(b: BrowserLike, p: Slot, agent: AgentRef, lease: Lease): Promise<Point | null> {
    return new Promise<Point | null>((done) => {
      const timer = this.clock.setTimeout(() => done(null), CORNER_MS);
      const end = (c: Point | null): void => { this.clock.clearTimeout(timer); done(c); };
      b.focusCorner(() => this.current(p, agent, lease)).then(end, () => end(null));
    });
  }

  /** Whether a pointer would show for this session: one is wired and the session's browser is on screen (selected, with a
   *  rectangle or popped out). A browser that is not on screen gets no pointer and no delay (session-browser S18). */
  private pointerOn(p: Slot): boolean {
    return !!this.o.pointer && this.onScreen(p.key);
  }

  /** session-browser S18: the pointer travels to `point` (a point of the tab's page) before an action is delivered. `reply` is
   *  null to go on; otherwise the reply the call ends with: false from the pointer means the call stopped being current on the
   *  way (a Take over, a switch off) or ran past its deadline, answered as a stale call is, or as a late one; nothing is
   *  delivered. `moved` says whether the pointer was asked to travel for this action (a click pulses only then). It never turns a step
   *  into a failure: no pointer, a browser not on screen, a target the browser cannot place, or a pointer that throws goes on as
   *  if there were none. */
  private async travel(p: Slot, agent: AgentRef, lease: Lease, b: BrowserLike, kind: "arrow" | "caret", tab: number, point: Point | null): Promise<{ reply: Reply | null; moved: boolean }> {
    const pointer = this.o.pointer;
    if (!pointer || !point || !this.pointerOn(p)) return { reply: null, moved: false };
    const pastDeadline = (): boolean => lease.until !== null && this.clock.now() >= lease.until;
    let alive: boolean;
    try {
      const to = b.windowPoint(point, tab);
      const within = b.viewBox();
      if (!to || !within) return { reply: null, moved: false };
      this.pointerFor = p.key;
      this.pointerTab = b.tabUid(tab);
      alive = await pointer.moveTo({ window: this.popped ? "pop" : "main", to, name: this.labelOf(p.key), kind, within, alive: () => this.current(p, agent, lease) && !pastDeadline() });
    } catch {
      try { this.o.log?.("the pointer could not be shown"); } catch { /* main's log is not the service's concern */ }
      return { reply: null, moved: false };
    }
    if (alive) return { reply: null, moved: true };
    // Stale says why a call that is no longer current ended; a call that ran out of its time on the way is late; a pointer that
    // answers false with neither has no sentence of its own: it is the changed-page reply.
    return { reply: this.stale(p, agent, lease) ?? (pastDeadline() ? fail(REFUSAL.late) : refuseAt(REFUSAL.changed, this.url(b))), moved: true };
  }

  /** The press image, after a click that travelled was delivered: only while the pointer on screen was drawn for this session
   *  (another session's pointer may have taken the screen while this click was being delivered). */
  private pulse(p: Slot): void {
    if (this.pointerFor !== p.key) return;
    try { this.o.pointer?.pulse(); } catch { /* a pointer that fails never fails the click */ }
  }

  /** The browser says the tab in front may have changed (`page`: its main frame committed another document). The pointer goes only
   *  when the tab in front is not the one it was drawn over, or the page in it is another one: selecting the tab already in front
   *  or closing a background tab covers nothing. */
  private fronted(p: Slot, page: boolean): void {
    if (p.key !== this.pointerFor) return;
    let same = false;
    try { const b = p.browser; same = !page && !!b && this.pointerTab !== null && b.tabUid(this.active(b)) === this.pointerTab; } catch { /* cannot tell: hide */ }
    if (!same) this.hidePointer(p.key);
  }

  /** The caret stays while a long typing goes on and when it ends (the pointer's own 3 s start from the last touch). */
  private touchPointer(p: Slot): void {
    if (this.pointerFor !== p.key) return;
    try { this.o.pointer?.touch(); } catch { /* a pointer that fails never fails the typing */ }
  }

  /** The view's box changed or the pop-out was resized: the pointer drawn for the selected session stays if its image still lies
   *  inside the view's new box and the box's origin did not move; otherwise it hides at once (session-browser S18). */
  private keepPointer(): void {
    if (!this.o.pointer || this.pointerFor === null || this.pointerFor !== this.selected) return;
    let box: Rect | null = null;
    try { box = this.slots.get(this.selected)?.browser?.viewBox() ?? null; } catch { /* a browser that cannot say has no box */ }
    if (box) { try { this.o.pointer.keepWithin(box); } catch { /* a pointer that fails shows nothing */ } } else this.hidePointer();
  }

  /** The pop-out window was resized (index.ts, after the view took its new box): the pointer in it is kept or hidden as for a
   *  pane change. The pane's own rectangle says nothing while popped out, so this is the one place the pop-out's box reaches it. */
  popResized(): void {
    if (this.popped) this.keepPointer();
  }

  /** Makes the pointer's images for the selected session's name ready in the background, once its browser is on screen and
   *  awake (a cold first draw would take longer than an action waits for one). */
  private warmPointer(): void {
    const key = this.selected;
    if (!this.o.pointer || this.quitting || !key || !this.onScreen(key) || this.slots.get(key)?.power !== "awake") return;
    try { this.o.pointer.warm({ window: this.popped ? "pop" : "main", name: this.labelOf(key) }); } catch { /* nothing to warm */ }
  }

  /** The pointer goes at once: whenever the window stops showing the browser it was drawn for (session-browser S18). Without
   *  `session`: whatever is shown goes. */
  private hidePointer(session?: string): void {
    // A switch-off, a closed tab, a destroyed browser or a stopped turn of ANOTHER session hides nothing (it would cut that
    // session's travel short): `session` is the one the event is for, and the pointer was drawn for `pointerFor`.
    if (session !== undefined && session !== this.pointerFor) return;
    this.pointerFor = null;
    this.pointerTab = null;
    try { this.o.pointer?.hide(); } catch { /* nothing to hide */ }
  }

  /** R76 (S-AC-03): runs a click's or a key's delivery with the validity predicate the browser checks just before each
   *  input event (R81: the call is still current: this session holds the wheel, under the generation the call started
   *  with, from the process the registry holds; the browser checks the tab and page itself). When the predicate stopped
   *  it, the busy or changed reply; any other refusal (the page changed) goes on as the browser's error. */
  private async deliver(p: Slot, agent: AgentRef, lease: Lease, send: (valid: () => boolean) => Promise<void>): Promise<Reply | null> {
    try {
      await send(() => this.current(p, agent, lease));
      return null;
    } catch (e) {
      const late = e instanceof PageChanged ? this.stale(p, agent, lease) : null;
      if (late) return late;
      throw e;
    }
  }

  /** agent-computer D31 (controller 10): typing stops between chunks once this session no longer holds the wheel, and
   *  (I3b) once the tab or page it was judged on is no longer the one in front. R76: the browser checks the wheel just
   *  before each chunk and key event, after its focus reads too. R81: and only while the call is current (`lease`): a
   *  Take over and Hand back between chunks stops it as a Take over does. */
  private async typeInto(agent: AgentRef, p: Slot, b: BrowserLike, text: string, at: Judged, focus: FocusId, lease: Lease, shown: boolean): Promise<Reply> {
    // Only a typing whose own travel was asked keeps a caret (one that showed nothing must not keep an earlier click's arrow). Each look between chunks keeps it (a typing of a few thousand characters runs past the pointer's 3 s).
    const keepGoing = (): boolean => { if (shown) this.touchPointer(p); return this.current(p, agent, lease); };
    // The user holds the wheel, or held it since the call started and handed it back; otherwise the hold is gone.
    const stopper = (): string => (this.o.wheel.holder(p.key)?.kind === "user" || (this.holds(p.key, agent.key) && this.registered(agent)) ? "the user took over" : NOT_HELD);
    try {
      await b.type(text, keepGoing, at, focus);
      if (shown) this.touchPointer(p);
    } catch (e) {
      if (!(e instanceof PageChanged)) throw e;
      this.line(p, agent.label, "Typing stopped part way", agent);
      const byUser = this.stopped(p, lease);
      if (byUser) return byUser;
      const why = !keepGoing() ? stopper() : e instanceof FocusMoved ? "the focus moved" : "the page or tab changed";
      return refuseAt(REFUSAL.typingStopped(why), this.url(b));
    }
    if (!keepGoing()) {
      this.line(p, agent.label, "Typing stopped part way", agent);
      const byUser = this.stopped(p, lease);
      if (byUser) return byUser;
      return refuseAt(REFUSAL.typingStopped(stopper()), this.url(b));
    }
    const since = this.clock.now();
    const n = Array.from(text).length;
    this.line(p, agent.label, `Typed ${n} character${n === 1 ? "" : "s"}`, agent);
    return this.done(p, b, `Typed ${n} character${n === 1 ? "" : "s"}.`, since, lease);
  }

  /** session-browser S16: the reply of an acting tool that ran: `line`, then the page as it is now, so the agent need not
   *  call computer_snapshot after every action. It is built OUTSIDE the slot's queue: this only notes what is to be read (the
   *  step ends, so the person's address bar, a clicked link and a program's page do not wait behind a settle wait), and the
   *  caller of the queue finishes it with `finished` once the queue is free. */
  private done(p: Slot, b: BrowserLike, line: string, since: number, lease: Lease): Reply {
    const reply: Reply = { text: line };
    deferred.set(reply, {
      run: () => this.page(p, b, line, since, lease), unread: () => ({ text: `${line} ${UNREAD}` }), lease,
      late: () => lease.until !== null && this.clock.now() >= lease.until,
    });
    return reply;
  }

  /** The reply after the queue: a reply that `done` made is read now, any other is returned as it is. */
  private finished(p: Slot, reply: Reply): Promise<Reply> | Reply {
    const read = deferred.get(reply);
    if (!read) return reply;
    // One read after another per session, in the order the steps ended, so refs register in the order of the calls; the
    // chain is the agent's replies' only. The read counts as a look in flight (the browser is not put to sleep under it).
    // A call that holds the reply stops waiting for its turn at its own 45 s: it answers with its line and UNREAD, and its
    // link stays in the chain, doing nothing when its turn comes (`late`), so the others keep their order.
    p.reading++;
    let started = false, lost = false;
    let timer: unknown = null;
    const mine = p.replies.then(() => {
      // Its turn came with the deadline passed (or the call already answered): the timer for the wait has nothing left to do.
      if (lost || read.late()) { if (timer !== null) this.clock.clearTimeout(timer); return read.unread(); }
      started = true;
      if (timer !== null) this.clock.clearTimeout(timer);
      return read.run();
    }).finally(() => { p.reading--; this.released(); });
    p.replies = mine.catch(() => undefined);
    if (read.lease.until === null) return mine;
    // The deadline races only the wait for the turn: a read that has started is awaited and given to its call, so no read
    // ever runs whose text the call does not get (its refs are the ones the agent was shown).
    return new Promise<Reply>((resolve) => {
      timer = this.clock.setTimeout(() => { if (!started) { lost = true; resolve(read.unread()); } }, Math.max(0, read.lease.until! - this.clock.now()));
      void mine.then(resolve, () => resolve(read.unread()));
    });
  }

  /** The wait and the read of `done`. It waits for the page to settle after the action's last input (`since`, on the
   *  service's clock), then tells what the person did meanwhile (the stop's own sentence when they switched the browser off or
   *  closed the tab the action ran in: no outline, for it would be another page's), else takes the outline `computer_snapshot`
   *  would, cut by the browser (so its refs are the ones shown). While the call holds the reply (`lease.until`), nothing here
   *  runs past its 45 s: a wait that the deadline cut short starts no read, and the clock is looked at once more just before
   *  the snapshot; a read already under way is not abandoned. The input has been sent: the action happened, so nothing here
   *  turns it into a failure, throws or hangs: a page that cannot be read afterwards gives `line` and a sentence saying so. A
   *  Take over during the wait changes nothing: reading the outline is a look. The outline carries the page's address, so
   *  `line` does not. */
  private async page(p: Slot, b: BrowserLike, line: string, since: number, lease: Lease): Promise<Reply> {
    try {
      const settled = b.settled(since).catch(() => undefined);
      if (lease.until === null) await settled;
      else if (!(await this.within(settled, lease.until))) return { text: `${line} ${UNREAD}` };
      const stop = this.stoppedAfter(p, lease);
      if (stop) return { text: `${line} ${stop}` };
      if (p.browser !== b || p.power === "off") return { text: `${line} ${UNREAD}` };
      if (lease.until !== null && this.clock.now() >= lease.until) return { text: `${line} ${UNREAD}` };
      const snap = await b.snapshot(undefined, p.key, { cap: OUTLINE_MAX });
      // A stop during the read: the outline is of a browser the person switched off or a tab they closed.
      const after = this.stoppedAfter(p, lease);
      if (after) return { text: `${line} ${after}` };
      return { text: withPage(line, snap.text, { cut: snap.truncated }) };
    } catch {
      // A read that failed because the person switched the browser off or closed the tab says so.
      const stop = this.stoppedAfter(p, lease);
      return { text: `${line} ${stop ?? UNREAD}` };
    }
  }

  /** The verdict as what is needed: a refusal, the ask, or null to go. D39: a category ask is skipped when "Always on
   *  <site>" has allowed every category the control's name matches. */
  private need(v: Verdict, target: Target | null, site: string | null): { refuse: string } | AskWhy | null {
    if ("refuse" in v) return v;
    if ("go" in v) return null;
    if (isCategory(v.ask) && site && target) {
      const cats = categoriesOf(target);
      if (cats.length && cats.every((c) => this.o.sites.categoryAllowed(site, c))) return null;
    }
    return v.ask;
  }

  /** agent-computer D31 (controller 5, review fix): the approved control is still the one there: the same page and tab,
   *  the same DOM node with the same set of judged controls, and the same role, raw name and flags. The session's own
   *  next snapshot of the same document rebinds its refs (I2: another session's look and a text wait no longer do) and a
   *  layout shift moves what is under a point, so a same-name control in another row, or a re-rendered node, fails
   *  closed. The browser's click refuses a changed page too. */
  private async reresolve(b: BrowserLike, by: By, r: Resolved, session: string): Promise<Resolved | null> {
    if (b.pageToken() !== r.pageToken || this.active(b) !== r.tab) return null;
    const r2 = await b.resolve(by, session).catch(() => null);
    return r2 && r2.pageToken === r.pageToken && r2.tab === r.tab && r2.backendNodeId === r.backendNodeId
      && sameSet(r2.judged, r.judged) && same(r2.target, r.target) ? r2 : null;
  }

  /** "the button “Name”" for a card's detail: the role through the scrub of the action's tab (D9), the name as shown. */
  private async described(b: BrowserLike, t: Target, shown: string, tab: number): Promise<string> {
    const role = clean(await b.scrub(t.role, tab), 40) || "control";
    return shown ? `The ${role} ${quoted(shown)}` : `An unnamed ${role}`;
  }

  // ---- asks

  private async ask(agent: AgentRef, p: Slot, s: AskSpec, deadline: number, lease: Lease): Promise<Reply> {
    // The reply of an asked action comes through `computer_wait` or this call's hold, never past its 45 s by a settle wait.
    lease.until = null;
    const why = s.whys[0];
    // Controller 3: no Always for return, file, download, permission or frame, nor without a site to remember it for.
    // A category ask on a name that also says Download is asked every time too; an unmarked ask there still marks the site.
    const always = s.site !== null && s.whys.every(offersAlways)
      && !(s.whys.some(isCategory) && s.target !== null && categoriesOf(s.target).includes("download"));
    // Every reason's label heads the card (controller 2, R43): one ask can cover Return and a Delete click.
    const labels = s.whys.map((w) => ASK_LABELS[w]).join(" · ");
    const title = s.card?.title ?? `${labels}: ${s.action} on ${hostOf(s.site)}?`;
    const notice = s.card?.notice ?? `${labels}: ${s.kind} on ${hostOf(s.site)}?`;
    const input: AskInput = { computer: p.key, session: agent.key, sessionLabel: p.title ?? agent.label, why, title, notice, detail: s.detail, site: s.site, always };
    const held = this.o.broker.hold(input, deadline - this.clock.now());
    this.line(p, agent.label, `Asked the user: ${title}`, agent);
    const first = await held;
    const job: Job = { session: agent.key, answered: false, done: Promise.resolve(fail(REFUSAL.changed)), slot: p, collected: null };
    job.done = this.settle(agent, p, s, input, first, job, lease);
    this.jobs.set(first.askId, job);
    void job.done.then(() => { this.clock.setTimeout(() => this.jobs.delete(first.askId), KEEP_MS); });
    // D34: the call returns within the broker's hold; computer_wait picks the result up.
    if (first.state === "waiting_for_user") return { text: waiting(first.askId) };
    // R76: an answer near the deadline leaves no time for a slow revalidation or action: at the deadline the call says
    // so, as computer_wait does for the same ask, and computer_wait picks the result up.
    return this.until(this.collect(job), deadline, () => ({ text: job.answered ? running(first.askId) : waiting(first.askId) }));
  }

  /** An asked action's reply as the agent gets it (the held call, or `computer_wait`): the settle wait and the outline of an
   *  action that ran are read once, the first time it is collected (session-browser S16; PR 5, A5). */
  private collect(job: Job): Promise<Reply> {
    job.collected ??= job.done.then((r) => this.finished(job.slot, r));
    return job.collected;
  }

  /** `work`'s reply, or `late()`'s once the clock reaches `deadline` first (`work` goes on; its reply is kept). */
  private until(work: Promise<Reply>, deadline: number, late: () => Reply): Promise<Reply> {
    return new Promise<Reply>((resolve) => {
      const timer = this.clock.setTimeout(() => resolve(late()), Math.max(0, deadline - this.clock.now()));
      void work.then((r) => { this.clock.clearTimeout(timer); resolve(r); });
    });
  }

  /** Waits for the ask to settle, then (allowed) revalidates and runs the action. Never rejects. R81: the call must still
   *  be current before and after the revalidation's reads (no Take over, Hand back or turn end since it started, and its
   *  process still the registered one), or nothing runs. */
  private async settle(agent: AgentRef, p: Slot, s: AskSpec, input: AskInput, first: Outcome, job: Job, lease: Lease): Promise<Reply> {
    try {
      let o = first;
      while (o.state === "waiting_for_user") o = await this.o.broker.wait(o.askId);
      job.answered = true;
      // Controller 4 (D31): the wheel's idle timer restarts at the answer, so it cannot free before the revalidation.
      this.o.wheel.touch(p.key, agent.key);
      this.line(p, agent.label, outcomeLine(o, input), agent);
      // S4: the person turned the browser on by hand while the Turn on card was up: the held open runs on it.
      if (o.state !== "allowed" && !(input.why === "power" && o.reason === ON_BY_HAND)) {
        // Pages a program opened behind this card (session-browser S23): the person's no drops them; any other ending (the
        // turn ended, the process was replaced, the app quits) brings the program's own card back for them, or drops them
        // with a line, but never leaves them held with no card.
        const theirs = o.answer === "deny" || o.reason === "timed out";
        if (input.why === "power") {
          if (theirs) this.dropHeld(p, null);
          else this.keepOrDrop(p, o.reason ?? "cancelled");
        }
        // S3: a Not now, or no answer in time, is told once and then left quiet (a switch off cancels, and says so).
        if (input.why === "power" && theirs) { this.startQuiet(p, REFUSAL.declined, agent); return fail(REFUSAL.declined); }
        return this.stopped(p, lease) ?? fail(deniedText(o, input.notice));
      }
      // Lenient on purpose: a slot that was forgotten (no slot for the key at all) falls through, and the checks inside the
      // queue answer for it; only a slot replaced by a newer one for the same key is a restart.
      let ran = false;
      try {
      if (this.slots.get(p.key) !== p && this.slots.has(p.key)) return fail(REFUSAL.restarted);
      const queued = await this.serial(p, async () => {
        try {
          if (!this.current(p, agent, lease) || !(await s.revalidate()) || !this.current(p, agent, lease)) return this.stopped(p, lease) ?? refuseAt(REFUSAL.changed, p.browser ? this.url(p.browser) : null);
          ran = true;
          const done = await s.run();
          // R76, R78 (D39): "Always" is saved only for the action that revalidated and reports it was delivered; one the
          // browser refused or that failed (it threw, so it never gets here) saves nothing.
          if (!done.isError && o.answer === "always" && input.always && input.site) this.always(p, s, input.site);
          return done;
        } finally {
          this.o.wheel.touch(p.key, agent.key);
        }
      });
      // Not read here (PR 5, A5): the outline is read, and its refs registered, when the agent collects the result (the held
      // call, or computer_wait), so refs are never registered for a page the agent did not see.
      return queued;
      } finally {
        // A power card that was answered but whose open did not run (the process under the key was replaced, the call was
        // stale): the pages a program held behind it open if the person turned the browser on by hand, else they are dropped.
        if (input.why === "power" && !ran) {
          if (o.state === "denied" && o.reason === ON_BY_HAND && this.slots.get(p.key) === p && p.power !== "off") this.flushProgramOpens(p);
          else this.dropHeld(p, "the card's open could not go on");
        }
      }
    } catch (e) {
      return this.stopped(p, lease) ?? fail(message(e));
    }
  }

  /** D39 (controller 3): an unmarked ask marks the site; a category ask allows every category of the control's name. Run
   *  only once the approved action has revalidated and been delivered (R76, R78). A write that fails never undoes the
   *  action the person approved, and its error (which names a file) stays in main. */
  private always(p: Slot, s: AskSpec, site: string): void {
    try {
      for (const w of s.whys) {
        if (w === "unmarked") this.o.sites.mark(site);
        else if (isCategory(w) && s.target) for (const c of categoriesOf(s.target)) this.o.sites.allowCategory(site, c);
      }
    } catch {
      this.line(p, USER, `Could not remember Always for ${hostOf(site)}: this action goes ahead, and the next one asks again.`, null);
    }
    this.refresh();
  }

  /** Controller 6: a page's own ask (a download, a permission, a file chooser) goes to the session holding the wheel, or
   *  to "the page"; it reserves the wheel only for a holder it is attributed to (`reserved`). */
  private async pageAsk(place: string, i: Pick<AskInput, "why" | "title" | "detail" | "site">): Promise<boolean> {
    try {
      const p = this.slot(place);
      const h = this.o.wheel.holder(place);
      const who = h?.kind === "agent" ? { session: h.session, label: h.label } : PAGE;
      const agent = h?.kind === "agent" ? this.agents.get(h.session) ?? null : null;
      let title: string, detail: string;
      try {
        // D9: the browser's text names page-chosen things (a file name): scrubbed before it leaves.
        if (!p.browser) throw new Error("no browser");
        title = clean(await p.browser.scrub(i.title), 200);
        detail = clean(await p.browser.scrub(i.detail), 300);
      } catch {
        title = `A request from ${hostOf(i.site)}?`;
        detail = "";
      }
      const input: AskInput = {
        computer: place, session: who.session, sessionLabel: who.label, why: i.why, title: `${ASK_LABELS[i.why]}: ${title}`,
        notice: `${ASK_LABELS[i.why]} on ${hostOf(i.site)}?`, detail, site: i.site, always: false,
      };
      const held = this.o.broker.hold(input);
      this.line(p, who.label, `Asked the user: ${input.title}`, agent);
      let o = await held;
      while (o.state === "waiting_for_user") o = await this.o.broker.wait(o.askId);
      if (h?.kind === "agent") this.o.wheel.touch(place, h.session);
      this.line(p, who.label, outcomeLine(o, input), agent);
      return o.state === "allowed";
    } catch {
      return false;
    }
  }

  /** D21: a page's own navigation, new tab, download or blocked dialog. D9 (review fix): some notes carry page-chosen text
   *  the browser did not scrub (a download's file name), so each is scrubbed here like a page ask, with an app-written line
   *  when the scrub cannot run. */
  private async pageNote(place: string, text: string): Promise<void> {
    const p = this.slot(place);
    const h = this.o.wheel.holder(place);
    const to = h?.kind === "agent" ? this.agents.get(h.session) ?? p.last : p.last;
    let out: string;
    try {
      if (!p.browser) throw new Error("no browser");
      out = clean(await p.browser.scrub(text), 2_400);
    } catch {
      out = "The page acted on its own; the details are held back because they could not be checked for password values.";
    }
    this.line(p, PAGE.label, out, to);
  }

  private async wait(agent: AgentRef, p: Slot, a: Record<string, unknown>): Promise<Reply> {
    const sec = finite(a.timeoutSec) ? Math.min(WAIT_MAX_SEC, Math.max(1, Math.floor(a.timeoutSec))) : null;
    if (a.askId !== undefined) {
      if (typeof a.askId !== "string" || !a.askId || a.askId.length > 64) return fail(REFUSAL.badAskId);
      return this.waitAsk(agent, a.askId, (sec ?? WAIT_MAX_SEC) * 1000);
    }
    if (a.text !== undefined) {
      if (typeof a.text !== "string" || !a.text || a.text.length > 200) return fail(REFUSAL.badWaitText);
      return this.waitText(p, a.text, sec ?? TEXT_WAIT_SEC);
    }
    const s = sec ?? 1;
    await this.sleep(s * 1000);
    return { text: `Waited ${s} s. ${pageLine(p.browser ? this.url(p.browser) : null)}` };
  }

  /** D34: an asked action's reply once its ask settles, or waiting_for_user again after `ms`. */
  private waitAsk(agent: AgentRef, id: string, ms: number): Promise<Reply> {
    const job = this.jobs.get(id);
    if (job && job.session !== agent.key) return Promise.resolve(fail(REFUSAL.otherSessionsAsk));
    const result: Promise<Reply> = job ? this.collect(job) : this.o.broker.wait(id).then((o): Reply => {
      if (o.state === "waiting_for_user") return { text: waiting(id) };
      if (o.state === "allowed") return { text: "The user allowed it." };
      return o.reason === "unknown ask" ? fail(REFUSAL.noSuchAsk(clean(id, 64))) : fail(o.answer === "deny" ? REFUSAL.askDenied : REFUSAL.askDeniedBecause(o.reason ?? "cancelled"));
    });
    return new Promise<Reply>((resolve) => {
      // An answered ask whose action has not finished (it may be queued behind another) says so, not waiting_for_user.
      const timer = this.clock.setTimeout(() => resolve({ text: job?.answered ? running(id) : waiting(id) }), ms);
      void result.then((r) => { this.clock.clearTimeout(timer); resolve(r); }, (e: unknown) => { this.clock.clearTimeout(timer); resolve(fail(message(e))); });
    });
  }

  /** Re-reads the page every 500 ms until `text` is in its body (not the wrapper's attributes) or `sec` pass. */
  private async waitText(p: Slot, text: string, sec: number): Promise<Reply> {
    const b = this.browserOf(p);
    const end = this.clock.now() + sec * 1000;
    for (;;) {
      // A read only: it keeps no refs, so it re-points nobody's (I2).
      const page = (await b.snapshot()).text;
      const body = page.startsWith("<untrusted-page") ? page.slice(page.indexOf("\n") + 1) : page;
      if (body.includes(text)) return { text: `“${clean(text, 200)}” is on the page now: take a new snapshot before using refs. ${pageLine(this.url(b))}` };
      const left = end - this.clock.now();
      if (left <= 0) return { text: `“${clean(text, 200)}” did not appear within ${sec} s. ${pageLine(this.url(b))}` };
      await this.sleep(Math.min(POLL_MS, left));
    }
  }

  private status(agent: AgentRef, p: Slot): string {
    const h = this.o.wheel.holder(p.key);
    const driving = !h ? "nobody (the first session to act takes the wheel)"
      : h.kind === "user" ? "the user (wait for Hand back)"
      : `this session (${h.label})`;
    const access = agent.access === "read" ? "read only: this session can look but not act (D17)"
      : "this session can act; the user is asked first on sites they haven't marked and for irreversible actions";
    const onScreen = this.onScreen(p.key);
    const tabs = p.browser?.tabs() ?? [];
    // I1: this session's own asks by id and notice; the page's (a Turn on card from the user's side, say) only as a count and their kinds.
    // The holder is this session's agent (the wheel is per session: the hold is taken under the slot's own key and `rekey`
    // renames it with the slot), so there is no "another session drives" case to word (session-browser A9). The one exception
    // is a brief hand-over window: an old terminal's call that waited on a wake while `move` ran can leave another session's
    // name on the wheel, and status then reads "this session".
    const asks = this.o.broker.pending(p.key);
    const own = asks.filter((x) => x.session === agent.key);
    const theirs = asks.filter((x) => x.session === PERSON);
    const others = asks.filter((x) => x.session !== agent.key && x.session !== PERSON);
    return [
      p.power === "off" ? `Browser: ${agent.label} (off: computer_open asks the user to turn it on)` : `Browser: ${agent.label}`,
      `Driving: ${driving}`,
      `Access: ${access}`,
      `Pane: ${onScreen ? "on screen" : "off screen"}`,
      tabs.length ? "Tabs:" : "Tabs: none (call computer_open)",
      ...tabs.map((t) => `  [${t.index}]${t.active ? " (active)" : ""} ${untrustedUrl(t.url)} opened by ${t.openedBy ?? "the user"}`),
      own.length ? "Your pending asks:" : "Your pending asks: none",
      ...own.map((x) => `  ${x.id} ${x.notice}`),
      ...(theirs.length ? [`The user's own pending ask: ${theirs.length} (${[...new Set(theirs.map((x) => ASK_LABELS[x.why]))].join(", ")})`] : []),
      ...(others.length ? [`The page's pending asks: ${others.length} (${[...new Set(others.map((x) => ASK_LABELS[x.why]))].join(", ")})`] : []),
    ].join("\n");
  }

  // ---- the pane's operations

  /** The pane shows `session`'s browser (agent-computer D32, by session now: session-browser S1); the one it showed
   *  before is parked. Popped out, the newly selected browser goes into the pop-out window. */
  select(session: string | null): ComputerState | null {
    if (this.quitting) return null;
    const q = session ? this.slot(session) : null;
    if (q) { q.named = null; this.touch(q); this.wakeUp(q, false); }
    if (session !== this.selected) {
      this.hidePointer();
      if (this.selected) this.slots.get(this.selected)?.browser?.show(null);
      this.selected = session;
      if (session) {
        if (!this.popped) this.slots.get(session)?.browser?.show(this.bounds);
      }
      // session-browser S21: popped out, the window follows the selection (empty and titled "off" for an off browser or none).
      this.tellPopOut();
    }
    // The browser being left no longer counts as selected, so the limit is applied after the change.
    if (q) this.trim(q);
    this.warmPointer();
    return session ? this.state(this.slot(session)) : null;
  }

  /** The pane's rectangle for the view, or null (collapsed, another tab, a modal on top). Popped out, the app's pop-out
   *  window places the view; the rectangle is kept for when the pane pops back in.
   *  `inView`: the page's pane is in view (its page is the one showing), with or without a rectangle; a `power` ask's notice reads it (session-browser S12). */
  show(bounds: Rect | null, inView: boolean = bounds !== null): void {
    const before = this.bounds;
    this.bounds = bounds;
    this.inView = inView;
    // The view went: its pointer goes. (Popped out, the pane's rectangle is not the view's box and says nothing about it.)
    if (!bounds && !this.popped) this.hidePointer();
    if (bounds && !before) this.warmPointer();
    if (this.selected && !this.popped) this.slots.get(this.selected)?.browser?.show(bounds);
    // The view's box changed (the pane's rectangle did, as each new activity line shrinks it): the pointer drawn for this session
    // stays if it still lies inside the view's new box and the box's origin did not move; otherwise it hides at once.
    const changed = !!before && !!bounds && (before.x !== bounds.x || before.y !== bounds.y || before.width !== bounds.width || before.height !== bounds.height);
    if (changed && !this.popped) this.keepPointer();
  }

  /** The session the pane has selected, or null. Only the e2e seam (`__aosMain.computerSelected`) calls it. */
  selectedSession(): string | null { return this.selected; }

  /** True while the pane shows `session`'s browser: selected and given a rectangle, or popped out (agent-computer D27: an
   *  ask on a computer not on screen raises a notice). Whether the window holding it is visible is the app's to add. */
  onScreen(session: string): boolean {
    return this.selected === session && (this.bounds !== null || this.popped);
  }

  /** True while the pane that shows `session` is in view, with or without a rectangle: a power ask has no view to be on
   *  screen with, yet its card is in the pane, so a notice is owed only when the pane is out of view (session-browser S12). */
  paneShows(session: string): boolean {
    return this.selected === session && this.inView;
  }

  /** The `webContents.id` of the active tab of `session`'s browser (the selected session's by default), or null when there is
   *  none. Only the e2e seam (`__aosMain.computerPageId`) calls it: an id, never the page. */
  activeWebContentsId(session?: string): number | null {
    const key = session ?? this.selected;
    return (key ? this.slots.get(key)?.browser?.activeWebContentsId() : null) ?? null;
  }

  /** The address bar: the person opens a page (no ask; the agent's approved actions revalidate against the new page). */
  async navigate(url: string): Promise<Result<null>> {
    if (this.quitting) return { ok: false, error: REFUSAL.quitting, code: "ENOENT" };
    if (!this.selected) return { ok: false, error: "No computer is selected.", code: "ENOENT" };
    if (!navAllowed(url)) return { ok: false, error: "Only http and https pages open.", code: "EROFS" };
    const p = this.slot(this.selected);
    if (p.power === "off") return { ok: false, error: "The browser is off.", code: "ENOENT" };
    this.touch(p);
    this.wakeUp(p);
    const b = this.browserOf(p);
    try {
      // In the slot's queue, behind a wake that is under way, so it never overlaps the opens On is still making, or an agent's action.
      await this.serial(p, () => b.open(url, { by: null }));
      if (p.browser !== b) return { ok: false, error: "The browser is off.", code: "ENOENT" };
      this.line(p, USER, `Opened ${this.url(b) ?? "the page"}`, null);
      return { ok: true, data: null };
    } catch (e) {
      return { ok: false, error: forPerson(e), code: "EIO" };
    }
  }

  /** A web link the person clicked in a session (session-browser S14): their own act, so nothing asks. An off browser turns
   *  on with this address instead of the start page (the tabs it remembered come back first), an asleep one wakes, and the
   *  address opens in a new tab the person opened, in the slot's queue. */
  async openLink(session: string, raw: string): Promise<Result<null>> {
    if (this.quitting) return { ok: false, error: REFUSAL.quitting, code: "ENOENT" };
    const url = linkUrl(raw);
    if (!url) return { ok: false, error: "That address does not open.", code: "EINVAL" };
    const p = this.slot(session);
    // A Turn on card waiting for this session: the click turns the browser on and cancels it, and the agent's held open
    // goes on. Yield once so that open queues first (it takes the first tab) and the clicked page opens after it, in front.
    const held = p.power === "off" && this.o.broker.pending(session).some((a) => a.why === "power");
    if (p.power === "off") this.setPower(session, true, true);
    else { this.touch(p); this.wakeUp(p); }
    if (held) {
      await new Promise<void>((r) => { this.clock.setTimeout(r, 0); });
      if (this.quitting) return { ok: false, error: REFUSAL.quitting, code: "ENOENT" };
      if (this.slots.get(session) !== p || p.power === "off" || !p.browser) return { ok: false, error: "The browser is off.", code: "ENOENT" };
    }
    const b = this.browserOf(p);
    try {
      // The tab is added before the page loads, so an open that throws may still have made one.
      let made = false;
      try {
        await this.serial(p, async () => {
          const before = b.tabs().length;
          try { return await b.open(url, { newTab: true, by: null }); } finally { made = b.tabs().length > before; }
        });
      } catch (e) {
        if (!made || p.browser !== b) throw e;
        this.line(p, USER, `The page did not open: ${url.replace(/[?#].*$/, "")}`, null);
        this.refresh(session);
        return { ok: true, data: null };
      }
      if (p.browser !== b) return { ok: false, error: "The browser is off.", code: "ENOENT" };
      this.line(p, USER, `Opened ${this.url(b) ?? "the page"}`, null);
      this.refresh(session);
      return { ok: true, data: null };
    } catch (e) {
      return { ok: false, error: forPerson(e), code: "EIO" };
    }
  }

  /** A page a program in the session opened (a dev server, a sign-in, a companion page), handed over by the door
   *  (session-browser S23): its own act, not an agent's, so the tools' rules stand in for it. With the setting off, or for a
   *  Read only session, nothing opens (and an off browser raises no card); a shell with no agent is the user's own and may
   *  open. On, the page opens as a new tab opened by the session's name. Off, one Turn on card for the session carries it
   *  (a card already up, an agent's too, carries it instead): no tool call waits on it, Turn on opens every address held
   *  (six at most), Not now opens nothing and starts the quiet period, in which an open is dropped. Only a session the app
   *  holds gets a slot. A dropped open is logged with the session and the reason, never the address. */
  async openFromProgram(session: string, raw: string): Promise<void> {
    if (this.quitting) return;
    const drop = (why: string): void => { this.o.log?.(`door: an open for ${clean(session, 64)} was dropped (${why})`); };
    if (!this.o.config().enabled) return drop(SETTING_OFF);
    if (!this.o.held?.(session)) return drop("not a session the app holds");
    if (this.o.liveAgent?.(session)?.access === "read") return drop("read only");
    const url = linkUrl(raw);
    if (!url) return drop("not an address that opens");
    const p = this.slot(session);
    if (p.power !== "off") {
      this.touch(p);
      this.wakeUp(p);
      await this.programTab(p, this.browserOf(p), url);
      return;
    }
    if (this.quietNow(p)) return drop("quiet period");
    if (p.programOpens.length >= PROGRAM_HOLD) return drop("too many waiting for the card");
    p.programOpens.push(url);
    // A Turn on card already up (an agent's or an earlier program's) carries this address too: allowing it opens them all.
    if (this.o.broker.pending(p.key).some((a) => a.why === "power")) return;
    this.raiseProgramCard(p);
  }

  /** The program's own Turn on card for the pages held on the slot (the first names the card). At most one card a session:
   *  callers raise it only when none is pending. */
  private raiseProgramCard(p: Slot): void {
    const url = p.programOpens[0];
    if (!url) return;
    const label = this.programName(p.key);
    const title = `${label} wants to turn its browser on and open ${hostOf(siteOf(url))}`;
    const input: AskInput = { computer: p.key, session: PROGRAM, sessionLabel: label, why: "power", title, notice: "turn the browser on", detail: cardPage(withoutUserinfo(url)), site: null, always: false };
    const held = this.o.broker.hold(input);
    this.line(p, label, `Asked the user: ${title}`, null);
    void this.settleProgram(p, input, held);
  }

  /** The held pages of a card that ended without the person's answer: the program's card comes back for them when it can
   *  (the app is not quitting, the page has not gone, the slot is still the session's and off, no other power card is up),
   *  else they are dropped with a line. Never leaves pages held with no card. */
  private keepOrDrop(p: Slot, reason: string): void {
    if (!p.programOpens.length) return;
    const back = reason !== PAGE_GONE && !this.quitting && this.slots.get(p.key) === p && p.power === "off" && !this.o.broker.pending(p.key).some((a) => a.why === "power");
    if (back) this.raiseProgramCard(p);
    else this.dropHeld(p, reason);
  }

  /** Drops the pages held for a card: the activity log says how many (never an address), and, for an ending that was not the
   *  person's (`reason`), main's log gets one line naming the session and the reason. */
  private dropHeld(p: Slot, reason: string | null): void {
    const n = p.programOpens.length;
    if (!n) return;
    p.programOpens = [];
    this.line(p, this.programName(p.key), `${n} page${n === 1 ? "" : "s"} a program opened ${n === 1 ? "was" : "were"} not opened`, null);
    if (reason !== null) this.o.log?.(`door: ${n} open${n === 1 ? "" : "s"} for ${clean(p.key, 64)} ${n === 1 ? "was" : "were"} dropped (${clean(reason, 80)})`);
  }

  /** The answer to a program's Turn on card. Turn on (or the person turning the browser on by hand, which `setPower` has
   *  already run) opens what was held; anything else drops it, and a Not now or no answer starts the quiet period. A
   *  thread's period lasts until the live turn ends; with no turn live, and on Code, it is timed. Never rejects. */
  private async settleProgram(p: Slot, input: AskInput, first: Promise<Outcome>): Promise<void> {
    try {
      let o = await first;
      while (o.state === "waiting_for_user") o = await this.o.broker.wait(o.askId);
      // An agent's card took the session's one place: the held addresses ride it, and this card's end says nothing.
      if (o.state === "denied" && o.reason === PROGRAM_YIELD) {
        this.line(p, this.programName(p.key), "The Turn on card gave way to the agent's; the pages wait on that one", null);
        return;
      }
      this.line(p, this.programName(p.key), outcomeLine(o, input), null);
      if (o.state === "allowed" && this.slots.get(p.key) === p) {
        // The setting was switched off while the card was up: it turns nothing on and opens nothing (session-browser A3).
        if (!this.o.config().enabled) { this.dropHeld(p, SETTING_OFF); return; }
        // A browser never comes on with no tab to show (A4): nothing held (dropped meanwhile) leaves it off.
        if (p.power === "off" && !p.programOpens.length) return;
        if (p.power === "off") this.turnOn(p);
        // Turn on through any card leaves no other Turn on card up, as turning on by hand does.
        this.o.broker.cancel((x) => x.computer === p.key && x.why === "power", ON_BY_HAND);
        this.flushProgramOpens(p);
        this.refresh(p.key);
        return;
      }
      if (o.state === "denied" && o.reason === ON_BY_HAND) return;
      const theirs = o.state === "denied" && (o.answer === "deny" || o.reason === "timed out");
      this.dropHeld(p, theirs ? null : o.reason ?? "cancelled");
      if (theirs) {
        // S3: on a thread the period lasts until the live turn ends; with no turn live, and on Code, it is timed.
        const turn = p.key.startsWith("chat:") ? this.o.liveAgent?.(p.key) : undefined;
        if (turn) this.startQuiet(p, REFUSAL.declined, turn);
        else p.quiet = { sentence: REFUSAL.declined, until: this.clock.now() + QUIET_MS, pid: null };
      }
    } catch {
      this.dropHeld(p, "the card could not be settled");
    }
  }

  /** How a program's page names its session: the way an agent's Turn on card does (the described title, S22, else the
   *  agent's or main's name), and "A program" when the session has none. */
  private programName(key: string): string {
    return this.labelOf(key) || "A program";
  }

  /** The addresses held for a Turn on card open now, in the order they came, each in the slot's queue (behind a wake or the
   *  agent's own open that the same card was for). Called wherever the browser has just been turned on. */
  private flushProgramOpens(p: Slot): void {
    // Turned on by a card or by hand after the setting went off: nothing a program asked for opens (session-browser A3).
    if (!this.o.config().enabled) { this.dropHeld(p, SETTING_OFF); return; }
    const urls = p.programOpens.splice(0);
    if (!urls.length || p.power === "off" || this.quitting) return;
    let b: BrowserLike;
    try { b = this.browserOf(p); } catch { return; }
    for (const url of urls) void this.programTab(p, b, url).catch(() => undefined);
  }

  /** A program's page as a new tab, opened by the session's name; in the background while the person holds the wheel. The tab
   *  is added before the page loads, so an open that throws may still have made one; a browser switched off meanwhile is not
   *  the open's concern. */
  private async programTab(p: Slot, b: BrowserLike, url: string): Promise<void> {
    const by = this.programName(p.key);
    let made = false;
    // What `open` answered for the tab it opened: the active tab may be another (a background tab), so `url()` would name it.
    let opened: string | null = null;
    try {
      await this.serial(p, async () => {
        if (p.browser !== b) return;
        const before = b.tabs().length;
        // One driver at a time (S10): while the person holds the wheel the page is added behind the tab they are on, not
        // in front of it (session-browser X2). Read inside the queue, so a hand back that came meanwhile counts.
        const background = this.o.wheel.holder(p.key)?.kind === "user";
        try { opened = (await b.open(url, { newTab: true, background, by })).url; } finally { made = b.tabs().length > before; }
      });
    } catch {
      if (p.browser !== b) return;
      this.line(p, by, made ? `The page did not open: ${url.replace(/[?#].*$/, "")}` : "A page a program opened did not open", null);
      return;
    }
    if (p.browser !== b) return;
    this.line(p, by, `Opened ${opened ?? "the page"}`, null);
  }

  /** Open in my browser (session-browser S24): the selected browser's active tab goes to the Mac's own browser by its real
   *  address (main only: the page never names it), https only. The tab stays open. The answer waits for the system to take
   *  the page (X4); the log line names no address. */
  async openOutside(): Promise<Result<null>> {
    if (this.quitting) return { ok: false, error: REFUSAL.quitting, code: "ENOENT" };
    if (!this.selected) return { ok: false, error: "No computer is selected.", code: "ENOENT" };
    const p = this.slots.get(this.selected);
    const none: Result<null> = { ok: false, error: "No page is open.", code: "ENOENT" };
    // An asleep browser has no page in front: its kept tabs are not the person's to send from here.
    if (!p || p.power !== "awake" || !p.browser) return none;
    let url: string | null;
    try { url = p.browser.activeAddress(); } catch { return none; }
    if (!url) return none;
    // https is decided here, so `outside` (main's external-open path, which logs a refusal with its address) only ever gets an
    // https address and a refusal leaves no log line at all.
    if (!externalAllowed(url)) return { ok: false, error: "Only https pages open in your browser.", code: "EROFS" };
    // A rejection's text may carry the address: it is never kept or logged, only the fixed sentence is.
    let opened = false;
    try { opened = await this.o.outside(url); } catch { opened = false; }
    if (!opened) return { ok: false, error: "Your browser did not open the page.", code: "EIO" };
    this.line(p, USER, "Opened the page in your browser", null);
    return { ok: true, data: null };
  }

  tab(op: { kind: "new" } | { kind: "close" | "select"; index: number }): void {
    if (this.quitting) return;
    if (!this.selected) return;
    const p = this.slot(this.selected);
    if (p.power === "off") return;
    const b = this.browserOf(p);
    try {
      // A tab the person opens starts on the start page, the person's own load (nothing asks). An agent's new tab loads
      // its own URL instead, with no start page first (computer_open's newTab).
      if (op.kind === "new") void this.serial(p, () => b.open(this.o.startPage ?? START_PAGE, { newTab: true, by: null })).catch((e: unknown) => this.line(p, USER, `The new tab did not open: ${forPerson(e)}`, null));
      else if (op.kind === "close") { if (this.closeTab(p, b, op.index)) return; }
      else b.select(op.index);
    } catch { /* a stale index: the next state shows the tabs as they are */ }
    this.refresh(p.key);
  }

  /** The person's Back, Forward or Reload on the selected computer's active tab: their own, so Back and Forward never ask
   *  (session-browser S13). A Reload of a page a form loaded would send the form again, so it asks the person first, in the
   *  pane, then sends it (S13, 2026-11-14); it starts work and never throws into the IPC handler. */
  nav(go: ComputerNavGo): void {
    if (!this.selected) return;
    const p = this.slot(this.selected);
    if (p.power === "off") return;
    if (go === "reload") {
      void this.reloadOwn(p).catch(() => undefined);
      return;
    }
    // Only a move that started is logged: a stale click on a Back that cannot happen says nothing.
    if (!this.browserOf(p).nav(go)) return;
    this.line(p, USER, go === "back" ? "Went back" : "Went forward", null);
  }

  /** The person's Reload: a tab that holds no entry a form loaded (`mayHoldForm`) reloads at once with no history read, as Electron's
   *  own reload does; a page not known to have been loaded by another method than GET reloads the same way after one read; one a form loaded asks (`resendown`) and, once the person says Send again, sends the form through the protocol
   *  by the same bound move an agent's allowed reload uses (`navEntry`). A history that cannot be read reloads as it always did. */
  private async reloadOwn(p: Slot): Promise<void> {
    const b = this.browserOf(p);
    const tab = this.active(b);
    // A tab no form ever loaded reloads at once, as Electron's own reload does: no history read, nothing awaited.
    if (tab < 0 || !b.mayHoldForm(tab)) {
      if (b.nav("reload")) this.line(p, USER, "Reloaded", null);
      return;
    }
    const uid = b.tabUid(tab);
    const token = uid === null ? null : b.tabToken(uid);
    const alive = (): boolean => this.slots.get(p.key) === p && p.browser === b && p.power !== "off" && uid !== null && b.tabIndex(uid) >= 0;
    const now = (): boolean => alive() && b.tabToken(uid!) === token && b.tabUid(this.active(b)) === uid;
    const entry = await b.entry("reload", tab).catch(() => null);
    if (!now()) {
      // The page went on while the history was read: the press is not dropped, the tab it was for reloads the plain way (what
      // the button did before it asked about forms), unless the tab or the browser is gone.
      if (alive() && b.nav("reload", b.tabIndex(uid!))) this.line(p, USER, "Reloaded", null);
      return;
    }
    // The read was an await: a tab below the pressed one may have closed, so the pressed tab's index is read again by its uid.
    const at = b.tabIndex(uid!);
    // A history that could not be read says nothing about the page: the plain reload goes, but the log does not claim it did
    // what a Reload does.
    if (!entry || entry.id === null) {
      if (b.nav("reload", at)) this.line(p, USER, "Reload pressed; this page's history could not be read.", null);
      return;
    }
    if (entry.method === "GET") {
      if (b.nav("reload", at)) this.line(p, USER, "Reloaded", null);
      return;
    }
    if (p.ownCard) return;
    const site = this.siteAt(b, at);
    // "other" is known to be a form's result; "unknown" is a page in a tab that held one, which may be (a plain reload of a
    // form's result page does nothing), so it asks too.
    const input: AskInput = {
      computer: p.key, session: PERSON, sessionLabel: USER, why: "resendown", title: "Send this form again?",
      notice: `${ASK_LABELS.resendown} on ${hostOf(site)}?`,
      detail: `${entry.method === "other" ? "Reloading this page sends its form again, so what it did may happen twice." : "This page may have been loaded by a form. Reloading it would send that form again, so what it did may happen twice."} ${cardPage(b.tabs()[at]?.url ?? null)}`,
      site, always: false,
    };
    const held = this.o.broker.hold(input);
    const raised = this.o.broker.pending(p.key).find((x) => x.session === PERSON);
    if (raised && uid !== null && token !== null) p.ownCard = { askId: raised.id, uid, token };
    try {
      let o = await held;
      while (o.state === "waiting_for_user") o = await this.o.broker.wait(o.askId);
      if (o.state !== "allowed") return;
      try {
        // Nothing is awaited between navEntry's own check of the tab and entry and the move.
        if (await b.navEntry(entry, now)) this.line(p, USER, "Reloaded", null);
      } catch (e) {
        if (e instanceof PageChanged) return;
        // The person's log is the person's: a refusal worded for an agent's reply is not written here.
        this.line(p, USER, e instanceof Told ? forPerson(e) : "Send again did not complete.", null);
      }
    } finally {
      if (raised && p.ownCard?.askId === raised.id) p.ownCard = null;
    }
  }

  /** The tab in front or its page changed (the browser's front hook): the person's Send this form again card, raised for one page
   *  of one tab, goes with it. */
  private ownCardGone(p: Slot): void {
    const c = p.ownCard;
    if (!c) return;
    let same = false;
    try { const b = p.browser; same = !!b && b.tabToken(c.uid) === c.token && b.tabUid(this.active(b)) === c.uid; } catch { /* cannot tell: the card goes */ }
    if (!same) this.o.broker.cancel((a) => a.id === c.askId, "the page changed");
  }

  /** Take over (agent-computer D5, D31): the person drives, the session's pending asks are cancelled, and any typing stops
   *  at its next chunk. */
  takeOver(): void {
    this.hidePointer();
    const place = this.selected;
    if (!place || this.slot(place).power === "off") return;
    const h = this.o.wheel.holder(place);
    this.o.wheel.takeOver(place);
    this.o.broker.cancel((a) => a.computer === place, "the user took over");
    const agent = h?.kind === "agent" ? this.agents.get(h.session) ?? null : null;
    this.line(this.slot(place), USER, "Took over", agent);
  }

  handBack(): void {
    const place = this.selected;
    if (!place || this.slot(place).power === "off") return;
    this.o.wheel.handBack(place);
    const h = this.o.wheel.holder(place);
    const agent = h?.kind === "agent" ? this.agents.get(h.session) ?? null : null;
    this.line(this.slot(place), USER, "Handed back", agent);
  }

  /** The person's answer. A late answer (settled, cancelled, unknown) does nothing; "always" on an ask that offers no
   *  Always counts as once (controller 3). */
  answer(askId: string, a: Answer): void {
    const ask = this.o.broker.pending().find((x) => x.id === askId);
    if (!ask) return;
    this.o.broker.answer(askId, a === "always" && !ask.always ? "once" : a);
  }

  mark(origin: string, on: boolean): void {
    try {
      if (on) this.o.sites.mark(origin); else this.o.sites.unmark(origin);
    } catch {
      if (this.selected) this.line(this.slot(this.selected), USER, `Could not save the mark for ${hostOf(origin)}.`, null);
    }
    this.refresh();
  }

  popOut(): void {
    if (!this.selected || !this.o.popOut) return;
    const p = this.slot(this.selected);
    if (p.power === "off") return;
    this.browserOf(p);
    this.hidePointer();
    this.popped = true;
    this.tellPopOut(true);
    // After the app has made the pop-out's window: the warm asks that window's surface, which exists only now.
    this.warmPointer();
    this.refresh(this.selected);
  }

  /** session-browser S21: while popped out, tells the app what the window should now hold and say: the selected session's
   *  browser (on, awake or asleep), or nothing (its browser is off, or no session is selected). `front`: the user's own
   *  press, so the window comes forward. Never throws. */
  private tellPopOut(front = false): void {
    if (!this.popped || !this.o.popOut || this.quitting) return;
    try {
      const sel = this.selected;
      const p = sel ? this.slots.get(sel) : undefined;
      if (!sel) { this.o.popOut(null, { label: "", on: false }); return; }
      const on = !!p && p.power !== "off";
      if (p && on) this.browserOf(p);
      this.o.popOut(sel, { label: this.labelOf(sel), on, ...(front ? { front: true } : {}) });
    } catch { /* the app's window is not the service's concern */ }
  }

  /** The pop-out window closed (the app has moved the views back to the main window): the selected computer goes back
   *  to the pane's latest rectangle. */
  popIn(): void {
    this.hidePointer();
    this.popped = false;
    if (this.selected) this.slots.get(this.selected)?.browser?.show(this.bounds);
    this.refresh();
  }

  /** The session's turn ended or its CLI exited (agent-computer D31, controller 7). A late call for a process the
   *  session has since replaced (the registry holds the same key under another pid: a late bridge close from the last
   *  turn's CLI) is ignored, so it never frees the next turn's wheel or cancels its asks. */
  agentGone(agent: AgentRef): void {
    const live = this.o.liveAgent?.(agent.key);
    if (live && live.pid !== agent.pid) return;
    // The turn is over (or stopped): the pointer drawn for it goes (another session's stays).
    this.hidePointer(agent.key);
    this.o.wheel.turnEnded(agent.key);
    this.o.broker.cancel((a) => a.session === agent.key, "the turn ended");
    this.agents.delete(agent.key);
    // S3: a Chat session's quiet period ends with its turn.
    const q = this.slots.get(agent.key);
    if (q?.quiet && q.quiet.until === null) q.quiet = null;
    for (const p of this.slots.values()) if (p.last?.key === agent.key) p.last = null;
    this.refresh();
    this.released();
  }

  /** A hold or an ask ended, so the awake limit is applied again (session-browser S9); the selected browser and any still
   *  in use stay exempt. Not synchronous: it is called from inside wheel and ask-broker change callbacks, which can fire in
   *  the middle of another operation of the service (a `move`, a turn-on). It schedules one `trim(null)` on the service's
   *  clock; a second call before it ran schedules nothing more. Nothing runs after `pageGone` or while quitting. */
  released(): void {
    if (this.releasing !== null || this.quitting) return;
    this.releasing = this.clock.setTimeout(() => {
      this.releasing = null;
      if (!this.quitting) this.trim(null);
    }, 0);
  }

  /** The page went (closed, crashed or reloaded): every Code session's browser is destroyed and forgotten, with its asks,
   *  wheel and log, because the next page counts its terminals from the start and a new `code:t1` must not reach the old
   *  one's tabs (session-browser S1). Chat sessions are untouched: a thread's id is stable. Safe to call twice. */
  pageGone(): void {
    this.inView = false;
    this.hidePointer();
    if (this.releasing !== null) { this.clock.clearTimeout(this.releasing); this.releasing = null; }
    for (const [key, p] of [...this.slots]) {
      if (!key.startsWith("code:")) {
        // A thread's browser outlives the page, but its views go: asleep, as after a relaunch (S6).
        // The exemptions `trim` applies: a thread's agent outlives a reload, so work under way keeps its views.
        if (p.power === "awake" && p.browser && !this.inUse(p)) {
          try { p.browser.sleep(); p.power = "asleep"; } catch { /* it stays awake; the limit sleeps it later */ }
        }
        continue;
      }
      // The record gets the state as it is now before the browser goes, so the orphan below keeps the tabs: `track` first,
      // as `flush` does, since a save is pending only for a change it has already seen.
      this.track(p);
      this.flushSlot(p);
      // The pages a program held for a card go with a line before the slot ends (its asks are cancelled there, and the slot is
      // gone by the time their settle continuations run).
      this.dropHeld(p, PAGE_GONE);
      this.endSlot(p, PAGE_GONE);
    }
    for (const k of [...this.agents.keys()]) if (k.startsWith("code:")) this.agents.delete(k);
    for (const [id, j] of [...this.jobs]) if (j.session.startsWith("code:")) this.jobs.delete(id);
    if (this.selected?.startsWith("code:")) this.selected = null;
    // The next page counts its terminals from the start: every Code record waits under its conversation instead (S7).
    // Nothing touches the file once the records are closed for a quit (will-quit calls this too).
    if (!this.closed) { try { this.o.records.orphanCode(); } catch { /* the records are best effort */ } }
    this.refresh();
  }

  /** Ends a slot: its asks are cancelled, its wheel freed, its browser destroyed, and it leaves the map. */
  private endSlot(p: Slot, reason: string): void {
    const key = p.key;
    this.o.broker.cancel((a) => a.computer === key, reason);
    // End the hold the wheel's own way: a turn end frees an agent's hold and bumps the generation, so nothing in flight lands.
    let h = this.o.wheel.holder(key);
    if (h?.kind === "user") { this.o.wheel.handBack(key); h = this.o.wheel.holder(key); }
    if (h?.kind === "agent") this.o.wheel.turnEnded(h.session);
    if (this.slots.get(key) === p) this.slots.delete(key);
    if (p.save !== null) { this.clock.clearTimeout(p.save); p.save = null; }
    p.power = "off";
    p.programOpens = [];
    this.dropBrowser(p);
  }

  /** Close session, Delete thread (session-browser S22): the session's browser, tabs and record go. */
  forget(session: string): void {
    const p = this.slots.get(session);
    if (p) {
      this.endSlot(p, "the session ended");
      this.agents.delete(session);
      for (const [id, j] of [...this.jobs]) if (j.session === session) this.jobs.delete(id);
      if (this.selected === session) { this.selected = null; this.tellPopOut(); }
    }
    try { this.o.records.forget(session); } catch { /* the records are best effort */ }
    if (p) this.refresh();
  }

  /** Once, before the first call: a thread's record comes back. On, it returns asleep with its tabs (they load when the
   *  session is next used); off, it keeps its tabs for On. Code records are orphans by now (`orphanCode`), whose tabs a
   *  resumed conversation adopts (`describe`). */
  boot(): void {
    for (const key of this.o.records.keys()) {
      // No slot can exist for a key yet: `boot` runs once, right after construction, before any call (the guard is cheap).
      if (!key.startsWith("chat:") || this.slots.has(key)) continue;
      const r = this.o.records.get(key);
      if (!r) continue;
      let exists: boolean | undefined;
      try { exists = this.o.threadExists?.(key); } catch { /* cannot tell: keep the record */ }
      if (exists === false) { try { this.o.records.forget(key); } catch { /* best effort */ } continue; }
      const p = this.slot(key);
      if (r.conversation) p.conversation = r.conversation;
      const kept = r.tabs.length ? { urls: r.tabs, active: r.active } : null;
      // A browser is never on with no tabs (nothing to restore): it comes back off (session-browser A4). One record that
      // cannot be restored must not stop the others: its slot stays off with its tabs remembered.
      if (r.on && kept) {
        p.power = "asleep";
        try { this.browserOf(p).restore(r.tabs, r.active); } catch { this.dropBrowser(p); p.power = "off"; p.remembered = kept; }
      } else p.remembered = kept;
      p.sig = JSON.stringify(this.recordOf(p));
    }
  }

  /** S6, S7: the Code page names a session for the app's own cards and says which conversation it runs. */
  describe(session: string, d: { title?: string; conversation?: Conversation }): void {
    const p = this.slot(session);
    const title = d.title === undefined ? "" : cleanTitle(d.title);
    // A host's spinner changes a title several times a second: the pointer's images are made again only when the tag changes.
    const before = tagText(this.labelOf(session));
    if (title) p.title = title;
    if (d.conversation) {
      p.conversation = { host: d.conversation.host, id: d.conversation.id };
      if (p.power === "off" && !p.remembered && !p.browser) {
        const r = this.o.records.adopt(session, p.conversation);
        if (r && r.tabs.length) p.remembered = { urls: r.tabs, active: r.active };
      }
    }
    if (this.selected === session) { if (tagText(this.labelOf(session)) !== before) this.warmPointer(); this.tellPopOut(); }
    this.refresh(session);
  }

  /** S22: the terminal that replaces a Code session's terminal takes its browser as it is: power, tabs, log, name and
   *  conversation. No page is reloaded. False (and nothing changes) when the keys are equal or not Code keys, when `from`
   *  has no browser slot, or when `to` has a browser or remembered tabs and `from` has nothing to hand over (its browser
   *  is not on, and it is off with no remembered tabs): the replacement keeps its own. Otherwise the terminal being
   *  replaced wins: a browser or remembered tabs that `to` has are ended first (asks cancelled, browser destroyed, the
   *  app told `destroyed(to)` before `moved(from, to)`). A `to` with neither takes the slot over whole. */
  move(from: string, to: string): boolean {
    if (from === to || !CODE_KEY.test(from) || !CODE_KEY.test(to)) return false;
    const p = this.slots.get(from);
    const t = this.slots.get(to);
    if (!p) return false;
    const has = (q: Slot): boolean => q.power !== "off" || !!q.browser || !!q.remembered;
    if (t && has(t) && !has(p)) return false;
    // A program's pages held for the old terminal's Turn on card are not the replacement's to open.
    if (p.programOpens.length) {
      p.programOpens = [];
      this.o.log?.(`door: opens held for ${clean(from, 64)} were dropped (the session restarted)`);
    }
    this.o.broker.cancel((a) => a.computer === from, "the session restarted");
    if (t) {
      // endSlot cancels the asks, frees the wheel, clears the save timer and destroys the browser (telling the app).
      this.endSlot(t, "the session restarted");
      for (const [id, j] of [...this.jobs]) if (j.session === to) this.jobs.delete(id);
    }
    this.o.wheel.rekey(from, to);
    this.slots.delete(from);
    p.key = to;
    // Nothing in the moved slot refers to the old terminal's agent; a title and conversation already described for `to` win.
    this.agents.delete(from);
    p.last = null;
    if (p.quiet) p.quiet.pid = null;
    if (t?.title) p.title = t.title;
    if (t?.conversation) p.conversation = t.conversation;
    this.slots.set(to, p);
    if (this.selected === from) this.selected = to;
    // The pointer drawn for the session is the moved session's still.
    if (this.pointerFor === from) this.pointerFor = to;
    // A `to` that was selected stays so, now showing the moved browser where the pane (or the pop-out) puts it.
    if (this.selected === to && t) {
      if (!this.popped) p.browser?.show(this.bounds);
      // Like select(): a sleeping browser landing on the selection wakes, then the limit is applied.
      this.touch(p);
      this.wakeUp(p, false);
      this.trim(p);
    }
    // The record goes with it; `to` has none of its own to keep (a stale one is replaced, see BrowserRecords.move).
    try { this.o.records.forget(to); this.o.records.move(from, to); } catch { /* the records are best effort */ }
    try { this.o.moved?.(from, to); } catch { /* the app's map is not the service's concern */ }
    // After `moved`, so the app holds the browser for `to` (session-browser S21): the window gets the current object.
    if (this.selected === to) this.tellPopOut();
    // The page stops showing `from`: a last state with nothing in it (the slot itself is gone).
    try { this.o.emit({ session: from, label: this.labelOf(from), tabs: [], holder: this.o.wheel.holder(from), asks: [], log: [], marked: false, poppedOut: false, power: "off" }); } catch { /* a pane that cannot take it misses one update */ }
    this.refresh(to);
    return true;
  }

  /** Writes any record still waiting. */
  flush(): void {
    for (const p of [...this.slots.values()]) { this.track(p); this.flushSlot(p); }
  }

  /** The app is quitting: writes what is waiting, then closes the records. Nothing is tracked or written after it (the
   *  shutdown that follows destroys browsers and cancels asks, and none of that may rewrite a record), so it is safe to
   *  call twice. A quit that fails reopens them: the next browser made (`browserOf`) sets `closed` back to false. */
  flushForQuit(): void {
    if (this.closed) return;
    // The last real addresses are captured here (`flush` asks every live browser through `recordOf`), before the quit
    // destroys the views: a destroyed browser is never asked again.
    this.flush();
    this.closed = true;
    this.quitting = true;
  }

  /** The quit did not happen (an update's install failed): the app goes on. A slot that was on has lost its views but the
   *  session is still on, so it returns ASLEEP with its last-known addresses as kept tabs, as a thread's browser does after
   *  a relaunch: the pane shows them, the next select or call wakes it with them, Off remembers them. Records work again. */
  quitCancelled(): void {
    if (!this.quitting) return;
    this.quitting = false;
    this.closed = false;
    // The app destroyed the pop-out window at quit without `popIn`; it is gone, and the person pops out again if they want it.
    this.popped = false;
    for (const p of this.slots.values()) {
      if (p.power === "off" || p.browser) continue;
      const k = p.known ?? { urls: [], active: 0 };
      // Nothing to restore: it returns off, never on with no tabs (session-browser A4).
      if (!k.urls.length) { p.power = "off"; p.remembered = null; p.sig = JSON.stringify(this.recordOf(p)); continue; }
      p.power = "asleep";
      try { this.browserOf(p).restore(k.urls, k.active); } catch { this.dropBrowser(p); p.power = "off"; p.remembered = k.urls.length ? k : null; }
      p.sig = JSON.stringify(this.recordOf(p));
    }
    this.refresh();
  }

  /** The record of a slot, or null when there is nothing worth keeping: a browser that is off with no tabs and no conversation. */
  private recordOf(p: Slot): { on: boolean; tabs: string[]; active: number; conversation?: Conversation } | null {
    const on = p.power !== "off";
    let t: { urls: string[]; active: number } = p.remembered ?? { urls: [], active: 0 };
    if (on && p.browser && !this.quitting) { try { t = p.browser.realAddresses(); p.known = withoutBlank(t); } catch { t = p.known ?? t; } }
    else if (on && p.known) t = p.known;
    if (!on && !t.urls.length && !p.conversation) return null;
    return { on, tabs: [...t.urls], active: t.active, ...(p.conversation ? { conversation: { ...p.conversation } } : {}) };
  }

  /** A change to the record schedules its write SAVE_MS later (a later change moves it). */
  private track(p: Slot): void {
    if (this.slots.get(p.key) !== p) return;
    if (this.closed) return;
    const sig = JSON.stringify(this.recordOf(p));
    if (sig === p.sig) return;
    p.sig = sig;
    if (p.save !== null) this.clock.clearTimeout(p.save);
    p.save = this.clock.setTimeout(() => { p.save = null; this.writeRecord(p); }, SAVE_MS);
  }

  private flushSlot(p: Slot): void {
    if (p.save === null) return;
    this.clock.clearTimeout(p.save);
    p.save = null;
    this.writeRecord(p);
  }

  private writeRecord(p: Slot): void {
    if (this.closed || this.slots.get(p.key) !== p) return;
    const r = this.recordOf(p);
    try { if (r) this.o.records.put(p.key, r); else this.o.records.forget(p.key); } catch { /* the records are best effort */ }
  }

  /** Destroys a slot's browser, if it has one, and tells the app to forget its handle (pageGone and Off share it). */
  private dropBrowser(p: Slot): void {
    this.hidePointer(p.key);
    const b = p.browser;
    p.browser = null;
    p.waking = null;
    if (!b) return;
    try { b.destroy(); } catch { /* already gone */ }
    try { this.o.destroyed?.(p.key); } catch { /* the app's map is not the service's concern */ }
  }

  /** S3: the quiet period: a Chat session's lasts until its turn ends, a Code session's QUIET_MS. */
  private startQuiet(p: Slot, sentence: string, agent?: AgentRef): void {
    // A Chat period belongs to the turn that is live now (none: it is over at once, e.g. Off between turns).
    const pid = agent?.pid ?? this.o.liveAgent?.(p.key)?.pid ?? this.agents.get(p.key)?.pid ?? null;
    p.quiet = { sentence, until: p.key.startsWith("chat:") ? null : this.clock.now() + QUIET_MS, pid };
    p.programOpens = [];
  }

  /** The user's switch (S4, S5). On: the tabs Off remembered, else the start page, opened by the user; no ask, and it ends
   *  the quiet period. Off: every tab closes, the session's asks are cancelled and the action in flight is stopped. */
  power(session: string, on: boolean): void { this.setPower(session, on, false); }

  /** `power`; `noStart` (a clicked link turns the browser on, session-browser S14) leaves the start page unopened when no
   *  tabs were remembered, since the link's own tab follows. */
  private setPower(session: string, on: boolean, noStart: boolean): void {
    if (this.quitting) return;
    const p = this.slot(session);
    if (on) {
      if (p.power !== "off") return;
      this.turnOn(p);
      const b = this.browserOf(p);
      const r = p.remembered;
      p.remembered = null;
      // An agent's card carries the program's pages: its run queues them behind its own open, so they are not flushed here
      // (the agent's open would navigate the last of them).
      const agentCard = this.o.broker.pending(session).some((a) => a.why === "power" && a.session !== PROGRAM);
      const flushHeld = (): void => { if (!agentCard) this.flushProgramOpens(p); };
      // A held Turn on card is answered by this (S4); its open runs on the browser that is now on.
      this.o.broker.cancel((a) => a.computer === session && a.why === "power", ON_BY_HAND);
      this.refresh(session);
      // The opens run in the slot's queue, as the agent's calls do: a call arriving meanwhile waits for them and acts on a
      // settled tab, and no state shows a half-made one.
      p.reopening = r;
      const done = (): void => { if (p.reopening === r) p.reopening = null; this.refresh(session); };
      if (r) {
        // The remembered addresses are real: they reopen through `restore`, so each is hidden from the agent until the tab
        // next navigates (S9), and a tab that does not load is named by its hidden form only.
        b.restore(r.urls, r.active);
        const w: Promise<void> = this.serial(p, () => b.wake()).catch(() => this.line(p, USER, "The tabs did not open.", null)).finally(() => { if (p.waking === w) p.waking = null; done(); });
        p.waking = w;
        this.refresh(session);
        flushHeld();
        return;
      }
      if (noStart) { this.refresh(session); flushHeld(); return; }
      void this.serial(p, async () => {
        try { await b.open(this.o.startPage ?? START_PAGE, { by: null }); } catch { if (p.browser === b) this.line(p, USER, `The page did not open: ${(this.o.startPage ?? START_PAGE).replace(/[?#].*$/, "")}`, null); }
      }).finally(done);
      // Pages a program opened while the browser was off follow the tabs the person's switch opens (session-browser S23).
      flushHeld();
      return;
    } else if (p.power !== "off") this.switchOff(p, true, true, "the user switched the browser off", REFUSAL.switchedOff);
    this.refresh(session);
  }

  private turnOn(p: Slot): void {
    // While the app quits no browser can be made: refuse before the power changes, or the slot stays awake with none (A5).
    if (this.quitting) throw new Error(REFUSAL.quitting);
    p.power = "awake";
    p.quiet = null;
    this.browserOf(p);
    this.touch(p);
    this.trim(p);
    if (this.selected === p.key) { this.warmPointer(); this.tellPopOut(); }
  }

  private touch(p: Slot): void { p.used = ++this.stamp; }

  /** S9: an asleep browser is awake again: its state says so at once, its tabs reload inside the slot's queue (so an agent's
   *  call or the user's navigate that arrives meanwhile waits for them), and then the limit is applied. No ask, no quiet
   *  period: the user did not switch it off. */
  private wakeUp(p: Slot, trim = true): void {
    if (p.power !== "asleep" || !p.browser) return;
    const b = p.browser;
    p.power = "awake";
    const w: Promise<void> = this.serial(p, () => b.wake()).catch(() => this.line(p, USER, `The tabs did not wake.`, null)).finally(() => { if (p.waking === w) p.waking = null; this.refresh(p.key); });
    p.waking = w;
    if (trim) this.trim(p);
    this.refresh(p.key);
  }

  /** S9: puts the least recently used awake browsers to sleep until at most `config().awake` are awake. Never `except` (the
   *  one just woken or turned on), the selected one, one whose wheel is held, one with a pending ask, or one with work
   *  queued or running (its steps, a wake, On's opens); when every awake one is exempt the limit is passed. */
  private inUse(q: Slot): boolean {
    return !!this.o.wheel.holder(q.key) || this.o.broker.pending(q.key).length > 0 || q.queued > 0 || q.looking > 0 || q.reading > 0 || !!q.waking || !!q.reopening || q.running > 0;
  }

  private trim(except: Slot | null): void {
    const limit = this.o.config().awake;
    const awake = (): Slot[] => [...this.slots.values()].filter((q) => q.power === "awake" && q.browser);
    const failed = new Set<Slot>();
    for (;;) {
      const all = awake();
      if (all.length <= limit) return;
      const idle = all.filter((q) => q !== except && !failed.has(q) && q.key !== this.selected && !this.inUse(q)).sort((a, b) => a.used - b.used)[0];
      if (!idle?.browser) return;
      try { idle.browser.sleep(); } catch (e) {
        // A sleep that failed leaves the browser awake; it is set aside for this pass so the loop ends, and logged once.
        this.line(idle, USER, `The browser did not go to sleep: ${forPerson(e)}`, null);
        failed.add(idle);
        continue;
      }
      idle.power = "asleep";
      this.refresh(idle.key);
    }
  }

  private switchOff(p: Slot, remember: boolean, quiet: boolean, reason: string, sentence: string): void {
    // The real addresses, which stay in main (S6); `tabs()` is the form that leaves.
    let real: { urls: string[]; active: number } | null = null;
    try { real = p.browser?.realAddresses() ?? null; } catch { /* a browser that cannot answer remembers nothing */ }
    // A copy: On's `done` compares `reopening` by identity, and an earlier On finishing must not clear a later one's (A8).
    p.remembered = remember && p.reopening ? { urls: [...p.reopening.urls], active: p.reopening.active } : remember && real && real.urls.length ? real : null;
    p.power = "off";
    this.hidePointer(p.key);
    // The pages a card was holding go with a line, as a Not now's do (session-browser A7); the person's own act, so main's log says nothing.
    this.dropHeld(p, null);
    this.dropBrowser(p);
    this.o.broker.cancel((a) => a.computer === p.key, reason);
    this.o.wheel.interrupt(p.key, true);
    this.stop(p, sentence);
    if (quiet) this.startQuiet(p, sentence); else p.quiet = null;
    if (this.selected === p.key) this.tellPopOut();
  }

  /** The person's × (S5). Returns true when it switched the browser off (the caller has nothing more to do). */
  private closeTab(p: Slot, b: BrowserLike, index: number): boolean {
    const tabs = b.tabs();
    const t = tabs[index];
    if (!t) return false;
    if (tabs.length === 1) { this.switchOff(p, false, false, "the user closed the tab", REFUSAL.tabClosed); this.refresh(p.key); return true; }
    if (t.active) {
      this.hidePointer(p.key);
      this.o.wheel.interrupt(p.key);
      this.o.broker.cancel((a) => a.computer === p.key, "the user closed the tab");
      this.stop(p, REFUSAL.tabClosed);
    }
    b.close(index);
    return false;
  }

  /** The app destroyed every browser (it is quitting): a later call makes a new one, should the app go on after all (an
   *  update's quit that failed). */
  forgetBrowsers(): void {
    // Never recomputes a record: the browsers are destroyed already and would answer "no tabs".
    this.hidePointer();
    for (const p of this.slots.values()) p.browser = null;
  }

  /** For the wheel: a computer is reserved while an action runs or its holder has an ask pending (D31). A page's ask
   *  attributed to no one never holds the wheel for an agent that did not act. */
  reserved(place: string): boolean {
    const q = this.slots.get(place);
    if ((q?.running ?? 0) > 0 || (q?.reading ?? 0) > 0) return true;
    const h = this.o.wheel.holder(place);
    return h?.kind === "agent" && this.o.broker.pending(place).some((a) => a.session === h.session);
  }

  /** Emits the state of the browser of `session`, or of every one (the broker's and the wheel's onChange). */
  refresh(place?: string): void {
    for (const k of place === undefined ? [...this.slots.keys()] : [place]) {
      // A late call for a session that was forgotten, moved or lost with the page makes no empty slot (session-browser A2).
      const p = this.slots.get(k);
      if (!p) continue;
      try { this.o.emit(this.state(p)); } catch { /* a pane that cannot take the state misses one update */ }
      this.track(p);
    }
  }

  // ---- helpers

  private state(p: Slot): ComputerState {
    const tabs = p.browser?.tabs() ?? [];
    const active = tabs.find((t) => t.active);
    return { session: p.key, label: this.labelOf(p.key), tabs, holder: this.o.wheel.holder(p.key), asks: this.o.broker.pending(p.key), log: [...p.log], marked: active ? this.o.sites.isMarked(active.url) : false, poppedOut: this.popped, power: p.power };
  }

  /** The newest agent's label, else main's own name for the session, else none (session-browser S1). */
  private labelOf(key: string): string {
    const p = this.slots.get(key);
    const given = p?.title ?? this.o.liveAgent?.(key)?.label ?? this.agents.get(key)?.label;
    if (given !== undefined) return given;
    // main's own name reads a file (a Chat thread's): kept on the slot; a session with no slot is not cached.
    if (!p) return cleanTitle(this.o.label?.(key) ?? "");
    return p.named ??= cleanTitle(this.o.label?.(key) ?? "");
  }

  /** A session's name in main may have changed (a Chat thread's title, when its turn starts or ends): the next label is
   *  read again, and the pane hears of it. Never makes a slot for a session that has none. */
  retitled(session: string): void {
    const p = this.slots.get(session);
    if (!p) return;
    p.named = null;
    this.refresh(session);
    if (session === this.selected) { this.warmPointer(); this.tellPopOut(); }
  }

  private slot(key: string): Slot {
    let p = this.slots.get(key);
    if (!p) { p = { key, browser: null, power: "off", remembered: null, title: null, named: null, conversation: null, sig: "null", save: null, known: null, quiet: null, programOpens: [], reopening: null, used: 0, waking: null, queued: 0, looking: 0, stopped: null, stops: [], replies: Promise.resolve(), reading: 0, log: [], last: null, running: 0, queue: Promise.resolve(), ownCard: null }; this.slots.set(key, p); }
    return p;
  }

  private browserOf(p: Slot): BrowserLike {
    // S2: reached only while the slot is on; an off slot has no browser, view or process, and a path that forgot to ask
    // fails here instead of making one.
    if (p.power === "off") throw new Error(REFUSAL.isOff);
    if (!p.browser) {
      // Nothing is made while the app quits (the views are gone for good unless `quitCancelled`).
      if (this.quitting) throw new Error(REFUSAL.quitting);
      // The hooks read the slot's key when they run, so a browser `move` hands to another key keeps working.
      p.browser = this.o.browser(p.key, {
        ask: (i) => this.pageAsk(p.key, i),
        note: (text) => { void this.pageNote(p.key, text); },
        changed: () => this.refresh(p.key),
        // The tab in front changed, or (`page`) its main frame committed another document: the pointer drawn over the old page goes.
        front: (page) => { this.fronted(p, !!page); this.ownCardGone(p); },
        agentDrives: () => this.o.wheel.holder(p.key)?.kind === "agent",
      });
      if (p.key === this.selected && !this.popped) p.browser.show(this.bounds);
    }
    return p.browser;
  }

  private serial<T>(p: Slot, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => { p.running++; try { return await fn(); } finally { p.running--; } };
    p.queued++;
    const r = p.queue.then(run, run);
    p.queue = r.catch(() => undefined);
    void p.queue.then(() => { p.queued--; this.released(); });
    return r;
  }

  /** "busy: …" for a session that cannot act on `session`'s browser now (agent-computer D31, controller 8). */
  private busy(place: string, sentence: string): string {
    return this.o.wheel.holder(place)?.kind === "user" ? REFUSAL.busyUser(sentence) : REFUSAL.busy(sentence);
  }

  /** Null while `agent` holds the wheel; otherwise the busy reply. Checked again just before input is delivered, since an
   *  action can wait behind another while the user takes over or the turn ends. */
  private notDriving(p: Slot, agent: AgentRef): Reply | null {
    if (this.holds(p.key, agent.key)) return null;
    const h = this.o.wheel.holder(p.key);
    return fail(this.busy(p.key, h?.kind === "user" ? "the user is driving" : h ? `${h.label} is driving` : NOT_HELD));
  }

  private holds(place: string, session: string): boolean {
    const h = this.o.wheel.holder(place);
    return h?.kind === "agent" && h.session === session;
  }

  /** R81 (AC-R3-01): whether `agent` is still the process the app's registry holds for its session key. A replacement
   *  under the same key (a thread's next Chat CLI) is another caller, so an old call of the first never acts for it. With
   *  no registry wired (some tests), the session key alone. */
  private registered(agent: AgentRef): boolean {
    if (!this.o.liveAgent) return true;
    try { return this.o.liveAgent(agent.key)?.pid === agent.pid; } catch { return false; }
  }

  /** R81: true while an acting call may still deliver: its session holds the wheel, under the generation the call started
   *  with, from the process the registry holds for it. The predicate before each input event. */
  private current(p: Slot, agent: AgentRef, lease: Lease): boolean {
    return this.holds(p.key, agent.key) && this.registered(agent) && this.o.wheel.gen(p.key) === lease.gen;
  }

  /** R81: null while the call is current; otherwise the reply that ends it: busy while someone else drives or this process
   *  was replaced, and the changed reply when this session holds the wheel again after a Take over and Hand back. */
  private stale(p: Slot, agent: AgentRef, lease: Lease): Reply | null {
    const byUser = this.stopped(p, lease);
    if (byUser) return byUser;
    // A slot the handoff ended is no longer the one in the map: its call ends with the restart, and raises nothing.
    if (this.slots.get(p.key) !== p) return fail(REFUSAL.restarted);
    const busy = this.notDriving(p, agent);
    if (busy) return busy;
    if (!this.registered(agent)) return fail(this.busy(p.key, NOT_HELD));
    if (this.o.wheel.gen(p.key) !== lease.gen) return refuseAt(REFUSAL.changed, p.browser ? this.url(p.browser) : null);
    return null;
  }

  /** S5: the reply of a call the person stopped (the browser switched off, the active tab closed) since it started, else
   *  null. Only the generation the stop made counts: a later Take over or turn end bumps past it and reads as before. */
  private stopped(p: Slot, lease: Lease): Reply | null {
    const s = p.stopped;
    return s && lease.gen < s.gen && this.o.wheel.gen(p.key) === s.gen ? fail(s.sentence) : null;
  }

  /** The person stopped what was running in this browser: remembered as the latest stop (`stopped`) and in the slot's short
   *  history, which a reply read later still finds after a Take over or a turn end (session-browser S16). */
  private stop(p: Slot, sentence: string): void {
    p.stopped = { gen: this.o.wheel.gen(p.key), sentence };
    p.stops.push(p.stopped);
    if (p.stops.length > 4) p.stops.shift();
  }

  /** The sentence of the first stop after the call began, whatever followed it (a Take over or a turn end moves the wheel's
   *  generation on), else null. */
  private stoppedAfter(p: Slot, lease: Lease): string | null {
    return p.stops.find((s) => s.gen > lease.gen)?.sentence ?? null;
  }

  private active(b: BrowserLike): number { return b.tabs().find((t) => t.active)?.index ?? -1; }
  /** The active tab's URL, already scrubbed by the browser (D9). */
  private url(b: BrowserLike): string | null { return b.tabs().find((t) => t.active)?.url ?? null; }
  /** The origin of a tab: a scrubbed URL keeps its origin whole, so it is the site to judge and remember. */
  private siteAt(b: BrowserLike, tab: number): string | null { return siteOf(b.tabs()[tab]?.url ?? ""); }
  private markedAt(b: BrowserLike, tab: number): boolean { const u = b.tabs()[tab]?.url; return u ? this.o.sites.isMarked(u) : false; }

  /** A line in the session's activity log, and (with `agent`) the same line for that agent's Chat thread (D35, D6, D21),
   *  naming you when you acted (a page's own line already says what the page did). */
  private line(p: Slot, session: string, text: string, agent: AgentRef | null): void {
    p.log.push({ at: this.clock.now(), session, text });
    if (p.log.length > LOG_MAX) p.log.splice(0, p.log.length - LOG_MAX);
    if (agent) this.note(agent, session === USER ? `${USER}: ${text}` : text);
    this.refresh(p.key);
  }

  private note(agent: AgentRef, text: string): void {
    try { this.o.note(agent, text); } catch { /* a line that cannot be written never fails the action */ }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => { this.clock.setTimeout(r, ms); });
  }
}
