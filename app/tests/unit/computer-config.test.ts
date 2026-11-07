import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computerConfig } from "../../src/main/computer/config";

function vault(brain?: unknown, aos?: unknown): string {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), "aos-cc-"));
  fs.mkdirSync(path.join(v, "brain"), { recursive: true });
  if (brain !== undefined) fs.writeFileSync(path.join(v, "brain", "config.json"), JSON.stringify(brain));
  if (aos !== undefined) fs.writeFileSync(path.join(v, "agenticos.json"), JSON.stringify(aos));
  return v;
}

test("no vault gives the defaults", () => {
  assert.deepEqual(computerConfig(null), { enabled: true, askTimeoutSec: 120 });
  assert.deepEqual(computerConfig(vault()), { enabled: true, askTimeoutSec: 120 });
});

test("brain/config.json beats the default and agenticos.json beats that, key by key", () => {
  assert.equal(computerConfig(vault({ computer: { askTimeoutSec: 300 } })).askTimeoutSec, 300);
  const c = computerConfig(vault({ computer: { askTimeoutSec: 300, enabled: false } }, { computer: { askTimeoutSec: 600 } }));
  assert.deepEqual(c, { enabled: false, askTimeoutSec: 600 });
});

test("wrong-typed values are ignored", () => {
  const c = computerConfig(vault({ computer: { askTimeoutSec: "300", enabled: "no" } }, { computer: { askTimeoutSec: -5 } }));
  assert.deepEqual(c, { enabled: true, askTimeoutSec: 120 });
});
