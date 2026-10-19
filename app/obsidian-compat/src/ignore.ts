// Which vault paths the index and the watchers skip. Shared by the renderer's Vault and the main-process watcher, and
// free of DOM and Electron imports so both can load it.

const IGNORED_DIRS = new Set(["node_modules", "_worktrees"]);

/** Obsidian skips dot-files and dot-folders; we also skip dependency folders and agent worktrees. */
export function isIgnored(rel: string): boolean {
  return rel.split("/").some((seg) => seg.startsWith(".") || IGNORED_DIRS.has(seg));
}

/** A directory entry name the index walk should not descend into or list. */
export function isIgnoredName(name: string): boolean {
  return name.startsWith(".") || IGNORED_DIRS.has(name);
}
