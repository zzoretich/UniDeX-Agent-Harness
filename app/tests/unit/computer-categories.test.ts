import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryOf } from "../../src/main/computer/categories";

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
