// HostService: what Code still needs of the host CLIs once Sessions is gone (remove-sessions D11) — the binary a Code
// launch runs, each host's models and commands, and the Computer pane's off-screen notices. The vault's brain/scripts is
// the checkout's own runtime, so `sessions.js bin` and `catalog` and `notify.js post` run for real; the host CLIs are
// stand-ins. No network, nothing spent.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProgramContext } from "../../src/main/policy/programs";
import { HostService, type HostServiceOptions } from "../../src/main/services/hosts";

const REPO = path.resolve(process.cwd(), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aos-hosts-app-"));
const vault = path.join(tmp, "vault");
const bin = path.join(tmp, "bin");
fs.mkdirSync(path.join(vault, "brain", "_index"), { recursive: true });
fs.mkdirSync(path.join(vault, "workspaces", "harbor-map"), { recursive: true });
fs.mkdirSync(bin);
fs.writeFileSync(path.join(vault, "AGENTICOS.md"), "# vault\n");
fs.symlinkSync(path.join(REPO, "brain", "scripts"), path.join(vault, "brain", "scripts"));

/** A stand-in CLI that never answers the catalog's initialize (the catalog keeps its aliases). */
function fakeHost(name: string): string {
  const p = path.join(bin, name);
  fs.writeFileSync(p, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  return p;
}
const CLAUDE = fakeHost("claude");
const CODEX = fakeHost("codex");
const config = (extra: object = {}) => fs.writeFileSync(path.join(vault, "brain", "config.json"), JSON.stringify({ hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: true, bin: CODEX } }, ...extra }));
config();

const context: ProgramContext = { vaultRoot: vault, home: tmp, userData: path.join(tmp, "user-data"), env: process.env, agenticos: null, shells: [] } as unknown as ProgramContext;
const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, "claude-config"), AOS_CONFIG: path.join(tmp, "none.json") };
const hosts = (extra: Partial<HostServiceOptions> = {}): HostService =>
  new HostService({ vaultRoot: () => vault, context: () => context, env, node: () => process.execPath, ...extra });

test("resolveBin: the binary the runtime resolves for a Code launch (sessions.js bin), or why not", async () => {
  const s = hosts();
  assert.deepEqual(await s.resolveBin("claude"), { bin: CLAUDE });
  assert.deepEqual(await s.resolveBin("codex"), { bin: CODEX });
  assert.deepEqual(await hosts({ node: () => null }).resolveBin("claude"), { reason: "no node: run aos doctor" });
  assert.deepEqual(await hosts({ vaultRoot: () => null }).resolveBin("claude"), { reason: "no vault is open" });
  // With no binary recorded, the one a Code terminal's PATH finds: the CLI its typed line would have run.
  const termBin = path.join(tmp, "term-bin");
  fs.mkdirSync(termBin, { recursive: true });
  const termCodex = path.join(termBin, "codex");
  fs.writeFileSync(termCodex, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(vault, "brain", "config.json"), JSON.stringify({ hosts: { claude: { enabled: true, bin: CLAUDE }, codex: { enabled: true } } }));
  try {
    const onPath = hosts({ terminalPATH: () => `${termBin}:/usr/bin:/bin` });
    assert.deepEqual(await onPath.resolveBin("codex"), { bin: termCodex });
    assert.deepEqual(await onPath.resolveBin("claude"), { bin: CLAUDE }, "a recorded binary still comes first");
    // The runtime found none (AOS_NO_CODEX hides every Codex, the usual install folders included).
    assert.deepEqual(await hosts({ env: { ...env, AOS_NO_CODEX: "1" } }).resolveBin("codex"), { reason: "the runtime found no Codex binary: run aos doctor" });
  } finally { config(); }
});

/** A HostService whose `sessions.js bin` is replaced by `code` (node -e): an old runtime, or one that never answers. */
function binStandIn(code: string, extra: Partial<HostServiceOptions> = {}) {
  const children: childProcess.ChildProcess[] = [];
  const spawnImpl = ((cmd: string, args: string[], opts: object) => {
    const c = args[1] === "bin" ? childProcess.spawn(process.execPath, ["-e", code], opts) : childProcess.spawn(cmd, args, opts);
    if (args[1] === "bin") children.push(c);
    return c;
  }) as unknown as typeof childProcess.spawn;
  return { s: hosts({ spawnImpl, ...extra }), children };
}

