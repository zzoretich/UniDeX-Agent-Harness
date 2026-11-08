import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HUD_HOST_REL, writeHudHostMarker } from "../../src/main/hud-host";

// The runtime's reader (brain/scripts/lib/hud-host.js), loaded at run time from the repo: the tests run bundled from
// app/out-test/, two levels below the repo root.
interface RuntimeHudHost { MARKER_REL: string; readMarker(vault: string): { schema: number; host: string; name: string | null; version: string; at: string | null; pid?: number; computerSocket?: string; computer?: string } | null }
const runtime = createRequire(__filename)(path.resolve(__dirname, "../../brain/scripts/lib/hud-host.js")) as RuntimeHudHost;

test("hud-host: the marker the app writes is the record the runtime reads", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-app-hudhost-"));
  const at = new Date("2026-10-05T12:00:00.000Z");
  const file = writeHudHostMarker(vault, { name: "AgenticOS Workbench", version: "1.2.3" }, at);
  assert.equal(HUD_HOST_REL, runtime.MARKER_REL, "one path on both sides");
  assert.equal(file, path.join(vault, HUD_HOST_REL));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { schema: 1, host: "app", name: "AgenticOS Workbench", version: "1.2.3", at: at.toISOString() });
  assert.deepEqual(runtime.readMarker(vault), { schema: 1, host: "app", name: "AgenticOS Workbench", version: "1.2.3", at: at.toISOString() });
  // A second start replaces it whole and leaves no temp file behind.
  writeHudHostMarker(vault, { name: "AgenticOS Workbench", version: "1.2.4" });
  assert.equal(runtime.readMarker(vault)?.version, "1.2.4");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["hud-host.json"]);
});

test("hud-host: a vault it cannot write to throws, and leaves no temp file", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-app-hudhost-ro-"));
  const dir = path.join(vault, "brain", "_index");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "hud-host.json"));   // a folder where the file goes: the rename fails
  assert.throws(() => writeHudHostMarker(vault, { name: "AgenticOS Workbench", version: "1.0.0" }));
  assert.deepEqual(fs.readdirSync(dir), ["hud-host.json"]);
});

test("hud-host: computerSocket is written and read when given, and absent otherwise (agent-computer D26)", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-app-hudhost-cs-"));
  const at = new Date("2026-10-05T12:00:00.000Z");
  const file = writeHudHostMarker(vault, { name: "AgenticOS Workbench", version: "1.2.3", computerSocket: "/tmp/x/bridge.sock" }, at);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { schema: 1, host: "app", name: "AgenticOS Workbench", version: "1.2.3", at: at.toISOString(), computerSocket: "/tmp/x/bridge.sock" });
  assert.equal(runtime.readMarker(vault)?.computerSocket, "/tmp/x/bridge.sock");
  writeHudHostMarker(vault, { name: "AgenticOS Workbench", version: "1.2.3" }, at);
  assert.equal("computerSocket" in JSON.parse(fs.readFileSync(file, "utf8")), false);
  assert.equal("computerSocket" in (runtime.readMarker(vault) as object), false);
});

test("hud-host: with the Computer surface off the marker says so instead of naming a socket (agent-computer D26)", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-app-hudhost-off-"));
  const at = new Date("2026-10-05T12:00:00.000Z");
  const file = writeHudHostMarker(vault, { name: "UniDeX", version: "1.2.3", computerOff: true }, at);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { schema: 1, host: "app", name: "UniDeX", version: "1.2.3", at: at.toISOString(), computer: "off" });
  assert.equal(runtime.readMarker(vault)?.computer, "off");
  writeHudHostMarker(vault, { name: "UniDeX", version: "1.2.3", computerOff: false }, at);
  assert.equal("computer" in JSON.parse(fs.readFileSync(file, "utf8")), false);
  writeHudHostMarker(vault, { name: "UniDeX", version: "1.2.3", computerSocket: "/tmp/x/bridge.sock", computerOff: true }, at);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).filter((k) => k.startsWith("computer")), ["computerSocket"], "a listening bridge is never off");
});

test("hud-host: main's pid, and a bridge that did not start, are recorded and read back (agent-computer D26)", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-app-hudhost-failed-"));
  const at = new Date("2026-10-05T12:00:00.000Z");
  const file = writeHudHostMarker(vault, { name: "UniDeX", version: "1.2.3", pid: 4242, computerFailed: true }, at);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { schema: 1, host: "app", name: "UniDeX", version: "1.2.3", at: at.toISOString(), pid: 4242, computer: "failed" });
  assert.deepEqual(runtime.readMarker(vault), { schema: 1, host: "app", name: "UniDeX", version: "1.2.3", at: at.toISOString(), pid: 4242, computer: "failed" });
  // Off wins over failed (no bridge is wanted), a socket over both; a pid that is not a positive integer is left out.
  writeHudHostMarker(vault, { name: "UniDeX", version: "1.2.3", pid: 0, computerOff: true, computerFailed: true }, at);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { schema: 1, host: "app", name: "UniDeX", version: "1.2.3", at: at.toISOString(), computer: "off" });
  writeHudHostMarker(vault, { name: "UniDeX", version: "1.2.3", pid: 4242, computerSocket: "/tmp/x/bridge.sock", computerFailed: true }, at);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).computer, undefined);
  // At quit the app writes it with no Computer state at all.
  writeHudHostMarker(vault, { name: "UniDeX", version: "1.2.3", pid: 4242 }, at);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).filter((k) => k.startsWith("computer")), []);
});
