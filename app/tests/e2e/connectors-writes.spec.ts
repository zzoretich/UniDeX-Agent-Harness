// The Connectors tab's actions (spec 2026-10-23-connectors-tab D16–D18, D21, A1, A2): a server's sheet Park, Turn on and
// Remove, and the header's Add server, each through the vault's own `aos mcp park|unpark|remove|add` run by the app's
// policy with the `mcp-manage` surface on (AOS_APP_WRITE), against stand-in `claude` and `codex` CLIs that log their argv
// and change the entry the way the real ones do: a dry run, its exact commands in the confirm, then the run naming the
// dry run's hash. With the surface off (the default) every action is refused and its notice names the command for a Code
// terminal. On both hosts and on a Codex-only machine (app-smoke: Connectors ▸ Park, Turn on, Remove, Add server).

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, content, expected, expectNoErrors, freshConnectorsCheck, openTab, useApp } from "./harness";

const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};
const AGENTICOS = path.join(FX.claude, "agenticos.json");
const CLAUDE_JSON = () => path.join(FX.home, ".claude.json");
const TOML = () => path.join(FX.home, ".codex", "config.toml");
const PARKED = () => path.join(FX.home, ".local", "share", "unidex", "parked", "mcp");

const C = (win: Page) => content(win);
const card = (win: Page, key: string) => C(win).locator(`[data-conn="${key}"]`).first();
const sheet = (win: Page) => C(win).locator("aside.aos-con-sheet");
const hostRow = (win: Page, h: string) => sheet(win).locator(`.aos-con-hostrow[data-host="${h}"]`);
const verb = (win: Page, h: string, v: string) => hostRow(win, h).locator(`button.aos-con-manage[data-verb="${v}"]`);
const modal = (win: Page) => win.locator(".aos-confirm-modal");
const addSheet = (win: Page) => win.locator(".aos-con-addsheet");
const field = (win: Page, f: string) => addSheet(win).locator(`[data-field="${f}"]`);

