// The page as text for the agent (agent-computer D9, D21, §4.2). The browser reads the pierced DOM tree (frames and shadow
// roots included) and each frame's accessibility tree; `indexDom` and `mergeFrames` join them, and `formatSnapshot`
// prints one line per named or roled node with a ref the agent can click. A password field's value never prints: the
// field shows "••••••", its subtree is skipped, and its value (AX and DOM) is scrubbed from every other line (D9). The
// whole text is wrapped as untrusted page data with its origin (D21) and capped at 40,000 characters. Pure: no Electron.

import type { Target } from "./categories";

/** `opaque`: the node owns a frame from another site, whose contents this page's DevTools session cannot read. */
export interface AxNode { nodeId: string; backendDOMNodeId?: number; role: string; name: string; value?: string; ignored: boolean; childIds: string[]; frameId?: string; inForm?: boolean; fileInput?: boolean; opaque?: boolean }
export interface Snapshot { text: string; refs: Map<string, { backendNodeId: number; frameId?: string; target: Target }>; truncated: boolean }

/** A node of `DOM.getDocument({ depth: -1, pierce: true })`, the fields used here. */
export interface CdpDomNode {
  nodeId: number; backendNodeId: number; nodeType: number; nodeName: string; nodeValue?: string; attributes?: string[]; frameId?: string;
  children?: CdpDomNode[]; shadowRoots?: CdpDomNode[]; shadowRootType?: string; contentDocument?: CdpDomNode;
  /** On a <slot>: the light-DOM nodes assigned to it (the flat tree's children of the slot). */
  distributedNodes?: { backendNodeId: number }[];
}
/** A node of `Accessibility.getFullAXTree`, the fields used here. */
export interface CdpAxNode { nodeId: string; ignored: boolean; role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown }; childIds?: string[]; parentId?: string; backendDOMNodeId?: number }

/** What the browser needs to know about a page's DOM, keyed by backend node id (stable for the document's life). */
export interface DomIndex {
  /** Documents and author shadow roots, the roots `DOM.querySelectorAll` runs on; `depth` counts frame and shadow boundaries. */
  roots: { nodeId: number; frameId?: string; depth: number }[];
  /** The node id (valid until the next `DOM.getDocument`) to backend node id. */
  backendOf: Map<number, number>;
  /** A node's parent; a shadow root's is its host and a frame's document's is its owner element. */
  parent: Map<number, number>;
  /** A slotted node to the <slot> it is assigned to: its parent in the flat tree, where a click travels (R26). */
  slotOf: Map<number, number>;
  /** Each shadow host to its author shadow roots. */
  shadowRoots: Map<number, number[]>;
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
  /** Elements a click activates (R26): buttons, links with an href, form controls, summaries, click-capable roles. */
  activatable: Set<number>;
  /** Each label to the control its click is forwarded to (its `for=` target or first nested control), or null. */
  labels: Map<number, number | null>;
  /** An activatable element's role from its markup, for when the accessibility tree hides it. */
  roles: Map<number, string>;
  /** An activatable element's name from its markup (aria-label, a button input's value, an image input's alt, title). */
  hints: Map<number, string>;
  /** Inputs and textareas a person types into (not button-type inputs): what they hold is never a name (D9). */
  textFields: Set<number>;
  /** Light-DOM children (no shadow roots, no frame documents) and text node values, for `domText`. */
  children: Map<number, number[]>;
  values: Map<number, string>;
}

/** Roles that take a click as a control (agent-computer D43, R26). */
export const CLICK_ROLES: ReadonlySet<string> = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio",
  "switch", "tab", "option", "textbox", "searchbox", "combobox", "slider", "spinbutton", "listbox", "treeitem"]);
const LABELABLE = new Set(["BUTTON", "INPUT", "METER", "OUTPUT", "PROGRESS", "SELECT", "TEXTAREA"]);
const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image"]);
const INPUT_ROLES: Record<string, string> = {
  button: "button", submit: "button", reset: "button", image: "button", file: "button", checkbox: "checkbox", radio: "radio",
  range: "slider", number: "spinbutton", search: "searchbox",
};

