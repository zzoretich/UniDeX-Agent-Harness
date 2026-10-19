import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import {
  TEAMS_DIR, Team, TeamsAdapter, readTeams, teamFrom, parseJsonl, parseFrontmatter, memberStatus, pendingGates, gateBadge,
  orderTeams, boardColumns, gateCards, isBudgetGate, budgetFloor, budgetPresets, budgetPick, stepBudget, splitMentions, sessionCommand,
  redirectPrompt, nextStepPrompt, teamCommand, expectOf, channelView, touchesTeams, usd, shq, gatePitch, MAX_BUDGET_USD, diskAdapter,
} from "./teams";
import { parseAgents } from "./agents";
import { touchesBadges } from "./badges";

// The fixture vault is read by both sides (spec 2026-09-28-agent-teams-design §6): this module and brain/scripts/lib/teams.js.
const VAULT = path.resolve(__dirname, "fixtures/teams-vault");
const REPO = path.resolve(__dirname, "../../..");
const store = createRequire(__filename)(path.join(REPO, "brain/scripts/lib/teams.js"));
const ROOT = store.teamsRoot(VAULT);

/** The tab reads the fixture vault through the same disk adapter it uses at the plugin's vault root. */
const fsAdapter = (vault: string): TeamsAdapter => diskAdapter(vault);

let cached: Team[] | null = null;
async function teams(): Promise<Team[]> { return (cached ??= await readTeams(fsAdapter(VAULT))); }
async function team(id: string): Promise<Team> { const t = (await teams()).find((x) => x.id === id); assert.ok(t, `no team ${id}`); return t; }

test("the same teams as the runtime's listTeams: folders with a TEAM.md and a valid id", async () => {
  assert.deepEqual((await teams()).map((t) => t.id), store.listTeams(ROOT));
  assert.deepEqual(store.listTeams(ROOT), ["broken", "lab", "ops"]);
});

test("each team parses to the runtime's roster, stages, gates and state", async () => {
  for (const id of ["lab", "ops"]) {
    const t = await team(id);
    const js = store.readTeam(ROOT, id);
    assert.equal(t.error, null);
    assert.deepEqual([t.name, t.lead, t.reportsTo, t.parent, t.disabled], [js.name, js.lead, js.reportsTo ?? null, js.parent ?? null, js.disabled]);
    assert.deepEqual(t.stages, js.stages);
    assert.deepEqual(t.gates, js.gates);
    assert.deepEqual(t.members.map((m) => [m.id, m.name, m.role, m.agent, m.provider, m.model, m.effort, m.stage, m.paused]),
      js.members.map((m: Record<string, unknown>) => [m.id, m.name, m.role, m.agent, m.provider, m.model, m.effort, [].concat((m.stage ?? []) as never), !!m.paused]));
    assert.deepEqual(t.state, store.readState(js));
  }
  const lab = await team("lab");
  assert.equal(lab.members[0].id, "lead");
  assert.equal((store.readTeam(ROOT, "lab").members[1] as { voice: string }).voice, "Practical; shows the commit range, and it's brief.");
  assert.equal(lab.state.length, 3);
  assert.equal(lab.budgetDefault, 10);
});

test("the board is the runtime's: the last snapshot per id, in first-seen order; bad lines skipped, the torn tail left out", async () => {
  for (const id of ["lab", "ops"]) {
    const t = await team(id);
    assert.deepEqual(t.board.map((i) => i.raw), [...store.boardItems(store.readTeam(ROOT, id)).values()]);
  }
  const lab = await team("lab");
  assert.deepEqual(lab.board.map((i) => i.id), ["site-00", "site-01", "site-02", "site-03"]);
  assert.equal(lab.skipped, 2);   // one hand-edited board line, one channel line
  assert.equal(lab.torn, true);   // site-04's append is still in flight
  assert.deepEqual(lab.board[2].owners, ["builder"]);
});

