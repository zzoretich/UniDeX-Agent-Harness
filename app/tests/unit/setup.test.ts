// Phase 5's main-side setup: the login PATH, the payload, the preflight checks, the setup policy (fix-its, vault paths,
// persona answers, which step runs when), the CLAUDE.md diff, attach state, the job runner and the controller that ties
// them together. Probes, terminals and child processes are fakes; files go to a temp folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import type { SetupEvent } from "../../src/shared/ipc";
import { CHIEF_MODELS } from "../../src/shared/ipc";
import { chiefSummary } from "../../src/renderer/setup/chief";
import { PATH_MARKER, findOnPath, installDirs, loginPath, mergePath, parseLoginPath } from "../../src/main/setup/env";
import { cmpVersion, findPayload, readPayload } from "../../src/main/setup/payload";
import { parseTags, parseVersion, runPreflight, type PreflightDeps, type ProbeResult } from "../../src/main/setup/preflight";
import { FIXES, FIX_IDS, OLLAMA_MODELS, fixBlocked, fixCommandLine, installArgs, personaJson, resolveVaultPath, stepRefusal, type SetupState } from "../../src/main/policy/setup";
import { applyClaudeMd, claudeMdLine, claudeMdPath, previewClaudeMd } from "../../src/main/setup/claude-md";
import { attachInfo, hostsOf, markInstalled, markNoted } from "../../src/main/setup/attach";
import { JobRunner } from "../../src/main/setup/jobs";
import { SetupController, type AgenticosJson } from "../../src/main/setup/controller";
import type { PtyLib, PtyProcess } from "../../src/main/services/pty";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-setup-")));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, "home");
fs.mkdirSync(HOME, { recursive: true });

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
  // A shell that fails: main's own PATH, then the same folders.
  const fallback = loginPath({ shell: "/bin/zsh", home: HOME, env: { PATH: "/only" }, exec: () => { throw new Error("no shell"); } });
  assert.equal(fallback.split(":")[0], "/only");
  assert.ok(fallback.includes(path.join(HOME, ".local", "bin")));
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

