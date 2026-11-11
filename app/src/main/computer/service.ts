// The computer service (agent-computer D3, D17, D21, D30–D35, D39): takes an admitted agent's tool call to its place's
// computer and runs it through the wheel (one driver, D31), the gate (go, ask or refuse, D17, D39, D43), the ask broker
// (D7, D34) and the browser, and serves the operations the pane calls (D5, D32). D9: text that leaves the main process
// (ask titles and details, replies, log lines, notes) never carries a raw page-derived name: a target's name goes out as
// `Resolved.shown` / `Focus.shown`, other page text through `browser.scrub(text, tab)`, while the gate judges the raw
// target. I1: even scrubbed, a page's name for a control stays on the person's side (the card, the activity log, a Chat
// thread's live lines); a notice and every reply to an agent name an ask by its app-written labels, the action's kind and
// the site's host only (`AskInput.notice`). Nothing here touches Electron, so the unit tests drive it with a fake browser
// and a fake clock.

import { realClock, type Answer, type Ask, type AskBroker, type AskInput, type Clock, type Outcome } from "./asks";
import type { BrowserHooks, ComputerBrowser, FocusId, Judged, Resolved, TabInfo } from "./browser";
import { FocusMoved, PageChanged } from "./cdp";
import type { ToolCall, ToolReply } from "./bridge";
import { categoriesOf, type AskCategory, type Target } from "./categories";
import type { ComputerConfig } from "./config";
import { judge, type AskWhy, type Focus, type Verdict } from "./gate";
import type { Rect } from "./mask";
import type { AgentRef } from "./registry";
import type { SiteMarks } from "./sites";
import type { Holder, Wheel } from "./wheel";
import { navAllowed, siteOf } from "../policy/computer-url";
import type { ComputerNavGo, Result } from "../../shared/ipc";
import { START_PAGE } from "../../../../hud/src/data/computerStart";

export interface LogLine { at: number; session: string; text: string }
export interface ComputerState { place: string; tabs: TabInfo[]; holder: Holder; asks: readonly Ask[]; log: readonly LogLine[]; marked: boolean; poppedOut: boolean }

/** The part of `ComputerBrowser` the service drives. */
export type BrowserLike = Pick<ComputerBrowser, "tabs" | "pageToken" | "open" | "select" | "close" | "nav" | "snapshot" | "screenshot" | "resolve" | "focus" | "scrub" | "click" | "type" | "key" | "scroll" | "show">;

export interface ServiceOptions {
  /** Makes the computer of a place (once per place); its hooks route page asks, notes and changes back here. */
  browser: (place: string, hooks: BrowserHooks) => BrowserLike;
  broker: AskBroker;
  /** Built with `reserved: (c) => service.reserved(c)` and `onChange: (c) => service.refresh(c)`. */
  wheel: Wheel;
  sites: SiteMarks;
  config: () => ComputerConfig;
  emit: (s: ComputerState) => void;
  /** A line for the agent's Chat thread (a live `computer` event) or Code session (D35). The service has already put it
   *  in the place's activity log (`ComputerState.log`). */
  note: (agent: AgentRef, line: string) => void;
  /** Moves the place's computer into the pop-out window (the app's window code). */
  popOut?: (place: string) => void;
  /** The live agent the app's registry holds for a session key (AgentRegistry.byKey), so a late `agentGone` from a
   *  session's previous process is ignored. */
  liveAgent?: (key: string) => AgentRef | undefined;
  /** Where a tab the person opens (the pane's +) starts: START_PAGE (hud/src/data/computerStart.ts, DuckDuckGo) unless
   *  main was given the e2e suite's fixture (computer/notify.ts testSwitches). */
  startPage?: string;
  clock?: Clock;
}

type Reply = Omit<ToolReply, "id">;

/** What each ask is, in app-written text at the head of its card, so a scrubbed or page-chosen name cannot hide what the
 *  action is (agent-computer D6, D9, D43). */
export const ASK_LABELS: Readonly<Record<AskWhy, string>> = Object.freeze({
  submit: "Submit", purchase: "Purchase", send: "Send", delete: "Delete", merge: "Merge", signin: "Sign in", download: "Download",
  unmarked: "Act on a site you haven't marked", return: "Press Return", file: "Choose a file", permission: "Grant a permission",
  frame: "Act inside a frame from another site",
});

const CATEGORIES: ReadonlySet<string> = new Set<AskCategory>(["submit", "purchase", "send", "delete", "merge", "signin", "download"]);
const isCategory = (w: AskWhy): w is AskCategory => CATEGORIES.has(w);
/** agent-computer D6, D39: "Always on <site>" marks the site (unmarked) or allows a category for it. Return, file,
 *  download, permission and frame asks are asked every time. */
const offersAlways = (w: AskWhy): boolean => w === "unmarked" || (isCategory(w) && w !== "download");

