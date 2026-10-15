// The main process's rules for the sandboxed page (phase 4): what it may read, which programs and variables a spawn may
// use, what it may hand to the OS, which switches a packaged build refuses, and the argument schemas.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { debugSwitches } from "../../src/main/policy/debug";
import { cwdRefusal, parseShells, programRefusal, ptyEnv, shellRefusal, spawnEnv, type ProgramContext } from "../../src/main/policy/programs";
import { folderId, relUnder } from "../../src/main/policy/identity";
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

test("MCP config backups are never read: their folder is outside every root, brain/_index/backups is refused too, and no link reaches either (install-import B6)", () => {
  const s = new ReadScope(ctx());
  // Where `aos mcp copy` writes them (cli/mcp.js backupDir): each holds a whole host config, secrets included.
  const dir = `${HOME}/.local/share/unidex/backups/mcp`;
  const bak = `${dir}/codex-config.toml-20261015T142233123Z.bak`;
  for (const p of [bak, dir, `${HOME}/.local/share/unidex/backups`, `${VAULT}/brain/_index/backups/mcp/claude-claude.json-x.bak`, `${VAULT}/brain/_index/backups`]) {
    assert.equal(s.canRead(p), false, p);
    assert.equal(s.canList(p), false, p);
    assert.equal(s.canProbe(p), false, p);
  }
  // A vault that is the home folder itself still never reaches them; the rest of it stays readable.
  const atHome = new ReadScope(ctx({ vaultRoot: HOME }));
  assert.equal(atHome.canRead(bak), false);
  assert.equal(atHome.canRead(`${HOME}/notes.md`), true);
  // A link in the vault to the backups folder reads as the backups.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bak, "secret = 1\n");
  fs.symlinkSync(dir, `${VAULT}/peek`);
  try {
    assert.equal(s.canRead(`${VAULT}/peek/${path.basename(bak)}`), false);
    assert.equal(s.canList(`${VAULT}/peek`), false);
  } finally { fs.rmSync(`${VAULT}/peek`); }
  // brain/_index's other caches stay readable.
  assert.equal(s.canRead(`${VAULT}/brain/_index/mcp-servers.json`), true);
});

/** Whether this machine's temp folder ignores case, as APFS does by default (the app's own target). */
function caseInsensitiveFs(): boolean {
  const probe = path.join(ROOT, "CaseProbe");
  fs.writeFileSync(probe, "");
  try { return fs.existsSync(path.join(ROOT, "caseprobe")); } finally { fs.rmSync(probe, { force: true }); }
}

