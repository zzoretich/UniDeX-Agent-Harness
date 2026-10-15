// The write surfaces as the page sees them: which are on (the status bar, the App settings tab) and whether the note
// editor may save a path (its Edit button). Display only: main enforces the same table on every call (S3).

import * as path from "./shims/path";
import { SurfaceRules, type Surface } from "../shared/surfaces";

export class PagePolicy {
  readonly rules: SurfaceRules;

  constructor(private readonly vaultRoot: string | null, enabled: readonly string[]) {
    this.rules = new SurfaceRules(enabled);
  }

  get surfaces(): readonly Surface[] { return this.rules.surfaces; }
  get ids(): string[] { return this.rules.ids; }

  /** The vault-relative path of an absolute one, or null outside the vault. */
  vaultPath(target: unknown): string | null {
    if (typeof target !== "string" || !this.vaultRoot || !path.isAbsolute(target) || target.includes("\0")) return null;
    const rel = path.relative(path.resolve(this.vaultRoot), path.resolve(target));
    return !rel || rel === ".." || rel.startsWith("../") ? null : rel;
  }

  canWrite(target: unknown): boolean { const rel = this.vaultPath(target); return rel !== null && this.rules.canWrite(rel); }
  canSave(target: unknown): boolean { const rel = this.vaultPath(target); return rel !== null && this.rules.canSave(rel); }
  /** Whether an enabled HUD surface (or a background refresh) runs this runtime script with these arguments. */
  canRun(script: string, args: readonly string[]): boolean { return !!this.vaultRoot && this.rules.canRunScript(script, args); }
}
