import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type * as Draft from "./DraftModal";
import type { WorkspaceEntry } from "../../data/snapshot";

// DraftModal.ts draws with Obsidian's Modal; under node:test "obsidian" resolves to a stub, so the dialog's model
// (spaces-redesign D13, D14) loads without a DOM.
const STUB = "obsidian-stub";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
class Stub {}
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { Modal: Stub, FuzzySuggestModal: Stub, Notice: Stub, setIcon: () => {} } } as unknown as NodeJS.Module;
const { DRAFT_STATUS_OPTIONS, asDraft, draftBase, draftChanges, dryRunText, formFromDraft, oneLine, previewBadge, previewLines, providerLabel } = require("./DraftModal") as typeof Draft;

const H = "ab".repeat(32);
const OUT = {
  provider: "ollama", model: "qwen3.5:9b", reason: null, generatedAt: "2026-10-10T12:00:00.000Z", sources: ["README.md", "HANDOFF.md"],
  fields: { summary: "A trip site.", objectives: ["Commit the changes", "Decide"], next: "Commit, then decide." },
  file: "workspaces/trip/workspace.md", baseHash: H,
};

function entry(extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    name: "trip", path: "workspaces/trip", status: "idle", statusSource: "derived", summary: null, summarySource: "derived",
    objectives: [], isCollection: false, subprojects: [], docs: [], next: { text: null, source: "derived" },
    insight: { text: null, status: "unavailable" }, lastEvent: { iso: null, ageDays: null, subject: null }, inputHash: "x", ...extra,
  };
}

test("asDraft takes the verb's answer as the plan prints it and refuses other shapes", () => {
  assert.deepEqual(asDraft(OUT), { ...OUT });
  assert.equal(asDraft({ ...OUT, baseHash: "nope" }), null);
  assert.equal(asDraft({ ...OUT, fields: null }), null);
  assert.equal(asDraft(null), null);
  const loose = asDraft({ ...OUT, model: null, sources: ["a", 3], fields: { summary: 1, objectives: ["x", null], next: null } });
  assert.deepEqual([loose?.model, loose?.sources, loose?.fields], [null, ["a"], { summary: "", objectives: ["x"], next: "" }]);
  assert.equal(asDraft({ ...OUT, baseHash: "none" })?.baseHash, "none");
});

test("the provider label names who answered; the heuristic says no model did, with its reason (D14)", () => {
  assert.deepEqual(providerLabel(OUT), { badge: "AI", text: "Drafted by qwen3.5:9b · Ollama · local", detail: null });
  assert.equal(providerLabel({ provider: "claude", model: "haiku", reason: null }).text, "Drafted by haiku · Claude");
  // The default codex.model is null: the label names the provider alone (docs/app-smoke.md's Codex step).
  assert.equal(providerLabel({ provider: "codex", model: null, reason: null }).text, "Drafted by Codex");
  assert.equal(providerLabel({ provider: "codex", model: null, reason: null }).text, "Drafted by Codex");
  assert.deepEqual(providerLabel({ provider: "heuristic", model: null, reason: "no model provider is set up" }), { badge: "HEURISTIC", text: "A heuristic draft: no model answered", detail: "no model provider is set up" });
});

test("Status starts on auto (not written); the form takes the draft's fields as text", () => {
  assert.deepEqual(DRAFT_STATUS_OPTIONS.map((o) => o.label), ["auto (not written)", "Active", "Paused", "Done"]);
  const f = formFromDraft(asDraft(OUT)!);
  assert.equal(f.status, "auto");
  assert.deepEqual([f.summary, f.objectives, f.next], ["A trip site.", ["Commit the changes", "Decide"], "Commit, then decide."]);
});

