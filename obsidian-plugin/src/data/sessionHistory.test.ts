import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_PAGE, dayLabel, filterHistory, groupByDay, hasHistory, historyCount, historyRows, localDayTime, parseDigests, parseSessionIndex, resumeFor,
  type IndexedSession,
} from "./sessionHistory";
import type { PlaceWorld, TermHostChoice } from "./terminalLaunch";

const HOME = "/h/someone";
const VAULT = "/vaults/demo";
const WORLD: PlaceWorld = { vault: VAULT, home: HOME, workspaces: ["harbor", "reef"], links: { reef: `${HOME}/code/reef` } };
const CL = "c1a0de00-0000-4000-8000-000000000001";
const CX = "0199a1b2-0000-4000-8000-000000000001";
const choice = (host: "claude" | "codex", o: Partial<TermHostChoice> = {}): TermHostChoice => ({ host, label: host === "claude" ? "Claude Code" : "Codex", hidden: false, ready: true, reason: null, bin: null, ...o });
const BOTH = [choice("claude"), choice("codex")];

/** session-index.json as collectors/hostSessions.js writes it: rows keyed by the transcript's absolute path. */
const INDEX = JSON.stringify({
  schema: 1,
  files: {
    [`${HOME}/claude-config/projects/-vaults-demo-workspaces-harbor/${CL}.jsonl`]: { host: "claude", format: "claude", size: 900, lastAt: "2026-10-14T10:30:00.000Z", title: "Tide parser", titleSource: "ai", head: { id: CL, startCwd: `${VAULT}/workspaces/harbor`, startedAt: "2026-10-14T10:00:00.000Z", kind: "interactive", firstPrompt: "Parse the tides" } },
    // Claude Code's small stub file for the same session: one row, the newest file's facts.
    [`${HOME}/claude-config/projects/-vaults-demo/${CL}.jsonl`]: { host: "claude", format: "claude", size: 40, lastAt: "2026-10-14T09:00:00.000Z", title: null, head: { id: CL, startCwd: VAULT, startedAt: "2026-10-14T09:59:00.000Z", kind: "interactive" } },
    [`${HOME}/.codex/sessions/2026/10/13/rollout-2026-10-13T08-00-00-${CX}.jsonl`]: { host: "codex", format: "codex", size: 500, lastAt: "2026-10-13T08:20:00.000Z", title: "Chart tiles", head: { id: CX, startCwd: `${HOME}/code/reef/src`, startedAt: "2026-10-13T08:00:00.000Z", kind: "interactive" } },
    [`${HOME}/.codex/archived_sessions/rollout-x-0199a1b2-0000-4000-8000-000000000009.jsonl`]: { host: "codex", lastAt: "2026-09-01T08:00:00.000Z", title: "Old spike", head: { id: "0199a1b2-0000-4000-8000-000000000009", startCwd: "/opt/sample/spike", startedAt: "2026-09-01T07:00:00.000Z", kind: "interactive" } },
    // Not History: a headless run, a Codex subagent, a row without a head or an id, an unknown host.
    [`${HOME}/claude-config/projects/x/aaaaaaaa-0000-4000-8000-000000000001.jsonl`]: { host: "claude", head: { id: "aaaaaaaa-0000-4000-8000-000000000001", kind: "headless" } },
    [`${HOME}/.codex/sessions/2026/10/13/rollout-y-0199a1b2-0000-4000-8000-000000000006.jsonl`]: { host: "codex", head: { id: "0199a1b2-0000-4000-8000-000000000006", kind: "subagent" } },
    "/elsewhere/no-head.jsonl": { host: "claude" },
    "/elsewhere/no-id.jsonl": { host: "claude", head: { kind: "interactive" } },
    "/elsewhere/other.jsonl": { host: "cursor", head: { id: "x", kind: "interactive" } },
  },
});
const DIGESTS = JSON.stringify({
  schema: 1,
  sessions: [
    { key: `codex:${CX}`, id: CX, host: "codex", workspace: "reef", title: "Tile cache sizes", summary: "Sized the chart tile cache\nand wrote its test.", day: "2026-10-13" },
    { key: "claude:junk", id: null, host: "claude", summary: "no id" },
  ],
});

test("the index's interactive sessions, one row per session id per host", () => {
  const s = parseSessionIndex(INDEX);
  assert.deepEqual(s.map((x) => `${x.host}:${x.id}`).sort(), [`claude:${CL}`, `codex:${CX}`, "codex:0199a1b2-0000-4000-8000-000000000009"].sort());
  const cl = s.find((x) => x.id === CL)!;
  assert.deepEqual([cl.title, cl.cwd, cl.startedAt, cl.lastAt, cl.fileMatches], ["Tide parser", `${VAULT}/workspaces/harbor`, "2026-10-14T09:59:00.000Z", "2026-10-14T10:30:00.000Z", true]);
  assert.equal(s.find((x) => x.id.endsWith("09"))!.archived, true);
  for (const bad of [null, "", "not json", "[]", '{"files":[]}', '{"schema":1}']) assert.deepEqual(parseSessionIndex(bad), [], String(bad));
  assert.equal(hasHistory(INDEX), true);
  assert.equal(hasHistory('{"schema":1,"files":{}}'), false);
  assert.equal(hasHistory(null), false);
});

