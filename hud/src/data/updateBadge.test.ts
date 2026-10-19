import { test } from "node:test";
import assert from "node:assert/strict";
import { updateBadge } from "./updateBadge";
import type { SnapshotUpdates } from "./snapshot";

// Injected so these assertions never depend on the clock; the view passes formatRelative.
const age = (iso: string) => `AGE(${iso})`;

const u = (over: Partial<SnapshotUpdates> = {}): SnapshotUpdates => ({
  installed: "0.1.0",
  latest: "0.2.0",
  behind: true,
  checkedAt: "2026-09-16T00:00:00.000Z",
  snoozed: false,
  ...over,
});

test("no badge when there is nothing to say", () => {
  assert.equal(updateBadge(undefined, age), null, "absent before the first check");
  assert.equal(updateBadge(u({ behind: false }), age), null, "up to date");
  assert.equal(updateBadge(u({ snoozed: true }), age), null, "a snooze stays silent in the HUD too");
  assert.equal(updateBadge(u({ latest: null }), age), null, "no release published yet");
});

test("the badge carries the version, and the detail in its tooltip", () => {
  const b = updateBadge(u(), age);
  assert.ok(b);
  assert.equal(b.label, "⬆ 0.2.0");
  assert.equal(b.title, "0.1.0 → 0.2.0 · checked AGE(2026-09-16T00:00:00.000Z) · run `aos upgrade`");
});

test("the tooltip drops the checked clause when checkedAt is absent", () => {
  const b = updateBadge(u({ checkedAt: null }), age);
  assert.ok(b);
  assert.equal(b.title, "0.1.0 → 0.2.0 · run `aos upgrade`");
});

test("an unknown installed version still renders, rather than printing null", () => {
  const b = updateBadge(u({ installed: null }), age);
  assert.ok(b);
  assert.equal(b.title, "(unknown) → 0.2.0 · checked AGE(2026-09-16T00:00:00.000Z) · run `aos upgrade`");
});

test("it trusts the snapshot's behind/snoozed instead of recomputing them", () => {
  // The scanner said behind, so the badge shows — even though the versions read equal here.
  assert.ok(updateBadge(u({ installed: "0.2.0", latest: "0.2.0", behind: true }), age));
  // The scanner said not behind, so the badge stays away — we do not second-guess it. Recomputing
  // would add another copy of a rule this project has already had to keep in sync twice.
  assert.equal(updateBadge(u({ installed: "0.0.9", latest: "0.2.0", behind: false }), age), null);
});
