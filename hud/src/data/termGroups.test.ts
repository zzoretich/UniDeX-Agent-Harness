import { test } from "node:test";
import assert from "node:assert/strict";
import { rowEnd, stepRow, groupKey, groupSidebar, ageText, sidebarOrder, rowInput, type TermRowInput } from "./termGroups";
import { ClosedRecord } from "./closedRecord";
import type { HistoryRow } from "./sessionHistory";
import type { Place } from "./terminalLaunch";

const ws = (n: string): Place => ({ kind: n === "scratch" ? "scratch" : "workspace", label: n === "scratch" ? "Scratch" : n, dir: `/v/workspaces/${n}`, workspace: n });
const vault: Place = { kind: "vault", label: "Vault", dir: "/v" };
const other: Place = { kind: "other", label: "app", dir: "/code/app" };
const row = (id: string, place: Place, startedAt: number, extra: Partial<TermRowInput> = {}) =>
  ({ id, host: "claude" as const, title: `t${id}`, place, origin: null, startedAt, exited: false, exitCode: null, ...extra });

test("a linked code folder groups with its workspace", () => {
  const linked: Place = { kind: "workspace", label: "notes", dir: "/code/app", workspace: "notes", linked: true };
  assert.equal(groupKey(linked), groupKey(ws("notes")));
});

test("end states: running, Done on exit 0, Exited n otherwise", () => {
  assert.deepEqual(rowEnd({ exited: false, exitCode: null }), { end: "running", endText: null });
  assert.deepEqual(rowEnd({ exited: true, exitCode: 0 }), { end: "done", endText: "Done" });
  assert.deepEqual(rowEnd({ exited: true, exitCode: 127 }), { end: "failed", endText: "Exited 127" });
});

test("stepRow walks the list order and wraps", () => {
  const g = ["1", "2", "3"];
  assert.equal(stepRow(g, "1", 1), "2");
  assert.equal(stepRow(g, "3", 1), "1");
  assert.equal(stepRow(g, "1", -1), "3");
  assert.equal(stepRow(g, null, 1), "1");
  assert.equal(stepRow([], null, 1), null);
});

// ── groupSidebar (spec 2026-11-09-code-chat C6) ──

