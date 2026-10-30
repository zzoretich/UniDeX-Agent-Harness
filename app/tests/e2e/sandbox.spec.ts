// Phase 4: the page is sandboxed. It has no Node, its window runs with Chromium's sandbox and context isolation, it
// reaches main only through window.aos's named functions, and main refuses what the policy does not name: a read
// outside the vault and the hosts' folders, a credential file, a write outside the surfaces, a shell, a planted program
// or variable, a terminal running something other than a shell, a link that is not https, a file that would run when
// opened, and anyone but the app's own page. Phase 5 adds setup and updates: a fix (a download or a login) is named by
// id only, and each setup step, the PATH line, the import and the unwire included, is refused outside the state it
// belongs to.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, useApp } from "./harness";

const app = useApp({
  prepare: () => {
    fs.mkdirSync(path.join(FX.home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(FX.home, ".codex", "auth.json"), "{\"token\":\"fixture-secret\"}\n");
    fs.writeFileSync(FX.v("workspaces/run-me.terminal"), "<plist/>\n");
  },
});

type Aos = import("../../src/shared/ipc").AosBridge;
const call = <T>(fn: (aos: Aos, arg: string) => T, arg = "") =>
  app().win.evaluate(([f, a]) => (0, eval)(`(${f})`)((window as unknown as { aos: Aos }).aos, a), [fn.toString(), arg] as const) as Promise<T>;

test("the page has no Node: no require, process, module, Buffer or Electron", async () => {
  const globals = await app().win.evaluate(() => ["require", "process", "module", "Buffer", "global", "__dirname", "ipcRenderer", "electron"]
    .filter((g) => typeof (window as unknown as Record<string, unknown>)[g] !== "undefined"));
  expect(globals).toEqual([]);
});

test("the main window runs sandboxed, isolated, with no Node, and loads the app's own page", async () => {
  const prefs = await app().app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith("app://hud/"))!;
    // Not in Electron's typings, but present: the preferences the window's page actually runs with.
    const p = (w.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webviewTag: p.webviewTag, url: w.webContents.getURL() };
  });
  expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, url: "app://hud/index.html" });
});

test("window.aos is named functions only: no channel, no ipcRenderer, no generic send", async () => {
  const shape = await app().win.evaluate(() => {
    const aos = (window as unknown as { aos: Record<string, unknown> }).aos;
    const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
    return { top: keys(aos), fs: keys(aos.fs as Record<string, unknown>), proc: keys(aos.proc as Record<string, unknown>), pty: keys(aos.pty as Record<string, unknown>),
      shell: keys(aos.shell as Record<string, unknown>), plugin: keys(aos.plugin as Record<string, unknown>),
      setup: keys(aos.setup as Record<string, unknown>), update: keys(aos.update as Record<string, unknown>), theme: keys(aos.theme as Record<string, unknown>),
      sessions: keys(aos.sessions as Record<string, unknown>), git: keys(aos.git as Record<string, unknown>),
      proposals: keys(aos.proposals as Record<string, unknown>) };
  });
  expect(shape.top).toEqual(["boot", "fs", "git", "onCommand", "onProtocol", "onVaultChanges", "plugin", "proc", "proposals", "pty", "ready", "sessions", "setup", "shell", "theme", "update"]);
  expect(shape.proposals).toEqual(["apply", "preview", "reject", "undo", "undos"]);
  expect(shape.fs).toEqual(["appendText", "copy", "exists", "mkdir", "readBytes", "readText", "readdir", "remove", "rename", "stat", "trash", "walk", "writeText"]);
  expect(shape.proc).toEqual(["execSync", "kill", "onEvent", "spawn"]);
  expect(shape.pty).toEqual(["available", "kill", "onEvent", "resize", "spawn", "write"]);
  expect(shape.shell).toEqual(["openExternal", "openPath", "showItemInFolder"]);
  expect(shape.plugin).toEqual(["loadData", "saveData"]);
  expect(shape.setup).toEqual(["addToPath", "applyClaudeMd", "cancel", "chooseVault", "claudeMd", "finish", "fix", "importHistory", "importScan", "input", "install", "noted", "onEvent", "pathLine", "preflight", "resize", "unwire", "upgrade"]);
  expect(shape.update).toEqual(["check", "install", "onState", "state"]);
  expect(shape.theme).toEqual(["onChange", "set", "state"]);
  expect(shape.sessions).toEqual(["catalog", "list", "onEvent", "read", "send", "start", "stop"]);
  expect(shape.git).toEqual(["commit", "diff", "status"]);
});