/** A machine of fake programs: name → what `--version` (and the login probes) answer. */
function machine(tools: Record<string, Partial<Record<string, ProbeResult>>>, extra: Partial<PreflightDeps> = {}): PreflightDeps {
  const dir = "/fake/bin";
  return {
    PATH: dir, home: HOME,
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
  brew: {},
  node: { "--version": v("v22.12.0") },
  claude: { "--version": v("2.1.0 (Claude Code)"), "auth status --json": v('{"loggedIn":true}') },
  codex: { "--version": v("codex-cli 0.150.0"), "login status": v("Logged in using ChatGPT") },
  ollama: {},
  python3: { "--version": v("Python 3.12.1") },
  uv: {},
  curl: { [TAGS]: tags("llama3.2:latest", ...OLLAMA_MODELS) },
};

test("parseVersion reads the first x.y of a version line", () => {
  assert.deepEqual(parseVersion("v22.12.0"), [22, 12]);
  assert.deepEqual(parseVersion("Python 3.9.6"), [3, 9]);
  assert.equal(parseVersion("none"), null);
});

test("everything there: ready, both hosts, and main learns the node to run", async () => {
  const { report, node } = await runPreflight(machine(ALL));
  assert.equal(report.ready, true);
  assert.deepEqual(report.hosts, { claude: true, codex: true });
  assert.equal(node, "/fake/bin/node");
  assert.ok(report.checks.every((c) => c.state === "ok" && c.fix === null));
  assert.deepEqual(report.checks.map((c) => c.id), ["homebrew", "node", "claude", "claude-login", "codex", "codex-login", "ollama", "ollama-models", "python", "uv"]);
});

test("one host is enough; a missing login offers its fix; codex's 'Not logged in' does not count", async () => {
  const { report } = await runPreflight(machine({ ...ALL, codex: { "--version": v("codex-cli 0.150.0"), "login status": v("Not logged in", 1) } }));
  assert.equal(report.ready, true);
  assert.deepEqual(report.hosts, { claude: true, codex: false });
  const login = report.checks.find((c) => c.id === "codex-login");
  assert.equal(login?.state, "missing");
  assert.equal(login?.fix, "codex-login");
  assert.equal(login?.fixCommand, "codex login");
  assert.equal(login?.fixBlocked, null);
});

test("no host at all, an old node, no uv: not ready, each with its fix", async () => {
  const { claude: _c, codex: _x, uv: _u, ...rest } = ALL;
  const { report, node } = await runPreflight(machine({ ...rest, node: { "--version": v("v18.19.0") } }));
  assert.equal(report.ready, false);
  assert.equal(node, null);
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.match(by.node.detail, /needs 20 or newer/);
  assert.equal(by.node.fix, "node");
  assert.equal(by.claude.fix, "claude");
  // Installing a CLI needs npm, which needs a node that runs: the fix waits for Node.
  assert.equal(by.claude.fixBlocked, "needs Node.js first");
  assert.equal(by["claude-login"].fixBlocked, "needs Claude Code first");
  assert.equal(by.uv.fix, "uv");
  assert.equal(by.uv.fixBlocked, null);
});

test("without Homebrew its fixes wait for it, and Homebrew's own installer is offered", async () => {
  const { brew: _b, uv: _u, ...rest } = ALL;
  const { report } = await runPreflight(machine(rest));
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(by.homebrew.state, "missing");
  assert.equal(by.homebrew.required, false);
  assert.equal(by.homebrew.fix, "homebrew");
  assert.equal(by.uv.fixBlocked, "needs Homebrew first");
});

test("macOS's python3 stub is not run when the Command Line Tools are missing (it would open their installer)", async () => {
  const ran: string[] = [];
  const deps = machine({ ...ALL, python3: {} }, {
    isExec: (p) => p === "/usr/bin/python3" || (path.dirname(p) === "/fake/bin" && path.basename(p) in ALL && path.basename(p) !== "python3"),
  });
  const run = deps.run;
  deps.PATH = "/fake/bin:/usr/bin";
  deps.run = async (file, args, t) => { ran.push(file); return file === "/usr/bin/xcode-select" ? v("", 2) : run(file, args, t); };
  const { report } = await runPreflight(deps);
  assert.equal(report.checks.find((c) => c.id === "python")?.state, "missing");
  assert.ok(!ran.includes("/usr/bin/python3"));
});

test("Ollama.app counts as Ollama, and uv in ~/.local/bin counts as uv", async () => {
  const { ollama: _o, uv: _u, ...rest } = ALL;
  const uv = path.join(HOME, ".local", "bin", "uv");
  const deps = machine(rest, { exists: (p) => p === "/Applications/Ollama.app" });
  const isExec = deps.isExec!;
  deps.isExec = (p) => p === uv || isExec(p);
  const { report } = await runPreflight(deps);
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(by.ollama.detail, "/Applications/Ollama.app");
  assert.equal(by.uv.detail, uv);
  assert.equal(report.ready, true);
});

test("Ollama's models: asked over HTTP; one missing is a warning with its fix, and Continue does not wait for it", async () => {
  const { report } = await runPreflight(machine({ ...ALL, curl: { [TAGS]: tags("qwen3-embedding:0.6b") } }));
  const models = report.checks.find((c) => c.id === "ollama-models");
  assert.equal(models?.state, "warn");
  assert.equal(models?.required, false);
  assert.equal(models?.detail, "not downloaded: qwen3.5:9b");
  assert.equal(models?.fix, "ollama-models");
  assert.equal(models?.fixBlocked, null);
  assert.equal(report.ready, true);
});

test("Ollama's models: not answering, they cannot be checked; no Ollama, its own fix downloads them", async () => {
  const down = (await runPreflight(machine({ ...ALL, curl: { [TAGS]: v("", 7) } }))).report.checks.find((c) => c.id === "ollama-models");
  assert.equal(down?.state, "warn");
  assert.match(down?.detail ?? "", /not running/);
  assert.equal(down?.fix, "ollama-models");
  const { ollama: _o, ...rest } = ALL;
  const ran: string[] = [];
  const deps = machine(rest);
  const run = deps.run;
  deps.run = async (file, args, t) => { ran.push(path.basename(file)); return run(file, args, t); };
  const { report } = await runPreflight(deps);
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.ok(!ran.includes("curl"), "nothing to ask without Ollama");
  assert.equal(by.ollama.state, "missing");
  assert.equal(by["ollama-models"].state, "warn");
  assert.equal(by["ollama-models"].fixBlocked, "needs Ollama first");
  assert.match(by.ollama.fixCommand ?? "", /"\$O" pull qwen3\.5:9b.*"\$O" pull qwen3-embedding:0\.6b/);
});

test("parseTags reads the names in Ollama's answer, and nothing from a failed or garbled one", () => {
  assert.deepEqual(parseTags(tags("qwen3.5:9b")), ["qwen3.5:9b", "qwen3.5:9b"]);
  assert.equal(parseTags(v("", 7)), null);
  assert.equal(parseTags(v("<html>")), null);
  assert.equal(parseTags(null), null);
});

test("the app's Ollama models are models.js's workhorse and embedder", () => {
  // The runtime's roles, loaded at run time from the repo (the tests run bundled from app/out-test/), without the env
  // overrides a developer's shell may set.
  const models = createRequire(__filename)(path.resolve(__dirname, "../../brain/scripts/sdk/lib/models.js")) as { role(name: string, cfg: object): { tag: string; provider: string } };
  const saved = { BRAIN_MODEL: process.env.BRAIN_MODEL, BRAIN_EMBEDDER: process.env.BRAIN_EMBEDDER };
  delete process.env.BRAIN_MODEL;
  delete process.env.BRAIN_EMBEDDER;
  try {
    const roles = [models.role("workhorse", {}), models.role("embedder", {})];
    assert.deepEqual([...OLLAMA_MODELS], roles.map((r) => r.tag));
    assert.ok(roles.every((r) => r.provider === "ollama"));
  } finally {
    for (const [k, val] of Object.entries(saved)) if (val !== undefined) process.env[k] = val;
  }
});

// ── policy ───────────────────────────────────────────────────────────

test("every fix is a fixed command run by /bin/sh -c; the page cannot add one", () => {
  assert.deepEqual(FIX_IDS.sort(), ["claude", "claude-login", "codex", "codex-login", "homebrew", "node", "ollama", "ollama-models", "python", "uv"]);
  assert.deepEqual(fixCommandLine("uv"), { file: "/bin/sh", args: ["-c", "brew install uv"] });
  assert.equal(FIXES["claude-login"].command, "claude auth login");
  assert.equal(fixBlocked("uv", new Set(["homebrew"])), null);
  assert.equal(fixBlocked("codex-login", new Set()), "needs the Codex CLI first");
});

/**
 * Runs a fix-it's command with /bin/sh on stand-ins: curl answers once `up` exists, brew's service start creates it
 * (unless `startFails`), brew lists the formula once `formula` exists, ollama knows what it pulled. With `appCli`,
 * ollama is not on the PATH but inside ~/Applications/Ollama.app, as before Ollama.app first links it. Every call is
 * logged.
 */
function runFix(id: "ollama" | "ollama-models", state: { up?: boolean; formula?: boolean; startFails?: boolean; appCli?: boolean; pulled?: string[] }): { code: number | null; out: string; calls: string[] } {
  const dir = fs.mkdtempSync(path.join(ROOT, "fix-"));
  const bin = path.join(dir, "bin");
  const appBin = path.join(dir, "Applications", "Ollama.app", "Contents", "Resources");
  fs.mkdirSync(bin);
  fs.mkdirSync(appBin, { recursive: true });
  const at = (f: string) => JSON.stringify(path.join(dir, f));
  if (state.up) fs.writeFileSync(path.join(dir, "up"), "");
  if (state.formula) fs.writeFileSync(path.join(dir, "formula"), "");
  fs.writeFileSync(path.join(dir, "pulled"), (state.pulled ?? []).map((m) => `${m}\n`).join(""));
  const sh = (name: string, body: string, where = bin) => fs.writeFileSync(path.join(where, name), `#!/bin/sh\necho "${name} $*" >> ${at("calls")}\n${body}\n`, { mode: 0o755 });
  sh("curl", `[ -f ${at("up")} ]`);
  sh("brew", `case "$1 $2" in
  "install ollama") : > ${at("formula")};;
  "services start") ${state.startFails ? ":" : `: > ${at("up")}`};;
  "list --formula") [ -f ${at("formula")} ];;
  *) exit 1;;
esac`);
  sh("ollama", `case "$1" in
  show) grep -qx "$2" ${at("pulled")};;
  pull) echo "pulling $2"; echo "$2" >> ${at("pulled")};;
  *) exit 1;;
esac`, state.appCli ? appBin : bin);
  const r = spawnSync(fixCommandLine(id).file, fixCommandLine(id).args, { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir } });
  const calls = fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n") : [];
  return { code: r.status, out: r.stdout + r.stderr, calls };
}

