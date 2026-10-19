// To-Do with its write surface on (AOS_APP_WRITE=todo), the rows of app-smoke: To-Do. Quick-add, tick and
// untick, edit, priority, due date and delete write TODO.md byte for byte as the HUD's model says; a missing TODO.md is
// created from the template; the stale-write guard keeps two HUDs honest; every other surface stays refused.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TODO_TEMPLATE } from "../../../hud/src/data/todos";
import { FX, badge, closeNotes, content, day, expected, guardWrites, openTab, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "todo" } });

const FILE = FX.v("TODO.md");
const pristine = (): string => fs.readFileSync(path.join(FX.pristine, "vault", "TODO.md"), "utf8");
const onDisk = (): string => fs.readFileSync(FILE, "utf8");
const td = (win: Page) => content(win);
const row = (win: Page, text: string) => td(win).locator(".aos-td-row", { has: win.locator(".aos-td-text", { hasText: text }) });
const count = (win: Page) => td(win).locator(".aos-rt-count");
/** The fixture's today, read when a test runs (restoreFixture may have built it again since this file loaded). */
const T = (): string => day(0);

/** The fixture's today item with its child line, as it sits in ## Open. */
const REVIEW = (): string => `- [ ] Review the tide parser PR 🔼 📅 ${T()} #harbor\n    - bring the three open review comments\n`;
const LAST_OPEN = "- [ ] Sort the old survey photos 🔽\n";

/** What ticking `line` (an open item line plus any children) writes: out of ## Open, to the top of ## Done. */
function ticked(text: string, block: string): string {
  const [first, ...children] = block.split("\n");
  const done = [`${first.replace("- [ ] ", "- [x] ")} ✅ ${T()}`, ...children].join("\n");
  return text.replace(block, "").replace("## Done\n", `## Done\n${done}`);
}

/**
 * How long a write made outside the app may take to reach the tab: FSEvents batches it, the watcher adds 40 ms and the
 * tab's debounce 250 ms, but a busy CI runner can hold the event for seconds (main's ci, 2026-10-12: still unseen after
 * the 3 s this file allowed). The Brain specs wait as long for the same watcher.
 */
const WATCHED = 10_000;
/** How late the reproduction delivers an outside write's event: well past the 3 s an earlier budget allowed. */
const LATE_EVENT_MS = 5000;

/** Hold back the vault's events (the watcher's feed into the page), as a slow file watcher does. */
async function holdVaultEvents(win: Page): Promise<void> {
  await win.evaluate(() => {
    const v = (window as unknown as { aosHost: { app: { vault: Record<string, unknown> } } }).aosHost.app.vault;
    v.__trigger = v.trigger;
    v.trigger = () => undefined;
  });
}

/**
 * Let events through again `ms` from now (in the page, so the wait overlaps the test's own) and deliver the held change
 * to `rel`, late; `rel` null lets them through at once with nothing delivered (a test's cleanup).
 */
async function releaseVaultEventsAfter(win: Page, rel: string | null, ms: number): Promise<void> {
  await win.evaluate(([p, wait]) => {
    const v = (window as unknown as { aosHost: { app: { vault: Record<string, unknown> & { getAbstractFileByPath(p: string): unknown } } } }).aosHost.app.vault;
    const release = (): void => {
      if (!v.__trigger) return;
      v.trigger = v.__trigger;
      delete v.__trigger;
      if (p) (v.trigger as (name: string, f: unknown) => void).call(v, "modify", v.getAbstractFileByPath(p));
    };
    if (wait > 0) window.setTimeout(release, wait); else release();
  }, [rel, ms] as const);
}

/** How long the tab must go without a redraw to count as settled: past the watcher's batch and the tab's debounce. */
const QUIET_MS = 750;

/**
 * Waits until the To-Do tab has gone QUIET_MS without a redraw, so a TODO.md event still on its way (the restore below, or
 * an earlier test's write seen late) lands before a test starts rather than in the middle of it. A redraw no longer
 * replaces an open editor, but a test should still start from a tab that has stopped moving.
 */
async function settled(win: Page): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await win.evaluate(() => document.querySelector(".aos-wb-content .aos-rt-head")?.setAttribute("data-quiet", ""));
    await win.waitForTimeout(QUIET_MS);
    if (await td(win).locator(".aos-rt-head[data-quiet]").count()) return;
  }
  throw new Error("the To-Do tab kept redrawing");
}

test.beforeEach(async () => {
  const { win } = app();
  const e = expected().todo;
  if (onDisk() !== pristine()) fs.writeFileSync(FILE, pristine());
  await openTab(win, "todo");
  await expect(count(win)).toHaveText(`${e.open} open · ${e.overdue} overdue · ${e.today} today`);
  await settled(win);
});

