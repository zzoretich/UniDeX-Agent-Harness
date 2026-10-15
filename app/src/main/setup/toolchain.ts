// The tools the wizard installs when one is missing (install-import B1): a private Node LTS, uv, the Ollama app,
// Claude Code by its native installer and Codex by its standalone package, each from a pinned URL with a pinned size and
// SHA-256 (toolchain-manifest.json, where each pin says where it came from). A download goes through Electron's net, so
// it follows the system's proxy settings; it is hashed as it arrives and checked before anything is unpacked, and a
// mismatch deletes it and fails the job (the wizard offers Retry). What it unpacks is checked again against the Developer
// ID team that signs it (codesign), and the Ollama app by Gatekeeper too (spctl), before anything is moved into place.
// Ollama's models follow the Mac's memory (local-first A12) and come through Ollama's own /api/pull. Nothing here runs
// through a shell: every program is an absolute path, the curl main found, or the tool just installed. The network, the
// programs and the folders are injected, so the tests stand in for all three.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { BRAND } from "../../shared/brand";
import shipped from "./toolchain-manifest.json";
import { cmpVersion } from "./payload";

export type ToolId = "node" | "uv" | "ollama" | "claude" | "codex";
export const TOOL_IDS: readonly ToolId[] = ["node", "uv", "ollama", "claude", "codex"];
/** A toolchain job: install a tool, or pull Ollama's models. */
export type ToolchainJob = ToolId | "models";
export type Arch = "arm64" | "x64";

export interface Asset { url: string; sha256: string; size: number }
export interface ToolPin {
  version: string;
  /** The oldest version already on the Mac that is reused; null: any. */
  floor: string | null;
  /** The Developer ID team that signs it; null only in a development manifest (the e2e suite's unsigned stand-ins). */
  teamId: string | null;
  /** The oldest macOS it runs on, when it says so (Ollama's LSMinimumSystemVersion). */
  minMacOS?: string;
  from: string;
  assets: Record<Arch, Asset>;
}
export interface Manifest { schema: 1; tools: Record<ToolId, ToolPin> }

export class ToolchainError extends Error {}

const SEMVER = /^\d+\.\d+\.\d+$/;
const fail = (why: string): never => { throw new ToolchainError(`toolchain manifest: ${why}`); };

/**
 * A manifest, checked: the five tools, each with a version, a floor, a team, its provenance and an asset per arch with an
 * https URL, a SHA-256 and a size. `dev` (a development run's override) also takes http://127.0.0.1 URLs and no team.
 */
export function parseManifest(raw: unknown, o: { dev?: boolean } = {}): Manifest {
  const m = raw as { schema?: unknown; tools?: Record<string, unknown> } | null;
  if (!m || typeof m !== "object" || m.schema !== 1) fail("schema must be 1");
  const tools = m?.tools;
  if (!tools || typeof tools !== "object") fail("no tools");
  const keys = Object.keys(tools as object).sort();
  if (keys.join(",") !== [...TOOL_IDS].sort().join(",")) fail(`tools must be exactly ${TOOL_IDS.join(", ")}`);
  const out = {} as Record<ToolId, ToolPin>;
  for (const id of TOOL_IDS) {
    const t = (tools as Record<string, Partial<ToolPin> | undefined>)[id] ?? {};
    if (typeof t.version !== "string" || !SEMVER.test(t.version)) fail(`${id}: version`);
    if (t.floor !== null && (typeof t.floor !== "string" || !SEMVER.test(t.floor))) fail(`${id}: floor`);
    const teamOk = typeof t.teamId === "string" && /^[A-Z0-9]{10}$/.test(t.teamId);
    if (!teamOk && !(o.dev && t.teamId === null)) fail(`${id}: teamId`);
    if (t.minMacOS !== undefined && (typeof t.minMacOS !== "string" || !/^\d+(\.\d+){0,2}$/.test(t.minMacOS))) fail(`${id}: minMacOS`);
    if (typeof t.from !== "string" || !t.from.trim()) fail(`${id}: from`);
    const assets = {} as Record<Arch, Asset>;
    for (const arch of ["arm64", "x64"] as const) {
      const a = (t.assets as Record<string, Partial<Asset>> | undefined)?.[arch];
      let url: URL | null = null;
      try { url = new URL(String(a?.url)); } catch { /* checked below */ }
      const urlOk = !!url && (url.protocol === "https:" || (!!o.dev && url.protocol === "http:" && url.hostname === "127.0.0.1"));
      if (!a || !urlOk) fail(`${id}.${arch}: url`);
      if (typeof a?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) fail(`${id}.${arch}: sha256`);
      if (typeof a?.size !== "number" || !Number.isInteger(a.size) || a.size <= 0 || a.size > 2 ** 31) fail(`${id}.${arch}: size`);
      assets[arch] = { url: String(a?.url), sha256: String(a?.sha256), size: Number(a?.size) };
    }
    out[id] = { version: String(t.version), floor: t.floor ?? null, teamId: t.teamId ?? null, ...(t.minMacOS ? { minMacOS: t.minMacOS } : {}), from: String(t.from), assets };
  }
  return { schema: 1, tools: out };
}

