// The Computer pane's browser (agent-computer D8, D9, D20, D21, D27, D39, §4.2). Each tab is a WebContentsView in the
// shared `persist:computer` partition, driven through its own `webContents.debugger` (the DevTools protocol in process:
// no port, never the HUD, D20). Navigation is limited to http, https and about:blank on every path (§4.2); permissions,
// downloads and file choosers ask the person through `hooks.ask` (D39); navigations a page starts are noted (D21).
// Password fields are tracked for the document's life and never reach the agent: snapshots redact them, screenshots
// paint over them, and `scrub` removes their values from any text that leaves the main process, while the gate judges
// the raw names (D9). Off-screen, the active view sits in an invisible park window so it keeps painting (D27).

import { app, BrowserWindow, dialog, nativeImage, session, WebContentsView } from "electron";
import type { BaseWindow, DownloadItem, Session, WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AskInput } from "./asks";
import { ASK_ROLES, covers, type Target } from "./categories";
import { cdp, CdpTimeout, FocusMoved, isGone, keyEvents, PageChanged, unlessGone } from "./cdp";
import { downloadName, HeldDownloads, moveInto } from "./downloads";
import { permissionVerdict, type Focus } from "./gate";
import { deviceRects, paintRects, screenScale, type Rect } from "./mask";
import { framesHolding, leavingFrames, LeavingRecords, mergeFrameReads, PendingReads, type Departure } from "./leaving";
import { SecretMemory, type Secrets } from "./memory";
import { accepted, hostsAbove, reach, within, type Reach, type Start } from "./reach";
import { domText, formatSnapshot, hideAfterOrigin, indexDom, inUrl, mergeFrames, scrubber, secretsOf, SNAPSHOT_CAP, urlScrubber, type CdpAxNode, type CdpDomNode, type DomIndex, type Snapshot } from "./snapshot";
import { navAllowed, siteOf } from "../policy/computer-url";
import type { ComputerNavGo } from "../../shared/ipc";

/** `canBack` and `canForward` read the tab's own navigation history (session-browser S13). */
export interface TabInfo { index: number; url: string; title: string; openedBy: string | null; active: boolean; canBack: boolean; canForward: boolean }
/** `pageToken` and `tab` say where it was resolved: `click` and `scroll` refuse once either has changed. `judged` holds
 *  every control the gate judged (R26: `backendNodeId` and, when the walks disagreed, the others; none when the element
 *  is plain): the click is delivered only while a click at `point` reaches no other control. `target.name` is raw, for
 *  the gate alone; `shown` is that name scrubbed of every sensitive field's value as read in this same call (D9), the
 *  only name to put in text that leaves the main process. Any other text built from this page goes through
 *  `scrub(text, r.tab)`: the tab, not the current one, since a popup may have made another tab current. The scrub
 *  remembers what the tab read on the current site (R32), so text about a page the tab has since left is covered too. */
export interface Resolved { target: Target; shown: string; sensitive: boolean; backendNodeId: number; judged: number[]; point: { x: number; y: number }; pageToken: string; tab: number }
export interface BrowserHooks { ask(i: Pick<AskInput, "why" | "title" | "detail" | "site">): Promise<boolean>; note(text: string): void; changed(): void }
/** Where the gate judged an action (I3b): the tab, and the page token it had. `key` and `type` deliver only while both
 *  are still the ones in front. */
export interface Judged { tab: number; pageToken: string }
/** The focused element a key or typing was judged on (R76, `Focus.node` and `Focus.frame`): delivered only while it is
 *  still the one with focus. */
export type FocusId = Pick<Focus, "node" | "frame">;

const PARTITION = "persist:computer";
const SENSITIVE = 'input[type="password" i], [autocomplete~="current-password" i], [autocomplete~="new-password" i], [autocomplete~="one-time-code" i]';
const KEY_LISTENERS = new Set(["keydown", "keypress", "keyup", "beforeinput"]);
const ENABLE: [string, object?][] = [
  ["Page.enable"], ["DOM.enable"], ["Accessibility.enable"], ["Page.setInterceptFileChooserDialog", { enabled: true }],
  // An off-screen page is never the focused window: emulate focus so :focus matches and typing lands (D27).
  ["Emulation.setFocusEmulationEnabled", { enabled: true }],
];
const CHUNK = 200;
const LOAD_WAIT_MS = 15_000;
const QUERY_MS = 100;
const MAX_TABS = 20;
const KEPT_DOCUMENTS = 8;
const DEFAULT_SIZE = { width: 1280, height: 800 };
// R26: after the pointer moves onto a point, how long hover styles and mouseenter handlers get before the hit test.
const HOVER_MS = 100;
const CANT_TELL = "Cannot tell which control this click reaches: take a new snapshot.";
const URL_NOTE_MAX = 2_000;
const D9_REFUSAL = "Typing into a password field is refused (D9).";
const D9_UNREAD = "Could not read a password field's value to scrub it, so the text was held back (D9): try again.";
// A field's current value through the native getter (an isolated world sees no page-defined one; "" for anything else)
// and whether it is a one-time-code field (a short code typed so far is scrubbed as a whole word).
const VALUE_OF = "function () { return { v: typeof this.value === 'string' ? this.value : '', otp: /(^|\\s)one-time-code(\\s|$)/i.test((this.getAttribute && this.getAttribute('autocomplete')) || '') }; }";
const WORLD = "agent-computer";
// G2: every sensitive field's value in a document about to be left, in one command (the document may be gone a few
// milliseconds later), run in an isolated world (native getters and querySelectorAll only): the selector matched in the
// document and every open shadow root, each value with whether its field is a one-time-code field.
const LEAVING_VALUES = `(() => { const out = []; const sel = ${JSON.stringify(SENSITIVE)};
  const walk = (root) => {
    for (const e of root.querySelectorAll(sel)) out.push({ v: typeof e.value === 'string' ? e.value : '', otp: /(^|\\s)one-time-code(\\s|$)/i.test(e.getAttribute('autocomplete') || '') });
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
  };
  walk(document); return out; })()`;
// D9: text the gate builds itself names the category; a page-chosen URL loses its query and fragment when the values
// it may carry could not be read (G2 below) or a read flooded a kind's reserve (R37).
const ABORTED = -3;
const stripQuery = (url: string): string => { try { const u = new URL(url); u.search = ""; u.hash = ""; return u.href; } catch { return url; } };
const DIALOGS = new Set(["alert", "confirm", "prompt", "beforeunload"]);
// The focused element behind open shadow roots and readable frames, run in an isolated world (native getters only).
const ACTIVE_ELEMENT = `(() => { let e = document.activeElement;
  for (let i = 0; e && i < 64; i++) {
    if (e.shadowRoot && e.shadowRoot.activeElement) { e = e.shadowRoot.activeElement; continue; }
    let d = null; try { d = e.contentDocument; } catch (_) {}
    if (d && d.activeElement) { e = d.activeElement; continue; }
    break;
  }
  return e; })()`;

type Size = { width: number; height: number };
type Point = { x: number; y: number };

interface Tab {
  uid: number; view: WebContentsView; wc: WebContents; openedBy: string | null;
  /** Main-frame commits and in-page navigations, for `pageToken()` (a ref or a Resolved is stale after either). */
  seq: number;
  /** I3b: main-frame navigations requested or started (renderer-requested ones arrive on the DevTools session in order with
   *  the command that caused them), so typing stops at the chunk whose input event sent the page elsewhere, before the
   *  new document commits. */
  navs: number;
  /** Cross-document main-frame commits only, error pages included (R37): the race check of a read and of the carry at
   *  commit, which an in-page navigation must not trip. */
  doc: number;
  /** The window its view is in. */
  in: BaseWindow | null;
  /** D9: backend ids of fields that were ever sensitive in the current document; `documents` keeps them per loader. */
  sensitive: Set<number>; documents: Map<string, Set<number>>;
  query: ReturnType<typeof setTimeout> | null;
  /** Serialises DOM.getDocument and the node ids it hands out (each call invalidates the last call's ids). */
  lock: Promise<unknown>;
  attaching: Promise<void> | null;
  /** I2: each session's refs from its own last snapshot of this tab, with the page token they were printed under, so
   *  another session's snapshot (which numbers the document afresh) never re-points them. */
  refs: Map<string, { refs: Snapshot["refs"]; token: string }>;
  /** The scheme of a main-frame redirect refused during `open()`. */
  refused: string | null;
  /** Set while the tab is being closed, so its own debugger detach is not noted. */
  closing: boolean;
  /** The isolated world made in each frame (by frame id) for reading field values and the focused element, as the command
   *  that makes it (so a world still being made is never asked for twice); dropped when the frame navigates or goes.
   *  agent-computer D9 (R41): made ahead for every frame, when it attaches and at each of its commits, so a leaving read
   *  only evaluates: DevTools held a world made mid-navigation until the commit, and the read then failed. */
  worlds: Map<string, Promise<number>>;
  /** D9 (R32): every secret value read in this tab, scoped to the site it was read on, kept across the tab's navigations,
   *  so text about a page the tab has since left is still scrubbed (./memory). */
  memory: SecretMemory;
  /** The main frame's id (from `Page.frameNavigated`) and the frames of the last DOM read still attached: where a leaving
   *  read runs (G2), with every frame that has a world. */
  frame: string; frames: string[];
  /** agent-computer D9 (R41): the frame each field of the current document's sensitive set was in when a DOM read last saw
   *  it, so a leaving read knows which frames must answer (./leaving `framesHolding`); R47: null once that frame detached
   *  and a later DOM read found it gone. */
  fieldFrames: Map<number, string | null>;
  /** agent-computer D9 (R47): frames detached since the last completed DOM read. Until that read prunes them, a field placed
   *  in one still makes the leaving read fail (the page may have taken its code and removed the frame). */
  detached: Set<string>;
  /** agent-computer D9 (R47): whether a DOM read has completed since the last main-frame commit (until then a restored
   *  document's fields are placed nowhere), and that commit's count, so a read that spans a commit places nothing. */
  placed: boolean; mainDocs: number;
  /** The main-frame navigations under way (./leaving), each keyed by its URL: a page-started one with its leaving record
   *  (the site being left and the read of its document's values, G2), consumed at the commit of that navigation (R35: what
   *  the committed URL carries from the old site goes to the carried set); one from main (the agent's `open()`) with none.
   *  agent-computer D9 (R39): one entry per navigation, so a second navigation started before the first commits never
   *  overwrites the first's record; a commit no entry matches fails closed while a page record could be its. R40: a record
   *  the bound drops folds into one merged lost record, carried from at every commit until loading stops. */
  leaving: LeavingRecords;
  /** agent-computer D9 (R40): the tab's leaving reads still waiting for an answer, ended with null by every commit. */
  reads: PendingReads;
  /** R38: set on a popup tab before its first load: the opener's site and the read of the opener's fields, which become the
   *  leaving record of that first navigation when it starts (the popup's URL may carry a code typed into the opener). */
  opened: Departure | null;
  /** D9 (F1): the current document arrived through a navigation whose leaving read is pending or failed, so its URL may
   *  carry a code no one read: the URL goes out without its query and fragment while this document is current. */
  urlHidden: boolean;
  /** agent-computer D9 (R40): the current document's commit is carrying from records whose reads have not all answered, so
   *  a value its URL holds may not scrub yet: the URL goes out with everything after its origin hidden until they answer. */
  pathHidden: boolean;
  /** D9 (R37): a read on the current document returned more values of one kind than the memory's reserve, so one of them
   *  may already be forgotten: the URL goes out without its query and fragment for this document's life too. */
  flooded: boolean;
}

/** A sensitive field's current value and whether the field is a one-time-code field. */
interface FieldValue { b: number; value: string; otp: boolean }

interface Handlers { permission(permission: string, url: string): Promise<boolean>; download(item: DownloadItem, wc: WebContents): void }

let nextUid = 1;
const owners = new Map<number, Handlers>();
let shared: Session | null = null;

