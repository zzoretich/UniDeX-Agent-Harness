// terminalLauncher.ts — starting terminals from the Term tab (spec 2026-10-08-term-agent-deck T2–T11). The decisions are
// pure, in terminalLaunch.ts; this does the rest through the HudHost: it lists the workspaces and their linked code
// folders, makes Scratch and new workspaces, starts the terminal, types the agent's line into it, remembers the choice,
// and tells the panel what it started. A new workspace and a linked code folder go through the runtime's
// `aos workspace new` and `aos workspace set` while the Spaces surface admits them (spaces-redesign D28, D29), the one
// code path a session on either host uses too; with that surface off, through HostFs as before (the Files surface).
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import { env, fs } from "../host";
import { claudeConfigDir as envClaudeConfigDir, readAgenticosJson, readProviderState } from "./aosConfig";
import { modelArg, workspaceNames } from "./agentSessions";
import { envPrefix } from "./teams";
import { shq } from "./skills";
import type { TerminalSession } from "./terminalSession";
import {
  SCRATCH, TERM_HOST_LABEL, gitInitWanted, homePlace, launchIds, launchLine, parseRepoLink, placeOf, previewLine, quickHost,
  repoValue, resolvePlace, scratchStubs, slugify, stubWrites, termHostChoices, vaultPlace, withRepoLink, workspaceNameProblem,
  workspacePlace, workspaceStubs,
} from "./terminalLaunch";
import type { LaunchSpec, Place, PlaceWhy, PlaceWorld, TermAccess, TermHost, TermHostChoice } from "./terminalLaunch";
import { rememberTerminalChoice, sanitizeSessionChoice, sanitizeTerminalChoice } from "../settingsDefaults";
import { KEBAB_RE, WS_RE, verbResult, workspaceArgs } from "./spacesModel";
import type { ManifestFields, VerbResult } from "./spacesModel";
import type { TerminalChoice } from "../settingsDefaults";

/** What a launch asks for: the host, and a place when one was picked; otherwise the context or the default decides. */
export interface LaunchRequest {
  host: TermHost;
  /** Where it starts. A Spaces resume picks `{...workspacePlace(name, w), dir: <the folder D7 picks>, linked: false}`, so
   *  the terminal stays in the `ws:<name>` group whatever folder it starts in (spaces-redesign D7, D26). */
  picked?: Place | null;
  context?: Place | null;
  /** Continue a conversation instead of starting one: the last one in that place (⇧Enter in the menu), or one by id
   *  (either host; the terminal then remembers the id for its end bar's Resume). */
  resume?: "last" | { id: string } | null;
  /** Type `git init` first (a new workspace whose box is ticked). */
  gitInit?: boolean;
  /** What started it when it was not the deck (a skill's button, Spaces…): the row's "from …" subtitle. Such launches
   *  never change the remembered host. */
  origin?: string | null;
}

export interface Launched {
  session: TerminalSession;
  place: Place;
  why: PlaceWhy;
}

/** What the panel shows for six seconds after a launch: "Started Claude Code in Vault · Change". */
export interface LaunchNote { id: string; text: string; why: PlaceWhy; host: TermHost }

export class TerminalLauncher {
  constructor(private plugin: AgenticOSPlugin) {}

  private vault(): string { return this.plugin.vaultRoot(); }
  private home(): string { return env.homedir(); }
  private workspacesDir(): string { return path.join(this.vault(), "workspaces"); }

