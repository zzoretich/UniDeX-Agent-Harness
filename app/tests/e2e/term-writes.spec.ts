import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import { FX, command, content, openTab, terminalText, useApp } from "./harness";

// Starting terminals from the Term tab (spec 2026-10-08-term-agent-deck T2–T7). The fixture's Claude Code is on and its
// Codex off; both CLIs are stubs that echo their arguments, so the typed launch line can be read back.

// Scratch and New workspace write folders and stubs through the Files surface.
const app = useApp({ env: { AOS_APP_WRITE: "files" } });
const C = () => content(app().win);
type Pool = { list(): Array<{ id: string; cwd: string; meta: { host: string; place: { kind: string; label: string } | null } }>; selectedId(): string | null };
const pool = () => app().win.evaluate(() => {
  const p = (window as unknown as { aosHost: { plugin: { terminalPool: Pool } } }).aosHost.plugin.terminalPool;
  const sel = p.selectedId();
  return { count: p.list().length, selected: p.list().find((s) => s.id === sel) ?? null };
});

test.afterAll(() => {
  for (const w of ["scratch", "tide-chart"]) fs.rmSync(FX.v(`workspaces/${w}`), { recursive: true, force: true });
});

test("⌘T with nothing picked starts Claude Code in the vault, and makes no Scratch (T2, T4, T5)", async () => {
  const { win } = app();
  await openTab(win, "pulse");
  await win.keyboard.press("Meta+t");
  await expect(win.locator(".aos-wb-railbtn[data-tab='term']")).toHaveClass(/is-active/);
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture claude stub] --session-id");
  const { selected } = await pool();
  expect(selected?.meta.host).toBe("claude");
  expect(selected?.meta.place?.kind).toBe("vault");
  expect(selected?.cwd).toBe(FX.vault);
  expect(fs.existsSync(FX.v("workspaces/scratch"))).toBe(false);
  await expect(C().locator(".aos-term-started")).toContainText("Started Claude Code in Vault");
  // C1 (R65a): the computer surface is off, so main checked nothing and said nothing: the line was typed into the
  // shell, as before the computer (its echo is on screen), with no "the computer is off" aside.
  await expect(C().locator(".aos-term-started > span")).toHaveText("Started Claude Code in Vault");
  expect((await terminalText(win)).replace(/\s+/g, "")).toContain("command-v");
  await expect(C().locator(".aos-term-tab.aos-term-tab-active")).toHaveAttribute("data-host", "claude");
});

