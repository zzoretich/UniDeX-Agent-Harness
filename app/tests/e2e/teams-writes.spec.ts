// Agent Teams with its write surface on (AOS_APP_WRITE=teams), the rows of app-smoke: Agent Teams tab. Every
// change is one `aos team` call (the vault's brain/scripts/team.js); the tab never writes persona/teams/ itself. The
// tests read what team.js leaves: board.jsonl and channel.jsonl (append-only), TEAM.md (rewritten line by line) and the
// DISABLED switch. A gate approval and a budget raise on a paused item open the lead in the Term, which in the fixture is
// a stub `claude` that only echoes: no seat is dispatched and no model is called.

import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, appEnv, badge, content, guardWrites, openTab, rail, terminalText, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "teams" } });

type Row = Record<string, unknown>;
const file = (rel: string) => FX.v(`persona/teams/example/${rel}`);
const read = (rel: string) => fs.readFileSync(file(rel), "utf8");
const pristine = (rel: string) => fs.readFileSync(path.join(FX.pristine, "vault", "persona", "teams", "example", rel), "utf8");
const rows = (rel: string): Row[] => read(rel).trim().split("\n").map((l) => JSON.parse(l) as Row);
const lastItem = (id: string) => rows("board.jsonl").filter((r) => r.id === id).pop()!;
const lastPost = () => rows("channel.jsonl").pop()!;
/** The lead's own write, as a dispatched lead makes it: team.js in the fixture's environment. */
function teamCli(...args: string[]): void {
  const r = spawnSync(process.execPath, [FX.v("brain/scripts/team.js"), ...args], { cwd: FX.vault, env: appEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`team.js ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
}
/** TEAM.md with one member's key set, as lib/teams.js rewriteMember writes it (the key's line in that member's block). */
function withMember(text: string, member: string, key: string, value: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `- id: ${member}`);
  const at = lines.findIndex((l, i) => i > start && new RegExp(`^\\s+${key}:`).test(l));
  lines[at] = lines[at].replace(/:.*$/, `: ${value}`);
  return lines.join("\n");
}

const C = (win: Page) => content(win);
// Needs you, a node of the Agent Workspace tree (agent-workspace D5): every pending gate card, as the old NEEDS YOU strip.
const gate = (win: Page, item: string) => C(win).locator(".aos-aw-pane[data-node='needs'] .aos-at-gate", { has: win.locator(".aos-at-itemid", { hasText: item }) });
async function needsYou(win: Page): Promise<void> {
  await C(win).locator(".aos-aw-tree .aos-aw-row[data-key='needs']").click();
  await expect(C(win).locator(".aos-aw-pane")).toHaveAttribute("data-node", "needs");
}
const view = (win: Page, name: string) => C(win).locator(".aos-at-view", { hasText: name });
const modal = (win: Page) => win.locator(".modal");
async function example(win: Page, pane: "Board" | "Roster" | "Interact" | "Manage"): Promise<void> {
  await C(win).locator(".aos-at-teamchip", { hasText: "Example" }).click();
  await view(win, pane).click();
}
const memberRow = (win: Page, name: string) => C(win).locator(".aos-at-pane-manage .aos-at-mrow", { has: win.locator(".aos-at-name", { hasText: new RegExp(`^${name}`) }) });

/**
 * Holds back what would redraw the tab from disk, so it keeps drawing what it last read (another writer's change has not
 * arrived): the vault's events, the tab's own 30-second clock, which once redrew the card between the lead's write and
 * the click and let the approve through, and every re-read queued through its schedule(): a pending one is dropped, and
 * the one the `aos team list` sweep asks for when it ends is held. That sweep starts when a test before this one mounts
 * the tab, and on a slow runner it ended after the lead's write, so the card was redrawn and the approve went through
 * (twice in CI). Released, the tab is mounted again (its clock restarts and it re-reads).
 */
async function holdEvents(win: Page, hold: boolean): Promise<void> {
  await win.evaluate((on) => {
    type Tab = {
      tick: number | null; refreshDebounce: number | null; host: HTMLElement; schedule?: () => void;
      mount(h: HTMLElement): void; unmount(): void;
    };
    const host = (window as unknown as { aosHost: { app: { vault: Record<string, unknown>; workspace: { getLeavesOfType(t: string): Array<{ view: { getTab(id: string): Tab | null } }> } } } }).aosHost;
    const v = host.app.vault;
    const tab = host.app.workspace.getLeavesOfType("agentic-os-workbench")[0]?.view.getTab("agent-teams");
    if (on) {
      v.__trigger = v.trigger; v.trigger = () => undefined;
      if (tab?.tick != null) { window.clearInterval(tab.tick); tab.tick = null; }
      if (tab?.refreshDebounce != null) { window.clearTimeout(tab.refreshDebounce); tab.refreshDebounce = null; }
      if (tab) tab.schedule = () => undefined;   // shadows the class's method until released
    } else {
      v.trigger = v.__trigger; delete v.__trigger;
      if (tab) { delete tab.schedule; tab.unmount(); tab.mount(tab.host); }
    }
  }, hold);
}

test.beforeEach(async () => { await openTab(app().win, "agent-teams"); });

test.afterEach(async () => {
  // Every change goes through team.js: nothing is written by the tab, and every spawn it made ran.
  expect(await guardWrites(app())).toEqual([]);
  expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
});

test("Agent Teams is the one surface on: the status bar names it and what it may run", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Agent Teams");
  await expect(mode).toHaveAttribute("title", /^Agent Teams: team\.js\n/);
});

test("an approve drawn before the lead changed the item is refused by --expect: nothing is recorded, and the card catches up (AT3)", async () => {
  const { win } = app();
  await needsYou(win);
  await expect(gate(win, "harbor-01").locator(".aos-at-itemtitle")).toHaveText("Tide table parser");
  await holdEvents(win, true);
  try {
    teamCli("put", "example", "--from", "lead", JSON.stringify({ id: "harbor-01", title: "Tide table parser (v2)" }));
    const board = read("board.jsonl");
    const channel = read("channel.jsonl");
    await gate(win, "harbor-01").locator(".aos-at-approve").click();
    await modal(win).locator("button.mod-cta", { hasText: "Approve" }).click();
    await expect(gate(win, "harbor-01").locator(".aos-at-error")).toHaveText("harbor-01 changed after this view was drawn, so nothing was written. The tab now shows it as it is.");
    expect(read("board.jsonl")).toBe(board);
    expect(read("channel.jsonl")).toBe(channel);
    await expect(gate(win, "harbor-01").locator(".aos-at-itemtitle")).toHaveText("Tide table parser (v2)");
    await expect(rail(win, "agent-teams")).toHaveClass(/is-active/);
  } finally {
    await holdEvents(win, false);
  }
});

test("Approve records the decision on the board and in the channel, and opens the lead in Code (AT3)", async () => {
  const { win } = app();
  await needsYou(win);
  await expect(badge(win, "agent-teams")).toHaveText("2");
  await gate(win, "harbor-01").locator(".aos-at-approve", { hasText: "Approve · $10" }).click();
  await expect(modal(win).locator("h3")).toHaveText("Approve the Discuss gate on harbor-01?");
  await modal(win).locator("button.mod-cta", { hasText: "Approve" }).click();
  await expect(win.locator(".notice-container")).toContainText("discuss gate approved on harbor-01: now plan/working with lead");
  expect(lastItem("harbor-01")).toMatchObject({
    stage: "plan", status: "working", owner: "lead", by: "user",
    gate: { name: "discuss", state: "approved", by: "user", note: "" }, budget: { usd: 10, spentUsd: 6 },
  });
  expect(lastPost()).toMatchObject({ from: "user", item: "harbor-01", kind: "gate", text: "Discuss gate approved by the user at $10; @lead takes the next step" });
  // The lead's next step starts in a Term session: the fixture's claude is a stub that echoes.
  await expect(rail(win, "term")).toHaveClass(/is-active/);
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture claude stub] --agent team-lead");
  await openTab(win, "agent-teams");
  await expect(gate(win, "harbor-01")).toHaveCount(0);
  await expect(badge(win, "agent-teams")).toHaveText("1");
});

test("an item's budget: Set to $X records the new total; on a paused item work resumes and the lead opens (AT5)", async () => {
  const { win } = app();
  await example(win, "Board");
  await C(win).locator(".aos-at-card", { hasText: "harbor-04" }).click();
  const budget = C(win).locator(".aos-at-detail .aos-at-budget");
  await budget.locator(".aos-at-step", { hasText: "+" }).click();
  const apply = budget.locator("button.aos-at-btn");
  await expect(apply).toHaveText(/^Set to \$\d+$/);
  const usd = Number((await apply.textContent())!.replace(/^Set to \$/, ""));
  expect(usd).toBeGreaterThan(10);
  await apply.click();
  await expect(win.locator(".notice-container")).toContainText(`harbor-04's budget is now $${usd} (spent $0)`);
  expect(lastItem("harbor-04")).toMatchObject({ status: "working", budget: { usd }, by: "user" });
  expect(lastPost()).toMatchObject({ from: "user", item: "harbor-04", kind: "note", text: `Budget for harbor-04 set to $${usd} by the user; @lead takes the next step` });
  await expect(rail(win, "term")).toHaveClass(/is-active/);
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture claude stub] --agent team-lead");
});

