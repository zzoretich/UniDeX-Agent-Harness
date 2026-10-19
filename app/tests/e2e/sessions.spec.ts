// Sessions (spec 2026-10-07-unidex-sessions S10, §4.5, §6; spec 2026-10-07-sessions-ux U1–U12), the Chat tab's place on
// the rail, with their surface on (AOS_APP_WRITE=sessions). Main runs every turn through the vault's own runtime
// (lib/sessions.js args, events, catalog, record), so the plan, the events, the host catalog, the cap and the run record
// are the real ones; only the host CLIs are stand-ins: `claude` prints a stream-json turn and `codex` an `exec --json`
// one, each recording its argv and folder, and a prompt with "[sleep]" in it waits instead, for Stop. They also answer
// the catalog's questions as the real CLIs do (claude's `initialize` control request and --version; codex's `debug
// models`, `debug prompt-input` and --version) from small synthetic lists, logged apart from the turns. Their paths are
// the vault config's hosts.<host>.bin, where the runtime looks first. The repository card runs the user's git on
// repositories the test makes in workspaces/.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ACCESS_LEVELS, CODEX_ACCESS_NOTE, accessHostLine } from "../../../hud/src/data/agentSessions";
import { FX, USER_DATA, content, expectNoErrors, openTab, providerState, rail, useApp } from "./harness";

// ── the host stand-ins ───────────────────────────────────────────────

const STUBS = path.join(FX.root, "session-stubs");
const BIN = { claude: path.join(STUBS, "claude"), codex: path.join(STUBS, "codex") };
type Host = keyof typeof BIN;
type Access = "read" | "edit" | "run";
interface Call { argv: string[]; cwd: string }
const jsonl = (file: string): Call[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : []);
/** The host's turns. */
const calls = (host: Host): Call[] => jsonl(path.join(STUBS, `${host}-calls.jsonl`));
/** The catalog's questions to the host (--version, claude's initialize, codex's debug commands). */
const catalogCalls = (host: Host): Call[] => jsonl(path.join(STUBS, `${host}-catalog.jsonl`));
/** Files whose presence changes a stand-in's catalog answer: claude fails its initialize, codex lists no skills. */
const FLAG = { claudeFails: path.join(STUBS, "claude-catalog-fail"), codexNoSkills: path.join(STUBS, "codex-no-skills") };

/** What the claude stand-in's turn costs and what it writes in its folder (a new file the repository card shows). */
const CLAUDE_TURN = { usd: 0.0213, footer: "$0.02 · 1,200 in · 45 out", note: "Tide notes from the agent." };

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Claude's initialize answer: its aliases are the current models, a full id an older one; four commands. The account
 *  block is there because Claude Code sends one, and the runtime must drop it (U5). */
const CLAUDE_CATALOG = {
  models: [
    { value: "default", displayName: "Default (recommended)", description: "The model Claude Code picks", supportedEffortLevels: CLAUDE_EFFORTS },
    { value: "opus", displayName: "Opus", description: "For the hardest work", supportedEffortLevels: CLAUDE_EFFORTS },
    { value: "sonnet", displayName: "Sonnet", description: "For everyday work", supportedEffortLevels: ["low", "medium", "high"] },
    { value: "haiku", displayName: "Haiku", description: "The quickest", supportedEffortLevels: [] },
    { value: "claude-tide-7-20990101", displayName: "Tide 7", description: "An older model", supportedEffortLevels: ["low", "medium", "high"] },
  ],
  commands: [
    { name: "review", description: "Review the open changes", argumentHint: "[path]" },
    { name: "agenticos:standup", description: "Did, doing and blockers", argumentHint: "" },
    { name: "tide-report", description: "Write the tide report", argumentHint: "<day>" },
    { name: "compact", description: "Compact the conversation", argumentHint: "" },
  ],
  // Built here, so no address sits in the source.
  account: { email: ["someone", "example.invalid"].join("@") },
};
const levels = (l: string[]) => l.map((effort) => ({ effort, description: `${effort} reasoning` }));
/** `codex debug models`: three current models by priority, one older, one hidden. */
const CODEX_MODELS = {
  models: [
    { slug: "gpt-tide-internal", display_name: "GPT-Tide Internal", description: "Not offered.", visibility: "hide", priority: 0, supported_reasoning_levels: levels(["low"]) },
    { slug: "gpt-tide-3", display_name: "GPT-Tide-3", description: "The newest tide model.", visibility: "list", priority: 1, supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max", "ultra"]) },
    { slug: "gpt-tide-3-mini", display_name: "GPT-Tide-3 Mini", description: "Smaller and quicker.", visibility: "list", priority: 2, supported_reasoning_levels: levels(["low", "medium", "high"]) },
    { slug: "gpt-tide-3-codex", display_name: "GPT-Tide-3 Codex", description: "Tuned for code.", visibility: "list", priority: 3, supported_reasoning_levels: levels(["low", "medium", "high", "xhigh"]) },
    { slug: "gpt-tide-2", display_name: "GPT-Tide-2", description: "The previous generation.", visibility: "list", priority: 4, supported_reasoning_levels: levels(["minimal", "low", "medium", "high"]) },
  ],
};
/** `codex debug prompt-input`: the developer message whose skills block names three skills. */
const CODEX_PROMPT = [{
  type: "message", role: "developer",
  content: [{
    type: "input_text",
    text: [
      "<skills_instructions>", "## Skills", "### Available skills",
      "- tide-check: Check the tide tables (file: r0/tide-check/SKILL.md)",
      "- agenticos:ask-brain: Ask the vault a question (file: r0/ask-brain/SKILL.md)",
      "- harbor-chart: Draw the harbour chart (file: r0/harbor-chart/SKILL.md)",
      "### How to use skills", "Name a skill as $name.", "</skills_instructions>",
    ].join("\n"),
  }],
}];

function installSessionStubs(): void {
  fs.rmSync(STUBS, { recursive: true, force: true });
  fs.mkdirSync(STUBS, { recursive: true });
  const node = path.join(FX.root, "bin", "node");
  const head = (host: Host, catalogCall: string) => `#!${node}
// fixture stub: never reaches the real ${host}. Records the call (the catalog's apart from the turns); a prompt with
// [sleep] in it waits to be stopped.
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
const catalogCall = ${catalogCall};
fs.appendFileSync(path.join(${JSON.stringify(STUBS)}, catalogCall ? "${host}-catalog.jsonl" : "${host}-calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const prompt = argv[argv.length - 1] || "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
`;
  fs.writeFileSync(BIN.claude, `${head("claude", 'argv[0] === "--version" || argv.includes("--input-format")')}if (argv[0] === "--version") process.stdout.write("2.1.293 (Claude Code)\\n");
else if (catalogCall) {
  // One initialize control request on stdin, one answer; then it waits, as Claude Code does, until the runtime ends it.
  if (fs.existsSync(${JSON.stringify(FLAG.claudeFails)})) { process.stderr.write("fixture: catalog unavailable\\n"); process.exit(1); }
  let buf = "", answered = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    if (answered || !buf.includes("\\n")) return;
    answered = true;
    const req = JSON.parse(buf.slice(0, buf.indexOf("\\n")));
    out({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response: ${JSON.stringify(CLAUDE_CATALOG)} } });
  });
  setInterval(() => {}, 1000);
} else {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  const id = at("--session-id") || at("--resume");
  out({ type: "system", subtype: "init", session_id: id });
  if (prompt.includes("[sleep]")) setTimeout(() => {}, 120000);
  else {
    fs.appendFileSync(path.join(process.cwd(), "notes.md"), ${JSON.stringify(`${CLAUDE_TURN.note}\n`)});
    out({ type: "assistant", session_id: id, message: { content: [
      { type: "text", text: "Fixed the **tide parser**." },
      { type: "tool_use", id: "t0", name: "TodoWrite", input: { todos: [
        { content: "Read the tide parser", status: "completed", activeForm: "Reading the tide parser" },
        { content: "Fix the parser", status: "in_progress", activeForm: "Fixing the parser" },
        { content: "Run the tests", status: "pending", activeForm: "Running the tests" },
      ] } },
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "notes.md", old_string: "", new_string: "Tide notes" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } },
    ] } });
    out({ type: "user", session_id: id, message: { content: [
      { type: "tool_result", tool_use_id: "t1", content: "The file notes.md has been updated." },
      { type: "tool_result", tool_use_id: "t2", content: "1 test failing", is_error: true },
    ] } });
    out({ type: "result", subtype: "success", is_error: false, session_id: id, total_cost_usd: ${CLAUDE_TURN.usd}, usage: { input_tokens: 1200, output_tokens: 45 } });
  }
}
`, { mode: 0o755 });
  fs.writeFileSync(BIN.codex, `${head("codex", 'argv[0] === "--version" || argv[0] === "debug"')}if (argv[0] === "--version") process.stdout.write("codex-cli 0.158.0\\n");
else if (argv[0] === "debug" && argv[1] === "models") out(${JSON.stringify(CODEX_MODELS)});
else if (argv[0] === "debug" && argv[1] === "prompt-input") out(fs.existsSync(${JSON.stringify(FLAG.codexNoSkills)}) ? [] : ${JSON.stringify(CODEX_PROMPT)});
else if (catalogCall) process.exit(2);
else {
  const resume = argv[1] === "resume";
  out({ type: "thread.started", thread_id: "codex-thread-1" });
  if (prompt.includes("[sleep]")) setTimeout(() => {}, 120000);
  else {
    out({ type: "item.started", item: { id: "p1", type: "todo_list", items: [{ text: "Chart the harbour", completed: false }, { text: "Cache the tiles", completed: false }] } });
    out({ type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", status: "in_progress" } });
    out({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "all green", exit_code: 0, status: "completed" } });
    out({ type: "item.updated", item: { id: "p1", type: "todo_list", items: [{ text: "Chart the harbour", completed: true }, { text: "Cache the tiles", completed: false }] } });
    out({ type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "src/tiles.js", kind: "update" }], status: "completed" } });
    out({ type: "item.completed", item: { id: "m1", type: "agent_message", text: resume ? "Codex cached the tiles." : "Codex charted the harbour." } });
    out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 80 } });
  }
}
`, { mode: 0o755 });
}

// ── the fixture ──────────────────────────────────────────────────────

const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};
const VAULT_CONFIG = FX.v("brain/config.json");
const REPO = FX.v("workspaces/tide-log");
/** git as the app's main runs it: the fixture's HOME, so no user or system setting (signing, hooks) applies. */
const gitEnv = { ...process.env, HOME: FX.home, GIT_CONFIG_NOSYSTEM: "1" };
const gitIn = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" }).trim();
const git = (...args: string[]) => gitIn(REPO, ...args);

