// Agent Teams (app-smoke: Agent Teams tab): the old tab's rail button, team chips with a sub-team and a broken TEAM.md,
// and the broken team's card. Everything else moved to the Agent Workspace: Needs you, a team's Items, Channel and
// Settings, and a member's roster and Manage rows, now an agent's profile (agent-workspace.spec.ts), with the writes in
// teams-writes.spec.ts. What is left here is covered there too (agent-workspace › rail…, › the tree…, › the broken
// team's pane…); the file goes when the old tab does.

import { expect, test } from "@playwright/test";
import { badge, content, openTab, rail, useApp } from "./harness";

const app = useApp();
const C = () => content(app().win);
const chipFor = (name: string) => C().locator(".aos-at-teamchip", { hasText: name });

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
