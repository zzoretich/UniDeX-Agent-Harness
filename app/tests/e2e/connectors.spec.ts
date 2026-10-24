// The Connectors tab (spec 2026-10-23-connectors-tab D3–D5, D10, D12): the health board and a card's sheet over the
// fixture's caches: what `aos mcp list` found and counted (Claude Code's user servers and the vault's own plugin server,
// Codex's servers, the claude.ai connectors the last check named, a built-in seen in a subagent's calls) and a
// hand-made check (a failing connector, a server needing sign-in). On the fixture as it is (Claude Code on, Codex off),
// on a Codex-only machine, with both hosts, and before any check. Check now runs the vault's own `aos mcp check --json`
// (a background refresh the app allows): in the fixture neither host's CLI is found and the servers' programs do not
// exist, so it ends in a moment; a check held by another (its lock taken here) is refused, and the tab says so
// (app-smoke: Connectors). Copy to … runs for real in history-mcp.spec.ts.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, badge, content, expected, expectNoErrors, freshConnectorsCheck, openTab, rail, useApp } from "./harness";

const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};
const AGENTICOS = path.join(FX.claude, "agenticos.json");
const PROVIDER_STATE = () => FX.v("brain/_index/provider-state.json");
const LIVE = () => FX.v("brain/_index/connectors-live.json");

const C = (win: Page) => content(win);
const card = (win: Page, key: string) => C(win).locator(`[data-conn="${key}"]`).first();
const group = (win: Page, g: string) => C(win).locator(`[data-group="${g}"]`);
const tile = (win: Page, t: string) => C(win).locator(`button.aos-con-tile[data-tile="${t}"]`);
const sheet = (win: Page) => C(win).locator("aside.aos-con-sheet");
const hostRow = (win: Page, h: string) => sheet(win).locator(`.aos-con-hostrow[data-host="${h}"]`);
/** When the check in the vault last ran (connectors-live.json's checkedAt), or null before any. */
const checkedAt = (): string | null => { try { return (JSON.parse(fs.readFileSync(LIVE(), "utf8")) as { checkedAt?: string }).checkedAt ?? null; } catch { return null; } };
/** Holds the check's lock as another check would (lib/connectors/check.js tryLock): `aos mcp check` is refused meanwhile. */
const LOCK = () => `${LIVE()}.lock`;
const holdCheckLock = () => fs.writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, id: "e2e", until: new Date(Date.now() + 3_600_000).toISOString() }));

