// Phase 5 and install-import B1, B13, B14: the first-run wizard, end to end on stand-ins (harness installSetupStubs).
// With no agenticos.json the app shows the wizard; it checks what `aos init` needs on the PATH main resolves
// ($AOS_SETUP_PATH here), with no Homebrew and no Python anywhere. A missing tool is a download main runs itself, from a
// development manifest served on 127.0.0.1 ($AOS_TOOLCHAIN_MANIFEST): a download that does not match its pin is deleted
// and offers Retry, and "Install what's missing" runs uv, then Ollama's models through its /api/pull, with progress. Then
// hosts, folder and the Chief of Staff, the payload's `aos init` with those answers, the CLAUDE.md line as a diff added
// only when asked, the PATH line shown and appended when its box is ticked, and the Workbench without a relaunch, where
// the welcome tour starts (a new install never sees the "What changed" note, whose copy is about moving off Obsidian:
// tour C10). Between the install and Finish, "Bring in your history" (install-import B9, B13) shows what Claude Code
// left on this Mac per kind, all ticked, with the proposed workspace ticked; Import runs `aos import` with the choices
// and progress, Finish says the digest is queued, and Pulse follows it in the Workbench.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, SETUP, SETUP_TOTALMEM, USER_DATA, aosCalls, installSetupStubs, toolchainServer, useApp, writeToolchainManifest, type ToolchainServer } from "./harness";

const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const PINNED = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "src", "main", "setup", "toolchain-manifest.json"), "utf8")) as { tools: Record<string, { version: string }> };
const AGENTICOS = path.join(FX.claude, "agenticos.json");
const CLAUDE_MD = path.join(FX.claude, "CLAUDE.md");
const ZPROFILE = path.join(FX.home, ".zprofile");
const LINE = `@${path.join(FX.vault, "AGENTICOS.md")}`;
const DOWNLOADS = path.join(USER_DATA, "setup", "downloads");

const SCAN = {
  schema: 1, dryRun: true, since: "90d", windowDays: 90, from: ["claude", "codex"], only: ["instructions", "memories", "projects", "mcp", "sessions"],
  engine: { ready: false, provider: "none", model: null, reason: "local-model-missing" },
  hosts: {
    claude: { present: true, configDir: "~/.claude", instructions: { files: 1, rules: 5, new: 5 }, memories: { files: 3, new: 3 }, mcp: { servers: 2 }, sessions: 4 },
    codex: { present: false, configDir: "~/.codex" },
  },
  projects: { proposals: [{ id: "~/code/harbor-map", repo: "~/code/harbor-map", action: "new", slug: "harbor-map", name: "harbor-map", claude: 4, codex: 0, sessions: 4, reason: "4 sessions in the window" }] },
};

// The toolchain server starts before the app (this beforeAll is registered before useApp's), so the manifest the app
// reads names its port.
let server: ToolchainServer;
test.beforeAll(async () => { server = await toolchainServer(); });
test.afterAll(async () => { await server?.close(); });

const app = useApp({
  ready: ".aos-setup",
  noted: false,
  // No install: agenticos.json is gone (restored for the next spec file), and the app carries the stand-in payload.
  prepare: () => {
    installSetupStubs(VERSION);
    writeToolchainManifest(server.port);
    fs.rmSync(AGENTICOS, { force: true });
    fs.rmSync(CLAUDE_MD, { force: true });
    fs.rmSync(ZPROFILE, { force: true });
    fs.writeFileSync(CLAUDE_MD, "# My Claude notes\n\nPrefer small diffs.");
    // What `aos import --dry-run --json` finds: Claude Code's history, Codex's folder absent, one proposed workspace.
    fs.writeFileSync(SETUP.importScan, JSON.stringify(SCAN));
  },
  env: { AOS_APP_VAULT: undefined, AOS_APP_PAYLOAD: SETUP.payload, AOS_SETUP_PATH: SETUP.bin, AOS_TOOLCHAIN_MANIFEST: SETUP.manifest, AOS_TOTALMEM: SETUP_TOTALMEM },
});

test.describe.configure({ mode: "serial" });

