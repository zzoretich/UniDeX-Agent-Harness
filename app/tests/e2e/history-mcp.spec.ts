// Sessions ▸ History and the MCP server copy (install-import B11, B6; Copy to … in a Connectors sheet since
// connectors-tab D20), on the fixture as it is (Claude Code on but not signed in, Codex off), on a Codex-only machine, on
// a machine with no host, and with both hosts and the MCP servers surface on. History reads the scan's session index and
// the digests the fixture writes (the import-digest routine's output); Resume types the host's resume line into a Code
// terminal, whose `claude` and `codex` are the fixture's echo stubs. Copy to … runs the vault's own `aos mcp copy`
// through the app's policy against stand-in `claude` and `codex` CLIs that log their argv and write the entry the way the
// real ones do (app-smoke: Sessions ▸ History, Connectors). The copy refused without the surface is connectors.spec.ts's.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, content, expected, expectNoErrors, freshConnectorsCheck, openTab, rail, terminalText, useApp } from "./harness";

const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};
const AGENTICOS = path.join(FX.claude, "agenticos.json");
const PROVIDER_STATE = () => FX.v("brain/_index/provider-state.json");

const history = (win: Page) => content(win).locator(".aos-ss-history");
const hrow = (win: Page, title: string) => history(win).locator(".aos-ss-hrow", { hasText: title });
/** A server's card on the Connectors board, and the host rows of the sheet it opens. */
const serverCard = (win: Page, name: string) => content(win).locator(`[data-conn="s:${name}"]`).first();
const sheetHost = (win: Page, host: string) => content(win).locator(`aside.aos-con-sheet .aos-con-hostrow[data-host="${host}"]`);

/** The fixture's two digested sessions and what the scan indexed besides. */
const CLAUDE_ROW = "Tide parser in the chart view";
const CODEX_ROW = "Sketch the depth contours layer for the chart view";