const LOOK: ReadonlySet<string> = new Set(["computer_status", "computer_snapshot", "computer_screenshot", "computer_wait"]);
const OFF = "The Computer pane is off (Settings › Computer).";
const CHANGED = "The page changed while you waited: look again.";
/** D34 (R78): the call's 45 s ran out before it took the computer (queued behind another action, or a slow read). R80:
 *  the action did not run, though a read already under way (a ref scrolled into view, the pointer moved) may have. */
const LATE = "busy: this call waited its 45 s for the computer and the action did not run: call it again.";
/** I3b: the focus a key or typing is judged by was read on another page or tab than the one now in front. */
const MOVED = "The page or tab changed while the focus was read: look again.";
const PAGE = { session: "page", label: "the page" } as const;
/** The busy reply's sentence for a session whose hold is gone: freed, or (R81) its process no longer the registered one. */
const NOT_HELD = "this session no longer holds the wheel";
const USER = "You";
const LOG_MAX = 200;
/** How long a settled ask's reply stays for `computer_wait`. */
const KEEP_MS = 120_000;
const POLL_MS = 500;
const WAIT_MAX_SEC = 40;
const TEXT_WAIT_SEC = 10;

interface Place {
  key: string;
  browser: BrowserLike | null;
  log: LogLine[];
  /** The agent that called on this computer last: where a page's own notes go when no agent holds the wheel. */
  last: AgentRef | null;
  /** Actions under way (the wheel never frees under one, D31). */
  running: number;
  /** Serialises the computer's acting steps, so one action's hover, check and press never interleave with another's. */
  queue: Promise<unknown>;
}

/** An action the gate asks about. `whys` is never empty; the first names the card. */
interface AskSpec {
  whys: AskWhy[];
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
interface Job { session: string; answered: boolean; done: Promise<Reply> }
/** R81 (AC-R3-01): what an acting call holds from its start: its place's cancellation generation (Wheel.gen). The call's
 *  own AgentRef is its registration identity (its pid). Both are checked after every await in the call's path, before an
 *  ask is raised and in the predicate before each input event (`current`, `stale`). */
interface Lease { gen: number }

type By = { ref: string } | { x: number; y: number };
type Parsed =
  | { kind: "open"; url: string; newTab: boolean }
  | { kind: "click"; by: By }
  | { kind: "type"; text: string; ref: string | null }
  | { kind: "key"; key: string }
  | { kind: "scroll"; dx: number; dy: number; ref: string | null };

const fail = (text: string): Reply => ({ text, isError: true });
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
  if (a.ref !== undefined && (typeof a.ref !== "string" || !a.ref || a.ref.length > 32)) return "ref must be a snapshot ref, such as e12.";
  const ref = typeof a.ref === "string" ? a.ref : null;
  switch (call.tool) {
    case "computer_open":
      return typeof a.url === "string" && a.url && a.url.length <= 8192 ? { kind: "open", url: a.url, newTab: a.newTab === true } : "Give url, the page to open.";
    case "computer_click":
      if (ref) return { kind: "click", by: { ref } };
      return finite(a.x) && finite(a.y) ? { kind: "click", by: { x: a.x, y: a.y } } : "Give either ref, or both x and y.";
    case "computer_type":
      return typeof a.text === "string" && a.text && a.text.length <= 20_000 ? { kind: "type", text: a.text, ref } : "Give text to type, at most 20,000 characters.";
    case "computer_key":
      return typeof a.key === "string" && a.key && a.key.length <= 40 ? { kind: "key", key: a.key } : "Give key, such as Enter or Shift+Tab.";
    case "computer_scroll":
      return finite(a.dy) && (a.dx === undefined || finite(a.dx)) ? { kind: "scroll", dx: finite(a.dx) ? a.dx : 0, dy: a.dy, ref } : "Give dy in pixels (and dx if needed).";
    default:
      return "Unknown tool.";
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
  if (o.state !== "denied" || o.answer === "deny") return `The user denied: ${bare(notice)}.`;
  if (o.reason === "timed out") return `The user did not answer in time, so it was denied: ${bare(notice)}.`;
  return `Cancelled because ${o.reason ?? "it was cancelled"}: ${bare(notice)}.`;
}

export class ComputerService {
  private readonly places = new Map<string, Place>();
  /** Each asked action's reply by ask id, for `computer_wait`; the session that asked. */
  private readonly jobs = new Map<string, Job>();
  /** The latest ref of each session that called, by session key. */
  private readonly agents = new Map<string, AgentRef>();
  private selected: string | null = null;
  private bounds: Rect | null = null;
  private popped = false;
  private readonly clock: Clock;

  constructor(private readonly o: ServiceOptions) {
    this.clock = o.clock ?? realClock;
  }

  // ---- agent calls

  async call(agent: AgentRef, call: ToolCall): Promise<Reply> {
    if (!this.o.config().enabled) return fail(OFF);
    // agent-computer D3, D30: the session's place is its computer.
    const p = this.placeOf(agent.place);
    this.agents.set(agent.key, agent);
    try {
      return LOOK.has(call.tool) ? await this.look(agent, p, call) : await this.act(agent, p, call);
    } catch (e) {
      return fail(message(e));
    }
  }