test("proposal decisions reject paths, malformed hashes and unknown undo records", async () => {
  expect(await call((aos) => aos.proposals.preview("../persona/IDENTITY.md"))).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await call((aos) => aos.proposals.apply("2026-10-30-test.md", "bad-hash", "bad-token"))).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await call((aos) => aos.proposals.undo("../outside"))).toMatchObject({ ok: false, code: "EINVAL" });
});

test("setup names a fix by id only, and refuses each step outside its state", async () => {
  // A command, or a fix the table does not have (Homebrew's and Python's are gone, install-import B1), does not parse.
  expect(await call((aos) => (aos.setup.fix as (id: string, c: number, r: number) => unknown)("rm -rf ~", 80, 24))).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await call((aos) => (aos.setup.fix as (id: string, c: number, r: number) => unknown)("homebrew", 80, 24))).toMatchObject({ ok: false, code: "EINVAL" });
  // A download is named by its fix id too, and is the wizard's: with a vault attached, refused before anything is fetched.
  expect(await call((aos) => aos.setup.fix("node", 80, 24))).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  // The checks and fix-its are the wizard's: with a vault attached, refused.
  expect(await call((aos) => aos.setup.fix("uv", 80, 24))).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  expect(await call((aos) => aos.setup.fix("ollama-models", 80, 24))).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  expect(await call((aos) => aos.setup.preflight())).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  // A vault is attached: no install, no second attach; no payload in a dev run: no upgrade.
  expect(await call((aos) => aos.setup.install({ host: "claude", vault: "~/Elsewhere", persona: null }))).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  expect(await call((aos) => aos.setup.finish())).toMatchObject({ ok: false, code: "EROFS" });
  expect(await call((aos) => aos.setup.upgrade())).toMatchObject({ ok: false, code: "EROFS", error: "this build carries no runtime" });
  expect(await call((aos) => aos.setup.chooseVault())).toBeNull();
  // A persona name the interview would refuse, or a host that is not one, does not parse.
  const persona = { name: "x", addressAs: "", voice: "", priorities: [], dutyModel: "", dutyCodexModel: "", dutyEffort: "medium", schedule: false };
  expect(await call((aos, p) => aos.setup.install({ host: "claude", vault: "~/V", persona: JSON.parse(p) }), JSON.stringify(persona))).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await call((aos) => aos.setup.install({ host: "all" as "both", vault: "~/V", persona: null }))).toMatchObject({ ok: false, code: "EINVAL" });
  // No host is a choice (install-import B2) that parses, and is refused like any install once a vault is attached.
  expect(await call((aos) => aos.setup.install({ host: "none", vault: "~/V", persona: null }))).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  // The PATH line is Finish's (B14): main names the file and the line, and neither is offered once a vault is attached.
  expect(await call((aos) => aos.setup.pathLine())).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  expect(await call((aos) => aos.setup.addToPath())).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  expect(fs.existsSync(path.join(FX.home, ".zprofile"))).toBe(false);
  // Bring in your history (install-import B13) is the wizard's, after its install; the unwire (inspection F7), before it.
  // Neither runs once a vault is attached, and each takes only hosts, kinds and proposal ids.
  expect(await call((aos) => aos.setup.importScan())).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  expect(await call((aos) => aos.setup.importHistory({ from: ["claude"], only: ["mcp"], accept: [] }))).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  expect(await call((aos) => aos.setup.unwire("codex", "claude"))).toMatchObject({ ok: false, code: "EROFS", error: "a vault is already attached" });
  type Setup = { importHistory(r: unknown): unknown; unwire(h: unknown, c?: unknown): unknown };
  for (const bad of [{ from: ["cursor"], only: ["mcp"], accept: [] }, { from: ["claude"], only: ["secrets"], accept: [] }, { from: ["claude", "claude"], only: ["mcp"], accept: [] },
    { from: ["claude"], only: ["mcp"], accept: [], argv: ["--yes"] }, { from: [], only: ["mcp"], accept: [] }, { from: ["claude"], only: ["mcp"] }]) {
    expect(await call((aos, b) => (aos.setup as unknown as Setup).importHistory(JSON.parse(b)), JSON.stringify(bad))).toMatchObject({ ok: false, code: "EINVAL" });
  }
  expect(await call((aos) => (aos.setup as unknown as Setup).unwire("all", "claude"))).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await call((aos) => (aos.setup as unknown as Setup).unwire("codex"))).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await call((aos) => (aos.setup as unknown as Setup).unwire("codex", "everything"))).toMatchObject({ ok: false, code: "EINVAL" });
  // The CLAUDE.md preview names the attached vault's line; the page sends no path.
  const md = await call((aos) => aos.setup.claudeMd());
  expect(md).toMatchObject({ ok: true, data: { line: `@${FX.v("AGENTICOS.md")}` } });
  // Updates are off in a dev run.
  expect(await call((aos) => aos.update.state())).toMatchObject({ status: "off", reason: "a development run" });
  // The theme takes one of its three choices, nothing else.
  expect(await call((aos) => (aos.theme.set as (s: string) => unknown)("sepia"))).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await call((aos) => aos.theme.state())).toMatchObject({ source: "system" });
  // This run is read-only, Sessions included (spec 2026-10-07-unidex-sessions): nothing starts, nothing in git is read.
  type Sess = { start(r: unknown): Promise<unknown>; list(): Promise<unknown>; catalog(refresh?: unknown): Promise<unknown> };
  type Git = { status(w: string): Promise<unknown> };
  expect(await call((aos) => (aos.sessions as unknown as Sess).start({ workspace: "harbor-map", host: "claude", text: "hi" }))).toMatchObject({ ok: false, code: "EROFS" });
  expect(await call((aos) => (aos.sessions as unknown as Sess).list())).toMatchObject({ ok: false, code: "EROFS" });
  expect(await call((aos) => (aos.sessions as unknown as Sess).catalog())).toMatchObject({ ok: false, code: "EROFS" });
  expect(await call((aos) => (aos.git as unknown as Git).status("harbor-map"))).toMatchObject({ ok: false, code: "EROFS" });
  // A workspace that could leave the folder, or a host that is not one, never reaches main's service.
  expect(await call((aos) => (aos.sessions as unknown as Sess).start({ workspace: "../x", host: "claude", text: "hi" }))).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await call((aos) => (aos.sessions as unknown as Sess).start({ workspace: "harbor-map", host: "sh", text: "hi" }))).toMatchObject({ ok: false, code: "EINVAL" });
  // An access level or an effort that is not one, or a model that reads as a flag (sessions-ux U6, U7).
  expect(await call((aos) => (aos.sessions as unknown as Sess).start({ workspace: "harbor-map", host: "claude", text: "hi", access: "root" }))).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await call((aos) => (aos.sessions as unknown as Sess).start({ workspace: "harbor-map", host: "codex", text: "hi", effort: "turbo" }))).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await call((aos) => (aos.sessions as unknown as Sess).start({ workspace: "harbor-map", host: "claude", text: "hi", model: "--dangerously-skip-permissions" }))).toMatchObject({ ok: false, code: "EINVAL" });
});

