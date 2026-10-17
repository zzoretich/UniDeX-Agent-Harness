// Skills and Agents (app-smoke: Skills, Agents): the inventories `aos skills sync` / `aos agents sync` wrote for a
// Claude-Code-only machine (sharing off), host pills, source pills and chips, the filter, and the run / copy / open
// actions (the stale-cache sync is checked by its notice, which the HUD raises whether the spawn is allowed or refused).
// On a machine with both hosts and the sharing surface off, unshare is refused. share / unshare themselves, and sync
// now, are in sharing-writes.spec.ts.

import { expect, test, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, content, openTab, readVaultJson, shareBothHosts, terminalText, useApp } from "./harness";

interface Row { name: string; status: string; origin: { scope: string; host?: string; plugin?: string | null; path?: string }; on: Record<string, { invoke: string } | null> }
const yours = (r: Row) => ["user", "synced", "mirror"].includes(r.origin.scope);

/** Redraws the tab as a sync landing does (its cache rewritten, the same bytes) and waits until the filter that had the
 *  focus is replaced: the redraw CI met between the click in the filter and the typing. */
async function redrawUnder(filter: Locator, rel: string): Promise<void> {
  const old = await filter.elementHandle();
  const file = FX.v(rel);
  fs.writeFileSync(file, fs.readFileSync(file));
  await expect.poll(() => old!.evaluate((e) => e.isConnected)).toBe(false);
}