test("every deny compares as the file system names things: any case, any Unicode form, links resolved when asked (security re-review A)", () => {
  const home = path.join(ROOT, "home-a");
  const vault = path.join(ROOT, "vault-a");
  fs.mkdirSync(path.join(home, ".local", "share", "unidex", "backups", "mcp"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(vault, "brain", "_index", "backups", "mcp"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "share", "unidex", "backups", "mcp", "x.bak"), "secret = 1\n");
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
  const s = new ReadScope(ctx({ vaultRoot: vault, home }));
  // brain/_index/backups in another case: the same folder on APFS.
  for (const p of [`${vault}/Brain/_Index/Backups/mcp/x.bak`, `${vault}/BRAIN/_INDEX/BACKUPS`, `${vault}/brain/_index/backups/MCP/y.bak`]) {
    assert.equal(s.canRead(p), false, p);
    assert.equal(s.canList(p), false, p);
  }
  // A credential's name in any case, and a link in the vault to one.
  for (const p of [`${vault}/AUTH.JSON`, `${vault}/x/.ENV`, `${vault}/certs/Server.PEM`]) assert.equal(s.canRead(p), false, p);
  fs.symlinkSync(path.join(home, ".codex", "auth.json"), path.join(vault, "notes.md"));
  assert.equal(s.canRead(`${vault}/notes.md`), false, "a link to a credential file reads as it");
  // A link whose target names the backups folder in another case (a repo's relative link, ../../.local/share/UniDeX/Backups).
  if (caseInsensitiveFs()) {
    fs.mkdirSync(path.join(vault, "workspaces", "app"), { recursive: true });
    fs.symlinkSync(path.join("..", "..", "..", "home-a", ".local", "share", "UniDeX", "Backups"), path.join(vault, "workspaces", "app", "rel"));
    assert.equal(s.canRead(`${vault}/workspaces/app/rel/mcp/x.bak`), false, "an upper-case link to the backups");
    assert.equal(s.canList(`${vault}/workspaces/app/rel`), false);
  }
  // A vault whose name has an accent, asked for in the other Unicode form (NFD): the same folder.
  const accented = path.join(ROOT, "caf\u00e9-vault");
  fs.mkdirSync(path.join(accented, "brain", "_index", "backups"), { recursive: true });
  const sa = new ReadScope(ctx({ vaultRoot: accented, home }));
  assert.equal(sa.canRead(`${accented.normalize("NFD")}/brain/_index/backups/mcp/x.bak`), false, "NFD spelling");
  assert.equal(sa.canRead(`${accented}/notes.md`), true);
  assert.equal(s.canRead(`${vault}/brain/_index/mcp-servers.json`), true, "the other caches stay readable");
});

test("a deny reaches a folder made after the scope was built: ~/.local turned into a link, the backups made later (security re-review A)", () => {
  const home = path.join(ROOT, "home-b");
  const vault = path.join(ROOT, "vault-b");
  const elsewhere = path.join(ROOT, "elsewhere-b");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  const s = new ReadScope(ctx({ vaultRoot: vault, home }));
  // After launch: ~/.local becomes a link to another disk, and the first copy makes the backups there.
  fs.mkdirSync(path.join(elsewhere, "share", "unidex", "backups", "mcp"), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "share", "unidex", "backups", "mcp", "x.bak"), "secret = 1\n");
  fs.symlinkSync(elsewhere, path.join(home, ".local"));
  fs.symlinkSync(path.join(elsewhere, "share", "unidex", "backups"), path.join(vault, "late"));
  assert.equal(s.canRead(`${vault}/late/mcp/x.bak`), false, "a link in the vault to where ~/.local now points");
  assert.equal(s.canList(`${vault}/late/mcp`), false);
  assert.equal(s.canProbe(`${vault}/late/mcp/x.bak`), false);
  // The per-install key of `aos mcp copy` is never read either.
  fs.mkdirSync(path.join(elsewhere, "share", "unidex", "keys"), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "share", "unidex", "keys", "mcp-plan.key"), "k");
  fs.symlinkSync(path.join(elsewhere, "share", "unidex", "keys", "mcp-plan.key"), path.join(vault, "k.md"));
  assert.equal(s.canRead(`${vault}/k.md`), false);
});

