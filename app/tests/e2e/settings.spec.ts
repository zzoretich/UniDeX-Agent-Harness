// ⚙ Settings (app-smoke: Install paths, Settings) with its write surface off: the whole system's settings from
// `aos config list --json`, master switches, source pills, dimmed Codex rows, pickers with − / +, daily-cap spend, the
// edit / manage buttons, hosts & install rows, the plugin's own rows (the same renderer as Obsidian's settings pane),
// and a change refused. The changes themselves (`aos config set|unset`) are in settings-writes.spec.ts.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, content, expected, openTab, rail, terminalText, useApp } from "./harness";

const app = useApp();
const C = () => content(app().win);
const row = (key: string) => C().locator(".aos-st-row", { has: app().win.locator(".aos-st-key", { hasText: new RegExp(`^${key.replace(/\./g, "\\.")}$`) }) });

test.beforeEach(async () => { await openTab(app().win, "settings"); await expect(C().locator(".aos-rt-count")).not.toHaveText("loading…"); });

test("head: N changed from the defaults, matching the changed rows of `aos config list`", async () => {
  const cfg = expected().config!;
  const changed = cfg.settings.filter((r) => (r as { changed?: boolean }).changed).length;
  await expect(C().locator(".aos-rt-count")).toHaveText(`${changed} changed from the defaults`);
  const pills = C().locator(".aos-rt-note .aos-pill");
  await expect(pills).toHaveText(["this machine", "this vault", "default"]);
  await expect(pills.nth(0)).toHaveAttribute("title", cfg.files.machine);
  await expect(pills.nth(1)).toHaveAttribute("title", cfg.files.vault);
  expect(cfg.files.machine).toBe(path.join(FX.claude, "agenticos.json"));
});

test("master switches head the tab and follow the settings", async () => {
  const sw = (label: string) => C().locator(".aos-st-master .aos-st-switch", { hasText: label });
  await expect(C().locator(".aos-st-master .aos-st-switchlabel")).toContainText(["Background AI", "Chief of Staff", "Routines", "Knowledge graph", "Cross-review", "Session costing", "Telemetry"]);
  await expect(sw("Background AI")).not.toHaveClass(/is-on/);   // provider none
  await expect(sw("Session costing")).toHaveClass(/is-on/);    // aos cost enable
  await expect(sw("Chief of Staff")).toHaveClass(/is-on/);
  await expect(sw("Telemetry")).toHaveClass(/is-on/);
  await expect(sw("Session costing").locator("input")).toBeChecked();
});