test("Install Ollama and its models starts its service, waits until it answers, then pulls both models", () => {
  const r = runFix("ollama", {});
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls.filter((c) => !c.startsWith("ollama show")), [
    "brew install ollama", "brew services start ollama",
    "curl -q --noproxy 127.0.0.1 -fs --retry 30 --retry-delay 1 --retry-connrefused --retry-max-time 30 -m 2 -o /dev/null http://127.0.0.1:11434/api/tags",
    "ollama pull qwen3.5:9b", "ollama pull qwen3-embedding:0.6b",
  ]);
  assert.match(r.out, /Waiting for Ollama to answer \(up to 30 s\)[\s\S]*Downloading qwen3\.5:9b[\s\S]*Downloading qwen3-embedding:0\.6b/);
});

test("Download the models pulls only the missing ones, starting brew's service only when Ollama is not answering", () => {
  const answering = runFix("ollama-models", { up: true, pulled: ["qwen3.5:9b"] });
  assert.equal(answering.code, 0, answering.out);
  assert.ok(!answering.calls.some((c) => c.startsWith("brew")), "nothing to start");
  assert.deepEqual(answering.calls.filter((c) => c.startsWith("ollama pull")), ["ollama pull qwen3-embedding:0.6b"]);
  assert.match(answering.out, /qwen3\.5:9b is already downloaded/);

  const brewed = runFix("ollama-models", { formula: true });
  assert.equal(brewed.code, 0, brewed.out);
  assert.ok(brewed.calls.includes("brew services start ollama"));
  assert.deepEqual(brewed.calls.filter((c) => c.startsWith("ollama pull")), ["ollama pull qwen3.5:9b", "ollama pull qwen3-embedding:0.6b"]);

  // Ollama.app, closed: it starts its own server once opened, so the fix says so and pulls nothing.
  const app = runFix("ollama-models", {});
  assert.equal(app.code, 1);
  assert.match(app.out, /Ollama is not running: open Ollama/);
  assert.ok(!app.calls.some((c) => c.startsWith("ollama")));

  // Ollama.app, open, before it links its CLI onto the PATH: the app's own copy pulls.
  const unlinked = runFix("ollama-models", { up: true, appCli: true });
  assert.equal(unlinked.code, 0, unlinked.out);
  assert.deepEqual(unlinked.calls.filter((c) => c.startsWith("ollama pull")), ["ollama pull qwen3.5:9b", "ollama pull qwen3-embedding:0.6b"]);
});

