// The Files tab with its write surface on (AOS_APP_WRITE=files): a new note in a new folder, opened at once and
// selected in its folder; the form's refusals; rename in place (files-finder D14) with the links that follow it (D17);
// New folder and Duplicate; Move to… and drag to move (D15), each undone with ⌘Z or the toast (D16); a runtime folder
// refusing a drop; and the Trash, for one file or a selection, only after a confirm. Every write is the surface's own:
// the guard refuses nothing.

import { expect, test, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, closeNotes, content, drawer, guardWrites, notePath, openTab, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "files" } });

const view = (win: Page) => content(win).locator(".aos-fx-view");
const item = (win: Page, p: string) => view(win).locator(`[data-path="${p}"]`);
const title = (win: Page) => content(win).locator(".aos-fx-h1");
const inputs = (win: Page) => drawer(win).locator(".aos-rt-input");
const note = (win: Page) => drawer(win).locator(".aos-rt-errors");
const button = (win: Page, text: string) => drawer(win).locator(".aos-capture-actions button", { hasText: text });
const menuItem = (win: Page, act: string) => content(win).locator(`.aos-fx-menu .aos-fx-mi[data-act="${act}"]`);
const field = (win: Page) => view(win).locator(".aos-fx-rename-input");
const renameNote = (win: Page) => view(win).locator(".aos-fx-rename-note");
const hint = (win: Page) => content(win).locator(".aos-fx-drophint");
const setView = async (win: Page, v: "icons" | "list" | "columns") => { await content(win).locator(`.aos-fx-seg button[data-view="${v}"]`).click(); };

/** Clicks the toasts away (by their corner, clear of an Undo button): they sit over the toolbar for a few seconds. */
async function dismissToasts(win: Page): Promise<void> {
  const first = win.locator(".notice").first();
  for (let i = 0; i < 10 && (await win.locator(".notice").count()); i++) await first.click({ position: { x: 14, y: 5 }, timeout: 1000 }).catch(() => undefined);
  await expect(win.locator(".notice")).toHaveCount(0);
}

/** The rename field's selection, as [start, end]. */
const selected = (win: Page) => field(win).evaluate((e) => [(e as HTMLInputElement).selectionStart, (e as HTMLInputElement).selectionEnd]);

/** A drag from `from` dropped on `to`, with the events Chromium sends. The drag's end goes to the tab: the item that
 *  started it may be gone by then. */
async function drag(win: Page, from: Locator, to: Locator): Promise<void> {
  const dataTransfer = await win.evaluateHandle(() => new DataTransfer());
  await from.dispatchEvent("dragstart", { dataTransfer });
  await to.dispatchEvent("dragenter", { dataTransfer });
  await to.dispatchEvent("dragover", { dataTransfer });
  await to.dispatchEvent("drop", { dataTransfer });
  await content(win).locator(".aos-fx").dispatchEvent("dragend", { dataTransfer });
}

/** Holds the drag over `to` (no drop, no end) so its marks can be read; `end` finishes it. */
async function hover(win: Page, from: Locator, to: Locator): Promise<{ end: () => Promise<void> }> {
  const dataTransfer = await win.evaluateHandle(() => new DataTransfer());
  await from.dispatchEvent("dragstart", { dataTransfer });
  await to.dispatchEvent("dragenter", { dataTransfer });
  await to.dispatchEvent("dragover", { dataTransfer });
  return { end: () => from.dispatchEvent("dragend", { dataTransfer }) };
}

/** Right-clicks `p` and picks the menu item `act`. */
async function act(win: Page, p: string, a: string): Promise<void> {
  await item(win, p).click({ button: "right" });
  await menuItem(win, a).click();
}

/** Enters each folder down to `dir` from the vault, by double-clicks in Icons. */
async function enter(win: Page, dir: string): Promise<void> {
  await content(win).locator('.aos-fx-si[data-fav=""]').click();
  const parts = dir.split("/");
  for (let i = 1; i <= parts.length; i++) {
    await item(win, parts.slice(0, i).join("/")).dblclick();
    await expect(title(win)).toHaveText(parts[i - 1]);
  }
}

