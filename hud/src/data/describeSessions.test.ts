// describeChanged reports a row once per change (session-browser S6, S7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeChanged } from "./describeSessions";

test("describeChanged reports a row once per change", () => {
  const seen = new Map<string, string>();
  const a = { session: "code:t1", title: "Fix login" };
  assert.deepEqual(describeChanged(seen, [a]), [a], "the first time");
  assert.deepEqual(describeChanged(seen, [a]), [], "the same again");
  const renamed = { ...a, title: "Fix logout" };
  assert.deepEqual(describeChanged(seen, [renamed]), [renamed], "a new title");
  const resumed = { ...renamed, conversation: { host: "claude" as const, id: "abc" } };
  assert.deepEqual(describeChanged(seen, [resumed]), [resumed], "a conversation");
  assert.deepEqual(describeChanged(seen, [resumed, { session: "code:t2", title: "Docs" }]).map((r) => r.session), ["code:t2"], "only the new row");
  assert.deepEqual(describeChanged(seen, []), [], "nothing");
  assert.deepEqual(describeChanged(seen, [resumed]), [resumed], "a row that was gone is described again");
});
