import { test } from "node:test";
import assert from "node:assert/strict";
import { agoLabel, sessionsChip, sessionsTitle, shortenCwd, shortAge, recentRows, lastThread, outsideGroups, outsideGitLabel } from "./hostSessions";
import type { WorkspaceSessionRow } from "./snapshot";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");

test("sessionsChip names the hosts that have sessions and the age of the newest", () => {
  assert.equal(sessionsChip({ claude: 12, codex: 3, total: 15, lastAt: "2026-09-19T09:00:00.000Z" }, NOW), "claude 12 · codex 3 · 2d ago");
  assert.equal(sessionsChip({ claude: 0, codex: 1, total: 1, lastAt: "2026-09-21T09:00:00.000Z" }, NOW), "codex 1 · today");
  assert.equal(sessionsChip({ claude: 2, codex: 0, total: 2, lastAt: null }, NOW), "claude 2 · never");
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: null }, NOW), null);
  assert.equal(sessionsChip(undefined, NOW), null);
});

test("the chip reads the window: counts are the last windowDays days, older sessions read 'none in 30d' (spaces-redesign D34)", () => {
  const w = { windowDays: 30, recent: [] };
  assert.equal(sessionsChip({ claude: 1, codex: 2, total: 3, lastAt: "2026-09-20T09:00:00.000Z", ...w }, NOW), "claude 1 · codex 2 · 1d ago");
  // Every session is older than the window: the counts are 0, but the workspace was worked on.
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z", ...w }, NOW), "none in 30d · 45d ago");
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z", windowDays: 14 }, NOW), "none in 14d · 45d ago");
  // Never any session, or a snapshot from before the window (all-time counts): no chip, as before.
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: null, ...w }, NOW), null);
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: "garbage", ...w }, NOW), null);
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z" }, NOW), null);
  assert.equal(sessionsChip({ claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z", windowDays: 0 }, NOW), null);
});

test("sessionsTitle names the window and both hosts; none without a window or a chip (D34)", () => {
  assert.equal(sessionsTitle({ claude: 1, codex: 2, total: 3, lastAt: "2026-09-20T09:00:00.000Z", windowDays: 30 }, NOW),
    "Sessions in the last 30 days, both hosts: Claude Code 1, Codex 2; the newest 1d ago");
  assert.equal(sessionsTitle({ claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z", windowDays: 30 }, NOW),
    "Sessions in the last 30 days, both hosts: Claude Code 0, Codex 0; the newest 45d ago");
  assert.equal(sessionsTitle({ claude: 2, codex: 0, total: 2, lastAt: null, windowDays: 30 }, NOW), "Sessions in the last 30 days, both hosts: Claude Code 2, Codex 0");
  assert.equal(sessionsTitle({ claude: 12, codex: 3, total: 15, lastAt: "2026-09-19T09:00:00.000Z" }, NOW), null, "an all-time snapshot names no window");
  assert.equal(sessionsTitle({ claude: 0, codex: 0, total: 0, lastAt: null, windowDays: 30 }, NOW), null);
  assert.equal(sessionsTitle(null, NOW), null);
});

test("agoLabel and shortenCwd", () => {
  assert.equal(agoLabel("2026-09-20T09:00:00.000Z", NOW), "1d ago");
  assert.equal(agoLabel("garbage", NOW), "never");
  assert.equal(shortenCwd("/home/demo/Documents/x", "/home/demo"), "~/Documents/x");
  assert.equal(shortenCwd("/home/demoted/x", "/home/demo"), "/home/demoted/x", "a shared name prefix is not the home dir");
  assert.equal(shortenCwd("/home/demo", "/home/demo"), "~");
});

test("outsideGroups reads the snapshot's window: rows with sessions keep their chip, older ones read 'none in 30d'", () => {
  const list = [
    { cwd: "/opt/sample/scratchpad", claude: 2, codex: 0, total: 2, lastAt: "2026-09-21T09:00:00.000Z", exists: true, match: null, git: null, worktrees: 0 },
    { cwd: "/home/demo/old", claude: 0, codex: 0, total: 0, lastAt: "2026-08-07T09:00:00.000Z", exists: true, match: null, git: null, worktrees: 0 },
  ];
  assert.deepEqual(outsideGroups(list, NOW, "/home/demo", 30).present.map((r) => r.chip), ["claude 2 · today", "none in 30d · 45d ago"]);
  assert.deepEqual(outsideGroups(list, NOW, "/home/demo", null).present.map((r) => r.chip), ["claude 2 · today", "45d ago"], "no window: today's fallback");
});

test("shortAge: minutes, hours, days, then weeks, months and years", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const M = 60000, H = 60 * M, D = 24 * H;
  assert.equal(shortAge(at(20 * 1000), NOW), "now");
  assert.equal(shortAge(at(40 * M), NOW), "40m");
  assert.equal(shortAge(at(9 * H), NOW), "9h");
  assert.equal(shortAge(at(12 * D), NOW), "12d");
  assert.equal(shortAge(at(42 * D), NOW), "6w");
  assert.equal(shortAge(at(120 * D), NOW), "4mo");
  assert.equal(shortAge(at(800 * D), NOW), "2y");
  assert.equal(shortAge(null, NOW), "");
  assert.equal(shortAge("garbage", NOW), "");
});

const ID1 = "0a1b2c3d-1111-4222-8333-444455556666";
const ID2 = "9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff";
const ID3 = "12345678-1234-4234-8234-123456789abc";
const srow = (id: string, extra: Partial<WorkspaceSessionRow> = {}): WorkspaceSessionRow => ({
  id, host: "claude", format: "claude", kind: "interactive", title: "A thread", titleSource: "ai", startedAt: "2026-09-21T08:00:00.000Z",
  lastAt: "2026-09-21T11:20:00.000Z", cwd: "/home/demo/vault", startExists: true, via: "files", resumable: true, reason: null, ...extra,
});

test("recentRows: newest first, host and kind in the meta, a title fallback, the start folder shortened (spaces-redesign D25)", () => {
  const rows = recentRows({ claude: 2, codex: 1, total: 3, lastAt: null, recent: [
    srow(ID1),
    srow(ID2, { host: "codex", format: "codex", kind: "headless", title: null, lastAt: "2026-09-21T11:50:00.000Z", via: "cwd", resumable: true }),
    srow(ID3, { kind: "team", lastAt: null, startedAt: "2026-09-20T12:00:00.000Z", resumable: false, reason: "A team seat's run" }),
    { id: "", host: "claude" } as unknown as WorkspaceSessionRow,
  ] }, NOW, "/home/demo");
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.meta, r.resumable]), [
    [ID2, "Untitled session", "codex · 10m · headless", true],
    [ID1, "A thread", "claude · 40m", true],
    [ID3, "A thread", "claude · 1d · team seat", false],
  ]);
  assert.equal(rows[1].cwdLabel, "~/vault");
  assert.equal(rows[1].viaText, "Started at the vault root; most of the files it touched are here");
  assert.equal(rows[2].reason, "A team seat's run");
  assert.deepEqual(recentRows(undefined), []);
  assert.deepEqual(recentRows({ claude: 0, codex: 0, total: 0, lastAt: null }), [], "a snapshot before recent rows");
});