test("Save sends only the changed keys: drafted ones that differ from workspace.md, edited ones, a picked status (D13)", () => {
  const base = draftBase(entry());
  const f = formFromDraft(asDraft(OUT)!);
  assert.deepEqual(draftChanges(f, base), { summary: "A trip site.", next: "Commit, then decide.", objectives: ["Commit the changes", "Decide"] });
  // auto writes no status:
  assert.equal("status" in draftChanges(f, base), false);
  // A field the draft left empty is not sent (set would clear it); one the user emptied is.
  const empty = formFromDraft(asDraft({ ...OUT, fields: { summary: "", objectives: [], next: "" } })!);
  assert.deepEqual(draftChanges(empty, draftBase(entry({ summary: "Kept", summarySource: "manifest" }))), {});
  empty.touched.summary = true;
  assert.deepEqual(draftChanges(empty, draftBase(entry({ summary: "Kept", summarySource: "manifest" }))), { summary: "" });
  // Equal to workspace.md: not sent; a picked status that differs: sent.
  const same = draftBase(entry({
    summary: "A trip site.", summarySource: "manifest", next: { text: "Commit, then decide.", source: "manifest" },
    objectives: [{ text: "Commit the changes", source: "manifest" }, { text: "Decide", source: "manifest" }], statusOverride: "paused",
  }));
  assert.deepEqual(draftChanges(f, same), {});
  f.status = "done";
  assert.deepEqual(draftChanges(f, same), { status: "done" });
  f.status = "paused";
  assert.deepEqual(draftChanges(f, same), {});
  // Line breaks and blank objectives are cleaned; a README-derived summary is no baseline.
  f.status = "auto";
  f.summary = "Two\nlines";
  f.objectives = ["  a  ", "", "b"];
  assert.deepEqual(draftChanges(f, draftBase(entry({ summary: "Two lines", summarySource: "derived" }))), { summary: "Two lines", next: "Commit, then decide.", objectives: ["a", "b"] });
});

test("the preview marks the lines the file did not have; dryRunText reads the exact file", () => {
  assert.deepEqual(previewLines("---\nsummary: x\n---\n# T\n", "---\n---\n# T\n"), [
    { text: "---", added: false }, { text: "summary: x", added: true }, { text: "---", added: false }, { text: "# T", added: false },
  ]);
  assert.deepEqual(previewLines("a\nb", null).map((l) => l.added), [true, true]);
  // `set --dry-run --json` as cli/workspace.js prints it: `before` is the old hash, `beforeText` the old file (or null).
  assert.deepEqual(dryRunText({ ok: true, text: "x\n", before: H, beforeText: "y\nz" }), { text: "x\n", before: "y\nz" });
  assert.deepEqual(dryRunText({ ok: true, text: "x\n", before: "none", beforeText: null }), { text: "x\n", before: null });
  assert.deepEqual(dryRunText({ ok: true, text: "x\n", before: H }), { text: "x\n", before: null });
  assert.equal(dryRunText({ ok: true }), null);
});

test("oneLine turns every control character into a space, as the runtime's set would refuse them (tab, U+2028)", () => {
  assert.equal(oneLine("a\tb"), "a b");
  assert.equal(oneLine("first\u2028second\u2029third"), "first second third");
  assert.equal(oneLine(" a\r\n  b \u0007c\u007f "), "a b c");
  const form = { summary: "Tide\ttables", objectives: ["Parse\u2028the table"], next: "Ship\u0000it", status: "auto" as const, touched: { summary: true, objectives: true, next: true } };
  const out = draftChanges(form, { summary: null, objectives: [], next: null, status: null });
  assert.deepEqual(out, { summary: "Tide tables", next: "Ship it", objectives: ["Parse the table"] });
  for (const v of [out.summary, out.next, ...(out.objectives ?? [])]) assert.doesNotMatch(String(v), /[\u0000-\u001f\u007f\u2028\u2029]/);
});

test("previewBadge: NEW FILE without one, CHANGES when Save would write, NO CHANGES when every field matches", () => {
  assert.deepEqual(previewBadge("none", {}), { text: "NEW FILE", tone: "is-ok" });
  assert.deepEqual(previewBadge("ab".repeat(32), { summary: "x" }), { text: "CHANGES", tone: "is-changed" });
  assert.deepEqual(previewBadge("ab".repeat(32), {}), { text: "NO CHANGES", tone: "is-off" });
});
