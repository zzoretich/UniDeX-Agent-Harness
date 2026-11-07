// The page as text for the agent (agent-computer D9, D21, §4.2). The browser reads the pierced DOM tree (frames and shadow
// roots included) and each frame's accessibility tree; `indexDom` and `mergeFrames` join them, and `formatSnapshot`
// prints one line per named or roled node with a ref the agent can click. A password field's value never prints: the
// field shows "••••••", its subtree is skipped, and its text is scrubbed from every other line (D9). The whole text is
// wrapped as untrusted page data with its origin (D21) and capped at 40,000 characters. Pure: no Electron here.

import type { Target } from "./categories";

export interface AxNode { nodeId: string; backendDOMNodeId?: number; role: string; name: string; value?: string; ignored: boolean; childIds: string[]; frameId?: string; inForm?: boolean; fileInput?: boolean }
export interface Snapshot { text: string; refs: Map<string, { backendNodeId: number; frameId?: string; target: Target }>; truncated: boolean }

/** A node of `DOM.getDocument({ depth: -1, pierce: true })`, the fields used here. */
export interface CdpDomNode {
  nodeId: number; backendNodeId: number; nodeType: number; nodeName: string; attributes?: string[]; frameId?: string;
  children?: CdpDomNode[]; shadowRoots?: CdpDomNode[]; shadowRootType?: string; contentDocument?: CdpDomNode;
}
/** A node of `Accessibility.getFullAXTree`, the fields used here. */
export interface CdpAxNode { nodeId: string; ignored: boolean; role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown }; childIds?: string[]; backendDOMNodeId?: number }

/** What the browser needs to know about a page's DOM, keyed by backend node id (stable for the document's life). */
export interface DomIndex {
  /** Documents and author shadow roots, the roots `DOM.querySelectorAll` runs on; `depth` counts frame and shadow boundaries. */
  roots: { nodeId: number; frameId?: string; depth: number }[];
  /** The node id (valid until the next `DOM.getDocument`) to backend node id. */
  backendOf: Map<number, number>;
  /** A node's parent; a shadow root's is its host and a frame's document's is its owner element. */
  parent: Map<number, number>;
  /** Node names ("TEXTAREA", "#document", "#text"). */
  names: Map<number, string>;
  /** The frame each node's document belongs to. */
  frameOf: Map<number, string>;
  inForm: Set<number>;
  fileInput: Set<number>;
  /** Frame owner elements whose document is in this tree, to their frame id. */
  frameOwners: Map<number, string>;
  /** Frame owner elements whose document lives in another process (a cross-site frame): not readable here. */
  remoteFrames: Set<number>;
}

export const SNAPSHOT_CAP = 40_000;
export const REDACTED = "••••••";

const NAME_MAX = 1_000;
// Roles that print only when they carry a name.
const QUIET = new Set(["none", "generic", "Ignored", "IgnoredRole", "LineBreak", "presentation"]);
// Roles that never print (the title has its own line; inline boxes repeat their text).
const SKIP = new Set(["RootWebArea", "WebArea", "InlineTextBox"]);

const attr = (doc: CdpDomNode, name: string): string | undefined => {
  const a = doc.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) if (a[i].toLowerCase() === name) return a[i + 1];
  return undefined;
};

