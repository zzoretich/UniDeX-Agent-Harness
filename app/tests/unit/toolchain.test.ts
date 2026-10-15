// install-import B1: the toolchain the wizard installs. The manifest's shape and the shipped pins; Ollama's models by the
// Mac's memory (local-first A12); a download kept only when its size and SHA-256 are the pinned ones; and each tool's
// install on stand-in archives built here, unpacked by the real tar and ditto into a temp home. The network, codesign,
// spctl, open and curl are fakes: nothing leaves the machine and nothing is installed outside the temp folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  EMBEDDER, MANIFEST, RAM_TIERS, TOOL_IDS, describeJob, fetchVerified, loadManifest, macOSAtLeast, meetsFloor, ollamaModels, parseManifest,
  runToolchainJob, toolchainPaths, totalMemBytes, versionIn, type Asset, type Fetch, type Manifest, type Run, type TaskContext, type ToolchainDeps,
} from "../../src/main/setup/toolchain";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-toolchain-")));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
const GB = 1024 ** 3;

// ── the manifest ─────────────────────────────────────────────────────

test("the shipped manifest pins every tool for both Mac arches: https, a SHA-256, a size, a signing team and where it came from", () => {
  assert.deepEqual(Object.keys(MANIFEST.tools).sort(), [...TOOL_IDS].sort());
  for (const id of TOOL_IDS) {
    const t = MANIFEST.tools[id];
    assert.match(t.version, /^\d+\.\d+\.\d+$/, id);
    assert.match(t.teamId ?? "", /^[A-Z0-9]{10}$/, `${id} has a Developer ID team`);
    assert.ok(t.from.length > 20, `${id} says where its pin came from`);
    for (const arch of ["arm64", "x64"] as const) {
      const a = t.assets[arch];
      assert.equal(new URL(a.url).protocol, "https:", `${id}.${arch}`);
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
      assert.ok(a.size > 1e6, `${id}.${arch} size`);
    }
  }
  assert.equal(MANIFEST.tools.node.floor, "20.0.0", "the runtime's own floor");
  assert.equal(MANIFEST.tools.ollama.minMacOS, "14.0");
  // Each URL names the version it pins (a pin bumped in one place only fails here).
  for (const id of TOOL_IDS) for (const arch of ["arm64", "x64"] as const) assert.ok(MANIFEST.tools[id].assets[arch].url.includes(MANIFEST.tools[id].version), `${id}.${arch}`);
});

function devManifest(over: Partial<Record<string, Partial<{ url: string; sha256: string; size: number; teamId: string | null; version: string; floor: string | null }>>> = {}): Manifest {
  const raw = JSON.parse(JSON.stringify(MANIFEST)) as { tools: Record<string, { teamId: string | null; version: string; floor: string | null; assets: Record<string, Asset> }> };
  for (const [id, o] of Object.entries(over)) {
    const t = raw.tools[id];
    if (o?.teamId !== undefined) t.teamId = o.teamId;
    if (o?.version) t.version = o.version;
    if (o?.floor !== undefined) t.floor = o.floor;
    for (const arch of ["arm64", "x64"]) t.assets[arch] = { url: o?.url ?? t.assets[arch].url, sha256: o?.sha256 ?? t.assets[arch].sha256, size: o?.size ?? t.assets[arch].size };
  }
  return parseManifest(raw, { dev: true });
}

test("a manifest is refused with the field that is wrong; a development one may use 127.0.0.1 and no team", () => {
  const raw = () => JSON.parse(JSON.stringify(MANIFEST)) as { schema: number; tools: Record<string, Record<string, unknown> & { assets: Record<string, Record<string, unknown>> }> };
  const bad = (edit: (m: ReturnType<typeof raw>) => void, re: RegExp, dev = false) => { const m = raw(); edit(m); assert.throws(() => parseManifest(m, { dev }), re); };
  bad((m) => { m.schema = 2; }, /schema/);
  bad((m) => { delete m.tools.codex; }, /exactly/);
  bad((m) => { m.tools.uv.assets.arm64.url = "http://example.com/uv.tar.gz"; }, /uv\.arm64: url/);
  bad((m) => { m.tools.uv.assets.arm64.url = "http://example.com/uv.tar.gz"; }, /uv\.arm64: url/, true);
  bad((m) => { m.tools.node.assets.x64.sha256 = "abc"; }, /node\.x64: sha256/);
  bad((m) => { m.tools.node.teamId = null; }, /node: teamId/);
  bad((m) => { m.tools.ollama.floor = "latest"; }, /ollama: floor/);
  const dev = raw();
  dev.tools.uv.assets.arm64.url = "http://127.0.0.1:4321/uv.tar.gz";
  dev.tools.uv.teamId = null;
  assert.equal(parseManifest(dev, { dev: true }).tools.uv.teamId, null);
});

