// The wizard's and attach mode's calls, as main answers them (phase 5, I3–I5; install-import B1, B2, B13, B14). It keeps
// what the page must not choose: the PATH and the node preflight found, the Ollama app, the vault `aos init` was asked
// for, whether the install finished, the proposals the last import scan listed. Every step is checked against
// policy/setup.ts first; what runs is the fix table's (a toolchain job or a login), the payload's CLI (init, import, an
// earlier install's host unwired, upgrade), and main's own two edits (the CLAUDE.md line and the PATH line).

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AttachInfo, ClaudeMdPreview, HostId, ImportRunRequest, InstallRequest, PathLinePreview, PreflightReport, Result, SetupCheckId, SetupEvent, SetupFixId, SetupJob } from "../../shared/ipc";
import { FIXES, fixBlocked, fixCommandLine, importJobArgs, importScanArgs, installArgs, personaJson, requestHosts, resolveVaultPath, stepRefusal, unwireArgs, zprofilePath, type SetupStep } from "../policy/setup";
import { refused } from "../services/fs";
import type { PtyLib } from "../services/pty";
import { applyClaudeMd, claudeMdPath, previewClaudeMd } from "./claude-md";
import { findOnPath, isExecutable, loginPath, defaultLoginPathDeps, shellPath } from "./env";
import { hostsOf, markInstalled, markNoted, type AgenticosFacts } from "./attach";
import { JobRunner } from "./jobs";
import { applyPathLine, previewPathLine } from "./path-line";
import type { Payload } from "./payload";
import { ollamaApps, runPreflight, type PreflightDeps, type ProbeResult } from "./preflight";
import { archOf, describeJob, loadManifest, runToolchainJob, toolchainPaths, totalMemBytes, type Fetch, type Run, type ToolchainDeps } from "./toolchain";

export interface AgenticosJson extends AgenticosFacts {
  vault?: unknown;
  node?: unknown;
  claudeConfigDir?: unknown;
  hosts?: { claude?: { enabled?: unknown; configDir?: unknown }; codex?: { enabled?: unknown } };
}

export interface SetupControllerOptions {
  home: string;
  userData: string;
  /** Main's own environment: the base of every child's. */
  env: NodeJS.ProcessEnv;
  payload: Payload | null;
  emit: (ev: SetupEvent) => void;
  pty: () => PtyLib;
  /** The attached vault, or null while the wizard shows. */
  attached: () => string | null;
  attachInfo: () => AttachInfo | null;
  readAgenticos: () => AgenticosJson | null;
  /** Re-reads agenticos.json and attaches the vault it names; false when that folder is not there. */
  attach: () => boolean;
  /** After an upgrade: agenticos.json's version moved. */
  refreshAttach: () => void;
  chooseFolder: () => Promise<string | null>;
  /** The downloads' https GET: Electron's net.fetch, which follows the system's proxy settings (index.ts). */
  fetch: Fetch;
  /** A development run may swap the toolchain manifest ($AOS_TOOLCHAIN_MANIFEST); a packaged app never does. */
  allowManifestOverride?: boolean;
  /** The macOS version (process.getSystemVersion()); "" when unknown. */
  macOS?: string;
  /** Tests: the PATH, the probes, the child processes, the toolchain's programs and folders, the Mac's memory. */
  path?: () => string;
  probe?: PreflightDeps["run"];
  isExec?: (p: string) => boolean;
  exists?: (p: string) => boolean;
  spawnImpl?: typeof childProcess.spawn;
  toolRun?: Run;
  totalmem?: number;
  canWrite?: (dir: string) => boolean;
  applications?: string[];
  ollamaWaitSec?: number;
}

