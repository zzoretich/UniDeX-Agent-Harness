import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agoWords, alertKind, attentionFix, buildBoard, checkDue, connectorsBadge, copyOffers, filterCards, foundFiles, groupPeek, inTile, kindLine,
  metaLine, onBoth, parseCaches, scopeLine, serverSub, sideActions, sparkHeights, takenNames, tileSub, toolChips, useLine, CONN_TILES,
  type ConnCard,
} from "./connectorsModel";

// The three caches as brain/scripts/lib/connectors writes them (spec 2026-10-23-connectors-tab §4.2).
const FOUND = JSON.stringify({
  schema: 1, updatedAt: "2026-10-23T12:00:00.000Z",
  hosts: { claude: { enabled: true, rows: 7 }, codex: { enabled: true, rows: 6 } },
  rows: [
    { host: "claude", name: "agenticos", kind: "server", transport: "stdio", command: "sh", scope: "user", file: "~/.claude.json", enabled: true, own: true },
    { host: "claude", name: "plugin:agenticos:agenticos", kind: "server", transport: "stdio", command: "sh", scope: "plugin", file: "~/p/.mcp.json", enabled: true, plugin: "agenticos", own: true },
    { host: "codex", name: "agenticos", kind: "server", transport: "stdio", command: "sh", scope: "plugin", file: "~/c/.mcp.json", enabled: true, plugin: "agenticos", own: true },
    { host: "claude", name: "docs", kind: "server", transport: "stdio", command: "docs-mcp", scope: "user", file: "~/.claude.json", enabled: true },
    { host: "codex", name: "docs", kind: "server", transport: "stdio", command: "docs-mcp", scope: "user", file: "~/.codex/config.toml", enabled: true },
    { host: "claude", name: "remote", kind: "server", transport: "http", url: "https://r.example.com/mcp", scope: "user", file: "~/.claude.json", enabled: true },
    { host: "claude", name: "local-only", kind: "server", transport: "stdio", command: "lo-mcp", scope: "user", file: "~/.claude.json", enabled: true },
    { host: "claude", name: "claude.ai Mail", kind: "connector", transport: "http", url: null, scope: "account", enabled: true, displayName: "Mail" },
    { host: "codex", name: "mail", kind: "connector", transport: "http", url: null, scope: "account", enabled: true, plugin: "mail", displayName: "Mail" },
    { host: "claude", name: "claude.ai Tickets", kind: "connector", transport: "http", url: null, scope: "account", enabled: true, displayName: "Tickets" },
    { host: "codex", name: "sleepy", kind: "server", transport: "stdio", command: "sleepy", scope: "user", file: "~/.codex/config.toml", enabled: false },
    { host: "claude", name: "waiting", kind: "server", transport: "stdio", command: "w", scope: "project", file: "~/v/workspaces/alpha/.mcp.json", workspace: "alpha", enabled: true, approval: "pending" },
    { host: "codex", name: "oauth", kind: "server", transport: "http", url: "https://o.example.com", scope: "user", enabled: true },
    { bad: true }, { host: "cursor", name: "x" },
  ],
});
const LIVE = JSON.stringify({
  schema: 1, checkedAt: "2026-10-23T12:00:00.000Z", durationMs: 6000,
  hosts: { claude: { enabled: true, ran: true }, codex: { enabled: true, ran: true } },
  rows: [
    { host: "claude", name: "agenticos", kind: "server", status: "connected", detail: "", tools: [{ name: "recall", summary: "Recall." }] },
    { host: "claude", name: "plugin:agenticos:agenticos", kind: "server", status: "connected", detail: "", tools: [{ name: "recall", summary: "Recall." }, { name: "wrap_session", summary: "Wrap." }] },
    { host: "codex", name: "agenticos", kind: "server", status: "connected", detail: "", tools: [{ name: "recall", summary: "Recall." }] },
    { host: "claude", name: "docs", kind: "server", status: "connected", detail: "", tools: [{ name: "lookup", summary: "Look up." }] },
    { host: "codex", name: "docs", kind: "server", status: "connected", detail: "", tools: [{ name: "lookup", summary: "Look up." }] },
    { host: "claude", name: "remote", kind: "server", status: "connected", detail: "", tools: null, toolsError: "signed in through its host; tools are the ones seen in use" },
    { host: "claude", name: "local-only", kind: "server", status: "connected", detail: "", tools: [] },
    { host: "claude", name: "claude.ai Mail", kind: "connector", status: "connected", detail: "", tools: null },
    { host: "codex", name: "mail", kind: "connector", status: "connected", detail: "through your ChatGPT sign-in", tools: null },
    { host: "claude", name: "claude.ai Tickets", kind: "connector", status: "failed", detail: "-32600: client not permitted", tools: null },
    { host: "claude", name: "claude.ai Fresh", kind: "connector", status: "connected", detail: "", tools: null },
    { host: "codex", name: "sleepy", kind: "server", status: "off", detail: "turned off", tools: null },
    { host: "codex", name: "oauth", kind: "server", status: "needs-auth", detail: "codex mcp login oauth", tools: null },
    { host: "claude", name: "x", status: "bogus" },
  ],
});
const days = (n: number, at: number[]) => { const a = new Array(30).fill(0); for (const i of at) a[i] = n; return a; };
const USAGE = JSON.stringify({
  schema: 1, updatedAt: "2026-10-23T12:00:00.000Z", days: 30,
  rows: [
    { host: "claude", key: "plugin_agenticos_agenticos", name: "plugin:agenticos:agenticos", builtin: false, calls: 40, sessions: 9, lastUsed: "2026-10-23T10:00:00.000Z", perDay: days(20, [28, 29]), perTool: { recall: 30, wrap_session: 10 } },
    { host: "codex", key: "agenticos", name: "agenticos", builtin: false, calls: 4, sessions: 1, lastUsed: "2026-10-22T10:00:00.000Z", perDay: days(4, [28]), perTool: { recall: 4 } },
    { host: "claude", key: "remote", name: "remote", builtin: false, calls: 3, sessions: 2, lastUsed: "2026-10-20T10:00:00.000Z", perDay: days(3, [26]), perTool: { fetch: 2, list: 1 } },
    { host: "claude", key: "claude-in-chrome", name: "claude-in-chrome", builtin: true, calls: 99, sessions: 4, lastUsed: "2026-10-22T09:00:00.000Z", perDay: days(99, [28]), perTool: { navigate: 60, click: 39 } },
  ],
});
const NOW = Date.parse("2026-10-23T12:05:00.000Z");
const both = ["claude", "codex"] as const;
const board = (enabled: readonly ("claude" | "codex")[] = both, live: string | null = LIVE) => buildBoard(parseCaches(FOUND, live, USAGE), enabled);
const byTitle = (b: ReturnType<typeof board>, t: string): ConnCard => { const k = b.cards.find((x) => x.title === t); assert.ok(k, t); return k!; };

