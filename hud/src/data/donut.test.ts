import { test } from "node:test";
import assert from "node:assert/strict";
import { donutArcs, DONUT_COLORS } from "./donut";

test("donutArcs emits one arc per positive segment, colored in order, skipping zero bytes", () => {
  const arcs = donutArcs([{ name: "a", bytes: 50 }, { name: "z", bytes: 0 }, { name: "b", bytes: 50 }], 100, 140);
  assert.equal(arcs.length, 2);
  assert.equal(arcs[0].fill, DONUT_COLORS[0]);
  assert.equal(arcs[1].fill, DONUT_COLORS[2]); // index follows the input position, like the legend
  assert.match(arcs[0].d, /^M70\.00,16\.80 A53\.2,53\.2 0 0 1 /); // starts at 12 o'clock, radius = size*0.38
  assert.equal(arcs[0].opacity, "0.85");
});

test("donutArcs is empty for no data", () => {
  assert.deepEqual(donutArcs([], 0, 140), []);
  assert.deepEqual(donutArcs([{ name: "a", bytes: 1 }], 0, 140), []);
});
