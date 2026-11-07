import { test } from "node:test";
import assert from "node:assert/strict";
import { accepted, activates, axControl, flatParent, hostsAbove, reach, within } from "../../src/main/computer/reach";
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
  assert.deepEqual(reach(dom, b(span), [{ from: b(span), ax: agree }]), { hit: b(span), controls: [b(shadowButton)] });
  // The ElementInternals host: only the accessibility walk sees a control.
  const internals = [axNode(innerSpan, "generic", "", internalsHost), axNode(internalsHost, "button", "Delete")];
  assert.deepEqual(reach(dom, b(innerSpan), [{ from: b(innerSpan), ax: internals }]), { hit: b(innerSpan), controls: [b(internalsHost)] });
  // A disagreement (aria-owns moved the label's text under another control): both are judged, the DOM's first.
  const owned = [axNode(label, "LabelText", "", internalsHost), axNode(internalsHost, "button", "Delete")];
  assert.deepEqual(reach(dom, b(label), [{ from: b(label), ax: owned }]), { hit: b(label), controls: [b(cancel), b(internalsHost)] });
  // A plain cell with nothing above it.
  assert.deepEqual(reach(dom, b(cell), [{ from: b(cell), ax: [axNode(cell, "cell", "Nov 8")] }]), { hit: b(cell), controls: [] });

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
  assert.deepEqual(reach(d, b(host2), [{ from: b(text), ax: [] }]), { hit: b(host2), controls: [b(button2)] });
  assert.deepEqual(reach(d, b(host2), [{ from: b(host2), ax: [] }]), { hit: b(host2), controls: [] }, "from the host itself (a hit on its padding) nothing in its shadow tree is guessed at");
  assert.ok(accepted(d, reach(d, b(host2), [{ from: b(text), ax: [] }]), { b: b(button2), controls: [b(button2)] }), "the same reach at click time is accepted");
});

test("on a shadow-host hit the walks start from the slotted text and the host both, and the union is judged (D43, R26, Task 11b)", () => {
  // N2: <x-n2 role=button aria-label="Delete item 3">Item 3</x-n2> with a shadow <a href style="pointer-events:none"><slot>.
  // The text is unhittable, so the click lands on the host; the hit test returns the host either way. Judging only the
  // text's walk gives link "Item 3" (GO); the host's walk gives the button, so both are judged and the click asks.
  const text = txt("Item 3");
  const slot3 = el("SLOT", [], [], { distributedNodes: [{ backendNodeId: text.backendNodeId }] });
  const link = el("A", ["href", "#help", "style", "pointer-events:none"], [slot3]);
  const root3: CdpDomNode = { nodeId: ++id, backendNodeId: id, nodeType: 11, nodeName: "#document-fragment", shadowRootType: "open", children: [link] };
  const host3 = el("X-N2", ["role", "button", "aria-label", "Delete item 3"], [text], { shadowRoots: [root3] });
  // N2c: a light-DOM <button aria-label="Delete item 3"> around a host with no role of its own.
  const text4 = txt("Item 3");
  const slot4 = el("SLOT", [], [], { distributedNodes: [{ backendNodeId: text4.backendNodeId }] });
  const link4 = el("A", ["href", "#help"], [slot4]);
  const root4: CdpDomNode = { nodeId: ++id, backendNodeId: id, nodeType: 11, nodeName: "#document-fragment", shadowRootType: "open", children: [link4] };
  const host4 = el("X-N2C", [], [text4], { shadowRoots: [root4] });
  const outer = el("BUTTON", ["aria-label", "Delete item 3"], [host4]);
  const d = indexDom({ nodeId: ++id, backendNodeId: id, nodeType: 9, nodeName: "#document", children: [el("HTML", [], [el("BODY", [], [host3, outer])], { frameId: "F3" })] });
  const axText = [axNode(text, "StaticText", "Item 3", link), axNode(link, "link", "Item 3", host3), axNode(host3, "button", "Delete item 3")];
  const axHost = [axNode(host3, "button", "Delete item 3")];
  assert.deepEqual(reach(d, b(host3), [{ from: b(text), ax: axText }]), { hit: b(host3), controls: [b(link)] }, "the text's walk alone sees only the link");
  const both = reach(d, b(host3), [{ from: b(text), ax: axText }, { from: b(host3), ax: axHost }]);
  assert.deepEqual(both, { hit: b(host3), controls: [b(link), b(host3)] }, "the union: the link and the host, each once");
  assert.ok(accepted(d, both, { b: b(link), controls: [b(link), b(host3)] }), "the same union at click time is accepted");
  assert.ok(!accepted(d, both, { b: b(link), controls: [b(link)] }), "a judgement that missed the host refuses");
  // N2c: the host's walk climbs the light DOM to the button around it (where the click really lands).
  const c = reach(d, b(host4), [{ from: b(text4), ax: [] }, { from: b(host4), ax: [] }]);
  assert.deepEqual(c, { hit: b(host4), controls: [b(link4), b(outer)] });
  // The same control reached from both starts is listed once.
  assert.deepEqual(reach(d, b(outer), [{ from: b(host4), ax: [] }, { from: b(outer), ax: [] }]), { hit: b(outer), controls: [b(outer)] });
});

