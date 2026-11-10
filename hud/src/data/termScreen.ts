// termScreen.ts — what an agent terminal's TUI is waiting on, read from a snapshot of its headless screen (spec
// 2026-11-09 code-chat, C4, C5, C10): the approval prompt with its choices, whether a dialog is open (the trust
// question, `/model`, a picker, an approval), and which rows are Codex's footer. Pure.
//
// Anchored on each prompt's own lines, never on a column: the key hint a dialog draws as its last row ("Esc to cancel",
// "enter select · esc back"); for an approval, the question line ("Do you want to proceed?", "Would you like to run the
// following command?"), the numbered options right under it, and the panel's top rule or box above it. A prompt counts
// only when its options run 1, 2, 3 … and nothing but blank rows stands between them and that last row, so a question
// left in the transcript is not one. Codex's footer is the block of rows under its composer (the `› ` row) at the bottom
// of the screen. Keys are the TUI's own: a trailing "(y)", "(a)" or "(esc)" names an option's key (Codex; earlier Claude
// Code versions), else its number. An unknown screen reads as nothing, and no input throws.
// Fixtures per host and CLI version: fixtures/screens (termScreen.test.ts).
import type { ScreenSnapshot } from "./headlessScreen";

export interface ApprovalChoice { key: string; label: string }
export interface ApprovalPrompt { title: string; detail: string | null; choices: ApprovalChoice[] }

type Host = "claude" | "codex";
const isHost = (h: unknown): h is Host => h === "claude" || h === "codex";

/** The approval's question line, per host. */
const QUESTION: Record<Host, RegExp> = {
  claude: /^Do you want\b.*\?$/,
  codex: /^Would you like\b.*\?$/,
};
/** A dialog's key hint, the last row it draws. Claude Code's working footer says "esc to interrupt": not a dialog. */
const HINT: Record<Host, RegExp> = {
  claude: /\b(?:esc|enter) to (?!interrupt\b)[a-z]/i,
  codex: /\b(?:esc|enter)(?: to)? (?:select|confirm|cancel|back|go back|close|exit|dismiss|continue)\b/i,
};
/** A numbered option, with or without the selection cursor in front. */
const OPTION = /^\s*(?:[❯›>]\s*)?(\d{1,2})\.\s+(.*\S)\s*$/;
/** An option's own key at the end of its label: "(y)", "(p)", "(a)", "(esc)". */
const KEY = /^(.*?)\s*\((esc|[a-z0-9])\)$/i;
const SOLID = /^\s*[─━]{8,}\s*$/;
const DASHED = /^\s*╌{8,}\s*$/;
const BOX_TOP = /^\s*╭─+╮\s*$/;
const BOX_END = /^\s*╰─+╯\s*$/;
/** How far above an approval's options its question and its panel's top may be. */
const REACH = 40;
/** The most rows Codex's footer has (its status line and its hints). */
const FOOTER_MAX = 3;

const blank = (r: string) => r.trim() === "";

/** The snapshot's rows as strings; [] for anything that is not a snapshot. */
function rowsOf(s: unknown): string[] {
  const rows = s && typeof s === "object" ? (s as { rows?: unknown }).rows : undefined;
  return Array.isArray(rows) ? rows.map((r) => (typeof r === "string" ? r : "")) : [];
}

/** A row without the box drawn around it (`│ … │`), its indent inside the box kept. */
function unbox(r: string): string {
  const m = /^\s*│ ?(.*?)\s*│?\s*$/.exec(r);
  return m ? m[1] : r;
}

function lastNonBlank(rows: string[]): number {
  for (let i = rows.length - 1; i >= 0; i--) if (!blank(rows[i])) return i;
  return -1;
}

/** The row that closes an open dialog at the bottom of the screen: its key hint, or (an earlier Claude Code's boxed
 *  prompt) the box's bottom edge under a selected numbered option. -1 when no dialog is open. */
function dialogEnd(rows: string[], host: Host): number {
  const end = lastNonBlank(rows);
  if (end < 0) return -1;
  if (HINT[host].test(unbox(rows[end]).trim())) return end;
  if (host === "claude" && BOX_END.test(rows[end])) {
    for (let i = end - 1; i >= 0 && end - i <= REACH && !BOX_TOP.test(rows[i]); i--) {
      if (/^❯\s*\d{1,2}\.\s/.test(unbox(rows[i]).trim())) return end;
    }
  }
  return -1;
}

/** Whether the TUI shows a dialog the user must answer in it: an approval, the trust question, `/model`, a picker. */
export function dialogOpen(s: ScreenSnapshot, host: string): boolean {
  try {
    return isHost(host) && dialogEnd(rowsOf(s), host) >= 0;
  } catch {
    return false;
  }
}

