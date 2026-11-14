// ComputerAsk — one ask card in the Computer pane (agent-computer D6, D39; ruling R52). Main holds an agent's flagged
// action until the person answers here: the card shows main's title as it is (app-written, already led by the category),
// the detail and the site, with Allow once · Always on <site> · Deny. For an ask raised because the site was not marked,
// Always lets the agent act freely there (M4: read from the ask's own reason, never the computer's current tab); Return, a
// file, a download and a permission prompt ask every time, so they never offer it, and neither does an ask main does not
// mark `always` (fail closed). A card pushes the view down as it appears, so its buttons stay disabled, and ignore
// clicks, until it has been on screen for ARM_MS (M7); the pane counts that again when a card moves (R69).

import type { HostComputerAnswer, HostComputerAsk } from "../host";

/** The asks that never offer Always: they ask every time (D39). */
export const ONCE_ONLY: readonly string[] = ["return", "file", "download", "permission", "power", "resendown"];

/** The host a site's origin names ("example.com", "localhost:5173"), or the text itself when it is not a URL. */
export function siteHost(site: string): string {
  try { return new URL(site).host || site; } catch { return site; }
}

/** How long a new card's buttons wait before they answer (M7): a click meant for what the card just pushed down is not
 *  an answer. */
export const ARM_MS = 500;

/** The Always button's words, or null when the card offers none (R52). An ask raised because its site was not marked
 *  marks it ("Let it act freely"); a category ask on a marked site allows that category there ("Always on"). */
export function alwaysLabel(ask: HostComputerAsk): string | null {
  if (ask.always !== true || ONCE_ONLY.includes(ask.why) || !ask.site) return null;
  const host = siteHost(ask.site);
  return ask.why === "unmarked" ? `Let it act freely on ${host}` : `Always on ${host}`;
}

/** Draws an ask's card in `parent`; each button answers it through `answer`. A late answer does nothing in main. Until
 *  `armedAt` (by `now`) the buttons are disabled and a click on one is ignored; the caller enables them then (`arm`). */
export function renderAsk(parent: HTMLElement, ask: HostComputerAsk, answer: (a: HostComputerAnswer) => void, o: { armedAt?: number; now?: () => number } = {}): HTMLElement {
  const now = o.now ?? (() => Date.now());
  const armedAt = o.armedAt ?? 0;
  const card = parent.createDiv({ cls: "aos-cp-ask", attr: { "data-ask": ask.id, role: "group", "aria-label": ask.title } });
  card.createDiv({ cls: "aos-cp-asktitle", text: ask.title });
  if (ask.detail) card.createDiv({ cls: "aos-cp-askdetail", text: ask.detail });
  const meta = [ask.site ? siteHost(ask.site) : null, ask.sessionLabel || null].filter((x): x is string => !!x).join(" · ");
  if (meta) card.createDiv({ cls: "aos-cp-asksite", text: meta, attr: ask.site ? { title: ask.site } : {} });
  const row = card.createDiv({ cls: "aos-cp-askbtns" });
  const waiting = now() < armedAt;
  card.toggleClass("is-arming", waiting);
  const button = (label: string, a: HostComputerAnswer): void => {
    const b = row.createEl("button", { cls: `aos-cp-askbtn is-${a}`, text: label, attr: { type: "button", "data-answer": a } });
    b.disabled = waiting;
    b.addEventListener("click", () => { if (now() >= armedAt) answer(a); });
  };
  // A power card and the person's own form card have words of their own; every other card is an agent's, Allow once or Deny.
  const [yes, no] = ask.why === "power" ? ["Turn on", "Not now"] : ask.why === "resendown" ? ["Send again", "Cancel"] : ["Allow once", "Deny"];
  button(yes, "once");
  const always = alwaysLabel(ask);
  if (always) button(always, "always");
  button(no, "deny");
  return card;
}

/** Enables a card's buttons once its wait is over (M7). */
export function arm(card: HTMLElement): void {
  card.toggleClass("is-arming", false);
  for (const b of Array.from(card.querySelectorAll<HTMLButtonElement>(".aos-cp-askbtn"))) b.disabled = false;
}