const STUBS = path.join(FX.root, "mcp-manage-stubs");
const STUB_LOG = path.join(STUBS, "calls.jsonl");
const stubCalls = (): Array<{ cli: string; argv: string[] }> =>
  (fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/**
 * `claude mcp add-json --scope user <name> <json>` and `claude mcp remove <name> --scope user`; `codex mcp add <name>
 * [--env K=V]… -- <cmd> [args…]`, `codex mcp add <name> --url <url> [--bearer-token-env-var V]` and `codex mcp remove
 * <name>`, as the real CLIs write them: into ~/.claude.json (the default config folder's file beside it) and
 * $CODEX_HOME/config.toml.
 */
function installStubs(): void {
  fs.rmSync(STUBS, { recursive: true, force: true });
  fs.mkdirSync(STUBS, { recursive: true });
  const head = (cli: string) => `#!${process.execPath}\nconst fs = require("fs"); const path = require("path");\nconst a = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(STUB_LOG)}, JSON.stringify({ cli: ${JSON.stringify(cli)}, argv: a }) + "\\n");\n`;
  fs.writeFileSync(path.join(STUBS, "claude"), head("claude") + String.raw`const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(process.env.HOME, ".claude.json");
const j = JSON.parse(fs.readFileSync(file, "utf8"));
if (a[1] === "remove") delete j.mcpServers[a[2]];
else j.mcpServers = { ...(j.mcpServers || {}), [a[4]]: JSON.parse(a[5]) };
fs.writeFileSync(file, JSON.stringify(j, null, 2));
`);
  fs.writeFileSync(path.join(STUBS, "codex"), head("codex") + String.raw`const toml = path.join(process.env.CODEX_HOME, "config.toml");
const name = a[2];
if (a[1] === "remove") {
  const re = new RegExp("^\\s*\\[mcp_servers\\." + name + "(\\.[^\\]]*)?\\]\\s*$");
  let skip = false;
  const out = [];
  for (const l of fs.readFileSync(toml, "utf8").split("\n")) { if (/^\s*\[/.test(l)) skip = re.test(l); if (!skip) out.push(l); }
  fs.writeFileSync(toml, out.join("\n"));
} else if (a[3] === "--url") {
  fs.appendFileSync(toml, "\n[mcp_servers." + name + "]\nurl = " + JSON.stringify(a[4]) + "\n" + (a[5] ? "bearer_token_env_var = " + JSON.stringify(a[6]) + "\n" : ""));
} else {
  const cut = a.indexOf("--");
  const env = [];
  for (let i = 3; i < cut; i += 2) env.push(a[i + 1]);
  let t = "\n[mcp_servers." + name + "]\ncommand = " + JSON.stringify(a[cut + 1]) + "\nargs = " + JSON.stringify(a.slice(cut + 2)) + "\n";
  if (env.length) t += "\n[mcp_servers." + name + ".env]\n" + env.map((kv) => kv.split("=")[0] + " = " + JSON.stringify(kv.slice(kv.indexOf("=") + 1))).join("\n") + "\n";
  fs.appendFileSync(toml, t);
}
`);
  for (const cli of ["claude", "codex"]) fs.chmodSync(path.join(STUBS, cli), 0o755);
}

const ON = { AOS_APP_WRITE: "mcp-manage", AOS_NO_CLAUDE: undefined, AOS_NO_CODEX: undefined, AOS_CLAUDE_BIN: path.join(STUBS, "claude"), AOS_CODEX_BIN: path.join(STUBS, "codex") };
const hosts = (claude: boolean, codex: boolean) => () => {
  editJson(AGENTICOS, (j) => { j.hosts.claude.enabled = claude; j.hosts.codex.enabled = codex; });
  installStubs();
  // Checked a moment ago: with a surface on, a check of its own would start every server the fixture names.
  freshConnectorsCheck();
};

test.describe("both hosts, MCP server changes on", () => {
  const app = useApp({ env: ON, prepare: hosts(true, true) });

  test("Park: the confirm names the remove, the file, its backup and the stash; Cancel runs nothing; Park runs `claude mcp remove --scope user`, keeps the entry 0600, and Turn on puts it back unchanged", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "connectors");
    const name = expected().mcp.claude;
    const before = JSON.parse(fs.readFileSync(CLAUDE_JSON(), "utf8")).mcpServers[name];
    await card(win, `s:${name}`).click();
    await expect(verb(win, "claude", "park")).toHaveText("Park");
    await expect(verb(win, "claude", "remove")).toHaveText("Remove");
    await expect(verb(win, "claude", "remove")).toHaveClass(/is-danger/);
    await verb(win, "claude", "park").click();
    await expect(modal(win).locator("h3")).toHaveText(`Park ${name}?`);
    await expect(modal(win).locator("p")).toHaveText("Removes it from Claude Code and keeps its exact settings in a private stash outside the vault; Turn on puts it back unchanged.");
    const detail = modal(win).locator("pre.aos-confirm-detail");
    await expect(detail).toContainText("Writes ~/.claude.json");
    await expect(detail).toContainText(/Backs it up first to ~\/\.local\/share\/unidex\/backups\/mcp\/claude-claude\.json-\d{8}T\d{9}Z\.bak/);
    await expect(detail).toContainText(`Keeps its exact entry in ~/.local/share/unidex/parked/mcp/claude-${name}.json`);
    await expect(detail).toContainText(`claude mcp remove ${name} --scope user`);
    await modal(win).locator("button", { hasText: "Cancel" }).click();
    await expect(modal(win)).toHaveCount(0);
    expect(stubCalls()).toEqual([]);

    await verb(win, "claude", "park").click();
    await modal(win).locator("button.mod-cta", { hasText: "Park" }).click();
    await expect(win.locator(".notice-container")).toContainText(new RegExp(`${name} is parked: off Claude Code, its exact settings kept for Turn on \\(backup: ~/\\.local/share/unidex/backups/mcp/claude-claude\\.json-\\d{8}T\\d{9}Z\\.bak\\)`));
    expect(stubCalls()).toEqual([{ cli: "claude", argv: ["mcp", "remove", name, "--scope", "user"] }]);
    expect(JSON.parse(fs.readFileSync(CLAUDE_JSON(), "utf8")).mcpServers[name]).toBeUndefined();
    const stash = path.join(PARKED(), `claude-${name}.json`);
    expect((fs.statSync(stash).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(fs.readFileSync(stash, "utf8")).entry).toEqual(before);
    // The page cannot read the stash: main refuses its path whatever asks (read-scope deniedDirs).
    const read = await win.evaluate((p) => (window as unknown as { aos: { fs: { readText(p: string): Promise<{ ok: boolean }> } } }).aos.fs.readText(p), stash);
    expect(read).toMatchObject({ ok: false });
    // Listed again: the sheet stays on it, off with how to bring it back; Turn on in place of Park and Remove.
    await expect(hostRow(win, "claude").locator(".aos-con-pill")).toHaveText("Off");
    await expect(hostRow(win, "claude").locator(".aos-con-scope")).toHaveText("user · parked · Turn on puts it back in ~/.claude.json");
    await expect(hostRow(win, "claude").locator("button.aos-con-manage")).toHaveText(["Turn on"]);

    await verb(win, "claude", "unpark").click();
    await expect(modal(win).locator("h3")).toHaveText(`Turn ${name} back on?`);
    await expect(modal(win).locator("pre.aos-confirm-detail")).toContainText(`claude mcp add-json --scope user ${name} '{"type":"stdio","command":"npx","args":["-y","docs-search-mcp"],"env":{"LOG_LEVEL":"<redacted>"}}'`);
    await expect(modal(win).locator("pre.aos-confirm-detail")).toContainText(`From ~/.local/share/unidex/parked/mcp/claude-${name}.json, deleted once Claude Code lists it`);
    await modal(win).locator("button.mod-cta", { hasText: "Turn on" }).click();
    await expect(win.locator(".notice-container")).toContainText(`${name} is back on Claude Code.`);
    expect(stubCalls()[1]).toEqual({ cli: "claude", argv: ["mcp", "add-json", "--scope", "user", name, JSON.stringify(before)] });
    expect(JSON.parse(fs.readFileSync(CLAUDE_JSON(), "utf8")).mcpServers[name]).toEqual(before);
    expect(fs.existsSync(stash)).toBe(false);
    await expect(hostRow(win, "claude").locator("button.aos-con-manage")).toHaveText(["Park", "Remove"]);
    await win.keyboard.press("Escape");
    expectNoErrors(h);
  });

  test("Remove: the confirm is in the danger tone and says nothing is stashed; `codex mcp remove` runs and the card leaves the board", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "connectors");
    const name = expected().mcp.codex;
    await card(win, `s:${name}`).click();
    await verb(win, "codex", "remove").click();
    await expect(modal(win).locator("h3")).toHaveText(`Remove ${name} from Codex?`);
    await expect(modal(win).locator("p")).toContainText("nothing is stashed, so Turn on cannot bring it back");
    await expect(modal(win).locator("pre.aos-confirm-detail")).toContainText(`codex mcp remove ${name}`);
    await expect(modal(win).locator("pre.aos-confirm-detail")).not.toContainText("parked");
    const ok = modal(win).locator("button.mod-warning");
    await expect(ok).toHaveText("Remove");
    const n = stubCalls().length;
    await ok.click();
    await expect(win.locator(".notice-container")).toContainText(`${name} is removed from Codex`);
    expect(stubCalls().slice(n)).toEqual([{ cli: "codex", argv: ["mcp", "remove", name] }]);
    expect(fs.readFileSync(TOML(), "utf8")).not.toContain(name);
    await expect(card(win, `s:${name}`)).toHaveCount(0);
    await expect(sheet(win)).toHaveCount(0);
    // Rows no action takes say what to do instead: the vault's own server.
    await card(win, "s:agenticos").click();
    await expect(hostRow(win, "claude").locator("button.aos-con-manage")).toHaveCount(0);
    await expect(hostRow(win, "claude").locator(".aos-con-instead")).toHaveText("The vault's own server: aos init and aos hosts add wire it on each host.");
    await win.keyboard.press("Escape");
    expectNoErrors(h);
  });

  test("Add server to both: names only (NAME ← $VAR), the review shows each host's exact command and Codex's env_vars line with Copy; Add to both runs them", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "connectors");
    const n0 = stubCalls().length;
    await C(win).locator('button.aos-con-add[data-tour="connectors-add"]').click();
    await expect(addSheet(win).locator("h3")).toHaveText("Add MCP server");
    await expect(field(win, "name")).toBeFocused();
    await expect(addSheet(win).locator(".aos-con-check")).toHaveText(["Claude Codeuser scope", "Codexconfig.toml"]);
    await expect(addSheet(win).locator(".aos-con-note").first()).toHaveText("UniDeX keeps the variable's name, never its value. The server reads it from your environment each time it starts.");
    // A value where a variable's name belongs is refused before anything runs.
    await field(win, "name").fill("gh-tools");
    await field(win, "command").fill("npx -y gh-mcp");
    await field(win, "key:0").fill("GITHUB_TOKEN");
    await field(win, "var:0").fill("tok-pasted-value");
    await field(win, "review").click();
    await expect(addSheet(win).locator(".aos-con-adderror")).toHaveText("Give GITHUB_TOKEN the name of a variable, such as $GITHUB_TOKEN: upper case, digits and _, never the value itself.");
    expect(stubCalls().slice(n0)).toEqual([]);
    await field(win, "var:0").fill("$GH");
    await field(win, "review").click();
    await expect(modal(win).locator("h3")).toHaveText("Add gh-tools to Claude Code and Codex?");
    await expect(modal(win).locator("p")).toContainText("Secrets go by name only (GITHUB_TOKEN ← $GH)");
    const detail = modal(win).locator("pre.aos-confirm-detail");
    await expect(detail).toContainText(`claude mcp add-json --scope user gh-tools '{"type":"stdio","command":"npx","args":["-y","gh-mcp"],"env":{"GITHUB_TOKEN":"\${GH}"}}'`);
    await expect(detail).toContainText("codex mcp add gh-tools -- npx -y gh-mcp");
    await expect(detail).toContainText('Then paste under [mcp_servers.gh-tools] in ~/.codex/config.toml:\n  env_vars = ["GITHUB_TOKEN"]');
    await expect(modal(win).locator("button.aos-confirm-copy")).toHaveText("Copy env_vars line");
    const n = stubCalls().length;
    await modal(win).locator("button.mod-cta", { hasText: "Add to both" }).click();
    await expect(win.locator(".notice-container")).toContainText('gh-tools is on Claude Code and Codex now. For Codex, paste env_vars = ["GITHUB_TOKEN"] under [mcp_servers.gh-tools] in ~/.codex/config.toml.');
    expect(stubCalls().slice(n)).toEqual([
      { cli: "claude", argv: ["mcp", "add-json", "--scope", "user", "gh-tools", JSON.stringify({ type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "${GH}" } })] },
      { cli: "codex", argv: ["mcp", "add", "gh-tools", "--", "npx", "-y", "gh-mcp"] },
    ]);
    expect(JSON.parse(fs.readFileSync(CLAUDE_JSON(), "utf8")).mcpServers["gh-tools"].env).toEqual({ GITHUB_TOKEN: "${GH}" });
    await expect(card(win, "s:gh-tools").locator(".aos-con-dot.is-claude:not(.is-absent)")).toHaveCount(1);
    await expect(card(win, "s:gh-tools").locator(".aos-con-dot.is-codex:not(.is-absent)")).toHaveCount(1);
    expectNoErrors(h);
  });
});

