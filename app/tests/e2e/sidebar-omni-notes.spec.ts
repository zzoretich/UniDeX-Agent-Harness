// The sidebar HUD, ⌘K omnisearch, the note view with link following, the heartbeat pill, Sessions without a provider and
// the Term tab (app-smoke: Pulse heartbeat pill, Chat `none`, Term, Review readiness; phase-0 surfaces).

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, closeNotes, command, content, expected, noteBar, noteBody, notePath, openTab, rail, readVaultJson, terminalText, useApp } from "./harness";

const app = useApp();
const side = () => app().win.locator(".aos-host-right");

test.describe("sidebar HUD", () => {
  test.beforeAll(async () => { await command(app().win, "agentic-os:open-sidebar-hud"); });

  test("opens in the right pane with LEDs, model and effort, the live pill and the heartbeat pill", async () => {
    await expect(side()).not.toHaveClass(/is-empty/);
    await expect(side().locator(".aos-host-tab-title")).toHaveText("UniDeX");
    await expect(side().locator(".aos-sb-title")).toHaveText("UniDeX");
    await expect(side().locator(".aos-sb-clock")).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
    await expect(side().locator(".aos-hud-leds .aos-pulse-chip", { hasText: "EMBED off" })).toBeVisible();
    const pills = side().locator(".aos-sb-status .aos-pill");
    await expect(pills.nth(0)).toHaveText("sonnet");    // ~/.claude/settings.json model
    await expect(pills.nth(1)).toHaveText("medium");    // and effortLevel
    await expect(pills.nth(2)).toHaveText(/^⚡ (live|idle)$/);
    // The watchdog ran once (aos routines run heartbeat); the duties themselves never have, so the pill is amber.
    const beat = side().locator(".aos-sb-status .aos-pill", { hasText: "♥" });
    await expect(beat).toHaveText(/^♥ \d+[smh] ago$/);
    await expect(beat).toHaveClass(/aos-pill-amber/);
    await expect(beat).toHaveAttribute("title", /^watchdog checked .*\nmonitor: never · last never · next /);
  });

  test("trend tiles, scan age and health, the staff strip and the recent-runs ticker", async () => {
    const snap = readVaultJson<{ capabilities: { agents: { count: number }; skills: { count: number } }; config: { memoryMd: { pointers: number } }; brain: { counts: { sessions: number } } }>("brain/_index/snapshot.json");
    await expect(side().locator(".aos-sb-trend .aos-sb-trend-label")).toHaveText(["agents", "memories", "skills", "sessions"]);
    await expect(side().locator(".aos-sb-trend .aos-sb-trend-value")).toHaveText([
      String(snap.capabilities.agents.count), String(snap.config.memoryMd.pointers), String(snap.capabilities.skills.count), String(snap.brain.counts.sessions),
    ]);
    await expect(side().locator(".aos-sb-meta > div").first()).toHaveText(/^scan \d+[smh] ago$/);
    await expect(side().locator(".aos-sb-meta > div").nth(1)).toHaveText(/^\d+ err · \d+ warn$/);
    const staff = fs.readdirSync(FX.v("brain/agents")).filter((d) => fs.existsSync(FX.v(`brain/agents/${d}/heartbeat.json`))).sort();
    await expect(side().locator(".aos-sb-staff .aos-sb-staff-name")).toHaveText(staff);
    await expect(side().locator(".aos-sb-ticker .aos-sb-ticker-row")).toHaveCount(6);
    await expect(side().locator(".aos-sb-ticker .aos-sb-tk-name").first()).toHaveText("standup");
    await expect(side().locator(".aos-sb-ticker .aos-dot-err")).toHaveCount(1);
  });

  test("the heartbeat pill is green when every duty is on time, amber when the check is two hours old, rose with a missed duty", async () => {
    const file = FX.v("brain/_index/persona-heartbeat.json");
    const hb = JSON.parse(fs.readFileSync(file, "utf8")) as { checkedAt: string; beats: Record<string, { status: string; kind?: string }> };
    const beat = side().locator(".aos-sb-status .aos-pill", { hasText: "♥" });
    // What the watchdog writes once each duty has run on schedule (the file is watched: no reload).
    const onTime = { ...hb, checkedAt: new Date().toISOString(), beats: Object.fromEntries(Object.entries(hb.beats).map(([k, b]) => [k, b.kind === "duty" ? { ...b, status: "ok" } : b])) };
    fs.writeFileSync(file, JSON.stringify(onTime, null, 2));
    await expect(beat).toHaveClass(/aos-pill-green/, { timeout: 2000 });
    const green = onTime;
    fs.writeFileSync(file, JSON.stringify({ ...green, checkedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }, null, 2));
    await expect(beat).toHaveClass(/aos-pill-amber/, { timeout: 2000 });
    await expect(beat).toHaveAttribute("title", /is the heartbeat routine running\?/);
    const missed = { ...green, beats: { ...green.beats, monitor: { ...green.beats.monitor, status: "missed" } } };
    fs.writeFileSync(file, JSON.stringify(missed, null, 2));
    await expect(beat).toHaveClass(/aos-pill-rose/, { timeout: 2000 });
    await expect(beat).toHaveText(/· 1 missed$/);
    fs.writeFileSync(file, JSON.stringify(hb, null, 2));
    await expect(beat).toHaveClass(/aos-pill-amber/, { timeout: 2000 });
  });
});

