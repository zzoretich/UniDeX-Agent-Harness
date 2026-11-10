import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSED_CAP, ClosedRecord } from "./closedRecord";
import type { TermRowInput } from "./termGroups";

const row = (n: number, over: Partial<TermRowInput> = {}): TermRowInput => ({ id: `t${n}`, host: "claude", sessionId: `s${n}`, title: `T${n}`, place: { kind: "other", dir: "/work/demo", label: "demo" } as TermRowInput["place"], origin: null, startedAt: n, exited: false, exitCode: null, ...over });

test("a closed agent terminal is kept, newest first, marked exited", () => {
  const c = new ClosedRecord();
  c.add(row(1));
  c.add(row(2));
  assert.deepEqual(c.list().map((r) => r.sessionId), ["s2", "s1"]);
  assert.equal(c.list()[0].exited, true);
});

test("a shell and a terminal with no conversation id are not kept", () => {
  const c = new ClosedRecord();
  c.add(row(1, { host: "shell" }));
  c.add(row(2, { sessionId: undefined }));
  assert.equal(c.list().length, 0);
});

test("the same host and conversation is one row, the newest", () => {
  const c = new ClosedRecord();
  c.add(row(1));
  c.add(row(2));
  c.add(row(3, { sessionId: "s1" }));
  assert.deepEqual(c.list().map((r) => r.id), ["t3", "t2"]);
  c.add(row(4, { host: "codex", sessionId: "s1" }));
  assert.equal(c.list().length, 3);
});

test("only the newest CLOSED_CAP are kept", () => {
  const c = new ClosedRecord();
  for (let i = 0; i < CLOSED_CAP + 10; i++) c.add(row(i));
  assert.equal(c.list().length, CLOSED_CAP);
  assert.equal(c.list()[0].sessionId, `s${CLOSED_CAP + 9}`);
  assert.equal(c.list()[CLOSED_CAP - 1].sessionId, "s10");
});