test("Interact: Enter posts to the lead; Shift+Enter adds a line; the draft survives a view switch (AT7)", async () => {
  const { win } = app();
  await example(win, "Interact");
  const box = C(win).locator("textarea.aos-at-msg");
  await box.fill("Check the tide cache first");
  await box.press("Enter");
  await expect(win.locator(".notice-container")).toContainText("posted note as user");
  expect(lastPost()).toMatchObject({ from: "user", kind: "note", text: "@lead Check the tide cache first" });
  await expect(box).toHaveValue("");

  const posts = read("channel.jsonl");
  await box.fill("line one");
  await box.press("Shift+Enter");
  await box.pressSequentially("line two");
  await expect(box).toHaveValue("line one\nline two");
  expect(read("channel.jsonl")).toBe(posts);
  await view(win, "Board").click();
  await view(win, "Interact").click();
  await expect(C(win).locator("textarea.aos-at-msg")).toHaveValue("line one\nline two");
  await C(win).locator(".aos-at-send").click();
  await expect.poll(() => lastPost().text).toBe("@lead line one\nline two");
});

test("Manage: an effort pick rewrites its TEAM.md line, and picking it back restores the file byte for byte (AT8)", async () => {
  const { win } = app();
  await example(win, "Manage");
  const effort = memberRow(win, "Reviewer").locator(".aos-at-pick-effort select");
  await expect(effort).toHaveValue("high");
  await effort.selectOption("low");
  await expect(win.locator(".notice-container")).toContainText("reviewer on example: effort is now low");
  await expect.poll(() => read("TEAM.md")).toBe(withMember(pristine("TEAM.md"), "reviewer", "effort", "low"));
  await expect(memberRow(win, "Reviewer").locator(".aos-at-pick-effort select")).toHaveValue("low");
  await memberRow(win, "Reviewer").locator(".aos-at-pick-effort select").selectOption("high");
  await expect.poll(() => read("TEAM.md")).toBe(pristine("TEAM.md"));
});

