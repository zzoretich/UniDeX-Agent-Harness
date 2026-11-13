// DevTools-protocol plumbing for the Computer browser (agent-computer D20). Every command goes through `cdp()`, which
// gives up after 5 s with an error naming the command, so a page that stops answering becomes a reply, never a hung
// call. `keyEvents` turns a key string into Input.dispatchKeyEvent events; it reads the string with the gate's own
// `parseKey` (D39) and throws for anything it does not know, so no key the gate did not judge is delivered.

import { parseKey } from "./gate";
import { REFUSAL } from "./refusals";

export const CDP_TIMEOUT_MS = 5_000;

/** A command the page did not answer in time. */
export class CdpTimeout extends Error {
  /** `person` is the plain statement for a line the person reads (an attach note), without the advice meant for the agent. */
  constructor(text: string, readonly person: string = text) { super(text); }
}

/** An error with two wordings (session-browser S16): its message is the table's sentence, for the agent; `person` is the plain
 *  statement of what happened, for the activity log and a note, which carry no advice meant for the agent. */
export class Told extends Error {
  constructor(text: string, readonly person: string) { super(text); }
}

/** An error's text for a line the person reads. */
export const forPerson = (e: unknown): string => (e instanceof Told || e instanceof CdpTimeout ? e.person : e instanceof Error ? e.message : String(e));

/** The tab or page an action was judged on is no longer the one in front (agent-computer D31, I3b): nothing more of the
 *  action is delivered. */
export class PageChanged extends Error {
  constructor(message: string = REFUSAL.pageChanged) { super(message); }
}

/** The element a key or typing was judged on no longer has focus (R76): nothing of the action is delivered. */
export class FocusMoved extends PageChanged {
  constructor() { super(REFUSAL.focusMoved); }
}

/** What `cdp()` needs from Electron's `webContents.debugger`. */
export interface CdpTarget { sendCommand(method: string, params?: object): Promise<unknown> }

/** Sends one DevTools command, rejecting with `CdpTimeout` after `ms`. */
export function cdp<T = unknown>(target: CdpTarget, method: string, params?: object, ms = CDP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CdpTimeout(REFUSAL.pageSlow(`${method} within ${ms / 1000} s`), `The page did not answer ${method} within ${ms / 1000} s.`)), ms);
    const fail = (e: unknown): void => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); };
    try {
      target.sendCommand(method, params).then((v) => { clearTimeout(timer); resolve(v as T); }, fail);
    } catch (e) {
      fail(e);
    }
  });
}

// The answers DevTools gives when a node or its box no longer exists: the page moved on, which a reader may skip.
const GONE = /^(Could not compute box model|Could not compute content quads|No node found for given backend id|Could not find node with given id|No node with given id found|Node with given id does not belong to the document)/;

/** Whether `e` says the node (or its box) is gone. A timeout or any other failure is not. */
export function isGone(e: unknown): boolean {
  return e instanceof Error && !(e instanceof CdpTimeout) && GONE.test(e.message);
}

/** A `.catch` that turns a node-gone error into `fallback` and rethrows everything else (a D9 read must not fail open). */
export function unlessGone<T>(fallback: T): (e: unknown) => T {
  return (e) => {
    if (isGone(e)) return fallback;
    throw e;
  };
}

export interface KeyEvent { type: "rawKeyDown" | "keyDown" | "char" | "keyUp"; key: string; code: string; windowsVirtualKeyCode: number; modifiers: number; text?: string }

interface KeyDef { key: string; code: string; vk: number; text?: string; shifted?: KeyDef }

// DevTools modifier bits: Alt 1, Control 2, Meta 4, Shift 8.
const MODIFIERS: Record<string, { def: KeyDef; bit: number }> = {};
for (const [names, key, vk, bit] of [
  [["shift"], "Shift", 16, 8], [["control", "ctrl"], "Control", 17, 2], [["alt", "option"], "Alt", 18, 1], [["meta", "cmd"], "Meta", 91, 4],
] as const) for (const n of names) MODIFIERS[n] = { def: { key, code: `${key}Left`, vk }, bit };

const KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };
const printable = (ch: string, code: string, vk: number, shifted: string): void => {
  const up: KeyDef = { key: shifted, code, vk, text: shifted };
  KEYS[ch] = { key: ch, code, vk, text: ch, shifted: up };
  KEYS[shifted.toLowerCase()] ??= up;
};
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(97 + i);
  printable(ch, `Key${ch.toUpperCase()}`, 65 + i, ch.toUpperCase());
}
for (let i = 0; i <= 9; i++) printable(String(i), `Digit${i}`, 48 + i, ")!@#$%^&*("[i]);
for (const [ch, code, vk, shifted] of [
  ["`", "Backquote", 192, "~"], ["-", "Minus", 189, "_"], ["=", "Equal", 187, "+"], ["[", "BracketLeft", 219, "{"],
  ["]", "BracketRight", 221, "}"], ["\\", "Backslash", 220, "|"], [";", "Semicolon", 186, ":"], ["'", "Quote", 222, '"'],
  [",", "Comma", 188, "<"], [".", "Period", 190, ">"], ["/", "Slash", 191, "?"],
] as const) printable(ch, code, vk, shifted);

/**
 * The events for one key or chord such as "Shift+Tab", "Control+a" or "Enter": each modifier down, the key down and up,
 * the modifiers up. A key that types (a letter, digit, punctuation, Space, Enter) sends its text, except while Control,
 * Alt or Meta is held, when it is a shortcut. Throws for an empty part ("", "+", "Shift+"), a modifier that is not one,
 * or a key name not listed here. Parts are lower-cased by `parseKey`, so "A" is "a"; use "Shift+a" for a capital.
 */
export function keyEvents(key: string): KeyEvent[] {
  const { parts } = parseKey(key);
  if (parts.some((p) => p === "")) throw new Error(REFUSAL.emptyKeyPart(key));
  const main = parts[parts.length - 1];
  const held = parts.slice(0, -1).map((p) => {
    const m = MODIFIERS[p];
    if (!m) throw new Error(REFUSAL.notModifier(p));
    return m;
  });
  const own = MODIFIERS[main];
  let def = own?.def ?? KEYS[main];
  if (!def) throw new Error(REFUSAL.unknownKey(key));
  const events: KeyEvent[] = [];
  const ev = (type: KeyEvent["type"], d: KeyDef, modifiers: number, text?: string): void => {
    events.push({ type, key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, modifiers, ...(text === undefined ? {} : { text }) });
  };
  let mods = 0;
  const down: { def: KeyDef; bit: number }[] = [];
  for (const m of held) {
    if (mods & m.bit) continue;
    mods |= m.bit;
    down.push(m);
    ev("rawKeyDown", m.def, mods);
  }
  if (own) mods |= own.bit;
  if (mods & 8 && def.shifted) def = def.shifted;
  const text = def.text !== undefined && !(mods & (1 | 2 | 4)) ? def.text : undefined;
  ev(text === undefined ? "rawKeyDown" : "keyDown", def, mods, text);
  if (own) mods &= ~own.bit;
  ev("keyUp", def, mods);
  for (const m of down.reverse()) {
    mods &= ~m.bit;
    ev("keyUp", m.def, mods);
  }
  return events;
}
