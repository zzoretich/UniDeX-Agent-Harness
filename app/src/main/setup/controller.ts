// The wizard's and attach mode's calls, as main answers them (phase 5, I3–I5). It keeps what the page must not choose:
// the PATH and the node preflight found, the vault `aos init` was asked for, whether the install finished. Every step is
// checked against policy/setup.ts first; the commands are the fix table's and the payload's CLI.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AttachInfo, ClaudeMdPreview, InstallRequest, PreflightReport, Result, SetupCheckId, SetupEvent, SetupFixId, SetupJob } from "../../shared/ipc";
import { FIXES, fixBlocked, fixCommandLine, installArgs, personaJson, resolveVaultPath, stepRefusal, type SetupStep } from "../policy/setup";
import { refused } from "../services/fs";
import type { PtyLib } from "../services/pty";
import { applyClaudeMd, claudeMdPath, previewClaudeMd } from "./claude-md";
import { findOnPath, isExecutable, loginPath, defaultLoginPathDeps } from "./env";
import { hostsOf, markInstalled, markNoted, type AgenticosFacts } from "./attach";
import { JobRunner } from "./jobs";
import type { Payload } from "./payload";
import { runPreflight, type PreflightDeps, type ProbeResult } from "./preflight";

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
  /** Tests: the PATH, the probes and the child processes. */
  path?: () => string;
  probe?: PreflightDeps["run"];
  isExec?: (p: string) => boolean;
  exists?: (p: string) => boolean;
  spawnImpl?: typeof childProcess.spawn;
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

export class SetupController {
  readonly jobs: JobRunner;
  private PATH: string | null = null;
  private node: string | null = null;
  private last: PreflightReport | null = null;
  private installed = false;
  private installedVault: string | null = null;
  private personaFile: string | null = null;

  constructor(private readonly o: SetupControllerOptions) {
    this.jobs = new JobRunner({ emit: o.emit, pty: o.pty, spawnImpl: o.spawnImpl, onExit: (job, code) => this.exited(job, code) });
  }

  private loginPath(): string {
    this.PATH = this.o.path ? this.o.path() : loginPath(defaultLoginPathDeps(this.o.env, this.o.home));
    return this.PATH;
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
    const { report, node } = await runPreflight({
      PATH, home: this.o.home, run: this.o.probe ?? probe(this.childEnv()), isExec: this.o.isExec, exists: this.o.exists ?? fs.existsSync,
    });
    this.node = node;
    this.last = report;
    return { ok: true, data: report };
  }

  fix(id: SetupFixId, cols: number, rows: number): Result<null> {
    const why = this.refusal("fix");
    if (why) return refused(why);
    if (!this.last) return refused("run the checks first");
    const ok = new Set<SetupCheckId>(this.last.checks.filter((c) => c.state === "ok").map((c) => c.id));
    const blocked = fixBlocked(id, ok);
    if (blocked) return refused(blocked);
    const { file, args } = fixCommandLine(id);
    return this.jobs.startPty("fix", file, args, {
      cwd: this.o.home, cols, rows, echo: FIXES[id].command,
      env: this.childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor", HOMEBREW_NO_ENV_HINTS: "1" }),
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
    const hosts = { claude: req.host !== "codex", codex: req.host !== "claude" };
    if ((hosts.claude && !this.last.hosts.claude) || (hosts.codex && !this.last.hosts.codex)) return refused(`${req.host} is not installed and logged in`);
    const vault = resolveVaultPath(req.vault, this.o.home);
    if (!vault) return { ok: false, error: "the vault must be a folder under your home folder, like ~/AgenticOS", code: "EINVAL" };
    const payload = this.o.payload as NonNullable<SetupControllerOptions["payload"]>;
    let personaFile: string | null = null;
    if (req.persona) {
      personaFile = path.join(this.o.userData, "setup", "persona.json");
      fs.mkdirSync(path.dirname(personaFile), { recursive: true });
      fs.writeFileSync(personaFile, `${JSON.stringify(personaJson(req.persona, hosts), null, 2)}\n`, { mode: 0o600 });
    }
    const r = this.jobs.startProc("install", this.node, installArgs(payload.cli, req, vault, personaFile), {
      cwd: this.o.home, env: this.childEnv(), echo: `aos init --yes --vault ${vault} --host ${req.host}${personaFile ? " --persona-json …" : ""}`,
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
    return { ok: true, data: previewClaudeMd(this.claudeMdFile(this.o.readAgenticos()), vault, this.o.home) };
  }

  applyClaudeMd(): Result<ClaudeMdPreview> {
    const why = this.refusal("claude-md");
    const vault = this.claudeMdVault();
    if (why || !vault) return refused(why ?? "no vault yet");
    const cfg = this.o.readAgenticos();
    if (!hostsOf(cfg).claude) return refused("Claude Code is not a host of this install");
    return { ok: true, data: applyClaudeMd(this.claudeMdFile(cfg), vault, this.o.home) };
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

  noted(): void {
    const vault = this.o.attached();
    if (vault) { try { markNoted(this.o.userData, vault); } catch { /* shows again next time */ } }
  }
}