/** The pins this build carries. */
export const MANIFEST: Manifest = parseManifest(shipped);

/**
 * The manifest a run uses: the shipped one, or, in a development run only, the file $AOS_TOOLCHAIN_MANIFEST names (the
 * e2e suite's stand-ins, served from 127.0.0.1). A packaged app never reads another.
 */
export function loadManifest(env: NodeJS.ProcessEnv, allowOverride: boolean): Manifest {
  const file = env.AOS_TOOLCHAIN_MANIFEST;
  if (!allowOverride || !file || !path.isAbsolute(file)) return MANIFEST;
  return parseManifest(JSON.parse(fs.readFileSync(file, "utf8")), { dev: true });
}

/** process.arch as the manifest names it; null on anything but a Mac's two. */
export function archOf(arch: string): Arch | null { return arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null; }

// ── Ollama's models ──────────────────────────────────────────────────

const GB = 1024 ** 3;

/**
 * local-first A12: the workhorse a Mac of this much memory runs well, first match wins. The runtime's copy is
 * LOCAL_TIERS in brain/scripts/sdk/lib/models.js; tests/unit/setup.test.ts holds the two equal.
 */
export const RAM_TIERS: ReadonlyArray<{ belowGb: number; tag: string }> = [{ belowGb: 12, tag: "qwen3.5:4b" }, { belowGb: Infinity, tag: "qwen3.5:9b" }];

/** The embedder every tier pulls (models.js's embedder). */
export const EMBEDDER = "qwen3-embedding:0.6b";

/** The Mac's memory: os.totalmem(), or $AOS_TOTALMEM (bytes) where a test pins it, as models.js reads it. */
export function totalMemBytes(env: NodeJS.ProcessEnv, total: number): number {
  const pinned = Number(env.AOS_TOTALMEM);
  return Number.isFinite(pinned) && pinned > 0 ? pinned : total;
}

/** The models the wizard leaves downloaded on a Mac with this much memory: the tier's workhorse, then the embedder. */
export function ollamaModels(totalBytes: number): [string, string] {
  const tier = RAM_TIERS.find((t) => totalBytes < t.belowGb * GB) ?? RAM_TIERS[RAM_TIERS.length - 1];
  return [tier.tag, EMBEDDER];
}

/** Where provider.js looks for Ollama before a vault has any config. */
export const OLLAMA_URL = "http://127.0.0.1:11434";

/**
 * curl asking Ollama as provider.js's node http does: -q (first) skips ~/.curlrc, and --noproxy keeps 127.0.0.1 off any
 * http_proxy or ALL_PROXY in main's environment, which node ignores.
 */
export const OLLAMA_CURL = ["-q", "--noproxy", "127.0.0.1", "-fs"] as const;

/** The model names in Ollama's /api/tags answer; null when it did not answer with them. */
export function parseTags(r: { code: number | null; out: string } | null): string[] | null {
  if (!r || r.code !== 0) return null;
  try {
    const models = (JSON.parse(r.out) as { models?: unknown }).models;
    if (!Array.isArray(models)) return null;
    return models.flatMap((m: { name?: unknown; model?: unknown }) => [m?.name, m?.model].filter((n): n is string => typeof n === "string"));
  } catch { return null; }
}

// ── versions and folders ─────────────────────────────────────────────

