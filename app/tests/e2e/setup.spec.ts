// Phase 5: the first-run wizard, end to end on stand-ins (harness installSetupStubs). With no agenticos.json the app
// shows the wizard; it checks what `aos init` needs on the PATH main resolves ($AOS_SETUP_PATH here), runs a fix-it's
// fixed command in its terminal (Ollama's models are a warning with their own fix), asks for hosts, folder and the
// Chief of Staff, runs the payload's `aos init` with those answers, shows the CLAUDE.md line as a diff and adds it only
// when asked, then attaches the vault and draws the Workbench without a relaunch, where the welcome tour starts (a new
// install never sees the "What changed" note, whose copy is about moving off Obsidian: tour C10).

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, SETUP, USER_DATA, aosCalls, installSetupStubs, useApp } from "./harness";

const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const AGENTICOS = path.join(FX.claude, "agenticos.json");
const CLAUDE_MD = path.join(FX.claude, "CLAUDE.md");
const LINE = `@${path.join(FX.vault, "AGENTICOS.md")}`;

const app = useApp({
  ready: ".aos-setup",
  noted: false,
  // No install: agenticos.json is gone (restored for the next spec file), and the app carries the stand-in payload.
  prepare: () => {
    installSetupStubs(VERSION);
    fs.rmSync(AGENTICOS, { force: true });
    fs.rmSync(CLAUDE_MD, { force: true });
    fs.writeFileSync(CLAUDE_MD, "# My Claude notes\n\nPrefer small diffs.");
  },
  env: { AOS_APP_VAULT: undefined, AOS_APP_PAYLOAD: SETUP.payload, AOS_SETUP_PATH: SETUP.bin },
});

test.describe.configure({ mode: "serial" });

const row = (id: string) => app().win.locator(`.aos-setup-check[data-check="${id}"]`);
const log = () => app().win.evaluate(() => (window as unknown as { aosSetup: { log(): string } }).aosSetup.log());

test("with no install, the wizard checks what aos init needs, on the login PATH", async () => {
  const { win } = app();
  await expect(win.locator(".aos-setup h1")).toHaveText("Set up UniDeX");
  await expect(win.locator(".aos-setup-sub")).toContainText(`runtime ${VERSION}`);
  await expect(row("uv")).toHaveClass(/is-missing/);
  for (const id of ["homebrew", "node", "claude", "claude-login", "codex", "ollama", "python"]) await expect(row(id)).toHaveClass(/is-ok/);
  await expect(row("node").locator(".aos-setup-detail")).toContainText(path.join(SETUP.bin, "node"));
  // Codex is installed but not logged in: a Log in fix; Claude Code is ready, so Codex is not required.
  await expect(row("codex-login")).toHaveClass(/is-missing/);
  await expect(row("codex-login").locator(".aos-setup-fix")).toHaveText("Log in");
  // Ollama answers without its models: a warning with a fix, never a requirement.
  await expect(row("ollama-models")).toHaveClass(/is-warn/);
  await expect(row("ollama-models").locator(".aos-setup-detail")).toHaveText("not downloaded: qwen3.5:9b, qwen3-embedding:0.6b");
  await expect(row("ollama-models").locator(".aos-setup-fix")).toHaveText("Download the models");
  // uv is required: Continue waits for it.
  await expect(win.locator(".aos-setup-next")).toBeDisabled();
  await expect(row("uv").locator(".aos-setup-fix")).toHaveAttribute("title", "Runs: brew install uv");
  await win.screenshot({ path: test.info().outputPath("wizard-check.png") });
});

test("a fix-it runs its fixed command in the wizard's terminal, then the checks run again", async () => {
  const { win } = app();
  await row("uv").locator(".aos-setup-fix").click();
  await expect.poll(log).toContain("$ brew install uv");
  await expect.poll(log).toContain("uv 0.9.0 installed");
  await expect(row("uv")).toHaveClass(/is-ok/, { timeout: 15_000 });
  await expect(row("uv").locator(".aos-setup-detail")).toHaveText(path.join(SETUP.bin, "uv"));
  await expect(win.locator(".aos-setup-next")).toBeEnabled();
  await win.screenshot({ path: test.info().outputPath("wizard-fixed.png") });
});

test("Ollama's missing models do not hold up Continue, and their fix pulls them in the terminal", async () => {
  const { win } = app();
  await expect(row("ollama-models")).toHaveClass(/is-warn/);
  await expect(win.locator(".aos-setup-next")).toBeEnabled();
  await row("ollama-models").locator(".aos-setup-fix").click();
  await expect.poll(log).toContain("$ if ! curl -q --noproxy 127.0.0.1 -fs -m 2 -o /dev/null http://127.0.0.1:11434/api/tags");
  await expect.poll(log).toContain("Downloading qwen3.5:9b...");
  await expect.poll(log).toContain("pulling qwen3-embedding:0.6b: 100%");
  await expect(row("ollama-models")).toHaveClass(/is-ok/, { timeout: 15_000 });
  await expect(row("ollama-models").locator(".aos-setup-detail")).toHaveText("qwen3.5:9b · qwen3-embedding:0.6b");
  expect(fs.readFileSync(SETUP.models, "utf8")).toBe("qwen3.5:9b\nqwen3-embedding:0.6b\n");
});