test("cards merge by name across hosts: a Claude plugin server and Codex's are one card; connectors by title; malformed rows dropped", () => {
  const b = board();
  const own = byTitle(b, "agenticos");
  assert.deepEqual(Object.keys(own.sides).sort(), ["claude", "codex"]);
  assert.equal(own.sides.claude!.name, "plugin:agenticos:agenticos", "the plugin side wins the Claude Code slot after the user one");
  const mail = byTitle(b, "Mail");
  assert.deepEqual([mail.kind, Object.keys(mail.sides).sort()], ["connector", ["claude", "codex"]]);
  assert.equal(byTitle(b, "Fresh").kind, "connector", "a connector only the check knows yet still shows");
  assert.ok(!b.cards.some((k) => k.title === "x"));
});

test("groups: attention first, then off, project, built-in, connectors, servers; every card in one", () => {
  const b = board();
  assert.deepEqual(b.groups.attention.map((k) => k.title).sort(), ["Tickets", "oauth"]);
  assert.deepEqual(b.groups.off.map((k) => k.title), ["sleepy"]);
  assert.deepEqual(b.groups.project.map((k) => k.title), ["waiting"]);
  assert.equal(b.groups.project[0].status, "pending");
  assert.deepEqual(b.groups.builtin.map((k) => k.title), ["claude-in-chrome"]);
  assert.deepEqual(b.groups.connectors.map((k) => k.title).sort(), ["Fresh", "Mail"]);
  assert.deepEqual(b.groups.servers.map((k) => k.title).sort(), ["agenticos", "docs", "local-only", "remote"]);
  const total = Object.values(b.groups).reduce((n, g) => n + g.length, 0);
  assert.equal(total, b.cards.length);
});