/** A probe: the program's stdout and stderr together, its exit code, never a shell, never longer than `timeoutMs`. */
function probe(env: NodeJS.ProcessEnv): PreflightDeps["run"] {
  return (file, args, timeoutMs) => new Promise<ProbeResult>((resolve) => {
    childProcess.execFile(file, args, { env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
      resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

/** Most of a tool's output a toolchain job keeps (its last bytes); everything streams to the terminal anyway. */
const KEEP = 64 * 1024;

/** A toolchain job's program: stdout and stderr together, streamed to `onData`, never a shell, stopped by the job's signal. */
function toolRunner(env: () => NodeJS.ProcessEnv, spawnImpl: typeof childProcess.spawn = childProcess.spawn): Run {
  return (file, args, o = {}) => new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (code: number | null, extra = ""): void => { if (!done) { done = true; resolve({ code, out: out + extra }); } };
    let child: childProcess.ChildProcess;
    try {
      child = spawnImpl(file, args, { env: o.env ?? env(), shell: false, stdio: ["ignore", "pipe", "pipe"], signal: o.signal, timeout: o.timeoutMs, killSignal: "SIGTERM" });
    } catch (err) { finish(null, err instanceof Error ? err.message : String(err)); return; }
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      stream?.on("data", (b: Buffer) => {
        const text = decoder.write(b);
        out = (out + text).slice(-KEEP);
        o.onData?.(text);
      });
    }
    child.on("error", (err) => finish(null, `\n${(err as NodeJS.ErrnoException).code ?? err.message}`));
    child.on("close", (code) => finish(code));
  });
}

const canWriteDir = (dir: string): boolean => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };

export class SetupController {
  readonly jobs: JobRunner;
  private PATH: string | null = null;
  private shellPATH: string | null = null;
  private node: string | null = null;
  private ollamaApp: string | null = null;
  /** The uv the checks validated: `aos init` installs graphify with this one, never another found first on the PATH (M1). */
  private uv: string | null = null;
  private last: PreflightReport | null = null;
  private installed = false;
  private installedVault: string | null = null;
  private personaFile: string | null = null;
  /** The proposal ids the last import scan listed: the only ones an import may create (install-import B9). */
  private scanned: Set<string> | null = null;

  constructor(private readonly o: SetupControllerOptions) {
    this.jobs = new JobRunner({ emit: o.emit, pty: o.pty, spawnImpl: o.spawnImpl, onExit: (job, code) => this.exited(job, code) });
  }

  private loginPath(): string {
    if (this.o.path) {
      this.PATH = this.o.path();
      this.shellPATH = this.PATH;
    } else {
      const deps = defaultLoginPathDeps(this.o.env, this.o.home);
      this.shellPATH = shellPath(deps);
      this.PATH = loginPath(deps, this.shellPATH);
    }
    return this.PATH;
  }

  private totalmem(): number { return totalMemBytes(this.o.env, this.o.totalmem ?? os.totalmem()); }

  /** What a toolchain job runs with: the pins, this Mac, the folders, the network and the programs. */
  private toolchain(): ToolchainDeps {
    const arch = archOf(process.arch) ?? "arm64";
    const paths = toolchainPaths(this.o.home, this.o.env, this.o.userData);
    if (this.o.applications) paths.applications = this.o.applications;
    return {
      manifest: loadManifest(this.o.env, !!this.o.allowManifestOverride),
      arch, home: this.o.home, paths, env: this.childEnv(),
      fetch: this.o.fetch,
      run: this.o.toolRun ?? toolRunner(() => this.childEnv(), this.o.spawnImpl),
      curl: findOnPath("curl", this.PATH ?? this.loginPath(), this.o.isExec ?? isExecutable),
      macOS: this.o.macOS ?? "",
      totalmem: this.totalmem(),
      canWrite: this.o.canWrite ?? canWriteDir,
      ollamaApp: () => this.ollamaApp ?? ollamaApps(this.o.home).find((p) => (this.o.exists ?? fs.existsSync)(p)) ?? null,
      ollamaWaitSec: this.o.ollamaWaitSec,
    };
  }

  /** A child's environment: main's, on the login PATH, and never inside a Claude Code session's (CLAUDECODE). */
  private childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.o.env, PATH: this.PATH ?? this.loginPath(), ...extra };
    delete env.CLAUDECODE;
    return env;
  }

  private refusal(step: SetupStep): string | null {
    const info = this.o.attachInfo();
    return stepRefusal(step, {
      attached: !!this.o.attached(), installed: this.installed, payload: !!this.o.payload, behind: !!info?.behind, busy: !!this.jobs.running,
    });
  }

  async preflight(): Promise<Result<PreflightReport>> {
    const why = this.refusal("preflight");
    if (why) return refused(why);
    const PATH = this.loginPath();
    const { report, node, uv, ollamaApp } = await runPreflight({
      PATH, home: this.o.home, run: this.o.probe ?? probe(this.childEnv()), isExec: this.o.isExec, exists: this.o.exists ?? fs.existsSync,
      manifest: loadManifest(this.o.env, !!this.o.allowManifestOverride), arch: archOf(process.arch) ?? "arm64", macOS: this.o.macOS ?? "",
      totalmem: this.totalmem(), env: this.o.env,
    });
    this.node = node;
    this.ollamaApp = ollamaApp;
    this.uv = uv;
    // An earlier install's hosts (inspection F7): what aos init would refuse to drop, for Choose to explain.
    const cfg = this.o.readAgenticos();
    report.wired = cfg ? hostsOf(cfg) : null;
    this.last = report;
    return { ok: true, data: report };
  }

  fix(id: SetupFixId, cols: number, rows: number): Result<null> {
    const why = this.refusal("fix");
    if (why) return refused(why);
    if (!this.last) return refused("run the checks first");
    const ok = new Set<SetupCheckId>(this.last.checks.filter((c) => c.state === "ok").map((c) => c.id));
    // Only a fix its check offers: nothing is downloaded over a tool that passes, or over an Ollama the wizard did not install.
    const row = this.last.checks.find((c) => c.id === id);
    if (!row || row.fix !== id) return refused(`nothing to fix: ${row?.label ?? id} passes`);
    const blocked = row.fixBlocked ?? fixBlocked(id, ok);
    if (blocked) return refused(blocked);
    const fix = FIXES[id];
    if (fix.kind === "download") {
      const deps = this.toolchain();
      return this.jobs.startTask("fix", (ctx) => runToolchainJob(fix.job, deps, ctx), {
        echo: `${fix.label}: ${describeJob(fix.job, deps.manifest, deps.arch, this.o.home, this.o.env, deps.totalmem)}`,
      });
    }
    const { file, args } = fixCommandLine(id);
    return this.jobs.startPty("fix", file, args, {
      cwd: this.o.home, cols, rows, echo: fix.command,
      env: this.childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" }),
    });
  }

  input(data: string): void { if (this.jobs.running === "fix") this.jobs.input(data); }
  resize(cols: number, rows: number): void { this.jobs.resize(cols, rows); }
  cancel(): void { this.jobs.cancel(); }

  async chooseVault(): Promise<Result<string | null>> {
    if (this.o.attached()) return refused("a vault is already attached");
    return { ok: true, data: await this.o.chooseFolder() };
  }

  install(req: InstallRequest): Result<null> {
    const why = this.refusal("install");
    if (why) return refused(why);
    if (!this.last || !this.node) return refused("run the checks first");
    if (!this.last.ready) return refused("a prerequisite is missing");
    const hosts = requestHosts(req.host);
    if ((hosts.claude && !this.last.hosts.claude) || (hosts.codex && !this.last.hosts.codex)) return refused(`${req.host} is not installed and logged in`);
    const vault = resolveVaultPath(req.vault, this.o.home);
    if (!vault) return { ok: false, error: "the vault must be a folder under your home folder, like ~/AgenticOS", code: "EINVAL" };
    const payload = this.o.payload as NonNullable<SetupControllerOptions["payload"]>;
    let personaFile: string | null = null;
    // No host, no Chief of Staff yet: its duties need one (install-import B2), so the answers wait for that.
    if (req.persona && req.host !== "none") {
      personaFile = path.join(this.o.userData, "setup", "persona.json");
      fs.mkdirSync(path.dirname(personaFile), { recursive: true });
      fs.writeFileSync(personaFile, `${JSON.stringify(personaJson(req.persona, hosts), null, 2)}\n`, { mode: 0o600 });
    }
    const r = this.jobs.startProc("install", this.node, installArgs(payload.cli, req, vault, personaFile), {
      // AOS_UV_BIN: graph-cmd.js uvBin takes it before the PATH, so graphify installs with the uv the checks validated.
      cwd: this.o.home, env: this.childEnv(this.uv ? { AOS_UV_BIN: this.uv } : {}), echo: `aos init --yes --vault ${vault} --host ${req.host}${personaFile ? " --persona-json …" : ""}`,
    });
    if (r.ok) { this.installedVault = vault; this.personaFile = personaFile; }
    else if (personaFile) fs.rmSync(personaFile, { force: true });
    return r;
  }

  private exited(job: SetupJob, code: number | null): void {
    if (job === "install") {
      if (this.personaFile) { fs.rmSync(this.personaFile, { force: true }); this.personaFile = null; }
      this.installed = code === 0;
      // Remembered with the vault, so the Workbench this install opens starts the tour, not the "What changed" note.
      if (this.installed && this.installedVault) { try { markInstalled(this.o.userData, this.installedVault); } catch { /* the note shows instead */ } }
    }
    if (job === "upgrade") this.o.refreshAttach();
  }

  /** The vault the CLAUDE.md line names: the attached one, else the one `aos init` just installed. */
  private claudeMdVault(): string | null { return this.o.attached() ?? (this.installed ? this.installedVault : null); }

  private claudeMdFile(cfg: AgenticosJson | null): string {
    const dir = typeof cfg?.hosts?.claude?.configDir === "string" ? cfg.hosts.claude.configDir : typeof cfg?.claudeConfigDir === "string" ? cfg.claudeConfigDir : null;
    return claudeMdPath({ configDir: dir, env: this.o.env, home: this.o.home });
  }

  claudeMd(): Result<ClaudeMdPreview> {
    const why = this.refusal("claude-md");
    const vault = this.claudeMdVault();
    if (why || !vault) return refused(why ?? "no vault yet");
    try { return { ok: true, data: previewClaudeMd(this.claudeMdFile(this.o.readAgenticos()), vault, this.o.home) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), code: "EIO" }; }
  }

  applyClaudeMd(): Result<ClaudeMdPreview> {
    const why = this.refusal("claude-md");
    const vault = this.claudeMdVault();
    if (why || !vault) return refused(why ?? "no vault yet");
    const cfg = this.o.readAgenticos();
    if (!hostsOf(cfg).claude) return refused("Claude Code is not a host of this install");
    try { return { ok: true, data: applyClaudeMd(this.claudeMdFile(cfg), vault, this.o.home) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), code: "EIO" }; }
  }

  finish(): Result<null> {
    const why = this.refusal("finish");
    if (why) return refused(why);
    return this.o.attach() ? { ok: true, data: null } : { ok: false, error: "agenticos.json names no vault that is there", code: "ENOENT" };
  }

  upgrade(): Result<null> {
    const why = this.refusal("upgrade");
    if (why) return refused(why);
    const payload = this.o.payload as NonNullable<SetupControllerOptions["payload"]>;
    const PATH = this.loginPath();
    // The node `aos init` recorded (D12: Homebrew's stable link), else the login shell's.
    const recorded = this.o.readAgenticos()?.node;
    const node = typeof recorded === "string" && isExecutable(recorded) ? recorded : findOnPath("node", PATH);
    if (!node) return refused("no node on your PATH");
    return this.jobs.startProc("upgrade", node, [payload.cli, "upgrade"], { cwd: this.o.home, env: this.childEnv(), echo: "aos upgrade" });
  }

  /** A program's output, captured (the import scan): stdout apart from stderr, never a shell, stopped after `timeoutMs`. */
  private capture(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      let out = "";
      let err = "";
      let done = false;
      const finish = (code: number | null): void => { if (!done) { done = true; resolve({ code, out, err }); } };
      let child: childProcess.ChildProcess;
      try {
        child = (this.o.spawnImpl ?? childProcess.spawn)(file, args, { cwd: this.o.home, env: this.childEnv(), shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGTERM" });
      } catch (e) { err = e instanceof Error ? e.message : String(e); finish(null); return; }
      const so = new StringDecoder("utf8");
      const se = new StringDecoder("utf8");
      child.stdout?.on("data", (b: Buffer) => { if (out.length < 16 * 1024 * 1024) out += so.write(b); });
      child.stderr?.on("data", (b: Buffer) => { err = (err + se.write(b)).slice(-64 * 1024); });
      child.on("error", (e) => { err += `\n${(e as NodeJS.ErrnoException).code ?? e.message}`; finish(null); });
      child.on("close", (code) => finish(code));
    });
  }

  /**
   * "Bring in your history" (install-import B13): what the runtime the app carries finds on this Mac, `aos import
   * --dry-run --json`, after the install and before the Workbench. Nothing is written. The page reads the report.
   */
  async importScan(): Promise<Result<unknown>> {
    const why = this.refusal("import");
    if (why) return refused(why);
    if (!this.node) return refused("run the checks first");
    const payload = this.o.payload as NonNullable<SetupControllerOptions["payload"]>;
    const r = await this.capture(this.node, importScanArgs(payload.cli), 180_000);
    if (r.code !== 0) {
      const line = r.err.trim().split("\n").filter(Boolean).pop() ?? "";
      return { ok: false, error: line.replace(/^aos( import)?: /, "") || `aos import exited ${r.code ?? "without a code"}`, code: "EIO" };
    }
    let report: unknown;
    try { report = JSON.parse(r.out); } catch { return { ok: false, error: "aos import sent output that does not parse", code: "EIO" }; }
    const j = report as { dryRun?: unknown; hosts?: unknown; projects?: { proposals?: Array<{ id?: unknown }> } };
    if (!j || typeof j !== "object" || j.dryRun !== true || !j.hosts || typeof j.hosts !== "object") return { ok: false, error: "aos import answered in an unexpected shape", code: "EIO" };
    this.scanned = new Set((Array.isArray(j.projects?.proposals) ? j.projects!.proposals! : []).map((p) => p?.id).filter((id): id is string => typeof id === "string"));
    return { ok: true, data: report };
  }

  /** The import (B9, B13): the hosts and kinds the page ticked, and only the scan's proposals it picked, as a setup job. */
  importHistory(req: ImportRunRequest): Result<null> {
    const why = this.refusal("import");
    if (why) return refused(why);
    if (!this.node || !this.scanned) return refused("look at what there is to import first");
    const payload = this.o.payload as NonNullable<SetupControllerOptions["payload"]>;
    let args: string[];
    try { args = importJobArgs(payload.cli, req, this.scanned); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), code: "EINVAL" }; }
    return this.jobs.startProc("import", this.node, args, {
      cwd: this.o.home, env: this.childEnv(), echo: `aos ${args.slice(1).map((a) => (/^[\w.,:/~-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ")}`,
    });
  }

  /**
   * Inspection F7, made a choice: `aos uninstall --host <host>` from the payload, for a host an earlier install's
   * agenticos.json has on, before this install (aos init refuses to drop it). Its plugin, hooks and MCP server go; the
   * host's CLI, its sessions and settings, and the vault stay. Refused for a host that file does not have on.
   */
  unwire(host: HostId): Result<null> {
    const why = this.refusal("unwire");
    if (why) return refused(why);
    if (!this.node) return refused("run the checks first");
    const cfg = this.o.readAgenticos();
    if (!cfg || !hostsOf(cfg)[host]) return refused(`agenticos.json does not have ${host} on`);
    if (typeof cfg.vault !== "string" || !cfg.vault) return refused("agenticos.json names no vault, so aos uninstall cannot unwire its hosts");
    const payload = this.o.payload as NonNullable<SetupControllerOptions["payload"]>;
    return this.jobs.startProc("unwire", this.node, unwireArgs(payload.cli, host), { cwd: this.o.home, env: this.childEnv(), echo: `aos uninstall --host ${host}` });
  }

  noted(): void {
    const vault = this.o.attached();
    if (vault) { try { markNoted(this.o.userData, vault); } catch { /* shows again next time */ } }
  }

  /** Finish's PATH line (install-import B14): the profile, the line, and whether either already does the job. */
  pathLine(): Result<PathLinePreview> {
    const why = this.refusal("path");
    if (why) return refused(why);
    try { return { ok: true, data: previewPathLine(zprofilePath(this.o.home, this.o.env), this.o.home, this.shellPATH) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), code: "EIO" }; }
  }

  addToPath(): Result<PathLinePreview> {
    const why = this.refusal("path");
    if (why) return refused(why);
    try { return { ok: true, data: applyPathLine(zprofilePath(this.o.home, this.o.env), this.o.home, this.shellPATH) }; }
    catch (err) { return { ok: false, error: `the PATH line: ${err instanceof Error ? err.message : String(err)}`, code: "EIO" }; }
  }
}