test.describe("the fixture: Claude Code on, Codex off", () => {
  const app = useApp({ prepare: freshConnectorsCheck });

  test("the board: the header's line, four tiles, NEEDS ATTENTION with one fix each, the grids and the folded rows; the rail badge counts what failed", async () => {
    const h = app();
    const { win } = h;
    const x = expected().connectors;
    // Two need attention after a check within the day: the rose badge shows it before the tab is opened (D5).
    await expect(badge(win, "connectors")).toHaveText("2");
    await expect(badge(win, "connectors")).toHaveClass(/is-urgent/);
    await openTab(win, "connectors");
    await expect(C(win).locator(".aos-con-h1")).toHaveText("Connectors");
    await expect(C(win).locator(".aos-con-meta")).toHaveText(/^checked (just now|\d+ min ago) · next check in \d+ min · Claude Code 7$/);
    await expect(C(win).locator("button.aos-con-check")).toHaveText("Check now");
    await expect(tile(win, "attention").locator(".aos-con-tilen")).toHaveText("2");
    await expect(tile(win, "attention")).toHaveClass(/is-danger/);
    await expect(tile(win, "attention").locator(".aos-con-tilesub")).toHaveText("1 connector · 1 server");
    await expect(tile(win, "connected").locator(".aos-con-tilen")).toHaveText("5");
    await expect(tile(win, "unused")).toContainText("Unused in 30 days");
    await expect(tile(win, "unused").locator(".aos-con-tilen")).toHaveText("5");
    await expect(tile(win, "off").locator(".aos-con-tilen")).toHaveText("0");
    // NEEDS ATTENTION: the failing claude.ai connector, then the server that needs sign-in (most called first, then by name).
    const att = group(win, "attention");
    await expect(att.locator(".aos-con-h2")).toHaveText("NEEDS ATTENTION · 2");
    await expect(att.locator(".aos-con-alertname")).toHaveText([x.failed, x.needsAuth].sort((a, b) => a.localeCompare(b)));
    const mail = card(win, `c:${x.failed.toLowerCase()}`);
    await expect(mail.locator(".aos-con-kind")).toHaveText("claude.ai connector");
    await expect(mail.locator(".aos-con-reason")).toHaveText("-32600: client not permitted");
    await expect(mail.locator("button.aos-con-fix")).toHaveText("Open claude.ai connectors");
    const auth = card(win, `s:${x.needsAuth}`);
    await expect(auth.locator(".aos-con-kind")).toHaveText("http · Claude Code");
    await expect(auth.locator(".aos-con-reason")).toHaveText("Needs authentication");
    await expect(auth.locator(".aos-con-hint")).toHaveText("Sign in from /mcp in a Claude Code session.");
    await expect(auth.locator("button.aos-con-fix")).toHaveText("Check again");
    // CONNECTORS and MCP SERVERS: Claude Code's dot on each, none for Codex (off on this machine).
    await expect(group(win, "connectors").locator(".aos-con-cname")).toHaveText([x.connected]);
    await expect(group(win, "connectors").locator(".aos-con-use")).toHaveText(["unused 30d"]);
    await expect(C(win).locator(".aos-con-dot.is-codex")).toHaveCount(0);
    const servers = group(win, "servers");
    await expect(servers.locator(".aos-con-h2")).toHaveText("MCP SERVERS · 3bars are calls per day, 30 days");
    await expect(servers.locator(".aos-con-cname")).toHaveText([expected().mcp.claude, "agenticos", expected().mcp.both]);
    const docs = card(win, `s:${expected().mcp.claude}`);
    await expect(docs.locator(".aos-con-sub")).toHaveText("stdio · npx");
    await expect(docs.locator(".aos-con-foot")).toHaveText(/^3 tools4 calls · [23]h ago$/);
    await expect(docs.locator(".aos-con-bar")).toHaveCount(30);
    await expect(docs.locator(".aos-con-bar.is-on")).toHaveCount(1);
    await expect(docs.locator(".aos-con-dot.is-claude")).toHaveCount(1);
    // The folded rows: the built-in seen in use opens to its card; OFF and PROJECT are empty.
    await expect(group(win, "builtin").locator(".aos-con-foldcount")).toHaveText("1");
    await expect(group(win, "builtin").locator(".aos-con-peek")).toHaveText(x.builtin);
    await expect(group(win, "off").locator(".aos-con-peek")).toHaveText("nothing is turned off");
    await expect(group(win, "project").locator(".aos-con-peek")).toHaveText("no workspace declares its own servers");
    await expect(card(win, `b:${x.builtin}`)).toHaveCount(0);
    await group(win, "builtin").locator("button.aos-con-foldhead").click();
    await expect(group(win, "builtin").locator("button.aos-con-foldhead")).toHaveAttribute("aria-expanded", "true");
    await expect(card(win, `b:${x.builtin}`).locator(".aos-con-sub")).toHaveText("built into Claude Code");
    expectNoErrors(h);
  });

  test("a card opens its sheet: the host row, usage by host and day, the tools with their calls, where it was found; Esc, ✕ and the scrim close it", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "connectors");
    const docs = card(win, `s:${expected().mcp.claude}`);
    await docs.click();
    await expect(sheet(win)).toBeVisible();
    await expect(sheet(win).locator(".aos-con-sheettitle")).toHaveText(expected().mcp.claude);
    await expect(sheet(win).locator(".aos-con-tag")).toHaveText(["Local · stdio"]);
    await expect(sheet(win).locator(".aos-con-what")).toHaveText("npx");
    await expect(hostRow(win, "claude").locator(".aos-con-pill")).toHaveText("Connected");
    await expect(hostRow(win, "claude").locator(".aos-con-scope")).toHaveText("user · ~/.claude.json");
    await expect(sheet(win).locator(".aos-con-hostrow")).toHaveCount(1);
    await expect(sheet(win).locator("button.aos-con-copy")).toHaveCount(0);
    // Usage: the subagent's four calls are its session's (D13).
    const usage = sheet(win).locator(".aos-con-usage");
    await expect(usage.locator(".aos-con-h3")).toHaveText(/^USAGE · 30 DAYS1 session · last [23] h ago$/);
    await expect(usage.locator(".aos-con-callsn")).toHaveText("4");
    await expect(usage.locator(".aos-con-byline")).toHaveText(["Claude Code 4"]);
    await expect(usage.locator(".aos-con-bar")).toHaveCount(30);
    // Tools: every tool the check listed, the ones called with their count, most called first.
    const tools = sheet(win).locator(".aos-con-tools");
    await expect(tools.locator(".aos-con-h3")).toHaveText("TOOLS · 3calls in 30 days");
    await expect(tools.locator(".aos-con-chip")).toHaveText(["lookup3", "search1", "fetch_page"]);
    await expect(tools.locator('.aos-con-chip[data-tool="lookup"]')).toHaveAttribute("title", "Look a term up in the docs");
    await expect(sheet(win).locator(".aos-con-found")).toHaveText(/^Found automatically in ~\/\.claude\.json\. Checked (just now|\d+ min ago)\.$/);
    await expect(sheet(win).locator("button.aos-con-close")).toBeFocused();
    await win.keyboard.press("Escape");
    await expect(sheet(win)).toHaveCount(0);
    await expect(docs).toBeFocused();
    await docs.click();
    await sheet(win).locator("button.aos-con-close").click();
    await expect(sheet(win)).toHaveCount(0);
    await docs.click();
    await C(win).locator(".aos-con-scrim").click({ position: { x: 20, y: 200 } });
    await expect(sheet(win)).toHaveCount(0);
    // A built-in's tools are the ones seen in use (D12), said so. (The first test left its row open: the tab keeps it.)
    const fold = group(win, "builtin").locator("button.aos-con-foldhead");
    if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
    await card(win, `b:${expected().connectors.builtin}`).click();
    await expect(sheet(win).locator(".aos-con-tools .aos-con-h3")).toHaveText("TOOLS · 1seen in use — may be partial");
    await expect(sheet(win).locator(".aos-con-chip")).toHaveText(["getDiagnostics1"]);
    await expect(sheet(win).locator(".aos-con-found")).toHaveText("Seen in use in Claude Code's sessions; no config file declares it.");
    await win.keyboard.press("Escape");
    expectNoErrors(h);
  });

  test("the filter narrows every section by name, program or tool and keeps its focus; a tile shows only its cards until clicked again", async () => {
    const { win } = app();
    await openTab(win, "connectors");
    const q = C(win).locator("input.aos-con-q");
    await q.click();
    await win.keyboard.type("lookup");
    await expect(group(win, "servers").locator(".aos-con-cname")).toHaveText([expected().mcp.claude]);
    await expect(group(win, "attention").locator(".aos-con-none")).toHaveText("No card that needs attention matches.");
    await expect(group(win, "connectors").locator(".aos-con-none")).toHaveText("No connector matches.");
    await expect(q).toBeFocused();
    await q.fill("");
    await tile(win, "attention").click();
    await expect(tile(win, "attention")).toHaveAttribute("aria-pressed", "true");
    await expect(group(win, "attention").locator(".aos-con-alert")).toHaveCount(2);
    await expect(group(win, "servers").locator(".aos-con-none")).toHaveText("No server matches.");
    await tile(win, "unused").click();
    await expect(tile(win, "attention")).toHaveAttribute("aria-pressed", "false");
    await expect(group(win, "servers").locator(".aos-con-cname")).toHaveText(["agenticos", expected().mcp.both]);
    await tile(win, "unused").click();
    await expect(group(win, "servers").locator(".aos-con-card")).toHaveCount(3);
  });

  test("fixes: Open claude.ai connectors hands claude.ai's page to the OS; Check now while another check runs says why; Check again runs aos mcp check and the board shows what it found", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "connectors");
    const before = checkedAt();
    await card(win, `c:${expected().connectors.failed.toLowerCase()}`).locator("button.aos-con-fix").click();
    await expect.poll(async () => (await h.opened()).filter((o) => o.fn === "openExternal").map((o) => o.arg)).toEqual(["https://claude.ai/settings/connectors"]);
    // Checked a moment ago: opening the tab started no check of its own.
    expect(checkedAt()).toBe(before);
    holdCheckLock();
    await C(win).locator("button.aos-con-check").click();
    await expect(win.locator(".notice-container")).toContainText("Connectors: the check failed: mcp check: a check is already running: try again in a moment");
    await expect(C(win).locator(".aos-con-meta")).toHaveText("last check failed: mcp check: a check is already running: try again in a moment · Claude Code 7");
    await expect(C(win).locator("button.aos-con-check")).toBeEnabled();
    expect(checkedAt()).toBe(before);
    fs.rmSync(LOCK(), { force: true });
    // Check again on the server that needs sign-in: the vault's own check runs. Neither CLI is on this machine's PATH and
    // the servers' programs do not exist: Claude Code's banner says so, and its servers that failed to start join NEEDS ATTENTION.
    await card(win, `s:${expected().connectors.needsAuth}`).locator("button.aos-con-fix").click();
    await expect.poll(checkedAt, { timeout: 60_000 }).not.toBe(before);
    await expect(C(win).locator('.aos-con-banner[data-host="claude"]')).toHaveText("Claude Code could not be checked: the claude CLI was not found. Its servers show what the config files say.");
    await expect(C(win).locator(".aos-con-meta")).toHaveText(/^checked just now · next check in 15 min · Claude Code 7$/);
    await expect(card(win, `s:${expected().mcp.claude}`).locator(".aos-con-reason")).toHaveText("spawn npx ENOENT");
    await expect(card(win, "s:agenticos").locator(".aos-con-dot").first()).toHaveClass(/is-ok/);
    expectNoErrors(h);
  });
});

