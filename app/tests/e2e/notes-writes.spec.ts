// The note editor with its write surface on (AOS_APP_WRITE=notes). Notes is the app's own surface, not the HUD's: it
// lets the note pane's CodeMirror editor save a Markdown note, and nothing else. Each save is a compare-and-set against
// the text the editor last read or wrote, so a note changed on disk under unsaved edits is never overwritten silently.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, closeNotes, content, expectNoErrors, guardWrites, noteBar, noteBody, openTab, terminalText, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "notes" } });

const NOTE = "brain/memory/projects/harbor-map.md";
const FILE = FX.v(NOTE);
const pristine = () => fs.readFileSync(path.join(FX.pristine, "vault", NOTE), "utf8");
const onDisk = () => (fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : null);

type Host = { aosHost: { app: { workspace: { activeLeaf: { view: { editor: { text: string; state: string } | null } } | null; openLinkText(l: string, s: string, n: boolean | string): Promise<void> }; vault: Record<string, unknown> } } };
const open = (win: Page, rel: string, where: boolean | "split" = true) =>
  win.evaluate(([r, w]) => (window as unknown as Host).aosHost.app.workspace.openLinkText(r as string, "", w as boolean | "split"), [rel, where] as const);
/** The active note's editor, as the test sees it: its text and save state (null in reading mode). */
const editor = (win: Page) => win.evaluate(() => {
  const ed = (window as unknown as Host).aosHost.app.workspace.activeLeaf?.view?.editor;
  return ed ? { text: ed.text, state: ed.state } : null;
});
const editBtn = (win: Page) => noteBar(win).locator("button.aos-note-edit");
const stateText = (win: Page) => noteBar(win).locator(".aos-note-state");
const conflict = (win: Page) => win.locator(".aos-host-pane.is-main > .workspace-leaf.is-active .aos-note-conflict");
const cm = (win: Page) => win.locator(".aos-host-pane.is-main > .workspace-leaf.is-active .cm-content");

/** Holds back the vault's events, as when another writer's change has not reached this app yet. */
async function holdEvents(win: Page, hold: boolean): Promise<void> {
  await win.evaluate((h) => {
    const v = (window as unknown as Host).aosHost.app.vault;
    if (h) { v.__trigger = v.trigger; v.trigger = () => undefined; }
    else { v.trigger = v.__trigger; delete v.__trigger; }
  }, hold);
}

async function edit(win: Page, rel = NOTE): Promise<void> {
  await open(win, rel);
  await expect(editBtn(win)).toBeEnabled();
  await editBtn(win).click();
  await expect(cm(win)).toBeVisible();
  await expect(stateText(win)).toHaveText("saved");
}

/** Types at the end of the note. */
async function typeAtEnd(win: Page, text: string): Promise<void> {
  await cm(win).click();
  await win.keyboard.press("Meta+ArrowDown");
  await win.keyboard.type(text);
}

test.beforeEach(async () => {
  // Every test starts from the pristine note.
  fs.writeFileSync(FILE, pristine());
});

test.afterEach(async () => {
  const h = app();
  await closeNotes(h.win);
  expectNoErrors(h);
  expect(await guardWrites(h)).toEqual([]);
  expect((await h.guard()).filter((e) => e.kind === "spawn")).toEqual([]);
});

test("Notes is the one surface on: the status bar names what the editor may save, and what it may not", async () => {
  const mode = app().win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Notes");
  // Never the runtime's folders, a dependency folder or a dot-path (.obsidian, .git, a host's .claude or .codex: S7).
  await expect(mode).toHaveAttribute("title", /^Notes: \*\*\/\*\.md \(not brain\/_index\/\*\*, brain\/scripts\/\*\*, \*\*\/node_modules\/\*\*, \*\*\/\.\*, \*\*\/\.\*\/\*\*\)\n/);
});

