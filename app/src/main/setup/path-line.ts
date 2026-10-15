// Finish's "Add aos to my PATH" (install-import B14). `aos init` links the launcher into ~/.local/bin, where the wizard's
// Claude Code and Codex installs and uv live too, but a new Mac's shell does not look there. The wizard shows the one
// line it would append to the login profile and appends it only when the box is ticked; unticked, the app still runs
// `aos` by its full path. Main computes the file and the line; the page sends neither.

import * as fs from "node:fs";
import * as path from "node:path";
import type { PathLinePreview } from "../../shared/ipc";
import { PATH_LINE } from "../policy/setup";

/** Whether the profile already has the line (ignoring surrounding space), so it is never added twice. */
function hasLine(text: string): boolean {
  return text.split("\n").some((l) => l.trim() === PATH_LINE);
}

/** `file`'s state, and whether the login shell's PATH (`shellPath`, null when unknown) already has ~/.local/bin. */
export function previewPathLine(file: string, home: string, shellPath: string | null): PathLinePreview {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* a new file */ }
  const bin = path.join(home, ".local", "bin");
  const onPath = !!shellPath && shellPath.split(":").some((d) => d && path.resolve(d) === bin);
  return { file, line: PATH_LINE, present: hasLine(text), onPath };
}

/** Appends the line on a line of its own unless it is there; a symlinked profile is written through. Atomic. */
export function applyPathLine(file: string, home: string, shellPath: string | null): PathLinePreview {
  const before = previewPathLine(file, home, shellPath);
  if (before.present) return before;
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { /* a new file */ }
  const next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${PATH_LINE}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, next, { mode: fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o644 });
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
  return previewPathLine(file, home, shellPath);
}
