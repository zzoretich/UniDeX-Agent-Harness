// The guided tour (spec 2026-10-14-guided-tour-design, PR 8): the welcome tour driven by real clicks on a Mac that has
// never seen it, the spotlight's keys and its manners around modals, a tab's first-visit chip, Getting started, Help in
// the rail and in the app's Help menu, and every chapter's anchors, which resolve or are gated by `when` on the default
// fixture (Claude Code, no provider) and on a Codex-only machine (app-smoke: Guided tour).

import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, HUD_SETTINGS, HUD_VERSION, TOUR_BOOK, appEnv, command, content, drawer, expectNoErrors, openTab, rail, useApp } from "./harness";

const pop = (win: Page) => win.locator(".aos-tour-pop");
const overlay = (win: Page) => win.locator(".aos-tour");
const step = async (win: Page) => (await pop(win).getAttribute("data-step")) ?? "";
interface TourStateFile { lastSeenVersion: string | null; completed: string[]; dismissed: string[]; checklist: { dismissed: boolean; done: Record<string, string> }; offered: string[] }
const saved = (): TourStateFile => (JSON.parse(fs.readFileSync(HUD_SETTINGS, "utf8")) as { tour: TourStateFile }).tour;
type Probe = Array<{ ref: string; status: "found" | "gated" | "unrouted" | "missing" }>;
/** Routes every step of a chapter in the page and waits for its anchor (the engine's own resolver, nothing drawn). */
const probe = (win: Page, id: string): Promise<Probe> =>
  win.evaluate((cid) => (window as unknown as { aosHost: { plugin: { tour: { probe(id: string, ms: number): Promise<Probe> } } } }).aosHost.plugin.tour.probe(cid, 10_000), id);
const tourLog = (win: Page): Promise<string[]> =>
  win.evaluate(() => [...(window as unknown as { aosHost: { plugin: { tour: { engine: { log: string[] } } } } }).aosHost.plugin.tour.engine.log]);
const helpMenu = async (win: Page, key: string) => {
  await win.locator('.aos-wb-railfoot [data-action="help"]').click();
  await win.locator(`.aos-tour-menu [data-key="${key}"]`).click();
};