test("reads stay inside the vault and the hosts' folders, and never return a credential", async () => {
  expect(await call((aos, v) => aos.fs.readText(`${v}/TODO.md`).ok, FX.vault)).toBe(true);
  expect(await call((aos) => aos.fs.readText("/etc/passwd"))).toMatchObject({ ok: false, code: "EROFS" });
  expect(await call((aos) => aos.fs.readdir("/"))).toMatchObject({ ok: false, code: "EROFS" });
  expect(await call((aos, h) => aos.fs.readText(`${h}/.codex/auth.json`), FX.home)).toMatchObject({ ok: false, code: "EROFS" });
  expect(await call((aos, v) => aos.fs.readText(`${v}/../env.json`), FX.vault)).toMatchObject({ ok: false, code: "EROFS" });
  expect(await call((aos) => aos.fs.readText("relative/TODO.md"))).toMatchObject({ ok: false, code: "EINVAL" });
});

test("writes outside the surfaces are refused, and leave the disk as it was (this run is read-only)", async () => {
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  expect(await call((aos, v) => aos.fs.writeText(`${v}/TODO.md`, "x", "hud"), FX.vault)).toMatchObject({ ok: false, code: "EROFS" });
  expect(await call((aos, r) => aos.fs.writeText(`${r}/outside.md`, "x", "hud"), FX.root)).toMatchObject({ ok: false, code: "EROFS" });
  expect(await call((aos, v) => aos.fs.writeText(`${v}/.claude/settings.json`, "{}", "editor"), FX.vault)).toMatchObject({ ok: false, code: "EROFS" });
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  expect(fs.existsSync(path.join(FX.root, "outside.md"))).toBe(false);
});