test("tiles and the badge: attention, connected, unused, off; the badge only after a check within a day", () => {
  const b = board();
  // Unused: every card not off with no call in the window, failing ones too (they are the first candidates to park).
  assert.deepEqual(b.tiles, { attention: 2, connected: 7, unused: 7, off: 1 });
  assert.equal(connectorsBadge(b, NOW), 2);
  assert.equal(connectorsBadge(b, NOW + 25 * 60 * 60 * 1000), 0, "a check over a day old shows no badge");
  const never = board(both, null);
  assert.equal(never.checkedAt, null);
  assert.equal(connectorsBadge(never, NOW), 0);
  assert.equal(byTitle(never, "docs").status, "not-checked");
  assert.equal(byTitle(never, "sleepy").status, "off", "off comes from the files, check or not");
});

test("usage: calls and days summed across sides; tools merged with their calls; seen-in-use tools when the check has none", () => {
  const b = board();
  const own = byTitle(b, "agenticos");
  assert.deepEqual([own.calls, own.sessions, own.lastUsed], [44, 10, "2026-10-23T10:00:00.000Z"]);
  assert.equal(own.perDay[28], 24);
  assert.equal(own.perDay[29], 20);
  assert.deepEqual(toolChips(own).map((t) => `${t.name}:${t.calls}`), ["recall:34", "wrap_session:10"]);
  const remote = byTitle(b, "remote");
  assert.equal(remote.sides.claude!.toolsSeen, true);
  assert.deepEqual(remote.sides.claude!.tools!.map((t) => t.name), ["fetch", "list"]);
  assert.equal(byTitle(b, "local-only").toolCount, 0, "a server the check reached with no tools has 0, not unknown");
  assert.equal(byTitle(b, "Mail").toolCount, null);
  assert.equal(useLine(own, 30, NOW), "44 calls · 2h ago");
  assert.equal(useLine(byTitle(b, "docs"), 30, NOW), "unused 30d");
});

test("Codex only: Claude Code's rows and connectors are not shown; Claude only likewise", () => {
  const cx = board(["codex"]);
  assert.ok(cx.cards.every((k) => !k.sides.claude));
  assert.ok(!cx.cards.some((k) => k.title === "Tickets"));
  assert.equal(cx.hosts.claude.enabled, false);
  assert.equal(cx.tiles.attention, 1);
  const cl = board(["claude"]);
  assert.ok(cl.cards.every((k) => !k.sides.codex));
  assert.equal(cl.hosts.codex.count, 0);
});

test("attention fixes: claude.ai connector → claude.ai; Codex OAuth → codex mcp login; others check again", () => {
  const b = board();
  assert.equal(attentionFix(byTitle(b, "Tickets"))!.fix, "claude.ai");
  const o = attentionFix(byTitle(b, "oauth"))!;
  assert.deepEqual([o.fix, o.side.host], ["login", "codex"]);
  assert.equal(attentionFix(byTitle(b, "docs")), null);
});

test("copy offers: a user-scope server on one host to the other enabled host, a streamable HTTP one to Codex too (D20); the vault's own never", () => {
  const b = board();
  assert.deepEqual(copyOffers(byTitle(b, "local-only"), both).map((o) => [o.to, o.disabled]), [["codex", false]]);
  assert.deepEqual(copyOffers(byTitle(b, "remote"), both), [{ to: "codex", label: "Copy to Codex", disabled: false, reason: null }]);
  assert.deepEqual(copyOffers(byTitle(b, "agenticos"), both), []);
  assert.deepEqual(copyOffers(byTitle(b, "docs"), both), [], "on both already");
  assert.deepEqual(copyOffers(byTitle(b, "local-only"), ["claude"]), [], "the other host is off");
  assert.deepEqual(copyOffers(byTitle(b, "Mail"), both), [], "connectors are not copied");
});

test("words and filters: kind and scope lines; a filter matches names, programs, plugins and tools; checkDue", () => {
  const b = board();
  assert.equal(kindLine(byTitle(b, "docs")), "Local · stdio");
  assert.equal(kindLine(byTitle(b, "remote")), "Remote · http");
  assert.equal(scopeLine(byTitle(b, "waiting").sides.claude!), "project · alpha · ~/v/workspaces/alpha/.mcp.json");
  assert.equal(scopeLine(byTitle(b, "agenticos").sides.codex!), "plugin agenticos · this vault's own");
  assert.deepEqual(filterCards(b.cards, "LOOKUP").map((k) => k.title), ["docs"]);
  assert.deepEqual(filterCards(b.cards, "plugin:agenticos").map((k) => k.title), ["agenticos"]);
  assert.equal(checkDue({ checkedAt: null }, NOW, 15), true);
  assert.equal(checkDue(b, NOW, 15), false);
  assert.equal(checkDue(b, NOW + 16 * 60_000, 15), true);
});

