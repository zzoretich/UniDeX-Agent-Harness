// ansiSpans: SGR + OSC 8 into spans for the Code tab's status line (spec 2026-11-09 code-chat, C5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ansiLines, allowCodeHref } from "./ansiSpans";

const R = createRequire(import.meta.url)("../../../brain/scripts/lib/statusline-render.js");
const ESC = "\x1b";
const text = (spans: { text: string }[]) => spans.map((s) => s.text).join("");

test("the real renderer's three lines: 3 lines, the green context bar", () => {
  const now = Date.UTC(2026, 8, 28, 19, 0, 0);
  const payload = {
    model: { display_name: "Opus 5.5 (1M context)" },
    workspace: { current_dir: "/work/demo", project_dir: "/work/demo" },
    context_window: { remaining_percentage: 66, context_window_size: 1000000 },
    pr: { number: 63, url: "https://github.com/o/r/pull/63", review_state: "pending" },
  };
  const model = {
    schema: 1, at: new Date(now).toISOString(), vault: "V",
    needs: { gates: [{ team: "dev", item: "a-01", stage: "ship" }], alerts: 1, breaking: 0, flags: 0 },
    runs: [], spend: null, health: { update: null, provider: null, unwrapped: false, drafts: 0 },
  };
  const out = R.render({ payload, model, now, links: true }).join("\n") + "\n";
  const lines = ansiLines(out, allowCodeHref);
  assert.equal(lines.length, 3);
  const bar = lines[1].find((s) => s.text === "████░░░░░░ 41%");
  assert.ok(bar, "bar span");
  assert.equal(bar!.fg, "var(--udx-term-green)");
  assert.ok(lines[0].some((s) => s.dim && s.text === "│"));
  assert.ok(lines[2].some((s) => s.bold && s.href === "agenticos://workbench?tab=agent-teams"));
  assert.ok(lines.flat().every((s) => !s.text.includes(ESC)));
  assert.ok(lines[0].some((s) => s.href === "https://github.com/o/r/pull/63"));
});

test("OSC 8: BEL and ST terminators; an empty URL closes the link; params ignored", () => {
  const u = "agenticos://workbench?tab=notifications";
  const a = ansiLines(`${ESC}]8;;${u}\x07go${ESC}]8;;\x07 end`, allowCodeHref)[0];
  assert.deepEqual(a.map((s) => [s.text, s.href]), [["go", u], [" end", null]]);
  const b = ansiLines(`${ESC}]8;id=1;${u}${ESC}\\go${ESC}]8;;${ESC}\\ end`, allowCodeHref)[0];
  assert.deepEqual(b.map((s) => [s.text, s.href]), [["go", u], [" end", null]]);
});

test("unsafe hrefs lose the link but keep the text", () => {
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "http://x.example", "data:text/html,x", "/rel/path"]) {
    const line = ansiLines(`${ESC}]8;;${bad}\x07text${ESC}]8;;\x07`, allowCodeHref)[0];
    assert.equal(text(line), "text");
    assert.ok(line.every((s) => s.href === null), bad);
  }
});

test("allowCodeHref: agenticos and https only, any case, no whitespace or control chars", () => {
  assert.equal(allowCodeHref("agenticos://workbench?tab=x"), true);
  assert.equal(allowCodeHref("HTTPS://github.com/o/r"), true);
  assert.equal(allowCodeHref("AgenticOS://x"), true);
  for (const bad of ["http://a.b", "file:///x", "javascript:x", "data:x", "x/y", "", "https://a b", "https://a\tb", "https://a\u0001b", "https://a\nb"]) assert.equal(allowCodeHref(bad), false, bad);
});

test("colours: basic, bright, 256 and truecolor", () => {
  const f = (s: string) => ansiLines(`${ESC}[${s}mx`, allowCodeHref)[0][0].fg;
  assert.equal(f("31"), "var(--udx-term-red)");
  assert.equal(f("37"), "var(--udx-term-white)");
  assert.equal(f("92"), "var(--udx-term-bright-green)");
  assert.equal(f("38;5;2"), "var(--udx-term-green)");
  assert.equal(f("38;5;9"), "var(--udx-term-bright-red)");
  assert.equal(f("38;5;208"), "rgb(255, 135, 0)");
  assert.equal(f("38;5;16"), "rgb(0, 0, 0)");
  assert.equal(f("38;5;232"), "rgb(8, 8, 8)");
  assert.equal(f("38;5;255"), "rgb(238, 238, 238)");
  assert.equal(f("38;2;10;20;30"), "rgb(10, 20, 30)");
  assert.equal(f("38;2;999;0;0"), "rgb(255, 0, 0)");
});

test("attributes, resets and ignored sequences", () => {
  const line = ansiLines(`${ESC}[1;2;4;31ma${ESC}[22mb${ESC}[24mc${ESC}[39md${ESC}[0me`, allowCodeHref)[0];
  assert.deepEqual(line.map((s) => [s.text, s.bold, s.dim, s.underline, s.fg]), [
    ["a", true, true, true, "var(--udx-term-red)"],
    ["b", false, false, true, "var(--udx-term-red)"],
    ["c", false, false, false, "var(--udx-term-red)"],
    ["de", false, false, false, null],
  ]);
  // background colours, cursor moves, clears and unknown OSC leak nothing and change nothing
  const g = ansiLines(`${ESC}[44mA${ESC}[48;5;12mB${ESC}[102mC${ESC}[2J${ESC}[3;4HD${ESC}]0;title\x07E${ESC}]52;c;AAAA${ESC}\\F`, allowCodeHref)[0];
  assert.equal(text(g), "ABCDEF");
  assert.ok(g.every((s) => s.fg === null && !s.bold));
});

test("lines: split on newline, CR dropped, trailing newline adds no empty line", () => {
  assert.deepEqual(ansiLines("a\r\nb\n", allowCodeHref).map(text), ["a", "b"]);
  assert.deepEqual(ansiLines("a\n\nb", allowCodeHref).map(text), ["a", "", "b"]);
  assert.deepEqual(ansiLines("", allowCodeHref), []);
  // style carries across lines
  const l = ansiLines(`${ESC}[32ma\nb`, allowCodeHref);
  assert.equal(l[1][0].fg, "var(--udx-term-green)");
});

test("adjacent text with identical attributes merges; an unterminated escape is dropped", () => {
  assert.equal(ansiLines(`a${ESC}[0mb`, allowCodeHref)[0].length, 1);
  assert.equal(text(ansiLines(`ok${ESC}[3`, allowCodeHref)[0]), "ok");
  assert.equal(text(ansiLines(`ok${ESC}]8;;https://x`, allowCodeHref)[0]), "ok");
});
