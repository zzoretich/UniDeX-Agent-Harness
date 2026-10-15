// The page's file system, processes and terminals as main runs them, against a real temporary vault: what the policy
// allows reaches the disk or starts, what it refuses comes back EROFS and leaves everything as it was.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProcEvent, PtyEvent, Result } from "../../src/shared/ipc";
import { SURFACE_IDS, WritePolicy } from "../../src/main/policy/write-policy";
import { ReadScope } from "../../src/main/policy/read-scope";
import type { ProgramContext } from "../../src/main/policy/programs";
import { FsService } from "../../src/main/services/fs";
import { ProcService } from "../../src/main/services/proc";
import { PtyService, terminalBaseEnv, type PtyLib, type PtyProcess } from "../../src/main/services/pty";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-services-")));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
const VAULT = path.join(ROOT, "vault");
const HOME = path.join(ROOT, "home");
const USER_DATA = path.join(ROOT, "userData");
const OUTSIDE = path.join(ROOT, "outside.md");
const v = (rel: string) => path.join(VAULT, rel);
const S = v("brain/scripts");
const NODE = process.execPath;

const context = (): ProgramContext => ({ vaultRoot: VAULT, home: HOME, userData: USER_DATA, env: {}, agenticos: null, shells: ["/bin/sh"] });

let policy = new WritePolicy(VAULT, []);
const scope = new ReadScope(context());
const svc = new FsService({ vaultRoot: VAULT, userData: USER_DATA, scope: () => scope, policy: () => policy });

