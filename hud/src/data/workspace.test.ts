import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Team, TeamFiles, readTeams, teamFrom, parseJsonl, latestRows, diskAdapter } from "./teams";
import { parseAgents, emptyAgents } from "./agents";
import { activityOf, ACTIVITY_PAGE, itemOrder, stageStrip, workspaceTree, seatsOf, benchOf, agentRuns, weekUsd, pickNode, paneNode, isWorkspacePane, TreeRow, NO_TEAMS, NO_AGENTS } from "./workspace";

const VAULT = path.resolve(__dirname, "fixtures/teams-vault");
const LAB_BOARD = path.join(VAULT, "persona/teams/lab/board.jsonl");

async function lab(): Promise<Team> {
  const t = (await readTeams(diskAdapter(VAULT))).find((x) => x.id === "lab");
  assert.ok(t, "no lab team");
  return t;
}

test("history keeps every complete board row and the board is unchanged", async () => {
  const t = await lab();
  const rows = parseJsonl(fs.readFileSync(LAB_BOARD, "utf8")).rows;
  assert.equal(t.history.length, rows.length);
  assert.deepEqual(t.history.map((h) => h.raw), rows);
  assert.deepEqual(t.board.map((b) => b.raw), [...latestRows(rows).values()]);
});

test("activity: the lab's gate, runs, marker and posts, newest first", async () => {
  const ev = activityOf(await lab());
  const ts = ev.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort().reverse());
  assert.ok(ev.some((e) => e.kind === "gate-open" && e.item === "site-01" && e.ts === "2026-09-20T12:00:00.000Z"));
  assert.equal(ev.filter((e) => e.kind === "gate-open" && e.item === "site-01").length, 1);
  assert.ok(ev.some((e) => e.kind === "run-end" && e.member === "reviewer" && e.item === "site-03"));
  assert.ok(ev.some((e) => e.kind === "run-start" && e.member === "builder" && e.item === "site-02" && e.ts === "2026-09-20T12:50:00.000Z"));
  assert.ok(ev.some((e) => e.kind === "item-new" && e.item === "site-00"));
  assert.ok(ev.some((e) => e.kind === "gate-decided" && e.item === "site-02" && e.ts === "2026-09-20T10:30:00.000Z"));
  assert.ok(ev.every((e) => e.item !== "site-04"));
  assert.ok(ev.some((e) => e.kind === "post" && e.member === "lead"));
  assert.ok(!ev.some((e) => e.kind === "post" && e.item === "site-01" && e.ts === "2026-09-20T12:00:00.000Z"), "a gate post is folded into gate-open");
  const open = ev.find((e) => e.kind === "gate-open" && e.item === "site-01");
  assert.ok(open?.text.endsWith('"Discuss gate open on site-01: scope is the landing page; I propose $20, with $3.44 spent. See notes@lead, or ask @user."'));
  assert.ok(ACTIVITY_PAGE === 50);
});

test("no gate post is a post event for any fixture team", async () => {
  for (const t of await readTeams(diskAdapter(VAULT))) {
    const gateTexts = new Set(t.channel.filter((p) => p.kind === "gate").map((p) => p.text));
    assert.ok(!activityOf(t).some((e) => e.kind === "post" && [...gateTexts].some((g) => e.text.endsWith(g))), t.id);
  }
});

test("a gate-open takes the latest earlier lead pitch, or none", () => {
  const row = (ts: string, id: string) => JSON.stringify({ ts, by: "lead", id, title: id, stage: "discuss", owner: "lead", status: "gate", gate: { name: "discuss", state: "pending" } });
  const post = (ts: string, text: string, item: string) => JSON.stringify({ ts, from: "lead", kind: "gate", item, text });
  const t = teamFrom({
    id: "x", teamMd: "---\nname: X\nlead: lead\n---\n", runs: null, markers: [], state: null, disabled: false,
    board: [row("2026-01-01T00:10:00.000Z", "a-1"), row("2026-01-01T00:10:00.000Z", "b-1")].join("\n") + "\n",
    channel: [post("2026-01-01T00:01:00.000Z", "old", "a-1"), post("2026-01-01T00:09:00.000Z", "new", "a-1"), post("2026-01-01T00:11:00.000Z", "later", "b-1")].join("\n") + "\n",
  });
  const ev = activityOf(t).filter((e) => e.kind === "gate-open");
  assert.ok(ev.find((e) => e.item === "a-1")?.text.endsWith('"new"'));
  assert.ok(!ev.find((e) => e.item === "b-1")?.text.includes('"'));
  assert.ok(!activityOf(t).some((e) => e.kind === "post"));
});

