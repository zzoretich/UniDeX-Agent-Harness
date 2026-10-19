import { test } from "node:test";
import assert from "node:assert/strict";
import { heartbeatPill, parsePersonaHeartbeat, PersonaHeartbeat } from "./personaHeartbeat";

// Injected so nothing here depends on the clock or the locale; the view passes formatRelative.
const age = (iso: string) => `AGE(${iso})`;
const next = (iso: string) => `NEXT(${iso})`;
const NOW = Date.parse("2026-09-22T10:00:00.000Z");
const min = (n: number) => NOW - n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const hb = (over: Partial<PersonaHeartbeat> = {}, beats: PersonaHeartbeat["beats"] = {}): PersonaHeartbeat => ({
  schema: 1,
  checkedAt: iso(min(12)),
  beats: {
    sitrep: { kind: "duty", enabled: true, status: "ok", lastRunAt: "2026-09-22T07:45:00.000Z", next: "2026-09-23T07:45:00.000Z" },
    heartbeat: { kind: "command", enabled: true, status: "unwatched", lastRunAt: iso(min(12)), next: iso(min(-18)) },
    ...beats,
  },
  misses: [],
  ...over,
});

test("no pill without a heartbeat file; the parser rejects the wrong schema or shape", () => {
  assert.equal(heartbeatPill(null, NOW, age), null);
  assert.equal(parsePersonaHeartbeat("not json"), null);
  assert.equal(parsePersonaHeartbeat(JSON.stringify({ schema: 2, checkedAt: "x", beats: {} })), null);
  assert.equal(parsePersonaHeartbeat(JSON.stringify({ schema: 1, checkedAt: "x" })), null, "beats required");
  assert.equal(parsePersonaHeartbeat("[]"), null);
  assert.ok(parsePersonaHeartbeat(JSON.stringify(hb())));
});

test("tone follows the check's age: green under 1 h, amber under 3 h, red from 3 h", () => {
  assert.equal(heartbeatPill(hb({ checkedAt: iso(min(59)) }), NOW, age)!.tone, "ok");
  assert.equal(heartbeatPill(hb({ checkedAt: iso(min(60)) }), NOW, age)!.tone, "warn");
  assert.equal(heartbeatPill(hb({ checkedAt: iso(min(179)) }), NOW, age)!.tone, "warn");
  assert.equal(heartbeatPill(hb({ checkedAt: iso(min(180)) }), NOW, age)!.tone, "bad");
  assert.equal(heartbeatPill(hb({ checkedAt: "garbage" }), NOW, age)!.tone, "bad", "an unreadable checkedAt is never green");
});

test("a missed or failed duty is red whatever the age; never/stale/invalid are amber; disabled and command beats do not count", () => {
  assert.equal(heartbeatPill(hb({}, { monitor: { kind: "duty", enabled: true, status: "missed", due: iso(min(90)) } }), NOW, age)!.tone, "bad");
  assert.equal(heartbeatPill(hb({}, { monitor: { kind: "duty", enabled: true, status: "failed", lastRunAt: iso(min(90)) } }), NOW, age)!.tone, "bad");
  for (const status of ["never", "stale", "invalid"]) {
    assert.equal(heartbeatPill(hb({}, { tick: { kind: "duty", enabled: true, status } }), NOW, age)!.tone, "warn", status);
  }
  assert.equal(heartbeatPill(hb({}, { old: { kind: "duty", enabled: false, status: "disabled" } }), NOW, age)!.tone, "ok");
  assert.equal(heartbeatPill(hb({}, { heartbeat: { kind: "command", enabled: true, status: "failed" } }), NOW, age)!.tone, "ok", "a command routine is the watchdog's own lane, not a duty");
});

test("the label carries the age and the miss count; the tooltip lists each enabled duty with status, last and next", () => {
  const p = heartbeatPill(hb({}, { monitor: { kind: "duty", enabled: true, status: "missed", due: iso(min(90)), lastRunAt: null, next: "2026-09-23T13:00:00.000Z" } }), NOW, age, next)!;
  assert.equal(p.label, `♥ AGE(${iso(min(12))}) · 1 missed`);
  assert.equal(p.title, [
    `watchdog checked AGE(${iso(min(12))})`,
    "monitor: missed · last never · next NEXT(2026-09-23T13:00:00.000Z)",
    "sitrep: ok · last AGE(2026-09-22T07:45:00.000Z) · next NEXT(2026-09-23T07:45:00.000Z)",
  ].join("\n"));
  const fine = heartbeatPill(hb(), NOW, age, next)!;
  assert.equal(fine.label, `♥ AGE(${iso(min(12))})`, "no miss clause when nothing is missed");
  assert.ok(!fine.title.includes("heartbeat:"), "the watchdog's own command routine is not listed as a duty");
});

test("a stale check says so in the tooltip, and an empty duty list still renders", () => {
  const p = heartbeatPill(hb({ checkedAt: iso(min(150)) }), NOW, age)!;
  assert.match(p.title, /is the heartbeat routine running\? \(aos routines list\)/);
  const none = heartbeatPill({ schema: 1, checkedAt: iso(min(1)), beats: {} }, NOW, age)!;
  assert.equal(none.tone, "ok");
  assert.match(none.title, /no enabled duties/);
});
