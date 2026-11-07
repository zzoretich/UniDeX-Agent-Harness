import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceRects, paintRects, MASK_BGRA } from "../../src/main/computer/mask";

const viewport = { x: 0, y: 0, width: 800, height: 600 };

test("rects scale by device pixels and zoom", () => {
  // 2x display at 125% page zoom: one CSS pixel is 2.5 device pixels.
  assert.deepEqual(deviceRects([{ x: 10, y: 20, width: 100, height: 30 }], { dpr: 2, zoom: 1.25, viewport }), [{ x: 25, y: 50, width: 250, height: 75 }]);
  // Fractional edges round outwards, so the mask never falls short of the field.
  assert.deepEqual(deviceRects([{ x: 10.3, y: 20.3, width: 100, height: 30 }], { dpr: 2, zoom: 1.25, viewport }), [{ x: 25, y: 50, width: 251, height: 76 }]);
});

test("rects are clipped to the viewport and dropped outside it", () => {
  const r = deviceRects([
    { x: -20, y: 590, width: 50, height: 40 },
    { x: 900, y: 10, width: 50, height: 40 },
    { x: 10, y: 10, width: 0, height: 40 },
  ], { dpr: 1, zoom: 1, viewport });
  assert.deepEqual(r, [{ x: 0, y: 590, width: 30, height: 10 }]);
  // A viewport offset (the visual viewport scrolled within the layout one) shifts the rects first.
  assert.deepEqual(deviceRects([{ x: 110, y: 220, width: 10, height: 10 }], { dpr: 2, zoom: 1, viewport: { x: 100, y: 200, width: 800, height: 600 } }), [{ x: 20, y: 40, width: 20, height: 20 }]);
});

test("paintRects changes exactly the rect's pixels", () => {
  const width = 8, height = 6;
  const src = Buffer.alloc(width * height * 4);
  for (let i = 0; i < src.length; i += 4) src.set([10, 20, 30, 255], i);
  const out = paintRects(src, width, height, [{ x: 2, y: 1, width: 3, height: 2 }, { x: 7, y: 5, width: 9, height: 9 }]);
  assert.ok(src.every((v, i) => v === [10, 20, 30, 255][i % 4]), "the input is not changed");
  let changed = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = [...out.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
    const inside = (x >= 2 && x < 5 && y >= 1 && y < 3) || (x === 7 && y === 5);
    assert.deepEqual(px, inside ? [...MASK_BGRA] : [10, 20, 30, 255], `pixel ${x},${y}`);
    if (inside) changed++;
  }
  assert.equal(changed, 7);
  assert.throws(() => paintRects(Buffer.alloc(10), width, height, []), /bitmap/);
});