test("run-end names the provider and never dangles a separator", async () => {
  const rev = activityOf(await lab()).find((e) => e.kind === "run-end" && e.member === "reviewer" && e.item === "site-03");
  assert.ok(rev?.text.includes("codex"));
  const t = teamFrom({
    id: "x", teamMd: "---\nname: X\nlead: lead\n---\n", board: null, channel: null, markers: [], state: null, disabled: false,
    runs: JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", member: "a", item: "a-1" }) + "\n",
  });
  const e = activityOf(t).find((x) => x.kind === "run-end");
  assert.ok(e && !/[:·]\s*$/.test(e.text));
});

test("a user gate post is left out", () => {
  const t = teamFrom({
    id: "x", teamMd: "---\nname: X\nlead: lead\n---\n", board: null, runs: null, markers: [], state: null, disabled: false,
    channel: [
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", from: "user", kind: "gate", item: "a-1", text: "approved" }),
      JSON.stringify({ ts: "2026-01-01T00:01:00.000Z", from: "user", kind: "note", item: null, text: "hello" }),
    ].join("\n") + "\n",
  });
  const ev = activityOf(t);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "post");
  assert.equal(ev[0].text.endsWith("hello"), true);
});

test("activity names a member as the roster does, one off the roster by its id, and the user as You", () => {
  // The tree shows a member by its roster name, so the feed does too: "Survey Lead", never "Surveylead".
  const t = teamFrom({
    id: "survey", teamMd: "---\nname: Survey\nlead: surveylead\nmembers:\n  - id: surveylead\n    name: Survey Lead\n    agent: survey-lead\n---\n",
    board: JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", by: "surveylead", id: "s-1", title: "Sites", stage: "plan", status: "gate", gate: { name: "plan", state: "pending" } }) + "\n",
    channel: [
      JSON.stringify({ ts: "2026-01-01T00:01:00.000Z", from: "fieldhand", kind: "note", item: null, text: "on site" }),
      JSON.stringify({ ts: "2026-01-01T00:02:00.000Z", from: "user", kind: "note", item: null, text: "thanks" }),
    ].join("\n") + "\n",
    runs: JSON.stringify({ ts: "2026-01-01T00:03:00.000Z", member: "surveylead", item: "s-1", provider: "claude", status: "ok", usd: 1 }) + "\n",
    markers: [JSON.stringify({ run: "survey-s-1-surveylead-b", member: "surveylead", item: "s-1", provider: "claude", startedAt: "2026-01-01T00:04:00.000Z" })],
    state: null, disabled: false,
  });
  assert.deepEqual(activityOf(t).map((e) => e.text), [
    "Survey Lead started s-1 (plan) on claude",
    "Survey Lead finished s-1: ok · claude · $1",
    "You: thanks",
    "Fieldhand: on site",
    "Survey Lead added s-1: Sites",
    "Survey Lead opened the plan gate on s-1",
  ]);
});

test("activity over 2,000 generated rows stays sorted and one row can give two events", () => {
  const rows: string[] = [];
  const base = Date.parse("2026-02-01T00:00:00.000Z");
  const at = (i: number) => new Date(base + i * 60000).toISOString();
  for (let i = 0; i < 2000; i++) {
    const id = `g-${i % 40}`;
    rows.push(JSON.stringify({ ts: at(i), by: "lead", id, title: id, stage: i < 40 ? "discuss" : "plan", owner: "a", status: "working", gate: null, budget: { usd: 10 + (i % 3) } }));
  }
  // one row that both moves the stage and records a user decision
  rows.push(JSON.stringify({ ts: at(2001), by: "lead", id: "g-0", title: "g-0", stage: "execute", owner: "a", status: "working", gate: { name: "plan", state: "approved", by: "user", ts: at(2000) }, budget: { usd: 12 } }));
  const files: TeamFiles = { id: "big", teamMd: "---\nname: Big\nlead: lead\n---\n", board: rows.join("\n") + "\n", channel: null, runs: null, markers: [], state: null, disabled: false };
  const t = teamFrom(files);
  assert.equal(t.history.length, 2001);
  const ev = activityOf(t);
  const ts = ev.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort().reverse());
  const mine = ev.filter((e) => e.item === "g-0" && e.ts >= at(2000));
  assert.ok(mine.some((e) => e.kind === "gate-decided" && e.ts === at(2000)));
  assert.ok(mine.some((e) => e.kind === "stage" && e.ts === at(2001)));
  assert.equal(ev.filter((e) => e.kind === "item-new").length, 40);
});

