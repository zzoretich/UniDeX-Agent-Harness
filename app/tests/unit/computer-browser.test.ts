// The Computer browser's delivery checks (agent-computer D9, D31, D39; R76), against a fake DevTools page: the input a
// click, a key or typing sends, and what stops it, at the moment each event would go. The unit bundle's electron is an
// empty stand-in (electron-stub.cjs), so the session and the file dialog the browser uses are given here; a tab is put
// in the browser as it would be once attached, its webContents a stand-in whose debugger answers from `FakePage`.

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import electron from "electron";
import { ComputerBrowser, type BrowserHooks, type Resolved } from "../../src/main/computer/browser";
import { FocusMoved, PageChanged } from "../../src/main/computer/cdp";
import { LeavingRecords, PendingReads } from "../../src/main/computer/leaving";
import { SecretMemory } from "../../src/main/computer/memory";
import { TABS_MAX } from "../../src/main/computer/records";
import type { CdpDomNode } from "../../src/main/computer/snapshot";

type Dialog = (...a: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>;
const stub = electron as unknown as Record<string, unknown>;
let showOpenDialog: Dialog = async () => ({ canceled: false, filePaths: [] });
stub.session = { fromPartition: () => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, on() {} }) };
stub.dialog = { showOpenDialog: (...a: unknown[]) => showOpenDialog(...a) };
stub.app = { getPath: () => os.tmpdir() };


/** A page in frame F1: two buttons both named "Go" (10, 11) and a text field "Search" (12). */
class FakePage {
  focused: number | null = 10;
  hit = 10;
  url = "https://a.test/";
  /** R82: the document the renderer holds now. A new one numbers its nodes afresh (+1000 per document), as DevTools does,
   *  and can be in place before main hears of its commit (the tab's seq, navs and doc unchanged). */
  doc = 0;
  /** Nodes the page has taken out of its document (a re-render), by their number within it. */
  removed = new Set<number>();
  sent: { method: string; params: Record<string, unknown> }[] = [];
  /** A layout, when a test gives one: each node's box in the document's coordinates, and how far the page is scrolled.
   *  DOM.getContentQuads then answers in the viewport's coordinates, and DOM.getNodeForLocation reads its x and y as the
   *  document's, as Blink does (InspectorDOMAgent::getNodeForLocation converts them with DocumentToFrame): a point
   *  that falls above or left of the frame hits nothing, and one on no box hits the body. */
  boxes: Map<number, { x: number; y: number; width: number; height: number }> | null = null;
  scroll = { x: 0, y: 0 };
  /** A list of buttons the accessibility tree prints, in order (`b` is the node, as in the DOM below), when a test reads the
   *  page as text; null leaves the tree empty. */
  ax: { b: number; name: string }[] | null = null;
  /** Runs when the page receives `method`, before it answers (a Take over or a focus move landing mid-read); one that
   *  throws makes that command fail. */
  on = new Map<string, (params: Record<string, unknown>) => void>();
  private node(n: number, name: string, attrs: string[], text?: string): CdpDomNode {
    const b = n + this.doc * 1000;
    return { nodeId: b, backendNodeId: b, nodeType: 1, nodeName: name, attributes: attrs, children: text ? [{ nodeId: b + 100, backendNodeId: b + 100, nodeType: 3, nodeName: "#text", nodeValue: text }] : [] };
  }
  root(): CdpDomNode {
    const o = this.doc * 1000;
    const body = [this.node(10, "BUTTON", ["id", "b1"], "Go"), this.node(11, "BUTTON", ["id", "b2"], "Go"), this.node(12, "INPUT", ["id", "q", "aria-label", "Search"]),
      ...(this.ax ?? []).map((x) => this.node(x.b, "BUTTON", ["id", `x${x.b}`], x.name))]
      .filter((n) => !this.removed.has(n.backendNodeId - o));
    return {
      nodeId: 1 + o, backendNodeId: 1 + o, nodeType: 9, nodeName: "#document", children: [{
        nodeId: 2 + o, backendNodeId: 2 + o, nodeType: 1, nodeName: "HTML", frameId: "F1", children: [{ nodeId: 3 + o, backendNodeId: 3 + o, nodeType: 1, nodeName: "BODY", children: body }],
      }],
    };
  }
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params });
    this.on.get(method)?.(params);
    switch (method) {
      case "DOM.getDocument": return { root: this.root() };
      case "DOM.querySelectorAll": return { nodeIds: params.selector === ":focus" && this.focused !== null ? [this.focused] : [] };
      case "Page.createIsolatedWorld": return { executionContextId: 1 };
      case "Page.getFrameTree": return { frameTree: { frame: { id: "F1" } } };
      case "Accessibility.getFullAXTree": {
        const o = this.doc * 1000, list = this.ax ?? [];
        return { nodes: [
          { nodeId: "root", ignored: false, role: { value: "RootWebArea" }, name: { value: "" }, childIds: list.map((x) => `n${x.b}`), backendDOMNodeId: 2 + o },
          ...list.map((x) => ({ nodeId: `n${x.b}`, ignored: false, role: { value: "button" }, name: { value: x.name }, childIds: [] as string[], backendDOMNodeId: x.b + o })),
        ] };
      }
      case "DOM.getNodeForLocation": {
        if (!this.boxes) return { backendNodeId: this.hit };
        const x = params.x as number, y = params.y as number;
        if (x - this.scroll.x < 0 || y - this.scroll.y < 0) throw new Error("No node found at given location");
        return { backendNodeId: this.nodeAt(x, y) };
      }
      case "DOM.getContentQuads": {
        const r = this.boxes?.get((params.backendNodeId as number) - this.doc * 1000);
        if (!r) return { quads: [] };
        const x = r.x - this.scroll.x, y = r.y - this.scroll.y;
        return { quads: [[x, y, x + r.width, y, x + r.width, y + r.height, x, y + r.height]] };
      }
      case "Page.getLayoutMetrics": {
        const view = { pageX: this.scroll.x, pageY: this.scroll.y, clientWidth: 400, clientHeight: 300 };
        return { cssLayoutViewport: view, cssVisualViewport: { ...view, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 } };
      }
      case "Accessibility.getPartialAXTree": {
        const b = params.backendNodeId as number;
        const role = b === 12 ? "textbox" : b === 10 || b === 11 ? "button" : "generic";
        return { nodes: [{ nodeId: String(b), ignored: false, role: { value: role }, name: { value: b === 12 ? "Search" : b === 10 || b === 11 ? "Go" : "" }, backendDOMNodeId: b }] };
      }
      default: return {};
    }
  }
  /** With a layout: the node at document point (x, y), the topmost box holding it, else the body. */
  nodeAt(x: number, y: number): number {
    const on = [...(this.boxes ?? [])].reverse().find(([, r]) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
    return on ? on[0] + this.doc * 1000 : 3 + this.doc * 1000;
  }
  inputs(): string[] {
    return this.sent.filter((s) => s.method.startsWith("Input.")).map((s) => `${s.method}:${String(s.params.type ?? s.params.text ?? "")}`);
  }
  /** The mouse events sent, as [type, x, y], x and y in the viewport's coordinates as Input.dispatchMouseEvent takes them. */
  mice(): [string, number, number][] {
    return this.sent.filter((s) => s.method === "Input.dispatchMouseEvent").map((s) => [String(s.params.type), s.params.x as number, s.params.y as number]);
  }
  /** The key events sent, as `type key` ("rawKeyDown Shift"). */
  keys(): string[] {
    return this.sent.filter((s) => s.method === "Input.dispatchKeyEvent").map((s) => `${String(s.params.type)} ${String(s.params.key)}`);
  }
}

/** A browser with one tab on `page`, active; `notes` collects its hooks' notes, `asks` answers its asks. */
function make(page = new FakePage(), answer: () => Promise<boolean> = async () => true) {
  const notes: string[] = [];
  const asked: string[] = [];
  const hooks: BrowserHooks = { ask: async (i) => { asked.push(i.title); return answer(); }, note: (s) => notes.push(s), changed: () => {} };
  const b = new ComputerBrowser({ key: "ws:alpha", window: () => null, hooks });
  // Electron's navigation history and reload, recorded (session-browser S13).
  const nav = { back: false, forward: false, moves: [] as string[] };
  const wc = {
    navigationHistory: {
      canGoBack: () => nav.back, canGoForward: () => nav.forward,
      goBack: () => { nav.moves.push("back"); }, goForward: () => { nav.moves.push("forward"); },
    },
    reload: () => { nav.moves.push("reload"); },
    id: 1, isDestroyed: () => false, isDevToolsOpened: () => false, getURL: () => page.url, getTitle: () => "", getZoomFactor: () => 1,
    mainFrame: { processId: 1 }, focusedFrame: null,
    debugger: { isAttached: () => true, sendCommand: (m: string, p?: Record<string, unknown>) => page.send(m, p) },
  };
  const sensitive = new Set<number>();
  const tab = {
    uid: 1, view: null, wc, openedBy: null, seq: 0, navs: 0, doc: 0, in: null, sensitive, documents: new Map([["", sensitive]]),
    query: null, lock: Promise.resolve(), attaching: null, refs: new Map(), refused: null, closing: false, worlds: new Map(),
    memory: new SecretMemory(), frame: "F1", frames: [], fieldFrames: new Map(), detached: new Set(), placed: false, mainDocs: 0,
    leaving: new LeavingRecords(), reads: new PendingReads(), opened: null, urlHidden: false, pathHidden: false, flooded: false,
  };
  const inner = b as unknown as { list: unknown[]; current: number };
  inner.list.push(tab);
  inner.current = 0;
  return { b, page, tab, notes, asked, nav };
}

