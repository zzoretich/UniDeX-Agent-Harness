// The ask-first vocabulary (agent-computer D43): the button labels that make the app stop and ask the person before
// an agent acts in the Computer pane. A label is matched as a whole-word phrase in the lower-cased name with
// punctuation stripped, and only on button-like roles. "Continue" and "Save" ask only inside a form; "Approve" and
// "Allow" ask in any context, because their review and consent contexts cannot be read reliably (fails closed).

export type AskCategory = "submit" | "purchase" | "send" | "delete" | "merge" | "signin" | "download";

/** What the gate looks at. `fileInput` and `opaque` are for the gate's own use; `categoryOf` ignores them. `opaque`: the
 *  control is a frame from another site, whose contents the browser cannot read (agent-computer D9, D43). */
export interface Target { role: string; name: string; inForm: boolean; fileInput: boolean; opaque?: boolean }

/** Labels that ask wherever they appear. */
export const VOCABULARY: Readonly<Record<AskCategory, readonly string[]>> = {
  submit: ["submit", "confirm"],
  purchase: ["buy", "pay", "place order", "checkout", "check out", "subscribe"],
  send: ["send", "post", "publish", "reply", "share", "tweet"],
  delete: ["delete", "remove", "erase", "discard", "empty trash"],
  merge: ["merge", "squash and merge", "rebase and merge", "approve"],
  signin: ["sign in", "log in", "authorize", "connect", "grant", "allow"],
  download: ["download", "export", "save to disk"],
};

/** Labels that ask only on a control inside a form. */
const FORM_ONLY: readonly string[] = ["continue", "save"];

/** The roles whose label is judged. */
export const ASK_ROLES: ReadonlySet<string> = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio"]);

const phrase = (name: string): string =>
  ` ${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** Whether `part` already appears in `name` as whole words, so every label `categoryOf` finds in `part` it finds in `name`
 *  too ("Deleted messages" does not cover "Delete"; "Delete item" does). */
export const covers = (name: string, part: string): boolean => phrase(name).includes(phrase(part));

/** The category a control asks under, or null when the agent may act without asking. */
export function categoryOf(t: Target): AskCategory | null {
  if (!ASK_ROLES.has(t.role)) return null;
  const text = phrase(t.name);
  for (const [category, labels] of Object.entries(VOCABULARY) as [AskCategory, readonly string[]][]) {
    if (labels.some((l) => text.includes(` ${l} `))) return category;
  }
  if (t.inForm && FORM_ONLY.some((l) => text.includes(` ${l} `))) return "submit";
  return null;
}
