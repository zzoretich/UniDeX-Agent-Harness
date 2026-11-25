// Agent Teams with its write surface on (AOS_APP_WRITE=teams), the rows of app-smoke: Agent Workspace (Needs you, a
// team's Items, Channel and Settings, an agent's profile), and + New team with New agent teams
// (team-create) off and, in an app of its own, on (agent-workspace D14). Every change is one `aos team` call (the vault's
// brain/scripts/team.js); the tab never writes persona/teams/ itself. The tests read what team.js leaves: board.jsonl
// and channel.jsonl (append-only), TEAM.md (rewritten line by line) and the DISABLED switch. A gate approval and a budget
// raise on a paused item open the lead in the Term, which in the fixture is a stub `claude` that only echoes: no seat is
// dispatched and no model is called.

import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, HUD_SETTINGS, appEnv, badge, content, guardWrites, openTab, rail, terminalText, useApp } from "./harness";

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
const modal = (win: Page) => win.locator(".modal");
/** A team node of the Agent Workspace tree, on one of its views (agent-workspace D6). */
async function teamView(win: Page, team: string, v: "items" | "channel" | "settings"): Promise<void> {
  await C(win).locator(`.aos-aw-tree .aos-aw-row[data-key='team:${team}']`).click();
  await expect(C(win).locator(".aos-aw-pane")).toHaveAttribute("data-node", `team:${team}`);
  await C(win).locator(`.aos-aw-pane .aos-aw-view[data-view='${v}']`).click();
  await expect(viewPane(win, v)).toBeVisible();
}
const viewPane = (win: Page, v: string) => C(win).locator(`.aos-aw-pane .aos-aw-viewpane[data-view='${v}']`);
/** Redraws the tab as its clock or a sweep's re-read does. */
const redraw = (win: Page) => win.evaluate(() => (window as unknown as { aosHost: { app: { workspace: { getLeavesOfType(t: string): Array<{ view: { getTab(id: string): { render(): void } } }> } } } })
  .aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0].view.getTab("agent-teams").render());
/** An agent's profile in the Agent Workspace (agent-workspace D11): its tree row (the first, when it sits in two teams). */
async function profile(win: Page, agent: string): Promise<void> {
  await C(win).locator(`.aos-aw-tree .aos-aw-row[data-key='agent:${agent}']`).first().click();
  await expect(C(win).locator(".aos-aw-pane")).toHaveAttribute("data-node", `agent:${agent}`);
}
/** + New team's dialog (agent-workspace D14). */
const newTeam = (win: Page) => win.locator(".modal.mod-aw-newteam");
/** The node the HUD saved (settings.agentWorkspace.node), null when none is. */
function savedNode(): string | null {
  try { return (JSON.parse(fs.readFileSync(HUD_SETTINGS, "utf8")) as { agentWorkspace?: { node?: string | null } }).agentWorkspace?.node ?? null; } catch { return null; }
}
/** The profile's SEAT block for one team. */
const seat = (win: Page, team: string) => C(win).locator(`.aos-aw-pane .aos-aw-seat[data-team='${team}']`);

/**
 * Runs a test's body, then puts the fixture back even when the body failed; a restore that fails after a failed body is
 * dropped, so the body's own failure is the one reported.
 */
async function restoring(body: () => Promise<void>, restore: () => void): Promise<void> {
  let passed = false;
  try {
    await body();
    passed = true;
  } finally {
    try { restore(); } catch (e) { if (passed) throw e; }
  }
}
/** The example team as the fixture has it: no DISABLED switch, TEAM.md byte for byte. */
function restoreExample(): void {
  fs.rmSync(file("DISABLED"), { force: true });
  if (read("TEAM.md") !== pristine("TEAM.md")) fs.writeFileSync(file("TEAM.md"), pristine("TEAM.md"));
}

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

