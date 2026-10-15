// install-import B13 and inspection F7 on a Codex-only Mac: an earlier install left agenticos.json behind with both hosts
// on and its vault gone. Choose names the host the choice would drop (Claude Code, not installed here), offers no "keep"
// it cannot honour, and "Remove Claude Code's wiring first" runs `aos uninstall --host claude` from the payload, after
// which the checks run again and the choice stands. The install then brings in Codex's history: its row alone, the
// kinds it has, Import with sessions left out; Finish lists the /hooks steps and the history. Stand-ins as in
// setup.spec.ts, with a Codex that is logged in and no Claude Code.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, SETUP, SETUP_TOTALMEM, aosCalls, installSetupStubs, useApp } from "./harness";

const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const AGENTICOS = path.join(FX.claude, "agenticos.json");
const GONE = path.join(FX.root, "gone-vault");

const SCAN = {
  schema: 1, dryRun: true, since: "90d", windowDays: 90, from: ["claude", "codex"], only: ["instructions", "memories", "projects", "mcp", "sessions"],
  engine: { ready: false, provider: "none", model: null, reason: "local-down" },
  hosts: {
    claude: { present: false, configDir: "~/.claude" },
    codex: { present: true, configDir: "~/.codex", instructions: { files: 1, rules: 2, new: 2 }, memories: { files: 0, new: 0 }, mcp: { servers: 2 }, sessions: 3 },
  },
  projects: { proposals: [] },
};

const app = useApp({
  ready: ".aos-setup",
  noted: false,
  prepare: () => {
    installSetupStubs(VERSION, { hosts: false });
    fs.writeFileSync(path.join(SETUP.bin, "codex"), `#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.150.0";; login) echo "Logged in using ChatGPT";; *) exit 1;; esac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(SETUP.bin, "uv"), "#!/bin/sh\necho \"uv 0.13.1 (e2e stand-in)\"\n", { mode: 0o755 });
    fs.writeFileSync(SETUP.models, "qwen3.5:9b\nqwen3-embedding:0.6b\n");
    fs.writeFileSync(SETUP.importScan, JSON.stringify(SCAN));
    // The earlier install: both hosts wired, its vault no longer there.
    const cfg = JSON.parse(fs.readFileSync(AGENTICOS, "utf8")) as { vault: string; hosts: Record<string, { enabled: boolean; install?: string }> };
    cfg.vault = GONE;
    cfg.hosts.claude.enabled = true;
    cfg.hosts.codex = { ...cfg.hosts.codex, enabled: true, install: "plugin" };
    fs.writeFileSync(AGENTICOS, `${JSON.stringify(cfg, null, 2)}\n`);
  },
  env: { AOS_APP_VAULT: undefined, AOS_APP_PAYLOAD: SETUP.payload, AOS_SETUP_PATH: SETUP.bin, AOS_TOTALMEM: SETUP_TOTALMEM },
});

test.describe.configure({ mode: "serial" });

const row = (id: string) => app().win.locator(`.aos-setup-check[data-check="${id}"]`);
const log = () => app().win.evaluate(() => (window as unknown as { aosSetup: { log(): string } }).aosSetup.log());

test("Codex logged in, no Claude Code: ready, and the earlier install's vault is named as gone", async () => {
  const { win } = app();
  await expect(row("codex-login")).toHaveClass(/is-ok/);
  await expect(row("claude")).toHaveClass(/is-missing/);
  await expect(win.locator(".aos-setup-callout").first()).toContainText(`agenticos.json names ${GONE}, which is not there`);
  await expect(win.locator(".aos-setup-next")).toBeEnabled();
});

test("F7 as a choice: Codex alone would drop the earlier install's Claude Code, so Choose says why and waits", async () => {
  const { win } = app();
  await win.locator(".aos-setup-next").click();
  await expect(win.locator('input[name="aos-host"][value="codex"]')).toBeChecked();
  const box = win.locator('[data-callout="wired"]');
  await expect(box).toContainText(`An earlier install on this Mac left Claude Code on (${AGENTICOS}), so its UniDeX plugin, hooks and MCP server may still be wired.`);
  // Keeping it needs Claude Code installed and logged in, which it is not: no Keep button, and how to get there instead.
  await expect(box.locator(".aos-setup-keep-wired")).toHaveCount(0);
  await expect(box.locator(".aos-setup-hint")).toHaveText("To keep Claude Code instead, install and log in to it on Check, then choose Both here.");
  await expect(box.locator(".aos-setup-unwire")).toHaveText("Remove Claude Code's wiring first");
  await expect(win.locator(".aos-setup-next")).toBeDisabled();
  await win.screenshot({ path: test.info().outputPath("wizard-wired.png") });
});

test("Remove Claude Code's wiring first runs aos uninstall --host claude; the checks run again and Codex alone goes on", async () => {
  const { win } = app();
  await win.locator(".aos-setup-unwire").click();
  await expect(win.locator('[data-callout="wired"]')).toHaveCount(0, { timeout: 20_000 });
  expect(aosCalls().map((c) => c.argv)).toEqual([["uninstall", "--host", "claude"]]);
  expect((JSON.parse(fs.readFileSync(AGENTICOS, "utf8")) as { hosts: { claude: { enabled: boolean }; codex: { enabled: boolean } } }).hosts).toMatchObject({ claude: { enabled: false }, codex: { enabled: true } });
  expect(await log()).toContain("aos uninstall --host claude");
  await expect(win.locator('input[name="aos-host"][value="codex"]')).toBeChecked();
  await expect(win.locator(".aos-setup-next")).toBeEnabled();
  await win.locator(".aos-setup-vault-input").fill(FX.vault);
  await win.locator(".aos-setup-next").click();
  await expect(win.locator('[data-field="dutyCodexModel"]')).toHaveValue("gpt-6-sol");
  await win.locator(".aos-setup-skip").click();
  await expect(win.locator('.aos-setup-body[data-step="history"] table.aos-setup-import')).toBeVisible({ timeout: 20_000 });
  expect(aosCalls().map((c) => c.argv.slice(0, 6))).toEqual([["uninstall", "--host", "claude"], ["init", "--yes", "--vault", FX.vault, "--host", "codex"], ["import", "--from", "all", "--dry-run", "--json"]]);
});

test("Bring in your history on Codex alone: its row and kinds; Import without the sessions; Finish has /hooks and the history", async () => {
  const { win } = app();
  const body = win.locator('.aos-setup-body[data-step="history"]');
  await expect(body.locator("tr[data-host]")).toHaveCount(1);
  await expect(body.locator('tr[data-host="codex"] td')).toHaveText(["2 rules", "2 servers", "3 sessions"]);
  await expect(body.locator("input[data-kind]")).toHaveCount(3);
  await expect(body.locator('[data-section="proposals"]')).toHaveCount(0);
  await body.locator('input[data-kind="sessions"]').uncheck();
  await body.locator(".aos-setup-import-run").click();
  await expect(win.locator('.aos-setup-body[data-step="finish"]')).toBeVisible({ timeout: 20_000 });
  expect(aosCalls().at(-1)?.argv).toEqual(["import", "--from", "codex", "--only", "instructions,mcp"]);
  await expect(win.locator('[data-section="codex-hooks"] h3')).toHaveText("Trust the hooks in Codex");
  await expect(win.locator('[data-section="history"] h3')).toHaveText("Your history is coming in");
  await expect(win.locator('[data-section="history"] .aos-setup-hint')).toHaveText("Its instructions and memories wait in Brain ▸ Review for you to keep.");
  await expect(win.locator('[data-section="claude-md"]')).toHaveCount(0);
});