/** The role an element's markup gives it when a click activates it, else undefined. */
function nativeRole(n: CdpDomNode, name: string): string | undefined {
  const role = attr(n, "role")?.trim().toLowerCase().split(/\s+/)[0];
  if (role && CLICK_ROLES.has(role)) return role;
  switch (name) {
    case "BUTTON": case "SUMMARY": return "button";
    case "A": case "AREA": return attr(n, "href") !== undefined ? "link" : undefined;
    case "SELECT": return "combobox";
    case "TEXTAREA": return "textbox";
    case "INPUT": {
      const type = (attr(n, "type") ?? "text").toLowerCase();
      return type === "hidden" ? undefined : INPUT_ROLES[type] ?? "textbox";
    }
    default: return undefined;
  }
}

export const SNAPSHOT_CAP = 40_000;
export const REDACTED = "••••••";

const NAME_MAX = 1_000;
const URL_MAX = 2_000;
const OPAQUE = " (a frame from another site: its contents cannot be read)";
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
    slotOf: new Map(), shadowRoots: new Map(), frameOwners: new Map(), remoteFrames: new Set(), activatable: new Set(), labels: new Map(),
    roles: new Map(), hints: new Map(), textFields: new Set(), children: new Map(), values: new Map(),
  };
  const mainFrame = root.children?.find((c) => c.frameId)?.frameId;
  // `scope` is the tree a node's ids resolve in (its document or shadow root); `label` the nearest label without for=.
  type Item = { n: CdpDomNode; parent?: number; form: boolean; frame?: string; depth: number; scope: number; label?: number };
  const stack: Item[] = [{ n: root, form: false, frame: mainFrame, depth: 0, scope: root.backendNodeId }];
  const ids = new Map<string, number>();
  const labelable = new Set<number>();
  const pending: { label: number; scope: number; id: string }[] = [];
  while (stack.length) {
    const { n, parent, form: inheritedForm, frame, depth, scope, label } = stack.pop()!;
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
    if (n.nodeType === 3) ix.values.set(b, n.nodeValue ?? "");
    ix.children.set(b, (n.children ?? []).map((c) => c.backendNodeId));
    for (const d of n.distributedNodes ?? []) ix.slotOf.set(d.backendNodeId, b);
    const authorRoots = (n.shadowRoots ?? []).filter((s) => s.shadowRootType !== "user-agent");
    if (authorRoots.length) ix.shadowRoots.set(b, authorRoots.map((s) => s.backendNodeId));
    let ownLabel = label;
    if (n.nodeType === 1) {
      const id = attr(n, "id");
      // Duplicate ids: the first element wins, as it does for the page's own `for=` lookups.
      if (id && !ids.has(`${scope}|${id}`)) ids.set(`${scope}|${id}`, b);
      const type = name === "INPUT" ? (attr(n, "type") ?? "text").toLowerCase() : "";
      if (name === "TEXTAREA" || (name === "INPUT" && type !== "hidden" && !BUTTON_INPUTS.has(type))) ix.textFields.add(b);
      const role = nativeRole(n, name);
      if (role) {
        ix.activatable.add(b);
        ix.roles.set(b, role);
        // D9: an input's `value` is a label only on a button-type input (a text field's value is what was typed into it).
        const own = type === "image" ? attr(n, "alt") : BUTTON_INPUTS.has(type) ? attr(n, "value") : undefined;
        const hint = attr(n, "aria-label") ?? own ?? attr(n, "title");
        if (hint?.trim()) ix.hints.set(b, hint.trim());
      }
      if (LABELABLE.has(name) && !(name === "INPUT" && attr(n, "type")?.toLowerCase() === "hidden")) {
        labelable.add(b);
        if (label !== undefined && ix.labels.get(label) === null) ix.labels.set(label, b);
      }
      if (name === "LABEL") {
        const forId = attr(n, "for");
        ix.labels.set(b, null);
        if (forId !== undefined) pending.push({ label: b, scope, id: forId });
        else ownLabel = b;
      }
    }
    // Pushed in reverse so the walk (and the roots) come out in document order.
    const next: typeof stack = [];
    for (const c of n.children ?? []) next.push({ n: c, parent: b, form, frame, depth, scope, label: ownLabel });
    for (const s of n.shadowRoots ?? []) next.push({ n: s, parent: b, form, frame, depth: depth + 1, scope: s.backendNodeId });
    if (n.contentDocument) next.push({ n: n.contentDocument, parent: b, form: false, frame: n.frameId, depth: depth + 1, scope: n.contentDocument.backendNodeId });
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
  }
  for (const p of pending) {
    const target = ids.get(`${p.scope}|${p.id}`);
    ix.labels.set(p.label, target !== undefined && labelable.has(target) ? target : null);
  }
  ix.roots.sort((a, b) => a.depth - b.depth);
  return ix;
}

