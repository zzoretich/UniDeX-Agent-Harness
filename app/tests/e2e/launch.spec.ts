// The launch sequence (spec 2026-10-14-guided-tour-design C11; local-first A9; install-import B12): what the app opens on
// its own at launch, one dialog at a time, each once. An install from before 2.0 updated by this app meets the runtime
// update, then the Go-local card (its `aos migrate local-first` runs for real against the fixture, through the `migrate`
// surface), then the Import sheet (the vault's own dry run, then `aos migrate import --apply`), then What's new with the
// full tour, then Getting started; a relaunch shows none of them, and Settings undoes going local. A vault with nothing
// to import is told so. A new install gets the welcome tour, then Getting started. Codex-only and no-host machines get
// the cards worded for them, and Pulse says how to add a host (app-smoke: Launch sequence).

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FX, HUD_SETTINGS, HUD_VERSION, SETUP, USER_DATA, content, drawer, expectNoErrors, installSetupStubs, launchApp, openTab, rail, restoreFixture,
  vaultKey, type AppHandle,
} from "./harness";

const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const AGENTICOS = path.join(FX.claude, "agenticos.json");
const MIGRATIONS = FX.v("brain/_index/migrations.json");
const LOCAL_URL = "http://127.0.0.1:9";
/** The fixture vault's Go-local mark in tour.launched (per vault: obsidian-plugin/src/tour/launch.ts goLocalId). */
const GO_LOCAL = `go-local@${vaultKey(FX.vault)}`;
const WHATS_NEW = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "obsidian-plugin", "src", "tour", "whatsnew.json"), "utf8")) as { releases: Array<{ version: string; entries: unknown[] }> };

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
const editJson = (file: string, fn: (j: Record<string, any>) => void) => { const j = readJson(file); fn(j); fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`); };
const launchLog = (win: Page): Promise<string[]> => win.evaluate(() => [...(window as unknown as { aosHost: { launchLog: string[] } }).aosHost.launchLog]);
const migration = (id: string) => (readJson(MIGRATIONS).migrations as Array<{ id: string; state: string }>).find((m) => m.id === id)?.state;
const tourState = () => (readJson(HUD_SETTINGS).tour ?? {}) as { lastSeenVersion?: string; launched?: string[] };
/** What an `aos upgrade` from before 2.0.0 leaves for the app (cli/migrations.js recordPending); `ids` narrows it. */
const pending = (ids = ["local-first", "import"]) => fs.writeFileSync(MIGRATIONS, `${JSON.stringify({ schema: 1, migrations: ids.map((id) => ({ id, state: "pending", since: "2.0.0", from: "1.9.0", at: new Date().toISOString() })) }, null, 2)}\n`);
const card = (win: Page) => win.locator(".modal.aos-golocal-modal");
const sheet = (win: Page) => win.locator(".modal.aos-importsheet-modal");
/** The fixture vault's Import mark in tour.launched (obsidian-plugin/src/tour/launch.ts importId). */
const IMPORT = `import@${vaultKey(FX.vault)}`;
/** A Mac with no host history: no Claude Code transcripts, no Codex sessions (the scan then finds nothing to bring). */
const noHistory = () => {
  fs.rmSync(path.join(FX.claude, "projects"), { recursive: true, force: true });
  fs.rmSync(path.join(FX.home, ".codex", "sessions"), { recursive: true, force: true });
  fs.rmSync(path.join(FX.home, ".codex", "session_index.jsonl"), { force: true });
  // The MCP servers the fixture gives each host (Skills ▸ MCP servers): an import lists them, so nothing means none.
  fs.rmSync(path.join(FX.home, ".claude.json"), { force: true });
  fs.rmSync(path.join(FX.home, ".codex", "config.toml"), { force: true });
};
const whatsNew = (win: Page) => win.locator(".modal.aos-whatsnew-modal");
/** The running release's What's new entries an install new to the tour sees (tour/whatsnew.ts selectWhatsNew, lastSeen null). */
const LINE = HUD_VERSION.split(".").slice(0, 2).join(".");
const ENTRIES = WHATS_NEW.releases.filter((r) => r.version.startsWith(`${LINE}.`) && Number(r.version.split(".")[2]) <= Number(HUD_VERSION.split(".")[2]))
  .reduce((n, r) => n + r.entries.length, 0);

test.describe.configure({ mode: "serial" });

let h: AppHandle | null = null;
test.afterEach(async () => { await h?.close(); h = null; });

test("an install from before 2.0: runtime update → Go local → Import → What's new → Getting started, in order and once", async () => {
  restoreFixture();
  // Go local and the Local engine's download on (each is off by default until its live check), Settings for Undo.
  const env = { AOS_APP_PAYLOAD: SETUP.payload, AOS_SETUP_PATH: SETUP.bin, AOS_APP_WRITE: "migrate,local,settings" };
  h = await launchApp({
    // A 1.9 Mac: no tour state in the HUD's settings, nothing launched, a runtime older than the app's.
    tour: false, launch: false, env,
    prepare: () => {
      installSetupStubs(VERSION);
      editJson(AGENTICOS, (j) => { j.version = "1.8.0"; });
      // A 1.x brain/config.json: no 2.0 Chief of Staff keys (the update pins the model it ran on and no failover).
      editJson(FX.v("brain/config.json"), (j) => { for (const k of ["model", "codexModel", "failover"]) delete j.persona[k]; });
      // The local engine at an address nothing serves (once local, background work must never reach a real Ollama on
      // this Mac), last seen answering without this Mac's model; and background work spent a little this week.
      editJson(FX.v("brain/config.json"), (j) => { j.local = { ...(j.local ?? {}), url: LOCAL_URL }; });
      editJson(FX.v("brain/_index/provider-state.json"), (j) => { j.local = { url: LOCAL_URL, reachable: true, models: [] }; });
      fs.appendFileSync(FX.v("brain/_index/provider-spend.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), feature: "summary", provider: "claude", usd: 0.12 })}\n`);
    },
  });
  const { win } = h;

  // 1. The runtime update, alone.
  const runtime = win.locator(".aos-runtime-modal");
  await expect(runtime.locator(".modal-title")).toHaveText("Update the runtime in your vault");
  await expect(card(win)).toHaveCount(0);
  expect(await launchLog(win)).toEqual(["runtime"]);
  await runtime.locator(".aos-runtime-go").click();
  await expect(runtime.locator(".aos-setup-status")).toHaveText(`Updated to ${VERSION}.`, { timeout: 20_000 });
  expect(migration("local-first")).toBe("pending");
  const kept = () => { const p = readJson(FX.v("brain/config.json")).persona; return [p.model, p.codexModel, p.failover]; };
  expect(kept()).toEqual([null, null, false]);
  await runtime.locator("button", { hasText: "Close" }).click();

  // 2. Go local: what moves, what stays, the week's spend, the missing model, the CoS checkbox for Claude Code.
  await expect(card(win).locator(".modal-title")).toHaveText("Run background work on this Mac");
  await expect(whatsNew(win)).toHaveCount(0);
  expect(await launchLog(win)).toEqual(["runtime", "go-local"]);
  await expect(card(win).locator('[data-col="local"] li')).toHaveCount(4);
  await expect(card(win).locator('[data-col="hosted"]')).toContainText("on Claude Code");
  await expect(card(win).locator(".aos-golocal-spend")).toHaveText(/^Background spend \$\d+\.\d\d over \d+ calls? in the last 7 days; on this Mac it costs nothing$/);
  await expect(card(win).locator('.aos-golocal-model[data-state="missing"] .aos-golocal-pull')).toHaveText("Download the model");
  await expect(card(win).locator(".aos-golocal-chief")).toHaveText("Move the Chief of Staff to Opus 5.5");
  await expect(card(win).locator(".aos-golocal-chief input")).toBeChecked();
  await win.screenshot({ path: test.info().outputPath("go-local-card.png") });
  await card(win).locator(".aos-golocal-go").click();
  await expect(card(win)).toHaveCount(0, { timeout: 60_000 });
  const user = readJson(AGENTICOS);
  expect([user.provider, user.ai?.chat]).toEqual(["local", "local"]);
  expect(kept()).toEqual(["claude-opus-5-5", "gpt-6-sol", true]);
  expect([migration("local-first"), migration("import")]).toEqual(["applied", "pending"]);
  expect(fs.readdirSync(FX.v("brain/_index/migrations")).filter((f) => f.startsWith("local-first-"))).toHaveLength(1);

  // 3. Import: what the vault's own `aos import --dry-run` finds (the fixture's sessions on both hosts), then Import runs
  // `aos migrate import --apply` through the migrate surface, which imports and settles the migration in one call.
  await expect(sheet(win).locator(".modal-title")).toHaveText("Bring in your Claude Code and Codex history");
  await expect(whatsNew(win)).toHaveCount(0);
  expect(await launchLog(win)).toEqual(["runtime", "go-local", "import"]);
  await expect(sheet(win).locator('.aos-importsheet-body[data-state="ready"]')).toBeVisible({ timeout: 60_000 });
  await expect(sheet(win).locator(".aos-importsheet-table th[data-host]")).toHaveText(["Claude Code", "Codex"]);
  await expect(sheet(win).locator('.aos-importsheet-table td[data-host="claude"][data-kind="sessions"]')).toHaveText(/^\d+ sessions?$/);
  await expect(sheet(win).locator(".aos-importsheet-engine")).toContainText("Nothing leaves this Mac");
  await win.screenshot({ path: test.info().outputPath("import-sheet.png") });
  await sheet(win).locator(".aos-importsheet-import").click();
  await expect(sheet(win)).toHaveCount(0, { timeout: 120_000 });
  expect(migration("import")).toBe("applied");
  const state = readJson(FX.v("brain/_index/import-state.json")) as { runs: Array<{ from: string[] }> };
  expect(state.runs.at(-1)?.from).toEqual(["claude", "codex"]);

  // 4. What's new, with the full tour on offer (an install that never kept a last-seen version).
  await expect(whatsNew(win).locator(".modal-title")).toHaveText(`What's new in ${LINE}`);
  await expect(whatsNew(win).locator(".aos-whatsnew-entry")).toHaveCount(ENTRIES);
  await expect(whatsNew(win).locator(".aos-whatsnew-tour")).toHaveText("Take the full tour");
  await whatsNew(win).locator(".aos-whatsnew-ok").click();
  await expect(whatsNew(win)).toHaveCount(0);

  // 5. Getting started.
  await expect(drawer(win).locator(".aos-tour-checklist")).toBeVisible();
  expect(await launchLog(win)).toEqual(["runtime", "go-local", "import", "whats-new", "checklist"]);
  expect(tourState().lastSeenVersion).toBe(HUD_VERSION);
  expect(tourState().launched).toEqual(expect.arrayContaining([GO_LOCAL, IMPORT, `whats-new@${HUD_VERSION}`]));
  expectNoErrors(h);
  await h.close();

  // Once: the next launch opens nothing on its own. Settings ▸ Local engine offers Undo, which puts the settings back.
  h = await launchApp({ tour: false, launch: false, env });
  await h.win.waitForTimeout(1500);
  await expect(h.win.locator(".modal-container")).toHaveCount(0);
  expect(await launchLog(h.win)).toEqual([]);
  await openTab(h.win, "settings");
  const row = content(h.win).locator('[data-tour="settings-golocal"]');
  await expect(row).toContainText("You went local");
  await row.locator('[data-act="go-local-undo"]').click();
  await h.win.locator(".aos-confirm-modal button.mod-cta").click();
  // The state is recorded last, after the keys and the schedules.
  await expect.poll(() => migration("local-first"), { timeout: 30_000 }).toBe("undone");
  expect(readJson(AGENTICOS).provider).toBe("none");
  expect(readJson(AGENTICOS).ai).toBeUndefined();
  expect(kept()).toEqual([null, null, false]);
  await expect(content(h.win).locator('[data-tour="settings-golocal"] [data-act="go-local"]')).toBeVisible();
  expectNoErrors(h);
});

