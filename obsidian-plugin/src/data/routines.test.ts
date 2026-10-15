import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import {
  routineFromFile, routineToFile, validateRoutine, parseRoutineFrontmatter, fingerprint, parseState, health, buildRows,
  schedulesOutOfDate, emptyState, Routine, ENGINES, KEY_ORDER, MAX_TURNS_LIMIT, lastSkip,
} from "./routines";

// The runtime's fixtures: both parsers must agree on every one of them.
const FIXTURES = path.resolve(__dirname, "../../../brain/scripts/test/fixtures/routines");
const fixture = (slug: string) => routineFromFile(slug, fs.readFileSync(path.join(FIXTURES, `${slug}.md`), "utf8"));

test("every runtime fixture parses to the same verdict as routines-store.js", () => {
  assert.deepEqual(fixture("monitor").errors, []);
  assert.deepEqual(fixture("morning-brief").errors, []);
  assert.deepEqual(fixture("scan-refresh").errors, []);
  assert.match(fixture("bad-cron").errors[0], /^schedule: hour/);
  assert.match(fixture("bad-kind").errors[0], /^kind must be one of/);
  assert.match(fixture("missing-argv").errors[0], /argv/);
  assert.deepEqual(fixture("local-digest").errors, []);
  assert.deepEqual(fixture("bad-engine").errors, ["engine is for prompt routines only"]);
  const l = fixture("local-digest");
  assert.deepEqual([l.engine, l.model, l.maxTurns, l.output], ["local", "qwen3.5:9b", 12, "notify"]);
  assert.deepEqual(l.writes, ["notes/digests/", "brain/reflections/*.md"]);
  const b = fixture("morning-brief");
  assert.equal(b.kind, "prompt");
  assert.equal(b.budgetUsd, 0.5);
  assert.equal(b.timeoutSec, 600);
  assert.deepEqual(b.tags, ["brief", "two words"]);
  assert.match(b.body, /^Read today's daily note/);
  assert.deepEqual(fixture("scan-refresh").argv, ["node", "brain/scripts/scan-vault.js", "--quiet"]);
  assert.equal(fixture("monitor").guarded, true);
});

test("routineToFile round-trips every valid fixture and is a fixed point", () => {
  for (const slug of ["monitor", "morning-brief", "scan-refresh", "local-digest"]) {
    const r = fixture(slug);
    const { errors, ...rest } = r;
    void errors;
    const text = routineToFile(rest);
    const again = routineFromFile(slug, text);
    const strip = (x: Routine) => { const { errors: e, ...y } = x; void e; return y; };
    assert.deepEqual(strip(again), strip(r), slug);
    assert.equal(routineToFile(strip(again)), text, `${slug} fixed point`);
  }
});

test("serializer quoting matches the runtime byte for byte", () => {
  const text = routineToFile({ slug: "s", schema: 1, name: 'Needs "quotes": yes', kind: "command", schedule: "0 9 * * *", enabled: true,
    argv: ["sh", "-c", 'echo "hi, there"'], tags: ["true", "plain"], body: "" });
  assert.deepEqual(text.split("\n").slice(0, 9), [
    "---", "schema: 1", 'name: "Needs \\"quotes\\": yes"', "kind: command", 'schedule: "0 9 * * *"', "enabled: true",
    'argv: [sh, "-c", "echo \\"hi, there\\""]', 'tags: ["true", plain]', "---",
  ]);
  const back = routineFromFile("s", text);
  assert.deepEqual(back.argv, ["sh", "-c", 'echo "hi, there"']);
  assert.equal(back.name, 'Needs "quotes": yes');
});

test("validateRoutine: kind rules and the slug rule", () => {
  const base = { slug: "ok-slug", schema: 1, name: "x", kind: "prompt", schedule: "0 9 * * *", enabled: true, body: "hi" } as Partial<Routine>;
  assert.deepEqual(validateRoutine(base), []);
  assert.match(validateRoutine({ ...base, body: "" }).join(), /needs a body/);
  assert.match(validateRoutine({ ...base, kind: "command" }).join(), /argv/);
  assert.match(validateRoutine({ ...base, schedule: "0 9 1 * 1" }).join(), /both be restricted/);
  assert.match(validateRoutine({ ...base, slug: "A" }).join(), /slug/);
  assert.match(validateRoutine({ ...base, effort: "max" }).join(), /effort/);
  assert.deepEqual(validateRoutine({ ...base, kind: "duty", body: "", budgetUsd: 0.05, tools: "Read,Glob" }), [], "a duty may carry its own budget and allowlist");
  assert.match(validateRoutine({ ...base, kind: "duty", budgetUsd: -1 }).join(), /budgetUsd/);
  assert.match(validateRoutine({ ...base, kind: "duty", tools: " " }).join(), /tools/);
  assert.deepEqual(validateRoutine({ ...base, kind: "duty", body: "", model: "sonnet", effort: "high" }), [], "a duty may pick its own model and effort");
  assert.match(validateRoutine({ ...base, kind: "duty", effort: "max" }).join(), /effort/);
  assert.match(validateRoutine({ ...base, kind: "duty", model: " " }).join(), /model/);
});

test("parseRoutineFrontmatter: leading blank lines are layout, unterminated block is no block", () => {
  assert.equal(parseRoutineFrontmatter("---\nname: x\n---\n\nbody\n").body, "body\n");
  assert.equal(parseRoutineFrontmatter("---\nname: x\n").hasFrontmatter, false);
});

test("state, fingerprint and health mirror the runtime", () => {
  assert.deepEqual(parseState(null), emptyState());
  assert.deepEqual(parseState("{nope").routines, {});
  const st = parseState(JSON.stringify({ schema: 1, routines: { a: { lastRunAt: "2026-09-20T13:00:00.000Z", lastExit: 0, failStreak: 0 } }, synced: { a: "duty|0 13 * * *|on" }, syncedAt: "x" }));
  assert.equal(st.routines.a.lastExit, 0);
  assert.equal(fingerprint({ kind: "duty", schedule: "0  13 * * *", enabled: true }), "duty|0 13 * * *|on");
  const r: Routine = { slug: "a", kind: "duty", schedule: "0 13 * * *", enabled: true, body: "", errors: [] };
  const now = new Date(2026, 8, 21, 14, 0);
  assert.equal(health({ ...r, enabled: false }, null, now), "off");
  assert.equal(health({ ...r, errors: ["x"] }, null, now), "invalid");
  assert.equal(health(r, null, now, { synced: "duty|0 12 * * *|on" }), "stale");
  assert.equal(health(r, { lastRunAt: null, lastExit: 1, lastCostUsd: null, lastDurationMs: null, failStreak: 1, lastTrigger: null, lastError: "x" }, now), "failed");
  const ranYesterday = { lastRunAt: new Date(2026, 8, 20, 13, 0).toISOString(), lastExit: 0, lastCostUsd: null, lastDurationMs: null, failStreak: 0, lastTrigger: null, lastError: null };
  assert.equal(health(r, ranYesterday, now), "missed");
  assert.equal(health(r, { ...ranYesterday, lastRunAt: new Date(2026, 8, 21, 13, 0).toISOString() }, now), "ok");
  assert.equal(health(r, null, now), "ok");
});

test("buildRows and schedulesOutOfDate", () => {
  const a: Routine = { slug: "a", kind: "duty", schedule: "0 13 * * *", enabled: true, body: "", errors: [] };
  const b: Routine = { slug: "b", kind: "command", schedule: "0 9 * * *", enabled: false, argv: ["true"], body: "", errors: [] };
  const bad: Routine = { slug: "bad", kind: "prompt", schedule: "x", enabled: true, body: "y", errors: ["schedule: x"] };
  const now = new Date(2026, 8, 21, 14, 0);
  const st = { ...emptyState(), synced: { a: "duty|0 13 * * *|on", gone: "command|0 1 * * *|on" }, syncedAt: now.toISOString() };
  const rows = buildRows([a, b, bad], st, now);
  assert.equal(rows[0].cadence, "Every day at 13:00");
  assert.equal(rows[0].next.length, 3);
  assert.equal(rows[0].next[0].getDate(), 22);
  assert.equal(rows[0].health, "ok");
  assert.equal(rows[1].health, "off");
  assert.deepEqual(rows[1].next, []);
  assert.equal(rows[2].health, "invalid");
  assert.equal(rows[2].cadence, "x");
  assert.deepEqual(schedulesOutOfDate([a, b, bad], st), ["gone"], "only the synced slug with no file");
  assert.deepEqual(schedulesOutOfDate([{ ...a, schedule: "0 14 * * *" }, { ...b, enabled: true }], st), ["a", "b", "gone"]);
});

// ── duty log fallback (spec host-routines D1) — mirrors routines-store.js dutyLogLast/mergeDutyLog ──

import { parseDutyLogTail, mergeDutyLog, readDutyLogLast, DUTY_LOG_DIR, RoutineStateEntry } from "./routines";
import * as os from "os";

test("parseDutyLogTail: the last 'done (exit N)' line; a trailing start line or empty tail is null", () => {
  assert.deepEqual(parseDutyLogTail("[stamp] duty=monitor start\n{json}\n[stamp] duty=monitor done (exit 0)\n", "2026-09-21T17:01:00.000Z"), { at: "2026-09-21T17:01:00.000Z", exit: 0 });
  assert.deepEqual(parseDutyLogTail("[stamp] duty=monitor done (exit 3)", "t"), { at: "t", exit: 3 });
  assert.equal(parseDutyLogTail("[stamp] duty=monitor done (exit 0)\n[stamp] duty=monitor model=haiku start\n", "t"), null);
  assert.equal(parseDutyLogTail("", "t"), null);
});

test("mergeDutyLog: same verdicts as the runtime — window keeps the entry, a later log run replaces it", () => {
  const entry: RoutineStateEntry = { lastRunAt: "2026-09-21T19:49:12.000Z", lastExit: 0, lastCostUsd: 0.12, lastDurationMs: 55_000, failStreak: 0, lastTrigger: "manual", lastError: null };
  const duty = { kind: "duty" };
  assert.equal(mergeDutyLog(duty, entry, { at: "2026-09-21T19:50:07.000Z", exit: 0 }), entry);
  assert.deepEqual(mergeDutyLog(duty, entry, { at: "2026-09-21T23:00:00.000Z", exit: 0 }),
    { lastRunAt: "2026-09-21T23:00:00.000Z", lastExit: 0, lastCostUsd: null, lastDurationMs: null, failStreak: 0, lastTrigger: "duty-log", lastError: null });
  assert.equal(mergeDutyLog(duty, { ...entry, lastExit: 1, failStreak: 2 }, { at: "2026-09-21T23:00:00.000Z", exit: 1 })?.failStreak, 3);
  const fresh = mergeDutyLog(duty, null, { at: "2026-09-21T23:00:00.000Z", exit: 1 });
  assert.equal(fresh?.failStreak, 1); assert.match(fresh?.lastError ?? "", /from the duty log/);
  assert.equal(mergeDutyLog(duty, entry, { at: "2026-09-20T13:00:00.000Z", exit: 1 }), entry);
  assert.equal(mergeDutyLog({ kind: "command" }, entry, { at: "2026-09-21T23:00:00.000Z", exit: 1 }), entry);
  assert.equal(mergeDutyLog(duty, null, null), null);
});

test("buildRows with duty logs: a log-only run becomes the last run and clears 'missed'", () => {
  const monitor = routineFromFile("monitor", "---\nschema: 1\nname: Monitor\nkind: duty\nschedule: \"0 13 * * *\"\nenabled: true\n---\n");
  const state = { ...emptyState(), synced: { monitor: "duty|0 13 * * *|on" }, syncedAt: "2026-09-20T20:00:00Z" };
  const now = new Date("2026-09-21T23:00:00Z");
  assert.equal(buildRows([monitor], state, now)[0].health, "missed");
  const row = buildRows([monitor], state, now, { monitor: { at: "2026-09-21T17:01:00.000Z", exit: 0 } })[0];
  assert.equal(row.health, "ok");
  assert.equal(row.last?.lastTrigger, "duty-log");
  assert.equal(buildRows([monitor], state, now, { monitor: { at: "2026-09-21T17:01:00.000Z", exit: 2 } })[0].health, "failed");
});

test("readDutyLogLast: reads the vault log's tail and mtime; absent, empty or an odd slug is null", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aos-dl-"));
  assert.equal(readDutyLogLast(vault, "monitor"), null);
  const dir = path.join(vault, DUTY_LOG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "duty-monitor.log");
  fs.writeFileSync(f, "x".repeat(10_000) + "\n[stamp] duty=monitor done (exit 0)\n");
  const end = new Date("2026-09-21T17:01:00Z"); fs.utimesSync(f, end, end);
  assert.deepEqual(readDutyLogLast(vault, "monitor"), { at: end.toISOString(), exit: 0 });
  fs.writeFileSync(f, "");
  assert.equal(readDutyLogLast(vault, "monitor"), null);
  assert.equal(readDutyLogLast(vault, "../monitor"), null);
});

