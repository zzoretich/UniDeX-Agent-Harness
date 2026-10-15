import { test } from "node:test";
import assert from "node:assert/strict";
import { PREDICATES, boldRuns, fillText, holds, hostName, isPredicate, type TourContext } from "./predicates";

const ctx = (hosts: TourContext["hosts"], chat = false, checklist = false): TourContext => ({ hosts, chat, checklist });
const CLAUDE = ctx(["claude"]);
const CODEX = ctx(["codex"], true);
const BOTH = ctx(["claude", "codex"], true, true);
const NONE = ctx([]);

test("each predicate on each kind of install (tour C8)", () => {
  const table: Array<[string, TourContext, boolean]> = [
    ["hasHost:claude", CLAUDE, true], ["hasHost:claude", CODEX, false], ["hasHost:claude", BOTH, true], ["hasHost:claude", NONE, false],
    ["hasHost:codex", CLAUDE, false], ["hasHost:codex", CODEX, true], ["hasHost:codex", BOTH, true],
    ["chatAvailable", CLAUDE, false], ["chatAvailable", CODEX, true],
    ["codexOnly", CODEX, true], ["codexOnly", BOTH, false], ["codexOnly", NONE, false],
    ["noHost", NONE, true], ["noHost", CLAUDE, false],
    ["checklistShown", BOTH, true], ["checklistShown", CLAUDE, false],
  ];
  for (const [when, c, want] of table) assert.equal(holds(when, c), want, `${when} on ${c.hosts.join("+") || "none"}`);
});

test("no when always holds; ! negates; an unknown predicate never holds", () => {
  assert.equal(holds(undefined, NONE), true);
  assert.equal(holds("", NONE), true);
  assert.equal(holds("!chatAvailable", CLAUDE), true);
  assert.equal(holds("!hasHost:codex", CODEX), false);
  assert.equal(holds("hasHost:other", BOTH), false);
  assert.equal(holds("!hasHost:other", BOTH), false);
  for (const p of PREDICATES) { assert.ok(isPredicate(p)); assert.ok(isPredicate(`!${p}`)); }
  assert.equal(isPredicate("sometimes"), false);
});

test("{host} names the user's host; {cmd:x} the way their host types a command", () => {
  assert.equal(hostName(CLAUDE), "Claude Code");
  assert.equal(hostName(CODEX), "Codex");
  assert.equal(hostName(BOTH), "Claude Code or Codex");
  assert.equal(hostName(NONE), "your agent");
  assert.equal(fillText("Start {host} with {cmd:wrap}.", CLAUDE), "Start Claude Code with /wrap.");
  assert.equal(fillText("Run {cmd:wrap} in {host}.", { ...CODEX, cmd: (n) => `$agenticos:${n}` }), "Run $agenticos:wrap in Codex.");
  assert.equal(fillText("{other} stays", CLAUDE), "{other} stays");
});

test("**bold** runs split out, the rest is plain text", () => {
  assert.deepEqual(boldRuns("Click **Pulse**, then **Next**."), [
    { text: "Click ", bold: false }, { text: "Pulse", bold: true }, { text: ", then ", bold: false }, { text: "Next", bold: true }, { text: ".", bold: false },
  ]);
  assert.deepEqual(boldRuns("plain"), [{ text: "plain", bold: false }]);
  assert.deepEqual(boldRuns("<b>not html</b>"), [{ text: "<b>not html</b>", bold: false }]);
});
