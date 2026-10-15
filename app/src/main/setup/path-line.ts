// Finish's "Add aos to my PATH" (install-import B14). `aos init` links the launcher into ~/.local/bin, where the wizard's
// Claude Code and Codex installs and uv live too, but a new Mac's shell does not look there. The wizard shows the one
// line it would append to the login profile and appends it only when the box is ticked; unticked, the app still runs
// `aos` by its full path. Main computes the file and the line; the page sends neither.

import * as fs from "node:fs";
import * as path from "node:path";
import type { PathLinePreview } from "../../shared/ipc";
import { PATH_LINE } from "../policy/setup";
import { writeKeepingLinks } from "./dotfile";

/** Whether the profile already has the line (ignoring surrounding space), so it is never added twice. */
function hasLine(text: string): boolean {
  return text.split("\n").some((l) => l.trim() === PATH_LINE);
}

/**
 * The profile's text: "" only when there is no such file. Any other failure (no permission, a folder in its place)
 * throws, so a profile that cannot be read is never replaced by one holding only the new line.
 */
export function readProfile(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw new Error(`${file} could not be read (${code ?? (err instanceof Error ? err.message : String(err))}), so nothing was written`);
  }
}

/** `file`'s state, and whether the login shell's PATH (`shellPath`, null when unknown) already has ~/.local/bin. */
export function previewPathLine(file: string, home: string, shellPath: string | null): PathLinePreview {
  const text = readProfile(file);
  const bin = path.join(home, ".local", "bin");
  const onPath = !!shellPath && shellPath.split(":").some((d) => d && path.resolve(d) === bin);
  return { file, line: PATH_LINE, present: hasLine(text), onPath };
}

/** Appends the line on a line of its own unless it is there; a linked profile is written through, the link kept (M3). Atomic. */
export function applyPathLine(file: string, home: string, shellPath: string | null): PathLinePreview {
  const before = previewPathLine(file, home, shellPath);
  if (before.present) return before;
  const text = readProfile(file);
  writeKeepingLinks(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${PATH_LINE}\n`);
  return previewPathLine(file, home, shellPath);
}
