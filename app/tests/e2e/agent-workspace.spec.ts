// Agent Workspace (spec 2026-11-12-agent-workspace-design D2-D7, D13, D16): one rail button for agents and the teams they
// sit in. The rail button and its gate count, the `agents` alias and links, the tree (Needs you, the teams nested by
// parent with their members, the bench, plugin agents folded) and its keys, the filter, the header (counts, sharing, sync
// now, + New team) and the stale-cache sync; the Needs you pane (every pending gate card: presets, Approve asks first,
// Redirect ❯_) and a team's pane (its header line, NOW, its gates, Activity). The agent pane comes later. Read-only:
// approving and the other writes are in teams-writes.spec.ts.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, HUD_SETTINGS, appEnv, badge, content, guardWrites, openTab, pulseArea, rail, terminalText, useApp } from "./harness";

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
/** What the team spent in the last seven days, as the pane writes it: the fixture's runs are dated from when it was built. */
function weekSpend(team: string): string {
  const runs = fs.readFileSync(FX.v(`persona/teams/${team}/runs.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { ts: string; usd: number | null });
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

  test("the header: counts, sharing state, sync now, + New team", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "agent-teams");
    await expect(C().locator(".aos-aw-title")).toHaveText("Agent Workspace");
    // Your agents (not plugin ones), every team, live runs, pending gates.
    await expect(C().locator(".aos-aw-counts")).toHaveText("6 agents · 3 teams · 0 running · 2 gates");
    await expect(C().locator(".aos-aw-sharing")).toHaveText("sharing off — sharing needs both hosts enabled");
    // + New team is there; its dialog comes later, so a click opens nothing and runs nothing. (The tab's own background
    // refreshes may land meanwhile: the team sweep and the agents sync.)
    const btn = C().locator("button.aos-aw-new");
    await expect(btn).toHaveText("+ New team");
    const ours = async () => (await h.guard()).filter((e) => !/ list --json$|agents sync$/.test(e.what)).length;
    const spawns = await ours();
    await btn.click();
    await win.waitForTimeout(300);
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
      "Lead added harbor-01: Tide table parser",
      "Lead opened the discuss gate on harbor-01",
      "Lead added harbor-04: Offline tiles",
      "Lead added harbor-03: Offline sync",
      "Lead added harbor-02: Chart tile cache",
      "Lead added harbor-00: Scaffold the viewer",
      "Reviewer finished harbor-03: failed · codex",
      "Builder finished harbor-02: ok · claude · $2.40",
    ]);
    await expect(p.locator(".aos-aw-evtime").first()).toHaveText(/^\d+[mhd]$/);
    await expect(p.locator(".aos-aw-event").first().locator(".aos-aw-dot")).toHaveClass(/is-failed/);
    await expect(p.locator(".aos-aw-event").nth(4).locator(".aos-aw-dot")).toHaveClass(/is-gate/);
    await expect(p.locator("button.aos-aw-older")).toHaveCount(0);

    // A seat's run goes live (its marker, from another machine, so no sweep closes it): the builder is at work.
    const running = FX.v("persona/teams/example/running");
    fs.mkdirSync(running, { recursive: true });
    fs.writeFileSync(path.join(running, "example-harbor-02-builder-z.json"), JSON.stringify({
      schema: 1, run: "example-harbor-02-builder-z", team: "example", member: "builder", item: "harbor-02", provider: "claude",
      pid: 999999, pidStart: 0, host: "another-machine.test", startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), reservedUsd: 2,
    }));
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
    // One board row, two events at its time, in the order they happened; the member by its roster name, as the tree has it.
    await expect(pane().locator(".aos-aw-evtext")).toHaveText(["Survey Lead added survey-01: Pick survey sites", "Survey Lead opened the plan gate on survey-01"]);
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

  test("with no agents cache, BENCH holds a dim note that is never picked", async () => {
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
    // Members whose agent is not in the (empty) cache keep their place under their team.
    await expect(C().locator(".aos-aw-tree [data-key='member:example/lead'] .aos-aw-label")).toHaveText("Lead");
  });
});
