// The Files tab, read-only (the harness default), as a Finder window onto the vault (spec 2026-10-17-files-finder):
// Icons at the vault's top level with the runtime's folders locked; entering folders, back and forward and the path
// bar; List and Columns by the switcher and ⌃⌘1–3; List's header and triangles; Columns' preview with the vault index's
// tags and links; Finder's selection and keys; the preview pane; Quick Look; the right-click menu; the Workspace chip;
// search, Open file… and Search vault…; and, with the Files surface off, a new note and a trash refused.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, closeNotes, command, content, drawer, emulateViewport, notePath, openTab, rail, useApp } from "./harness";

const app = useApp();

const view = (win: Page) => content(win).locator(".aos-fx-view");
const item = (win: Page, p: string) => view(win).locator(`[data-path="${p}"]`);
const query = (win: Page) => content(win).locator(".aos-fx-query");
const title = (win: Page) => content(win).locator(".aos-fx-h1");
const status = (win: Page) => content(win).locator(".aos-fx-sel");
const menuItem = (win: Page, act: string) => content(win).locator(`.aos-fx-menu .aos-fx-mi[data-act="${act}"]`);
const setView = async (win: Page, v: "icons" | "list" | "columns") => { await content(win).locator(`.aos-fx-seg button[data-view="${v}"]`).click(); };
const toVault = async (win: Page) => { await content(win).locator('.aos-fx-si[data-fav=""]').click(); };

/** Enters each folder down to `dir` from the vault, by double-clicks in Icons. */
async function enter(win: Page, dir: string): Promise<void> {
  await toVault(win);
  const parts = dir.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    await item(win, p).dblclick();
    await expect(title(win)).toHaveText(parts[i - 1]);
  }
}

/** The vault's top level as the index lists it: no dot-names or dependency folders. */
function topLevel(): { dirs: string[]; files: string[] } {
  const skip = (n: string) => n.startsWith(".") || ["node_modules", "_worktrees", "graphify-out"].includes(n);
  const all = fs.readdirSync(FX.vault, { withFileTypes: true }).filter((e) => !skip(e.name));
  const sorted = (xs: string[]) => xs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return { dirs: sorted(all.filter((e) => e.isDirectory()).map((e) => e.name)), files: sorted(all.filter((e) => e.isFile()).map((e) => e.name)) };
}

test.beforeEach(async () => {
  const { win } = app();
  await closeNotes(win);
  await openTab(win, "files");
  if (await query(win).inputValue()) await query(win).fill("");
  await setView(win, "icons");
  await toVault(win);
});

test("Files opens from the rail on Icons at the vault's top level: folders first, then files; the runtime's folders locked", async () => {
  const { win } = app();
  await expect(rail(win, "files")).toHaveClass(/is-active/);
  await expect(title(win)).toHaveText(path.basename(FX.vault));
  await expect(content(win).locator(".aos-fx-total")).toHaveText(/^[\d,]+ files$/);
  const { dirs, files } = topLevel();
  expect(await view(win).locator('.aos-fx-group[data-group="folders"] .aos-fx-tile-name').allTextContents()).toEqual(dirs);
  const shown = await view(win).locator('.aos-fx-group:not([data-group="folders"]) .aos-fx-tile-name').allTextContents();
  expect([...shown].sort()).toEqual([...files].sort());
  expect(await view(win).locator(".aos-fx-group-head > span:first-child").first().textContent()).toBe("Folders");
  await item(win, "brain").dblclick();
  await expect(item(win, "brain/_index").locator(".aos-fx-lock")).toHaveCount(1);
  await expect(item(win, "brain/scripts").locator(".aos-fx-lock")).toHaveCount(1);
  await expect(item(win, "brain/memory").locator(".aos-fx-lock")).toHaveCount(0);
});

