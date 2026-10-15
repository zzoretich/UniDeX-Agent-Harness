// install-import B2, B13, B14: the wizard on a Mac with neither Claude Code nor Codex. Nothing about a host holds up the
// checks; Choose offers "No agent CLI yet" (and only that), skips the Chief of Staff, and installs with `--host none`;
// Finish says, step by step, how to add a host later, and an unticked PATH box writes nothing. Stand-ins as in
// setup.spec.ts, without the two CLIs; uv and Ollama's models are already there, so nothing is downloaded.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, SETUP, SETUP_TOTALMEM, USER_DATA, aosCalls, installSetupStubs, useApp } from "./harness";

const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const ZPROFILE = path.join(FX.home, ".zprofile");

const app = useApp({
  ready: ".aos-setup",
  // A Mac this app has never opened the fixture vault on: the install it makes is a first launch (the welcome tour).
  noted: false,
  prepare: () => {
    installSetupStubs(VERSION, { hosts: false });
    fs.writeFileSync(path.join(SETUP.bin, "uv"), "#!/bin/sh\necho \"uv 0.13.1 (e2e stand-in)\"\n", { mode: 0o755 });
    fs.writeFileSync(SETUP.models, "qwen3.5:9b\nqwen3-embedding:0.6b\n");
    fs.rmSync(path.join(FX.claude, "agenticos.json"), { force: true });
    fs.rmSync(ZPROFILE, { force: true });
  },
  env: { AOS_APP_VAULT: undefined, AOS_APP_PAYLOAD: SETUP.payload, AOS_SETUP_PATH: SETUP.bin, AOS_TOTALMEM: SETUP_TOTALMEM },
});

test.describe.configure({ mode: "serial" });

const row = (id: string) => app().win.locator(`.aos-setup-check[data-check="${id}"]`);

test("no host: the checks are ready without one, and each host's install waits for nothing", async () => {
  const { win } = app();
  await expect(row("uv")).toHaveClass(/is-ok/);
  await expect(row("ollama-models")).toHaveClass(/is-ok/);
  for (const id of ["claude", "codex"]) {
    await expect(row(id)).toHaveClass(/is-missing/);
    await expect(row(id).locator(".aos-setup-mark")).toHaveText("○");
    await expect(row(id).locator(".aos-setup-fix")).toBeEnabled();
  }
  await expect(row("claude").locator(".aos-setup-fix")).toHaveText("Install Claude Code");
  await expect(row("codex").locator(".aos-setup-fix")).toHaveText("Install Codex");
  await expect(row("claude-login").locator(".aos-setup-fix")).toBeDisabled();
  await expect(win.locator(".aos-setup-install-missing")).toHaveCount(0);
  await expect(win.locator(".aos-setup-next")).toBeEnabled();
});

test("inspection M2: a host logged in after the first check replaces No agent CLI yet, with its radio checked", async () => {
  const { win } = app();
  await win.locator(".aos-setup-next").click();
  await expect(win.locator('input[name="aos-host"][value="none"]')).toBeChecked();
  await win.getByRole("button", { name: "Back" }).click();
  // Claude Code installed and logged in meanwhile: the next check offers it, and it is the one chosen.
  const claude = path.join(SETUP.bin, "claude");
  fs.writeFileSync(claude, `#!/bin/sh\ncase "$1" in --version) echo "2.1.0 (Claude Code)";; auth) echo '{"loggedIn": true}';; *) exit 1;; esac\n`, { mode: 0o755 });
  await win.locator(".aos-setup-recheck").click();
  await expect(row("claude-login")).toHaveClass(/is-ok/);
  await win.locator(".aos-setup-next").click();
  await expect(win.locator('input[name="aos-host"][value="none"]')).not.toBeChecked();
  await expect(win.locator('input[name="aos-host"][value="claude"]')).toBeChecked();
  await expect(win.locator(".aos-setup-next")).toBeEnabled();
  // F5: No agent CLI yet stays on offer, and once picked it stands across a check that still finds Claude Code.
  await win.locator('input[name="aos-host"][value="none"]').check();
  await win.getByRole("button", { name: "Back" }).click();
  await win.locator(".aos-setup-recheck").click();
  await expect(row("claude-login")).toHaveClass(/is-ok/);
  await win.locator(".aos-setup-next").click();
  await expect(win.locator('input[name="aos-host"][value="none"]')).toBeChecked();
  await expect(win.locator(".aos-setup-install")).toBeEnabled();
  // Gone again: back to No agent CLI yet, checked, for the rest of this file.
  fs.rmSync(claude);
  await win.getByRole("button", { name: "Back" }).click();
  await win.locator(".aos-setup-recheck").click();
  await expect(row("claude")).toHaveClass(/is-missing/);
});

