import { test } from "node:test";
import assert from "node:assert/strict";
import { FIND_LIMIT, findCountLabel } from "./termFind";

test("the find count: nothing while empty, No results, then the selected match of the total", () => {
  assert.equal(findCountLabel("", { resultIndex: 0, resultCount: 3 }), "");
  assert.equal(findCountLabel("needle", null), "No results");
  assert.equal(findCountLabel("needle", { resultIndex: -1, resultCount: 0 }), "No results");
  assert.equal(findCountLabel("needle", { resultIndex: 0, resultCount: 7 }), "1 of 7");
  assert.equal(findCountLabel("needle", { resultIndex: 6, resultCount: 7 }), "7 of 7");
});

test("the find count past the addon's limit says so, and a match below it still counts", () => {
  assert.equal(findCountLabel("e", { resultIndex: 2, resultCount: FIND_LIMIT }), "3 of 1000+");
  // The selected match lies beyond the highlighted ones: the addon reports no index.
  assert.equal(findCountLabel("e", { resultIndex: -1, resultCount: FIND_LIMIT }), "1000+ matches");
  assert.equal(findCountLabel("e", { resultIndex: -1, resultCount: 1 }), "1 match");
  assert.equal(findCountLabel("e", { resultIndex: 0, resultCount: 5 }, 5), "1 of 5+");
});
