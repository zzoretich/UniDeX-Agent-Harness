// Phase 5's main-side setup: the login PATH, the payload, the preflight checks, the setup policy (fixes, vault paths,
// persona answers, which step runs when), the CLAUDE.md diff, the PATH line, attach state, the job runner and the
// controller that ties them together (install-import B1, B2, B14). Probes, terminals, child processes and the network
// are fakes; files go to a temp folder. The toolchain's own jobs are tests/unit/toolchain.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { SetupEvent } from "../../src/shared/ipc";
import { PATH_MARKER, findOnPath, installDirs, loginPath, mergePath, parseLoginPath, shellPath } from "../../src/main/setup/env";
import { cmpVersion, findPayload, readPayload } from "../../src/main/setup/payload";
import { parseTags, parseVersion, runPreflight, type PreflightDeps, type ProbeResult } from "../../src/main/setup/preflight";
import { FIXES, FIX_IDS, PATH_LINE, fixBlocked, fixCommandLine, installArgs, personaJson, requestHosts, resolveVaultPath, stepRefusal, zprofilePath, type SetupState } from "../../src/main/policy/setup";
import { applyClaudeMd, claudeMdLine, claudeMdPath, previewClaudeMd } from "../../src/main/setup/claude-md";
import { applyPathLine, previewPathLine } from "../../src/main/setup/path-line";
import { MANIFEST, RAM_TIERS, ollamaModels, privateNodeBinDir, type Fetch } from "../../src/main/setup/toolchain";
import { attachInfo, hostsOf, markInstalled, markNoted } from "../../src/main/setup/attach";
import { JobRunner } from "../../src/main/setup/jobs";
import { SetupController, type AgenticosJson } from "../../src/main/setup/controller";
import type { PtyLib, PtyProcess } from "../../src/main/services/pty";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-setup-")));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, "home");
fs.mkdirSync(HOME, { recursive: true });
const GB = 1024 ** 3;
/** The models a 16 GB Mac downloads (local-first A12): the 9b workhorse and the embedder. */
const MODELS = ollamaModels(16 * GB);

// ── env ──────────────────────────────────────────────────────────────

test("the login PATH comes from after the marker, whatever the shell printed before it", () => {
  assert.equal(parseLoginPath(`Welcome!\n${PATH_MARKER}/opt/homebrew/bin:/usr/bin\n`), "/opt/homebrew/bin:/usr/bin");
  assert.equal(parseLoginPath("no marker here"), null);
  assert.equal(parseLoginPath(`${PATH_MARKER}\n`), null);
});

test("PATH lists merge in order, each folder once, without relative entries", () => {
  assert.equal(mergePath("/a:/b", ["/b", "rel", "/c"], null, ""), "/a:/b:/c");
});

test("loginPath: $AOS_SETUP_PATH replaces the lookup; else the shell's PATH, the installers' folders, the system's", () => {
  const exec = (): string => { throw new Error("must not run"); };
  assert.equal(loginPath({ shell: "/bin/zsh", home: HOME, env: { AOS_SETUP_PATH: "/x:/y" }, exec }), "/x:/y");
  const seen: string[][] = [];
  const got = loginPath({ shell: "/bin/zsh", home: HOME, env: {}, exec: (file, args) => { seen.push([file, ...args]); return `hi\n${PATH_MARKER}/opt/homebrew/bin:/custom\n`; } });
  assert.equal(seen[0][0], "/bin/zsh");
  assert.deepEqual(seen[0].slice(1, 2), ["-lic"]);
  assert.deepEqual(got.split(":").slice(0, 2), ["/opt/homebrew/bin", "/custom"]);
  for (const d of [...installDirs(HOME), "/usr/bin", "/bin"]) assert.ok(got.split(":").includes(d), d);
  // The wizard's own Node (install-import B1) is on it, so a Node it installed is found without a new shell.
  assert.ok(installDirs(HOME).includes(privateNodeBinDir(HOME)));
  // A shell that fails: main's own PATH, then the same folders.
  const fallback = loginPath({ shell: "/bin/zsh", home: HOME, env: { PATH: "/only" }, exec: () => { throw new Error("no shell"); } });
  assert.equal(fallback.split(":")[0], "/only");
  assert.ok(fallback.includes(path.join(HOME, ".local", "bin")));
  // The shell's own PATH, without the folders main adds (Finish's PATH line asks whether ~/.local/bin is really on it).
  assert.equal(shellPath({ shell: "/bin/zsh", home: HOME, env: {}, exec: () => `${PATH_MARKER}/usr/bin:/bin\n` }), "/usr/bin:/bin");
  assert.equal(shellPath({ shell: "/bin/zsh", home: HOME, env: {}, exec: () => { throw new Error("no shell"); } }), null);
  // Asked once: loginPath takes the answer it was given.
  assert.equal(loginPath({ shell: "/bin/zsh", home: HOME, env: {}, exec: () => { throw new Error("must not run"); } }, "/given").split(":")[0], "/given");
});

test("findOnPath: the first executable of that name", () => {
  const a = path.join(ROOT, "pa"), b = path.join(ROOT, "pb");
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, "tool"), "", { mode: 0o644 });
  fs.writeFileSync(path.join(b, "tool"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(findOnPath("tool", `${a}:${b}`), path.join(b, "tool"));
  assert.equal(findOnPath("nope", `${a}:${b}`), null);
});

// ── payload ──────────────────────────────────────────────────────────

