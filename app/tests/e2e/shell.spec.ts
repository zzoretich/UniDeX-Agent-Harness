// The Workbench shell: boot, the app's record in the vault, the rail, badges, keyboard, commands, the status bar,
// agenticos:// links, and the read-only guard over a full tour (app-smoke: Install paths, Settings rail rows, Status
// line, Review readiness).

import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { BACKGROUND_SPAWNS, FX, HUD_VERSION, RAIL_ORDER, RAIL_SECTIONS, REPO, badge, command, content, expected, expectNoErrors, noteBody, notePath, openTab, rail, readVaultJson, useApp } from "./harness";

const app = useApp();

test("boots the Workbench on Pulse against the fixture vault, read-only", async () => {
  const { win } = app();
  const info = await win.evaluate(() => (window as unknown as { aosHost: { info: { vaultRoot: string; writeSurfaces: string[]; writeSource: string; vaultSource: string } } }).aosHost.info);
  expect(info.vaultRoot).toBe(FX.vault);
  expect(info.vaultSource).toBe("AOS_APP_VAULT");
  // The harness runs it read-only (AOS_APP_WRITE=""); the default, every surface on, is in variants.spec.ts.
  expect(info.writeSurfaces).toEqual([]);
  expect(info.writeSource).toBe("AOS_APP_WRITE");
  // No top bar (UniDeX D3): the mark heads the rail and opens Home, which is Pulse (spec 2026-10-08-pulse-cockpit-design).
  await expect(win.locator(".aos-wb-mark")).toHaveAttribute("aria-label", "Home");
  await expect(win.locator(".aos-wb-topbar")).toHaveCount(0);
  // The unmodified HUD from this repo loaded ("[agentic-os] loaded" in Obsidian).
  const plugin = await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { manifest: { id: string; version: string }; settings: object; _loaded: boolean } } }).aosHost.plugin;
    return { id: p.manifest.id, version: p.manifest.version, loaded: p._loaded, settings: !!p.settings };
  });
  expect(plugin).toEqual({ id: "agentic-os", version: HUD_VERSION, loaded: true, settings: true });
  await expect(rail(win, "pulse")).toHaveClass(/is-active/);
  await expect(win.locator(".aos-host-tab.is-active .aos-host-tab-title")).toHaveText("Workbench");
});

test("the app records itself in the vault for doctor and the update check (brain/_index/hud-host.json, D11)", async () => {
  const h = app();
  const running = await h.app.evaluate(({ app: a }) => ({ name: a.getName(), version: a.getVersion() }));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { productName: string; version: string };
  expect(running).toEqual({ name: pkg.productName, version: pkg.version });
  const marker = readVaultJson<{ schema: number; host: string; name: string; version: string; at: string }>("brain/_index/hud-host.json");
  expect(marker).toEqual({ schema: 1, host: "app", name: running.name, version: running.version, at: marker.at });
  expect(Date.now() - Date.parse(marker.at)).toBeLessThan(10 * 60_000);
  // Written by main, atomically: no temp file is left beside it.
  expect(fs.readdirSync(FX.v("brain/_index")).filter((n) => n.startsWith("hud-host.json."))).toEqual([]);
});