/** The partition, configured once for every computer (D39: nothing is granted without the person). */
function computerSession(): Session {
  if (shared) return shared;
  const s = session.fromPartition(PARTITION);
  s.setPermissionCheckHandler(() => false);
  s.setPermissionRequestHandler((wc, permission, cb, details) => {
    const owner = owners.get(wc.id);
    // §4.2: an external app scheme is never opened, so it is never asked about.
    if (!owner || permission === "openExternal") { cb(false); return; }
    owner.permission(permission, details.requestingUrl || wc.getURL()).then(cb, () => cb(false));
  });
  s.on("will-download", (_e, item, wc) => {
    const owner = wc ? owners.get(wc.id) : undefined;
    if (owner && wc) owner.download(item, wc);
    else item.cancel();
  });
  shared = s;
  return s;
}

// The park window (agent-computer D27): an invisible, click-through window on screen that holds each computer's active
// view while the pane is off-screen. A screenshot hangs when a view is far off-screen, hidden, or in a hidden window,
// and works in a window at opacity 0. One per app, made on first use and destroyed when no view needs it.
const park = { win: null as BrowserWindow | null, sizes: new Map<ComputerBrowser, Size>() };

function parkWindow(owner: ComputerBrowser, size: Size): BrowserWindow {
  park.sizes.set(owner, size);
  const width = Math.max(...[...park.sizes.values()].map((s) => s.width));
  const height = Math.max(...[...park.sizes.values()].map((s) => s.height));
  if (park.win && !park.win.isDestroyed()) {
    const [w, h] = park.win.getContentSize();
    if (w !== width || h !== height) park.win.setContentSize(width, height);
    return park.win;
  }
  const win = new BrowserWindow({
    width, height, useContentSize: true, show: false, frame: false, opacity: 0, focusable: false, hasShadow: false, skipTaskbar: true,
    resizable: false, title: "",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setIgnoreMouseEvents(true);
  win.excludedFromShownWindowsMenu = true;
  win.on("closed", () => { if (park.win === win) park.win = null; });
  win.showInactive();
  park.win = win;
  return win;
}

function leavePark(owner: ComputerBrowser): void {
  if (!park.sizes.delete(owner) || park.sizes.size) return;
  const win = park.win;
  park.win = null;
  if (win && !win.isDestroyed()) win.destroy();
}

const clipUrl = (url: string): string => (url.length > URL_NOTE_MAX ? `${url.slice(0, URL_NOTE_MAX - 1)}…` : url);
const schemeOf = (url: string): string => { try { return new URL(url).protocol; } catch { return "unreadable"; } };
const hostOf = (site: string | null, url: string): string => { try { return new URL(site ?? url).host || url; } catch { return url; } };
const quadRect = (q: number[]): Rect => {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The free navigation keys (gate.ts NAV_KEYS, by their DevTools key names): their own keydown moves focus, so their up
 *  goes without the focus read (R80). */
const FREE_NAV_UPS: ReadonlySet<string> = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Escape"]);
/** The modifier keys: their up activates nothing, so a chord stopped on the document its modifiers went down to still lets
 *  them go (R79), but never on another document or once the call is no longer current (R81). */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta"]);
/** Whether two focus reads name the same element (R76): its node and its frame. */
const sameId = (a: FocusId, b: FocusId): boolean => a.node === b.node && a.frame === b.frame;
/** R82: the backend node of a DOM read's main document; a new document has another. */
const rootOf = (dom: DomIndex | null): number | null => {
  const r = dom?.roots.find((x) => x.depth === 0);
  return r ? dom!.backendOf.get(r.nodeId) ?? null : null;
};
const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
/** R87: the viewport point a hit test judged, its document point less the scroll it used (`hitAt`). Input.dispatchMouseEvent
 *  takes fractional x and y, so a press there reaches exactly the document point judged, on a scroll that is not whole too. */
const judgedAt = (h: { at: Point; off: Point }): Point => ({ x: h.at.x - h.off.x, y: h.at.y - h.off.y });

export class ComputerBrowser {
  private list: Tab[] = [];
  /** The private folders this browser's downloads wait in until they are answered (agent-computer D39). */
  private readonly held = new HeldDownloads(() => app.getPath("temp"));
  private current = -1;
  private bounds: Rect | null = null;
  private size: Size = { ...DEFAULT_SIZE };
  private popped: BrowserWindow | null = null;
  private watched = new Map<BrowserWindow, () => void>();
  private gone = false;
  private readonly handlers: Handlers = {
    permission: (p, url) => this.askPermission(p, url),
    download: (item, wc) => this.download(item, wc),
  };

  constructor(private o: { key: string; window: () => BrowserWindow | null; hooks: BrowserHooks }) {
    computerSession();
  }

  /** Each tab's URL and title scrubbed of the secrets the tab has read (D9: a code submitted by GET sits in the URL). */
  tabs(): TabInfo[] {
    return this.list.map((t, index) => ({ index, url: this.urlOut(t), title: this.remembered(t, [this.site(t)])(t.wc.getTitle()), openedBy: t.openedBy, active: index === this.current, canBack: t.wc.navigationHistory.canGoBack(), canForward: t.wc.navigationHistory.canGoForward() }));
  }

  /** Changes on every main-frame navigation commit of the active tab (error pages and in-page navigations included), and
   *  when the active tab changes. */
  pageToken(): string {
    const t = this.list[this.current];
    return t ? `${t.uid}.${t.seq}` : "none";
  }

  async open(url: string, o: { newTab?: boolean; by: string | null }): Promise<{ url: string; title: string }> {
    if (!navAllowed(url)) throw new Error("Only http and https pages open.");
    // §4.2: load the normalised form navAllowed judged, never the raw string.
    const href = new URL(url).href;
    const t = !o.newTab && this.list[this.current] ? this.list[this.current] : await this.addTab(o.by);
    t.refused = null;
    // R38: a page-started navigation's leaving record is left alone here: that navigation may be past the point where this
    // load can cancel it and commit first, and its record then goes with its own commit (`committed` matches the URL). R39:
    // this load gets its own entry when it starts (no record) and its commit normally consumes that entry; but a page
    // record keyed at the same URL goes first (carrying is the safe side), so the agent's commit can consume it and carry
    // what this URL holds from that page's read. R40: the agent's commit also carries what its URL holds from page
    // records still pending; it is never held back for them once their reads have answered (R37 N4).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failed = await Promise.race([
      t.wc.loadURL(href).then(() => null, (e: unknown) => e as { code?: string; message?: string }),
      // A page still loading after this returns as it is; the agent can wait on it.
      new Promise<null>((r) => { timer = setTimeout(() => r(null), LOAD_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    if (t.refused || failed?.code === "ERR_UNSAFE_REDIRECT") throw new Error(`The page redirected to ${t.refused ? `a ${t.refused}` : "a non-web"} URL, which is refused.`);
    // ERR_ABORTED: the page went somewhere else before it finished loading.
    if (failed && failed.code !== "ERR_ABORTED") throw new Error(`Could not open ${href}: ${failed.code ?? failed.message ?? "failed"}.`);
    return { url: this.urlOut(t), title: this.remembered(t, [this.site(t)])(t.wc.getTitle()) };
  }

  /** Makes tab `index` the active one. */
  select(index: number): void {
    this.tab(index);
    this.current = index;
    this.place();
    this.o.hooks.changed();
  }

  /** The person's Back, Forward or Reload on a tab (the active one by default). A move that cannot happen, or no tab, does
   *  nothing and returns false; true means the move or the reload was started (session-browser S13). The page's own
   *  commit hooks report the result. */
  nav(go: ComputerNavGo, tab?: number): boolean {
    const t = this.list[tab ?? this.current];
    if (!t || t.wc.isDestroyed()) return false;
    const h = t.wc.navigationHistory;
    if (go === "back") { if (!h.canGoBack()) return false; h.goBack(); }
    else if (go === "forward") { if (!h.canGoForward()) return false; h.goForward(); }
    else t.wc.reload();
    return true;
  }

  /** Closes tab `index`; the next tab (or the last one) becomes active. */
  close(index: number): void {
    this.drop(this.tab(index));
    if (index < this.current) this.current--;
    this.current = Math.min(this.current, this.list.length - 1);
    this.place();
    this.o.hooks.changed();
  }

  /** The tab as text for the model. With `session`, its refs become that session's to use (I2: one table per session
   *  per tab); without one (a text wait) no table changes. */
  async snapshot(tab?: number, session?: string): Promise<Snapshot> {
    const t = this.tab(tab);
    // The site and document the reads belong to are fixed before them: a navigation during the reads (a value of the
    // old site read after the page moved on) is remembered for neither.
    const site = this.site(t), doc = t.doc;
    const dom = await this.locked(t, () => this.readDom(t));
    const before = await this.fieldValues(t, dom);
    const frames: { id: string }[] = [];
    const walk = (n: { frame: { id: string }; childFrames?: unknown[] }): void => { frames.push(n.frame); for (const c of n.childFrames ?? []) walk(c as typeof n); };
    walk((await this.send<{ frameTree: { frame: { id: string } } }>(t, "Page.getFrameTree")).frameTree);
    const trees: { frameId: string; nodes: CdpAxNode[] }[] = [];
    for (const [i, f] of frames.entries()) {
      try {
        trees.push({ frameId: f.id, nodes: (await this.send<{ nodes: CdpAxNode[] }>(t, "Accessibility.getFullAXTree", { frameId: f.id })).nodes });
      } catch (e) {
        if (i === 0) throw e; // a child frame that went away meanwhile is left out
      }
    }
    // D9: the fields' DOM values go into the scrub too (a type=number field's AX value is the parsed float, not its string),
    // read before and after the accessibility trees so a value that changed meanwhile is scrubbed in both forms.
    const fields = [...before, ...(await this.fieldValues(t, dom))];
    const otp = new Set(fields.filter((f) => f.otp).map((f) => f.b));
    const read: Secrets = { values: fields.filter((f) => !f.otp).map((f) => f.value), whole: fields.filter((f) => f.otp).map((f) => f.value) };
    for (const { nodes } of trees) { read.values.push(...secretsOf(nodes, new Set([...t.sensitive].filter((b) => !otp.has(b))))); read.whole.push(...secretsOf(nodes, otp)); }
    if (t.doc === doc) this.remember(t, site, read, site, doc);
    // R32: the values just read and the site's remembered secrets scrub the text; what other sites carried into the URL
    // scrubs the URL only (R35, by kind R37); a URL whose leaving read failed or whose document was flooded loses its
    // query and fragment (F1, R37), and one whose commit is still carrying loses everything after its origin (R40).
    const pool = t.memory.pool([site]), carried = t.memory.carried();
    const url = this.shownUrl(t);
    const snap = formatSnapshot(mergeFrames(trees, dom), {
      origin: siteOf(url) ?? "null", url, title: t.wc.getTitle(), sensitive: t.sensitive, cap: SNAPSHOT_CAP,
      values: [...read.values, ...pool.values], whole: [...read.whole, ...pool.whole], otp, urlValues: carried.values, urlWhole: carried.whole,
    });
    if (session) {
      const token = this.tokenOf(t);
      for (const [k, v] of [...t.refs]) if (v.token !== token) t.refs.delete(k);
      t.refs.set(session, { refs: snap.refs, token });
    }
    return snap;
  }

  /** The viewport as a PNG, with every sensitive field painted over (D9). */
  async screenshot(tab?: number): Promise<Buffer> {
    const t = this.tab(tab);
    this.place();
    try {
      return await this.capture(t);
    } catch (e) {
      if (!(e instanceof CdpTimeout)) throw e;
      // D27: a view that stopped painting (its window hidden under it) is moved to the park window, or the park window is
      // shown again with the view re-added, and the capture is tried once more.
      this.parkTab(t, true);
      return await this.capture(t);
    }
  }

  /**
   * The element a click will hit, for the gate to judge (R26: never the container a ref named). The point is a ref's
   * centre (scrolled into view first) or the given x, y. The pointer moves there first, so the element judged is the
   * one in the hovered state the press will meet (a row that shows Delete on hover). The target is the control a click
   * there reaches by either walk (`judgeReach`); `click()` delivers at exactly that point. `target.name` is raw (D9: the
   * gate judges what the page shows); `shown` is the name for outgoing text, scrubbed with the values read in this call.
   * A ref is looked up in `session`'s own table (I2), so it names the node printed for that session or nothing.
   */
  async resolve(by: { ref: string } | { x: number; y: number }, session?: string): Promise<Resolved> {
    const t = this.tab();
    const where = { pageToken: this.tokenOf(t), tab: this.current };
    let named: number | null = null;
    let p: Point;
    if ("ref" in by) {
      const mine = session ? t.refs.get(session) : undefined;
      const ref = mine?.refs.get(by.ref);
      if (!mine || !ref || mine.token !== this.tokenOf(t)) throw new Error(`There is no ${by.ref} on this page now: take a new snapshot.`);
      named = ref.backendNodeId;
      await this.send(t, "DOM.scrollIntoViewIfNeeded", { backendNodeId: named }).catch(() => undefined);
      p = centre(await this.box(t, named));
    } else {
      p = { x: by.x, y: by.y };
    }
    p = { x: Math.round(p.x), y: Math.round(p.y) };
    // D9: the fields' values are read before the pointer arrives as well as after the walk, and `shown` is scrubbed with
    // both (a page that clears a code on mouseenter would otherwise leave it in the name read after the hover).
    const pre = await this.secrets(t);
    await this.hover(t, p);
    const { hit, at, off, dom, reached, own } = await this.reachAt(t, p, (h, d) => {
      if (named !== null && h !== named && !within(d, h, named) && !within(d, named, h)) throw new Error("Something else covers that element now: take a new snapshot.");
    });
    const target = await this.judgeReach(t, reached, dom, own);
    const b = reached.controls[0] ?? hit;
    // D9: the name for outgoing text is scrubbed with the values read now, in this call, before the page can change.
    const post = await this.secrets(t, { dom });
    const shown = this.scrubWith(t, { values: [...pre.values, ...post.values], whole: [...pre.whole, ...post.whole] })(target.name);
    // D9: `hit` is the node the hit test returned, so a sensitive host hit on its padding or its slotted text counts. R87:
    // the point is the one the hit test judged, so the click's hover, its own hit test and its press are made there.
    return { target, shown, sensitive: [hit, ...reached.controls].some((n) => t.sensitive.has(n)), backendNodeId: b, judged: reached.controls, point: judgedAt({ at, off }), ...where };
  }

  /** What has keyboard focus (D39), and whether it is a password field (D9). `target.name` is raw, for the gate; `shown`
   *  is the name for outgoing text, scrubbed with the values read in this call. */
  async focus(): Promise<Focus> {
    const t = this.tab();
    const f = await this.focused(t);
    // D9: focus inside a frame from another site counts as sensitive, so typing there is refused.
    if (f === "remote") {
      const r = await this.remoteFocus(t);
      const target = await this.remoteTarget(t, r);
      return { target, shown: this.scrubWith(t, await this.secrets(t))(target.name), sensitive: true, plainTextarea: false, node: r?.b ?? null, frame: r ? r.dom.frameOf.get(r.b) ?? null : null };
    }
    if (f.b === null) return { target: null, shown: "", sensitive: false, plainTextarea: false, node: null, frame: null };
    // I3a: named as a click's target is (accessible name, markup hint and DOM text), so a key judges what a click would.
    const target = await this.named(t, f.b, f.dom);
    const plainTextarea = f.dom.names.get(f.b) === "TEXTAREA" && !(await this.keyListened(t, f.b, f.dom));
    return { target, shown: this.scrubWith(t, await this.secrets(t, { dom: f.dom }))(target.name), sensitive: t.sensitive.has(f.b), plainTextarea, node: f.b, frame: f.dom.frameOf.get(f.b) ?? null };
  }

  /**
   * D9: `text` with every sensitive field's current value removed, for any text that leaves the main process: an ask
   * title, a notification, a note, a tool reply, anything built from the names `resolve()`, `focus()` and a snapshot's
   * refs return raw. Chrome composes some controls' names from an embedded field's value (a label holding a checkbox
   * and a one-time-code field names the checkbox with the code; so does aria-labelledby). Both what Chrome shows (the
   * accessibility value) and what the field holds (its DOM value, read on the node in an isolated world of its frame)
   * are scrubbed, whitespace collapsed (./snapshot `scrubber`), together with every value this tab has read before on
   * the site it is on (its memory, R32), so a code the page has since cleared or navigated away from still goes, while
   * a site that planted words as codes cannot blank another site's text. A value that cannot be read throws rather than
   * letting the text out. The gate never sees the result: a page could plant a value that matches a label (R26, Task
   * 11b). Pass the tab the text is about (`Resolved.tab`): a popup may have made another tab current.
   */
  async scrub(text: string, tab?: number): Promise<string> {
    const t = this.tab(tab);
    if (!text) return text;
    return this.scrubWith(t, await this.secrets(t))(text);
  }

  /** Clicks where `r` was resolved. R76: the move and the press go only while `valid()` (the agent's call is still current:
   *  it holds the wheel, R81) and `r`'s tab and page are still the ones in front, checked just before each, after the
   *  hover and the hit test too; otherwise PageChanged, and nothing more is sent. R81 (AC-R3-02, replacing R79's rule):
   *  once the press went, its release goes only to the document that got it (an in-page navigation, such as a mousedown
   *  handler's pushState, keeps the document; a cross-document commit does not) and only while `valid()` still holds;
   *  otherwise it is withheld (PageChanged), so a new document, or a click the person stopped, never gets a mouseup. R87:
   *  the press and its release go to exactly the point the click's own hit test judged, and the press only while the page
   *  is scrolled as it was for that test, read again just before it. */
  async click(r: Resolved, valid: () => boolean): Promise<void> {
    const t = this.where(r);
    if (typeof r.backendNodeId !== "number") throw new Error("The page changed: look again.");
    const p = r.point;
    const live = (): void => this.live(valid, r);
    // R26: hover the point again, hit-test, read the DOM and walk again, and deliver only while a click there reaches no
    // control the gate did not judge; the press follows the check with no move in between.
    await this.hover(t, p, live);
    const now = await this.reachAt(t, p).catch((e: unknown) => { if (e instanceof CdpTimeout) throw e; return null; });
    if (!now) throw new Error("The page changed: look again.");
    const ok = now.dom.remoteFrames.has(now.hit) ? now.hit === r.backendNodeId : accepted(now.dom, now.reached, { b: r.backendNodeId, controls: r.judged ?? [] });
    if (!ok) throw new Error("The page changed: look again.");
    // R87: a scroll since the hit test (a smooth scroll still running, the page's script, the person) moves what the
    // point shows, so it refuses. It is read before the checks below, so nothing is awaited between them and the press.
    const off = await this.scrolledBy(t);
    if (off.x !== now.off.x || off.y !== now.off.y) throw new Error("The page changed: look again.");
    const at = judgedAt(now);
    live();
    const doc = t.doc;
    await this.mouse(t, "mousePressed", at);
    if (!valid() || !this.list.includes(t) || t.doc !== doc) throw new PageChanged();
    await this.mouse(t, "mouseReleased", at);
  }

  /** Types into the focused element: Input.insertText in 200-character chunks, each newline as Enter. R76: each chunk and
   *  each key event goes only while `valid()` (the agent still holds the wheel), checked just before it, after the focus
   *  read too; once it is false nothing more is typed. With `at` (I3b), each goes only while the judged tab and page are
   *  in front and no main-frame navigation has been requested or started since typing began; otherwise it throws
   *  PageChanged and types nothing more. With `focus` (R76, R78), each chunk and each event of a newline's Enter goes
   *  only while that element still has focus; otherwise FocusMoved (R82: PageChanged when the read shows the page itself
   *  changed, `focusCheck`), and nothing more is typed. */
  async type(text: string, valid: () => boolean, at?: Judged, focus?: FocusId): Promise<void> {
    const t = at ? this.where(at) : this.tab();
    const navs = t.navs;
    const still = (): void => { if (at && (this.where(at) !== t || t.navs !== navs)) throw new PageChanged(); };
    // D9: the gate refuses typing into a password field; focus can move while typing, so each chunk checks again. R76,
    // R78: the judged element must still be the focused one before every chunk and every key event, for the whole call.
    const check = this.focusCheck(t, focus);
    const ready = async (typing: boolean): Promise<void> => {
      if (!typing && !focus) return;
      await check(typing);
    };
    // Thrown inside `keys` between an Enter's events; `type` then stops without an error, as at a chunk.
    const stop = new PageChanged();
    const lines = text.split(/\r\n|\r|\n/);
    try {
      for (const [i, line] of lines.entries()) {
        if (i > 0) {
          await this.keys(t, "Enter", async () => { still(); await ready(false); if (!valid()) throw stop; still(); });
        }
        const chars = Array.from(line);
        for (let k = 0; k < chars.length; k += CHUNK) {
          // A navigation is reported as one (I3b) before the focus read, which would see the next page's focus.
          still();
          await ready(true);
          if (!valid()) return;
          still();
          await this.send(t, "Input.insertText", { text: chars.slice(k, k + CHUNK).join("") });
        }
      }
    } catch (e) {
      if (e !== stop) throw e;
    }
  }

  /** Presses a key on the focused element. R76: each event goes only while `valid()` (the agent still holds the wheel)
   *  and, with `at` (I3b), the judged tab and page are still in front, checked just before it, after the focus read too;
   *  otherwise PageChanged, and nothing more is sent. With `focus` (R76, R78), each event goes only while that element
   *  still has focus, read again before every event of a chord; otherwise FocusMoved (R82: PageChanged when the read
   *  shows the page itself changed, `focusCheck`), and nothing more is sent. */
  async key(key: string, valid: () => boolean, at?: Judged, focus?: FocusId): Promise<void> {
    const t = at ? this.where(at) : this.tab();
    const events = keyEvents(key);
    // D9: a key that types (not Enter, which submits) into a password field is typing into it.
    const typing = events.some((e) => e.text !== undefined && e.text !== "\r");
    // R79, R81: a modifier's up activates nothing, so it goes, also when a check stopped the chord part way or a send
    // failed, but only to the document its keydown went to and only while `valid()` holds (AC-R3-02): after a
    // cross-document commit or a Take over it is withheld (PageChanged). The main key's up goes only with every check
    // passed. R78, R80: the focus is read again before every event but the up of a free navigation key (Tab, an arrow,
    // Home, End, Page Up, Page Down, Esc), whose own keydown moves focus by design; every other key's up (Space, Enter,
    // a letter) is held to the judged element, as type()'s Enter is.
    /** Each modifier down, with the document (`t.doc`) its keydown went to. */
    const down = new Map<string, number>();
    const mayLetGo = (k: string): boolean => down.get(k) === t.doc && valid();
    const check = this.focusCheck(t, focus);
    let i = 0, done = false;
    try {
      for (; i < events.length; i++) {
        const e = events[i];
        const letGo = e.type === "keyUp" && MODIFIER_KEYS.has(e.key);
        const ownMove = e.type === "keyUp" && FREE_NAV_UPS.has(e.key);
        if (!letGo) {
          if (at) this.where(at);
          if ((typing || focus) && !ownMove) await check(typing);
          this.live(valid, at);
        } else if (!mayLetGo(e.key)) {
          throw new PageChanged();
        }
        // The document the event goes to is the one in front as it is sent (a commit while it is on its way comes after).
        const doc = t.doc;
        await this.send(t, "Input.dispatchKeyEvent", e);
        if (MODIFIER_KEYS.has(e.key)) { if (e.type === "keyUp") down.delete(e.key); else down.set(e.key, doc); }
      }
      done = true;
    } finally {
      // R79, R80: however the chord stopped (a check, or a send that failed), the modifiers it pressed are let go, R81:
      // on the document they went down to, while the call is current.
      if (!done) {
        for (const up of events.slice(i)) {
          if (up.type === "keyUp" && down.has(up.key) && mayLetGo(up.key)) await this.send(t, "Input.dispatchKeyEvent", up).catch(() => undefined);
        }
      }
    }
  }

  async scroll(dx: number, dy: number, at?: Resolved): Promise<void> {
    const t = at ? this.where(at) : this.tab();
    let p: Point;
    if (at) {
      await this.send(t, "DOM.scrollIntoViewIfNeeded", { backendNodeId: at.backendNodeId }).catch(() => undefined);
      p = centre(await this.box(t, at.backendNodeId));
    } else {
      const m = await this.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(t, "Page.getLayoutMetrics");
      p = { x: m.cssVisualViewport.clientWidth / 2, y: m.cssVisualViewport.clientHeight / 2 };
    }
    await this.send(t, "Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: dx, deltaY: dy });
  }

  /** Places the active view at the pane's rectangle (CSS pixels of the HUD page), or parks it off-screen (null). */
  show(bounds: Rect | null): void {
    const host = this.host();
    if (bounds && bounds.width > 0 && bounds.height > 0 && host) {
      const z = host.webContents.getZoomFactor();
      const width = Math.round(bounds.width * z), height = Math.round(bounds.height * z);
      this.bounds = { x: Math.round(bounds.x * z), y: Math.round(bounds.y * z), width, height };
      this.size = { width, height };
      this.watch(host);
    } else {
      this.bounds = null;
    }
    this.place();
  }

  /** Moves the computer to another window (the pane popped out); it shows there once `show()` gives its rectangle. */
  moveTo(win: BrowserWindow): void {
    this.popped = win;
    this.bounds = null;
    this.watch(win);
    this.place();
  }

  destroy(): void {
    if (this.gone) return;
    for (const t of [...this.list]) this.drop(t);
    // Its held downloads go with it, answered or not (quitting destroys every browser).
    this.held.dropAll();
    this.current = -1;
    for (const off of this.watched.values()) off();
    this.watched.clear();
    leavePark(this);
    this.gone = true;
  }

  // ---- tabs and placement

  private host(): BrowserWindow | null {
    const w = this.popped ?? this.o.window();
    return w && !w.isDestroyed() ? w : null;
  }

  private tab(index?: number): Tab {
    const t = this.list[index ?? this.current];
    if (!t) throw new Error(index === undefined ? "No page is open: call computer_open first." : `There is no tab ${index}.`);
    return t;
  }

  private tokenOf(t: Tab): string { return `${t.uid}.${t.seq}`; }

  /** R76 (S-AC-03): run just before each input event: `valid()` (the agent still holds the wheel) and, for an action
   *  judged on a tab and page, both still in front; otherwise PageChanged. */
  private live(valid: () => boolean, at?: Judged): void {
    if (!valid()) throw new PageChanged();
    if (at) this.where(at);
  }

  /** The active tab, if `r` was resolved (or judged) on it and the page has not moved since; else PageChanged. */
  private where(r: Judged): Tab {
    const t = this.list[this.current];
    if (!t || r.tab !== this.current || r.pageToken !== this.tokenOf(t)) throw new PageChanged();
    return t;
  }

  private async addTab(by: string | null): Promise<Tab> {
    if (this.gone) throw new Error("This computer was closed.");
    if (this.list.length >= MAX_TABS) throw new Error(`${MAX_TABS} tabs are open: close one first.`);
    const view = new WebContentsView({
      webPreferences: {
        session: computerSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
        webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false, spellcheck: false,
        // A page's alert, confirm or prompt would be a native window over the person's desktop (visible even from the
        // invisible park window, D27): they are off, answered at once (confirm false, prompt empty), and noted.
        disableDialogs: true,
      },
    });
    const sensitive = new Set<number>();
    const t: Tab = {
      uid: nextUid++, view, wc: view.webContents, openedBy: by, seq: 0, navs: 0, in: null, sensitive, documents: new Map([["", sensitive]]),
      query: null, lock: Promise.resolve(), attaching: null, refs: new Map(), refused: null, closing: false,
      worlds: new Map(), memory: new SecretMemory(), frame: "", frames: [], fieldFrames: new Map(), detached: new Set(), placed: false, mainDocs: 0, leaving: new LeavingRecords(), reads: new PendingReads(), opened: null, urlHidden: false, pathHidden: false, flooded: false, doc: 0,
    };
    owners.set(t.wc.id, this.handlers);
    this.list.push(t);
    this.wire(t);
    this.current = this.list.length - 1;
    this.place();
    // The debugger's domains answer only once the page has a renderer.
    await t.wc.loadURL("about:blank");
    await this.attach(t).catch((e: Error) => this.o.hooks.note(e.message));
    this.o.hooks.changed();
    return t;
  }

  private drop(t: Tab): void {
    t.closing = true;
    if (t.query) clearTimeout(t.query);
    owners.delete(t.wc.id);
    this.attachTo(t, null);
    if (!t.wc.isDestroyed()) {
      try { if (t.wc.debugger.isAttached()) t.wc.debugger.detach(); } catch { /* already gone */ }
      t.wc.close();
    }
    this.list.splice(this.list.indexOf(t), 1);
  }

  /** Puts the active view in the host window at the pane's rectangle, or in the park window; other tabs are detached. */
  private place(): void {
    if (this.gone) return;
    const active = this.list[this.current];
    for (const t of this.list) if (t !== active) this.attachTo(t, null);
    if (!active) { leavePark(this); return; }
    const host = this.host();
    if (this.bounds && host && host.isVisible()) {
      this.attachTo(active, host);
      active.view.setBounds(this.bounds);
      leavePark(this);
    } else {
      this.parkTab(active);
    }
  }

  private parkTab(t: Tab, reshow = false): void {
    const size = this.list[this.current] === t ? this.size : { width: t.view.getBounds().width || this.size.width, height: t.view.getBounds().height || this.size.height };
    const win = parkWindow(this, size);
    if (reshow && t.in === win) {
      win.showInactive();
      win.contentView.removeChildView(t.view);
      win.contentView.addChildView(t.view);
    }
    this.attachTo(t, win);
    t.view.setBounds({ x: 0, y: 0, ...size });
  }

  private attachTo(t: Tab, win: BaseWindow | null): void {
    if (t.in === win) return;
    if (t.in && !t.in.isDestroyed()) t.in.contentView.removeChildView(t.view);
    t.in = win;
    if (win) win.contentView.addChildView(t.view);
  }

  private watch(win: BrowserWindow): void {
    if (this.watched.has(win)) return;
    const replace = (): void => this.place();
    const closed = (): void => {
      for (const t of this.list) if (t.in === win) t.in = null;
      this.watched.delete(win);
      if (this.popped === win) { this.popped = null; this.bounds = null; }
      this.place();
    };
    win.on("show", replace); win.on("hide", replace); win.on("minimize", replace); win.on("restore", replace); win.once("closed", closed);
    this.watched.set(win, () => {
      if (win.isDestroyed()) return;
      win.off("show", replace); win.off("hide", replace); win.off("minimize", replace); win.off("restore", replace); win.off("closed", closed);
    });
  }

  // ---- page events

  private wire(t: Tab): void {
    const { wc } = t;
    const note = (s: string): void => this.o.hooks.note(s);
    const refuse = (url: string, what: string): void => note(`Refused ${what} a ${schemeOf(url)} URL.`);
    wc.setWindowOpenHandler((d) => {
      if (!navAllowed(d.url)) refuse(d.url, "a new window for");
      else void this.popup(t, d).catch((e: Error) => this.o.hooks.note(`The page's new tab did not open: ${e.message}`));
      return { action: "deny" };
    });
    // A page's own navigations reach will-frame-navigate (main frame included), which notes the refusal once.
    wc.on("will-navigate", (e) => { if (!navAllowed(e.url)) e.preventDefault(); });
    wc.on("will-frame-navigate", (e) => {
      if (navAllowed(e.url)) return;
      e.preventDefault();
      refuse(e.url, e.isMainFrame ? "a navigation to" : "a frame's navigation to");
    });
    wc.on("will-redirect", (e) => {
      if (navAllowed(e.url)) return;
      e.preventDefault();
      if (e.isMainFrame) t.refused = schemeOf(e.url);
      refuse(e.url, "a redirect to");
    });
    // Chromium refuses a redirect to data:, javascript: or file: itself, before will-redirect; it is noted all the same.
    wc.on("did-fail-load", (_e, code, _d, _url, isMainFrame) => { if (code === -311) note(`Refused ${isMainFrame ? "a" : "a frame's"} redirect to a URL that is not http or https.`); });
    // D21: a navigation the page started (not open(), which loads from main) is noted with its URL. This fires before
    // the refusal above, so a refused URL is left to the refusal's scheme-only note.
    // D9: a code submitted by GET sits in the URL; the secrets remembered for the site being left and the one arrived at are
    // scrubbed from the note, once the leaving document's values have been read (or that read has failed). This event is
    // the earliest the main process hears of a page-started navigation (before will-frame-navigate; the probe showed the
    // old document gone about 5 ms later on a local server), so the leaving read starts here.
    wc.on("did-start-navigation", (e) => {
      if (!e.isMainFrame || e.isSameDocument) return;
      t.navs++;
      // agent-computer D9 (R38, R39): every navigation started gets its own entry (./leaving), never overwriting an earlier
      // one still waiting to commit; from now on a redirect belongs to this navigation. One that is not http or https gets
      // no entry (it is refused, or about:blank).
      if (!navAllowed(e.url)) { t.leaving.start(null); return; }
      if (e.initiator) this.noteNavigation(t, e.url);
      // R38: a popup's first load (from main, so no initiator) is one its opener started, with the opener's read.
      else if (t.opened) { t.leaving.start(e.url, t.opened); t.opened = null; }
      // A load from main (the agent's open()) carries nothing; its entry keeps its commit from being taken for a page's.
      else t.leaving.start(e.url);
    });
    // R38: a redirect moves the pending navigation to another URL (the one its commit will report): the latest entry
    // follows it (R39: only the latest navigation started can still be redirected).
    wc.on("did-redirect-navigation", (e) => { if (e.isMainFrame && !e.isSameDocument) t.leaving.redirect(e.url); });
    wc.on("did-navigate", (_e, url) => this.commit(t, url));
    // R37 (N1): a main-frame error page (the site refused the connection, the name did not resolve) commits too, with the
    // failed URL as the tab's URL (a GET-submitted code is in it), but Electron emits no did-navigate for it: it emits one
    // did-fail-provisional-load at that commit (probed on Electron 44), and nothing for an aborted navigation (-3).
    wc.on("did-fail-provisional-load", (_e, code, _d, url, isMainFrame) => { if (isMainFrame && code !== ABORTED) this.commit(t, url); });
    wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => { if (isMainFrame) { t.seq++; this.o.hooks.changed(); } });
    // R37 (N4): loading stops after every main-frame navigation ends; one that committed consumed its entry at the commit,
    // so an entry still here belongs to a navigation that never committed (a 204, a download, a cancel: Electron 44 emits
    // no did-fail-provisional-load for either, probed) and would otherwise wait for a URL that never commits. R39: loading
    // stays on while any navigation is pending (r40b: no stop between A's commit and B's), so this drops them all.
    // session-browser S13: the history may not hold the new entry at did-navigate, so the pane's Back and Forward are
    // read again once loading has stopped.
    wc.on("did-stop-loading", () => { t.leaving.stop(); this.o.hooks.changed(); });
    wc.on("page-title-updated", () => this.o.hooks.changed());
    wc.on("render-process-gone", (_e, d) => note(`The page ${clipUrl(this.urlOut(t))} stopped (${d.reason}).`));
    wc.on("select-bluetooth-device", (e, _devices, cb) => { e.preventDefault(); cb(""); });
    wc.debugger.on("message", (_e, method: string, params: Record<string, unknown>) => this.onCdp(t, method, params));
    wc.debugger.on("detach", (_e, reason: string) => { if (!t.closing) note(`The tab's DevTools connection closed (${reason}); the next action reconnects.`); });
  }

  private onCdp(t: Tab, method: string, p: Record<string, unknown>): void {
    switch (method) {
      // I3b: the page asked to go elsewhere in this tab (a script, a form, a link), before the browser starts the navigation.
      case "Page.frameRequestedNavigation":
        if ((!t.frame || p.frameId === t.frame) && (p.disposition === undefined || p.disposition === "currentTab")) t.navs++;
        break;
      case "Page.frameNavigated": {
        const frame = p.frame as { id: string; parentId?: string; loaderId: string };
        // agent-computer D9 (R41): a main-frame commit takes the old document's frames with it; the new ones attach after.
        // R47: the new document's fields are placed by its first DOM read, started now (a restored document's frames
        // attach no new ones, and its fields count as placed nowhere until then).
        if (!frame.parentId) {
          t.worlds.clear(); t.frames = []; t.fieldFrames = new Map(); t.detached.clear(); t.placed = false; t.mainDocs++;
          this.requery(t);
        }
        t.worlds.delete(frame.id);
        // G2 (R41): the frame's new document gets its isolated world now, so a leaving read later is one command per frame,
        // sent to every frame at once (the old document can be gone about 5 ms after a navigation starts against a fast
        // server, and DevTools holds a world made after that until the commit).
        void this.world(t, frame.id).catch(() => undefined);
        if (frame.parentId) break;
        t.frame = frame.id;
        // D9: a document keeps its sensitive set for its life (a back/forward-cache restore brings its set back).
        t.sensitive = t.documents.get(frame.loaderId) ?? new Set();
        t.documents.delete(frame.loaderId);
        t.documents.set(frame.loaderId, t.sensitive);
        while (t.documents.size > KEPT_DOCUMENTS) t.documents.delete(t.documents.keys().next().value!);
        break;
      }
      case "DOM.attributeModified": {
        const name = String(p.name).toLowerCase(), value = String(p.value).toLowerCase();
        if ((name === "type" && value.trim() === "password") || (name === "autocomplete" && /(^|\s)(current-password|new-password|one-time-code)(\s|$)/.test(value))) {
          void this.locked(t, async () => {
            const { node } = await this.send<{ node: { backendNodeId: number } }>(t, "DOM.describeNode", { nodeId: p.nodeId });
            t.sensitive.add(node.backendNodeId);
          }).catch(() => undefined);
        }
        this.requery(t);
        break;
      }
      // agent-computer D9 (R41): a frame's world is made as soon as it attaches (a frame that never navigates, filled by its
      // parent, can hold a field too) and dropped when it goes.
      case "Page.frameAttached":
        void this.world(t, String(p.frameId)).catch(() => undefined);
        break;
      // R47: a detached frame stays known to hold its fields until the next completed DOM read, started now, prunes it
      // (about 100 ms): a page that takes a code and removes its frame before navigating still fails the leaving read.
      case "Page.frameDetached": {
        const id = String(p.frameId);
        t.worlds.delete(id);
        t.frames = t.frames.filter((f) => f !== id);
        t.detached.add(id);
        this.requery(t);
        break;
      }
      case "DOM.documentUpdated":
      case "DOM.childNodeInserted":
      case "Page.loadEventFired":
        this.requery(t);
        break;
      case "Page.fileChooserOpened":
        void this.chooseFile(t, p as { mode: string; backendNodeId?: number }).catch(() => undefined);
        break;
      case "Page.javascriptDialogOpening":
        this.dialogOpened(p as { type: string });
        break;
    }
  }

  /** D9: re-reads the sensitive set at most every 100 ms while the page changes. */
  private requery(t: Tab): void {
    if (t.query) return;
    t.query = setTimeout(() => {
      t.query = null;
      void this.locked(t, () => this.readDom(t)).catch(() => undefined);
    }, QUERY_MS);
  }

  private async popup(t: Tab, d: Electron.HandlerDetails): Promise<void> {
    const from = this.site(t), to = siteOf(d.url) ?? "null", doc = t.doc;
    // R38 (D9): the popup's URL may carry a code typed into the opener that the agent never read (a target=_blank GET form,
    // window.open with the field's value). The opener document is still alive here, so its sensitive values are read now,
    // in G2's one-command read (the usual command timeout), and remembered for the opener's site before the URL goes out.
    const read = this.leavingValues(t, from);
    const got = await read;
    if (got) this.remember(t, from, got, this.site(t), doc);
    // The note is scrubbed with the values just read as well as the pools (a flood may have evicted one already); a URL
    // whose read failed loses its query and fragment, as a navigation note does.
    const out = this.urlScrub(t, [from, to], got ?? { values: [], whole: [] });
    const shown = clipUrl(out(got ? d.url : stripQuery(d.url)));
    if (this.list.length >= MAX_TABS) { this.o.hooks.note(`The page tried to open ${shown} in a new tab; ${MAX_TABS} tabs are open.`); return; }
    const nt = await this.addTab(t.openedBy);
    // R32: the new tab inherits the opener's secrets for the opener's site only. R35: a value the opener put in the new
    // tab's URL is carried for that URL string only, never into the new tab's site pool. R37 (N2): the opener's own
    // carried set comes along (a code carried into the opener's URL and forwarded to the popup's), kinds kept. R38: the
    // values read from the opener's live fields are matched against the URL too, and the popup's first navigation gets
    // them as its leaving record, so the URL it commits at (after redirects) is matched again and, when the read failed,
    // goes out without its query and fragment for that document's life (as for a failed leaving read, F1).
    nt.memory.inherit(t.memory, from);
    nt.memory.carry(t.memory.carried());
    const known = t.memory.pool([from]);
    nt.memory.carry(inUrl(d.url, { values: [...known.values, ...(got?.values ?? [])], whole: [...known.whole, ...(got?.whole ?? [])] }));
    nt.opened = { from: [from], read };
    this.o.hooks.note(`The page opened ${shown} in a new tab.`);
    const post = d.postBody;
    // A form posted into a new tab keeps its fields, never a file from this Mac (only raw data is passed on).
    const raw = post?.data.filter((x): x is Electron.UploadRawData => x.type === "rawData") ?? [];
    await nt.wc.loadURL(new URL(d.url).href, {
      httpReferrer: d.referrer,
      ...(post && raw.length ? { postData: raw, extraHeaders: `Content-Type: ${post.contentType}${post.boundary ? `; boundary=${post.boundary}` : ""}` } : {}),
    }).catch(() => { if (nt.opened?.read === read) nt.opened = null; });
  }

  private askPermission(permission: string, url: string): Promise<boolean> {
    const site = siteOf(url);
    // M10: what the app cannot grant is denied at once, with a line in the activity log, never an ask that does nothing.
    const v = permissionVerdict(permission, hostOf(site, url));
    if (v !== "ask") { this.o.hooks.note(v.deny); return Promise.resolve(false); }
    return this.o.hooks.ask({ why: "permission", title: `Let ${hostOf(site, url)} use ${permission}?`, detail: `The page asked for the "${permission}" permission.`, site });
  }

  /**
   * agent-computer D39: a download always asks, and nothing lands in Downloads before Allow. Chromium can have every byte
   * before the person answers (a small file arrives with its headers, and pause() does not stop it finishing), so the
   * bytes go to a private folder of their own in the user's system temp folder (0700; ./downloads.ts) and move into
   * Downloads only once allowed; Deny cancels the download and deletes them, and so does this browser going.
   */
  private download(item: DownloadItem, wc: WebContents): void {
    const name = downloadName(item.getFilename());
    let dir: string;
    try { dir = this.held.hold(); } catch {
      item.cancel();
      this.o.hooks.note(`The download of ${name} was refused: there was no private folder to hold it in.`);
      return;
    }
    const held = path.join(dir, name);
    item.setSavePath(held);
    item.pause();
    const drop = (): void => this.held.drop(dir);
    const site = siteOf(item.getURL()) ?? siteOf(wc.getURL());
    const bytes = item.getTotalBytes();
    const deliver = (state: string): void => {
      try {
        if (state !== "completed") { this.o.hooks.note(`The download of ${name} was ${state}.`); return; }
        const into = app.getPath("downloads");
        fs.mkdirSync(into, { recursive: true });
        const file = moveInto(held, into, name);
        this.o.hooks.note(`Downloaded ${path.basename(file)} to ${file}`);
      } catch (e) {
        this.o.hooks.note(`The download of ${name} did not reach Downloads: ${e instanceof Error ? e.message : String(e)}`);
      } finally { drop(); }
    };
    const done = (ok: boolean): void => {
      if (!ok) { item.cancel(); drop(); item.once("done", drop); return; }
      if (item.getState() !== "progressing") { deliver(item.getState()); return; }
      item.once("done", (_e, state) => deliver(state));
      item.resume();
    };
    this.o.hooks.ask({
      why: "download", title: `Download ${name} from ${hostOf(site, item.getURL())}?`,
      detail: bytes > 0 ? `${name}, ${Math.max(1, Math.round(bytes / 1024))} KB, into Downloads` : `${name}, into Downloads`, site,
    }).then(done, () => done(false));
  }

  /** D39: a page's file chooser asks first, then the person picks in the system dialog. R76 (T-AC-03): the chooser is
   *  bound to the tab and the page that opened it: after the Allow and again after the dialog closes, that tab must still
   *  be open on the same page (its token), or no file is given and a note says why. */
  private async chooseFile(t: Tab, p: { mode: string; backendNodeId?: number }): Promise<void> {
    const url = t.wc.getURL(), site = siteOf(url), name = hostOf(site, url);
    const token = this.tokenOf(t);
    const moved = (): boolean => {
      if (this.list.includes(t) && !t.wc.isDestroyed() && this.tokenOf(t) === token) return false;
      this.o.hooks.note(`No file was given to ${name}: its page changed or closed before you chose one.`);
      return true;
    };
    const ok = await this.o.hooks.ask({ why: "file", title: `Give ${name} a file?`, detail: "The page asked for a file from this Mac.", site }).catch(() => false);
    if (!ok || p.backendNodeId === undefined || moved()) return;
    const opts: Electron.OpenDialogOptions = { properties: p.mode === "selectMultiple" ? ["openFile", "multiSelections"] : ["openFile"] };
    const host = this.host();
    const r = host && host.isVisible() ? await dialog.showOpenDialog(host, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths.length || moved()) return;
    await this.send(t, "DOM.setFileInputFiles", { files: r.filePaths, backendNodeId: p.backendNodeId })
      .catch((e: Error) => this.o.hooks.note(`The chosen file did not reach the page: ${e.message}`));
  }

  /** Dialogs are off in computer views (`disableDialogs`); the page got its answer already, and the transcript a note
   *  naming the kind only (the message is page-chosen text). */
  private dialogOpened(p: { type: string }): void {
    const kind = DIALOGS.has(p.type) ? `${p.type} dialog` : "dialog";
    this.o.hooks.note(`The page tried to show a ${kind}; dialogs are off here, so it was blocked.`);
  }

  // ---- the DevTools protocol

  private locked<T>(t: Tab, fn: () => Promise<T>): Promise<T> {
    const run = t.lock.then(fn, fn);
    t.lock = run.catch(() => undefined);
    return run;
  }

  private attach(t: Tab): Promise<void> {
    t.attaching ??= (async () => {
      try {
        t.wc.debugger.attach("1.3");
      } catch {
        throw new Error("Another debugger is attached to this tab, so it cannot be driven (agent-computer D20).");
      }
      for (const [method, params] of ENABLE) await cdp(t.wc.debugger, method, params);
    })().finally(() => { t.attaching = null; });
    return t.attaching;
  }

  /** Every command goes through here: attached on demand (after a crash or reload), 5 s timeout (./cdp). */
  private async send<T = unknown>(t: Tab, method: string, params?: object): Promise<T> {
    if (t.wc.isDestroyed()) throw new Error("That tab was closed.");
    if (t.wc.isDevToolsOpened()) throw new Error("DevTools is open on this tab, so it cannot be driven (agent-computer D20).");
    if (t.attaching) await t.attaching;
    else if (!t.wc.debugger.isAttached()) await this.attach(t);
    return cdp<T>(t.wc.debugger, method, params);
  }

  /** The pierced DOM, and the sensitive fields in it added to the document's set (D9). Call inside `locked`. */
  private async readDom(t: Tab): Promise<DomIndex> {
    const docs = t.mainDocs, gone = [...t.detached];
    const { root } = await this.send<{ root: CdpDomNode }>(t, "DOM.getDocument", { depth: -1, pierce: true });
    const dom = indexDom(root);
    t.frames = [...new Set(dom.roots.map((r) => r.frameId).filter((f): f is string => !!f))];
    for (const r of dom.roots) {
      // A root that went away has nothing to hide; a timeout or any other failure fails the read (D9 never fails open).
      const { nodeIds } = await this.send<{ nodeIds: number[] }>(t, "DOM.querySelectorAll", { nodeId: r.nodeId, selector: SENSITIVE }).catch(unlessGone({ nodeIds: [] as number[] }));
      for (const id of nodeIds) {
        const b = dom.backendOf.get(id);
        if (b !== undefined) t.sensitive.add(b);
      }
    }
    // agent-computer D9 (R41): where each sensitive field is, for the leaving read's failure rule; and a world for any frame
    // this read found without one (a restored document's frames attach no new ones). R47: the frames that detached before
    // this read began and are not in it are pruned (their fields are placed nowhere now), so a removed login frame does not
    // fail every later read of the document. A read that spans a main-frame commit places nothing.
    if (t.mainDocs === docs) {
      for (const b of t.sensitive) { const f = dom.frameOf.get(b); if (f !== undefined) t.fieldFrames.set(b, f); }
      const here = new Set(t.frames);
      for (const id of gone) {
        t.detached.delete(id);
        if (!here.has(id)) for (const [b, f] of t.fieldFrames) if (f === id) t.fieldFrames.set(b, null);
      }
      t.placed = true;
    }
    for (const f of t.frames) if (!t.worlds.has(f)) void this.world(t, f).catch(() => undefined);
    return dom;
  }

  private async capture(t: Tab): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      const before = await this.maskRects(t);
      const m1 = await this.viewport(t);
      const shot = await this.send<{ data: string }>(t, "Page.captureScreenshot", { format: "png" });
      const m2 = await this.viewport(t);
      // Boxes read before and after the capture are both painted, so a field that moved meanwhile stays covered.
      const after = await this.maskRects(t);
      const img = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
      const size = img.getSize();
      // The scale comes from the capture against the page's own metrics; if they disagree (the view resized meanwhile)
      // the masks could land in the wrong place, so the capture is taken again once and otherwise refused (D9).
      const same = m1.width === m2.width && m1.height === m2.height && m1.zoom === m2.zoom && m1.scale === m2.scale;
      const sc = same ? screenScale(size, m2) : null;
      if (!sc) {
        if (attempt === 0) continue;
        throw new Error("The page changed size while the screenshot was taken, so it was not returned: try again.");
      }
      const viewport = { x: 0, y: 0, width: sc.width, height: sc.height };
      // One CSS pixel of margin, so the box's edge stays fully covered once the image is scaled down.
      const boxes = [...before, ...after].map((r) => ({ x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 }));
      const painted = nativeImage.createFromBitmap(paintRects(img.toBitmap(), size.width, size.height, deviceRects(boxes, { dpr: sc.dpr, zoom: sc.zoom, viewport })), size);
      // Clicks take CSS pixels, so the image is returned at that size, after the masks are painted.
      const out = size.width === sc.width && size.height === sc.height ? painted : painted.resize({ width: sc.width, height: sc.height, quality: "good" });
      return out.toPNG();
    }
  }

  private async viewport(t: Tab): Promise<{ width: number; height: number; zoom: number; scale: number }> {
    const { cssVisualViewport: v } = await this.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number; zoom?: number; scale: number } }>(t, "Page.getLayoutMetrics");
    return { width: v.clientWidth, height: v.clientHeight, zoom: v.zoom ?? t.wc.getZoomFactor(), scale: v.scale };
  }

  /** The boxes painted over: every field that was ever sensitive (D9), and every frame from another site, whose contents
   *  cannot be read (a revealed password or a one-time code inside one must not leak either). */
  private async maskRects(t: Tab): Promise<Rect[]> {
    const dom = await this.locked(t, () => this.readDom(t));
    const rects: Rect[] = [];
    for (const b of new Set([...t.sensitive, ...dom.remoteFrames])) {
      const m = await this.send<{ model: { border: number[] } }>(t, "DOM.getBoxModel", { backendNodeId: b }).catch(unlessGone(null));
      if (m) rects.push(quadRect(m.model.border));
    }
    return rects;
  }

  /** The element's first visible box (its first line, for an inline element). */
  private async box(t: Tab, backendNodeId: number): Promise<Rect> {
    const q = await this.send<{ quads: number[][] }>(t, "DOM.getContentQuads", { backendNodeId }).catch(unlessGone({ quads: [] as number[][] }));
    const r = q.quads.map(quadRect).find((x) => x.width > 0 && x.height > 0);
    if (!r) throw new Error("That element is not visible on the page: take a new snapshot.");
    return r;
  }

  /** The focused node and the DOM it was read from; "remote" when focus is in a cross-site frame. */
  /** The focused element's backend node (null when nothing has focus) with the DOM read that found it, or "remote".
   *  `gone`: a root's :focus query found its node gone, so the document may have changed under the read (R82). */
  private async focused(t: Tab): Promise<{ b: number | null; dom: DomIndex; gone: boolean } | "remote"> {
    // A cross-site frame's document is in another process, out of this debugger's reach (so is anything inside one):
    // treated as sensitive, so typing into it is refused rather than judged blind (D9).
    const main = t.wc.mainFrame.processId;
    for (let f = t.wc.focusedFrame; f; f = f.parent) if (f.processId !== main) return "remote";
    return this.locked(t, async () => {
      const dom = await this.readDom(t);
      // :focus matches in the deepest root that holds focus (an iframe's document, a shadow root), so every root is asked.
      let best: { b: number; depth: number } | null = null;
      let gone = false;
      for (const r of dom.roots) {
        const { nodeIds } = await this.send<{ nodeIds: number[] }>(t, "DOM.querySelectorAll", { nodeId: r.nodeId, selector: ":focus" })
          .catch((e: unknown) => { if (!isGone(e)) throw e; gone = true; return { nodeIds: [] as number[] }; });
        for (const id of nodeIds) {
          const b = dom.backendOf.get(id);
          if (b !== undefined && (!best || r.depth >= best.depth)) best = { b, depth: r.depth };
        }
      }
      return { b: best ? best.b : null, dom, gone };
    });
  }

  /** The focused element's node and frame as `focus()` names them (R76), and whether typing there is refused (D9: a
   *  field that was ever sensitive, or anything inside a frame from another site). */
  private async focusedId(t: Tab): Promise<FocusId & { refused: boolean; dom: DomIndex | null; gone: boolean }> {
    const f = await this.focused(t);
    if (f === "remote") {
      const r = await this.remoteFocus(t);
      return { node: r?.b ?? null, frame: r ? r.dom.frameOf.get(r.b) ?? null : null, refused: true, dom: r?.dom ?? null, gone: false };
    }
    if (f.b === null) return { node: null, frame: null, refused: false, dom: f.dom, gone: f.gone };
    return { node: f.b, frame: f.dom.frameOf.get(f.b) ?? null, refused: t.sensitive.has(f.b), dom: f.dom, gone: f.gone };
  }

  /**
   * R76, R78, R82: a key's or typing's focus check, run before each event: typing never lands in a sensitive field (D9),
   * and with `focus` the focused element must still be the judged one. The page token and `navs` come from webContents
   * events, which can reach main after the renderer already holds the next document, so the read itself is judged too:
   * PageChanged when another main document is in place than when the call began (a main-frame commit seen on the
   * DevTools session, whose events arrive in order with the read's answers; or a main document other than the call's
   * first read saw) or the read found its document's nodes gone under it, and, when the focus is not the judged element,
   * when the judged node is gone from the document read. Only a focus move within the same document throws FocusMoved.
   */
  private focusCheck(t: Tab, focus: FocusId | undefined): (typing: boolean) => Promise<void> {
    const docs = t.mainDocs;
    let first: number | null | undefined;
    return async (typing) => {
      const now = await this.focusedId(t);
      const root = rootOf(now.dom);
      if (first === undefined) first = root;
      if (t.mainDocs !== docs || now.gone || (first !== null && root !== null && root !== first)) throw new PageChanged();
      if (focus && !sameId(now, focus)) {
        if (focus.node !== null && now.dom !== null && !now.dom.names.has(focus.node)) throw new PageChanged();
        if (typing && now.refused) throw new Error(D9_REFUSAL);
        throw new FocusMoved();
      }
      if (typing && now.refused) throw new Error(D9_REFUSAL);
    };
  }

  /** The frame element holding focus that lives in another site's process, read through `document.activeElement` in an
   *  isolated world (DOM :focus does not match it), with the DOM it was found in; null when it cannot be read. */
  private async remoteFocus(t: Tab): Promise<{ b: number; dom: DomIndex } | null> {
    const group = `agent-computer-focus-${t.uid}`;
    try {
      const objectId = await this.activeElement(t, group);
      if (!objectId) return null;
      const { node } = await this.send<{ node: { backendNodeId: number } }>(t, "DOM.describeNode", { objectId });
      const dom = await this.locked(t, () => this.readDom(t));
      return { b: node.backendNodeId, dom };
    } catch (e) {
      if (e instanceof CdpTimeout) throw e;
      return null;
    } finally {
      await this.send(t, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
    }
  }

  /** The target of a remote focus (`remoteFocus`): the frame element, opaque; a generic frame target when it cannot be read. */
  private async remoteTarget(t: Tab, r: { b: number; dom: DomIndex } | null): Promise<Target> {
    const frame: Target = { role: "Iframe", name: "", inForm: false, fileInput: false, opaque: true };
    if (!r) return frame;
    try {
      return { ...(await this.targetOf(t, r.b, r.dom)), opaque: true };
    } catch (e) {
      if (e instanceof CdpTimeout) throw e;
      return frame;
    }
  }

  /** `ACTIVE_ELEMENT` in the main frame's isolated world (a stale one is replaced once). */
  private async activeElement(t: Tab, group: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>(t, "Page.getFrameTree");
      try {
        const contextId = await this.world(t, frameTree.frame.id);
        const { result } = await this.send<{ result: { objectId?: string } }>(t, "Runtime.evaluate", { expression: ACTIVE_ELEMENT, contextId, objectGroup: group });
        return result.objectId;
      } catch (e) {
        if (e instanceof CdpTimeout) throw e;
        t.worlds.delete(frameTree.frame.id);
      }
    }
    return undefined;
  }

  /** The isolated world of frame `frameId`, made once per document (page scripts cannot reach it). A world that could not
   *  be made is forgotten, so the next caller tries again; one dropped meanwhile (the frame navigated) is never put back. */
  private world(t: Tab, frameId: string): Promise<number> {
    const known = t.worlds.get(frameId);
    if (known) return known;
    const made = this.send<{ executionContextId: number }>(t, "Page.createIsolatedWorld", { frameId, worldName: WORLD }).then((r) => r.executionContextId);
    t.worlds.set(frameId, made);
    made.catch(() => { if (t.worlds.get(frameId) === made) t.worlds.delete(frameId); });
    return made;
  }

  /** D9: every sensitive field's current value, as the field holds it (`fieldValues`) and as the accessibility tree shows
   *  it, remembered for `site` (the current one by default). The sensitive set is refreshed first unless the caller just
   *  read `dom`; `ids` reads a given set of fields (the document being left) instead of the tab's current set. */
  private async secrets(t: Tab, o: { dom?: DomIndex; ids?: Iterable<number>; site?: string } = {}): Promise<Secrets> {
    // The site and document are fixed before the reads; a cross-document navigation during them leaves the values
    // unremembered (R37: an in-page navigation is not one, so a page replacing its URL in a loop cannot starve the memory).
    const site = o.site ?? this.site(t), doc = t.doc;
    const d = o.dom ?? await this.locked(t, () => this.readDom(t));
    const ids = new Set(o.ids ?? t.sensitive);
    const fields = await this.fieldValues(t, d, ids);
    const otp = new Set(fields.filter((f) => f.otp).map((f) => f.b));
    const out: Secrets = { values: fields.filter((f) => !f.otp).map((f) => f.value), whole: fields.filter((f) => f.otp).map((f) => f.value) };
    for (const b of ids) {
      const { nodes } = await this.send<{ nodes: CdpAxNode[] }>(t, "Accessibility.getPartialAXTree", { backendNodeId: b, fetchRelatives: false }).catch(unlessGone({ nodes: [] as CdpAxNode[] }));
      (otp.has(b) ? out.whole : out.values).push(...secretsOf(nodes, ids));
    }
    return t.doc === doc ? this.remember(t, site, out, site, doc) : out;
  }

  /** The site (origin) the tab is on, the key its remembered secrets are scoped by (R32). */
  private site(t: Tab): string { return siteOf(t.wc.getURL()) ?? "null"; }

  /** Adds `s` to the tab's memory for `site`; `keep` (the current site by default) is never evicted with the oldest sites.
   *  R37: a read of document `doc` that flooded a kind's reserve (so one of its values may be forgotten already) hides
   *  that document's URL query and fragment while it is current. */
  private remember(t: Tab, site: string, s: Secrets, keep: string = site, doc?: number): Secrets {
    const flooded = t.memory.remember(site, s, keep);
    if (flooded && doc === t.doc) t.flooded = true;
    return s;
  }

  /** Whether the current document's URL goes out without its query and fragment (F1, R37). */
  private hidden(t: Tab): boolean { return t.urlHidden || t.flooded; }

  /** The scrub for the secrets just read plus what the tab remembers for `sites` (the current site by default). */
  private scrubWith(t: Tab, s: Secrets, sites: string[] = [this.site(t)]): (text: string) => string {
    const mem = t.memory.pool(sites);
    return scrubber([...s.values, ...mem.values], [...s.whole, ...mem.whole]);
  }

  /** The scrub from the tab's memory alone (for a title going out where nothing new is read). */
  private remembered(t: Tab, sites: string[]): (text: string) => string {
    return this.scrubWith(t, { values: [], whole: [] }, sites);
  }

  /** The scrub for a URL string (./snapshot `urlScrubber`: after the origin only, in every URL form): `s`, the sites'
   *  pools and what other sites carried into this tab's URLs (R35), each by kind (R37). */
  private urlScrub(t: Tab, sites: string[], s: Secrets = { values: [], whole: [] }): (url: string) => string {
    const mem = t.memory.pool(sites), carried = t.memory.carried();
    return urlScrubber([...s.values, ...mem.values, ...carried.values], [...s.whole, ...mem.whole, ...carried.whole]);
  }

  /** The tab's current URL before its scrub: everything after the origin hidden while its commit is still carrying (R40),
   *  the query and fragment hidden while the document arrived through a navigation whose leaving read failed, a commit no
   *  entry matched, or a read of it flooded the memory (F1, R37, R39). */
  private shownUrl(t: Tab): string {
    const url = t.wc.getURL();
    return t.pathHidden ? hideAfterOrigin(url) : this.hidden(t) ? stripQuery(url) : url;
  }

  /** The tab's current URL as it may leave: `shownUrl`, scrubbed for the current site. */
  private urlOut(t: Tab): string {
    return this.urlScrub(t, [this.site(t)])(this.shownUrl(t));
  }

  /** G2: the document being left may hold a code the person typed that the agent never read (a GET submit carries it into
   *  the next URL). Its sensitive values are read now in one command per frame (`LEAVING_VALUES`, in the frame's isolated
   *  world; the usual command timeout applies). Best effort: null when the document went before the read answered.
   *  agent-computer D9 (R40): a frame's answer counts only while the tab has not committed (`PendingReads`, and the
   *  document counter): DevTools holds commands while a cross-process navigation commits and then sends them to the new
   *  renderer, where a stale numeric context id can name a context of the new document (review rv5), so such an answer may
   *  not be the old document's. R41: the frames are read all at once, each in the world made for it ahead (a world made now
   *  would be held until the commit), and each on its own (./leaving `mergeFrameReads`): the read fails only when the main
   *  frame, or a frame the document's sensitive set places a field in, gives no answer (R47: a detached one included,
   *  ./leaving `leavingFrames`); what the others answered is remembered for `from`, the site being left, all the same. */
  private leavingValues(t: Tab, from: string): Promise<Secrets | null> {
    const doc = t.doc;
    const frames = leavingFrames(t.frame, [...t.frames, ...t.worlds.keys()], t.worlds, framesHolding(t.sensitive, t.fieldFrames), t.placed);
    const one = async (frameId: string): Promise<Secrets | null> => {
      const world = t.worlds.get(frameId);
      if (!world) return null;
      try {
        const contextId = await world;
        const { result } = await this.send<{ result: { value?: { v?: unknown; otp?: unknown }[] } }>(t, "Runtime.evaluate", { contextId, returnByValue: true, expression: LEAVING_VALUES });
        if (t.doc !== doc) return null;
        const out: Secrets = { values: [], whole: [] };
        for (const x of result.value ?? []) (x.otp === true ? out.whole : out.values).push(typeof x.v === "string" ? x.v : "");
        return out;
      } catch {
        return null;
      }
    };
    return Promise.all(frames.map((f) => (f.read ? t.reads.track(one(f.frame)) : Promise.resolve(null)))).then((reads) => {
      const m = mergeFrameReads(frames.map((f, i) => ({ main: f.main, sensitive: f.sensitive, read: reads[i] })));
      // R41: a failed read still keeps what the frames that answered held (each answered before the commit, so it is the
      // old document's): remembered for the site being left, so the carry at commit and the note's scrub take it from that
      // site's pool, as they do a whole read's values.
      if (!m.read && (m.got.values.length || m.got.whole.length)) this.remember(t, from, m.got, this.site(t));
      return m.read;
    });
  }

  /**
   * D21 with D9: a page-started main-frame navigation. The leaving document's values are read now (G2) and remembered
   * for the site being left; the note is written once that read has answered or failed, with the secrets of the site
   * being left and the one arrived at scrubbed from the URL (R32: a GET submit carries a code from the old site into
   * the new URL), or without the URL's query and fragment when the read failed. What the URL carries goes to the
   * carried set at commit (`committed`), not here: a cancelled navigation carries nothing, and the committed URL (after
   * redirects) is the one `tabs()` shows. SECURITY.md (Task 16): a code the person typed and submitted by GET with no
   * agent read in between is covered only when the one-command read answers before the old document is torn down
   * (about 5 ms after the navigation starts against a local server, longer against a real one); a field revealed from
   * type=password to text is outside that read's selector; and when the read loses, the new page's own text (a
   * confirmation echoing the code) is scrubbed only if the same value was read earlier in this tab on that site, while
   * its URL goes out without query and fragment.
   */
  private noteNavigation(t: Tab, url: string): void {
    const from = this.site(t), to = siteOf(url) ?? "null";
    const read = this.leavingValues(t, from);
    t.leaving.start(url, { from: [from], read });
    void read.then((got) => {
      if (got) this.remember(t, from, got, this.site(t));
      // The values just read scrub the note directly (a flood on the leaving page may have evicted one of them from the
      // pool already, and the carry at commit runs after this).
      const out = this.urlScrub(t, [from, to], got ?? { values: [], whole: [] });
      this.o.hooks.note(`The page went to ${clipUrl(out(got ? url : stripQuery(url)))}`);
    });
  }

  /** A cross-document main-frame commit (did-navigate, or an error page's did-fail-provisional-load, R37): a new document
   *  for the tokens and the race checks, then `committed`. */
  private commit(t: Tab, url: string): void {
    t.seq++;
    t.doc++;
    // R40: a leaving read still pending can no longer count (an answer now may be the new document's): it fails now, so
    // this commit's carry never waits on it.
    t.reads.endAll();
    this.committed(t, url);
    this.o.hooks.changed();
  }

  /** R35: at a main-frame commit, the values the committed URL carries from the site being left (its pool and the
   *  leaving read) go to the tab's carried set, which scrubs URL strings only, each by kind (R37); the URL is held back
   *  (query and fragment) while the leaving read is pending and for the document's life when it failed (F1). An
   *  agent-started navigation (`open()`) has no leaving read and carries nothing. The flood flag starts clear for the
   *  new document. R38: the record is this navigation's only when the committed URL is the one the record followed
   *  (Electron reports the same handle's URL at start, redirect and commit). agent-computer D9 (R39): the commit consumes
   *  only its own entry and leaves the others (a navigation started before this commit can still commit after it: r40b
   *  q1'); when no entry matches but a page record could be this navigation's (a redirect not seen, a record lost to the
   *  bound), it fails closed: the document's query and fragment stay hidden for its life. R40: the carry takes what the URL
   *  holds from every record the commit yields (./leaving: the page records keyed at the URL, the merged record of those
   *  the bound dropped, and for the agent's commit or an unmatched one every pending page record), so it scrubs the path
   *  too; until all their reads have answered, everything after the origin is hidden (`pathHidden`). The agent's own commit
   *  is never held back once they have. A page commit stays hidden when the read of the record it consumed (the oldest
   *  keyed at its URL: the one that commits first) failed; the others keyed there are carried from all the same. */
  private committed(t: Tab, url: string): void {
    const got = t.leaving.commit(url);
    const records = [...got.own, ...got.others];
    t.urlHidden = got.kind === "page" || got.kind === "unknown";
    t.pathHidden = records.length > 0;
    t.flooded = false;
    if (!records.length) return;
    const doc = t.doc;
    void Promise.all(records.map((r) => r.read)).then((reads) => {
      if (t.doc !== doc) return;
      const known = t.memory.pool([...new Set(records.flatMap((r) => r.from))]);
      const s: Secrets = { values: [...known.values], whole: [...known.whole] };
      for (const read of reads) { s.values.push(...(read?.values ?? [])); s.whole.push(...(read?.whole ?? [])); }
      t.memory.carry(inUrl(url, s));
      t.pathHidden = false;
      if (got.kind === "page") t.urlHidden = reads[0] === null;
      this.o.hooks.changed();
    });
  }

  /** D9: the DOM value (`this.value`) of every sensitive field in `dom`, read on the node in an isolated world of its
   *  frame, so a page-defined getter cannot answer instead. A field that is gone has nothing to read; a stale world is
   *  made again once; any other failure throws (the text it was for is held back rather than let out unscrubbed). */
  private async fieldValues(t: Tab, dom: DomIndex, ids: Iterable<number> = t.sensitive): Promise<FieldValue[]> {
    const out: FieldValue[] = [];
    const group = `agent-computer-values-${t.uid}`;
    let any = false;
    try {
      for (const b of ids) {
        any = true;
        const frameId = dom.frameOf.get(b);
        if (frameId === undefined) continue;
        const v = await this.fieldValue(t, b, frameId, group);
        if (v) out.push(v);
      }
    } finally {
      if (any) await this.send(t, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
    }
    return out;
  }

  /** One field's value. A cached world may be stale (a reload keeps the frame id; DevTools then answers as if the node were
   *  gone), so any failure with a cached world drops it and tries once more with a fresh one; the node counts as gone only
   *  when the fresh world says so, and any other failure throws. */
  private async fieldValue(t: Tab, b: number, frameId: string, group: string): Promise<FieldValue | undefined> {
    let fresh = !t.worlds.has(frameId);
    for (;;) {
      try {
        const executionContextId = await this.world(t, frameId);
        const { object } = await this.send<{ object: { objectId: string } }>(t, "DOM.resolveNode", { backendNodeId: b, executionContextId, objectGroup: group });
        const { result } = await this.send<{ result: { value?: { v?: unknown; otp?: unknown } } }>(t, "Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: VALUE_OF, returnByValue: true, objectGroup: group });
        return typeof result.value?.v === "string" ? { b, value: result.value.v, otp: result.value.otp === true } : undefined;
      } catch (e) {
        if (e instanceof CdpTimeout) throw e;
        if (fresh) {
          if (isGone(e)) return undefined;
          throw new Error(D9_UNREAD);
        }
        t.worlds.delete(frameId);
        fresh = true;
      }
    }
  }

  /** The node a press at viewport point `p` reaches, with the document point `at` the hit test was made at and the scroll
   *  `off` it used. Every point here is the viewport's (a ref's content quad, the agent's x and y off a screenshot,
   *  Input.dispatchMouseEvent's), but DOM.getNodeForLocation reads its x and y as the document's, whole numbers (Blink
   *  converts them with DocumentToFrame), so the hit test is at `p` plus the page's scroll, rounded: without the scroll,
   *  a scrolled page was judged on whatever it shows a scroll's height above the press, or on nothing. The scroll is read
   *  before and after the hit test, and one that moved between refuses: the node hit then belongs to neither. R87: a
   *  scroll that is not whole leaves `at` up to half a pixel from `p + off`, so a press goes to `judgedAt`, not `p`. */
  private async hitAt(t: Tab, p: Point): Promise<{ hit: number; at: Point; off: Point }> {
    const off = await this.scrolledBy(t);
    const at = { x: Math.round(p.x + off.x), y: Math.round(p.y + off.y) };
    let hit: number;
    try {
      ({ backendNodeId: hit } = await this.send<{ backendNodeId: number }>(t, "DOM.getNodeForLocation", { ...at, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }));
    } catch (e) {
      if (e instanceof Error && /^No node found at given location/.test(e.message)) throw new Error("There is nothing at that point on the page.");
      throw e;
    }
    const after = await this.scrolledBy(t);
    if (after.x !== off.x || after.y !== off.y) throw new Error("The page changed: look again.");
    return { hit, at, off };
  }

  /** Where the viewport's top left is in the document, in CSS pixels: the page's scroll (and, pinch-zoomed, the visual
   *  viewport's offset within it). */
  private async scrolledBy(t: Tab): Promise<Point> {
    const { cssVisualViewport: v } = await this.send<{ cssVisualViewport: { pageX: number; pageY: number } }>(t, "Page.getLayoutMetrics");
    return { x: v.pageX, y: v.pageY };
  }

  /** Moves the pointer to `p` and gives hover styles and handlers a moment to apply; `before` runs just before the move
   *  (a click's validity check, R76). */
  private async hover(t: Tab, p: Point, before?: () => void): Promise<void> {
    before?.();
    await this.mouse(t, "mouseMoved", p);
    await sleep(HOVER_MS);
  }

  /**
   * What a click at `p` reaches now (R26): the hit test comes first and the DOM is read after it, so the facts read
   * (form, file input) include the hit node; `check` sees the hit. The hit test returns the shadow host in two cases it
   * cannot tell apart: a slotted bare text node, which it climbs to its DOM parent (the host), and a slotted text that
   * cannot be hit (pointer-events:none inherited from a shadow wrapper), where the click lands on the host itself or
   * bubbles to a light-DOM ancestor. So when a slotted text holds the point (`slottedText`), both walks (./reach) start
   * from the text and from the host, and the gate judges the union (Task 11b). A hit inside a shadow tree (the text
   * hidden, the wrapper hit) also starts at each host above it, where the click bubbles (`hostsAbove`). `hit` stays
   * the node the hit test returned; `at` and `off` are the hit test's (`hitAt`), and a press goes to `judgedAt` of them.
   */
  private async reachAt(t: Tab, p: Point, check?: (hit: number, dom: DomIndex) => void): Promise<{ hit: number; at: Point; off: Point; dom: DomIndex; reached: Reach; own: number }> {
    const { hit, at, off } = await this.hitAt(t, p);
    const dom = await this.locked(t, () => this.readDom(t));
    if (!dom.names.has(hit)) throw new Error("The page changed: look again.");
    check?.(hit, dom);
    if (dom.remoteFrames.has(hit)) return { hit, at, off, dom, reached: { hit, controls: [hit] }, own: 1 };
    const text = await this.slottedText(t, hit, judgedAt({ at, off }), dom);
    // The hit's own starts first (the text and the host, or the hit), then the hosts the click bubbles to, each once.
    const ownFrom = text === null ? [hit] : [text, hit];
    const froms = [...ownFrom, ...hostsAbove(dom, hit).filter((h) => !ownFrom.includes(h))];
    const starts: Start[] = [];
    for (const from of froms) {
      const { nodes } = await this.send<{ nodes: CdpAxNode[] }>(t, "Accessibility.getPartialAXTree", { backendNodeId: from, fetchRelatives: true }).catch(unlessGone({ nodes: [] as CdpAxNode[] }));
      starts.push({ from, ax: nodes });
    }
    // The controls the own starts found come first in the union; `own` says how many, for `judgeReach`.
    return { hit, at, off, dom, reached: reach(dom, hit, starts), own: reach(dom, hit, starts.slice(0, ownFrom.length)).controls.length };
  }

  /** On a hit on a shadow host: the host's light-DOM text node whose own box holds the point (`DOM.getContentQuads` works
   *  on text nodes), where the click landed if the text could be hit; else null (a hit on the host's padding, or nothing
   *  slotted there). Nothing in the shadow tree is guessed at by its box: a shadow element the point falls in is only
   *  what the click reaches when the hit test says so. */
  private async slottedText(t: Tab, host: number, p: Point, dom: DomIndex): Promise<number | null> {
    if (!dom.shadowRoots.has(host)) return null;
    for (const c of dom.children.get(host) ?? []) {
      if (dom.names.get(c) !== "#text") continue;
      const { quads } = await this.send<{ quads: number[][] }>(t, "DOM.getContentQuads", { backendNodeId: c }).catch(unlessGone({ quads: [] as number[][] }));
      if (quads.map(quadRect).some((r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height)) return c;
    }
    return null;
  }

  /** The target the gate judges for what a click reaches (D43 reads role and label): a frame from another site
   *  (opaque); a plain element as it is; one control by its name; or, when the walks found different controls, every
   *  name joined so the click asks if any matches. Refused only when the hit's own walks (the first `own` controls)
   *  disagree and one of them cannot be named: then which control the click activates cannot be told. A nameless
   *  control elsewhere (an icon button inside a host inside a named link) is judged by the named ones. */
  private async judgeReach(t: Tab, r: Reach, dom: DomIndex, own: number): Promise<Target> {
    if (dom.remoteFrames.has(r.hit)) return { ...(await this.targetOf(t, r.hit, dom)), opaque: true };
    if (!r.controls.length) return this.targetOf(t, r.hit, dom);
    const targets: Target[] = [];
    for (const c of r.controls) targets.push(await this.named(t, c, dom));
    if (targets.length === 1) return targets[0];
    if (own > 1 && targets.slice(0, own).some((x) => !x.name)) throw new Error(CANT_TELL);
    const named = targets.filter((x) => x.name);
    if (!named.length) return targets[0];
    // Each further name is added unless the name so far holds it as whole words (then every label in it is matched
    // already): "Deleted messages" holds "Delete" as letters only, so the name is "Deleted messages (Delete)" and asks.
    let name = named[0].name;
    for (const x of named.slice(1)) if (!covers(name, x.name)) name = `${name} (${x.name})`;
    return { role: named.find((x) => ASK_ROLES.has(x.role))?.role ?? named[0].role, name, inForm: targets.some((x) => x.inForm), fileInput: targets.some((x) => x.fileInput) };
  }

  /** A control's role and name: from the accessibility tree, with its markup role where that tree hides it, and its own
   *  markup name and text added when the accessible name does not already contain them as whole words (a <label for>
   *  names a Buy button "Learn more"; aria-owns moves its text away; "Approved requests" does not cover "Approve"). D9:
   *  nothing a person typed becomes a name, so a text field or a sensitive node gets no markup hint and no text. */
  private async named(t: Tab, b: number, dom: DomIndex): Promise<Target> {
    const ax = await this.targetOf(t, b, dom);
    const native = dom.roles.get(b);
    const role = native && (ax.role === "generic" || ax.role === "none" || ax.role === "") ? native : ax.role;
    let name = ax.name;
    if (!dom.textFields.has(b) && !t.sensitive.has(b)) {
      for (const extra of [dom.hints.get(b), domText(dom, b)]) {
        if (extra && !covers(name, extra)) name = name ? `${name} (${extra})` : extra;
      }
    }
    return { ...ax, role, name };
  }

  private async targetOf(t: Tab, b: number, dom: DomIndex): Promise<Target> {
    const { nodes } = await this.send<{ nodes: CdpAxNode[] }>(t, "Accessibility.getPartialAXTree", { backendNodeId: b, fetchRelatives: false }).catch(unlessGone({ nodes: [] as CdpAxNode[] }));
    const n = nodes.find((x) => x.backendDOMNodeId === b) ?? nodes[0];
    return { role: n && !n.ignored ? String(n.role?.value ?? "generic") : "generic", name: String(n?.name?.value ?? ""), inForm: dom.inForm.has(b), fileInput: dom.fileInput.has(b) };
  }

  /** D39: whether a key listener sits on the node, an ancestor up to its document (shadow hosts included), or its window. */
  private async keyListened(t: Tab, b: number, dom: DomIndex): Promise<boolean> {
    const group = `agent-computer-${t.uid}`;
    const listened = async (objectId: string): Promise<boolean> => {
      const { listeners } = await this.send<{ listeners: { type: string }[] }>(t, "DOMDebugger.getEventListeners", { objectId });
      return listeners.some((l) => KEY_LISTENERS.has(l.type));
    };
    try {
      let first: string | null = null;
      for (let n: number | undefined = b; n !== undefined; n = dom.names.get(n) === "#document" ? undefined : dom.parent.get(n)) {
        const { object } = await this.send<{ object: { objectId: string } }>(t, "DOM.resolveNode", { backendNodeId: n, objectGroup: group });
        first ??= object.objectId;
        if (await listened(object.objectId)) return true;
      }
      // `window` cannot be redefined by the page, so this is the frame's real window whatever its scripts did.
      const win = await this.send<{ result: { objectId?: string } }>(t, "Runtime.callFunctionOn", { objectId: first, functionDeclaration: "function () { return window; }", objectGroup: group });
      return win.result.objectId ? await listened(win.result.objectId) : true;
    } catch {
      return true; // unreadable: fail towards asking
    } finally {
      await this.send(t, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
    }
  }

  private async mouse(t: Tab, type: "mouseMoved" | "mousePressed" | "mouseReleased", p: Point): Promise<void> {
    await this.send(t, "Input.dispatchMouseEvent", {
      type, x: p.x, y: p.y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1,
    });
  }

  /** Sends a key's events; `before` runs just before each one (typing's focus and validity checks, R76, R78). */
  private async keys(t: Tab, key: string, before: () => void | Promise<void>): Promise<void> {
    // keyEvents throws for a key it does not know before anything is sent.
    for (const e of keyEvents(key)) {
      await before();
      await this.send(t, "Input.dispatchKeyEvent", e);
    }
  }
}
