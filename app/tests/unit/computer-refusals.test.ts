// The refusal table (session-browser S8, Task 19): every sentence is one sentence that names a next step, and the service
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

test("no refusal is written in service.ts", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "computer", "service.ts"), "utf8");
  assert.equal(/fail\(\s*["'`]/.test(src), false, "fail( takes a table entry, never a literal or a template");
});

test("the gate's verdicts come from the table", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "computer", "gate.ts"), "utf8");
  assert.equal(/refuse:\s*["'`]/.test(src), false, "a refusal in gate.ts is a table entry");
});

test("a busy refusal keeps the prefix older runtimes match", () => {
  assert.ok(REFUSAL.late.startsWith("busy: "));
  assert.ok(REFUSAL.busy("x is driving").startsWith("busy: "));
  assert.ok(REFUSAL.busyUser("the user is driving").startsWith("busy: "));
});