test("a check resolves the path asked once, and each denied folder once, whichever of read, list or probe asks (third review 6)", () => {
  const home = path.join(ROOT, "home-c");
  const vault = path.join(ROOT, "vault-c");
  for (const d of [path.join(home, ".local", "share", "unidex", "backups"), path.join(home, ".local", "share", "unidex", "keys"), path.join(vault, "brain", "_index", "backups")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(vault, "notes.md"), "x");
  let calls = 0;
  const realpath = (p: string): string => { calls++; return fs.realpathSync.native(p); };
  const s = new ReadScope({ ...ctx({ vaultRoot: vault, home }), realpath });
  // Three denied folders, all there: one resolution each, plus the path itself.
  for (const ask of [(p: string) => s.canRead(p), (p: string) => s.canList(p), (p: string) => s.canProbe(p)]) {
    calls = 0;
    assert.equal(ask(`${vault}/notes.md`), true);
    assert.equal(calls, 4, "one walk for the path, one per denied folder");
  }
  fs.writeFileSync(path.join(vault, "brain", "_index", "backups", "x.bak"), "x");
  calls = 0;
  assert.equal(s.canProbe(`${vault}/brain/_index/backups/x.bak`), false);
  assert.ok(calls <= 4, `a denied probe stops early (${calls})`);
});

test("relUnder finds a path under a folder by the folder's identity, whatever the path calls it", () => {
  const dir = path.join(ROOT, "ident", "box");
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  const id = folderId(dir);
  assert.ok(id);
  assert.equal(relUnder([id!], path.join(dir, "sub", "not-yet.txt")), "sub/not-yet.txt");
  assert.equal(relUnder([id!], dir), "");
  assert.equal(relUnder([id!], path.join(ROOT, "ident", "other")), null);
  // Another name for the same folder (a link, here; a firmlink or a second spelling on a Mac) is still under it.
  fs.symlinkSync(dir, path.join(ROOT, "ident", "alias"));
  assert.equal(relUnder([id!], path.join(ROOT, "ident", "alias", "sub", "x")), "sub/x");
  // And by an identity a test supplies, so the rule is checked where no second name exists.
  const fake = (p: string) => (p.startsWith("/elsewhere/box") ? folderId(p.replace("/elsewhere/box", dir)) : folderId(p));
  assert.equal(relUnder([id!], "/elsewhere/box/sub/y", fake), "sub/y");
});

test("a deny holds under any name for the denied folder: by device and inode, not only by spelling", () => {
  const home = path.join(ROOT, "home-d");
  const vault = path.join(ROOT, "vault-d");
  const backups = path.join(home, ".local", "share", "unidex", "backups");
  fs.mkdirSync(path.join(backups, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(backups, "mcp", "x.bak"), "secret = 1\n");
  fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
  fs.writeFileSync(path.join(vault, "notes", "a.md"), "x");
  fs.symlinkSync(backups, path.join(vault, "notes", "b"));
  // The disk names what the link reaches by a second name for the backups folder (as /System/Volumes/Data/… is on a Mac):
  // realpath leaves that name as it is, so no spelling compare sees the backups in it; its identity is the backups'.
  const ALIAS = "/second-name-d";
  const realpath = (p: string): string => {
    const r = fs.realpathSync.native(p);
    return p.startsWith(path.join(vault, "notes", "b")) ? r.replace(home, `${ALIAS}/home`) : r;
  };
  const identity = (p: string) => folderId(p.startsWith(ALIAS) ? p.replace(`${ALIAS}/home`, home) : p);
  const s = new ReadScope({ ...ctx({ vaultRoot: vault, home }), realpath, identity });
  for (const p of [`${vault}/notes/b/mcp/x.bak`, `${vault}/notes/b/mcp`, `${vault}/notes/b`]) {
    assert.equal(s.canRead(p), false, p);
    assert.equal(s.canList(p), false, p);
    assert.equal(s.canProbe(p), false, p);
  }
  assert.equal(s.canRead(`${vault}/notes/a.md`), true, "the rest of the vault stays readable");
});

test("a link in the vault spelled through /System/Volumes/Data never reaches the backups (on a Mac with a data volume)", () => {
  const home = path.join(ROOT, "home-e");
  const vault = path.join(ROOT, "vault-e");
  const backups = path.join(home, ".local", "share", "unidex", "backups");
  fs.mkdirSync(path.join(backups, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(backups, "mcp", "x.bak"), "secret = 1\n");
  fs.mkdirSync(vault, { recursive: true });
  const alias = `/System/Volumes/Data${backups}`;
  let same = false;
  try { const a = fs.statSync(backups); const b = fs.statSync(alias); same = a.dev === b.dev && a.ino === b.ino; } catch { /* no data volume */ }
  if (!same) return;
  fs.symlinkSync(alias, path.join(vault, "fl"));
  const s = new ReadScope(ctx({ vaultRoot: vault, home }));
  assert.equal(s.canRead(`${vault}/fl/mcp/x.bak`), false);
  assert.equal(s.canList(`${vault}/fl/mcp`), false);
  assert.equal(s.canProbe(`${vault}/fl/mcp/x.bak`), false);
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
