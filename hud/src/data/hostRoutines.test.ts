import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseHostRoutines, readHostRoutines, hostRows, hostChip, sectionStale, codexRefreshDue, CODEX_REFRESH_GAP_MS, HOST_ROUTINES_PATH } from "./hostRoutines";

const CACHE = {
  schema: 1,
  hosts: {
    claude: { fetchedAt: "2026-09-21T23:00:00.000Z", routines: [
      { id: "trig_1", name: "One shot", cadence: "once at Sat 2026-05-16 09:00", schedule: "2026-05-16T13:00:00Z", enabled: false, status: "ran once", next: null,
        last: { at: "2026-05-16T13:00:06Z", status: "ran once" }, model: "claude-sonnet-4-6", target: null, link: "https://claude.ai/code/routines/trig_1", summary: "Review." },
      { id: "trig_2", name: "Weekly", cadence: "Mondays at 13:00 (UTC)", schedule: "0 13 * * 1", enabled: true, status: "active", next: "2026-09-28T13:00:00Z", last: null, model: null, target: "https://github.com/example/repo", link: null, summary: "" },
    ] },
    codex: { fetchedAt: "2026-09-21T22:50:00.000Z", ok: false, warning: "sqlite3 is not on PATH", routines: [] },
    other: { routines: [{ id: "x" }] },
  },
};

test("parseHostRoutines: sections, tolerant fields, unknown hosts dropped; missing or corrupt is empty", () => {
  const c = parseHostRoutines(JSON.stringify(CACHE));
  assert.deepEqual(Object.keys(c.hosts).sort(), ["claude", "codex"]);
  assert.equal(c.hosts.claude?.ok, true); assert.equal(c.hosts.claude?.warning, null); assert.equal(c.hosts.claude?.routines.length, 2);
  assert.equal(c.hosts.codex?.ok, false); assert.equal(c.hosts.codex?.warning, "sqlite3 is not on PATH");
  const [once, weekly] = c.hosts.claude!.routines;
  assert.equal(once.enabled, false); assert.deepEqual(once.last, { at: "2026-05-16T13:00:06Z", status: "ran once" }); assert.equal(once.link, "https://claude.ai/code/routines/trig_1");
  assert.equal(weekly.enabled, true); assert.equal(weekly.last, null); assert.equal(weekly.model, null); assert.equal(weekly.summary, "");
  assert.deepEqual(parseHostRoutines(null), { hosts: {} });
  assert.deepEqual(parseHostRoutines("{nope"), { hosts: {} });
  assert.deepEqual(parseHostRoutines(JSON.stringify({ schema: 1 })), { hosts: {} });
  assert.deepEqual(parseHostRoutines(JSON.stringify({ hosts: { claude: { fetchedAt: "x" } } })), { hosts: {} });
  // A routine without an id is skipped; one with only an id gets safe defaults.
  const min = parseHostRoutines(JSON.stringify({ hosts: { codex: { routines: [{ name: "no id" }, { id: "a" }] } } }));
  assert.equal(min.hosts.codex?.routines.length, 1);
  assert.deepEqual(min.hosts.codex?.routines[0], { id: "a", name: "a", cadence: "", schedule: "", enabled: false, status: null, next: null, last: null, model: null, target: null, link: null, summary: "" });
  assert.equal(min.hosts.codex?.fetchedAt, null);
});

test("readHostRoutines: the vault file, or empty when absent", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-hr-"));
  assert.deepEqual(readHostRoutines(vault), { hosts: {} });
  fs.mkdirSync(path.dirname(path.join(vault, HOST_ROUTINES_PATH)), { recursive: true });
  fs.writeFileSync(path.join(vault, HOST_ROUTINES_PATH), JSON.stringify(CACHE));
  assert.equal(readHostRoutines(vault).hosts.claude?.routines.length, 2);
});

test("hostRows: codex first then claude, each row tagged with its host and fetchedAt", () => {
  const rows = hostRows(parseHostRoutines(JSON.stringify(CACHE)));
  assert.deepEqual(rows.map((r) => [r.host, r.id]), [["claude", "trig_1"], ["claude", "trig_2"]]);
  assert.equal(rows[0].fetchedAt, "2026-09-21T23:00:00.000Z");
  const both = parseHostRoutines(JSON.stringify({ hosts: { claude: { routines: [{ id: "c" }] }, codex: { routines: [{ id: "x" }] } } }));
  assert.deepEqual(hostRows(both).map((r) => r.host), ["codex", "claude"]);
});

test("hostChip: ran once → neutral, failed last run → failed, paused → off, else ok", () => {
  const base = { id: "a", name: "a", cadence: "", schedule: "", enabled: true, status: "active", next: null, last: null, model: null, target: null, link: null, summary: "" };
  assert.deepEqual(hostChip({ ...base, enabled: false, status: "ran once" }), { cls: "is-neutral", text: "ran once" });
  assert.deepEqual(hostChip({ ...base, last: { at: "x", status: "failed" } }), { cls: "is-failed", text: "failed" });
  assert.deepEqual(hostChip({ ...base, enabled: false, status: "paused" }), { cls: "is-off", text: "paused" });
  assert.deepEqual(hostChip({ ...base, enabled: false, status: null }), { cls: "is-off", text: "paused" });
  assert.deepEqual(hostChip({ ...base, last: { at: "x", status: "completed" } }), { cls: "is-ok", text: "active" });
});

test("sectionStale: absent, no fetchedAt, unparsable, or older than the window", () => {
  const now = Date.parse("2026-09-21T23:00:00Z");
  assert.equal(sectionStale(undefined, now), true);
  assert.equal(sectionStale({ fetchedAt: null, ok: true, warning: null, routines: [] }, now), true);
  assert.equal(sectionStale({ fetchedAt: "nope", ok: true, warning: null, routines: [] }, now), true);
  assert.equal(sectionStale({ fetchedAt: "2026-09-21T22:49:00Z", ok: true, warning: null, routines: [] }, now), true);
  assert.equal(sectionStale({ fetchedAt: "2026-09-21T22:51:00Z", ok: true, warning: null, routines: [] }, now), false);
});

test("codexRefreshDue: only where Codex is a host, when its section is stale, at most once a minute", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const fresh = { fetchedAt: new Date(now - 30_000).toISOString(), ok: true, warning: null, routines: [] };
  // A Claude-only machine never gets a Codex section: no refresh, however long it has been.
  assert.equal(codexRefreshDue(["claude"], undefined, 0, now), false);
  assert.equal(codexRefreshDue([], undefined, 0, now), false);
  assert.equal(codexRefreshDue(["claude", "codex"], undefined, 0, now), true);
  assert.equal(codexRefreshDue(["codex"], undefined, now - CODEX_REFRESH_GAP_MS - 1, now), true);
  assert.equal(codexRefreshDue(["codex"], undefined, now - 10_000, now), false, "asked less than a minute ago");
  assert.equal(codexRefreshDue(["codex"], fresh, 0, now), false, "a fresh section");
});