test("rail: three sections in order with a line between them, no Sessions without a provider, ⚙ Settings at the foot", async () => {
  const { win } = app();
  const ids = await win.locator(".aos-wb-railtabs .aos-wb-railbtn").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
  expect(ids).toEqual(RAIL_ORDER.filter((id) => id !== "chat"));
  // The sections and their lines (spec 2026-10-09-rail-sections-code D1, D5): a separator between sections, none at
  // either end, so the list reads ① | ② | ③.
  const seq = await win.locator(".aos-wb-railtabs > *").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab ?? (e.classList.contains("aos-wb-railsep") ? "|" : "?")));
  expect(seq).toEqual(RAIL_SECTIONS.map((s) => s.filter((id) => id !== "chat").join(",")).join(",|,").split(","));
  await expect(win.locator(".aos-wb-railsep[role='separator']")).toHaveCount(2);
  // Notifications heads the rail, then Pulse and Code; Files sits right after Spaces; Runs closes the list.
  expect(ids[0]).toBe("notifications");
  expect(ids.indexOf("term")).toBe(ids.indexOf("pulse") + 1);
  expect(ids.indexOf("files")).toBe(ids.indexOf("spaces") + 1);
  expect(ids[ids.length - 1]).toBe("runs");
  // Term is called Code (D7); its id stays "term".
  await expect(rail(win, "term")).toHaveAttribute("aria-label", "Code");
  await expect(rail(win, "term").locator(".aos-wb-railicon")).toHaveAttribute("data-icon", "terminal");
  await expect(win.locator(".aos-wb-railfoot .aos-wb-railbtn[data-tab='settings']")).toHaveCount(1);
  await expect(rail(win, "files").locator(".aos-wb-railicon")).toHaveAttribute("data-icon", "file-text");
  await expect(rail(win, "skills").locator(".aos-wb-railicon")).toHaveAttribute("data-icon", "sparkles");
  await expect(rail(win, "agents").locator(".aos-wb-railicon")).toHaveAttribute("data-icon", "bot");
  await expect(rail(win, "agent-teams").locator(".aos-wb-railicon")).toHaveAttribute("data-icon", "users");
  await expect(rail(win, "settings").locator(".aos-wb-railicon")).toHaveAttribute("data-icon", "settings");
  // The head: search and capture; the foot: light and dark, App settings, then Settings.
  const acts = (where: string) => win.locator(`.aos-wb-rail${where} .aos-wb-railact`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.action));
  expect(await acts("head")).toEqual(["search", "capture"]);
  expect(await acts("foot")).toEqual(["theme", "app-settings"]);
});

test("rail: Pulse is navy in light and neon blue in dark, the other theme's on its selected chip; one line colour (D5, D6)", async () => {
  const { win } = app();
  const NAVY = "rgb(30, 58, 138)";
  const NEON = "rgb(0, 179, 255)";
  const look = () => win.evaluate(() => {
    const pulse = document.querySelector(".aos-wb-railbtn[data-tab='pulse']") as HTMLElement;
    const css = (sel: string, prop: string) => getComputedStyle(document.querySelector(sel) as HTMLElement).getPropertyValue(prop);
    return {
      dark: document.body.classList.contains("theme-dark"),
      pulse: getComputedStyle(pulse).color,
      lines: [css(".aos-wb-railsep", "background-color"), css(".aos-wb-railhead", "border-bottom-color"), css(".aos-wb-railfoot", "border-top-color")],
    };
  });
  const toggle = async () => {
    const was = (await look()).dark;
    await win.locator(".aos-wb-railact[data-action='theme']").click();
    await expect.poll(async () => (await look()).dark).toBe(!was);
  };
  // Both themes, then back to the one the suite started in.
  for (let i = 0; i < 2; i++) {
    await openTab(win, "todo");
    const rest = await look();
    expect(rest.pulse).toBe(rest.dark ? NEON : NAVY);
    expect(new Set(rest.lines).size).toBe(1);
    expect(rest.lines[0]).toBe(rest.dark ? "rgba(255, 255, 255, 0.24)" : "rgb(212, 212, 212)");
    await rail(win, "pulse").hover();
    expect((await look()).pulse).toBe(rest.pulse);
    await openTab(win, "pulse");
    expect((await look()).pulse).toBe(rest.dark ? NAVY : NEON);
    await toggle();
  }
});

test("rail: ⚙ stays reachable in a pane too short for every tab, which scroll above it", async () => {
  const { app: electronApp, win } = app();
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://hud/"))?.setContentSize(1480, 600));
  try {
    await expect.poll(() => win.locator(".aos-wb-railtabs").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const box = await rail(win, "settings").boundingBox();
    const viewport = await win.evaluate(() => window.innerHeight);
    expect(box && box.y + box.height).toBeLessThanOrEqual(viewport);
    await rail(win, "settings").click();
    await expect(rail(win, "settings")).toHaveClass(/is-active/);
  } finally {
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("app://hud/"))?.setContentSize(1480, 920));
  }
});

test("rail: Enter or Space on a focused button opens its tab", async () => {
  const { win } = app();
  await rail(win, "settings").focus();
  await win.keyboard.press("Enter");
  await expect(rail(win, "settings")).toHaveClass(/is-active/);
  await rail(win, "memory").focus();
  await win.keyboard.press(" ");
  await expect(rail(win, "memory")).toHaveClass(/is-active/);
  await openTab(win, "pulse");
});

