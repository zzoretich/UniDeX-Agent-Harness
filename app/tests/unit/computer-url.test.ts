import { test } from "node:test";
import assert from "node:assert/strict";
import { linkUrl, navAllowed, siteOf, withoutUserinfo } from "../../src/main/policy/computer-url";

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

test("withoutUserinfo removes a user name and password and leaves everything else alone", () => {
  assert.equal(withoutUserinfo("https://user:pass@example.com/p?q=1#f"), "https://example.com/p?q=1#f");
  assert.equal(withoutUserinfo("https://user@example.com/"), "https://example.com/");
  assert.equal(withoutUserinfo("https://:pass@example.com/"), "https://example.com/");
  assert.equal(withoutUserinfo("https://u:p@[::1]:8080/"), "https://[::1]:8080/");
  assert.equal(withoutUserinfo("https://us%40er:p@example.com/"), "https://example.com/");
  assert.equal(withoutUserinfo("http://a.test/"), "http://a.test/");
  assert.equal(withoutUserinfo("about:blank"), "about:blank");
  assert.equal(withoutUserinfo("not a url"), "not a url");
});

test("linkUrl normalises or refuses", () => {
  assert.equal(linkUrl("http://0.0.0.0:3000/a"), "http://localhost:3000/a");
  assert.equal(linkUrl("HTTP://LOCALHOST"), "http://localhost/");
  assert.equal(linkUrl("http://[::1]:8080/"), "http://[::1]:8080/");
  for (const bad of ["http://user:pass@localhost/", "file:///etc/hosts", "javascript:alert(1)", "about:blank", "x", "https://a.test/" + "a".repeat(8192), 7, null]) assert.equal(linkUrl(bad), null);
});

test("linkUrl turns the unspecified addresses into localhost and leaves lookalikes alone", () => {
  assert.equal(linkUrl("http://[::]:8000/x"), "http://localhost:8000/x");
  assert.equal(linkUrl("http://0.0.0.0:3000/x"), "http://localhost:3000/x");
  assert.equal(linkUrl("http://[::1]:8080/"), "http://[::1]:8080/");
  assert.equal(linkUrl("http://0.0.0.0.evil.test/"), "http://0.0.0.0.evil.test/");
});

test("linkUrl accepts 8,192 characters, refuses 8,193, and refuses a user name alone", () => {
  const base = "https://a.test/";
  assert.notEqual(linkUrl(base + "a".repeat(8192 - base.length)), null);
  assert.equal(linkUrl(base + "a".repeat(8193 - base.length)), null);
  assert.equal(linkUrl("https://user@example.com/"), null);
});
