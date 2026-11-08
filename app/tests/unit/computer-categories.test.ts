import { test } from "node:test";
import assert from "node:assert/strict";
import { categoriesOf, categoryOf, covers } from "../../src/main/computer/categories";

const b = (name: string, inForm = false) => categoryOf({ role: "button", name, inForm, fileInput: false });

test("D43 labels ask, case-insensitive, whole words", () => {
  assert.equal(b("Merge pull request"), "merge");   assert.equal(b("SIGN IN"), "signin");
  assert.equal(b("Place order"), "purchase");       assert.equal(b("Delete branch"), "delete");
  assert.equal(b("Download PDF"), "download");      assert.equal(b("Approve"), "merge");
  assert.equal(b("Allow"), "signin");               assert.equal(b("Archive"), null);
  assert.equal(b("Sender settings"), null);         assert.equal(b("Continue"), null);
  assert.equal(b("Continue", true), "submit");      assert.equal(b("Save", true), "submit");
});

test("punctuation is stripped and multi-word phrases match", () => {
  assert.equal(b("Sign-in!"), "signin");
  assert.equal(b("Squash and merge"), "merge");
  assert.equal(b("Empty Trash"), "delete");
  assert.equal(b("Save to disk", true), "download");
  assert.equal(b("Save", false), null);
});

test("only button-like roles match", () => {
  assert.equal(categoryOf({ role: "heading", name: "Delete", inForm: false, fileInput: false }), null);
  assert.equal(categoryOf({ role: "link", name: "Sign in", inForm: false, fileInput: false }), "signin");
});

test("covers matches whole words only, so a name is never taken to hold a label it has only as letters", () => {
  assert.equal(covers("Deleted messages", "Delete"), false);
  assert.equal(covers("Approved requests", "Approve"), false);
  assert.equal(covers("Delete item", "delete"), true);
  assert.equal(covers("Squash and merge!", "squash and merge"), true);
  assert.equal(covers("Learn more", "Buy now"), false);
  assert.equal(covers("", "Delete"), false);
});

const all = (name: string, inForm = false, role = "button") => categoriesOf({ role, name, inForm, fileInput: false });

test("categoriesOf lists every category a name matches, in vocabulary order, with categoryOf as its first", () => {
  assert.deepEqual(all("Delete and merge"), ["delete", "merge"]);
  assert.deepEqual(all("Merge and download"), ["merge", "download"]);
  assert.deepEqual(all("Sign in and pay"), ["purchase", "signin"]);
  assert.deepEqual(all("Approve"), ["merge"]);
  assert.deepEqual(all("Archive"), []);
  for (const n of ["Delete and merge", "Sign in and pay", "Save to disk", "Continue", "Archive"]) {
    assert.equal(categoryOf({ role: "button", name: n, inForm: true, fileInput: false }), all(n, true)[0] ?? null);
  }
});

test("categoriesOf adds the form-only submit once, and only on button-like roles", () => {
  assert.deepEqual(all("Save and send", true), ["send", "submit"]);
  assert.deepEqual(all("Save and send", false), ["send"]);
  assert.deepEqual(all("Confirm and continue", true), ["submit"]);
  assert.deepEqual(all("Continue", true), ["submit"]);
  assert.deepEqual(all("Delete and merge", false, "heading"), []);
});
