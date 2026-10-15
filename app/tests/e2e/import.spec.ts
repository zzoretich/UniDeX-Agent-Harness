// install-import B2, B4, B10 in the Workbench: Settings ▸ Hosts (each host on, installed and signed in, from `aos hosts
// status --json`, a background read; Add <host> through the `hosts` surface), Settings ▸ Import (each host's last import,
// Import and Import older history through the `import` surface) and Pulse's digest line, per variant: the default
// fixture (Claude Code) with both surfaces on and Codex installed and signed in, so Add Codex runs the vault's own
// `aos hosts add codex` against the repository's fake Codex CLI and an Import runs the vault's own `aos import`; a
// Codex-only machine with the surfaces off (the app's default until their live check), where each refuses and points at
// the Code tab; and a machine with no host at all. No real claude or codex runs: AOS_CLAUDE_BIN and AOS_CODEX_BIN name
// the fixtures in cli/fixtures, and the fixture's provider is none, so the import calls no model.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, REPO, content, expectNoErrors, openTab, useApp } from "./harness";

const FAKE_CLAUDE = path.join(REPO, "..", "cli", "fixtures", "fake-claude.sh");
const FAKE_CODEX = path.join(REPO, "..", "cli", "fixtures", "fake-codex.sh");
const AGENTICOS = path.join(FX.claude, "agenticos.json");
const STATE = FX.v("brain/_index/import-state.json");
const CODEX_LOG = path.join(FX.root, "import-spec-codex.log");

const C = (win: Page) => content(win);
const hosts = (win: Page) => C(win).locator('[data-tour="settings-host-list"]');
const hostRow = (win: Page, h: string) => hosts(win).locator(`.aos-st-hostrow[data-host="${h}"]`);
const imports = (win: Page) => C(win).locator('[data-tour="settings-import"]');
const importRow = (win: Page, h: string) => imports(win).locator(`.aos-st-hostrow[data-host="${h}"]`);
const confirmModal = (win: Page, title: string) => win.locator(".modal", { has: win.locator(".aos-confirm-modal h3", { hasText: title }) });
const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Settings, with the hosts as their CLIs answered (not the caches standing in). */
async function settings(win: Page): Promise<void> {
  await openTab(win, "settings");
  await expect(hosts(win)).toHaveAttribute("data-source", "runtime", { timeout: 30_000 });
}

/** A digest part way through: 140 of 412 sessions, 272 queued. */
function digestState(o: { processed: number; total: number; done?: boolean }): string {
  const left = o.done ? 0 : o.total - o.processed;
  return `${JSON.stringify({
    schema: 1,
    phases: [
      { phase: "instructions", host: "claude", done: true, cursor: null, counts: { written: 5 }, at: "2026-10-14T10:00:00.000Z" },
      { phase: "sessions", host: "claude", done: true, cursor: null, counts: { added: o.total, queued: o.total }, at: "2026-10-14T10:00:01.000Z" },
    ],
    hashes: {}, files: {},
    digest: { since: "90d", processed: o.processed, total: o.total, done: !!o.done, finishedAt: o.done ? "2026-10-15T00:00:00.000Z" : null, lastRun: null, queue: Array.from({ length: left }, (_, i) => ({ key: `claude:${i}` })) },
    runs: [{ at: "2026-10-14T10:00:01.000Z", from: ["claude"], only: ["instructions", "sessions"], since: "90d", written: 5 }],
  }, null, 2)}\n`;
}

