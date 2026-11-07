// The verdict for one agent action in the Computer pane (agent-computer D9, D17, D39, §4.2): go, ask the person first,
// or refuse. Pure: the service gathers the facts (access level, whether the site is marked, what has focus) and acts on
// the verdict. What asks by label is the D43 vocabulary in ./categories.

import { categoryOf, type AskCategory, type Target } from "./categories";
import { navAllowed } from "../policy/computer-url";

export type Access = "read" | "edit" | "run" | "host";

/** What has keyboard focus. `plainTextarea`: a native <textarea> with no key listener on it or an ancestor. */
export interface Focus { target: Target | null; sensitive: boolean; plainTextarea: boolean }

export type Action =
  | { kind: "status" | "snapshot" | "screenshot" | "wait" | "scroll" }
  | { kind: "open"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "key"; key: string; focus: Focus }
  | { kind: "type"; text: string; focus: Focus };

export type AskWhy = AskCategory | "unmarked" | "return" | "file" | "permission";
export type Verdict = { go: true } | { ask: AskWhy } | { refuse: string };

/** Keys that move focus or dismiss without changing the page's data. */
export const NAV_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Tab", "Shift+Tab", "Escape",
]);

const LOOKING = new Set(["status", "snapshot", "screenshot", "wait"]);
const GO: Verdict = { go: true };

const hasEnter = (key: string): boolean =>
  key.split("+").some((p) => ["enter", "return"].includes(p.toLowerCase()));

function click(t: Target, marked: boolean): Verdict {
  if (t.fileInput) return { ask: "file" };
  if (!marked) return { ask: "unmarked" };
  const c = categoryOf(t);
  return c ? { ask: c } : GO;
}

/** The verdict for `a` given the session's access level and whether the current site is marked. */
export function judge(a: Action, ctx: { access: Access; marked: boolean }): Verdict {
  if (ctx.access === "read" && !LOOKING.has(a.kind)) return { refuse: "Read only: this session can look but not act (D17)." };
  switch (a.kind) {
    case "open":
      return navAllowed(a.url) ? GO : { refuse: "Only http and https pages open." };
    case "click":
      return click(a.target, ctx.marked);
    case "key": {
      if (hasEnter(a.key) && !a.focus.plainTextarea) return { ask: "return" };
      if (NAV_KEYS.has(a.key)) return GO;
      if (!ctx.marked) return { ask: "unmarked" };
      if ((a.key === " " || a.key === "Space") && a.focus.target) return click(a.focus.target, true);
      return GO;
    }
    case "type": {
      if (a.focus.sensitive) return { refuse: "Typing into a password field is refused (D9)." };
      if (a.text.includes("\n") && !a.focus.plainTextarea) return { ask: "return" };
      if (!ctx.marked) return { ask: "unmarked" };
      if (a.focus.target?.fileInput) return { ask: "file" };
      return GO;
    }
    default:
      return GO;
  }
}
