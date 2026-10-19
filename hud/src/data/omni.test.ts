import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOmniItems, OmniInputs } from "./omni";

const INPUTS: OmniInputs = {
  maps: { Alpha: { workspace: "Alpha", generatedAt: null, pending: 0, files: [
    { path: "src/main.js", desc: "Boots the app", descAt: null, mtime: 1, size: 1, status: "fresh" } ] } },
  memories: [{ path: "brain/memory/user/profile.md", slug: "profile", type: "user", title: "Profile", created: null, updated: null, reviewed: null }],
  runs: [{ id: "run-123", label: "scan sweep" } as never],
  agents: [{ name: "Explore" } as never],
  skills: [{ name: "cost", path: "skills/cost/SKILL.md" }],
  actions: [{ id: "run-scan", title: "scan-vault is stale" } as never],
};

test("every source contributes typed items", () => {
  const items = buildOmniItems(INPUTS);
  const kinds = new Set(items.map((i) => i.kind));
  assert.deepEqual([...kinds].sort(), ["action", "agent", "file", "memory", "run", "skill"]);
});

test("file items carry workspace-prefixed vault paths as payload", () => {
  const f = buildOmniItems(INPUTS).find((i) => i.kind === "file");
  assert.equal(f?.payload, "workspaces/Alpha/src/main.js");
  assert.match(f!.hint, /Boots the app/);
});

test("empty inputs produce an empty list", () => {
  assert.deepEqual(buildOmniItems({ maps: {}, memories: [], runs: [], agents: [], skills: [], actions: [] }), []);
});