test.describe("a Mac that has not seen the tour (Claude Code, no provider)", () => {
  test.describe.configure({ mode: "serial" });
  const app = useApp({ tour: false });

  test("Getting started and Help sit at the rail's foot; Help's menu has the five items", async () => {
    const { win } = app();
    const acts = await win.locator(".aos-wb-railfoot .aos-wb-railact").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.action));
    expect(acts).toEqual(["checklist", "help", "theme", "app-settings"]);
    await expect(win.locator('[data-action="checklist"]')).toHaveAttribute("aria-label", /^Getting started \d+\/\d+$/);
    await win.locator('.aos-wb-railfoot [data-action="help"]').click();
    await expect(win.locator('[data-action="help"]')).toHaveAttribute("aria-expanded", "true");
    await expect(win.locator(".aos-tour-menu .aos-tour-menulabel")).toHaveText(["Take the tour", "Tour this tab", "What's new", "Getting started", "Documentation"]);
    await expect(win.locator(".aos-tour-menu [data-key='tour-start']")).toBeFocused();
    await win.keyboard.press("Escape");
    await expect(win.locator(".aos-tour-menu")).toHaveCount(0);
  });

  test("a tab's first visit offers its chapter once, as a chip, never a modal (C6)", async () => {
    const { win } = app();
    // Pulse, Home, was shown at launch: its chip came and was recorded.
    await expect(win.locator('.aos-tour-chip[data-chapter="pulse"]')).toBeVisible();
    await expect(win.locator(".modal-container")).toHaveCount(0);
    await win.locator(".aos-tour-chipx").click();
    await openTab(win, "todo");
    await expect(win.locator('.aos-tour-chip[data-chapter="todo"]')).toHaveText(/New to To-Do\?/);
    await openTab(win, "pulse");
    await win.waitForTimeout(1000);
    await expect(win.locator(".aos-tour-chip")).toHaveCount(0);
    expect(saved().offered).toEqual(expect.arrayContaining(["pulse", "todo"]));
    // Its button runs the chapter.
    await openTab(win, "files");
    await win.locator('.aos-tour-chip[data-chapter="files"] .aos-tour-chipgo').click();
    await expect(pop(win)).toHaveAttribute("data-step", "files.count");
    await win.keyboard.press("Escape");
    await expect(overlay(win)).toHaveCount(0);
    expect(saved().dismissed).toContain("files");
  });

  test("the welcome tour by real clicks: rail to Help, then Getting started opens (C1, C6)", async () => {
    const h = app();
    const { win } = h;
    await helpMenu(win, "tour-start");
    await expect(pop(win)).toHaveAttribute("data-step", "core.rail");
    // The popover takes the focus and is a live region; Sessions is gated here (no provider), so nine stops.
    await expect(pop(win)).toBeFocused();
    await expect(pop(win)).toHaveAttribute("role", "dialog");
    await expect(pop(win)).toHaveAttribute("aria-live", "polite");
    await expect(pop(win).locator(".aos-tour-meta")).toHaveText("Welcome tour · 1 of 9");
    await expect(pop(win).locator(".aos-tour-back")).toBeDisabled();
    await pop(win).locator(".aos-tour-next").click();

    // Each "click" stop waits for the real click on the highlighted rail button, which shows its tab.
    const clicks: Array<[string, string]> = [["core.pulse", "pulse"], ["core.code", "term"], ["core.brain", "memory"], ["core.spaces", "spaces"], ["core.routines", "routines"], ["core.chief-of-staff", "proposals"]];
    for (const [ref, tab] of clicks) {
      await expect(pop(win)).toHaveAttribute("data-step", ref);
      await expect(pop(win).locator(".aos-tour-next")).toHaveCount(0);
      await expect(pop(win).locator(".aos-tour-hint")).toBeVisible();
      if (ref === "core.pulse") {
        // Only the cutout takes a click: the Skills button, under a shade, does nothing.
        const active = await win.locator(".aos-wb-railbtn.is-active").getAttribute("data-tab");
        expect(active).not.toBe("skills");
        const box = (await rail(win, "skills").boundingBox())!;
        await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await win.waitForTimeout(300);
        await expect(win.locator(".aos-wb-railbtn.is-active")).toHaveAttribute("data-tab", active!);
        expect(await step(win)).toBe("core.pulse");
      }
      await rail(win, tab).click();
      await expect(rail(win, tab)).toHaveClass(/is-active/);
    }
    await expect(pop(win)).toHaveAttribute("data-step", "core.search");
    expect(await pop(win).locator(".aos-tour-body").textContent()).toContain("⌘K");
    await pop(win).locator(".aos-tour-next").click();
    await expect(pop(win)).toHaveAttribute("data-step", "core.help");
    await pop(win).locator(".aos-tour-next", { hasText: "Done" }).click();
    await expect(overlay(win)).toHaveCount(0);
    // It ends on Getting started, with the welcome tour ticked.
    await expect(drawer(win).locator(".aos-tour-checklist")).toBeVisible();
    await expect(drawer(win).locator('.aos-tour-cl-item[data-task="core"]')).toHaveClass(/is-done/);
    await expect.poll(() => saved().completed).toContain("core");
    expect(saved().lastSeenVersion).toBe(HUD_VERSION);
    expectNoErrors(h);
  });

  test("Getting started: tours and first steps, Start runs a chapter, Hide puts it away and Help brings it back (C9)", async () => {
    const { win } = app();
    if (!(await drawer(win).locator(".aos-tour-checklist").count())) await win.locator('[data-action="checklist"]').click();
    const list = drawer(win).locator(".aos-tour-checklist");
    await expect(list.locator(".aos-tour-cl-section")).toHaveText(["TOURS", "FIRST STEPS"]);
    // The fixture has a Chief of Staff, so that first step is ticked from its cache.
    await expect(list.locator('.aos-tour-cl-item[data-task="chief-set-up"]')).toHaveClass(/is-done/);
    await expect(list.locator('.aos-tour-cl-item[data-task="sessions"]')).toHaveCount(0);
    const count = await win.locator('[data-action="checklist"]').getAttribute("aria-label");
    await expect(list.locator(".aos-tour-cl-count")).toHaveText(count!.replace(/^Getting started (\d+)\/(\d+)$/, "$1 of $2 done"));
    await list.locator('.aos-tour-cl-item[data-task="help"] .aos-tour-cl-go').click();
    await expect(pop(win)).toHaveAttribute("data-step", "help.menu");
    await win.keyboard.press("Escape");
    await win.locator('[data-action="checklist"]').click();
    await drawer(win).locator(".aos-tour-cl-hide").click();
    await expect(win.locator('[data-action="checklist"]')).toHaveCount(0);
    await expect.poll(() => saved().checklist.dismissed).toBe(true);
    await helpMenu(win, "getting-started");
    await expect(drawer(win).locator(".aos-tour-checklist")).toBeVisible();
    await expect(win.locator('[data-action="checklist"]')).toHaveCount(1);
    await drawer(win).locator(".aos-wb-drawerhead .aos-link", { hasText: "✕" }).click();
  });

  test("keys: → and ← move, Esc skips the chapter; Tour this tab picks the tab's (and Brain mode's) chapter (C7)", async () => {
    const { win } = app();
    await openTab(win, "routines");
    await helpMenu(win, "tour-tab");
    await expect(pop(win)).toHaveAttribute("data-step", "routines.count");
    await win.keyboard.press("ArrowRight");
    await expect(pop(win)).toHaveAttribute("data-step", "routines.new");
    await win.keyboard.press("ArrowLeft");
    await expect(pop(win)).toHaveAttribute("data-step", "routines.count");
    await win.keyboard.press("Escape");
    await expect(overlay(win)).toHaveCount(0);
    await expect.poll(() => saved().dismissed).toContain("routines");
    expect(await command(win, "agentic-os:open-workbench-memory")).toBe(true);
    await win.locator('.aos-brain-mode[data-mode="health"]').click();
    expect(await command(win, "agentic-os:tour-tab")).toBe(true);
    await expect(pop(win)).toHaveAttribute("data-step", "brain-health.tiles");
    await win.keyboard.press("Escape");
  });

  test("a step whose control never appears is skipped and logged; the spotlight steps aside for a modal (C7)", async () => {
    const h = app();
    const { win } = h;
    await win.evaluate(() => {
      const t = (window as unknown as { aosHost: { plugin: { tour: { engine: { run(items: unknown[], o: unknown): void } } } } }).aosHost.plugin.tour.engine;
      const chapter = { id: "probe", title: "Probe", summary: "s", steps: [] };
      const s = (id: string, anchor: string) => ({ id, anchor, title: id, body: "b", advance: "next", since: "2.0.0" });
      t.run([{ chapter, step: s("gone", ".aos-no-such-control") }, { chapter, step: s("here", '.aos-wb-railhead [data-action="search"]') }], { chapter: null });
    });
    await expect(pop(win)).toHaveAttribute("data-step", "probe.here", { timeout: 6_000 });
    expect(await tourLog(win)).toContain("probe.gone: no .aos-no-such-control after 2 s");
    // A modal (Quick Capture) hides the spotlight and keeps the keyboard: Esc closes the modal, not the tour.
    expect(await command(win, "agentic-os:quick-capture")).toBe(true);
    await expect(win.locator(".modal-container")).toHaveCount(1);
    await expect(overlay(win)).toHaveClass(/is-hidden/);
    await win.keyboard.press("Escape");
    await expect(win.locator(".modal-container")).toHaveCount(0);
    await expect(overlay(win)).not.toHaveClass(/is-hidden/);
    await expect(pop(win)).toHaveAttribute("data-step", "probe.here");
    await win.keyboard.press("Escape");
    await expect(overlay(win)).toHaveCount(0);
    expectNoErrors(h);
  });

  test("prefers-reduced-motion drops the spotlight's transitions", async () => {
    const { win } = app();
    await helpMenu(win, "tour-start");
    await expect(pop(win)).toHaveAttribute("data-step", "core.rail");
    expect(await win.locator(".aos-tour-ring").evaluate((el) => getComputedStyle(el).transitionDuration)).not.toBe("0s");
    await win.keyboard.press("Escape");
    await win.emulateMedia({ reducedMotion: "reduce" });
    try {
      await helpMenu(win, "tour-start");
      await expect(pop(win)).toHaveAttribute("data-step", "core.rail");
      expect(await win.locator(".aos-tour-ring").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
      expect(await pop(win).evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
      await win.keyboard.press("Escape");
    } finally { await win.emulateMedia({ reducedMotion: null }); }
  });

  test("What's new says when it has nothing yet; Documentation opens the README in the browser", async () => {
    const h = app();
    const { win } = h;
    await helpMenu(win, "whats-new");
    await expect(drawer(win).locator(".aos-tour-wn-empty")).toBeVisible();
    await helpMenu(win, "docs");
    await expect.poll(async () => (await h.opened()).map((o) => o.arg)).toContain("https://github.com/zzoretich/UniDeX-Agent-Harness#readme");
  });

  test("the app's Help menu lists the tour's commands, not under Commands, and runs them (C12)", async () => {
    const { app: electronApp, win } = app();
    const menu = await electronApp.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu()!.items;
      const help = items.find((i) => i.role === "help");
      const commands = items.find((i) => i.label === "Commands");
      return {
        help: help!.submenu!.items.map((i) => i.label), off: help!.submenu!.items.filter((i) => i.type !== "separator" && !i.enabled).map((i) => i.label),
        commands: commands!.submenu!.items.map((i) => i.label),
      };
    });
    expect(menu.help).toEqual(["Take the Tour", "Tour This Tab", "What's New", "Getting Started", "", "UniDeX Documentation", "UniDeX on GitHub"]);
    // Each names a command the HUD registered (an id that drifted would leave its item off).
    expect(menu.off).toEqual([]);
    for (const l of ["Take the tour", "Tour this tab", "What's new", "Getting started", "Documentation"]) expect(menu.commands).not.toContain(l);
    await electronApp.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find((i) => i.role === "help")!.submenu!.items[0].click(); });
    await expect(pop(win)).toHaveAttribute("data-step", "core.rail");
    await win.keyboard.press("Escape");
    // ⌘P lists them too.
    await win.keyboard.press("Meta+p");
    await win.keyboard.type("Take the tour");
    await expect(win.locator(".modal-container .suggestion-item").first()).toContainText("Take the tour");
    await win.keyboard.press("Escape");
  });

  test("every chapter's anchors resolve on this machine, or are gated by `when` (C8)", async () => {
    const h = app();
    const gated: string[] = [];
    for (const c of TOUR_BOOK.chapters) {
      const r = await probe(h.win, c.id);
      expect(r.filter((x) => x.status === "missing" || x.status === "unrouted"), `chapter ${c.id}`).toEqual([]);
      gated.push(...r.filter((x) => x.status === "gated").map((x) => x.ref));
    }
    // What this machine lacks, and only that: Sessions (no provider), Codex's own steps, and the checklist put away.
    expect(gated.filter((r) => r.startsWith("sessions."))).toHaveLength(TOUR_BOOK.chapters.find((c) => c.id === "sessions")!.steps.length);
    expect(gated).toEqual(expect.arrayContaining(["core.sessions", "code.start-codex", "routines.codex", "settings.claude-off"]));
    expect(gated).not.toContain("code.start-claude");
    expectNoErrors(h);
  });
});

