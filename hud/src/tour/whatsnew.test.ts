import { test } from "node:test";
import assert from "node:assert/strict";
import { WHATS_NEW, cmpVersion, launchWhatsNew, selectWhatsNew, validateWhatsNew, whatsNewHistory, type WhatsNewRelease } from "./whatsnew";
import { BOOK, allRefs } from "./steps";

const rel = (version: string, n = 1): WhatsNewRelease => ({
  version, entries: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, title: `T${i}`, body: `B${i}`, steps: [] })),
});
const LIST = [rel("1.9.0"), rel("2.0.0", 2), rel("2.0.1"), rel("2.1.0"), rel("2.2.0"), rel("2.0.2", 0)];
const versions = (r: WhatsNewRelease[]) => r.map((x) => x.version);

test("versions compare by major, minor, patch", () => {
  assert.equal(cmpVersion("2.0.0", "1.9.9"), 1);
  assert.equal(cmpVersion("2.0.10", "2.0.9"), 1);
  assert.equal(cmpVersion("2.0.0", "2.0.0"), 0);
  assert.equal(cmpVersion("1.10.0", "1.9.0"), 1);
  assert.equal(cmpVersion("2.0.0-beta.1", "2.0.0"), 0);
  assert.equal(cmpVersion("junk", "1.0.0"), -1);
});

test("an update shows every release after the last one seen, up to the one running, newest first (tour C10)", () => {
  assert.deepEqual(versions(selectWhatsNew(LIST, "2.0.0", "2.1.0")), ["2.1.0", "2.0.1"]);
  assert.deepEqual(versions(selectWhatsNew(LIST, "1.9.0", "2.2.0")), ["2.2.0", "2.1.0", "2.0.1", "2.0.0"]);
  assert.deepEqual(selectWhatsNew(LIST, "2.2.0", "2.2.0"), [], "nothing new on the same version");
  assert.deepEqual(versions(selectWhatsNew(LIST, "2.0.1", "2.0.2")), [], "a release with no entries shows nothing");
});

test("with no last-seen version it is What's new in the running release's x.y line", () => {
  assert.deepEqual(versions(selectWhatsNew(LIST, null, "2.0.1")), ["2.0.1", "2.0.0"]);
  assert.deepEqual(versions(selectWhatsNew(LIST, null, "2.1.0")), ["2.1.0"]);
});

test("Help ▸ What's new keeps the history up to the running release", () => {
  assert.deepEqual(versions(whatsNewHistory(LIST, "2.1.0")), ["2.1.0", "2.0.1", "2.0.0", "1.9.0"]);
});

test("the shipped whatsnew.json is valid and has 2.0.0's entries, each with a Show me (tour C2)", () => {
  assert.deepEqual(validateWhatsNew(WHATS_NEW, allRefs(BOOK)), []);
  assert.equal(WHATS_NEW.schema, 1);
  const two = WHATS_NEW.releases.find((r) => r.version === "2.0.0");
  assert.deepEqual(two?.entries.map((e) => e.id), ["local-background", "chief-models", "routine-engines", "imported-history", "sessions-history", "guided-tour"]);
  for (const e of two!.entries) assert.ok(e.steps.length > 0, e.id);
});

test("the launch card: an install from before the tour always gets it, with the full tour; later, only what is new (C10)", () => {
  const shipped = WHATS_NEW.releases;
  const first = launchWhatsNew(shipped, null, "2.0.0");
  assert.deepEqual([first?.line, first?.firstTime, versions(first?.releases ?? [])], ["2.0", true, ["2.0.0"]]);
  assert.equal(launchWhatsNew(shipped, "2.0.0", "2.0.0"), null, "seen: no card");
  assert.deepEqual(versions(launchWhatsNew(LIST, "2.0.0", "2.1.0")?.releases ?? []), ["2.1.0", "2.0.1"]);
  assert.equal(launchWhatsNew(LIST, "2.0.1", "2.0.2"), null, "a release with no entries: no card");
  // A running release whose line has no entries (an unreleased build) still offers the tour to an install that never saw it.
  assert.deepEqual(launchWhatsNew(shipped, null, "1.9.0"), { line: "1.9", releases: [], firstTime: true });
});

test("a bad whatsnew.json is caught: version, duplicate, missing text, unknown step", () => {
  const refs = allRefs(BOOK);
  const bad = {
    schema: 1,
    releases: [
      { version: "2.0.0", entries: [{ id: "a", title: "A", body: "B", steps: ["core.rail", "nope.step"] }, { id: "a", title: "", body: "B", steps: [] }] },
      { version: "2.0.0", entries: [] },
      { version: "v2", entries: [] },
    ],
  };
  const problems = validateWhatsNew(bad, refs);
  assert.ok(problems.some((p) => p.includes("unknown step nope.step")));
  assert.ok(problems.some((p) => p.includes("id is listed twice")));
  assert.ok(problems.some((p) => p.includes("no title")));
  assert.ok(problems.some((p) => p.includes("2.0.0 is listed twice")));
  assert.ok(problems.some((p) => p.includes("no x.y.z version")));
  assert.ok(!problems.some((p) => p.includes("core.rail")), "a real step ref passes");
});