/** Indexes a pierced DOM tree. A form reaches into its shadow trees (failing towards asking) but not into frames. */
export function indexDom(root: CdpDomNode): DomIndex {
  const ix: DomIndex = {
    roots: [], backendOf: new Map(), parent: new Map(), names: new Map(), frameOf: new Map(), inForm: new Set(), fileInput: new Set(),
    frameOwners: new Map(), remoteFrames: new Set(),
  };
  const mainFrame = root.children?.find((c) => c.frameId)?.frameId;
  const stack: { n: CdpDomNode; parent?: number; form: boolean; frame?: string; depth: number }[] = [{ n: root, form: false, frame: mainFrame, depth: 0 }];
  while (stack.length) {
    const { n, parent, form: inheritedForm, frame, depth } = stack.pop()!;
    const b = n.backendNodeId;
    ix.backendOf.set(n.nodeId, b);
    ix.names.set(b, n.nodeName);
    if (parent !== undefined) ix.parent.set(b, parent);
    if (frame) ix.frameOf.set(b, frame);
    if (n.nodeType === 9 || (n.nodeType === 11 && n.shadowRootType !== "user-agent")) ix.roots.push({ nodeId: n.nodeId, frameId: frame, depth });
    const name = n.nodeName.toUpperCase();
    const form = inheritedForm || name === "FORM";
    if (inheritedForm || (n.nodeType === 1 && attr(n, "form"))) ix.inForm.add(b);
    if (name === "INPUT" && attr(n, "type")?.toLowerCase() === "file") ix.fileInput.add(b);
    if (n.nodeType === 1 && n.frameId && /^(I?FRAME|OBJECT|EMBED|PORTAL|FENCEDFRAME)$/.test(name)) {
      if (n.contentDocument) ix.frameOwners.set(b, n.frameId);
      else ix.remoteFrames.add(b);
    }
    // Pushed in reverse so the walk (and the roots) come out in document order.
    const next: typeof stack = [];
    for (const c of n.children ?? []) next.push({ n: c, parent: b, form, frame, depth });
    for (const s of n.shadowRoots ?? []) next.push({ n: s, parent: b, form, frame, depth: depth + 1 });
    if (n.contentDocument) next.push({ n: n.contentDocument, parent: b, form: false, frame: n.frameId, depth: depth + 1 });
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
  }
  ix.roots.sort((a, b) => a.depth - b.depth);
  return ix;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/**
 * Joins each frame's accessibility tree into one: node ids are made unique per frame, every node carries its frame id
 * and its form and file-input facts, and a frame's root hangs under its owner's iframe node. The main frame comes first.
 */
export function mergeFrames(frames: { frameId: string; nodes: CdpAxNode[] }[], dom: DomIndex): AxNode[] {
  const out: AxNode[] = [];
  const rootOf = new Map<string, string>();
  const owners: AxNode[] = [];
  frames.forEach(({ frameId, nodes }, i) => {
    const id = (n: string): string => `${i}:${n}`;
    nodes.forEach((n, k) => {
      const b = n.backendDOMNodeId;
      const node: AxNode = {
        nodeId: id(n.nodeId), role: str(n.role?.value), name: str(n.name?.value), ignored: n.ignored, childIds: (n.childIds ?? []).map(id), frameId,
        ...(b === undefined ? {} : { backendDOMNodeId: b, inForm: dom.inForm.has(b), fileInput: dom.fileInput.has(b) }),
      };
      const value = str(n.value?.value);
      if (value) node.value = value;
      if (k === 0) rootOf.set(frameId, node.nodeId);
      if (b !== undefined && dom.frameOwners.has(b)) owners.push(node);
      out.push(node);
    });
  });
  for (const o of owners) {
    const child = rootOf.get(dom.frameOwners.get(o.backendDOMNodeId!)!);
    if (child && !o.childIds.includes(child)) o.childIds.push(child);
  }
  return out;
}

/** A JSON-quoted string that cannot open or close a tag. */
const quote = (s: string): string => JSON.stringify(s).replace(/</g, "\\u003c");
const attrValue = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > NAME_MAX ? `${one.slice(0, NAME_MAX)}…` : one;
};

/**
 * The page as text: `title "…"`, then one line per named or roled node in document order, indented by depth, such as
 * `[e12] button "Merge pull request"` or `[e3] textbox "Password" value="••••••"`, wrapped as
 * `<untrusted-page origin="…" url="…">…</untrusted-page>` and cut at `cap` characters with `[truncated: N more nodes]`.
 */
