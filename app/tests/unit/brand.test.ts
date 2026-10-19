// The product's name (UniDeX spec D1) lives in two copies, one per tree: the app's and the HUD's. They must agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND as HUD } from "../../../hud/src/brand";
import { BRAND as APP } from "../../src/shared/brand";

test("the app and the HUD name the product the same way", () => {
  assert.deepEqual(HUD, APP);
  assert.equal(APP.name, "UniDeX");
});
