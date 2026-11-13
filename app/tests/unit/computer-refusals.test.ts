// The refusal table (session-browser S16, Task 19): every sentence is one sentence that names a next step, and the service
// words none of them itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REFUSAL } from "../../src/main/computer/refusals";

test("every refusal is one sentence that names a next step", () => {
  const all: Readonly<Record<string, string | ((x: string) => string)>> = REFUSAL;
  assert.ok(Object.keys(all).length >= 30, "the table holds the service's sentences");
  for (const [name, s] of Object.entries(all)) {
    const text = typeof s === "function" ? s("x") : s;
    assert.equal((text.match(/[.!?](\s|$)/g) || []).length, 1, name);
    assert.match(text, /: \w/, name);
  }
});

const read = (f: string): string => fs.readFileSync(path.join(__dirname, "..", "src", "main", "computer", f), "utf8");

/** The text of the first argument of every call of `name(` in `src`, up to its matching comma or closing parenthesis. */
function firstArgs(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0, i = m.index + m[0].length, str: string | null = null;
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (str) { if (c === "\\") i++; else if (c === str) str = null; continue; }
      if (c === '"' || c === "'" || c === "`") str = c;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) break;
    }
    out.push(src.slice(start, i).trim());
  }
  return out;
}

/** Arguments of fail( and refuseAt( that are not a table entry written in place: each with its reason. */
const SERVICE_ALLOWED: Readonly<Record<string, string>> = {
  "message(e)": "the .message of an error thrown by browser.ts or cdp.ts (each throw there is checked below), by the service's own throws (REFUSAL.quitting, isOff: checked below) or by the page",
  "parsed": "what parse() returned when it was a string: its returns are REFUSAL.badRef, noUrl, noTarget, noText, noKey, noDistance and unknownTool",
  "ro.refuse": "the gate's verdict: every `refuse:` in gate.ts is a table entry (checked below)",
  "v.refuse": "the gate's verdict: every `refuse:` in gate.ts is a table entry (checked below)",
  "need.refuse": "the gate's verdict: every `refuse:` in gate.ts is a table entry (checked below)",
  "tv.refuse": "the gate's verdict: every `refuse:` in gate.ts is a table entry (checked below)",
  "cv.refuse": "the gate's verdict: every `refuse:` in gate.ts is a table entry (checked below)",
  "q.sentence": "the quiet sentence: REFUSAL.declined or switchedOff, stored when the period began",
  "s.sentence": "the stop's sentence: REFUSAL.switchedOff or tabClosed, stored when the person stopped the call",
  'o.answer === "deny" ? REFUSAL.askDenied : REFUSAL.askDeniedBecause(o.reason ?? "cancelled")': "a choice between two table entries",
  "text": "refuseAt's own variable, built from a table sentence and the page line",
};

/** The service's fail( and refuseAt( calls whose first argument is not a table entry or an allowed name. */
function serviceViolations(src: string): string[] {
  return [...firstArgs(src, "fail"), ...firstArgs(src, "refuseAt")].filter((a) =>
    !(/^REFUSAL\.\w+(\(.*\))?$/s.test(a) || /^this\.busy\(/.test(a) || /^deniedText\(/.test(a) || a in SERVICE_ALLOWED));
}

/** The whole text of every call of `name(` in `src` (to its closing parenthesis). */
function wholeCalls(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0, i = m.index + m[0].length, str: string | null = null;
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (str) { if (c === "\\") i++; else if (c === str) str = null; continue; }
      if (c === '"' || c === "'" || c === "`") str = c;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
    }
    out.push(src.slice(start, i));
  }
  return out;
}

/** The error constructors of browser.ts and cdp.ts whose call holds a string literal outside a REFUSAL entry's own arguments. */
function throwViolations(src: string): string[] {
  const calls = ["new Error", "new PageChanged", "new FocusMoved"].flatMap((n) => wholeCalls(src, n));
  // `new Told(table sentence, the person's own wording)` and `new CdpTimeout(…, the person's wording)`: only the first
  // argument is the agent's.
  calls.push(...firstArgs(src, "new Told"), ...firstArgs(src, "new CdpTimeout"));
  return calls.filter((c) => /["'`]/.test(c.replace(/REFUSAL\.\w+(\((?:[^()]|\([^()]*\))*\))?/g, "")));
}

/** The value of every `text:` property in `src` (up to its comma or closing brace). */
function textValues(src: string): string[] {
  const out: string[] = [];
  const re = /\btext\s*:\s*/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0, i = m.index + m[0].length, str: string | null = null;
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (str) { if (c === "\\") i++; else if (c === str) str = null; continue; }
      if (c === '"' || c === "'" || c === "`") str = c;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if ((c === "," || c === ";") && depth === 0) break;
    }
    out.push(src.slice(start, i).trim());
  }
  return out;
}

/** The bridge's `text:` values that are not a table entry (its ToolReply type's own `text: string` aside), whatever the
 *  order of the properties and however the text is built. */
function bridgeViolations(src: string): string[] {
  return textValues(src).filter((a) => a !== "string" && !/^REFUSAL\.\w+(\(.*\))?$/s.test(a));
}

/** The gate's `refuse:` values that are not a table entry. */
function gateViolations(src: string): string[] {
  return [...src.matchAll(/\brefuse\s*:\s*([^}]+?)\s*\}/g)].map((m) => m[1]).filter((a) => a !== "string" && !/^REFUSAL\.\w+$/.test(a));
}