function makePayload(dir: string, manifest: object | null, pkg: object | null = { version: "1.2.3" }): string {
  fs.mkdirSync(path.join(dir, "cli"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cli", "aos.js"), "");
  if (manifest) fs.writeFileSync(path.join(dir, "payload.json"), JSON.stringify(manifest));
  if (pkg) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

test("a payload is a release tree with a CLI and a version; its dependencies count only when payload.json says so and they are there", () => {
  const p = makePayload(path.join(ROOT, "payload-a"), { schema: 1, version: "1.0.0", runtimeDeps: true });
  assert.deepEqual(readPayload(p), { root: p, cli: path.join(p, "cli", "aos.js"), version: "1.0.0", runtimeDeps: false });
  fs.mkdirSync(path.join(p, "brain", "scripts", "node_modules"), { recursive: true });
  assert.equal(readPayload(p)?.runtimeDeps, true);
  // A checkout: no payload.json, package.json's version, npm installs.
  assert.equal(readPayload(makePayload(path.join(ROOT, "payload-b"), null))?.version, "1.2.3");
  assert.equal(readPayload(makePayload(path.join(ROOT, "payload-c"), null, { version: "latest" })), null);
  assert.equal(readPayload(path.join(ROOT, "nowhere")), null);
});

test("findPayload: $AOS_APP_PAYLOAD, else the bundle's when packaged, else none", () => {
  const p = makePayload(path.join(ROOT, "res", "payload"), { schema: 1, version: "2.0.0", runtimeDeps: false });
  assert.equal(findPayload({ packaged: false, resourcesPath: path.join(ROOT, "res"), env: {} }), null);
  assert.equal(findPayload({ packaged: true, resourcesPath: path.join(ROOT, "res"), env: {} })?.version, "2.0.0");
  assert.equal(findPayload({ packaged: false, resourcesPath: "/x", env: { AOS_APP_PAYLOAD: p } })?.root, p);
  assert.equal(findPayload({ packaged: true, resourcesPath: "/x", env: { AOS_APP_PAYLOAD: "relative" } }), null);
});

test("cmpVersion orders releases and prereleases", () => {
  assert.equal(cmpVersion("0.21.0", "1.0.0"), -1);
  assert.equal(cmpVersion("1.0.0", "1.0.0"), 0);
  assert.equal(cmpVersion("1.0.0-rc.2", "1.0.0"), -1);
  assert.equal(cmpVersion("1.0.0-rc.10", "1.0.0-rc.9"), 1);
  assert.equal(cmpVersion("1.10.0", "1.9.9"), 1);
  assert.equal(cmpVersion(null, "1.0.0"), null);
  assert.equal(cmpVersion("x", "1.0.0"), null);
});

// ── preflight ────────────────────────────────────────────────────────

/** A machine of fake programs: name → what `--version` (and the login probes) answer. A 16 GB Mac on macOS 15. */
function machine(tools: Record<string, Partial<Record<string, ProbeResult>>>, extra: Partial<PreflightDeps> = {}): PreflightDeps {
  const dir = "/fake/bin";
  return {
    PATH: dir, home: HOME, totalmem: 16 * GB, macOS: "15.3",
    isExec: (p) => path.dirname(p) === dir && path.basename(p) in tools,
    exists: () => false,
    run: async (file, args) => {
      const t = tools[path.basename(file)];
      return t?.[args.join(" ")] ?? { code: 1, out: "" };
    },
    ...extra,
  };
}
const v = (out: string, code = 0): ProbeResult => ({ code, out });
const TAGS = "-q --noproxy 127.0.0.1 -fs -m 3 http://127.0.0.1:11434/api/tags";
const tags = (...names: string[]): ProbeResult => v(JSON.stringify({ models: names.map((name) => ({ name, model: name, size: 1 })) }));
const ALL = {
  node: { "--version": v("v22.12.0") },
  claude: { "--version": v("2.1.0 (Claude Code)"), "auth status --json": v('{"loggedIn":true}') },
  codex: { "--version": v("codex-cli 0.150.0"), "login status": v("Logged in using ChatGPT") },
  ollama: { "--version": v("ollama version is 0.40.4") },
  uv: { "--version": v("uv 0.13.1 (stand-in)") },
  curl: { [TAGS]: tags("llama3.2:latest", ...MODELS) },
};

test("parseVersion reads the first x.y of a version line", () => {
  assert.deepEqual(parseVersion("v22.12.0"), [22, 12]);
  assert.deepEqual(parseVersion("Python 3.9.6"), [3, 9]);
  assert.equal(parseVersion("none"), null);
});

test("everything there: ready, both hosts, and main learns the node to run; nothing asks about Homebrew or Python", async () => {
  const { report, node } = await runPreflight(machine(ALL));
  assert.equal(report.ready, true);
  assert.deepEqual(report.hosts, { claude: true, codex: true });
  assert.equal(node, "/fake/bin/node");
  assert.ok(report.checks.every((c) => c.state === "ok" && c.fix === null));
  assert.deepEqual(report.checks.map((c) => c.id), ["node", "uv", "ollama", "ollama-models", "claude", "claude-login", "codex", "codex-login"]);
  assert.deepEqual(report.models, MODELS);
  assert.deepEqual(report.checks.filter((c) => c.required).map((c) => c.id), ["node", "uv"]);
});

test("one host is enough; a missing login offers its terminal fix; codex's 'Not logged in' does not count", async () => {
  const { report } = await runPreflight(machine({ ...ALL, codex: { "--version": v("codex-cli 0.150.0"), "login status": v("Not logged in", 1) } }));
  assert.equal(report.ready, true);
  assert.deepEqual(report.hosts, { claude: true, codex: false });
  const login = report.checks.find((c) => c.id === "codex-login");
  assert.equal(login?.state, "missing");
  assert.equal(login?.fix, "codex-login");
  assert.equal(login?.fixKind, "terminal");
  assert.equal(login?.fixCommand, "codex login");
  assert.equal(login?.fixBlocked, null);
});

test("install-import B2: no host at all is still ready, and each host's install is a download that needs nothing first", async () => {
  const { claude: _c, codex: _x, ...rest } = ALL;
  const { report } = await runPreflight(machine(rest));
  assert.equal(report.ready, true);
  assert.deepEqual(report.hosts, { claude: false, codex: false });
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(by.claude.state, "missing");
  assert.equal(by.claude.required, false);
  assert.equal(by.claude.fixKind, "download");
  assert.equal(by.claude.fixBlocked, null, "the native installer needs no Node");
  assert.match(by.claude.fixCommand ?? "", /from downloads\.claude\.ai .*claude install/);
  assert.equal(by["claude-login"].fixBlocked, "needs Claude Code first");
  assert.match(by.codex.fixCommand ?? "", /from github\.com\/openai\/codex/);
});

test("an old node, no uv: not ready, each with its download; the wizard's own Node is used when the PATH's is too old", async () => {
  const { uv: _u, ...rest } = ALL;
  const { report, node } = await runPreflight(machine({ ...rest, node: { "--version": v("v18.19.0") } }));
  assert.equal(report.ready, false);
  assert.equal(node, null);
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.match(by.node.detail, /v18\.19\.0 at \/fake\/bin\/node: UniDeX needs 20\.0\.0 or newer/);
  assert.equal(by.node.fix, "node");
  assert.equal(by.node.fixKind, "download");
  assert.match(by.node.fixCommand ?? "", new RegExp(`Downloads Node\\.js ${MANIFEST.tools.node.version.replace(/\./g, "\\.")} from nodejs\\.org`));
  assert.equal(by.uv.fix, "uv");
  assert.equal(by.uv.fixBlocked, null);
  // The Node the wizard installed, in ~/.local/share/unidex/node/current: found even though the PATH's is older.
  const ours = path.join(privateNodeBinDir(HOME), "node");
  const deps = machine({ ...rest, node: { "--version": v("v18.19.0") } });
  const isExec = deps.isExec!;
  deps.isExec = (p) => p === ours || isExec(p);
  const run = deps.run;
  deps.run = async (file, args, t) => file === ours ? v(`v${MANIFEST.tools.node.version}`) : run(file, args, t);
  const fixed = await runPreflight(deps);
  assert.equal(fixed.node, ours);
  assert.equal(fixed.report.checks.find((c) => c.id === "node")?.state, "ok");
});

test("inspection F5: a uv that does not answer --version with a version fails its check, unless another uv on the Mac does", async () => {
  const broken = { ...ALL, uv: { "--version": v("dyld: Library not loaded", 134) } };
  const { report } = await runPreflight(machine(broken));
  const uvRow = report.checks.find((c) => c.id === "uv");
  assert.equal(uvRow?.state, "missing");
  assert.equal(uvRow?.detail, "/fake/bin/uv did not answer uv --version with a version");
  assert.equal(uvRow?.fix, "uv");
  assert.equal(report.ready, false, "Continue waits for a uv that runs");
  // A working uv in ~/.local/bin is found and used, though the PATH's comes first.
  const local = path.join(HOME, ".local", "bin", "uv");
  const deps = machine(broken);
  const isExec = deps.isExec!;
  deps.isExec = (p) => p === local || isExec(p);
  const run = deps.run;
  deps.run = async (file, args, t) => (file === local ? v("uv 0.13.1 (Homebrew)") : run(file, args, t));
  const ok = (await runPreflight(deps)).report.checks.find((c) => c.id === "uv");
  assert.equal(ok?.state, "ok");
  assert.equal(ok?.detail, `uv 0.13.1 · ${local}`);
  // An Ollama that reports no version is not trusted either: a warning whose download installs (or opens) the app.
  const mute = (await runPreflight(machine({ ...ALL, ollama: { "--version": v("", 1) } }))).report.checks.find((c) => c.id === "ollama");
  assert.equal(mute?.state, "warn");
  assert.equal(mute?.detail, "/fake/bin/ollama did not report its version");
  assert.equal(mute?.fix, "ollama");
});

test("Python and the Command Line Tools are never asked about (graphify's Python comes with uv)", async () => {
  const ran: string[] = [];
  const deps = machine(ALL);
  const run = deps.run;
  deps.run = async (file, args, t) => { ran.push(file); return run(file, args, t); };
  await runPreflight(deps);
  assert.ok(!ran.some((f) => /python|xcode-select|brew/.test(f)), ran.join(" "));
});

test("Ollama.app counts as Ollama (its version read from Info.plist, nothing opened), and uv in ~/.local/bin counts as uv", async () => {
  const { ollama: _o, uv: _u, ...rest } = ALL;
  const uv = path.join(HOME, ".local", "bin", "uv");
  const deps = machine(rest, { exists: (p) => p === "/Applications/Ollama.app" });
  const isExec = deps.isExec!;
  deps.isExec = (p) => p === uv || isExec(p);
  const ran: string[][] = [];
  const run = deps.run;
  deps.run = async (file, args, t) => { ran.push([file, ...args]); return file === uv ? v("uv 0.11.32 (Homebrew)") : file === "/usr/bin/plutil" ? v("0.34.3") : run(file, args, t); };
  const { report, ollamaApp } = await runPreflight(deps);
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(by.ollama.detail, "0.34.3 · /Applications/Ollama.app");
  assert.equal(ollamaApp, "/Applications/Ollama.app");
  assert.deepEqual(ran.find((c) => c[0] === "/usr/bin/plutil")?.slice(1), ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", "/Applications/Ollama.app/Contents/Info.plist"]);
  assert.equal(by.uv.detail, `uv 0.11.32 · ${uv}`);
  assert.equal(report.ready, true);
});

test("Ollama older than its floor is a warning with no download (it updates itself); a uv older than its floor is missing", async () => {
  const { report } = await runPreflight(machine({ ...ALL, ollama: { "--version": v("ollama version is 0.12.3") }, uv: { "--version": v("uv 0.2.9") } }));
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(by.ollama.state, "warn");
  assert.equal(by.ollama.fix, null);
  assert.match(by.ollama.detail, new RegExp(`0\\.12\\.3 at /fake/bin/ollama is older than ${MANIFEST.tools.ollama.floor?.replace(/\./g, "\\.")}, which qwen3\\.5:9b needs: update Ollama from its menu`));
  assert.equal(by.uv.state, "missing");
  assert.equal(by.uv.fix, "uv");
  assert.equal(report.ready, false);
});

test("no Ollama: a warning (not required) whose download waits for nothing, except on a macOS older than it needs", async () => {
  const { ollama: _o, ...rest } = ALL;
  const ran: string[] = [];
  const deps = machine(rest);
  const run = deps.run;
  deps.run = async (file, args, t) => { ran.push(path.basename(file)); return run(file, args, t); };
  const { report } = await runPreflight(deps);
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.ok(!ran.includes("curl"), "nothing to ask without Ollama");
  assert.equal(by.ollama.state, "warn");
  assert.equal(by.ollama.required, false);
  assert.equal(by.ollama.fix, "ollama");
  assert.equal(by.ollama.fixBlocked, null);
  assert.equal(by["ollama-models"].state, "warn");
  assert.equal(by["ollama-models"].fixBlocked, "needs Ollama first");
  assert.equal(report.ready, true, "Continue never waits for Ollama");
  const old = (await runPreflight(machine(rest, { macOS: "13.6.1" }))).report.checks.find((c) => c.id === "ollama");
  assert.equal(old?.fixBlocked, "needs macOS 14.0 or newer");
});

test("Ollama's models: the Mac's tier, asked over HTTP; one missing is a warning with its download, and Continue does not wait for it", async () => {
  const { report } = await runPreflight(machine({ ...ALL, curl: { [TAGS]: tags("qwen3-embedding:0.6b") } }));
  const models = report.checks.find((c) => c.id === "ollama-models");
  assert.equal(models?.state, "warn");
  assert.equal(models?.required, false);
  assert.equal(models?.detail, "not downloaded: qwen3.5:9b");
  assert.equal(models?.fix, "ollama-models");
  assert.equal(models?.fixKind, "download");
  assert.equal(models?.fixBlocked, null);
  assert.equal(report.ready, true);
  // An 8 GB Mac wants the 4b.
  const small = await runPreflight(machine({ ...ALL, curl: { [TAGS]: tags(...MODELS) } }, { totalmem: 8 * GB }));
  assert.deepEqual(small.report.models, ["qwen3.5:4b", "qwen3-embedding:0.6b"]);
  assert.equal(small.report.checks.find((c) => c.id === "ollama-models")?.detail, "not downloaded: qwen3.5:4b");
  const down = (await runPreflight(machine({ ...ALL, curl: { [TAGS]: v("", 7) } }))).report.checks.find((c) => c.id === "ollama-models");
  assert.equal(down?.state, "warn");
  assert.match(down?.detail ?? "", /not running/);
});

test("parseTags reads the names in Ollama's answer, and nothing from a failed or garbled one", () => {
  assert.deepEqual(parseTags(tags("qwen3.5:9b")), ["qwen3.5:9b", "qwen3.5:9b"]);
  assert.equal(parseTags(v("", 7)), null);
  assert.equal(parseTags(v("<html>")), null);
  assert.equal(parseTags(null), null);
});

test("the app's Ollama models are models.js's workhorse and embedder, tier by tier (local-first A12)", () => {
  // The runtime's roles, loaded at run time from the repo (the tests run bundled from app/out-test/), without the env
  // overrides a developer's shell may set.
  const models = createRequire(__filename)(path.resolve(__dirname, "../../brain/scripts/sdk/lib/models.js")) as {
    role(name: string, cfg: object): { tag: string; provider: string };
    LOCAL_TIERS?: Array<{ belowGb: number; tag: string }>;
  };
  const saved = { BRAIN_MODEL: process.env.BRAIN_MODEL, BRAIN_EMBEDDER: process.env.BRAIN_EMBEDDER };
  delete process.env.BRAIN_MODEL;
  delete process.env.BRAIN_EMBEDDER;
  try {
    const roles = [models.role("workhorse", {}), models.role("embedder", {})];
    // A Mac at or above the last tier's floor pulls what the runtime runs by default.
    assert.deepEqual(ollamaModels(64 * GB), roles.map((r) => r.tag));
    assert.ok(roles.every((r) => r.provider === "ollama"));
    // Once the runtime carries the tiers (local-first PR 1), the two tables are one.
    if (models.LOCAL_TIERS) assert.deepEqual(RAM_TIERS, models.LOCAL_TIERS);
  } finally {
    for (const [k, val] of Object.entries(saved)) if (val !== undefined) process.env[k] = val;
  }
});

// ── policy ───────────────────────────────────────────────────────────

test("every fix is a toolchain download or, for a login, a fixed command run by /bin/sh -c; the page cannot add one", () => {
  assert.deepEqual([...FIX_IDS].sort(), ["claude", "claude-login", "codex", "codex-login", "node", "ollama", "ollama-models", "uv"]);
  assert.deepEqual(FIX_IDS.filter((id) => FIXES[id].kind === "terminal").sort(), ["claude-login", "codex-login"]);
  assert.deepEqual(fixCommandLine("claude-login"), { file: "/bin/sh", args: ["-c", "claude auth login"] });
  assert.throws(() => fixCommandLine("uv"), /not a terminal fix/);
  assert.equal(JSON.stringify(FIXES).includes("brew"), false, "no fix needs Homebrew (install-import B1)");
  assert.equal(JSON.stringify(FIXES).includes("npm"), false);
  assert.equal(fixBlocked("uv", new Set()), null);
  assert.equal(fixBlocked("ollama-models", new Set()), "needs Ollama first");
  assert.equal(fixBlocked("codex-login", new Set()), "needs the Codex CLI first");
});

test("a vault folder is absolute or ~/…, never home itself or a root", () => {
  assert.equal(resolveVaultPath("~/AgenticOS", HOME), path.join(HOME, "AgenticOS"));
  assert.equal(resolveVaultPath(" /Volumes/Data/Vault/ ", HOME), "/Volumes/Data/Vault");
  assert.equal(resolveVaultPath("~", HOME), null);
  assert.equal(resolveVaultPath(HOME, HOME), null);
  assert.equal(resolveVaultPath("/", HOME), null);
  assert.equal(resolveVaultPath("AgenticOS", HOME), null);
});

test("persona answers: trimmed, and each host's model only where that host is on", () => {
  const a = { name: " Atlas ", addressAs: "Sam ", voice: "", priorities: [" ship ", ""], dutyModel: "sonnet", dutyCodexModel: "gpt-5.1", dutyEffort: "high" as const, schedule: false };
  assert.deepEqual(personaJson(a, { claude: true, codex: false }), { name: "Atlas", addressAs: "Sam", voice: "", priorities: ["ship"], dutyModel: "sonnet", dutyEffort: "high", schedule: false });
  assert.deepEqual(Object.keys(personaJson(a, { claude: false, codex: true })), ["name", "addressAs", "voice", "priorities", "dutyCodexModel", "dutyEffort", "schedule"]);
  assert.deepEqual(installArgs("/p/cli/aos.js", { host: "both", vault: "x", persona: null }, "/v", null), ["/p/cli/aos.js", "init", "--yes", "--vault", "/v", "--host", "both"]);
  assert.deepEqual(installArgs("/p/cli/aos.js", { host: "codex", vault: "x", persona: null }, "/v", "/a.json").slice(-2), ["--persona-json", "/a.json"]);
  assert.deepEqual(installArgs("/p/cli/aos.js", { host: "none", vault: "x", persona: null }, "/v", null).slice(-2), ["--host", "none"]);
  assert.deepEqual(requestHosts("none"), { claude: false, codex: false });
  assert.deepEqual(requestHosts("both"), { claude: true, codex: true });
  assert.deepEqual(requestHosts("codex"), { claude: false, codex: true });
});

test("each step runs only in its state", () => {
  const s = (o: Partial<SetupState>): SetupState => ({ attached: false, installed: false, payload: true, behind: false, busy: false, ...o });
  assert.equal(stepRefusal("install", s({})), null);
  assert.equal(stepRefusal("install", s({ attached: true })), "a vault is already attached");
  assert.equal(stepRefusal("install", s({ payload: false })), "this build carries no runtime");
  assert.equal(stepRefusal("install", s({ busy: true })), "another setup step is running");
  assert.equal(stepRefusal("upgrade", s({ attached: true, behind: true })), null);
  assert.equal(stepRefusal("upgrade", s({ attached: true })), "the vault's runtime is not behind this app's");
  assert.equal(stepRefusal("upgrade", s({ behind: true })), "no vault is attached");
  assert.equal(stepRefusal("finish", s({})), null);
  assert.equal(stepRefusal("finish", s({ attached: true })), "a vault is already attached");
  assert.equal(stepRefusal("claude-md", s({})), "no vault yet");
  assert.equal(stepRefusal("fix", s({})), null);
  assert.equal(stepRefusal("fix", s({ attached: true })), "a vault is already attached");
  assert.equal(stepRefusal("fix", s({ busy: true })), "another setup step is running");
  assert.equal(stepRefusal("preflight", s({ busy: true })), null, "the checks may re-run while a fix runs");
  assert.equal(stepRefusal("preflight", s({ attached: true })), "a vault is already attached");
  assert.equal(stepRefusal("claude-md", s({ installed: true, busy: true })), null);
  // Finish's PATH line: the wizard's, after the install and before the Workbench opens.
  assert.equal(stepRefusal("path", s({})), "no vault yet");
  assert.equal(stepRefusal("path", s({ installed: true })), null);
  assert.equal(stepRefusal("path", s({ installed: true, attached: true })), "a vault is already attached");
});

// ── the PATH line (install-import B14) ──────────────────────────────

test("the PATH line: ~/.zprofile ($ZDOTDIR's when set), shown before it is written, appended once, a symlink written through", () => {
  assert.equal(PATH_LINE, 'export PATH="$HOME/.local/bin:$PATH"');
  assert.equal(zprofilePath(HOME, {}), path.join(HOME, ".zprofile"));
  assert.equal(zprofilePath(HOME, { ZDOTDIR: "/z" }), "/z/.zprofile");
  assert.equal(zprofilePath(HOME, { ZDOTDIR: "relative" }), path.join(HOME, ".zprofile"));
  const home = path.join(ROOT, "pathline");
  const file = path.join(home, ".zprofile");
  fs.mkdirSync(home, { recursive: true });
  assert.deepEqual(previewPathLine(file, home, "/usr/bin:/bin"), { file, line: PATH_LINE, present: false, onPath: false });
  assert.equal(previewPathLine(file, home, `/usr/bin:${path.join(home, ".local", "bin")}`).onPath, true);
  assert.equal(fs.existsSync(file), false, "a preview writes nothing");
  fs.writeFileSync(file, "eval \"$(/opt/homebrew/bin/brew shellenv)\"");
  assert.equal(applyPathLine(file, home, null).present, true);
  applyPathLine(file, home, null);
  assert.equal(fs.readFileSync(file, "utf8"), `eval "$(/opt/homebrew/bin/brew shellenv)"\n${PATH_LINE}\n`);
  // A dotfiles symlink stays a symlink.
  const real = path.join(ROOT, "dotfiles-zprofile");
  fs.writeFileSync(real, "# mine\n");
  const link = path.join(ROOT, "pathline2", ".zprofile");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  applyPathLine(link, path.dirname(link), null);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(real, "utf8"), `# mine\n${PATH_LINE}\n`);
});

// ── CLAUDE.md ────────────────────────────────────────────────────────

test("CLAUDE.md: where it is, the diff, and an append only when the line is missing", () => {
  const vault = path.join(ROOT, "Vault");
  assert.equal(claudeMdLine(vault), `@${vault}/AGENTICOS.md`);
  assert.equal(claudeMdPath({ configDir: "/c", env: { CLAUDE_CONFIG_DIR: "/e" }, home: HOME }), "/c/CLAUDE.md");
  assert.equal(claudeMdPath({ configDir: null, env: { CLAUDE_CONFIG_DIR: "/e" }, home: HOME }), "/e/CLAUDE.md");
  assert.equal(claudeMdPath({ env: {}, home: HOME }), path.join(HOME, ".claude", "CLAUDE.md"));

  const file = path.join(ROOT, "claude", "CLAUDE.md");
  const fresh = previewClaudeMd(file, vault);
  assert.deepEqual(fresh.diff, [{ kind: "add", text: `@${vault}/AGENTICOS.md` }]);
  assert.equal(applyClaudeMd(file, vault).present, true);
  assert.equal(fs.readFileSync(file, "utf8"), `@${vault}/AGENTICOS.md\n`);

  fs.writeFileSync(file, "a\nb\nc\nd");
  const p = previewClaudeMd(file, vault);
  assert.deepEqual(p.diff.map((l) => `${l.kind}:${l.text}`), ["context:b", "context:c", "context:d", `add:@${vault}/AGENTICOS.md`]);
  applyClaudeMd(file, vault);
  applyClaudeMd(file, vault);
  assert.equal(fs.readFileSync(file, "utf8"), `a\nb\nc\nd\n@${vault}/AGENTICOS.md\n`);
});

test("CLAUDE.md: a ~/ import of the same file counts, and a symlinked file is written through", () => {
  const vault = path.join(HOME, "AgenticOS");
  const real = path.join(ROOT, "dotfiles", "CLAUDE.md");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "# mine\n");
  const link = path.join(ROOT, "claude2", "CLAUDE.md");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  applyClaudeMd(link, vault, HOME);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(real, "utf8"), `# mine\n@${vault}/AGENTICOS.md\n`);
  fs.writeFileSync(real, "@~/AgenticOS/AGENTICOS.md\n");
  assert.equal(previewClaudeMd(link, vault, HOME).present, true);
});

test("inspection F2: a profile or CLAUDE.md that exists but cannot be read is refused with the reason, and kept as it was", () => {
  const home = path.join(ROOT, "unreadable");
  fs.mkdirSync(home, { recursive: true });
  const profile = path.join(home, ".zprofile");
  fs.writeFileSync(profile, "export SECRET_SETUP=1\n");
  fs.chmodSync(profile, 0o000);
  const md = path.join(home, "CLAUDE.md");
  fs.writeFileSync(md, "# rules I wrote\n");
  fs.chmodSync(md, 0o000);
  try {
    assert.throws(() => previewPathLine(profile, home, null), /\.zprofile could not be read \(EACCES\), so nothing was written/);
    assert.throws(() => applyPathLine(profile, home, null), /could not be read \(EACCES\)/);
    assert.throws(() => applyClaudeMd(md, path.join(home, "Vault"), home), /CLAUDE\.md could not be read \(EACCES\)/);
    // A folder where the profile should be is not "absent" either.
    const dirHome = path.join(ROOT, "dirprofile");
    fs.mkdirSync(path.join(dirHome, ".zprofile"), { recursive: true });
    assert.throws(() => applyPathLine(path.join(dirHome, ".zprofile"), dirHome, null), /could not be read \(EISDIR\)/);
  } finally {
    fs.chmodSync(profile, 0o644);
    fs.chmodSync(md, 0o644);
  }
  assert.equal(fs.readFileSync(profile, "utf8"), "export SECRET_SETUP=1\n", "the profile's contents survive");
  assert.equal(fs.readFileSync(md, "utf8"), "# rules I wrote\n");
  assert.deepEqual(fs.readdirSync(home).sort(), [".zprofile", "CLAUDE.md"], "no temp file left behind");
});

// ── attach ───────────────────────────────────────────────────────────

test("attach: the note is due until noted, per vault; behind when the runtime is older than the payload", () => {
  const ud = path.join(ROOT, "userData");
  const vault = path.join(ROOT, "v1");
  const cfg = { version: "0.21.0", hosts: { claude: { enabled: true }, codex: { enabled: true } } };
  const first = attachInfo(ud, vault, cfg, "1.0.0");
  assert.deepEqual(first, { firstTime: true, installed: false, runtimeVersion: "0.21.0", payloadVersion: "1.0.0", behind: true, hosts: { claude: true, codex: true } });
  assert.equal(attachInfo(ud, vault, cfg, "1.0.0").firstTime, true);
  markNoted(ud, vault);
  assert.equal(attachInfo(ud, vault, cfg, "1.0.0").firstTime, false);
  assert.equal(attachInfo(ud, path.join(ROOT, "v2"), cfg, "1.0.0").firstTime, true);
  assert.equal(attachInfo(ud, vault, { version: "1.0.0" }, "1.0.0").behind, false);
  assert.equal(attachInfo(ud, vault, null, null).behind, false);
  assert.deepEqual(hostsOf(null), { claude: true, codex: false });
});

test("attach: a vault the wizard installed is a new install (the tour, not the What changed note), until noted", () => {
  const ud = path.join(ROOT, "userData-installed");
  const vault = path.join(ROOT, "v-new");
  markInstalled(ud, vault);
  assert.deepEqual([attachInfo(ud, vault, null, null).firstTime, attachInfo(ud, vault, null, null).installed], [true, true]);
  markNoted(ud, vault);
  assert.deepEqual([attachInfo(ud, vault, null, null).firstTime, attachInfo(ud, vault, null, null).installed], [false, true]);
  // A vault the app opened but did not install stays an existing one.
  assert.equal(attachInfo(ud, path.join(ROOT, "v-old"), null, null).installed, false);
});

// ── jobs ─────────────────────────────────────────────────────────────

class FakePty extends EventEmitter implements PtyProcess {
  pid = 4242;
  written: string[] = [];
  killed = false;
  write(d: string): void { this.written.push(d); }
  resize(): void { /* nothing */ }
  kill(): void { this.killed = true; this.emit("exit", { exitCode: 130 }); }
  onData(cb: (d: string) => void): unknown { return this.on("data", cb); }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown { return this.on("exit", cb); }
}

/** A child process as JobRunner sees one: like Node's, it emits close only after both of its streams have ended. */
function fakeChild(): { child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): void }; finish(code: number): void } {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { /* recorded by the caller */ } });
  return {
    child,
    finish: (code) => {
      let open = 2;
      const ended = (): void => { if (--open === 0) setImmediate(() => child.emit("close", code, null)); };
      child.stdout.once("end", ended);
      child.stderr.once("end", ended);
      child.stdout.end();
      child.stderr.end();
    },
  };
}