export function formatSnapshot(nodes: AxNode[], o: { origin: string; url: string; title: string; sensitive: ReadonlySet<number>; cap: number }): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const isSensitive = (n: AxNode): boolean => n.backendDOMNodeId !== undefined && o.sensitive.has(n.backendDOMNodeId);

  // D9: a sensitive field's value, and the text inside it, are secrets to scrub from every other line too (a label that
  // embeds the field, a title, a URL). Bullet-only strings and very short ones are not worth scrubbing.
  const secrets = new Set<string>();
  const keep = (s: string | undefined): void => { const t = s?.trim(); if (t && t.length >= 4 && !/^[•●*\s]+$/.test(t)) secrets.add(t); };
  for (const n of nodes) {
    if (!isSensitive(n)) continue;
    keep(n.value);
    const stack = [...n.childIds];
    const seen = new Set<string>();
    while (stack.length) {
      const c = byId.get(stack.pop()!);
      if (!c || seen.has(c.nodeId)) continue;
      seen.add(c.nodeId);
      keep(c.name);
      keep(c.value);
      stack.push(...c.childIds);
    }
  }
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  const scrub = (s: string): string => ordered.reduce((acc, x) => (acc.includes(x) ? acc.split(x).join(REDACTED) : acc), s);

  const open = `<untrusted-page origin="${attrValue(scrub(o.origin))}" url="${attrValue(scrub(o.url))}">`;
  const close = "</untrusted-page>";
  const lines = [open, `title ${quote(clip(scrub(o.title)))}`];
  const reserve = `\n[truncated: ${nodes.length} more nodes]`.length + 1 + close.length;
  let used = lines[0].length + 1 + lines[1].length;
  const refs: Snapshot["refs"] = new Map();
  let truncated = false;
  let more = 0;

  const children = new Set<string>();
  for (const n of nodes) for (const c of n.childIds) children.add(c);
  const seen = new Set<string>();
  // Depth-first, iterative (a deep page must not overflow the stack); `parentName` dedupes a StaticText that repeats
  // the name of the line it sits under.
  const stack: { id: string; depth: number; parentName: string }[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) if (!children.has(nodes[i].nodeId)) stack.push({ id: nodes[i].nodeId, depth: 0, parentName: "" });
  while (stack.length) {
    const { id, depth, parentName } = stack.pop()!;
    const n = byId.get(id);
    if (!n || seen.has(id)) continue;
    seen.add(id);
    const sensitive = isSensitive(n);
    const name = n.ignored ? "" : clip(scrub(n.name));
    const prints = !n.ignored && !SKIP.has(n.role) && (name !== "" || (n.role !== "" && !QUIET.has(n.role)))
      && !(n.role === "StaticText" && name === parentName);
    let childDepth = depth;
    let childParent = parentName;
    if (prints) {
      childDepth = depth + 1;
      childParent = name;
      if (truncated) {
        more++;
      } else {
        const ref = n.backendDOMNodeId === undefined ? null : `e${refs.size + 1}`;
        const value = sensitive ? (n.value ? REDACTED : "") : clip(scrub(n.value ?? ""));
        const line = `${"  ".repeat(depth)}${ref ? `[${ref}] ` : ""}${n.role || "node"}${name ? ` ${quote(name)}` : ""}${value ? ` value=${quote(value)}` : ""}`;
        if (used + 1 + line.length + reserve > o.cap) {
          truncated = true;
          more++;
        } else {
          lines.push(line);
          used += 1 + line.length;
          if (ref) refs.set(ref, { backendNodeId: n.backendDOMNodeId!, frameId: n.frameId, target: { role: n.role, name: scrub(n.name), inForm: !!n.inForm, fileInput: !!n.fileInput } });
        }
      }
    }
    // D9: nothing under a sensitive field prints (its inner text node holds the value).
    if (sensitive) continue;
    for (let i = n.childIds.length - 1; i >= 0; i--) stack.push({ id: n.childIds[i], depth: childDepth, parentName: childParent });
  }
  if (truncated) lines.push(`[truncated: ${more} more nodes]`);
  lines.push(close);
  return { text: lines.join("\n"), refs, truncated };
}