test("a double-click enters a folder or opens a note; back, forward and the path bar move around", async () => {
  const { win } = app();
  await enter(win, "workspaces/harbor-map");
  expect(await view(win).locator(".aos-fx-tile-name").allTextContents()).toEqual(["src", "PLAN.md", "README.md", "workspace.md"]);
  await content(win).locator('button[data-act="back"]').click();
  await expect(title(win)).toHaveText("workspaces");
  // Back to the folder you came out of selects it, as Finder does.
  await expect(item(win, "workspaces/harbor-map")).toHaveClass(/is-selected/);
  await content(win).locator('button[data-act="forward"]').click();
  await expect(title(win)).toHaveText("harbor-map");
  await content(win).locator('.aos-fx-crumb[data-path="workspaces"]').click();
  await expect(title(win)).toHaveText("workspaces");
  await item(win, "workspaces/harbor-map").dblclick();
  await item(win, "workspaces/harbor-map/README.md").dblclick();
  await expect(notePath(win)).toHaveText("workspaces/harbor-map/README.md");
  await closeNotes(win);
  await openTab(win, "files");
  // ⌘↓ opens what is selected, ⌘↑ goes up and selects the folder.
  await item(win, "workspaces/harbor-map/PLAN.md").click();
  await win.keyboard.press("Meta+ArrowDown");
  await expect(notePath(win)).toHaveText("workspaces/harbor-map/PLAN.md");
  await closeNotes(win);
  await openTab(win, "files");
  await item(win, "workspaces/harbor-map/PLAN.md").click();
  await win.keyboard.press("Meta+ArrowUp");
  await expect(title(win)).toHaveText("workspaces");
  await expect(item(win, "workspaces/harbor-map")).toHaveClass(/is-selected/);
});

test("List and Columns come from the switcher and ⌃⌘1–3, and the choice stays when the tab is drawn again", async () => {
  const { win } = app();
  await setView(win, "list");
  await expect(view(win).locator(".aos-fx-list")).toBeVisible();
  await openTab(win, "pulse");
  await openTab(win, "files");
  await expect(content(win).locator('.aos-fx-seg button[data-view="list"]')).toHaveAttribute("aria-pressed", "true");
  await expect(view(win).locator(".aos-fx-list")).toBeVisible();
  await item(win, "brain").click();
  await win.keyboard.press("Control+Meta+3");
  await expect(view(win).locator(".aos-fx-columns")).toBeVisible();
  await win.keyboard.press("Control+Meta+1");
  await expect(view(win).locator(".aos-fx-icons")).toBeVisible();
  // ⌃⌘1–3 are the view's own: the menu's ⌘1–⌘9 (the tabs) never see them, so Files stays in front.
  await expect(rail(win, "files")).toHaveClass(/is-active/);
});

test("List sorts by its header and opens folders in place; → and ← open and close them", async () => {
  const { win } = app();
  await enter(win, "workspaces/harbor-map");
  await setView(win, "list");
  const names = () => view(win).locator(".aos-fx-row .aos-fx-name").allTextContents();
  expect(await names()).toEqual(["src", "PLAN.md", "README.md", "workspace.md"]);
  await view(win).locator('.aos-fx-lh[data-sort="name"]').click();
  await expect(view(win).locator('.aos-fx-lh[data-sort="name"]')).toHaveAttribute("aria-sort", "descending");
  expect(await names()).toEqual(["src", "workspace.md", "README.md", "PLAN.md"]);
  await view(win).locator('.aos-fx-lh[data-sort="name"]').click();
  await expect(view(win).locator('.aos-fx-lh[data-sort="name"]')).toHaveAttribute("aria-sort", "ascending");
  await item(win, "workspaces/harbor-map/src").locator(".aos-fx-twisty").click();
  await expect(item(win, "workspaces/harbor-map/src/tides.js")).toBeVisible();
  await item(win, "workspaces/harbor-map/src").click();
  await win.keyboard.press("ArrowLeft");
  await expect(item(win, "workspaces/harbor-map/src/tides.js")).toHaveCount(0);
  await win.keyboard.press("ArrowRight");
  await expect(item(win, "workspaces/harbor-map/src/tides.js")).toBeVisible();
  await win.keyboard.press("ArrowRight");
  await expect(item(win, "workspaces/harbor-map/src/tides.js")).toHaveClass(/is-selected/);
  await expect(item(win, "workspaces/harbor-map/src/tides.js").locator(".aos-fx-col-kind")).toHaveText("JavaScript");
  await setView(win, "icons");
});