test("no refusal is written in service.ts: every fail( and refuseAt( takes a table entry", () => {
  const src = read("service.ts");
  assert.ok(firstArgs(src, "fail").length + firstArgs(src, "refuseAt").length > 40);
  assert.deepEqual(serviceViolations(src), []);
});

test("every error an agent can get from the gate, the browser, the cdp helpers and the bridge comes from the table", () => {
  const gate = read("gate.ts");
  assert.ok([...gate.matchAll(/\brefuse\s*:/g)].length >= 6, "the gate's refusals were found");
  assert.deepEqual(gateViolations(gate), []);
  for (const f of ["browser.ts", "cdp.ts"]) {
    const src = read(f);
    if (f === "browser.ts") assert.ok(wholeCalls(src, "new Error").length > 15, "the throws were found");
    assert.deepEqual(throwViolations(src), [], f);
  }
  const bridge = read("bridge.ts");
  assert.ok(textValues(bridge).length >= 4, "the bridge's replies were found");
  assert.deepEqual(bridgeViolations(bridge), []);
  // The service's own throws reach the agent through its catch blocks; the two "no browser" ones are caught inside and
  // replaced by an app-written line.
  const own = firstArgs(read("service.ts"), "new Error").filter((a) => a !== '"no browser"');
  assert.ok(own.length >= 3, "the service's throws were found");
  for (const a of own) assert.match(a, /^REFUSAL\.\w+$/, `service.ts: new Error(${a})`);
  assert.equal(/reason:\s*["'`]/.test(bridge), false, "bridge.ts: the admission reason comes from the table");
  assert.equal(/NOT_STARTED\s*=\s*["'`]/.test(read("admission.ts")), false, "admission.ts takes its sentence from the table too");
});

test("the source checks catch a planted literal", () => {
  assert.deepEqual(serviceViolations('return fail("A new sentence.");'), ['"A new sentence."']);
  assert.equal(serviceViolations("return fail(`Nope ${x}.`);").length, 1);
  assert.equal(serviceViolations('return refuseAt("Nope.", url);').length, 1);
  assert.equal(serviceViolations("return fail(REFUSAL.late);").length, 0);
  assert.equal(throwViolations('throw new Error("Oops.");').length, 1);
  assert.equal(throwViolations("throw new PageChanged('Oops.');").length, 1, "a literal given to PageChanged");
  assert.equal(throwViolations('throw new FocusMoved("Oops.");').length, 1, "a literal given to FocusMoved");
  assert.equal(throwViolations('throw new Error(cond ? REFUSAL.noPage : "Oops.");').length, 1, "a literal anywhere in the call");
  assert.equal(throwViolations("throw new Error(`Oops ${REFUSAL.noPage}`);").length, 1, "a template around an entry");
  assert.equal(throwViolations('throw new Told("Oops.", "the person\'s words");').length, 1, "a literal as a Told's agent text");
  assert.equal(throwViolations('throw new Told(REFUSAL.tabGone, "That tab was closed.");').length, 0, "the person's own wording is allowed");
  assert.equal(throwViolations("throw new Error(REFUSAL.pageSlow(`${m} within ${s} s`));").length, 0);
  assert.equal(bridgeViolations('write({ id, text: "Nope.", isError: true });').length, 1, "a literal in the bridge");
  assert.equal(bridgeViolations("write({ isError: true, text: `Nope ${why}.`, id });").length, 1, "a template, isError first");
  assert.equal(bridgeViolations("write({ id, text: REFUSAL.ended, isError: true });").length, 0);
  assert.equal(throwViolations('throw new CdpTimeout("Oops.", REFUSAL.pageSlow(x));').length, 1, "a literal as a CdpTimeout\'s agent text");
  assert.equal(throwViolations("throw new CdpTimeout(REFUSAL.pageSlow(x), `The page did not answer ${m}.`);").length, 0, "the person\'s wording");
  assert.equal(gateViolations('return {refuse:"Nope."};').length, 1, "no spacing needed to hide it");
  assert.equal(gateViolations("return { refuse   :   `Nope.` };").length, 1);
  assert.equal(gateViolations("return { refuse: REFUSAL.notWeb };").length, 0);
});

test("the password-field sentence exists once", () => {
  for (const f of ["browser.ts", "gate.ts", "cdp.ts", "service.ts", "bridge.ts"]) assert.equal(/password field is refused/.test(read(f)), false, f);
});

test("a busy refusal keeps the prefix older runtimes match", () => {
  assert.ok(REFUSAL.late.startsWith("busy: "));
  assert.ok(REFUSAL.busy("x is driving").startsWith("busy: "));
  assert.ok(REFUSAL.busyUser("the user is driving").startsWith("busy: "));
});

test("the sentences that must not tell an agent to repeat what already ran or what was refused", () => {
  assert.equal(REFUSAL.noSuchAsk("x"), 'There is no ask "x": call computer_snapshot to see whether the action already ran.');
  assert.equal(REFUSAL.denied("N"), "The user denied it (N): go on without it unless the user asks for it.");
  assert.equal(REFUSAL.askDenied, "The user denied it: go on without it unless the user asks for it.");
  assert.equal(REFUSAL.timedOut("N"), "The user did not answer in time, so it was denied (N): go on without it, or try once more if the task cannot go on.");
  assert.equal(REFUSAL.cancelled("the user took over (N)"), "Cancelled because the user took over (N): call computer_status before you try it again.");
  assert.equal(REFUSAL.askDeniedBecause("R"), "Denied because R: call computer_status before you try it again.");
  assert.equal(REFUSAL.readOnly, "This session is read only, so it can look but not act: ask the user for more access if the task needs it.");
});
