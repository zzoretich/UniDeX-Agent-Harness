import { test } from "node:test";
import assert from "node:assert/strict";
import { fitKey, frameUnsized } from "./termFit";

test("a frame with no width or no height keeps the last fit; no frame at all is not unsized", () => {
  assert.equal(frameUnsized({ clientWidth: 0, clientHeight: 400 }), true);
  assert.equal(frameUnsized({ clientWidth: 600, clientHeight: 0 }), true);
  assert.equal(frameUnsized({ clientWidth: 600, clientHeight: 400 }), false);
  assert.equal(frameUnsized(null), false);
});

test("the fit key changes with the frame's size, the font's size or family, and the pixel ratio", () => {
  const frame = { clientWidth: 600, clientHeight: 400 };
  const base = fitKey(frame, { fontSize: 13, fontFamily: "Mono" }, 1);
  assert.equal(fitKey({ ...frame }, { fontSize: 13, fontFamily: "Mono" }, 1), base, "the same inputs, the same key");
  assert.notEqual(fitKey({ clientWidth: 601, clientHeight: 400 }, { fontSize: 13, fontFamily: "Mono" }, 1), base);
  assert.notEqual(fitKey({ clientWidth: 600, clientHeight: 399 }, { fontSize: 13, fontFamily: "Mono" }, 1), base);
  assert.notEqual(fitKey(frame, { fontSize: 15, fontFamily: "Mono" }, 1), base, "a font size change");
  assert.notEqual(fitKey(frame, { fontSize: 13, fontFamily: "Serif" }, 1), base, "a font family change");
  assert.notEqual(fitKey(frame, { fontSize: 13, fontFamily: "Mono" }, 2), base, "a zoom");
  assert.equal(fitKey(null, { fontSize: 13 }, 1), undefined);
});
