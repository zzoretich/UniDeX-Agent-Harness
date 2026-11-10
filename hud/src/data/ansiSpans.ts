// ansiSpans.ts — a terminal's styled text as spans, for the Code tab's status line under the composer (spec
// 2026-11-09 code-chat, C5). Claude's comes from `aos statusline render`; Codex's from a headless terminal screen
// converted to the same text. Pure; the renderer (Task 8) draws the spans.
//
// Colour representation (C9, tokens only): a basic colour (SGR 30-37, 90-97, or 256-colour indexes 0-15) is a CSS
// custom-property reference to the xterm token `var(--udx-term-<name>)` (--udx-term-green, --udx-term-bright-red, ...)
// which hud/styles.css defines per theme, so the renderer sets it as-is and both themes resolve it. Indexes 16-255 and
// truecolor are `rgb(r, g, b)` strings. Background colours are ignored (the composer area has its own background).
// Links: OSC 8 only, both terminators; an href the `allow` callback refuses keeps its text with `href: null`.

export interface Span { text: string; fg: string | null; bold: boolean; dim: boolean; underline: boolean; href: string | null }

const BASIC = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const basic = (i: number): string => `var(--udx-term-${i < 8 ? "" : "bright-"}${BASIC[i % 8]})`;
const rgb = (r: number, g: number, b: number): string => {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
};

function color256(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return basic(n);
  if (n >= 232) { const v = 8 + 10 * (n - 232); return rgb(v, v, v); }
  const i = n - 16;
  const lvl = (k: number) => (k === 0 ? 0 : 55 + 40 * k);
  return rgb(lvl(Math.floor(i / 36)), lvl(Math.floor(i / 6) % 6), lvl(i % 6));
}

/** True only for agenticos:// and https:// (scheme in any case), with no whitespace or control characters. */
export function allowCodeHref(href: string): boolean {
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(href)) return false;
  return /^(agenticos|https):\/\/./i.test(href);
}

interface Style { fg: string | null; bold: boolean; dim: boolean; underline: boolean }
const PLAIN: Style = { fg: null, bold: false, dim: false, underline: false };

function applySgr(style: Style, params: string): Style {
  const p = params === "" ? [0] : params.split(/[;:]/).map((s) => (s === "" ? 0 : Number(s)));
  let s = { ...style };
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) s = { ...PLAIN };
    else if (n === 1) s.bold = true;
    else if (n === 2) s.dim = true;
    else if (n === 4) s.underline = true;
    else if (n === 22) { s.bold = false; s.dim = false; }
    else if (n === 24) s.underline = false;
    else if (n === 39) s.fg = null;
    else if (n >= 30 && n <= 37) s.fg = basic(n - 30);
    else if (n >= 90 && n <= 97) s.fg = basic(n - 90 + 8);
    else if (n === 38 || n === 48) {
      const mode = p[i + 1];
      let color: string | null = null;
      if (mode === 5) { color = color256(p[i + 2]); i += 2; }
      else if (mode === 2) { color = rgb(p[i + 2], p[i + 3], p[i + 4]); i += 4; }
      else i = p.length;
      if (n === 38 && color) s.fg = color;
    }
  }
  return s;
}

/** Split `text` into lines of spans. SGR sets colour/bold/dim/underline; OSC 8 sets links (kept when `allow` says so);
 *  every other escape sequence is dropped without leaking bytes. */
export function ansiLines(text: string, allow: (href: string) => boolean): Span[][] {
  const lines: Span[][] = [];
  let line: Span[] = [];
  let style = PLAIN;
  let href: string | null = null;
  let buf = "";
  const flush = () => {
    if (buf === "") return;
    const last = line[line.length - 1];
    if (last && last.fg === style.fg && last.bold === style.bold && last.dim === style.dim && last.underline === style.underline && last.href === href) last.text += buf;
    else line.push({ text: buf, fg: style.fg, bold: style.bold, dim: style.dim, underline: style.underline, href });
    buf = "";
  };
  const endLine = () => { flush(); lines.push(line); line = []; };

  let i = 0;
  let pending = false; // text seen since the last line break
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\x1b") {
      const next = text[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x3f) j++;
        if (j >= text.length) break; // unterminated: drop the rest
        if (text[j] === "m") { flush(); style = applySgr(style, text.slice(i + 2, j)); }
        i = j + 1;
      } else if (next === "]") {
        let j = i + 2;
        while (j < text.length && text[j] !== "\x07" && !(text[j] === "\x1b" && text[j + 1] === "\\")) j++;
        if (j >= text.length) break;
        const body = text.slice(i + 2, j);
        if (body.startsWith("8;")) {
          flush();
          const url = body.slice(body.indexOf(";", 2) + 1);
          href = url !== "" && allow(url) ? url : null;
        }
        i = text[j] === "\x07" ? j + 1 : j + 2;
      } else {
        i += next === undefined ? 1 : 2; // a two-byte escape
      }
      continue;
    }
    if (ch === "\n") { endLine(); pending = false; }
    else if (ch !== "\r") { buf += ch; pending = true; }
    i++;
  }
  if (pending || buf !== "" || line.length > 0) endLine();
  return lines;
}
