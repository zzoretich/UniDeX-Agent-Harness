import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  TEAM_CLI, LIST_ARGS, teamRunner, approveArgs, budgetArgs, pauseArgs, setArgs, addMemberArgs, removeMemberArgs, postArgs,
  presetsOf, teamFailure, modelChoices, ignoredModel, ListJson, Presets,
} from "./teamWriter";
import { Team, readTeams, budgetFloor, diskAdapter } from "./teams";
import type { AosResult } from "./aosRun";

// The writes run the real brain/scripts/team.js (spec 2026-09-28-agent-teams-design D3) against a copy of the fixture
// vault that teams.test.ts shares with lib/teams.js, and the tab's own reader checks what landed.
const FIXTURE = path.resolve(__dirname, "fixtures/teams-vault");
const CLI = path.resolve(__dirname, "../../../brain/scripts/team.js");

function world() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aos-teams-hud-"));
  const vault = path.join(base, "vault");
  // The fixture's board ends in a torn tail (a crash mid-append): the CLI's rows must land on lines of their own.
  fs.cpSync(FIXTURE, vault, { recursive: true });
  const configDir = path.join(base, "claude");
  fs.mkdirSync(path.join(configDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "agents", "team-scout.md"), "---\nname: team-scout\ndescription: Looks ahead.\n---\nScout.\n");
  const env = { CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: path.join(base, "codex") };
  const runner = teamRunner({ node: process.execPath, vault, configDir, cli: CLI, env });
  const team = async (id: string): Promise<Team> => (await readTeams(diskAdapter(vault))).find((t) => t.id === id)!;
  const item = async (id: string, itemId: string) => (await team(id)).board.find((i) => i.id === itemId)!;
  return { vault, runner, team, item };
}

const ok = (r: AosResult) => assert.equal(r.code, 0, r.stderr);

test("argument builders: --expect is the rendered row's ts, a note is addressed to the lead as one argv entry", () => {
  const it = { id: "site-01", ts: "2026-09-20T12:45:00.000Z", raw: {} } as never;
  assert.deepEqual(approveArgs("lab", it), ["gate", "approve", "lab", "site-01", "--expect", '{"ts":"2026-09-20T12:45:00.000Z"}']);
  assert.deepEqual(approveArgs("lab", it, 40).slice(-2), ["--usd", "40"]);
  assert.deepEqual(budgetArgs("lab", it, 12.5), ["budget", "lab", "site-01", "12.5", "--expect", '{"ts":"2026-09-20T12:45:00.000Z"}']);
  assert.deepEqual([pauseArgs("lab", true), pauseArgs("lab", false, "builder")], [["pause", "lab"], ["resume", "lab", "builder"]]);
  assert.deepEqual(setArgs("lab", "builder", "effort", "low"), ["set", "lab", "builder", "effort", "low"]);
  assert.deepEqual([addMemberArgs("lab", "team-scout"), removeMemberArgs("lab", "scout")], [["member", "add", "lab", "team-scout"], ["member", "remove", "lab", "scout"]]);
  assert.deepEqual(postArgs("lab", "lead", "  --detach costs $20  "), ["post", "lab", "--from", "user", "--kind", "note", "@lead --detach costs $20"]);
  assert.deepEqual(postArgs("lab", "lead", "@lead already addressed")?.slice(-1), ["@lead already addressed"]);
  assert.deepEqual(postArgs("lab", "lead", "@leader is not the lead")?.slice(-1), ["@lead @leader is not the lead"]);
  assert.equal(postArgs("lab", "lead", "   "), null);
  assert.equal(TEAM_CLI, "brain/scripts/team.js");
});