test("a new install: the welcome tour, then Getting started; the vault is noted at once", async () => {
  restoreFixture();
  h = await launchApp({
    noted: false, launch: false,
    // What the wizard's `aos init` recorded (src/main/setup/attach.ts markInstalled), before the first launch.
    prepare: () => {
      fs.mkdirSync(USER_DATA, { recursive: true });
      fs.writeFileSync(path.join(USER_DATA, "attach.json"), `${JSON.stringify({ vaults: { [path.resolve(FX.vault)]: { firstAt: new Date().toISOString(), installedAt: new Date().toISOString() } } }, null, 2)}\n`);
    },
  });
  const { win } = h;
  await expect(win.locator(".aos-tour-pop")).toHaveAttribute("data-step", "core.rail");
  await expect(win.locator(".modal-container")).toHaveCount(0);
  expect(await launchLog(win)).toEqual(["core-tour"]);
  const rec = () => readJson(path.join(USER_DATA, "attach.json")).vaults[path.resolve(FX.vault)] as { notedAt?: string };
  await expect.poll(() => rec().notedAt).toBeTruthy();
  await win.keyboard.press("Escape");
  await expect(win.locator(".aos-tour")).toHaveCount(0);
  await expect(drawer(win).locator(".aos-tour-checklist")).toBeVisible();
  expect(await launchLog(win)).toEqual(["core-tour", "checklist"]);
  expectNoErrors(h);
});