test("Edit opens the note in an editor; typing saves a moment later; undo saves it back byte for byte; Read renders it", async () => {
  const { win } = app();
  await edit(win);
  expect((await editor(win))?.text).toBe(pristine());
  await expect(editBtn(win)).toHaveText("Read");

  await typeAtEnd(win, "A line from the app.\n");
  await expect(stateText(win)).toHaveText("unsaved");
  await expect.poll(onDisk).toBe(`${pristine()}A line from the app.\n`);
  await expect(stateText(win)).toHaveText("saved");

  for (let i = 0; i < 10 && (await editor(win))?.text !== pristine(); i++) await win.keyboard.press("Meta+z");
  expect((await editor(win))?.text).toBe(pristine());
  await expect.poll(onDisk).toBe(pristine());
  await expect(stateText(win)).toHaveText("saved");

  await editBtn(win).click();
  await expect(cm(win)).toHaveCount(0);
  await expect(editBtn(win)).toHaveText("Edit");
  await expect(noteBody(win)).toContainText("An offline harbor chart viewer.");
  await expect(stateText(win)).toHaveText("");
});

test("⌘S saves at once, without waiting for the pause", async () => {
  const { win } = app();
  await edit(win);
  await typeAtEnd(win, "Saved by ⌘S.\n");
  await win.keyboard.press("Meta+s");
  // The autosave waits a second after the last key: a save within 700 ms is ⌘S's.
  await expect.poll(onDisk, { timeout: 700 }).toBe(`${pristine()}Saved by ⌘S.\n`);
  await expect(stateText(win)).toHaveText("saved");
});

test("a change on disk with nothing unsaved is taken into the editor, and the editor writes nothing", async () => {
  const { win } = app();
  await edit(win);
  const theirs = `${pristine()}Written by the other HUD.\n`;
  fs.writeFileSync(FILE, theirs);
  await expect.poll(async () => (await editor(win))?.text).toBe(theirs);
  await expect(stateText(win)).toHaveText("saved");
  await expect(conflict(win)).toBeHidden();
  fs.writeFileSync(FILE, pristine());
  await expect.poll(async () => (await editor(win))?.text).toBe(pristine());
  expect(onDisk()).toBe(pristine());
});

test("the reading view follows the file too", async () => {
  const { win } = app();
  await open(win, NOTE);
  await expect(noteBody(win)).toContainText("An offline harbor chart viewer.");
  fs.writeFileSync(FILE, `${pristine()}\nRendered after the change.\n`);
  await expect(noteBody(win)).toContainText("Rendered after the change.");
});

test("stale guard: a note changed on disk under unsaved edits is not overwritten; Reload from disk takes theirs", async () => {
  const { win } = app();
  await edit(win);
  const theirs = `${pristine()}Theirs, written while this app had not heard yet.\n`;
  await holdEvents(win, true);
  try {
    fs.writeFileSync(FILE, theirs);
    await typeAtEnd(win, "Mine.\n");
    // The autosave compares the disk with what the editor loaded, finds theirs, and writes nothing.
    await expect(stateText(win)).toHaveText("changed on disk");
  } finally { await holdEvents(win, false); }
  expect(onDisk()).toBe(theirs);
  await expect(conflict(win)).toBeVisible();
  await expect(conflict(win)).toContainText("This note changed on disk while you had unsaved edits. Nothing was written.");
  // More typing waits for the choice.
  await win.keyboard.type("Still mine.");
  await win.waitForTimeout(1500);
  expect(onDisk()).toBe(theirs);
  await conflict(win).locator("button", { hasText: "Reload from disk" }).click();
  await expect.poll(async () => (await editor(win))?.text).toBe(theirs);
  await expect(stateText(win)).toHaveText("saved");
  await expect(conflict(win)).toBeHidden();
  expect(onDisk()).toBe(theirs);
});

test("Keep mine writes the edits over what is on disk", async () => {
  const { win } = app();
  await edit(win);
  await holdEvents(win, true);
  try {
    fs.writeFileSync(FILE, `${pristine()}Theirs.\n`);
    await typeAtEnd(win, "Mine.\n");
    await expect(stateText(win)).toHaveText("changed on disk");
  } finally { await holdEvents(win, false); }
  await conflict(win).locator("button", { hasText: "Keep mine" }).click();
  await expect.poll(onDisk).toBe(`${pristine()}Mine.\n`);
  await expect(stateText(win)).toHaveText("saved");
  await expect(conflict(win)).toBeHidden();
});

