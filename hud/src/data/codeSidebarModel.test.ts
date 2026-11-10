import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeSidebarModel } from "./codeSidebarModel";
import { scopeOf } from "./termGroups";
import type { Place } from "./terminalLaunch";

const ws = (n: string): Place => ({ kind: "workspace", label: n, dir: `/v/workspaces/${n}`, workspace: n });

// A pool of terminals started in the given workspaces; the chat feeds are off, so only the terminals make groups.
function model(places: Place[]) {
  const sessions = places.map((place, i) => ({
    id: String(i + 1), cwd: place.dir, meta: { host: "shell", origin: null, startedAt: 1_000 + i, sessionId: null, place },
    getTitle: () => `t${i + 1}`, isExited: false, exitCode: null, agentEnded: false,
  }));
  const plugin = {
    terminalPool: { list: () => sessions },
    termLauncher: { world: () => ({ vault: "/v", home: "/h", workspaces: [], links: {} }) },
    codeFeeds: null,
  };
  return new CodeSidebarModel(plugin as never, { filter: () => "", changed: () => {} });
}

test("scope keeps only its workspace's group", () => {
  const m = model([ws("kite"), ws("harbor"), ws("kite")]);
  assert.deepEqual(m.build().map((g) => g.label).sort(), ["harbor", "kite"]);
  m.scope = scopeOf(ws("kite"));
  const groups = m.build();
  assert.deepEqual(groups.map((g) => g.label), ["kite"]);
  assert.equal(groups[0].rows.length, 2);
});

test("a scoped workspace with nothing running still shows its (empty) group", () => {
  const m = model([ws("harbor")]);
  m.scope = scopeOf(ws("kite"));
  const groups = m.build();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "ws:kite");
  assert.deepEqual(groups[0].rows, []);
});