test.describe("before any check", () => {
  // No check yet, and one held elsewhere: the tab's own is refused, so the board stays as the files alone say.
  const app = useApp({ prepare: () => { fs.rmSync(LIVE(), { force: true }); holdCheckLock(); } });

  test("no badge; the tab asks for a check at once and says why it could not; every card is Not checked and its tools are the ones seen in use", async () => {
    const h = app();
    const { win } = h;
    await expect(badge(win, "connectors")).toHaveText("");
    await openTab(win, "connectors");
    await expect(C(win).locator(".aos-con-meta")).toHaveText("last check failed: mcp check: a check is already running: try again in a moment · Claude Code 7");
    // An automatic check that failed says so in the header only, no notice.
    await expect(win.getByText("Connectors: the check failed")).toHaveCount(0);
    await expect(tile(win, "attention").locator(".aos-con-tilen")).toHaveText("0");
    await expect(group(win, "attention").locator(".aos-con-none")).toHaveText("Nothing to report until the first check.");
    await card(win, `s:${expected().mcp.claude}`).click();
    await expect(hostRow(win, "claude").locator(".aos-con-pill")).toHaveText("Not checked");
    await expect(sheet(win).locator(".aos-con-tools .aos-con-h3")).toHaveText("TOOLS · 2seen in use — may be partial");
    await expect(sheet(win).locator(".aos-con-found")).toHaveText("Found automatically in ~/.claude.json. Not checked yet.");
    await win.keyboard.press("Escape");
    // An automatic check that failed is not tried again before the cadence comes round, even with the lock gone.
    fs.rmSync(LOCK(), { force: true });
    await openTab(win, "skills");
    await openTab(win, "connectors");
    await win.waitForTimeout(1000);
    expect(checkedAt()).toBeNull();
    await expect(C(win).locator(".aos-con-meta")).toHaveText(/^last check failed: /);
    expectNoErrors(h);
  });
});