test("Choose offers No agent CLI yet, says what waits for a host, and installs with --host none and no Chief of Staff", async () => {
  const { win } = app();
  await win.locator(".aos-setup-next").click();
  await expect(win.locator('input[name="aos-host"][value="none"]')).toBeChecked();
  for (const id of ["claude", "codex", "both"]) await expect(win.locator(`input[name="aos-host"][value="${id}"]`)).toBeDisabled();
  await expect(win.locator('[data-hint="no-host"]')).toHaveText("Sessions and the Chief of Staff wait until Claude Code or Codex is added. Finish says how.");
  await win.locator(".aos-setup-vault-input").fill(FX.vault);
  await expect(win.locator(".aos-setup-next")).toHaveCount(0);
  await win.locator(".aos-setup-install").click();
  await expect(win.locator('.aos-setup-body[data-step="finish"]')).toBeVisible({ timeout: 20_000 });
  const calls = aosCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].argv).toEqual(["init", "--yes", "--vault", FX.vault, "--host", "none"]);
  expect(calls[0].persona).toBeNull();
});

test("Finish says how to add a host, step by step, and has no CLAUDE.md or Codex steps", async () => {
  const { win } = app();
  await expect(win.locator('[data-section="claude-md"]')).toHaveCount(0);
  await expect(win.locator('[data-section="codex-hooks"]')).toHaveCount(0);
  const sec = win.locator('[data-section="no-host"]');
  await expect(sec.locator("h3")).toHaveText("Add Claude Code or Codex");
  const steps = sec.locator("li");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveText("Open Terminal (in Applications ▸ Utilities).");
  await expect(steps.nth(2)).toHaveText(`Type ~/.local/bin/aos init --vault ${FX.vault} --host claude (or --host codex) and press Return. It keeps your files and adds the host.`);
  await win.screenshot({ path: test.info().outputPath("wizard-finish-nohost.png") });
});

test("an unticked PATH box writes nothing, and the Workbench opens on the welcome tour, a new install with no host too", async () => {
  const { win, errors } = app();
  await win.locator(".aos-setup-add-path").uncheck();
  await win.locator(".aos-setup-open").click();
  await win.waitForSelector(".aos-wb-railbtn", { timeout: 30_000 });
  expect(fs.existsSync(ZPROFILE)).toBe(false);
  // The wizard installed it (--host none included), so its first launch is the tour (tour C10), recorded with the vault.
  await expect(win.locator(".aos-tour-pop")).toHaveAttribute("data-step", "core.rail");
  await expect(win.locator(".aos-attach-modal")).toHaveCount(0);
  const rec = JSON.parse(fs.readFileSync(path.join(USER_DATA, "attach.json"), "utf8")) as { vaults: Record<string, { installedAt?: string }> };
  expect(rec.vaults[FX.vault]?.installedAt).toBeTruthy();
  await win.keyboard.press("Escape");
  await expect(win.locator(".aos-tour")).toHaveCount(0);
  expect(errors).toEqual([]);
});
