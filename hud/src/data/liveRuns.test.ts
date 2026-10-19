import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LiveRunsWatcher } from "./liveRuns";
import type { Events } from "obsidian";

function vault(): string {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), "aos-live-"));
  fs.mkdirSync(path.join(v, "brain", "_index"), { recursive: true });
  return v;
}
const bus = { trigger: () => undefined } as unknown as Events;

test("createDirs:false never creates agent-runs/live or runs.jsonl", () => {
  const v = vault();
  const w = new LiveRunsWatcher({ vault: v, bus, pollMs: 5000, createDirs: false });
  w.start();
  w.stop();
  assert.equal(fs.existsSync(path.join(v, "brain", "_index", "agent-runs")), false);
});

test("default (createDirs:true) creates the live dir and an empty summary log", () => {
  const v = vault();
  const w = new LiveRunsWatcher({ vault: v, bus, pollMs: 5000 });
  w.start();
  w.stop();
  assert.equal(fs.existsSync(path.join(v, "brain", "_index", "agent-runs", "live")), true);
  assert.equal(fs.readFileSync(path.join(v, "brain", "_index", "agent-runs", "runs.jsonl"), "utf8"), "");
});

test("a vault root that does not exist is never created, even with createDirs:true", () => {
  const v = path.join(os.tmpdir(), "aos-live-missing-" + process.pid);
  const w = new LiveRunsWatcher({ vault: v, bus, pollMs: 5000, createDirs: true });
  w.start();
  w.stop();
  assert.equal(fs.existsSync(v), false);
});

test("a watcher with createDirs:false still replays in-flight runs that already exist", () => {
  const v = vault();
  const live = path.join(v, "brain", "_index", "agent-runs", "live");
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, "r1.ndjson"), JSON.stringify({ type: "run_start", id: "r1", script: "ask", started_at: "2026-09-04T10:00:00Z" }) + "\n");
  const seen: string[] = [];
  const spyBus = { trigger: (_n: string, e: { type: string; data: { id?: string } }) => { seen.push(`${e.type}:${e.data.id}`); } } as unknown as Events;
  const w = new LiveRunsWatcher({ vault: v, bus: spyBus, pollMs: 5000, createDirs: false });
  w.start();
  w.replayInflight();
  w.stop();
  assert.deepEqual(seen, ["run-start:r1"]);
});