/** The first x.y.z in a program's output ("v24.22.0", "uv 0.13.1 (…)", "codex-cli 0.162.1"); null when there is none. */
export function versionIn(out: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/**
 * Whether `version` is at or above the pin's floor. No floor: yes. With a floor, a version that could not be read is a
 * no (inspection F5): a tool that does not answer `--version` is not trusted to run `aos init`.
 */
export function meetsFloor(version: string | null, floor: string | null): boolean {
  if (!floor) return true;
  if (!version) return false;
  return (cmpVersion(version, floor) ?? -1) >= 0;
}

/** "14.0" ≤ "15.3.1"? Missing parts count as 0; an empty or unreadable version counts as new enough. */
export function macOSAtLeast(have: string, need: string): boolean {
  if (!/^\d+(\.\d+)*$/.test(have)) return true;
  const a = have.split(".").map(Number), b = need.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** The private Node's folder: ~/.local/share/unidex/node/current/bin, which `aos init` records (cli/node-path.js). */
export function privateNodeBinDir(home: string): string { return path.join(home, ".local", "share", "unidex", "node", "current", "bin"); }

export interface ToolchainPaths {
  /** ~/.local/bin: the links to uv and to the hosts' CLIs (claude, codex), and aos's. */
  localBin: string;
  /** ~/.local/share/unidex: the private Node and uv, each a folder per version. */
  unidex: string;
  /** ~/.local/share/unidex/node: one folder per version and the `current` link. */
  nodeRoot: string;
  /** ~/.local/share/unidex/node/current/bin/node, the path agenticos.json records. */
  node: string;
  /** $CODEX_HOME, else ~/.codex: its packages/standalone is where Codex's installer keeps its releases. */
  codexHome: string;
  /** Where a download waits until it is checked: the app's data. */
  downloads: string;
  /** Where the Ollama app goes: the first that can be written. */
  applications: string[];
}

export function toolchainPaths(home: string, env: NodeJS.ProcessEnv, userData: string): ToolchainPaths {
  const unidex = path.join(home, ".local", "share", "unidex");
  const nodeRoot = path.join(unidex, "node");
  return {
    localBin: path.join(home, ".local", "bin"),
    unidex,
    nodeRoot,
    node: path.join(privateNodeBinDir(home), "node"),
    codexHome: env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex"),
    downloads: path.join(userData, "setup", "downloads"),
    applications: ["/Applications", path.join(home, "Applications")],
  };
}

// ── the job's seams ──────────────────────────────────────────────────

export interface RunResult { code: number | null; out: string }
export interface RunOptions { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; onData?: (text: string) => void }
/** A program with arguments, never a shell; stdout and stderr together. */
export type Run = (file: string, args: string[], o?: RunOptions) => Promise<RunResult>;

export interface FetchResponse { ok: boolean; status: number; body: AsyncIterable<Uint8Array> | null }
/** An https GET (main passes Electron's net.fetch, which uses the system's proxy settings). */
export type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<FetchResponse>;

export interface ToolchainDeps {
  manifest: Manifest;
  arch: Arch;
  home: string;
  paths: ToolchainPaths;
  fetch: Fetch;
  run: Run;
  /** The environment the tools' own commands run with (the login PATH, CLAUDECODE removed). */
  env: NodeJS.ProcessEnv;
  /** curl on the login PATH (/usr/bin/curl on every Mac), for Ollama's API; null when there is none. */
  curl: string | null;
  /** The macOS version ("15.3.1"); "" when unknown. */
  macOS: string;
  /** The Mac's memory in bytes (totalMemBytes). */
  totalmem: number;
  /** Whether a folder may be written. */
  canWrite: (dir: string) => boolean;
  /** The Ollama app the checks found, else null. */
  ollamaApp: () => string | null;
  /** How long to wait for Ollama to answer once it is opened. */
  ollamaWaitSec?: number;
}

/** What a job reports: lines and raw output for the wizard's terminal, and a download's progress. */
export interface TaskContext {
  signal: AbortSignal;
  log(line: string): void;
  write(text: string): void;
  progress(p: { label: string; received: number; total: number | null }): void;
}

// ── helpers ──────────────────────────────────────────────────────────

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim().slice(0, 200) ?? "";
const mb = (n: number): string => `${Math.max(1, Math.round(n / 1e6))} MB`;
/** ~/… for a path under home, as the wizard shows it. */
export const tilde = (p: string, home: string): string => (p === home ? "~" : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);

/** Where a pin comes from, as the wizard names it: github.com/<owner>/<repo>, else the host. */
export function sourceOf(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return u.host === "github.com" && parts.length >= 2 ? `github.com/${parts[0]}/${parts[1]}` : u.host;
  } catch { return url; }
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolchainError("stopped");
}

/**
 * A program of the job's, stopped with it, and the job stops right after it when Stop came meanwhile (inspection F6): a
 * stopped job never moves, links or reports anything after its Stop, even when the program itself ended normally.
 */
async function step(d: ToolchainDeps, ctx: TaskContext, file: string, args: string[], o: Omit<RunOptions, "signal"> = {}): Promise<RunResult> {
  aborted(ctx.signal);
  const r = await d.run(file, args, { ...o, signal: ctx.signal });
  aborted(ctx.signal);
  return r;
}

/**
 * Downloads `asset` to `dest`, hashing as it arrives. The file is kept only when it is exactly the pinned size and
 * SHA-256; anything else (an error, more bytes than pinned, another hash) deletes it and throws.
 */
export async function fetchVerified(asset: Asset, dest: string, label: string, d: Pick<ToolchainDeps, "fetch">, ctx: TaskContext): Promise<string> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  fs.rmSync(part, { force: true });
  fs.rmSync(dest, { force: true });
  ctx.log(`Downloading ${label} from ${sourceOf(asset.url)} (${mb(asset.size)})…`);
  const hash = crypto.createHash("sha256");
  let received = 0;
  const fh = await fs.promises.open(part, "w", 0o600);
  try {
    const res = await d.fetch(asset.url, { signal: ctx.signal });
    if (!res.ok || !res.body) throw new ToolchainError(`${new URL(asset.url).host} answered ${res.status}`);
    ctx.progress({ label: `Downloading ${label}`, received: 0, total: asset.size });
    for await (const chunk of res.body) {
      aborted(ctx.signal);
      received += chunk.byteLength;
      if (received > asset.size) throw new ToolchainError(`${label}: more than the ${asset.size} bytes pinned`);
      hash.update(chunk);
      await fh.write(chunk);
      ctx.progress({ label: `Downloading ${label}`, received, total: asset.size });
    }
    aborted(ctx.signal);
  } catch (err) {
    await fh.close().catch(() => undefined);
    fs.rmSync(part, { force: true });
    throw err instanceof ToolchainError || ctx.signal.aborted ? err : new ToolchainError(`could not download ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await fh.close();
  const got = hash.digest("hex");
  if (received !== asset.size || got !== asset.sha256) {
    fs.rmSync(part, { force: true });
    throw new ToolchainError(`${label} did not match its pinned checksum (SHA-256 ${got}, ${received} bytes; expected ${asset.sha256}, ${asset.size} bytes). The download was deleted: Retry fetches it again.`);
  }
  fs.renameSync(part, dest);
  ctx.log(`Checked: SHA-256 ${got} is the pinned one.`);
  return dest;
}

/** codesign accepts it and its Developer ID team is the pinned one; with `gatekeeper`, spctl accepts it too. */
async function checkSigned(file: string, name: string, teamId: string | null, d: ToolchainDeps, ctx: TaskContext, o: { deep?: boolean; gatekeeper?: boolean } = {}): Promise<void> {
  if (!teamId) { ctx.log(`${name}: no signature to check (a development manifest).`); return; }
  const run = (bin: string, args: string[]) => step(d, ctx, bin, args, { timeoutMs: 180_000 });
  const verify = await run("/usr/bin/codesign", ["--verify", ...(o.deep ? ["--deep"] : []), "--strict", file]);
  if (verify.code !== 0) throw new ToolchainError(`${name} is not validly signed: ${firstLine(verify.out) || `codesign exit ${verify.code}`}`);
  const info = await run("/usr/bin/codesign", ["-dv", "--verbose=2", file]);
  const team = /^TeamIdentifier=(\S+)$/m.exec(info.out)?.[1] ?? null;
  if (team !== teamId) throw new ToolchainError(`${name} is signed by team ${team ?? "none"}, not ${teamId}`);
  if (o.gatekeeper) {
    const g = await run("/usr/sbin/spctl", ["-a", "-t", "exec", "-vv", file]);
    if (g.code !== 0) throw new ToolchainError(`Gatekeeper does not accept ${name}: ${firstLine(g.out) || `spctl exit ${g.code}`}`);
  }
  ctx.log(`Checked: ${name} is signed by Developer ID team ${team}${o.gatekeeper ? " and accepted by Gatekeeper" : ""}.`);
}

async function unpack(file: string, into: string, d: ToolchainDeps, ctx: TaskContext): Promise<void> {
  const zip = file.endsWith(".zip");
  const r = zip
    ? await step(d, ctx, "/usr/bin/ditto", ["-x", "-k", file, into], { timeoutMs: 600_000 })
    : await step(d, ctx, "/usr/bin/tar", ["-xzf", file, "-C", into], { timeoutMs: 600_000 });
  if (r.code !== 0) throw new ToolchainError(`could not unpack ${path.basename(file)}: ${firstLine(r.out) || `exit ${r.code}`}`);
}

/** The one folder an archive unpacked into. */
function onlyDir(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
  if (entries.length !== 1 || !entries[0].isDirectory()) throw new ToolchainError(`the archive did not hold one folder (${entries.map((e) => e.name).join(", ") || "nothing"})`);
  return path.join(dir, entries[0].name);
}

const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Points `link` at `target` in one step (a new link renamed over the old); a real folder there is refused. */
function swapLink(link: string, target: string): void {
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(link); } catch { /* absent */ }
  if (st && st.isDirectory()) throw new ToolchainError(`${link} is a folder, not a link: move it away, then Retry`);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const tmp = `${link}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

const within = (root: string, p: string): boolean => { const rel = path.relative(root, p); return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel)); };

/**
 * Makes room at `dest` for a link this installer owns (inspection F3): nothing there, or a link into one of `own` (a tree
 * this installer lays out), is replaced; anything else (a file, a folder, a link elsewhere: another installer's uv, an
 * npm codex) is moved aside to `<dest>.unidex-backup-<time>` and the move is logged. Nothing is replaced unseen.
 */
function makeRoom(dest: string, own: string[], d: ToolchainDeps, ctx: TaskContext): void {
  let st: fs.Stats;
  try { st = fs.lstatSync(dest); } catch { return; }
  if (st.isSymbolicLink()) {
    const target = path.resolve(path.dirname(dest), fs.readlinkSync(dest));
    if (own.some((root) => within(root, target))) return;
  }
  const backup = `${dest}.unidex-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.renameSync(dest, backup);
  ctx.log(`Moved the existing ${tilde(dest, d.home)} aside to ${tilde(backup, d.home)}.`);
}

/** Moves a file or folder into place, copying with ditto when it crosses volumes. */
async function moveInto(src: string, dest: string, d: ToolchainDeps, ctx: TaskContext): Promise<void> {
  try { fs.renameSync(src, dest); return; } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err; }
  const r = await step(d, ctx, "/usr/bin/ditto", [src, dest], { timeoutMs: 600_000 });
  if (r.code !== 0) throw new ToolchainError(`could not copy into ${dest}: ${firstLine(r.out)}`);
  fs.rmSync(src, { recursive: true, force: true });
}

/** The program runs and, when a version is given, says it. */
async function reports(bin: string, version: string | null, d: ToolchainDeps, ctx: TaskContext): Promise<boolean> {
  if (!isFile(bin)) return false;
  const r = await step(d, ctx, bin, ["--version"], { timeoutMs: 30_000, env: d.env });
  return r.code === 0 && (!version || versionIn(r.out) === version);
}

const downloadPath = (d: ToolchainDeps, name: string): string => path.join(d.paths.downloads, name);

// ── the jobs ─────────────────────────────────────────────────────────

/** Node: unpacked into ~/.local/share/unidex/node/v<version>, and `current` pointed at it. */
async function installNode(d: ToolchainDeps, ctx: TaskContext): Promise<void> {
  const pin = d.manifest.tools.node;
  const name = `v${pin.version}`;
  const dir = path.join(d.paths.nodeRoot, name);
  if (await reports(path.join(dir, "bin", "node"), pin.version, d, ctx)) ctx.log(`Node.js ${pin.version} is already in ${tilde(dir, d.home)}.`);
  else {
    const file = await fetchVerified(pin.assets[d.arch], downloadPath(d, `node-${name}-darwin-${d.arch}.tar.gz`), `Node.js ${pin.version}`, d, ctx);
    fs.mkdirSync(d.paths.nodeRoot, { recursive: true });
    const stage = fs.mkdtempSync(path.join(d.paths.nodeRoot, ".staging-"));
    try {
      await unpack(file, stage, d, ctx);
      const top = onlyDir(stage);
      await checkSigned(path.join(top, "bin", "node"), "node", pin.teamId, d, ctx);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(top, dir);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(file, { force: true });
    }
  }
  swapLink(path.join(d.paths.nodeRoot, "current"), name);
  if (!(await reports(d.paths.node, pin.version, d, ctx))) throw new ToolchainError(`${d.paths.node} does not run`);
  ctx.log(`Node.js ${pin.version} is in ${tilde(dir, d.home)}; ${tilde(path.join(d.paths.nodeRoot, "current"), d.home)} points at it.`);
}

/**
 * uv: the archive's uv and uvx, each checked (inspection F4), into ~/.local/share/unidex/uv/<version> in one rename, then
 * linked from ~/.local/bin (F3): what is already there and is not one of these links is moved aside first.
 */
async function installUv(d: ToolchainDeps, ctx: TaskContext): Promise<void> {
  const pin = d.manifest.tools.uv;
  const root = path.join(d.paths.unidex, "uv");
  const dir = path.join(root, pin.version);
  const bins = ["uv", "uvx"];
  if (bins.every((b) => isFile(path.join(dir, b))) && await reports(path.join(dir, "uv"), pin.version, d, ctx)) ctx.log(`uv ${pin.version} is already in ${tilde(dir, d.home)}.`);
  else {
    const file = await fetchVerified(pin.assets[d.arch], downloadPath(d, `uv-${pin.version}-${d.arch}.tar.gz`), `uv ${pin.version}`, d, ctx);
    fs.mkdirSync(root, { recursive: true });
    const stage = fs.mkdtempSync(path.join(root, ".staging-"));
    try {
      await unpack(file, stage, d, ctx);
      const top = onlyDir(stage);
      for (const b of bins) if (!isFile(path.join(top, b))) throw new ToolchainError(`the uv archive has no ${b}`);
      for (const b of bins) {
        fs.chmodSync(path.join(top, b), 0o755);
        await checkSigned(path.join(top, b), b, pin.teamId, d, ctx);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(top, dir);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(file, { force: true });
    }
  }
  fs.mkdirSync(d.paths.localBin, { recursive: true });
  for (const b of bins) {
    makeRoom(path.join(d.paths.localBin, b), [d.paths.unidex], d, ctx);
    swapLink(path.join(d.paths.localBin, b), path.join(dir, b));
  }
  const uv = path.join(d.paths.localBin, "uv");
  if (!(await reports(uv, pin.version, d, ctx))) throw new ToolchainError(`${uv} does not run`);
  ctx.log(`uv ${pin.version} is in ${tilde(dir, d.home)}, linked from ${tilde(d.paths.localBin, d.home)}.`);
}

/** Ollama answers on /api/tags (one ask), with the names it has. */
async function ollamaTags(d: ToolchainDeps, ctx: TaskContext): Promise<string[] | null> {
  if (!d.curl) return null;
  return parseTags(await step(d, ctx, d.curl, [...OLLAMA_CURL, "-m", "3", `${OLLAMA_URL}/api/tags`], { timeoutMs: 10_000, env: d.env }));
}

/** Opens the Ollama app in the background and waits until it answers (curl asks once a second). */
async function startOllama(app: string, d: ToolchainDeps, ctx: TaskContext): Promise<boolean> {
  const secs = d.ollamaWaitSec ?? 60;
  ctx.log(`Opening ${tilde(app, d.home)} in the background, and waiting up to ${secs} s for it to answer…`);
  await step(d, ctx, "/usr/bin/open", ["-g", "-j", app], { timeoutMs: 30_000 });
  if (!d.curl) return false;
  const r = await step(d, ctx, d.curl, [...OLLAMA_CURL, "--retry", String(secs), "--retry-delay", "1", "--retry-connrefused", "--retry-max-time", String(secs),
    "-m", "2", "-o", "/dev/null", `${OLLAMA_URL}/api/tags`], { timeoutMs: (secs + 15) * 1000, env: d.env });
  return r.code === 0;
}

/** Ollama.app: checked (codesign --deep, its team, Gatekeeper), moved into /Applications (else ~/Applications), opened hidden. */
async function installOllama(d: ToolchainDeps, ctx: TaskContext): Promise<void> {
  const pin = d.manifest.tools.ollama;
  if (pin.minMacOS && !macOSAtLeast(d.macOS, pin.minMacOS)) throw new ToolchainError(`Ollama ${pin.version} needs macOS ${pin.minMacOS} or newer; this Mac runs ${d.macOS}`);
  let app = d.ollamaApp();
  if (app) ctx.log(`Ollama is already in ${tilde(app, d.home)}.`);
  else {
    const file = await fetchVerified(pin.assets[d.arch], downloadPath(d, `Ollama-darwin-${pin.version}.zip`), `Ollama ${pin.version}`, d, ctx);
    const stage = fs.mkdtempSync(path.join(d.paths.downloads, ".staging-ollama-"));
    try {
      await unpack(file, stage, d, ctx);
      const unpacked = path.join(stage, "Ollama.app");
      if (!fs.existsSync(path.join(unpacked, "Contents", "Info.plist"))) throw new ToolchainError("the Ollama archive holds no Ollama.app");
      await checkSigned(unpacked, "Ollama.app", pin.teamId, d, ctx, { deep: true, gatekeeper: true });
      const into = d.paths.applications.find((dir) => d.canWrite(dir)) ?? d.paths.applications[d.paths.applications.length - 1];
      fs.mkdirSync(into, { recursive: true });
      app = path.join(into, "Ollama.app");
      if (fs.existsSync(app)) throw new ToolchainError(`${app} is already there: open it, then check again`);
      await moveInto(unpacked, app, d, ctx);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(file, { force: true });
    }
    ctx.log(`Ollama ${pin.version} is in ${tilde(app, d.home)}.`);
  }
  if (await ollamaTags(d, ctx)) { ctx.log("Ollama is answering."); return; }
  ctx.log(await startOllama(app, d, ctx) ? "Ollama is answering." : "Ollama has not answered yet; Download the models opens it again.");
}

/** Claude Code: the pinned build checked, then its own `claude install`, as the native installer (claude.ai/install.sh) runs it. */
async function installClaude(d: ToolchainDeps, ctx: TaskContext): Promise<void> {
  const pin = d.manifest.tools.claude;
  const file = await fetchVerified(pin.assets[d.arch], downloadPath(d, `claude-${pin.version}-darwin-${d.arch}`), `Claude Code ${pin.version}`, d, ctx);
  try {
    fs.chmodSync(file, 0o755);
    await checkSigned(file, "claude", pin.teamId, d, ctx);
    ctx.log("Running Claude Code's installer (claude install)…");
    const r = await step(d, ctx, file, ["install"], { timeoutMs: 20 * 60_000, env: d.env, onData: (t) => ctx.write(t) });
    if (r.code !== 0) throw new ToolchainError(`claude install stopped (exit ${r.code ?? "?"})`);
  } finally {
    fs.rmSync(file, { force: true });
  }
  const bin = path.join(d.paths.localBin, "claude");
  if (!(await reports(bin, null, d, ctx))) throw new ToolchainError(`claude install finished, but ${tilde(bin, d.home)} does not run`);
  ctx.log(`Claude Code is in ${tilde(bin, d.home)}. Next: Log in.`);
}

const TRIPLE: Record<Arch, string> = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" };

/**
 * Codex: the standalone package laid out as Codex's own installer (scripts/install/install.sh) lays it out, so Codex
 * keeps it up to date the same way: <codex home>/packages/standalone/releases/<version>-<target>, `current` pointed at
 * it, `auto-update-version` naming it, and codex and codex-code-mode-host linked from ~/.local/bin. Every executable in
 * it is checked before anything moves (inspection F4); a release already complete is kept, an incomplete one and
 * anything at the links that is not this layout's are moved aside (F3).
 */
async function installCodex(d: ToolchainDeps, ctx: TaskContext): Promise<void> {
  const pin = d.manifest.tools.codex;
  const release = `${pin.version}-${TRIPLE[d.arch]}`;
  const root = path.join(d.paths.codexHome, "packages", "standalone");
  const releases = path.join(root, "releases");
  const dir = path.join(releases, release);
  const exes = ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg"];
  const complete = (at: string) => [...exes, "codex-package.json"].every((rel) => isFile(path.join(at, rel)));
  if (complete(dir) && await reports(path.join(dir, "bin", "codex"), pin.version, d, ctx)) ctx.log(`Codex ${pin.version} is already in ${tilde(dir, d.home)}.`);
  else {
    const file = await fetchVerified(pin.assets[d.arch], downloadPath(d, `codex-package-${release}.tar.gz`), `Codex ${pin.version}`, d, ctx);
    fs.mkdirSync(releases, { recursive: true });
    const stage = path.join(releases, `.staging.${release}.${process.pid}`);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage);
    try {
      await unpack(file, stage, d, ctx);
      if (!complete(stage)) throw new ToolchainError(`not a Codex package: ${[...exes, "codex-package.json"].filter((rel) => !isFile(path.join(stage, rel))).join(", ")} missing`);
      for (const rel of exes) {
        fs.chmodSync(path.join(stage, rel), 0o755);
        await checkSigned(path.join(stage, rel), path.basename(rel), pin.teamId, d, ctx);
      }
      fs.rmSync(path.join(stage, "codex"), { force: true });
      fs.symlinkSync("bin/codex", path.join(stage, "codex"));
      makeRoom(dir, [], d, ctx);
      fs.renameSync(stage, dir);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(file, { force: true });
    }
  }
  const current = path.join(root, "current");
  makeRoom(current, [releases], d, ctx);
  swapLink(current, dir);
  for (const name of ["codex", "codex-code-mode-host"]) {
    const link = path.join(d.paths.localBin, name);
    makeRoom(link, [root], d, ctx);
    swapLink(link, path.join(current, "bin", name));
  }
  const marker = path.join(root, "auto-update-version");
  fs.writeFileSync(`${marker}.${process.pid}.tmp`, release);
  fs.renameSync(`${marker}.${process.pid}.tmp`, marker);
  const bin = path.join(d.paths.localBin, "codex");
  if (!(await reports(bin, pin.version, d, ctx))) throw new ToolchainError(`${tilde(bin, d.home)} does not run`);
  ctx.log(`Codex ${pin.version} is in ${tilde(dir, d.home)}, linked from ${tilde(bin, d.home)}. Next: Log in.`);
}

/** One model through Ollama's /api/pull, its progress from the streamed answer. */
async function pull(model: string, d: ToolchainDeps, ctx: TaskContext): Promise<void> {
  ctx.log(`Downloading ${model}…`);
  let ok = false;
  let error: string | null = null;
  let last = "";
  let buf = "";
  const onData = (text: string): void => {
    buf += text;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let j: { status?: unknown; error?: unknown; total?: unknown; completed?: unknown };
      try { j = JSON.parse(line) as typeof j; } catch { continue; }
      if (typeof j.error === "string") { error = j.error; continue; }
      if (j.status === "success") ok = true;
      if (typeof j.total === "number" && j.total > 0) ctx.progress({ label: `Downloading ${model}`, received: typeof j.completed === "number" ? j.completed : 0, total: j.total });
      const status = typeof j.status === "string" ? j.status.replace(/^pulling ([0-9a-f]{12})[0-9a-f]+$/, "pulling $1") : "";
      if (status && status !== last) { last = status; ctx.log(`  ${status}`); }
    }
  };
  const r = await step(d, ctx, d.curl as string, ["-q", "--noproxy", "127.0.0.1", "-sS", "-N", "-X", "POST", "-H", "Content-Type: application/json",
    "--data-binary", JSON.stringify({ model, stream: true }), `${OLLAMA_URL}/api/pull`], { env: d.env, onData });
  onData("\n");
  if (error) throw new ToolchainError(`Ollama could not download ${model}: ${error}`);
  if (r.code !== 0 || !ok) throw new ToolchainError(`Ollama did not finish ${model} (curl exit ${r.code ?? "?"}${firstLine(r.out) ? `: ${firstLine(r.out)}` : ""})`);
}

/** The tier's two models (local-first A12), opening Ollama first when it is not answering; a model already there is kept. */
async function pullModels(d: ToolchainDeps, ctx: TaskContext): Promise<void> {
  if (!d.curl) throw new ToolchainError("curl was not found on the PATH");
  const want = ollamaModels(d.totalmem);
  ctx.log(`This Mac has ${Math.round(d.totalmem / GB)} GB of memory: ${want.join(" and ")}.`);
  let have = await ollamaTags(d, ctx);
  if (!have) {
    const app = d.ollamaApp();
    if (!app) throw new ToolchainError(`Ollama is not answering at ${OLLAMA_URL}: start it, then Retry`);
    if (!(await startOllama(app, d, ctx)) || !(have = await ollamaTags(d, ctx))) throw new ToolchainError(`Ollama did not answer at ${OLLAMA_URL}: open it, then Retry`);
  }
  for (const m of want) {
    if (have.includes(m)) ctx.log(`${m} is already downloaded.`);
    else await pull(m, d, ctx);
  }
  ctx.log(`Ollama has ${want.join(" and ")}.`);
}

/** Runs one job to its end; a failure throws a ToolchainError whose message says what to do. */
export async function runToolchainJob(job: ToolchainJob, d: ToolchainDeps, ctx: TaskContext): Promise<void> {
  const jobs: Record<ToolchainJob, (d: ToolchainDeps, ctx: TaskContext) => Promise<void>> = {
    node: installNode, uv: installUv, ollama: installOllama, claude: installClaude, codex: installCodex, models: pullModels,
  };
  await jobs[job](d, ctx);
  aborted(ctx.signal);
}

/** What a job does, in one sentence: the wizard shows it before the job runs (the tooltip of its button, and its terminal). */
export function describeJob(job: ToolchainJob, m: Manifest, arch: Arch, home: string, env: NodeJS.ProcessEnv, totalmem: number): string {
  const pinned = (id: ToolId, what: string) => {
    const pin = m.tools[id], a = pin.assets[arch];
    return `Downloads ${what} ${pin.version} from ${sourceOf(a.url)} (${mb(a.size)}) and checks its SHA-256 and its signature`;
  };
  const p = toolchainPaths(home, env, "");
  switch (job) {
    case "node": return `${pinned("node", "Node.js")}, then unpacks it into ${tilde(path.join(p.nodeRoot, `v${m.tools.node.version}`), home)} (${tilde(p.node, home)} is the Node ${BRAND.name} runs)`;
    case "uv": return `${pinned("uv", "uv")}, then unpacks it into ${tilde(path.join(p.unidex, "uv", m.tools.uv.version), home)} and links uv and uvx from ${tilde(p.localBin, home)}`;
    case "ollama": return `${pinned("ollama", "Ollama")} (Gatekeeper too), then moves Ollama.app into Applications and opens it in the background`;
    case "claude": return `${pinned("claude", "Claude Code")}, then runs its installer (claude install), which puts claude in ${tilde(p.localBin, home)}`;
    case "codex": return `${pinned("codex", "Codex")}, then installs it as Codex's own installer does (${tilde(path.join(p.codexHome, "packages", "standalone"), home)}, codex in ${tilde(p.localBin, home)})`;
    case "models": return `Asks Ollama to download ${ollamaModels(totalmem).join(" and ")} (its /api/pull), opening Ollama first if it is not running`;
  }
}