test("rail badges count the fixture: Pulse, to-do, proposals, notifications (rose for breaking), agent teams", async () => {
  const { win } = app();
  const e = expected();
  await expect(badge(win, "todo")).toHaveText(String(e.todo.badge));
  await expect(badge(win, "proposals")).toHaveText(String(e.proposals.pending.length));
  await expect(badge(win, "notifications")).toHaveText(String(e.notifications.unread));
  await expect(badge(win, "notifications")).toHaveClass(/is-urgent/);
  await expect(badge(win, "proposals")).not.toHaveClass(/is-urgent/);
  await expect(badge(win, "agent-teams")).toHaveText("2");
  // Pulse counts what needs the user (spec 2026-10-08-pulse-cockpit-design P5): the fixture has a health error, so it is rose.
  await expect(badge(win, "pulse")).toHaveText(/^\d+$/);
  await expect(badge(win, "pulse")).toHaveClass(/is-urgent/);
  for (const id of ["spaces", "memory", "runs", "routines", "skills", "agents", "term", "settings"]) {
    await expect(badge(win, id)).toHaveClass(/is-empty/);
  }
});

test("status bar: READ-ONLY, the live marker and the runtime's status-line segments", async () => {
  const { win } = app();
  await expect(win.locator(".aos-host-status .aos-host-mode")).toHaveText("READ-ONLY");
  await expect(win.locator(".aos-host-status .aos-host-mode")).toHaveAttribute("title", /Content writes are refused for this run \(AOS_APP_WRITE\)/);
  const bar = win.locator(".aos-host-status .aos-statusbar");
  await expect(bar).toContainText("⚡");
  await expect(bar).toContainText(/ (live|idle)/);
  // live is cyan; idle is dimmed.
  const marker = bar.locator("span", { hasText: /^ (live|idle)$/ });
  await expect(marker).toHaveClass((await marker.textContent()) === " live" ? /aos-text-cyan/ : /aos-dim/);
  await expect(bar.locator(".aos-sbar-link", { hasText: "◆ 2 gates" })).toHaveAttribute("aria-label", "harbor-01 (discuss), survey-01 (plan)");
  await expect(bar.locator(".aos-sbar-link", { hasText: "1 breaking" })).toHaveClass(/aos-text-rose/);
  await expect(bar.locator(".aos-sbar-link", { hasText: "1 alert" })).toHaveClass(/aos-text-amber/);
  await expect(bar.locator(".aos-sbar-link", { hasText: "1 flag" })).toBeVisible();
  // The health scan's errors (snapshot.json): the fixture's missing CLAUDE.md line and its MEMORY.md line to a deleted file.
  const errors = readVaultJson<{ health: { issues: Array<{ severity: string }> } }>("brain/_index/snapshot.json").health.issues.filter((i) => i.severity === "error").length;
  expect(errors).toBe(2);
  await expect(bar).toContainText(`${errors}err`);
});

test("status bar: a gate opens Agent Teams, an alert Notifications, a flag persona/STATE.md", async () => {
  const { win } = app();
  const bar = win.locator(".aos-host-status .aos-statusbar");
  await bar.locator(".aos-sbar-link", { hasText: "◆ 2 gates" }).click();
  await expect(rail(win, "agent-teams")).toHaveClass(/is-active/);
  await bar.locator(".aos-sbar-link", { hasText: "1 breaking" }).click();
  await expect(rail(win, "notifications")).toHaveClass(/is-active/);
  await bar.locator(".aos-sbar-link", { hasText: "1 flag" }).click();
  await expect(win.locator(".aos-host-tab.is-active .aos-host-tab-title")).toHaveText("STATE");
  await expect(notePath(win)).toHaveText("persona/STATE.md");
  await expect(noteBody(win)).toContainText("The nightly backup has not reported for two days");
  // Clicking the bar anywhere else brings the Workbench back.
  await bar.locator("span", { hasText: "⚡" }).first().click();
  await expect(win.locator(".aos-host-tab.is-active .aos-host-tab-title")).toHaveText("Workbench");
});

test("status bar keeps working with the Workbench closed; a gate reopens it on Agent Teams", async () => {
  const { win } = app();
  const wb = win.locator(".aos-host-tab", { has: win.locator(".aos-host-tab-title", { hasText: /^Workbench$/ }) });
  await wb.locator(".aos-host-tab-close").click();
  await expect(win.locator(".aos-wb-rail")).toHaveCount(0);
  const bar = win.locator(".aos-host-status .aos-statusbar");
  await expect(bar.locator(".aos-sbar-link", { hasText: "◆ 2 gates" })).toBeVisible();
  await bar.locator(".aos-sbar-link", { hasText: "◆ 2 gates" }).click();
  await expect(rail(win, "agent-teams")).toHaveClass(/is-active/);
  await openTab(win, "pulse");
});

