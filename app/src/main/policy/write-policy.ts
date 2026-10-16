// The write policy, enforced in the main process (phase 4, docs/superpowers/plans/2026-10-05-sandbox-renderer.md S3).
// The surface table and its matching live in ../../shared/surfaces.ts; this adds what only main may decide: which
// absolute path is which vault path (the vault as configured and as the disk spells it), and which `node <script>` is
// one of this vault's runtime scripts. Every write and spawn the page asks for over the bridge is checked here.
//
// A path is checked as written, after resolving `.` and `..`, and again where the disk puts it: links followed (a
// dangling one too, which a write would create at its target) and each existing name as the disk spells it. Both must
// pass. A link inside the vault is the user's (the bridge never creates one, so the page cannot add one) and is
// followed as they set it up, into a normal folder or out of the vault, but never into a protected folder. A path the
// disk reads differently from its lexical form (a `..` after a link) is refused. Names compare the way macOS's disk
// compares them (foldPath: any case, any Unicode form), and the vault is known where the disk resolves a path by its
// folder's identity, under any name for it (identity.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACES, SurfaceRules, type Surface } from "../../shared/surfaces";
import { folderId, relUnder } from "./identity";

export { BACKGROUND, SURFACES, SURFACE_IDS, argv, foldPath, globToRegExp, parseSurfaces, type Surface, type SpawnRule } from "../../shared/surfaces";

/** A string, Buffer or file: URL as a path; anything else (a descriptor, a FileHandle) as null. */
export function pathOf(target: unknown): string | null {
  if (typeof target === "string") return target;
  if (target instanceof Uint8Array) return Buffer.from(target).toString();
  const url = target as { href?: unknown; protocol?: unknown } | null;
  if (url && typeof url === "object" && typeof url.href === "string" && url.protocol === "file:") {
    try { return fileURLToPath(url.href); } catch { return null; }
  }
  return null;
}

const NODE = /^node(\.exe)?$/;

/** At most this many links are followed resolving one path; more is a loop. */
const MAX_LINKS = 40;

/**
 * An absolute path as the disk resolves it: every link followed (a dangling one too), a `..` taken after the link
 * before it, and each existing name as the disk spells it. Null when that cannot be told (a link loop).
 */
export function resolveOnDisk(p: string, budget = { links: MAX_LINKS }): string | null {
  try { return fs.realpathSync.native(p); } catch { /* some part is not there (yet) */ }
  const dir = path.dirname(p);
  if (dir === p) return p;
  const name = path.basename(p);
  const base = resolveOnDisk(dir, budget);
  if (base === null) return null;
  if (name === "." || name === "") return base;
  if (name === "..") return path.dirname(base);
  const at = path.join(base, name);
  let target: string;
  try { target = fs.readlinkSync(at); } catch { return at; } // not a link, or not there: the name as asked
  // The link's text as the disk reads it: a `..` in it is taken after any link before it, never lexically.
  return budget.links-- > 0 ? resolveOnDisk(path.isAbsolute(target) ? target : `${base}/${target}`, budget) : null;
}

const hasDots = (p: string): boolean => p.split("/").some((s) => s === "." || s === "..");

export class WritePolicy {
  readonly rules: SurfaceRules;
  private readonly roots: string[];
  private readonly root: string | null;

  constructor(vaultRoot: string | null, enabled: readonly string[] = [], table: readonly Surface[] = SURFACES) {
    this.rules = new SurfaceRules(enabled, table);
    // The vault as configured and as the disk spells it (a symlinked home, /tmp → /private/tmp, another case).
    const roots = new Set<string>();
    this.root = vaultRoot && path.isAbsolute(vaultRoot) ? path.resolve(vaultRoot) : null;
    if (vaultRoot && path.isAbsolute(vaultRoot)) {
      roots.add(path.resolve(vaultRoot));
      try { roots.add(fs.realpathSync(vaultRoot)); } catch { /* not there yet */ }
      try { roots.add(fs.realpathSync.native(vaultRoot)); } catch { /* not there yet */ }
    }
    this.roots = [...roots];
  }

  /** The enabled surfaces, in table order. */
  get surfaces(): readonly Surface[] { return this.rules.surfaces; }
  get ids(): string[] { return this.rules.ids; }