test("a runtime that writes no connectors.json reads as not listed; junk never throws", () => {
  const c = parseCaches(null, "{", "nope");
  assert.equal(c.listed, false);
  assert.deepEqual(buildBoard(c, both).cards, []);
});

test("a tile keeps exactly the cards it counts; its sub line names their kinds", () => {
  const b = board();
  for (const t of CONN_TILES) assert.equal(b.cards.filter((k) => inTile(k, t)).length, b.tiles[t], t);
  assert.equal(tileSub(b.cards, "attention", 30), "1 connector · 1 server");
  assert.equal(tileSub(b.cards, "connected", 30), "2 connectors · 4 servers · 1 built in");
  assert.equal(tileSub(b.cards, "unused", 30), "no call in 30 days");
  assert.equal(tileSub(b.cards, "off", 30), "1 server");
  assert.equal(tileSub([], "attention", 30), "nothing failed");
});

test("the header line: the check's age, the next one, each enabled host's count; Checking… and a failure lead it", () => {
  const b = board();
  assert.equal(metaLine(b, NOW, 15), "checked 5 min ago · next check in 10 min · Claude Code 9 · Codex 5");
  assert.equal(metaLine(b, NOW + 20 * 60_000, 15), "checked 25 min ago · check due · Claude Code 9 · Codex 5");
  assert.equal(metaLine(board(["codex"]), NOW, 15, { checking: true }), "Checking… · Codex 5");
  assert.equal(metaLine(board(both, null), NOW, 15), "never checked · Claude Code 8 · Codex 5");
  assert.equal(metaLine(b, NOW, 15, { failed: "aos did not answer in time" }), "last check failed: aos did not answer in time · Claude Code 9 · Codex 5");
  assert.deepEqual([agoWords(null, NOW), agoWords("2026-10-23T12:04:30.000Z", NOW), agoWords("2026-10-23T09:00:00.000Z", NOW), agoWords("2026-10-19T12:00:00.000Z", NOW)], ["never", "just now", "3 h ago", "4 d ago"]);
});

test("cards' words: sparkline heights, server sub lines, alert kinds, both-hosts tag, found-in files, folded peeks", () => {
  const b = board();
  assert.deepEqual(sparkHeights([0, 2, 4], 5, 24), [0, 0, 0, 12, 24], "padded at the front to the window, today last");
  assert.deepEqual(sparkHeights([1, 100], 2, 24), [3, 24], "a day with a call is never invisible");
  assert.equal(sparkHeights([], 30, 24).length, 30);
  assert.equal(serverSub(byTitle(b, "docs")), "stdio · docs-mcp");
  assert.equal(serverSub(byTitle(b, "remote")), "http · r.example.com");
  assert.equal(serverSub(byTitle(b, "agenticos")), "plugin · agenticos");
  assert.equal(serverSub(byTitle(b, "waiting")), "project · alpha");
  assert.equal(alertKind(byTitle(b, "Tickets").sides.claude!, byTitle(b, "Tickets")), "claude.ai connector");
  assert.equal(alertKind(byTitle(b, "oauth").sides.codex!, byTitle(b, "oauth")), "http · Codex");
  assert.deepEqual([onBoth(byTitle(b, "docs")), onBoth(byTitle(b, "remote"))], [true, false]);
  assert.deepEqual(foundFiles(byTitle(b, "docs")), ["~/.claude.json", "~/.codex/config.toml"]);
  assert.deepEqual(foundFiles(byTitle(b, "Mail")), []);
  assert.equal(groupPeek(b.groups.builtin, "builtin"), "claude-in-chrome");
  assert.equal(groupPeek([], "project"), "no workspace declares its own servers");
});