test("the channel, member status, pending gates and live markers match the runtime", async () => {
  for (const id of ["lab", "ops"]) {
    const t = await team(id);
    const js = store.readTeam(ROOT, id);
    assert.deepEqual(t.channel.map((p) => [p.ts, p.from, p.item, p.kind, p.text]),
      store.tail(js, { n: 1000 }).map((r: Record<string, unknown>) => [r.ts, r.from, r.item, r.kind, r.text]));
    assert.deepEqual(memberStatus(t).map((m) => [m.id, m.lead, m.status, m.item, m.lastRun]), store.memberStatus(js).map((m: Record<string, unknown>) => [m.id, m.lead, m.status, m.item, m.lastRun]));
    assert.deepEqual(pendingGates(t).map((i) => i.id), store.pendingGates(js).map((i: { id: string }) => i.id));
    assert.deepEqual(t.live.map((m) => m.run), store.liveMarkers(js).map((m: { run: string }) => m.run));
  }
  const s = memberStatus(await team("lab"));
  assert.deepEqual(s.map((m) => [m.id, m.status, m.item]), [["lead", "idle", "site-01"], ["builder", "working", "site-02"], ["reviewer", "blocked", "site-03"]]);
  assert.equal(s[2].lastRun?.status, "killed");
  assert.ok(memberStatus(await team("ops")).every((m) => m.status === "paused"), "a disabled team's members are all paused");
});

test("a TEAM.md the subset refuses is a team with its error, as the runtime refuses it", async () => {
  const b = await team("broken");
  assert.match(b.error ?? "", /unsupported TEAM\.md line: - one/);
  assert.equal(b.errorFile, "TEAM.md");
  assert.throws(() => store.readTeam(ROOT, "broken"), /unsupported TEAM\.md line: - one/);
  assert.deepEqual([b.members, b.board], [[], []]);
  assert.throws(() => parseFrontmatter("no frontmatter"), /no frontmatter/);
});

test("a file that exists but cannot be read is an error or a warning, never an empty file", async () => {
  const failing = (bad: RegExp): TeamsAdapter => {
    const a = fsAdapter(VAULT);
    return { ...a, async read(p) { if (bad.test(p)) throw new Error("EACCES: permission denied"); return a.read(p); } };
  };
  const board = (await readTeams(failing(/lab\/board\.jsonl$/))).find((t) => t.id === "lab")!;
  assert.deepEqual([board.errorFile, board.error], ["board.jsonl", "could not be read: EACCES: permission denied"]);
  assert.equal(gateBadge([board]), 0, "its gates are unknown, and the tab says why");
  const md = (await readTeams(failing(/ops\/TEAM\.md$/))).find((t) => t.id === "ops")!;
  assert.deepEqual([md.errorFile, md.error], ["TEAM.md", "could not be read: EACCES: permission denied"]);
  assert.equal(md.disabled, true);
  const ch = (await readTeams(failing(/lab\/(channel\.jsonl|running\/lab-site-02-builder-c\.json)$/))).find((t) => t.id === "lab")!;
  assert.equal(ch.error, null);
  assert.deepEqual(ch.warnings, ["lab-site-02-builder-c.json could not be read: EACCES: permission denied", "channel.jsonl could not be read: EACCES: permission denied"]);
  assert.equal(ch.board.length, 4, "the board still reads");
  const unlisted = { ...fsAdapter(VAULT), async list(): Promise<{ files: string[]; folders: string[] }> { throw new Error("EIO"); } };
  await assert.rejects(readTeams(unlisted), /EIO/);
  const none = { ...fsAdapter(VAULT), async exists() { return false; } };
  assert.deepEqual(await readTeams(none), []);
});

test("the disk adapter: a symlinked team folder is a team, a missing path is not there, any other error is thrown", async () => {
  const base = fs.mkdtempSync(path.join(require("os").tmpdir(), "aos-teams-disk-"));
  fs.cpSync(VAULT, path.join(base, "v"), { recursive: true });
  fs.symlinkSync(path.join(base, "v", "persona/teams/lab"), path.join(base, "v", "persona/teams/mirror"));
  const a = diskAdapter(path.join(base, "v"));
  assert.deepEqual((await readTeams(a)).map((t) => t.id), ["broken", "lab", "mirror", "ops"]);
  assert.equal(await a.exists("persona/teams/nope/TEAM.md"), false);
  fs.writeFileSync(path.join(base, "file"), "x");
  await assert.rejects(diskAdapter(path.join(base, "file")).exists("persona/teams"), /ENOTDIR/, "a path under a file is an error, not missing");
  assert.deepEqual(await readTeams(diskAdapter(path.join(base, "none"))), [], "no persona/teams: no teams");
});