test("a hit inside a shadow tree also starts a walk from each host above it, where the click bubbles (D43, R26, Task 11b)", () => {
  // N8: <x-n8 role=button aria-label="Delete item 3">Item 3</x-n8>, shadow <a href><span style="visibility:hidden"><slot>.
  // The hidden text cannot be hit, so the hit test returns the shadow link; the click lands on it and bubbles to the host.
  const text = txt("Item 3");
  const slot5 = el("SLOT", [], [], { distributedNodes: [{ backendNodeId: text.backendNodeId }] });
  const hiddenSpan = el("SPAN", ["style", "visibility:hidden"], [slot5]);
  const link5 = el("A", ["href", "#help"], [hiddenSpan]);
  const root5: CdpDomNode = { nodeId: ++id, backendNodeId: id, nodeType: 11, nodeName: "#document-fragment", shadowRootType: "open", children: [link5] };
  const host5 = el("X-N8", ["role", "button", "aria-label", "Delete item 3"], [text], { shadowRoots: [root5] });
  // A nested case: a plain host whose shadow tree holds another host with a shadow button, all inside a light <button>.
  const innerButton = el("BUTTON", [], [txt("Go")]);
  const innerRoot: CdpDomNode = { nodeId: ++id, backendNodeId: id, nodeType: 11, nodeName: "#document-fragment", shadowRootType: "open", children: [innerButton] };
  const innerHost = el("X-IN", [], [], { shadowRoots: [innerRoot] });
  const outerRoot: CdpDomNode = { nodeId: ++id, backendNodeId: id, nodeType: 11, nodeName: "#document-fragment", shadowRootType: "open", children: [innerHost] };
  const outerHost = el("X-OUT", [], [], { shadowRoots: [outerRoot] });
  const lightButton = el("BUTTON", ["aria-label", "Delete all"], [outerHost]);
  const d = indexDom({ nodeId: ++id, backendNodeId: id, nodeType: 9, nodeName: "#document", children: [el("HTML", [], [el("BODY", [], [host5, lightButton])], { frameId: "F4" })] });
  assert.deepEqual(hostsAbove(d, b(link5)), [b(host5)], "the host whose shadow tree holds the link");
  assert.deepEqual(hostsAbove(d, b(host5)), [], "a host in the light DOM is inside no shadow tree");
  assert.deepEqual(hostsAbove(d, b(text)), [], "slotted light-DOM text is a child of its host, not of its shadow tree");
  assert.deepEqual(hostsAbove(d, b(innerButton)), [b(innerHost), b(outerHost)], "nested hosts, nearest first");
  const axLink = [axNode(link5, "link", "Item 3", host5), axNode(host5, "button", "Delete item 3")];
  assert.deepEqual(reach(d, b(link5), [{ from: b(link5), ax: axLink }]), { hit: b(link5), controls: [b(link5)] }, "the link's own walks stop at the link");
  const both = reach(d, b(link5), [{ from: b(link5), ax: axLink }, ...hostsAbove(d, b(link5)).map((from) => ({ from, ax: [axNode(host5, "button", "Delete item 3")] }))]);
  assert.deepEqual(both, { hit: b(link5), controls: [b(link5), b(host5)] }, "with the host's walk the button is judged too");
  const nested = reach(d, b(innerButton), [{ from: b(innerButton), ax: [] }, ...hostsAbove(d, b(innerButton)).map((from) => ({ from, ax: [] }))]);
  assert.deepEqual(nested, { hit: b(innerButton), controls: [b(innerButton), b(lightButton)] }, "the light-DOM button the click bubbles to, once");
});