const row = (id: string) => app().win.locator(`.aos-setup-check[data-check="${id}"]`);
const log = () => app().win.evaluate(() => (window as unknown as { aosSetup: { log(): string } }).aosSetup.log());
/** Every progress event the page received since `recordProgress`. */
const progress = () => app().win.evaluate(() => (window as unknown as { aosProgress: Array<{ label: string; received: number; total: number | null }> }).aosProgress);
const recordProgress = () => app().win.evaluate(() => {
  const w = window as unknown as { aosProgress: unknown[]; aos: { setup: { onEvent(cb: (e: { type: string }) => void): void } } };
  w.aosProgress = [];
  w.aos.setup.onEvent((e) => { if (e.type === "progress") w.aosProgress.push(e); });
});

test("with no install, the wizard checks what aos init needs, on the login PATH, with no Homebrew or Python", async () => {
  const { win } = app();
  await expect(win.locator(".aos-setup h1")).toHaveText("Set up UniDeX");
  await expect(win.locator(".aos-setup-sub")).toContainText(`runtime ${VERSION}`);
  await expect(row("uv")).toHaveClass(/is-missing/);
  await expect(win.locator(".aos-setup-check")).toHaveCount(8);
  for (const id of ["homebrew", "python"]) await expect(row(id)).toHaveCount(0);
  for (const id of ["node", "claude", "claude-login", "codex", "ollama"]) await expect(row(id)).toHaveClass(/is-ok/);
  await expect(row("node").locator(".aos-setup-detail")).toContainText(path.join(SETUP.bin, "node"));
  await expect(row("ollama").locator(".aos-setup-detail")).toHaveText(`0.40.4 · ${path.join(SETUP.bin, "ollama")}`);
  // Codex is installed but not logged in: a Log in fix in a terminal; Claude Code is ready, and a host is optional anyway.
  await expect(row("codex-login")).toHaveClass(/is-missing/);
  await expect(row("codex-login").locator(".aos-setup-fix")).toHaveText("Log in");
  await expect(row("codex-login").locator(".aos-setup-fix")).toHaveAttribute("title", "Runs: codex login");
  // Ollama answers without its models: a warning with a download, never a requirement (a 16 GB Mac: the 9b).
  await expect(row("ollama-models")).toHaveClass(/is-warn/);
  await expect(row("ollama-models").locator(".aos-setup-detail")).toHaveText("not downloaded: qwen3.5:9b, qwen3-embedding:0.6b");
  await expect(row("ollama-models").locator(".aos-setup-fix")).toHaveText("Download the models");
  // uv is required: Continue waits for it. Its button says what it downloads and from where, before anything runs.
  await expect(win.locator(".aos-setup-next")).toBeDisabled();
  await expect(row("uv").locator(".aos-setup-fix")).toHaveText("Install uv");
  await expect(row("uv").locator(".aos-setup-fix")).toHaveAttribute("title", new RegExp(`^Downloads uv ${PINNED.tools.uv.version.replace(/\./g, "\\.")} from 127\\.0\\.0\\.1:\\d+ \\(1 MB\\) and checks its SHA-256 and its signature, then unpacks it into ~/\\.local/share/unidex/uv/${PINNED.tools.uv.version.replace(/\./g, "\\.")} and links uv and uvx from ~/\\.local/bin$`));
  await expect(win.locator(".aos-setup-install-missing")).toHaveText("Install what's missing");
  expect(server.served).toEqual([]);
  await win.screenshot({ path: test.info().outputPath("wizard-check.png") });
});

test("a download that does not match its pinned checksum is deleted, nothing is installed, and its button offers Retry", async () => {
  const { win } = app();
  server.corruptNext.add("uv");
  await row("uv").locator(".aos-setup-fix").click();
  await expect.poll(log).toContain("# Install uv: Downloads uv");
  await expect.poll(log).toMatch(/uv \d+\.\d+\.\d+ did not match its pinned checksum .*The download was deleted: Retry fetches it again\./);
  await expect(row("uv").locator(".aos-setup-fix")).toHaveText("Retry", { timeout: 15_000 });
  await expect(row("uv")).toHaveClass(/is-missing/);
  expect(fs.readdirSync(DOWNLOADS)).toEqual([]);
  expect(fs.existsSync(path.join(FX.home, ".local", "bin", "uv"))).toBe(false);
  expect(server.served).toEqual(["uv"]);
  await expect(win.locator(".aos-setup-next")).toBeDisabled();
});