/** A workspace that is a repository of its own, with one commit; an identity built here so no address sits in the source. */
function makeRepo(dir = REPO, readme = "# Tide log\n"): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), readme);
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "user.name", "Fixture");
  gitIn(dir, "config", "user.email", ["fixture", "example.invalid"].join("@"));
  gitIn(dir, "config", "commit.gpgsign", "false");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "Start the log");
}

/** The stand-ins as the hosts' binaries, the hosts switched on as asked, a provider on record (so the tab shows). */
function prepare(hosts: Record<Host, boolean>): void {
  installSessionStubs();
  editJson(path.join(FX.claude, "agenticos.json"), (j) => { j.hosts.claude.enabled = hosts.claude; j.hosts.codex.enabled = hosts.codex; });
  editJson(VAULT_CONFIG, (j) => {
    j.hosts = { ...(j.hosts ?? {}) };
    for (const h of ["claude", "codex"] as Host[]) j.hosts[h] = { ...(j.hosts[h] ?? {}), bin: BIN[h] };
  });
  providerState(hosts.claude ? "claude" : "codex", hosts);
  makeRepo();
}

// The fixture's environment hides both CLIs from the runtime (AOS_NO_CLAUDE, AOS_NO_CODEX); here they are the stand-ins.
const HOSTS_ON = { AOS_NO_CLAUDE: undefined, AOS_NO_CODEX: undefined };

// ── helpers ──────────────────────────────────────────────────────────

const list = (win: Page) => content(win).locator(".aos-ss-list");
const reader = (win: Page) => content(win).locator(".aos-ss-reader");
const group = (win: Page, workspace: string) => list(win).locator(`.aos-ss-group[data-workspace="${workspace}"]`);
/** The composer's host and model menu, its chip and its popover; the access menu; the prompt. */
const hm = (win: Page) => reader(win).locator(".aos-ss-toolbar .aos-hm");
const chip = (win: Page) => hm(win).locator(".aos-hm-trigger");
const pop = (win: Page) => hm(win).locator(".aos-hm-pop");
const access = (win: Page) => reader(win).locator(".aos-ss-toolbar .aos-am");
const input = (win: Page) => reader(win).locator("textarea.aos-ss-input");
/** An attribute of every element a locator matches, in order. */
const attrs = (loc: Locator, name: string) => loc.evaluateAll((els, n) => els.map((e) => e.getAttribute(n)), name);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A finished turn's line: Done, the model and effort it ran on, its length, then the stand-in's cost and tokens. */
const claudeDone = (choice: string) => new RegExp(`^Done · ${esc(choice)} · \\d+s · ${esc(CLAUDE_TURN.footer)}$`);
const codexDone = (choice: string) => new RegExp(`^Done · ${esc(choice)} · \\d+s · \\$0\\.\\d+ estimated · 1,200 in · 80 out$`);
const FAILED_DONE = /^Did not finish · (.+ · )?no cost recorded$/;
/** The value after `flag` in an argv. */
const argOf = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

async function openMenu(win: Page): Promise<void> {
  if ((await chip(win).getAttribute("aria-expanded")) !== "true") await chip(win).click();
  await expect(pop(win)).toBeVisible();
}

/** Escape in the popover closes it, and focus goes back to the chip. */
async function closeMenu(win: Page): Promise<void> {
  await pop(win).locator(".aos-hm-search").press("Escape");
  await expect(pop(win)).toHaveCount(0);
  await expect(chip(win)).toBeFocused();
}

/** Picks in the host and model menu: the host (a new session only), a model found by its id, an effort. */
async function choose(win: Page, o: { host?: Host; model?: string; effort?: string }): Promise<void> {
  await openMenu(win);
  const p = pop(win);
  if (o.host) {
    const b = p.locator(`.aos-hm-host[data-host="${o.host}"]`);
    await b.click();
    await expect(b).toHaveAttribute("aria-pressed", "true");
  }
  if (o.model) {
    await p.locator(".aos-hm-search").fill(o.model);
    const m = p.locator(`.aos-hm-model[data-model="${o.model}"]`);
    await m.click();
    await expect(m).toHaveAttribute("aria-selected", "true");
  }
  if (o.effort) {
    const e = p.locator(`.aos-hm-effort[data-effort="${o.effort}"]`);
    await e.click();
    await expect(e).toHaveAttribute("aria-pressed", "true");
  }
  await closeMenu(win);
}

/** Picks a level in the access menu. */
async function pickAccess(win: Page, level: Access): Promise<void> {
  await access(win).locator(".aos-am-trigger").click();
  await access(win).locator(`.aos-am-item[data-level="${level}"]`).click();
  await expect(access(win)).toHaveAttribute("data-access", level);
  await expect(access(win).locator(".aos-am-menu")).toHaveCount(0);
}

interface NewSession { workspace: string; host: Host; text: string; model?: string; effort?: string; access?: Access }

/** New session: the workspace, the host (and model and effort) in the host and model menu, the access level, the prompt. */
async function newSession(win: Page, o: NewSession): Promise<void> {
  await content(win).locator(".aos-ss-newbtn").click();
  await expect(reader(win).locator(".aos-ss-toptitle")).toHaveText("New session");
  await reader(win).locator("select.aos-ss-workspace").selectOption(o.workspace);
  await choose(win, { host: o.host, model: o.model, effort: o.effort });
  await expect(chip(win)).toHaveAttribute("data-host", o.host);
  await pickAccess(win, o.access ?? "edit");
  await input(win).fill(o.text);
  await reader(win).locator(".aos-ss-send").click();
}

/** A reply in the open thread (or the first prompt of a new session already set up). */
async function reply(win: Page, text: string): Promise<void> {
  await input(win).fill(text);
  await reader(win).locator(".aos-ss-send").click();
}

/** The open thread's id, once its row is selected in the list. */
const openId = async (win: Page) => (await list(win).locator(".aos-ss-row.is-selected").getAttribute("data-thread")) ?? "";

/** The HUD's saved settings: the app keeps the plugin's data.json as <userData>/plugins/agentic-os.json. */
const savedSettings = (): Record<string, any> => {
  try { return JSON.parse(fs.readFileSync(path.join(USER_DATA, "plugins", "agentic-os.json"), "utf8")) as Record<string, any>; } catch { return {}; }
};

/**
 * The open thread's turn still runs after a key that should only have closed a menu or the drawer: stop() turns Stop
 * into "Stopping…" and the working line into "Stopping…" at once, so a key that stopped the turn can never pass here.
 */
async function expectStillRunning(win: Page): Promise<void> {
  const r = reader(win);
  await expect(r.locator(".aos-ss-stop .aos-ss-stoplabel")).toHaveText("Stop");
  await expect(r.locator(".aos-ss-working")).toHaveText(/esc to stop\)$/);
  await expect(list(win).locator(".aos-ss-row.is-selected")).toHaveClass(/is-running/);
}

/** Review changes: the drawer over the conversation. */
async function openReview(win: Page): Promise<void> {
  const b = reader(win).locator(".aos-ss-reviewbtn");
  if ((await b.getAttribute("aria-expanded")) !== "true") await b.click();
  await expect(reader(win).locator("#aos-ss-drawer")).toHaveClass(/is-open/);
}

