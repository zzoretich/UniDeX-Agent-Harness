// The main process's rules for the sandboxed page (phase 4): what it may read, which programs and variables a spawn may
// use, what it may hand to the OS, which switches a packaged build refuses, and the argument schemas.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { debugSwitches } from "../../src/main/policy/debug";
import { cwdRefusal, parseShells, programRefusal, ptyEnv, shellRefusal, spawnEnv, type ProgramContext } from "../../src/main/policy/programs";
import { ReadScope, claudeDirs, codexHomes } from "../../src/main/policy/read-scope";
import { externalAllowed, openPathAction } from "../../src/main/policy/shell";
import { PathArgs, PtySpawnRequestSchema, SpawnRequestSchema, WriteArgs } from "../../src/main/ipc/schemas";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-policy-")));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, "home");
const VAULT = path.join(ROOT, "vault");
const USER_DATA = path.join(ROOT, "userData");
for (const d of [VAULT, USER_DATA, path.join(HOME, ".claude", "skills"), path.join(HOME, ".codex"), path.join(ROOT, "bin")]) fs.mkdirSync(d, { recursive: true });

function ctx(over: Partial<ProgramContext> = {}): ProgramContext {
  return { vaultRoot: VAULT, home: HOME, userData: USER_DATA, env: {}, agenticos: null, shells: ["/bin/zsh", "/bin/bash", "/bin/sh"], ...over };
}

function exe(p: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "#!/bin/sh\n");
  fs.chmodSync(p, mode);
  return p;
}

// ── read scope ───────────────────────────────────────────────────────

test("the page reads the vault, what it shows of the hosts' folders, LaunchAgents, /etc/shells and the app's data, and nothing else", () => {
  const s = new ReadScope(ctx());
  for (const p of [`${VAULT}/TODO.md`, VAULT, `${HOME}/.claude/skills/x/SKILL.md`, `${HOME}/.claude/agents/a.md`, `${HOME}/.claude/agenticos.json`,
    `${HOME}/.codex/agents/a.toml`, `${HOME}/.agents/skills`, `${HOME}/Library/LaunchAgents/com.agenticos.tick.plist`, "/etc/shells",
    `${USER_DATA}/plugins/agentic-os.json`]) assert.equal(s.canRead(p), true, p);
  for (const p of ["/etc/passwd", `${HOME}/.ssh/config`, `${HOME}/Documents/x.md`, `${VAULT}-other/x.md`, `${VAULT}/../x`, "relative/x", "", `${VAULT}/a\0b`,
    // The rest of the hosts' folders: tokens (an IDE lock file carries one), settings, history, logs, and transcripts.
    `${HOME}/.claude/ide/1234.lock`, `${HOME}/.claude/settings.json`, `${HOME}/.claude/history.jsonl`, `${HOME}/.claude/projects/-v/s1.jsonl`,
    `${HOME}/.codex/config.toml`, `${HOME}/.codex/history.jsonl`, `${HOME}/.codex/sessions/2026/10/05/rollout-x.jsonl`, `${HOME}/.claude`])
    assert.equal(s.canRead(p), false, p);
});

test("the hosts' session folders may be listed and probed for a transcript, never read", () => {
  const s = new ReadScope(ctx());
  for (const p of [`${HOME}/.claude/projects`, `${HOME}/.claude/projects/-v`, `${HOME}/.codex/sessions/2026/10/05`, `${HOME}/.codex/archived_sessions`]) {
    assert.equal(s.canList(p), true, p);
    assert.equal(s.canRead(p), false, p);
  }
  assert.equal(s.canProbe(`${HOME}/.claude/projects/-v/s1.jsonl`), true);
  assert.equal(s.canRead(`${HOME}/.claude/projects/-v/s1.jsonl`), false);
  assert.equal(s.canList(`${HOME}/.claude`), false);
  assert.equal(s.canList(`${HOME}/.claude/ide`), false);
});

test("credential files are never read, even inside a root", () => {
  const s = new ReadScope(ctx());
  for (const p of [`${HOME}/.codex/auth.json`, `${HOME}/.claude/.credentials.json`, `${VAULT}/workspaces/app/.env`, `${VAULT}/.env.local`, `${VAULT}/certs/server.pem`, `${VAULT}/id_ed25519`])
    assert.equal(s.canRead(p), false, p);
  assert.equal(s.canRead(`${HOME}/.codex/skills/x/SKILL.md`), true);
});