test("Columns open a folder's column on a click and preview a note, with its tags and links from the vault index", async () => {
  const { win } = app();
  await setView(win, "columns");
  for (const p of ["brain", "brain/memory", "brain/memory/projects"]) await item(win, p).click();
  await item(win, "brain/memory/projects/harbor-map.md").click();
  const pv = view(win).locator(".aos-fx-pcol");
  await expect(pv.locator(".aos-fx-pname")).toHaveText("harbor-map.md");
  await expect(pv.locator(".aos-fx-pkind")).toHaveText(/^Markdown note · \d+(\.\d)? (B|KB)$/);
  await expect(pv.locator(".aos-fx-kv", { hasText: "Tags" }).locator(".aos-fx-chip")).toHaveText(["memory/projects", "status/active"]);
  await expect(pv.locator("[data-links]")).toHaveText(/^\d+ out · [1-9]\d* in$/);
  await expect(content(win).locator(".aos-fx-h1")).toHaveText("projects");
  await win.keyboard.press("ArrowLeft");
  await expect(item(win, "brain/memory/projects")).toHaveClass(/is-selected/);
  await win.keyboard.press("ArrowLeft");
  await expect(item(win, "brain/memory")).toHaveClass(/is-selected/);
  await setView(win, "icons");
});

test("selection: a click, ⌘-click and ⇧-click, ⌘A, the arrows and type-ahead; Escape clears it", async () => {
  const { win } = app();
  await enter(win, "workspaces/harbor-map");
  const selected = () => view(win).locator(".is-selected").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path));
  const base = "workspaces/harbor-map";
  await item(win, `${base}/PLAN.md`).click();
  await expect(status(win)).toHaveText("4 items · 1 selected");
  await item(win, `${base}/workspace.md`).click({ modifiers: ["Meta"] });
  expect(await selected()).toEqual([`${base}/PLAN.md`, `${base}/workspace.md`]);
  await item(win, `${base}/src`).click({ modifiers: ["Shift"] });
  expect(await selected()).toEqual([`${base}/src`, `${base}/PLAN.md`, `${base}/README.md`, `${base}/workspace.md`]);
  await win.keyboard.press("Escape");
  expect(await selected()).toEqual([]);
  await item(win, `${base}/src`).click();
  await win.keyboard.press("Meta+a");
  await expect(status(win)).toHaveText("4 items · 4 selected");
  await item(win, `${base}/src`).click();
  await win.keyboard.press("w");
  expect(await selected()).toEqual([`${base}/workspace.md`]);
  await win.keyboard.press("ArrowLeft");
  expect(await selected()).toEqual([`${base}/README.md`]);
  await win.keyboard.press("Shift+ArrowLeft");
  expect(await selected()).toEqual([`${base}/PLAN.md`, `${base}/README.md`]);
});

test("the preview pane (⇧⌘P) shows the selection rendered, and stays on until it is turned off", async () => {
  const { win } = app();
  await enter(win, "workspaces/harbor-map");
  await item(win, "workspaces/harbor-map/README.md").click();
  const pane = content(win).locator(".aos-fx-pane");
  await expect(pane).not.toHaveClass(/is-shown/);
  await win.keyboard.press("Shift+Meta+P");
  await expect(pane).toHaveClass(/is-shown/);
  await expect(pane.locator(".aos-fx-pname")).toHaveText("README.md");
  await expect(pane.locator(".aos-fx-md h1")).toHaveText("Harbor Map");
  await item(win, "workspaces/harbor-map/src").click();
  await expect(pane.locator(".aos-fx-pkind")).toHaveText("Folder · 2 items");
  await openTab(win, "pulse");
  await openTab(win, "files");
  await expect(content(win).locator(".aos-fx-pane")).toHaveClass(/is-shown/);
  await content(win).locator('button[data-act="preview"]').click();
  await expect(content(win).locator(".aos-fx-pane")).not.toHaveClass(/is-shown/);
});