const at = (tab: { seq: number }) => ({ tab: 0, pageToken: `1.${tab.seq}` });
const resolved = (o: Partial<Resolved> = {}): Resolved => ({
  target: { role: "button", name: "Go", inForm: false, fileInput: false }, shown: "Go", sensitive: false, backendNodeId: 10, judged: [10],
  point: { x: 5, y: 5 }, pageToken: "1.0", tab: 0, ...o,
});

test("the harness: a click hovers, checks what it reaches and presses", async () => {
  const { b, page } = make();
  await b.click(resolved(), () => true);
  assert.deepEqual(page.inputs(), ["Input.dispatchMouseEvent:mouseMoved", "Input.dispatchMouseEvent:mousePressed", "Input.dispatchMouseEvent:mouseReleased"]);
});

// ---- R76 (S-AC-04): focus by node identity

test("R76: focus() names the focused element's backend DOM node and its frame, so two same-named buttons differ", async () => {
  const { b, page } = make();
  const first = await b.focus();
  assert.deepEqual([first.target?.role, first.target?.name, first.node, first.frame], ["button", "Go", 10, "F1"]);
  page.focused = 11;
  const second = await b.focus();
  assert.deepEqual([second.target?.role, second.target?.name, second.node, second.frame], ["button", "Go", 11, "F1"]);
  page.focused = null;
  const none = await b.focus();
  assert.deepEqual([none.target, none.node, none.frame], [null, null, null]);
});

test("R76: a key goes only while the node it was judged on still has focus: moved to a same-named button, nothing is sent", async () => {
  const { b, page, tab } = make();
  page.focused = 11;
  await assert.rejects(b.key("Space", () => true, at(tab), { node: 10, frame: "F1" }), PageChanged);
  assert.deepEqual(page.inputs(), []);
  page.focused = 10;
  await b.key("Space", () => true, at(tab), { node: 10, frame: "F1" });
  assert.deepEqual(page.inputs(), ["Input.dispatchKeyEvent:keyDown", "Input.dispatchKeyEvent:keyUp"]);
});

test("R76: typing's first chunk goes only while the node it was judged on still has focus", async () => {
  const { b, page, tab } = make();
  page.focused = 10;
  await assert.rejects(b.type("rope", () => true, at(tab), { node: 12, frame: "F1" }), PageChanged);
  assert.deepEqual(page.inputs(), []);
  page.focused = 12;
  await b.type("rope", () => true, at(tab), { node: 12, frame: "F1" });
  assert.deepEqual(page.inputs(), ["Input.insertText:rope"]);
});

// ---- R76 (S-AC-03): the validity predicate before every input event

test("R76: a Take over that lands during the click's hit test sends no mousePressed", async () => {
  const { b, page } = make();
  let held = true;
  page.on.set("DOM.getNodeForLocation", () => { held = false; });
  await assert.rejects(b.click(resolved(), () => held), PageChanged);
  assert.deepEqual(page.inputs(), ["Input.dispatchMouseEvent:mouseMoved"], "the hover went before; nothing after the hit test");
});

test("R76: the wheel lost after the press sends no release, and lost before the hover sends nothing", async () => {
  const { b, page } = make();
  let held = true;
  page.on.set("Input.dispatchMouseEvent", () => { if (page.inputs().at(-1)?.endsWith("mousePressed")) held = false; });
  await assert.rejects(b.click(resolved(), () => held), PageChanged);
  assert.deepEqual(page.inputs(), ["Input.dispatchMouseEvent:mouseMoved", "Input.dispatchMouseEvent:mousePressed"]);
  page.sent.length = 0;
  await assert.rejects(b.click(resolved(), () => false), PageChanged);
  assert.deepEqual(page.inputs(), []);
});

test("R76: a key whose wheel is lost during the focus read sends no key event", async () => {
  const { b, page, tab } = make();
  await b.key("Tab", () => true, at(tab), { node: 10, frame: "F1" });
  assert.deepEqual(page.inputs(), ["Input.dispatchKeyEvent:rawKeyDown", "Input.dispatchKeyEvent:keyUp"], "held, it goes");
  page.sent.length = 0;
  let held = true;
  page.on.set("DOM.querySelectorAll", () => { held = false; });
  await assert.rejects(b.key("Tab", () => held, at(tab), { node: 10, frame: "F1" }), PageChanged);
  assert.deepEqual(page.inputs(), []);
});

test("R76: typing whose wheel is lost during the sensitive-focus read types nothing, and a chord stops between its events", async () => {
  const { b, page, tab } = make();
  page.focused = 12;
  let held = true;
  page.on.set("DOM.querySelectorAll", () => { held = false; });
  await b.type("rope", () => held, at(tab), { node: 12, frame: "F1" });
  assert.deepEqual(page.inputs(), [], "nothing typed after the read that saw the wheel go");
  page.on.clear();
  held = true;
  page.on.set("Input.dispatchKeyEvent", () => { held = false; });
  await assert.rejects(b.key("Shift+Tab", () => held, at(tab)), PageChanged);
  assert.deepEqual(page.keys(), ["rawKeyDown Shift"], "Shift went down; Tab never followed, and with the wheel gone Shift's up is withheld too (R81)");
});

// ---- R76 (T-AC-03): a file chooser is bound to its page

type Chooser = { chooseFile(t: unknown, p: { mode: string; backendNodeId?: number }): Promise<void> };
const setFiles = (page: FakePage) => page.sent.filter((s) => s.method === "DOM.setFileInputFiles").map((s) => s.params.files);

test("R76: a file chooser whose page is unchanged gets the chosen file after Allow", async () => {
  const { b, page, tab, notes, asked } = make();
  showOpenDialog = async () => ({ canceled: false, filePaths: ["/files/tide.csv"] });
  await (b as unknown as Chooser).chooseFile(tab, { mode: "selectSingle", backendNodeId: 12 });
  assert.deepEqual(asked, ["Give a.test a file?"]);
  assert.deepEqual(setFiles(page), [["/files/tide.csv"]]);
  assert.deepEqual(notes, []);
});

test("R76: a page that changed before the Allow gets no file and no dialog opens; a note says why", async () => {
  let dialogs = 0;
  showOpenDialog = async () => { dialogs++; return { canceled: false, filePaths: ["/files/tide.csv"] }; };
  const page = new FakePage();
  const box: { tab?: { seq: number } } = {};
  const { b, tab, notes } = make(page, async () => { box.tab!.seq++; return true; });
  box.tab = tab;
  await (b as unknown as Chooser).chooseFile(tab, { mode: "selectSingle", backendNodeId: 12 });
  assert.equal(dialogs, 0);
  assert.deepEqual(setFiles(page), []);
  assert.deepEqual(notes, ["No file was given to a.test: its page changed or closed before you chose one."]);
});

test("R76: a page that changed, or a tab that closed, while the dialog was open gets no file; a note says why", async () => {
  const { b, page, tab, notes } = make();
  showOpenDialog = async () => { tab.seq++; return { canceled: false, filePaths: ["/files/tide.csv"] }; };
  await (b as unknown as Chooser).chooseFile(tab, { mode: "selectSingle", backendNodeId: 12 });
  assert.deepEqual(setFiles(page), []);
  assert.deepEqual(notes, ["No file was given to a.test: its page changed or closed before you chose one."]);
  const inner = b as unknown as { list: unknown[] };
  showOpenDialog = async () => { inner.list.splice(0, 1); return { canceled: false, filePaths: ["/files/tide.csv"] }; };
  await (b as unknown as Chooser).chooseFile(tab, { mode: "selectSingle", backendNodeId: 12 });
  assert.deepEqual(setFiles(page), []);
  assert.equal(notes.length, 2);
  assert.equal(notes[1], "No file was given to a.test: its page changed or closed before you chose one.");
});

// ---- R78 (AC-R2-01): the judged focus held for the whole action

test("R78: typing rechecks the judged node before every chunk: a page that moves focus after the first chunk gets nothing more", async () => {
  const { b, page, tab } = make();
  page.focused = 12;
  page.on.set("Input.insertText", () => { page.focused = 10; });
  await assert.rejects(b.type("a".repeat(450), () => true, at(tab), { node: 12, frame: "F1" }), FocusMoved);
  assert.deepEqual(page.inputs(), [`Input.insertText:${"a".repeat(200)}`], "the first chunk only");
});

test("R78: a newline after the focus moved sends no Enter", async () => {
  const { b, page, tab } = make();
  page.focused = 12;
  page.on.set("Input.insertText", () => { page.focused = 11; });
  await assert.rejects(b.type("ab\ncd", () => true, at(tab), { node: 12, frame: "F1" }), FocusMoved);
  assert.deepEqual(page.inputs(), ["Input.insertText:ab"]);
  assert.deepEqual(page.keys(), [], "no Enter");
});