  /** The workspaces a terminal may start in, and their linked code folders, read from disk each time (cheap). */
  world(): PlaceWorld {
    const vault = this.vault();
    let names: string[] = [];
    try {
      names = workspaceNames(fs.readdirSync(this.workspacesDir(), { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name));
    } catch { /* no workspaces/ yet */ }
    const links: Record<string, string> = {};
    for (const n of names) {
      try {
        const repo = parseRepoLink(fs.readFileSync(path.join(this.workspacesDir(), n, "workspace.md"), "utf8"), this.home(), vault);
        if (repo) links[n] = repo;
      } catch { /* no workspace.md */ }
    }
    return { vault, home: this.home(), workspaces: names, links };
  }

  /** The remembered Term choice, sanitized. */
  choice(): TerminalChoice { return sanitizeTerminalChoice(this.plugin.settings.terminalChoice); }

  /** Remembers an access level or a default place picked in the menu. */
  remember(patch: { access?: TermAccess; agentPlace?: TerminalChoice["agentPlace"] }): void {
    this.plugin.settings.terminalChoice = rememberTerminalChoice(this.plugin.settings.terminalChoice, patch);
    void this.plugin.saveSettings();
  }

  /** The model a launch of `host` passes, in words: the one remembered from Sessions, else the host's default. */
  modelLabel(host: "claude" | "codex"): string {
    return modelArg(host, sanitizeSessionChoice(this.plugin.settings.sessionChoice).models[host]) ?? (host === "claude" ? "Default model" : "Codex default");
  }

  /** The hosts a launch may use, read fresh (a login or `aos hosts add` while the app runs shows up at once). */
  choices(): TermHostChoice[] {
    return termHostChoices(readAgenticosJson(this.plugin.claudeConfigDir()), readProviderState(this.vault()));
  }

  /** The host ⌘T starts, or why it cannot (the menu then opens with the reason). */
  quickHost(): { host: TermHost | null; reason: string | null } {
    return quickHost(sanitizeTerminalChoice(this.plugin.settings.terminalChoice).host, this.choices());
  }

  /** Where shells start when nothing is picked: the Working directory setting, else the vault. */
  shellDefault(w = this.world()): Place {
    const cwd = this.plugin.settings.terminalCwd;
    if (!cwd) return vaultPlace(w);
    return path.resolve(cwd) === path.resolve(w.home) ? homePlace(w) : placeOf(cwd, w);
  }

  /** Where a launch of `host` lands, and why. */
  resolve(host: TermHost, picked?: Place | null, context?: Place | null): { place: Place; why: PlaceWhy } {
    const w = this.world();
    const choice = sanitizeTerminalChoice(this.plugin.settings.terminalChoice);
    const last = choice.recent.find((n) => w.workspaces.includes(n));
    return resolvePlace({
      host, picked, context, agentPlace: choice.agentPlace,
      lastWorkspace: last ? workspacePlace(last, w) : null,
      scratch: workspacePlace(SCRATCH, w), vault: vaultPlace(w), shellDefault: this.shellDefault(w),
    });
  }

  /**
   * The agent line a launch would type, before the session id is known (the menu's preview), or for a resume by id
   * (Spaces' hint: `launchLine(spec(host, { resume: { id }, cwd }))`). `cwd` is the folder the terminal starts in; a
   * Codex resume by id needs it, or Codex asks which folder to use (LaunchSpec.cwd).
   */
  spec(host: "claude" | "codex", opts: { resume?: "last" | { id: string } | null; gitInit?: boolean; sessionId?: string | null; cwd?: string | null } = {}): LaunchSpec {
    const cfg = readAgenticosJson(this.plugin.claudeConfigDir());
    const bin = this.choices().find((c) => c.host === host)?.bin ?? null;
    const model = modelArg(host, sanitizeSessionChoice(this.plugin.settings.sessionChoice).models[host]);
    const access = sanitizeTerminalChoice(this.plugin.settings.terminalChoice).access as TermAccess;
    // The folder each host uses, set on the line only when a new terminal would find another (AgentTeamsTab.hostEnv).
    const envCodex = path.resolve(env.get("CODEX_HOME") || path.join(this.home(), ".codex"));
    const prefix = host === "claude"
      ? envPrefix("CLAUDE_CONFIG_DIR", this.plugin.claudeConfigDir(), envClaudeConfigDir())
      : envPrefix("CODEX_HOME", cfg?.hosts?.codex?.home || envCodex, envCodex);
    return { host, bin, model, access, resume: opts.resume ?? null, gitInit: opts.gitInit, sessionId: opts.sessionId ?? null, cwd: opts.cwd ?? null, envPrefix: prefix };
  }

  /** What the menu previews for a launch of `host`: the short command, or a shell's note. */
  preview(host: TermHost, opts: { resume?: "last" | null; gitInit?: boolean } = {}): string {
    if (host === "shell") return opts.gitInit ? "git init -q (then your shell)" : "a new shell: nothing is typed";
    // A remembered model that starts with "-" is refused by launchArgs: the menu says so instead of failing to draw.
    try { return previewLine(this.spec(host, { ...opts, sessionId: host === "claude" && !opts.resume ? "new-id" : null })); }
    catch (e) { return e instanceof Error ? e.message : String(e); }
  }

  // ── folders ──

  /** Whether a new workspace (or Scratch) gets its own git repo by default (T7). */
  gitDefault(slug: string): boolean {
    const vault = this.vault();
    let gitignore: string | null = null;
    try { gitignore = fs.readFileSync(path.join(vault, ".gitignore"), "utf8"); } catch { /* none */ }
    return gitInitWanted(fs.existsSync(path.join(vault, ".git")), gitignore, slug);
  }

  /** Makes workspaces/<slug> with its stubs (or adds the missing ones). Throws when file writes are off. */
  private ensureFolder(slug: string, stubs: Record<string, string>): { dir: string; created: boolean } {
    const dir = path.join(this.workspacesDir(), slug);
    const created = !fs.existsSync(dir);
    if (created) fs.mkdirSync(dir, { recursive: true });
    for (const w of stubWrites(stubs, (n) => fs.existsSync(path.join(dir, n)), (n) => fs.readFileSync(path.join(dir, n), "utf8"))) {
      fs.writeFileSync(path.join(dir, w.name), w.data);
    }
    if (created) this.refreshSpaces();
    return { dir, created };
  }

  /** Scratch, made on first use; whether its first agent should start a repo there. */
  private ensureScratch(): { gitInit: boolean } {
    const { dir } = this.ensureFolder(SCRATCH, scratchStubs());
    return { gitInit: !fs.existsSync(path.join(dir, ".git")) && this.gitDefault(SCRATCH) };
  }

  /** Spaces lists workspaces from the snapshot: rebuild it so a new one appears there (Sessions reads the disk). */
  private refreshSpaces(): void {
    this.plugin.runBrainScript("brain/scripts/scan-vault.js", ["--quiet"], undefined, { quiet: true });
  }

  /** Why `name` cannot be a new workspace, or null; an existing one is not a problem (the sheet offers to open it). */
  nameProblem(name: string): string | null { return workspaceNameProblem(name); }
  exists(name: string): boolean { const s = slugify(name); return !!s && fs.existsSync(path.join(this.workspacesDir(), s)); }

  // ── launching ──

  /** Starts a terminal: makes Scratch when it lands there, types the agent's line, selects it and shows Term. */
  async launch(req: LaunchRequest): Promise<Launched> {
    let { place, why } = this.resolve(req.host, req.picked, req.context);
    let gitInit = !!req.gitInit;
    let aside: string | null = null;
    if (place.kind === "scratch" && req.host !== "shell") {
      try { gitInit = this.ensureScratch().gitInit || gitInit; }
      catch {
        // File writes are off and Scratch was never made: start in the vault instead, and say so (spec §5 degradation).
        if (!fs.existsSync(place.dir)) { place = vaultPlace(this.world()); why = "default"; aside = "Scratch needs file writes"; }
      }
    }
    const session = this.start(req.host, place, { resume: req.resume ?? null, gitInit, origin: req.origin ?? null });
    if (!req.origin) {
      this.plugin.settings.terminalChoice = rememberTerminalChoice(this.plugin.settings.terminalChoice, { host: req.host, workspace: place.workspace ?? null });
      void this.plugin.saveSettings();
    }
    this.announce(session, place, why, req.host, aside);
    return { session, place, why };
  }

  /**
   * Makes a new workspace and starts `host` there in the same step (T6). Throws on a bad name. While the Spaces surface
   * is on, `aos workspace new <slug> [--git] --json` makes it (spaces-redesign D28) and the slug it answers is checked
   * against KEBAB again before a terminal opens in it; a refused spawn (the surface is off) or a runtime that predates the
   * verb takes today's path. A workspace that exists already (the sheet's "Open <name>") is opened, never made again:
   * `new` would refuse it.
   */
  async createAndLaunch(name: string, host: TermHost, gitInit: boolean): Promise<Launched> {
    const problem = workspaceNameProblem(name);
    const slug = slugify(name);
    if (problem || !slug) throw new Error(problem ?? "Use a letter or digit");
    if (!this.exists(slug)) {
      if (!KEBAB_RE.test(slug)) throw new Error("Use at most 64 letters, digits and dashes");
      const made = await this.verb<{ slug?: unknown; name?: unknown }>(workspaceArgs.new(slug, { git: gitInit }));
      if (made.ok) {
        const got = String(made.json.slug ?? made.json.name ?? slug);
        if (!KEBAB_RE.test(got)) throw new Error(`aos workspace new answered a name Spaces will not use: ${JSON.stringify(got.slice(0, 60))}`);
        this.refreshSpaces();
        // `--git` made the repository; the typed `[ -e .git ] || git init -q` is then a no-op, and covers a runtime that
        // leaves it to the terminal.
        return this.launch({ host, picked: workspacePlace(got, this.world()), gitInit });
      }
      if (!made.refused && !made.outdated) throw new Error(made.reason);
      // Today's path makes the folder itself, so it keeps the runtime's rule: an archived workspace holds its name.
      if (fs.existsSync(path.join(this.workspacesDir(), "_archive", slug))) {
        throw new Error(`"${slug}" is held by an archived workspace (workspaces/_archive/${slug}): restore it, or pick another name`);
      }
    }
    try {
      this.ensureFolder(slug, workspaceStubs(slug));
    } catch (e) {
      // File writes are off (AOS_APP_WRITE): let the CLI make it, in a shell the user can see.
      const s = this.start("shell", vaultPlace(this.world()), { resume: null, gitInit: false, origin: "New workspace" });
      s.write(` aos workspace new ${shq(name)}\r`);
      this.announce(s, vaultPlace(this.world()), "picked", "shell");
      throw new Error(`File writes are off, so the workspace is being made with aos workspace new in a shell (${e instanceof Error ? e.message : String(e)})`);
    }
    return this.launch({ host, picked: workspacePlace(slug, this.world()), gitInit });
  }

  /**
   * Writes `repo:` into a workspace's workspace.md (T8): a path typed by the user, `~/…` or absolute; empty unlinks it.
   * Through `aos workspace set` while the Spaces surface is on (the runtime checks the folder again: it exists, outside
   * the vault and every host's config folder; spaces-redesign D24, §6), else today's write.
   */
  async linkRepo(workspace: string, typed: string | null): Promise<string | null> {
    const home = this.home();
    let abs: string | null = null;
    if (typed !== null && typed.trim()) {
      abs = parseRepoLink(withRepoLink(null, typed.trim()), home, this.vault());
      if (!abs) throw new Error("Give a folder outside the vault, as ~/… or a full path");
    }
    if (WS_RE.test(workspace)) {
      const r = await this.setManifest(workspace, { repo: abs ? repoValue(abs, home) : "" });
      if (r.ok) return abs;
      if (!r.refused && !r.outdated) throw new Error(r.reason);
    }
    const file = path.join(this.workspacesDir(), workspace, "workspace.md");
    let text: string | null = null;
    try { text = fs.readFileSync(file, "utf8"); } catch { /* none yet */ }
    if (!abs) { if (text !== null) fs.writeFileSync(file, withRepoLink(text, null)); return null; }
    fs.writeFileSync(file, withRepoLink(text, repoValue(abs, home)));
    return abs;
  }

  // ── the runtime's workspace verbs (spaces-redesign D28, D29) ──

  /**
   * Runs one of the page's `aos workspace` verbs (spacesModel.workspaceArgs) and reads its answer: runAosJson, so the
   * spawn goes through proc:spawn and the spaces surface's argument rules; no new IPC (spec §6).
   */
  async verb<T = Record<string, unknown>>(args: string[], timeoutMs?: number): Promise<VerbResult<T>> {
    try {
      return verbResult<T>(await this.plugin.aosJson<T>(args, timeoutMs));
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e), refused: false, outdated: false, stale: false };
    }
  }

  /** workspace.md's hash as `aos workspace set --expect` compares it: the sha256 of its bytes, or "none" without one. */
  async manifestHash(workspace: string): Promise<string> {
    const file = path.join(this.workspacesDir(), workspace, "workspace.md");
    if (!fs.existsSync(file)) return "none";
    // The runtime refuses a workspace.md over 256 KB; one byte more is enough to hash a file it would refuse.
    return sha256Hex(fs.readBytesSync(file, 0, 256 * 1024 + 1));
  }

  /**
   * Sets workspace.md keys (D18): compare-and-set on the file as it is now, so a change made meanwhile is never lost. A
   * miss here (Pin, Status, Link: no draft to redo) is a write that landed between the read and the set, so the hash is
   * read once more and the set tried again; a second miss says so in words that fit outside the Draft dialog.
   */
  async setManifest(workspace: string, fields: ManifestFields): Promise<VerbResult<Record<string, unknown>>> {
    for (let attempt = 0; ; attempt++) {
      let args: string[];
      try { args = workspaceArgs.set(workspace, fields, await this.manifestHash(workspace)); }
      catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e), refused: false, outdated: false, stale: false }; }
      const r = await this.verb(args);
      if (r.ok || !r.stale) return r;
      if (attempt) return { ...r, reason: "workspace.md changed meanwhile: try again" };
    }
  }

  /** The terminal itself: a fresh shell in the place, with the agent's line typed when it is an agent. Throws before any
   *  terminal opens when the line would carry a value that starts with `-` (launchArgs). */
  private start(host: TermHost, place: Place, o: { resume: "last" | { id: string } | null; gitInit: boolean; origin: string | null }): TerminalSession {
    const pool = this.plugin.terminalPool;
    const shell = this.plugin.settings.terminalShell || pool.defaults.shell;
    // The deck names a new Claude Code conversation; a resume by id names the thread on either host. Either way the
    // terminal keeps the id, so its end bar resumes this conversation and not the folder's latest (spaces-redesign D7).
    const ids = launchIds(host, o.resume, newId);
    const sessionId = ids.known;
    const spec = host === "shell" ? null : this.spec(host, { resume: o.resume, gitInit: o.gitInit, sessionId: ids.fresh, cwd: place.dir });
    const line = spec ? launchLine(spec) : null;
    const session = pool.create({
      shell, cwd: place.dir,
      meta: { host, place, origin: o.origin, label: null, model: spec?.model ?? null, access: spec?.access ?? null, sessionId, startedAt: Date.now() },
    });
    if (line) session.write(`${line}\r`);
    else if (o.gitInit) session.write(" [ -e .git ] || git init -q\r");
    pool.select(session.id);
    return session;
  }

  private announce(session: TerminalSession, place: Place, why: PlaceWhy, host: TermHost, aside: string | null = null): void {
    const note: LaunchNote = { id: session.id, text: `Started ${TERM_HOST_LABEL[host]} in ${place.label}${aside ? ` (${aside})` : ""}`, why, host };
    this.plugin.terminalPool.lastLaunch = { ...note, at: Date.now() };
    this.plugin.terminalPool.trigger("session-launched", note);
  }
}

/** The sha256 of `bytes` as lowercase hex (Web Crypto: the page's and Node's). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new conversation id: the deck names Claude Code's so Resume can find it again. */
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}
