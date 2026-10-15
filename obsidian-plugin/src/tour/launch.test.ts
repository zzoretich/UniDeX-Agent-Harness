import { test } from "node:test";
import assert from "node:assert/strict";
import { goLocalDue, importDue, welcomeStep, whatsNewId } from "./launch";
import { DEFAULT_TOUR_STATE, markCompleted, markLaunched, markSeen, type TourState } from "./state";
import type { WhatsNewRelease } from "./whatsnew";
import type { MigrationRow } from "../data/goLocal";

const rows = (state: MigrationRow["state"] | null): Record<string, MigrationRow> =>
  state ? { "local-first": { id: "local-first", state, at: null, backup: null }, import: { id: "import", state, at: null, backup: null } } : {};
const REL: WhatsNewRelease[] = [{ version: "2.0.0", entries: [{ id: "a", title: "A", body: "B", steps: [] }] }, { version: "2.1.0", entries: [{ id: "b", title: "B", body: "C", steps: [] }] }];
const existing = { firstTime: false, installed: false, behind: false };
const fresh = { firstTime: true, installed: true, behind: false };

test("Go local is due while the upgrade left it pending and the card was never shown (local-first A9)", () => {
  assert.equal(goLocalDue(rows("pending"), DEFAULT_TOUR_STATE), true);
  for (const s of ["applied", "declined", "undone", null] as const) assert.equal(goLocalDue(rows(s), DEFAULT_TOUR_STATE), false, String(s));
  assert.equal(goLocalDue(rows("pending"), markLaunched(DEFAULT_TOUR_STATE, "go-local")), false, "shown once: Settings offers it after");
  assert.equal(importDue(rows("pending"), DEFAULT_TOUR_STATE), false, "the Import sheet is PR 9's second stage");
});

test("the welcome: a new install's core tour; an install from before the tour What's new with the tour; later only what is new (C10)", () => {
  assert.deepEqual(welcomeStep(fresh, DEFAULT_TOUR_STATE, "2.0.0", REL), { kind: "core" });
  assert.equal(welcomeStep(fresh, markCompleted(DEFAULT_TOUR_STATE, "core"), "2.0.0", REL), null);
  assert.deepEqual(welcomeStep(existing, DEFAULT_TOUR_STATE, "2.0.0", REL), { kind: "whats-new", line: "2.0", releases: [REL[0]], firstTime: true });
  // A vault opened for the first time, not one the wizard made (a CLI install meeting the app): What's new too.
  assert.equal(welcomeStep({ ...existing, firstTime: true }, DEFAULT_TOUR_STATE, "2.0.0", REL)?.kind, "whats-new");
  const seen: TourState = markSeen(DEFAULT_TOUR_STATE, "2.0.0");
  assert.equal(welcomeStep(existing, seen, "2.0.0", REL), null);
  assert.deepEqual(welcomeStep(existing, seen, "2.1.0", REL), { kind: "whats-new", line: "2.1", releases: [REL[1]], firstTime: false });
  assert.equal(welcomeStep(existing, markLaunched(DEFAULT_TOUR_STATE, whatsNewId("2.0.0")), "2.0.0", REL), null, "the card shows once per release");
  assert.equal(whatsNewId("2.0.0"), "whats-new@2.0.0");
});