/** Runs the vault's `aos` launcher as a user at a terminal would (no AOS_HEADLESS), in the fixture's environment. */
const aos = (...args: string[]) => {
  const r = spawnSync("/bin/sh", [FX.v("brain/scripts/bin/aos"), ...args], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`aos ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
};
const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};

test.describe("a Codex-only machine (variants.spec.ts's)", () => {
  test.describe.configure({ mode: "serial" });
  const app = useApp({
    tour: false,
    prepare: () => {
      editJson(path.join(FX.claude, "agenticos.json"), (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = true; });
      aos("routines", "hosts", "--refresh");
      editJson(FX.v("brain/_index/provider-state.json"), (j) => {
        j.name = "codex"; j.reason = "fixture"; j.codex = { ...(j.codex ?? {}), loggedIn: true, checkedAt: new Date().toISOString() };
      });
    },
  });

  test("the welcome tour names Codex and stops at Sessions, which is on the rail", async () => {
    const { win } = app();
    await helpMenu(win, "tour-start");
    await expect(pop(win)).toHaveAttribute("data-step", "core.rail");
    await expect(pop(win).locator(".aos-tour-meta")).toHaveText("Welcome tour · 1 of 10");
    await pop(win).locator(".aos-tour-next").click();
    await rail(win, "pulse").click();
    await expect(pop(win)).toHaveAttribute("data-step", "core.sessions");
    await expect(pop(win).locator(".aos-tour-body")).toContainText("run Codex in a workspace");
    await rail(win, "chat").click();
    await expect(pop(win)).toHaveAttribute("data-step", "core.code");
    await expect(pop(win).locator(".aos-tour-body")).not.toContainText("Claude Code");
    await win.keyboard.press("Escape");
    await expect(overlay(win)).toHaveCount(0);
    await expect(content(win)).not.toBeEmpty();
  });

  test("every chapter's anchors resolve on Codex alone, or are gated by `when` (C8)", async () => {
    const h = app();
    const gated: string[] = [];
    for (const c of TOUR_BOOK.chapters) {
      const r = await probe(h.win, c.id);
      expect(r.filter((x) => x.status === "missing" || x.status === "unrouted"), `chapter ${c.id}`).toEqual([]);
      gated.push(...r.filter((x) => x.status === "gated").map((x) => x.ref));
    }
    expect(gated).toEqual(expect.arrayContaining(["code.start-claude", "routines.cloud", "settings.codex-off"]));
    expect(gated.filter((r) => r.startsWith("sessions.") || r === "core.sessions")).toEqual([]);
    expectNoErrors(h);
  });
});