test.describe("the fixture: Claude Code on but not signed in, Codex off", () => {
  // The fixture's Connectors check dated now: opening Connectors starts no check of its own.
  const app = useApp({ prepare: freshConnectorsCheck });

  test("Sessions is on the rail for History and opens there: past sessions by day with the digest's line; Resume on Claude Code's rows, none on Codex's (B11)", async () => {
    const h = app();
    const { win } = h;
    await expect(rail(win, "chat")).toHaveCount(1);
    await openTab(win, "chat");
    await expect(content(win).locator('.aos-ss-row[data-thread="history"]')).toHaveClass(/is-selected/);
    await expect(content(win).locator(".aos-ss-hnohost")).toHaveText("No host is signed in: Sessions shows the history on this Mac. Sign in to Claude Code or Codex to start a session.");
    const x = expected().history.digests;
    await expect(content(win).locator(".aos-ss-hcount")).toHaveText(/^\d+ past sessions · Claude Code \d+ · Codex \d+ · 2 summarised$/);
    await expect(history(win).locator(".aos-ss-hdayname").first()).toHaveText(/^(Today|Yesterday)$/);   // three hours ago
    // Newest first: the Claude Code session in harbor-map, its digest's line under it.
    const first = history(win).locator(".aos-ss-hrow").first();
    await expect(first.locator(".aos-ss-htitle")).toHaveText(CLAUDE_ROW);
    await expect(first.locator(".aos-ss-hmeta")).toHaveText(/^\d{2}:\d{2} · Claude Code · harbor-map$/);
    await expect(first.locator(".aos-ss-hsummary")).toHaveText(x.claude.summary);
    await expect(first).toHaveAttribute("data-host", "claude");
    // Claude Code is on (its login never checked, so a terminal may try it, as Spaces' Resume does); Codex is off: its
    // rows have no Resume.
    await expect(first.locator("button.aos-ss-hresume")).toBeEnabled();
    await expect(first.locator("button.aos-ss-hresume")).toHaveAttribute("title", "Resumes in workspaces/harbor-map");
    await expect(hrow(win, CODEX_ROW).locator(".aos-ss-hsummary")).toHaveText(x.codex.summary);
    await expect(hrow(win, CODEX_ROW).locator("button.aos-ss-hresume")).toHaveCount(0);
    await expect(history(win).locator('.aos-ss-hrow[data-host="codex"] button.aos-ss-hresume')).toHaveCount(0);
    // A rollout outside every workspace shows its folder; a headless `codex exec` run and a subagent are not History.
    await expect(history(win).locator(".aos-ss-hrow", { hasText: "~/sketches" })).toHaveCount(1);
    await expect(history(win)).not.toContainText("List the chart tiles missing a zoom level");
    await expect(history(win)).not.toContainText("Find where the chart view draws its layers");
    // Resume types `claude --resume <id>` into a Code terminal in the workspace.
    await first.locator("button.aos-ss-hresume").click();
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toMatch(new RegExp(`\\[fixture claude stub\\] .*--resume ${x.claude.id}`));
    expectNoErrors(h);
  });

  test("the filter narrows History by any word, keeps its focus, and says when nothing matches", async () => {
    const { win } = app();
    await openTab(win, "chat");
    const filter = history(win).locator("input.aos-ss-hfilter");
    await filter.fill("contours");
    await expect(history(win).locator(".aos-ss-hrow")).toHaveCount(1);
    await expect(history(win).locator(".aos-ss-htitle")).toHaveText(CODEX_ROW);
    await expect(filter).toBeFocused();
    await filter.fill("nothing like this");
    await expect(history(win).locator(".aos-ss-hempty")).toHaveText("No past session matches the filter.");
    await filter.fill("");
    await expect(history(win).locator(".aos-ss-hrow").first()).toBeVisible();
  });

  test("Skills says MCP servers moved and opens Connectors; with Codex off a server's sheet has Claude Code's row only and nothing to copy (B6, connectors-tab D2, D20)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "skills");
    const moved = content(win).locator(".aos-sk-mcpmoved a");
    await expect(moved).toHaveText("MCP servers and connectors moved to Connectors →");
    await moved.click();
    await expect(rail(win, "connectors")).toHaveClass(/is-active/);
    const m = expected().mcp;
    // Codex is off on this machine: its own server is not on the board, and nothing is offered to it.
    await expect(serverCard(win, m.codex)).toHaveCount(0);
    await serverCard(win, m.claude).click();
    await expect(sheetHost(win, "claude")).toHaveCount(1);
    await expect(sheetHost(win, "codex")).toHaveCount(0);
    await expect(content(win).locator("button.aos-con-copy")).toHaveCount(0);
    await win.keyboard.press("Escape");
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

  test("History: Claude Code's rows show without Resume; a Codex row resumes in Code with `codex resume -C <folder> <id>` in its workspace (B11, spaces-redesign D7)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "chat");
    // A host is signed in: Sessions opens on Vault as before; History is one click away.
    await expect(content(win).locator('.aos-ss-row[data-thread="vault"]')).toHaveClass(/is-selected/);
    await content(win).locator('.aos-ss-row[data-thread="history"]').click();
    await expect(content(win).locator(".aos-ss-hnohost")).toHaveCount(0);
    await expect(hrow(win, CLAUDE_ROW).locator("button.aos-ss-hresume")).toHaveCount(0);
    const resume = hrow(win, CODEX_ROW).locator("button.aos-ss-hresume");
    await expect(resume).toBeEnabled();
    await expect(resume).toHaveAttribute("title", "Resumes in workspaces/harbor-map");
    await resume.click();
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    const dir = FX.v("workspaces/harbor-map");
    const id = expected().history.digests.codex.id;
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain(`[fixture codex stub] resume -C ${dir} ${id}`);
    expectNoErrors(h);
  });

  test("Connectors: Claude Code is off, so its servers are not on the board and nothing is offered to either host (connectors-tab D20)", async () => {
    const { win } = app();
    await openTab(win, "connectors");
    const m = expected().mcp;
    await expect(serverCard(win, m.claude)).toHaveCount(0);
    await serverCard(win, m.codex).click();
    await expect(sheetHost(win, "codex")).toHaveCount(1);
    await expect(sheetHost(win, "claude")).toHaveCount(0);
    await expect(content(win).locator("button.aos-con-copy")).toHaveCount(0);
  });
});

test.describe("no host on this Mac", () => {
  const app = useApp({ prepare: () => { freshConnectorsCheck(); editJson(AGENTICOS, (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = false; }); } });

  test("History still lists what is on disk, with no Resume anywhere; Connectors says no host is on and offers nothing (B11 §5.6, B6)", async () => {
    const h = app();
    const { win } = h;
    await expect(rail(win, "chat")).toHaveCount(1);
    await openTab(win, "chat");
    await expect(content(win).locator(".aos-ss-hnohost")).toBeVisible();
    await expect(hrow(win, CLAUDE_ROW)).toHaveCount(1);
    await expect(hrow(win, CODEX_ROW)).toHaveCount(1);
    await expect(history(win).locator("button.aos-ss-hresume")).toHaveCount(0);
    await openTab(win, "connectors");
    await expect(content(win).locator(".aos-con-banner")).toHaveText("No host is on for this vault: Settings ▸ Hosts adds Claude Code or Codex.");
    await expect(content(win).locator(".aos-con-card")).toHaveCount(0);
    await expect(content(win).locator("button.aos-con-check")).toBeDisabled();
    expectNoErrors(h);
  });
});

