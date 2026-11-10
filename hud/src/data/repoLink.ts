// repoLink.ts — a workspace's linked code folder: `repo:` in its workspace.md (spec 2026-10-08-term-agent-deck T8), read,
// written and spelled. Pure, with nothing but path, so main reads a link exactly as the Code page does (spec
// 2026-11-09-code-chat C8: app/src/main/services/code-git.ts). terminalLaunch.ts re-exports it.
import * as path from "path";

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(v: string): string {
  const s = v.trim();
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;
}

/** A `~/…` or absolute path as an absolute one; null for anything relative. */
export function expandHome(p: string, home: string): string | null {
  const s = p.trim();
  if (s === "~") return path.resolve(home);
  if (s.startsWith("~/")) return path.resolve(home, s.slice(2));
  return path.isAbsolute(s) ? path.resolve(s) : null;
}

/** The `repo:` of a workspace.md's frontmatter as an absolute folder, or null: none, relative, or inside the vault. */
export function parseRepoLink(text: string | null, home: string, vault: string): string | null {
  const m = text ? FRONTMATTER.exec(text) : null;
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => /^repo\s*:/.test(l));
  if (!line) return null;
  const abs = expandHome(unquote(line.replace(/^repo\s*:/, "")), home);
  if (!abs || inside(abs, path.resolve(vault))) return null;
  return abs;
}

/** How a linked folder is written: `~/…` when it is under home, so the note reads the same on another Mac. */
export function repoValue(abs: string, home: string): string {
  const rel = path.relative(path.resolve(home), abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : abs;
}

/** workspace.md with its frontmatter's `repo:` set (added or replaced), or removed when `repo` is null; the rest kept. */
export function withRepoLink(text: string | null, repo: string | null): string {
  const src = text ?? "";
  const m = FRONTMATTER.exec(src);
  const value = repo === null ? null : `repo: ${JSON.stringify(repo)}`;
  if (!m) return value ? `---\n${value}\n---\n${src}` : src;
  const lines = m[1].split(/\r?\n/).filter((l) => !/^repo\s*:/.test(l));
  if (value) lines.push(value);
  const body = src.slice(m[0].length);
  return lines.length ? `---\n${lines.join("\n")}\n---\n${body}` : body;
}
