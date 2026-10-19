import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrail } from "./promoteTrail";
test("parseTrail newest-first, tolerant of corrupt lines", () => {
  const raw = '{"ts":"1","session":"s","action":"written","slug":"a","type":"feedback","title":"A"}\n{nope\n{"ts":"2","session":"s","action":"kept","slug":"b","type":"user","title":"B"}\n';
  const rows = parseTrail(raw, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].slug, "b");
});

test("parseTrail keeps the verbs' rows (brain-hub D7) and stops at the limit", () => {
  const row = (ts: string, action: string) => JSON.stringify({ ts, session: "s", action, slug: "a", type: "reference", title: "A" });
  const raw = [row("1", "written"), row("2", "archived"), row("3", "restored"), row("4", "superseded")].join("\n");
  assert.deepEqual(parseTrail(raw, 3).map((r) => r.action), ["superseded", "restored", "archived"]);
});