/** The approval prompt on screen, or null when there is none or it can't be read. */
export function approvalPrompt(s: ScreenSnapshot, host: string): ApprovalPrompt | null {
  try {
    if (!isHost(host)) return null;
    const raw = rowsOf(s);
    const end = dialogEnd(raw, host);
    if (end < 0) return null;
    const rows = raw.map(unbox);

    // The question: the nearest one above the dialog's last row.
    let q = -1;
    for (let i = end - 1; i >= 0 && end - i <= REACH; i--) if (QUESTION[host].test(rows[i].trim())) { q = i; break; }
    if (q < 0) return null;

    // The options: the first numbered row under it, then every numbered row and wrapped row up to a blank one.
    let first = -1;
    for (let i = q + 1; i < end; i++) if (OPTION.test(rows[i])) { first = i; break; }
    if (first < 0) return null;
    const opts: Array<{ n: number; label: string }> = [];
    let i = first;
    for (; i < end; i++) {
      const r = rows[i];
      if (blank(r)) break;
      const m = OPTION.exec(r);
      if (m) { opts.push({ n: Number(m[1]), label: m[2] }); continue; }
      if (!/^\s/.test(r) || HINT[host].test(r)) break;
      opts[opts.length - 1].label += ` ${r.trim()}`;
    }
    // Nothing but blank rows between the options and the dialog's last row: the prompt is the live one.
    for (let k = i; k < end; k++) if (!blank(rows[k])) return null;
    if (opts.length < 2 || opts.some((o, k) => o.n !== k + 1)) return null;

    const seen = new Set<string>();
    const choices = opts.map((o, k): ApprovalChoice => {
      const text = o.label.replace(/\s+/g, " ").trim();
      const m = KEY.exec(text);
      const own = m ? (m[2].toLowerCase() === "esc" ? "esc" : m[2]) : null;
      const key = own && !seen.has(own) ? own : String(k + 1);
      seen.add(key);
      return { key, label: m && key === own ? m[1] : text };
    });
    return { title: rows[q].trim(), detail: host === "claude" ? claudeDetail(rows, q) : codexDetail(rows, q, first), choices };
  } catch {
    return null;
  }
}

/** Claude Code: under the panel's top rule (or box), its header ("Bash command", "Create file"); a command's text is
 *  the block between the dashed rules, anything else the first row under the header (the file). */
function claudeDetail(rows: string[], q: number): string | null {
  let top = -1;
  for (let i = q - 1; i >= 0 && q - i <= REACH; i--) if (SOLID.test(rows[i]) || BOX_TOP.test(rows[i])) { top = i; break; }
  if (top < 0) return null;
  let head = top + 1;
  while (head < q && blank(rows[head])) head++;
  if (head >= q) return null;
  const dashes: number[] = [];
  for (let i = head + 1; i < q; i++) if (DASHED.test(rows[i])) dashes.push(i);
  const block = dashes.length >= 2
    ? rows.slice(dashes[0] + 1, dashes[1]).map((r) => r.trim()).filter(Boolean).join("\n") || null
    : null;
  if (block && /command/i.test(rows[head])) return block;
  for (let i = head + 1; i < (dashes[0] ?? q); i++) {
    const t = rows[i].trim();
    if (t && !/^Tip:/.test(t)) return t;
  }
  return block;
}

/** Codex: the command under the question (`$ …`, with its wrapped rows), else the file (`Destination: …`). */
function codexDetail(rows: string[], q: number, first: number): string | null {
  for (let i = q + 1; i < first; i++) {
    const t = rows[i].trim();
    if (t.startsWith("$ ")) {
      const out = [t.slice(2).trim()];
      for (let k = i + 1; k < first && !blank(rows[k]); k++) out.push(rows[k].trim());
      return out.join("\n") || null;
    }
  }
  for (let i = q + 1; i < first; i++) {
    const m = /^Destination:\s+(.+)$/.exec(rows[i].trim());
    if (m) return m[1];
  }
  return null;
}

/** Codex's footer: the indexes of the rows under its composer, a block of at most three ending at the screen's last
 *  non-blank row, for the chat to copy with HeadlessScreen.rowSpans. Null when the composer is not right above it (an
 *  approval or a picker covers it) or the screen is not Codex's. */
export function codexFooterRows(s: ScreenSnapshot): number[] | null {
  try {
    const rows = rowsOf(s);
    const last = lastNonBlank(rows);
    if (last < 0) return null;
    let start = last;
    while (start > 0 && !blank(rows[start - 1])) start--;
    if (last - start + 1 > FOOTER_MAX) return null;
    for (let k = start; k <= last; k++) {
      const r = rows[k];
      // A footer row is indented; a cursor, an option, a command menu (`/…`) or a dialog's hint is something else.
      if (!/^\s/.test(r) || /^\s*[›❯]/.test(r) || OPTION.test(r) || /^\s*\//.test(r) || HINT.codex.test(r)) return null;
    }
    // Above it, past the blank rows: the composer's last row, its first (`› `) row at most REACH rows up.
    let i = start - 1;
    while (i >= 0 && blank(rows[i])) i--;
    for (const stop = i - REACH; i >= 0 && i > stop; i--) {
      const r = rows[i];
      if (/^›(?:\s|$)/.test(r)) return OPTION.test(r) ? null : Array.from({ length: last - start + 1 }, (_, k) => start + k);
      if (blank(r) || !/^\s/.test(r)) return null;
    }
    return null;
  } catch {
    return null;
  }
}