function reset(surfaces: string[]): void {
  fs.rmSync(VAULT, { recursive: true, force: true });
  fs.mkdirSync(path.join(S, "cli"), { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(v("TODO.md"), "# To-Do\n");
  fs.writeFileSync(v("MEMORY.md"), "# Memory\n");
  // A runtime script that echoes what it was given and the pins it was started with.
  fs.writeFileSync(path.join(S, "scan-vault.js"), "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), vault: process.env.AOS_VAULT ?? null, cwd: process.cwd(), node: process.env.NODE_OPTIONS ?? null }));process.stderr.write('é');");
  fs.writeFileSync(path.join(S, "cli", "aos.js"), "setTimeout(() => {}, 30000);");
  policy = new WritePolicy(VAULT, surfaces);
}

const refusedResult = (r: Result<unknown>) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(!r.ok && r.code, "EROFS"); };
const read = (rel: string) => fs.readFileSync(v(rel), "utf8");

// ── files ────────────────────────────────────────────────────────────

test("with To-Do on, the page writes TODO.md and nothing else, leaving the rest untouched", () => {
  reset(["todo"]);
  assert.deepEqual(svc.writeText(v("TODO.md"), "a\n", "hud"), { ok: true, data: null });
  assert.deepEqual(svc.appendText(v("TODO.md"), "b\n"), { ok: true, data: null });
  assert.equal(read("TODO.md"), "a\nb\n");
  refusedResult(svc.writeText(v("MEMORY.md"), "x", "hud"));
  refusedResult(svc.writeText(v("brain/new.md"), "x", "hud"));
  refusedResult(svc.writeText(OUTSIDE, "x", "hud"));
  refusedResult(svc.writeText(`${VAULT}/brain/../../outside.md`, "x", "hud"));
  refusedResult(svc.remove(v("MEMORY.md"), false));
  refusedResult(svc.remove(v("brain"), true));
  refusedResult(svc.appendText(v("MEMORY.md"), "x"));
  assert.equal(read("MEMORY.md"), "# Memory\n");
  assert.equal(fs.existsSync(v("brain/new.md")), false);
  assert.equal(fs.existsSync(OUTSIDE), false);
  assert.equal(fs.existsSync(v("brain")), true);
});

test("with nothing on, even TODO.md is refused; the note editor's saves need Notes", () => {
  reset([]);
  refusedResult(svc.writeText(v("TODO.md"), "x", "hud"));
  refusedResult(svc.writeText(v("notes/a.md"), "x", "editor"));
  reset(["notes"]);
  refusedResult(svc.writeText(v("TODO.md"), "x", "hud"));
  refusedResult(svc.writeText(v("notes/a.md"), "x", "editor")); // the editor saves notes that exist: it creates no folder
  fs.mkdirSync(v("notes"));
  assert.equal(svc.writeText(v("notes/a.md"), "x", "editor").ok, true);
  refusedResult(svc.writeText(v("brain/_index/x.md"), "x", "editor"));
  refusedResult(svc.writeText(v(".claude/agents/x.md"), "x", "editor"));
});

test("a folder never goes for good, and the runtime's folders never move: not removed, renamed or trashed, nor any folder above them", () => {
  reset(["files"]);
  fs.mkdirSync(v("brain/_index"), { recursive: true });
  fs.mkdirSync(v("workspaces/old/.git"), { recursive: true });
  refusedResult(svc.remove(v("brain"), true));
  refusedResult(svc.remove(v("workspaces/old"), true));
  refusedResult(svc.rename(v("brain"), v("brain-moved")));
  refusedResult(svc.rename(v("brain/scripts"), v("scripts")));
  assert.equal(svc.canTrash(v("brain")), false);
  assert.equal(svc.canTrash(v("brain/scripts")), false);
  assert.equal(fs.existsSync(path.join(S, "scan-vault.js")), true);
  // A folder of one's own goes to the Trash with what is in it, its .git included; renaming it moves it whole.
  assert.equal(svc.canTrash(v("workspaces/old")), true);
  assert.equal(svc.rename(v("workspaces/old"), v("workspaces/older")).ok, true);
  assert.equal(svc.remove(v("TODO.md"), false).ok, true);
});

test("a rename needs both ends; a copy needs to read its source and write its destination", () => {
  reset(["todo"]);
  refusedResult(svc.rename(v("TODO.md"), v("brain/TODO.md")));
  refusedResult(svc.rename(v("MEMORY.md"), v("TODO.md")));
  refusedResult(svc.copy(v("TODO.md"), v("MEMORY.md")));
  refusedResult(svc.copy("/etc/hosts", v("TODO.md")));
  assert.equal(read("TODO.md"), "# To-Do\n");
  assert.equal(svc.copy(v("MEMORY.md"), v("TODO.md")).ok, true);
  assert.equal(read("TODO.md"), "# Memory\n", "the destination is what a copy writes");
});

test("mkdir of an existing folder is a no-op and allowed; a new folder needs a surface, and so does each missing parent", () => {
  reset([]);
  fs.mkdirSync(v("brain/memory"), { recursive: true });
  assert.equal(svc.mkdir(v("brain"), true).ok, true);
  refusedResult(svc.mkdir(v("brain/patterns"), true));
  assert.equal(fs.existsSync(v("brain/patterns")), false);
  reset(["files"]);
  assert.equal(svc.mkdir(v("workspaces/new/deep"), true).ok, true);
  refusedResult(svc.mkdir(v(".claude/agents"), true));
  refusedResult(svc.mkdir(v("brain/_index/x"), true));
  assert.equal(fs.existsSync(v(".claude")), false);
});

test("Files writes anywhere in the vault but the runtime's folders and every dot-path", () => {
  reset(["files"]);
  assert.equal(svc.writeText(v("workspaces/app/PLAN.md"), "x", "hud").ok, true);
  for (const rel of [".claude/settings.json", ".mcp.json", "workspaces/app/.claude/settings.local.json", ".codex/config.toml", ".git/hooks/pre-commit", "x/.envrc",
    "brain/scripts/scan-vault.js", "brain/_index/snapshot.json", "workspaces/app/node_modules/a.js"]) refusedResult(svc.writeText(v(rel), "x", "hud"));
  refusedResult(svc.rename(v("TODO.md"), v(".mcp.json")));
});

test("Files never reaches the runtime's folders by another spelling or through a link; the disk is left as it was", () => {
  reset(["files", "notes"]);
  fs.mkdirSync(v("brain/_index"), { recursive: true });
  fs.mkdirSync(v("notes"), { recursive: true });
  fs.symlinkSync("../brain/scripts", v("notes/Scripts"));
  fs.symlinkSync("../brain/scripts/planted.js", v("notes/planted.js"));
  const before = fs.readdirSync(S).sort();
  for (const target of [v("Brain/Scripts/scan-vault.js"), v("BRAIN/SCRIPTS/new.js"), v("brain/\u017Fcripts/new.js"), v("brain/_Index/BRAIN.md"),
    v("notes/Scripts/new.js"), v("notes/planted.js"), `${v("notes/Scripts")}/../_index/BRAIN.md`]) {
    refusedResult(svc.writeText(target, "x", "hud"));
    refusedResult(svc.writeText(target, "x", "editor"));
    refusedResult(svc.appendText(target, "x"));
    refusedResult(svc.copy(v("TODO.md"), target));
  }
  refusedResult(svc.mkdir(v("Brain/Scripts/lib"), true));
  refusedResult(svc.rename(v("TODO.md"), v("Brain/Scripts/TODO.md")));
  refusedResult(svc.rename(v("Brain/Scripts"), v("scripts")));
  refusedResult(svc.rename(v("Brain"), v("brain-moved")));
  assert.equal(svc.canTrash(v("BRAIN")), false);
  assert.equal(svc.canTrash(v("brain/Scripts")), false);
  assert.deepEqual(fs.readdirSync(S).sort(), before);
  assert.equal(fs.existsSync(v("brain/_index/BRAIN.md")), false);
  assert.equal(fs.existsSync(path.join(S, "planted.js")), false);
  // The same tab still writes the user's notes.
  assert.equal(svc.writeText(v("notes/a.md"), "x", "hud").ok, true);
});

test("reads stay inside the read scope; credential files never come back", () => {
  reset([]);
  assert.deepEqual(svc.readText(v("TODO.md")), { ok: true, data: "# To-Do\n" });
  assert.equal(svc.exists(v("nope.md")).ok && (svc.exists(v("nope.md")) as { data: boolean }).data, false);
  const notThere = svc.readText(v("nope.md"));
  assert.equal(!notThere.ok && notThere.code, "ENOENT");
  refusedResult(svc.readText("/etc/hosts"));
  refusedResult(svc.readdir("/etc"));
  refusedResult(svc.exists("/etc/hosts"));
  fs.mkdirSync(path.join(HOME, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(HOME, ".codex", "auth.json"), "{\"token\":\"secret\"}");
  refusedResult(svc.readText(path.join(HOME, ".codex", "auth.json")));
  assert.equal(svc.exists(NODE).ok, true, "a program may be probed by its name");
});

test("ranged reads return the bytes asked for, fewer at the end", () => {
  reset([]);
  fs.writeFileSync(v("log.jsonl"), "héllo\nworld\n");
  const r = svc.readBytes(v("log.jsonl"), 7, 100);
  assert.ok(r.ok);
  assert.equal(Buffer.from(r.data).toString("utf8"), "world\n");
  const past = svc.readBytes(v("log.jsonl"), 100, 10);
  assert.ok(past.ok && past.data.length === 0);
});

test("the vault walk lists files with stats and skips what the index skips", () => {
  reset([]);
  for (const rel of ["a.md", "brain/b.md", ".obsidian/c.json", "x/node_modules/d.js", "_worktrees/e.md", "y/.hidden/f.md"]) {
    fs.mkdirSync(path.dirname(v(rel)), { recursive: true });
    fs.writeFileSync(v(rel), "x");
  }
  const r = svc.walk();
  assert.ok(r.ok);
  const rels = r.data.map((e) => e.rel).sort();
  assert.deepEqual(rels, ["MEMORY.md", "TODO.md", "a.md", "brain/b.md", "brain/scripts/cli/aos.js", "brain/scripts/scan-vault.js"]);
  assert.ok(r.data.every((e) => e.size >= 0 && e.mtimeMs > 0));
});

test("a plugin's settings: the app's copy, else Obsidian's in the vault (read only); saves go to the app's data", () => {
  reset([]);
  fs.mkdirSync(v(".obsidian/plugins/agentic-os"), { recursive: true });
  fs.writeFileSync(v(".obsidian/plugins/agentic-os/data.json"), "{\"from\":\"obsidian\"}");
  assert.deepEqual(svc.loadPluginData("agentic-os"), { ok: true, data: { from: "obsidian" } });
  assert.equal(svc.savePluginData("agentic-os", "{\"from\":\"app\"}").ok, true);
  assert.deepEqual(svc.loadPluginData("agentic-os"), { ok: true, data: { from: "app" } });
  assert.equal(fs.readFileSync(v(".obsidian/plugins/agentic-os/data.json"), "utf8"), "{\"from\":\"obsidian\"}");
  assert.equal(svc.savePluginData("agentic-os", "not json").ok, false);
  assert.deepEqual(svc.loadPluginData("nothing-here"), { ok: true, data: null });
  assert.ok(!fs.existsSync(path.join(USER_DATA, "plugins", "nothing-here.json")), "no copy of settings that do not exist");
});

test("Obsidian's settings are copied into the app's data on first read, so removing the old plugin folder loses nothing", () => {
  reset([]);
  const legacy = v(".obsidian/plugins/carry-over/data.json");
  const own = path.join(USER_DATA, "plugins", "carry-over.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "{\"statusBarEnabled\":false}");
  assert.deepEqual(svc.loadPluginData("carry-over"), { ok: true, data: { statusBarEnabled: false } });
  assert.deepEqual(JSON.parse(fs.readFileSync(own, "utf8")), { statusBarEnabled: false });
  assert.equal(fs.readFileSync(legacy, "utf8"), "{\"statusBarEnabled\":false}", "the vault's file is never written");
  fs.rmSync(path.dirname(legacy), { recursive: true });
  assert.deepEqual(svc.loadPluginData("carry-over"), { ok: true, data: { statusBarEnabled: false } });
  // An unreadable legacy file is no settings at all, and copies nothing.
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "{not json");
  fs.rmSync(own);
  assert.deepEqual(svc.loadPluginData("carry-over"), { ok: true, data: null });
  assert.ok(!fs.existsSync(own));
});

test("a copy the app cannot write still returns Obsidian's settings, and is tried again on the next read", () => {
  const data = path.join(ROOT, "readonly-userData");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "plugins"), "a file where the folder should be");
  const ro = new FsService({ vaultRoot: VAULT, userData: data, scope: () => scope, policy: () => policy });
  fs.mkdirSync(v(".obsidian/plugins/stuck"), { recursive: true });
  fs.writeFileSync(v(".obsidian/plugins/stuck/data.json"), "{\"a\":1}");
  assert.deepEqual(ro.loadPluginData("stuck"), { ok: true, data: { a: 1 } });
  fs.rmSync(path.join(data, "plugins"));
  assert.deepEqual(ro.loadPluginData("stuck"), { ok: true, data: { a: 1 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "plugins", "stuck.json"), "utf8")), { a: 1 });
});

