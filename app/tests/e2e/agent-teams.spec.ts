// Agent Teams (app-smoke: Agent Teams tab): teams written by `aos team init / put / post` — the team chips with a
// sub-team and a broken TEAM.md, Roster; with the Agent Teams surface off, a seat pick is refused. Needs you's gate
// cards (presets, Approve's cancel path and its refusal, Redirect, a new gate on the rail), the Work board and an item's
// detail (a team's Items) and Interact (its Channel) moved to agent-workspace.spec.ts. Approving, budgets, posting and
// Manage's changes themselves are in teams-writes.spec.ts. Talk opens a terminal session, checked against the stub CLI.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import { FX, badge, content, openTab, rail, useApp } from "./harness";

const app = useApp();
const C = () => content(app().win);
const chipFor = (name: string) => C().locator(".aos-at-teamchip", { hasText: name });
const view = (name: string) => C().locator(".aos-at-view", { hasText: name });

test.beforeEach(async () => { await openTab(app().win, "agent-teams"); });

test("rail: Agent Teams between Memory and Agents with a count of pending gates", async () => {
  const { win } = app();
  const ids = await win.locator(".aos-wb-railtabs .aos-wb-railbtn").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
  expect(ids.indexOf("agent-teams")).toBe(ids.indexOf("memory") + 1);
  expect(ids.indexOf("agents")).toBe(ids.indexOf("agent-teams") + 1);
  await expect(rail(win, "agent-teams").locator(".aos-wb-raillabel")).toHaveText("Agent Teams");
  await expect(badge(win, "agent-teams")).toHaveText("2");
  await expect(badge(win, "agent-teams")).not.toHaveClass(/is-urgent/);
  await expect(C().locator(".aos-rt-count")).toHaveText("2 gates waiting · 3 teams");
});

test("team chips: the broken TEAM.md has a rose !, the sub-team is indented under its parent", async () => {
  await expect(C().locator(".aos-at-teams .aos-at-teamchip")).toHaveCount(3);
  const broken = chipFor("broken");
  await expect(broken).toHaveClass(/is-broken/);
  await expect(broken.locator(".aos-at-chipmark")).toHaveText("!");
  await expect(broken).toHaveAttribute("title", /TEAM\.md: unsupported TEAM\.md line/);
  await expect(chipFor("Survey").locator(".aos-at-depth")).toHaveText("› ");
  await expect(chipFor("Example").locator(".aos-at-chipcount")).toHaveText("1");
  await expect(chipFor("Example")).toHaveClass(/is-active/);
});

test("the broken team shows an error card naming the line, with Open TEAM.md", async () => {
  await chipFor("broken").click();
  const card = C().locator(".aos-at-team .aos-st-failure");
  await expect(card).toContainText("persona/teams/broken/TEAM.md: unsupported TEAM.md line");
  await expect(card.locator("button")).toHaveText("Open TEAM.md");
  await chipFor("Example").click();
});

test("roster: members with provider pill, model and effort, status, current item, last run and Talk links", async () => {
  await chipFor("Example").click();
  await view("Roster").click();
  const rows = C().locator(".aos-at-member");
  await expect(rows.locator(".aos-at-name")).toHaveText(["Leadlead", "Builder", "Reviewer"]);
  await expect(rows.locator(".aos-at-provider")).toHaveText(["claude", "claude", "opposite"]);
  await expect(rows.nth(2).locator(".aos-at-provider")).toHaveAttribute("title", "runs on whichever provider did not build the item");
  await expect(rows.nth(1).locator(".aos-at-model")).toHaveText("inherit · high");
  await expect(rows.nth(1).locator(".aos-at-role")).toHaveText("Builds the work · agent team-builder");
  // Working needs a live run marker; an owned blocked item reads blocked; otherwise idle, with the owned item linked.
  await expect(rows.nth(1).locator(".aos-at-mstate .aos-at-chip")).toHaveText("idle");
  await expect(rows.nth(1).locator(".aos-at-itemlink")).toHaveText("harbor-02");
  await expect(rows.nth(2).locator(".aos-at-mstate .aos-at-chip")).toHaveText("blocked");
  await expect(rows.nth(2).locator(".aos-at-itemlink")).toHaveText("harbor-03");
  await expect(rows.nth(1).locator(".aos-at-last")).toContainText("ok");
  await expect(rows.nth(2).locator(".aos-at-last")).toContainText("failed");
  await expect(rows.nth(0).locator(".aos-at-last")).toHaveText("no runs yet");
  await expect(rows.nth(0).locator(".aos-at-rowacts a")).toHaveText(["❯_ claude"]);
  await expect(C().locator(".aos-rt-subhead", { hasText: "IN THE TREE" })).toBeVisible();
  await expect(C().locator(".aos-at-treerow")).toContainText(["└ Survey · lead surveylead · 2 members · 1 gate waiting"]);
});

test("a sub-team's roster names its parent and who its lead reports to", async () => {
  await chipFor("Survey").click();
  await view("Roster").click();
  await expect(C().locator(".aos-at-treerow").first()).toHaveText("part of Example");
  await expect(C().locator(".aos-at-treerow").nth(1)).toHaveText("Survey Lead reports to lead");
  await chipFor("Example").click();
});

test("manage: seat pickers, the running switch, add and remove, and no text box", async () => {
  await chipFor("Example").click();
  await view("Manage").click();
  const pane = C().locator(".aos-at-pane-manage");
  await expect(pane.locator("input[type='text'], input:not([type]), textarea")).toHaveCount(0);
  const running = pane.locator(".aos-at-manage-top .aos-at-switch");
  await expect(running).toHaveText("Team running");
  await expect(running).toHaveClass(/is-on/);
  await expect(running.locator("input[type='checkbox']")).toBeChecked();
  await expect(pane.locator(".aos-at-mrow .aos-at-name")).toHaveText(["Leadlead", "Builder", "Reviewer"]);
  await expect(pane.locator(".aos-at-mrow").first().locator("select.dropdown")).not.toHaveCount(0);
  await expect(pane.locator(".aos-at-mrow button", { hasText: "Remove" })).not.toHaveCount(0);
  // Add a member offers the agents that are not on the team.
  const add = pane.locator(".aos-at-add select option");
  await expect(add).toContainText(["pick one of your agents"]);
  const offered = await add.allTextContents();
  expect(offered.some((o) => o.startsWith("field-researcher"))).toBe(true);
  expect(offered.some((o) => o.startsWith("team-builder"))).toBe(false);
  await view("Board").click();
});

// The approve half of this test moved to agent-workspace.spec.ts (Needs you); the seat pick moves with the agent profile.
test("with the Agent Teams surface off, a seat pick is refused: the row says why, and the board, the channel and TEAM.md stay", async () => {
  const h = app();
  const dir = FX.v("persona/teams/example");
  const files = () => ["board.jsonl", "channel.jsonl", "TEAM.md"].map((f) => fs.readFileSync(`${dir}/${f}`, "utf8"));
  const before = files();
  await chipFor("Example").click();
  await view("Manage").click();
  const effort = C().locator(".aos-at-pane-manage .aos-at-mrow", { has: h.win.locator(".aos-at-name", { hasText: /^Reviewer/ }) }).locator(".aos-at-pick-effort select");
  await effort.selectOption("low");
  await expect(C().locator(".aos-at-pane-manage .aos-at-error")).toContainText("Reviewer: could not run aos team:");
  await expect.poll(async () => (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what)).toEqual([
    expect.stringMatching(/\/team\.js set example reviewer effort low$/),
  ]);
  expect(files()).toEqual(before);
  await view("Board").click();
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
