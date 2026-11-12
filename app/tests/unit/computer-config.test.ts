import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computerConfig } from "../../src/main/computer/config";

function vault(brain?: unknown, aos?: unknown): { v: string; f: string | null } {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), "aos-cc-"));
  fs.mkdirSync(path.join(v, "brain"), { recursive: true });
  if (brain !== undefined) fs.writeFileSync(path.join(v, "brain", "config.json"), JSON.stringify(brain));
  let f: string | null = null;
  if (aos !== undefined) { f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aos-cc-f-")), "agenticos.json"); fs.writeFileSync(f, JSON.stringify(aos)); }
  return { v, f };
}

const cfg = (x: { v: string; f: string | null }) => computerConfig(x.v, x.f);

test("no vault and no file gives the defaults", () => {
  assert.deepEqual(computerConfig(null, null), { enabled: true, askTimeoutSec: 120, awake: 4 });
  assert.deepEqual(cfg(vault()), { enabled: true, askTimeoutSec: 120, awake: 4 });
});

test("brain/config.json beats the default and the agenticos file beats that, key by key", () => {
  assert.equal(cfg(vault({ computer: { askTimeoutSec: 300 } })).askTimeoutSec, 300);
  assert.deepEqual(cfg(vault({ computer: { askTimeoutSec: 300, enabled: false } }, { computer: { askTimeoutSec: 600 } })), { enabled: false, askTimeoutSec: 600, awake: 4 });
});

test("a null vault still applies the agenticos file", () => {
  const { f } = vault(undefined, { computer: { enabled: false, askTimeoutSec: 90, awake: 4 } });
  assert.deepEqual(computerConfig(null, f), { enabled: false, askTimeoutSec: 90, awake: 4 });
});

test("an agenticos.json inside the vault is not read", () => {
  const { v } = vault(); fs.writeFileSync(path.join(v, "agenticos.json"), JSON.stringify({ computer: { askTimeoutSec: 600 } }));
  assert.equal(computerConfig(v, null).askTimeoutSec, 120);
});

test("wrong-typed values are ignored", () => {
  assert.deepEqual(cfg(vault({ computer: { askTimeoutSec: "300", enabled: "no" } })), { enabled: true, askTimeoutSec: 120, awake: 4 });
});

test("askTimeoutSec is an integer clamped to 30..3600", () => {
  for (const [n, want] of [[-5, 30], [0, 30], [10, 30], [90.7, 90], [99999, 3600], [1e12, 3600]] as const)
    assert.equal(cfg(vault({ computer: { askTimeoutSec: n } })).askTimeoutSec, want, String(n));
});

test("computer.awake defaults to 4 and is held to 1…12 (session-browser S9)", () => {
  assert.equal(cfg(vault()).awake, 4);
  assert.equal(cfg(vault({ computer: { awake: 0 } })).awake, 1);
  assert.equal(cfg(vault({ computer: { awake: 99 } })).awake, 12);
  assert.equal(cfg(vault({ computer: { awake: 6.7 } })).awake, 6);
  assert.equal(cfg(vault({ computer: { awake: "x" } })).awake, 4);
});