test("items: pending gate, blocked, working, open, paused, then done", async () => {
  const t = await lab();
  const { open, done } = itemOrder(t);
  assert.equal(open[0].id, "site-01");
  assert.ok(done.some((i) => i.id === "site-00"));
  assert.equal(open.length + done.length, t.board.length);
  const mk = (id: string, status: string, gate: string | null = null) =>
    ({ ...t.board[0], id, status, gate: gate ? { name: "g", state: gate, by: null, ts: null, note: "" } : null });
  const fake = { ...t, board: [mk("a", "paused"), mk("b", "todo"), mk("c", "working"), mk("d", "blocked"), mk("e", "gate", "approved"), mk("f", "gate", "pending"), mk("g", "done"), mk("h", "working")] };
  const o = itemOrder(fake);
  assert.deepEqual(o.open.map((i) => i.id), ["f", "d", "c", "h", "b", "e", "a"]);
  assert.deepEqual(o.done.map((i) => i.id), ["g"]);
});

test("the strip: done before the stage, the stage's state, todo after", async () => {
  const t = await lab();
  const by = (id: string) => t.board.find((b) => b.id === id)!;
  assert.deepEqual(stageStrip(t, by("site-02")), ["done", "done", "current", "todo", "todo"]);
  assert.deepEqual(stageStrip(t, by("site-01")), ["gate", "todo", "todo", "todo", "todo"]);
  assert.deepEqual(stageStrip(t, by("site-00")), ["done", "done", "done", "done", "done"]);
  assert.deepEqual(stageStrip(t, { ...by("site-02"), stage: "gone" }), ["todo", "todo", "todo", "todo", "todo"]);
  assert.deepEqual(stageStrip(t, { ...by("site-02"), status: "blocked" }), ["done", "done", "blocked", "todo", "todo"]);
  const ops = (await readTeams(diskAdapter(VAULT))).find((x) => x.id === "ops")!;
  assert.equal(stageStrip(ops, ops.board[0]).length, 3);
});

// ── the tree, seats, bench, runs and which node shows ──

const agentRow = (id: string, scope = "user", description = "") => ({
  id, name: id, description, origin: { host: "claude", scope, plugin: scope === "plugin" ? "pl" : null, path: `/x/agents/${id}.md` },
  on: { claude: { invoke: `@agent-${id}`, path: `/x/agents/${id}.md`, run: `claude --agent ${id}` } },
});
const cache = (rows: ReturnType<typeof agentRow>[]) => parseAgents(JSON.stringify({ schema: 1, scannedAt: "2026-09-20T00:00:00.000Z", agents: rows }));
const AGENTS = cache([
  agentRow("team-lead"), agentRow("team-builder"), agentRow("ops-chief"), agentRow("solo", "user", "writes haiku"),
  agentRow("plug", "plugin"), agentRow("cfg", "config"),
]);
const keys = (rows: TreeRow[]) => rows.map((r) => r.key);
async function all(): Promise<Team[]> { return readTeams(diskAdapter(VAULT)); }

