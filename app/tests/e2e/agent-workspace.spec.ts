// Agent Workspace (spec 2026-11-12-agent-workspace-design D2-D10, D13, D16): one rail button for agents and the teams
// they sit in. The rail button and its gate count, the `agents` alias and links, the tree (Needs you, the teams nested by
// parent with their members, the bench, plugin agents folded) and its keys, the filter, the header (counts, sharing, sync
// now, + New team) and the stale-cache sync; the Needs you pane (every pending gate card: presets, Approve asks first,
// Redirect ❯_) and a team's pane (its header line, NOW, its gates, Activity, Items as a list or today's board with an
// item's detail, the Channel, Settings) and the broken team's error card; an agent's profile (D11: its header, NOW, a SEAT
// block per team, Seat in…, HOSTS, RECENT RUNS; a bench agent, a plugin agent) and a member whose agent is missing (D12).
// Read-only: approving, budgets, posting, pausing, a seat's pickers, Seat in…, Remove and adding a member are in
// teams-writes.spec.ts, and share / unshare in sharing-writes.spec.ts; here, with both hosts and the sharing surface off,
// an agent's unshare is refused (it moved from skills-agents.spec.ts with the Agents tab).

import { expect, test, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FX, HUD_SETTINGS, appEnv, badge, closeNotes, content, guardWrites, launchApp, notePath, openTab, pulseArea, rail, restoreFixture, shareBothHosts, terminalText, useApp,
  type AppHandle,
} from "./harness";

const AGENTS = "brain/_index/agents.json";
const SYNC = "▶ aos.js agents sync";
type Cache = { scannedAt: string; agents: Array<Record<string, unknown>> };
const readCache = (): Cache => JSON.parse(fs.readFileSync(FX.v(AGENTS), "utf8")) as Cache;
const writeCache = (c: Cache): void => fs.writeFileSync(FX.v(AGENTS), `${JSON.stringify(c, null, 2)}\n`);

/** An agent row as `aos agents sync` writes it, on Claude Code only. */
function agentRow(id: string, name: string, description: string, scope: "user" | "plugin", plugin: string | null): Record<string, unknown> {
  const file = path.join(FX.claude, scope === "plugin" ? `plugins/cache/sample-market/${plugin}/1.2.0/agents` : "agents", `${name}.md`);
  return {
    id, name, description, origin: { host: "claude", scope, plugin, path: file },
    on: { claude: { path: file, via: "native", invoke: `@agent-${name}`, run: `claude --agent ${name}` }, codex: null },
    readOnly: false, status: scope === "plugin" ? "listed" : "pending", note: null,
  };
}

/** The fixture plus one agent of yours seated nowhere (the bench), one plugin agent (listed, folded), and the builder
 *  also seated on Survey, so it shows under both teams; the agents cache dated now, so no sync starts on its own. */
function workspaceFixture(): void {
  const c = readCache();
  c.agents.push(agentRow("harbor-scout", "harbor-scout", "Scouts the harbor charts for new soundings.", "user", null));
  c.agents.push(agentRow("logbook:keeper", "keeper", "Keeps the ship's log.", "plugin", "logbook"));
  c.scannedAt = new Date().toISOString();
  writeCache(c);
  const team = FX.v("persona/teams/survey/TEAM.md");
  const seat = "  - id: builder\n    name: Builder\n    role: Builds the survey tools\n    agent: team-builder\n    provider: claude\n    model: inherit\n    effort: high\n    stage: [build]\n";
  fs.writeFileSync(team, fs.readFileSync(team, "utf8").replace("\n---\n\n# Survey team", `\n${seat}---\n\n# Survey team`));
}

/** workspaceFixture, and a Survey member whose agent is in no host's folder (D12). */
function profileFixture(): void {
  workspaceFixture();
  const team = FX.v("persona/teams/survey/TEAM.md");
  const seat = "  - id: scribe\n    name: Scribe\n    role: Keeps the survey log\n    agent: harbor-ghost\n    provider: claude\n    model: inherit\n    effort: inherit\n    stage: [all]\n";
  fs.writeFileSync(team, fs.readFileSync(team, "utf8").replace("\n---\n\n# Survey team", `\n${seat}---\n\n# Survey team`));
}

/** A live run marker for one of the example team's seats, from another machine, so no sweep closes it. */
function liveRun(member: string, item: string, minutesAgo: number): string {
  const running = FX.v("persona/teams/example/running");
  fs.mkdirSync(running, { recursive: true });
  const run = `example-${item}-${member}-z`;
  fs.writeFileSync(path.join(running, `${run}.json`), JSON.stringify({
    schema: 1, run, team: "example", member, item, provider: "claude",
    pid: 999999, pidStart: 0, host: "another-machine.test", startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), reservedUsd: 2,
  }));
  return running;
}

/** Redraws the tab as a sync landing does (its cache rewritten, the same bytes) and waits until the filter that had the
 *  focus is replaced. */
async function redrawUnder(filter: Locator, rel: string): Promise<void> {
  const old = await filter.elementHandle();
  const file = FX.v(rel);
  fs.writeFileSync(file, fs.readFileSync(file));
  await expect.poll(() => old!.evaluate((e) => e.isConnected)).toBe(false);
}

/** The node the HUD saved (settings.agentWorkspace.node), null when none is. */
const savedNode = (): string | null => {
  try { return (JSON.parse(fs.readFileSync(HUD_SETTINGS, "utf8")) as { agentWorkspace?: { node?: string | null } }).agentWorkspace?.node ?? null; } catch { return null; }
};
/** How the HUD saved the Items view (settings.agentWorkspace.items), null when it saved none. */
const savedItems = (): string | null => {
  try { return (JSON.parse(fs.readFileSync(HUD_SETTINGS, "utf8")) as { agentWorkspace?: { items?: string } }).agentWorkspace?.items ?? null; } catch { return null; }
};
/** What the team (or one of its members) spent in the last seven days, as the panes write it: the fixture's runs are dated
 *  from when it was built. */