test.afterEach(async () => {
  // Every write in this file is To-Do's own: nothing may have been refused on the way.
  expect(await guardWrites(app())).toEqual([]);
});

test("To-Do is the one surface on: the status bar names it and what it writes", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: To-Do");
  await expect(mode).toHaveClass(/is-writing/);
  await expect(mode).toHaveAttribute("title", /^To-Do: TODO\.md\n/);
  const info = await win.evaluate(() => (window as unknown as { aosHost: { info: { writeSurfaces: string[]; writeSource: string } } }).aosHost.info);
  expect(info).toMatchObject({ writeSurfaces: ["todo"], writeSource: "AOS_APP_WRITE" });
});

test("quick-add appends to the end of ## Open with priority and date, and clears the row (T2)", async () => {
  const { win } = app();
  const e = expected().todo;
  const input = td(win).locator("input.aos-td-input");
  await input.fill("Pay the mooring fee #harbor");
  await td(win).locator(".aos-td-add select.aos-td-prio").selectOption("high");
  await td(win).locator(".aos-td-add input.aos-td-date").fill(T());
  await input.press("Enter");
  // Priority goes on the end; the date after it, since the tag is not the body's last token.
  const first = `- [ ] Pay the mooring fee #harbor ⏫ 📅 ${T()}\n`;
  await expect.poll(onDisk).toBe(pristine().replace(LAST_OPEN, `${LAST_OPEN}${first}`));
  await expect(td(win).locator("input.aos-td-input")).toHaveValue("");
  await expect(td(win).locator(".aos-td-add select.aos-td-prio")).toHaveValue("");
  await expect(td(win).locator(".aos-td-add input.aos-td-date")).toHaveValue("");
  await expect(count(win)).toHaveText(`${e.open + 1} open · ${e.overdue} overdue · ${e.today + 1} today`);
  await expect(badge(win, "todo")).toHaveText(String(e.badge + 1));
  // ⏫ sorts first in TODAY.
  await expect(td(win).locator(".aos-rt-table").nth(1).locator(".aos-td-text").first()).toHaveText("Pay the mooring fee");

  await td(win).locator("input.aos-td-input").fill("Check the bilge pump");
  await td(win).locator(".aos-td-add button", { hasText: "+ add" }).click();
  await expect.poll(onDisk).toBe(pristine().replace(LAST_OPEN, `${LAST_OPEN}${first}- [ ] Check the bilge pump\n`));
  await expect(row(win, "Check the bilge pump")).toBeVisible();
});

test("ticking moves the item and its child line to the top of ## Done with today's date; unticking brings it back (T4)", async () => {
  const { win } = app();
  const e = expected().todo;
  await row(win, "Review the tide parser PR").locator(".aos-td-check").click();
  await expect.poll(onDisk).toBe(ticked(pristine(), REVIEW()));
  await expect(count(win)).toHaveText(`${e.open - 1} open · ${e.overdue} overdue · ${e.today - 1} today`);
  await expect(badge(win, "todo")).toHaveText(String(e.badge - 1));

  const head = td(win).locator(".aos-rt-subhead", { hasText: "DONE THIS WEEK" });
  await expect(head).toHaveText(`▸ DONE THIS WEEK (${e.doneThisWeek + 1})`);
  await head.click();
  const done = row(win, "Review the tide parser PR");
  await expect(done).toHaveClass(/is-done/);
  await expect(done.locator(".aos-td-when")).toHaveText(`✅ ${T()}`);
  await done.locator(".aos-td-check").click();
  // Unticked items go to the end of ## Open, without their ✅ date.
  await expect.poll(onDisk).toBe(pristine().replace(REVIEW(), "").replace(LAST_OPEN, `${LAST_OPEN}${REVIEW()}`));
  await expect(count(win)).toHaveText(`${e.open} open · ${e.overdue} overdue · ${e.today} today`);
  await td(win).locator(".aos-rt-subhead", { hasText: "DONE THIS WEEK" }).click();
});