// ── both hosts, the MCP servers surface on: the copy for real, against stand-in CLIs ──

const STUBS = path.join(FX.root, "mcp-stubs");
const STUB_LOG = path.join(STUBS, "calls.jsonl");
const stubCalls = (): Array<{ cli: string; argv: string[] }> =>
  (fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** `claude mcp add-json --scope user <name> <json>` and `codex mcp add <name> [--env K=V]… -- <cmd> [args…]`, as the real
 *  CLIs write them: into ~/.claude.json (the default config folder's file beside it) and $CODEX_HOME/config.toml. */
function installMcpStubs(): void {
  fs.rmSync(STUBS, { recursive: true, force: true });
  fs.mkdirSync(STUBS, { recursive: true });
  const head = (cli: string) => `#!${process.execPath}\nconst fs = require("fs"); const path = require("path");\nconst a = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(STUB_LOG)}, JSON.stringify({ cli: ${JSON.stringify(cli)}, argv: a }) + "\\n");\n`;
  fs.writeFileSync(path.join(STUBS, "claude"), `${head("claude")}const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(process.env.HOME, ".claude.json");\nconst j = JSON.parse(fs.readFileSync(file, "utf8"));\nj.mcpServers = { ...(j.mcpServers || {}), [a[4]]: JSON.parse(a[5]) };\nfs.writeFileSync(file, JSON.stringify(j, null, 2));\n`);
  fs.writeFileSync(path.join(STUBS, "codex"), `${head("codex")}const cut = a.indexOf("--");\nconst env = [];\nfor (let i = 3; i < cut; i += 2) env.push(a[i + 1]);\nlet t = "\\n[mcp_servers." + a[2] + "]\\ncommand = " + JSON.stringify(a[cut + 1]) + "\\nargs = " + JSON.stringify(a.slice(cut + 2)) + "\\n";\nif (env.length) t += "\\n[mcp_servers." + a[2] + ".env]\\n" + env.map((kv) => kv.split("=")[0] + " = " + JSON.stringify(kv.slice(kv.indexOf("=") + 1))).join("\\n") + "\\n";\nfs.appendFileSync(path.join(process.env.CODEX_HOME, "config.toml"), t);\n`);
  for (const cli of ["claude", "codex"]) fs.chmodSync(path.join(STUBS, cli), 0o755);
}

test.describe("both hosts, the MCP servers surface on", () => {
  const app = useApp({
    env: { AOS_APP_WRITE: "mcp", AOS_NO_CLAUDE: undefined, AOS_NO_CODEX: undefined, AOS_CLAUDE_BIN: path.join(STUBS, "claude"), AOS_CODEX_BIN: path.join(STUBS, "codex") },
    prepare: () => {
      editJson(AGENTICOS, (j) => { j.hosts.claude.enabled = true; j.hosts.codex.enabled = true; });
      // Codex signed in, Claude Code signed out: History's Resume follows each host's login.
      editJson(PROVIDER_STATE(), (j) => {
        const at = new Date().toISOString();
        j.claude = { loggedIn: false, checkedAt: at };
        j.codex = { loggedIn: true, checkedAt: at };
      });
      installMcpStubs();
      // Checked a moment ago: with surfaces on, a check of its own would start every server the fixture names.
      freshConnectorsCheck();
    },
  });

  test("History: a signed-out host's Resume is off with why, the signed-in host's on (B11, spaces-redesign D31)", async () => {
    const { win } = app();
    await openTab(win, "chat");
    await content(win).locator('.aos-ss-row[data-thread="history"]').click();
    const claude = hrow(win, CLAUDE_ROW);
    await expect(claude.locator("button.aos-ss-hresume")).toBeDisabled();
    await expect(claude.locator("button.aos-ss-hresume")).toHaveAttribute("title", "Claude Code is not logged in");
    await expect(claude.locator(".aos-ss-hwhy")).toHaveText("Claude Code is not logged in");
    await expect(hrow(win, CODEX_ROW).locator("button.aos-ss-hresume")).toBeEnabled();
  });

  test("Copy to Codex: the dry run's exact command and file in the confirm, nothing on Cancel; Add backs config.toml up and runs `codex mcp add` with the real values", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "connectors");
    const toml = path.join(FX.home, ".codex", "config.toml");
    const before = fs.readFileSync(toml, "utf8");
    await serverCard(win, "docs-search").click();
    const copy = sheetHost(win, "codex").locator('button.aos-con-copy[data-to="codex"]');
    await expect(copy).toHaveText("Copy to Codex");
    await copy.click();
    const modal = win.locator(".aos-confirm-modal");
    await expect(modal.locator("h3")).toHaveText("Make docs-search available on Codex?");
    const detail = modal.locator("pre.aos-confirm-detail");
    await expect(detail).toContainText("Writes ~/.codex/config.toml");
    // Outside the vault, in a folder the page never reads (security review 1).
    await expect(detail).toContainText(/Backs it up first to ~\/\.local\/share\/unidex\/backups\/mcp\/codex-config\.toml-\d{8}T\d{9}Z\.bak/);
    await expect(detail).toContainText("codex mcp add docs-search --env 'LOG_LEVEL=<redacted>' -- npx -y docs-search-mcp");
    await expect(modal.locator("p")).toContainText("Copies docs-search from Claude Code (~/.claude.json) through Codex's own CLI.");
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(modal).toHaveCount(0);
    expect(stubCalls()).toEqual([]);
    expect(fs.readFileSync(toml, "utf8")).toBe(before);

    await copy.click();
    await win.locator(".aos-confirm-modal button.mod-cta", { hasText: "Add to Codex" }).click();
    await expect(win.locator(".notice-container")).toContainText(/docs-search is on Codex now \(backup: ~\/\.local\/share\/unidex\/backups\/mcp\/codex-config\.toml-\d{8}T\d{9}Z\.bak\)/);
    expect(stubCalls()).toEqual([{ cli: "codex", argv: ["mcp", "add", "docs-search", "--env", "LOG_LEVEL=warn", "--", "npx", "-y", "docs-search-mcp"] }]);
    const dir = path.join(FX.home, ".local", "share", "unidex", "backups", "mcp");
    const backups = fs.readdirSync(dir).filter((n) => n.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups[0]), "utf8")).toBe(before);
    expect((fs.statSync(path.join(dir, backups[0])).mode & 0o777).toString(8)).toBe("600");
    expect(fs.existsSync(FX.v("brain/_index/backups"))).toBe(false);
    // The page cannot read it: main refuses a backup's path whatever asks (read-scope deniedDirs).
    const read = await win.evaluate((p) => (window as unknown as { aos: { fs: { readText(p: string): Promise<{ ok: boolean; error?: string }> } } }).aos.fs.readText(p), path.join(dir, backups[0]));
    expect(read).toMatchObject({ ok: false });
    // Listed again (aos mcp list): the card is on both hosts now, and its sheet has nothing to offer.
    await expect(serverCard(win, "docs-search").locator(".aos-con-dot.is-codex:not(.is-absent)")).toHaveCount(1);
    await expect(sheetHost(win, "codex").locator(".aos-con-scope")).toHaveText("user · ~/.codex/config.toml");
    await expect(content(win).locator("button.aos-con-copy")).toHaveCount(0);
    // Esc closes the sheet though the confirm took the focus away from it.
    await win.keyboard.press("Escape");
    await expect(content(win).locator("aside.aos-con-sheet")).toHaveCount(0);
    expectNoErrors(h);
  });

  test("Copy to Claude Code: `claude mcp add-json --scope user` with Codex's command, args and env", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "connectors");
    await serverCard(win, "issue-tracker").click();
    await sheetHost(win, "claude").locator('button.aos-con-copy[data-to="claude"]').click();
    const modal = win.locator(".aos-confirm-modal");
    await expect(modal.locator("pre.aos-confirm-detail")).toContainText(`claude mcp add-json --scope user issue-tracker '{"type":"stdio","command":"issue-mcp","args":["--stdio"],"env":{"LOG_LEVEL":"<redacted>"}}'`);
    await expect(modal.locator("pre.aos-confirm-detail")).toContainText("Writes ~/.claude.json");
    await modal.locator("button.mod-cta", { hasText: "Add to Claude Code" }).click();
    await expect(win.locator(".notice-container")).toContainText("issue-tracker is on Claude Code now");
    expect(stubCalls().filter((c) => c.cli === "claude")).toEqual([{ cli: "claude", argv: ["mcp", "add-json", "--scope", "user", "issue-tracker", JSON.stringify({ type: "stdio", command: "issue-mcp", args: ["--stdio"], env: { LOG_LEVEL: "warn" } })] }]);
    expect(JSON.parse(fs.readFileSync(path.join(FX.home, ".claude.json"), "utf8")).mcpServers["issue-tracker"]).toEqual({ type: "stdio", command: "issue-mcp", args: ["--stdio"], env: { LOG_LEVEL: "warn" } });
    await expect(serverCard(win, "issue-tracker").locator(".aos-con-dot.is-claude:not(.is-absent)")).toHaveCount(1);
    await expect(sheetHost(win, "claude").locator(".aos-con-scope")).toHaveText("user · ~/.claude.json");
    expectNoErrors(h);
  });
});