test("tree: needs first, lab then ops under it, members lead first, the broken team marked, bench and folded plugins", async () => {
  const teams = await all();
  const tree = workspaceTree(teams, AGENTS, { query: "", folded: new Set() });
  assert.equal(tree[0].key, "needs");
  assert.equal(tree[0].kind, "needs");
  assert.equal(tree[0].count, teams.flatMap((t) => (t.error ? [] : t.board.filter((i) => i.status === "gate" && i.gate?.state === "pending"))).length);
  assert.ok(tree[0].count! > 0);
  const ks = keys(tree);
  assert.ok(ks.indexOf("section:teams") === 1);
  const at = (k: string) => tree.find((r) => r.key === k)!;
  assert.ok(ks.indexOf("team:lab") < ks.indexOf("team:ops"));
  assert.equal(at("team:lab").depth, 1);
  assert.equal(at("team:ops").depth, 2);
  assert.equal(at("team:broken").broken, true);
  const lab = ks.indexOf("team:lab");
  assert.deepEqual(ks.slice(lab + 1, lab + 4), ["agent:team-lead", "agent:team-builder", "member:lab/reviewer"]);
  assert.equal(at("agent:team-lead").lead, true);
  assert.equal(at("agent:team-lead").label, "Lead");
  assert.equal(at("agent:team-lead").depth, 2);
  assert.equal(at("agent:ops-chief").depth, 3);
  const broken = ks.indexOf("team:broken");
  assert.ok(!tree[broken + 1] || tree[broken + 1].kind !== "member");
  assert.ok(ks.includes("section:bench"));
  assert.deepEqual(tree.filter((r) => r.depth === 1 && r.kind === "agent").map((r) => r.key).slice(0, 1), ["agent:solo"]);
  assert.ok(ks.includes("section:plugins"));
  assert.ok(!ks.includes("agent:plug"), "plugins are folded by default");
  const open = workspaceTree(teams, AGENTS, { query: "", folded: new Set(["section:plugins"]) });
  assert.ok(keys(open).includes("agent:plug") && keys(open).includes("agent:cfg"));
  const shut = workspaceTree(teams, AGENTS, { query: "", folded: new Set(["section:teams"]) });
  assert.ok(!keys(shut).includes("team:lab") && keys(shut).includes("section:teams"));
});

test("tree with no agents cache: members by member name, bench empty", async () => {
  const tree = workspaceTree(await all(), emptyAgents(), { query: "", folded: new Set() });
  const ks = keys(tree);
  assert.ok(ks.includes("member:lab/lead") && ks.includes("member:ops/chief"));
  assert.equal(tree.find((r) => r.key === "member:lab/lead")!.label, "Lead");
  const bench = ks.indexOf("section:bench");
  assert.deepEqual(tree.slice(bench + 1).filter((r) => r.depth > 0 && r.kind !== "section" || (r.depth > 0 && r.label.includes("not scanned"))).map((r) => r.label).slice(0, 1), ["not scanned yet — sync now"]);
  assert.ok(!tree.some((r) => r.kind === "agent"));
});

test("tree with no teams (D15): TEAMS reads No teams yet, BENCH lists every agent of yours; with none of yours, today's Agents empty line", async () => {
  const tree = workspaceTree([], AGENTS, { query: "", folded: new Set() });
  const ks = keys(tree);
  assert.deepEqual(ks.slice(0, 3), ["needs", "section:teams", NO_TEAMS]);
  assert.deepEqual(tree[2], { key: NO_TEAMS, kind: "section", label: "No teams yet", depth: 1, tone: null });
  const bench = ks.indexOf("section:bench");
  assert.equal(tree[bench].count, 4);
  assert.deepEqual(ks.slice(bench + 1, bench + 5), ["agent:team-lead", "agent:team-builder", "agent:ops-chief", "agent:solo"], "every agent of yours, none hidden");
  assert.ok(!ks.includes(NO_AGENTS));
  // A filter's empty list is the filter's own: no note. A folded TEAMS hides it, as it hides teams.
  assert.ok(!keys(workspaceTree([], AGENTS, { query: "solo", folded: new Set() })).includes(NO_TEAMS));
  assert.ok(!keys(workspaceTree([], AGENTS, { query: "", folded: new Set(["section:teams"]) })).includes(NO_TEAMS));
  // A team, even a broken one, ends the empty state.
  assert.ok(!keys(workspaceTree(await all(), AGENTS, { query: "", folded: new Set() })).includes(NO_TEAMS));

  // No agents of yours either (a scanned cache with only a plugin's): BENCH says so, as the Agents tab did.
  const none = workspaceTree([], cache([agentRow("plug", "plugin")]), { query: "", folded: new Set() });
  const at = keys(none).indexOf(NO_AGENTS);
  assert.ok(at > keys(none).indexOf("section:bench") && at < keys(none).indexOf("section:plugins"));
  assert.deepEqual(none[at], { key: NO_AGENTS, kind: "section", label: "none yet — an agent is a .md file in Claude Code's agents folder or a .toml file in Codex's", depth: 1, tone: null });
  assert.ok(keys(none).includes(NO_TEAMS));
  assert.equal(pickNode({ saved: null, via: "rail", asked: null, gates: 0, tree: none }), "needs", "a note is never picked");
  // Teams with no agents of yours: the line too; never scanned: the unscanned note instead; a filter: neither.
  assert.ok(keys(workspaceTree(await all(), cache([]), { query: "", folded: new Set() })).includes(NO_AGENTS));
  const unscanned = keys(workspaceTree([], emptyAgents(), { query: "", folded: new Set() }));
  assert.ok(unscanned.includes("bench:unscanned") && !unscanned.includes(NO_AGENTS));
  assert.ok(!keys(workspaceTree([], cache([]), { query: "x", folded: new Set() })).includes(NO_AGENTS));
});