/** + ▸ New note… */
async function newNote(win: Page): Promise<void> {
  await content(win).locator('button[data-act="new"]').click();
  await menuItem(win, "new-note").click();
}

test.beforeEach(async () => {
  const { win } = app();
  await closeNotes(win);
  await openTab(win, "files");
  await content(win).locator('.aos-fx-seg button[data-view="icons"]').click();
});

test.afterEach(async () => {
  expect(await guardWrites(app())).toEqual([]);
  const d = drawer(app().win);
  if (await d.evaluate((e) => e.classList.contains("is-open"))) await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
});

test("Files is the one surface on: the status bar names it", async () => {
  await expect(app().win.locator(".aos-host-status .aos-host-mode")).toHaveText("WRITES: Files");
});

test("New note makes a Markdown note in a new folder, opens it, and shows it selected in its folder", async () => {
  const { win } = app();
  await newNote(win);
  // The name first, then the folder (its suggestion list could commit an entry when focus leaves it).
  await inputs(win).nth(1).fill("Tide windows");
  await inputs(win).nth(0).fill("workspaces/harbor-map/notes");
  await expect(note(win)).toHaveText("→ workspaces/harbor-map/notes/Tide windows.md");
  await button(win, "create").click();
  await expect(notePath(win)).toHaveText("workspaces/harbor-map/notes/Tide windows.md");
  expect(fs.readFileSync(FX.v("workspaces/harbor-map/notes/Tide windows.md"), "utf8")).toBe("");
  await closeNotes(win);
  await openTab(win, "files");
  await expect(title(win)).toHaveText("notes");
  await expect(item(win, "workspaces/harbor-map/notes/Tide windows.md")).toHaveClass(/is-selected/);
});

test("the new-note form says why it refuses, and create stays off", async () => {
  const { win } = app();
  await newNote(win);
  const check = async (folder: string, name: string, why: string) => {
    await inputs(win).nth(1).fill(name);
    await inputs(win).nth(0).fill(folder);
    await expect(note(win)).toHaveText(why);
    await expect(button(win, "create")).toBeDisabled();
  };
  await check("workspaces/harbor-map", "PLAN", "workspaces/harbor-map/PLAN.md already exists");
  await check("brain/_index", "x", "brain/_index/ is written by the runtime itself");
  await check("", "../outside", "a path cannot climb out of the vault (..)");
  await check("notes", "", "a name is required");
});

