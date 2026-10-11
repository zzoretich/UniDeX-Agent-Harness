import { App, normalizePath } from "obsidian";
import { appendUnderHeading } from "./mdSections";

export type MemoryType = "user" | "feedback" | "projects" | "reference";

const TYPE_HEADING: Record<MemoryType, string> = {
  user: "User",
  feedback: "Feedback",
  projects: "Project",
  reference: "Reference",
};

export interface MemoryDraft {
  type: MemoryType;
  slug?: string;
  title?: string;
  description: string;
  body: string;
}

export interface PromoteSource {
  text: string;
  lineNumber: number;
}

export interface WriteResult {
  memoryPath: string;
  indexUpdated: boolean;
  sessionUpdated: boolean;
}

export function slugify(text: string, maxWords = 6): string {
  return text
    .toLowerCase()
    .replace(/[`*_~#>\[\]\(\)]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, maxWords)
    .join("-")
    .slice(0, 80) || "untitled";
}

export function deriveTitle(text: string, maxChars = 60): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) return single;
  return single.slice(0, maxChars).trimEnd();
}

export function deriveDescription(text: string, maxChars = 90): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) return single;
  return single.slice(0, maxChars).trimEnd();
}

export async function writeMemory(
  app: App,
  draft: MemoryDraft,
  promoteSource?: PromoteSource
): Promise<WriteResult> {
  const slug = draft.slug || slugify(draft.title || draft.description || "memory");
  const folder = `brain/memory/${draft.type}`;
  const memoryPath = normalizePath(`${folder}/${slug}.md`);
  await ensureFolder(app, folder);

  if (await app.vault.adapter.exists(memoryPath)) {
    throw new Error(`Memory already exists: ${memoryPath}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const title = draft.title || deriveTitle(draft.description);
  const fm = [
    "---",
    "type: memory",
    `tags: [memory/${draft.type}, status/active]`,
    `created: ${today}`,
    `updated: ${today}`,
    "---",
    "",
    `# ${title}`,
    "",
    draft.body.trim(),
    "",
  ].join("\n");

  await app.vault.create(memoryPath, fm);

  const indexUpdated = await appendToMemoryIndex(app, draft.type, title, memoryPath, draft.description);

  let sessionUpdated = false;
  if (promoteSource) {
    sessionUpdated = await removeSessionLine(app, promoteSource.lineNumber);
  }

  return { memoryPath, indexUpdated, sessionUpdated };
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (!(await app.vault.adapter.exists(folder))) {
    await app.vault.createFolder(folder);
  }
}

async function appendToMemoryIndex(
  app: App,
  type: MemoryType,
  title: string,
  memoryPath: string,
  description: string
): Promise<boolean> {
  const indexPath = "MEMORY.md";
  if (!(await app.vault.adapter.exists(indexPath))) {
    console.warn("[agentic-os] MEMORY.md not found — skipping index update");
    return false;
  }
  const raw = await app.vault.adapter.read(indexPath);
  // Prefix match, first heading wins; IDENTICAL rule in memory-index.js — behavioral parity between the two writers
  // is a standing P4 contract (the rule and its tests live in mdSections.ts).
  const entry = `- [${title}](${memoryPath}) — ${description}`;
  await app.vault.adapter.write(indexPath, appendUnderHeading(raw, `## ${TYPE_HEADING[type]}`, entry));
  return true;
}

async function removeSessionLine(app: App, lineNumber: number): Promise<boolean> {
  const sessionPath = "brain/_index/SESSION.md";
  if (!(await app.vault.adapter.exists(sessionPath))) return false;
  const raw = await app.vault.adapter.read(sessionPath);
  const lines = raw.split("\n");
  const idx = lineNumber - 1;
  if (idx < 0 || idx >= lines.length) return false;
  lines.splice(idx, 1);
  await app.vault.adapter.write(sessionPath, lines.join("\n"));
  return true;
}
