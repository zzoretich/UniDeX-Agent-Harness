import { test } from "node:test";
import assert from "node:assert/strict";
import { sparkline, deltaArrow, sparklineGeometry } from "./sparkline";

test("unicode sparkline and delta arrow are unchanged", () => {
  assert.equal(sparkline([1, 2, 3, 4, 5, 6, 7, 8]).length, 8);
  assert.equal(sparkline([3, 3, 3]), "▄▄▄");
  assert.equal(deltaArrow([1, 4]), "↑3");
  assert.equal(deltaArrow([4, 1]), "↓3");
});

test("sparklineGeometry maps values to a line, an area and a tail dot", () => {
  const g = sparklineGeometry([0, 10, 5], { width: 100, height: 20 });
  assert.ok(g);
  assert.equal(g!.w, 100);
  assert.equal(g!.line, "M 0.0,20.0 L 50.0,0.0 L 100.0,10.0");
  assert.equal(g!.area, "M 0.0,20.0 L 50.0,0.0 L 100.0,10.0 L 100.0,20 L 0.0,20 Z");
  assert.deepEqual(g!.tail, { x: 100, y: 10 });
});

test("sparklineGeometry is null for no values and puts a single value at the right edge", () => {
  assert.equal(sparklineGeometry([], {}), null);
  const one = sparklineGeometry([7], { width: 50, height: 10 });
  assert.deepEqual(one!.tail, { x: 50, y: 10 });
});