test("Scratch, picked in the New menu, is made on first use with its stubs; a Scratch terminal does not pull ⌘T into Scratch (T4, T10)", async () => {
  const { win } = app();
  await openTab(win, "term");
  await C().locator(".aos-ntm-caret").click();
  await C().locator(".aos-ntm-row[data-key='scratch']").click();
  await expect.poll(async () => (await pool()).selected?.meta.place?.kind, { timeout: 10_000 }).toBe("scratch");
  expect((await pool()).selected?.cwd).toBe(FX.v("workspaces/scratch"));
  expect(fs.readFileSync(FX.v("workspaces/scratch/README.md"), "utf8")).toMatch(/^# Scratch/);
  expect(fs.readFileSync(FX.v("workspaces/scratch/CLAUDE.md"), "utf8")).toBe(fs.readFileSync(FX.v("workspaces/scratch/AGENTS.md"), "utf8"));
  // With that Scratch terminal selected, ⌘T still starts in the vault: Scratch is never what you are "looking at".
  const before = (await pool()).count;
  expect(await command(win, "agentic-os:new-terminal")).toBe(true);
  await expect.poll(async () => (await pool()).count).toBe(before + 1);
  expect((await pool()).selected?.meta.place?.kind).toBe("vault");
});

test("the New button names what ⌘T starts and where; Codex is off, so it has no row and no ⌥⌘2 (T2, T3)", async () => {
  const { win } = app();
  await openTab(win, "term");
  await expect(C().locator(".aos-ntm-name")).toHaveText("New session");
  await C().locator(".aos-ntm-caret").click();
  await expect(C().locator(".aos-ntm-row[data-key='now-claude']")).toBeVisible();
  await expect(C().locator(".aos-ntm-row[data-key='now-codex']")).toHaveCount(0);
  await expect(C().locator(".aos-ntm-row[data-key='scratch']")).toBeVisible();
  await expect(C().locator(".aos-ntm-row[data-key='ws-harbor-map']")).toBeVisible();
  await expect(C().locator(".aos-ntm-preview").first()).toContainText("exec claude");
  await win.keyboard.press("Escape");
  await expect(C().locator(".aos-ntm-pop")).toHaveCount(0);
  const ids = await win.evaluate(() => (window as unknown as { aosHost: { app: { commands: { list(): Array<{ id: string }> } } } }).aosHost.app.commands.list().map((c) => c.id));
  expect(ids).toEqual(expect.arrayContaining(["agentic-os:new-terminal", "agentic-os:new-terminal-claude", "agentic-os:new-terminal-shell", "agentic-os:new-terminal-menu", "agentic-os:new-workspace"]));
  expect(ids).not.toContain("agentic-os:new-terminal-codex");
});

test("typing an exact workspace name starts there; a new name creates the workspace and starts in it (T6)", async () => {
  const { win } = app();
  await openTab(win, "term");
  await C().locator(".aos-ntm-caret").click();
  await C().locator(".aos-ntm-filter").fill("harbor-map");
  await expect(C().locator(".aos-ntm-row.is-hi")).toHaveAttribute("data-key", "ws-harbor-map");
  await win.keyboard.press("Enter");
  await expect.poll(async () => (await pool()).selected?.cwd).toBe(FX.v("workspaces/harbor-map"));

  await C().locator(".aos-ntm-caret").click();
  await C().locator(".aos-ntm-filter").fill("Tide chart");
  await expect(C().locator(".aos-ntm-row.is-hi")).toHaveAttribute("data-key", "create");
  await expect(C().locator(".aos-ntm-row.is-hi")).toContainText("Create workspaces/tide-chart and start Claude Code");
  await win.keyboard.press("Enter");
  await expect.poll(async () => (await pool()).selected?.cwd).toBe(FX.v("workspaces/tide-chart"));
  for (const f of ["README.md", "CLAUDE.md", "AGENTS.md"]) expect(fs.existsSync(FX.v(`workspaces/tide-chart/${f}`))).toBe(true);
});

test("New workspace (⇧⌘N): reserved names are refused, an existing one is offered to open, never silently reused (T6)", async () => {
  const { win } = app();
  expect(await command(win, "agentic-os:new-workspace")).toBe(true);
  const name = C().locator(".aos-ntm-name-input");
  await expect(name).toBeFocused();
  await name.fill("research");
  await expect(C().locator(".aos-ntm-hint")).toContainText("reserved");
  await expect(C().locator(".aos-ntm-go")).toBeDisabled();
  await name.fill("Harbor Map");
  await expect(C().locator(".aos-ntm-exists")).toContainText("harbor-map already exists");
  await expect(C().locator(".aos-ntm-git")).toHaveClass(/is-hidden/);
  await win.keyboard.press("Escape");
});

test("⌥⌘3's command opens a shell next to the selected workspace terminal; Spaces' Terminal here starts in its workspace, and its row shows it live (T4, spaces-redesign D5, D26)", async () => {
  const { win } = app();
  await openTab(win, "term");
  // Select the tide-chart agent from the earlier test: a workspace is context, so the shell starts there.
  await win.evaluate((dir) => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { list(): Array<{ id: string; cwd: string }>; select(id: string): void } } } }).aosHost.plugin.terminalPool;
    const s = p.list().find((x) => x.cwd === dir);
    if (s) p.select(s.id);
  }, FX.v("workspaces/tide-chart"));
  const before = (await pool()).count;
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  await expect.poll(async () => (await pool()).count).toBe(before + 1);
  const { selected } = await pool();
  expect(selected?.meta.host).toBe("shell");
  expect(selected?.cwd).toBe(FX.v("workspaces/tide-chart"));
  await openTab(win, "spaces");
  // field-notes is idle, so its group starts folded (spaces-redesign D4).
  const idle = C().locator(".aos-spc-ghead", { has: win.locator(".aos-spc-glabel", { hasText: /^IDLE$/ }) });
  if ((await idle.getAttribute("aria-expanded")) === "false") await idle.click();
  const row = C().locator('.aos-spc-row[data-workspace="field-notes"]');
  await row.click();
  await expect(C().locator(".aos-spc-h1")).toHaveText("field-notes");
  await expect(row.locator(".aos-spc-live")).toHaveCount(0);
  // Resume in Code's menu: Terminal here, a shell in the workspace (its code folder when linked).
  await C().locator(".aos-spc-head button.aos-spc-caret").click();
  await C().locator(".aos-spc-pop .aos-spc-popitem", { hasText: "Terminal here" }).click();
  await expect.poll(async () => (await pool()).selected?.cwd).toBe(FX.v("workspaces/field-notes"));
  expect((await pool()).selected?.meta.host).toBe("shell");
  expect((await pool()).selected?.meta.place?.kind).toBe("workspace");
  await expect(win.locator(".aos-wb-railbtn[data-tab='term']")).toHaveClass(/is-active/);
  // D26: a Code terminal placed in the workspace is what makes its row live.
  await openTab(win, "spaces");
  await expect(row.locator(".aos-spc-live")).toHaveText("live");
  await expect(row.locator(".aos-spc-live")).toHaveAttribute("title", /^Live: \d+ terminals? in Code$/);
});