test.describe("a runtime from before Connectors", () => {
  // Its scan writes no connectors.json: the tab asks for `aos upgrade` and starts nothing.
  const app = useApp({ prepare: () => { for (const f of ["connectors.json", "connectors-live.json", "connectors-usage.json"]) fs.rmSync(FX.v(`brain/_index/${f}`), { force: true }); } });

  test("the tab says the runtime predates Connectors and offers aos upgrade; no check, no badge", async () => {
    const h = app();
    const { win } = h;
    await expect(badge(win, "connectors")).toHaveText("");
    await openTab(win, "connectors");
    await expect(C(win).locator(".aos-con-upgrade p")).toHaveText("This vault's runtime predates Connectors: run aos upgrade to list every MCP server and connector both hosts can use here.");
    await expect(C(win).locator(".aos-con-upgrade button")).toHaveText("❯_ aos upgrade");
    await expect(C(win).locator("button.aos-con-check")).toBeDisabled();
    await expect(C(win).locator(".aos-con-meta")).toHaveText("never checked · Claude Code 0");
    await win.waitForTimeout(500);
    expect(checkedAt()).toBeNull();
    expectNoErrors(h);
  });
});

test.describe("a Codex-only machine", () => {
  const app = useApp({
    prepare: () => {
      freshConnectorsCheck();
      editJson(AGENTICOS, (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = true; });
      editJson(PROVIDER_STATE(), (j) => { j.name = "codex"; j.reason = "fixture"; j.codex = { ...(j.codex ?? {}), loggedIn: true, checkedAt: new Date().toISOString() }; });
    },
  });

  test("only Codex's servers, with Codex's dot; no claude.ai connector, no Claude Code dot, no badge", async () => {
    const h = app();
    const { win } = h;
    await expect(badge(win, "connectors")).toHaveText("");
    await openTab(win, "connectors");
    await expect(C(win).locator(".aos-con-meta")).toHaveText(/ · Codex 2$/);
    await expect(C(win).locator(".aos-con-dot.is-claude")).toHaveCount(0);
    await expect(group(win, "connectors").locator(".aos-con-card")).toHaveCount(0);
    await expect(group(win, "connectors").locator(".aos-con-h2")).toHaveText("CONNECTORS · 0ChatGPT apps for Codex");
    await expect(group(win, "servers").locator(".aos-con-cname")).toHaveText([expected().mcp.codex, expected().mcp.both]);
    await expect(card(win, `s:${expected().mcp.codex}`).locator(".aos-con-dot.is-codex")).toHaveCount(1);
    await expect(tile(win, "attention").locator(".aos-con-tilen")).toHaveText("0");
    await card(win, `s:${expected().mcp.codex}`).click();
    await expect(sheet(win).locator(".aos-con-hostrow")).toHaveCount(1);
    await expect(hostRow(win, "codex").locator(".aos-con-scope")).toHaveText("user · ~/.codex/config.toml");
    // Codex was off when the fixture's check ran: its servers are listed from the config, their state unknown.
    await expect(hostRow(win, "codex").locator(".aos-con-pill")).toHaveText("Unknown");
    await expect(sheet(win).locator("button.aos-con-copy")).toHaveCount(0);
    expectNoErrors(h);
  });
});