test("Return renames in place: the stem selected, the check under the field, Escape keeps the name, Return keeps the bytes", async () => {
  const h = app();
  const { win } = h;
  const before = fs.readFileSync(FX.v("workspaces/harbor-map/PLAN.md"));
  await enter(win, "workspaces/harbor-map");
  await item(win, "workspaces/harbor-map/PLAN.md").click();
  await win.keyboard.press("Enter");
  await expect(field(win)).toHaveValue("PLAN.md");
  await expect(field(win)).toBeFocused();
  expect(await selected(win)).toEqual([0, 4]);
  await field(win).fill("README");
  await expect(renameNote(win)).toHaveText("workspaces/harbor-map/README.md already exists");
  await field(win).fill("a:b");
  await expect(renameNote(win)).toHaveText('names cannot contain \\ : * ? " < > |');
  // Return on a name that cannot be keeps the field; Escape keeps the old name.
  await win.keyboard.press("Enter");
  await expect(field(win)).toBeVisible();
  await win.keyboard.press("Escape");
  await expect(field(win)).toHaveCount(0);
  await expect(item(win, "workspaces/harbor-map/PLAN.md").locator(".aos-fx-tile-name")).toHaveText("PLAN.md");
  expect(fs.existsSync(FX.v("workspaces/harbor-map/PLAN.md"))).toBe(true);

  // The menu's Rename opens the same field; the extension is kept when it is left off.
  await act(win, "workspaces/harbor-map/PLAN.md", "rename");
  await field(win).fill("ROADMAP");
  await win.keyboard.press("Enter");
  await expect.poll(() => fs.existsSync(FX.v("workspaces/harbor-map/ROADMAP.md"))).toBe(true);
  expect(fs.existsSync(FX.v("workspaces/harbor-map/PLAN.md"))).toBe(false);
  expect(fs.readFileSync(FX.v("workspaces/harbor-map/ROADMAP.md")).equals(before)).toBe(true);
  await expect(item(win, "workspaces/harbor-map/ROADMAP.md")).toHaveClass(/is-selected/);
  await expect(view(win)).toBeFocused();
  await expect.poll(() => h.notices.some((n) => n.startsWith("Renamed PLAN.md to ROADMAP.md"))).toBe(true);

  // ⌘Z puts the name back; the undo goes stale once the file moved on without the tab.
  await win.keyboard.press("Meta+z");
  await expect.poll(() => fs.existsSync(FX.v("workspaces/harbor-map/PLAN.md"))).toBe(true);
  expect(fs.readFileSync(FX.v("workspaces/harbor-map/PLAN.md")).equals(before)).toBe(true);
  await expect(item(win, "workspaces/harbor-map/PLAN.md")).toHaveClass(/is-selected/);
  await expect.poll(() => h.notices.includes("Undid the rename of PLAN.md")).toBe(true);
  await item(win, "workspaces/harbor-map/PLAN.md").click();
  await win.keyboard.press("Enter");
  await field(win).fill("GOALS");
  await win.keyboard.press("Enter");
  await expect.poll(() => fs.existsSync(FX.v("workspaces/harbor-map/GOALS.md"))).toBe(true);
  fs.renameSync(FX.v("workspaces/harbor-map/GOALS.md"), FX.v("workspaces/harbor-map/PLAN.md"));
  await view(win).focus();
  await win.keyboard.press("Meta+z");
  await expect.poll(() => h.notices.includes("Cannot undo the rename of PLAN.md: GOALS.md is no longer at workspaces/harbor-map/GOALS.md")).toBe(true);
  expect(fs.existsSync(FX.v("workspaces/harbor-map/PLAN.md"))).toBe(true);
});

