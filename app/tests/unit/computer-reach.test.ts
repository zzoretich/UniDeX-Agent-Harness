import { test } from "node:test";
import assert from "node:assert/strict";
import { accepted, activates, axControl, flatParent, reach, within } from "../../src/main/computer/reach";
import { indexDom, type CdpAxNode, type CdpDomNode } from "../../src/main/computer/snapshot";

// A page with a web component whose shadow tree is <button><slot>, a host whose button role comes from ElementInternals
// (so the markup shows no role), a label, and a plain cell.
let id = 0;
const el = (nodeName: string, attributes: string[] = [], children: CdpDomNode[] = [], extra: Partial<CdpDomNode> = {}): CdpDomNode =>
  ({ nodeId: ++id, backendNodeId: id, nodeType: 1, nodeName, attributes, children, ...extra });
const txt = (v: string): CdpDomNode => ({ nodeId: ++id, backendNodeId: id, nodeType: 3, nodeName: "#text", nodeValue: v });
const span = el("SPAN", [], [txt("Delete")]);
const slot = el("SLOT", [], [], { distributedNodes: [{ backendNodeId: span.backendNodeId }] });
const shadowButton = el("BUTTON", ["part", "base"], [slot]);
const shadowRoot: CdpDomNode = { nodeId: ++id, backendNodeId: id, nodeType: 11, nodeName: "#document-fragment", shadowRootType: "open", children: [shadowButton] };
const host = el("X-BTN", ["id", "wc"], [span], { shadowRoots: [shadowRoot] });
const innerSpan = el("SPAN", [], [txt("Delete")]);
const internalsHost = el("X-IBTN", ["tabindex", "0"], [innerSpan]);
const cancel = el("BUTTON", ["id", "c"], [txt("Cancel")]);
const label = el("LABEL", ["for", "c"], [txt("Choose")]);
const cellText = txt("Nov 8");
const cell = el("TD", [], [cellText]);
const dom = indexDom({ nodeId: ++id, backendNodeId: id, nodeType: 9, nodeName: "#document", children: [el("HTML", [], [el("BODY", [], [host, internalsHost, cancel, label, cell])], { frameId: "F1" })] });
const b = (n: CdpDomNode): number => n.backendNodeId;
const axNode = (n: CdpDomNode, role: string, name: string, parent?: CdpDomNode, ignored = false): CdpAxNode =>
  ({ nodeId: String(b(n)), ignored, role: { value: role }, name: { value: name }, backendDOMNodeId: b(n), ...(parent ? { parentId: String(b(parent)) } : {}) });

test("the flat-tree walk steps from a slotted node to its slot and finds the shadow button", () => {
  assert.equal(flatParent(dom, b(span)), b(slot));
  assert.equal(flatParent(dom, b(slot)), b(shadowButton));
  assert.equal(flatParent(dom, b(shadowRoot)), b(host), "a shadow root's parent is its host");
  assert.deepEqual(activates(dom, b(span)), { b: b(shadowButton), actionable: true });
  assert.ok(within(dom, b(span), b(shadowButton)), "slotted content is inside the shadow button in the flat tree");
  assert.ok(within(dom, b(span), b(host)), "and still inside its host");
  assert.deepEqual(activates(dom, b(label)), { b: b(cancel), actionable: true }, "a label forwards to its control");
  assert.deepEqual(activates(dom, b(cell)), { b: b(cell), actionable: false }, "a plain cell activates nothing");
  assert.deepEqual(activates(dom, b(innerSpan)), { b: b(innerSpan), actionable: false }, "the markup shows no role on the ElementInternals host");
});

test("the accessibility walk finds a click role the markup does not show, and skips ignored nodes", () => {
  const body = { nodeId: "body", ignored: false, role: { value: "generic" }, name: { value: "" }, backendDOMNodeId: 2 } as CdpAxNode;
  const chain = [axNode(innerSpan, "generic", "", internalsHost), axNode(internalsHost, "button", "Delete", cell), { ...axNode(cell, "button", "Nope", undefined), parentId: "body" }, body];
  assert.equal(axControl(chain, b(innerSpan)), b(internalsHost));
  const hidden = [axNode(innerSpan, "generic", ""), { ...axNode(internalsHost, "button", "Delete"), ignored: true }];
  assert.equal(axControl([hidden[0], { ...hidden[1] }].map((n, i) => (i === 0 ? { ...n, parentId: hidden[1].nodeId } : n)), b(innerSpan)), null, "an ignored node is not a control");
  assert.equal(axControl([], b(innerSpan)), null, "an unreadable chain names nothing");
  const loop = [{ ...axNode(innerSpan, "generic", ""), parentId: String(b(internalsHost)) }, { ...axNode(internalsHost, "generic", ""), parentId: String(b(innerSpan)) }];
  assert.equal(axControl(loop, b(innerSpan)), null, "a cycle ends");
});