test("R78: a chord rechecks the judged node before every event: focus moved after Shift went down sends no Tab", async () => {
  const { b, page, tab } = make();
  page.focused = 10;
  page.on.set("Input.dispatchKeyEvent", () => { page.focused = 11; });
  await assert.rejects(b.key("Shift+Tab", () => true, at(tab), { node: 10, frame: "F1" }), FocusMoved);
  assert.ok(!page.keys().some((k) => k.endsWith(" Tab")), page.keys().join(", "));
  assert.equal(page.keys()[0], "rawKeyDown Shift");
});

// ---- R79: input pairs

test("R79, R81: a chord stopped part way on its document lets its modifiers go, never its main key's up; with the wheel lost none go", async () => {
  const { b, page, tab } = make();
  page.focused = 10;
  // Focus moves once Space went down: Space's up is withheld (it would press whatever has focus now), Shift's up is sent.
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "keyDown  ") page.focused = 11; });
  await assert.rejects(b.key("Shift+Space", () => true, at(tab), { node: 10, frame: "F1" }), FocusMoved);
  assert.deepEqual(page.keys(), ["rawKeyDown Shift", "keyDown  ", "keyUp Shift"]);
  // R81: the wheel lost after the main key's up: the modifier's up is withheld, and the call says the page changed.
  page.sent.length = 0;
  page.on.clear();
  page.focused = 10;
  let held = true;
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "keyUp Tab") held = false; });
  await assert.rejects(b.key("Shift+Tab", () => held, at(tab)), PageChanged);
  assert.deepEqual(page.keys(), ["rawKeyDown Shift", "rawKeyDown Tab", "keyUp Tab"]);
});

test("R79: a press whose page moved its own token (a mousedown handler's pushState) still gets its release", async () => {
  const { b, page, tab } = make();
  page.on.set("Input.dispatchMouseEvent", () => { if (page.inputs().at(-1)?.endsWith("mousePressed")) tab.seq++; });
  await b.click(resolved(), () => true);
  assert.deepEqual(page.inputs(), ["Input.dispatchMouseEvent:mouseMoved", "Input.dispatchMouseEvent:mousePressed", "Input.dispatchMouseEvent:mouseReleased"]);
});

// ---- R78 follow-up: what a key's own keydown does, and a navigation reported as one

test("R78: Tab's own keydown moves focus, so its keyup still goes; Space whose keydown handler moved focus gets no keyup (it would act there)", async () => {
  const { b, page, tab } = make();
  page.focused = 10;
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "rawKeyDown Tab") page.focused = 11; });
  await b.key("Tab", () => true, at(tab), { node: 10, frame: "F1" });
  assert.deepEqual(page.keys(), ["rawKeyDown Tab", "keyUp Tab"]);
  page.sent.length = 0;
  page.focused = 10;
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "keyDown  ") page.focused = 11; });
  await assert.rejects(b.key("Space", () => true, at(tab), { node: 10, frame: "F1" }), FocusMoved);
  assert.deepEqual(page.keys(), ["keyDown  "], "Space went down on the judged button; its up, which would press the other, is withheld");
});

test("R78: typing whose input sends the page elsewhere says the page changed, not that the focus moved", async () => {
  const { b, page, tab } = make();
  page.focused = 12;
  page.on.set("Input.insertText", () => { tab.seq++; page.focused = null; });
  await assert.rejects(b.type("a".repeat(450), () => true, at(tab), { node: 12, frame: "F1" }), (e: unknown) => e instanceof PageChanged && !(e instanceof FocusMoved));
  assert.equal(page.inputs().length, 1);
});

// ---- R80: only the free navigation keys' ups skip the focus read

test("R80: Enter whose keydown moved focus withholds its keyup and says the focus moved; arrows, like Tab, still get theirs", async () => {
  const { b, page, tab } = make();
  page.focused = 12;
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "keyDown Enter") page.focused = 10; });
  await assert.rejects(b.key("Enter", () => true, at(tab), { node: 12, frame: "F1" }), FocusMoved);
  assert.deepEqual(page.keys(), ["keyDown Enter"], "Enter's up is held to the judged element, as type()'s Enter is");
  for (const k of ["ArrowDown", "Escape", "PageDown"]) {
    page.sent.length = 0;
    page.focused = 10;
    page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === `rawKeyDown ${k}`) page.focused = 11; });
    await b.key(k, () => true, at(tab), { node: 10, frame: "F1" });
    assert.deepEqual(page.keys(), [`rawKeyDown ${k}`, `keyUp ${k}`], `${k} moves focus by design: its up still goes`);
  }
});

test("R80: a chord whose main key-down fails to send still lets its modifiers go", async () => {
  const { b, page, tab } = make();
  page.on.set("Input.dispatchKeyEvent", (p) => { if (p.type === "rawKeyDown" && p.key === "Tab") throw new Error("the page did not take the key"); });
  await assert.rejects(b.key("Control+Shift+Tab", () => true, at(tab)), /the page did not take the key/);
  assert.deepEqual(page.keys(), ["rawKeyDown Control", "rawKeyDown Shift", "rawKeyDown Tab", "keyUp Shift", "keyUp Control"], "Tab's down was tried and failed; both modifiers were let go");
});

// ---- R81 (AC-R3-02): a release and a chord's modifier ups go only to the document that got the press, while the call
// is current

/** A main-frame commit of a new document, as `commit()` counts it: the page token moves and so does the document. */
const commitNewDocument = (tab: { seq: number; doc: number }): void => { tab.seq++; tab.doc++; };

test("R81: a mousedown that pushStates (same document) still gets its release", async () => {
  const { b, page, tab } = make();
  page.on.set("Input.dispatchMouseEvent", () => { if (page.inputs().at(-1)?.endsWith("mousePressed")) tab.seq++; });
  await b.click(resolved(), () => true);
  assert.deepEqual(page.inputs(), ["Input.dispatchMouseEvent:mouseMoved", "Input.dispatchMouseEvent:mousePressed", "Input.dispatchMouseEvent:mouseReleased"]);
});

test("R81: a mousedown whose navigation commits a new document gets no release", async () => {
  const { b, page, tab } = make();
  page.on.set("Input.dispatchMouseEvent", () => { if (page.inputs().at(-1)?.endsWith("mousePressed")) commitNewDocument(tab); });
  await assert.rejects(b.click(resolved(), () => true), PageChanged);
  assert.deepEqual(page.inputs(), ["Input.dispatchMouseEvent:mouseMoved", "Input.dispatchMouseEvent:mousePressed"], "the new document never sees a mouseup");
});

test("R81: a Take over between the press and the release withholds the release (the call's predicate stays false after Hand back)", async () => {
  const { b, page } = make();
  let current = true;
  page.on.set("Input.dispatchMouseEvent", () => { if (page.inputs().at(-1)?.endsWith("mousePressed")) current = false; });
  await assert.rejects(b.click(resolved(), () => current), PageChanged);
  assert.deepEqual(page.inputs(), ["Input.dispatchMouseEvent:mouseMoved", "Input.dispatchMouseEvent:mousePressed"]);
});

test("R81: a chord stopped by a cross-document commit or a Take over withholds its modifier ups", async () => {
  const { b, page, tab } = make();
  page.focused = 10;
  // The new document commits once Shift went down: Tab is never sent (its page changed), and neither is Shift's up.
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "rawKeyDown Shift") commitNewDocument(tab); });
  await assert.rejects(b.key("Shift+Tab", () => true, at(tab), { node: 10, frame: "F1" }), PageChanged);
  assert.deepEqual(page.keys(), ["rawKeyDown Shift"]);
  // A Take over once Control and Shift went down: nothing more, their ups included.
  page.sent.length = 0;
  page.on.clear();
  let current = true;
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "rawKeyDown Shift") current = false; });
  await assert.rejects(b.key("Control+Shift+Tab", () => current, at(tab)), PageChanged);
  assert.deepEqual(page.keys(), ["rawKeyDown Control", "rawKeyDown Shift"]);
  // A chord whose main key went in full, then a commit (Control+Enter that submits): Control's up is withheld too.
  page.sent.length = 0;
  page.on.clear();
  page.focused = 12;
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "keyUp Enter") commitNewDocument(tab); });
  await assert.rejects(b.key("Control+Enter", () => true, at(tab)), PageChanged);
  assert.deepEqual(page.keys(), ["rawKeyDown Control", "rawKeyDown Enter", "keyUp Enter"]);
});

test("R81: a chord stopped by a focus move on the same document still lets its modifiers go", async () => {
  const { b, page, tab } = make();
  page.focused = 10;
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "rawKeyDown Shift") page.focused = 11; });
  await assert.rejects(b.key("Shift+Tab", () => true, at(tab), { node: 10, frame: "F1" }), FocusMoved);
  assert.deepEqual(page.keys(), ["rawKeyDown Shift", "keyUp Shift"]);
});

// ---- R82: a focus read that reaches the next document before main hears of its commit reports the page changing

/** The message a delivery was refused with. */
const refusal = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { return (e as Error).message; } return "delivered"; };