test("edit saves on Enter; the priority button cycles; the date picker sets 📅; ✕ asks first (T5)", async () => {
  const { win } = app();
  await row(win, "Draft the release notes").locator(".aos-td-text").dblclick();
  const edit = td(win).locator("input.aos-td-edit");
  await expect(edit).toHaveValue(`Draft the release notes 📅 ${day(1)} #harbor`);
  await expect(edit).toBeFocused();
  await edit.fill(`Draft the release notes for 0.22 📅 ${day(1)} #harbor`);
  await edit.press("Enter");
  let want = pristine().replace(`- [ ] Draft the release notes 📅 ${day(1)} #harbor`, `- [ ] Draft the release notes for 0.22 📅 ${day(1)} #harbor`);
  await expect.poll(onDisk).toBe(want);
  await expect(td(win).locator("input.aos-td-edit")).toHaveCount(0);

  // · → ⏫, placed before the date as the Tasks plugin expects.
  await row(win, "File the quarterly notes").locator(".aos-td-prio-btn").click();
  want = want.replace(`- [ ] File the quarterly notes 📅 ${day(-1)} #admin`, `- [ ] File the quarterly notes ⏫ 📅 ${day(-1)} #admin`);
  await expect.poll(onDisk).toBe(want);
  await expect(row(win, "File the quarterly notes").locator(".aos-td-prio-btn")).toHaveText("⏫");

  // A due date goes before trailing tags; the item moves from SOMEDAY to UPCOMING.
  await row(win, "Read the field guide").locator("input.aos-td-date").fill(day(3));
  want = want.replace("- [ ] Read the field guide #reading", `- [ ] Read the field guide 📅 ${day(3)} #reading`);
  await expect.poll(onDisk).toBe(want);
  await expect(td(win).locator(".aos-rt-subhead", { hasText: "UPCOMING" })).toHaveText(`UPCOMING (${expected().todo.upcoming + 1})`);

  await row(win, "Sort the old survey photos").locator(".aos-td-del").click();
  const modal = win.locator(".modal");
  await expect(modal.locator("h3")).toHaveText("Delete todo?");
  await expect(modal.locator("p")).toContainText('"Sort the old survey photos" will be removed from TODO.md.');
  await modal.locator("button", { hasText: "Cancel" }).click();
  await expect(modal).toHaveCount(0);
  expect(onDisk()).toBe(want);
  await row(win, "Sort the old survey photos").locator(".aos-td-del").click();
  await win.locator(".modal button.mod-cta", { hasText: "Delete" }).click();
  await expect.poll(onDisk).toBe(want.replace(LAST_OPEN, ""));
  await expect(row(win, "Sort the old survey photos")).toHaveCount(0);
});

test("the inline editor defers nothing: typing over a select-all replaces the text, however late the page's timers run", async () => {
  const { win } = app();
  // fill() is a select-all and then the typing, two steps. Hold this page's zero-delay timers, as a loaded runner
  // can, and run them in between: a caret move the editor deferred to one would collapse the selection, and the
  // new text would be appended to the old.
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
  const text = `Draft the release notes for 0.22 📅 ${day(1)} #harbor`;
  try {
    await row(win, "Draft the release notes").locator(".aos-td-text").dblclick();
    const edit = td(win).locator("input.aos-td-edit");
    await edit.selectText();
    await win.evaluate(() => { for (const f of ((window as unknown as Record<string, unknown>).__held as (() => void)[]).splice(0)) f(); });
    await win.keyboard.insertText(text);
    await expect(edit).toHaveValue(text);
  } finally {
    await win.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.setTimeout = w.__setTimeout;
      for (const f of (w.__held as (() => void)[]).splice(0)) f();
      delete w.__setTimeout;
      delete w.__held;
    });
  }
  await td(win).locator("input.aos-td-edit").press("Escape");
  await expect(td(win).locator("input.aos-td-edit")).toHaveCount(0);
  expect(onDisk()).toBe(pristine());
});