test("commands: the plugin registers its palette commands; each 'Open Workbench: <tab>' opens that tab", async () => {
  const { win } = app();
  const cmds = await win.evaluate(() => (window as unknown as { aosHost: { app: { commands: { list(): Array<{ id: string; name: string; hotkeys?: unknown[] }> } } } })
    .aosHost.app.commands.list().map((c) => ({ id: c.id, name: c.name, hotkeys: c.hotkeys ?? [] })));
  const ids = cmds.map((c) => c.id);
  for (const t of ["todo", "proposals", "notifications", "spaces", "memory", "runs", "routines", "skills", "agents", "agent-teams", "chat", "term", "settings"]) {
    expect(ids).toContain(`agentic-os:open-workbench-${t}`);
  }
  for (const id of ["open-workbench", "open-sidebar-hud", "open-memory-inspector", "open-run-inspector", "new-terminal", "quick-capture", "open-omnisearch"]) {
    expect(ids).toContain(`agentic-os:${id}`);
  }
  expect(cmds.find((c) => c.id === "agentic-os:open-workbench-agent-teams")?.name).toBe("Open Workbench: Agent Teams");
  expect(cmds.find((c) => c.id === "agentic-os:open-workbench-settings")?.name).toBe("Open Workbench: Settings");
  // The Chat tab became Sessions; its id (and so its command's) stays "chat", so links and hotkeys keep working.
  expect(cmds.find((c) => c.id === "agentic-os:open-workbench-chat")?.name).toBe("Open Workbench: Sessions");
  // Term became Code the same way: the command keeps the id "term".
  expect(cmds.find((c) => c.id === "agentic-os:open-workbench-term")?.name).toBe("Open Workbench: Code");
  // Review readiness: Omnisearch has no default hotkey (⌘K is the host's own binding).
  expect(cmds.find((c) => c.id === "agentic-os:open-omnisearch")?.hotkeys).toEqual([]);
  for (const t of ["agent-teams", "settings", "routines"]) {
    expect(await command(win, `agentic-os:open-workbench-${t}`)).toBe(true);
    await expect(rail(win, t)).toHaveClass(/is-active/);
  }
  await openTab(win, "pulse");
});

test("agenticos:// links open the named tab; an unknown tab leaves the current one", async () => {
  const { win } = app();
  const open = (params: Record<string, string>) => win.evaluate((p) => (window as unknown as { aosHost: { app: { handleProtocol(a: string, p: Record<string, string>): boolean } } }).aosHost.app.handleProtocol("agenticos", p), params);
  expect(await open({ vault: "vault", tab: "notifications" })).toBe(true);
  await expect(rail(win, "notifications")).toHaveClass(/is-active/);
  await open({ vault: "vault", tab: "nope" });
  await win.waitForTimeout(300);
  await expect(rail(win, "notifications")).toHaveClass(/is-active/);
  await open({ tab: "agent-teams" });
  await expect(rail(win, "agent-teams")).toHaveClass(/is-active/);
  await openTab(win, "pulse");
});

// ── the read-only tour ───────────────────────────────────────────────

/** User content: what a person or an agent writes. Runtime caches under brain/_index may be refreshed; these may not. */
function userContent(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (rel: string) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) { for (const n of fs.readdirSync(abs)) add(path.join(rel, n)); return; }
    out[rel] = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  };
  for (const rel of ["vault/TODO.md", "vault/MEMORY.md", "vault/brain/memory", "vault/brain/patterns", "vault/brain/notifications", "vault/brain/routines",
    "vault/brain/config.json", "vault/persona/proposals", "vault/persona/ledger.jsonl", "vault/persona/backlog.md", "vault/persona/STATE.md",
    "vault/persona/teams/example/TEAM.md", "vault/persona/teams/example/board.jsonl", "vault/persona/teams/example/channel.jsonl",
    "vault/workspaces", "home/.claude/agenticos.json", "home/.claude/settings.json", "home/.claude/skills", "home/.claude/agents"]) add(rel);
  return out;
}