test("Install what's missing downloads uv, checks it and installs it, then pulls Ollama's models through its API, with progress", async () => {
  const { win } = app();
  await recordProgress();
  await win.locator(".aos-setup-install-missing").click();
  await expect(row("uv")).toHaveClass(/is-ok/, { timeout: 20_000 });
  await expect(row("uv").locator(".aos-setup-detail")).toHaveText(`uv ${PINNED.tools.uv.version} · ${path.join(FX.home, ".local", "bin", "uv")}`);
  await expect(row("ollama-models")).toHaveClass(/is-ok/, { timeout: 20_000 });
  await expect(row("ollama-models").locator(".aos-setup-detail")).toHaveText("qwen3.5:9b · qwen3-embedding:0.6b");
  const text = await log();
  expect(text).toMatch(/Checked: SHA-256 [0-9a-f]{64} is the pinned one\./);
  expect(text).toContain("uv: no signature to check (a development manifest).");
  expect(text).toContain(`uv ${PINNED.tools.uv.version} is in ~/.local/share/unidex/uv/${PINNED.tools.uv.version}, linked from ~/.local/bin.`);
  expect(text).toContain("Downloading qwen3.5:9b…");
  expect(text).toContain("  pulling manifest");
  expect(text).toContain("Ollama has qwen3.5:9b and qwen3-embedding:0.6b.");
  expect(fs.readFileSync(SETUP.models, "utf8")).toBe("qwen3.5:9b\nqwen3-embedding:0.6b\n");
  expect(fs.readdirSync(path.join(FX.home, ".local", "bin"))).toEqual(expect.arrayContaining(["uv", "uvx"]));
  expect(fs.readdirSync(path.join(FX.home, ".local", "share", "unidex", "uv"))).toEqual([PINNED.tools.uv.version]);
  expect(fs.lstatSync(path.join(FX.home, ".local", "bin", "uv")).isSymbolicLink()).toBe(true);
  expect(fs.readdirSync(DOWNLOADS)).toEqual([]);
  const seen = await progress();
  const uvSize = fs.statSync(path.join(SETUP.archives, "uv")).size;
  expect(seen.some((p) => p.label === `Downloading uv ${PINNED.tools.uv.version}` && p.received === uvSize && p.total === uvSize)).toBe(true);
  expect(seen.some((p) => p.label === "Downloading qwen3.5:9b" && p.received === 2000 && p.total === 2000)).toBe(true);
  await expect(win.locator(".aos-setup-install-missing")).toHaveCount(0);
  await expect(win.locator(".aos-setup-next")).toBeEnabled();
  await win.screenshot({ path: test.info().outputPath("wizard-fixed.png") });
});

test("hosts offer what is ready, and No agent CLI yet always; the ready host is the default; the folder is typed or picked", async () => {
  const { win } = app();
  await win.locator(".aos-setup-next").click();
  await expect(win.locator('.aos-setup-body[data-step="choose"]')).toBeVisible();
  await expect(win.locator('input[name="aos-host"][value="claude"]')).toBeChecked();
  await expect(win.locator('input[name="aos-host"][value="codex"]')).toBeDisabled();
  await expect(win.locator('input[name="aos-host"][value="both"]')).toBeDisabled();
  await expect(win.locator('input[name="aos-host"][value="none"]')).toBeEnabled();
  await expect(win.locator('input[name="aos-host"][value="none"]')).not.toBeChecked();
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
  // Claude Code only: the Codex model is not asked; the Chief of Staff's hosted model is preselected (local-first A4).
  await expect(win.locator('[data-field="dutyCodexModel"]')).toHaveCount(0);
  await expect(win.locator('[data-field="dutyModel"]')).toHaveValue("claude-opus-5-5");
  await expect(win.locator('[data-field="chief"]')).toHaveText("Duties run on Claude Code · claude-opus-5-5, a hosted model. The hourly check runs on this Mac's local model and wakes it only when something changed.");
  await win.locator('[data-field="schedule"]').uncheck();
  await win.screenshot({ path: test.info().outputPath("wizard-persona.png") });
});

