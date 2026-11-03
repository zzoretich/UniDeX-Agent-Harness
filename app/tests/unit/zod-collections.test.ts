import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadyInfoSchema, SpawnRequestSchema } from "../../src/main/ipc/schemas";

const spawn = { id: "dummy", cmd: "node", args: [] };

test("IPC environment maps accept 32 variables but reject 33 and malformed keys or values", () => {
  const env = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`DUMMY_${i}`, "value"]));
  assert.equal(SpawnRequestSchema.safeParse({ ...spawn, env }).success, true);
  assert.equal(SpawnRequestSchema.safeParse({ ...spawn, env: { ...env, DUMMY_EXTRA: "value" } }).success, false);
  assert.equal(SpawnRequestSchema.safeParse({ ...spawn, env: { "not-a-key": "value" } }).success, false);
  assert.equal(SpawnRequestSchema.safeParse({ ...spawn, env: { DUMMY: null } }).success, false);
});

test("IPC argument arrays accept 256 small strings but reject 257 without throwing", () => {
  assert.equal(SpawnRequestSchema.safeParse({ ...spawn, args: Array(256).fill("dummy") }).success, true);
  const rejected = SpawnRequestSchema.safeParse({ ...spawn, args: Array(257).fill("dummy") });
  assert.equal(rejected.success, false);
  if (!rejected.success) assert.deepEqual(rejected.error.issues[0].path, ["args"]);
});

test("IPC command collections validate nested fields and reject bounded malformed entries", () => {
  assert.equal(ReadyInfoSchema.safeParse({ commands: [{ id: "dummy", name: "Dummy" }] }).success, true);
  assert.equal(ReadyInfoSchema.safeParse({ commands: [{ id: "dummy", name: 42 }] }).success, false);
  assert.equal(ReadyInfoSchema.safeParse({ commands: Array(64).fill(null) }).success, false);
  assert.equal(ReadyInfoSchema.safeParse({ commands: [{ id: "dummy", name: "Dummy", hotkeys: [{ modifiers: Array(5).fill("Ctrl"), key: "D" }] }] }).success, false);
});
