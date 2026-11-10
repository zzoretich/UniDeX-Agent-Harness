// termComposer.ts — the Term composer (spec 2026-10-08-term-agent-deck T12). Pure: what a message becomes on the wire
// (one bracketed paste, then Enter), with the paths of its images after the text (code-chat C7), which images it takes,
// the @file token under the caret and the files that match it, and the saved snippets. ui/TermComposer.ts draws it.

/** One pty write is capped at 1 MiB: a long message goes in pieces well under that. */
export const COMPOSER_CHUNK = 64 * 1024;

/**
 * The writes that send `text` to an agent's prompt: a bracketed paste (so its newlines stay newlines instead of
 * sending), its line ends as carriage returns as a terminal pastes them, then Enter.
 */
export function composerWrites(text: string, chunk = COMPOSER_CHUNK, bracketed = true): string[] {
  const body = text.replace(/\r?\n/g, "\r").replace(/\x1b\[20[01]~/g, "");
  const parts: string[] = [];
  for (let i = 0; i < body.length; i += chunk) parts.push(body.slice(i, i + chunk));
  // A program that has not turned bracketed paste on (a REPL in a shell, say) would print the markers: type the lines.
  return bracketed ? ["\x1b[200~", ...parts, "\x1b[201~", "\r"] : [...parts, "\r"];
}

/** A path as a prompt takes it: quoted when it holds a space (or other whitespace), as an @file mention is. */
const promptPath = (p: string): string => (/\s/.test(p) ? `"${p}"` : p);

/**
 * The message Send pastes (code-chat C7): the text, then each image's path (the absolute path main saved it at), separated
 * by spaces, each quoted when it holds a space. Both TUIs take a pasted image path as an attachment. Text with no image
 * goes exactly as written; the text's trailing whitespace gives way to the one space before the paths.
 */
export function composeSend(text: string, images: string[]): string {
  if (!images.length) return text;
  const paths = images.map(promptPath).join(" ");
  const body = text.replace(/\s+$/, "");
  return body ? `${body} ${paths}` : paths;
}

/** The images the composer takes (code-chat C7), as main checks them again by content (services/code-images.ts). */
export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Why an image of this type and size is not taken, in main's words, or null when it may go to main. */
export function imageRefusal(type: string, size: number): string | null {
  if (!IMAGE_TYPES.includes(type)) return "only PNG, JPEG, GIF or WebP images";
  if (size > IMAGE_MAX_BYTES) return "larger than 10 MB";
  if (size <= 0) return "an empty file";
  return null;
}

/** The base64 of a `data:…;base64,` URL (FileReader's readAsDataURL), or null for any other text. */
export function dataUrlBase64(url: string): string | null {
  const m = /^data:[^,]*;base64,/.exec(url);
  return m ? url.slice(m[0].length) : null;
}

/** The @token the caret is in (after `@`, up to the caret), with where it starts, or null. */
export function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? { query: m[2], start: caret - m[2].length - 1 } : null;
}

/** Files whose path holds every character of the query in order, the shortest and earliest matches first. */
export function matchFiles(paths: string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  const score = (p: string): number | null => {
    const s = p.toLowerCase();
    if (!q) return p.length;
    const at = s.indexOf(q);
    if (at >= 0) return at + p.length / 100;
    let j = 0;
    for (let i = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) j++;
    return j === q.length ? 1000 + p.length : null;
  };
  return paths.map((p) => ({ p, s: score(p) })).filter((x): x is { p: string; s: number } => x.s !== null)
    .sort((a, b) => a.s - b.s).slice(0, limit).map((x) => x.p);
}

/** `text` with the @token at `start` replaced by `@path ` (a path with a space is quoted). */
export function insertMention(text: string, start: number, caret: number, path: string): { text: string; caret: number } {
  const token = `@${promptPath(path)} `;
  const out = text.slice(0, start) + token + text.slice(caret);
  return { text: out, caret: start + token.length };
}

export interface Snippet { title: string; text: string; host: "claude" | "codex" | null }

/** At most 50 snippets, each with a title (its first line when none) and text under 8,000 characters. */
export function sanitizeSnippets(raw: unknown): Snippet[] {
  if (!Array.isArray(raw)) return [];
  const out: Snippet[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.slice(0, 8000) : "";
    if (!text.trim()) continue;
    const title = (typeof o.title === "string" && o.title.trim() ? o.title.trim() : text.trim().split("\n")[0]).slice(0, 80);
    const host = o.host === "claude" || o.host === "codex" ? o.host : null;
    out.push({ title, text, host });
    if (out.length >= 50) break;
  }
  return out;
}