// Any TODO.md event (an agent, a hook, `aos todo`, a sync, or this tab's own write seen late) redraws the tab. While a todo
// is being edited the redraw goes on around the editor: the box is the same element, with its text, selection and focus,
// so nothing typed or about to be typed into it is lost (the race behind the inline editor's select-all failing as
// "not attached to the DOM"). The redraw is forced here, through the watcher's own path, twice.
test("a redraw while a todo is being edited keeps the editor itself: same box, text, selection and focus", async () => {
  const { win } = app();
  await row(win, "Draft the release notes").locator(".aos-td-text").dblclick();
  const edit = td(win).locator("input.aos-td-edit");
  await expect(edit).toBeFocused();
  await edit.selectText();
  await win.keyboard.insertText("Draft the release notes for 0.22");
  const box = await edit.elementHandle();
  await box!.evaluate((el: HTMLInputElement) => el.setSelectionRange(6, 17));
  for (let i = 0; i < 2; i++) {
    // The vault's own modify event for TODO.md, as the watcher delivers it; the head is marked so its redraw shows.
    await win.evaluate(() => {
      const host = (window as unknown as { aosHost: { app: { vault: { trigger(n: string, f: unknown): void; getAbstractFileByPath(p: string): unknown } } } }).aosHost;
      document.querySelector(".aos-wb-content .aos-rt-head")?.setAttribute("data-before-redraw", "");
      host.app.vault.trigger("modify", host.app.vault.getAbstractFileByPath("TODO.md"));
    });
    await expect(td(win).locator(".aos-rt-head[data-before-redraw]")).toHaveCount(0);
    expect(await box!.evaluate((el: HTMLInputElement) => ({ attached: el.isConnected, value: el.value, start: el.selectionStart, end: el.selectionEnd, focused: document.activeElement === el })))
      .toEqual({ attached: true, value: "Draft the release notes for 0.22", start: 6, end: 17, focused: true });
  }
  await expect(edit).toHaveCount(1);
  // Typing goes on in the same box: the selection is replaced.
  await win.keyboard.insertText("NOTES");
  await expect(edit).toHaveValue("Draft NOTES notes for 0.22");
  await edit.press("Escape");
  await expect(edit).toHaveCount(0);
  expect(onDisk()).toBe(pristine());
});

test("the todo being edited changes in TODO.md underneath: nothing overwrites it, and the tab says the edit was not saved", async () => {
  const h = app();
  const { win } = h;
  await row(win, "Draft the release notes").locator(".aos-td-text").dblclick();
  const edit = td(win).locator("input.aos-td-edit");
  await edit.selectText();
  await win.keyboard.insertText("Draft the release notes for 0.22");
  // Another writer changes that very line (its due date) while this one is typing.
  const theirs = pristine().replace(`- [ ] Draft the release notes 📅 ${day(1)} #harbor`, `- [ ] Draft the release notes 📅 ${day(2)} #harbor`);
  const n = h.notices.length;
  fs.writeFileSync(FILE, theirs);
  await expect(edit).toHaveCount(0, { timeout: WATCHED });
  await expect.poll(() => h.notices.slice(n)).toEqual(['That todo changed in TODO.md while you were editing it, so your edit was not saved: "Draft the release notes for 0.22".']);
  await expect(row(win, "Draft the release notes")).toBeVisible();
  expect(onDisk()).toBe(theirs);
});

test("a tick made in the other HUD shows here while the tab is open, and the next edit applies to the new text", async () => {
  const { win } = app();
  const e = expected().todo;
  // What the Obsidian HUD (or /todo) writes when it ticks the item.
  const theirs = ticked(pristine(), REVIEW());
  fs.writeFileSync(FILE, theirs);
  await expect(count(win)).toHaveText(`${e.open - 1} open · ${e.overdue} overdue · ${e.today - 1} today`, { timeout: WATCHED });
  await expect(badge(win, "todo")).toHaveText(String(e.badge - 1));
  const call = `- [ ] Call the chart vendor 📅 ${T()} #harbor\n`;
  await row(win, "Call the chart vendor").locator(".aos-td-check").click();
  await expect.poll(onDisk).toBe(ticked(theirs, call));
});

test("an edit survives TODO.md changing underneath with its line intact: the typing, caret and focus stay; Enter saves onto the new text", async () => {
  const { win } = app();
  const e = expected().todo;
  await row(win, "Draft the release notes").locator(".aos-td-text").dblclick();
  const edit = td(win).locator("input.aos-td-edit");
  await edit.selectText();
  await win.keyboard.insertText("Draft the release notes for 0.22");
  // Another HUD ticks a different item while this one is being edited: the tab redraws from the new file. Its event
  // reaches the tab late, as a busy runner's FSEvents can deliver it (main's ci, 2026-10-12: still unseen after 3 s).
  const theirs = ticked(pristine(), REVIEW());
  await holdVaultEvents(win);
  try {
    fs.writeFileSync(FILE, theirs);
    await releaseVaultEventsAfter(win, "TODO.md", LATE_EVENT_MS);
    await expect(count(win)).toHaveText(`${e.open - 1} open · ${e.overdue} overdue · ${e.today - 1} today`, { timeout: WATCHED });
  } finally {
    await releaseVaultEventsAfter(win, null, 0);
  }
  await expect(edit).toHaveValue("Draft the release notes for 0.22");
  await expect(edit).toBeFocused();
  expect(onDisk()).toBe(theirs);   // nothing saved halfway through the typing
  await win.keyboard.insertText(` 📅 ${day(1)} #harbor`);
  await edit.press("Enter");
  await expect.poll(onDisk).toBe(theirs.replace(`- [ ] Draft the release notes 📅 ${day(1)} #harbor`, `- [ ] Draft the release notes for 0.22 📅 ${day(1)} #harbor`));
  await expect(edit).toHaveCount(0);
});