/** ↻ in the open menu, until the host was asked again and the button is back. */
async function refreshCatalog(win: Page, host: Host): Promise<void> {
  const before = catalogCalls(host).length;
  const b = pop(win).locator(".aos-hm-refresh");
  await expect(b).toHaveAttribute("aria-label", "Refresh the model list");
  await b.click();
  await expect.poll(() => catalogCalls(host).length, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(b).toBeEnabled({ timeout: 30_000 });
  await expect(b).not.toHaveClass(/is-busy/);
}

// ── both hosts, the surface on ───────────────────────────────────────

test.describe("both hosts, the Sessions surface on", () => {
  const app = useApp({ env: { AOS_APP_WRITE: "sessions", ...HOSTS_ON }, prepare: () => prepare({ claude: true, codex: true }) });

  test.beforeEach(async () => { await openTab(app().win, "chat"); });
  test.afterEach(async () => {
    expectNoErrors(app());
    // The cap test turns sessions off for the day; every other test runs with the defaults.
    editJson(VAULT_CONFIG, (j) => { delete j.sessions; });
  });

  test("the rail says Sessions and opens on Vault, today's chat as before; the status bar names the surface", async () => {
    const { win } = app();
    await expect(rail(win, "chat").locator(".aos-wb-raillabel")).toHaveText("Sessions");
    await expect(rail(win, "chat")).toHaveAttribute("aria-label", "Sessions");
    await expect(win.locator(".aos-host-status .aos-host-mode")).toHaveText("WRITES: Sessions");
    // No page title in the new layout (spec 2026-10-07-sessions-ux U1): the list is the tab's landmark, named Sessions.
    await expect(list(win)).toHaveAttribute("aria-label", "Sessions");
    await expect(content(win).locator(".aos-ss-newbtn")).toHaveText("New session");
    const first = list(win).locator(".aos-ss-row").first();
    await expect(first).toHaveAttribute("data-thread", "vault");
    await expect(first).toHaveClass(/is-selected/);
    await expect(reader(win).locator(".aos-asst-head .aos-title")).toHaveText("Vault");
    await expect(reader(win).locator("textarea.aos-asst-input")).toHaveAttribute("placeholder", "Ask about your notes…");
    await expect(list(win).locator(".aos-ss-note")).toHaveText("No workspace sessions yet. New session starts one.");
  });

  test("a Claude turn end to end: the prompt, the agent's text, tool lines that open to their result, the done line, the thread under its workspace", async () => {
    const { win } = app();
    const before = calls("claude").length;
    await newSession(win, { workspace: "harbor-map", host: "claude", text: "Fix the tide parser", model: "opus", effort: "high", access: "run" });
    const r = reader(win);
    await expect(r.locator(".aos-ss-done")).toHaveText([claudeDone("Opus · High")], { timeout: 30_000 });
    await expect(r.locator(".aos-ss-crumb-ws")).toHaveText("harbor-map");
    await expect(r.locator(".aos-ss-crumb-title")).toHaveText("Fix the tide parser");
    await expect(hm(win)).toHaveAttribute("data-mode", "thread");
    await expect(chip(win).locator(".aos-hm-chiphost")).toHaveText("Claude Code");
    await expect(r.locator(".aos-ss-bubble")).toHaveText(["Fix the tide parser"]);
    await expect(r.locator(".aos-ss-text")).toHaveText(["Fixed the tide parser."]);
    await expect(r.locator(".aos-ss-text strong")).toHaveText("tide parser");   // rendered as Markdown
    const tools = r.locator(".aos-ss-tool");
    await expect(tools.locator(".aos-ss-toolline")).toHaveText(["Update(notes.md)", "Bash(npm test)"]);
    await expect(tools.nth(0)).toHaveClass(/is-ok/);
    await expect(tools.nth(1)).toHaveClass(/is-failed/);
    await expect(tools.locator(".aos-ss-toolresult")).toHaveText(["Done", "1 test failing"]);
    await expect(tools.nth(1).locator(".aos-ss-toolout")).toHaveCount(0);
    await tools.nth(1).locator(".aos-ss-toolline").click();
    await expect(tools.nth(1)).toHaveClass(/is-open/);
    await expect(tools.nth(1).locator(".aos-ss-toolline")).toHaveAttribute("aria-expanded", "true");
    await expect(tools.nth(1).locator(".aos-ss-toolin")).toContainText("npm test");
    await expect(tools.nth(1).locator(".aos-ss-toolstate")).toHaveText("Failed");
    await expect(tools.nth(1).locator(".aos-ss-toolout")).toHaveText("1 test failing");
    await expect(r.locator(".aos-ss-stop")).toHaveCount(0);
    // harbor-map is a plain folder, so the review says there is nothing to review.
    await openReview(win);
    await expect(r.locator(".aos-ss-reposum")).toHaveText("workspaces/harbor-map is not a git repository, so there is nothing to review or commit");
    await r.locator(".aos-ss-drawerclose").click();
    await expect(r.locator("#aos-ss-drawer")).not.toHaveClass(/is-open/);

    const g = group(win, "harbor-map");
    const row = g.locator(".aos-ss-row");
    await expect(row).toHaveCount(1);
    await expect(g.locator(".aos-ss-title")).toHaveText("Fix the tide parser");
    await expect(row.locator(".aos-ss-hostdot.is-claude")).toHaveAttribute("aria-label", "Claude Code");
    await expect(row).toHaveAttribute("title", /^Claude Code · 1 turn · \$0\.02 · /);
    await expect(row).not.toHaveClass(/is-running/);

    const id = await openId(win);
    const [call] = calls("claude").slice(before);
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(FX.v("workspaces/harbor-map")));
    expect(argOf(call.argv, "--session-id")).toBe(id);
    expect(argOf(call.argv, "--permission-mode")).toBe("acceptEdits");
    expect(argOf(call.argv, "--allowedTools")).toBe("Bash");
    expect(argOf(call.argv, "--model")).toBe("opus");
    expect(argOf(call.argv, "--effort")).toBe("high");
    expect(call.argv.at(-1)).toBe("Fix the tide parser");
    expect(fs.existsSync(FX.v(`brain/_index/sessions/harbor-map/${id}.jsonl`))).toBe(true);
    const runs = fs.readFileSync(FX.v("brain/_index/agent-runs/runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(runs.filter((row) => row.thread === id).map((row) => [row.script, row.status])).toEqual([["session:claude", "ok"]]);

    // Vault is one click away, and back again: the thread is read from its file.
    await list(win).locator('.aos-ss-row[data-thread="vault"]').click();
    await expect(reader(win).locator(".aos-asst-head .aos-title")).toHaveText("Vault");
    await row.click();
    await expect(r.locator(".aos-ss-done")).toHaveText([claudeDone("Opus · High")]);

    // A reply resumes the same Claude session, on the thread's model, effort and access.
    await reply(win, "And the tests");
    await expect(r.locator(".aos-ss-done")).toHaveCount(2, { timeout: 30_000 });
    await expect(r.locator(".aos-ss-done").nth(1)).toHaveText(claudeDone("Opus · High"));
    await expect(r.locator(".aos-ss-bubble")).toHaveText(["Fix the tide parser", "And the tests"]);
    await expect(r.locator(".aos-ss-turnchange")).toHaveCount(0);
    const second = calls("claude").slice(before)[1];
    expect(argOf(second.argv, "--resume")).toBe(id);
    expect(second.argv).not.toContain("--session-id");
    expect([argOf(second.argv, "--model"), argOf(second.argv, "--effort"), argOf(second.argv, "--allowedTools")]).toEqual(["opus", "high", "Bash"]);
    await expect(row).toHaveAttribute("title", /^Claude Code · 2 turns · \$0\.04 · /);
  });

  test("a Codex turn, then a reply that resumes it: the access menu's sandbox note, Bash lines, the files it changed, an estimated cost", async () => {
    const { win } = app();
    const before = calls("codex").length;
    await newSession(win, { workspace: "harbor-map", host: "codex", text: "Chart the harbour", model: "gpt-tide-3", effort: "medium" });
    const r = reader(win);
    await expect(r.locator(".aos-ss-done")).toHaveText([codexDone("GPT-Tide-3 · Medium")], { timeout: 30_000 });
    await expect(chip(win).locator(".aos-hm-chiphost")).toHaveText("Codex");
    await expect(r.locator(".aos-ss-text")).toHaveText(["Codex charted the harbour."]);
    await expect(r.locator(".aos-ss-tool .aos-ss-toolline")).toHaveText(["Bash(npm test)"]);
    await expect(r.locator(".aos-ss-tool")).toHaveClass(/is-ok/);
    await expect(r.locator(".aos-ss-tool .aos-ss-toolresult")).toHaveText("all green");
    const file = r.locator('.aos-ss-patch .aos-ss-patchfile[data-file="src/tiles.js"]');
    await expect(file).toHaveAttribute("data-change", "update");
    await expect(file.locator(".aos-ss-toolline")).toHaveText("Update(src/tiles.js)");
    // The access menu says Codex runs commands in its sandbox at every level that edits.
    await access(win).locator(".aos-am-trigger").click();
    await expect(access(win).locator(".aos-am-note")).toHaveText(CODEX_ACCESS_NOTE);
    await access(win).locator(".aos-am-item.is-checked").press("Escape");
    await expect(access(win).locator(".aos-am-menu")).toHaveCount(0);
    await expect(access(win).locator(".aos-am-trigger")).toBeFocused();
    const id = await openId(win);
    await expect(list(win).locator(`.aos-ss-row[data-thread="${id}"]`)).not.toHaveClass(/is-running/);

    await reply(win, "And cache the tiles");
    await expect(r.locator(".aos-ss-done")).toHaveCount(2, { timeout: 30_000 });
    await expect(r.locator(".aos-ss-bubble")).toHaveText(["Chart the harbour", "And cache the tiles"]);
    await expect(r.locator(".aos-ss-text")).toHaveText(["Codex charted the harbour.", "Codex cached the tiles."]);
    const [first, second] = calls("codex").slice(before);
    expect(first.argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(argOf(first.argv, "-m")).toBe("gpt-tide-3");
    expect(first.argv).toContain('model_reasoning_effort="medium"');
    expect(second.argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(second.argv).toContain("codex-thread-1");
    expect(second.argv.at(-1)).toBe("And cache the tiles");
    await expect(list(win).locator(`.aos-ss-row[data-thread="${id}"]`)).toHaveAttribute("title", /^Codex · 2 turns · ≈\$0\.\d+ · /);
  });

  test("the workspace crumb opens Spaces on its workspace, and Spaces' Sessions links come back scoped to it (spaces-redesign D12, D32)", async () => {
    const { win } = app();
    // The threads the turns above left under harbor-map: the newest is open.
    const g = group(win, "harbor-map");
    await g.locator(".aos-ss-row").first().click();
    const crumb = reader(win).locator("a.aos-ss-crumb-ws");
    await expect(crumb).toHaveText("harbor-map");
    await expect(crumb).toHaveAttribute("title", "Open workspace harbor-map in Spaces");
    await crumb.click();
    // Select only: Spaces shows the workspace, and nothing is sent or started.
    await expect(rail(win, "spaces")).toHaveClass(/is-active/);
    await expect(content(win).locator('.aos-spc-row[data-workspace="harbor-map"]')).toHaveAttribute("aria-selected", "true");
    await expect(content(win).locator(".aos-spc-h1")).toHaveText("harbor-map");
    // Sessions lists app threads only (D32): History counts them, and opens Sessions on this workspace.
    const more = content(win).locator(".aos-spc-history button.aos-spc-more");
    await expect(more).toHaveText(/^All \d+ in Sessions →$/);
    await more.click();
    await expect(rail(win, "chat")).toHaveClass(/is-active/);
    await expect(list(win).locator(".aos-ss-scope .aos-ss-scopetext")).toHaveText("Showing harbor-map only ·");
    await expect(list(win).locator(".aos-ss-group")).toHaveCount(1);
    await expect(list(win).locator(".aos-ss-group")).toHaveAttribute("data-workspace", "harbor-map");
    await expect(more).toHaveCount(0);
    const n = await group(win, "harbor-map").locator(".aos-ss-row").count();
    expect(n).toBeGreaterThan(0);
    await list(win).locator(".aos-ss-scopeall").click();
    await expect(list(win).locator(".aos-ss-scope")).toHaveCount(0);
    // And the count the link showed was this workspace's app threads.
    await openTab(win, "spaces");
    await expect(content(win).locator(".aos-spc-history button.aos-spc-more")).toHaveText(`All ${n} in Sessions →`);
    // The right pane's footer link opens the same scoped list.
    await content(win).locator(".aos-spc-rightfoot button", { hasText: "Threads in Sessions →" }).click();
    await expect(rail(win, "chat")).toHaveClass(/is-active/);
    await expect(list(win).locator(".aos-ss-scope .aos-ss-scopetext")).toHaveText("Showing harbor-map only ·");
    await list(win).locator(".aos-ss-scopeall").click();
  });

  for (const host of ["claude", "codex"] as Host[]) {
    test(`Stop ends a running ${host} turn: the running mark and Stop while it runs, then stopped, and the thread can go on`, async () => {
      const { win } = app();
      const prompt = `[sleep] Wait for the tide on ${host}`;
      await newSession(win, { workspace: "harbor-map", host, text: prompt });
      const r = reader(win);
      const stop = r.locator(".aos-ss-stop");
      await expect(stop.locator(".aos-ss-stoplabel")).toHaveText("Stop", { timeout: 30_000 });
      await expect(stop.locator(".aos-ss-kbd")).toHaveText("esc");
      await expect(r.locator(".aos-ss-working")).toHaveText(/^Working… \(\d+s · esc to stop\)$/);
      const id = await openId(win);
      const row = list(win).locator(`.aos-ss-row[data-thread="${id}"]`);
      await expect(row).toHaveClass(/is-running/);
      await expect(row.locator(".aos-ss-runmark")).toHaveAttribute("aria-label", "Working");
      await expect(r.locator(".aos-ss-send")).toBeDisabled();
      // The stand-in is running before Stop is pressed, so SIGTERM ends it.
      await expect.poll(() => calls(host).some((c) => c.argv.at(-1) === prompt), { timeout: 15_000 }).toBe(true);
      await stop.click();
      // The stand-in printed no result: the runtime closes the turn as unfinished, and main says it was stopped.
      await expect(r.locator(".aos-ss-error")).toHaveText(["the turn ended before the host finished it", "stopped"], { timeout: 30_000 });
      await expect(r.locator(".aos-ss-done")).toHaveText([FAILED_DONE]);
      await expect(r.locator(".aos-ss-done")).toHaveClass(/is-failed/);
      await expect(r.locator(".aos-ss-stop")).toHaveCount(0);
      await expect(r.locator(".aos-ss-working")).toHaveCount(0);
      await expect(row).not.toHaveClass(/is-running/);
      await expect(r.locator(".aos-ss-send")).toBeEnabled();
    });
  }

  test("the repository card in Review changes: what changed, a file's diff on Review, a refusal inline, and Commit with the message as edited", async () => {
    const { win } = app();
    await newSession(win, { workspace: "tide-log", host: "claude", text: "Log the tides" });
    const r = reader(win);
    await expect(r.locator(".aos-ss-done")).toHaveCount(1, { timeout: 30_000 });
    await expect(r.locator(".aos-ss-topbranchname")).toHaveText("main");
    await openReview(win);
    await expect(r.locator(".aos-ss-reposum")).toHaveText("1 file changed");
    await expect(r.locator(".aos-ss-branch")).toHaveText("main");
    const file = r.locator('.aos-ss-file[data-file="notes.md"]');
    await expect(file.locator(".aos-ss-change")).toHaveText("new");
    await file.locator(".aos-ss-review").click();
    await expect(r.locator(".aos-ss-drawer pre.aos-ss-diff")).toContainText(`+${CLAUDE_TURN.note}`);
    await expect(file.locator(".aos-ss-review")).toHaveText("Close");

    const msg = r.locator("input.aos-ss-message");
    await expect(msg).toHaveValue("Log the tides");   // the thread's title
    await msg.fill("   ");
    await r.locator(".aos-ss-commitbtn").click();
    await expect(r.locator(".aos-ss-commitresult")).toHaveText("A commit needs a message.");
    await expect(r.locator(".aos-ss-commitresult")).toHaveClass(/is-failed/);
    expect(git("log", "--format=%s")).toBe("Start the log");

    await msg.fill("Log the tides from the agent");
    await r.locator(".aos-ss-commitbtn").click();
    await expect(r.locator(".aos-ss-commitresult")).toHaveText(/^Committed [0-9a-f]{7}$/);
    await expect(r.locator(".aos-ss-commitresult")).toHaveClass(/is-ok/);
    await expect(r.locator(".aos-ss-reposum")).toHaveText("No changes");
    expect(git("log", "--format=%s").split("\n")).toEqual(["Log the tides from the agent", "Start the log"]);
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("notes.md");
    expect(git("remote")).toBe("");   // nothing to push to, and nothing pushed

    // A detached HEAD, then a merge in progress: the card says why, and Commit is off. It re-reads on opening the thread.
    const reopen = async () => {
      await list(win).locator('.aos-ss-row[data-thread="vault"]').click();
      await list(win).locator(".aos-ss-row", { hasText: "Log the tides" }).click();
      await openReview(win);
    };
    fs.appendFileSync(path.join(REPO, "notes.md"), "More notes.\n");
    git("checkout", "-q", "--detach");
    await reopen();
    await expect(r.locator(".aos-ss-commit .aos-ss-note")).toHaveText("HEAD is detached: check out a branch to commit.");
    await expect(r.locator(".aos-ss-commitbtn")).toBeDisabled();
    git("checkout", "-q", "main");
    fs.writeFileSync(path.join(REPO, ".git", "MERGE_HEAD"), `${git("rev-parse", "HEAD")}\n`);
    await reopen();
    await expect(r.locator(".aos-ss-commit .aos-ss-note")).toHaveText("A merge is in progress: finish it in a terminal.");
    await expect(r.locator(".aos-ss-commitbtn")).toBeDisabled();
    fs.rmSync(path.join(REPO, ".git", "MERGE_HEAD"));
  });

  test("the day cap (sessions.perDayUsd 0) refuses the turn: the runtime's reason is shown in the thread, and no host runs", async () => {
    const { win } = app();
    editJson(VAULT_CONFIG, (j) => { j.sessions = { perDayUsd: 0 }; });
    const before = calls("claude").length;
    await newSession(win, { workspace: "harbor-map", host: "claude", text: "Over the cap" });
    const r = reader(win);
    await expect(r.locator(".aos-ss-error")).toHaveText(["sessions.perDayUsd is 0, which turns sessions off"], { timeout: 30_000 });
    await expect(r.locator(".aos-ss-done")).toHaveText([FAILED_DONE]);
    expect(calls("claude").length).toBe(before);
  });

  test("SE8 the host and model menu: each host's own list from its catalog, older models folded, search, efforts per model, a custom id, ↻, and the pick in the CLI's argv", async () => {
    test.setTimeout(150_000);
    const { win } = app();
    const r = reader(win);
    await content(win).locator(".aos-ss-newbtn").click();
    await expect(r.locator(".aos-ss-intro")).toBeVisible();
    await r.locator("select.aos-ss-workspace").selectOption("harbor-map");
    await pickAccess(win, "edit");
    await expect(chip(win)).toHaveAttribute("aria-haspopup", "dialog");
    await openMenu(win);
    await expect(chip(win)).toHaveAttribute("aria-expanded", "true");
    await expect(chip(win)).toHaveClass(/is-open/);
    const p = pop(win);
    await expect(p).toHaveAttribute("role", "dialog");
    await expect(p.locator(".aos-hm-hosts .aos-hm-host")).toHaveText(["Claude Code", "Codex"]);
    for (const b of await p.locator(".aos-hm-host").all()) await expect(b).toBeEnabled();
    await expect(p.locator(".aos-hm-offline")).toHaveCount(0);

    // Claude Code: its aliases are current, the full id folds under Older models.
    await p.locator('.aos-hm-host[data-host="claude"]').click();
    await expect(p.locator(".aos-hm-source")).toHaveText(/^From Claude Code 2\.1\.293 · /, { timeout: 30_000 });
    await expect(p.locator(".aos-hm-source")).not.toHaveClass(/is-short/);
    await p.locator('.aos-hm-model[data-model="default"]').click();
    const models = p.locator(".aos-hm-models .aos-hm-model");
    await expect(p.locator(".aos-hm-models")).toHaveAttribute("role", "listbox");
    await expect.poll(() => attrs(models, "data-model")).toEqual(["default", "opus", "sonnet", "haiku"]);
    await expect(models.locator(".aos-hm-modelname")).toHaveText(["Default (recommended)", "Opus", "Sonnet", "Haiku"]);
    await expect(models.first()).toHaveAttribute("aria-selected", "true");
    const older = p.locator(".aos-hm-older");
    await expect(older).toHaveText("Older models (1)");
    await expect(older).toHaveAttribute("aria-expanded", "false");
    await older.click();
    await expect(older).toHaveText("Hide older models");
    await expect.poll(() => attrs(models, "data-model")).toEqual(["default", "opus", "sonnet", "haiku", "claude-tide-7-20990101"]);
    await older.click();
    await expect(models).toHaveCount(4);
    // The search looks through every model, older ones too.
    const search = p.locator("input.aos-hm-search");
    await expect(search).toHaveAttribute("aria-label", "Search models");
    await search.fill("tide");
    await expect.poll(() => attrs(models, "data-model")).toEqual(["claude-tide-7-20990101"]);
    await search.fill("no such model");
    await expect(models).toHaveCount(0);
    await expect(p.locator(".aos-hm-empty")).toHaveText("No model matches. Use a custom model id below.");
    await search.fill("");

    // Each model's own effort levels.
    await expect(p.locator(".aos-hm-efforttitle")).toHaveText("Effort");
    const efforts = p.locator(".aos-hm-effort");
    await p.locator('.aos-hm-model[data-model="opus"]').click();
    await expect.poll(() => attrs(efforts, "data-effort")).toEqual(CLAUDE_EFFORTS);
    await p.locator('.aos-hm-model[data-model="haiku"]').click();
    await expect(efforts).toHaveCount(0);
    await expect(p.locator(".aos-hm-noeffort")).toHaveText("This model has no effort setting.");
    await p.locator('.aos-hm-model[data-model="sonnet"]').click();
    await expect.poll(() => attrs(efforts, "data-effort")).toEqual(["low", "medium", "high"]);
    await p.locator('.aos-hm-effort[data-effort="high"]').click();
    await expect(p.locator(".aos-hm-effort.is-active")).toHaveAttribute("data-effort", "high");
    await expect(chip(win).locator(".aos-hm-chiphost")).toHaveText("Claude Code");
    await expect(chip(win).locator(".aos-hm-chiprest")).toHaveText("· Sonnet · High");

    // A custom id: a dash-led one is refused under the field; another is used and shows as the chosen row.
    await p.locator(".aos-hm-custom").click();
    await expect(p.locator("input.aos-hm-custominput")).toBeFocused();
    await p.locator("input.aos-hm-custominput").fill("-bad");
    await p.locator(".aos-hm-customuse").click();
    await expect(p.locator(".aos-hm-customerror")).toHaveText("A model id cannot start with a dash.");
    await expect(p.locator(".aos-hm-customerror")).toHaveAttribute("role", "alert");
    await p.locator("input.aos-hm-custominput").fill("claude-reef-9");
    await p.locator(".aos-hm-customuse").click();
    await expect(p.locator('.aos-hm-model.is-custom[data-model="claude-reef-9"]')).toHaveAttribute("aria-selected", "true");
    await expect(chip(win).locator(".aos-hm-chiprest")).toHaveText("· claude-reef-9 · High");

    // The keys: Escape closes and focus returns to the chip; ↓ opens on the search; ↓ walks the models, Enter picks.
    await closeMenu(win);
    await chip(win).press("ArrowDown");
    await expect(search).toBeFocused();
    await win.keyboard.type("sonn");
    await win.keyboard.press("ArrowDown");
    await expect(p.locator('.aos-hm-model[data-model="sonnet"]')).toBeFocused();
    await win.keyboard.press("Enter");
    await expect(p.locator('.aos-hm-model[data-model="sonnet"]')).toHaveAttribute("aria-selected", "true");
    await win.keyboard.press("Escape");
    await expect(pop(win)).toHaveCount(0);
    await expect(chip(win)).toBeFocused();
    await expect(chip(win).locator(".aos-hm-chiprest")).toHaveText("· Sonnet · High");
    await expect(r.locator(".aos-ss-statuschoice")).toHaveText("Sonnet · High · Edit files");

    // The pick reaches claude's argv, and the done line names it.
    const claude0 = calls("claude").length;
    await reply(win, "Sound the harbour");
    await expect(r.locator(".aos-ss-done")).toHaveText([claudeDone("Sonnet · High")], { timeout: 30_000 });
    const [c] = calls("claude").slice(claude0);
    expect([argOf(c.argv, "--model"), argOf(c.argv, "--effort")]).toEqual(["sonnet", "high"]);

    // The next New session starts where this one left off (U12): the last host, its model and effort, the access.
    await content(win).locator(".aos-ss-newbtn").click();
    await expect(chip(win)).toHaveAttribute("data-host", "claude");
    await expect(chip(win).locator(".aos-hm-chiprest")).toHaveText("· Sonnet · High");
    await expect(r.locator(".aos-ss-statuschoice")).toHaveText("Sonnet · High · Edit files");
    await expect.poll(() => savedSettings().sessionChoice).toMatchObject({ host: "claude", access: "edit", models: { claude: "sonnet" }, efforts: { claude: "high" } });

    // Codex: its listed models by priority, the hidden one never offered, "Reasoning" levels per model.
    await r.locator("select.aos-ss-workspace").selectOption("harbor-map");
    await openMenu(win);
    await p.locator('.aos-hm-host[data-host="codex"]').click();
    await expect(p.locator(".aos-hm-source")).toHaveText(/^From Codex 0\.158\.0 · /);
    await expect(p.locator(".aos-hm-efforttitle")).toHaveText("Reasoning");
    await expect.poll(() => attrs(models, "data-model")).toEqual(["gpt-tide-3", "gpt-tide-3-mini", "gpt-tide-3-codex"]);
    await expect(p.locator(".aos-hm-older")).toHaveText("Older models (1)");
    await p.locator(".aos-hm-older").click();
    await expect.poll(() => attrs(models, "data-model")).toEqual(["gpt-tide-3", "gpt-tide-3-mini", "gpt-tide-3-codex", "gpt-tide-2"]);
    await search.fill("internal");
    await expect(models).toHaveCount(0);
    await search.fill("");
    await p.locator('.aos-hm-model[data-model="gpt-tide-3-mini"]').click();
    await expect.poll(() => attrs(efforts, "data-effort")).toEqual(["low", "medium", "high"]);
    await p.locator('.aos-hm-model[data-model="gpt-tide-3"]').click();
    await expect.poll(() => attrs(efforts, "data-effort")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    await p.locator('.aos-hm-effort[data-effort="xhigh"]').click();
    await closeMenu(win);
    await expect(chip(win).locator(".aos-hm-chiprest")).toHaveText("· GPT-Tide-3 · XHigh");
    await pickAccess(win, "read");
    const codex0 = calls("codex").length;
    await reply(win, "Sound the channel");
    await expect(r.locator(".aos-ss-done")).toHaveText([codexDone("GPT-Tide-3 · XHigh")], { timeout: 30_000 });
    const [x] = calls("codex").slice(codex0);
    expect(argOf(x.argv, "-m")).toBe("gpt-tide-3");
    expect(x.argv).toContain('model_reasoning_effort="xhigh"');

    // The cache keeps models and commands only: the account Claude Code answered with is not in it (U5).
    const cache = fs.readFileSync(FX.v("brain/_index/host-catalog.json"), "utf8");
    expect(cache).toContain("claude-tide-7-20990101");
    expect(cache).not.toContain("example.invalid");

    // Now New session starts on Codex, its model, its level and Read only; switching to Claude Code brings back
    // Claude's own model and effort (U12). All of it is saved, so it outlives the app.
    await content(win).locator(".aos-ss-newbtn").click();
    await expect(chip(win)).toHaveAttribute("data-host", "codex");
    await expect(chip(win).locator(".aos-hm-chiprest")).toHaveText("· GPT-Tide-3 · XHigh");
    await expect(access(win)).toHaveAttribute("data-access", "read");
    await expect(r.locator(".aos-ss-statuschoice")).toHaveText("GPT-Tide-3 · XHigh · Read only");
    await expect.poll(() => savedSettings().sessionChoice).toMatchObject({
      host: "codex", access: "read", models: { claude: "sonnet", codex: "gpt-tide-3" }, efforts: { claude: "high", codex: "xhigh" },
    });
    await pickAccess(win, "edit");

    // ↻ asks the hosts again. A host that does not answer leaves its aliases and why the list is short, and still runs.
    await r.locator("select.aos-ss-workspace").selectOption("harbor-map");
    await openMenu(win);
    await p.locator('.aos-hm-host[data-host="claude"]').click();
    await expect(chip(win).locator(".aos-hm-chiprest")).toHaveText("· Sonnet · High");
    fs.writeFileSync(FLAG.claudeFails, "");
    try {
      await refreshCatalog(win, "claude");
      await expect(p.locator(".aos-hm-source")).toHaveText(/^Claude Code exited \(1\)/);
      await expect(p.locator(".aos-hm-source")).toHaveClass(/is-short/);
      await expect.poll(() => attrs(models, "data-model")).toEqual(["default", "opus", "fable", "sonnet", "haiku"]);
      await p.locator('.aos-hm-model[data-model="sonnet"]').click();
      await p.locator('.aos-hm-effort[data-effort="low"]').click();
      await closeMenu(win);
      const claude1 = calls("claude").length;
      await reply(win, "Sound the shallows");
      await expect(r.locator(".aos-ss-done")).toHaveText([/^Done · Sonnet · Low · /], { timeout: 30_000 });
      expect(argOf(calls("claude")[claude1].argv, "--model")).toBe("sonnet");
    } finally {
      fs.rmSync(FLAG.claudeFails, { force: true });
    }
    await content(win).locator(".aos-ss-newbtn").click();
    await openMenu(win);
    await p.locator('.aos-hm-host[data-host="claude"]').click();
    await refreshCatalog(win, "claude");
    await expect(p.locator(".aos-hm-source")).toHaveText(/^From Claude Code 2\.1\.293 · /);
    await closeMenu(win);
  });

  test("SE9 in a thread the host is locked; a model or effort change applies from the next turn, with a marker; New session on the other host", async () => {
    test.setTimeout(120_000);
    const { win } = app();
    const r = reader(win);
    const before = calls("claude").length;
    await newSession(win, { workspace: "harbor-map", host: "claude", text: "Chart the reef", model: "default", effort: "medium" });
    await expect(r.locator(".aos-ss-done")).toHaveText([claudeDone("Default · Medium")], { timeout: 30_000 });
    const id = await openId(win);

    // The chip carries a lock; the menu has no host switch, says the host stays, and offers a new session on Codex.
    await expect(hm(win)).toHaveAttribute("data-mode", "thread");
    await expect(chip(win).locator(".aos-hm-lockicon")).toHaveCount(1);
    await expect(chip(win)).toHaveAttribute("title", "This thread stays on Claude Code");
    await openMenu(win);
    await expect(pop(win).locator(".aos-hm-hosts")).toHaveCount(0);
    await expect(pop(win).locator(".aos-hm-locktext")).toHaveText("Claude Code · this thread stays on Claude Code");
    await expect(pop(win).locator(".aos-hm-lockhost")).toHaveText("Claude Code");
    await expect(pop(win).locator(".aos-hm-newon")).toHaveText("New session on Codex");
    await expect(pop(win).locator(".aos-hm-newon")).toHaveAttribute("data-host", "codex");
    await expect(pop(win).locator(".aos-hm-caption")).toHaveText("Applies from your next message. Earlier turns keep the model they ran on.");
    await closeMenu(win);

    await choose(win, { model: "opus", effort: "max" });
    await expect(r.locator(".aos-ss-statuschoice")).toHaveText("Opus · Max · Edit files");
    await expect(r.locator(".aos-ss-turnchange")).toHaveCount(0);   // nothing changed until the next turn runs
    // The list tags the model the thread ran on so far, apart from its name, while another is picked.
    await openMenu(win);
    await expect(pop(win).locator(".aos-hm-modeltag")).toHaveText(["used so far"]);
    await expect(pop(win).locator('.aos-hm-model[data-model="default"] .aos-hm-modeltag')).toHaveText("used so far");
    await expect(pop(win).locator('.aos-hm-model[data-model="default"] .aos-hm-modelname')).toHaveText("Default (recommended)");
    await closeMenu(win);
    await reply(win, "And the shoals");
    await expect(r.locator(".aos-ss-done")).toHaveCount(2, { timeout: 30_000 });
    const marker = r.locator(".aos-ss-turnchange");
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAttribute("data-turn", "2");
    await expect(marker.locator(".aos-ss-turnchangetext")).toHaveText("Next turn on Opus · Max");
    await expect(r.locator(".aos-ss-turnchange + .aos-ss-prompt")).toHaveText("And the shoals");
    await expect(r.locator(".aos-ss-done")).toHaveText([claudeDone("Default · Medium"), claudeDone("Opus · Max")]);
    await expect(r.locator(".aos-ss-statuschoice")).toHaveText("Opus · Max · Edit files");   // the next turn keeps it
    const [first, second] = calls("claude").slice(before);
    expect(first.argv).not.toContain("--model");   // Claude's default alias passes no --model
    expect(argOf(first.argv, "--effort")).toBe("medium");
    expect([argOf(second.argv, "--resume"), argOf(second.argv, "--model"), argOf(second.argv, "--effort")]).toEqual([id, "opus", "max"]);
    // Each prompt in the thread file records what its turn ran on.
    const prompts = fs.readFileSync(FX.v(`brain/_index/sessions/harbor-map/${id}.jsonl`), "utf8").trim().split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.kind === "prompt").map((e) => [e.model, e.effort, e.access]);
    expect(prompts).toEqual([[null, "medium", "edit"], ["opus", "max", "edit"]]);

    // The same on Codex: another model and level from the next turn.
    const codex0 = calls("codex").length;
    await newSession(win, { workspace: "harbor-map", host: "codex", text: "Map the channel", model: "gpt-tide-3", effort: "medium" });
    await expect(r.locator(".aos-ss-done")).toHaveCount(1, { timeout: 30_000 });
    await expect(chip(win)).toHaveAttribute("title", "This thread stays on Codex");
    await choose(win, { model: "gpt-tide-3-mini", effort: "low" });
    await reply(win, "And the buoys");
    await expect(r.locator(".aos-ss-done")).toHaveCount(2, { timeout: 30_000 });
    await expect(r.locator(".aos-ss-turnchangetext")).toHaveText("Next turn on GPT-Tide-3 Mini · Low");
    await expect(r.locator(".aos-ss-done").nth(1)).toHaveText(codexDone("GPT-Tide-3 Mini · Low"));
    const [c1, c2] = calls("codex").slice(codex0);
    expect([argOf(c1.argv, "-m"), c1.argv.includes('model_reasoning_effort="medium"')]).toEqual(["gpt-tide-3", true]);
    expect([c2.argv[1], argOf(c2.argv, "-m"), c2.argv.includes('model_reasoning_effort="low"')]).toEqual(["resume", "gpt-tide-3-mini", true]);

    // New session on Claude Code from the Codex thread: a new session in the same workspace, on that host.
    await openMenu(win);
    await pop(win).locator('.aos-hm-newon[data-host="claude"]').click();
    await expect(r.locator(".aos-ss-toptitle")).toHaveText("New session");
    await expect(hm(win)).toHaveAttribute("data-mode", "new");
    await expect(chip(win)).toHaveAttribute("data-host", "claude");
    await expect(r.locator("select.aos-ss-workspace")).toHaveValue("harbor-map");
  });

  test("SE10 access levels reach the argv: Claude plan mode, acceptEdits, acceptEdits with Bash; Codex read-only and workspace-write; the menu says what each runs as", async () => {
    test.setTimeout(180_000);
    const { win } = app();
    const r = reader(win);
    const before = calls("claude").length;
    await newSession(win, { workspace: "harbor-map", host: "claude", text: "Read the charts", model: "default", effort: "medium", access: "read" });
    await expect(r.locator(".aos-ss-done")).toHaveCount(1, { timeout: 30_000 });

    // The menu: three levels, what each runs as on each host, the chosen one checked; no Codex note on a Claude thread.
    const am = access(win);
    await expect(am.locator(".aos-am-trigger")).toHaveAttribute("title", "What the agent may do");
    await expect(am.locator(".aos-am-trigger")).toHaveAttribute("aria-haspopup", "menu");
    await expect(am.locator(".aos-am-label")).toHaveText("Read only");
    await am.locator(".aos-am-trigger").click();
    await expect(am).toHaveClass(/is-open/);
    await expect(am.locator(".aos-am-trigger")).toHaveAttribute("aria-expanded", "true");
    await expect(am.locator(".aos-am-menu")).toHaveAttribute("role", "menu");
    const items = am.locator(".aos-am-item");
    await expect(items.locator(".aos-am-name")).toHaveText(ACCESS_LEVELS.map((l) => l.label));
    await expect(items.locator(".aos-am-map")).toHaveText(ACCESS_LEVELS.map((l) => accessHostLine(l)));
    expect(await attrs(items, "role")).toEqual(["menuitemradio", "menuitemradio", "menuitemradio"]);
    await expect(am.locator('.aos-am-item[data-level="read"]')).toHaveAttribute("aria-checked", "true");
    await expect(am.locator(".aos-am-note")).toHaveCount(0);
    // ↓ moves, Enter picks; focus stays on the chip.
    await expect(am.locator('.aos-am-item[data-level="read"]')).toBeFocused();
    await win.keyboard.press("ArrowDown");
    await expect(am.locator('.aos-am-item[data-level="edit"]')).toBeFocused();
    await win.keyboard.press("Enter");
    await expect(am).toHaveAttribute("data-access", "edit");
    await expect(am.locator(".aos-am-label")).toHaveText("Edit files");
    await expect(am.locator(".aos-am-trigger")).toBeFocused();
    await reply(win, "Edit the charts");
    await expect(r.locator(".aos-ss-done")).toHaveCount(2, { timeout: 30_000 });
    await expect(r.locator(".aos-ss-turnchangetext")).toHaveText(["Next turn on Default · Medium · Edit files"]);
    await pickAccess(win, "run");
    await reply(win, "Run the chart tests");
    await expect(r.locator(".aos-ss-done")).toHaveCount(3, { timeout: 30_000 });
    await expect(r.locator(".aos-ss-turnchangetext")).toHaveText(["Next turn on Default · Medium · Edit files", "Next turn on Default · Medium · Edit and run commands"]);
    const [a, b, c] = calls("claude").slice(before);
    expect([argOf(a.argv, "--permission-mode"), argOf(a.argv, "--allowedTools")]).toEqual(["plan", undefined]);
    expect([argOf(b.argv, "--permission-mode"), argOf(b.argv, "--allowedTools")]).toEqual(["acceptEdits", undefined]);
    expect([argOf(c.argv, "--permission-mode"), argOf(c.argv, "--allowedTools")]).toEqual(["acceptEdits", "Bash"]);

    // Codex: the sandbox note; read-only, then workspace-write for both levels that edit.
    const codex0 = calls("codex").length;
    await newSession(win, { workspace: "harbor-map", host: "codex", text: "Read the tiles", model: "gpt-tide-3", effort: "medium", access: "read" });
    await expect(r.locator(".aos-ss-done")).toHaveCount(1, { timeout: 30_000 });
    await am.locator(".aos-am-trigger").click();
    await expect(am.locator(".aos-am-note")).toHaveText(CODEX_ACCESS_NOTE);
    await win.keyboard.press("Escape");
    await expect(am.locator(".aos-am-menu")).toHaveCount(0);
    await expect(am.locator(".aos-am-trigger")).toBeFocused();
    await pickAccess(win, "edit");
    await reply(win, "Edit the tiles");
    await expect(r.locator(".aos-ss-done")).toHaveCount(2, { timeout: 30_000 });
    await pickAccess(win, "run");
    await reply(win, "Test the tiles");
    await expect(r.locator(".aos-ss-done")).toHaveCount(3, { timeout: 30_000 });
    const sandbox = (call: Call) => call.argv.find((x) => x.startsWith("sandbox_mode="));
    expect(calls("codex").slice(codex0).map(sandbox)).toEqual(['sandbox_mode="read-only"', 'sandbox_mode="workspace-write"', 'sandbox_mode="workspace-write"']);
  });

  test("SE11 the slash menu: / lists Claude Code's commands and inserts /name, $ lists Codex's skills and inserts $name; Escape closes; an empty skills list says so", async () => {
    test.setTimeout(150_000);
    const { win } = app();
    const r = reader(win);
    await newSession(win, { workspace: "harbor-map", host: "claude", text: "Note the tides", model: "default", effort: "medium" });
    await expect(r.locator(".aos-ss-done")).toHaveCount(1, { timeout: 30_000 });
    await expect(input(win)).toHaveAttribute("placeholder", "Reply to Claude Code…   / for commands");

    const menu = r.locator(".aos-ss-composer.aos-sm-anchor .aos-sm-menu");
    const names = menu.locator(".aos-sm-option .aos-sm-name");
    await input(win).click();
    await input(win).pressSequentially("/");
    await expect(menu).toHaveAttribute("role", "listbox");
    await expect(menu).toHaveAttribute("aria-label", "Commands");
    await expect(menu).toHaveAttribute("data-host", "claude");
    await expect(names).toHaveText(["/review", "/agenticos:standup", "/tide-report", "/compact"]);
    await expect(menu.locator('.aos-sm-option[data-command="review"] .aos-sm-hint')).toHaveText("[path]");
    await expect(menu.locator('.aos-sm-option[data-command="review"] .aos-sm-desc')).toHaveText("Review the open changes");
    await expect(menu.locator(".aos-sm-count")).toHaveText("4 commands from Claude Code");
    await expect(menu.locator(".aos-sm-keys")).toHaveText("↑↓ move · ↵ insert · esc close");
    const firstOpt = menu.locator(".aos-sm-option").first();
    await expect(firstOpt).toHaveAttribute("aria-selected", "true");
    await expect(input(win)).toHaveAttribute("aria-autocomplete", "list");
    await expect(input(win)).toHaveAttribute("aria-controls", (await menu.getAttribute("id")) ?? "");
    await expect(input(win)).toHaveAttribute("aria-activedescendant", (await firstOpt.getAttribute("id")) ?? "");
    await win.keyboard.press("ArrowDown");
    await expect(menu.locator('.aos-sm-option[data-command="agenticos:standup"]')).toHaveClass(/is-selected/);
    // Typing filters; Enter inserts the command in place of the typed token, and the menu closes.
    await input(win).pressSequentially("tide");
    await expect(names).toHaveText(["/tide-report"]);
    await win.keyboard.press("Enter");
    await expect(input(win)).toHaveValue("/tide-report ");
    await expect(menu).toHaveCount(0);
    await expect(input(win)).not.toHaveAttribute("aria-autocomplete", "list");
    await input(win).pressSequentially("Monday");
    // The prompt reaches the host unchanged.
    const claude0 = calls("claude").length;
    await r.locator(".aos-ss-send").click();
    await expect(r.locator(".aos-ss-done")).toHaveCount(2, { timeout: 30_000 });
    expect(calls("claude").slice(claude0).map((c) => c.argv.at(-1))).toEqual(["/tide-report Monday"]);
    // Escape closes the menu and keeps the text; it stops nothing, not even a running turn, which Esc in the tab would.
    const prompt = "[sleep] Wait for the tide report";
    await reply(win, prompt);
    await expect(r.locator(".aos-ss-stop .aos-ss-stoplabel")).toHaveText("Stop", { timeout: 30_000 });
    await expect.poll(() => calls("claude").some((c) => c.argv.at(-1) === prompt), { timeout: 15_000 }).toBe(true);
    await input(win).click();
    await input(win).pressSequentially("/re");
    await expect(names.first()).toHaveText("/review");
    await win.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(input(win)).toHaveValue("/re");
    await expectStillRunning(win);
    await expect(r.locator(".aos-ss-error")).toHaveCount(0);
    await input(win).fill("");
    await r.locator(".aos-ss-stop").click();
    await expect(r.locator(".aos-ss-error")).toHaveText(["the turn ended before the host finished it", "stopped"], { timeout: 30_000 });
    await expect(r.locator(".aos-ss-stop")).toHaveCount(0);

    // Codex: $ lists its skills, and inserts $name, how Codex names a skill.
    await newSession(win, { workspace: "harbor-map", host: "codex", text: "Plot the shoals", model: "gpt-tide-3", effort: "medium" });
    await expect(r.locator(".aos-ss-done")).toHaveCount(1, { timeout: 30_000 });
    await input(win).click();
    await input(win).pressSequentially("$");
    await expect(menu).toHaveAttribute("aria-label", "Skills");
    await expect(menu).toHaveAttribute("data-host", "codex");
    await expect(names).toHaveText(["$tide-check", "$agenticos:ask-brain", "$harbor-chart"]);
    await expect(menu.locator(".aos-sm-count")).toHaveText("3 skills from Codex");
    await input(win).pressSequentially("harb");
    await expect(names).toHaveText(["$harbor-chart"]);
    await win.keyboard.press("Enter");
    await expect(input(win)).toHaveValue("$harbor-chart ");
    await expect(menu).toHaveCount(0);
    await input(win).fill("");

    // A Codex that lists no skills: the menu says typing $name still works.
    fs.writeFileSync(FLAG.codexNoSkills, "");
    try {
      await openMenu(win);
      await refreshCatalog(win, "codex");
      await closeMenu(win);
      await input(win).click();
      await input(win).pressSequentially("$");
      await expect(menu.locator(".aos-sm-empty")).toHaveText("Codex listed no skills; typing $name still works");
      await expect(menu.locator(".aos-sm-count")).toHaveText("0 skills from Codex");
      await win.keyboard.press("Escape");
      await input(win).fill("");
    } finally {
      fs.rmSync(FLAG.codexNoSkills, { force: true });
    }
    await openMenu(win);
    await refreshCatalog(win, "codex");
    await closeMenu(win);
  });

  test("SE12 the layout: the list (New session, Vault, workspace folders, host dots, spend), mono tool lines, the Plan card, Review changes +a −b, the status line, Esc stops a turn", async () => {
    test.setTimeout(150_000);
    const { win } = app();
    const r = reader(win);
    // A repository with an edited README (+2 −1) before the turn adds notes.md (+1 −0).
    const reef = FX.v("workspaces/reef-log");
    makeRepo(reef, "# Reef log\nOld line\n");
    fs.writeFileSync(path.join(reef, "README.md"), "# Reef log\nNew line\nAnother line\n");
    await newSession(win, { workspace: "reef-log", host: "claude", text: "Survey the reef", model: "default", effort: "medium", access: "edit" });
    await expect(r.locator(".aos-ss-done")).toHaveCount(1, { timeout: 30_000 });

    // The list: New session, Vault, then each workspace folder with its threads, and the day's spend.
    const l = list(win);
    await expect(l).toHaveAttribute("aria-label", "Sessions");
    await expect(l.locator("button.aos-ss-newbtn")).toHaveText("New session");
    const vault = l.locator(".aos-ss-row").first();
    await expect(vault).toHaveAttribute("data-thread", "vault");
    await expect(vault).toHaveAttribute("title", "Questions about your notes");
    await expect(vault.locator(".aos-ss-title")).toHaveText("Vault");
    const g = group(win, "reef-log");
    await expect(g).toHaveAttribute("role", "group");
    await expect(g.locator(".aos-ss-ws .aos-ss-wsname")).toHaveText("reef-log");
    const row = g.locator(".aos-ss-row.aos-ss-thread");
    await expect(row).toHaveAttribute("data-host", "claude");
    await expect(row).toHaveClass(/is-selected/);
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(row.locator(":scope > span")).toHaveClass([/aos-ss-hostdot is-claude/, /aos-ss-title/, /aos-ss-age/]);
    await expect(l.locator(".aos-ss-spend .aos-ss-spendval")).toHaveText(/^\$\d+\.\d{2,4} of \$10$/);
    await expect(l.locator(".aos-ss-spendbar")).toHaveAttribute("role", "progressbar");
    await expect(l.locator(".aos-ss-spendbar")).toHaveAttribute("aria-valuenow", /^\d+$/);

    // The top bar: workspace / title, the branch, Review changes with the totals.
    await expect(r.locator(".aos-ss-top .aos-ss-crumbs")).toHaveText("reef-log/Survey the reef");
    await expect(r.locator(".aos-ss-topbranch .aos-ss-topbranchname")).toHaveText("main");
    const review = r.locator(".aos-ss-reviewbtn");
    await expect(review.locator(".aos-ss-plus")).toHaveText("+3");
    await expect(review.locator(".aos-ss-minus")).toHaveText("−1");
    await expect(review).toHaveAttribute("aria-controls", "aos-ss-drawer");

    // The timeline: the Plan card, and mono tool lines whose edit line has the file's +/− and opens to its diff.
    const plan = r.locator(".aos-ss-plan");
    await expect(plan.locator(".aos-ss-planhead")).toHaveText("Plan");
    await expect.poll(() => attrs(plan.locator("li.aos-ss-planitem"), "data-status")).toEqual(["done", "active", "pending"]);
    await expect(plan.locator(".aos-ss-plantext")).toHaveText(["Done: Read the tide parser", "In progress: Fix the parser", "To do: Run the tests"]);
    await expect(plan.locator(".aos-ss-planitem.is-done .aos-ss-planbox")).toHaveText("☒");
    const edit = r.locator('.aos-ss-tool[data-kind="edit"]');
    await expect(edit).toHaveAttribute("data-verb", "Update");
    await expect(edit.locator(".aos-ss-toolline")).toHaveText("Update(notes.md)");
    await expect(edit.locator(".aos-ss-verb")).toHaveText("Update");
    await expect(edit.locator(".aos-ss-target")).toHaveText("(notes.md)");
    await expect(edit.locator(".aos-ss-toolresult")).toHaveText("+1 −0 · open to see the file's diff");
    await edit.locator(".aos-ss-toolline").click();
    await expect(edit).toHaveClass(/is-open/);
    await expect(edit.locator(".aos-ss-toolstate")).toHaveText("Result");
    await expect(edit.locator(".aos-ss-filediff .aos-ss-diffline.is-add").filter({ hasText: CLAUDE_TURN.note })).toHaveCount(1);
    await edit.locator(".aos-ss-toolline").click();
    await expect(edit).not.toHaveClass(/is-open/);

    // Review changes: the drawer with each file's counts; Esc inside it closes it and gives focus back to the button.
    await review.click();
    const drawer = r.locator("#aos-ss-drawer");
    await expect(drawer).toHaveClass(/is-open/);
    await expect(drawer).toHaveAttribute("role", "region");
    await expect(review).toHaveAttribute("aria-expanded", "true");
    await expect(drawer.locator(".aos-ss-drawertitle")).toHaveText("Review changes");
    await expect(drawer.locator(".aos-ss-reposum")).toHaveText("2 files changed");
    await expect(drawer.locator(".aos-ss-repohead .aos-ss-counts")).toHaveText("+3−1");
    await expect(drawer.locator('.aos-ss-file[data-file="README.md"] .aos-ss-counts')).toHaveText("+2−1");
    await expect(drawer.locator('.aos-ss-file[data-file="notes.md"] .aos-ss-counts')).toHaveText("+1−0");
    await expect(drawer.locator(".aos-ss-drawerclose")).toBeFocused();
    await win.keyboard.press("Escape");
    await expect(drawer).not.toHaveClass(/is-open/);
    await expect(review).toBeFocused();

    // The status line: the next turn's choice, the spend, the branch and files.
    await expect(r.locator(".aos-ss-statuschoice")).toHaveText("Default · Medium · Edit files");
    await expect(r.locator(".aos-ss-statusspend")).toHaveText(/^turn \$0\.02 · today \$\d+\.\d{2,4} of \$10$/);
    await expect(r.locator(".aos-ss-statusrepo")).toHaveText("main · 2 files");

    // A running turn: the running mark, the working line, Stop with its key, Review's note. Esc in the drawer, the
    // access menu (from an item, and from its chip after Shift+Tab) or the slash menu only closes it: the turn runs on.
    // Esc in the tab stops it.
    const prompt = "[sleep] Wait for the reef";
    await reply(win, prompt);
    await expect(row).toHaveClass(/is-running/, { timeout: 30_000 });
    await expect(row.locator(".aos-ss-runmark")).toHaveAttribute("aria-label", "Working");
    await expect(row.locator(".aos-ss-age")).toHaveCount(0);
    await expect(r.locator(".aos-ss-working")).toHaveText(/^Working… \(\d+s · esc to stop\)$/);
    await expect(r.locator(".aos-ss-stop .aos-ss-kbd")).toHaveText("esc");
    await expect.poll(() => calls("claude").some((c) => c.argv.at(-1) === prompt), { timeout: 15_000 }).toBe(true);
    await openReview(win);
    await expect(r.locator(".aos-ss-drawer .aos-ss-repo > .aos-ss-note")).toHaveText("The agent is still working: commit once the turn ends.");
    await expect(drawer.locator(".aos-ss-drawerclose")).toBeFocused();
    await win.keyboard.press("Escape");
    await expect(drawer).not.toHaveClass(/is-open/);
    await expect(review).toBeFocused();
    await expectStillRunning(win);
    const am = access(win);
    await am.locator(".aos-am-trigger").click();
    await expect(am.locator('.aos-am-item[data-level="edit"]')).toBeFocused();
    await win.keyboard.press("Escape");
    await expect(am.locator(".aos-am-menu")).toHaveCount(0);
    await expect(am.locator(".aos-am-trigger")).toBeFocused();
    await expectStillRunning(win);
    await am.locator(".aos-am-trigger").click();
    await win.keyboard.press("Shift+Tab");
    await expect(am.locator(".aos-am-trigger")).toBeFocused();
    await expect(am.locator(".aos-am-menu")).toHaveCount(1);
    await win.keyboard.press("Escape");
    await expect(am.locator(".aos-am-menu")).toHaveCount(0);
    await expect(am.locator(".aos-am-trigger")).toBeFocused();
    await expectStillRunning(win);
    await input(win).click();
    await input(win).pressSequentially("/");
    await expect(r.locator(".aos-sm-menu")).toBeVisible();
    await win.keyboard.press("Escape");
    await expect(r.locator(".aos-sm-menu")).toHaveCount(0);
    await expectStillRunning(win);
    await input(win).fill("");
    await input(win).press("Escape");
    await expect(r.locator(".aos-ss-error")).toHaveText(["the turn ended before the host finished it", "stopped"], { timeout: 30_000 });
    await expect(r.locator(".aos-ss-done").last()).toHaveClass(/is-failed/);
    await expect(row).not.toHaveClass(/is-running/);

    // Codex's plan: its todo list, ticked as the turn went; its thread has a Codex dot in its workspace.
    await newSession(win, { workspace: "harbor-map", host: "codex", text: "Chart the shoals", model: "gpt-tide-3", effort: "medium" });
    await expect(r.locator(".aos-ss-done")).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => attrs(r.locator(".aos-ss-plan li.aos-ss-planitem"), "data-status")).toEqual(["done", "pending"]);
    await expect(r.locator(".aos-ss-plan .aos-ss-plantext")).toHaveText(["Done: Chart the harbour", "To do: Cache the tiles"]);
    await expect(group(win, "harbor-map").locator(".aos-ss-thread.is-selected .aos-ss-hostdot")).toHaveClass(/is-codex/);
  });
});

// ── the surface off ──────────────────────────────────────────────────

test.describe("the Sessions surface off", () => {
  const app = useApp({ env: HOSTS_ON, prepare: () => prepare({ claude: true, codex: true }) });

  test("the list says why, a new session is refused inline, Vault still works, and nothing runs", async () => {
    const h = app();
    await openTab(h.win, "chat");
    await expect(list(h.win).locator(".aos-ss-note")).toHaveText("Workspace sessions are unavailable: the Sessions surface is off.");
    await expect(reader(h.win).locator(".aos-asst-head .aos-title")).toHaveText("Vault");
    await newSession(h.win, { workspace: "harbor-map", host: "claude", text: "Refused?" });
    await expect(reader(h.win).locator(".aos-ss-composererror")).toHaveText("the Sessions surface is off");
    await expect(reader(h.win).locator(".aos-ss-composererror")).toHaveAttribute("role", "alert");
    await expect(input(h.win)).toHaveValue("Refused?");   // the prompt is kept
    expect(calls("claude")).toEqual([]);
    expect(catalogCalls("claude")).toEqual([]);   // nor is a host asked for its models
    expect(fs.existsSync(FX.v("brain/_index/sessions"))).toBe(false);
    await list(h.win).locator('.aos-ss-row[data-thread="vault"]').click();
    await expect(reader(h.win).locator("textarea.aos-asst-input")).toBeVisible();
    expectNoErrors(h);
  });
});

// ── a Codex-only machine ─────────────────────────────────────────────

test.describe("a Codex-only machine", () => {
  const app = useApp({ env: { AOS_APP_WRITE: "sessions", ...HOSTS_ON }, prepare: () => prepare({ claude: false, codex: true }) });

  test("the host and model menu offers Codex alone, with Claude Code off on this Mac and why; a Codex turn runs", async () => {
    const h = app();
    await openTab(h.win, "chat");
    await content(h.win).locator(".aos-ss-newbtn").click();
    await expect(chip(h.win)).toHaveAttribute("data-host", "codex");
    await expect(chip(h.win).locator(".aos-hm-chiphost")).toHaveText("Codex");
    await openMenu(h.win);
    const p = pop(h.win);
    const claude = p.locator('.aos-hm-host[data-host="claude"]');
    const codex = p.locator('.aos-hm-host[data-host="codex"]');
    await expect(claude).toBeDisabled();
    await expect(claude).toHaveAttribute("title", "Claude Code is off on this machine");
    // `aos hosts add claude` keeps Codex on (install-import B2), so the line names it whatever else is on.
    await expect(p.locator('.aos-hm-offline[data-host="claude"]')).toHaveText("Claude Code is off on this Mac: aos hosts add claude turns it on");
    await expect(codex).toBeEnabled();
    await expect(codex).toHaveClass(/is-active/);
    await expect(p.locator(".aos-hm-source")).toHaveText(/^From Codex 0\.158\.0 · /, { timeout: 30_000 });
    await closeMenu(h.win);
    await access(h.win).locator(".aos-am-trigger").click();
    await expect(access(h.win).locator(".aos-am-note")).toHaveText(CODEX_ACCESS_NOTE);
    await h.win.keyboard.press("Escape");
    await expect(access(h.win).locator(".aos-am-menu")).toHaveCount(0);
    await input(h.win).fill("Chart the harbour");
    await reader(h.win).locator(".aos-ss-send").click();
    await expect(reader(h.win).locator(".aos-ss-text")).toHaveText(["Codex charted the harbour."], { timeout: 30_000 });
    await expect(reader(h.win).locator(".aos-ss-done")).toHaveText(/estimated/);
    expect(calls("claude")).toEqual([]);
    expect(catalogCalls("claude")).toEqual([]);   // a host that is off is never asked
    expectNoErrors(h);
  });
});
