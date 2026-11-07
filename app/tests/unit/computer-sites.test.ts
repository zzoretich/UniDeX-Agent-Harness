import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SiteMarks } from "../../src/main/computer/sites";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aos-sites-")), "computer", "sites.json");

test("localhost starts marked, on any port and scheme", () => {
  const s = new SiteMarks(tmp());
  for (const u of ["http://localhost:3000/x", "https://127.0.0.1", "http://[::1]:8080/"]) assert.equal(s.isMarked(u), true, u);
  assert.equal(s.isMarked("https://example.com"), false);
  assert.equal(s.isMarked("not a url"), false);
});

test("a mark survives a new instance and the file is 0600", () => {
  const f = tmp();
  new SiteMarks(f).mark("https://shop.test/some/path");
  assert.deepEqual(new SiteMarks(f).list(), ["https://shop.test"]);
  assert.equal(new SiteMarks(f).isMarked("https://shop.test/other"), true);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["sites.json"]);
  const s = new SiteMarks(f); s.unmark("https://shop.test");
  assert.deepEqual(new SiteMarks(f).list(), []);
});

test("a broken file reads as empty and never throws", () => {
  const f = tmp(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "{nope");
  const s = new SiteMarks(f);
  assert.deepEqual(s.list(), []);
  s.mark("https://a.test");
  assert.deepEqual(new SiteMarks(f).list(), ["https://a.test"]);
});

test("a category allowance is per origin", () => {
  const f = tmp(); const s = new SiteMarks(f);
  s.allowCategory("https://a.test/p", "merge");
  assert.equal(s.categoryAllowed("https://a.test", "merge"), true);
  assert.equal(s.categoryAllowed("https://a.test", "delete"), false);
  assert.equal(s.categoryAllowed("https://b.test", "merge"), false);
  assert.equal(new SiteMarks(f).categoryAllowed("https://a.test", "merge"), true);
});
