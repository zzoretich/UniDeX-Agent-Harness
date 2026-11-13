// The verdict for one agent action in the Computer pane (agent-computer D9, D17, D39, §4.2): go, ask the person first,
// or refuse. Pure: the service gathers the facts (access level, whether the site is marked, what has focus) and acts on
// the verdict. What asks by label is the D43 vocabulary in ./categories.

import { categoryOf, type AskCategory, type Target } from "./categories";
import { REFUSAL } from "./refusals";
import { navAllowed } from "../policy/computer-url";

export type Access = "read" | "edit" | "run" | "host";

/** What has keyboard focus. `plainTextarea`: a native <textarea> with no key listener on it or an ancestor. `shown`: the
 *  target's name scrubbed of every sensitive field's value as read in the same call (D9), "" with no target: the only
 *  name to put in text that leaves the main process (an ask title, a note, a reply); `target.name` is raw, for the gate.
 *  `node` and `frame` (R76): the focused element's backend DOM node id and the frame its document is in, null when
 *  nothing has focus or they cannot be read; a judged key or typing is bound to them, so two same-named controls differ. */
export interface Focus { target: Target | null; shown: string; sensitive: boolean; plainTextarea: boolean; node: number | null; frame: string | null }

export type Action =
  | { kind: "status" | "snapshot" | "screenshot" | "wait" | "scroll" }
  | { kind: "open"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "key"; key: string; focus: Focus }
  | { kind: "type"; text: string; focus: Focus };

/** `frame`: input into a frame from another site, which cannot be read or judged by label (asked on every site). */
export type AskWhy = AskCategory | "unmarked" | "return" | "file" | "permission" | "frame" | "power";
export type Verdict = { go: true } | { ask: AskWhy } | { refuse: string };

/** Keys that move focus or dismiss without changing the page's data. */
export const NAV_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Tab", "Shift+Tab", "Escape",
]);

const LOOKING = new Set(["status", "snapshot", "screenshot", "wait"]);
const NAV_LOWER: ReadonlySet<string> = new Set([...NAV_KEYS].map((k) => k.toLowerCase()));
const GO: Verdict = Object.freeze({ go: true as const });

/** A key string split into trimmed, lower-cased parts on "+". A lone space part is "space"; "\r", "\n" and "return"
 *  are "enter". Shared with the browser's key-event builder so both read a key the same way. */
export function parseKey(key: string): { parts: string[]; enter: boolean; space: boolean } {
  const parts = key.split("+").map((raw) => {
    if (raw === " ") return "space";
    if (/^[\r\n]+$/.test(raw)) return "enter";
    const p = raw.trim().toLowerCase();
    return p === "return" ? "enter" : p;
  });
  return { parts, enter: parts.includes("enter"), space: parts.includes("space") };
}

// A file input asks "file" when its chooser opens (the browser's ask, which also covers a chooser a script opens), not
// on the click.
function click(t: Target, marked: boolean): Verdict {
  if (t.opaque) return { ask: "frame" };
  if (!marked) return { ask: "unmarked" };
  const c = categoryOf(t);
  return c ? { ask: c } : GO;
}

/** The verdict for `a` given the session's access level and whether the current site is marked. */
export function judge(a: Action, ctx: { access: Access; marked: boolean }): Verdict {
  if (ctx.access === "read" && !LOOKING.has(a.kind)) return { refuse: REFUSAL.readOnly };
  switch (a.kind) {
    case "open":
      return navAllowed(a.url) ? GO : { refuse: REFUSAL.notWeb };
    case "click":
      return click(a.target, ctx.marked);
    case "key": {
      const k = parseKey(a.key);
      // A frame from another site cannot be read, so Enter there is asked as input into the frame, not judged as a return.
      if (k.enter && a.focus.target?.opaque) return { ask: "frame" };
      if (k.enter && !a.focus.plainTextarea) return { ask: "return" };
      if (NAV_LOWER.has(k.parts.join("+"))) return GO;
      // D9: any other key into a password field is typing into it (Enter asked above; it submits, it does not type).
      if (a.focus.sensitive && !k.enter) return { refuse: REFUSAL.passwordField };
      if (a.focus.target?.opaque) return { ask: "frame" };
      if (!ctx.marked) return { ask: "unmarked" };
      if (k.space && a.focus.target) return click(a.focus.target, true);
      return GO;
    }
    case "type": {
      if (a.focus.sensitive) return { refuse: REFUSAL.passwordField };
      if (a.focus.target?.opaque) return { refuse: REFUSAL.otherSiteFrame };
      if (/[\r\n]/.test(a.text) && !a.focus.plainTextarea) return { ask: "return" };
      if (!ctx.marked) return { ask: "unmarked" };
      if (a.focus.target?.fileInput) return { ask: "file" };
      return GO;
    }
    case "status":
    case "snapshot":
    case "screenshot":
    case "wait":
    case "scroll":
      return GO;
    default: {
      const _exhaustive: never = a;
      void _exhaustive;
      return { refuse: REFUSAL.unknownAction };
    }
  }
}

/** M10: the permissions this app cannot grant on this Mac, by Electron's name, with what each would give. The app has no
 *  camera, microphone or location entitlement or usage description and its check handler denies every check, so an
 *  Allow would do nothing: these are denied without an ask. */
const UNGRANTABLE: Readonly<Record<string, { what: string; them: string }>> = Object.freeze({
  media: { what: "the camera or microphone", them: "them" },
  geolocation: { what: "your location", them: "it" },
});

/** A page's permission request: "ask" the person, or deny it at once with the activity log's line (M10). `host` is the
 *  requesting site's host. */
export function permissionVerdict(permission: string, host: string): { deny: string } | "ask" {
  const u = Object.prototype.hasOwnProperty.call(UNGRANTABLE, permission) ? UNGRANTABLE[permission] : undefined;
  if (!u) return "ask";
  return { deny: `Denied ${host} ${u.what} without asking: this app has no access to ${u.them} on this Mac, so allowing would do nothing.` };
}
