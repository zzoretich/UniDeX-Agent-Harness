// The Computer pane's start page and search (computerStart.ts): one copy for the HUD and main, pinned here; main's own
// use is pinned in app/tests/unit/computer-service.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { START_PAGE, searchUrl } from "./computerStart";

test("the start page is DuckDuckGo's", () => {
  assert.equal(START_PAGE, "https://duckduckgo.com/");
});

test("words search the start page: ?q= and the words URL-encoded as a component", () => {
  assert.equal(searchUrl("weather"), "https://duckduckgo.com/?q=weather");
  assert.equal(searchUrl("what is the weather?"), "https://duckduckgo.com/?q=what%20is%20the%20weather%3F");
  assert.equal(searchUrl("a&b=c #1 /x"), "https://duckduckgo.com/?q=a%26b%3Dc%20%231%20%2Fx");
  assert.equal(searchUrl("café ☕"), "https://duckduckgo.com/?q=caf%C3%A9%20%E2%98%95");
});

test("another start page (the e2e suite's fixture) is searched the same way", () => {
  assert.equal(searchUrl("tide times", "http://search.test:4100/"), "http://search.test:4100/?q=tide%20times");
});