// ── processes ────────────────────────────────────────────────────────

function procs(): { svc: ProcService; events: ProcEvent[]; exit: (id: string) => Promise<ProcEvent[]> } {
  const events: ProcEvent[] = [];
  const waiters = new Map<string, () => void>();
  const p = new ProcService({ policy: () => policy, context, env: { ...process.env, NODE_OPTIONS: "" }, emit: (ev) => { events.push(ev); if (ev.type === "exit") waiters.get(ev.id)?.(); } });
  const exit = (id: string) => new Promise<ProcEvent[]>((resolve) => {
    if (events.some((e) => e.id === id && e.type === "exit")) resolve(events.filter((e) => e.id === id));
    else waiters.set(id, () => resolve(events.filter((e) => e.id === id)));
  });
  return { svc: p, events, exit };
}

test("the HUD's background refreshes run; content writes and user actions stay refused with no surface on", async () => {
  reset([]);
  const { svc: p, exit } = procs();
  const r = p.spawn({ id: "scan", cmd: NODE, args: [`${S}/scan-vault.js`, "--quiet"], cwd: VAULT, env: { AOS_VAULT: VAULT } });
  assert.ok(r.ok && typeof r.data.pid === "number");
  const ev = await exit("scan");
  const out = JSON.parse(ev.filter((e) => e.type === "stdout").map((e) => (e as { data: string }).data).join(""));
  assert.deepEqual(out.argv, ["--quiet"]);
  assert.equal(out.vault, VAULT);
  assert.equal(fs.realpathSync(out.cwd), VAULT);
  assert.equal(ev.filter((e) => e.type === "stderr").map((e) => (e as { data: string }).data).join(""), "é", "text, decoded whole");
  assert.deepEqual(ev.at(-1), { id: "scan", type: "exit", code: 0, signal: null });
  for (const args of [
    [`${S}/cli/aos.js`, "config", "set", "cost.enabled", "true", "--json"],
    [`${S}/cli/aos.js`, "routines", "sync"],
    [`${S}/team.js`, "gate", "approve", "dev", "item-1", "--expect", "{}"],
    [`${S}/routines/run-routine.js`, "tick", "--manual"],
    [`${S}/sdk/ask.js`, "--local", "hi"],
  ]) refusedResult(p.spawn({ id: "x", cmd: NODE, args, cwd: VAULT }));
});