test("every row: key, a source pill with the file on hover, when it applies; a changed row has ↺", async () => {
  const cfg = expected().config!;
  const provider = row("provider");
  await expect(provider.locator(".setting-item-name")).toHaveText("Background provider");
  await expect(provider.locator(".aos-st-meta .aos-pill")).toHaveText("this machine");
  await expect(provider.locator(".aos-st-meta .aos-pill")).toHaveAttribute("title", new RegExp(cfg.files.machine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await expect(provider.locator(".aos-st-meta")).toContainText("applies at the next model call");
  await expect(provider.locator("select.dropdown")).toHaveValue("none");
  await expect(provider.locator(".extra-setting-button")).toHaveCount(1);   // ↺ back to the default
  // A row still at its default shows no ↺.
  const untouched = cfg.settings.find((r) => r.source === "default" && !r.readonly);
  if (untouched) await expect(row(untouched.key).locator(".extra-setting-button[aria-label*='default'], .extra-setting-button[title*='Back to the default']")).toHaveCount(0);
});

test("Codex rows are dimmed on a Claude-Code-only machine, and still editable", async () => {
  const codex = row("codex.model");
  await expect(codex).toHaveClass(/is-dim/);
  await expect(codex.locator(".aos-st-hostnote")).toHaveText("Codex is off on this machine; Add Codex under Hosts (`aos hosts add codex`) turns it on");
  await expect(codex.locator("select.dropdown")).toBeEnabled();
  await expect(row("claude.model")).not.toHaveClass(/is-dim/);
});

test("no text box anywhere: toggles, pickers, chips and buttons only", async () => {
  await expect(C().locator("input[type='text'], input:not([type]), input[type='search'], textarea")).toHaveCount(0);
});

test("number rows have − / + around the picker; daily caps show today's spend", async () => {
  // A value set outside the presets (aos config set cost.monthlyBudget 175) shows as custom; − / + go to its neighbours.
  const budget = row("cost.monthlyBudget");
  await expect(budget.locator(".setting-item-control > .extra-setting-button")).toHaveCount(3);   // −, +, ↺
  await expect(budget.locator("select.dropdown option:checked")).toHaveText("$175.00 (custom)");
  await expect(budget.locator(".setting-item-control > .extra-setting-button").nth(0)).toHaveAttribute("aria-label", "Lower to $150.00");
  await expect(budget.locator(".setting-item-control > .extra-setting-button").nth(1)).toHaveAttribute("aria-label", "Raise to $200.00");
  const cap = row("claude.perDayUsd");
  await expect(cap.locator(".aos-st-spend")).toHaveText(/^today \$\d+\.\d{2} of \$\d+\.\d{2}$/);
});

test("− is disabled at the lowest preset; + on a spend setting asks first, and Cancel changes nothing", async () => {
  const h = app();
  const r = row("scan.fileMapBudgetUnderClaude");   // 0: the lowest preset
  const [minus, plus] = [r.locator(".setting-item-control > .extra-setting-button").nth(0), r.locator(".setting-item-control > .extra-setting-button").nth(1)];
  await expect(minus).toHaveClass(/is-disabled/);
  await expect(minus).toHaveAttribute("aria-label", "lowest preset");
  await expect(plus).not.toHaveClass(/is-disabled/);
  const before = await r.locator("select.dropdown").inputValue();
  await plus.click();
  const modal = h.win.locator(".modal");
  await expect(modal.locator("h3")).toHaveText(/^Raise /);
  await modal.locator("button", { hasText: "Cancel" }).click();
  await expect(h.win.locator(".modal")).toHaveCount(0);
  await expect(row("scan.fileMapBudgetUnderClaude").locator("select.dropdown")).toHaveValue(before);
  expect((await h.guard()).filter((e) => / config (set|unset) /.test(e.what))).toEqual([]);
});

test("list settings: recallRoots and routines.tools render as chips, one per value", async () => {
  const roots = row("recallRoots");
  await expect(roots.locator(".aos-st-chips .aos-st-chip.is-on")).toHaveText(["brain/memory", "brain/patterns", "persona/journal", "brain/notifications"]);
  const tools = row("routines.tools");
  await expect(tools.locator(".aos-st-chip.is-on")).toHaveText(["Read", "Glob", "Grep"]);
  // With more than one chip on, none is locked (the last-chip lock needs a write to reach: phase 2).
  await expect(tools.locator(".aos-st-chip input:disabled")).toHaveCount(0);
});

test("quickLinks and external labels open their file; skills.exclude switches to Skills", async () => {
  const h = app();
  const labels = row("routines.externalLabels");
  const edit = labels.locator("button", { hasText: /^Edit / });
  await expect(edit).toHaveText(/^Edit (brain\/config\.json|agenticos\.json)$/);
  await edit.click();
  await expect.poll(async () => (await h.opened()).map((o) => o.arg)).toContainEqual(expect.stringMatching(/(brain\/config\.json|agenticos\.json)$/));
  await expect(row("quickLinks").locator("button")).toHaveText(/^Edit /);
  await row("skills.exclude").locator("button", { hasText: "Manage in Skills" }).click();
  await expect(rail(h.win, "skills")).toHaveClass(/is-active/);
  await openTab(h.win, "settings");
  await expect(row("agents.exclude").locator("button")).toHaveText("Manage in Agents");
});

test("hosts & install: read-only values and the doctor / upgrade terminal buttons", async () => {
  await expect(C().locator(".aos-rt-subhead", { hasText: "HOSTS & INSTALL" })).toHaveText("HOSTS & INSTALL — CHANGED ONLY THROUGH THE INSTALLER");
  await expect(C().locator(".aos-st-actions button")).toHaveText(["❯_ aos doctor", "❯_ aos upgrade"]);
  const hostRows = C().locator(".aos-rt-subhead", { hasText: "HOSTS & INSTALL" }).locator("xpath=following-sibling::div[contains(@class,'aos-st-section')][1]").locator(".aos-st-row");
  expect(await hostRows.count()).toBeGreaterThan(0);
  await expect(hostRows.locator("select, .checkbox-container")).toHaveCount(0);
});

test("❯_ aos doctor runs the vault's own doctor in a new terminal in Code", async () => {
  const { win } = app();
  await C().locator(".aos-st-actions button", { hasText: "❯_ aos doctor" }).click();
  await expect(rail(win, "term")).toHaveClass(/is-active/);
  // The launcher resolves the fixture's agenticos.json and runs <vault>/brain/scripts/cli/aos.js doctor.
  await expect.poll(() => terminalText(win), { timeout: 30_000 }).toMatch(/ok\s+node >= 20/);
  await expect.poll(() => terminalText(win), { timeout: 30_000 }).toContain("agenticos.json");
});

test("WORKBENCH section: the plugin's own rows as pickers, the same rows Obsidian's settings pane renders", async () => {
  const { win } = app();
  const section = C().locator(".aos-st-plugin");
  const names = (await section.locator(".setting-item-name").allTextContents()).map((t) => t.trim());
  expect(names).toEqual(expect.arrayContaining(["Status bar enabled", "Vault root", "Claude config dir", "Node binary", "Shell", "Font size"]));
  expect(names).not.toContain("Embedded terminal panel");   // the Pulse terminal is gone (1.4.1)
  const item = (name: string) => section.locator(".setting-item", { has: win.locator(".setting-item-name", { hasText: new RegExp(`^${name}$`) }) });
  await expect(item("Vault root").locator("select option:checked")).toHaveText(/^this vault \(/);
  await expect(item("Claude config dir").locator("select option:checked")).toHaveText(/^auto/);
  await expect(item("Node binary").locator("select option:checked")).toHaveText(/^auto/);
  await expect(item("Node binary").locator("button")).toHaveText("Probe");
  await expect(item("Poll interval").locator(".extra-setting-button")).toHaveCount(2);   // − / + around a number picker
  // The settings tab the plugin registers (Obsidian's pane) renders the same rows through the same renderer.
  const pane = await win.evaluate(() => {
    const tab = (window as unknown as { aosHost: { app: { settingTabs: Array<{ display(): void; containerEl: HTMLElement }> } } }).aosHost.app.settingTabs[0];
    tab.display();
    return Array.from(tab.containerEl.querySelectorAll(".setting-item-name")).map((e) => (e.textContent ?? "").trim());
  });
  expect(pane).toEqual(expect.arrayContaining(names));
  // The pane's own head: the provider row reflects provider-state.json, name and reason.
  const provider = await win.evaluate(() => {
    const tab = (window as unknown as { aosHost: { app: { settingTabs: Array<{ containerEl: HTMLElement }> } } }).aosHost.app.settingTabs[0];
    const row = Array.from(tab.containerEl.querySelectorAll(".setting-item")).find((r) => r.querySelector(".setting-item-name")?.textContent === "Provider");
    return { desc: row?.querySelector(".setting-item-description")?.textContent ?? "", refresh: row?.querySelectorAll(".extra-setting-button").length ?? 0 };
  });
  expect(provider.desc).toMatch(/^none \(forced\) — checked \d{4}-\d{2}-\d{2}T/);
  expect(provider.refresh).toBe(1);
});

test("with the Settings surface off, a change is refused: the Notice says why and neither config file changes", async () => {
  const h = app();
  const files = [path.join(FX.claude, "agenticos.json"), FX.v("brain/config.json")];
  const before = files.map((f) => fs.readFileSync(f, "utf8"));
  const select = row("claude.model").locator("select.dropdown");
  const next = await select.locator("option").evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value).find((v) => v && v !== "haiku"));
  await select.selectOption(next!);
  await expect(h.win.locator(".notice-container")).toContainText(/claude\.model not changed: .*refused; no write surface that allows it is on/);
  expect(files.map((f) => fs.readFileSync(f, "utf8"))).toEqual(before);
  await expect(row("claude.model").locator("select.dropdown")).toHaveValue("haiku");
  expect((await h.guard()).filter((e) => / config set claude\.model /.test(e.what))).toHaveLength(1);
});
