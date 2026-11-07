// The Computer pane's browser (agent-computer D8, D9, D20, D21, D27, D39, §4.2). Each tab is a WebContentsView in the
// shared `persist:computer` partition, driven through its own `webContents.debugger` (the DevTools protocol in process:
// no port, never the HUD, D20). Navigation is limited to http, https and about:blank on every path (§4.2); permissions,
// downloads and file choosers ask the person through `hooks.ask` (D39); navigations a page starts are noted (D21).
// Password fields are tracked for the document's life and never reach the agent: snapshots redact them and screenshots
// paint over them (D9). Off-screen, the active view sits in an invisible park window so it keeps painting (D27).

import { app, BrowserWindow, dialog, nativeImage, session, WebContentsView } from "electron";
import type { BaseWindow, DownloadItem, Session, WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AskInput } from "./asks";
import { ASK_ROLES, type Target } from "./categories";
import { cdp, CdpTimeout, keyEvents, unlessGone } from "./cdp";
import type { Focus } from "./gate";
import { deviceRects, paintRects, screenScale, type Rect } from "./mask";
import { accepted, reach, within, type Reach } from "./reach";
import { domText, formatSnapshot, indexDom, mergeFrames, SNAPSHOT_CAP, type CdpAxNode, type CdpDomNode, type DomIndex, type Snapshot } from "./snapshot";
import { navAllowed, siteOf } from "../policy/computer-url";

export interface TabInfo { index: number; url: string; title: string; openedBy: string | null; active: boolean }
/** `pageToken` and `tab` say where it was resolved: `click` and `scroll` refuse once either has changed. `judged` holds
 *  every control the gate judged (R26: `backendNodeId` and, when the two walks disagreed, the other one; none when the
 *  element is plain): the click is delivered only while a click at `point` reaches no other control. */
export interface Resolved { target: Target; sensitive: boolean; backendNodeId: number; judged: number[]; point: { x: number; y: number }; pageToken: string; tab: number }
export interface BrowserHooks { ask(i: Pick<AskInput, "why" | "title" | "detail" | "site">): Promise<boolean>; note(text: string): void; changed(): void }

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
// R26: how deep a hit on a shadow host is followed into nested shadow trees, and how many controls of one shadow tree
// are box-tested before the browser gives up telling which one the click reaches.
const SHADOW_DEPTH = 8;
const SHADOW_CANDIDATES = 64;
const CANT_TELL = "Cannot tell which control this click reaches: take a new snapshot.";
const URL_NOTE_MAX = 2_000;
const D9_REFUSAL = "Typing into a password field is refused (D9).";
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
  /** Main-frame commits, for `pageToken()`. */
  seq: number;
  /** The window its view is in. */
  in: BaseWindow | null;
  /** D9: backend ids of fields that were ever sensitive in the current document; `documents` keeps them per loader. */
  sensitive: Set<number>; documents: Map<string, Set<number>>;
  query: ReturnType<typeof setTimeout> | null;
  /** Serialises DOM.getDocument and the node ids it hands out (each call invalidates the last call's ids). */
  lock: Promise<unknown>;
  attaching: Promise<void> | null;
  refs: Snapshot["refs"]; refsToken: string;
  /** The scheme of a main-frame redirect refused during `open()`. */
  refused: string | null;
  /** Set while the tab is being closed, so its own debugger detach is not noted. */
  closing: boolean;
  /** The main frame's current loader, and the isolated world made for that document (remote-focus reads). */
  loader: string; world: { loader: string; contextId: number } | null;
}

interface Handlers { permission(permission: string, url: string): Promise<boolean>; download(item: DownloadItem, wc: WebContents): void }

let nextUid = 1;
const owners = new Map<number, Handlers>();
const reserved = new Set<string>();
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
const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** A file name for the Downloads folder: no folders, no control characters, not hidden, never an existing file. */
function downloadPath(dir: string, suggested: string): string {
  // Bidirectional controls go too: a page-chosen name must not read differently in a note or an ask than on disk.
  const name = path.basename(suggested).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u0000-\u001f\u007f/\\:]/g, "_").replace(/^\.+/, "").trim() || "download";
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; ; i++) {
    const file = path.join(dir, i ? `${stem} (${i})${ext}` : name);
    if (!reserved.has(file) && !fs.existsSync(file)) return file;
  }
}