test("only a development run reads $AOS_TOOLCHAIN_MANIFEST", () => {
  const file = path.join(ROOT, "dev-manifest.json");
  const m = JSON.parse(JSON.stringify(MANIFEST)) as Manifest;
  m.tools.uv.version = "9.9.9";
  fs.writeFileSync(file, JSON.stringify(m));
  assert.equal(loadManifest({ AOS_TOOLCHAIN_MANIFEST: file }, false).tools.uv.version, MANIFEST.tools.uv.version, "a packaged app keeps its pins");
  assert.equal(loadManifest({ AOS_TOOLCHAIN_MANIFEST: file }, true).tools.uv.version, "9.9.9");
  assert.equal(loadManifest({ AOS_TOOLCHAIN_MANIFEST: "relative.json" }, true), MANIFEST);
});

// ── models, versions ─────────────────────────────────────────────────

test("local-first A12: under 12 GB of memory the 4b workhorse, else the 9b, and the embedder on every tier", () => {
  assert.deepEqual(RAM_TIERS.map((t) => t.tag), ["qwen3.5:4b", "qwen3.5:9b"]);
  assert.deepEqual(ollamaModels(8 * GB), ["qwen3.5:4b", EMBEDDER]);
  assert.deepEqual(ollamaModels(12 * GB - 1), ["qwen3.5:4b", EMBEDDER]);
  assert.deepEqual(ollamaModels(12 * GB), ["qwen3.5:9b", EMBEDDER]);
  assert.deepEqual(ollamaModels(64 * GB), ["qwen3.5:9b", "qwen3-embedding:0.6b"]);
  assert.equal(totalMemBytes({ AOS_TOTALMEM: String(8 * GB) }, 64 * GB), 8 * GB, "a test pins the memory as models.js lets it");
  assert.equal(totalMemBytes({ AOS_TOTALMEM: "lots" }, 64 * GB), 64 * GB);
});

test("versions: the first x.y.z of a program's answer, floors, and macOS", () => {
  assert.equal(versionIn("v24.22.0"), "24.22.0");
  assert.equal(versionIn("uv 0.13.1 (4b1c 2026-10-13 aarch64-apple-darwin)"), "0.13.1");
  assert.equal(versionIn("Warning: could not connect to a running Ollama instance\nWarning: client version is 0.40.4"), "0.40.4");
  assert.equal(versionIn("none"), null);
  assert.equal(meetsFloor("18.19.0", "20.0.0"), false);
  assert.equal(meetsFloor("20.0.0", "20.0.0"), true);
  assert.equal(meetsFloor("0.12.10", "0.17.3"), false);
  assert.equal(meetsFloor(null, "1.0.0"), false, "inspection F5: with a floor, a version that could not be read is not trusted");
  assert.equal(meetsFloor(null, null), true, "no floor, no version needed");
  assert.equal(meetsFloor("0.1.0", null), true);
  assert.equal(macOSAtLeast("13.6.1", "14.0"), false);
  assert.equal(macOSAtLeast("14", "14.0"), true);
  assert.equal(macOSAtLeast("26.0.1", "14.0"), true);
  assert.equal(macOSAtLeast("", "14.0"), true);
});

// ── downloads ────────────────────────────────────────────────────────

const sha = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