test.describe("⌘K omnisearch", () => {
  test("⌘K opens the palette; the topbar ⌕ too; Escape closes it", async () => {
    const { win } = app();
    await openTab(win, "pulse");
    await win.keyboard.press("Meta+K");
    const prompt = win.locator(".modal.prompt");
    await expect(prompt.locator(".prompt-input")).toBeFocused();
    await expect(prompt.locator(".prompt-input")).toHaveAttribute("placeholder", "Search files, memories, runs, agents, skills, actions…");
    await win.keyboard.press("Escape");
    await expect(win.locator(".modal.prompt")).toHaveCount(0);
    await win.locator('.aos-wb-railact[data-action="search"]').click();
    await expect(win.locator(".modal.prompt .prompt-input")).toBeVisible();
    await win.keyboard.press("Escape");
  });

  test("results span memories, runs, agents and actions; a memory opens as a note", async () => {
    const { win } = app();
    await openTab(win, "pulse");
    await win.keyboard.press("Meta+K");
    const input = win.locator(".modal.prompt .prompt-input");
    const kinds = () => win.locator(".modal.prompt .suggestion-item .aos-omni-kind").allTextContents();
    // Workspace-map files, memories, runs, staff agents and Fix Queue / deck actions, in that order; an empty query shows
    // the first 50 (the suggestion limit, as Obsidian's), which the fixture's memories fill before the actions, so the
    // queries below reach those.
    await expect.poll(async () => [...new Set(await kinds())]).toEqual(["file", "memory", "run", "agent"]);
    expect(await kinds()).toHaveLength(50);
    await input.fill("tide api");
    await expect(win.locator(".suggestion-item").first().locator(".aos-omni-label")).toHaveText("Tide API notes");
    await expect(win.locator(".suggestion-item").first().locator(".aos-omni-hint")).toHaveText("reference · tide-api-notes");
    await input.fill("missing cost");   // the Pulse Fix Queue's backfill card
    await expect(win.locator(".suggestion-item").first().locator(".aos-omni-kind")).toHaveText("action");
    await expect(win.locator(".suggestion-item").first().locator(".aos-omni-label")).toHaveText("2 session(s) missing cost");
    await input.fill("/reflect-week");  // a command-deck action
    await expect(win.locator(".suggestion-item").first().locator(".aos-omni-label")).toHaveText(/^\/reflect-week — /);
    await input.fill("reflect-week");
    await expect(win.locator(".suggestion-item").first().locator(".aos-omni-kind")).toHaveText("run");
    await input.fill("tide api");
    await win.keyboard.press("Enter");
    await expect(win.locator(".modal.prompt")).toHaveCount(0);
    await expect(notePath(win)).toHaveText("brain/memory/reference/tide-api-notes.md");
    await closeNotes(win);
  });

  test("a run result opens Runs with that run's drawer", async () => {
    const { win } = app();
    await win.keyboard.press("Meta+K");
    await win.locator(".modal.prompt .prompt-input").fill("reflect-week");
    await win.keyboard.press("Enter");
    await expect(rail(win, "runs")).toHaveClass(/is-active/);
    await expect(win.locator(".aos-wb-drawer .aos-wb-drawertitle")).toHaveText("run -week-bbbb");
    await win.locator(".aos-wb-drawer .aos-wb-draweractions a", { hasText: "✕" }).click();
  });
});

