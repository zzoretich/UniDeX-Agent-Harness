// termStream.ts — what a terminal's raw output says about the program in it (spec 2026-10-08-term-agent-deck §4). Pure:
// it reads the window title an agent sets (OSC 0 or 2: Claude Code puts the conversation there, Codex a spinner and the
// project), and records the signals release 2's status uses: a notification (OSC 9), the bell, and bracketed-paste
// mode. It reads the PTY stream itself, not an xterm, so it works for terminals nobody is looking at; a sequence split
// across two chunks is held until the rest arrives.

export interface StreamSignal {
  /** A window title the program set, cleaned of a leading spinner. */
  title?: string;
  /** True when that title began with a spinner glyph (Codex's working mark). */
  spinner?: boolean;
  /** An OSC 9 notification's text (iTerm2-style; Codex's [tui] notifications). */
  notify?: string;
  bell?: true;
  /** Bracketed-paste mode switched on (true) or off (false): the program is at a prompt that takes pastes. */
  bracketedPaste?: boolean;
}

/** The longest OSC we keep waiting for the end of; past it the start is dropped as noise. */
const MAX_PENDING = 4096;
const ESC = "\x1b";
const BEL = "\x07";
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
/** Glyphs agents put before a title while they work: Braille spinners and the stars and dots Claude Code and Codex use. */
const SPINNER = /^[⠀-⣿✳✴✶✻✽✢✦✧·•●○◐-◓⏺*✳✻✽✶✢]+\s*/u;

/** A title without its leading spinner, and whether it had one. */
export function cleanTitle(raw: string): { title: string; spinner: boolean } {
  const t = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  const m = SPINNER.exec(t);
  return m ? { title: t.slice(m[0].length).trim(), spinner: true } : { title: t, spinner: false };
}

export class TermStreamScanner {
  private pending = "";

  /** Reads one chunk of output; returns the signals it completed, in order. */
  feed(chunk: string): StreamSignal[] {
    const data = this.pending + chunk;
    this.pending = "";
    const out: StreamSignal[] = [];
    let i = 0;
    while (i < data.length) {
      const esc = data.indexOf(ESC, i);
      const bel = data.indexOf(BEL, i);
      if (bel !== -1 && (esc === -1 || bel < esc)) { out.push({ bell: true }); i = bel + 1; continue; }
      if (esc === -1) break;
      if (esc === data.length - 1) { this.pending = ESC; break; }
      const next = data[esc + 1];
      if (next === "]") {
        const end = this.oscEnd(data, esc + 2);
        if (!end) {
          const rest = data.slice(esc);
          if (rest.length < MAX_PENDING) this.pending = rest;
          break;
        }
        const sig = this.osc(data.slice(esc + 2, end.at));
        if (sig) out.push(sig);
        i = end.at + end.len;
        continue;
      }
      if (next === "[") {
        const rest = data.slice(esc, esc + PASTE_ON.length);
        if (rest === PASTE_ON) { out.push({ bracketedPaste: true }); i = esc + PASTE_ON.length; continue; }
        if (rest === PASTE_OFF) { out.push({ bracketedPaste: false }); i = esc + PASTE_OFF.length; continue; }
        if (rest.length < PASTE_ON.length && (PASTE_ON.startsWith(rest) || PASTE_OFF.startsWith(rest))) { this.pending = rest; break; }
      }
      i = esc + 1;
    }
    return out;
  }

  /** Where an OSC body ends: at BEL, or at ST (ESC \). */
  private oscEnd(data: string, from: number): { at: number; len: number } | null {
    for (let j = from; j < data.length; j++) {
      const c = data[j];
      if (c === BEL) return { at: j, len: 1 };
      if (c === ESC) return data[j + 1] === "\\" ? { at: j, len: 2 } : j + 1 < data.length ? { at: j, len: 1 } : null;
    }
    return null;
  }

  private osc(body: string): StreamSignal | null {
    const semi = body.indexOf(";");
    const code = semi === -1 ? body : body.slice(0, semi);
    const text = semi === -1 ? "" : body.slice(semi + 1);
    if (code === "0" || code === "2") {
      const { title, spinner } = cleanTitle(text);
      return { title, spinner };
    }
    // OSC 9;4;… is ConEmu's progress bar, not a notification.
    if (code === "9" && !/^4;/.test(text)) return { notify: text.trim() };
    return null;
  }
}