test("tree with a missing parent and a cycle lists each team once", () => {
  const mk = (id: string, parent: string | null) => teamFrom({
    id, teamMd: `---\nname: ${id}\nlead: l\n${parent ? `parent: ${parent}\n` : ""}members:\n  - id: l\n    name: L\n---\n`,
    board: null, channel: null, runs: null, markers: [], state: null, disabled: false,
  });
  const tree = workspaceTree([mk("a", "b"), mk("b", "a"), mk("c", "nope")], emptyAgents(), { query: "", folded: new Set() });
  const teamRows = tree.filter((r) => r.kind === "team");
  assert.deepEqual(teamRows.map((r) => r.key).sort(), ["team:a", "team:b", "team:c"]);
  assert.ok(teamRows.every((r) => r.depth === 1));
});

test("an agent in two teams shows under both and not on the bench", async () => {
  const [lab0, ops0] = [(await all()).find((t) => t.id === "lab")!, (await all()).find((t) => t.id === "ops")!];
  const ops = { ...ops0, members: ops0.members.map((m, i) => (i === 0 ? { ...m, agent: "team-lead" } : m)) };
  const teams = [lab0, ops];
  assert.deepEqual(seatsOf(teams, "team-lead").map((s) => `${s.team.id}/${s.member.id}`), ["lab/lead", "ops/chief"]);
  assert.equal(seatsOf(teams, "team-lead")[0].member.lead, true);
  assert.deepEqual(seatsOf(teams, "nobody"), []);
  const tree = workspaceTree(teams, AGENTS, { query: "", folded: new Set() });
  assert.equal(tree.filter((r) => r.key === "agent:team-lead").length, 2);
  assert.deepEqual(benchOf(AGENTS, teams).map((a) => a.id), ["ops-chief", "solo"], "the chief lost its seat, the lead keeps one in lab");
  assert.ok(!benchOf(AGENTS, teams).some((a) => a.id === "plug"));
});

test("seatsOf skips a broken team", async () => {
  const lab0 = (await all()).find((t) => t.id === "lab")!;
  assert.deepEqual(seatsOf([{ ...lab0, error: "bad" }], "team-lead"), []);
});

test("the filter keeps a matching member's team and hides the rest", async () => {
  const teams = await all();
  const tree = workspaceTree(teams, AGENTS, { query: "scout", folded: new Set() });
  const ks = keys(tree);
  assert.ok(ks.includes("team:ops") && ks.includes("team:lab"), "the matching team keeps its parent");
  assert.ok(ks.includes("member:ops/scout"));
  assert.ok(!ks.includes("agent:ops-chief") && !ks.includes("agent:team-lead") && !ks.includes("team:broken"));
  const hay = workspaceTree(teams, AGENTS, { query: "haiku", folded: new Set() }).filter((r) => r.kind === "agent").map((r) => r.key);
  assert.deepEqual(hay, ["agent:solo"]);
  assert.ok(workspaceTree(teams, AGENTS, { query: "haiku", folded: new Set() })[0].key === "needs");
});