test("R82: typing whose input sends the page elsewhere, read on the new document before its commit reaches main, says the page changed", async () => {
  const { b, page, tab } = make();
  page.focused = 12;
  // The first chunk's input event navigates; the renderer has the next document (its own field focused) while the tab's
  // seq, navs and doc still say the old one: the race the e2e run hit (typing.html → landed.html).
  page.on.set("Input.insertText", () => { page.doc = 1; page.focused = 1012; });
  assert.equal(await refusal(b.type("a".repeat(450), () => true, at(tab), { node: 12, frame: "F1" })), "The page changed: look again.");
  assert.deepEqual([tab.seq, tab.navs, tab.doc], [0, 0, 0], "main had heard of no navigation");
  assert.equal(page.inputs().length, 1, "nothing reached the next document");
});

test("R82: a key whose keydown sends the page elsewhere, read on the new document before its commit reaches main, says the page changed and withholds its up", async () => {
  const { b, page, tab } = make();
  page.focused = 10;
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "keyDown  ") { page.doc = 1; page.focused = 1012; } });
  assert.equal(await refusal(b.key("Space", () => true, at(tab), { node: 10, frame: "F1" })), "The page changed: look again.");
  assert.deepEqual(page.keys(), ["keyDown  "]);
});

test("R82: the judged node gone from its document is the page changing; a focus move within the same document is still a focus move", async () => {
  const { b, page, tab } = make();
  page.focused = 12;
  // A re-render took the judged field out and focused a button.
  page.on.set("Input.insertText", () => { page.removed.add(12); page.focused = 10; });
  assert.equal(await refusal(b.type("a".repeat(450), () => true, at(tab), { node: 12, frame: "F1" })), "The page changed: look again.");
  // The field is still there; the focus moved to a button beside it.
  page.sent.length = 0;
  page.removed.clear();
  page.on.set("Input.insertText", () => { page.focused = 10; });
  assert.equal(await refusal(b.type("a".repeat(450), () => true, at(tab), { node: 12, frame: "F1" })), "The focus moved: look again.");
  page.sent.length = 0;
  page.on.clear();
  page.focused = 10;
  page.on.set("Input.dispatchKeyEvent", () => { if (page.keys().at(-1) === "keyDown  ") page.focused = 11; });
  assert.equal(await refusal(b.key("Space", () => true, at(tab), { node: 10, frame: "F1" })), "The focus moved: look again.");
});

test("R82: a commit that lands between the focus read's DOM read and its :focus query (the old document read, its node ids gone) says the page changed", async () => {
  const { b, page, tab } = make();
  page.focused = 12;
  let chunks = 0;
  page.on.set("Input.insertText", () => { chunks++; });
  // After the first chunk, the next focus read gets the old document from DOM.getDocument; the new document commits
  // before its :focus query, which then fails as gone. Page.frameNavigated comes in order on the DevTools session, so main
  // has counted the main-frame commit (mainDocs) though the tab's seq, navs and doc (from webContents events) lag.
  page.on.set("DOM.querySelectorAll", (p) => {
    if (chunks === 1 && p.selector === ":focus") { tab.mainDocs++; throw new Error("Could not find node with given id"); }
  });
  assert.equal(await refusal(b.type("a".repeat(450), () => true, at(tab), { node: 12, frame: "F1" })), "The page changed: look again.");
  assert.deepEqual([tab.seq, tab.navs, tab.doc], [0, 0, 0]);
  assert.equal(page.inputs().length, 1, "nothing more was typed");
});

// ---- CI fix: DOM.getNodeForLocation takes document coordinates, every point here is the viewport's

/** The page laid out as a column (button Go 10, button Go 11 at `second`, the field Search 12 at document y 300–320) and
 *  scrolled down by `scrollY`, with session s1's snapshot naming the field e3. */
function scrolled(scrollY: number, second = { x: 0, y: 40, width: 100, height: 40 }) {
  const m = make();
  m.page.boxes = new Map([[10, { x: 0, y: 0, width: 100, height: 20 }], [11, second], [12, { x: 0, y: 300, width: 100, height: 20 }]]);
  m.page.scroll = { x: 0, y: scrollY };
  const target = { role: "textbox", name: "Search", inForm: false, fileInput: false };
  (m.tab.refs as Map<string, unknown>).set("s1", { refs: new Map([["e3", { backendNodeId: 12, frameId: "F1", target }]]), token: "1.0" });
  return m;
}
const hits = (page: FakePage) => page.sent.filter((s) => s.method === "DOM.getNodeForLocation").map((s) => [s.params.x, s.params.y]);
/** The press and the release sent, as [type, x, y] in the viewport's coordinates. */
const pressed = (page: FakePage) => page.mice().filter(([type]) => type !== "mouseMoved");
/** The node the press reached: the one at its viewport point plus the page's scroll at the time of the check. */
const landed = (page: FakePage) => {
  const [, x, y] = page.mice().find(([type]) => type === "mousePressed") ?? ["", NaN, NaN];
  return page.nodeAt(x + page.scroll.x, y + page.scroll.y);
};

test("a ref the page has scrolled into view is hit-tested where it is: the scroll is added to the viewport point", async () => {
  // Scrolled by 250, the field's box is at 50–70 in the viewport; at document y 60 (no scroll added) is the second button.
  const { b, page } = scrolled(250);
  const r = await b.resolve({ ref: "e3" }, "s1");
  assert.deepEqual([r.backendNodeId, r.target.role, r.target.name, r.point], [12, "textbox", "Search", { x: 50, y: 60 }]);
  assert.deepEqual(hits(page), [[50, 310]]);
  await b.click(r, () => true);
  assert.deepEqual(pressed(page), [["mousePressed", 50, 60], ["mouseReleased", 50, 60]], "the press goes to the viewport point, not the document's");
  assert.equal(landed(page), 12);
});

test("an x, y click on a scrolled page is judged on the control under that point of the viewport, the one its press reaches", async () => {
  // Scrolled by 30, the press at viewport (50, 280) lands on the field (document y 310). Document y 280, shown a scroll's
  // height above the press, is the second button: the gate would judge it while the press went to the field.
  const { b, page } = scrolled(30, { x: 0, y: 260, width: 100, height: 40 });
  const r = await b.resolve({ x: 50, y: 280 }, "s1");
  assert.deepEqual([r.backendNodeId, r.target.role, r.target.name], [12, "textbox", "Search"]);
  await b.click(r, () => true);
  assert.deepEqual(hits(page), [[50, 310], [50, 310]], "the click's own check hit-tests the same document point");
  assert.deepEqual(page.inputs().slice(-2), ["Input.dispatchMouseEvent:mousePressed", "Input.dispatchMouseEvent:mouseReleased"]);
  assert.deepEqual(pressed(page), [["mousePressed", 50, 280], ["mouseReleased", 50, 280]], "the press goes to the viewport point, not the document's");
  assert.equal(landed(page), 12, "and reaches the field the gate judged");
});

test("a scroll between the offset's read and the hit test refuses: the node hit belongs to neither position", async () => {
  const { b, page } = scrolled(250);
  page.on.set("DOM.getNodeForLocation", () => { page.scroll.y += 30; });
  assert.equal(await refusal(b.resolve({ ref: "e3" }, "s1")), "The page changed: look again.");
  const r = resolved({ target: { role: "textbox", name: "Search", inForm: false, fileInput: false }, backendNodeId: 12, judged: [12], point: { x: 50, y: 60 } });
  page.sent.length = 0;
  page.scroll.y = 250;
  assert.equal(await refusal(b.click(r, () => true)), "The page changed: look again.");
  assert.deepEqual(page.inputs(), ["Input.dispatchMouseEvent:mouseMoved"], "no press");
});

// ---- R87: the press goes to exactly the point the last hit test judged, at the scroll that test used

test("R87: a fractional scroll: the press goes to exactly the document point the hit test judged, not half a pixel off it", async () => {
  // Scrolled by 0.5 (one device pixel at a device scale of 2), the field ends at document y 320, where the second button
  // starts. Viewport (50, 319) is document y 319.5, on the field; the hit test takes whole numbers, so it is made at y 320,
  // on the button. Pressed at (50, 319), the press reached the field while the gate judged the button.
  const { b, page } = scrolled(0.5, { x: 0, y: 320, width: 100, height: 40 });
  const r = await b.resolve({ x: 50, y: 319 }, "s1");
  assert.deepEqual([r.backendNodeId, r.target.role, r.target.name], [11, "button", "Go"]);
  const n = page.mice().length;
  await b.click(r, () => true);
  assert.deepEqual(hits(page), [[50, 320], [50, 320]]);
  assert.deepEqual([landed(page), r.backendNodeId], [11, 11], "the press lands on the button the gate judged");
  assert.deepEqual(page.mice().slice(n), [["mouseMoved", 50, 319.5], ["mousePressed", 50, 319.5], ["mouseReleased", 50, 319.5]], "the hover, the press and the release at the judged document point less the scroll");
  // The click's own hit test decides where its press goes, whatever point it was given (one resolved before the page
  // scrolled by a fraction): given (50, 319), it judges document y 320, so it presses at 319.5, not 319.
  page.sent.length = 0;
  await b.click(resolved({ backendNodeId: 11, judged: [11], point: { x: 50, y: 319 } }), () => true);
  assert.deepEqual(hits(page), [[50, 320]]);
  assert.deepEqual([landed(page), pressed(page)], [11, [["mousePressed", 50, 319.5], ["mouseReleased", 50, 319.5]]], "pressed where the click's own hit test judged");
});

