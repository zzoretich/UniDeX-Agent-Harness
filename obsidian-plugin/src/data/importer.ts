// importer.ts — the HUD's import service (install-import B4, B7, B9, B12): what `aos import` would bring from this Mac
// (its dry run: counts per host and kind, and the proposed workspaces), a run of the fast phase with its progress (the
// sessions are queued for the import-digest routine), and what import-state.json says since. Settings ▸ Import uses it,
// and so does the launch sequence's Import sheet (ui/ImportSheet.ts, B12), through `aos migrate import`. Every run goes
// through the vendored CLI (data/aosRun.ts), so a write surface (app/src/shared/surfaces.ts: `import`, or `migrate` for
// the sheet) admits or refuses it; the runtime does the work and the writes. The shapes and the argv are importModel.ts's.
import * as path from "path";
import { fs } from "../host";
import { failureText, runAos, type AosResult } from "./aosRun";
import {
  IMPORT_KINDS, IMPORT_STATE_PATH, MIGRATE_IMPORT_REQUEST, ProgressFollower, digestPending, importArgs, importSteps, migrateImportArgs,
  parseImportState, parseScan,
  type DigestState, type ImportHost, type ImportProgress, type ImportRequest, type ImportScan, type ImportSince, type ImportState,
} from "./importModel";

export interface ImporterDeps {
  /** Runs `aos <args>` and waits for it, streaming its stdout (data/aosRun.ts runAos with the vault's pins). */
  run(args: string[], o: { timeoutMs: number; onStdout?: (chunk: string) => void }): Promise<AosResult>;
  /** A vault-relative file's text; null when it is not there. */
  read(rel: string): string | null;
}

export type ScanResult = { ok: true; scan: ImportScan } | { ok: false; error: string };
export interface RunResult {
  ok: boolean;
  /** Why it failed: the CLI's own line, a refused surface, or a run already going. */
  error: string | null;
  /** What it printed, line by line. */
  lines: string[];
  /** import-state.json once it ended. */
  state: ImportState;
}

/** The dry run reads every host's folders and session index: a minute or two on a long history. */
export const SCAN_MS = 3 * 60_000;
/** The fast phase types each rule on the local model when it is ready: give it time. */
export const RUN_MS = 30 * 60_000;

/** One import at a time in this app, whichever panel started it (the runtime's lock keeps the state file whole anyway). */
let running: Promise<RunResult> | null = null;

export class Importer {
  constructor(private readonly d: ImporterDeps) {}

  /** An import started from any panel is still running. */
  get busy(): boolean { return running !== null; }

  /** `aos import --dry-run --json`: what an import would bring, per host and kind, and the proposed workspaces. Writes nothing. */
  async scan(o: { from?: ImportHost[]; since?: ImportSince } = {}): Promise<ScanResult> {
    const args = importArgs({ from: o.from ?? ["claude", "codex"], only: [...IMPORT_KINDS], since: o.since }, { dryRun: true, json: true });
    const r = await this.d.run(args, { timeoutMs: SCAN_MS });
    if (r.code !== 0) return { ok: false, error: failureText(r) };
    let j: unknown;
    try { j = JSON.parse(r.stdout); } catch { return { ok: false, error: "aos import sent output that does not parse" }; }
    const scan = parseScan(j);
    return scan ? { ok: true, scan } : { ok: false, error: "aos import answered in an unexpected shape" };
  }

  /**
   * `aos import` for the request: the fast phase, step by step through `onProgress`, the sessions queued for the
   * digest and its routine turned on and scheduled, and only the proposals in `accept` created. Refused while another
   * import from this app runs.
   */
  run(req: ImportRequest, onProgress?: (p: ImportProgress) => void): Promise<RunResult> {
    let args: string[];
    try { args = importArgs(req); } catch (e) { return Promise.resolve({ ok: false, error: (e as Error).message, lines: [], state: this.state() }); }
    return this.follow(args, importSteps(req), onProgress);
  }

  /**
   * The Import sheet's Import (install-import B12): `aos migrate import --apply [--accept …]` through the `migrate`
   * surface, which runs the import (every kind, both hosts) with the same progress lines and records the upgrade's
   * `import` migration applied in the same call. Refused while another import from this app runs.
   */
  applyMigration(accept: readonly string[], onProgress?: (p: ImportProgress) => void): Promise<RunResult> {
    let args: string[];
    try { args = migrateImportArgs("apply", accept); } catch (e) { return Promise.resolve({ ok: false, error: (e as Error).message, lines: [], state: this.state() }); }
    return this.follow(args, importSteps(MIGRATE_IMPORT_REQUEST), onProgress);
  }

  /** The Import sheet's Not now: `aos migrate import --decline --json`, which records the choice and imports nothing. */
  async declineMigration(): Promise<{ ok: boolean; error: string | null }> {
    const r = await this.d.run(migrateImportArgs("decline"), { timeoutMs: SCAN_MS });
    return { ok: r.code === 0, error: r.code === 0 ? null : failureText(r) };
  }

  /** Runs one import argv, one at a time in this app, following its step lines. */
  private follow(args: string[], steps: number, onProgress?: (p: ImportProgress) => void): Promise<RunResult> {
    if (running) return Promise.resolve({ ok: false, error: "an import is already running", lines: [], state: this.state() });
    const follow = new ProgressFollower(steps, onProgress);
    const p = this.d.run(args, { timeoutMs: RUN_MS, onStdout: (s) => follow.push(s) }).then((r) => {
      follow.end();
      return { ok: r.code === 0, error: r.code === 0 ? null : failureText(r), lines: follow.lines, state: this.state() };
    }).finally(() => { running = null; });
    running = p;
    return p;
  }

  /** import-state.json as it is now (empty before any import). */
  state(): ImportState { return parseImportState(this.d.read(IMPORT_STATE_PATH)); }

  /** The digest while it has sessions left (Pulse's line), else null. */
  digest(): DigestState | null { return digestPending(this.state()); }
}

/** The Importer over the plugin's vault: the vendored CLI with AOS_VAULT and AOS_CONFIG pinned, files read from the vault. */
export function importerFor(plugin: { nodeBin(): string; vaultRoot(): string; claudeConfigDir(): string }): Importer {
  return new Importer({
    run: (args, o) => runAos(args, { node: plugin.nodeBin(), vault: plugin.vaultRoot(), configDir: plugin.claudeConfigDir(), timeoutMs: o.timeoutMs, onStdout: o.onStdout }),
    read: (rel) => { try { return fs.readFileSync(path.join(plugin.vaultRoot(), rel), "utf8"); } catch { return null; } },
  });
}