  /** Look tools never take the wheel and answer while another session or the user drives (agent-computer D31). */
  private async look(agent: AgentRef, p: Place, call: ToolCall): Promise<Reply> {
    const a = call.args;
    if (call.tool === "computer_status") return { text: this.status(agent, p) };
    if (call.tool === "computer_wait") return this.wait(agent, p, a);
    const tab = tabArg(a);
    if (tab === null) return fail("tab must be a tab index, such as 0.");
    const b = this.browserOf(p);
    // D21: the snapshot is page text, already scrubbed and wrapped as untrusted data with its origin.
    // I2: its refs are this session's own.
    if (call.tool === "computer_snapshot") return { text: (await b.snapshot(tab, agent.key)).text };
    const png = await b.screenshot(tab);
    const shot = tab === undefined ? b.tabs().find((t) => t.active) : b.tabs()[tab];
    return { image: { data: png.toString("base64"), mimeType: "image/png" }, text: `A screenshot of ${shot?.url ? untrustedUrl(shot.url) : "the page"}, with password fields painted over.` };
  }

  private async act(agent: AgentRef, p: Place, call: ToolCall): Promise<Reply> {
    // D34 (R76): an asked call returns by the broker's hold (45 s) counted from here, its start, whatever it waits on.
    const deadline = this.clock.now() + this.o.broker.holdMs;
    // R81 (AC-R3-01): the call is bound to its place's generation as it is now, and to the calling process.
    const lease: Lease = { gen: this.o.wheel.gen(p.key) };
    const parsed = parse(call);
    if (typeof parsed === "string") return fail(parsed);
    // D17: a Read only session is refused before it can hold the wheel.
    const ro = judge({ kind: "scroll" }, { access: agent.access, marked: false });
    if ("refuse" in ro) return fail(ro.refuse);
    if (parsed.kind === "open") {
      const v = judge({ kind: "open", url: parsed.url }, { access: agent.access, marked: false });
      if ("refuse" in v) return fail(v.refuse);
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
      return await this.bounded(deadline, async (g) => {
        const step = await this.serial(p, () => (g.alive() ? this.step(agent, p, parsed, g.take, lease) : Promise.resolve<Step>({ reply: fail(LATE) })));
        if ("reply" in step) return step.reply;
        // R81: writing the card awaited the page's text; no ask is raised for a call that is no longer current.
        const gone = this.stale(p, agent, lease);
        if (gone) return gone;
        return g.take() ? this.ask(agent, p, step.ask, deadline, lease) : fail(LATE);
      });
    } finally {
      this.o.wheel.touch(p.key, agent.key);
    }
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
      const timer = this.clock.setTimeout(() => { if (!taken) { gone = true; resolve(fail(LATE)); } }, Math.max(0, deadline - this.clock.now()));
      void work({ take, alive }).then((r) => { this.clock.clearTimeout(timer); resolve(r); }, (e: unknown) => { this.clock.clearTimeout(timer); reject(e); });
    });
  }

  /** Resolves the target, judges it, and runs the action when the verdict is go; returns the ask otherwise. `take` claims
   *  the computer just before input is delivered (R78: false once the call's deadline has passed). R81: after the queue,
   *  and after each read of the page, the call must still be current (`lease`). */
  private async step(agent: AgentRef, p: Place, a: Parsed, take: () => boolean, lease: Lease): Promise<Step> {
    const busy = this.stale(p, agent, lease);
    if (busy) return { reply: busy };
    const b = this.browserOf(p);
    switch (a.kind) {
      case "open": {
        if (!take()) return { reply: fail(LATE) };
        await b.open(a.url, { newTab: a.newTab, by: agent.label });
        const url = this.url(b);
        // D39: a URL the agent opens itself is logged, not asked.
        this.line(p, agent.label, `Opened ${url ?? a.url}`, agent);
        return { reply: { text: `Opened the page. ${pageLine(url)}` } };
      }
      case "click": return this.click(agent, p, b, a.by, take, lease);
      case "type": return this.typeStep(agent, p, b, a.text, a.ref, take, lease);
      case "key": return this.keyStep(agent, p, b, a.key, take, lease);
      case "scroll": {
        const at = a.ref ? await b.resolve({ ref: a.ref }, agent.key) : undefined;
        const late = this.stale(p, agent, lease);
        if (late) return { reply: late };
        if (!take()) return { reply: fail(LATE) };
        await b.scroll(a.dx, a.dy, at);
        return { reply: { text: `Scrolled by (${a.dx}, ${a.dy}). ${pageLine(this.url(b))}` } };
      }
    }
  }

  private async click(agent: AgentRef, p: Place, b: BrowserLike, by: By, take: () => boolean, lease: Lease): Promise<Step> {
    const r = await b.resolve(by, agent.key);
    // R81: a Take over and Hand back (or the process's replacement) during the target read ends the call here.
    const read = this.stale(p, agent, lease);
    if (read) return { reply: read };
    const site = this.siteAt(b, r.tab);
    const need = this.need(judge({ kind: "click", target: r.target }, { access: agent.access, marked: this.markedAt(b, r.tab) }), r.target, site);
    if (need && typeof need === "object") return { reply: fail(need.refuse) };
    const did = "ref" in by ? by.ref : `at (${by.x}, ${by.y})`;
    const run = async (x: Resolved): Promise<Reply> => {
      const late = this.stale(p, agent, lease);
      if (late) return late;
      const lost = await this.deliver(p, agent, lease, (valid) => b.click(x, valid));
      if (lost) return lost;
      this.line(p, agent.label, x.shown ? `Clicked ${quoted(x.shown)}` : "Clicked an unnamed control", agent);
      return { text: `Clicked ${did}. ${pageLine(this.url(b))}` };
    };
    if (!need) return { reply: take() ? await run(r) : fail(LATE) };
    let fresh = r;
    return {
      ask: {
        whys: [need], site, target: r.target,
        action: r.shown ? `Click ${quoted(r.shown)}` : "Click an unnamed control", kind: "Click",
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

  /** D39: typing into a ref is a click on it and the typing, under one ask; after the click the focus is judged again. */
  private async typeStep(agent: AgentRef, p: Place, b: BrowserLike, text: string, ref: string | null, take: () => boolean, lease: Lease): Promise<Step> {
    const r = ref ? await b.resolve({ ref }, agent.key) : null;
    // The page token and tab are read before the focus and compared after it, so a navigation during the read refuses.
    const token = r ? r.pageToken : b.pageToken();
    const tab = r ? r.tab : this.active(b);
    // A ref's field stands in for the focus until the click lands; plainTextarea false asks Return (fails closed).
    const f: Focus = r ? { target: r.target, shown: r.shown, sensitive: r.sensitive, plainTextarea: false, node: r.backendNodeId, frame: null } : await b.focus();
    // R81: the target or focus read was an await: the call must still be current after it.
    const read = this.stale(p, agent, lease);
    if (read) return { reply: read };
    // I3b: the focus judged is this page's in this tab, or nothing goes.
    if (!r && (b.pageToken() !== token || this.active(b) !== tab)) return { reply: fail(`${MOVED} ${pageLine(this.url(b))}`) };
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
      const late = this.stale(p, agent, lease);
      if (late) return late;
      // R76: the typing goes into the element judged: the focus read now (after a ref's click) or the one the gate judged.
      let into = idOf(f);
      if (fresh) {
        const x = fresh;
        const lost = await this.deliver(p, agent, lease, (valid) => b.click(x, valid));
        if (lost) return lost;
        const now = await b.focus();
        const after = this.stale(p, agent, lease);
        if (after) return after;
        // I3b: the click and the focus read must leave the page the gate judged in front; the typing is bound to it.
        if (b.pageToken() !== fresh.pageToken || this.active(b) !== fresh.tab) return fail(`${MOVED} ${pageLine(this.url(b))}`);
        const v = this.need(judge({ kind: "type", text, focus: now }, { access: agent.access, marked: this.markedAt(b, fresh.tab) }), now.target, this.siteAt(b, fresh.tab));
        if (v && typeof v === "object") return fail(v.refuse);
        if (v && !approved.includes(v)) return fail(`The click moved the focus somewhere that asks first: call computer_type again without ref. ${pageLine(this.url(b))}`);
        into = idOf(now);
      }
      return this.typeInto(agent, p, b, text, fresh ? { tab: fresh.tab, pageToken: fresh.pageToken } : { tab, pageToken: token }, into, lease);
    };
    if (!whys.length) return { reply: take() ? await run([]) : fail(LATE) };
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

  private async keyStep(agent: AgentRef, p: Place, b: BrowserLike, key: string, take: () => boolean, lease: Lease): Promise<Step> {
    // Read before the focus, so a navigation during the read refuses (below) or fails the revalidation.
    const token = b.pageToken();
    const tab = this.active(b);
    const f = await b.focus();
    // R81: the focus read was an await: the call must still be current after it.
    const read = this.stale(p, agent, lease);
    if (read) return { reply: read };
    // I3b: and checked again after it: a navigation or a tab switch during the read refuses the key at once.
    if (b.pageToken() !== token || this.active(b) !== tab) return { reply: fail(`${MOVED} ${pageLine(this.url(b))}`) };
    const site = this.siteAt(b, tab);
    const need = this.need(judge({ kind: "key", key, focus: f }, { access: agent.access, marked: this.markedAt(b, tab) }), f.target, site);
    if (need && typeof need === "object") return { reply: fail(need.refuse) };
    const shownKey = clean(key, 40);
    const run = async (): Promise<Reply> => {
      const late = this.stale(p, agent, lease);
      if (late) return late;
      const lost = await this.deliver(p, agent, lease, (valid) => b.key(key, valid, { tab, pageToken: token }, idOf(f)));
      if (lost) return lost;
      this.line(p, agent.label, `Pressed ${shownKey}`, agent);
      return { text: `Pressed ${shownKey}. ${pageLine(this.url(b))}` };
    };
    if (!need) return { reply: take() ? await run() : fail(LATE) };
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

  /** R76 (S-AC-03): runs a click's or a key's delivery with the validity predicate the browser checks just before each
   *  input event (R81: the call is still current: this session holds the wheel, under the generation the call started
   *  with, from the process the registry holds; the browser checks the tab and page itself). When the predicate stopped
   *  it, the busy or changed reply; any other refusal (the page changed) goes on as the browser's error. */
  private async deliver(p: Place, agent: AgentRef, lease: Lease, send: (valid: () => boolean) => Promise<void>): Promise<Reply | null> {
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
  private async typeInto(agent: AgentRef, p: Place, b: BrowserLike, text: string, at: Judged, focus: FocusId, lease: Lease): Promise<Reply> {
    const keepGoing = (): boolean => this.current(p, agent, lease);
    // The user holds the wheel, or held it since the call started and handed it back; otherwise the hold is gone.
    const stopper = (): string => (this.o.wheel.holder(p.key)?.kind === "user" || (this.holds(p.key, agent.key) && this.registered(agent)) ? "the user took over" : NOT_HELD);
    try {
      await b.type(text, keepGoing, at, focus);
    } catch (e) {
      if (!(e instanceof PageChanged)) throw e;
      this.line(p, agent.label, "Typing stopped part way", agent);
      const why = !keepGoing() ? stopper() : e instanceof FocusMoved ? "the focus moved" : "the page or tab changed";
      return fail(`Typing stopped part way because ${why}${keepGoing() ? ": look again" : ""}. ${pageLine(this.url(b))}`);
    }
    if (!keepGoing()) {
      this.line(p, agent.label, "Typing stopped part way", agent);
      return fail(`Typing stopped part way because ${stopper()}. ${pageLine(this.url(b))}`);
    }
    const n = Array.from(text).length;
    this.line(p, agent.label, `Typed ${n} character${n === 1 ? "" : "s"}`, agent);
    return { text: `Typed ${n} character${n === 1 ? "" : "s"}. ${pageLine(this.url(b))}` };
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

  private async ask(agent: AgentRef, p: Place, s: AskSpec, deadline: number, lease: Lease): Promise<Reply> {
    const why = s.whys[0];
    // Controller 3: no Always for return, file, download, permission or frame, nor without a site to remember it for.
    // A category ask on a name that also says Download is asked every time too; an unmarked ask there still marks the site.
    const always = s.site !== null && s.whys.every(offersAlways)
      && !(s.whys.some(isCategory) && s.target !== null && categoriesOf(s.target).includes("download"));
    // Every reason's label heads the card (controller 2, R43): one ask can cover Return and a Delete click.
    const labels = s.whys.map((w) => ASK_LABELS[w]).join(" · ");
    const title = `${labels}: ${s.action} on ${hostOf(s.site)}?`;
    const notice = `${labels}: ${s.kind} on ${hostOf(s.site)}?`;
    const input: AskInput = { computer: p.key, session: agent.key, sessionLabel: agent.label, why, title, notice, detail: s.detail, site: s.site, always };
    const held = this.o.broker.hold(input, deadline - this.clock.now());
    this.line(p, agent.label, `Asked the user: ${title}`, agent);
    const first = await held;
    const job: Job = { session: agent.key, answered: false, done: Promise.resolve(fail(CHANGED)) };
    job.done = this.settle(agent, p, s, input, first, job, lease);
    this.jobs.set(first.askId, job);
    void job.done.then(() => { this.clock.setTimeout(() => this.jobs.delete(first.askId), KEEP_MS); });
    // D34: the call returns within the broker's hold; computer_wait picks the result up.
    if (first.state === "waiting_for_user") return { text: waiting(first.askId) };
    // R76: an answer near the deadline leaves no time for a slow revalidation or action: at the deadline the call says
    // so, as computer_wait does for the same ask, and computer_wait picks the result up.
    return this.until(job.done, deadline, () => ({ text: job.answered ? running(first.askId) : waiting(first.askId) }));
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
  private async settle(agent: AgentRef, p: Place, s: AskSpec, input: AskInput, first: Outcome, job: Job, lease: Lease): Promise<Reply> {
    try {
      let o = first;
      while (o.state === "waiting_for_user") o = await this.o.broker.wait(o.askId);
      job.answered = true;
      // Controller 4 (D31): the wheel's idle timer restarts at the answer, so it cannot free before the revalidation.
      this.o.wheel.touch(p.key, agent.key);
      this.line(p, agent.label, outcomeLine(o, input), agent);
      if (o.state !== "allowed") return fail(deniedText(o, input.notice));
      return await this.serial(p, async () => {
        try {
          if (!this.current(p, agent, lease) || !(await s.revalidate()) || !this.current(p, agent, lease)) return fail(`${CHANGED} ${pageLine(p.browser ? this.url(p.browser) : null)}`);
          const done = await s.run();
          // R76, R78 (D39): "Always" is saved only for the action that revalidated and reports it was delivered; one the
          // browser refused or that failed (it threw, so it never gets here) saves nothing.
          if (!done.isError && o.answer === "always" && input.always && input.site) this.always(p, s, input.site);
          return done;
        } finally {
          this.o.wheel.touch(p.key, agent.key);
        }
      });
    } catch (e) {
      return fail(message(e));
    }
  }

  /** D39 (controller 3): an unmarked ask marks the site; a category ask allows every category of the control's name. Run
   *  only once the approved action has revalidated and been delivered (R76, R78). A write that fails never undoes the
   *  action the person approved, and its error (which names a file) stays in main. */
  private always(p: Place, s: AskSpec, site: string): void {
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
      const p = this.placeOf(place);
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
    const p = this.placeOf(place);
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

  private async wait(agent: AgentRef, p: Place, a: Record<string, unknown>): Promise<Reply> {
    const sec = finite(a.timeoutSec) ? Math.min(WAIT_MAX_SEC, Math.max(1, Math.floor(a.timeoutSec))) : null;
    if (a.askId !== undefined) {
      if (typeof a.askId !== "string" || !a.askId || a.askId.length > 64) return fail("askId must be the id from a waiting_for_user reply.");
      return this.waitAsk(agent, a.askId, (sec ?? WAIT_MAX_SEC) * 1000);
    }
    if (a.text !== undefined) {
      if (typeof a.text !== "string" || !a.text || a.text.length > 200) return fail("text must be 1 to 200 characters.");
      return this.waitText(p, a.text, sec ?? TEXT_WAIT_SEC);
    }
    const s = sec ?? 1;
    await this.sleep(s * 1000);
    return { text: `Waited ${s} s. ${pageLine(p.browser ? this.url(p.browser) : null)}` };
  }

  /** D34: an asked action's reply once its ask settles, or waiting_for_user again after `ms`. */
  private waitAsk(agent: AgentRef, id: string, ms: number): Promise<Reply> {
    const job = this.jobs.get(id);
    if (job && job.session !== agent.key) return Promise.resolve(fail("That ask belongs to another session."));
    const result: Promise<Reply> = job ? job.done : this.o.broker.wait(id).then((o): Reply => {
      if (o.state === "waiting_for_user") return { text: waiting(id) };
      if (o.state === "allowed") return { text: "The user allowed it." };
      return o.reason === "unknown ask" ? fail(`There is no ask "${clean(id, 64)}".`) : fail(o.answer === "deny" ? "The user denied it." : `Denied: ${o.reason ?? "cancelled"}.`);
    });
    return new Promise<Reply>((resolve) => {
      // An answered ask whose action has not finished (it may be queued behind another) says so, not waiting_for_user.
      const timer = this.clock.setTimeout(() => resolve({ text: job?.answered ? running(id) : waiting(id) }), ms);
      void result.then((r) => { this.clock.clearTimeout(timer); resolve(r); }, (e: unknown) => { this.clock.clearTimeout(timer); resolve(fail(message(e))); });
    });
  }

  /** Re-reads the page every 500 ms until `text` is in its body (not the wrapper's attributes) or `sec` pass. */
  private async waitText(p: Place, text: string, sec: number): Promise<Reply> {
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

  private status(agent: AgentRef, p: Place): string {
    const h = this.o.wheel.holder(p.key);
    const driving = !h ? "nobody (the first session to act takes the wheel)"
      : h.kind === "user" ? "the user (wait for Hand back)"
      : h.session === agent.key ? `this session (${h.label})` : `${h.label} (look tools still work; acting is busy)`;
    const access = agent.access === "read" ? "read only: this session can look but not act (D17)"
      : "this session can act; the user is asked first on sites they haven't marked and for irreversible actions";
    const onScreen = this.onScreen(p.key);
    const tabs = p.browser?.tabs() ?? [];
    // I1: this session's own asks by id and notice; another session's only as a count and their kinds.
    const asks = this.o.broker.pending(p.key);
    const own = asks.filter((x) => x.session === agent.key);
    const others = asks.filter((x) => x.session !== agent.key);
    return [
      `Computer: ${p.key}`,
      `Driving: ${driving}`,
      `Access: ${access}`,
      `Pane: ${onScreen ? "on screen" : "off screen"}`,
      tabs.length ? "Tabs:" : "Tabs: none (call computer_open)",
      ...tabs.map((t) => `  [${t.index}]${t.active ? " (active)" : ""} ${untrustedUrl(t.url)} opened by ${t.openedBy ?? "the user"}`),
      own.length ? "Your pending asks:" : "Your pending asks: none",
      ...own.map((x) => `  ${x.id} ${x.notice}`),
      ...(others.length ? [`Other sessions' pending asks: ${others.length} (${[...new Set(others.map((x) => ASK_LABELS[x.why]))].join(", ")})`] : []),
    ].join("\n");
  }

  // ---- the pane's operations

  /** The pane shows `place`'s computer (agent-computer D32); the one it showed before is parked. Popped out, the newly
   *  selected computer goes into the pop-out window. */
  select(place: string | null): ComputerState | null {
    if (place !== this.selected) {
      if (this.selected) this.places.get(this.selected)?.browser?.show(null);
      this.selected = place;
      if (place) {
        if (this.popped) this.popOut();
        else this.places.get(place)?.browser?.show(this.bounds);
      }
    }
    return place ? this.state(this.placeOf(place)) : null;
  }

  /** The pane's rectangle for the view, or null (collapsed, another tab, a modal on top). Popped out, the app's pop-out
   *  window places the view; the rectangle is kept for when the pane pops back in. */
  show(bounds: Rect | null): void {
    this.bounds = bounds;
    if (this.selected && !this.popped) this.places.get(this.selected)?.browser?.show(bounds);
  }

  /** True while the pane shows `place`'s computer: selected and given a rectangle, or popped out (agent-computer D27: an
   *  ask on a computer not on screen raises a notice). Whether the window holding it is visible is the app's to add. */
  onScreen(place: string): boolean {
    return this.selected === place && (this.bounds !== null || this.popped);
  }

  /** The address bar: the person opens a page (no ask; the agent's approved actions revalidate against the new page). */
  async navigate(url: string): Promise<Result<null>> {
    if (!this.selected) return { ok: false, error: "No computer is selected.", code: "ENOENT" };
    if (!navAllowed(url)) return { ok: false, error: "Only http and https pages open.", code: "EROFS" };
    const p = this.placeOf(this.selected);
    const b = this.browserOf(p);
    try {
      await b.open(url, { by: null });
      this.line(p, USER, `Opened ${this.url(b) ?? "the page"}`, null);
      return { ok: true, data: null };
    } catch (e) {
      return { ok: false, error: message(e), code: "EIO" };
    }
  }

  tab(op: { kind: "new" } | { kind: "close" | "select"; index: number }): void {
    if (!this.selected) return;
    const p = this.placeOf(this.selected);
    const b = this.browserOf(p);
    try {
      // A tab the person opens starts on the start page, the person's own load (nothing asks). An agent's new tab loads
      // its own URL instead, with no start page first (computer_open's newTab).
      if (op.kind === "new") void b.open(this.o.startPage ?? START_PAGE, { newTab: true, by: null }).catch((e: unknown) => this.line(p, USER, `The new tab did not open: ${message(e)}`, null));
      else if (op.kind === "close") b.close(op.index);
      else b.select(op.index);
    } catch { /* a stale index: the next state shows the tabs as they are */ }
    this.refresh(p.key);
  }

  /** The person's Back, Forward or Reload on the selected computer's active tab: their own, so nothing asks
   *  (session-browser S13). */
  nav(go: ComputerNavGo): void {
    if (!this.selected) return;
    const p = this.placeOf(this.selected);
    this.browserOf(p).nav(go);
    this.line(p, USER, go === "back" ? "Went back" : go === "forward" ? "Went forward" : "Reloaded", null);
  }

  /** Take over (agent-computer D5, D31): the person drives, the place's pending asks are cancelled, and any typing stops
   *  at its next chunk. */
  takeOver(): void {
    const place = this.selected;
    if (!place) return;
    const h = this.o.wheel.holder(place);
    this.o.wheel.takeOver(place);
    this.o.broker.cancel((a) => a.computer === place, "the user took over");
    const agent = h?.kind === "agent" ? this.agents.get(h.session) ?? null : null;
    this.line(this.placeOf(place), USER, "Took over", agent);
  }

  handBack(): void {
    const place = this.selected;
    if (!place) return;
    this.o.wheel.handBack(place);
    const h = this.o.wheel.holder(place);
    const agent = h?.kind === "agent" ? this.agents.get(h.session) ?? null : null;
    this.line(this.placeOf(place), USER, "Handed back", agent);
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
      if (this.selected) this.line(this.placeOf(this.selected), USER, `Could not save the mark for ${hostOf(origin)}.`, null);
    }
    this.refresh();
  }

  popOut(): void {
    if (!this.selected || !this.o.popOut) return;
    this.browserOf(this.placeOf(this.selected));
    this.popped = true;
    this.o.popOut(this.selected);
    this.refresh(this.selected);
  }

  /** The pop-out window closed (the app has moved the views back to the main window): the selected computer goes back
   *  to the pane's latest rectangle. */
  popIn(): void {
    this.popped = false;
    if (this.selected) this.places.get(this.selected)?.browser?.show(this.bounds);
    this.refresh();
  }

  /** The session's turn ended or its CLI exited (agent-computer D31, controller 7). A late call for a process the
   *  session has since replaced (the registry holds the same key under another pid: a late bridge close from the last
   *  turn's CLI) is ignored, so it never frees the next turn's wheel or cancels its asks. */
  agentGone(agent: AgentRef): void {
    const live = this.o.liveAgent?.(agent.key);
    if (live && live.pid !== agent.pid) return;
    this.o.wheel.turnEnded(agent.key);
    this.o.broker.cancel((a) => a.session === agent.key, "the turn ended");
    this.agents.delete(agent.key);
    for (const p of this.places.values()) if (p.last?.key === agent.key) p.last = null;
    this.refresh();
  }

  /** The app destroyed every browser (it is quitting): a later call makes a new one, should the app go on after all (an
   *  update's quit that failed). */
  forgetBrowsers(): void {
    for (const p of this.places.values()) p.browser = null;
  }

  /** For the wheel: a computer is reserved while an action runs or its holder has an ask pending (D31). A page's ask
   *  attributed to no one never holds the wheel for an agent that did not act. */
  reserved(place: string): boolean {
    if ((this.places.get(place)?.running ?? 0) > 0) return true;
    const h = this.o.wheel.holder(place);
    return h?.kind === "agent" && this.o.broker.pending(place).some((a) => a.session === h.session);
  }

  /** Emits the state of `place`, or of every computer (the broker's and the wheel's onChange). */
  refresh(place?: string): void {
    for (const k of place === undefined ? [...this.places.keys()] : [place]) {
      try { this.o.emit(this.state(this.placeOf(k))); } catch { /* a pane that cannot take the state misses one update */ }
    }
  }

  // ---- helpers

  private state(p: Place): ComputerState {
    const tabs = p.browser?.tabs() ?? [];
    const active = tabs.find((t) => t.active);
    return { place: p.key, tabs, holder: this.o.wheel.holder(p.key), asks: this.o.broker.pending(p.key), log: [...p.log], marked: active ? this.o.sites.isMarked(active.url) : false, poppedOut: this.popped };
  }

  private placeOf(key: string): Place {
    let p = this.places.get(key);
    if (!p) { p = { key, browser: null, log: [], last: null, running: 0, queue: Promise.resolve() }; this.places.set(key, p); }
    return p;
  }

  private browserOf(p: Place): BrowserLike {
    if (!p.browser) {
      const key = p.key;
      p.browser = this.o.browser(key, {
        ask: (i) => this.pageAsk(key, i),
        note: (text) => { void this.pageNote(key, text); },
        changed: () => this.refresh(key),
      });
      if (key === this.selected && !this.popped) p.browser.show(this.bounds);
    }
    return p.browser;
  }

  private serial<T>(p: Place, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => { p.running++; try { return await fn(); } finally { p.running--; } };
    const r = p.queue.then(run, run);
    p.queue = r.catch(() => undefined);
    return r;
  }

  /** "busy: …" for a session that cannot act on `place` now (agent-computer D31, controller 8). */
  private busy(place: string, sentence: string): string {
    return this.o.wheel.holder(place)?.kind === "user" ? `busy: ${sentence}: wait for Hand back.` : `busy: ${sentence}`;
  }

  /** Null while `agent` holds the wheel; otherwise the busy reply. Checked again just before input is delivered, since an
   *  action can wait behind another while the user takes over or the turn ends. */
  private notDriving(p: Place, agent: AgentRef): Reply | null {
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
  private current(p: Place, agent: AgentRef, lease: Lease): boolean {
    return this.holds(p.key, agent.key) && this.registered(agent) && this.o.wheel.gen(p.key) === lease.gen;
  }

  /** R81: null while the call is current; otherwise the reply that ends it: busy while someone else drives or this process
   *  was replaced, and the changed reply when this session holds the wheel again after a Take over and Hand back. */
  private stale(p: Place, agent: AgentRef, lease: Lease): Reply | null {
    const busy = this.notDriving(p, agent);
    if (busy) return busy;
    if (!this.registered(agent)) return fail(this.busy(p.key, NOT_HELD));
    if (this.o.wheel.gen(p.key) !== lease.gen) return fail(`${CHANGED} ${pageLine(p.browser ? this.url(p.browser) : null)}`);
    return null;
  }

  private active(b: BrowserLike): number { return b.tabs().find((t) => t.active)?.index ?? -1; }
  /** The active tab's URL, already scrubbed by the browser (D9). */
  private url(b: BrowserLike): string | null { return b.tabs().find((t) => t.active)?.url ?? null; }
  /** The origin of a tab: a scrubbed URL keeps its origin whole, so it is the site to judge and remember. */
  private siteAt(b: BrowserLike, tab: number): string | null { return siteOf(b.tabs()[tab]?.url ?? ""); }
  private markedAt(b: BrowserLike, tab: number): boolean { const u = b.tabs()[tab]?.url; return u ? this.o.sites.isMarked(u) : false; }

  /** A line in the place's activity log, and (with `agent`) the same line for that agent's Chat thread (D35, D6, D21),
   *  naming you when you acted (a page's own line already says what the page did). */
  private line(p: Place, session: string, text: string, agent: AgentRef | null): void {
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
