import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTerminals, rowEnd, stepRow, groupKey, scopeOf, groupSidebar, ageText, sidebarOrder, rowInput } from "./termGroups";
import { ClosedRecord } from "./closedRecord";
import type { HistoryRow } from "./sessionHistory";
import type { Place } from "./terminalLaunch";

const ws = (n: string): Place => ({ kind: n === "scratch" ? "scratch" : "workspace", label: n === "scratch" ? "Scratch" : n, dir: `/v/workspaces/${n}`, workspace: n });
const vault: Place = { kind: "vault", label: "Vault", dir: "/v" };
const other: Place = { kind: "other", label: "app", dir: "/code/app" };
const row = (id: string, place: Place, startedAt: number, extra: Partial<Parameters<typeof groupTerminals>[0][number]> = {}) =>
  ({ id, host: "claude" as const, title: `t${id}`, place, origin: null, startedAt, exited: false, exitCode: null, ...extra });

test("groups by place, the newest launch first, the vault and other folders last; rows newest first", () => {
  const g = groupTerminals([row("1", vault, 50), row("2", ws("kite"), 10), row("3", ws("scratch"), 30), row("4", ws("kite"), 40), row("5", other, 99)]);
  assert.deepEqual(g.map((x) => x.label), ["kite", "Scratch", "Vault", "app"]);
  assert.deepEqual(g[0].rows.map((r) => r.id), ["4", "2"]);
});

test("a linked code folder groups with its workspace", () => {
  const linked: Place = { kind: "workspace", label: "notes", dir: "/code/app", workspace: "notes", linked: true };
  assert.equal(groupKey(linked), groupKey(ws("notes")));
  assert.equal(groupTerminals([row("1", linked, 1), row("2", ws("notes"), 2)]).length, 1);
});

test("end states: running, Done on exit 0, Exited n otherwise", () => {
  assert.deepEqual(rowEnd({ exited: false, exitCode: null }), { end: "running", endText: null });
  assert.deepEqual(rowEnd({ exited: true, exitCode: 0 }), { end: "done", endText: "Done" });
  assert.deepEqual(rowEnd({ exited: true, exitCode: 127 }), { end: "failed", endText: "Exited 127" });
});

test("the filter matches title, place and origin", () => {
  const rows = [row("1", vault, 1, { origin: "Skills" }), row("2", ws("kite"), 2, { title: "Fix the race" })];
  assert.deepEqual(groupTerminals(rows, "skills").flatMap((g) => g.rows.map((r) => r.id)), ["1"]);
  assert.deepEqual(groupTerminals(rows, "race").flatMap((g) => g.rows.map((r) => r.id)), ["2"]);
  assert.deepEqual(groupTerminals(rows, "KITE").flatMap((g) => g.rows.map((r) => r.id)), ["2"]);
});

test("stepRow walks the list order and wraps", () => {
  const g = groupTerminals([row("1", ws("a"), 3), row("2", ws("a"), 2), row("3", vault, 1)]);
  assert.equal(stepRow(g, "1", 1), "2");
  assert.equal(stepRow(g, "3", 1), "1");
  assert.equal(stepRow(g, "1", -1), "3");
  assert.equal(stepRow(g, null, 1), "1");
  assert.equal(stepRow([], null, 1), null);
});

test("a scope (spaces-redesign D12) keeps only its workspace's group, by key and never by text", () => {
  const linked: Place = { kind: "workspace", label: "site", dir: "/code/site", workspace: "site", linked: true };
  const rows = [row("1", ws("site"), 1), row("2", ws("site-repo"), 2), row("3", vault, 3, { title: "site notes" }), row("4", linked, 4)];
  const g = groupTerminals(rows, "", scopeOf(ws("site")));
  assert.deepEqual(g.map((x) => x.key), ["ws:site"]);
  assert.deepEqual(g[0].rows.map((r) => r.id), ["4", "1"], "its linked code folder's terminals included, site-repo and the vault left out");
  // The group starts in the workspace's own place, whatever folder its newest row runs in.
  assert.equal(g[0].place.dir, "/v/workspaces/site");
  // The filter still narrows inside the scope.
  assert.deepEqual(groupTerminals(rows, "t1", scopeOf(ws("site"))).flatMap((x) => x.rows.map((r) => r.id)), ["1"]);
  assert.deepEqual(groupTerminals(rows, "nothing", scopeOf(ws("site"))), []);
  assert.deepEqual(stepRow(g, "4", 1), "1");
});

test("a scope with no terminal yet is one empty group, so its + can start one there", () => {
  const g = groupTerminals([row("1", vault, 1)], "", scopeOf(ws("kite")));
  assert.deepEqual(g.map((x) => [x.key, x.label, x.kind, x.rows.length]), [["ws:kite", "kite", "workspace", 0]]);
  assert.equal(stepRow(g, null, 1), null);
});

// ── groupSidebar (spec 2026-11-09-code-chat C6) ──

const NOW = Date.parse("2026-11-09T12:00:00Z");
const DAY = 86_400_000;
const hist = (id: string, place: Place, ago: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({
  key: `claude:${id}`, id, host: "claude", hostLabel: "Claude Code", title: `h${id}`, summary: null, workspace: place.workspace ?? null, where: place.label,
  at: new Date(NOW - ago).toISOString(), day: "", time: "", resume: { state: "on", place, hint: "" }, place, ...extra,
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