test("a service that never answers stops the fix with Homebrew's advice, before any pull", () => {
  const r = runFix("ollama-models", { formula: true, startFails: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /did not answer at http:\/\/127\.0\.0\.1:11434 within 30 s: run brew services restart ollama/);
  assert.ok(r.calls.includes("brew services start ollama"));
  assert.ok(!r.calls.some((c) => c.startsWith("ollama pull")));
});

test("a vault folder is absolute or ~/…, never home itself or a root", () => {
  assert.equal(resolveVaultPath("~/AgenticOS", HOME), path.join(HOME, "AgenticOS"));
  assert.equal(resolveVaultPath(" /Volumes/Data/Vault/ ", HOME), "/Volumes/Data/Vault");
  assert.equal(resolveVaultPath("~", HOME), null);
  assert.equal(resolveVaultPath(HOME, HOME), null);
  assert.equal(resolveVaultPath("/", HOME), null);
  assert.equal(resolveVaultPath("AgenticOS", HOME), null);
});

test("the Chief of Staff's models the wizard preselects are models.js's chief role (local-first A4)", () => {
  const models = createRequire(__filename)(path.resolve(__dirname, "../../brain/scripts/sdk/lib/models.js")) as { CHIEF: { claude: string; codex: string } };
  assert.deepEqual({ ...CHIEF_MODELS }, { ...models.CHIEF });
  const defaults = createRequire(__filename)(path.resolve(__dirname, "../../brain/scripts/config.default.json")) as { persona: { model: string; codexModel: string } };
  assert.deepEqual([defaults.persona.model, defaults.persona.codexModel], [CHIEF_MODELS.claude, CHIEF_MODELS.codex]);
});

test("the persona step says where duties run: the hosted model, the failover with both hosts, the hourly check on the local model", () => {
  const p = { dutyModel: CHIEF_MODELS.claude, dutyCodexModel: CHIEF_MODELS.codex };
  const local = "a hosted model. The hourly check runs on this Mac's local model and wakes it only when something changed.";
  assert.equal(chiefSummary("claude", p), `Duties run on Claude Code · claude-opus-5-5, ${local}`);
  assert.equal(chiefSummary("codex", p), `Duties run on Codex · gpt-6-sol, ${local}`);
  assert.equal(chiefSummary("both", p), `Duties run on Claude Code · claude-opus-5-5, and on Codex · gpt-6-sol when Claude Code can't start one, ${local}`);
  assert.equal(chiefSummary("both", { dutyModel: " sonnet ", dutyCodexModel: "" }), `Duties run on Claude Code · sonnet, and on Codex · your Codex default when Claude Code can't start one, ${local}`);
});

test("persona answers: trimmed, and each host's model only where that host is on", () => {
  const a = { name: " Atlas ", addressAs: "Sam ", voice: "", priorities: [" ship ", ""], dutyModel: "sonnet", dutyCodexModel: "gpt-5.1", dutyEffort: "high" as const, schedule: false };
  assert.deepEqual(personaJson(a, { claude: true, codex: false }), { name: "Atlas", addressAs: "Sam", voice: "", priorities: ["ship"], dutyModel: "sonnet", dutyEffort: "high", schedule: false });
  assert.deepEqual(Object.keys(personaJson(a, { claude: false, codex: true })), ["name", "addressAs", "voice", "priorities", "dutyCodexModel", "dutyEffort", "schedule"]);
  assert.deepEqual(installArgs("/p/cli/aos.js", { host: "both", vault: "x", persona: null }, "/v", null), ["/p/cli/aos.js", "init", "--yes", "--vault", "/v", "--host", "both"]);
  assert.deepEqual(installArgs("/p/cli/aos.js", { host: "codex", vault: "x", persona: null }, "/v", "/a.json").slice(-2), ["--persona-json", "/a.json"]);
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
  assert.deepEqual(jobs.startPty("fix", "/bin/sh", ["-c", "brew install uv"], { cwd: HOME, env: {}, cols: 80, rows: 24, echo: "brew install uv" }), { ok: true, data: null });
  assert.equal(jobs.running, "fix");
  assert.equal(jobs.startProc("install", "/x", [], { cwd: HOME, env: {}, echo: "x" }).ok, false);
  jobs.input("secret\r");
  assert.deepEqual(pty.written, ["secret\r"]);
  pty.emit("data", "==> done");
  pty.emit("exit", { exitCode: 0 });
  assert.equal(jobs.running, null);
  assert.match((events[0] as { data: string }).data, /\$ brew install uv/);
  assert.deepEqual(events.slice(1), [{ job: "fix", type: "data", data: "==> done" }, { job: "fix", type: "exit", code: 0, signal: null }]);
  assert.deepEqual(exits, [["fix", 0]]);
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