/** Waits until `events` holds an exit for `job` (or fails after 2 s). */
async function exitOf(events: SetupEvent[], job: string): Promise<void> {
  const end = Date.now() + 2000;
  while (!events.some((e) => e.type === "exit" && e.job === job)) {
    if (Date.now() > end) throw new Error(`no exit for ${job}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("jobs: one at a time; a terminal's output and exit stream as events, after the echoed command", () => {
  const events: SetupEvent[] = [];
  const exits: Array<[string, number | null]> = [];
  const pty = new FakePty();
  const lib: PtyLib = { spawn: () => pty };
  const jobs = new JobRunner({ emit: (e) => events.push(e), pty: () => lib, onExit: (j, c) => exits.push([j, c]) });
  assert.deepEqual(jobs.startPty("fix", "/bin/sh", ["-c", "claude auth login"], { cwd: HOME, env: {}, cols: 80, rows: 24, echo: "claude auth login" }), { ok: true, data: null });
  assert.equal(jobs.running, "fix");
  assert.equal(jobs.startProc("install", "/x", [], { cwd: HOME, env: {}, echo: "x" }).ok, false);
  jobs.input("secret\r");
  assert.deepEqual(pty.written, ["secret\r"]);
  pty.emit("data", "==> done");
  pty.emit("exit", { exitCode: 0 });
  assert.equal(jobs.running, null);
  assert.match((events[0] as { data: string }).data, /\$ claude auth login/);
  assert.deepEqual(events.slice(1), [{ job: "fix", type: "data", data: "==> done" }, { job: "fix", type: "exit", code: 0, signal: null }]);
  assert.deepEqual(exits, [["fix", 0]]);
});

test("inspection F6: a task stopped while it runs ends as stopped, even when it then resolves normally", async () => {
  const events: SetupEvent[] = [];
  const jobs = new JobRunner({ emit: (e) => events.push(e), pty: () => { throw new Error("no pty"); } });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  assert.equal(jobs.startTask("fix", async (ctx) => { ctx.log("working"); await held; /* ignores its signal */ }, { echo: "Install x" }).ok, true);
  await new Promise((r) => setImmediate(r));
  jobs.cancel();
  release();
  await exitOf(events, "fix");
  assert.deepEqual(events.at(-1), { job: "fix", type: "exit", code: null, signal: "SIGTERM" });
  // Not stopped: exit 0; failed: exit 1 after its message.
  events.length = 0;
  jobs.startTask("fix", async () => undefined, { echo: "ok" });
  await exitOf(events, "fix");
  assert.deepEqual(events.at(-1), { job: "fix", type: "exit", code: 0, signal: null });
  events.length = 0;
  jobs.startTask("fix", async () => { throw new Error("bad hash"); }, { echo: "x" });
  await exitOf(events, "fix");
  assert.match((events.at(-2) as { data: string }).data, /bad hash/);
  assert.deepEqual(events.at(-1), { job: "fix", type: "exit", code: 1, signal: null });
});

test("jobs: a child process gets no stdin, and its line ends are made terminal-ready", async () => {
  const events: SetupEvent[] = [];
  const { child, finish } = fakeChild();
  let opts: Record<string, unknown> = {};
  const jobs = new JobRunner({
    emit: (e) => events.push(e), pty: () => { throw new Error("no pty"); },
    spawnImpl: ((_f: string, _a: string[], o: Record<string, unknown>) => { opts = o; return child; }) as never,
  });
  assert.equal(jobs.startProc("install", "/node", ["aos.js", "init"], { cwd: HOME, env: { A: "1" }, echo: "aos init" }).ok, true);
  assert.deepEqual(opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(opts.shell, false);
  child.stdout.write("a\nb\n");
  finish(0);
  await exitOf(events, "install");
  assert.deepEqual(events.filter((e) => e.type === "data").slice(1).map((e) => (e as { data: string }).data).join(""), "a\r\nb\r\n");
  assert.deepEqual(events.at(-1), { job: "install", type: "exit", code: 0, signal: null });
});

// ── the controller ───────────────────────────────────────────────────

/** The network a unit test has: none. */
const noNetwork: Fetch = async () => { throw new Error("no network in tests"); };

/** Polls until `events` holds an exit for `job` and returns it. */
async function exitEvent(events: SetupEvent[], job: string): Promise<Extract<SetupEvent, { type: "exit" }>> {
  await exitOf(events, job);
  return events.find((e) => e.type === "exit" && e.job === job) as Extract<SetupEvent, { type: "exit" }>;
}

test("controller: a download fix runs as a toolchain job with progress, and a failed check ends it with exit 1 and the reason", async () => {
  const events: SetupEvent[] = [];
  const home = path.join(ROOT, "ctl-dl-home");
  fs.mkdirSync(home, { recursive: true });
  const { uv: _u, ...rest } = ALL;
  const pin = MANIFEST.tools.uv.assets[process.arch === "x64" ? "x64" : "arm64"];
  const served: string[] = [];
  const ctl = new SetupController({
    home, userData: path.join(ROOT, "ctl-dl-ud"), env: {}, payload: null,
    emit: (e) => events.push(e), pty: () => { throw new Error("no terminal for a download"); },
    attached: () => null, attachInfo: () => null, readAgenticos: () => null, attach: () => false, refreshAttach: () => undefined,
    chooseFolder: async () => null, path: () => "/fake/bin", probe: machine(rest).run, isExec: machine(rest).isExec, exists: () => false,
    totalmem: 16 * GB,
    // The pinned URL answers with bytes that are not the pinned ones: the job must refuse them.
    fetch: async (url) => {
      served.push(url);
      async function* body(): AsyncIterable<Uint8Array> { yield Buffer.alloc(pin.size, 1); }
      return { ok: true, status: 200, body: body() };
    },
    toolRun: async () => ({ code: 1, out: "must not run" }),
  });
  assert.equal(ctl.fix("uv", 80, 24).ok, false, "before the checks");
  assert.ok((await ctl.preflight()).ok);
  const passing = ctl.fix("node", 80, 24);
  assert.ok(!passing.ok && passing.error === "nothing to fix: Node.js 20 or newer passes", "a tool that passes is never downloaded over");
  assert.equal(ctl.fix("uv", 80, 24).ok, true);
  assert.equal(ctl.fix("ollama-models", 80, 24).ok, false, "one job at a time");
  const exit = await exitEvent(events, "fix");
  assert.equal(exit.code, 1);
  assert.deepEqual(served, [pin.url]);
  const text = events.filter((e) => e.type === "data").map((e) => (e as { data: string }).data).join("");
  assert.match(text, /# Install uv: Downloads uv \d+\.\d+\.\d+ from github\.com\/astral-sh\/uv/);
  assert.match(text, /did not match its pinned checksum/);
  assert.ok(events.some((e) => e.type === "progress" && e.total === pin.size));
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "ctl-dl-ud", "setup", "downloads")), [], "the bad download is gone");
  assert.equal(fs.existsSync(path.join(home, ".local", "bin", "uv")), false);
  // Stopping a download ends it with a signal, not an error.
  events.length = 0;
  ctl.fix("uv", 80, 24);
  ctl.cancel();
  assert.equal((await exitEvent(events, "fix")).signal, "SIGTERM");
});

test("controller: --host none installs with no host and no Chief of Staff; the PATH line waits for the install and is written once", async () => {
  const userData = path.join(ROOT, "ctl-none-ud");
  const home = path.join(ROOT, "ctl-none-home");
  fs.mkdirSync(home, { recursive: true });
  const events: SetupEvent[] = [];
  const spawned: string[][] = [];
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const { claude: _c, codex: _x, ...rest } = ALL;
  const ctl = new SetupController({
    home, userData, env: {}, payload: { root: "/payload", cli: "/payload/cli/aos.js", version: "2.0.0", runtimeDeps: true },
    emit: (e) => events.push(e), pty: () => { throw new Error("no terminal"); },
    attached: () => null, attachInfo: () => null, readAgenticos: () => null, attach: () => true, refreshAttach: () => undefined,
    chooseFolder: async () => null, path: () => "/fake/bin", probe: machine(rest).run, isExec: machine(rest).isExec, exists: () => false,
    fetch: noNetwork, totalmem: 16 * GB,
    spawnImpl: ((file: string, args: string[]) => { spawned.push([file, ...args]); const c = fakeChild(); children.push(c); return c.child; }) as never,
  });
  assert.equal(ctl.pathLine().ok, false, "no vault yet");
  const pre = await ctl.preflight();
  assert.ok(pre.ok && pre.data.ready && !pre.data.hosts.claude && !pre.data.hosts.codex);
  const persona = { name: "Atlas", addressAs: "", voice: "", priorities: [], dutyModel: "", dutyCodexModel: "", dutyEffort: "medium" as const, schedule: true };
  assert.equal(ctl.install({ host: "claude", vault: "~/Vault", persona: null }).ok, false, "claude is not ready");
  assert.equal(ctl.install({ host: "none", vault: "~/Vault", persona }).ok, true);
  assert.deepEqual(spawned[0].slice(1), ["/payload/cli/aos.js", "init", "--yes", "--vault", path.join(home, "Vault"), "--host", "none"], "no --persona-json without a host");
  assert.equal(fs.existsSync(path.join(userData, "setup", "persona.json")), false);
  children[0].finish(0);
  await exitOf(events, "install");
  // A new install with no host is still the wizard's own: the Workbench it opens starts the welcome tour (tour C10).
  assert.equal(attachInfo(userData, path.join(home, "Vault"), null, null).installed, true);
  const pl = ctl.pathLine();
  assert.ok(pl.ok && pl.data.file === path.join(home, ".zprofile") && !pl.data.present && !pl.data.onPath);
  assert.equal(fs.existsSync(path.join(home, ".zprofile")), false);
  const added = ctl.addToPath();
  assert.ok(added.ok && added.data.present);
  ctl.addToPath();
  assert.equal(fs.readFileSync(path.join(home, ".zprofile"), "utf8"), `${PATH_LINE}\n`);
});

test("controller: checks first, then a fix, the install with the answers file, CLAUDE.md, and finish", async () => {
  const userData = path.join(ROOT, "ctl-ud");
  const vault = path.join(HOME, "Vault");
  const payload = { root: "/payload", cli: "/payload/cli/aos.js", version: "1.0.0", runtimeDeps: true };
  const events: SetupEvent[] = [];
  const spawned: Array<{ file: string; args: string[]; personaSeen: unknown }> = [];
  let cfg: AgenticosJson | null = null;
  let attachedVault: string | null = null;
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const pty = new FakePty();
  const ctl = new SetupController({
    home: HOME, userData, env: { CLAUDECODE: "1", PATH: "/usr/bin" }, payload,
    emit: (e) => events.push(e), pty: () => ({ spawn: () => pty }),
    attached: () => attachedVault, attachInfo: () => null,
    readAgenticos: () => cfg,
    attach: () => { attachedVault = vault; return true; },
    refreshAttach: () => { /* nothing */ },
    chooseFolder: async () => "/picked",
    path: () => "/fake/bin",
    probe: machine(ALL).run,
    isExec: machine(ALL).isExec,
    exists: () => false,
    fetch: noNetwork,
    totalmem: 16 * GB,
    spawnImpl: ((file: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
      const i = args.indexOf("--persona-json");
      spawned.push({ file, args, personaSeen: i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], "utf8")) : null });
      assert.equal(o.env.CLAUDECODE, undefined);
      assert.equal(o.env.PATH, "/fake/bin");
      const c = fakeChild(); children.push(c); return c.child;
    }) as never,
  });
  const persona = { name: "Atlas", addressAs: "", voice: "", priorities: [], dutyModel: "", dutyCodexModel: "", dutyEffort: "medium" as const, schedule: true };
  const req = { host: "claude" as const, vault: "~/Vault", persona };
  assert.equal(ctl.install(req).ok, false, "before the checks");
  assert.equal(ctl.fix("uv", 80, 24).ok, false, "before the checks");
  assert.equal(ctl.claudeMd().ok, false, "no vault yet");
  const pre = await ctl.preflight();
  assert.ok(pre.ok && pre.data.ready);

  assert.equal(ctl.install({ ...req, host: "both" }).ok, true, "both hosts ready in the fake machine");
  children[0].finish(1);
  await exitOf(events, "install");
  events.length = 0;
  assert.equal(ctl.finish().ok, true, "finish attaches whatever agenticos.json names");
  attachedVault = null;

  const rel = ctl.install({ ...req, vault: "relative" });
  assert.ok(!rel.ok && rel.code === "EINVAL");
  assert.equal(ctl.install(req).ok, true);
  assert.equal(spawned.at(-1)?.file, "/fake/bin/node");
  assert.deepEqual(spawned.at(-1)?.args.slice(0, 7), ["/payload/cli/aos.js", "init", "--yes", "--vault", vault, "--host", "claude"]);
  assert.deepEqual(spawned.at(-1)?.personaSeen, { name: "Atlas", addressAs: "", voice: "", priorities: [], dutyEffort: "medium", schedule: true });
  const busy = ctl.install(req);
  assert.ok(!busy.ok && busy.error === "another setup step is running", "one job at a time, refused by the policy first");
  children.at(-1)!.finish(0);
  await exitOf(events, "install");
  assert.equal(fs.existsSync(path.join(userData, "setup", "persona.json")), false, "the answers file goes when init ends");

  cfg = { hosts: { claude: { enabled: true, configDir: path.join(HOME, ".claude") } } };
  const md = ctl.claudeMd();
  assert.ok(md.ok && md.data.path === path.join(HOME, ".claude", "CLAUDE.md") && md.data.line === `@${vault}/AGENTICOS.md`);
  cfg = { hosts: { claude: { enabled: false } } };
  assert.equal(ctl.applyClaudeMd().ok, false, "not a Claude Code install");
  cfg = { hosts: { claude: { enabled: true, configDir: path.join(HOME, ".claude") } } };
  assert.equal(ctl.applyClaudeMd().ok, true);
  assert.equal(fs.readFileSync(path.join(HOME, ".claude", "CLAUDE.md"), "utf8"), `@${vault}/AGENTICOS.md\n`);

  assert.equal(ctl.upgrade().ok, false, "nothing attached");
  assert.equal(ctl.finish().ok, true);
  assert.equal(attachedVault, vault);
  assert.equal(ctl.finish().ok, false, "already attached");
  assert.equal((await ctl.chooseVault()).ok, false, "no folder picker once attached");
  assert.equal((await ctl.preflight()).ok, false, "no checks once attached");
  assert.equal(ctl.fix("uv", 80, 24).ok, false, "no fix-its once attached");
  assert.ok(events.some((e) => e.type === "exit" && e.job === "install" && e.code === 0));
});
