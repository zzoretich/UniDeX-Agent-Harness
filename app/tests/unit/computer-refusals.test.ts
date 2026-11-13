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
  "message(e)": "the text of an error another module threw (tabled there)",
  "parsed": "the sentence parse() took from the table",
  "ro.refuse": "the gate's verdict, from the table",
  "v.refuse": "the gate's verdict, from the table",
  "need.refuse": "the gate's verdict, from the table",
  "tv.refuse": "the gate's verdict, from the table",
  "cv.refuse": "the gate's verdict, from the table",
  "q.sentence": "the quiet sentence, a table entry stored when the period began",
  "s.sentence": "the stop's sentence, a table entry stored when the person stopped the call",
  'o.answer === "deny" ? REFUSAL.askDenied : REFUSAL.askDeniedBecause(o.reason ?? "cancelled")': "a choice between two table entries",
  "text": "refuseAt's own variable, built from a table sentence and the page line",
};

test("no refusal is written in service.ts: every fail( and refuseAt( takes a table entry", () => {
  const src = read("service.ts");
  const calls = [...firstArgs(src, "fail"), ...firstArgs(src, "refuseAt")];
  assert.ok(calls.length > 40, `${calls.length} calls found`);
  for (const a of calls) {
    const ok = /^REFUSAL\.\w+(\(.*\))?$/s.test(a) || /^this\.busy\(/.test(a) || /^deniedText\(/.test(a) || a in SERVICE_ALLOWED;
    assert.ok(ok, `fail/refuseAt takes "${a}": a sentence belongs in refusals.ts`);
  }
});

test("every error an agent can get from the gate, the browser, the cdp helpers and the bridge comes from the table", () => {
  const gate = read("gate.ts");
  const verdicts = [...gate.matchAll(/\{ refuse: ([^}]+) \}/g)].map((m) => m[1]).filter((a) => a !== "string");   // the Verdict type's own `{ refuse: string }`
  assert.ok(verdicts.length >= 5, "the gate's refusals were found");
  for (const a of verdicts) assert.match(a, /^REFUSAL\.\w+$/, `gate.ts: ${a}`);
  for (const f of ["browser.ts", "cdp.ts"]) {
    const src = read(f);
    const args = [...firstArgs(src, "new Error"), ...firstArgs(src, "new CdpTimeout")];
    if (f === "browser.ts") assert.ok(args.length > 15, `${args.length} throws found`);
    // `new Error(String(e))` only wraps a value a promise rejected with that was not an Error (its own text, not ours).
    for (const a of args) if (a !== "String(e)") assert.match(a, /REFUSAL\.\w+/, `${f}: new Error(${a})`);
  }
  const bridge = read("bridge.ts");
  const texts = [...bridge.matchAll(/text:\s*([^,}]+?),\s*isError: true/g)].map((m) => m[1]);
  assert.ok(texts.length >= 3, "the bridge's replies were found");
  for (const a of texts) assert.match(a, /^REFUSAL\./, `bridge.ts: text: ${a}`);
  assert.equal(/reason:\s*["'`]/.test(bridge), false, "bridge.ts: the admission reason comes from the table");
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
