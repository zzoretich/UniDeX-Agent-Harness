// The Files tab with its write surface on (AOS_APP_WRITE=files): a new note in a new folder, opened at once and
// selected in its folder; the form's refusals; rename and move from the right-click menu keeping the bytes; and the
// Trash, for one file or a selection, only after a confirm. Every write is the surface's own: the guard refuses nothing.

import { expect, test, type Page } from "@playwright/test";
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

test("rename keeps the folder, the extension and the bytes", async () => {
  const { win } = app();
  const before = fs.readFileSync(FX.v("workspaces/harbor-map/PLAN.md"));
  await enter(win, "workspaces/harbor-map");
  await act(win, "workspaces/harbor-map/PLAN.md", "rename");
  await expect(drawer(win).locator(".aos-wb-drawertitle")).toHaveText("Rename");
  await inputs(win).nth(0).fill("ROADMAP");
  await expect(note(win)).toHaveText("→ workspaces/harbor-map/ROADMAP.md");
  await button(win, "rename").click();
  await expect.poll(() => fs.existsSync(FX.v("workspaces/harbor-map/ROADMAP.md"))).toBe(true);
  expect(fs.existsSync(FX.v("workspaces/harbor-map/PLAN.md"))).toBe(false);
  expect(fs.readFileSync(FX.v("workspaces/harbor-map/ROADMAP.md")).equals(before)).toBe(true);
  await expect(item(win, "workspaces/harbor-map/ROADMAP.md")).toHaveClass(/is-selected/);
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
  // The tab follows the file to its new folder and selects it.
  await expect(title(win)).toHaveText("2026");
  await expect(item(win, "archive/2026/README.md")).toHaveClass(/is-selected/);
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
  await expect.poll(() => h.notices.includes(`${file} moved to the Trash`)).toBe(true);
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
  await expect.poll(() => h.notices.includes("2 items moved to the Trash")).toBe(true);
});