test("Quick Look: Space shows the note, ← → walk the folder, Escape closes it on that item; an image shows as an image", async () => {
  const { win } = app();
  // A one-pixel PNG, written into the fixture the way any app would, so the vault's watcher lists it.
  const png = FX.v("workspaces/harbor-map/chart.png");
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  try {
    await enter(win, "workspaces/harbor-map");
    await expect(item(win, "workspaces/harbor-map/chart.png")).toBeVisible();
    await item(win, "workspaces/harbor-map/README.md").click();
    await win.keyboard.press(" ");
    const ql = content(win).locator(".aos-fx-qlpanel");
    await expect(ql).toHaveAttribute("aria-label", "Quick Look: README.md");
    await expect(ql.locator(".aos-fx-md h1")).toHaveText("Harbor Map");
    await win.keyboard.press("ArrowRight");
    await expect(ql).toHaveAttribute("aria-label", "Quick Look: workspace.md");
    await win.keyboard.press("Escape");
    await expect(ql).toHaveCount(0);
    await expect(item(win, "workspaces/harbor-map/workspace.md")).toHaveClass(/is-selected/);
    await item(win, "workspaces/harbor-map/chart.png").click();
    await win.keyboard.press(" ");
    await expect(content(win).locator(".aos-fx-qlimg")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await win.keyboard.press(" ");
    await expect(content(win).locator(".aos-fx-qlpanel")).toHaveCount(0);
  } finally {
    fs.rmSync(png, { force: true });
  }
});

test("the right-click menu: what it offers, its write items off in the runtime's folders with the reason; Reveal goes to the OS", async () => {
  const h = app();
  const { win } = h;
  await enter(win, "workspaces/harbor-map");
  await item(win, "workspaces/harbor-map/README.md").click({ button: "right" });
  expect(await content(win).locator(".aos-fx-menu .aos-fx-mi .aos-fx-mlabel").allTextContents()).toEqual([
    "Open", "Quick Look", "Rename", "Move to…", "Duplicate", "New note here…", "New folder", "Copy path", "Copy as [[link]]", "Reveal in Finder",
    "Open with default app", "Move to Trash",
  ]);
  await win.keyboard.press("Escape");
  await expect(content(win).locator(".aos-fx-menu")).toHaveCount(0);
  // brain holds the runtime's folders: it is not renamed, moved or trashed whole (main's canMoveTree), but a note can go in it.
  await content(win).locator('.aos-fx-si[data-fav=""]').click();
  await item(win, "brain").click({ button: "right" });
  for (const act of ["rename", "move", "trash"]) {
    await expect(menuItem(win, act)).toBeDisabled();
    await expect(menuItem(win, act)).toHaveAttribute("title", "brain holds brain/_index/, which the runtime writes itself");
  }
  for (const act of ["new-note", "new-folder", "duplicate"]) await expect(menuItem(win, act)).toBeEnabled();
  await win.keyboard.press("Escape");
  await enter(win, "brain/_index");
  await item(win, "brain/_index/BRAIN.md").click({ button: "right" });
  for (const act of ["rename", "move", "duplicate", "new-note", "new-folder", "trash"]) {
    await expect(menuItem(win, act)).toBeDisabled();
    await expect(menuItem(win, act)).toHaveAttribute("title", "brain/_index/ is written by the runtime itself");
  }
  const before = (await h.opened()).length;
  await menuItem(win, "reveal").click();
  await expect.poll(async () => (await h.opened()).slice(before).map((o) => [o.fn, path.relative(FX.vault, o.arg)])).toEqual([["showItemInFolder", "brain/_index/BRAIN.md"]]);
});

test("a workspace folder offers Open in Spaces, which shows that workspace there", async () => {
  const { win } = app();
  await enter(win, "workspaces/harbor-map");
  await content(win).locator('button[data-act="open-space"]').click();
  await expect(rail(win, "spaces")).toHaveClass(/is-active/);
  await openTab(win, "files");
  await toVault(win);
  await expect(content(win).locator('button[data-act="open-space"]')).toHaveCount(0);
});

test("a change elsewhere in the vault leaves the view alone; a change in the folder on screen shows at once", async () => {
  const { win } = app();
  await enter(win, "workspaces/harbor-map");
  await item(win, "workspaces/harbor-map/README.md").click();
  // A mark on the drawn tile: a redraw would replace the element and lose it (a redraw between the two clicks of a
  // double-click loses the double-click).
  const marked = () => item(win, "workspaces/harbor-map/README.md").evaluate((el) => (el as unknown as { __mark?: number }).__mark ?? 0);
  await item(win, "workspaces/harbor-map/README.md").evaluate((el) => { (el as unknown as { __mark: number }).__mark = 1; });
  const elsewhere = FX.v("brain/_index/zz-elsewhere.json");
  const here = FX.v("workspaces/harbor-map/zz-here.md");
  try {
    // Kept until after the wait: the watcher looks at the file when it reports it, and a file already gone is no event.
    fs.writeFileSync(elsewhere, "{}\n");
    await win.waitForTimeout(900);
    expect(await marked()).toBe(1);
    fs.writeFileSync(here, "# Here\n");
    await expect(item(win, "workspaces/harbor-map/zz-here.md")).toBeVisible();
    await expect(item(win, "workspaces/harbor-map/README.md")).toHaveClass(/is-selected/);
  } finally {
    fs.rmSync(elsewhere, { force: true });
    fs.rmSync(here, { force: true });
  }
});

test("under 900 px the sidebar folds into the toolbar's sidebar button, and a pick folds it again", async () => {
  const { win } = app();
  const side = content(win).locator(".aos-fx-side");
  const toggle = content(win).locator(".aos-fx-sidetoggle");
  await expect(side).toBeVisible();
  await expect(toggle).toBeHidden();
  const undo = await emulateViewport(win, { width: 860, height: 760 });
  try {
    await expect(side).toBeHidden();
    // The tour's Favorites step still finds a control: the sidebar's button (CI's smaller screen folds the sidebar).
    const probe = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { tour: { probe(id: string, ms: number): Promise<Array<{ ref: string; status: string }>> } } } }).aosHost.plugin.tour.probe("files", 3000));
    expect(probe.filter((r) => r.status !== "found")).toEqual([]);
    await toggle.click();
    await expect(side).toBeVisible();
    await content(win).locator('.aos-fx-si[data-fav="brain"]').click();
    await expect(title(win)).toHaveText("brain");
    await expect(side).toBeHidden();
  } finally {
    await undo();
  }
});

