// The Computer browser's delivery checks (agent-computer D9, D31, D39; R76), against a fake DevTools page: the input a
// click, a key or typing sends, and what stops it, at the moment each event would go. The unit bundle's electron is an
// empty stand-in (electron-stub.cjs), so the session and the file dialog the browser uses are given here; a tab is put
// in the browser as it would be once attached, its webContents a stand-in whose debugger answers from `FakePage`.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import electron from "electron";
import { ComputerBrowser, type BrowserHooks, type Resolved } from "../../src/main/computer/browser";
import { FocusMoved, PageChanged } from "../../src/main/computer/cdp";
import { LeavingRecords, PendingReads } from "../../src/main/computer/leaving";
import { SecretMemory } from "../../src/main/computer/memory";
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
  /** Runs when the page receives `method`, before it answers (a Take over or a focus move landing mid-read); one that
   *  throws makes that command fail. */
  on = new Map<string, (params: Record<string, unknown>) => void>();
  private node(n: number, name: string, attrs: string[], text?: string): CdpDomNode {
    const b = n + this.doc * 1000;
    return { nodeId: b, backendNodeId: b, nodeType: 1, nodeName: name, attributes: attrs, children: text ? [{ nodeId: b + 100, backendNodeId: b + 100, nodeType: 3, nodeName: "#text", nodeValue: text }] : [] };
  }
  root(): CdpDomNode {
    const o = this.doc * 1000;
    const body = [this.node(10, "BUTTON", ["id", "b1"], "Go"), this.node(11, "BUTTON", ["id", "b2"], "Go"), this.node(12, "INPUT", ["id", "q", "aria-label", "Search"])]
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
  const wc = {
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
  return { b, page, tab, notes, asked };
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