test("resolveBin: a runtime older than the bin verb says to upgrade; one that never answers is given up on and killed", async () => {
  const old = binStandIn("process.stderr.write('usage: sessions.js catalog [--refresh] [--host h] | mirror … | bin <host>\\n'); process.exit(2);");
  assert.deepEqual(await old.s.resolveBin("claude"), { reason: "the runtime is older than this app: run aos upgrade" });
  const hung = binStandIn("setInterval(() => {}, 1000);", { binTimeoutMs: 300 });
  const started = Date.now();
  assert.deepEqual(await hung.s.resolveBin("claude"), { reason: "the runtime didn't answer" });
  assert.ok(Date.now() - started < 5000);
  const child = hung.children[0];
  if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once("exit", r));
  assert.ok(child.signalCode !== null, "the runtime child was killed");
});

test("catalog: the runtime's answer for each host; a host that does not answer keeps its aliases; one fetch at a time", async () => {
  const s = hosts();
  const [a, b] = await Promise.all([s.catalog(), s.catalog()]);
  assert.ok(a.ok, JSON.stringify(a));
  assert.deepEqual(b, a, "one fetch at a time: the second call shares the first");
  assert.equal(a.data.schema, 1);
  const claude = a.data.hosts.claude;
  assert.ok(claude && !claude.ok && claude.reason, "the stand-in claude never answers initialize");
  assert.deepEqual(claude.models.map((m) => m.id), ["default", "opus", "fable", "sonnet", "haiku"]);
  assert.ok(fs.existsSync(path.join(vault, "brain", "_index", "host-catalog.json")));
  assert.ok((await s.catalog(true)).ok);
  assert.deepEqual(await hosts({ vaultRoot: () => null }).catalog(), { ok: false, error: "no vault is open", code: "EROFS" });
});

test("D11: the catalog answers with the sessions surface off", async () => {
  // HostService takes no surface switch: Code's composer and Routines read the model lists whichever surfaces are on.
  const opts: HostServiceOptions & { enabled?: () => boolean } = { vaultRoot: () => vault, context: () => context, env, node: () => process.execPath, enabled: () => false };
  const r = await new HostService(opts).catalog();
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.data.hosts.claude && r.data.hosts.codex);
});

test("postComputerNotice: one Notifications item from computer at level info, through the runtime's notify.js, the body on stdin (agent-computer D27)", async () => {
  const s = hosts({ computerOn: () => true });
  const dir = path.join(vault, "brain", "notifications");
  fs.rmSync(dir, { recursive: true, force: true });
  await s.postComputerNotice("Submit: Click “Pay” on a.test?", "Alpha is waiting for your answer in the Computer pane.\n--json is just text here");
  const years = fs.readdirSync(dir).filter((d) => /^\d{4}$/.test(d));
  assert.equal(years.length, 1);
  const files = fs.readdirSync(path.join(dir, years[0]));
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(dir, years[0], files[0]), "utf8");
  assert.match(text, /^from: "computer"$/m);
  assert.match(text, /^level: "info"$/m);
  assert.match(text, /^title: "Submit: Click “Pay” on a\.test\?"$/m);
  assert.match(text, /Alpha is waiting for your answer in the Computer pane\.\n--json is just text here\n$/);
});

test("postComputerNotice: a title the runtime would refuse, or no vault, rejects without running anything", async () => {
  let spawned = 0;
  const spawnImpl = ((...a: Parameters<typeof childProcess.spawn>) => { spawned++; return childProcess.spawn(...a); }) as unknown as typeof childProcess.spawn;
  const s = hosts({ computerOn: () => true, spawnImpl });
  for (const bad of ["", "  ", "two\nlines", "-flag", "--json", "x".repeat(161)]) {
    await assert.rejects(s.postComputerNotice(bad, "body"), /title/, JSON.stringify(bad));
  }
  assert.equal(spawned, 0);
  await assert.rejects(hosts({ vaultRoot: () => null, computerOn: () => true, spawnImpl }).postComputerNotice("Submit: x?", "body"), /no vault is open/);
  assert.equal(spawned, 0);
});

test("postComputerNotice: nothing runs while the Computer surface is off (agent-computer D26)", async () => {
  let spawned = 0;
  const spawnImpl = ((...a: Parameters<typeof childProcess.spawn>) => { spawned++; return childProcess.spawn(...a); }) as unknown as typeof childProcess.spawn;
  let on = false;
  const s = hosts({ computerOn: () => on, spawnImpl });
  await assert.rejects(s.postComputerNotice("Submit: x?", "body"), /the Computer surface is off/);
  assert.equal(spawned, 0);
  on = true;
  await s.postComputerNotice("Submit: x?", "body");
  assert.equal(spawned, 1);
});