test("search finds lines across notes and highlights the hit; a line opens its note; every text file on request", async () => {
  const { win } = app();
  await query(win).fill("tide");
  await expect(content(win).locator(".aos-fx-summary")).toHaveText(/^\d+ lines? in \d+ files? · \d+ searched$/);
  const hit = content(win).locator('.aos-fx-hit[data-hit="brain/memory/reference/tide-api-notes.md"]');
  await expect(hit).toBeVisible();
  await expect(hit.locator(".aos-fx-mark").first()).toHaveText(/^tide$/i);
  await expect(content(win).locator('.aos-fx-hit[data-hit="workspaces/harbor-map/src/tides.js"]')).toHaveCount(0);
  await content(win).locator(".aos-fx-scope input").check();
  await expect(content(win).locator('.aos-fx-hit[data-hit="workspaces/harbor-map/src/tides.js"]')).toBeVisible();
  await content(win).locator(".aos-fx-scope input").uncheck();
  await hit.locator(".aos-fx-line").first().click();
  await expect(notePath(win)).toHaveText("brain/memory/reference/tide-api-notes.md");
  await closeNotes(win);
  await openTab(win, "files");
  // Escape clears the search and the folder is back.
  await query(win).press("Escape");
  await expect(view(win).locator(".aos-fx-icons")).toBeVisible();
  await query(win).fill("no such words anywhere in the vault");
  await expect(content(win).locator(".aos-fx-summary")).toHaveText(/^No matches in \d+ files$/);
  await query(win).fill("");
});