test("only node, only this vault's scripts, only from the vault, no path tricks, no planted programs or variables", () => {
  reset([...SURFACE_IDS]);
  const { svc: p } = procs();
  const scan = [`${S}/scan-vault.js`];
  refusedResult(p.spawn({ id: "a", cmd: "/bin/sh", args: ["-c", "true"], cwd: VAULT }));
  refusedResult(p.spawn({ id: "a", cmd: NODE, args: ["-e", "require('fs')"], cwd: VAULT }));
  refusedResult(p.spawn({ id: "a", cmd: NODE, args: [`${S}/../../evil/scan-vault.js`], cwd: VAULT }));
  refusedResult(p.spawn({ id: "a", cmd: NODE, args: ["/other/vault/brain/scripts/scan-vault.js"], cwd: VAULT }));
  refusedResult(p.spawn({ id: "a", cmd: NODE, args: [`${S}/cli/aos.js`, "uninstall"], cwd: VAULT }));
  refusedResult(p.spawn({ id: "a", cmd: NODE, args: scan, cwd: "/tmp" }));
  refusedResult(p.spawn({ id: "a", cmd: NODE, args: scan }));
  refusedResult(p.spawn({ id: "a", cmd: NODE, args: scan, cwd: VAULT, env: { NODE_OPTIONS: "--require /tmp/x.js" } }));
  refusedResult(p.spawn({ id: "a", cmd: NODE, args: scan, cwd: VAULT, unsetEnv: ["PATH"] }));
  // A program the page could have planted: a "node" or a "claude" in the vault.
  for (const name of ["node", "claude"]) {
    const planted = v(`tools/${name}`);
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, "#!/bin/sh\n");
    fs.chmodSync(planted, 0o755);
  }
  refusedResult(p.spawn({ id: "a", cmd: v("tools/node"), args: scan, cwd: VAULT }));
  const claudeArgs = ["-p", "q", "--model", "haiku", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "s", "--max-budget-usd", "0.05", "--output-format", "json"];
  refusedResult(p.spawn({ id: "a", cmd: v("tools/claude"), args: claudeArgs, cwd: VAULT }));
  assert.equal(p.running, 0);
});

