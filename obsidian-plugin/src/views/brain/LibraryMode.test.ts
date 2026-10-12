import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { DEFAULT_LIBRARY_FILTER, libraryRows, parseBrainHub, parseMemory, type BrainMemory, type LibraryFilter } from "../../data/brainModel";
import type * as Library from "./LibraryMode";

// LibraryMode.ts and the reader it builds draw with Obsidian's setIcon and MarkdownRenderer, and the obsidian package
// ships types only: under node:test "obsidian" resolves to a stub, so the mode's pure part loads without a DOM.
const STUB = "obsidian-stub";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
class Stub {}
require.cache[STUB] = {
  id: STUB, filename: STUB, loaded: true, exports: { setIcon: () => {}, Component: Stub, Notice: Stub, MarkdownRenderer: { render: async () => {} } },
} as unknown as NodeJS.Module;
const { filterForUse } = require("./LibraryMode") as typeof Library;

const P = (type: string, slug: string): string => `brain/memory/${type}/${slug}.md`;
const mem = (type: string, slug: string, title: string, o: { tags?: string; source?: string; updated?: string } = {}): string =>
  ["---", "type: memory", `tags: [memory/${type}${o.tags ? `, ${o.tags}` : ""}]`, "created: 2026-09-01", `updated: ${o.updated ?? "2026-09-01"}`,
    ...(o.source ? [`source: ${o.source}`] : []), "---", "", `# ${title}`, "", `The body of ${slug}.`, ""].join("\n");

test("filterForUse: Memories, live, the use, Type and Source cleared, the query kept", () => {
  const f: LibraryFilter = { kind: "patterns", query: "tide", type: "feedback", status: "archived", source: "auto-wrap", use: "used" };
  assert.deepEqual(filterForUse(f, "unused"), { kind: "memories", query: "tide", type: null, status: "live", source: null, use: "unused" });
  assert.deepEqual(filterForUse(DEFAULT_LIBRARY_FILTER, "unused"), { ...DEFAULT_LIBRARY_FILTER, use: "unused" });
  assert.deepEqual(filterForUse(f, "any"), { ...DEFAULT_LIBRARY_FILTER, query: "tide" });
  assert.equal(f.use, "used", "the filter it was given is left as it was");
});

test("a use link lands on the live memories no session used in 30 days, whatever the facets were", () => {
  const files: Record<string, string> = {
    [P("feedback", "ask-first")]: mem("feedback", "ask-first", "Ask first", { source: "auto-wrap", updated: "2026-09-20" }),
    [P("reference", "tide-table")]: mem("reference", "tide-table", "Tide table", { updated: "2026-09-10" }),
    [P("projects", "kite-build")]: mem("projects", "kite-build", "Kite build", { updated: "2026-09-15" }),
    [P("projects", "old-kite")]: mem("projects", "old-kite", "Old kite", { tags: "status/archived" }),
  };
  const memories = Object.entries(files).map(([p, t]) => parseMemory(p, t)).filter((m): m is BrainMemory => !!m);
  const data = { memories, drafts: [], patterns: [], reflections: [] };
  const hub = parseBrainHub(JSON.stringify({ schema: 1, usage: { since: "2026-09-01T00:00:00Z", paths: { [P("feedback", "ask-first")]: { d30: 4 } } } }));
  // Narrowed to feedback from auto-wrap, the never-used ones would all be hidden; the link clears those facets.
  const before: LibraryFilter = { ...DEFAULT_LIBRARY_FILTER, type: "feedback", source: "auto-wrap" };
  assert.deepEqual(libraryRows(data, { ...before, use: "unused" }, hub).map((r) => r.title), []);
  const rows = libraryRows(data, filterForUse(before, "unused"), hub);
  assert.deepEqual(rows.map((r) => [r.title, r.useLabel]), [["Kite build", "unused"], ["Tide table", "unused"]]);
  assert.ok(!rows.some((r) => r.path === P("projects", "old-kite")), "an archived memory is not live");
  // The header's search still narrows them.
  assert.deepEqual(libraryRows(data, filterForUse({ ...before, query: "tide" }, "unused"), hub).map((r) => r.title), ["Tide table"]);
});