test.describe("both hosts, the write surfaces as they ship (MCP server changes off)", () => {
  const app = useApp({ env: { AOS_NO_CLAUDE: undefined, AOS_NO_CODEX: undefined, AOS_CLAUDE_BIN: path.join(STUBS, "claude"), AOS_CODEX_BIN: path.join(STUBS, "codex") }, prepare: hosts(true, true) });

  test("Park and Add server are refused with no confirm, and the notice says so and names the exact aos mcp command for a Code terminal", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "connectors");
    const name = expected().mcp.claude;
    await card(win, `s:${name}`).click();
    await verb(win, "claude", "park").click();
    await expect(win.locator(".notice-container")).toContainText(`Park ${name}: refused, since MCP server changes are off in this app's write access — run aos mcp park ${name} --host claude in the Code tab instead`);
    await expect(modal(win)).toHaveCount(0);
    await expect(verb(win, "claude", "park")).toHaveText("Park");
    await win.keyboard.press("Escape");
    await C(win).locator("button.aos-con-add").click();
    await field(win, "name").fill("gh-tools");
    await field(win, "command").fill("npx -y gh-mcp");
    await field(win, "key:0").fill("GITHUB_TOKEN");
    await field(win, "var:0").fill("$GH");
    await field(win, "review").click();
    await expect(win.locator(".notice-container")).toContainText("Add gh-tools: refused, since MCP server changes are off in this app's write access — run aos mcp add gh-tools --to both --command npx --arg -y --arg gh-mcp --env 'GITHUB_TOKEN=$GH' in the Code tab instead");
    await expect(modal(win)).toHaveCount(0);
    expect(stubCalls()).toEqual([]);
    expect(fs.existsSync(PARKED())).toBe(false);
    expectNoErrors(h);
  });
});