  /** The path inside the vault, `/`-separated, or null when it is not strictly inside it. Lexical: see locate. */
  vaultPath(target: unknown): string | null {
    const p = pathOf(target);
    if (!p || p.includes("\0") || !path.isAbsolute(p)) return null;
    const rel = this.relIn(path.resolve(p));
    return rel ? rel : null;
  }

  /**
   * An absolute, resolved path relative to the vault (`""` for the vault itself), or null outside it. By its spelling;
   * with `anyName`, also by the vault folder's identity, for a place the disk resolved: the vault under another name for
   * its folder (macOS's /System/Volumes/Data firmlink, or any other) is still the vault.
   */
  private relIn(abs: string, anyName = false): string | null {
    for (const root of this.roots) {
      const rel = path.relative(root, abs);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
      return rel.split(path.sep).join("/");
    }
    if (!anyName || !this.root) return null;
    // Taken at each check, so a vault folder removed and made again (a restore, a re-clone) is known by its new identity.
    const id = folderId(this.root);
    return id ? relUnder([id], abs) : null;
  }

  /**
   * The path as asked for (`rel`) and where the disk puts it (`real`): the target with every link followed, which a
   * write reaches, and the entry itself in its resolved folder, which a rename or the Trash moves. A place outside the
   * vault is left out (the user's link out of it). Null, refusing it, when the path is outside the vault, when the disk
   * puts it at the vault itself or cannot be told where (a link loop), or when a `..` after a link makes the disk read
   * it differently from the lexical path.
   */
  private locate(target: unknown): { rel: string; real: string[] } | null {
    const rel = this.vaultPath(target);
    if (rel === null) return null;
    const raw = pathOf(target) as string;
    const abs = path.resolve(raw);
    const full = resolveOnDisk(abs);
    const folder = resolveOnDisk(path.dirname(abs));
    if (full === null || folder === null) return null;
    if (hasDots(raw) && resolveOnDisk(raw) !== full) return null;
    const real: string[] = [];
    for (const place of [full, path.join(folder, path.basename(abs))]) {
      const r = this.relIn(place, true);
      if (r === "") return null;
      if (r !== null && !real.includes(r)) real.push(r);
    }
    return { rel, real };
  }

  /** Whether an enabled HUD surface may create, change or remove this absolute path. */
  canWrite(target: unknown): boolean {
    const at = this.locate(target);
    return at !== null && this.rules.canWrite(at.rel, at.real);
  }

  /** Whether this folder may be created: a HUD surface may write it, or a file it may write could live in it. */
  canMakeFolder(target: unknown): boolean {
    const at = this.locate(target);
    return at !== null && this.rules.canMakeFolder(at.rel, at.real);
  }

  /** Whether the app's note editor may save this absolute path (an enabled editor surface, Notes). */
  canSave(target: unknown): boolean {
    const at = this.locate(target);
    return at !== null && this.rules.canSave(at.rel, at.real);
  }

  /** Whether this absolute path may be moved or trashed with everything under it (SurfaceRules.canMoveTree). */
  canMoveTree(target: unknown): boolean {
    const at = this.locate(target);
    return at !== null && this.rules.canMoveTree(at.rel, at.real);
  }

  /**
   * Whether `cmd args…`, run without a shell from `cwd`, is a background refresh or a command an enabled surface runs.
   * A relative script path counts only with a cwd to resolve it against, as node would. Which program `cmd` names is
   * policy/programs.ts's question, not this one's.
   */
  canSpawn(cmd: unknown, args: readonly unknown[] = [], cwd?: unknown): boolean {
    if (typeof cmd !== "string" || !cmd) return false;
    const list = args.map(String);
    const name = path.basename(cmd);
    if (NODE.test(name)) {
      const script = this.scriptOf(list[0], cwd);
      return !!script && this.rules.canRunScript(script, list.slice(1));
    }
    return this.rules.canRunProgram(name, list);
  }

  /** A path to one of this vault's runtime scripts → its name relative to brain/scripts. */
  private scriptOf(arg: string | undefined, cwd: unknown): string | null {
    if (!arg || arg.startsWith("-")) return null;
    const abs = path.isAbsolute(arg) ? arg : typeof cwd === "string" && path.isAbsolute(cwd) ? path.resolve(cwd, arg) : null;
    const rel = abs && this.vaultPath(abs);
    return rel && rel.startsWith("brain/scripts/") ? rel.slice("brain/scripts/".length) : null;
  }
}
