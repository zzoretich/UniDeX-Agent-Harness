// The Term composer's drafts per terminal (code-chat D5; final review I1, I2) and the focus after a Send with images (M3):
// what the one composer keeps for each terminal as the panel shows, closes and restarts them, and what a Send's wait
// leaves behind. "obsidian" resolves to a stub under node:test, the composer's elements to a stand-in that takes every
// call and keeps what is set on it (the textarea's value), and the plugin's codeFeeds to a fake whose waits the test ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type { SendHold } from "../data/codeFeeds";
import type { TerminalSession } from "../data/terminalSession";
import type * as Composer from "./TermComposer";

const STUB = "obsidian-stub-term-composer";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { setIcon: () => {}, Notice: class {} } } as unknown as NodeJS.Module;
const { TermComposer } = require("./TermComposer") as typeof Composer;

/** An element that takes every call and answers with another, and keeps what is set on it (a textarea's value). */
const el = (): HTMLElement => {
  const own: Record<string, unknown> = { value: "" };
  return new Proxy(own, {
    get: (t, k) => (typeof k === "symbol" || k === "then" ? undefined : k in t ? t[k] : () => el()),
    set: (t, k, v) => { if (typeof k === "string") t[k] = v; return true; },
  }) as unknown as HTMLElement;
};
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
// The composer asks whether it has the focus (document.activeElement); its stand-in elements contain everything.
(globalThis as { document?: unknown }).document = { activeElement: null };

type Hold = (r: SendHold) => void;
type Shown = (r: "attached" | "timeout" | "held" | "gone") => void;
/** The plugin's codeFeeds as Send uses it: no card known, and each screen read or image wait ends when the test says. */
function feeds() {
  const reads: Hold[] = [];
  const shows: Shown[] = [];
  return {
    reads, shows,
    get: () => ({ card: null }),
    cardNow: () => new Promise<SendHold>((r) => { reads.push(r); }),
    imageMarks: () => 0,
    imagesShown: () => new Promise<"attached" | "timeout" | "held" | "gone">((r) => { shows.push(r); }),
  };
}

/** A Claude Code terminal as the composer reads it; what Send writes to it is kept. */
function term(id: string) {
  const writes: string[] = [];
  const t = {
    id, meta: { host: "claude" }, cwd: "/work/demo", ptyId: `pty-${id}`,
    isExited: false, agentEnded: false, isClosed: false,
    write: (d: string) => { writes.push(d); }, noteCommand: () => {},
  };
  return { t, s: t as unknown as TerminalSession, writes };
}

/** The composer's private parts a test reads or drives. */
interface Inside { input: { value: string }; drafts: Map<string, string>; shots: unknown[]; send(): void }

function composer(o: { focusTerminal?: () => void } = {}) {
  const f = feeds();
  const plugin = { codeFeeds: f, claudeConfigDir: () => "/nowhere", vaultRoot: () => "/nowhere", settings: { terminalSnippets: [] } };
  const c = new TermComposer(el(), plugin as never, o.focusTerminal ?? (() => {}));
  return { c, f, inside: c as unknown as Inside };
}

test("I1: closing the selected terminal with a draft leaves no draft behind, whether another terminal or none shows next", () => {
  const { c, inside } = composer();
  const a = term("a");
  const b = term("b");
  c.setSession(a.s);
  inside.input.value = "half a prompt";
  // TerminalPool.remove disposes the terminal, then says it was removed: the panel forgets its draft, then shows another.
  a.t.isClosed = true;
  c.forgetDraft("a");
  c.setSession(b.s);
  assert.equal(inside.drafts.has("a"), false);
  assert.equal(inside.input.value, "", "the next terminal has its own (empty) box");
  // The last terminal closed: nothing shows next.
  inside.input.value = "for b";
  b.t.isClosed = true;
  c.forgetDraft("b");
  c.setSession(null);
  assert.equal(inside.drafts.size, 0);
});

test("I1: a chip restart carries the draft to the new terminal (the launch selects it at once), and keeps none for the old one", () => {
  const { c, inside } = composer();
  const old = term("old");
  const next = term("new");
  c.setSession(old.s);
  inside.input.value = "now with the other model";
  // TermLauncher selects the new terminal as it opens it; once its agent started, restartKeepingOld calls onReplace, then
  // removes the old one, whose removal draws the panel again.
  c.setSession(next.s);
  assert.equal(inside.input.value, "");
  c.carryDraft("old", "new");
  old.t.isClosed = true;
  c.forgetDraft("old");
  c.setSession(next.s);
  assert.equal(inside.input.value, "now with the other model");
  assert.equal(inside.drafts.size, 0);
});