test("R87: a scroll between the click's last hit test and its press refuses, and no press is sent", async () => {
  // A smooth scroll still running, the page's own script or the person: the scroll moves after the click's hit test (here
  // while the click reads the DOM) and before the press, so the point no longer shows the node judged.
  const { b, page } = scrolled(250);
  const r = await b.resolve({ ref: "e3" }, "s1");
  page.sent.length = 0;
  let moved = false;
  page.on.set("DOM.getDocument", () => { if (!moved) { moved = true; page.scroll.y += 40; } });
  assert.equal(await refusal(b.click(r, () => true)), "The page changed: look again.");
  assert.deepEqual([moved, hits(page)], [true, [[50, 310]]], "the hit test was made at the old scroll; the scroll moved after it");
  assert.deepEqual(page.inputs(), ["Input.dispatchMouseEvent:mouseMoved"], "no press");
});

test("session-browser S13: tabs() reports whether the page can go back and forward", () => {
  const { b, nav } = make();
  assert.deepEqual(b.tabs().map((t) => [t.canBack, t.canForward]), [[false, false]]);
  nav.back = true;
  assert.deepEqual(b.tabs().map((t) => [t.canBack, t.canForward]), [[true, false]]);
  nav.forward = true;
  assert.deepEqual(b.tabs().map((t) => [t.canBack, t.canForward]), [[true, true]]);
});

test("session-browser S13: nav goes back, forward or reloads the active tab; a move that cannot happen does nothing", () => {
  const { b, nav } = make();
  assert.equal(b.nav("back"), false);
  assert.equal(b.nav("forward"), false);
  assert.deepEqual(nav.moves, [], "nothing to go back or forward to");
  nav.back = true; nav.forward = true;
  assert.equal(b.nav("back"), true);
  assert.equal(b.nav("forward"), true);
  assert.equal(b.nav("reload"), true);
  assert.deepEqual(nav.moves, ["back", "forward", "reload"]);
  const none = new ComputerBrowser({ key: "ws:none", window: () => null, hooks: { ask: async () => true, note: () => {}, changed: () => {} } });
  assert.equal(none.nav("reload"), false, "no tab");
  assert.equal(none.nav("back", 4), false, "no such tab");
});

test("activeWebContentsId: the active tab's id, or null with no tab or a destroyed one (e2e seam)", () => {
  const { b, tab } = make();
  assert.equal(b.activeWebContentsId(), 1);
  const none = new ComputerBrowser({ key: "ws:none", window: () => null, hooks: { ask: async () => true, note: () => {}, changed: () => {} } });
  assert.equal(none.activeWebContentsId(), null);
  (tab.wc as { isDestroyed: () => boolean }).isDestroyed = () => true;
  assert.equal(b.activeWebContentsId(), null);
});

// ---- one set of window listeners for every browser on a window (session-browser S1: one browser per session)

/** A window that counts its listeners per event and can fire them. */
function fakeWindow() {
  const on = new Map<string, Array<() => void>>();
  const win = {
    on: (e: string, f: () => void) => { on.set(e, [...(on.get(e) ?? []), f]); },
    // Like Node's emitter: a once-wrapper is removed by the function it wraps.
    once(e: string, f: () => void) { const g = Object.assign((): void => { win.off(e, g); f(); }, { listener: f }); on.set(e, [...(on.get(e) ?? []), g]); },
    off: (e: string, f: () => void) => { on.set(e, (on.get(e) ?? []).filter((x) => x !== f && (x as unknown as { listener?: unknown }).listener !== f)); },
    isDestroyed: () => false,
  };
  const count = (e: string): number => (on.get(e) ?? []).length;
  const fire = (e: string): void => { for (const f of [...(on.get(e) ?? [])]) f(); };
  return { win: win as unknown as import("electron").BrowserWindow, count, fire };
}

test("twelve browsers on one window add one listener per event, and the last one to go removes them", () => {
  const w = fakeWindow();
  const bare = (): ComputerBrowser => new ComputerBrowser({ key: "chat:x", window: () => null, hooks: { ask: async () => true, note: () => {}, changed: () => {} } });
  const bs = Array.from({ length: 12 }, bare);
  for (const b of bs) (b as unknown as { watch(x: unknown): void }).watch(w.win);
  for (const e of ["show", "hide", "minimize", "restore", "closed"]) assert.equal(w.count(e), 1, e);
  for (const b of bs.slice(0, 11)) b.destroy();
  assert.equal(w.count("hide"), 1, "still watched by the last");
  bs[11].destroy();
  for (const e of ["show", "hide", "minimize", "restore", "closed"]) assert.equal(w.count(e), 0, e);
});

test("a hidden window still reaches every watching browser, and a closed one lets each go", () => {
  const w = fakeWindow();
  const bs = Array.from({ length: 3 }, () => make().b);
  const placed = bs.map(() => 0);
  bs.forEach((b, i) => {
    (b as unknown as { place(): void }).place = () => { placed[i]++; };
    (b as unknown as { watch(x: unknown): void }).watch(w.win);
  });
  w.fire("hide");
  assert.deepEqual(placed, [1, 1, 1]);
  w.fire("closed");
  assert.deepEqual(placed, [2, 2, 2]);

});

// ---- session-browser S9: sleep and wake