test("a spawn runs only a named runtime command: no shell, no planted program, no injected variable", async () => {
  const spawn = (req: object) => call((aos, r) => aos.proc.spawn(JSON.parse(r)), JSON.stringify(req));
  const node = await app().win.evaluate(() => (window as unknown as { aosHost: { plugin: { nodeBin(): string } } }).aosHost.plugin.nodeBin());
  const scan = { cmd: node, args: [FX.v("brain/scripts/scan-vault.js"), "--quiet"], cwd: FX.vault, stdio: "ignore" };
  expect(await spawn({ id: "sbx-shell", cmd: "/bin/sh", args: ["-c", "id"], cwd: FX.vault })).toMatchObject({ ok: false, code: "EROFS" });
  expect(await spawn({ id: "sbx-inline", cmd: node, args: ["-e", "1"], cwd: FX.vault })).toMatchObject({ ok: false, code: "EROFS" });
  expect(await spawn({ id: "sbx-env", ...scan, env: { NODE_OPTIONS: "--require /tmp/x.js" } })).toMatchObject({ ok: false, code: "EROFS" });
  expect(await spawn({ id: "sbx-cfg", ...scan, env: { CLAUDE_CONFIG_DIR: FX.v("planted") } })).toMatchObject({ ok: false, code: "EROFS" });
  expect(await spawn({ id: "sbx-cwd", ...scan, cwd: FX.root })).toMatchObject({ ok: false, code: "EROFS" });
  expect(await spawn({ id: "sbx-bad id", ...scan })).toMatchObject({ ok: false, code: "EINVAL" });
  expect(await spawn({ id: "sbx-scan", ...scan })).toMatchObject({ ok: true });
});

test("a terminal starts only a listed shell, with no arguments", async () => {
  const pty = (req: object) => call((aos, r) => aos.pty.spawn(JSON.parse(r)), JSON.stringify({ cols: 80, rows: 24, name: "xterm-256color", cwd: FX.vault, args: [], ...req }));
  expect(await pty({ id: "sbx-t1", file: "/usr/bin/python3" })).toMatchObject({ ok: false, code: "EROFS" });
  expect(await pty({ id: "sbx-t2", file: "/bin/sh", args: ["-c", "id"] })).toMatchObject({ ok: false, code: "EROFS" });
  expect(await pty({ id: "sbx-t3", file: "/bin/sh", env: { NODE_OPTIONS: "x" } })).toMatchObject({ ok: false, code: "EROFS" });
});

test("only https links leave the app; a file that would run is shown in Finder, never opened", async () => {
  const h = app();
  const before = (await h.opened()).length;
  await call((aos) => { aos.shell.openExternal("file:///etc/passwd"); aos.shell.openExternal("javascript:alert(1)"); aos.shell.openExternal("https://example.com/ok"); });
  expect(await call((aos, p) => aos.shell.openPath(p), FX.v("workspaces/run-me.terminal"))).toBe("");
  expect(await call((aos) => aos.shell.openPath("/etc/hosts"))).toBe("outside what the app reads");
  await expect.poll(async () => (await h.opened()).slice(before).map((o) => `${o.fn} ${o.arg}`)).toEqual([
    "openExternal https://example.com/ok",
    `showItemInFolder ${FX.v("workspaces/run-me.terminal")}`,
  ]);
});

test("only the app's own page is answered: the tray popover's window gets EPERM", async () => {
  const h = app();
  await expect.poll(() => h.app.windows().length).toBe(2);
  const pop = h.app.windows().find((w) => w !== h.win)!;
  const r = await pop.evaluate((v) => {
    const aos = (window as unknown as { aos?: { fs: { readText(p: string): unknown } } }).aos;
    return aos ? aos.fs.readText(`${v}/TODO.md`) : "no bridge";
  }, FX.vault);
  expect(r === "no bridge" || (r as { code?: string }).code === "EPERM").toBe(true);
});