test("a relative script resolves against the vault it runs in, as node would", async () => {
  reset([]);
  const { svc: p, exit } = procs();
  assert.ok(p.spawn({ id: "rel", cmd: NODE, args: ["brain/scripts/scan-vault.js"], cwd: VAULT }).ok);
  await exit("rel");
  assert.ok(p.spawn({ id: "rel2", cmd: NODE, args: ["../brain/scripts/scan-vault.js"], cwd: v("brain") }).ok, "the same script, spelled from a subfolder");
  await exit("rel2");
  refusedResult(p.spawn({ id: "rel3", cmd: NODE, args: ["../../brain/scripts/scan-vault.js"], cwd: v("brain") }));
});

test("children are named by the page, capped, killed on request, and the attached ones end with the page", async () => {
  reset([...SURFACE_IDS]);
  const { svc: p, exit } = procs();
  const sync = [`${S}/cli/aos.js`, "routines", "sync"];
  assert.ok(p.spawn({ id: "long", cmd: NODE, args: sync, cwd: VAULT }).ok);
  const dup = p.spawn({ id: "long", cmd: NODE, args: sync, cwd: VAULT });
  assert.equal(!dup.ok && dup.code, "EEXIST");
  p.kill("long", "SIGKILL");
  const ev = await exit("long");
  assert.equal((ev.at(-1) as { signal: string | null }).signal, "SIGKILL");
  assert.ok(p.spawn({ id: "again", cmd: NODE, args: sync, cwd: VAULT }).ok);
  p.killAttached();
  assert.equal((await exit("again")).at(-1)?.type, "exit");
});

test("execSync runs only an allowed command, from the vault, with a timeout", () => {
  reset(["settings"]);
  const { svc: p } = procs();
  refusedResult(p.execSync({ file: "/bin/sh", args: ["-c", "id"], timeoutMs: 1000 }));
  refusedResult(p.execSync({ file: "/bin/zsh", args: ["-lic", "rm -rf /"], timeoutMs: 1000 }));
  const r = p.execSync({ file: "/bin/sh", args: ["-lic", "command -v node"], timeoutMs: 5000 });
  assert.equal(r.ok || r.code !== "EROFS", true, "allowed by the settings surface (it may still fail on a machine without node)");
});