export class ComputerBrowser {
  private list: Tab[] = [];
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

  tabs(): TabInfo[] {
    return this.list.map((t, index) => ({ index, url: t.wc.getURL(), title: t.wc.getTitle(), openedBy: t.openedBy, active: index === this.current }));
  }

  /** Changes on every main-frame navigation commit of the active tab, and when the active tab changes. */
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
    return { url: t.wc.getURL(), title: t.wc.getTitle() };
  }

  /** Makes tab `index` the active one. */
  select(index: number): void {
    this.tab(index);
    this.current = index;
    this.place();
    this.o.hooks.changed();
  }

  /** Closes tab `index`; the next tab (or the last one) becomes active. */
  close(index: number): void {
    this.drop(this.tab(index));
    if (index < this.current) this.current--;
    this.current = Math.min(this.current, this.list.length - 1);
    this.place();
    this.o.hooks.changed();
  }

  async snapshot(tab?: number): Promise<Snapshot> {
    const t = this.tab(tab);
    const dom = await this.locked(t, () => this.readDom(t));
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
    const url = t.wc.getURL();
    const snap = formatSnapshot(mergeFrames(trees, dom), { origin: siteOf(url) ?? "null", url, title: t.wc.getTitle(), sensitive: t.sensitive, cap: SNAPSHOT_CAP });
    t.refs = snap.refs;
    t.refsToken = this.tokenOf(t);
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
   * there reaches by either walk (`judgeReach`); `click()` delivers at exactly that point.
   */
  async resolve(by: { ref: string } | { x: number; y: number }): Promise<Resolved> {
    const t = this.tab();
    const where = { pageToken: this.tokenOf(t), tab: this.current };
    let named: number | null = null;
    let p: Point;
    if ("ref" in by) {
      const ref = t.refs.get(by.ref);
      if (!ref || t.refsToken !== this.tokenOf(t)) throw new Error(`There is no ${by.ref} on this page now: take a new snapshot.`);
      named = ref.backendNodeId;
      await this.send(t, "DOM.scrollIntoViewIfNeeded", { backendNodeId: named }).catch(() => undefined);
      p = centre(await this.box(t, named));
    } else {
      p = { x: by.x, y: by.y };
    }
    p = { x: Math.round(p.x), y: Math.round(p.y) };
    await this.hover(t, p);
    const { hit, dom, reached } = await this.reachAt(t, p, (h, d) => {
      if (named !== null && h !== named && !within(d, h, named) && !within(d, named, h)) throw new Error("Something else covers that element now: take a new snapshot.");
    });
    const target = await this.judgeReach(t, reached, dom);
    const b = reached.controls[0] ?? hit;
    return { target, sensitive: [hit, ...reached.controls].some((n) => t.sensitive.has(n)), backendNodeId: b, judged: reached.controls, point: p, ...where };
  }

  /** What has keyboard focus (D39), and whether it is a password field (D9). */
  async focus(): Promise<Focus> {
    const t = this.tab();
    const f = await this.focused(t);
    // D9: focus inside a frame from another site counts as sensitive, so typing there is refused.
    if (f === "remote") return { target: await this.remoteTarget(t), sensitive: true, plainTextarea: false };
    if (!f) return { target: null, sensitive: false, plainTextarea: false };
    const target = await this.targetOf(t, f.b, f.dom);
    const plainTextarea = f.dom.names.get(f.b) === "TEXTAREA" && !(await this.keyListened(t, f.b, f.dom));
    return { target, sensitive: t.sensitive.has(f.b), plainTextarea };
  }

  async click(r: Resolved): Promise<void> {
    const t = this.where(r);
    if (typeof r.backendNodeId !== "number") throw new Error("The page changed: look again.");
    const p = r.point;
    // R26: hover the point again, hit-test, read the DOM and walk again, and deliver only while a click there reaches no
    // control the gate did not judge; the press follows the check with no move in between.
    await this.hover(t, p);
    const now = await this.reachAt(t, p).catch((e: unknown) => { if (e instanceof CdpTimeout) throw e; return null; });
    if (!now) throw new Error("The page changed: look again.");
    const ok = now.dom.remoteFrames.has(now.hit) ? now.hit === r.backendNodeId : accepted(now.dom, now.reached, { b: r.backendNodeId, controls: r.judged ?? [] });
    if (!ok) throw new Error("The page changed: look again.");
    await this.mouse(t, "mousePressed", p);
    await this.mouse(t, "mouseReleased", p);
  }

  /** Types into the focused element: Input.insertText in 200-character chunks, each newline as Enter. */
  async type(text: string, keepGoing: () => boolean): Promise<void> {
    const t = this.tab();
    const lines = text.split(/\r\n|\r|\n/);
    for (const [i, line] of lines.entries()) {
      if (i > 0) {
        if (!keepGoing()) return;
        await this.keys(t, "Enter");
      }
      const chars = Array.from(line);
      for (let k = 0; k < chars.length; k += CHUNK) {
        if (!keepGoing()) return;
        // D9: the gate refuses typing into a password field; focus can move while typing, so each chunk checks again.
        await this.refuseSensitiveFocus(t);
        await this.send(t, "Input.insertText", { text: chars.slice(k, k + CHUNK).join("") });
      }
    }
  }

  async key(key: string): Promise<void> {
    const t = this.tab();
    const events = keyEvents(key);
    // D9: a key that types (not Enter, which submits) into a password field is typing into it.
    if (events.some((e) => e.text !== undefined && e.text !== "\r")) await this.refuseSensitiveFocus(t);
    for (const e of events) await this.send(t, "Input.dispatchKeyEvent", e);
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

  /** The active tab, if `r` was resolved on it and the page has not moved since. */
  private where(r: Resolved): Tab {
    const t = this.tab();
    if (r.tab !== this.current || r.pageToken !== this.tokenOf(t)) throw new Error("The page changed: look again.");
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
      uid: nextUid++, view, wc: view.webContents, openedBy: by, seq: 0, in: null, sensitive, documents: new Map([["", sensitive]]),
      query: null, lock: Promise.resolve(), attaching: null, refs: new Map(), refsToken: "", refused: null, closing: false,
      loader: "", world: null,
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
    wc.on("did-start-navigation", (e) => { if (e.isMainFrame && !e.isSameDocument && e.initiator && navAllowed(e.url)) note(`The page went to ${clipUrl(e.url)}`); });
    wc.on("did-navigate", () => { t.seq++; this.o.hooks.changed(); });
    wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => { if (isMainFrame) { t.seq++; this.o.hooks.changed(); } });
    wc.on("page-title-updated", () => this.o.hooks.changed());
    wc.on("render-process-gone", (_e, d) => note(`The page ${clipUrl(wc.getURL())} stopped (${d.reason}).`));
    wc.on("select-bluetooth-device", (e, _devices, cb) => { e.preventDefault(); cb(""); });
    wc.debugger.on("message", (_e, method: string, params: Record<string, unknown>) => this.onCdp(t, method, params));
    wc.debugger.on("detach", (_e, reason: string) => { if (!t.closing) note(`The tab's DevTools connection closed (${reason}); the next action reconnects.`); });
  }

  private onCdp(t: Tab, method: string, p: Record<string, unknown>): void {
    switch (method) {
      case "Page.frameNavigated": {
        const frame = p.frame as { parentId?: string; loaderId: string };
        if (frame.parentId) break;
        // D9: a document keeps its sensitive set for its life (a back/forward-cache restore brings its set back).
        t.loader = frame.loaderId;
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
    if (this.list.length >= MAX_TABS) { this.o.hooks.note(`The page tried to open ${clipUrl(d.url)} in a new tab; ${MAX_TABS} tabs are open.`); return; }
    const nt = await this.addTab(t.openedBy);
    this.o.hooks.note(`The page opened ${clipUrl(d.url)} in a new tab.`);
    const post = d.postBody;
    // A form posted into a new tab keeps its fields, never a file from this Mac (only raw data is passed on).
    const raw = post?.data.filter((x): x is Electron.UploadRawData => x.type === "rawData") ?? [];
    await nt.wc.loadURL(new URL(d.url).href, {
      httpReferrer: d.referrer,
      ...(post && raw.length ? { postData: raw, extraHeaders: `Content-Type: ${post.contentType}${post.boundary ? `; boundary=${post.boundary}` : ""}` } : {}),
    }).catch(() => undefined);
  }

  private askPermission(permission: string, url: string): Promise<boolean> {
    const site = siteOf(url);
    return this.o.hooks.ask({ why: "permission", title: `Let ${hostOf(site, url)} use ${permission}?`, detail: `The page asked for the "${permission}" permission.`, site });
  }

  private download(item: DownloadItem, wc: WebContents): void {
    const file = downloadPath(app.getPath("downloads"), item.getFilename());
    const name = path.basename(file);
    reserved.add(file);
    item.setSavePath(file);
    item.pause();
    const site = siteOf(item.getURL()) ?? siteOf(wc.getURL());
    const bytes = item.getTotalBytes();
    const done = (ok: boolean): void => {
      if (!ok) { reserved.delete(file); item.cancel(); return; }
      item.once("done", (_e, state) => {
        reserved.delete(file);
        this.o.hooks.note(state === "completed" ? `Downloaded ${name} to ${file}` : `The download of ${name} was ${state}.`);
      });
      item.resume();
    };
    this.o.hooks.ask({
      why: "download", title: `Download ${name} from ${hostOf(site, item.getURL())}?`,
      detail: bytes > 0 ? `${name}, ${Math.max(1, Math.round(bytes / 1024))} KB, into Downloads` : `${name}, into Downloads`, site,
    }).then(done, () => done(false));
  }

  private async chooseFile(t: Tab, p: { mode: string; backendNodeId?: number }): Promise<void> {
    const url = t.wc.getURL(), site = siteOf(url);
    const ok = await this.o.hooks.ask({ why: "file", title: `Give ${hostOf(site, url)} a file?`, detail: "The page asked for a file from this Mac.", site }).catch(() => false);
    if (!ok || p.backendNodeId === undefined) return;
    const opts: Electron.OpenDialogOptions = { properties: p.mode === "selectMultiple" ? ["openFile", "multiSelections"] : ["openFile"] };
    const host = this.host();
    const r = host && host.isVisible() ? await dialog.showOpenDialog(host, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths.length) return;
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
    const { root } = await this.send<{ root: CdpDomNode }>(t, "DOM.getDocument", { depth: -1, pierce: true });
    const dom = indexDom(root);
    for (const r of dom.roots) {
      // A root that went away has nothing to hide; a timeout or any other failure fails the read (D9 never fails open).
      const { nodeIds } = await this.send<{ nodeIds: number[] }>(t, "DOM.querySelectorAll", { nodeId: r.nodeId, selector: SENSITIVE }).catch(unlessGone({ nodeIds: [] as number[] }));
      for (const id of nodeIds) {
        const b = dom.backendOf.get(id);
        if (b !== undefined) t.sensitive.add(b);
      }
    }
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
  private async focused(t: Tab): Promise<{ b: number; dom: DomIndex } | "remote" | null> {
    // A cross-site frame's document is in another process, out of this debugger's reach (so is anything inside one):
    // treated as sensitive, so typing into it is refused rather than judged blind (D9).
    const main = t.wc.mainFrame.processId;
    for (let f = t.wc.focusedFrame; f; f = f.parent) if (f.processId !== main) return "remote";
    return this.locked(t, async () => {
      const dom = await this.readDom(t);
      // :focus matches in the deepest root that holds focus (an iframe's document, a shadow root), so every root is asked.
      let best: { b: number; depth: number } | null = null;
      for (const r of dom.roots) {
        const { nodeIds } = await this.send<{ nodeIds: number[] }>(t, "DOM.querySelectorAll", { nodeId: r.nodeId, selector: ":focus" }).catch(unlessGone({ nodeIds: [] as number[] }));
        for (const id of nodeIds) {
          const b = dom.backendOf.get(id);
          if (b !== undefined && (!best || r.depth >= best.depth)) best = { b, depth: r.depth };
        }
      }
      return best ? { b: best.b, dom } : null;
    });
  }

  /** D9: refuses when focus is on a field that was ever sensitive, or inside a frame from another site. */
  private async refuseSensitiveFocus(t: Tab): Promise<void> {
    const f = await this.focused(t);
    if (f === "remote" || (f && t.sensitive.has(f.b))) throw new Error(D9_REFUSAL);
  }

  /** The frame element holding focus that lives in another site's process, read through `document.activeElement` in an
   *  isolated world (DOM :focus does not match it); a generic frame target when it cannot be read. */
  private async remoteTarget(t: Tab): Promise<Target> {
    const frame: Target = { role: "Iframe", name: "", inForm: false, fileInput: false, opaque: true };
    const group = `agent-computer-focus-${t.uid}`;
    try {
      const objectId = await this.activeElement(t, group);
      if (!objectId) return frame;
      const { node } = await this.send<{ node: { backendNodeId: number } }>(t, "DOM.describeNode", { objectId });
      const dom = await this.locked(t, () => this.readDom(t));
      return { ...(await this.targetOf(t, node.backendNodeId, dom)), opaque: true };
    } catch (e) {
      if (e instanceof CdpTimeout) throw e;
      return frame;
    } finally {
      await this.send(t, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
    }
  }

  /** `ACTIVE_ELEMENT` in the main frame's isolated world, made once per document (a stale one is replaced once). */
  private async activeElement(t: Tab, group: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!t.world || t.world.loader !== t.loader) {
        const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>(t, "Page.getFrameTree");
        const { executionContextId } = await this.send<{ executionContextId: number }>(t, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "agent-computer" });
        t.world = { loader: t.loader, contextId: executionContextId };
      }
      try {
        const { result } = await this.send<{ result: { objectId?: string } }>(t, "Runtime.evaluate", { expression: ACTIVE_ELEMENT, contextId: t.world.contextId, objectGroup: group });
        return result.objectId;
      } catch (e) {
        if (e instanceof CdpTimeout) throw e;
        t.world = null;
      }
    }
    return undefined;
  }

  /** The node a click at `p` would hit. */
  private async hitAt(t: Tab, p: Point): Promise<number> {
    try {
      const { backendNodeId } = await this.send<{ backendNodeId: number }>(t, "DOM.getNodeForLocation", { x: p.x, y: p.y, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
      return backendNodeId;
    } catch (e) {
      if (e instanceof Error && /^No node found at given location/.test(e.message)) throw new Error("There is nothing at that point on the page.");
      throw e;
    }
  }

  /** Moves the pointer to `p` and gives hover styles and handlers a moment to apply. */
  private async hover(t: Tab, p: Point): Promise<void> {
    await this.mouse(t, "mouseMoved", p);
    await sleep(HOVER_MS);
  }

  /**
   * What a click at `p` reaches now (R26): the hit test comes first and the DOM is read after it, so the facts read
   * (form, file input) include the hit node; `check` sees the hit before it is followed into a shadow tree. A hit on a
   * shadow host resolves into its shadow tree at the point; then both walks (./reach) look for the control.
   */
  private async reachAt(t: Tab, p: Point, check?: (hit: number, dom: DomIndex) => void): Promise<{ hit: number; dom: DomIndex; reached: Reach }> {
    const first = await this.hitAt(t, p);
    const dom = await this.locked(t, () => this.readDom(t));
    if (!dom.names.has(first)) throw new Error("The page changed: look again.");
    check?.(first, dom);
    const hit = dom.remoteFrames.has(first) ? first : await this.intoShadow(t, first, p, dom);
    if (dom.remoteFrames.has(hit)) return { hit, dom, reached: { hit, controls: [hit] } };
    const { nodes } = await this.send<{ nodes: CdpAxNode[] }>(t, "Accessibility.getPartialAXTree", { backendNodeId: hit, fetchRelatives: true }).catch(unlessGone({ nodes: [] as CdpAxNode[] }));
    return { hit, dom, reached: reach(dom, hit, nodes) };
  }

  /** A hit on a shadow host (a bare slotted text node climbs to its host in the hit test): the deepest control of its
   *  shadow tree whose box holds the point is what the click reaches; a nested host there is looked into in turn. */
  private async intoShadow(t: Tab, hit: number, p: Point, dom: DomIndex): Promise<number> {
    for (let round = 0; round < SHADOW_DEPTH; round++) {
      const roots = dom.shadowRoots.get(hit);
      if (!roots?.length) return hit;
      const candidates: number[] = [];
      const stack = [...roots];
      while (stack.length) {
        const n = stack.pop()!;
        if (dom.activatable.has(n) || dom.shadowRoots.has(n)) {
          candidates.push(n);
          if (candidates.length > SHADOW_CANDIDATES) throw new Error(CANT_TELL);
        }
        stack.push(...(dom.children.get(n) ?? []));
      }
      let best: { b: number; depth: number } | null = null;
      for (const c of candidates) {
        const { quads } = await this.send<{ quads: number[][] }>(t, "DOM.getContentQuads", { backendNodeId: c }).catch(unlessGone({ quads: [] as number[][] }));
        if (!quads.map(quadRect).some((r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height)) continue;
        let depth = 0;
        for (let n = dom.parent.get(c); n !== undefined; n = dom.parent.get(n)) depth++;
        if (!best || depth > best.depth) best = { b: c, depth };
      }
      if (!best) return hit;
      if (dom.activatable.has(best.b)) return best.b;
      hit = best.b;
    }
    return hit;
  }

  /** The target the gate judges for what a click reaches (D43 reads role and label): a frame from another site
   *  (opaque); a plain element as it is; one control by its name; or, when the two walks found different controls, both
   *  names joined so the click asks if either matches, refused when either cannot be named. */
  private async judgeReach(t: Tab, r: Reach, dom: DomIndex): Promise<Target> {
    if (dom.remoteFrames.has(r.hit)) return { ...(await this.targetOf(t, r.hit, dom)), opaque: true };
    if (!r.controls.length) return this.targetOf(t, r.hit, dom);
    const targets: Target[] = [];
    for (const c of r.controls) targets.push(await this.named(t, c, dom));
    if (targets.length === 1) return targets[0];
    if (targets.some((x) => !x.name)) throw new Error(CANT_TELL);
    const [a, b] = targets;
    const name = a.name.toLowerCase().includes(b.name.toLowerCase()) ? a.name : `${a.name} (${b.name})`;
    return { role: targets.find((x) => ASK_ROLES.has(x.role))?.role ?? a.role, name, inForm: a.inForm || b.inForm, fileInput: a.fileInput || b.fileInput };
  }

  /** A control's role and name: from the accessibility tree, with its markup role where that tree hides it, and its own
   *  markup name and text added when the accessible name does not already contain them (a <label for> names a Buy
   *  button "Learn more"; aria-owns moves its text away). D9: nothing a person typed becomes a name, so a text field or
   *  a sensitive node gets no markup hint and no text. */
  private async named(t: Tab, b: number, dom: DomIndex): Promise<Target> {
    const ax = await this.targetOf(t, b, dom);
    const native = dom.roles.get(b);
    const role = native && (ax.role === "generic" || ax.role === "none" || ax.role === "") ? native : ax.role;
    let name = ax.name;
    if (!dom.textFields.has(b) && !t.sensitive.has(b)) {
      for (const extra of [dom.hints.get(b), domText(dom, b)]) {
        if (extra && !name.toLowerCase().includes(extra.toLowerCase())) name = name ? `${name} (${extra})` : extra;
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

  private async keys(t: Tab, key: string): Promise<void> {
    // keyEvents throws for a key it does not know before anything is sent.
    for (const e of keyEvents(key)) await this.send(t, "Input.dispatchKeyEvent", e);
  }
}