test("Install runs the payload's aos init with the user's answers, unattended", async () => {
  const { win } = app();
  await win.locator(".aos-setup-install").click();
  await expect(win.locator('.aos-setup-body[data-step="history"] table.aos-setup-import')).toBeVisible({ timeout: 20_000 });
  const calls = aosCalls();
  // aos init, then the import's dry run (install-import B13), which writes nothing.
  expect(calls.map((c) => c.argv.slice(0, 2))).toEqual([["init", "--yes"], ["import", "--from"]]);
  expect(calls[1].argv).toEqual(["import", "--from", "all", "--dry-run", "--json"]);
  const [init] = calls;
  expect(init.argv.slice(0, 6)).toEqual(["init", "--yes", "--vault", FX.vault, "--host", "claude"]);
  expect(init.argv[6]).toBe("--persona-json");
  expect(init.persona).toEqual({ name: "Halyard", addressAs: "Captain", voice: "", priorities: ["tide tables", "harbour chart"], dutyModel: "claude-opus-5-5", dutyEffort: "medium", schedule: false });
  // Inspection M1: aos init installs graphify with the uv the checks validated (the one the wizard installed here).
  expect(init.uvBin).toBe(path.join(FX.home, ".local", "bin", "uv"));
  // The answers file lived only while aos init ran.
  expect(fs.existsSync(init.argv[7])).toBe(false);
  expect(path.dirname(init.argv[7])).toBe(path.join(USER_DATA, "setup"));
  expect(await log()).toContain("aos init --yes --vault");
});

test("Bring in your history: Claude Code's counts per kind, all ticked, the proposed workspace ticked; Import runs with the choices", async () => {
  const { win } = app();
  const body = win.locator('.aos-setup-body[data-step="history"]');
  await expect(win.locator('.aos-setup-step[data-step="history"]')).toHaveText("5 Your history");
  await expect(body.locator('[data-hint="engine"]')).toHaveText("The local model is not ready yet: each instruction file comes in as one note, and the sessions wait for it. Nothing leaves this Mac.");
  // Codex left nothing here: Claude Code's row only, a column per kind it has.
  await expect(body.locator("tr[data-host]")).toHaveCount(1);
  const row = body.locator('tr[data-host="claude"]');
  await expect(row.locator("th")).toContainText("Claude Code");
  await expect(row.locator("td")).toHaveText(["5 rules", "3 memories", "2 servers", "4 sessions"]);
  for (const sel of ['input[data-host="claude"]', 'input[data-kind="instructions"]', 'input[data-kind="memories"]', 'input[data-kind="mcp"]', 'input[data-kind="sessions"]', 'input[data-proposal="~/code/harbor-map"]']) {
    await expect(body.locator(sel)).toBeChecked();
  }
  await expect(body.locator(".aos-setup-proposal")).toHaveText("workspaces/harbor-map · ~/code/harbor-map · 4 sessions in the window");
  await win.screenshot({ path: test.info().outputPath("wizard-history.png") });
  // Leave the memories out; the rest comes in, the workspace created.
  await body.locator('input[data-kind="memories"]').uncheck();
  await body.locator(".aos-setup-import-run").click();
  await expect(win.locator('.aos-setup-body[data-step="finish"]')).toBeVisible({ timeout: 20_000 });
  expect(aosCalls().at(-1)?.argv).toEqual(["import", "--from", "claude", "--only", "instructions,projects,mcp,sessions", "--accept", '["~/code/harbor-map"]']);
  const text = await log();
  expect(text).toContain("- instructions (Claude Code): 5 written, 0 already in the vault");
  expect(text).toContain("- sessions: 4 queued for the digest");
  const sec = win.locator('[data-section="history"]');
  await expect(sec.locator("h3")).toHaveText("Your history is coming in");
  await expect(sec.locator(".aos-setup-hint")).toHaveText("Its instructions and memories wait in Brain ▸ Review for you to keep. 4 sessions are queued: the import-digest routine summarises them on the local model every 30 minutes, and Pulse shows how far it got.");
});