test("a vault with nothing to import: the sheet says so, and OK settles the import (declined, nothing written)", async () => {
  restoreFixture();
  h = await launchApp({
    launch: false, env: { AOS_APP_WRITE: "migrate" },
    prepare: () => { pending(["import"]); noHistory(); },
  });
  const { win } = h;
  await expect(sheet(win).locator('.aos-importsheet-body[data-state="empty"]')).toBeVisible({ timeout: 60_000 });
  await expect(sheet(win).locator(".aos-importsheet-empty")).toContainText("There is nothing from Claude Code or Codex on this Mac to bring in");
  await expect(sheet(win).locator(".aos-importsheet-import")).toHaveCount(0);
  await sheet(win).locator(".aos-importsheet-ok").click();
  await expect(sheet(win)).toHaveCount(0, { timeout: 30_000 });
  expect(migration("import")).toBe("declined");
  expect(fs.existsSync(FX.v("brain/_index/import-state.json"))).toBe(false);
  expect(await launchLog(win)).toEqual(["import"]);
  await expect.poll(() => tourState().launched ?? []).toContain(IMPORT);
  expectNoErrors(h);
});

test("Codex only: the card names gpt-6-sol and Codex; Keep my settings changes nothing, and Settings offers Go local later", async () => {
  restoreFixture();
  h = await launchApp({
    launch: false, env: { AOS_APP_WRITE: "migrate" },
    prepare: () => {
      editJson(AGENTICOS, (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = true; });
      pending();
    },
  });
  const { win } = h;
  await expect(card(win).locator(".aos-golocal-chief")).toHaveText("Move the Chief of Staff to gpt-6-sol");
  await expect(card(win).locator('[data-col="hosted"]')).toContainText("on Codex");
  await expect(card(win).locator('[data-col="hosted"]')).not.toContainText("Claude Code");
  const before = fs.readFileSync(AGENTICOS, "utf8");
  await card(win).locator(".aos-golocal-keep").click();
  await expect(card(win)).toHaveCount(0, { timeout: 30_000 });
  expect(migration("local-first")).toBe("declined");
  expect(fs.readFileSync(AGENTICOS, "utf8")).toBe(before);
  // The Import sheet next: a host's files come in whether or not it is on, so both are listed; Not now declines.
  await expect(sheet(win).locator('.aos-importsheet-body[data-state="ready"]')).toBeVisible({ timeout: 60_000 });
  await expect(sheet(win).locator(".aos-importsheet-table th[data-host]")).toHaveText(["Claude Code", "Codex"]);
  await sheet(win).locator(".aos-importsheet-later").click();
  await expect(sheet(win)).toHaveCount(0, { timeout: 30_000 });
  expect(migration("import")).toBe("declined");
  expect(fs.existsSync(FX.v("brain/_index/import-state.json"))).toBe(false);
  expect(await launchLog(win)).toEqual(["go-local", "import"]);
  await openTab(win, "settings");
  const row = content(win).locator('[data-tour="settings-golocal"]');
  await expect(row).toContainText("(you kept your settings)");
  await expect(row.locator('[data-act="go-local"]')).toHaveText("Go local…");
  expectNoErrors(h);
});

