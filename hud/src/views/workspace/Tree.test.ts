import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTeams, parentOf, rowState, UNSCANNED } from "./Tree";
import type { TreeRow } from "../../data/workspace";

const r = (key: string, kind: TreeRow["kind"], depth: number, extra: Partial<TreeRow> = {}): TreeRow => ({ key, kind, label: key, depth, tone: null, ...extra });

// The fixture's shape: Example with its members and the Survey sub-team under it, a broken team, the bench, plugins.
const ROWS: TreeRow[] = [
  r("needs", "needs", 0, { count: 2 }),
  r("section:teams", "section", 0, { count: 3 }),
  r("team:broken", "team", 1, { broken: true }),
  r("team:example", "team", 1, { count: 1 }),
  r("agent:team-lead", "member", 2, { lead: true }),
  r("agent:team-builder", "member", 2),
  r("team:survey", "team", 2),
  r("agent:survey-lead", "member", 3, { lead: true }),
  r("agent:team-builder", "member", 3),
  r("section:bench", "section", 0, { count: 0 }),
  r("section:plugins", "section", 0, { count: 4 }),
];
const keys = (rows: TreeRow[]) => rows.map((x) => x.key);

test("foldTeams: a folded team hides its members and its sub-team; the next team at its depth shows again", () => {
  const shown = foldTeams(ROWS, new Set(["team:example"]));
  assert.deepEqual(keys(shown), ["needs", "section:teams", "team:broken", "team:example", "section:bench", "section:plugins"]);
  assert.equal(shown.find((x) => x.key === "team:example")?.folded, true);
  // A sub-team folds alone; its parent's members stay.
  assert.deepEqual(keys(foldTeams(ROWS, new Set(["team:survey"]))), keys(ROWS).filter((k, i) => i < 7 || i > 8));
});

test("foldTeams: a team with nothing under it is never folded; a filter ignores the folds; sections are workspaceTree's", () => {
  const shown = foldTeams(ROWS, new Set(["team:broken", "section:teams"]));
  assert.deepEqual(keys(shown), keys(ROWS));
  assert.equal(shown.find((x) => x.key === "team:broken")?.folded, undefined);
  assert.deepEqual(keys(foldTeams(ROWS, new Set(["team:example"]), "sur")), keys(ROWS));
  assert.deepEqual(keys(foldTeams(ROWS, new Set(["team:example"]), "  ")), keys(foldTeams(ROWS, new Set(["team:example"]))));
});

test("parentOf: the row a row sits under, -1 at the top", () => {
  assert.equal(parentOf(ROWS, 4), 3, "a member sits under its team");
  assert.equal(parentOf(ROWS, 6), 3, "a sub-team under its parent");
  assert.equal(parentOf(ROWS, 8), 6);
  assert.equal(parentOf(ROWS, 3), 1, "a team under TEAMS");
  assert.equal(parentOf(ROWS, 1), -1);
  assert.equal(parentOf(ROWS, 0), -1);
});

test("rowState: sections fold when they hold something, teams when they have rows under them, the note never", () => {
  const at = (key: string, rows = ROWS) => rowState(rows, rows.findIndex((x) => x.key === key));
  assert.deepEqual(at("section:teams"), { open: true, foldable: true, pickable: false, note: false });
  assert.deepEqual(at("section:plugins"), { open: false, foldable: true, pickable: false, note: false }, "folded with 4 inside");
  assert.deepEqual(at("section:bench"), { open: false, foldable: false, pickable: false, note: false }, "empty: nothing to fold");
  assert.deepEqual(at("team:example"), { open: true, foldable: true, pickable: true, note: false });
  assert.deepEqual(at("team:broken"), { open: false, foldable: false, pickable: true, note: false });
  assert.deepEqual(at("needs"), { open: false, foldable: false, pickable: true, note: false });
  const folded = foldTeams(ROWS, new Set(["team:example"]));
  assert.deepEqual(at("team:example", folded), { open: false, foldable: true, pickable: true, note: false });
  // No agents cache: BENCH holds a note that is neither folded nor picked, though BENCH itself can fold it away.
  const unscanned = [r("section:bench", "section", 0, { count: 0 }), r(UNSCANNED, "section", 1)];
  assert.deepEqual(rowState(unscanned, 1), { open: false, foldable: false, pickable: false, note: true });
  assert.deepEqual(rowState(unscanned, 0), { open: true, foldable: true, pickable: false, note: false });
});
