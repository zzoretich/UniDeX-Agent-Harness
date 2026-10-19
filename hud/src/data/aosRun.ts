// aosRun.ts — run the vendored `aos` CLI and WAIT for it (spec 2026-09-24-settings-tab D3). Plugin.runBrainScript is
// fire-and-forget (detached, stdio ignored): right for a "sync now" whose file event re-renders a tab, wrong for a
// settings write, which must show the CLI's own verdict ("must be more than 0") beside the field. This one captures
// stdout, stderr and the exit code, pins AOS_VAULT/AOS_CONFIG like RoutinesTab.spawnEnv, and kills a child that hangs.
// Pure over an injectable spawn so node:test drives it with a fixture script.
import * as path from "path";
import { spawn as hostSpawn, type HostChild, type SpawnFn } from "../host";

/** The vendored CLI, relative to the vault (`aos upgrade` copies cli/ into brain/scripts/cli/). */
export const AOS_CLI = "brain/scripts/cli/aos.js";

export interface AosRunOptions {
  node: string;             // Plugin.nodeBin()
  vault: string;            // Plugin.vaultRoot(): AOS_VAULT, the cwd, and where the vendored CLI lives
  configDir: string;        // Plugin.claudeConfigDir(): AOS_CONFIG is <configDir>/agenticos.json
  timeoutMs?: number;       // default 60 s; the child is killed after it
  cli?: string;             // the CLI path, when not the vendored one (tests)
  env?: Record<string, string>;  // variables set on top of the host's environment (AgentTeamsTab: CLAUDE_CONFIG_DIR)
  onStdout?: (chunk: string) => void;  // each chunk of stdout as it arrives (the importer's progress, data/importer.ts)
}

export interface AosResult { code: number; stdout: string; stderr: string; timedOut: boolean; error?: string }
export interface AosJsonResult<T> extends AosResult { json: T | null; parseError?: string }

export type { SpawnFn };

/** What the child gets on top of the host's environment: `o.env`, then the two pins. */
export function aosEnv(o: AosRunOptions): Record<string, string> {
  return { ...(o.env ?? {}), AOS_VAULT: o.vault, AOS_CONFIG: path.join(o.configDir, "agenticos.json") };
}

export function runAos(args: string[], o: AosRunOptions, spawnFn: SpawnFn = hostSpawn): Promise<AosResult> {
  return new Promise((resolve) => {
    const cli = o.cli ?? path.join(o.vault, AOS_CLI);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: AosResult) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(r);
    };
    let child: HostChild;
    try {
      child = spawnFn(o.node, [cli, ...args], { cwd: o.vault, env: aosEnv(o) });
    } catch (e) {
      finish({ code: -1, stdout, stderr, timedOut, error: (e as Error).message });
      return;
    }
    timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, o.timeoutMs ?? 60_000);
    child.stdout?.on("data", (d) => { const s = String(d); stdout += s; o.onStdout?.(s); });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => finish({ code: -1, stdout, stderr, timedOut, error: e.message }));
    child.on("close", (code) => finish({ code: timedOut ? -1 : (code ?? -1), stdout, stderr, timedOut }));
  });
}

/** runAos plus the parsed stdout on exit 0; `json` is null on a failure or an unparseable body (parseError says why). */
export async function runAosJson<T>(args: string[], o: AosRunOptions, spawnFn?: SpawnFn): Promise<AosJsonResult<T>> {
  const r = await runAos(args, o, spawnFn);
  if (r.code !== 0) return { ...r, json: null };
  try { return { ...r, json: JSON.parse(r.stdout) as T }; } catch (e) { return { ...r, json: null, parseError: (e as Error).message }; }
}

/** The one line to show for a failed run: the CLI's own `aos: …` / `aos config: …` message, else why it did not run. */
export function failureText(r: AosResult): string {
  if (r.timedOut) return "aos did not answer in time";
  if (r.error) return `could not run aos: ${r.error}`;
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const own = lines.find((l) => /^aos( config)?: /.test(l));
  return (own ?? lines[0] ?? `aos exited ${r.code}`).replace(/^aos( config)?: /, "");
}

/**
 * Why `aos config list --json` gave the tab no list, and whether `aos upgrade` is the fix. Only a runtime without the
 * verb (or without the CLI) is an upgrade; output that does not parse or has the wrong shape says so as it is — it
 * once hid a 64 KB pipe truncation behind "run aos upgrade".
 */
export function listFailure(r: AosJsonResult<unknown>, parsed: boolean): { text: string; upgrade: boolean } | null {
  if (parsed) return null;
  if (r.code !== 0) return { text: failureText(r), upgrade: needsUpgrade(r) };
  if (r.parseError) return { text: `aos config list sent output that does not parse (${r.parseError})`, upgrade: false };
  return { text: "aos config list answered in an unexpected shape", upgrade: false };
}

/** D13: the vendored runtime predates `aos config` (or is missing), so the tab asks for `aos upgrade`. */
export function needsUpgrade(r: AosResult): boolean {
  return /unknown command: config|unknown script config|Cannot find module/.test(r.stderr);
}