test("agentRuns sums only the last seven days", async () => {
  const lab0 = (await all()).find((t) => t.id === "lab")!;
  const now = new Date("2026-09-25T12:00:00.000Z");
  const run = (ts: string, member: string, usd: number | null) => ({ ts, member, item: "i", provider: "claude", status: "ok", usd, ms: 1 });
  const t = { ...lab0, runs: [run("2026-09-01T00:00:00.000Z", "builder", 5), run("2026-09-20T11:50:00.000Z", "builder", 3.44), run("2026-09-24T00:00:00.000Z", "builder", 1), run("2026-09-24T00:00:00.000Z", "reviewer", 9), run("2026-09-24T01:00:00.000Z", "builder", null)] };
  const r = agentRuns([t], "team-builder", now);
  assert.equal(r.runs.length, 4);
  assert.ok(r.runs.every((x) => x.team === "lab" && x.member === "builder"));
  assert.equal(r.runs[0].ts, "2026-09-24T01:00:00.000Z");
  assert.ok(Math.abs(r.weekUsd - 4.44) < 1e-9);
  assert.equal(agentRuns([t], "nobody", now).runs.length, 0);
  assert.equal(weekUsd(t.runs, now), 13.44);
});

test("pickNode: asked, then needs by link, saved, needs, first team, first agent, needs", async () => {
  const teams = await all();
  const tree = workspaceTree(teams, AGENTS, { query: "", folded: new Set() });
  const o = { saved: null, via: "rail" as const, asked: null, gates: 0, tree };
  assert.equal(pickNode({ ...o, asked: "team:ops", saved: "team:lab", via: "link", gates: 2 }), "team:ops");
  assert.equal(pickNode({ ...o, asked: "team:gone", saved: "team:lab", via: "link", gates: 2 }), "needs");
  assert.equal(pickNode({ ...o, saved: "team:lab", via: "link", gates: 2 }), "needs");
  assert.equal(pickNode({ ...o, saved: "team:lab", gates: 2 }), "team:lab");
  assert.equal(pickNode({ ...o, saved: "team:gone", gates: 2 }), "needs");
  assert.equal(pickNode({ ...o, saved: "team:gone" }), "team:lab");
  assert.equal(pickNode(o), "team:lab");
  const onlyBroken = workspaceTree([{ ...teams.find((x) => x.id === "lab")!, error: "bad" }], emptyAgents(), { query: "", folded: new Set() });
  assert.equal(pickNode({ ...o, tree: onlyBroken }), "team:lab");
  const noTeams = workspaceTree([], AGENTS, { query: "", folded: new Set() });
  assert.equal(pickNode({ ...o, tree: noTeams }), "agent:team-lead");
  assert.equal(pickNode({ ...o, tree: workspaceTree([], emptyAgents(), { query: "", folded: new Set() }) }), "needs");
});

test("paneNode (the tour's route, D18): the selected node when it fits, else the first team or agent in the tree", async () => {
  const teams = await all();
  const tree = workspaceTree(teams, AGENTS, { query: "", folded: new Set() });
  assert.equal(paneNode("needs", "team:ops", tree), "needs");
  assert.equal(paneNode("team", "team:ops", tree), "team:ops", "the team the user is on stays");
  assert.equal(paneNode("team", "agent:solo", tree), "team:lab", "else the first team");
  assert.equal(paneNode("team", null, tree), "team:lab");
  assert.equal(paneNode("agent", "agent:solo", tree), "agent:solo", "the agent the user is on stays");
  assert.equal(paneNode("agent", "member:lab/reviewer", tree), "member:lab/reviewer", "a member without an agent shows its seat");
  assert.equal(paneNode("agent", "team:lab", tree), "agent:team-lead", "else the first agent: the first team's lead");
  assert.equal(paneNode("team", "team:gone", tree), "team:lab", "a selection gone from the tree does not count");
  const onlyBroken = workspaceTree([{ ...teams.find((x) => x.id === "lab")!, error: "bad" }], emptyAgents(), { query: "", folded: new Set() });
  assert.equal(paneNode("team", null, onlyBroken), "team:lab", "a broken team when every team is");
  const empty = workspaceTree([], emptyAgents(), { query: "", folded: new Set() });
  assert.equal(paneNode("team", null, empty), null);
  assert.equal(paneNode("agent", null, empty), null);
  assert.deepEqual(["needs", "team", "agent", "files", null].map(isWorkspacePane), [true, true, true, false, false]);
});