test("JSONL: a complete last row without a newline is read; an unparsable one is torn, not skipped", () => {
  assert.deepEqual(parseJsonl('{"a":1}\n{"b":2}'), { rows: [{ a: 1 }, { b: 2 }], skipped: 0, torn: false });
  assert.deepEqual(parseJsonl('{"a":1}\nnope\n[1]\n{"b"'), { rows: [{ a: 1 }], skipped: 2, torn: true });
  assert.deepEqual(parseJsonl(null), { rows: [], skipped: 0, torn: false });
});

test("the badge counts pending gates across readable teams, a disabled team's included", async () => {
  assert.equal(gateBadge(await teams()), 3);
  assert.equal(gateBadge(await readTeams(fsAdapter(VAULT), { boardOnly: true })), 3);
  const board = (await readTeams(fsAdapter(VAULT), { boardOnly: true })).find((t) => t.id === "lab");
  assert.deepEqual([board?.channel.length, board?.live.length, board?.runs.length], [0, 0, 0]);
});

test("teams are listed parent first, children indented; a parent cycle still lists every team", async () => {
  assert.deepEqual(orderTeams(await teams()).map((x) => [x.team.id, x.depth]), [["broken", 0], ["lab", 0], ["ops", 1]]);
  const a = teamFrom({ id: "a", teamMd: "---\nparent: b\n---\n", board: null, channel: null, runs: null, markers: [], state: null, disabled: false });
  const b = teamFrom({ id: "b", teamMd: "---\nparent: a\n---\n", board: null, channel: null, runs: null, markers: [], state: null, disabled: false });
  assert.deepEqual(orderTeams([a, b]).map((x) => x.team.id), ["a", "b"]);
});

test("gate cards: longest waiting first, since the gate first went pending, with the lead's pitch and the budget gate", async () => {
  const cards = gateCards(await teams());
  assert.deepEqual(cards.map((c) => [c.team.id, c.item.id, c.since, c.budget]), [
    ["lab", "site-01", "2026-09-20T12:00:00.000Z", true],
    ["ops", "rel-01", "2026-09-21T08:00:00.000Z", false],
    ["ops", "rel-02", "2026-09-21T09:00:00.000Z", true],
  ]);
  assert.match(cards[0].pitch?.text ?? "", /I propose \$20/);
  assert.equal(isBudgetGate(await team("ops"), cards[2].item), true, "ops funds work at its own first stage, plan");
});

test("budgets: presets are half, the proposal and double; the floor is spend plus what live Claude runs hold", async () => {
  assert.deepEqual(budgetPresets(20), [10, 20, 40]);
  assert.deepEqual(budgetPresets(25), [13, 25, 50]);
  assert.deepEqual(budgetPresets(0, 5), [3, 5, 10]);
  assert.deepEqual(budgetPresets(0, 0), [5, 10, 20]);
  assert.deepEqual(budgetPresets(0.01), [0.01, 1], "a tiny proposal: never a $0 choice");
  const lab = await team("lab");
  assert.equal(budgetFloor(lab, lab.board.find((i) => i.id === "site-02")!), 14.7);
  assert.equal(budgetFloor(lab, lab.board.find((i) => i.id === "site-01")!), 3.44);
  const frac = { ...lab.board[1], budget: { usd: 20, spentUsd: 3.4435, codexRuns: 0 } };
  assert.equal(budgetFloor(lab, frac), 3.45, "spend recorded past the cent: the floor rounds up, as the CLI compares exactly");
  assert.equal(stepBudget(20, 1, [10, 20, 40], 3.44), 25);
  assert.equal(stepBudget(20, -1, [10, 20, 40], 3.44), 15);
  assert.equal(stepBudget(5, -1, [10, 20, 40], 3.44), null);
  assert.equal(stepBudget(10000, 1, [10, 20, 40], 0), null, "the CLI's maximum is the top");
  assert.equal(stepBudget(13, 1, [13, 25, 50], 0), 15);
  assert.equal(stepBudget(1000, 1, [1000], 0), 1250, "past $1,000 the ladder goes on to the CLI's maximum");
  assert.equal(stepBudget(7500, 1, [], 0), 10000);
});

