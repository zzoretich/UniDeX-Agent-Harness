// headlessScreen.ts — an agent terminal's screen as its TUI draws it, kept without a view (spec 2026-11-09 code-chat,
// C4, C5, C10). Each agent terminal feeds its raw stream to an @xterm/headless terminal (the visible xterm's sibling
// package) with no scrollback, so termScreen can read the approval prompt or the dialog it shows for terminals nobody is
// looking at, and the Code chat can copy Codex's footer rows with their colours. One per agent terminal: made when the
// terminal is made, disposed when it closes; none for shells or `chat: false` terminals (the caller's rule).
//
// It is fed from `session.onData` and follows the session's size on the next chunk or read. It starts from what the
// terminal already printed, so one made late still shows the TUI's screen. Once the agent ended (the login shell took
// over, D18) or the terminal exited, it reads as empty: nothing on the shell's screen is the agent's to answer.
//
// Spans come from the buffer's cells, never from re-parsing the raw text (charset escapes such as `ESC ( B` and cursor
// moves are the parser's business): basic colours are the `var(--udx-term-*)` tokens ansiSpans uses, 256-colour and
// truecolor `rgb()`; background and inverse are ignored, as ansiSpans does. OSC 8 links are not in xterm 5's public
// buffer API: a cell's link id and its URI are read from the headless core when they are there (allowCodeHref decides),
// and a span has no link when they are not.
import { Terminal } from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import type { TerminalSession } from "./terminalSession";
import { allowCodeHref, color256, rgb, type Span } from "./ansiSpans";

/** What a terminal's screen shows: its rows as text (trailing blank cells trimmed) and its width. */
export interface ScreenSnapshot { rows: string[]; cols: number }

/** What a headless screen reads of its terminal (a TerminalSession; tests pass a fake). */
export type ScreenSource = Pick<TerminalSession, "onData" | "dimensions" | "agentEnded" | "isExited" | "getScrollback">;

/** The headless core's link store (xterm 5.5); absent or different in another version, which only loses links. */
interface LinkCore { _core?: { _oscLinkService?: { getLinkData(id: number): { uri?: unknown } | undefined } } }

export class HeadlessScreen {
  private readonly session: ScreenSource;
  private readonly term: Terminal;
  private readonly off: () => void;
  private size: { cols: number; rows: number };
  private disposed = false;
  /** Chunks written and not yet parsed (xterm parses on a timer). */
  private pending = 0;
  private waiters: Array<() => void> = [];

  constructor(session: TerminalSession | ScreenSource) {
    this.session = session;
    this.size = fit(session.dimensions);
    // allowProposedApi: xterm 5 marks the buffer API this reads as experimental.
    this.term = new Terminal({ cols: this.size.cols, rows: this.size.rows, scrollback: 0, allowProposedApi: true });
    const back = session.getScrollback();
    if (back) this.write(back);
    this.off = session.onData((d) => this.feed(d));
  }

  /** Whether a chunk waits to be parsed: a snapshot now could miss it, so nothing should be decided from one. */
  get busy(): boolean { return !this.disposed && this.pending > 0; }

  /** Resolves when every chunk written so far is parsed, or after `maxMs`, whichever is first (a screen that never settles
   *  must not hold a caller). */
  settled(maxMs: number): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); resolve(); }, maxMs);
      this.waiters.push(done);
    });
  }

  /** The rows on screen now; none once the agent ended, the terminal exited, or this was disposed. */
  snapshot(): ScreenSnapshot {
    if (this.gone()) return { rows: [], cols: this.size.cols };
    this.follow();
    const b = this.term.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < this.term.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? "");
    return { rows, cols: this.term.cols };
  }

  /** Row `y` of the screen as styled spans (adjacent cells of one style merged, trailing blanks dropped); [] for a row
   *  that is not there or blank. */
  rowSpans(y: number): Span[] {
    if (this.gone() || !Number.isInteger(y) || y < 0 || y >= this.term.rows) return [];
    const b = this.term.buffer.active;
    const line = b.getLine(b.viewportY + y);
    if (!line) return [];
    const spans: Span[] = [];
    const cell = b.getNullCell();
    for (let x = 0; x < this.term.cols; x++) {
      if (!line.getCell(x, cell) || cell.getWidth() === 0) continue; // the second half of a wide character
      const s: Span = { text: cell.getChars() || " ", fg: colorOf(cell), bold: !!cell.isBold(), dim: !!cell.isDim(), underline: !!cell.isUnderline(), href: this.linkOf(cell) };
      const last = spans[spans.length - 1];
      if (last && last.fg === s.fg && last.bold === s.bold && last.dim === s.dim && last.underline === s.underline && last.href === s.href) last.text += s.text;
      else spans.push(s);
    }
    // Trailing blanks: what the TUI left empty or cleared, unless they are underlined or linked (those show).
    while (spans.length) {
      const last = spans[spans.length - 1];
      if (last.underline || last.href) break;
      last.text = last.text.trimEnd();
      if (last.text) break;
      spans.pop();
    }
    return spans;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.term.dispose();
  }

  private gone(): boolean {
    return this.disposed || this.session.agentEnded || this.session.isExited;
  }

  private feed(d: string): void {
    if (this.gone()) return;
    this.follow();
    this.write(d);
  }

  private write(d: string): void {
    this.pending++;
    this.term.write(d, () => {
      this.pending--;
      if (this.pending <= 0) { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
    });
  }

  /** The session resized since: the screen takes its size before it parses more. */
  private follow(): void {
    const next = fit(this.session.dimensions);
    if (next.cols === this.size.cols && next.rows === this.size.rows) return;
    this.size = next;
    try { this.term.resize(next.cols, next.rows); } catch { /* a size xterm refuses keeps the last one */ }
  }

  private linkOf(cell: IBufferCell): string | null {
    try {
      const id = (cell as unknown as { extended?: { urlId?: unknown } }).extended?.urlId;
      if (typeof id !== "number" || id <= 0) return null;
      const uri = (this.term as unknown as LinkCore)._core?._oscLinkService?.getLinkData(id)?.uri;
      return typeof uri === "string" && allowCodeHref(uri) ? uri : null;
    } catch {
      return null;
    }
  }
}

/** A terminal size xterm takes: whole numbers from 1 to 1000. */
function fit(d: { cols: number; rows: number }): { cols: number; rows: number } {
  const n = (v: number, dflt: number) => (Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 1000) : dflt);
  return { cols: n(d.cols, 80), rows: n(d.rows, 24) };
}

function colorOf(cell: IBufferCell): string | null {
  if (cell.isFgDefault()) return null;
  const c = cell.getFgColor();
  if (cell.isFgRGB()) return rgb((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  return cell.isFgPalette() ? color256(c) : null;
}
