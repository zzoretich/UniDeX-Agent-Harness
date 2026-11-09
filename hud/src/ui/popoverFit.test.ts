// A popover opened from a chip stays inside the part of the window it can be seen in (the CI fix for the host menu,
// whose left part ran under the session list when the Computer pane narrowed Sessions' reader).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitSpan } from "./popoverFit";

test("fitSpan: a popover that fits stays where its stylesheet puts it", () => {
  assert.deepEqual(fitSpan({ left: 543, right: 963 }, { left: 304, right: 1040 }, "right"), { offset: 0, maxWidth: null });
});

test("fitSpan: the host menu in a 280 px reader (the e2e run's 1024 px window) is narrowed to the reader and moved inside it", () => {
  // The run measured the popover at 127–547 and the reader at 304–584: its first 177 px, the Claude Code host's button
  // among them, were under the session list.
  const fit = fitSpan({ left: 127, right: 547 }, { left: 304, right: 584 }, "right");
  assert.deepEqual(fit, { offset: -29, maxWidth: 264 });
  // Narrowed from its right edge (547): 283–547, then moved right by 29: 312–576, inside 304–584 by 8 px each side.
  assert.deepEqual([547 - fit.maxWidth! - fit.offset, 547 - fit.offset], [312, 576]);
});

test("fitSpan: anchored at its chip's left edge, a menu running past the box's right edge moves left, or is narrowed", () => {
  assert.deepEqual(fitSpan({ left: 400, right: 600 }, { left: 304, right: 584 }, "left"), { offset: -24, maxWidth: null });
  assert.deepEqual(fitSpan({ left: 345, right: 815 }, { left: 304, right: 584 }, "left"), { offset: -33, maxWidth: 264 });
});

test("fitSpan: one that only runs past its anchored side moves back in without a cap", () => {
  assert.deepEqual(fitSpan({ left: 280, right: 500 }, { left: 304, right: 1040 }, "right"), { offset: -32, maxWidth: null });
});