test("budgets stay inside what the CLI takes: nothing above $10,000, and no amount at all when the floor is past it", () => {
  assert.equal(MAX_BUDGET_USD, 10000);
  assert.deepEqual(budgetPresets(6000), [3000, 6000], "double $6,000 is over the cap");
  assert.equal(stepBudget(6000, 1, [3000, 6000], 0), 7500);
  assert.equal(stepBudget(10000, 1, [3000, 6000], 0), null);
  assert.equal(budgetPick(20, [10, 20, 40], 3.44), 20);
  assert.equal(budgetPick(20, [10, 20, 40], 30), 40, "below the floor: the next preset up");
  assert.equal(budgetPick(20, [10, 20, 40], 55.5), 55.5, "past every preset: the floor itself");
  assert.equal(budgetPick(12000, [3000, 6000], 0), 3000);
  assert.equal(budgetPick(20, [], 12000), null, "spent past the cap: nothing can be approved");
});

test("the pitch is the team's case for the gate now pending, never an earlier gate's", () => {
  const md = "---\nid: t\nlead: lead\ngates: [discuss, ship]\nmembers:\n  - id: lead\n  - id: builder\n---\n";
  const row = (ts: string, gate: object | null, status = "gate") => JSON.stringify({ id: "x-01", ts, stage: gate ? "verify" : "plan", status, gate });
  const post = (ts: string, from: string, text: string) => JSON.stringify({ ts, from, item: "x-01", kind: "gate", text });
  const board = [
    row("2026-09-20T10:00:00.000Z", { name: "discuss", state: "pending" }),
    row("2026-09-20T11:00:00.000Z", { name: "discuss", state: "approved", by: "user" }, "working"),
    row("2026-09-21T09:00:00.000Z", { name: "ship", state: "pending" }),
  ].join("\n") + "\n";
  const early = [post("2026-09-20T10:01:00.000Z", "lead", "Discuss gate: I propose $20."), post("2026-09-20T11:00:00.000Z", "user", "Discuss gate approved by the user")];
  const team = (posts: string[]) => teamFrom({ id: "t", teamMd: md, board, channel: posts.join("\n") + "\n", runs: null, markers: [], state: null, disabled: false });
  assert.equal(gatePitch(team(early), "x-01"), null, "only the old Discuss proposal: no pitch for the Ship gate");
  const t = team([...early, post("2026-09-21T08:59:00.000Z", "lead", "Ship gate: verified, ready."), post("2026-09-21T09:05:00.000Z", "dispatch", "not a member"),
    post("2026-09-21T09:10:00.000Z", "builder", "a seat's gate note")]);
  assert.equal(gatePitch(t, "x-01")?.text, "Ship gate: verified, ready.", "the lead's post, even with a seat's later one, and one just before the gate row counts");
  assert.equal(t.pendingSince["x-01"], "2026-09-21T09:00:00.000Z");
});

test("the work board: one column per stage, done items apart, unknown stages in a last column", async () => {
  assert.deepEqual(boardColumns(await team("lab")).map((c) => [c.stage, c.items.map((i) => i.id), c.done.map((i) => i.id)]), [
    ["discuss", ["site-01"], []], ["plan", [], []], ["execute", ["site-02"], []], ["verify", ["site-03"], []], ["ship", [], ["site-00"]],
  ]);
  assert.deepEqual(boardColumns(await team("ops")).map((c) => c.stage), ["plan", "build", "ship", "other"]);
});

test("the channel view filters by item and keeps the last posts", async () => {
  const lab = await team("lab");
  assert.deepEqual(channelView(lab, "site-01").map((p) => p.kind), ["assign", "handoff", "gate"]);
  assert.equal(channelView(lab, null, 2).length, 2);
});

test("mentions: members and the user are known, a word@word is not a mention", () => {
  const parts = splitMentions("See notes@lead, ask @user or @builder, not @stranger.", ["lead", "builder"]);
  assert.deepEqual(parts.filter((p) => p.mention).map((p) => [p.text, p.known]), [["@user", true], ["@builder", true], ["@stranger", false]]);
  assert.equal(parts.map((p) => p.text).join(""), "See notes@lead, ask @user or @builder, not @stranger.");
});

