// Agent Workspace (spec 2026-11-12-agent-workspace-design D2-D5, D13, D16): one rail button for agents and the teams they
// sit in. The rail button and its gate count, the `agents` alias and links, the tree (Needs you, the teams nested by
// parent with their members, the bench, plugin agents folded) and its keys, the filter, the header (counts, sharing, sync
// now, + New team) and the stale-cache sync. The panes the tree selects come later; here each names its node. Read-only.

import { expect, test, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, HUD_SETTINGS, badge, content, openTab, pulseArea, rail, useApp } from "./harness";

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
