// Memory-file lister for brain/memory/<type>/*.md. Pure parsing core;
// only listMemories touches Obsidian, via its param.
import type { App } from "obsidian";

export const MEMORY_ROOT = "brain/memory";
export type MemoryType = "user" | "feedback" | "projects" | "reference";

export interface MemoryMeta {
  path: string;        // vault-relative
  slug: string;        // filename sans .md
  type: MemoryType | string;
  title: string;
  created: string | null;
  updated: string | null;
  reviewed: boolean | null;  // from `reviewed:` frontmatter when present (P4 auto-writes)
  // spaces-redesign D27; parseMemoryMeta always sets both (optional so hand-built metas elsewhere stay valid):
  workspace?: string | null; // frontmatter `workspace:`: a workspace name, `workspaces/<name>` read as <name>
  mentions?: string[];       // the workspace names the body mentions as `workspaces/<name>/`, each once, in order
}

/** At most this many body mentions are kept per note; a note listing more is not about one workspace. */
export const MAX_MENTIONS = 32;
/**
 * `workspaces/<name>/` in a note's body (spaces-redesign D27): the folder segment up to the next `/`, on one line, not
 * glued to a longer word before it (`my-workspaces/x/` is not a mention). Names may hold spaces, as folders do.
 */
const MENTION_RE = /(?:^|[^\w.-])workspaces\/([^/\n\r]{1,128}?)\//g;

/** The workspace names a body mentions as `workspaces/<name>/`: trimmed, `.`/`..`/`_…` folders left out, each once. */
export function workspaceMentions(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const name = m[1].trim();
    if (!name || name === "." || name === ".." || name.startsWith("_") || out.includes(name)) continue;
    out.push(name);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

/** A frontmatter `workspace:` value as a name: quotes, a `[[link]]` and a leading `workspaces/` stripped; null when empty. */
export function workspaceKey(raw: string | null): string | null {
  if (raw === null) return null;
  let v = raw.trim();
  const q = /^(["'])(.*)\1$/.exec(v);
  if (q) v = q[2].trim();
  const link = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(v);
  if (link) v = link[1].trim();
  v = v.replace(/^workspaces\//, "").replace(/\/+$/, "").trim();
  return v || null;
}

export function parseMemoryMeta(path: string, raw: string): MemoryMeta {
  const parts = path.split("/");
  const slug = (parts[parts.length - 1] ?? "").replace(/\.md$/, "");
  const type = parts.length >= 3 ? parts[parts.length - 2] : "unknown";
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const grab = (key: string): string | null => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const h1 = raw.match(/^#\s+(.+)$/m);
  const reviewedRaw = grab("reviewed");
  const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
  return {
    path, slug, type,
    title: h1 ? h1[1].trim() : slug,
    created: grab("created"),
    updated: grab("updated"),
    reviewed: reviewedRaw === null ? null : reviewedRaw === "true",
    // One line only: an empty `workspace:` must not read the next key's line as its value.
    workspace: workspaceKey(fm.match(/^workspace:[ \t]*(.*)$/m)?.[1] ?? null),
    mentions: workspaceMentions(body),
  };
}

export function filterMemories(list: MemoryMeta[], query: string, type: string | null): MemoryMeta[] {
  const q = query.trim().toLowerCase();
  return list.filter((m) =>
    (type === null || m.type === type) &&
    (!q || m.title.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q))
  );
}

// ── IO ──
export async function listMemories(app: App): Promise<MemoryMeta[]> {
  const out: MemoryMeta[] = [];
  const adapter = app.vault.adapter;
  let types: string[] = [];
  try { types = (await adapter.list(MEMORY_ROOT)).folders.map((f) => f.split("/").pop()!); } catch { return out; }
  for (const t of types) {
    let files: string[] = [];
    try { files = (await adapter.list(`${MEMORY_ROOT}/${t}`)).files.filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) {
      try { out.push(parseMemoryMeta(f, await adapter.read(f))); } catch { /* unreadable file — skip */ }
    }
  }
  return out.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
}