test.describe("Skills and Agents", () => {
  const app = useApp();
  const C = () => content(app().win);
  const skillRow = (name: string) => C().locator(".aos-sk-row", { has: app().win.locator(".aos-sk-name > div:first-child", { hasText: new RegExp(`^${name}`) }) });

  test("Skills: head counts, the sharing note, YOUR SKILLS then PLUGINS & BUILT-INS", async () => {
    await openTab(app().win, "skills");
    const cache = readVaultJson<{ skills: Row[] }>("brain/_index/skills.json");
    const mine = cache.skills.filter(yours);
    const listed = cache.skills.filter((r) => !yours(r));
    await expect(C().locator(".aos-rt-count")).toHaveText(`0 on both · ${mine.length} Claude Code only · 0 Codex only · ${listed.length} from plugins`);
    await expect(C().locator(".aos-rt-note")).toHaveText("sharing off — sharing needs both hosts enabled");
    // MCP SERVERS (install-import B6) closes the list; history-mcp.spec.ts covers it.
    await expect(C().locator(".aos-sk-list .aos-rt-subhead")).toHaveText([
      `YOUR SKILLS (${mine.length})`, `PLUGINS & BUILT-INS (${listed.length}) — listed, not copied: they need their plugin's tools`,
      /^MCP SERVERS \(4\) — each host's own; Make available on … copies one through that host's CLI, when you confirm · listed /,
    ]);
    const first = C().locator(".aos-sk-table").first();
    await expect(first.locator(".aos-sk-name > div:first-child")).toHaveText(mine.map((r) => r.name));
  });

  test("Skills: a row carries a cyan claude pill, a struck codex pill, its source and chip, and no share toggle while sharing is off", async () => {
    await openTab(app().win, "skills");
    const r = skillRow("tide-report");
    await expect(r.locator(".aos-sk-desc")).toHaveText("Summarise the week's tide readings for the harbor map workspace.");
    await expect(r.locator(".aos-sk-pills .aos-pill")).toHaveText(["claude", "codex"]);
    await expect(r.locator(".aos-sk-pills .aos-pill").first()).toHaveClass(/aos-pill-cyan/);
    await expect(r.locator(".aos-sk-pills .aos-pill").nth(1)).toHaveClass(/is-absent/);
    await expect(r.locator(".aos-sk-source")).toHaveText("claude");
    await expect(r.locator(".aos-pulse-chip")).toHaveText("not shared yet");
    await expect(r.locator(".aos-sk-actions a")).toHaveText(["❯_ claude", "⧉", "open"]);
    // Plugin skills: the plugin as the source, invoked as /<plugin>:<skill>.
    const plugin = skillRow("log-entry");
    await expect(plugin.locator(".aos-sk-source")).toHaveText("logbook");
    await expect(plugin.locator(".aos-pulse-chip")).toHaveText("plugin");
    await expect(plugin.locator(".aos-sk-actions a").first()).toHaveAttribute("title", "run in a new Claude Code session: claude '/logbook:log-entry'");
  });

  test("Skills: the filter narrows every section by name, description, plugin or program, keeping focus", async () => {
    const { win } = app();
    await openTab(win, "skills");
    const filter = C().locator("input.aos-sk-filter");
    const skills = C().locator(".aos-sk-row:not(.aos-sk-mcprow) .aos-sk-name > div:first-child");
    const servers = C().locator(".aos-sk-mcprow .aos-sk-name > div:first-child");
    await filter.click();
    await redrawUnder(filter, "brain/_index/skills.json");
    await win.keyboard.type("chart");
    await expect(skills).toHaveText(["chart-check"]);
    // MCP SERVERS (install-import B6): a server's name or its program or URL.
    await expect(servers).toHaveText(["chart-api"]);
    await expect(filter).toBeFocused();
    await filter.fill("logbook");
    await expect(skills).toHaveText(["log-entry"]);
    await expect(C().locator(".aos-sk-table").first()).toContainText("no match");
    await expect(C().locator(".aos-sk-mcp")).toHaveText("no match");
    await filter.fill("");
  });

  test("Skills: open hands the SKILL.md to the OS; ❯_ claude runs the skill in a new terminal in Code", async () => {
    const h = app();
    await openTab(h.win, "skills");
    await skillRow("tide-report").locator(".aos-sk-actions a", { hasText: "open" }).click();
    await expect.poll(async () => (await h.opened()).map((o) => `${o.fn} ${o.arg}`)).toContain(`openPath ${path.join(FX.claude, "skills", "tide-report", "SKILL.md")}`);
    await skillRow("tide-report").locator(".aos-sk-actions a", { hasText: "❯_ claude" }).click();
    await expect(h.win.locator(".aos-wb-railbtn[data-tab='term']")).toHaveClass(/is-active/);
    await expect.poll(() => terminalText(h.win), { timeout: 10_000 }).toContain("[fixture claude stub] /tide-report");
  });

  // The OS clipboard is shared with the machine running the tests: save what is there and put it back.
  test("Skills: ⧉ copies the invocation to the clipboard", async () => {
    const h = app();
    await openTab(h.win, "skills");
    const saved = await h.app.evaluate(({ clipboard }) => clipboard.readText());
    try {
      await skillRow("tide-report").locator(".aos-sk-actions a", { hasText: "⧉" }).click();
      await expect.poll(() => h.notices).toContain("copied /tide-report");
      expect(await h.app.evaluate(({ clipboard }) => clipboard.readText())).toBe("/tide-report");
    } finally {
      await h.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved);
    }
  });

  test("Agents: head counts, the sharing note, the read-only pill and how to reach an agent", async () => {
    await openTab(app().win, "agents");
    const cache = readVaultJson<{ agents: Row[] }>("brain/_index/agents.json");
    const mine = cache.agents.filter(yours);
    const listed = cache.agents.filter((r) => !yours(r));
    await expect(C().locator(".aos-rt-count")).toHaveText(`0 on both · ${mine.length} Claude Code only · 0 Codex only · ${listed.length} from plugins and config.toml`);
    await expect(C().locator(".aos-rt-note").first()).toHaveText("sharing off — sharing needs both hosts enabled");
    await expect(C().locator(".aos-sk-list .aos-rt-subhead").first()).toHaveText(`YOUR AGENTS (${mine.length})`);
    const researcher = skillRow("field-researcher");
    await expect(researcher.locator(".aos-ag-ro")).toHaveText("read-only");
    await expect(C().locator(".aos-ag-ro")).toHaveCount(1);
    await expect(researcher.locator(".aos-sk-pills .aos-pill")).toHaveText(["claude", "codex"]);
    await expect(researcher.locator(".aos-sk-actions a").first()).toHaveAttribute("title", /claude --agent field-researcher/);
    await expect(researcher.locator(".aos-sk-actions a", { hasText: "⧉" })).toHaveAttribute("title", "copy @agent-field-researcher");
  });

  test("Agents: the filter narrows without losing focus", async () => {
    const { win } = app();
    await openTab(win, "agents");
    const filter = C().locator("input.aos-sk-filter");
    await filter.click();
    await win.keyboard.type("te");
    // A redraw mid-typing keeps the letters and the focus.
    await redrawUnder(filter, "brain/_index/agents.json");
    await win.keyboard.type("am-");
    await expect(C().locator(".aos-sk-row .aos-sk-name > div:first-child")).toHaveText(["team-builder", "team-lead", "team-reviewer"]);
    await expect(filter).toBeFocused();
    await filter.fill("");
  });
});