/** A node's light-DOM text, whitespace collapsed, cut at `max` characters (a control's text aria-owns moved away). */
export function domText(dom: DomIndex, b: number, max = 300): string {
  let out = "";
  const stack = [b];
  while (stack.length && out.length < max) {
    const n = stack.pop()!;
    const v = dom.values.get(n);
    if (v !== undefined) out += v;
    const kids = dom.children.get(n) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
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
        ...(b !== undefined && dom.remoteFrames.has(b) ? { opaque: true } : {}),
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

/** Secrets of fewer characters scrub only as a whole word, and only when all digits or from a one-time-code field. */
const SHORT_SECRET = 4;
const literal = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/**
 * D9: the scrub for secrets, the current values of sensitive fields, from any text that leaves the main process: a
 * snapshot line, a title, a URL, an ask title, a note or a tool reply (R27: Chrome names a label's checkbox or an
 * aria-labelledby button from an embedded one-time-code field's value). Whitespace is collapsed on both sides (a name
 * carries "12 3456" for a value "12  3456" or "12\t3456"); longest first, so a secret inside another goes with it.
 * A secret of fewer than 4 characters goes only as a whole word, and only when it is all digits (a one-time code typed
 * so far) or in `whole` (the value of a one-time-code field): a short password stays, so prose keeps its "a". Bullet-only
 * strings are not secrets. The gate never sees the result: it judges raw names (Task 11b), and this runs on the way out.
 */
export function scrubber(values: Iterable<string | undefined>, whole: Iterable<string | undefined> = []): (s: string) => string {
  const secrets = new Set<string>();
  const add = (v: string | undefined, short: boolean): void => {
    const t = v?.replace(/\s+/g, " ").trim();
    if (t && !/^[•●* ]+$/.test(t) && (t.length >= SHORT_SECRET || short)) secrets.add(t);
  };
  for (const v of values) add(v, /^\d+$/.test(v?.trim() ?? ""));
  for (const v of whole) add(v, true);
  const patterns = [...secrets].sort((a, b) => b.length - a.length).map((x) => {
    const body = x.split(" ").map(literal).join("\\s+");
    return x.length >= SHORT_SECRET ? new RegExp(body, "gu") : new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "gu");
  });
  return (s) => patterns.reduce((acc, re) => acc.replace(re, () => REDACTED), s);
}

/** The forms a value takes inside a URL (R37): as typed, percent-encoded (a path or a fragment: `p%40ss`,
 *  `correct%20horse`) and form-encoded as a GET submit writes it (spaces as `+`: `correct+horse`). */
const urlForms = (v: string): string[] => {
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return [];
  return [...new Set([t, encodeURIComponent(t), new URLSearchParams([["k", t]]).toString().slice(2)])];
};

/**
 * D9 with R35 and R37: the scrub for a URL string (a tab's URL, `open()`'s reply, a navigation note, a snapshot's `url`
 * attribute). Every value goes in each form it takes in a URL (`urlForms`), `whole` ones as whole words however short;
 * only the part after the origin is scrubbed (path, query, fragment, and any credentials): the scheme, host and port
 * stay, so a planted "localhost" cannot blank the address the agent is at (E6). A string that is not an http(s) URL is
 * scrubbed whole.
 */
export function urlScrubber(values: Iterable<string | undefined>, whole: Iterable<string | undefined> = []): (url: string) => string {
  const expand = (xs: Iterable<string | undefined>): string[] => [...xs].flatMap((x) => (x ? urlForms(x) : []));
  const scrub = scrubber(expand(values), expand(whole));
  return (url) => {
    let u: URL;
    try { u = new URL(url); } catch { return scrub(url); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return scrub(url);
    const auth = u.username || u.password ? `${scrub(u.username)}${u.password ? `:${scrub(u.password)}` : ""}@` : "";
    return `${u.protocol}//${auth}${u.host}${scrub(`${u.pathname}${u.search}${u.hash}`)}`;
  };
}

/** The values the sensitive nodes among `nodes` hold: each one's own value and the names and values under it (its inner
 *  text), from the protocol's accessibility nodes. */
export function secretsOf(nodes: CdpAxNode[], sensitive: ReadonlySet<number>): string[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const out: string[] = [];
  for (const n of nodes) {
    if (n.backendDOMNodeId === undefined || !sensitive.has(n.backendDOMNodeId)) continue;
    out.push(str(n.value?.value));
    const stack = [...(n.childIds ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const c = byId.get(stack.pop()!);
      if (!c || seen.has(c.nodeId)) continue;
      seen.add(c.nodeId);
      out.push(str(c.name?.value), str(c.value?.value));
      stack.push(...(c.childIds ?? []));
    }
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
 * A ref's `target` carries the raw name: it is what the gate judges (D9 is kept by scrubbing the text that leaves, never
 * the name that is judged, Task 11b); the browser's `scrub` runs on any text built from it.
 */
export function formatSnapshot(nodes: AxNode[], o: {
  origin: string; url: string; title: string; sensitive: ReadonlySet<number>; cap: number;
  /** The sensitive fields' DOM values, and those of one-time-code fields (`whole`: short ones scrub as whole words). */
  values?: Iterable<string | undefined>; whole?: Iterable<string | undefined>;
  /** The sensitive nodes that are one-time-code fields: their accessibility values go into `whole` too. */
  otp?: ReadonlySet<number>;
  /** Values another site carried into this page's URL (R35), by kind (R37): scrubbed from the `url` attribute only,
   *  after the origin (the `origin` attribute, scheme, host and port, is never scrubbed). */
  urlValues?: Iterable<string | undefined>; urlWhole?: Iterable<string | undefined>;
}): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const isSensitive = (n: AxNode): boolean => n.backendDOMNodeId !== undefined && o.sensitive.has(n.backendDOMNodeId);

  // D9: a sensitive field's value, and the text inside it, are secrets to scrub from every other line too (a label that
  // embeds the field, a title, a URL). `o.values` are the fields' DOM values, read by the browser: what Chrome composes
  // other names from (a type=number field's AX value is the parsed float, "123" for "000123").
  const secrets: (string | undefined)[] = [...(o.values ?? [])];
  const whole: (string | undefined)[] = [...(o.whole ?? [])];
  for (const n of nodes) {
    if (!isSensitive(n)) continue;
    const into = o.otp?.has(n.backendDOMNodeId!) ? whole : secrets;
    into.push(n.value);
    const stack = [...n.childIds];
    const seen = new Set<string>();
    while (stack.length) {
      const c = byId.get(stack.pop()!);
      if (!c || seen.has(c.nodeId)) continue;
      seen.add(c.nodeId);
      into.push(c.name, c.value);
      stack.push(...c.childIds);
    }
  }
  const scrub = scrubber(secrets, whole);
  const scrubUrl = urlScrubber([...secrets, ...(o.urlValues ?? [])], [...whole, ...(o.urlWhole ?? [])]);

  const url = scrubUrl(o.url);
  const open = `<untrusted-page origin="${attrValue(o.origin)}" url="${attrValue(url.length > URL_MAX ? `${url.slice(0, URL_MAX - 1)}…` : url)}">`;
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
        const line = `${"  ".repeat(depth)}${ref ? `[${ref}] ` : ""}${n.role || "node"}${name ? ` ${quote(name)}` : ""}${value ? ` value=${quote(value)}` : ""}${n.opaque ? OPAQUE : ""}`;
        if (used + 1 + line.length + reserve > o.cap) {
          truncated = true;
          more++;
        } else {
          lines.push(line);
          used += 1 + line.length;
          if (ref) refs.set(ref, { backendNodeId: n.backendDOMNodeId!, frameId: n.frameId, target: { role: n.role, name: n.name, inForm: !!n.inForm, fileInput: !!n.fileInput, ...(n.opaque ? { opaque: true } : {}) } });
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
