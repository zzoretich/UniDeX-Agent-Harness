// termComposer.ts — the Term composer (spec 2026-10-08-term-agent-deck T12). Pure: what a message becomes on the wire
// (a bracketed paste, then Enter), with each of its images' paths as a paste of its own before the text (code-chat C7,
// R63), which images it takes, the @file token under the caret and the files that match it, and the saved snippets.
// ui/TermComposer.ts draws it.

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

/** A path as a prompt takes it: quoted when it holds a space (or other whitespace), as an @file mention is. No `"` to
 *  escape: an image's path is main's `<userData>/code-images/<yyyy-mm>/<uuid>.<ext>` (no account name holds one), and an
 *  @file one goes into the agent's prompt, never a shell. */
const promptPath = (p: string): string => (/\s/.test(p) ? `"${p}"` : p);

/**
 * The message as one text (code-chat C7): the text, then each image's path (the absolute path main saved it at), separated
 * by spaces, each quoted when it holds a space. Send types it this way only where the program takes no bracketed paste
 * (sendWrites): the TUI can still read the path. Text with no image goes exactly as written; the text's trailing
 * whitespace gives way to the one space before the paths.
 */
export function composeSend(text: string, images: string[]): string {
  if (!images.length) return text;
  const paths = images.map(promptPath).join(" ");
  const body = text.replace(/\s+$/, "");
  return body ? `${body} ${paths}` : paths;
}

/**
 * The writes Send makes (code-chat C7, R63). With bracketed paste on: each image's path as a bracketed paste of its own
 * (quoted as composeSend quotes it), in order, then the text as its own paste (in pieces, as composerWrites cuts it; none
 * for text that is only whitespace), then Enter. A paste that holds nothing but an image's path is what Claude Code and
 * Codex attach as an image (`[Image #1]`); a path pasted with text stays text. With it off: composeSend's one text, typed.
 */
export function sendWrites(text: string, images: string[], chunk = COMPOSER_CHUNK, bracketed = true): string[] {
  const p = sendPhases(text, images, chunk, bracketed);
  return [...p.images, ...p.rest];
}

/**
 * sendWrites in its two parts (R70): `images`, the image pastes (none without images or bracketed paste), and `rest`, the
 * text and Enter. Send writes `images`, waits for the TUI to show their placeholders (Claude Code inserts a pasted image
 * after it has read the file), then writes `rest`. Text after images starts with a space (D4): Claude Code's placeholder
 * has none after it (`[Image #1]What…`); Codex's does, and a second space there is harmless.
 */
export function sendPhases(text: string, images: string[], chunk = COMPOSER_CHUNK, bracketed = true): { images: string[]; rest: string[] } {
  if (!bracketed || !images.length) return { images: [], rest: composerWrites(composeSend(text, images), chunk, bracketed) };
  const paste = (s: string): string[] => composerWrites(s, chunk, true).slice(0, -1);
  const spaced = /^\s/.test(text) ? text : ` ${text}`;
  return { images: images.flatMap((p) => paste(promptPath(p))), rest: [...(text.trim() ? paste(spaced) : []), "\r"] };
}

/** How a Send's wait ended: nothing up (the rest may go), a card is up (R49), or the terminal's process changed (C1). */
export type SendWaitEnd = "clear" | "held" | "gone";

/**
 * What the composer does when a Send's wait ends (D1, D2). Clear: write the rest. Held: write nothing more and say why
 * (the held note). Gone: write nothing more, and say that the terminal changed (D2) unless the composer is kept away (an
 * ended agent's chat, R39), where nothing is said. `cleared`: the box was emptied when the images went (R70's wait), so
 * on held or gone the text comes back, if the box is still empty: the images are in the TUI's input, the text is not.
 */
export function sendWaitEnd(r: SendWaitEnd, o: { blocked: boolean; cleared: boolean; box: string; text: string }): { write: boolean; note: "held" | "changed" | null; box: string } {
  if (r === "clear") return { write: true, note: null, box: o.box };
  const box = o.cleared && !o.box ? o.text : o.box;
  return { write: false, note: r === "held" ? "held" : o.blocked ? null : "changed", box };
}

/** The images the composer takes (code-chat C7), as main checks them again by content (services/code-images.ts). */
export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** The most images one message carries (code-chat R60). */
export const IMAGE_MAX_COUNT = 8;

/** Why an image of this type and size is not taken, after `count` already in the message, in main's words, or null when
 *  it may go to main. */
export function imageRefusal(type: string, size: number, count = 0): string | null {
  if (count >= IMAGE_MAX_COUNT) return `${IMAGE_MAX_COUNT} images at most in one message`;
  if (!IMAGE_TYPES.includes(type)) return "only PNG, JPEG, GIF or WebP images";
  if (size > IMAGE_MAX_BYTES) return "larger than 10 MB";
  if (size <= 0) return "an empty file";
  return null;
}

/** Plain words for a bare errno code main passes on from the file system (R60). */
const ERRNO_WORDS: Record<string, string> = {
  ENOSPC: "the disk is full",
  EEXIST: "it could not be saved: try again",
  EACCES: "the app can't write to its data folder",
  EPERM: "the app can't write to its data folder",
  EROFS: "the app can't write to its data folder",
};

/** Why main refused an image, as the note under the composer says it: main's own reasons as they are, and a bare errno
 *  code (`ENOSPC`, `EEXIST` …) in plain words, never the code. */
export function imageReason(error: string): string {
  if (error && !/^E[A-Z0-9]+$/.test(error)) return error;
  return Object.prototype.hasOwnProperty.call(ERRNO_WORDS, error) ? ERRNO_WORDS[error] : "it could not be saved";
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