test("a tour of every tab, the sidebar HUD and ⌘K raises no renderer or main-process error", async () => {
  const h = app();
  const { win } = h;
  const before = h.errors.length;
  for (const id of [...RAIL_ORDER.filter((t) => t !== "chat"), "settings"]) {
    await openTab(win, id);
    await win.waitForTimeout(600);
    await expect(content(win)).not.toBeEmpty();
  }
  await command(win, "agentic-os:open-sidebar-hud");
  await expect(win.locator(".aos-host-right .aos-sb-title")).toHaveText("UniDeX");
  await command(win, "agentic-os:open-omnisearch");
  await expect(win.locator(".modal.prompt .prompt-input")).toBeVisible();
  await win.keyboard.press("Escape");
  await openTab(win, "pulse");
  expectNoErrors(h, before);
});

test("read-only guard: the tour wrote nothing and refused only the runtime's own background refreshes", async () => {
  const h = app();
  const log = await h.guard();
  expect(log.filter((e) => e.kind === "write"), "refused writes").toEqual([]);
  // The guard shortens each argument to 90 characters, so a long vault path hides the script name: match on the tail too.
  const tails = [/…$/, / refresh$/, / --quiet$/, /routines hosts --refresh$/, /skills sync$/, /agents sync$/, / list --json$/];
  for (const e of log) {
    expect(BACKGROUND_SPAWNS.some((re) => re.test(e.what)) || tails.some((re) => re.test(e.what)), `unexpected refused spawn: ${e.what}`).toBe(true);
  }
  expect(userContent(FX.root), "user content changed during the tour").toEqual(userContent(FX.pristine));
  expect((await h.opened()).filter((o) => o.fn !== "openPath" || !o.arg.endsWith(".html")), "nothing was handed to the OS").toEqual([]);
});

test("an open form keeps the keyboard: a terminal that focuses itself behind it cannot take the keys", async () => {
  const { win } = app();
  await openTab(win, "term");
  await expect.poll(() => win.locator(".aos-wb-content .xterm-helper-textarea").count()).toBeGreaterThan(0);
  await command(win, "agentic-os:quick-capture");
  const body = win.locator(".modal textarea");
  await body.click();
  // What TerminalPanel does on its next frame after a re-render: focus the terminal.
  await win.evaluate(() => (document.querySelector(".aos-wb-content .xterm-helper-textarea") as HTMLElement).focus());
  await expect(body).toBeFocused();
  await win.keyboard.type("stays in the form");
  await expect(body).toHaveValue("stays in the form");
  await win.keyboard.press("Escape");
  await expect(win.locator(".modal")).toHaveCount(0);
  // With no form open, the terminal takes focus as before.
  await win.evaluate(() => (document.querySelector(".aos-wb-content .xterm-helper-textarea") as HTMLElement).focus());
  await expect(win.locator(".aos-wb-content .xterm-helper-textarea").first()).toBeFocused();
  await openTab(win, "pulse");
});

test("tray popover: the SidebarHUD in a window of its own, hidden until the menubar icon is clicked, from the one plugin", async () => {
  const h = app();
  type Main = { __aosMain: { togglePopover(): boolean; popoverVisible(): boolean; tray(): { mark: boolean } | null } };
  const main = <T>(fn: (m: Main["__aosMain"]) => T) => h.app.evaluate((_e, f) => (0, eval)(`(${f})`)((globalThis as unknown as Main).__aosMain), fn.toString()) as Promise<T>;
  // Opened blank by the renderer at boot, and filled by it: the only child window main allows.
  await expect.poll(() => h.app.windows().length).toBe(2);
  // The menubar item is the Line mark, a template image from out/main (UniDeX D10), not a text glyph.
  expect(await main((m) => m.tray()?.mark)).toBe(true);
  const pop = h.app.windows().find((w) => w !== h.win)!;
  expect(await main((m) => m.popoverVisible())).toBe(false);
  expect(await main((m) => m.togglePopover())).toBe(true);
  expect(await main((m) => m.popoverVisible())).toBe(true);
  await expect(pop.locator(".aos-popover-leaf .aos-sb-status")).toBeVisible();
  await expect(pop.locator(".aos-popover-leaf")).toContainText("UniDeX");
  // The same plugin draws it: no second HUD, so one status bar and one Workbench.
  expect(await h.win.evaluate(() => document.querySelectorAll(".aos-statusbar").length)).toBe(1);
  expect(await main((m) => m.togglePopover())).toBe(true);
  expect(await main((m) => m.popoverVisible())).toBe(false);
  // Any other window.open is still refused.
  expect(await h.win.evaluate(() => window.open("about:blank", "somewhere-else") === null)).toBe(true);
  expect(h.app.windows()).toHaveLength(2);
});