/** A fetch serving `files` (url → bytes) in small chunks; anything else is a 404. Records each URL. */
function serve(files: Record<string, Buffer>, seen: string[] = []): Fetch {
  return async (url, init) => {
    seen.push(url);
    const bytes = files[url];
    if (!bytes) return { ok: false, status: 404, body: null };
    async function* body(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < bytes.length; i += 4096) {
        if (init.signal.aborted) throw new Error("aborted");
        yield bytes.subarray(i, i + 4096);
      }
    }
    return { ok: true, status: 200, body: body() };
  };
}

interface Seen { lines: string[]; raw: string[]; progress: Array<{ label: string; received: number; total: number | null }> }
function context(signal = new AbortController().signal): TaskContext & { seen: Seen } {
  const seen: Seen = { lines: [], raw: [], progress: [] };
  return { signal, seen, log: (l) => seen.lines.push(l), write: (t) => seen.raw.push(t), progress: (p) => seen.progress.push(p) };
}

test("a download is kept only with the pinned size and SHA-256, and reports its progress", async () => {
  const bytes = crypto.randomBytes(20_000);
  const url = "https://example.test/tool.tar.gz";
  const dest = path.join(ROOT, "dl", "tool.tar.gz");
  const ctx = context();
  await fetchVerified({ url, sha256: sha(bytes), size: bytes.length }, dest, "Tool 1.0.0", { fetch: serve({ [url]: bytes }) }, ctx);
  assert.deepEqual(fs.readFileSync(dest), bytes);
  assert.equal(fs.existsSync(`${dest}.part`), false);
  assert.deepEqual(ctx.seen.progress.at(-1), { label: "Downloading Tool 1.0.0", received: bytes.length, total: bytes.length });
  assert.ok(ctx.seen.lines.some((l) => l.includes(sha(bytes))));
});

test("a download that does not match is deleted, and the error says Retry fetches it again", async () => {
  const bytes = crypto.randomBytes(9000);
  const url = "https://example.test/x";
  const dest = path.join(ROOT, "dl2", "x");
  const wrong = { url, sha256: "0".repeat(64), size: bytes.length };
  await assert.rejects(fetchVerified(wrong, dest, "X", { fetch: serve({ [url]: bytes }) }, context()), /did not match its pinned checksum.*The download was deleted: Retry fetches it again/);
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), [], "nothing is left behind");
  // More bytes than pinned stop the download at once.
  await assert.rejects(fetchVerified({ url, sha256: sha(bytes), size: 100 }, dest, "X", { fetch: serve({ [url]: bytes }) }, context()), /more than the 100 bytes pinned/);
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), []);
  await assert.rejects(fetchVerified({ url: "https://example.test/gone", sha256: sha(bytes), size: 1 }, dest, "X", { fetch: serve({}) }, context()), /answered 404/);
  // Stopped: the part file goes too.
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(fetchVerified({ url, sha256: sha(bytes), size: bytes.length }, dest, "X", { fetch: serve({ [url]: bytes }) }, context(ac.signal)));
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), []);
});

// ── installs on stand-ins ────────────────────────────────────────────

const sh = (file: string, body: string): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };

/** A .tar.gz of `dir`'s contents, built by the real tar. */
function tarOf(dir: string): Buffer {
  const out = `${dir}.tar.gz`;
  const r = spawnSync("/usr/bin/tar", ["-czf", out, "-C", dir, "."], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out);
}

interface Machine {
  home: string;
  deps: ToolchainDeps;
  calls: string[][];
  urls: string[];
  state: { team: string; signed: boolean; gatekeeper: boolean; tags: string[] | null; opened: string[]; pulls: string[]; pullError: string | null };
}

/**
 * A temp home with a toolchain whose network serves `files`, whose codesign answers with `state.team`, and whose curl is
 * Ollama answering with `state.tags` (null: not running until something is opened). Every other program really runs.
 */