test.describe("note view", () => {
  test("a note opens rendered and read-only (Edit disabled without Notes), with Show in Finder handed to the OS and no Open in Obsidian", async () => {
    const h = app();
    const { win } = h;
    await win.evaluate(() => (window as unknown as { aosHost: { app: { workspace: { openLinkText(l: string, s: string, n: boolean): Promise<void> } } } }).aosHost.app.workspace.openLinkText("MEMORY", "", true));
    await expect(win.locator(".aos-host-tab.is-active .aos-host-tab-title")).toHaveText("MEMORY");
    await expect(notePath(win)).toHaveText("MEMORY.md");
    await expect(noteBody(win).locator("h1")).toHaveText("Memory Index");
    await expect(noteBody(win).locator("h2")).toHaveText(["User", "Feedback (how to work)", "Project", "Reference", "Patterns"]);
    // One link per MEMORY.md line: each indexed memory (the archived one has none, brain-hub D5; one points at a file that
    // is gone, Health's broken link) and the pattern.
    const lines = fs.readFileSync(FX.v("MEMORY.md"), "utf8").split("\n").filter((l) => /^- \[[^\]]+\]\(brain\/(memory|patterns)\/[^)]+\.md\)/.test(l)).length;
    expect(lines).toBe(23);
    await expect(noteBody(win).locator("a.internal-link")).toHaveCount(lines);
    await expect(noteBody(win).locator("[contenteditable], textarea")).toHaveCount(0);
    // With the Notes surface off, Edit is there but disabled, and says why.
    const editBtn = noteBar(win).locator("button.aos-note-edit");
    await expect(editBtn).toBeDisabled();
    await expect(editBtn).toHaveAttribute("title", /^Read-only: Notes is off for this run \(AOS_APP_WRITE\)\./);
    await expect(noteBar(win).locator("button", { hasText: "Open in Obsidian" })).toHaveCount(0);
    await noteBar(win).locator("button", { hasText: "Show in Finder" }).click();
    await expect.poll(async () => (await h.opened()).map((o) => `${o.fn} ${o.arg}`)).toEqual(expect.arrayContaining([
      `showItemInFolder ${path.join(FX.vault, "MEMORY.md")}`,
    ]));
  });

  test("following a Markdown vault link opens the target in the same tab", async () => {
    const { win } = app();
    const tabs = await win.locator(".aos-host-tab").count();
    await noteBody(win).locator("a.internal-link", { hasText: "Harbor Map" }).click();
    await expect(win.locator(".aos-host-tab.is-active .aos-host-tab-title")).toHaveText("harbor-map");
    await expect(notePath(win)).toHaveText("brain/memory/projects/harbor-map.md");
    await expect(noteBody(win)).toContainText("An offline harbor chart viewer.");
    expect(await win.locator(".aos-host-tab").count()).toBe(tabs);
    await closeNotes(win);
  });

  test("a link to a missing note says so instead of opening anything", async () => {
    const { win } = app();
    await win.evaluate(() => (window as unknown as { aosHost: { app: { workspace: { openLinkText(l: string, s: string, n: boolean): Promise<void> } } } }).aosHost.app.workspace.openLinkText("no-such-note", "", true));
    await expect(win.locator(".notice-container")).toContainText('Cannot find "no-such-note" in the vault');
  });
});

test.describe("Sessions and Code", () => {
  test("no provider: Sessions is on the rail for History alone, opens there, and Vault shows the hint", async () => {
    const { win } = app();
    // No host is signed in, but past sessions are on disk (install-import B11): the button is there, and the tab opens on History.
    await expect(rail(win, "chat")).toHaveCount(1);
    expect(await command(win, "agentic-os:open-workbench-chat")).toBe(true);
    await expect(content(win).locator('.aos-ss-row[data-thread="history"]')).toHaveClass(/is-selected/);
    await expect(content(win).locator(".aos-ss-hnohost")).toBeVisible();
    await content(win).locator('.aos-ss-row[data-thread="vault"]').click();
    await expect(content(win).locator(".aos-asst-nohint")).toContainText("no provider — run `aos provider` (Ollama reachable, or Claude Code or Codex logged in), then reopen the Workbench.");
    await openTab(win, "pulse");
  });

  test("Code: a live shell in the vault; New ▸ Shell adds a session; typing runs in it", async () => {
    const { win } = app();
    await openTab(win, "term");
    await expect(content(win).locator(".aos-term-title")).toHaveText("Code");
    await expect(content(win).locator(".aos-term-error")).toHaveCount(0);   // node-pty loads in the app: no install hint
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("fixture %");
    const before = await content(win).locator(".aos-term-tab").count();
    await content(win).locator(".aos-ntm-caret").click();
    await content(win).locator(".aos-ntm-row[data-key='now-shell']").click();
    await expect(content(win).locator(".aos-term-tab")).toHaveCount(before + 1);
    // The deck lists the newest first within its place: the new shell is the selected row.
    await expect(content(win).locator(".aos-term-tab.aos-term-tab-active")).toHaveAttribute("data-host", "shell");
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("fixture %");
    await content(win).locator(".xterm").filter({ visible: true }).click();
    await win.keyboard.type("pwd; echo e2e-$((6*7))");
    await win.keyboard.press("Enter");
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("e2e-42");
    expect(await terminalText(win)).toContain(expected().vault);
  });
});