function weekSpend(team: string, member?: string): string {
  const runs = fs.readFileSync(FX.v(`persona/teams/${team}/runs.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { ts: string; usd: number | null; member: string })
    .filter((r) => !member || r.member === member);
  const cents = Math.round(100 * runs.reduce((n, r) => (Date.now() - Date.parse(r.ts) < 7 * 86_400_000 && typeof r.usd === "number" ? n + r.usd : n), 0));
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
const railIds = (win: Page) => win.locator(".aos-wb-railtabs .aos-wb-railbtn").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const link = (win: Page, params: Record<string, string>) =>
  win.evaluate((p) => (window as unknown as { aosHost: { app: { handleProtocol(a: string, p: Record<string, string>): boolean } } }).aosHost.app.handleProtocol("agenticos", p), params);
/** WorkbenchView.open, as a link or Pulse calls it, with a node to reveal. */
const reveal = (win: Page, target: { tab: string; node?: string }) =>
  win.evaluate((t) => (window as unknown as { aosHost: { app: { workspace: { getLeavesOfType(v: string): Array<{ view: { open(t: object): boolean } }> } } } })
    .aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0].view.open(t), target);

test.describe("Agent Workspace", () => {
  const app = useApp({ prepare: workspaceFixture });
  const C = () => content(app().win);
  const tree = () => C().locator(".aos-aw-tree");
  const rows = () => tree().locator(".aos-aw-row");
  const row = (key: string) => tree().locator(`.aos-aw-row[data-key="${key}"]`);
  const pane = () => C().locator(".aos-aw-pane");
  /** Each row as "<level> <label>", in order. */
  const shape = () => rows().evaluateAll((els) => els.map((e) => `${e.getAttribute("aria-level")} ${e.querySelector(".aos-aw-label")?.textContent ?? ""}`));
  const syncs = () => app().notices.filter((n) => n === SYNC).length;

  test("rail: Agent Workspace after Sessions with the bot icon and the gate count; no Agents button", async () => {
    const { win } = app();
    const ids = await railIds(win);
    expect(ids.indexOf("agent-teams")).toBe(ids.indexOf("chat") + 1);
    // It closes the first section: the first line between sections comes right after it.
    const seq = await win.locator(".aos-wb-railtabs > *").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab ?? (e.classList.contains("aos-wb-railsep") ? "|" : "?")));
    expect(seq[seq.indexOf("agent-teams") + 1]).toBe("|");
    await expect(rail(win, "agent-teams")).toHaveAttribute("aria-label", "Agent Workspace");
    await expect(rail(win, "agent-teams").locator(".aos-wb-raillabel")).toHaveText("Agent Workspace");
    await expect(rail(win, "agent-teams").locator(".aos-wb-railicon")).toHaveAttribute("data-icon", "bot");
    await expect(badge(win, "agent-teams")).toHaveText("2");
    await expect(badge(win, "agent-teams")).not.toHaveClass(/is-urgent/);
    await expect(rail(win, "agents")).toHaveCount(0);
  });

  test("tab=agents and tab=agent-teams links open it; a link with a gate pending shows Needs you", async () => {
    const { win } = app();
    // The first visit, with gates pending, shows Needs you, and remembers nothing: only a pick is saved.
    await openTab(win, "agent-teams");
    await expect(pane()).toHaveAttribute("data-node", "needs");
    await expect(pane().locator(".aos-aw-panetitle")).toHaveText("Needs you");
    await win.waitForTimeout(300);
    expect(savedNode()).toBeNull();
    await row("team:example").click();
    await expect(pane()).toHaveAttribute("data-node", "team:example");
    await expect(row("team:example")).toHaveAttribute("aria-selected", "true");
    await expect.poll(savedNode).toBe("team:example");
    // A rail click shows the saved selection.
    await openTab(win, "pulse");
    await openTab(win, "agent-teams");
    await expect(pane()).toHaveAttribute("data-node", "team:example");
    // A link with no node shows Needs you while a gate is pending, through the old id too; showing it is not picking
    // it, so the next rail click shows the saved team again.
    await openTab(win, "pulse");
    expect(await link(win, { tab: "agents" })).toBe(true);
    await expect(rail(win, "agent-teams")).toHaveClass(/is-active/);
    await expect(pane()).toHaveAttribute("data-node", "needs");
    await openTab(win, "pulse");
    await openTab(win, "agent-teams");
    await expect(pane()).toHaveAttribute("data-node", "team:example");
    expect(savedNode()).toBe("team:example");
    await openTab(win, "pulse");
    expect(await link(win, { tab: "agent-teams" })).toBe(true);
    await expect(rail(win, "agent-teams")).toHaveClass(/is-active/);
    await expect(pane()).toHaveAttribute("data-node", "needs");
    // Pulse's per-team Board → names its team, which wins over the gates and is remembered.
    await openTab(win, "pulse");
    const pop = await pulseArea(win, "agents");
    await pop.locator(".aos-pp-row", { hasText: "Survey — team" }).locator("button", { hasText: "Board →" }).click();
    await expect(rail(win, "agent-teams")).toHaveClass(/is-active/);
    await expect(pane()).toHaveAttribute("data-node", "team:survey");
    await expect(row("team:survey")).toHaveAttribute("aria-selected", "true");
    await expect.poll(savedNode).toBe("team:survey");
    await openTab(win, "pulse");
    await openTab(win, "agent-teams");
    await expect(pane()).toHaveAttribute("data-node", "team:survey");
  });

  test("the tree: Needs you, Example with Survey under it, members lead first, the broken team marked, Bench, Plugins folded", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    await expect.poll(shape).toEqual([
      "1 Needs you",
      "1 TEAMS", "2 broken", "2 Example", "3 Lead", "3 Builder", "3 Reviewer", "3 Survey", "4 Survey Lead", "4 Researcher", "4 Builder",
      "1 BENCH", "2 harbor-scout",
      "1 PLUGINS & CONFIG.TOML",
    ]);
    await expect(row("needs").locator(".aos-aw-count")).toHaveText("2");
    await expect(row("needs")).toHaveClass(/is-gate/);
    await expect(row("section:teams").locator(".aos-aw-count")).toHaveText("3");
    await expect(row("team:example").locator(".aos-aw-count")).toHaveText("1");
    await expect(row("team:example").locator(".aos-aw-dot")).toHaveClass(/is-gate/);
    await expect(row("team:survey").locator(".aos-aw-count")).toHaveText("1");
    // The broken TEAM.md: a rose ! that names the line.
    await expect(row("team:broken")).toHaveClass(/is-broken/);
    await expect(row("team:broken").locator(".aos-aw-broken")).toHaveText("!");
    await expect(row("team:broken")).toHaveAttribute("title", /TEAM\.md: unsupported TEAM\.md line/);
    // The lead first, with its pill; the reviewer owns a blocked item.
    await expect(row("agent:team-lead").locator(".aos-aw-lead")).toHaveText("lead");
    await expect(row("agent:survey-lead").locator(".aos-aw-lead")).toHaveText("lead");
    await expect(row("agent:team-builder").first().locator(".aos-aw-lead")).toHaveCount(0);
    await expect(row("agent:team-reviewer").locator(".aos-aw-dot")).toHaveClass(/is-failed/);
    await expect(row("section:bench").locator(".aos-aw-count")).toHaveText("1");
    // Plugins: counted, folded; a click opens and folds it.
    await expect(row("section:plugins")).toHaveAttribute("aria-expanded", "false");
    await expect(row("section:plugins").locator(".aos-aw-count")).toHaveText("1");
    await expect(row("agent:logbook:keeper")).toHaveCount(0);
    await row("section:plugins").click();
    await expect(row("section:plugins")).toHaveAttribute("aria-expanded", "true");
    await expect(row("agent:logbook:keeper").locator(".aos-aw-label")).toHaveText("keeper");
    await row("section:plugins").click();
    await expect(row("agent:logbook:keeper")).toHaveCount(0);
    // An agent seated on two teams shows under each, and picking one highlights both.
    await row("agent:team-builder").first().click();
    await expect(pane()).toHaveAttribute("data-node", "agent:team-builder");
    await expect(row("agent:team-builder")).toHaveCount(2);
    for (const r of await row("agent:team-builder").all()) await expect(r).toHaveAttribute("aria-selected", "true");
    await expect(tree().locator(".aos-aw-row[aria-selected='true']")).toHaveCount(2);
    // A reveal that names a plugin agent opens Plugins first, so the agent is in the tree and selected.
    expect(await reveal(win, { tab: "agent-teams", node: "agent:logbook:keeper" })).toBe(true);
    await expect(row("section:plugins")).toHaveAttribute("aria-expanded", "true");
    await expect(row("agent:logbook:keeper")).toHaveAttribute("aria-selected", "true");
    await expect(pane()).toHaveAttribute("data-node", "agent:logbook:keeper");
    await row("section:plugins").click();
  });

  test("the tree's keys: ↑↓ walk the rows, ← and → fold and open a team, Enter selects", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    await row("team:example").focus();
    await win.keyboard.press("ArrowDown");
    await expect(row("agent:team-lead")).toBeFocused();
    await win.keyboard.press("Enter");
    await expect(pane()).toHaveAttribute("data-node", "agent:team-lead");
    await expect(row("agent:team-lead")).toBeFocused();
    // ← on a member goes up to its team; ← on an open team folds it, its members and its sub-team with it.
    await win.keyboard.press("ArrowLeft");
    await expect(row("team:example")).toBeFocused();
    await win.keyboard.press("ArrowLeft");
    await expect(row("team:example")).toHaveAttribute("aria-expanded", "false");
    await expect(row("agent:team-lead")).toHaveCount(0);
    await expect(row("team:survey")).toHaveCount(0);
    await expect(row("team:example")).toBeFocused();
    await win.keyboard.press("ArrowRight");
    await expect(row("team:example")).toHaveAttribute("aria-expanded", "true");
    await expect(row("team:survey")).toBeVisible();
    await expect(row("team:example")).toBeFocused();
    await win.keyboard.press("ArrowUp");
    await expect(row("team:broken")).toBeFocused();
    await win.keyboard.press("ArrowUp");
    await expect(row("section:teams")).toBeFocused();
    // Enter on a section folds it, and again opens it.
    await win.keyboard.press("Enter");
    await expect(row("section:teams")).toHaveAttribute("aria-expanded", "false");
    await expect(row("team:example")).toHaveCount(0);
    await win.keyboard.press("Enter");
    await expect(row("team:example")).toBeVisible();
  });

  test("the filter narrows the tree and keeps its focus across a redraw", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    const filter = C().locator("input.aos-aw-filter");
    await filter.click();
    await win.keyboard.type("sur");
    // A redraw mid-typing keeps the letters and the focus.
    await redrawUnder(filter, AGENTS);
    await win.keyboard.type("vey");
    await expect(filter).toBeFocused();
    await expect(filter).toHaveValue("survey");
    // The matching team keeps its parent; its members all show.
    await expect.poll(shape).toEqual(["1 Needs you", "1 TEAMS", "2 Example", "3 Survey", "4 Survey Lead", "4 Researcher", "4 Builder", "1 BENCH", "1 PLUGINS & CONFIG.TOML"]);
    await filter.fill("keeper");
    await expect.poll(shape).toEqual(["1 Needs you", "1 TEAMS", "1 BENCH", "1 PLUGINS & CONFIG.TOML", "2 keeper"]);
    await filter.fill("");
    await expect(row("agent:logbook:keeper")).toHaveCount(0);
  });

  test("the header: counts, sharing state, sync now, + New team opens its dialog", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "agent-teams");
    await expect(C().locator(".aos-aw-title")).toHaveText("Agent Workspace");
    // Your agents (not plugin ones), every team, live runs, pending gates.
    await expect(C().locator(".aos-aw-counts")).toHaveText("6 agents · 3 teams · 0 running · 2 gates");
    await expect(C().locator(".aos-aw-sharing")).toHaveText("sharing off — sharing needs both hosts enabled");
    // + New team opens its dialog (D14) with the keyboard in the name field and Create off; Escape closes it, and
    // nothing ran. (The tab's own background refreshes may land meanwhile: the team sweep and the agents sync.)
    const btn = C().locator("button.aos-aw-new");
    await expect(btn).toHaveText("+ New team");
    const ours = async () => (await h.guard()).filter((e) => !/ list --json$|agents sync$/.test(e.what)).length;
    const spawns = await ours();
    await btn.click();
    const dlg = win.locator(".modal.mod-aw-newteam");
    await expect(dlg.locator("h3")).toHaveText("New team");
    await expect(dlg.locator("input.aos-aw-newname")).toBeFocused();
    await expect(dlg.locator("button", { hasText: "Create" })).toBeDisabled();
    await expect(dlg.locator(".aos-aw-newwhy")).toHaveText("Name the team: its id is made from the name.");
    await win.keyboard.press("Escape");
    await expect(win.locator(".modal")).toHaveCount(0);
    expect(await ours()).toBe(spawns);
    // The cache is fresh: no sync started on its own; sync now asks for one.
    expect(syncs()).toBe(0);
    await C().locator("button.aos-aw-sync").click();
    await expect.poll(syncs).toBe(1);
  });

  // ── Needs you (D5): today's NEEDS YOU strip as a node of its own, every card through renderGateCard ──

  const needsPane = () => C().locator(".aos-aw-pane[data-node='needs']");
  const gate = (item: string) => needsPane().locator(".aos-at-gate", { has: app().win.locator(".aos-at-itemid", { hasText: item }) });
  async function needsYou(): Promise<void> {
    await openTab(app().win, "agent-teams");
    await row("needs").click();
    await expect(needsPane()).toBeVisible();
  }

  test("NEEDS YOU: each pending gate with item, gate, wait, spend, pitch and presets", async () => {
    await needsYou();
    await expect(needsPane().locator(".aos-aw-panetitle")).toHaveText("Needs you");
    await expect(needsPane().locator(".aos-aw-paneline")).toHaveText("2 gates waiting on you across 2 teams");
    await expect(needsPane().locator(".aos-at-gate")).toHaveCount(2);
    const g = gate("harbor-01");
    await expect(g.locator(".aos-at-teamtag")).toHaveText("Example");
    await expect(g.locator(".aos-at-itemtitle")).toHaveText("Tide table parser");
    await expect(g.locator(".aos-at-gatename")).toHaveText("Discuss gate");
    await expect(g.locator(".aos-at-gatemeta")).toContainText(/waiting \d+[mhd]/);
    await expect(g.locator(".aos-at-gatemeta")).toContainText("$6 spent of $10");
    await expect(g.locator(".aos-at-pitch .aos-at-from")).toHaveText("Lead");
    await expect(g.locator(".aos-at-pitchtext")).toContainText("Discuss gate open on harbor-01: scope is the tide parser; I propose $10.");
    await expect(g.locator(".aos-at-pitchtext .aos-at-mention")).toHaveText(["@user"]);
    // Presets: half, the proposal, double; one below what is already spent is disabled.
    await expect(g.locator(".aos-at-preset")).toHaveText(["$5", "$10 proposed", "$20"]);
    await expect(g.locator(".aos-at-preset.is-active")).toHaveText("$10 proposed");
    await expect(g.locator(".aos-at-preset", { hasText: "$5" })).toBeDisabled();
    await expect(g.locator(".aos-at-preset", { hasText: "$5" })).toHaveAttribute("title", "below the $6 already spent or held");
    await expect(g.locator(".aos-at-floor")).toHaveText("at least $6");
    await expect(g.locator(".aos-at-step")).toHaveText(["−", "+"]);
    await expect(g.locator(".aos-at-stepvalue")).toHaveText("$10");
    await expect(g.locator(".aos-at-approve")).toHaveText("Approve · $10");
    await expect(g.locator(".aos-at-gateacts button", { hasText: "Redirect" })).toHaveText("Redirect ❯_");
    // The sub-team's gate, with its own budget ladder.
    await expect(gate("survey-01").locator(".aos-at-teamtag")).toHaveText("Survey");
    await expect(gate("survey-01").locator(".aos-at-gatename")).toHaveText("Plan gate");
    await expect(gate("survey-01").locator(".aos-at-approve")).toHaveText("Approve · $5");
  });

  test("a preset or − / + changes the Approve amount, writing nothing", async () => {
    const h = app();
    await needsYou();
    const writes = await guardWrites(h);
    await gate("harbor-01").locator(".aos-at-preset", { hasText: "$20" }).click();
    await expect(gate("harbor-01").locator(".aos-at-approve")).toHaveText("Approve · $20");
    await gate("harbor-01").locator(".aos-at-step", { hasText: "−" }).click();
    await expect(gate("harbor-01").locator(".aos-at-approve")).toHaveText("Approve · $15");
    await gate("harbor-01").locator(".aos-at-preset", { hasText: "$10 proposed" }).click();
    await expect(gate("harbor-01").locator(".aos-at-approve")).toHaveText("Approve · $10");
    expect(await guardWrites(h)).toEqual(writes);
  });

  test("Approve asks first; Cancel writes nothing", async () => {
    const h = app();
    await needsYou();
    const writes = await guardWrites(h);
    const spawns = (await h.guard()).filter((e) => e.kind === "spawn").length;
    await gate("harbor-01").locator(".aos-at-approve").click();
    const modal = h.win.locator(".modal");
    await expect(modal.locator(".modal-content h3")).toHaveText("Approve the Discuss gate on harbor-01?");
    await expect(modal.locator(".modal-content p")).toContainText("Tide table parser. harbor-01 moves on from discuss, and Lead takes the next step with a $10 phase budget ($6 spent so far).");
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(h.win.locator(".modal")).toHaveCount(0);
    expect(await guardWrites(h)).toEqual(writes);
    expect((await h.guard()).filter((e) => e.kind === "spawn" && / gate /.test(e.what))).toEqual([]);
    expect((await h.guard()).filter((e) => e.kind === "spawn").length).toBeGreaterThanOrEqual(spawns);
    await expect(gate("harbor-01")).toBeVisible();
  });

  // This block runs with no write surface on (the app's default here), so `aos team` is refused before it starts.
  test("with the Agent Teams surface off, an approve is refused: the card says why, nothing is written, the lead is not opened", async () => {
    const h = app();
    await needsYou();
    const dir = FX.v("persona/teams/example");
    const files = () => ["board.jsonl", "channel.jsonl", "TEAM.md"].map((f) => fs.readFileSync(`${dir}/${f}`, "utf8"));
    const before = files();
    const gateSpawns = async () => (await h.guard()).filter((e) => e.kind === "spawn" && / gate /.test(e.what)).map((e) => e.what);
    expect(await gateSpawns()).toEqual([]);
    await gate("harbor-01").locator(".aos-at-approve").click();
    await h.win.locator(".modal button.mod-cta", { hasText: "Approve" }).click();
    await expect(gate("harbor-01").locator(".aos-at-error")).toContainText("refused; no write surface that allows it is on");
    await expect(rail(h.win, "agent-teams")).toHaveClass(/is-active/);   // the lead was not opened
    await expect.poll(gateSpawns).toEqual([expect.stringMatching(/\/team\.js gate approve example harbor-01 --expect .* --usd 10$/)]);
    expect(files()).toEqual(before);
    await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
  });

  test("Redirect ❯_ opens the lead", async () => {
    const { win } = app();
    await needsYou();
    await gate("harbor-01").locator(".aos-at-gateacts button", { hasText: "Redirect" }).click();
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture claude stub] --agent team-lead");
    expect((await terminalText(win)).replace(/\s+/g, " ")).toContain("gate redirect");
  });

  // ── a team (D6, D7): its header line, who is at work, its gates, then Activity · Items · Channel · Settings ──

  test("a team: header line, NOW strip, its gates, Activity first with the fixture's events newest first, older adds more", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    await row("team:example").click();
    const p = pane();
    await expect(p).toHaveAttribute("data-node", "team:example");
    await expect(p.locator(".aos-aw-panetitle")).toHaveText("Example");
    await expect(p.locator(".aos-aw-teamline")).toHaveText(`lead Lead · 3 members · 4 open · ${weekSpend("example")} this week`);
    await expect(p.locator("button.aos-aw-talk")).toHaveText(["❯_ talk to Lead"]);
    // NOW: the reviewer owns a blocked item; the lead and the builder are idle (no run is live).
    const now = p.locator(".aos-aw-now");
    await expect(now.locator(".aos-aw-nowlabel")).toHaveText("NOW");
    await expect(now.locator(".aos-aw-whoname")).toHaveText(["Reviewer"]);
    await expect(now.locator(".aos-aw-who")).toHaveClass(/is-blocked/);
    await expect(now.locator(".aos-aw-whoitem")).toHaveText(["harbor-03"]);
    await expect(now.locator(".aos-aw-nowrest")).toHaveText("2 idle");
    // This team's gate, its team not named; the sub-team's gate is under Survey and Needs you.
    await expect(p.locator(".aos-aw-gates .aos-aw-gateshead")).toHaveText("NEEDS YOU · 1");
    await expect(p.locator(".aos-aw-gates .aos-at-gate .aos-at-itemid")).toHaveText(["harbor-01"]);
    await expect(p.locator(".aos-aw-gates .aos-at-teamtag")).toHaveCount(0);
    await expect(p.locator(".aos-aw-gates .aos-at-approve")).toHaveText("Approve · $10");
    // The views, Activity first.
    await expect(p.locator(".aos-aw-views")).toHaveAttribute("role", "tablist");
    await expect(p.locator(".aos-aw-view .aos-aw-viewlabel")).toHaveText(["Activity", "Items", "Channel", "Settings"]);
    await expect(p.locator(".aos-aw-view[aria-selected='true']")).toHaveAttribute("data-view", "activity");
    await expect(p.locator(".aos-aw-evtext")).toHaveText([
      "Reviewer: Offline sync fails on an empty cache; @builder should add a guard.",
      "Builder: Tile cache written; 3 commits. Back to @lead.",
      "Lead: @builder takes harbor-02 in execute.",
      // The lead posted its pitch after moving the board (R28): it rides on the gate, and is not a post of its own.
      'Lead opened the discuss gate on harbor-01: "Discuss gate open on harbor-01: scope is the tide parser; I propose $10. See notes, or ask @user."',
      "Lead added harbor-01: Tide table parser",
      "Lead added harbor-04: Offline tiles",
      "Lead added harbor-03: Offline sync",
      "Lead added harbor-02: Chart tile cache",
      "Lead added harbor-00: Scaffold the viewer",
      "Reviewer finished harbor-03: failed · codex",
      "Builder finished harbor-02: ok · claude · $2.40",
    ]);
    await expect(p.locator(".aos-aw-evtime").first()).toHaveText(/^\d+[mhd]$/);
    await expect(p.locator(".aos-aw-event").first().locator(".aos-aw-dot")).toHaveClass(/is-failed/);
    await expect(p.locator(".aos-aw-event").nth(3).locator(".aos-aw-dot")).toHaveClass(/is-gate/);
    await expect(p.locator("button.aos-aw-older")).toHaveCount(0);

    // A seat's run goes live (its marker, from another machine, so no sweep closes it): the builder is at work.
    const running = liveRun("builder", "harbor-02", 4);
    try {
      await expect(now.locator(".aos-aw-whoname")).toHaveText(["Builder", "Reviewer"]);
      await expect(now.locator(".aos-aw-who").first()).toHaveClass(/is-working/);
      await expect(now.locator(".aos-aw-whoitem").first()).toHaveText(/^harbor-02 · [45]m$/);
      await expect(now.locator(".aos-aw-nowrest")).toHaveText("1 idle");
      // Its start joins the feed at its time (the fixture's own events may be newer: it was built minutes ago).
      const started = p.locator(".aos-aw-event", { hasText: "Builder started harbor-02 (execute) on claude" });
      await expect(started).toHaveCount(1);
      await expect(started.locator(".aos-aw-dot")).toHaveClass(/is-live/);
      await expect(p.locator(".aos-aw-event")).toHaveCount(12);
    } finally {
      fs.rmSync(running, { recursive: true, force: true });
    }
    await expect(now.locator(".aos-aw-whoname")).toHaveText(["Reviewer"]);

    // Older posts than the feed's first 50 events: "older" adds the next 50.
    const channel = FX.v("persona/teams/example/channel.jsonl");
    const was = fs.readFileSync(channel, "utf8");
    const old = Array.from({ length: 45 }, (_, i) => JSON.stringify({
      schema: 1, ts: new Date(Date.now() - 3 * 86_400_000 - i * 60_000).toISOString(), team: "example", from: "lead", item: null, kind: "note", text: `log line ${i + 1}`,
    }));
    fs.writeFileSync(channel, `${old.join("\n")}\n${was}`);
    try {
      await expect(p.locator(".aos-aw-event")).toHaveCount(50);
      await expect(p.locator(".aos-aw-evtext").nth(11)).toHaveText("Lead: log line 1");
      await expect(p.locator(".aos-aw-evtext").last()).toHaveText("Lead: log line 39");
      await p.locator("button.aos-aw-older").click();
      await expect(p.locator(".aos-aw-event")).toHaveCount(56);
      await expect(p.locator(".aos-aw-evtext").last()).toHaveText("Lead: log line 45");
      await expect(p.locator("button.aos-aw-older")).toHaveCount(0);
    } finally {
      fs.writeFileSync(channel, was);
    }
    await expect(p.locator(".aos-aw-event")).toHaveCount(11);
  });

  test("a team's views: a click or an arrow key picks one, keeping the keyboard; the pick holds across teams", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    await row("team:example").click();
    const selected = () => pane().locator(".aos-aw-view[aria-selected='true']");
    await expect(selected()).toHaveAttribute("data-view", "activity");
    await pane().locator(".aos-aw-view[data-view='items']").click();
    await expect(selected()).toHaveAttribute("data-view", "items");
    await expect(pane().locator(".aos-aw-viewpane")).toHaveAttribute("data-view", "items");
    await expect(pane().locator(".aos-aw-event")).toHaveCount(0);
    await expect(selected()).toBeFocused();
    await win.keyboard.press("ArrowRight");
    await expect(selected()).toHaveAttribute("data-view", "channel");
    await expect(selected()).toBeFocused();
    // Another team shows the same view; Activity is one click away.
    await row("team:survey").click();
    await expect(pane()).toHaveAttribute("data-node", "team:survey");
    await expect(selected()).toHaveAttribute("data-view", "channel");
    await pane().locator(".aos-aw-view[data-view='activity']").click();
    await expect(selected()).toHaveAttribute("data-view", "activity");
    // One board row, two events at its time, newest first as the feed is (the gate opened on the item just added); the
    // member by its roster name, as the tree has it.
    await expect(pane().locator(".aos-aw-evtext")).toHaveText(["Survey Lead opened the plan gate on survey-01", "Survey Lead added survey-01: Pick survey sites"]);
  });

  // ── a team's Items (D8), Channel (D9) and Settings (D10) ──

  const viewPane = (v: string) => pane().locator(`.aos-aw-viewpane[data-view='${v}']`);
  async function teamView(team: string, v: "activity" | "items" | "channel" | "settings"): Promise<void> {
    await openTab(app().win, "agent-teams");
    await row(`team:${team}`).click();
    await expect(pane()).toHaveAttribute("data-node", `team:${team}`);
    await pane().locator(`.aos-aw-view[data-view='${v}']`).click();
    await expect(viewPane(v)).toBeVisible();
  }
  const item = (id: string) => viewPane("items").locator(".aos-aw-item", { has: app().win.locator(".aos-aw-itemid", { hasText: id }) });
  const detail = () => viewPane("items").locator(".aos-at-detail");

  test("a row opens the item's detail: facts, posts, runs, budget", async () => {
    await teamView("example", "items");
    await expect(item("harbor-02")).toHaveAttribute("aria-expanded", "false");
    await item("harbor-02").click();
    await expect(item("harbor-02")).toHaveAttribute("aria-expanded", "true");
    await expect(item("harbor-02")).toHaveClass(/is-open/);
    const d = detail();
    await expect(d.locator(".aos-at-detailtitle")).toHaveText("Chart tile cache");
    expect(await d.locator(".aos-at-facts dt").allTextContents()).toEqual(["Stage", "Owner", "Budget", "Project"]);
    await expect(d.locator(".aos-at-facts dd")).toHaveText(["execute · working", "Builder", "$0 spent of $10", "harbor-map · phase 02 · workspaces/harbor-map"]);
    await expect(d.locator(".aos-at-posts .aos-at-post")).toHaveCount(2);
    await expect(d.locator(".aos-at-posts .aos-at-kind")).toHaveText(["assign", "handoff"]);
    await expect(d.locator(".aos-at-runs .aos-inv-row")).toHaveCount(1);
    await expect(d.locator(".aos-at-runs .aos-at-runwho")).toHaveText("Builder");
    await expect(d.locator(".aos-at-runs")).toContainText("$2.40");
    // A working item offers its budget stepper; Set budget stays disabled until the amount changes.
    await expect(d.locator(".aos-at-budget button", { hasText: "Set budget" })).toBeDisabled();
    // Its posts link opens the Channel on that item.
    await d.locator("a", { hasText: "All posts on this item in Channel" }).click();
    await expect(viewPane("channel")).toBeVisible();
    await expect(viewPane("channel").locator(".aos-nt-chip.is-active")).toHaveText("harbor-02");
    await expect(viewPane("channel").locator(".aos-at-channel .aos-at-post")).toHaveCount(2);
    await viewPane("channel").locator(".aos-nt-chip", { hasText: "All" }).click();
    await pane().locator(".aos-aw-view[data-view='items']").click();
    await expect(detail().locator(".aos-at-detailtitle")).toHaveText("Chart tile cache");
    await detail().locator(".aos-at-close").click();
    await expect(detail()).toHaveCount(0);
    await expect(item("harbor-02")).toHaveAttribute("aria-expanded", "false");
  });

  test("a paused item's detail says raising its budget lets work resume and opens the lead", async () => {
    await teamView("example", "items");
    await item("harbor-04").click();
    const d = detail();
    await expect(d.locator(".aos-at-facts dd").first()).toHaveText("plan · paused");
    await expect(d.locator(".aos-at-budget .aos-at-hint")).toHaveText("paused at its budget: raising it lets work resume, and opens Lead to take the next step");
    await d.locator(".aos-at-close").click();
    await expect(detail()).toHaveCount(0);
  });

  test("a gate card's item link opens the team's Items with that item's detail, from the team and from Needs you", async () => {
    await teamView("example", "activity");
    await pane().locator(".aos-aw-gates .aos-at-gate .aos-at-itemid", { hasText: "harbor-01" }).click();
    await expect(pane().locator(".aos-aw-view[aria-selected='true']")).toHaveAttribute("data-view", "items");
    await expect(item("harbor-01")).toHaveAttribute("aria-expanded", "true");
    await expect(detail().locator(".aos-at-detailtitle")).toHaveText("Tide table parser");
    await expect(detail().locator(".aos-at-gate .aos-at-approve")).toHaveText("Approve · $10");
    await detail().locator(".aos-at-close").click();
    await row("needs").click();
    await C().locator(".aos-aw-pane[data-node='needs'] .aos-at-gate .aos-at-itemid", { hasText: "survey-01" }).click();
    await expect(pane()).toHaveAttribute("data-node", "team:survey");
    await expect(item("survey-01")).toHaveAttribute("aria-expanded", "true");
    await expect(detail().locator(".aos-at-detailtitle")).toHaveText("Pick survey sites");
    await detail().locator(".aos-at-close").click();
  });

  test("channel: the posts with @mentions highlighted and item filter chips; the message box; drafts kept per team across a switch", async () => {
    await teamView("example", "channel");
    const ch = viewPane("channel");
    await expect(ch.locator(".aos-at-channel .aos-at-post")).toHaveCount(4);
    await expect(ch.locator(".aos-at-channel .aos-at-mention.is-known").first()).toHaveText("@builder");
    await expect(ch.locator(".aos-nt-filters .aos-nt-chip")).toHaveText(["All", "harbor-01", "harbor-03", "harbor-02"]);
    await ch.locator(".aos-nt-filters .aos-nt-chip", { hasText: "harbor-03" }).click();
    await expect(ch.locator(".aos-at-channel .aos-at-post")).toHaveCount(1);
    await expect(ch.locator(".aos-at-channel .aos-at-kind")).toHaveText("blocker");
    await ch.locator(".aos-nt-filters .aos-nt-chip", { hasText: "All" }).click();
    await expect(ch.locator("textarea.aos-at-msg")).toHaveAttribute("placeholder", "Message @lead. Enter sends, Shift+Enter adds a line.");
    await expect(ch.locator(".aos-at-send")).toBeDisabled();
    await expect(ch.locator(".aos-at-interactbar button")).toHaveText("Talk to Lead ❯_");
    // An unsent message stays with its team: across a view switch, and apart from another team's.
    await ch.locator("textarea.aos-at-msg").fill("Check the tide cache first");
    await expect(ch.locator(".aos-at-send")).toBeEnabled();
    await pane().locator(".aos-aw-view[data-view='activity']").click();
    await pane().locator(".aos-aw-view[data-view='channel']").click();
    await expect(viewPane("channel").locator("textarea.aos-at-msg")).toHaveValue("Check the tide cache first");
    await row("team:survey").click();
    await expect(viewPane("channel").locator("textarea.aos-at-msg")).toHaveValue("");
    await expect(viewPane("channel").locator("textarea.aos-at-msg")).toHaveAttribute("placeholder", "Message @surveylead. Enter sends, Shift+Enter adds a line.");
    await row("team:example").click();
    await expect(viewPane("channel").locator("textarea.aos-at-msg")).toHaveValue("Check the tide cache first");
    await viewPane("channel").locator("textarea.aos-at-msg").fill("");
  });

  test("settings: lead, reports to, parent, stages, gates and budget read-only; Pause; the Add picker; Open TEAM.md", async () => {
    const { win } = app();
    await teamView("example", "settings");
    const s = viewPane("settings");
    await expect(s.locator(".aos-aw-facts dt")).toHaveText(["Lead", "Reports to", "Parent", "Stages", "Gates", "Default budget"]);
    await expect(s.locator(".aos-aw-facts dd")).toHaveText(["Lead", "none", "none", "discuss → plan → execute → verify → ship", "discuss, ship", "$10"]);
    await expect(s.locator("input[type='text'], input[type='search'], input:not([type]), textarea")).toHaveCount(0);
    await expect(s.locator(".aos-aw-runstate")).toHaveText("Running: its seats can be dispatched");
    await expect(s.locator("button.aos-aw-pause")).toHaveText("Pause");
    // Add a member offers your agents that are not on the team. (The bench's harbor-scout has no agent file, so the
    // header test's sync now has taken it out of the list by now.)
    const offered = await s.locator(".aos-aw-add select option").allTextContents();
    expect(offered[0]).toBe("pick one of your agents");
    for (const a of ["field-researcher", "survey-lead"]) expect(offered.some((o) => o.startsWith(`${a}:`)), a).toBe(true);
    for (const a of ["team-lead", "team-builder", "team-reviewer"]) expect(offered.some((o) => o.startsWith(a)), a).toBe(false);
    await expect(s.locator(".aos-aw-add button", { hasText: "Add" })).toBeDisabled();
    // Open TEAM.md opens the team's file as a note.
    await s.locator("button", { hasText: "Open TEAM.md" }).click();
    await expect(notePath(win)).toHaveText("persona/teams/example/TEAM.md");
    await closeNotes(win);
    // A sub-team: who its lead reports to, and its parent, a link to the parent's Settings.
    await teamView("survey", "settings");
    await expect(s.locator(".aos-aw-facts dd")).toHaveText(["Survey Lead", "Lead (Example)", "Example", "plan → build → ship", "plan", "$5"]);
    await s.locator(".aos-aw-facts a", { hasText: "Example" }).click();
    await expect(pane()).toHaveAttribute("data-node", "team:example");
    await expect(pane().locator(".aos-aw-view[aria-selected='true']")).toHaveAttribute("data-view", "settings");
  });

  test("the broken team's pane is the error card with Open TEAM.md", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    await row("team:broken").click();
    await expect(pane()).toHaveAttribute("data-node", "team:broken");
    const card = pane().locator(".aos-aw-note.is-error");
    await expect(card).toContainText("persona/teams/broken/TEAM.md: unsupported TEAM.md line");
    await expect(pane().locator(".aos-aw-views")).toHaveCount(0);
    await expect(pane().locator(".aos-aw-now")).toHaveCount(0);
    await card.locator("button", { hasText: "Open TEAM.md" }).click();
    await expect(notePath(win)).toHaveText("persona/teams/broken/TEAM.md");
    await closeNotes(win);
  });

  // Last in this block: it adds a gate to the board the tests above count.
  test("a gate put on the board by the lead shows on the rail within a second, with another tab active, and in Needs you", async () => {
    const { win } = app();
    await openTab(win, "memory");
    const put = spawnSync(process.execPath, [FX.v("brain/scripts/team.js"), "put", "example", "--from", "lead", JSON.stringify({ id: "harbor-05", title: "Tile legend", stage: "ship", status: "gate", owner: "lead", gate: { name: "ship", state: "pending" } })],
      { env: appEnv(), encoding: "utf8" });
    expect(put.status, put.stderr).toBe(0);
    await expect(badge(win, "agent-teams")).toHaveText("3", { timeout: 2000 });
    await needsYou();
    await expect(row("needs").locator(".aos-aw-count")).toHaveText("3");
    await expect(needsPane().locator(".aos-aw-paneline")).toHaveText("3 gates waiting on you across 2 teams");
    await expect(needsPane().locator(".aos-at-gate")).toHaveCount(3);
    await expect(gate("harbor-05").locator(".aos-at-gatename")).toHaveText("Ship gate");
    await expect(gate("harbor-05").locator(".aos-at-teamtag")).toHaveText("Example");
  });
});

// The Items view's list · board choice is the HUD's (settings.agentWorkspace.items): its own app, closed and launched again.
test.describe.serial("Agent Workspace: Items as a list or a board", () => {
  let h: AppHandle | null = null;
  const app = (): AppHandle => { if (!h) throw new Error("the app is not running"); return h; };
  test.beforeAll(async () => { restoreFixture(); h = await launchApp(); });
  test.afterAll(async () => { await h?.close(); h = null; });
  const C = () => content(app().win);
  const pane = () => C().locator(".aos-aw-pane");
  const items = () => pane().locator(".aos-aw-viewpane[data-view='items']");
  const mode = (m: string) => pane().locator(`.aos-aw-viewbar .aos-aw-itemsmode .aos-aw-mode[data-mode='${m}']`);
  async function exampleItems(): Promise<void> {
    await openTab(app().win, "agent-teams");
    await C().locator(".aos-aw-tree .aos-aw-row[data-key='team:example']").click();
    await pane().locator(".aos-aw-view[data-view='items']").click();
    await expect(items()).toBeVisible();
  }

  test("items: rows in needs-me order with the stage strip; the toggle shows the board and is remembered after a restart", async () => {
    await exampleItems();
    // The list: a pending gate, then blocked, working, paused; done folded behind its toggle.
    const rows = items().locator(".aos-aw-item");
    await expect(rows.locator(".aos-aw-itemid")).toHaveText(["harbor-01", "harbor-03", "harbor-02", "harbor-04"]);
    await expect(rows.locator(".aos-aw-itemtitle")).toHaveText(["Tide table parser", "Offline sync", "Chart tile cache", "Offline tiles"]);
    await expect(rows.locator(".aos-aw-itemstate")).toHaveText(["discuss gate", "blocked", "working", "paused"]);
    await expect(rows.locator(".aos-aw-holder")).toHaveText(["Lead", "Reviewer", "Builder", "Lead"]);
    await expect(rows.locator(".aos-aw-money")).toHaveText(["$6 / $10", "$0 / $10", "$0 / $10", "$0 / $10"]);
    // One segment per stage: done green, current blue, the gate violet, blocked red, the rest empty.
    const strip = (i: number) => rows.nth(i).locator(".aos-aw-seg").evaluateAll((els) => els.map((e) => [...e.classList].find((c) => c.startsWith("is-"))));
    expect(await strip(0)).toEqual(["is-gate", "is-todo", "is-todo", "is-todo", "is-todo"]);
    expect(await strip(1)).toEqual(["is-done", "is-done", "is-done", "is-blocked", "is-todo"]);
    expect(await strip(2)).toEqual(["is-done", "is-done", "is-current", "is-todo", "is-todo"]);
    expect(await strip(3)).toEqual(["is-done", "is-current", "is-todo", "is-todo", "is-todo"]);
    await expect(rows.nth(0).locator(".aos-aw-strip")).toHaveAttribute("aria-label", "discuss: gate waiting on you, plan: to do, execute: to do, verify: to do, ship: to do");
    const done = items().locator(".aos-aw-donetoggle");
    await expect(done).toHaveText("1 done");
    await done.click();
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(4)).toHaveClass(/is-done/);
    await expect(rows.nth(4).locator(".aos-aw-itemid")).toHaveText("harbor-00");
    await items().locator(".aos-aw-donetoggle").click();
    await expect(rows).toHaveCount(4);
    await expect(mode("list")).toHaveAttribute("aria-pressed", "true");

    // The board: one column per stage, ◆ on gated stages, status chips, done items folded.
    await mode("board").click();
    await expect(mode("board")).toHaveAttribute("aria-pressed", "true");
    await expect(items().locator(".aos-aw-item")).toHaveCount(0);
    const cols = items().locator(".aos-at-col");
    await expect(cols.locator(".aos-at-colhead > span:first-child")).toHaveText(["DISCUSS", "PLAN", "EXECUTE", "VERIFY", "SHIP"]);
    await expect(items().locator(".aos-at-col", { hasText: "DISCUSS" }).locator(".aos-at-gatemark")).toHaveText("◆");
    await expect(items().locator(".aos-at-col", { hasText: "SHIP" }).locator(".aos-at-gatemark")).toHaveText("◆");
    await expect(items().locator(".aos-at-col", { hasText: "EXECUTE" }).locator(".aos-at-gatemark")).toHaveCount(0);
    const card = (id: string) => items().locator(".aos-at-card", { has: app().win.locator(".aos-at-itemid", { hasText: id }) });
    await expect(card("harbor-01").locator(".aos-at-chip")).toHaveText("discuss gate");
    await expect(card("harbor-01")).toHaveClass(/is-gate/);
    await expect(card("harbor-02").locator(".aos-at-chip")).toHaveText("working");
    await expect(card("harbor-03").locator(".aos-at-chip")).toHaveText("blocked");
    await expect(card("harbor-04").locator(".aos-at-chip")).toHaveText("paused");
    await expect(card("harbor-02").locator(".aos-at-cardmeta")).toContainText("Builder");
    await expect(card("harbor-00")).toHaveCount(0);
    const boardDone = items().locator(".aos-at-col", { hasText: "SHIP" }).locator(".aos-at-donetoggle");
    await expect(boardDone).toHaveText("1 done");
    await boardDone.click();
    await expect(card("harbor-00")).toHaveClass(/is-done/);
    await items().locator(".aos-at-donetoggle").click();
    // A card opens the same detail below the board.
    await card("harbor-02").click();
    await expect(items().locator(".aos-at-detail .aos-at-detailtitle")).toHaveText("Chart tile cache");
    await items().locator(".aos-at-detail .aos-at-close").click();
    await expect.poll(savedItems).toBe("board");

    // A restart keeps the board.
    await app().close();
    h = await launchApp();
    await exampleItems();
    await expect(mode("board")).toHaveAttribute("aria-pressed", "true");
    await expect(items().locator(".aos-at-board")).toBeVisible();
    await mode("list").click();
    await expect(items().locator(".aos-aw-item")).toHaveCount(4);
    await expect.poll(savedItems).toBe("list");
  });
});

// An agent's profile (D11) and a member whose agent is missing (D12), on their own app: no sync now runs here, so the
// bench's harbor-scout and the plugin's keeper, which have no file in any host's folder, stay listed.
test.describe("Agent Workspace: an agent's profile", () => {
  const app = useApp({ prepare: profileFixture });
  const C = () => content(app().win);
  const row = (key: string) => C().locator(`.aos-aw-tree .aos-aw-row[data-key="${key}"]`);
  const pane = () => C().locator(".aos-aw-pane");
  const seat = (team: string) => pane().locator(`.aos-aw-seat[data-team='${team}']`);
  const sections = () => pane().locator(".aos-aw-sec").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sec));
  async function show(key: string): Promise<void> {
    await openTab(app().win, "agent-teams");
    await row(key).first().click();
    await expect(pane()).toHaveAttribute("data-node", key);
  }

  test("a seated agent: hosts, ❯_ per enabled host, copy, open; NOW; one SEAT block per team with pickers; recent runs and the week's spend", async () => {
    const h = app();
    const { win } = h;
    await show("agent:team-builder");
    const p = pane();
    await expect(p).toHaveAttribute("aria-label", "team-builder");
    await expect(p.locator(".aos-aw-panetitle")).toHaveText("team-builder");
    // A Claude Code agent on a Claude Code-only machine: its pill on, Codex's absent, one ❯_.
    await expect(p.locator(".aos-aw-hostpill")).toHaveText(["claude", "codex"]);
    await expect(p.locator(".aos-aw-hostpill[data-host='claude']")).toHaveClass(/is-on/);
    await expect(p.locator(".aos-aw-hostpill[data-host='codex']")).toHaveClass(/is-absent/);
    await expect(p.locator("button.aos-aw-run")).toHaveText(["❯_ claude"]);
    await expect(p.locator("button.aos-aw-copy")).toHaveAttribute("title", "copy @agent-team-builder");
    const file = path.join(FX.claude, "agents", "team-builder.md");
    await p.locator("button.aos-aw-open").click();
    await expect.poll(async () => (await h.opened()).map((o) => `${o.fn} ${o.arg}`)).toContain(`openPath ${file}`);
    await expect(p.locator("input[type='text'], input[type='search'], input:not([type]), textarea")).toHaveCount(0);
    expect(await sections()).toEqual(["seat", "hosts", "runs"]);

    // SEAT: one block per team, with its role, what it is doing and its stages; the pickers hold the seat's own values,
    // from the presets aos team list names.
    await expect(p.locator(".aos-aw-seat")).toHaveCount(2);
    await expect(p.locator(".aos-aw-seat .aos-aw-seatteam")).toHaveText(["Example", "Survey"]);
    await expect(p.locator(".aos-aw-seat .aos-aw-seatrole")).toHaveText(["Builds the work", "Builds the survey tools"]);
    await expect(p.locator(".aos-aw-seat .aos-aw-seatstate")).toHaveText(["idle · harbor-02", "idle"]);
    await expect(p.locator(".aos-aw-seat .aos-aw-seatline")).toHaveText(["builder · stages discuss, plan, execute", "builder · stages build"]);
    for (const team of ["example", "survey"]) {
      for (const [k, v] of [["provider", "claude"], ["model", "inherit"], ["effort", "high"]]) {
        const sel = seat(team).locator(`.aos-aw-pick-${k} select`);
        await expect(sel).toBeEnabled();
        await expect(sel).toHaveValue(v);
      }
    }
    await expect(seat("example").locator("button")).toHaveText(["Pause seat", "Remove from Example"]);
    // Its team's name shows the team.
    await seat("survey").locator("a.aos-aw-seatteam").click();
    await expect(pane()).toHaveAttribute("data-node", "team:survey");
    await show("agent:team-builder");

    // HOSTS: Claude Code's own file and how to reach it; sharing is off on a one-host machine, so nothing to share.
    const hosts = p.locator(".aos-aw-sec[data-sec='hosts']");
    await expect(hosts.locator(".aos-aw-hostrow")).toHaveCount(1);
    await expect(hosts.locator(".aos-aw-hostrow[data-host='claude'] .aos-aw-hostvia")).toHaveText("original");
    await expect(hosts.locator(".aos-aw-hostinvoke")).toHaveText("@agent-team-builder");
    await expect(hosts.locator(".aos-aw-hostfile")).toHaveText(file);
    await expect(hosts.locator(".aos-aw-sharechip")).toHaveText("not shared yet");
    await expect(hosts.locator("button.aos-aw-share")).toHaveCount(0);

    // NOW: nothing runs; a seat's run goes live and shows by team, and its seat says so.
    const now = p.locator(".aos-aw-now");
    await expect(now.locator(".aos-aw-nowrest")).toHaveText("not running");
    const running = liveRun("builder", "harbor-02", 4);
    try {
      await expect(now.locator(".aos-aw-whoname")).toHaveText(["Example"]);
      await expect(now.locator(".aos-aw-whoitem")).toHaveText(/^harbor-02 · claude · [45]m$/);
      await expect(seat("example").locator(".aos-aw-seatstate")).toHaveText("working on harbor-02");
    } finally {
      fs.rmSync(running, { recursive: true, force: true });
    }
    await expect(now.locator(".aos-aw-nowrest")).toHaveText("not running");

    // RECENT RUNS: its seats' runs across teams and this week's spend; Runs → opens the Runs tab.
    await expect(p.locator(".aos-aw-weekusd")).toHaveText(`${weekSpend("example", "builder")} this week`);
    await expect(p.locator(".aos-aw-runtext")).toHaveText(["Example · harbor-02 · ok · claude · $2.40"]);
    await p.locator("a.aos-aw-runslink").click();
    await expect(rail(win, "runs")).toHaveClass(/is-active/);

    // ❯_ claude starts a Claude Code session as the agent.
    await show("agent:team-builder");
    await pane().locator("button.aos-aw-run").click();
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture claude stub] --agent team-builder");
  });

  test("a bench agent; a read-only agent's pill; a plugin agent shows no SEAT or sharing; a member without an agent shows its seat and \"no agent\"", async () => {
    // The bench: no seat, Seat in… every readable team (not the broken one), no runs.
    await show("agent:harbor-scout");
    const p = pane();
    await expect(p.locator(".aos-aw-panetitle")).toHaveText("harbor-scout");
    expect(await sections()).toEqual(["seat", "hosts", "runs"]);
    await expect(p.locator(".aos-aw-seat")).toHaveCount(0);
    await expect(p.locator(".aos-aw-sec[data-sec='seat'] .aos-aw-empty")).toHaveText("seated in no team: it is on the bench");
    await expect(p.locator(".aos-aw-seatin select option")).toHaveText(["pick a team", "Example", "Survey"]);
    await expect(p.locator(".aos-aw-seatin button", { hasText: "Seat" })).toBeDisabled();
    await expect(p.locator(".aos-aw-now .aos-aw-nowrest")).toHaveText("not running");
    await expect(p.locator(".aos-aw-weekusd")).toHaveText("$0 this week");
    await expect(p.locator(".aos-aw-sec[data-sec='runs'] .aos-aw-empty")).toHaveText("no runs: it sits in no team");
    await expect(p.locator(".aos-aw-ro")).toHaveCount(0);

    // An agent whose tools cannot write (Read, Grep, Glob) carries the read-only pill in HOSTS.
    await row("agent:field-researcher").first().click();
    await expect(pane()).toHaveAttribute("data-node", "agent:field-researcher");
    await expect(p.locator(".aos-aw-sec[data-sec='hosts'] .aos-aw-ro")).toHaveText("read-only");

    // A plugin's agent: the header and HOSTS only.
    await row("section:plugins").click();
    await row("agent:logbook:keeper").click();
    await expect(pane()).toHaveAttribute("data-node", "agent:logbook:keeper");
    await expect(p.locator(".aos-aw-panetitle")).toHaveText("keeper");
    await expect(p.locator(".aos-aw-source")).toHaveText("logbook");
    expect(await sections()).toEqual(["hosts"]);
    for (const cls of ["aos-aw-now", "aos-aw-seat", "aos-aw-seatin", "aos-aw-sharechip", "aos-aw-share"]) await expect(p.locator(`.${cls}`), cls).toHaveCount(0);
    await expect(p.locator(".aos-aw-hostfoot")).toContainText("listed from logbook, not copied");
    await expect(p.locator("button.aos-aw-run")).toHaveText(["❯_ claude"]);
    await row("section:plugins").click();

    // A member whose agent is in no host's folder: dim "no agent" in the tree; its pane is its seat with that note.
    const scribe = row("member:survey/scribe");
    await expect(scribe.locator(".aos-aw-label")).toHaveText("Scribe");
    await expect(scribe.locator(".aos-aw-noagent")).toHaveText("no agent");
    await scribe.click();
    await expect(pane()).toHaveAttribute("data-node", "member:survey/scribe");
    await expect(p.locator(".aos-aw-panetitle")).toHaveText("Scribe");
    await expect(p.locator(".aos-aw-noagentnote")).toHaveText("no agent: harbor-ghost is not one of your agents, so this seat cannot run");
    expect(await sections()).toEqual(["seat"]);
    await expect(p.locator(".aos-aw-seat")).toHaveCount(1);
    await expect(seat("survey").locator(".aos-aw-seatrole")).toHaveText("Keeps the survey log");
    await expect(seat("survey").locator("button")).toHaveText(["Pause seat", "Remove from Survey"]);
    await expect(p.locator(".aos-aw-seatin")).toHaveCount(0);
  });

  // This app runs with no write surface on (the app's default here), so `aos team` is refused before it starts.
  test("with the Agent Teams surface off, a seat pick is refused: the seat says why, and the board, the channel and TEAM.md stay", async () => {
    const h = app();
    await show("agent:team-reviewer");
    const dir = FX.v("persona/teams/example");
    const files = () => ["board.jsonl", "channel.jsonl", "TEAM.md"].map((f) => fs.readFileSync(`${dir}/${f}`, "utf8"));
    const before = files();
    const sets = async () => (await h.guard()).filter((e) => e.kind === "spawn" && / set /.test(e.what)).map((e) => e.what);
    expect(await sets()).toEqual([]);
    const effort = () => seat("example").locator(".aos-aw-pick-effort select");
    await expect(effort()).toBeEnabled();
    await effort().selectOption("low");
    await expect(seat("example").locator(".aos-at-error")).toContainText("refused; no write surface that allows it is on");
    await expect.poll(sets).toEqual([expect.stringMatching(/\/team\.js set example reviewer effort low$/)]);
    expect(files()).toEqual(before);
    await expect(effort()).toHaveValue("high");
    await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
  });
});

test.describe("a stale agents cache", () => {
  const backdate = (): void => {
    const c = readCache();
    c.scannedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    writeCache(c);
  };
  const app = useApp({ prepare: backdate });
  const C = () => content(app().win);
  const syncs = () => app().notices.filter((n) => n === SYNC).length;

  test("a stale agents cache spawns aos agents sync once", async () => {
    const h = app();
    await openTab(h.win, "agent-teams");
    await expect.poll(syncs).toBe(1);
    await openTab(h.win, "pulse");
    await openTab(h.win, "agent-teams");
    await h.win.waitForTimeout(500);
    expect(syncs()).toBe(1);
  });

  test("with no agents cache, BENCH holds a dim note that is never picked; a member has no \"no agent\" mark, and its pane is its seat", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    const before = await C().locator(".aos-aw-pane").getAttribute("data-node");
    fs.rmSync(FX.v(AGENTS));
    const note = C().locator(".aos-aw-tree [data-key='bench:unscanned']");
    await expect(note).toHaveText("not scanned yet — sync now");
    await expect(note).toHaveClass(/is-note/);
    expect(await note.evaluate((e) => ["tabindex", "aria-expanded", "aria-selected"].filter((a) => e.hasAttribute(a)))).toEqual([]);
    await expect(C().locator(".aos-aw-sharing")).toHaveText("not scanned yet — sync now builds the list");
    // aria-disabled: Playwright will not click it, so the click is sent to it as the mouse would.
    await note.dispatchEvent("click");
    await expect(C().locator(".aos-aw-pane")).toHaveAttribute("data-node", before ?? "needs");
    // Members whose agent is not in the (empty) cache keep their place under their team, with no "no agent" mark: nothing
    // can be called missing before the list is built (Review focus 2). The pane falls back to the seat.
    const lead = C().locator(".aos-aw-tree [data-key='member:example/lead']");
    await expect(lead.locator(".aos-aw-label")).toHaveText("Lead");
    await expect(lead.locator(".aos-aw-noagent")).toHaveCount(0);
    expect(await lead.getAttribute("title")).toBeNull();
    await lead.click();
    const pane = C().locator(".aos-aw-pane");
    await expect(pane).toHaveAttribute("data-node", "member:example/lead");
    await expect(pane.locator(".aos-aw-panetitle")).toHaveText("Lead");
    await expect(pane.locator(".aos-aw-noagentnote")).toHaveText("the agents list is not scanned yet — sync now builds it; this seat runs team-lead");
    await expect(pane.locator(".aos-aw-seat[data-team='example'] .aos-aw-seatrole")).toHaveText("Team lead");
    await expect(pane).not.toContainText("not one of your agents");
  });
});

test.describe("both hosts, with the sharing surface off", () => {
  const app = useApp({ prepare: shareBothHosts });
  const C = () => content(app().win);

  test("an agent's unshare is refused: the Notice says why, and the config and the Codex copy stay", async () => {
    const h = app();
    const cfg = fs.readFileSync(FX.v("brain/config.json"), "utf8");
    const copy = path.join(FX.home, ".codex", "agents", "team-reviewer.toml");
    const before = fs.readFileSync(copy, "utf8");
    await openTab(h.win, "agent-teams");
    await C().locator(".aos-aw-tree .aos-aw-row[data-key='agent:team-reviewer']").first().click();
    const hosts = C().locator(".aos-aw-pane[data-node='agent:team-reviewer'] .aos-aw-sec[data-sec='hosts']");
    await expect(hosts.locator(".aos-aw-sharechip")).toHaveText("on both");
    await hosts.locator("button.aos-aw-share", { hasText: /^unshare$/ }).click();
    await expect.poll(async () => (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what))
      .toContainEqual(expect.stringMatching(/\/cli\/aos\.js agents exclude team-reviewer$/));
    await expect(h.win.locator(".notice-container")).toContainText("spawn failed: brain/scripts/cli/aos.js");
    await expect(hosts.locator(".aos-aw-sharechip")).toHaveText("on both");
    expect(fs.readFileSync(FX.v("brain/config.json"), "utf8")).toBe(cfg);
    expect(fs.readFileSync(copy, "utf8")).toBe(before);
    await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
  });
});