let viewIds = 100;
/** A stand-in WebContentsView whose webContents records its handlers and "commits" a main-frame load at once. */
class FakeView {
  static redirect: ((u: string) => string) | null = null;
  static hang = new Set<string>();
  /** Addresses whose load keeps the tab on its old URL until the promise settles, as a slow real load does. */
  static hold = new Map<string, Promise<void>>();
  static fail: ((u: string) => Error) | null = null;
  webContents: Record<string, unknown>;
  constructor() {
    const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    let url = "about:blank";
    const base: Record<string, unknown> = {
      id: ++viewIds, isDestroyed: () => false, getURL: () => url, getTitle: () => "", close: () => {},
      on: (ev: string, fn: (...a: unknown[]) => void) => { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
      loadURL: async (u: string) => {
        if (!FakeView.hold.has(u)) url = u;
        if (u === "about:blank") return;
        if (FakeView.fail) throw FakeView.fail(u);
        for (const f of handlers.get("did-start-navigation") ?? []) f({}, { isMainFrame: true, isSameDocument: false, url: u, initiator: undefined });
        if (FakeView.redirect) {
          url = FakeView.redirect(u);
          for (const f of handlers.get("did-redirect-navigation") ?? []) f({ isMainFrame: true, isSameDocument: false, url });
        }
        if (FakeView.hang.has(u)) await new Promise<void>(() => {});
        if (FakeView.hold.has(u)) { await FakeView.hold.get(u); url = u; }
        for (const f of handlers.get("did-navigate") ?? []) f({}, url);
      },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      debugger: { isAttached: () => false, on: () => {}, detach: () => {} },
    };
    this.webContents = new Proxy(base, { get: (o, k: string) => (k in o ? o[k] : () => undefined) });
  }
}
stub.WebContentsView = FakeView;

/** `make()` with the window code out of the way (no real windows here) and a close on the tab's contents. */
function makeSleeper(url = "https://a.test/") {
  const m = make();
  m.page.url = url;
  (m.tab.wc as unknown as { close: () => void }).close = () => {};
  const inner = m.b as unknown as { place: () => void; attach: () => Promise<void> };
  inner.place = () => {};
  inner.attach = async () => {};
  return m;
}

test("sleep keeps a tab's secret memory: a value read before sleeping is still scrubbed after the wake (session-browser S9, F3)", async () => {
  const { b, tab } = makeSleeper("https://a.test/?code=hunter22");
  tab.memory.remember("https://a.test", { values: ["hunter22"], whole: [] });
  assert.equal(b.tabs()[0].url.includes("hunter22"), false);
  b.sleep();
  assert.equal(b.tabs()[0].url.includes("hunter22"), false, "scrubbed while asleep too");
  await b.wake();
  assert.equal(b.asleep(), false);
  const woken = (b as unknown as { list: { memory: unknown; uid: number }[] }).list[0];
  assert.equal(woken.memory, tab.memory, "the same memory serves the new view");
  assert.equal(b.tabs()[0].url.includes("hunter22"), false, "the woken view's address is scrubbed by the kept memory");
  assert.equal(b.tabs()[0].url.includes("code="), true, "and its address really is the loaded one");
});

test("a sleeping browser still lists its tabs, and the page token changes on wake", async () => {
  const { b, tab } = makeSleeper();
  const before = b.pageToken();
  b.sleep();
  assert.equal(b.asleep(), true);
  const [t] = b.tabs();
  assert.equal(t.url, "https://a.test/");
  assert.equal(t.active, true);
  await b.wake();
  assert.equal(b.tabs().length, 1);
  assert.notEqual(b.pageToken(), before);
  assert.notEqual(b.pageToken(), `${tab.uid}.${tab.seq}`);
});

test("a restored tab's address is hidden from the agent until it navigates, also through a redirect of its reload", async () => {
  const { b } = makeSleeper();
  const fresh = new ComputerBrowser({ key: "ws:beta", window: () => null, hooks: { ask: async () => true, note: () => {}, changed: () => {} } });
  const inner = fresh as unknown as { place: () => void; attach: () => Promise<void>; shownUrl: (t: unknown) => string; list: unknown[] };
  inner.place = () => {}; inner.attach = async () => {};
  fresh.restore(["http://a.test/cb?q=secret#frag"], 0);
  assert.equal(fresh.asleep(), true);
  assert.equal(fresh.tabs()[0].url, "http://a.test/cb");
  FakeView.redirect = (u) => u.replace("http:", "https:");
  try {
    await fresh.wake();
    assert.equal(fresh.tabs()[0].url, "https://a.test/cb", "after the reload and its redirect, until the tab navigates");
    assert.equal(inner.shownUrl(inner.list[0]), "https://a.test/cb", "the path a snapshot's Page: line uses");
    // The tab then navigates on its own: the hold has ended and a redirect no longer extends it.
    const t = inner.list[0] as { wc: { loadURL: (u: string) => Promise<void> }; holdUrl: string | null };
    await t.wc.loadURL("http://a.test/other?x=1");
    assert.equal(t.holdUrl, null);
  } finally { FakeView.redirect = null; }
  void b;
});

test("a slept tab's hidden address stays hidden through a redirect of its reload", async () => {
  const { b, tab } = makeSleeper("http://a.test/cb?token=T");
  (tab as { urlHidden: boolean }).urlHidden = true;
  b.sleep();
  FakeView.redirect = (u) => u.replace("http:", "https:");
  try {
    await b.wake();
    assert.equal(b.tabs()[0].url, "https://a.test/cb");
  } finally { FakeView.redirect = null; }
});

test("a wake waits only for the active tab: a background tab that never finishes does not delay it", async () => {
  const { b } = makeSleeper("https://a.test/");
  const inner = b as unknown as { list: { wc: { getURL: () => string } }[]; kept: unknown[] | null };
  b.sleep();
  inner.kept = [
    { url: "https://a.test/", shown: "https://a.test/", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: false },
    { url: "https://slow.test/", shown: "https://slow.test/", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: false },
  ];
  FakeView.hang.add("https://slow.test/");
  try {
    await b.wake();
    assert.equal(b.asleep(), false);
    assert.equal(b.tabs().length, 2);
  } finally { FakeView.hang.clear(); }
});

test("a woken tab whose load has not committed keeps its kept address, then the live one takes over (session-browser X3, A1)", async () => {
  const { b } = makeSleeper("https://a.test/");
  const inner = b as unknown as { kept: unknown[] | null };
  b.sleep();
  inner.kept = [
    { url: "https://a.test/", shown: "https://a.test/", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: false },
    { url: "https://slow.test/p?code=S", shown: "https://slow.test/p", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: true },
  ];
  let release!: () => void;
  FakeView.hold.set("https://slow.test/p?code=S", new Promise<void>((r) => { release = r; }));
  try {
    await b.wake();
    // The slow tab is still on about:blank: its record address and its shown form are the kept ones, never blank.
    assert.deepEqual(b.realAddresses().urls, ["https://a.test/", "https://slow.test/p?code=S"]);
    assert.equal(b.tabs()[1].url, "https://slow.test/p");
    // Asleep again before it commits, it still remembers the address.
    b.sleep();
    assert.deepEqual(b.realAddresses().urls, ["https://a.test/", "https://slow.test/p?code=S"]);
    assert.equal(b.tabs()[1].url, "https://slow.test/p");
  } finally { release(); FakeView.hold.clear(); }
});

test("Reload on a woken tab that has not committed loads its kept address (session-browser X3, M2)", async () => {
  const { b } = makeSleeper("https://a.test/");
  const inner = b as unknown as { kept: unknown[] | null; list: { wc: { loadURL: (u: string) => Promise<void>; reload: () => void } }[] };
  b.sleep();
  inner.kept = [
    { url: "https://a.test/", shown: "https://a.test/", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: false },
    { url: "https://slow.test/p?code=S", shown: "https://slow.test/p", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: true },
  ];
  let release!: () => void;
  FakeView.hold.set("https://slow.test/p?code=S", new Promise<void>((r) => { release = r; }));
  try {
    await b.wake();
    const wc = inner.list[1].wc;
    const loads: string[] = [];
    let reloads = 0;
    const load = wc.loadURL;
    wc.loadURL = (u: string) => { loads.push(u); return load(u); };
    wc.reload = () => { reloads++; };
    assert.equal(b.nav("reload", 1), true);
    assert.equal(reloads, 0, "the view's own reload would load about:blank");
    assert.deepEqual(loads, ["https://slow.test/p?code=S"]);
    assert.deepEqual(b.realAddresses().urls, ["https://a.test/", "https://slow.test/p?code=S"]);
  } finally { release(); FakeView.hold.clear(); }
});

test("a woken tab takes its live address at its first commit, even when it commits somewhere else (session-browser X3, A1)", async () => {
  const { b } = makeSleeper("https://a.test/");
  const inner = b as unknown as { kept: unknown[] | null; list: { wc: { loadURL: (u: string) => Promise<void> } }[] };
  b.sleep();
  inner.kept = [
    { url: "https://a.test/", shown: "https://a.test/", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: false },
    { url: "https://slow.test/", shown: "https://slow.test/", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: false },
  ];
  let release!: () => void;
  FakeView.hold.set("https://slow.test/", new Promise<void>((r) => { release = r; }));
  await b.wake();
  assert.equal(b.realAddresses().urls[1], "https://slow.test/");
  // The person types another address into that tab before the reload commits: that commit ends the kept address.
  await inner.list[1].wc.loadURL("https://other.test/");
  assert.deepEqual(b.realAddresses().urls, ["https://a.test/", "https://other.test/"]);
  assert.equal(b.tabs()[1].url, "https://other.test/");
  release(); FakeView.hold.clear();
});

test("a woken tab whose load failed for good keeps answering its kept address until a commit (session-browser X3, A1)", async () => {
  const { b } = makeSleeper("https://a.test/");
  const inner = b as unknown as { kept: unknown[] | null };
  b.sleep();
  inner.kept = [
    { url: "https://a.test/", shown: "https://a.test/", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: false },
    { url: "https://down.test/", shown: "https://down.test/", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: false },
  ];
  // The load rejects with a real failure (not an abort) and nothing commits: the tab still reads about:blank.
  FakeView.hold.set("https://down.test/", Promise.reject(new Error("ERR_CONNECTION_REFUSED")));
  FakeView.hold.get("https://down.test/")!.catch(() => {});
  try {
    await b.wake();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(b.realAddresses().urls[1], "https://down.test/");
    b.sleep();
    assert.equal(b.realAddresses().urls[1], "https://down.test/");
  } finally { FakeView.hold.clear(); }
});

test("a browser destroyed during a wake leaves the wake settled", async () => {
  const { b } = makeSleeper("https://a.test/");
  b.sleep();
  FakeView.hang.add("https://a.test/");
  try {
    const w = b.wake();
    b.destroy();
    await w;
  } finally { FakeView.hang.clear(); }
});

test("a restored tab whose reload fails never gives out its full address, in a note or the tab list", async () => {
  const notes: string[] = [];
  const fresh = new ComputerBrowser({ key: "ws:beta", window: () => null, hooks: { ask: async () => true, note: (s) => notes.push(s), changed: () => {} } });
  const inner = fresh as unknown as { place: () => void; attach: () => Promise<void> };
  inner.place = () => {}; inner.attach = async () => {};
  fresh.restore(["http://x.test/cb?token=T"], 0);
  FakeView.fail = (u) => new Error(`ERR_CONNECTION_REFUSED (-102) loading '${u}'`);
  try {
    await fresh.wake();
  } finally { FakeView.fail = null; }
  assert.ok(notes.some((n) => n.startsWith("A tab did not reload")), `a note says it: ${notes.join(" | ")}`);
  assert.equal(JSON.stringify({ notes, tabs: fresh.tabs() }).includes("token=T"), false, "nothing given out carries the query");
});

function threeKept(): { fresh: ComputerBrowser; notes: string[]; inner: { addTab: (...a: unknown[]) => Promise<unknown> } } {
  const notes: string[] = [];
  const fresh = new ComputerBrowser({ key: "ws:beta", window: () => null, hooks: { ask: async () => true, note: (s) => notes.push(s), changed: () => {} } });
  const inner = fresh as unknown as { place: () => void; attach: () => Promise<void>; addTab: (...a: unknown[]) => Promise<unknown> };
  inner.place = () => {}; inner.attach = async () => {};
  fresh.restore(["http://a.test/", "http://b.test/?k=SECRET", "http://c.test/"], 2);
  return { fresh, notes, inner };
}

test("a kept tab that cannot be made is skipped, the others wake, and the remembered active tab is selected", async () => {
  const { fresh, notes, inner } = threeKept();
  const orig = inner.addTab.bind(fresh);
  inner.addTab = (opener: unknown, k: unknown) => (String((k as { url: string }).url).includes("b.test") ? Promise.reject(new Error("boom http://b.test/?k=SECRET")) : orig(opener, k));
  await fresh.wake();
  const tabs = fresh.tabs();
  assert.equal(tabs.length, 2, "the first and the third exist");
  assert.ok(tabs[1].url.includes("c.test") && tabs[1].active, "the third, the remembered active one, is active");
  assert.ok(notes.some((n) => n.startsWith("A tab did not wake")));
  assert.equal(JSON.stringify({ notes, tabs }).includes("SECRET"), false, "neither the error text nor the query is given out");
});

test("a kept tab whose load fails does not stop the others", async () => {
  const { fresh, notes } = threeKept();
  FakeView.fail = (u) => (u.includes("b.test") ? new Error("ERR_CONNECTION_REFUSED") : null) as never;
  try { await fresh.wake(); } finally { FakeView.fail = null; }
  const tabs = fresh.tabs();
  assert.equal(tabs.length, 3);
  assert.ok(tabs[2].active && tabs[2].url.includes("c.test"));
  assert.ok(notes.some((n) => n.startsWith("A tab did not reload")));
});

test("activeAddress is the active tab's real address, cleaned, or null with none to give; it throws once the browser is gone (session-browser S24)", () => {
  makeSleeper();
  const fresh = new ComputerBrowser({ key: "ws:active", window: () => null, hooks: { ask: async () => true, note: () => {}, changed: () => {} } });
  (fresh as unknown as { place: () => void }).place = () => {};
  assert.equal(fresh.activeAddress(), null, "no tab");
  fresh.restore(["https://example.com/p?x=1", "https://user:pass@example.com/p?x=2"], 1);
  assert.equal(fresh.activeAddress(), "https://example.com/p?x=2", "the active tab's, with its query, without the user name or password");
  assert.equal(fresh.realAddresses().urls[0], "https://example.com/p?x=1", "realAddresses answers as before");
  fresh.destroy();
  assert.throws(() => fresh.activeAddress(), /gone/);
});

test("activeAddress on an awake browser: the live tab's real address without a user name or password; a tab not yet committed gives its kept one; none for a destroyed view or a non-web scheme (session-browser S24)", async () => {
  const awake = makeSleeper("https://user:pw@example.com/p?code=abc");
  assert.equal(awake.b.activeAddress(), "https://example.com/p?code=abc", "real query kept, user name and password gone");
  awake.page.url = "about:blank";
  assert.equal(awake.b.activeAddress(), null, "no address yet");
  awake.page.url = "file:///etc/hosts";
  assert.equal(awake.b.activeAddress(), null, "a scheme the browser does not open");
  awake.page.url = "https://a.test/";
  (awake.tab.wc as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;
  assert.equal(awake.b.activeAddress(), null, "a destroyed view");
  // A woken tab that has not committed yet answers its kept address, not the blank page it still shows.
  const { b } = makeSleeper("https://a.test/");
  const inner = b as unknown as { kept: unknown[] | null };
  b.sleep();
  inner.kept = [
    { url: "https://a.test/", shown: "https://a.test/", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: false },
    { url: "https://slow.test/p?code=S", shown: "https://slow.test/p", title: "", openedBy: null, memory: new SecretMemory(), urlHidden: true },
  ];
  (b as unknown as { keptActive: number }).keptActive = 1;
  let release!: () => void;
  FakeView.hold.set("https://slow.test/p?code=S", new Promise<void>((r) => { release = r; }));
  try {
    // The active tab's load is held, and a wake waits for it up to LOAD_WAIT_MS: start it, look once the tab exists, release, then await.
    const waking = b.wake();
    const inner2 = b as unknown as { list: { pending: unknown }[] };
    for (let i = 0; i < 200 && !inner2.list.some((t) => t.pending); i++) await new Promise((r) => setImmediate(r));
    assert.equal(b.activeAddress(), "https://slow.test/p?code=S");
    release();
    await waking;
  } finally { release(); FakeView.hold.clear(); }
});

test("open with background adds a tab without taking the selection; without it the new tab is selected (session-browser X2)", async () => {
  const { b } = makeSleeper("https://a.test/");
  await b.open("https://b.test/", { newTab: true, background: true, by: "A program" });
  assert.deepEqual(b.tabs().map((t) => [t.url, t.active, t.openedBy]), [["https://a.test/", true, null], ["https://b.test/", false, "A program"]], "there, and the active tab is as it was");
  assert.equal(b.activeAddress(), "https://a.test/");
  await b.open("https://c.test/", { newTab: true, by: null });
  assert.deepEqual(b.tabs().map((t) => t.active), [false, false, true], "a tab opened as before takes the selection");
  // With no tab yet the first one is the active one, background or not.
  const fresh = new ComputerBrowser({ key: "ws:bg", window: () => null, hooks: { ask: async () => true, note: () => {}, changed: () => {} } });
  const inner = fresh as unknown as { place: () => void; attach: () => Promise<void> };
  inner.place = () => {}; inner.attach = async () => {};
  await fresh.open("https://d.test/", { newTab: true, background: true, by: null });
  assert.deepEqual(fresh.tabs().map((t) => t.active), [true]);
});

test("a restored tab's address shows no user name or password", () => {
  makeSleeper();
  const fresh = new ComputerBrowser({ key: "ws:cred", window: () => null, hooks: { ask: async () => true, note: () => {}, changed: () => {} } });
  (fresh as unknown as { place: () => void }).place = () => {};
  fresh.restore(["https://user:pass@example.com/x?code=1"], 0);
  const u = fresh.tabs()[0].url;
  assert.equal(u.includes("user"), false);
  assert.equal(u.includes("pass"), false);
  assert.equal(fresh.realAddresses().urls.join().includes("pass"), false);
  assert.equal(fresh.realAddresses().urls.join().includes("user"), false);
});

test("a live tab at an address with credentials shows none", () => {
  const { b } = makeSleeper("https://user:pass@example.com/x");
  for (const w of ["user", "pass"]) {
    assert.equal(JSON.stringify(b.tabs()).includes(w), false);
    assert.equal(JSON.stringify(b.realAddresses()).includes(w), false);
  }
  b.sleep();
  for (const w of ["user", "pass"]) {
    assert.equal(JSON.stringify(b.tabs()).includes(w), false);
    assert.equal(JSON.stringify(b.realAddresses()).includes(w), false);
  }
});

test("a popup's note shows no user name or password", async () => {
  const { b, tab, notes } = makeSleeper("https://user:pass@example.com/");
  const inner = b as unknown as { leavingValues: () => Promise<null>; addTab: () => Promise<unknown> };
  inner.leavingValues = async () => null;
  inner.addTab = async () => ({ memory: new SecretMemory(), opened: null });
  await (b as unknown as { popup: (t: unknown, d: unknown) => Promise<void> }).popup(tab, { url: "https://user:pass@example.com/x" }).catch(() => {});
  const note = notes.find((n) => n.startsWith("The page opened")) ?? "";
  assert.ok(note.includes("example.com"), note);
  assert.equal(note.includes("user"), false, note);
  assert.equal(note.includes("pass"), false, note);
});

test("a page-started navigation's note shows no user name or password", async () => {
  const { b, tab, notes } = makeSleeper("https://user:pass@example.com/");
  (b as unknown as { leavingValues: () => Promise<null> }).leavingValues = async () => null;
  (b as unknown as { noteNavigation: (t: unknown, u: string) => void }).noteNavigation(tab, "https://user:pass@example.com/x");
  await new Promise((r) => setImmediate(r));
  const note = notes.find((n) => n.startsWith("The page went to")) ?? "";
  assert.ok(note.includes("example.com"), note);
  assert.equal(note.includes("user"), false, note);
  assert.equal(note.includes("pass"), false, note);
});

test("waking the largest record keeps every tab", async () => {
  const { b } = makeSleeper();
  const notes: string[] = [];
  const fresh = new ComputerBrowser({ key: "ws:full", window: () => null, hooks: { ask: async () => true, note: (n: string) => { notes.push(n); }, changed: () => {} } });
  const inner = fresh as unknown as { place: () => void; attach: () => Promise<void> };
  inner.place = () => {}; inner.attach = async () => {};
  fresh.restore(Array.from({ length: TABS_MAX }, (_, i) => `https://a.test/${i}`), TABS_MAX - 1);
  await fresh.wake();
  assert.equal(fresh.tabs().length, TABS_MAX);
  assert.deepEqual(notes, []);
  void b;
});

// session-browser S16 (Task 19): `settled(since)` ends 300 ms after the action's last input, or, when a main-frame navigation
// started in that window, when it has loaded (5 s at the latest). The clock is node's mock one: setTimeout and Date.
const turns = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
/** What `settled` is waiting on after each tick; `at` is the milliseconds since the action's input. */
async function settledAt(drive: (h: { b: ComputerBrowser; tab: unknown; at: (ms: number) => Promise<void> }) => Promise<void>): Promise<number> {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const { b, tab } = make();
    let done: number | null = null;
    let now = 0;
    const at = async (ms: number): Promise<void> => {
      // Step in whole milliseconds so a timer due at `ms` fires with the clock reading `ms`.
      while (now < ms) { mock.timers.tick(1); now++; await turns(); }
    };
    void b.settled(0).then(() => { done = Date.now(); });
    await turns();
    await drive({ b, tab, at });
    await turns();
    await at(6000);
    return done ?? -1;
  } finally {
    mock.timers.reset();
  }
}
const began = (b: ComputerBrowser, tab: unknown): void => (b as unknown as { navBegan(t: unknown): void }).navBegan(tab);
const ended = (b: ComputerBrowser, tab: unknown): void => (b as unknown as { navEnded(t: unknown): void }).navEnded(tab);

test("settled waits 300 ms when nothing navigates", async () => {
  assert.equal(await settledAt(async () => {}), 300);
});

test("settled waits for a navigation that starts in the window, 5 s at most", async () => {
  // Starts at 200, loads at 900: ends at 900.
  assert.equal(await settledAt(async ({ b, tab, at }) => { await at(200); began(b, tab); await at(900); ended(b, tab); }), 900);
  // Starts at 200 and never loads: ends at 5,000.
  assert.equal(await settledAt(async ({ b, tab, at }) => { await at(200); began(b, tab); }), 5000);
  // Starts at 400, after the window: ends at 300.
  assert.equal(await settledAt(async ({ b, tab, at }) => { await at(400); began(b, tab); }), 300);
  // Starts at 100 and has loaded by 250: ends at 300.
  assert.equal(await settledAt(async ({ b, tab, at }) => { await at(100); began(b, tab); await at(250); ended(b, tab); }), 300);
});

// ---- fix round 1 (session-browser S16, I4): a ref is the node the session was last SHOWN under that number

const items = (n: number, from = 100): { b: number; name: string }[] => Array.from({ length: n }, (_, i) => ({ b: from + i, name: `Item ${from + i}` }));
const refTo = (tab: unknown, session: string, ref: string): number | undefined =>
  (tab as { refs: Map<string, { refs: Map<string, { backendNodeId: number }> }> }).refs.get(session)?.refs.get(ref)?.backendNodeId;
const snapshotText = (b: ComputerBrowser, session: string, cap?: number) => b.snapshot(undefined, session, cap === undefined ? undefined : { cap });

test("a ref beyond a reply's cut still names the node the session was shown", async () => {
  const { b, page, tab } = make();
  page.ax = items(600);
  const full = await b.snapshot(undefined, "s");
  assert.equal(refTo(tab, "s", "e500"), 599, "the full snapshot showed e500 as the 500th button");
  // An action inserted three buttons above; the reply shows only its first 8,000 characters.
  page.ax = [...items(3, 900), ...items(600)];
  const reply = await snapshotText(b, "s", 8000);
  const body = reply.text.slice(reply.text.indexOf("\n") + 1, reply.text.lastIndexOf("\n</untrusted-page>"));
  assert.ok(reply.truncated && body.length <= 8000, `${body.length}`);
  assert.equal(refTo(tab, "s", "e500"), 599, "e500 still names the node the session saw under that number, not what is there now");
  assert.ok(full.text.includes("[e500]"));
});

test("a ref printed in a reply's outline names the new node", async () => {
  const { b, page, tab } = make();
  page.ax = items(600);
  await b.snapshot(undefined, "s");
  page.ax = [...items(3, 900), ...items(600)];
  await snapshotText(b, "s", 8000);
  assert.equal(refTo(tab, "s", "e1"), 900);
});

test("a number the session was never shown is refused", async () => {
  const { b, page, tab } = make();
  page.ax = items(600);
  await snapshotText(b, "s", 8000);              // only the first lines were shown
  assert.equal(refTo(tab, "s", "e500"), undefined, "never registered");
  await assert.rejects(b.resolve({ ref: "e500" }, "s"), /take a new snapshot/);
});

test("after a navigation only the reply's printed refs exist", async () => {
  const { b, page, tab } = make();
  page.ax = items(600);
  await b.snapshot(undefined, "s");
  (tab as { seq: number }).seq++;                // a new document
  await snapshotText(b, "s", 8000);
  assert.equal(refTo(tab, "s", "e500"), undefined);
  assert.equal(refTo(tab, "s", "e1"), 100);
});

test("an address longer than the cap leaves the wrapper whole", async () => {
  const { b, page } = make();
  page.ax = items(60);
  page.url = `https://a.test/${"p".repeat(5000)}`;
  const snap = await snapshotText(b, "s", 500);
  assert.ok(snap.text.startsWith("<untrusted-page "), snap.text.slice(0, 40));
  assert.ok(snap.text.endsWith("\n</untrusted-page>"), snap.text.slice(-40));
  assert.equal(snap.truncated, true);
});

test("the cap counts outline lines, not the wrapper", async () => {
  const { b, page } = make();
  page.ax = items(60);
  page.url = `https://a.test/${"p".repeat(5000)}`;       // the opening part is about 2,000 characters
  const snap = await snapshotText(b, "s", 600);
  assert.ok(snap.text.includes("[e1]"), "an address of any length leaves room for the outline");
  const body = snap.text.slice(snap.text.indexOf("\n") + 1, snap.text.lastIndexOf("\n</untrusted-page>"));
  assert.ok(body.length <= 600, `${body.length} characters of outline`);
});

test("a navigation during a snapshot's reads leaves no usable ref", async () => {
  const { b, page, tab } = make();
  page.ax = items(5);
  page.on.set("Accessibility.getFullAXTree", () => { (tab as { seq: number }).seq++; });   // the page moves on mid-read
  await b.snapshot(undefined, "s");
  assert.equal((tab as { refs: Map<string, { token: string }> }).refs.get("s")?.token, "1.0", "registered under the token read before the reads");
  await assert.rejects(b.resolve({ ref: "e1" }, "s"), /There is no e1 on this page now/);
});

// ---- fix round 1 (session-browser S16, M3): `settled` through the web contents' own events

type AnyTab = { wc: Record<string, unknown> & { debugger: Record<string, unknown> } };
/** Gives the fake web contents an event source, wires the tab as the browser does, and returns the source. */
function listen(b: ComputerBrowser, tab: unknown): EventEmitter {
  const em = new EventEmitter();
  const t = tab as AnyTab;
  Object.assign(t.wc, { on: (e: string, f: (...a: unknown[]) => void) => { em.on(e, f); return t.wc; }, setWindowOpenHandler() {}, close() {} });
  Object.assign(t.wc.debugger, { on() {}, detach() {} });
  (b as unknown as { wire(t: unknown): void }).wire(tab);
  return em;
}
const navStart = (em: EventEmitter): boolean => em.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "https://a.test/next" });
const navStop = (em: EventEmitter): boolean => em.emit("did-stop-loading");

