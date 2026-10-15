import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOUR_STATE, markCompleted, markDismissed, markDone, markOffered, markSeen, sanitizeTourState, setChecklistDismissed,
} from "./state";
import { DEFAULT_SETTINGS } from "../settingsDefaults";

test("the HUD settings carry the tour key, defaulting to nothing seen (tour C4)", () => {
  assert.deepEqual(DEFAULT_SETTINGS.tour, DEFAULT_TOUR_STATE);
  assert.deepEqual(DEFAULT_TOUR_STATE, { lastSeenVersion: null, completed: [], dismissed: [], checklist: { dismissed: false, done: {} }, offered: [] });
});

test("a stored value of any shape reads as the default, never throws", () => {
  for (const raw of [undefined, null, {}, [], "x", 3, true, { completed: "core" }, { checklist: [] }]) {
    assert.deepEqual(sanitizeTourState(raw), DEFAULT_TOUR_STATE, JSON.stringify(raw));
  }
});

test("good parts are kept, bad ones dropped", () => {
  const s = sanitizeTourState({
    lastSeenVersion: "2.0.0",
    completed: ["core", "core", "pulse", 7, "Bad Id", "../x"],
    dismissed: ["spaces"],
    checklist: { dismissed: true, done: { "first-session": "2026-10-14T10:00:00.000Z", "x y": "2026-10-14T10:00:00.000Z", routine: "not a date" } },
    offered: ["pulse", "memory"],
    extra: 1,
  });
  assert.deepEqual(s, {
    lastSeenVersion: "2.0.0",
    completed: ["core", "pulse"],
    dismissed: ["spaces"],
    checklist: { dismissed: true, done: { "first-session": "2026-10-14T10:00:00.000Z" } },
    offered: ["pulse", "memory"],
  });
  assert.equal(sanitizeTourState({ lastSeenVersion: "two" }).lastSeenVersion, null);
});

test("every change returns a new object and leaves the default alone", () => {
  const before = JSON.stringify(DEFAULT_TOUR_STATE);
  const a = markCompleted(DEFAULT_TOUR_STATE, "core");
  const b = markOffered(a, "pulse");
  const c = markDone(b, ["first-session"], new Date("2026-10-14T10:00:00Z"));
  const d = setChecklistDismissed(c, true);
  const e = markSeen(d, "2.0.0");
  assert.equal(JSON.stringify(DEFAULT_TOUR_STATE), before);
  assert.deepEqual(e, {
    lastSeenVersion: "2.0.0", completed: ["core"], dismissed: [], offered: ["pulse"],
    checklist: { dismissed: true, done: { "first-session": "2026-10-14T10:00:00.000Z" } },
  });
});

test("completing a chapter clears its skip; skipping a completed one keeps it completed", () => {
  const skipped = markDismissed(DEFAULT_TOUR_STATE, "spaces");
  assert.deepEqual(skipped.dismissed, ["spaces"]);
  const done = markCompleted(skipped, "spaces");
  assert.deepEqual([done.completed, done.dismissed], [["spaces"], []]);
  assert.deepEqual(markDismissed(done, "spaces"), done);
});

test("an action keeps the first time it was seen done; a bad version is not recorded", () => {
  const first = markDone(DEFAULT_TOUR_STATE, ["first-review"], new Date("2026-10-01T00:00:00Z"));
  const again = markDone(first, ["first-review"], new Date("2026-10-14T00:00:00Z"));
  assert.equal(again.checklist.done["first-review"], "2026-10-01T00:00:00.000Z");
  assert.equal(markSeen(DEFAULT_TOUR_STATE, "latest").lastSeenVersion, null);
});