test("digests by host and id, one line each; rows without an id or a summary are skipped", () => {
  const d = parseDigests(DIGESTS);
  assert.deepEqual([...d.keys()], [`codex:${CX}`]);
  assert.deepEqual(d.get(`codex:${CX}`), { summary: "Sized the chart tile cache and wrote its test.", workspace: "reef", title: "Tile cache sizes" });
  assert.equal(parseDigests("nope").size, 0);
});

test("rows newest first, with the digest's line, the workspace (the digest's, else the start folder's) and where", () => {
  const rows = historyRows(parseSessionIndex(INDEX), parseDigests(DIGESTS), BOTH, WORLD);
  assert.deepEqual(rows.map((r) => [r.host, r.title, r.workspace, r.where, r.summary]), [
    ["claude", "Tide parser", "harbor", "harbor", null],
    // The digest's title wins: the scan saw the Codex thread's own name, which the index's row does not keep.
    ["codex", "Tile cache sizes", "reef", "reef", "Sized the chart tile cache and wrote its test."],
    ["codex", "Old spike", null, "/opt/sample/spike", null],
  ]);
  assert.equal(rows[0].day, localDayTime("2026-10-14T09:59:00.000Z").day);
  assert.equal(historyCount(rows), "3 past sessions · Claude Code 1 · Codex 2 · 1 summarised");
  assert.equal(historyCount([]), "No past sessions on this Mac yet");
  assert.ok(HISTORY_PAGE >= 50);
});

test("Resume: in the workspace (its code folder when linked), else where it started; a host that is off gets no button", () => {
  const rows = historyRows(parseSessionIndex(INDEX), parseDigests(DIGESTS), BOTH, WORLD);
  const [cl, cx, old] = rows;
  assert.deepEqual(cl.resume, { state: "on", place: { kind: "workspace", label: "harbor", dir: `${VAULT}/workspaces/harbor`, workspace: "harbor" }, hint: "Resumes in workspaces/harbor" });
  assert.equal(cx.resume.state, "on");
  assert.equal(cx.resume.state === "on" && cx.resume.hint, "Resumes in ~/code/reef, its code folder");
  assert.deepEqual(old.resume, { state: "off", reason: "Archived in Codex" });
  // Codex off on this Mac: its rows stay, without Resume; Claude Code not signed in: off with its reason.
  const codexOff = historyRows(parseSessionIndex(INDEX), new Map(), [choice("claude", { ready: false, reason: "Claude Code is not logged in: run claude auth login" }), choice("codex", { hidden: true })], WORLD);
  assert.deepEqual(codexOff.map((r) => r.resume.state), ["off", "none", "none"]);
  assert.deepEqual(codexOff[0].resume, { state: "off", reason: "Claude Code is not logged in: run claude auth login" });
  // No host at all: every row shows, none resumes.
  assert.deepEqual(historyRows(parseSessionIndex(INDEX), new Map(), [], WORLD).map((r) => r.resume.state), ["none", "none", "none"]);
});

test("Resume is off for an id that is not the file's, and an outside folder resumes where it started", () => {
  const base: IndexedSession = { host: "claude", id: CL, fileMatches: true, archived: false, title: null, cwd: `${HOME}/sketches`, startedAt: null, lastAt: null };
  const r = resumeFor(base, null, BOTH, WORLD);
  assert.deepEqual(r, { state: "on", place: { kind: "other", label: "sketches", dir: `${HOME}/sketches` }, hint: "Resumes in ~/sketches, where it started" });
  assert.equal(resumeFor({ ...base, cwd: null }, null, BOTH, WORLD).state === "on" && (resumeFor({ ...base, cwd: null }, null, BOTH, WORLD) as { hint: string }).hint, "Resumes in the vault");
  assert.deepEqual(resumeFor({ ...base, fileMatches: false }, null, BOTH, WORLD), { state: "off", reason: "Its session id is not the one in its file name, so it cannot be resumed by id" });
  assert.equal(resumeFor({ ...base, id: "C1A0DE00-0000-4000-8000-000000000001" }, null, BOTH, WORLD).state, "off", "an uppercase id is not resumed");
  // A digest naming a workspace that is gone falls back to the folder.
  assert.equal(resumeFor(base, "gone", BOTH, WORLD).state === "on", true);
});

test("the filter needs every word; days group in order; day headings", () => {
  const rows = historyRows(parseSessionIndex(INDEX), parseDigests(DIGESTS), BOTH, WORLD);
  assert.deepEqual(filterHistory(rows, "tile cache").map((r) => r.title), ["Tile cache sizes"]);
  assert.deepEqual(filterHistory(rows, "codex spike").map((r) => r.title), ["Old spike"]);
  assert.deepEqual(filterHistory(rows, "  ").length, 3);
  assert.deepEqual(groupByDay(rows).map((g) => g.rows.length), [1, 1, 1]);
  const now = new Date(2026, 9, 15, 12, 0);
  assert.equal(dayLabel("2026-10-15", now), "Today");
  assert.equal(dayLabel("2026-10-14", now), "Yesterday");
  assert.equal(dayLabel("2026-10-12", now), "Mon 12 Oct");
  assert.equal(dayLabel("2025-12-31", now), "Wed 31 Dec 2025");
  assert.equal(dayLabel("", now), "Undated");
  assert.deepEqual(localDayTime(null), { day: "", time: "" });
});