test("I1: a carried draft waits for a new terminal not shown yet, and never replaces what its box holds", () => {
  const { c, inside } = composer();
  const old = term("old");
  const next = term("new");
  const other = term("other");
  // Still on the old one when it is replaced.
  c.setSession(old.s);
  inside.input.value = "keep me";
  c.carryDraft("old", "new");
  old.t.isClosed = true;
  c.forgetDraft("old");
  c.setSession(other.s);
  c.setSession(next.s);
  assert.equal(inside.input.value, "keep me");
  assert.equal(inside.drafts.has("old"), false);
  // Typed into the new terminal's box meanwhile: that stays.
  const old2 = term("old2");
  const next2 = term("new2");
  c.setSession(old2.s);
  inside.input.value = "the old draft";
  c.setSession(next2.s);
  inside.input.value = "typed since";
  c.carryDraft("old2", "new2");
  assert.equal(inside.input.value, "typed since");
  assert.equal(inside.drafts.has("old2"), false);
});

test("I2, R73: Send on A, then B shown, then A's agent ends during the wait: back on A its (shell's) box is empty and A got nothing", async () => {
  const { c, f, inside } = composer();
  const a = term("a");
  const b = term("b");
  c.setSession(a.s);
  inside.input.value = "echo leaked-$((6*7))";
  inside.send();
  assert.equal(f.reads.length, 1, "Send reads the screen first");
  c.setSession(b.s);
  assert.equal(inside.drafts.get("a"), "echo leaked-$((6*7))", "A's draft is kept for it while B shows");
  a.t.agentEnded = true;
  f.reads[0]("gone");
  await flush();
  assert.equal(inside.drafts.has("a"), false, "the agent's text leaves A's drafts with it");
  c.setSession(a.s);
  assert.equal(inside.input.value, "");
  assert.deepEqual(a.writes, []);
  assert.deepEqual(b.writes, []);
});

test("I2: a wait that ends on a terminal not shown keeps what is left as its draft, and none once it closed", async () => {
  const { c, f, inside } = composer();
  const a = term("a");
  const b = term("b");
  // A card came up during the wait (held): the draft stays A's.
  c.setSession(a.s);
  inside.input.value = "for later";
  inside.send();
  c.setSession(b.s);
  f.reads[0](true);
  await flush();
  assert.equal(inside.drafts.get("a"), "for later");
  // A closed during the wait: nothing is kept for it.
  c.setSession(a.s);
  inside.send();
  c.setSession(b.s);
  a.t.isClosed = true;
  f.reads[1]("gone");
  await flush();
  assert.equal(inside.drafts.has("a"), false);
  assert.deepEqual(a.writes, []);
});

test("M3: with images the focus moves to the terminal only after the text and ⏎ went; a held wait and typing since keep it in the composer", async () => {
  let focused = 0;
  const { c, f, inside } = composer({ focusTerminal: () => { focused += 1; } });
  const a = term("a");
  const shot = () => ({ el: el(), path: "/work/demo/one.png", saved: Promise.resolve(true), gone: false });
  c.setSession(a.s);
  inside.input.value = "look at this";
  inside.shots.push(shot());
  inside.send();
  f.reads[0](false);
  await flush();
  assert.equal(a.writes.join(""), "\x1b[200~/work/demo/one.png\x1b[201~", "the image's paste, then the wait");
  assert.equal(focused, 0, "keys typed during the wait stay in the composer");
  f.shows[0]("attached");
  await flush();
  assert.equal(a.writes.join("").endsWith("\x1b[200~ look at this\x1b[201~\r"), true);
  assert.equal(focused, 1);
  // A card came up during the wait: the text comes back to the box, and the focus stays with it.
  inside.input.value = "and this";
  inside.shots.push(shot());
  inside.send();
  f.reads[1](false);
  await flush();
  f.shows[1]("held");
  await flush();
  assert.equal(inside.input.value, "and this");
  assert.equal(focused, 1);
  // Typed into the box during the wait: the focus stays where the typing is.
  inside.input.value = "one more";
  inside.shots.push(shot());
  inside.send();
  f.reads[2](false);
  await flush();
  inside.input.value = "the next message";
  f.shows[2]("attached");
  await flush();
  assert.equal(focused, 1);
});