test("Finish lists what is left: the CLAUDE.md line as a diff, added only when asked, and no Codex or no-host steps", async () => {
  const { win } = app();
  const diff = win.locator('[data-section="claude-md"] .aos-setup-diff');
  await expect(diff.locator(".aos-setup-diff-path")).toHaveText(CLAUDE_MD);
  await expect(diff.locator(".aos-setup-diff-line.is-context")).toHaveText(["  # My Claude notes", "  ", "  Prefer small diffs."]);
  await expect(diff.locator(".aos-setup-diff-line.is-add")).toHaveText(`+ ${LINE}`);
  expect(fs.readFileSync(CLAUDE_MD, "utf8")).not.toContain(LINE);
  for (const key of ["codex-hooks", "no-host", "persona", "ollama", "ollama-models"]) await expect(win.locator(`[data-section="${key}"]`)).toHaveCount(0);
  await win.screenshot({ path: test.info().outputPath("wizard-finish.png") });
  await win.locator(".aos-setup-add-line").click();
  await expect(win.locator('[data-section="claude-md"] .aos-setup-ok')).toHaveText("✓ The line is in your CLAUDE.md.");
  expect(fs.readFileSync(CLAUDE_MD, "utf8")).toBe(`# My Claude notes\n\nPrefer small diffs.\n${LINE}\n`);
});

test("install-import B14: the PATH line is shown before anything is written, with its box ticked", async () => {
  const { win } = app();
  const sec = win.locator('[data-section="path"]');
  await expect(sec.locator(".aos-setup-diff-path")).toHaveText(ZPROFILE);
  await expect(sec.locator(".aos-setup-diff-line.is-add")).toHaveText('+ export PATH="$HOME/.local/bin:$PATH"');
  await expect(sec.locator(".aos-setup-add-path")).toBeChecked();
  expect(fs.existsSync(ZPROFILE)).toBe(false);
});

test("Open the Workbench appends the PATH line, attaches the vault without a relaunch, and the welcome tour starts instead of the note", async () => {
  const { app: electronApp, win, errors } = app();
  const pid = await electronApp.evaluate(() => process.pid);
  await win.locator(".aos-setup-open").click();
  await win.waitForSelector(".aos-wb-railbtn", { timeout: 30_000 });
  expect(fs.readFileSync(ZPROFILE, "utf8")).toBe('export PATH="$HOME/.local/bin:$PATH"\n');
  expect(await electronApp.evaluate(() => process.pid)).toBe(pid);
  expect(await electronApp.evaluate(() => (globalThis as unknown as { __aosMain: { vaultRoot(): string | null } }).__aosMain.vaultRoot())).toBe(FX.vault);
  // D11: the app recorded itself in the vault it attached.
  expect(JSON.parse(fs.readFileSync(FX.v("brain/_index/hud-host.json"), "utf8"))).toMatchObject({ host: "app", version: VERSION });
  // The wizard installed this vault, so the first-launch UI is the welcome tour (ui/launchSequence.ts), on its first
  // step, and the vault is recorded as noted at once: the next launch shows neither.
  await expect(win.locator(".aos-tour-pop")).toHaveAttribute("data-step", "core.rail");
  await expect(win.locator(".aos-attach-modal")).toHaveCount(0);
  // The history the wizard queued: Pulse follows the digest until it is done (install-import B10).
  await expect(win.locator('.aos-pulse-import[data-row="import-digest"]')).toHaveText("Digesting history: 0 of 4 sessions");
  const rec = () => JSON.parse(fs.readFileSync(path.join(USER_DATA, "attach.json"), "utf8")) as { vaults: Record<string, { notedAt?: string; installedAt?: string }> };
  await expect.poll(() => rec().vaults[FX.vault]?.notedAt).toBeTruthy();
  expect(rec().vaults[FX.vault]?.installedAt).toBeTruthy();
  await win.keyboard.press("Escape");
  await expect(win.locator(".aos-tour")).toHaveCount(0);
  expect(errors).toEqual([]);
});