test.describe("a Codex-only machine, MCP server changes on", () => {
  const app = useApp({ env: ON, prepare: hosts(false, true) });

  test("Add server offers Codex alone; a remote server goes as `codex mcp add --url` with its token's variable; Park on Codex runs `codex mcp remove`", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "connectors");
    await C(win).locator("button.aos-con-add").click();
    await expect(addSheet(win).locator(".aos-con-check")).toHaveText(["Codexconfig.toml"]);
    await addSheet(win).locator('[data-kind="remote"]').click();
    await expect(addSheet(win).locator(".aos-con-keyfixed")).toHaveText("Authorization: Bearer");
    await field(win, "name").fill("charts");
    await field(win, "url").fill("https://charts.example.com/mcp");
    await field(win, "var:0").fill("$CHARTS_TOKEN");
    await field(win, "review").click();
    await expect(modal(win).locator("h3")).toHaveText("Add charts to Codex?");
    await expect(modal(win).locator("pre.aos-confirm-detail")).toContainText("codex mcp add charts --url https://charts.example.com/mcp --bearer-token-env-var CHARTS_TOKEN");
    await expect(modal(win).locator("button.aos-confirm-copy")).toHaveCount(0);
    await modal(win).locator("button.mod-cta", { hasText: "Add to Codex" }).click();
    await expect(win.locator(".notice-container")).toContainText("charts is on Codex now.");
    expect(stubCalls()).toEqual([{ cli: "codex", argv: ["mcp", "add", "charts", "--url", "https://charts.example.com/mcp", "--bearer-token-env-var", "CHARTS_TOKEN"] }]);
    expect(fs.readFileSync(TOML(), "utf8")).toContain('[mcp_servers.charts]\nurl = "https://charts.example.com/mcp"\nbearer_token_env_var = "CHARTS_TOKEN"');
    const name = expected().mcp.codex;
    await card(win, `s:${name}`).click();
    await expect(sheet(win).locator(".aos-con-hostrow")).toHaveCount(1);
    await verb(win, "codex", "park").click();
    await expect(modal(win).locator("pre.aos-confirm-detail")).toContainText(`codex mcp remove ${name}`);
    await modal(win).locator("button.mod-cta", { hasText: "Park" }).click();
    await expect(win.locator(".notice-container")).toContainText(`${name} is parked: off Codex`);
    expect(stubCalls()[1]).toEqual({ cli: "codex", argv: ["mcp", "remove", name] });
    expect(JSON.parse(fs.readFileSync(path.join(PARKED(), `codex-${name}.json`), "utf8")).entry).toEqual({ command: "issue-mcp", args: ["--stdio"], env: { LOG_LEVEL: "warn" } });
    await expect(hostRow(win, "codex").locator("button.aos-con-manage")).toHaveText(["Turn on"]);
    await win.keyboard.press("Escape");
    expectNoErrors(h);
  });
});