test("failures: the CLI's own reason, a stale card said plainly, a missing runtime asks for an upgrade", () => {
  const r = (stderr: string, extra: Partial<AosResult> = {}): AosResult => ({ code: 1, stdout: "", stderr, timedOut: false, ...extra });
  assert.deepEqual(teamFailure(r("team: found a killed run: b on x (r); recorded it and posted a blocker\nteam: refused: no gate is pending on x (it is plan/working)\n")),
    { text: "no gate is pending on x (it is plan/working)", stale: false, upgrade: false });
  const stale = teamFailure(r('team: refused: --expect failed on site-01: ts is "2026-09-21T00:00:00.000Z"; nothing written\n'));
  assert.equal(stale.stale, true);
  assert.match(stale.text, /^site-01 changed after this view was drawn, so nothing was written/);
  assert.deepEqual(teamFailure(r("team: effort must be one of inherit, low, medium, high\nusage: aos team list [--json]\n", { code: 2 })).text, "effort must be one of inherit, low, medium, high");
  assert.equal(teamFailure(r("Error: Cannot find module '/v/brain/scripts/team.js'\n")).upgrade, true);
  assert.equal(teamFailure(r("", { timedOut: true, code: -1 })).text, "aos team did not answer in time");
  assert.equal(teamFailure(r("", { error: "spawn node ENOENT", code: -1 })).text, "could not run aos team: spawn node ENOENT");
  assert.equal(teamFailure(r("")).text, "aos team exited 1");
});

test("list --json through the runner: an unreadable team is a row, and the presets come back", async () => {
  const w = world();
  const r = await w.runner.json<ListJson>(LIST_ARGS);
  ok(r);
  assert.deepEqual(r.json?.teams.map((t) => [t.team, !!t.error]), [["broken", true], ["lab", false], ["ops", false]]);
  const p = presetsOf(r.json);
  assert.deepEqual([p?.provider, p?.effort], [["claude", "codex", "opposite"], ["inherit", "low", "medium", "high"]]);
  assert.ok(p?.model.includes("inherit"));
  assert.ok(p?.models && p.models.claude.includes("claude-sonnet-5") && !p.models.codex.includes("claude-sonnet-5"));
  assert.equal(presetsOf({ schema: 1, teams: [] }), null, "an older runtime sends no presets");
});

test("a seat's model picker offers what its provider runs, and says when a set model is ignored", () => {
  const p: Presets = { provider: ["claude", "codex", "opposite"], effort: ["inherit"], model: ["inherit", "sonnet", "claude-sonnet-5", "gpt-5.5"],
    models: { claude: ["sonnet", "claude-sonnet-5"], codex: ["gpt-5.5"] } };
  assert.deepEqual(modelChoices(p, "claude"), ["inherit", "sonnet", "claude-sonnet-5"]);
  assert.deepEqual(modelChoices(p, "codex"), ["inherit", "gpt-5.5"]);
  assert.deepEqual(modelChoices(p, "opposite"), p.model);
  assert.deepEqual(modelChoices({ ...p, models: null }, "codex"), p.model, "an older runtime: every preset");
  assert.equal(ignoredModel(p, "codex", "claude-sonnet-5"), "not a Codex model: the Codex default runs");
  assert.equal(ignoredModel(p, "claude", "gpt-5.5"), "not a Claude model: the Claude Code default runs");
  assert.equal(ignoredModel(p, "codex", "gpt-5.5"), null);
  assert.equal(ignoredModel(p, "opposite", "gpt-5.5"), null);
  assert.equal(ignoredModel(p, "codex", "inherit"), null);
});

test("approve a budget gate from the card: the item moves on with the budget picked, and the old card is refused", async () => {
  const w = world();
  assert.equal((await w.team("lab")).torn, true, "the board starts with a torn tail");
  const seen = await w.item("lab", "site-01");
  ok(await w.runner.run(approveArgs("lab", seen, 25)));
  const now = await w.item("lab", "site-01");
  assert.deepEqual([now.stage, now.status, now.owners, now.gate?.state, now.gate?.by, now.budget.usd], ["plan", "working", ["lead"], "approved", "user", 25]);
  assert.match((await w.team("lab")).channel.pop()?.text ?? "", /^Discuss gate approved by the user at \$25; @lead takes the next step/);
  assert.equal((await w.team("lab")).skipped, 3, "the torn fragment is now a skipped line, and the approval is not lost with it");
  const again = await w.runner.run(approveArgs("lab", seen, 25));
  assert.equal(JSON.parse(approveArgs("lab", seen, 25)[5]).title, "Landing page", "--expect is the whole snapshot the card showed");
  assert.equal(again.code, 1);
  assert.equal(teamFailure(again).stale, true);
});