test("no host, Go local surface off: the card shows the commands, not buttons; closing it leaves the choice; Pulse says how to add a host", async () => {
  restoreFixture();
  h = await launchApp({
    launch: false,
    prepare: () => {
      editJson(AGENTICOS, (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = false; });
      pending();
    },
  });
  const { win } = h;
  await expect(card(win).locator(".aos-golocal-chief")).toHaveText(/Opus 5\.5 \/ gpt-6-sol when you add a host$/);
  await expect(card(win).locator('[data-col="hosted"]')).toContainText("Claude Code or Codex, once you add one");
  // The `migrate` surface is off here (this run's writes are off): the exact commands, each with ❯_, and no buttons the
  // app would refuse; the box changes the command.
  await expect(card(win).locator(".aos-golocal-go, .aos-golocal-keep")).toHaveCount(0);
  const apply = card(win).locator('.aos-golocal-cmd[data-cmd="apply"] .aos-golocal-cmdtext');
  await expect(apply).toHaveText("aos migrate local-first --apply --chief");
  await card(win).locator(".aos-golocal-chief input").uncheck();
  await expect(apply).toHaveText("aos migrate local-first --apply");
  await expect(card(win).locator('.aos-golocal-cmd[data-cmd="decline"] .aos-golocal-cmdtext')).toHaveText("aos migrate local-first --decline");
  await expect(card(win).locator(".aos-golocal-cmdgo")).toHaveCount(2);
  expect(tourState().launched ?? []).not.toContain(GO_LOCAL);
  await win.keyboard.press("Escape");
  await expect(card(win)).toHaveCount(0);
  expect(migration("local-first")).toBe("pending");
  await expect.poll(() => tourState().launched ?? []).toContain(GO_LOCAL);
  // The Import sheet, with the same surface off: its commands, not a scan the app would refuse.
  await expect(sheet(win).locator('.aos-importsheet-cmd[data-cmd="apply"] .aos-importsheet-cmdtext')).toHaveText("aos migrate import --apply");
  await expect(sheet(win).locator('.aos-importsheet-cmd[data-cmd="decline"] .aos-importsheet-cmdtext')).toHaveText("aos migrate import --decline");
  await expect(sheet(win).locator('.aos-importsheet-cmd[data-cmd="scan"] .aos-importsheet-cmdtext')).toHaveText("aos import --dry-run");
  await expect(sheet(win).locator(".aos-importsheet-import, .aos-importsheet-table")).toHaveCount(0);
  await win.keyboard.press("Escape");
  await expect(sheet(win)).toHaveCount(0);
  expect(migration("import")).toBe("pending");
  await expect.poll(() => tourState().launched ?? []).toContain(IMPORT);
  expect(await launchLog(win)).toEqual(["go-local", "import"]);
  await openTab(win, "pulse");
  const waiting = content(win).locator(".aos-pulse-waiting");
  await expect(waiting).toContainText("Add Claude Code or Codex to start your Chief of Staff.");
  await waiting.locator(".aos-pulse-waiting-go").click();
  await expect(rail(win, "settings")).toHaveClass(/is-active/);
  expectNoErrors(h);
});