// A board of what the sheet's actions depend on (D16, D17): a parked server, an SSE one, plugins' servers on each host,
// a connector on each, the vault's own, a project's, a turned-off one.
const ACTIONS = JSON.stringify({
  schema: 1, updatedAt: "2026-10-23T12:00:00.000Z", hosts: { claude: { enabled: true, rows: 6 }, codex: { enabled: true, rows: 4 } },
  rows: [
    { host: "claude", name: "resting", kind: "server", transport: "stdio", command: "rest-mcp", scope: "user", file: "~/.claude.json", enabled: false, parked: true },
    { host: "claude", name: "feed", kind: "server", transport: "sse", url: "https://feed.example.com/sse", scope: "user", file: "~/.claude.json", enabled: true },
    { host: "claude", name: "plugin:helper:helper", kind: "server", transport: "stdio", command: "h", scope: "plugin", file: "~/p/.mcp.json", enabled: true, plugin: "helper" },
    { host: "codex", name: "toolbox", kind: "server", transport: "stdio", command: "t", scope: "plugin", file: "~/c/.mcp.json", enabled: true, plugin: "tools" },
    { host: "claude", name: "claude.ai Notes", kind: "connector", transport: "http", url: null, scope: "account", enabled: true, displayName: "Notes" },
    { host: "codex", name: "tasks", kind: "connector", transport: "http", url: null, scope: "account", enabled: true, plugin: "tasks", displayName: "Tasks" },
    { host: "claude", name: "agenticos", kind: "server", transport: "stdio", command: "sh", scope: "user", file: "~/.claude.json", enabled: true, own: true },
    { host: "claude", name: "waiting", kind: "server", transport: "stdio", command: "w", scope: "project", file: "~/v/workspaces/alpha/.mcp.json", workspace: "alpha", enabled: true, approval: "pending" },
    { host: "codex", name: "sleepy", kind: "server", transport: "stdio", command: "sleepy", scope: "user", file: "~/.codex/config.toml", enabled: false },
    { host: "codex", name: "docs", kind: "server", transport: "stdio", command: "docs-mcp", scope: "user", file: "~/.codex/config.toml", enabled: true },
  ],
});

test("a parked server is off with how to bring it back; the sheet's actions per side: Park and Remove, Turn on, Remove alone when off, the D17 hint otherwise", () => {
  const b = buildBoard(parseCaches(ACTIONS, null, null), both);
  const at = (t: string, h: "claude" | "codex") => byTitle(b, t).sides[h]!;
  const resting = at("resting", "claude");
  assert.deepEqual([resting.parked, resting.status, resting.detail, byTitle(b, "resting").group], [true, "off", "parked: Turn on puts it back as it was", "off"]);
  assert.equal(scopeLine(resting), "user · parked · Turn on puts it back in ~/.claude.json");
  assert.deepEqual(sideActions(resting), { actions: ["unpark"], hint: null });
  assert.deepEqual(copyOffers(byTitle(b, "resting"), both).map((o) => o.reason), ["Parked on Claude Code: turn it on there first"]);
  assert.deepEqual(copyOffers(byTitle(b, "feed"), both).map((o) => [o.disabled, o.reason]), [[true, "An SSE server: Codex's mcp add --url takes a streamable HTTP server only"]]);
  assert.deepEqual(sideActions(at("feed", "claude")), { actions: ["park", "remove"], hint: null });
  assert.deepEqual(sideActions(at("docs", "codex")), { actions: ["park", "remove"], hint: null });
  assert.deepEqual(sideActions(at("sleepy", "codex")), { actions: ["remove"], hint: null }, "off: Turn on could not bring that back");
  const hint = (t: string, h: "claude" | "codex") => { const m = sideActions(at(t, h)); assert.deepEqual(m.actions, [], t); return m.hint; };
  assert.equal(hint("helper", "claude"), "From the plugin helper: turn the plugin off with claude plugin disable helper (that turns off its skills too).");
  assert.equal(hint("toolbox", "codex"), "From the Codex plugin tools: Codex has no command for it, so turn the plugin off in Codex's plugin settings.");
  assert.equal(hint("Notes", "claude"), "A claude.ai connector: turn it off in claude.ai's connector settings.");
  assert.equal(hint("Tasks", "codex"), "A ChatGPT app: turn it off in ChatGPT's connector settings.");
  assert.equal(hint("agenticos", "claude"), "The vault's own server: aos init and aos hosts add wire it on each host.");
  assert.equal(hint("waiting", "claude"), "Declared by the workspace alpha: change it in ~/v/workspaces/alpha/.mcp.json.");
  const taken = takenNames(b);
  assert.deepEqual([[...taken.claude].sort(), [...taken.codex].sort()], [["agenticos", "feed", "resting"], ["docs", "sleepy"]]);
});
