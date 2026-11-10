// termScreen: an agent terminal's approval prompt, an open TUI dialog and Codex's footer rows, read from a snapshot of
// its headless screen (spec 2026-11-09 code-chat, C4, C5, C10). The fixtures are real 120×40 screens of Claude Code
// 2.1.318 (its fullscreen renderer, and two of its default inline one) and codex-cli 0.167.0, captured in an empty
// scratch folder with each host's cheapest model, every approval declined, then scrubbed (fixtures/screens).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { approvalPrompt, choiceInput, codexFooterRows, dialogOpen, screenCard } from "./termScreen";
import type { ScreenSnapshot } from "./headlessScreen";

const DIR = path.join(__dirname, "fixtures", "screens");
const C = "claude-2.1.318";
const X = "codex-0.167.0";
const rowsOf = (name: string): string[] => fs.readFileSync(path.join(DIR, `${name}.txt`), "utf8").split("\n");
const screen = (name: string): ScreenSnapshot => ({ rows: rowsOf(name), cols: 120 });
const snap = (rows: string[], cols = 120): ScreenSnapshot => ({ rows, cols });

test("the fixtures are whole 120×40 screens", () => {
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith(".txt"))) {
    const rows = rowsOf(f.slice(0, -4));
    assert.equal(rows.length, 40, f);
    assert.ok(rows.every((r) => [...r].length <= 120), f);
  }
});

test("Claude Code's Bash approval: its question, the command, and choices 1 to 4 keyed as the TUI takes them", () => {
  assert.deepEqual(approvalPrompt(screen(`${C}-bash`), "claude"), {
    title: "Do you want to proceed?",
    detail: "touch hi.txt",
    choices: [
      { key: "1", label: "Yes" },
      { key: "2", label: "Yes, and always allow access to /work/demo from this project" },
      { key: "3", label: "Yes, and switch to auto mode · auto mode handles these prompts for you" },
      { key: "4", label: "No" },
    ],
  });
});

test("Claude Code's edit approval: the file it would create, and its three choices", () => {
  assert.deepEqual(approvalPrompt(screen(`${C}-edit`), "claude"), {
    title: "Do you want to create hello.txt?",
    detail: "hello.txt",
    choices: [
      { key: "1", label: "Yes" },
      { key: "2", label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)" },
      { key: "3", label: "No" },
    ],
  });
});

test("a boxed prompt in the shape earlier Claude Code versions drew: box characters trimmed, (esc) is its key", () => {
  // Hand-made, not captured: the rounded box, the question line and numbered options, one wrapped across two rows.
  const w = 60;
  const row = (t: string) => `│ ${t.padEnd(w - 4)} │`;
  const rows = [
    ...Array(20).fill(""),
    `╭${"─".repeat(w - 2)}╮`,
    row("Bash command"),
    row(""),
    row("  touch hi.txt"),
    row("  Create an empty file"),
    row(""),
    row("Do you want to proceed?"),
    row("❯ 1. Yes"),
    row("  2. Yes, and don't ask again for touch commands in"),
    row("     /work/demo"),
    row("  3. No, and tell Claude what to do differently (esc)"),
    `╰${"─".repeat(w - 2)}╯`,
  ];
  assert.deepEqual(approvalPrompt(snap(rows), "claude"), {
    title: "Do you want to proceed?",
    detail: "touch hi.txt",
    choices: [
      { key: "1", label: "Yes" },
      { key: "2", label: "Yes, and don't ask again for touch commands in /work/demo" },
      { key: "esc", label: "No, and tell Claude what to do differently" },
    ],
  });
  assert.equal(dialogOpen(snap(rows), "claude"), true);
});

test("Claude's keys are its option digits: a label ending in (y) is a label, (esc) stays its cancel key (R49)", () => {
  const rows = [
    ...Array(20).fill(""),
    "─".repeat(40),
    " Bash command",
    "",
    "   rm notes.txt",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for rm (y)",
    "   3. No (esc)",
    "",
    " Esc to cancel",
  ];
  const a = approvalPrompt(snap(rows), "claude")!;
  assert.deepEqual(a.choices, [
    { key: "1", label: "Yes" },
    { key: "2", label: "Yes, and don't ask again for rm (y)" },
    { key: "esc", label: "No" },
  ]);
  // Codex keeps reading its own letters.
  const x = approvalPrompt(snap(["Would you like to run the following command?", "$ ls", "", "› 1. Yes, proceed (y)", "  2. No (esc)", "", "Press enter to confirm or esc to cancel"]), "codex")!;
  assert.deepEqual(x.choices.map((c) => c.key), ["y", "esc"]);
});

