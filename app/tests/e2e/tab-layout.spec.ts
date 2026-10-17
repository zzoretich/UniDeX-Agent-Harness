import { expect, test, type Page } from "@playwright/test";
import { RAIL_ORDER, content, emulateViewport, openTab, resizeHud, useApp } from "./harness";

// Every tab draws into one content area. A tab must never leave its own layout on it for the next one: in 1.4.0 the Term
// deck's classes (aos-term, aos-term-deck: a row) stayed after a visit to Term, and every tab after it was laid out in a
// row until the app restarted. Read-only.

const app = useApp();
const C = () => content(app().win);
const box = async (win: Page, selector: string) => {
  const b = await content(win).locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
};

test("after Code and Agent Teams, the content area carries none of their classes", async () => {
  const { win } = app();
  await openTab(win, "agent-teams");
  await openTab(win, "term");
  // Sessions (chat) is on the rail only with a model provider; variants.spec.ts covers it.
  for (const t of RAIL_ORDER.filter((x) => x !== "term" && x !== "agent-teams" && x !== "chat")) {
    await openTab(win, t);
    const cls = ((await C().getAttribute("class")) ?? "").split(/\s+/);
    expect(cls, t).toContain("aos-wb-content");
    expect(cls.filter((c) => c.startsWith("aos-term") || c === "aos-at"), t).toEqual([]);
  }
});

test("after a visit to Code, the tabs keep their layout: lists beside their reading panes, toolbars above their lists", async () => {
  const { win } = app();
  await openTab(win, "term");

  // Notifications and Proposals: the list on the left, the reading pane beside it, both under the head.
  for (const t of ["notifications", "proposals"]) {
    await openTab(win, t);
    const list = await box(win, ".aos-split-list");
    const pane = await box(win, ".aos-split-detail");
    expect(list.x + list.width).toBeLessThanOrEqual(pane.x + 1);
    expect(Math.abs(list.y - pane.y)).toBeLessThan(8);
  }

  // Files (files-finder D6): the sidebar on the left, the toolbar above the view, both beside it.
  await openTab(win, "files");
  const side = await box(win, ".aos-fx-side");
  const bar = await box(win, ".aos-fx-bar");
  const view = await box(win, ".aos-fx-view");
  expect(side.x + side.width).toBeLessThanOrEqual(view.x + 1);
  expect(bar.y + bar.height).toBeLessThanOrEqual(view.y + 1);
  expect(Math.abs(bar.x - view.x)).toBeLessThan(2);

  // To-Do: one list, every row starting at the same left edge.
  await openTab(win, "todo");
  const xs = await C().locator(".aos-td-row").evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().x)));
  expect(xs.length).toBeGreaterThan(2);
  expect(new Set(xs).size).toBe(1);

  // Agent Teams: the team switch above the board.
  await openTab(win, "agent-teams");
  const teams = await box(win, ".aos-at-teams");
  const board = await box(win, ".aos-at-board");
  expect(teams.y + teams.height).toBeLessThanOrEqual(board.y + 1);
});

test("after a visit to Code, Spaces keeps its three panes side by side, and below 1100 px folds the right pane under the dossier (spaces-redesign D3)", async () => {
  const h = app();
  const { win } = h;
  await openTab(win, "term");
  await openTab(win, "spaces");
  await expect(C().locator(".aos-spc-right .aos-spc-history")).toBeVisible();
  const noSideScroll = () => C().evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  // 1480 px is wider than CI's screen, which the window cannot outgrow: the wide layout is measured in an emulated viewport.
  let undo = await emulateViewport(win, { width: 1480, height: 920 });
  try {
    // The list (≈260 px) · the dossier (flex) · the right pane (≈300 px), on one row under nothing.
    const list = await box(win, ".aos-spc-list");
    const centre = await box(win, ".aos-spc-centre");
    const right = await box(win, ".aos-spc-right");
    expect(list.x + list.width).toBeLessThanOrEqual(centre.x + 1);
    expect(centre.x + centre.width).toBeLessThanOrEqual(right.x + 1);
    expect(Math.abs(list.y - centre.y)).toBeLessThan(2);
    expect(Math.abs(centre.y - right.y)).toBeLessThan(2);
    expect(list.width).toBeGreaterThanOrEqual(240);
    expect(list.width).toBeLessThanOrEqual(300);
    expect(right.width).toBeGreaterThanOrEqual(260);
    expect(right.width).toBeLessThanOrEqual(340);
    expect(centre.width).toBeGreaterThan(right.width);
    expect(await noSideScroll()).toBe(true);
    // The dossier's actions sit on the left, not spread across the header.
    const head = await box(win, ".aos-spc-head");
    const acts = await box(win, ".aos-spc-actions");
    expect(acts.x - head.x).toBeLessThan(40);
  } finally {
    await undo();
  }
  try {
    // The window's narrowest (its minWidth, 960 px) is under 1100: HISTORY and LINKED move under the dossier, the list
    // stays at the left. The 760 px step (the list above) is below what the app's window allows.
    await resizeHud(h.app, { width: 960, height: 700 });
    await expect.poll(async () => {
      const c = await box(win, ".aos-spc-centre");
      const r = await box(win, ".aos-spc-right");
      return r.y >= c.y + c.height - 1 && Math.abs(r.x - c.x) < 2;
    }).toBe(true);
    const l = await box(win, ".aos-spc-list");
    const c = await box(win, ".aos-spc-centre");
    expect(l.x + l.width).toBeLessThanOrEqual(c.x + 1);
    expect(await noSideScroll()).toBe(true);
  } finally {
    await resizeHud(h.app, { width: 1480, height: 920 });
  }
  undo = await emulateViewport(win, { width: 1480, height: 920 });
  try {
    await expect.poll(async () => (await box(win, ".aos-spc-right")).y - (await box(win, ".aos-spc-centre")).y).toBeLessThan(2);
  } finally {
    await undo();
  }
});