test("lastThread: the newest interactive or Sessions row; team and headless runs never (spaces-redesign D6)", () => {
  const recent = [
    srow(ID3, { kind: "team", lastAt: "2026-09-21T11:59:00.000Z" }),
    srow(ID2, { kind: "headless", lastAt: "2026-09-21T11:58:00.000Z" }),
    srow(ID1, { kind: "interactive", lastAt: "2026-09-21T09:00:00.000Z" }),
    srow("aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000", { kind: "app", lastAt: "2026-09-21T10:00:00.000Z" }),
  ];
  assert.equal(lastThread({ claude: 4, codex: 0, total: 4, lastAt: null, recent })?.kind, "app");
  assert.equal(lastThread({ claude: 2, codex: 0, total: 2, lastAt: null, recent: recent.slice(0, 2) }), null);
  assert.equal(lastThread(null), null);
});

test("outsideGroups: existing folders, then the Vanished group; git, worktrees and a matching workspace (spaces-redesign D21)", () => {
  const g = outsideGroups([
    { cwd: "/home/demo/code/site", claude: 2, codex: 0, total: 2, lastAt: "2026-09-21T09:00:00.000Z", exists: true, match: "site", git: { root: "/home/demo/code/site", branch: "main" }, worktrees: 2 },
    { cwd: "/home/demo/old", claude: 0, codex: 1, total: 1, lastAt: "2026-09-01T09:00:00.000Z", exists: false, match: null, git: null, worktrees: 0 },
    { cwd: "/opt/sample/thing", claude: 1, codex: 0, total: 1, lastAt: null },
  ], NOW, "/home/demo", 30);
  assert.deepEqual(g.present.map((r) => [r.label, r.git, r.match, r.exists]), [
    ["~/code/site", "git · main · 2 worktrees", "site", true],
    ["/opt/sample/thing", null, null, true],
  ], "a row from before D21 (no exists) counts as present");
  assert.deepEqual(g.vanished.map((r) => [r.label, r.chip, r.age]), [["~/old", "codex 1 · 20d ago", "2w"]]);
  assert.equal(g.present[0].gitRoot, "~/code/site");
  assert.deepEqual([g.total, g.matched], [3, 1]);
  assert.deepEqual(outsideGroups(null), { present: [], vanished: [], total: 0, matched: 0 });
  assert.equal(outsideGitLabel({ git: { root: "/x", branch: null }, worktrees: 1 }), "git · detached · 1 worktree");
  assert.equal(outsideGitLabel({ git: null }), null);
});