function machine(files: Record<string, Buffer>, manifest: Manifest, o: Partial<ToolchainDeps> = {}): Machine {
  const home = fs.mkdtempSync(path.join(ROOT, "home-"));
  const calls: string[][] = [];
  const urls: string[] = [];
  const state: Machine["state"] = { team: "", signed: true, gatekeeper: true, tags: null, opened: [], pulls: [], pullError: null };
  const CURL = "/fake/curl";
  const run: Run = async (file, args, ro) => {
    calls.push([file, ...args]);
    if (file === "/usr/bin/codesign") {
      if (args[0] === "-dv") return { code: 0, out: `Executable=${args.at(-1)}\nIdentifier=stand-in\nTeamIdentifier=${state.team}\n` };
      return state.signed ? { code: 0, out: "" } : { code: 1, out: `${args.at(-1)}: invalid signature (code or signature have been modified)` };
    }
    if (file === "/usr/sbin/spctl") return state.gatekeeper ? { code: 0, out: "accepted\nsource=Notarized Developer ID" } : { code: 3, out: "rejected" };
    if (file === "/usr/bin/open") { state.opened.push(args.at(-1) as string); if (!state.tags) state.tags = []; return { code: 0, out: "" }; }
    if (file === CURL) {
      const url = args.at(-1) as string;
      if (url.endsWith("/api/tags")) {
        if (!state.tags) return { code: 7, out: "" };
        return args.includes("-o") ? { code: 0, out: "" } : { code: 0, out: JSON.stringify({ models: state.tags.map((name) => ({ name, model: name })) }) };
      }
      if (url.endsWith("/api/pull")) {
        const model = (JSON.parse(args[args.indexOf("--data-binary") + 1]) as { model: string }).model;
        state.pulls.push(model);
        const lines = state.pullError ? [{ error: state.pullError }]
          : [{ status: "pulling manifest" }, { status: `pulling ${"ab".repeat(32)}`, digest: "sha256:x", total: 1000, completed: 400 },
            { status: `pulling ${"ab".repeat(32)}`, digest: "sha256:x", total: 1000, completed: 1000 }, { status: "verifying sha256 digest" }, { status: "success" }];
        // Streamed in pieces that split a line, as a pipe may.
        const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
        ro?.onData?.(text.slice(0, 30));
        ro?.onData?.(text.slice(30));
        if (!state.pullError) state.tags?.push(model);
        return { code: 0, out: text };
      }
    }
    const r = spawnSync(file, args, { encoding: "utf8", env: ro?.env ?? { PATH: "/usr/bin:/bin", HOME: home } });
    if (r.stdout) ro?.onData?.(r.stdout);
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const paths = toolchainPaths(home, {}, path.join(home, "Library", "UniDeX"));
  paths.applications = [path.join(home, "SystemApplications"), path.join(home, "Applications")];
  const deps: ToolchainDeps = {
    manifest, arch: "arm64", home, paths, fetch: serve(files, urls), run,
    env: { PATH: "/usr/bin:/bin", HOME: home }, curl: CURL, macOS: "15.3", totalmem: 16 * GB,
    canWrite: (dir) => !dir.endsWith("SystemApplications"), ollamaApp: () => null, ollamaWaitSec: 1, ...o,
  };
  return { home, deps, calls, urls, state };
}

/** A manifest serving each stand-in archive at 127.0.0.1, its hash and size the archive's own. */
function pinned(archives: Partial<Record<"node" | "uv" | "ollama" | "claude" | "codex", Buffer>>, version: Partial<Record<string, string>> = {}): { files: Record<string, Buffer>; manifest: Manifest } {
  const files: Record<string, Buffer> = {};
  const over: Record<string, { url: string; sha256: string; size: number; version?: string }> = {};
  for (const [id, bytes] of Object.entries(archives) as Array<[string, Buffer]>) {
    const url = `http://127.0.0.1:9/${id}`;
    files[url] = bytes;
    over[id] = { url, sha256: sha(bytes), size: bytes.length, ...(version[id] ? { version: version[id] } : {}) };
  }
  return { files, manifest: devManifest(over) };
}

test("Node: checked, unpacked into ~/.local/share/unidex/node/v<version>, and `current` pointed at it", async () => {
  const v = MANIFEST.tools.node.version;
  const src = path.join(ROOT, "src-node");
  sh(path.join(src, `node-v${v}-darwin-arm64`, "bin", "node"), `echo v${v}`);
  const { files, manifest } = pinned({ node: tarOf(src) });
  const m = machine(files, manifest);
  m.state.team = MANIFEST.tools.node.teamId as string;
  const ctx = context();
  await runToolchainJob("node", m.deps, ctx);
  const root = path.join(m.home, ".local", "share", "unidex", "node");
  assert.equal(fs.readlinkSync(path.join(root, "current")), `v${v}`);
  assert.ok(fs.statSync(path.join(root, `v${v}`, "bin", "node")).isFile());
  assert.equal(m.deps.paths.node, path.join(root, "current", "bin", "node"));
  assert.deepEqual(fs.readdirSync(root).sort(), ["current", `v${v}`], "no staging folder is left");
  assert.deepEqual(fs.readdirSync(m.deps.paths.downloads), [], "the download is gone once installed");
  // The signature was checked on the unpacked node, before it was moved into place.
  const verify = m.calls.find((c) => c[0] === "/usr/bin/codesign" && c[1] === "--verify");
  assert.ok(verify && verify.at(-1)?.includes(".staging-"), JSON.stringify(verify));
  assert.ok(ctx.seen.lines.some((l) => l.includes(`node is signed by Developer ID team ${MANIFEST.tools.node.teamId}`)));
  // Run again: already there, nothing downloaded.
  const before = m.urls.length;
  await runToolchainJob("node", m.deps, context());
  assert.equal(m.urls.length, before);
});

test("a signature from another team, or none, stops the install before anything is moved, and deletes the download", async () => {
  const v = MANIFEST.tools.node.version;
  const src = path.join(ROOT, "src-node-bad");
  sh(path.join(src, `node-v${v}-darwin-arm64`, "bin", "node"), `echo v${v}`);
  const { files, manifest } = pinned({ node: tarOf(src) });
  const m = machine(files, manifest);
  m.state.team = "ZZZZZZZZZZ";
  await assert.rejects(runToolchainJob("node", m.deps, context()), new RegExp(`node is signed by team ZZZZZZZZZZ, not ${MANIFEST.tools.node.teamId}`));
  const root = path.join(m.home, ".local", "share", "unidex", "node");
  assert.deepEqual(fs.readdirSync(root), [], "no version folder, no current link, no staging");
  assert.deepEqual(fs.readdirSync(m.deps.paths.downloads), []);
  m.state.team = MANIFEST.tools.node.teamId as string;
  m.state.signed = false;
  await assert.rejects(runToolchainJob("node", m.deps, context()), /node is not validly signed: .*invalid signature/);
});

test("uv: uv and uvx land in ~/.local/bin", async () => {
  const v = MANIFEST.tools.uv.version;
  const src = path.join(ROOT, "src-uv");
  sh(path.join(src, "uv-aarch64-apple-darwin", "uv"), `echo "uv ${v} (stand-in)"`);
  sh(path.join(src, "uv-aarch64-apple-darwin", "uvx"), "echo uvx");
  const { files, manifest } = pinned({ uv: tarOf(src) });
  const m = machine(files, manifest);
  m.state.team = MANIFEST.tools.uv.teamId as string;
  await runToolchainJob("uv", m.deps, context());
  const bin = path.join(m.home, ".local", "bin");
  assert.deepEqual(fs.readdirSync(bin).sort(), ["uv", "uvx"]);
  assert.equal(spawnSync(path.join(bin, "uv"), [], { encoding: "utf8" }).stdout.trim(), `uv ${v} (stand-in)`);
});

test("Codex: laid out as its own installer lays it out, and linked from ~/.local/bin", async () => {
  const v = MANIFEST.tools.codex.version;
  const src = path.join(ROOT, "src-codex");
  sh(path.join(src, "bin", "codex"), `echo "codex-cli ${v}"`);
  sh(path.join(src, "bin", "codex-code-mode-host"), "exit 0");
  sh(path.join(src, "codex-path", "rg"), "exit 0");
  fs.writeFileSync(path.join(src, "codex-package.json"), JSON.stringify({ layoutVersion: 1, version: v }));
  const { files, manifest } = pinned({ codex: tarOf(src) });
  const m = machine(files, manifest);
  m.state.team = MANIFEST.tools.codex.teamId as string;
  await runToolchainJob("codex", m.deps, context());
  const root = path.join(m.home, ".codex", "packages", "standalone");
  const release = `${v}-aarch64-apple-darwin`;
  assert.equal(fs.readlinkSync(path.join(root, "current")), path.join(root, "releases", release));
  assert.equal(fs.readlinkSync(path.join(root, "releases", release, "codex")), "bin/codex");
  assert.equal(fs.readFileSync(path.join(root, "auto-update-version"), "utf8"), release);
  assert.equal(fs.readlinkSync(path.join(m.home, ".local", "bin", "codex")), path.join(root, "current", "bin", "codex"));
  assert.equal(fs.readlinkSync(path.join(m.home, ".local", "bin", "codex-code-mode-host")), path.join(root, "current", "bin", "codex-code-mode-host"));
  assert.deepEqual(fs.readdirSync(path.join(root, "releases")), [release], "no staging folder is left");
  // $CODEX_HOME moves it, as Codex's installer honours it.
  assert.equal(toolchainPaths(m.home, { CODEX_HOME: "/elsewhere/codex" }, "/ud").codexHome, "/elsewhere/codex");
});

test("Claude Code: the pinned build is checked, then its own `claude install` runs; the download is removed either way", async () => {
  const src = path.join(ROOT, "claude-standin");
  sh(src, `case "$1" in install) mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\necho "9.9.9 (Claude Code)"\\n' > "$HOME/.local/bin/claude"; chmod 755 "$HOME/.local/bin/claude"; echo "Claude Code successfully installed";; *) exit 2;; esac`);
  const { files, manifest } = pinned({ claude: fs.readFileSync(src) });
  const m = machine(files, manifest);
  m.state.team = MANIFEST.tools.claude.teamId as string;
  const ctx = context();
  await runToolchainJob("claude", m.deps, ctx);
  assert.ok(m.calls.some((c) => c[0].endsWith(`claude-${MANIFEST.tools.claude.version}-darwin-arm64`) && c[1] === "install"));
  assert.match(ctx.seen.raw.join(""), /successfully installed/, "its own output streams to the terminal");
  assert.ok(fs.existsSync(path.join(m.home, ".local", "bin", "claude")));
  assert.deepEqual(fs.readdirSync(m.deps.paths.downloads), []);
  // An installer that fails: the job fails with its exit, and the download is still removed.
  sh(src, "echo nope; exit 3");
  const again = pinned({ claude: fs.readFileSync(src) });
  const m2 = machine(again.files, again.manifest);
  m2.state.team = MANIFEST.tools.claude.teamId as string;
  await assert.rejects(runToolchainJob("claude", m2.deps, context()), /claude install stopped \(exit 3\)/);
  assert.deepEqual(fs.readdirSync(m2.deps.paths.downloads), []);
});

function ollamaZip(): Buffer {
  const src = path.join(ROOT, "src-ollama");
  fs.mkdirSync(path.join(src, "Ollama.app", "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(src, "Ollama.app", "Contents", "Info.plist"), "<plist/>\n");
  sh(path.join(src, "Ollama.app", "Contents", "MacOS", "Ollama"), "exit 0");
  const zip = path.join(ROOT, "ollama.zip");
  fs.rmSync(zip, { force: true });
  const r = spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", path.join(src, "Ollama.app"), zip], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(zip);
}

test("Ollama: checked deep, by its team and by Gatekeeper, moved into the first Applications folder it may write, opened hidden", async () => {
  const { files, manifest } = pinned({ ollama: ollamaZip() });
  const m = machine(files, manifest);
  m.state.team = MANIFEST.tools.ollama.teamId as string;
  const ctx = context();
  await runToolchainJob("ollama", m.deps, ctx);
  const app = path.join(m.home, "Applications", "Ollama.app");
  assert.ok(fs.existsSync(path.join(app, "Contents", "Info.plist")), "the first folder could not be written, so ~/Applications");
  assert.ok(m.calls.some((c) => c[0] === "/usr/bin/codesign" && c.includes("--deep")));
  assert.ok(m.calls.some((c) => c[0] === "/usr/sbin/spctl"));
  assert.deepEqual(m.state.opened, [app]);
  assert.ok(m.calls.some((c) => c[0] === "/usr/bin/open" && c[1] === "-g" && c[2] === "-j"), "opened in the background, hidden");
  assert.ok(ctx.seen.lines.includes("Ollama is answering."));
  // Gatekeeper's refusal stops it before the move.
  const again = pinned({ ollama: ollamaZip() });
  const m2 = machine(again.files, again.manifest);
  m2.state.team = MANIFEST.tools.ollama.teamId as string;
  m2.state.gatekeeper = false;
  await assert.rejects(runToolchainJob("ollama", m2.deps, context()), /Gatekeeper does not accept Ollama\.app/);
  assert.equal(fs.existsSync(path.join(m2.home, "Applications", "Ollama.app")), false);
  assert.deepEqual(fs.readdirSync(m2.deps.paths.downloads), []);
});

test("Ollama on a macOS older than it needs: refused before anything is downloaded", async () => {
  const m = machine({}, MANIFEST, { macOS: "13.6" });
  await assert.rejects(runToolchainJob("ollama", m.deps, context()), /Ollama \d+\.\d+\.\d+ needs macOS 14\.0 or newer; this Mac runs 13\.6/);
  assert.deepEqual(m.urls, []);
});

test("the models follow the Mac's memory, open Ollama when it is not answering, pull only what is missing, with progress", async () => {
  const app = "/Applications/Ollama.app";
  const m = machine({}, MANIFEST, { totalmem: 8 * GB, ollamaApp: () => app });
  m.state.tags = null;
  const ctx = context();
  await runToolchainJob("models", m.deps, ctx);
  assert.deepEqual(m.state.opened, [app]);
  assert.deepEqual(m.state.pulls, ["qwen3.5:4b", EMBEDDER]);
  assert.ok(ctx.seen.progress.some((p) => p.label === "Downloading qwen3.5:4b" && p.received === 1000 && p.total === 1000));
  assert.ok(ctx.seen.lines.includes(`  pulling ${"ab".repeat(6)}`), "a layer's digest is shortened");
  // Run again: both there, nothing pulled.
  m.state.pulls = [];
  await runToolchainJob("models", m.deps, context());
  assert.deepEqual(m.state.pulls, []);
  // 16 GB: the 9b. An error in the stream fails the job with Ollama's words.
  const big = machine({}, MANIFEST, { totalmem: 16 * GB });
  big.state.tags = [EMBEDDER];
  big.state.pullError = "pull model manifest: file does not exist";
  await assert.rejects(runToolchainJob("models", big.deps, context()), /Ollama could not download qwen3\.5:9b: pull model manifest/);
  // Not answering and no app to open: say so.
  const none = machine({}, MANIFEST);
  await assert.rejects(runToolchainJob("models", none.deps, context()), /Ollama is not answering at http:\/\/127\.0\.0\.1:11434: start it, then Retry/);
});

test("each job says what it will do, naming the pinned version and where it comes from", () => {
  const home = "/h";
  const node = describeJob("node", MANIFEST, "arm64", home, {}, 16 * GB);
  assert.match(node, new RegExp(`Downloads Node\\.js ${MANIFEST.tools.node.version.replace(/\./g, "\\.")} from nodejs\\.org \\(\\d+ MB\\) and checks its SHA-256 and its signature`));
  assert.match(node, /~\/\.local\/share\/unidex\/node\/current\/bin\/node/);
  assert.match(describeJob("uv", MANIFEST, "arm64", home, {}, 0), /from github\.com\/astral-sh\/uv .*uv and uvx in ~\/\.local\/bin/);
  assert.match(describeJob("ollama", MANIFEST, "arm64", home, {}, 0), /from github\.com\/ollama\/ollama .*Gatekeeper too.*opens it in the background/);
  assert.match(describeJob("claude", MANIFEST, "x64", home, {}, 0), /from downloads\.claude\.ai .*claude install/);
  assert.match(describeJob("codex", MANIFEST, "arm64", home, {}, 0), /from github\.com\/openai\/codex .*~\/\.codex\/packages\/standalone/);
  assert.match(describeJob("models", MANIFEST, "arm64", home, {}, 8 * GB), /qwen3\.5:4b and qwen3-embedding:0\.6b/);
});