test("stale guard: a line changed underneath is reported, nothing is written, and the quick-add draft survives (T7)", async () => {
  const { win } = app();
  const e = expected().todo;
  await td(win).locator("input.aos-td-input").fill("Keep this draft");
  // Hold back the vault's events so the tab still shows the old line, as when the other HUD's write has not reached
  // this one yet; then tick here what was just ticked there. A refresh the tab scheduled before the hold (a late event,
  // as an earlier test's writes can leave one) would read the new file and move the item away: one is forced here, and
  // the hold cancels it.
  await win.evaluate(() => {
    const host = (window as unknown as { aosHost: { app: { vault: Record<string, unknown> & { getAbstractFileByPath(p: string): unknown }; workspace: { getLeavesOfType(t: string): Array<{ view: { getTab(id: string): Record<string, unknown> | null } }> } } } }).aosHost;
    const v = host.app.vault;
    (v.trigger as (name: string, f: unknown) => void).call(v, "modify", v.getAbstractFileByPath("TODO.md"));
    v.__trigger = v.trigger;
    v.trigger = () => undefined;
    const tab = host.app.workspace.getLeavesOfType("agentic-os-workbench")[0]?.view.getTab("todo");
    if (tab && tab.refreshDebounce != null) window.clearTimeout(tab.refreshDebounce as number);
  });
  try {
    const call = `- [ ] Call the chart vendor 📅 ${T()} #harbor\n`;
    const theirs = ticked(pristine(), call);
    fs.writeFileSync(FILE, theirs);
    // As a loaded runner can: any refresh still pending (250 ms debounce) would land before the click.
    await win.waitForTimeout(400);
    await row(win, "Call the chart vendor").locator(".aos-td-check").click();
    await expect(win.locator(".notice-container")).toContainText("TODO.md changed underneath — reloaded, try again");
    // The tab re-read the file: the item is done there, the draft is still in the box, and this HUD wrote nothing.
    await expect(count(win)).toHaveText(`${e.open - 1} open · ${e.overdue} overdue · ${e.today - 1} today`);
    await expect(td(win).locator("input.aos-td-input")).toHaveValue("Keep this draft");
    expect(onDisk()).toBe(theirs);
  } finally {
    await win.evaluate(() => {
      const v = (window as unknown as { aosHost: { app: { vault: Record<string, unknown> } } }).aosHost.app.vault;
      v.trigger = v.__trigger;
      delete v.__trigger;
    });
  }
  await td(win).locator("input.aos-td-input").fill("");
});

test("without TODO.md, open TODO.md creates it from the template, and a quick-add creates it too (T1)", async () => {
  const { win } = app();
  fs.rmSync(FILE);
  await expect(td(win).locator(".aos-rt-table .aos-inv-row.aos-dim")).toContainText("Nothing open — add one above", { timeout: WATCHED });
  await td(win).locator("button", { hasText: "open TODO.md" }).click();
  await expect(win.locator(".aos-host-tab.is-active .aos-host-tab-title")).toHaveText("TODO");
  expect(onDisk()).toBe(TODO_TEMPLATE);
  await closeNotes(win);

  fs.rmSync(FILE);
  await openTab(win, "todo");
  await expect(td(win).locator(".aos-rt-count")).toHaveText("0 open · 0 overdue · 0 today", { timeout: WATCHED });
  await td(win).locator("input.aos-td-input").fill("First thing");
  await td(win).locator("input.aos-td-input").press("Enter");
  // An empty ## Open takes the item right under its heading.
  await expect.poll(onDisk).toBe(TODO_TEMPLATE.replace("## Open\n", "## Open\n- [ ] First thing\n"));
  await expect(row(win, "First thing")).toBeVisible();
});

test("with only To-Do on, other surfaces stay refused: opening an unread notification still cannot mark it read", async () => {
  const h = app();
  await openTab(h.win, "notifications");
  const unread = content(h.win).locator(".aos-nt-row.is-unread").first();
  await unread.click();
  await expect.poll(async () => (await guardWrites(h)).length).toBeGreaterThan(0);
  expect((await guardWrites(h)).every((w) => w.includes("brain/notifications/state.json"))).toBe(true);
  await expect(h.win.locator(".notice-container")).toContainText("Could not update brain/notifications/state.json");
  await unread.click();
  // The refusal was expected here; clear it so afterEach checks the rest of the file.
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