/** Runs `settled(sinceAt)` on a mock clock, firing the plan's events at their milliseconds; when it resolved, in ms. */
async function settleRun(sinceAt: number, plan: (h: { b: ComputerBrowser; tab: unknown }) => Record<number, () => void>): Promise<number> {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const { b, tab } = make();
    const events = plan({ b, tab });
    let done: number | null = null;
    for (let ms = 0; ms <= 6000; ms++) {
      events[ms]?.();
      if (ms === sinceAt) void b.settled(sinceAt).then(() => { done = Date.now(); });
      await turns();
      if (done !== null) return done;
      mock.timers.tick(1);
    }
    return -1;
  } finally {
    mock.timers.reset();
  }
}

test("settled: a navigation that begins after the window ends is not waited for, one at 299 ms is", async () => {
  assert.equal(await settleRun(0, ({ b, tab }) => { const em = listen(b, tab); return { 301: () => navStart(em) }; }), 300, "starting at 301 ms");
  assert.equal(await settleRun(0, ({ b, tab }) => { const em = listen(b, tab); return { 299: () => navStart(em), 800: () => navStop(em) }; }), 800, "starting at 299 ms, loaded at 800");
});

test("settled: a navigation that began 200 ms before the input and is still loading counts", async () => {
  assert.equal(await settleRun(200, ({ b, tab }) => { const em = listen(b, tab); return { 0: () => navStart(em), 900: () => navStop(em) }; }), 900);
  // ... but one that began 400 ms before it does not.
  assert.equal(await settleRun(400, ({ b, tab }) => { const em = listen(b, tab); return { 0: () => navStart(em), 900: () => navStop(em) }; }), 700);
});

