import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { HostChild } from "../host";
import { ASK_EFFORTS, buildAskArgs, lastStderrLine, runAsk } from "./askSpawner";

test("lastStderrLine skips stack frames and blank lines, returning the last meaningful line", () => {
  assert.equal(
    lastStderrLine("Invalid API key\nNot logged in · Please run /login\n    at foo (x.js:1:1)\n"),
    "Not logged in · Please run /login",
  );
  assert.equal(lastStderrLine(""), "");
  assert.equal(lastStderrLine("    at foo (x.js:1:1)\n    at bar (y.js:2:2)\n"), "");
});

/** A child whose "close" fires (with code null, as a real killed process reports) only when
 *  kill() is called — never on its own. Models the local ask.js process while a user cancel
 *  is in flight. Mirrors claudeAsk.test.ts:23-29. */
function cancelableChild(): HostChild {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setImmediate(() => child.emit("close", null)); return true; };
  return child as unknown as HostChild;
}

test('a user cancel under ollama reports "cancelled", never "cancelled (timeout)"', async () => {
  const child = cancelableChild();
  const handle = runAsk({ vault: "/tmp/v", question: "q", node: "/usr/bin/node" }, { spawn: () => child });
  setImmediate(() => handle.cancel());
  const r = await handle.result;
  assert.equal(r.ok, false);
  assert.equal(r.error, "cancelled");
  assert.equal(r.exitCode, null);
});

const ASK = "brain/scripts/sdk/ask.js";

test("buildAskArgs: --chat (a Vault question under provider local) comes after --local, and only with no host", () => {
  assert.deepEqual(buildAskArgs({ question: "q", chat: true }), [ASK, "--local", "--chat", "q"]);
  assert.deepEqual(buildAskArgs({ question: "q", chat: true, host: "codex" }), [ASK, "--local", "--host=codex", "q"], "a named host answers whatever ai.chat says");
});

test("buildAskArgs: the old call shape is ask.js --local <question>; model and effort need a host", () => {
  assert.deepEqual(buildAskArgs({ question: "q" }), [ASK, "--local", "q"]);
  assert.deepEqual(buildAskArgs({ question: "q", model: "gpt-5", effort: "low" }), [ASK, "--local", "q"], "the surface has no model rule without a host");
});

test("buildAskArgs: host, then model, then effort, then the question, one argument each (the chat surface's order)", () => {
  assert.deepEqual(buildAskArgs({ question: "q", host: "codex" }), [ASK, "--local", "--host=codex", "q"]);
  assert.deepEqual(buildAskArgs({ question: "q", host: "codex", model: "gpt-5-codex" }), [ASK, "--local", "--host=codex", "--model=gpt-5-codex", "q"]);
  assert.deepEqual(buildAskArgs({ question: "- what is due?", host: "codex", model: "gpt-5-codex", effort: "minimal" }),
    [ASK, "--local", "--host=codex", "--model=gpt-5-codex", "--effort=minimal", "- what is due?"]);
  assert.deepEqual(buildAskArgs({ question: "q", host: "claude", model: "opus", effort: "max" }), [ASK, "--local", "--host=claude", "--model=opus", "--effort=max", "q"]);
});

test("buildAskArgs: an effort outside the host's Vault levels is left off; with no model it still goes (--host, --effort)", () => {
  for (const effort of ["max", "ultra", "", "--write=x"]) {
    assert.deepEqual(buildAskArgs({ question: "q", host: "codex", model: "m", effort }), [ASK, "--local", "--host=codex", "--model=m", "q"], `codex effort=${effort}`);
  }
  assert.deepEqual(buildAskArgs({ question: "q", host: "claude", model: "opus", effort: "minimal" }), [ASK, "--local", "--host=claude", "--model=opus", "q"]);
  assert.deepEqual(buildAskArgs({ question: "q", host: "codex", effort: "low" }), [ASK, "--local", "--host=codex", "--effort=low", "q"], "Codex's own default model at a chosen effort");
  assert.deepEqual(ASK_EFFORTS.codex, ["minimal", "low", "medium", "high", "xhigh"]);
});

test("buildAskArgs: never --model= with an empty value, \"default\", a space, or a leading dash", () => {
  for (const model of ["", "default", "-x", "--effort=max", "two words"]) {
    assert.deepEqual(buildAskArgs({ question: "q", host: "claude", model, effort: "high" }), [ASK, "--local", "--host=claude", "--effort=high", "q"], `model=${JSON.stringify(model)}`);
  }
});

test("runAsk spawns node with the built argv in the vault", async () => {
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  const child = cancelableChild();
  const handle = runAsk({ vault: "/tmp/v", question: "q", node: "/usr/bin/node", host: "codex", model: "gpt-5-codex", effort: "high" },
    { spawn: (file, args, opts = {}) => { calls.push({ file, args, cwd: opts.cwd }); return child; } });
  handle.cancel();
  await handle.result;
  assert.deepEqual(calls, [{ file: "/usr/bin/node", args: [ASK, "--local", "--host=codex", "--model=gpt-5-codex", "--effort=high", "q"], cwd: "/tmp/v" }]);
});