test("Open file… matches paths fuzzily, Markdown first, and opens the choice; ⋯ offers it too", async () => {
  const { win } = app();
  await content(win).locator('button[data-act="more"]').click();
  await expect(menuItem(win, "open-file")).toBeVisible();
  await win.keyboard.press("Escape");
  expect(await command(win, "agentic-os:open-file")).toBe(true);
  const input = win.locator(".modal.prompt .prompt-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("placeholder", /^Open a file \(\d+ in the vault\)…$/);
  await input.fill("harbor plan");
  const first = win.locator(".modal.prompt .suggestion-item").first();
  await expect(first.locator(".aos-omni-label")).toHaveText("PLAN.md");
  await expect(first.locator(".aos-omni-hint")).toHaveText("workspaces/harbor-map");
  await input.press("Enter");
  await expect(notePath(win)).toHaveText("workspaces/harbor-map/PLAN.md");
});

test("Search vault… opens Files with the cursor in the search box; ⌘F does the same inside Files", async () => {
  const { win } = app();
  await openTab(win, "pulse");
  expect(await command(win, "agentic-os:search-vault")).toBe(true);
  await expect(rail(win, "files")).toHaveClass(/is-active/);
  await expect(query(win)).toBeFocused();
  await item(win, "brain").click();
  await win.keyboard.press("Meta+f");
  await expect(query(win)).toBeFocused();
});

test("with the Files surface off, a new note is refused and a trash refused: nothing written, nothing sent to the OS", async () => {
  const h = app();
  const { win } = h;
  const before = (await h.guard()).length;
  await content(win).locator('button[data-act="new"]').click();
  await menuItem(win, "new-note").click();
  const d = drawer(win);
  await expect(d.locator(".aos-wb-drawertitle")).toHaveText("New note");
  const [folder, name] = [d.locator(".aos-rt-input").nth(0), d.locator(".aos-rt-input").nth(1)];
  // The name first: the folder field has a suggestion list, and leaving it with the list open can commit a suggestion.
  await name.fill("first idea");
  await folder.fill("inbox");
  await expect(d.locator(".aos-rt-errors")).toHaveText("→ inbox/first idea.md");
  await d.locator(".aos-capture-actions button", { hasText: "create" }).click();
  await expect(d.locator(".aos-rt-errors")).toHaveText(/^Not done: /);
  expect(fs.existsSync(FX.v("inbox/first idea.md"))).toBe(false);
  await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();

  await enter(win, "workspaces/harbor-map");
  await item(win, "workspaces/harbor-map/PLAN.md").click({ button: "right" });
  await menuItem(win, "trash").click();
  await win.locator(".modal button.mod-cta", { hasText: "Move to Trash" }).click();
  await expect.poll(() => h.notices.some((n) => n.startsWith("Not moved to the Trash: "))).toBe(true);
  expect(fs.existsSync(FX.v("workspaces/harbor-map/PLAN.md"))).toBe(true);
  expect((await h.opened()).filter((o) => o.fn === "trashItem")).toEqual([]);
  const refused = (await h.guard()).slice(before).filter((e) => e.kind === "write");
  expect(refused.length).toBeGreaterThanOrEqual(2);
  expect(fs.existsSync(path.join(FX.home, ".Trash"))).toBe(false);
});

test("the new-note form defers nothing: a field filled at once keeps its text, however late the page's timers run", async () => {
  const { win } = app();
  // fill() is a focus and a select-all, then the typing. Hold this page's zero-delay timers, as a loaded runner can,
  // and run them in between: a focus the form deferred to one would move the folder's typing into the name field.
  await content(win).locator('button[data-act="new"]').click();
  await win.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const real = window.setTimeout.bind(window);
    const held: (() => void)[] = [];
    w.__held = held;
    w.__setTimeout = window.setTimeout;
    w.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms) return real(fn, ms, ...args);
      held.push(() => fn(...args));
      return 0;
    };
  });
  const d = drawer(win);
  try {
    await menuItem(win, "new-note").click();
    await expect(d.locator(".aos-wb-drawertitle")).toHaveText("New note");
    const [folder, name] = [d.locator(".aos-rt-input").nth(0), d.locator(".aos-rt-input").nth(1)];
    await name.fill("first idea");
    await folder.focus();
    await folder.selectText();
    await win.evaluate(() => { for (const f of ((window as unknown as Record<string, unknown>).__held as (() => void)[]).splice(0)) f(); });
    await win.keyboard.insertText("inbox");
    await expect(d.locator(".aos-rt-errors")).toHaveText("→ inbox/first idea.md");
  } finally {
    await win.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.setTimeout = w.__setTimeout;
      for (const f of (w.__held as (() => void)[]).splice(0)) f();
      delete w.__setTimeout;
      delete w.__held;
    });
  }
  await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  expect(fs.existsSync(FX.v("inbox/first idea.md"))).toBe(false);
});