test("the Claude and Codex folders come from main's environment and agenticos.json, never from the page", () => {
  const o = { home: HOME, env: { CLAUDE_CONFIG_DIR: "/cfg/claude", CODEX_HOME: "relative/ignored" }, agenticos: { claudeConfigDir: "/cfg/other", hosts: { codex: { home: "/cfg/codex" } } } };
  assert.deepEqual(claudeDirs(o), ["/cfg/claude", `${HOME}/.claude`, "/cfg/other"]);
  assert.deepEqual(codexHomes(o), [`${HOME}/.codex`, "/cfg/codex"]);
  const s = new ReadScope(ctx(o));
  assert.equal(s.canRead("/cfg/codex/agents/x.toml"), true);
  assert.equal(s.canRead("/cfg/other/skills/x/SKILL.md"), true);
});

test("a program may be probed by its well-known name anywhere; nvm's version folder may be listed", () => {
  const s = new ReadScope(ctx());
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/claude", `${HOME}/.local/bin/claude`, "/opt/homebrew/bin/fish"]) assert.equal(s.canProbe(p), true, p);
  assert.equal(s.canProbe("/etc/passwd"), false);
  assert.equal(s.canRead("/opt/homebrew/bin/node"), false, "a probe is not a read");
  assert.equal(s.canList(`${HOME}/.nvm/versions/node`), true);
  assert.equal(s.canRead(`${HOME}/.nvm/versions/node/v22.0.0/lib/x.js`), false);
});

// ── programs and environments ────────────────────────────────────────