test("Codex's approvals give its own keys: y, p or a, and esc", () => {
  assert.deepEqual(approvalPrompt(screen(`${X}-bash`), "codex"), {
    title: "Would you like to run the following command?",
    detail: "touch hi.txt",
    choices: [
      { key: "y", label: "Yes, proceed" },
      { key: "p", label: "Yes, and don't ask again for commands that start with `touch hi.txt`" },
      { key: "esc", label: "No, and tell Codex what to do differently" },
    ],
  });
  assert.deepEqual(approvalPrompt(screen(`${X}-edit`), "codex"), {
    title: "Would you like to make the following edits?",
    detail: "/work/demo/hello.txt",
    choices: [
      { key: "y", label: "Yes, proceed" },
      { key: "a", label: "Yes, and don't ask again for these files" },
      { key: "esc", label: "No, and tell Codex what to do differently" },
    ],
  });
});

test("/model and the trust question set dialogOpen, and are no approval", () => {
  for (const [name, host] of [[`${C}-model`, "claude"], [`${C}-inline-model`, "claude"], [`${C}-trust`, "claude"], [`${X}-model`, "codex"]]) {
    assert.equal(dialogOpen(screen(name), host), true, name);
    assert.equal(approvalPrompt(screen(name), host), null, name);
  }
});

test("an approval is a dialog too, so a prompt that can't be drawn still says the TUI waits", () => {
  for (const [name, host] of [[`${C}-bash`, "claude"], [`${C}-edit`, "claude"], [`${X}-bash`, "codex"], [`${X}-edit`, "codex"]]) {
    assert.equal(dialogOpen(screen(name), host), true, name);
  }
});

test("idle and working give no approval and no dialog", () => {
  const cases: Array<[string, string]> = [
    [`${C}-idle`, "claude"], [`${C}-idle-history`, "claude"], [`${C}-working`, "claude"], [`${C}-inline-idle`, "claude"],
    [`${X}-idle`, "codex"], [`${X}-idle-history`, "codex"], [`${X}-working`, "codex"],
  ];
  for (const [name, host] of cases) {
    assert.equal(approvalPrompt(screen(name), host), null, name);
    assert.equal(dialogOpen(screen(name), host), false, name);
  }
});

test("a composer's own key hint is no dialog: only the keys a dialog offers count (Task 12; \"esc to clear\" and the like)", () => {
  const idle = rowsOf(`${C}-idle`);
  const last = (hint: string) => { const r = [...idle]; r[39] = `   ⏸ manual mode on · ${hint} · ← 1 agent `; return snap(r); };
  for (const hint of ["esc to clear", "Esc to clear input", "esc to undo", "Esc to edit queued messages", "enter to send", "esc to interrupt", "esc to stop"]) {
    assert.equal(dialogOpen(last(hint), "claude"), false, hint);
    assert.equal(screenCard(last(hint), "claude"), null, hint);
  }
  // The dialogs' own hints still count: the fixtures', and the other verbs a Claude Code dialog closes with.
  for (const hint of ["Esc to cancel · Tab to amend", "Enter to confirm · Esc to cancel", "Enter to set as default · s to use this session only · Esc to cancel", "Enter to select · Esc to go back", "Esc to exit", "Esc to close"]) {
    const r = rowsOf(`${C}-model`);
    r[39] = `   ${hint}`;
    assert.equal(dialogOpen(snap(r), "claude"), true, hint);
  }
});

test("screenCard: an approval is a card with its choices (read before the dialog it also is); any other dialog, or an approval that can't be read, waits on you; idle and working are none", () => {
  const bash = screenCard(screen(`${C}-bash`), "claude");
  assert.deepEqual(bash, { kind: "approval", ...approvalPrompt(screen(`${C}-bash`), "claude")! });
  assert.equal(bash?.kind === "approval" && bash.choices.length, 4);
  assert.deepEqual(screenCard(screen(`${X}-edit`), "codex"), { kind: "approval", ...approvalPrompt(screen(`${X}-edit`), "codex")! });
  for (const [name, host] of [[`${C}-model`, "claude"], [`${C}-inline-model`, "claude"], [`${C}-trust`, "claude"], [`${X}-model`, "codex"]]) {
    assert.deepEqual(screenCard(screen(name), host), { kind: "waiting" }, name);
  }
  const unreadable = rowsOf(`${C}-bash`).map((r) => r.replace(/^(\s*)2\. /, "$15. "));
  assert.deepEqual(screenCard(snap(unreadable), "claude"), { kind: "waiting" }, "options that don't run 1, 2, 3: the TUI still waits");
  for (const [name, host] of [[`${C}-idle`, "claude"], [`${C}-working`, "claude"], [`${X}-idle`, "codex"], [`${X}-working`, "codex"]]) {
    assert.equal(screenCard(screen(name), host), null, name);
  }
  assert.equal(screenCard(screen(`${C}-bash`), "shell"), null);
  assert.equal(screenCard(null as unknown as ScreenSnapshot, "claude"), null);
});