test("session commands: the agent's run command per host, a prompt single-quoted, null where the host lacks the agent", async () => {
  const agents = parseAgents(JSON.stringify({ schema: 1, agents: [
    { id: "team-lead", name: "team-lead", on: { claude: { invoke: "@agent-team-lead", run: "claude --agent team-lead" }, codex: { invoke: "team-lead", run: "codex 'Use the team-lead agent. Ask me what it should work on.'" } } },
    { id: "team-builder", name: "team-builder", on: { claude: { invoke: "@agent-team-builder", run: "claude --agent team-builder" } } },
  ] }));
  assert.equal(sessionCommand(agents, "team-lead", "claude"), "claude --agent team-lead");
  assert.equal(sessionCommand(agents, "team-lead", "claude", "it's $20"), `claude --agent team-lead 'it'\\''s $20'`);
  assert.equal(sessionCommand(agents, "team-lead", "codex", "go"), "codex 'Use the team-lead agent for this. go'");
  assert.equal(sessionCommand(agents, "team-builder", "codex"), null);
  assert.equal(sessionCommand(agents, "nobody", "claude"), null);
  assert.equal(sessionCommand(agents, null, "claude"), null);
  assert.equal(shq("a'b"), `'a'\\''b'`);

  const lab = await team("lab");
  const it = lab.board.find((i) => i.id === "site-01")!;
  assert.deepEqual(JSON.parse(expectOf(it)), it.raw, "the whole rendered snapshot");
  assert.equal(expectOf({ ...it, raw: {} }), '{"ts":"2026-09-20T12:45:00.000Z"}');
  assert.ok(redirectPrompt(lab, it).includes(`aos team gate redirect 'lab' 'site-01' --expect ${shq(expectOf(it))} --note`));
  const stage = "review' ; touch x ; #";
  const odd = { ...it, stage, raw: { ...it.raw, stage } };
  assert.ok(redirectPrompt(lab, odd).includes(`--expect ${shq(expectOf(odd))} --note`), "an apostrophe in a stage stays inside the quotes");
  assert.ok(!redirectPrompt(lab, odd).includes(`${stage}"`), "never the raw stage text outside shq");
});

test("next step: the lead hears what the user decided, that it is recorded, and this vault's aos team line", async () => {
  const lab = await team("lab");
  const it = lab.board.find((i) => i.id === "site-01")!;
  assert.equal(nextStepPrompt(lab, it, "approved", 40),
    "The user approved the Discuss gate on site-01 (Landing page) in the lab team at $40, and it is recorded. Take the next step. "
    + "Run aos team for this vault as aos team, for example aos team item 'lab' 'site-01'.");
  const ship = { ...it, gate: { ...it.gate!, name: "ship" } };
  assert.match(nextStepPrompt(lab, ship, "approved", null), /^The user approved the Ship gate on site-01 \(Landing page\) in the lab team, and it is recorded\./, "a gate without a budget names no amount");
  assert.match(nextStepPrompt(lab, { ...it, title: "" }, "raised", 62.5), /^The user raised the budget on site-01 in the lab team to \$62\.50, and it is recorded\./);
  const cmd = teamCommand("/v/two", "/opt/node");
  assert.ok(nextStepPrompt(lab, it, "raised", 65, cmd).endsWith(`as ${cmd}, for example ${cmd} item 'lab' 'site-01'.`), "never the terminal's own aos config");
  const odd = { ...it, id: "site-01'; touch x #" };
  assert.ok(nextStepPrompt(lab, odd, "approved", 40).endsWith(`item 'lab' ${shq(odd.id)}.`), "an id reaches the shell only inside shq");
});

test("dollar amounts, and the paths a vault event must touch to refresh the tab or its badge", () => {
  assert.deepEqual([usd(3.44), usd(20), usd(125.5), usd(1000), usd(3.4435), usd(null)], ["$3.44", "$20", "$125.50", "$1000", "$3.44", "–"]);
  assert.ok(touchesTeams(TEAMS_DIR) && touchesTeams(`${TEAMS_DIR}/lab/board.jsonl`) && !touchesTeams("persona/teamsx"));
  assert.ok(touchesBadges(`${TEAMS_DIR}/lab/board.jsonl`));
});