test("Manage: a member's switch pauses and resumes it; the team switch writes DISABLED and Resume removes it (AT8)", async () => {
  const { win } = app();
  await example(win, "Manage");
  await memberRow(win, "Builder").locator(".aos-at-switch input").uncheck();
  await expect.poll(() => read("TEAM.md")).toBe(withMember(pristine("TEAM.md"), "builder", "paused", "true"));
  await expect(memberRow(win, "Builder")).toHaveClass(/is-off/);
  await memberRow(win, "Builder").locator(".aos-at-switch input").check();
  await expect.poll(() => read("TEAM.md")).toBe(pristine("TEAM.md"));

  const running = C(win).locator(".aos-at-manage-top .aos-at-switch");
  await running.locator("input").uncheck();
  await expect.poll(() => fs.existsSync(file("DISABLED")) ? read("DISABLED") : null).toBe("Paused from aos team pause. Delete this file, or run aos team resume, to resume.\n");
  const banner = C(win).locator(".aos-at-paused");
  await expect(banner).toContainText("This team is paused: no seat can be dispatched until it resumes.");
  await banner.locator("button", { hasText: "Resume" }).click();
  await expect.poll(() => fs.existsSync(file("DISABLED"))).toBe(false);
  await expect(C(win).locator(".aos-at-manage-top .aos-at-switch")).toHaveText("Team running");
});

test("Manage: Add puts an agent on the team; Remove asks first and takes its block out again (AT8)", async () => {
  const { win } = app();
  await example(win, "Manage");
  await C(win).locator(".aos-at-add select").selectOption("field-researcher");
  // A redraw before the click (the tab's clock, a sweep's re-read) keeps the pick: it once came back empty, Add disabled.
  await win.evaluate(() => (window as unknown as { aosHost: { app: { workspace: { getLeavesOfType(t: string): Array<{ view: { getTab(id: string): { render(): void } } }> } } } })
    .aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0].view.getTab("agent-teams").render());
  await expect(C(win).locator(".aos-at-add select")).toHaveValue("field-researcher");
  await C(win).locator(".aos-at-add button", { hasText: "Add" }).click();
  await expect(win.locator(".notice-container")).toContainText("added field-researcher (agent field-researcher) to example");
  await expect.poll(() => read("TEAM.md")).toContain("  - id: field-researcher\n    name: Field-researcher\n    role: Member\n    agent: field-researcher\n");
  const row = memberRow(win, "Field-researcher");
  await row.locator("button", { hasText: "Remove" }).click();
  await expect(modal(win).locator("h3")).toHaveText("Remove Field-researcher from Example?");
  await modal(win).locator("button", { hasText: "Cancel" }).click();
  await expect(memberRow(win, "Field-researcher")).toHaveCount(1);
  await memberRow(win, "Field-researcher").locator("button", { hasText: "Remove" }).click();
  await modal(win).locator("button.mod-cta", { hasText: "Remove" }).click();
  await expect.poll(() => read("TEAM.md")).toBe(pristine("TEAM.md"));
  await expect(memberRow(win, "Field-researcher")).toHaveCount(0);
});

test("with only Agent Teams on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