// ── terminals ────────────────────────────────────────────────────────

function fakePty(): { lib: PtyLib; spawned: Array<{ file: string; opts: Record<string, unknown>; p: PtyProcess & { written: string[]; exit(): void } }> } {
  const spawned: Array<{ file: string; opts: Record<string, unknown>; p: PtyProcess & { written: string[]; exit(): void } }> = [];
  const lib: PtyLib = {
    spawn: (file, _args, opts) => {
      let onData: (d: string) => void = () => {};
      let onExit: (e: { exitCode: number }) => void = () => {};
      const p = {
        pid: 4242, written: [] as string[],
        write: (d: string) => { p.written.push(d); onData(`echo:${d}`); },
        resize: () => {}, kill: () => onExit({ exitCode: 0 }),
        onData: (cb: (d: string) => void) => { onData = cb; }, onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb; },
        exit: () => onExit({ exitCode: 3 }),
      };
      spawned.push({ file, opts, p });
      return p;
    },
  };
  return { lib, spawned };
}

test("a terminal is a listed shell in a real folder; its data and exit stream back; all end with the page", () => {
  reset([]);
  const { lib, spawned } = fakePty();
  const events: PtyEvent[] = [];
  const t = new PtyService({ context, env: { PATH: "/usr/bin" }, emit: (ev) => events.push(ev), load: () => lib });
  assert.deepEqual(t.available(), { ok: true, data: null });
  const req = { id: "t1", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 80, rows: 24, env: { TERM: "xterm-256color", AGENTIC_OS: "1" } };
  assert.deepEqual(t.spawn(req), { ok: true, data: { pid: 4242 } });
  assert.equal((spawned[0].opts.env as Record<string, string>).PATH, "/usr/bin");
  t.write("t1", "ls\r");
  assert.deepEqual(events, [{ id: "t1", type: "data", data: "echo:ls\r" }]);
  refusedResult(t.spawn({ ...req, id: "t2", file: "/usr/bin/python3" }));
  refusedResult(t.spawn({ ...req, id: "t2", args: ["-c", "id"] }));
  refusedResult(t.spawn({ ...req, id: "t2", cwd: v("TODO.md") }));
  refusedResult(t.spawn({ ...req, id: "t2", env: { NODE_OPTIONS: "x" } }));
  spawned[0].p.exit();
  assert.deepEqual(events.at(-1), { id: "t1", type: "exit", exitCode: 3 });
  assert.ok(t.spawn({ ...req, id: "t3" }).ok);
  t.killAll();
  assert.equal(t.open, 0);
});

test("without node-pty, terminals say why and nothing starts", () => {
  const t = new PtyService({ context, env: {}, emit: () => {}, load: () => { throw new Error("Cannot find module 'node-pty'\nRequire stack: …"); } });
  const r = t.available();
  assert.equal(!r.ok && r.error, "node-pty failed to load: Cannot find module 'node-pty'");
  assert.equal(t.spawn({ id: "t", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 80, rows: 24 }).ok, false);
});

test("terminals start with the login shell's PATH and without CLAUDECODE (spec 2026-10-08-term-agent-deck T14)", () => {
  assert.deepEqual(terminalBaseEnv({ PATH: "/usr/bin", HOME: "/h", CLAUDECODE: "1" }, "/opt/homebrew/bin:/usr/bin"), { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/h" });
  assert.deepEqual(terminalBaseEnv({ PATH: "/usr/bin" }, null), { PATH: "/usr/bin" });
  reset([]);
  const { lib, spawned } = fakePty();
  let asked = 0;
  const t = new PtyService({ context, env: () => { asked++; return terminalBaseEnv({ PATH: "/usr/bin", CLAUDECODE: "1" }, "/login/bin:/usr/bin"); }, emit: () => {}, load: () => lib });
  assert.ok(t.spawn({ id: "t1", file: "/bin/sh", args: [], cwd: VAULT, name: "xterm-256color", cols: 80, rows: 24 }).ok);
  const env = spawned[0].opts.env as Record<string, string>;
  assert.equal(env.PATH, "/login/bin:/usr/bin");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(asked, 1);
  t.killAll();
});