test.describe("Claude Code, with Codex installed and signed in; Import and Hosts on", () => {
  test.describe.configure({ mode: "serial" });
  const app = useApp({
    prepare: () => { fs.rmSync(CODEX_LOG, { force: true }); },
    env: {
      AOS_APP_WRITE: "import,hosts",
      AOS_NO_CLAUDE: undefined, AOS_NO_CODEX: undefined, AOS_CLAUDE_BIN: FAKE_CLAUDE, AOS_CODEX_BIN: FAKE_CODEX,
      FAKE_CODEX_LOG: CODEX_LOG, FAKE_CODEX_STATE: path.join(FX.root, "import-spec-codex.state"),
    },
  });

  test("Settings ▸ Hosts: Claude Code on and signed in; Codex installed and signed in, not added, with Add Codex", async () => {
    const { win } = app();
    await settings(win);
    await expect(hostRow(win, "claude")).toHaveAttribute("data-state", "ready");
    await expect(hostRow(win, "claude").locator(".aos-st-hoststate")).toHaveText(`On · signed in · ${FAKE_CLAUDE}`);
    await expect(hostRow(win, "claude").locator('[data-act="add-claude"]')).toHaveCount(0);
    await expect(hostRow(win, "codex")).toHaveAttribute("data-state", "off");
    await expect(hostRow(win, "codex").locator(".aos-st-hoststate")).toHaveText(`Installed and signed in · ${FAKE_CODEX}; not added to this vault yet.`);
    await expect(hostRow(win, "codex").locator('[data-act="add-codex"]')).toBeEnabled();
    await expect(hosts(win).locator(".aos-st-hostsource")).toHaveText("Checked with each host's CLI.");
  });

  test("Add Codex asks first, runs aos hosts add codex, lists what is next, and Codex reads on", async () => {
    const { win } = app();
    await settings(win);
    await hostRow(win, "codex").locator('[data-act="add-codex"]').click();
    const modal = confirmModal(win, "Add Codex?");
    await expect(modal.locator(".aos-confirm-modal p")).toContainText("It runs aos hosts add codex.");
    await modal.getByRole("button", { name: "Add Codex" }).click();
    const result = hostRow(win, "codex").locator('[data-row="result"]');
    await expect(result).toContainText("Codex is added to this vault.", { timeout: 60_000 });
    await expect(result.locator("li").first()).toContainText("run /hooks, and trust");
    await expect(result.locator("li").nth(1)).toHaveText("Bring in its session history: aos import --from codex");
    await expect(hostRow(win, "codex")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    expect(readJson(AGENTICOS).hosts.codex.enabled).toBe(true);
    expect(readJson(AGENTICOS).hosts.claude.enabled).toBe(true);
    expect(fs.readFileSync(CODEX_LOG, "utf8")).toMatch(/^plugin add agenticos@agenticos-workbench/m);
  });

  test("Settings ▸ Import: Import for Claude Code runs the vault's aos import, then shows its last import", async () => {
    const { win } = app();
    await settings(win);
    await expect(importRow(win, "claude").locator('[data-row="last"]')).toHaveText("Not imported yet");
    await importRow(win, "claude").locator('[data-act="import-claude"]').click();
    const run = importRow(win, "claude").locator('[data-row="run"]');
    await expect(run).toHaveClass(/is-ok/, { timeout: 120_000 });
    await expect(run).toContainText("Claude Code: imported.");
    await expect(run).toContainText("New memories wait in Brain ▸ Review.");
    await expect(importRow(win, "claude").locator('[data-row="last"]')).toHaveText(/^Last imported .+: /);
    const state = readJson(STATE) as { phases: Array<{ phase: string; host: string }>; runs: Array<{ from: string[] }> };
    expect(state.phases.filter((p) => p.host === "claude").map((p) => p.phase).sort()).toEqual(["instructions", "mcp", "memories", "projects", "sessions"]);
    expect(state.runs.at(-1)?.from).toEqual(["claude"]);
    // Older history is a button of its own, for both hosts.
    await expect(imports(win).locator('[data-act="import-older"]')).toHaveText("Import older history");
  });

  test("Pulse follows the digest while sessions wait, and the line goes once it is done", async () => {
    const h = app();
    fs.writeFileSync(STATE, digestState({ processed: 140, total: 412 }));
    await openTab(h.win, "pulse");
    const line = h.win.locator('.aos-pulse-import[data-row="import-digest"]');
    await expect(line).toHaveText("Digesting history: 140 of 412 sessions");
    await settings(h.win);
    await expect(imports(h.win).locator('[data-row="digest"]')).toHaveText("Digesting history: 140 of 412 sessions");
    fs.writeFileSync(STATE, digestState({ processed: 412, total: 412, done: true }));
    await openTab(h.win, "pulse");
    await expect(line).toHaveCount(0);
    expectNoErrors(h);
  });
});

test.describe("a Codex-only machine, Import and Hosts off (the app's default)", () => {
  test.describe.configure({ mode: "serial" });
  const app = useApp({
    prepare: () => editJson(AGENTICOS, (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = true; j.hosts.codex.install = "plugin"; }),
    env: { AOS_NO_CLAUDE: undefined, AOS_NO_CODEX: undefined, AOS_CLAUDE_BIN: FAKE_CLAUDE, AOS_CODEX_BIN: FAKE_CODEX },
  });

  test("Hosts: Codex on; Add Claude Code is refused by the surface, says so and offers the Code tab; nothing changed", async () => {
    const { win } = app();
    await settings(win);
    await expect(hostRow(win, "codex")).toHaveAttribute("data-state", "ready");
    await expect(hostRow(win, "claude")).toHaveAttribute("data-state", "off");
    const before = fs.readFileSync(AGENTICOS, "utf8");
    await hostRow(win, "claude").locator('[data-act="add-claude"]').click();
    await confirmModal(win, "Add Claude Code?").getByRole("button", { name: "Add Claude Code" }).click();
    const result = hostRow(win, "claude").locator('[data-row="result"]');
    await expect(result).toContainText("Adding a host from here is off under the app's write surfaces (Hosts).");
    await expect(result.locator('[data-act="add-term-claude"]')).toHaveText("❯_ aos hosts add claude");
    expect(fs.readFileSync(AGENTICOS, "utf8")).toBe(before);
    // The dimmed Claude rows below point here.
    await expect(C(win).locator(".aos-st-row.is-dim .aos-st-hostnote").first()).toHaveText("Claude Code is off on this machine; Add Claude Code under Hosts (`aos hosts add claude`) turns it on");
  });

  test("Import: both hosts listed (a host's files come in whether or not it is on); refused with the surface off", async () => {
    const { win } = app();
    await settings(win);
    for (const h of ["claude", "codex"]) await expect(importRow(win, h).locator('[data-row="last"]')).toHaveText("Not imported yet");
    await importRow(win, "codex").locator('[data-act="import-codex"]').click();
    const run = importRow(win, "codex").locator('[data-row="run"]');
    await expect(run).toHaveClass(/is-err/, { timeout: 30_000 });
    await expect(run).toContainText("Importing from here is off under the app's write surfaces (Import).");
    await expect(run.locator('[data-act="import-term-codex"]')).toHaveText("❯_ aos import --from codex");
    expect(fs.existsSync(STATE)).toBe(false);
  });
});

test.describe("no host: neither CLI installed, neither on", () => {
  test.describe.configure({ mode: "serial" });
  const app = useApp({ prepare: () => editJson(AGENTICOS, (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = false; }) });

  test("Hosts: each not installed, with the steps to install it and Add off until then; Import is there", async () => {
    const h = app();
    await settings(h.win);
    for (const [host, label, cmd] of [["claude", "Claude Code", "curl -fsSL https://claude.ai/install.sh | bash"], ["codex", "Codex", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"]]) {
      const row = hostRow(h.win, host);
      await expect(row).toHaveAttribute("data-state", "off-missing");
      await expect(row.locator(".aos-st-hoststate")).toHaveText("Not installed on this Mac.");
      await expect(row.locator(`[data-act="add-${host}"]`)).toBeDisabled();
      await expect(row.locator(`[data-act="add-${host}"]`)).toHaveAttribute("title", `Install ${label} and sign in first`);
      await expect(row.locator(".aos-st-hoststeps li").nth(1)).toHaveText(`Type ${cmd} and press Return.`);
    }
    await expect(imports(h.win).locator('[data-act="import-older"]')).toBeVisible();
    expectNoErrors(h);
  });
});