test("a program is a bare name, or an executable file outside the vault and the app's data", () => {
  const c = ctx();
  assert.equal(programRefusal("claude", c), null);
  assert.equal(programRefusal(exe(path.join(ROOT, "bin", "node")), c), null);
  assert.match(programRefusal(exe(path.join(VAULT, "tools", "node")), c) ?? "", /inside the vault/);
  assert.match(programRefusal(exe(path.join(USER_DATA, "claude")), c) ?? "", /inside the vault or the app's data/);
  assert.match(programRefusal(exe(path.join(ROOT, "bin", "plain"), 0o644), c) ?? "", /not executable/);
  assert.match(programRefusal("./node", c) ?? "", /relative/);
  assert.match(programRefusal("bin/node", c) ?? "", /relative/);
  assert.match(programRefusal(path.join(ROOT, "bin", "missing"), c) ?? "", /no such program/);
  assert.match(programRefusal("node; rm", c) ?? "", /odd/);
  // A link out of the vault to a program is judged by where it points; a link into the vault, by where it lands.
  const link = path.join(ROOT, "bin", "claude-link");
  fs.symlinkSync(path.join(VAULT, "tools", "node"), link);
  assert.match(programRefusal(link, c) ?? "", /inside the vault/);
});

test("a program inside the vault is refused however the vault's path is spelled", () => {
  const c = ctx();
  const prog = exe(path.join(VAULT, "tools", "sh"));
  const upper = path.join(ROOT, "VAULT", "tools", "sh");
  assert.match(programRefusal(prog, c) ?? "", /inside the vault/);
  // On a case-insensitive disk VAULT is the vault; on a case-sensitive one it is not there at all.
  if (fs.existsSync(upper)) assert.match(programRefusal(upper, c) ?? "", /inside the vault/);
  else assert.match(programRefusal(upper, c) ?? "", /no such program/);
});

test("a program inside the vault or the app's data is refused under any name for their folders (the /System/Volumes/Data firmlink)", () => {
  const c = ctx();
  for (const prog of [exe(path.join(VAULT, "tools", "claude")), exe(path.join(USER_DATA, "bin", "node"))]) {
    const alias = `/System/Volumes/Data${prog}`;
    let same = false;
    try { const a = fs.statSync(prog); const b = fs.statSync(alias); same = a.dev === b.dev && a.ino === b.ino; } catch { /* no data volume here */ }
    if (same) assert.match(programRefusal(alias, c) ?? "", /inside the vault or the app's data/, alias);
  }
});

test("a spawn's folder is inside the vault", () => {
  assert.equal(cwdRefusal(VAULT, ctx()), null);
  assert.equal(cwdRefusal(`${VAULT}/workspaces/app`, ctx()), null);
  assert.notEqual(cwdRefusal("/tmp", ctx()), null);
  assert.notEqual(cwdRefusal(undefined, ctx()), null);
  assert.notEqual(cwdRefusal(VAULT, ctx({ vaultRoot: null })), null);
});

test("a spawn sets only the pins the HUD sends, each to a value main trusts, on top of main's own environment", () => {
  const base = { PATH: "/usr/bin", HOME, CLAUDECODE: "1" };
  const c = ctx({ env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude` } });
  const ok = spawnEnv(base, { AOS_VAULT: VAULT, AOS_CONFIG: `${HOME}/.claude/agenticos.json`, CLAUDE_CONFIG_DIR: `${HOME}/.claude`, CODEX_HOME: `${HOME}/.codex`, AOS_HEADLESS: "1", AOS_HOST: "", CLAUDE_PROJECT_DIR: "" }, ["CLAUDECODE"], c);
  assert.ok("env" in ok);
  assert.equal(ok.env.PATH, "/usr/bin");
  assert.equal(ok.env.AOS_VAULT, VAULT);
  assert.equal("CLAUDECODE" in ok.env, false);
  for (const [set, unset] of [
    [{ NODE_OPTIONS: "--require /tmp/x.js" }, []],
    [{ PATH: "/tmp/evil:/usr/bin" }, []],
    [{ DYLD_INSERT_LIBRARIES: "/tmp/x.dylib" }, []],
    [{ CLAUDE_CONFIG_DIR: `${VAULT}/planted` }, []],
    [{ CODEX_HOME: "/tmp/codex" }, []],
    [{ AOS_VAULT: "/other/vault" }, []],
    [{ AOS_CONFIG: `${VAULT}/agenticos.json` }, []],
    [{ AOS_HEADLESS: "0" }, []],
    [{ AOS_HOST: "claude" }, []],
    [{}, ["PATH"]],
    [{ constructor: "x" }, []],
  ] as Array<[Record<string, string>, string[]]>) assert.ok("refusal" in spawnEnv(base, set, unset, c), JSON.stringify([set, unset]));
});

test("a terminal adds TerminalSession's four variables, and starts only a listed shell with no arguments", () => {
  const r = ptyEnv({ PATH: "/usr/bin" }, { TERM: "xterm-256color", COLORTERM: "truecolor", AGENTIC_OS: "1", FORCE_HYPERLINK: "1" }, ctx());
  assert.ok("env" in r && r.env.TERM === "xterm-256color" && r.env.FORCE_HYPERLINK === "1");
  assert.ok("refusal" in ptyEnv({}, { FORCE_HYPERLINK: "0" }, ctx()));
  assert.ok("refusal" in ptyEnv({}, { TERM: "dumb" }, ctx()));
  assert.ok("refusal" in ptyEnv({}, { NODE_OPTIONS: "x" }, ctx()));
  assert.equal(shellRefusal("/bin/zsh", [], ctx()), null);
  assert.match(shellRefusal("/bin/zsh", ["-c", "id"], ctx()) ?? "", /arguments/);
  assert.match(shellRefusal("/usr/bin/python3", [], ctx()) ?? "", /not in \/etc\/shells/);
  assert.match(shellRefusal("zsh", [], ctx()) ?? "", /not in \/etc\/shells/);
  const own = exe(path.join(ROOT, "bin", "myshell"));
  assert.equal(shellRefusal(own, [], ctx({ env: { SHELL: own } })), null, "main's own $SHELL");
  assert.deepEqual(parseShells("# comment\n/bin/zsh\n\n /opt/homebrew/bin/fish \nnot-a-path\n"), ["/bin/zsh", "/opt/homebrew/bin/fish"]);
});

// ── the OS ───────────────────────────────────────────────────────────

test("links open only over https", () => {
  for (const u of ["https://example.com/a?b=c", "HTTPS://example.com"]) assert.equal(externalAllowed(u), true, u);
  for (const u of ["http://example.com", "file:///etc/passwd", "obsidian://open?vault=x", "javascript:alert(1)", "x-apple.systempreferences:", "", "not a url", 42])
    assert.equal(externalAllowed(u), false, String(u));
});

test("openPath opens documents and folders, shows programs, scripts, packages and pages the page could write in Finder, and refuses the rest", () => {
  const s = new ReadScope(ctx());
  const open = (p: string) => openPathAction(p, s, VAULT);
  const put = (rel: string): string => { const p = path.join(VAULT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x"); return p; };
  for (const rel of ["brain/_index/proposals/p.html", "notes/a.md", "data/x.json", "img/a.png"]) assert.deepEqual(open(put(rel)), { action: "open" }, rel);
  for (const rel of ["evil.terminal", "run.command", "tool.py", "build.sh", "Makefile", "x.webloc", "x.fileloc",
    "persona/proposals/p.html", "notes/page.htm", "img/a.svg"]) assert.deepEqual(open(put(rel)), { action: "reveal" }, rel);
  fs.mkdirSync(path.join(VAULT, "workspaces", "app"), { recursive: true });
  assert.deepEqual(open(path.join(VAULT, "workspaces", "app")), { action: "open" });
  fs.mkdirSync(path.join(VAULT, "Evil.app", "Contents"), { recursive: true });
  assert.deepEqual(open(path.join(VAULT, "Evil.app")), { action: "reveal" });
  fs.mkdirSync(path.join(VAULT, "Sneaky", "Contents"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Sneaky", "Contents", "Info.plist"), "");
  assert.deepEqual(open(path.join(VAULT, "Sneaky")), { action: "reveal" }, "a bundle by its Info.plist");
  assert.ok("refusal" in open("/etc/hosts"));
  assert.ok("refusal" in open(path.join(VAULT, "missing.md")));
});

test("a packaged build refuses the switches that open it to a debugger", () => {
  assert.deepEqual(debugSwitches(["/App", "--remote-debugging-port=9222", "-remote-debugging-pipe", "--inspect", "--inspect-brk=0", "--inspect-wait", "--js-flags=--allow-natives-syntax", "--remote-allow-origins=*"]),
    ["--remote-debugging-port=9222", "-remote-debugging-pipe", "--inspect", "--inspect-brk=0", "--inspect-wait", "--js-flags=--allow-natives-syntax", "--remote-allow-origins=*"]);
  assert.deepEqual(debugSwitches(["/App", "agenticos://workbench?tab=todo", "--enable-logging", "--remote-debugging", "--inspector"]), []);
});

// ── schemas ──────────────────────────────────────────────────────────

test("the schemas refuse what the contract does not allow", () => {
  assert.equal(PathArgs.safeParse({ p: "/a/b" }).success, true);
  for (const p of ["a/b", "", "/a\0b", 3, "/".repeat(5000)]) assert.equal(PathArgs.safeParse({ p }).success, false, String(p).slice(0, 20));
  assert.equal(WriteArgs.safeParse({ p: "/a", data: "x", via: "root" }).success, false);
  const spawn = { id: "c-1", cmd: "/opt/homebrew/bin/node", args: ["/v/brain/scripts/scan-vault.js"], cwd: "/v" };
  assert.equal(SpawnRequestSchema.safeParse(spawn).success, true);
  for (const bad of [{ ...spawn, id: "Bad Id" }, { ...spawn, args: ["a\0b"] }, { ...spawn, env: { "lower-case": "x" } }, { ...spawn, stdio: "inherit" },
    { ...spawn, cwd: "relative" }, { ...spawn, args: Array(300).fill("x") }, { ...spawn, unsetEnv: ["PATH; x"] }])
    assert.equal(SpawnRequestSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  assert.equal(PtySpawnRequestSchema.safeParse({ id: "t1", file: "/bin/zsh", args: [], cwd: "/v", name: "xterm-256color", cols: 80, rows: 24 }).success, true);
  assert.equal(PtySpawnRequestSchema.safeParse({ id: "t1", file: "zsh", args: [], cwd: "/v", name: "xterm-256color", cols: 80, rows: 24 }).success, false);
});