test("hosts offer only what is ready; the folder is typed or picked", async () => {
  const { win } = app();
  await win.locator(".aos-setup-next").click();
  await expect(win.locator('.aos-setup-body[data-step="choose"]')).toBeVisible();
  await expect(win.locator('input[name="aos-host"][value="claude"]')).toBeChecked();
  await expect(win.locator('input[name="aos-host"][value="codex"]')).toBeDisabled();
  await expect(win.locator('input[name="aos-host"][value="both"]')).toBeDisabled();
  const input = win.locator(".aos-setup-vault-input");
  await expect(input).toHaveValue(path.join(FX.home, "AgenticOS"));
  await input.fill(FX.vault);
  await win.locator(".aos-setup-next").click();
  await expect(win.locator('.aos-setup-body[data-step="persona"]')).toBeVisible();
});

test("the persona form checks the name the way the interview does", async () => {
  const { win } = app();
  const install = win.locator(".aos-setup-install");
  await expect(install).toBeDisabled();
  await win.locator('[data-field="name"]').fill("x");
  await expect(win.locator(".aos-setup-form .aos-setup-error")).toContainText("2 to 40 characters");
  await expect(install).toBeDisabled();
  await win.locator('[data-field="name"]').fill("Halyard");
  await expect(install).toBeEnabled();
  await win.locator('[data-field="addressAs"]').fill("Captain");
  await win.locator('[data-field="priorities"]').fill("tide tables, harbour chart");
  // Claude Code only: the Codex model is not asked.
  await expect(win.locator('[data-field="dutyCodexModel"]')).toHaveCount(0);
  await win.locator('[data-field="schedule"]').uncheck();
  await win.screenshot({ path: test.info().outputPath("wizard-persona.png") });
});

test("Install runs the payload's aos init with the user's answers, unattended", async () => {
  const { win } = app();
  await win.locator(".aos-setup-install").click();
  await expect(win.locator('.aos-setup-body[data-step="finish"]')).toBeVisible({ timeout: 20_000 });
  const calls = aosCalls();
  expect(calls).toHaveLength(1);
  const [init] = calls;
  expect(init.argv.slice(0, 6)).toEqual(["init", "--yes", "--vault", FX.vault, "--host", "claude"]);
  expect(init.argv[6]).toBe("--persona-json");
  expect(init.persona).toEqual({ name: "Halyard", addressAs: "Captain", voice: "", priorities: ["tide tables", "harbour chart"], dutyEffort: "medium", schedule: false });
  // The answers file lived only while aos init ran.
  expect(fs.existsSync(init.argv[7])).toBe(false);
  expect(path.dirname(init.argv[7])).toBe(path.join(USER_DATA, "setup"));
  expect(await log()).toContain("aos init --yes --vault");
});

test("the CLAUDE.md line is shown as a diff and added only when asked", async () => {
  const { win } = app();
  const diff = win.locator(".aos-setup-diff");
  await expect(diff.locator(".aos-setup-diff-path")).toHaveText(CLAUDE_MD);
  await expect(diff.locator(".aos-setup-diff-line.is-context")).toHaveText(["  # My Claude notes", "  ", "  Prefer small diffs."]);
  await expect(diff.locator(".aos-setup-diff-line.is-add")).toHaveText(`+ ${LINE}`);
  expect(fs.readFileSync(CLAUDE_MD, "utf8")).not.toContain(LINE);
  await win.screenshot({ path: test.info().outputPath("wizard-finish.png") });
  await win.locator(".aos-setup-add-line").click();
  await expect(win.locator(".aos-setup-ok")).toHaveText("✓ The line is in your CLAUDE.md.");
  expect(fs.readFileSync(CLAUDE_MD, "utf8")).toBe(`# My Claude notes\n\nPrefer small diffs.\n${LINE}\n`);
});

test("Open the Workbench attaches the vault without a relaunch, and the welcome tour starts instead of the note", async () => {
  const { app: electronApp, win, errors } = app();
  const pid = await electronApp.evaluate(() => process.pid);
  await win.locator(".aos-setup-open").click();
  await win.waitForSelector(".aos-wb-railbtn", { timeout: 30_000 });
  expect(await electronApp.evaluate(() => process.pid)).toBe(pid);
  expect(await electronApp.evaluate(() => (globalThis as unknown as { __aosMain: { vaultRoot(): string | null } }).__aosMain.vaultRoot())).toBe(FX.vault);
  // D11: the app recorded itself in the vault it attached.
  expect(JSON.parse(fs.readFileSync(FX.v("brain/_index/hud-host.json"), "utf8"))).toMatchObject({ host: "app", version: VERSION });
  // The wizard installed this vault, so the first-launch UI is the welcome tour (attach.ts firstLaunch), on its first
  // step, and the vault is recorded as noted at once: the next launch shows neither.
  await expect(win.locator(".aos-tour-pop")).toHaveAttribute("data-step", "core.rail");
  await expect(win.locator(".aos-attach-modal")).toHaveCount(0);
  const rec = () => JSON.parse(fs.readFileSync(path.join(USER_DATA, "attach.json"), "utf8")) as { vaults: Record<string, { notedAt?: string; installedAt?: string }> };
  await expect.poll(() => rec().vaults[FX.vault]?.notedAt).toBeTruthy();
  expect(rec().vaults[FX.vault]?.installedAt).toBeTruthy();
  await win.keyboard.press("Escape");
  await expect(win.locator(".aos-tour")).toHaveCount(0);
  expect(errors).toEqual([]);
});