// local-first A6/A7: the engine fields mirror routines-store.js rule for rule (its ENGINES, KEY_ORDER and messages).
test("engine, maxTurns, writes and output: the runtime's constants and verdicts", () => {
  const REPO = path.resolve(__dirname, "../../..");
  const store = createRequire(__filename)(path.join(REPO, "brain/scripts/lib/routines-store.js")) as {
    ENGINES: string[]; KEY_ORDER: string[]; MAX_TURNS_LIMIT: number; validate(r: unknown): string[];
  };
  assert.deepEqual([...ENGINES], store.ENGINES);
  assert.deepEqual(KEY_ORDER, store.KEY_ORDER);
  assert.equal(MAX_TURNS_LIMIT, store.MAX_TURNS_LIMIT);
  const base = { slug: "ok-slug", schema: 1, name: "x", kind: "prompt", schedule: "0 9 * * *", enabled: true, body: "hi" } as Partial<Routine>;
  const cases: Partial<Routine>[] = [
    { engine: "local" }, { engine: "claude", model: "sonnet" }, { engine: "codex", model: "gpt-6-sol" }, { engine: "ollama" },
    { kind: "duty", engine: "local" }, { kind: "command", argv: ["ls"], engine: "codex" },
    { maxTurns: 24 }, { maxTurns: 0 }, { maxTurns: 1.5 }, { maxTurns: 201 },
    { writes: ["notes/", "notes/**/*.md"] }, { writes: ["/abs/"] }, { writes: ["../x/"] }, { writes: ["a,b"] }, { writes: ["~/x"] },
    { output: "log" }, { output: "notify" }, { output: "notes/out.md" }, { output: "daily" }, { output: "../x.md" }, { output: "notes/x.txt" },
    { kind: "duty", writes: ["notes/inbox/"] },
  ];
  for (const c of cases) assert.deepEqual(validateRoutine({ ...base, ...c }), store.validate({ ...base, ...c }), JSON.stringify(c));
  const text = routineToFile({ slug: "k", schema: 1, name: "K", kind: "prompt", schedule: "0 9 * * *", enabled: true, output: "notify", writes: ["notes/"], maxTurns: 8, model: "qwen3.5:4b", engine: "local", body: "go" });
  assert.equal(text, '---\nschema: 1\nname: K\nkind: prompt\nschedule: "0 9 * * *"\nenabled: true\nengine: local\nmodel: "qwen3.5:4b"\nmaxTurns: 8\nwrites: [notes/]\noutput: notify\n---\n\ngo\n');
});

test("lastSkip: a skip newer than the last run, with its short reason; a run since hides it", () => {
  const e = (over: Partial<RoutineStateEntry>): RoutineStateEntry => ({ lastRunAt: null, lastExit: null, lastCostUsd: null, lastDurationMs: null, failStreak: 0, lastTrigger: null, lastError: null, ...over });
  const down = "local-down: Ollama at http://127.0.0.1:11434 is not answering";
  assert.deepEqual(lastSkip(e({ lastSkippedAt: "2026-10-15T09:00:00.000Z", lastSkipReason: down })), { at: "2026-10-15T09:00:00.000Z", reason: down, short: "local-down" });
  assert.equal(lastSkip(e({ lastSkippedAt: "2026-10-15T09:00:00.000Z", lastSkipReason: "daily cap reached (6.00 of 6 USD)" }))!.short, "daily cap reached");
  assert.equal(lastSkip(e({ lastRunAt: "2026-10-15T10:00:00.000Z", lastSkippedAt: "2026-10-15T09:00:00.000Z", lastSkipReason: down })), null);
  assert.equal(lastSkip(e({})), null);
  assert.equal(lastSkip(null), null);
});
