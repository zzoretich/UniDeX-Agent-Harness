// The one line `aos init` asks a Claude Code user to add to their CLAUDE.md, `@<vault>/AGENTICOS.md` (the installer never
// edits that file itself). The wizard shows it as a diff against the file and appends it only when the user says so
// (phase 5, I4). Main computes the file and the line from agenticos.json; the page sends neither.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClaudeMdPreview } from "../../shared/ipc";

/** How many of the file's last lines the diff shows above the added one. */
const CONTEXT = 3;

export function claudeMdLine(vault: string): string { return `@${path.join(vault, "AGENTICOS.md")}`; }

/** The CLAUDE.md in the Claude Code config folder agenticos.json records, else $CLAUDE_CONFIG_DIR's, else ~/.claude's. */
export function claudeMdPath(o: { configDir?: string | null; env: NodeJS.ProcessEnv; home: string }): string {
  const dir = o.configDir && path.isAbsolute(o.configDir) ? o.configDir
    : o.env.CLAUDE_CONFIG_DIR && path.isAbsolute(o.env.CLAUDE_CONFIG_DIR) ? o.env.CLAUDE_CONFIG_DIR : path.join(o.home, ".claude");
  return path.join(dir, "CLAUDE.md");
}

/** Whether a line already imports this vault's AGENTICOS.md (`@~/…` counts, as Claude Code expands it). */
function imports(text: string, vault: string, home: string): boolean {
  const want = path.resolve(vault, "AGENTICOS.md");
  return text.split("\n").some((l) => {
    const m = /^\s*@(\S+AGENTICOS\.md)\s*$/.exec(l);
    if (!m) return false;
    const p = m[1].startsWith("~/") ? path.join(home, m[1].slice(2)) : m[1];
    return path.isAbsolute(p) && path.resolve(p) === want;
  });
}

/** The file's text: "" only when there is none; any other read failure throws, so the file is never replaced blind. */
function readExisting(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw new Error(`${file} could not be read (${code ?? (err instanceof Error ? err.message : String(err))}), so nothing was written`);
  }
}

export function previewClaudeMd(file: string, vault: string, home: string = os.homedir()): ClaudeMdPreview {
  const line = claudeMdLine(vault);
  const text = readExisting(file);
  const present = imports(text, vault, home);
  const lines = text.replace(/\n$/, "").split("\n");
  const context = text ? lines.slice(-CONTEXT) : [];
  return {
    path: file, line, present,
    diff: [...context.map((t) => ({ kind: "context" as const, text: t })), ...(present ? [] : [{ kind: "add" as const, text: line }])],
  };
}

/** Appends the line (on a line of its own) unless it is there. Atomic: a temp file beside it, then a rename. */
export function applyClaudeMd(file: string, vault: string, home: string = os.homedir()): ClaudeMdPreview {
  const before = previewClaudeMd(file, vault, home);
  if (before.present) return before;
  const text = readExisting(file);
  const next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${before.line}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A symlinked CLAUDE.md (dotfiles repos do this) is written through, not replaced by a plain file.
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, next, { mode: fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644 });
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
  return previewClaudeMd(file, vault, home);
}