// Agent Teams on, New agent teams (team-create) off: one app for every test below.
test.describe("with the Agent Teams surface on", () => {
  const app = useApp({ env: { AOS_APP_WRITE: "teams" } });

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

  test("an approve drawn before the lead changed the item is refused by --expect: nothing is recorded, and the card catches up (AW7)", async () => {
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

  test("Approve records the decision on the board and in the channel, and opens the lead in Code (AW7)", async () => {
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

  test("an item's budget: Set to $X records the new total; on a paused item work resumes and the lead opens (AW10)", async () => {
    const { win } = app();
    await teamView(win, "example", "items");
    await viewPane(win, "items").locator(".aos-aw-item", { hasText: "harbor-04" }).click();
    const budget = viewPane(win, "items").locator(".aos-at-detail .aos-at-budget");
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

  test("channel: mentions, item filter, Enter posts to the lead, the draft survives a switch (AW11)", async () => {
    const { win } = app();
    await teamView(win, "example", "channel");
    const ch = viewPane(win, "channel");
    await expect(ch.locator(".aos-at-channel .aos-at-mention.is-known").first()).toHaveText("@builder");
    await ch.locator(".aos-nt-filters .aos-nt-chip", { hasText: "harbor-03" }).click();
    await expect(ch.locator(".aos-at-channel .aos-at-post")).toHaveCount(1);
    await ch.locator(".aos-nt-filters .aos-nt-chip", { hasText: "All" }).click();
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
    await C(win).locator(".aos-aw-pane .aos-aw-view[data-view='items']").click();
    await C(win).locator(".aos-aw-pane .aos-aw-view[data-view='channel']").click();
    await expect(C(win).locator("textarea.aos-at-msg")).toHaveValue("line one\nline two");
    // A redraw while typing (the tab's clock, a post landing) keeps the box's focus and caret.
    await C(win).locator("textarea.aos-at-msg").focus();
    await redraw(win);
    await expect(C(win).locator("textarea.aos-at-msg")).toBeFocused();
    await C(win).locator(".aos-at-send").click();
    await expect.poll(() => lastPost().text).toBe("@lead line one\nline two");
  });

  test("settings: Pause writes DISABLED and Resume removes it; Add a member puts an agent on the team", async () => {
    const { win } = app();
    await teamView(win, "example", "settings");
    const s = viewPane(win, "settings");
    await restoring(async () => {
      await s.locator("button.aos-aw-pause", { hasText: "Pause" }).click();
      await expect.poll(() => fs.existsSync(file("DISABLED")) ? read("DISABLED") : null).toBe("Paused from aos team pause. Delete this file, or run aos team resume, to resume.\n");
      await expect(C(win).locator(".aos-aw-paused")).toContainText("This team is paused: no seat can be dispatched until it resumes.");
      await expect(s.locator(".aos-aw-runstate")).toHaveText("Paused: no seat can be dispatched until it resumes");
      await s.locator("button.aos-aw-pause", { hasText: "Resume" }).click();
      await expect.poll(() => fs.existsSync(file("DISABLED"))).toBe(false);
      await expect(s.locator("button.aos-aw-pause")).toHaveText("Pause");
      await expect(C(win).locator(".aos-aw-paused")).toHaveCount(0);

      const pick = s.locator(".aos-aw-add select");
      await pick.selectOption("field-researcher");
      // A redraw before the click (the tab's clock, a sweep's re-read) keeps the pick.
      await redraw(win);
      await expect(pick).toHaveValue("field-researcher");
      await s.locator(".aos-aw-add button", { hasText: "Add" }).click();
      await expect(win.locator(".notice-container")).toContainText("added field-researcher (agent field-researcher) to example");
      await expect.poll(() => read("TEAM.md")).toContain("  - id: field-researcher\n    name: Field-researcher\n    role: Member\n    agent: field-researcher\n");
      // On the team now: the picker no longer offers it, and the team's header counts it.
      await expect(s.locator(".aos-aw-add select option", { hasText: /^field-researcher/ })).toHaveCount(0);
      await expect(C(win).locator(".aos-aw-teamline")).toContainText("4 members");
      // Its seat leaves as it came, through team.js (Remove is the agent profile's), and TEAM.md is the fixture's again.
      teamCli("member", "remove", "example", "field-researcher");
      await expect.poll(() => read("TEAM.md")).toBe(pristine("TEAM.md"));
    }, restoreExample);
  });

  // ── an agent's profile (agent-workspace D11): a seat's pickers, pause seat, Remove from <team>, Seat in… ──

  test.describe("an agent's profile in Agent Workspace", () => {
    test("an effort pick rewrites its TEAM.md line and back", async () => {
      const { win } = app();
      await profile(win, "team-reviewer");
      const effort = () => seat(win, "example").locator(".aos-aw-pick-effort select");
      await restoring(async () => {
        await expect(effort()).toBeEnabled();   // the presets aos team list names have come
        await expect(effort()).toHaveValue("high");
        await effort().selectOption("low");
        await expect(win.locator(".notice-container")).toContainText("reviewer on example: effort is now low");
        await expect.poll(() => read("TEAM.md")).toBe(withMember(pristine("TEAM.md"), "reviewer", "effort", "low"));
        await expect(effort()).toHaveValue("low");
        await effort().selectOption("high");
        await expect.poll(() => read("TEAM.md")).toBe(pristine("TEAM.md"));
        await expect(effort()).toHaveValue("high");
      }, restoreExample);
    });

    test("pause seat", async () => {
      const { win } = app();
      await profile(win, "team-builder");
      const s = seat(win, "example");
      await restoring(async () => {
        await s.locator("button.aos-aw-pauseseat", { hasText: "Pause seat" }).click();
        await expect.poll(() => read("TEAM.md")).toBe(withMember(pristine("TEAM.md"), "builder", "paused", "true"));
        await expect(s).toHaveClass(/is-paused/);
        await expect(s.locator(".aos-aw-seatstate")).toHaveText("paused");
        await expect(C(win).locator(".aos-aw-tree .aos-aw-row[data-key='agent:team-builder'] .aos-aw-dot")).toHaveClass(/is-off/);
        await s.locator("button.aos-aw-pauseseat", { hasText: "Resume seat" }).click();
        await expect.poll(() => read("TEAM.md")).toBe(pristine("TEAM.md"));
        await expect(s).not.toHaveClass(/is-paused/);
        await expect(s.locator("button.aos-aw-pauseseat")).toHaveText("Pause seat");
      }, restoreExample);
    });

    test("Remove from <team> asks first; the lead's refusal is shown", async () => {
      const { win } = app();
      await restoring(async () => {
        // field-researcher, a Survey member, seated on Example too, as the lead would seat it.
        teamCli("member", "add", "example", "field-researcher");
        await profile(win, "field-researcher");
        await expect(seat(win, "example")).toHaveCount(1);
        const remove = () => seat(win, "example").locator("button.aos-aw-remove");
        await expect(remove()).toHaveText("Remove from Example");
        await remove().click();
        await expect(modal(win).locator("h3")).toHaveText("Remove Field-researcher from Example?");
        await modal(win).locator("button", { hasText: "Cancel" }).click();
        await expect(modal(win)).toHaveCount(0);
        expect(read("TEAM.md")).toContain("  - id: field-researcher\n");
        await remove().click();
        await modal(win).locator("button.mod-cta", { hasText: "Remove" }).click();
        await expect.poll(() => read("TEAM.md")).toBe(pristine("TEAM.md"));
        // Its Survey seat stays.
        await expect(seat(win, "example")).toHaveCount(0);
        await expect(seat(win, "survey")).toHaveCount(1);

        // The lead: asked first too; the runtime refuses, its seat says why, and TEAM.md stays.
        await profile(win, "team-lead");
        await seat(win, "example").locator("button.aos-aw-remove", { hasText: "Remove from Example" }).click();
        await expect(modal(win).locator("h3")).toHaveText("Remove Lead from Example?");
        await modal(win).locator("button.mod-cta", { hasText: "Remove" }).click();
        await expect(seat(win, "example").locator(".aos-at-error")).toHaveText("the lead cannot be removed; make another member the lead in TEAM.md first");
        expect(read("TEAM.md")).toBe(pristine("TEAM.md"));
      }, restoreExample);
    });

    test("Seat in… lists only teams it is not on and adds it", async () => {
      const { win } = app();
      await profile(win, "field-researcher");
      const seatIn = C(win).locator(".aos-aw-pane .aos-aw-seatin");
      await restoring(async () => {
        // On Survey already, and the broken team cannot be read: Example is the one team offered.
        await expect(seatIn.locator("select option")).toHaveText(["pick a team", "Example"]);
        await expect(seatIn.locator("button", { hasText: "Seat" })).toBeDisabled();
        await seatIn.locator("select").selectOption("example");
        // A redraw before the click (the tab's clock, a sweep's re-read) keeps the pick.
        await redraw(win);
        await expect(seatIn.locator("select")).toHaveValue("example");
        await seatIn.locator("button", { hasText: "Seat" }).click();
        await expect(win.locator(".notice-container")).toContainText("added field-researcher (agent field-researcher) to example");
        await expect.poll(() => read("TEAM.md")).toContain("  - id: field-researcher\n    name: Field-researcher\n    role: Member\n    agent: field-researcher\n");
        // A SEAT block per team now, and no team left to offer.
        await expect(C(win).locator(".aos-aw-pane .aos-aw-seat .aos-aw-seatteam")).toHaveText(["Example", "Survey"]);
        await expect(seat(win, "example").locator(".aos-aw-seatrole")).toHaveText("Member");
        await expect(seatIn).toContainText("it sits in every team");
      }, restoreExample);
    });
  });

  test("with team-create off, Create is refused and the dialog says why", async () => {
    const h = app();
    const { win } = h;
    const news = async () => (await h.guard()).filter((e) => e.kind === "spawn" && / new /.test(e.what)).map((e) => e.what);
    await C(win).locator("button.aos-aw-new").click();
    const dlg = newTeam(win);
    await dlg.locator("input.aos-aw-newname").fill("Harbor Crew");
    await dlg.locator("select.aos-aw-newlead").selectOption("field-researcher");
    const create = dlg.locator("button", { hasText: "Create" });
    await create.click();
    // The app refuses the spawn (the surface is off); the dialog stays open with why, and Create is on again.
    await expect(dlg.locator(".aos-aw-newerror")).toContainText("refused; no write surface that allows it is on");
    await expect(create).toBeEnabled();
    await expect(dlg.locator("input.aos-aw-newname")).toHaveValue("Harbor Crew");
    await expect.poll(news).toEqual([expect.stringMatching(/\/team\.js new harbor-crew --name Harbor Crew --lead field-researcher$/)]);
    expect(fs.existsSync(FX.v("persona/teams/harbor-crew"))).toBe(false);
    await win.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
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
});

// + New team writes through a surface of its own, New agent teams (team-create), off until a live check per host
// (agent-workspace D14): this app turns it on beside Agent Teams.
test.describe("with New agent teams (team-create) on", () => {
  const app = useApp({ env: { AOS_APP_WRITE: "teams,team-create" } });
  const crew = FX.v("persona/teams/harbor-crew");

  test("+ New team: the id follows the name; an emoji-only name or a taken id disables Create with the reason; Create writes TEAM.md with the lead and selects the new team", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "agent-teams");
    await restoring(async () => {
      await C(win).locator("button.aos-aw-new").click();
      const dlg = newTeam(win);
      const name = dlg.locator("input.aos-aw-newname");
      const id = dlg.locator(".aos-aw-newid");
      const why = dlg.locator(".aos-aw-newwhy");
      const create = dlg.locator("button", { hasText: "Create" });
      await expect(dlg.locator("h3")).toHaveText("New team");
      await expect(name).toBeFocused();
      await expect(create).toBeDisabled();
      await name.pressSequentially("Harbor Crew");
      await expect(id).toHaveText("id harbor-crew · persona/teams/harbor-crew/");
      await expect(why).toHaveText("Pick the agent that leads it.");
      // An emoji-only name leaves no id; a taken id is refused before anything is sent.
      await name.fill("🚢🌊");
      await expect(id).toHaveText("id —");
      await expect(why).toHaveText("No team id can be made from this name: put a letter (a–z) in it.");
      await expect(create).toBeDisabled();
      await name.fill("Example");
      await expect(id).toHaveText("id example · persona/teams/example/");
      await expect(why).toHaveText("A team with the id example already exists.");
      await expect(create).toBeDisabled();
      // The lead from your agents aos team new can find (each file named as its agent); the parent from the teams that read.
      const lead = dlg.locator("select.aos-aw-newlead");
      expect(await lead.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).toEqual(["", "field-researcher", "survey-lead", "team-builder", "team-lead", "team-reviewer"]);
      const parent = dlg.locator("select.aos-aw-newparent");
      expect(await parent.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).toEqual(["", "example", "survey"]);
      await name.fill("Harbor Crew");
      await lead.selectOption("field-researcher");
      await parent.selectOption("example");
      await expect(why).toHaveText("");
      await expect(create).toBeEnabled();
      // Enter in the name field is Create once it is on.
      await name.press("Enter");
      await expect(dlg).toHaveCount(0);
      await expect(win.locator(".notice-container")).toContainText("created persona/teams/harbor-crew/ with field-researcher (agent field-researcher) as its lead");
      const md = fs.readFileSync(path.join(crew, "TEAM.md"), "utf8");
      expect(md).toMatch(/^id: harbor-crew$/m);
      expect(md).toMatch(/^name: "?Harbor Crew"?$/m);
      expect(md).toMatch(/^lead: field-researcher$/m);
      expect(md).toMatch(/^parent: example$/m);
      expect(md).toContain("  - id: field-researcher\n");
      expect(md).toContain("    agent: field-researcher\n");
      // The new team is selected, drawn under its parent, and remembered as the user's pick (D5).
      const row = C(win).locator(".aos-aw-tree .aos-aw-row[data-key='team:harbor-crew']");
      await expect(row).toHaveAttribute("aria-selected", "true");
      await expect(row).toHaveAttribute("aria-level", "3");
      await expect(C(win).locator(".aos-aw-pane")).toHaveAttribute("data-node", "team:harbor-crew");
      await expect(C(win).locator(".aos-aw-pane .aos-aw-panetitle")).toHaveText("Harbor Crew");
      await expect.poll(savedNode).toBe("team:harbor-crew");
      // Written by team.js alone: the tab wrote nothing and no spawn was refused.
      expect(await guardWrites(h)).toEqual([]);
      expect((await h.guard()).filter((e) => e.kind === "spawn")).toEqual([]);
    }, () => fs.rmSync(crew, { recursive: true, force: true }));
  });
});