test("reach takes the union of both walks, and accepted lets a click through only to what was judged", () => {
  // The slotted span: both walks agree on the shadow button.
  const agree = [axNode(span, "generic", "", slot), axNode(slot, "none", "", shadowButton, true), axNode(shadowButton, "button", "Delete", host), axNode(host, "generic", "")];
  assert.deepEqual(reach(dom, b(span), agree), { hit: b(span), controls: [b(shadowButton)] });
  // The ElementInternals host: only the accessibility walk sees a control.
  const internals = [axNode(innerSpan, "generic", "", internalsHost), axNode(internalsHost, "button", "Delete")];
  assert.deepEqual(reach(dom, b(innerSpan), internals), { hit: b(innerSpan), controls: [b(internalsHost)] });
  // A disagreement (aria-owns moved the label's text under another control): both are judged, the DOM's first.
  const owned = [axNode(label, "LabelText", "", internalsHost), axNode(internalsHost, "button", "Delete")];
  assert.deepEqual(reach(dom, b(label), owned), { hit: b(label), controls: [b(cancel), b(internalsHost)] });
  // A plain cell with nothing above it.
  assert.deepEqual(reach(dom, b(cell), [axNode(cell, "cell", "Nov 8")]), { hit: b(cell), controls: [] });

  const judged = { b: b(shadowButton), controls: [b(shadowButton)] };
  assert.ok(accepted(dom, { hit: b(span), controls: [b(shadowButton)] }, judged));
  assert.ok(!accepted(dom, { hit: b(span), controls: [b(shadowButton), b(internalsHost)] }, judged), "a second control appearing refuses");
  assert.ok(!accepted(dom, { hit: b(cancel), controls: [b(cancel)] }, judged), "another control refuses");
  assert.ok(!accepted(dom, { hit: b(cell), controls: [] }, judged), "the judged control gone plain refuses");
  const both = { b: b(cancel), controls: [b(cancel), b(internalsHost)] };
  assert.ok(accepted(dom, { hit: b(label), controls: [b(cancel)] }, both), "when both were judged, reaching one of them is fine");
  const plain = { b: b(cell), controls: [] as number[] };
  assert.ok(accepted(dom, { hit: b(cell), controls: [] }, plain));
  assert.ok(accepted(dom, { hit: b(cellText), controls: [] }, plain), "the cell's text node is inside it");
  assert.ok(!accepted(dom, { hit: b(cell), controls: [b(cancel)] }, plain), "a control wrapping the plain element refuses");
});

test("reach walks from the slotted text node the hit test climbed to its host, and keeps the host as the hit", () => {
  // R26: <x-btn>Delete</x-btn> with a shadow <button><slot>: the hit test returns the host for a click on the bare text.
  const text = txt("Delete");
  const slot2 = el("SLOT", [], [], { distributedNodes: [{ backendNodeId: text.backendNodeId }] });
  const button2 = el("BUTTON", [], [slot2]);
  const root2: CdpDomNode = { nodeId: ++id, backendNodeId: id, nodeType: 11, nodeName: "#document-fragment", shadowRootType: "open", children: [button2] };
  const host2 = el("X-BTN", [], [text], { shadowRoots: [root2] });
  const d = indexDom({ nodeId: ++id, backendNodeId: id, nodeType: 9, nodeName: "#document", children: [el("HTML", [], [el("BODY", [], [host2])], { frameId: "F2" })] });
  assert.equal(flatParent(d, b(text)), b(slot2), "a slotted text node's flat-tree parent is its slot");
  assert.deepEqual(reach(d, b(host2), [], b(text)), { hit: b(host2), controls: [b(button2)] });
  assert.deepEqual(reach(d, b(host2), []), { hit: b(host2), controls: [] }, "from the host itself (a hit on its padding) nothing in its shadow tree is guessed at");
  assert.ok(accepted(d, reach(d, b(host2), [], b(text)), { b: b(button2), controls: [b(button2)] }), "the same reach at click time is accepted");
});