test("settled: a background tab's navigation does not count", async () => {
  assert.equal(await settleRun(0, ({ b, tab }) => {
    const other = { ...(tab as object), wc: { ...(tab as AnyTab).wc, debugger: { ...(tab as AnyTab).wc.debugger } } };
    (b as unknown as { list: unknown[] }).list.push(other);   // the second tab is not the active one
    const em = listen(b, other);
    return { 100: () => navStart(em) };
  }), 300);
});

test("settled: a tab that is closed ends the wait", async () => {
  assert.equal(await settleRun(0, ({ b, tab }) => {
    const em = listen(b, tab);
    return { 100: () => navStart(em), 500: () => (b as unknown as { drop(t: unknown): void }).drop(tab) };
  }), 500);
});

test("settled leaves no timer or waiter behind when the wait ends", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const { b, tab } = make();
    const em = listen(b, tab);
    navStart(em);
    const waiters = (): number => (b as unknown as { navWake: Set<unknown> }).navWake.size;
    let done = false;
    void b.settled(0).then(() => { done = true; });
    mock.timers.tick(300); await turns();
    assert.equal(waiters(), 1, "waiting for the load");
    navStop(em); await turns();
    assert.equal(done, true);
    assert.equal(waiters(), 0);
  } finally {
    mock.timers.reset();
  }
});

test("settled: the browser being destroyed ends the wait", async () => {
  assert.equal(await settleRun(0, ({ b, tab }) => {
    const em = listen(b, tab);
    return { 100: () => navStart(em), 500: () => b.destroy() };
  }), 500);
});
