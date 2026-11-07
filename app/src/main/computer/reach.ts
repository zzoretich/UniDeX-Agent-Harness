// The control a click really reaches (agent-computer D43, R26). From the node a hit test returns, two walks look for
// the nearest element that takes the click as a control: one up the flat tree of the DOM (a slotted node steps to its
// slot before its DOM parent, so a web component's shadow <button> is found; a label forwards to its control), and one
// up the accessibility tree (a host whose role comes from ElementInternals, or anything aria-owns rearranged). The gate
// judges the union of what they find: when they disagree, both controls are judged and the click asks if either
// matches. Pure: the browser gathers the DOM index and the accessibility ancestors and delivers the click.

import { CLICK_ROLES, type CdpAxNode, type DomIndex } from "./snapshot";

/** What a click on `hit` reaches: the controls found by either walk (none for a plain element). */
export interface Reach { hit: number; controls: number[] }

/** A node's parent in the flat tree: its slot when it is slotted, else its DOM parent (a shadow root's is its host). */
export const flatParent = (dom: DomIndex, n: number): number | undefined => dom.slotOf.get(n) ?? dom.parent.get(n);

/** Whether node `a` sits inside node `b` in the flat tree (through slots, shadow hosts and frame owners). */
export function within(dom: DomIndex, a: number, b: number): boolean {
  for (let n = flatParent(dom, a); n !== undefined; n = flatParent(dom, n)) if (n === b) return true;
  return false;
}

/** The element a click on `hit` activates by the markup, walking flat-tree ancestors up to the node's document: a
 *  label forwards to its control, else the nearest activatable element, else none (the hit element as it is). */
export function activates(dom: DomIndex, hit: number): { b: number; actionable: boolean } {
  for (let n: number | undefined = hit; n !== undefined; n = dom.names.get(n) === "#document" ? undefined : flatParent(dom, n)) {
    if (dom.labels.has(n)) {
      const control = dom.labels.get(n);
      return control != null ? { b: control, actionable: true } : { b: n, actionable: true };
    }
    if (dom.activatable.has(n)) return { b: n, actionable: true };
  }
  return { b: hit, actionable: false };
}

/** The nearest accessibility node at or above `hit` with a click role, from `Accessibility.getPartialAXTree` with
 *  relatives (the chain ends at the frame's root); null when there is none or the chain cannot be read. */
export function axControl(nodes: CdpAxNode[], hit: number): number | null {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const seen = new Set<string>();
  for (let n = nodes.find((x) => x.backendDOMNodeId === hit); n && !seen.has(n.nodeId); n = n.parentId ? byId.get(n.parentId) : undefined) {
    seen.add(n.nodeId);
    if (!n.ignored && n.backendDOMNodeId !== undefined && CLICK_ROLES.has(String(n.role?.value ?? ""))) return n.backendDOMNodeId;
  }
  return null;
}

/** The union of both walks: the DOM's control first, then the accessibility tree's when it names another. */
export function reach(dom: DomIndex, hit: number, ax: CdpAxNode[]): Reach {
  const controls: number[] = [];
  const d = activates(dom, hit);
  if (d.actionable) controls.push(d.b);
  const a = axControl(ax, hit);
  if (a !== null && !controls.includes(a)) controls.push(a);
  return { hit, controls };
}

/** Whether a click that now reaches `now` still activates only what was judged: every control it reaches now was
 *  judged, or both are plain and the node there is the judged element or inside it. */
export function accepted(dom: DomIndex, now: Reach, judged: { b: number; controls: number[] }): boolean {
  if (now.controls.length) return now.controls.every((c) => judged.controls.includes(c));
  return judged.controls.length === 0 && (now.hit === judged.b || within(dom, now.hit, judged.b));
}