test.describe("stale inventories", () => {
  // Caches older than ten minutes: opening the tab asks the runtime for a sync, once.
  const backdate = (rel: string) => {
    const file = FX.v(rel);
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { scannedAt: string };
    j.scannedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
  };
  const app = useApp({ prepare: () => { backdate("brain/_index/skills.json"); backdate("brain/_index/agents.json"); } });

  test("opening Skills with a cache older than ten minutes spawns `aos skills sync` once; Agents the same", async () => {
    const h = app();
    await openTab(h.win, "skills");
    await expect.poll(() => h.notices.filter((n) => n === "▶ aos.js skills sync").length).toBe(1);
    await openTab(h.win, "pulse");
    await openTab(h.win, "skills");
    await h.win.waitForTimeout(500);
    expect(h.notices.filter((n) => n === "▶ aos.js skills sync").length).toBe(1);
    await openTab(h.win, "agents");
    await expect.poll(() => h.notices.filter((n) => n === "▶ aos.js agents sync").length).toBe(1);
  });
});

test.describe("both hosts, with the sharing surface off", () => {
  const app = useApp({ prepare: shareBothHosts });
  const C = () => content(app().win);

  test("unshare is refused for a skill and an agent: the Notice says why, and the config and the Codex copies stay", async () => {
    const h = app();
    const cfg = fs.readFileSync(FX.v("brain/config.json"), "utf8");
    const copies = [path.join(FX.home, ".agents", "skills", "tide-report", "SKILL.md"), path.join(FX.home, ".codex", "agents", "team-reviewer.toml")];
    const before = copies.map((f) => fs.readFileSync(f, "utf8"));
    for (const [kind, name] of [["skills", "tide-report"], ["agents", "team-reviewer"]] as const) {
      await openTab(h.win, kind);
      const r = C().locator(".aos-sk-row", { has: h.win.locator(".aos-sk-name > div:first-child", { hasText: new RegExp(`^${name}`) }) });
      await r.locator(".aos-sk-actions a", { hasText: /^unshare$/ }).click();
      await expect.poll(async () => (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what))
        .toContainEqual(expect.stringMatching(new RegExp(`/cli/aos\\.js ${kind} exclude ${name}$`)));
      await expect(h.win.locator(".notice-container")).toContainText("spawn failed: brain/scripts/cli/aos.js");
      await expect(r.locator(".aos-pulse-chip")).toHaveText("on both");
    }
    expect(fs.readFileSync(FX.v("brain/config.json"), "utf8")).toBe(cfg);
    expect(copies.map((f) => fs.readFileSync(f, "utf8"))).toEqual(before);
    await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
  });
});