const NOW = Date.parse("2026-11-09T12:00:00Z");
const DAY = 86_400_000;
const hist = (id: string, place: Place, ago: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({
  key: `claude:${id}`, id, host: "claude", hostLabel: "Claude Code", title: `h${id}`, summary: null, workspace: place.workspace ?? null, where: place.label,
  at: new Date(NOW - ago).toISOString(), lastAt: null, day: "", time: "", resume: { state: "on", place, hint: "" }, place, ...extra,
});
const sb = (open: ReturnType<typeof row>[], history: HistoryRow[], o: Partial<Parameters<typeof groupSidebar>[2]> = {}) =>
  groupSidebar(open, history, { now: NOW, filter: "", closed: [], ...o });
const ids = (g: ReturnType<typeof groupSidebar>[number]) => g.rows.map((r) => (r.kind === "open" ? r.row.id : r.history.id));

test("sidebar: groups are ordered by their newest activity, open or past", () => {
  const g = sb([row("1", ws("kite"), NOW - 5 * DAY)], [hist("a", ws("reef"), DAY), hist("b", ws("kite"), 3 * DAY)]);
  assert.deepEqual(g.map((x) => x.label), ["reef", "kite"]);
  assert.equal(g[0].place?.workspace, "reef");
});

test("sidebar: a group shows with an open row or a past conversation within 14 days; older past rows are left to All history", () => {
  const g = sb([row("1", ws("kite"), NOW - 40 * DAY)], [hist("old", ws("reef"), 15 * DAY), hist("old2", ws("kite"), 20 * DAY), hist("new", ws("kite"), 13 * DAY)]);
  assert.deepEqual(g.map((x) => x.key), ["ws:kite"]);
  assert.deepEqual(ids(g[0]), ["1", "new"], "open rows first, then past by recency; the 20-day row is out");
  assert.equal(sb([], [hist("old", ws("reef"), 15 * DAY)]).length, 0);
  assert.equal(sb([], [hist("old", ws("reef"), 15 * DAY)], { windowDays: 30 }).length, 1);
});

test("sidebar: the vault, home and other folders share Other folders (place null), and it sorts like any group", () => {
  const home: Place = { kind: "home", label: "Home", dir: "/h" };
  const g = sb([row("1", vault, NOW - 1000), row("2", home, NOW - 2000), row("3", other, NOW - 3000)], [hist("a", ws("kite"), 10 * 60_000)]);
  assert.deepEqual(g.map((x) => x.label), ["Other folders", "kite"]);
  assert.equal(g[0].key, "other");
  assert.equal(g[0].place, null);
  assert.deepEqual(ids(g[0]), ["1", "2", "3"]);
});

test("sidebar: past rows are cut at perGroup with the rest counted in more; extra raises a group's limit", () => {
  const hs = Array.from({ length: 25 }, (_, i) => hist(`h${i}`, ws("kite"), (i + 1) * 60_000));
  const g = sb([], hs);
  assert.equal(g[0].rows.length, 10);
  assert.equal(g[0].more, 15);
  assert.deepEqual(ids(g[0]).slice(0, 2), ["h0", "h1"]);
  const g2 = sb([], hs, { extra: { "ws:kite": 10 } });
  assert.equal(g2[0].rows.length, 20);
  assert.equal(g2[0].more, 5);
  assert.equal(sb([], hs, { perGroup: 3 })[0].more, 22);
  const withOpen = sb([row("o", ws("kite"), NOW)], hs);
  assert.equal(withOpen[0].rows.length, 11, "an open row never counts against the cut");
});

test("sidebar: a conversation closed in this app stays until the index has its id; an open terminal's conversation is not listed twice", () => {
  const closed = { ...row("c", ws("kite"), NOW - 60_000, { exited: true, exitCode: 0 }), sessionId: "SID-1" };
  const kept = sb([], [], { closed: [closed] });
  assert.deepEqual(ids(kept[0]), ["c"]);
  const k = kept[0].rows[0];
  assert.equal(k.kind === "open" && k.closed, true);
  const once = sb([], [hist("sid-1", ws("kite"), 30_000)], { closed: [closed] });
  assert.deepEqual(ids(once[0]), ["sid-1"], "the index has it (ids fold case): only the past row");
  const live = { ...row("o", ws("kite"), NOW - 1000), sessionId: "sid-2" };
  assert.deepEqual(ids(sb([live], [hist("sid-2", ws("kite"), 5000)])[0]), ["o"]);
  const resumed = { ...row("r", ws("kite"), NOW - 500), sessionId: "SID-1" };
  assert.deepEqual(ids(sb([resumed], [], { closed: [closed] })[0]), ["r"], "a closed conversation resumed in a terminal shows as that terminal");
  const codexRow = { ...row("o2", ws("kite"), NOW - 1000, { host: "codex" as const }), sessionId: "sid-3" };
  assert.deepEqual(ids(sb([codexRow], [hist("sid-3", ws("kite"), 5000)])[0]), ["o2", "sid-3"], "another host's id is another conversation");
});

test("sidebar: the filter matches the title and the host, in open, closed and past rows", () => {
  const open = [row("1", ws("kite"), NOW, { title: "Fix the race" }), row("2", ws("kite"), NOW - 1, { title: "Docs", host: "codex" })];
  const hs = [hist("a", ws("kite"), 1000, { title: "Race in tests" }), hist("b", ws("reef"), 1000, { title: "Other", host: "codex", hostLabel: "Codex" })];
  assert.deepEqual(sb(open, hs, { filter: "race" }).flatMap(ids), ["1", "a"]);
  assert.deepEqual(sb(open, hs, { filter: " CODEX " }).flatMap(ids), ["2", "b"]);
  assert.deepEqual(sb(open, hs, { filter: "claude" }).flatMap(ids), ["1", "a"]);
  assert.equal(sb(open, hs, { filter: "zzz" }).length, 0);
});

test("sidebar: a past conversation counts by its last activity, not its start: started weeks ago, resumed today, it stays (I5)", () => {
  // Started 20 days ago, last moved an hour ago: inside the window, and newer than one started and last moved 2 days ago.
  const resumed = hist("old-start", ws("kite"), 20 * DAY, { lastAt: new Date(NOW - 3_600_000).toISOString() });
  const recent = hist("recent", ws("kite"), 2 * DAY, { lastAt: new Date(NOW - 2 * DAY).toISOString() });
  const reef = hist("reef", ws("reef"), 3 * 3_600_000, { lastAt: new Date(NOW - 3 * 3_600_000).toISOString() });
  const g = sb([], [recent, reef, resumed]);
  assert.deepEqual(g.map((x) => x.key), ["ws:kite", "ws:reef"], "the group ordered by its newest activity");
  assert.deepEqual(ids(g[0]), ["old-start", "recent"], "rows newest activity first");
  // With no lastAt the start still counts.
  assert.equal(sb([], [hist("plain", ws("kite"), 20 * DAY)]).length, 0);
});

test("sidebar: the filter also matches the place and where a row came from, in open, closed and past rows (I6)", () => {
  const open = [row("1", ws("harbor-map"), NOW, { title: "Fix the race" }), row("2", vault, NOW - 1, { title: "Docs", origin: "Skills" })];
  const closed = [{ ...row("c", ws("harbor-map"), NOW - 5, { exited: true, exitCode: 0, title: "Closed one" }), sessionId: "s-c" }];
  const hs = [hist("a", ws("harbor-map"), 1000, { title: "Race in tests" }), hist("b", ws("reef"), 1000, { title: "Other", where: "~/code/reef-app" })];
  assert.deepEqual(sb(open, hs, { filter: "harbor", closed }).flatMap(ids), ["1", "c", "a"], "a workspace's name finds its terminals and past rows");
  assert.deepEqual(sb(open, hs, { filter: "skills", closed }).flatMap(ids), ["2"], "what started it");
  assert.deepEqual(sb(open, hs, { filter: "vault", closed }).flatMap(ids), ["2"], "the vault's place");
  assert.deepEqual(sb(open, hs, { filter: "reef-app", closed }).flatMap(ids), ["b"], "where a past one ran");
});

test("sidebar: an open row's status comes from rowStatus; the order and age text for stepping and rows", () => {
  const g = sb([row("1", ws("kite"), NOW, { turnOpen: true }), row("2", ws("kite"), NOW - 1, { needsYou: true }), row("3", ws("kite"), NOW - 2, { exited: true, exitCode: 2 })], []);
  assert.deepEqual(g[0].rows.map((r) => (r.kind === "open" ? r.status.text : "")), ["Working", "Needs you", "Exited 2"]);
  assert.deepEqual(sidebarOrder(g), ["1", "2", "3"]);
  assert.equal(ageText(NOW, NOW - 20_000), "now");
  assert.equal(ageText(NOW, NOW - 5 * 60_000), "5m");
  assert.equal(ageText(NOW, NOW - 3 * 3_600_000), "3h");
  assert.equal(ageText(NOW, NOW - 2 * DAY), "2d");
  assert.equal(ageText(NOW, NOW + 1000), "now");
});

// ── a terminal's row from what the pool and its chat know (code-chat C6, I2, R39) ──

const sess = (o: { host?: "claude" | "codex" | "shell"; sessionId?: string | null; ended?: boolean; exited?: boolean } = {}) => ({
  id: "7", meta: { host: o.host ?? "codex", origin: null, startedAt: NOW - 60_000, sessionId: o.sessionId ?? null },
  getTitle: () => "Tide chart", isExited: !!o.exited, exitCode: o.exited ? 0 : null, agentEnded: !!o.ended,
});
const feed = (sessionId: string | null, turnOpen = false, follow: "pending" | "on" | "off" | "failed" = "on") => ({ follow, state: { sessionId, turnOpen } });

test("rowInput: the conversation is the chat's (a new Codex thread, a /clear), else the launch's", () => {
  assert.equal(rowInput(sess(), ws("kite"), feed("019a-codex-thread")).sessionId, "019a-codex-thread", "a Codex terminal knows its id only from its chat");
  assert.equal(rowInput(sess({ host: "claude", sessionId: "before-clear" }), ws("kite"), feed("after-clear")).sessionId, "after-clear");
  assert.equal(rowInput(sess({ host: "claude", sessionId: "launched" }), ws("kite"), feed(null)).sessionId, "launched");
  assert.equal(rowInput(sess({ host: "claude", sessionId: "launched" }), ws("kite"), null).sessionId, "launched");
  assert.equal(rowInput(sess(), ws("kite"), null).sessionId, null);
});

test("rowInput: a Codex terminal with no launch id, closed, is kept and listed as a closed row by its chat's id", () => {
  const closed = new ClosedRecord();
  closed.add(rowInput(sess(), ws("kite"), feed("019a-codex-thread")));
  const g = sb([], [], { closed: closed.list() });
  assert.equal(g.length, 1);
  const r = g[0].rows[0];
  assert.equal(r.kind === "open" && r.closed, true);
  assert.equal(r.kind === "open" ? r.row.sessionId : null, "019a-codex-thread");
  assert.equal(r.kind === "open" ? r.status.text : null, "Closed");
});

test("rowInput: no turn is open once the agent ended; an agent whose chat is not followed reads Running, not Idle (M1)", () => {
  assert.equal(rowInput(sess({ ended: true }), ws("kite"), feed("x", true)).turnOpen, false);
  assert.equal(rowInput(sess(), ws("kite"), feed("x", true)).turnOpen, true);
  const status = (r: ReturnType<typeof rowInput>) => { const x = sb([r], [])[0].rows[0]; return x.kind === "open" ? x.status.text : null; };
  assert.equal(status(rowInput(sess(), ws("kite"), feed(null, false, "off"))), "Running", "the surface off: nothing says whether a turn runs");
  assert.equal(status(rowInput(sess(), ws("kite"), null)), "Running");
  assert.equal(status(rowInput(sess(), ws("kite"), feed(null, false, "pending"))), "Running");
  assert.equal(status(rowInput(sess(), ws("kite"), feed("x", false))), "Idle", "a followed chat with no open turn");
  assert.equal(status(rowInput(sess(), ws("kite"), feed("x", true))), "Working");
  assert.equal(status(rowInput(sess({ exited: true }), ws("kite"), null)), "Exited 0");
  assert.equal(status(rowInput(sess({ host: "shell" }), ws("kite"), null)), "Idle", "a shell's row shows no status");
});
