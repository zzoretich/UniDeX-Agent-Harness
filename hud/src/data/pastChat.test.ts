import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNodeHost } from "../nodeHost";
import { pastEarlier, pastState, pastView, readCacheAll } from "./pastChat";

const hostFs = createNodeHost().fs;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aos-past-chat-"));
const line = (o: Record<string, unknown>) => JSON.stringify({ t: "2026-11-09T10:00:00Z", turn: 1, ...o });

test("a cache is read whole, a missing one reads as nothing, and nothing in it is a line to show, not a blank chat", () => {
  const file = path.join(tmp, "claude-x.jsonl");
  fs.writeFileSync(file, [line({ kind: "session", id: "x" }), line({ kind: "prompt", text: "hello" }), line({ kind: "text", text: "hi there" }), "{broken"].join("\n") + "\n");
  const events = readCacheAll(hostFs, file);
  assert.deepEqual(events.map((e) => e.kind), ["session", "prompt", "text"]);
  const s = pastState(pastView(events), "claude", null);
  assert.ok(s.rows.length >= 2);
  assert.equal(s.error, null);
  assert.deepEqual(readCacheAll(hostFs, path.join(tmp, "none.jsonl")), []);
  assert.equal(pastState(pastView([]), "claude", null).error, "This conversation has no messages to show.");
});

test("Show earlier raises the row cap by 400", () => {
  const v = pastView([]);
  assert.equal(v.maxRows, 400);
  assert.equal(pastEarlier(v).maxRows, 800);
});
