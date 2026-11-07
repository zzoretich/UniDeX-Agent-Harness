import { test } from "node:test";
import assert from "node:assert/strict";
import { navAllowed, siteOf } from "../../src/main/policy/computer-url";

test("navAllowed refuses every non-web scheme", () => {
  for (const u of ["javascript:alert(1)", "data:text/html,x", "blob:https://a.test/1", "file:///etc/hosts", "agenticos://x", "chrome://gpu", "devtools://x", "about:srcdoc", "about:blank?x", "not a url", ""]) {
    assert.equal(navAllowed(u), false, u);
  }
});

test("navAllowed allows http, https and about:blank", () => {
  for (const u of ["http://a.test", "https://a.test/p?q=1#h", "about:blank", "about:blank#frag"]) assert.equal(navAllowed(u), true, u);
});

test("siteOf returns the origin for web URLs and null otherwise", () => {
  assert.equal(siteOf("https://a.test:8443/x?y#z"), "https://a.test:8443");
  assert.equal(siteOf("http://b.test/"), "http://b.test");
  assert.equal(siteOf("about:blank"), null);
  assert.equal(siteOf("junk"), null);
  assert.equal(siteOf("file:///etc/hosts"), null);
});