test("approve a gate that takes no budget; a budget below spend plus live holds is refused with the CLI's reason", async () => {
  const w = world();
  ok(await w.runner.run(approveArgs("ops", await w.item("ops", "rel-01"))));
  assert.equal((await w.item("ops", "rel-01")).gate?.state, "approved");
  const lab = await w.team("lab");
  const busy = lab.board.find((i) => i.id === "site-02")!;
  assert.equal(budgetFloor(lab, busy), 14.7);
  const low = await w.runner.run(budgetArgs("lab", busy, 10));
  assert.equal(low.code, 1);
  assert.match(teamFailure(low).text, /cannot go below \$14\.7/);
  ok(await w.runner.run(budgetArgs("lab", busy, 40)));
  assert.equal((await w.item("lab", "site-02")).budget.usd, 40);
});

test("manage: pause and resume, set a preset, refuse a value off the list, add and remove members", async () => {
  const w = world();
  ok(await w.runner.run(pauseArgs("lab", true, "builder")));
  assert.equal((await w.team("lab")).members.find((m) => m.id === "builder")?.paused, true);
  ok(await w.runner.run(pauseArgs("lab", false, "builder")));
  assert.equal((await w.team("lab")).members.find((m) => m.id === "builder")?.paused, false);
  ok(await w.runner.run(pauseArgs("ops", false)));
  assert.equal((await w.team("ops")).disabled, false);

  ok(await w.runner.run(setArgs("lab", "builder", "effort", "low")));
  assert.equal((await w.team("lab")).members.find((m) => m.id === "builder")?.effort, "low");
  const bad = await w.runner.run(setArgs("lab", "builder", "effort", "extreme"));
  assert.equal(bad.code, 2);
  assert.match(teamFailure(bad).text, /^effort must be one of/);

  ok(await w.runner.run(addMemberArgs("lab", "team-scout")));
  assert.ok((await w.team("lab")).members.some((m) => m.id === "team-scout" && m.agent === "team-scout"));
  ok(await w.runner.run(removeMemberArgs("lab", "team-scout")));
  assert.ok(!(await w.team("lab")).members.some((m) => m.id === "team-scout"));
  const busy = await w.runner.run(removeMemberArgs("lab", "reviewer"));
  assert.equal(busy.code, 1);
  assert.match(teamFailure(busy).text, /reviewer still owns site-03; reassign first/);
});

test("a snapshot that differs from the card in any field is refused, even with the same ts", async () => {
  const w = world();
  const seen = await w.item("lab", "site-01");
  const board = path.join(w.vault, "persona/teams/lab/board.jsonl");
  // Its own line: the fixture's board ends in a torn tail.
  fs.appendFileSync(board, "\n" + JSON.stringify({ ...seen.raw, title: "Changed in the same millisecond" }) + "\n");
  assert.equal((await w.item("lab", "site-01")).ts, seen.ts, "same ts, different snapshot");
  const r = await w.runner.run(approveArgs("lab", seen, 25));
  assert.equal(r.code, 1);
  assert.equal(teamFailure(r).stale, true);
  assert.equal((await w.item("lab", "site-01")).gate?.state, "pending");
});

test("a note to the lead lands in the channel as the user's, dollar signs intact", async () => {
  const w = world();
  ok(await w.runner.run(postArgs("lab", "lead", "can we keep site-02 under $40?")!));
  const last = (await w.team("lab")).channel.pop();
  assert.deepEqual([last?.from, last?.kind, last?.text], ["user", "note", "@lead can we keep site-02 under $40?"]);
});