test("a note deleted on disk keeps its text in the editor, and Keep mine writes it again", async () => {
  const { win } = app();
  await edit(win);
  fs.rmSync(FILE);
  await expect(stateText(win)).toHaveText("deleted on disk");
  await expect(conflict(win)).toContainText("This note was deleted on disk. Your text is still here.");
  await conflict(win).locator("button", { hasText: "Keep mine" }).click();
  await expect.poll(onDisk).toBe(pristine());
  await expect(stateText(win)).toHaveText("saved");
});

test("closing the tab saves what is unsaved", async () => {
  const { win } = app();
  await edit(win);
  await typeAtEnd(win, "Saved on close.\n");
  await win.locator(".aos-host-tab.is-active .aos-host-tab-close").click();
  await expect.poll(onDisk).toBe(`${pristine()}Saved on close.\n`);
});

test("files the runtime writes stay read-only, and so does anything that is not Markdown", async () => {
  const { win } = app();
  await open(win, "brain/_index/BRAIN.md");
  await expect(editBtn(win)).toBeDisabled();
  await expect(editBtn(win)).toHaveAttribute("title", /^Read-only: Notes is off for this run \(AOS_APP_WRITE\)\. Files the runtime writes \(brain\/_index, brain\/scripts\) stay read-only\.$/);
  await expect(noteBody(win).locator(".cm-editor")).toHaveCount(0);
  await open(win, "brain/config.json");
  await expect(noteBar(win).locator(".aos-note-path")).toHaveText("brain/config.json");
  await expect(editBtn(win)).toHaveCount(0);
});

test("a note with other names on disk (a hard link) is read-only, and says why: an edit would change them too", async () => {
  const { win } = app();
  const twin = FX.v("brain/memory/projects/harbor-map-twin.md");
  fs.linkSync(FILE, twin);
  try {
    await open(win, NOTE);
    await expect(editBtn(win)).toBeDisabled();
    await expect(editBtn(win)).toHaveAttribute("title", /^Read-only: this note has other names on disk \(hard links\), so an edit here would change them too\.$/);
    await expect(noteBody(win).locator(".cm-editor")).toHaveCount(0);
  } finally { fs.rmSync(twin, { force: true }); }
  expect(onDisk()).toBe(pristine());
});

test("the terminal cannot take the editor's keys: focus it takes on its own goes back to the note", async () => {
  const { win } = app();
  await openTab(win, "term");
  await expect.poll(() => win.locator(".aos-wb-content .xterm-helper-textarea").count()).toBeGreaterThan(0);
  await open(win, NOTE, "split");
  const split = win.locator(".aos-host-pane.is-split > .workspace-leaf.is-active");
  await split.locator("button.aos-note-edit").click();
  await split.locator(".cm-content").click();
  await win.keyboard.press("Meta+ArrowDown");
  // What TerminalPanel does on its next frame after a re-render: focus the terminal.
  await win.evaluate(() => (document.querySelector(".aos-wb-content .xterm-helper-textarea") as HTMLElement).focus());
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest(".cm-editor"))).toBe(true);
  await win.keyboard.type("kept-in-the-note");
  await expect.poll(onDisk).toBe(`${pristine()}kept-in-the-note`);
  expect(await terminalText(win)).not.toContain("kept-in-the-note");
  // A click in the terminal is the user's choice, and it keeps the focus.
  await win.locator(".aos-wb-content .xterm").first().click();
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest(".xterm"))).toBe(true);
  await openTab(win, "pulse");
});

test("with only Notes on, the HUD's own writes stay refused: a To-Do tick cannot write TODO.md, which the editor may save", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
  await open(h.win, "TODO.md");
  await expect(editBtn(h.win)).toBeEnabled();
});