test("choiceInput: what a choice's key writes to the TUI: the key alone, Esc as the escape byte", () => {
  assert.equal(choiceInput("1"), "1");
  assert.equal(choiceInput("y"), "y");
  assert.equal(choiceInput("esc"), "\x1b");
  assert.equal(choiceInput("ESC"), "\x1b");
  for (const bad of ["", "12", "yes", "\r", "1\r", "\x1b[A", " "]) assert.equal(choiceInput(bad), null, JSON.stringify(bad));
});

test("a prompt read under the other host, or a shell, is not read", () => {
  assert.equal(approvalPrompt(screen(`${C}-bash`), "codex"), null);
  assert.equal(approvalPrompt(screen(`${X}-bash`), "claude"), null);
  assert.equal(approvalPrompt(screen(`${C}-bash`), "shell"), null);
  assert.equal(dialogOpen(screen(`${C}-model`), "shell"), false);
});

test("a question left above the bottom of the screen is no live prompt", () => {
  const strip = (rows: string[], hint: RegExp) => rows.map((r) => (hint.test(r) ? "" : r));
  const claude = strip(rowsOf(`${C}-bash`), /Esc to cancel/);
  assert.equal(approvalPrompt(snap(claude), "claude"), null);
  assert.equal(dialogOpen(snap(claude), "claude"), false);
  const codex = strip(rowsOf(`${X}-bash`), /Press enter to confirm/);
  assert.equal(approvalPrompt(snap(codex), "codex"), null);
});

test("options must run 1, 2, 3 … from the question down", () => {
  const base = rowsOf(`${C}-bash`);
  const gap = base.map((r) => r.replace(/^(\s*)2\. /, "$15. "));
  assert.equal(approvalPrompt(snap(gap), "claude"), null);
  const one = base.map((r) => (/^\s*[234]\. |^\s{6}from this project/.test(r) ? "" : r));
  assert.equal(approvalPrompt(snap(one), "claude"), null);
});

test("Codex's footer: the rows under its composer, ending at the screen's last row", () => {
  for (const name of [`${X}-idle`, `${X}-idle-history`, `${X}-working`]) {
    const rows = codexFooterRows(screen(name));
    assert.deepEqual(rows, [38, 39], name);
    assert.equal(rows![rows!.length - 1], 39, name);
  }
});

test("Codex's footer under a draft of several lines is still only the footer", () => {
  const rows = rowsOf(`${X}-idle`);
  rows[33] = "› first line of a draft";
  rows[34] = "  second line";
  rows[35] = "  third line";
  rows[36] = " ";
  assert.deepEqual(codexFooterRows(snap(rows)), [38, 39]);
});

test("no footer while an approval or a picker covers it, nor on Claude Code's screens", () => {
  for (const name of [`${X}-bash`, `${X}-edit`, `${X}-model`]) assert.equal(codexFooterRows(screen(name)), null, name);
  for (const f of fs.readdirSync(DIR).filter((n) => n.startsWith(C) && n.endsWith(".txt"))) {
    assert.equal(codexFooterRows(screen(f.slice(0, -4))), null, f);
  }
});

test("never throws: unknown or broken snapshots read as nothing", () => {
  const junk: unknown[] = [
    null, undefined, 0, "rows", {}, { rows: "x" }, { rows: [] }, { rows: [""] }, { rows: [1, null, undefined, {}] },
    { rows: ["Do you want to proceed?"] }, { rows: ["Do you want to proceed?", "❯ 1. Yes", "Esc to cancel"] },
    { rows: ["Would you like to run the following command?", "› 1. Yes, proceed (y)", "", "Press enter to confirm or esc to cancel"] },
    { rows: Array(5000).fill("Do you want to proceed?") }, { rows: Array(5000).fill("› 1. Yes (y)") },
    { rows: ["› Ask", " ", "  a", "  b", "  c", "  d"] }, { rows: ["  status only"] },
  ];
  for (const s of junk) {
    for (const host of ["claude", "codex", "shell", "", null]) {
      assert.equal(approvalPrompt(s as ScreenSnapshot, host as string), null);
      assert.equal(typeof dialogOpen(s as ScreenSnapshot, host as string), "boolean");
    }
    assert.equal(codexFooterRows(s as ScreenSnapshot), null);
  }
});