test.describe("both hosts, read-only", () => {
  const app = useApp({
    prepare: () => {
      freshConnectorsCheck();
      editJson(AGENTICOS, (j) => { j.hosts.claude.enabled = true; j.hosts.codex.enabled = true; });
    },
  });

  test("a server on both is one card with both dots and On both hosts; Copy to … is offered for a server on one, a remote one to Codex too (D20)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "connectors");
    await expect(C(win).locator(".aos-con-meta")).toHaveText(/ · Claude Code 7 · Codex 2$/);
    const both = card(win, `s:${expected().mcp.both}`);
    await expect(both.locator(".aos-con-dot.is-claude:not(.is-absent)")).toHaveCount(1);
    await expect(both.locator(".aos-con-dot.is-codex:not(.is-absent)")).toHaveCount(1);
    await both.click();
    await expect(sheet(win).locator(".aos-con-tag")).toHaveText(["Local · stdio", "On both hosts"]);
    await expect(sheet(win).locator(".aos-con-hostrow")).toHaveCount(2);
    await expect(sheet(win).locator("button.aos-con-copy")).toHaveCount(0);
    await win.keyboard.press("Escape");
    // Claude Code's remote server: Codex takes a streamable HTTP server as `codex mcp add --url` (D20).
    await card(win, `s:${expected().mcp.remote}`).locator("button.aos-con-alertname").click();
    const remote = hostRow(win, "codex").locator('button.aos-con-copy[data-to="codex"]');
    await expect(remote).toHaveText("Copy to Codex");
    await expect(remote).toBeEnabled();
    await expect(remote).toHaveAttribute("title", "Shows the exact Codex command and the file it writes before anything changes");
    await win.keyboard.press("Escape");
    // The app's write surfaces are off here: the dry run is refused, nothing runs, and the notice names the command.
    await card(win, `s:${expected().mcp.codex}`).click();
    const copy = hostRow(win, "claude").locator('button.aos-con-copy[data-to="claude"]');
    await expect(hostRow(win, "claude").locator(".aos-con-pill")).toHaveText("Not added");
    await expect(copy).toHaveText("Copy to Claude Code");
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(win.locator(".notice-container")).toContainText(/refused; no write surface that allows it is on — or run aos mcp copy issue-tracker --to claude in the Code tab/);
    await expect(win.locator(".aos-confirm-modal")).toHaveCount(0);
    await expect(copy).toHaveText("Copy to Claude Code");
    expectNoErrors(h);
  });

  test("the rail has Connectors right after Skills", async () => {
    const { win } = app();
    const ids = await win.locator(".aos-wb-railtabs .aos-wb-railbtn").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
    expect(ids.indexOf("connectors")).toBe(ids.indexOf("skills") + 1);
    await expect(rail(win, "connectors")).toHaveAttribute("aria-label", "Connectors");
  });
});
