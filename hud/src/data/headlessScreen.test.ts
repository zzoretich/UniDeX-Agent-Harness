// HeadlessScreen: an agent terminal's raw stream fed to @xterm/headless (scrollback 0), so termScreen can read what its
// TUI shows and the Code chat can copy Codex's footer with its colours (spec 2026-11-09 code-chat, C5, C10). The .ansi
// fixtures are real, scrubbed PTY streams (fixtures/screens); a fake session stands in for TerminalSession.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { HeadlessScreen, type ScreenSnapshot } from "./headlessScreen";
import { approvalPrompt, codexFooterRows } from "./termScreen";
import type { Span } from "./ansiSpans";

const DIR = path.join(__dirname, "fixtures", "screens");
const read = (name: string) => fs.readFileSync(path.join(DIR, name), "utf8");
const ESC = "\x1b";

class FakeSession {
  listeners = new Set<(d: string) => void>();
  size = { cols: 120, rows: 40 };
  agentEnded = false;
  isExited = false;
  back = "";
  get dimensions() { return { ...this.size }; }
  onData(l: (d: string) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  getScrollback(): string { return this.back; }
  emit(d: string): void { for (const l of this.listeners) l(d); }
}

/** Waits until the screen shows what `ok` wants (xterm parses writes on a timer), or fails after 2 s. */
async function until(screen: HeadlessScreen, ok: (s: ScreenSnapshot) => boolean): Promise<ScreenSnapshot> {
  const end = Date.now() + 2000;
  for (;;) {
    const s = screen.snapshot();
    if (ok(s)) return s;
    if (Date.now() > end) assert.fail(`screen never matched; last rows:\n${s.rows.join("\n")}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const text = (spans: Span[]) => spans.map((s) => s.text).join("");

test("Codex's idle stream renders to the rows of its fixture", async () => {
  const sess = new FakeSession();
  const screen = new HeadlessScreen(sess);
  sess.emit(read("codex-0.167.0-idle.ansi"));
  const want = read("codex-0.167.0-idle.txt").split("\n");
  const s = await until(screen, (x) => x.rows.join("\n") === want.join("\n"));
  assert.equal(s.cols, 120);
  assert.equal(s.rows.length, 40);
  assert.deepEqual(codexFooterRows(s), [38, 39]);
  screen.dispose();
});

test("Claude Code's Bash approval stream, charset escapes and all, reads as the approval", async () => {
  const raw = read("claude-2.1.318-bash.ansi");
  assert.ok(raw.includes(`${ESC}(B`), "the stream has ESC ( B");
  const sess = new FakeSession();
  const screen = new HeadlessScreen(sess);
  // In pieces, as a PTY delivers it, cut through escape sequences.
  for (let i = 0; i < raw.length; i += 97) sess.emit(raw.slice(i, i + 97));
  const want = read("claude-2.1.318-bash.txt");
  const s = await until(screen, (x) => x.rows.join("\n") === want);
  assert.equal(approvalPrompt(s, "claude")?.choices.length, 4);
  assert.ok(s.rows.every((r) => !r.includes(ESC)));
  screen.dispose();
});

test("rowSpans: Codex's status line keeps its colours, its hint row its bold keys", async () => {
  const sess = new FakeSession();
  const screen = new HeadlessScreen(sess);
  sess.emit(read("codex-0.167.0-idle.ansi"));
  const s = await until(screen, (x) => (x.rows[39] ?? "").includes("f2 to view"));
  const status = screen.rowSpans(38);
  assert.equal(text(status), s.rows[38].trimEnd());
  const model = status.find((x) => x.text === "GPT-6-Luna low");
  assert.ok(model, "the model span");
  assert.match(model!.fg ?? "", /^rgb\(\d+, \d+, \d+\)$/);
  assert.equal(status.find((x) => x.text === " · ")?.fg, null);
  const hints = screen.rowSpans(39);
  assert.equal(text(hints), s.rows[39].trimEnd());
  assert.ok(hints.some((x) => x.text === "←" && x.bold));
  assert.ok(hints.some((x) => x.text === "f2" && x.bold));
  assert.ok([...status, ...hints].every((x) => !x.text.includes(ESC) && x.href === null && !x.dim && !x.underline));
  screen.dispose();
});

test("rowSpans: basic colours are the xterm tokens, 256 and truecolor rgb(), links only where allowed", async () => {
  const sess = new FakeSession();
  const screen = new HeadlessScreen(sess);
  sess.emit(`${ESC}[31mred${ESC}[0m ${ESC}[1;94mhi${ESC}[0m ${ESC}[38;5;196mx${ESC}[0m ${ESC}[38;2;1;2;3my${ESC}[0m ` +
    `${ESC}[2mdim${ESC}[22m ${ESC}[4mu${ESC}[24m ${ESC}]8;;https://example.com/a\x07link${ESC}]8;;\x07 ` +
    `${ESC}]8;;file:///work/demo/a${ESC}\\file${ESC}]8;;${ESC}\\ 日本   `);
  await until(screen, (x) => (x.rows[0] ?? "").includes("日本"));
  const spans = screen.rowSpans(0);
  const by = (t: string) => spans.find((x) => x.text === t);
  assert.equal(by("red")?.fg, "var(--udx-term-red)");
  assert.deepEqual(by("hi"), { text: "hi", fg: "var(--udx-term-bright-blue)", bold: true, dim: false, underline: false, href: null });
  assert.equal(by("x")?.fg, "rgb(255, 0, 0)");
  assert.equal(by("y")?.fg, "rgb(1, 2, 3)");
  assert.equal(by("dim")?.dim, true);
  assert.equal(by("u")?.underline, true);
  assert.equal(by("link")?.href, "https://example.com/a");
  assert.equal(spans.find((x) => x.text.includes("file"))?.href, null);
  assert.equal(text(spans), "red hi x y dim u link file 日本");
  assert.deepEqual(screen.rowSpans(-1), []);
  assert.deepEqual(screen.rowSpans(40), []);
  assert.deepEqual(screen.rowSpans(1.5), []);
  assert.deepEqual(screen.rowSpans(5), []);
  screen.dispose();
});

test("follows the session's size, and keeps no scrollback", async () => {
  const sess = new FakeSession();
  const screen = new HeadlessScreen(sess);
  sess.emit(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n"));
  const s = await until(screen, (x) => x.rows[39] === "line 99");
  assert.equal(s.rows.length, 40);
  assert.equal(s.rows[0], "line 60");
  sess.size = { cols: 80, rows: 24 };
  const small = screen.snapshot();
  assert.equal(small.cols, 80);
  assert.equal(small.rows.length, 24);
  sess.emit("\r\nmore");
  await until(screen, (x) => x.rows[23] === "more");
  screen.dispose();
});

test("starts from what the terminal already printed", async () => {
  const sess = new FakeSession();
  sess.back = "hello\r\nworld";
  const screen = new HeadlessScreen(sess);
  const s = await until(screen, (x) => x.rows[1] === "world");
  assert.equal(s.rows[0], "hello");
  screen.dispose();
});

test("once the agent ended or the terminal exited, the screen reads as empty", async () => {
  const sess = new FakeSession();
  const screen = new HeadlessScreen(sess);
  sess.emit(read("claude-2.1.318-bash.ansi"));
  await until(screen, (x) => approvalPrompt(x, "claude") !== null);
  sess.agentEnded = true;
  assert.deepEqual(screen.snapshot(), { rows: [], cols: 120 });
  assert.deepEqual(screen.rowSpans(0), []);
  assert.equal(approvalPrompt(screen.snapshot(), "claude"), null);
  sess.agentEnded = false;
  sess.isExited = true;
  assert.deepEqual(screen.snapshot().rows, []);
  screen.dispose();
});

test("dispose stops listening, and the screen reads as empty after it", () => {
  const sess = new FakeSession();
  const screen = new HeadlessScreen(sess);
  assert.equal(sess.listeners.size, 1);
  screen.dispose();
  assert.equal(sess.listeners.size, 0);
  assert.deepEqual(screen.snapshot().rows, []);
  assert.deepEqual(screen.rowSpans(0), []);
  assert.doesNotThrow(() => screen.dispose());
});