test("a rename takes the links to it along (Update N links, on), leaves the runtime's notes, and ⌘Z puts both back", async () => {
  const h = app();
  const { win } = h;
  const note = "brain/memory/projects/harbor-map.md";
  const memory = fs.readFileSync(FX.v("MEMORY.md"), "utf8");
  const bytes = fs.readFileSync(FX.v(note));
  expect(memory).toContain(`](${note})`);
  await enter(win, "brain/memory/projects");
  await item(win, note).click();
  await win.keyboard.press("Enter");
  const links = view(win).locator(".aos-fx-rename-links");
  // The vault index is read after the first paint: the count shows once it is.
  await expect(async () => {
    await field(win).fill("chart-viewer");
    await expect(links).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(links).toHaveText(/^Update [1-9]\d* links?/);
  await expect(links.locator("input")).toBeChecked();
  await win.keyboard.press("Enter");
  const to = "brain/memory/projects/chart-viewer.md";
  await expect.poll(() => fs.existsSync(FX.v(to))).toBe(true);
  expect(fs.readFileSync(FX.v(to)).equals(bytes)).toBe(true);
  await expect.poll(() => fs.readFileSync(FX.v("MEMORY.md"), "utf8")).toBe(memory.split(`](${note})`).join(`](${to})`));
  await expect.poll(() => h.notices.some((n) => n.startsWith("Renamed harbor-map.md to chart-viewer.md · ") && /links? updated/.test(n))).toBe(true);
  // The runtime's own notes are never written: brain/_index is the runtime's to compile again.
  const refused = (await h.guard()).filter((e) => e.kind === "write");
  expect(refused).toEqual([]);

  await win.keyboard.press("Meta+z");
  await expect.poll(() => fs.existsSync(FX.v(note))).toBe(true);
  expect(fs.existsSync(FX.v(to))).toBe(false);
  await expect.poll(() => fs.readFileSync(FX.v("MEMORY.md"), "utf8")).toBe(memory);

  // Turned off, it stays off: the next rename leaves the links as they are.
  await item(win, note).click();
  await win.keyboard.press("Enter");
  await field(win).fill("chart-viewer");
  await links.click();
  await expect(links.locator("input")).not.toBeChecked();
  await win.keyboard.press("Escape");
  await item(win, note).click();
  await win.keyboard.press("Enter");
  await field(win).fill("chart-viewer");
  await expect(links.locator("input")).not.toBeChecked();
  await win.keyboard.press("Enter");
  await expect.poll(() => fs.existsSync(FX.v(to))).toBe(true);
  expect(fs.readFileSync(FX.v("MEMORY.md"), "utf8")).toBe(memory);
  await win.keyboard.press("Meta+z");
  await expect.poll(() => fs.existsSync(FX.v(note))).toBe(true);
  // On again, for the specs after this one.
  await item(win, note).click();
  await win.keyboard.press("Enter");
  await field(win).fill("chart-viewer");
  await links.click();
  await expect(links.locator("input")).toBeChecked();
  await win.keyboard.press("Escape");
});

test("New folder (⌥⌘N, + and the menu) makes untitled folder, numbered when taken, with its name open", async () => {
  const { win } = app();
  await enter(win, "workspaces/harbor-map");
  await view(win).focus();
  await win.keyboard.press("Meta+Alt+KeyN");
  await expect.poll(() => fs.statSync(FX.v("workspaces/harbor-map/untitled folder"), { throwIfNoEntry: false })?.isDirectory()).toBe(true);
  await expect(field(win)).toHaveValue("untitled folder");
  expect(await selected(win)).toEqual([0, "untitled folder".length]);
  await field(win).fill("charts");
  await win.keyboard.press("Enter");
  await expect.poll(() => fs.existsSync(FX.v("workspaces/harbor-map/charts"))).toBe(true);
  expect(fs.existsSync(FX.v("workspaces/harbor-map/untitled folder"))).toBe(false);
  await expect(item(win, "workspaces/harbor-map/charts")).toHaveClass(/is-selected/);

  await dismissToasts(win);
  await content(win).locator('button[data-act="new"]').click();
  await menuItem(win, "new-folder").click();
  await expect(field(win)).toHaveValue("untitled folder");
  await win.keyboard.press("Escape");
  await expect(item(win, "workspaces/harbor-map/untitled folder")).toBeVisible();
  await view(win).locator('.aos-fx-tile[data-path="workspaces/harbor-map/charts"]').click({ button: "right" });
  await menuItem(win, "new-folder").click();
  // Inside the folder it was asked on, which the tab now shows.
  await expect(title(win)).toHaveText("charts");
  await expect(field(win)).toHaveValue("untitled folder");
  await win.keyboard.press("Escape");
  await enter(win, "workspaces/harbor-map");
  await view(win).focus();
  await win.keyboard.press("Meta+Alt+KeyN");
  await expect(field(win)).toHaveValue("untitled folder 2");
  await win.keyboard.press("Escape");
  for (const rel of ["untitled folder", "untitled folder 2", "charts/untitled folder"]) expect(fs.statSync(FX.v(`workspaces/harbor-map/${rel}`)).isDirectory()).toBe(true);
});

test("Duplicate (⌘D) copies a file beside itself as name copy, and a folder with what is in it; the copies are selected", async () => {
  const h = app();
  const { win } = h;
  await enter(win, "workspaces/harbor-map/src");
  await item(win, "workspaces/harbor-map/src/tides.js").click();
  await win.keyboard.press("Meta+d");
  const copy = "workspaces/harbor-map/src/tides copy.js";
  await expect.poll(() => fs.existsSync(FX.v(copy))).toBe(true);
  expect(fs.readFileSync(FX.v(copy)).equals(fs.readFileSync(FX.v("workspaces/harbor-map/src/tides.js")))).toBe(true);
  await expect(item(win, copy)).toHaveClass(/is-selected/);
  await win.keyboard.press("Meta+d");
  await expect.poll(() => fs.existsSync(FX.v("workspaces/harbor-map/src/tides copy copy.js"))).toBe(true);

  await enter(win, "workspaces/harbor-map");
  await act(win, "workspaces/harbor-map/src", "duplicate");
  await expect.poll(() => fs.existsSync(FX.v("workspaces/harbor-map/src copy"))).toBe(true);
  expect(fs.readdirSync(FX.v("workspaces/harbor-map/src copy")).sort()).toEqual(fs.readdirSync(FX.v("workspaces/harbor-map/src")).sort());
  await expect(item(win, "workspaces/harbor-map/src copy")).toHaveClass(/is-selected/);
  await expect.poll(() => h.notices.includes("Duplicated src as src copy")).toBe(true);
});

test("drag moves a selection onto a path-bar folder, every item checked first; the toast's Undo puts them back", async () => {
  const h = app();
  const { win } = h;
  const a = "workspaces/harbor-map/src/tides.js";
  const b = "workspaces/harbor-map/src/tiles.js";
  const bytes = [a, b].map((p) => fs.readFileSync(FX.v(p)));
  await enter(win, "workspaces/harbor-map/src");
  await item(win, a).click();
  await item(win, b).click({ modifiers: ["Meta"] });
  const crumb = content(win).locator('.aos-fx-crumb[data-path="workspaces/harbor-map"]');
  const held = await hover(win, item(win, a), crumb);
  await expect(crumb).toHaveClass(/is-drop/);
  await expect(hint(win)).toHaveText("Move 2 items to harbor-map");
  await held.end();
  await expect(hint(win)).not.toBeVisible();
  await expect(crumb).not.toHaveClass(/is-drop/);

  await drag(win, item(win, a), crumb);
  await expect.poll(() => [a, b].map((p) => fs.existsSync(FX.v(p.replace("/src/", "/"))))).toEqual([true, true]);
  expect([a, b].map((p) => fs.existsSync(FX.v(p)))).toEqual([false, false]);
  expect(fs.readFileSync(FX.v("workspaces/harbor-map/tides.js")).equals(bytes[0])).toBe(true);
  await expect.poll(() => h.notices.some((n) => n.startsWith("Moved 2 items to harbor-map"))).toBe(true);
  // The tab stays where it was, as Finder does.
  await expect(title(win)).toHaveText("src");
  await win.locator(".notice .aos-fx-undo").last().click();
  await expect.poll(() => [a, b].map((p) => fs.existsSync(FX.v(p)))).toEqual([true, true]);
  expect(fs.readFileSync(FX.v(a)).equals(bytes[0])).toBe(true);
  await expect.poll(() => h.notices.includes("Undid the move of 2 items")).toBe(true);
});

test("a runtime folder refuses a drop and says why; a favorite takes one and says what links it updates", async () => {
  const { win } = app();
  const note = "brain/memory/projects/harbor-map.md";
  await setView(win, "columns");
  await content(win).locator('.aos-fx-si[data-fav=""]').click();
  for (const p of ["brain", "brain/memory", "brain/memory/projects", note]) await item(win, p).click();
  const runtime = item(win, "brain/_index");
  const held = await hover(win, item(win, note), runtime);
  await expect(runtime).toHaveClass(/is-nodrop/);
  await expect(hint(win)).toHaveText("Cannot move here: brain/_index/ is written by the runtime itself");
  await expect(hint(win)).toHaveClass(/is-bad/);
  await held.end();
  await drag(win, item(win, note), runtime);
  expect(fs.existsSync(FX.v(note))).toBe(true);
  expect(fs.readdirSync(FX.v("brain/_index")).includes("harbor-map.md")).toBe(false);

  const fav = content(win).locator('.aos-fx-si[data-fav="workspaces"]');
  const over = await hover(win, item(win, note), fav);
  await expect(fav).toHaveClass(/is-drop/);
  await expect(hint(win)).toHaveText(/^Move harbor-map\.md to workspaces · update [1-9]\d* links?$/);
  await over.end();
  await setView(win, "icons");
});

test("move puts the file in another folder, creating it, and keeps the bytes", async () => {
  const { win } = app();
  const before = fs.readFileSync(FX.v("workspaces/harbor-map/README.md"));
  await enter(win, "workspaces/harbor-map");
  await act(win, "workspaces/harbor-map/README.md", "move");
  await inputs(win).nth(0).fill("archive/2026");
  await expect(note(win)).toHaveText("→ archive/2026/README.md");
  await button(win, "move").click();
  await expect.poll(() => fs.existsSync(FX.v("archive/2026/README.md"))).toBe(true);
  expect(fs.existsSync(FX.v("workspaces/harbor-map/README.md"))).toBe(false);
  expect(fs.readFileSync(FX.v("archive/2026/README.md")).equals(before)).toBe(true);
  // The tab follows the file to its new folder and selects it; ⌘Z puts it back, as it does a drag.
  await expect(title(win)).toHaveText("2026");
  await expect(item(win, "archive/2026/README.md")).toHaveClass(/is-selected/);
  await win.keyboard.press("Meta+z");
  await expect.poll(() => fs.existsSync(FX.v("workspaces/harbor-map/README.md"))).toBe(true);
  expect(fs.existsSync(FX.v("archive/2026/README.md"))).toBe(false);
  expect(fs.readFileSync(FX.v("workspaces/harbor-map/README.md")).equals(before)).toBe(true);
});

test("Move to Trash asks first: Cancel keeps the file; Move to Trash hands it to the Trash", async () => {
  const h = app();
  const { win } = h;
  const file = "workspaces/harbor-map/workspace.md";
  const before = fs.readFileSync(FX.v(file));
  await enter(win, "workspaces/harbor-map");
  await act(win, file, "trash");
  const modal = win.locator(".modal");
  await expect(modal.locator("h3")).toHaveText("Move to the Trash");
  await modal.locator("button", { hasText: "Cancel" }).click();
  await expect(win.locator(".modal")).toHaveCount(0);
  expect(fs.existsSync(FX.v(file))).toBe(true);

  await act(win, file, "trash");
  await win.locator(".modal button.mod-cta", { hasText: "Move to Trash" }).click();
  await expect.poll(() => fs.existsSync(FX.v(file))).toBe(false);
  expect((await h.opened()).filter((o) => o.fn === "trashItem").map((o) => o.arg)).toEqual([path.join(FX.vault, file)]);
  expect(fs.readFileSync(path.join(FX.home, ".Trash", "workspace.md")).equals(before)).toBe(true);
  // No undo: the Trash cannot hand a file back, so the toast says where it is.
  await expect.poll(() => h.notices.includes(`${file} moved to the Trash. To put it back, open the Trash in Finder.`)).toBe(true);
  await expect(win.locator(".notice", { hasText: "moved to the Trash" }).locator(".aos-fx-undo")).toHaveCount(0);
  await expect(item(win, file)).toHaveCount(0);
});

test("a selection goes to the Trash together, after one confirm that names how many; ⌘⌫ asks the same", async () => {
  const h = app();
  const { win } = h;
  const a = "workspaces/harbor-map/src/tides.js";
  const b = "workspaces/harbor-map/src/tiles.js";
  await enter(win, "workspaces/harbor-map/src");
  await item(win, a).click();
  await item(win, b).click({ modifiers: ["Meta"] });
  await win.keyboard.press("Meta+Backspace");
  const modal = win.locator(".modal");
  await expect(modal).toContainText("2 items go to the Trash");
  await modal.locator("button", { hasText: "Cancel" }).click();
  await item(win, b).click({ button: "right" });
  await expect(menuItem(win, "trash")).toHaveText(/Move 2 items to Trash/);
  await menuItem(win, "trash").click();
  await win.locator(".modal button.mod-cta", { hasText: "Move to Trash" }).click();
  await expect.poll(() => [a, b].map((p) => fs.existsSync(FX.v(p)))).toEqual([false, false]);
  expect((await h.opened()).filter((o) => o.fn === "trashItem").map((o) => path.relative(FX.vault, o.arg)).slice(-2)).toEqual([a, b]);
  await expect.poll(() => h.notices.includes("2 items moved to the Trash. To put them back, open the Trash in Finder.")).toBe(true);
});
