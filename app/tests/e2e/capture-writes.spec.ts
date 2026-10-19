// Capture, Remember and Pattern with their write surface on (AOS_APP_WRITE=capture): the phase 2 rows of app-smoke:
// Pulse (the deck's /remember and /pattern), plus Quick Capture and the deck's /feedback and /project, which open the
// same form. Each write is compared with what the HUD's model produces (sessionNotes, patternNotes and mdSections are
// pure; the memory file is the frontmatter memoryWriter.ts writes). A typed slug cannot leave brain/memory.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendUnderHeading } from "../../../hud/src/data/mdSections";
import { addPatternIndexEntry, appendPattern, newPatternFile } from "../../../hud/src/data/patternNotes";
import { appendRemember } from "../../../hud/src/data/sessionNotes";
import { localDay } from "../../../hud/src/data/todos";
import { FX, command, content, guardWrites, openTab, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "capture" } });

const pristine = (rel: string): string => fs.readFileSync(path.join(FX.pristine, "vault", rel), "utf8");
const onDisk = (rel: string) => (): string | null => (fs.existsSync(FX.v(rel)) ? fs.readFileSync(FX.v(rel), "utf8") : null);
const RESTORED = ["MEMORY.md", "brain/_index/SESSION.md", "brain/patterns/debugging.md"];
/** Files and folders a test created, removed again before the next one. */
const created: string[] = [];

const modal = (win: Page) => win.locator(".modal");
const field = (win: Page, name: string) => modal(win).locator(".setting-item", { has: win.locator(".setting-item-name", { hasText: new RegExp(`^${name}$`) }) });
const deck = (win: Page, name: string) => win.locator(".aos-pulse-deck .aos-deck-btn", { hasText: name });

/** The memory file memoryWriter.ts writes (its dates are UTC days). */
function memoryFile(type: string, title: string, body: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return ["---", "type: memory", `tags: [memory/${type}, status/active]`, `created: ${today}`, `updated: ${today}`, "---", "", `# ${title}`, "", body.trim(), ""].join("\n");
}

test.beforeEach(async () => {
  const { win } = app();
  for (const rel of RESTORED) if (onDisk(rel)() !== pristine(rel)) fs.writeFileSync(FX.v(rel), pristine(rel));
  await openTab(win, "pulse");
  await expect(modal(win)).toHaveCount(0);
});

test.afterEach(async () => {
  for (const rel of created.splice(0)) fs.rmSync(FX.v(rel), { recursive: true, force: true });
  expect(await guardWrites(app())).toEqual([]);
});

test("Capture is the one surface on: the status bar names it and what it writes", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Capture");
  await expect(mode).toHaveAttribute("title", /^Capture: brain\/memory\/\*\*\/\*\.md, MEMORY\.md, brain\/_index\/SESSION\.md, brain\/patterns\/\*\.md\n/);
});

test("Quick Capture writes the memory file and its MEMORY.md line under the type's heading", async () => {
  const { win } = app();
  await command(win, "agentic-os:quick-capture");
  await expect(modal(win).locator("h2")).toHaveText("Quick Capture");
  await field(win, "Type").locator("select").selectOption("reference");
  await field(win, "Title").locator("input").fill("Chart symbols");
  await expect(field(win, "Slug").locator("input")).toHaveValue("chart-symbols");
  await field(win, "Description").locator("input").fill("INT 1 legend for the chart view");
  const body = "Use the INT 1 symbol legend for buoys and lights.";
  await modal(win).locator("textarea").fill(body);
  // Until the slug is edited by hand, the body re-derives it, so the form filled top to bottom loses the title's slug
  // (a HUD finding, kept as it behaves). Setting it by hand keeps it.
  await expect(field(win, "Slug").locator("input")).toHaveValue("use-the-int-1-symbol-legend");
  await field(win, "Slug").locator("input").fill("chart-symbols");
  await modal(win).locator("button.mod-cta", { hasText: "Capture" }).click();
  const rel = "brain/memory/reference/chart-symbols.md";
  created.push(rel);
  await expect.poll(onDisk(rel)).toBe(memoryFile("reference", "Chart symbols", body));
  // memoryWriter writes the memory file first, then the index: wait for the index too.
  await expect.poll(onDisk("MEMORY.md")).toBe(appendUnderHeading(pristine("MEMORY.md"), "## Reference", `- [Chart symbols](${rel}) — INT 1 legend for the chart view`));
  await expect(modal(win)).toHaveCount(0);
  await expect(win.locator(".notice-container")).toContainText("✓ chart-symbols.md");
});

test("the deck's /feedback opens the form as feedback; ⌘↵ saves; the index line lands under Feedback (how to work)", async () => {
  const { win } = app();
  await deck(win, "/feedback").click();
  await expect(field(win, "Type").locator("select")).toHaveValue("feedback");
  const body = "Say which files a change touches before editing them.";
  await modal(win).locator("textarea").fill(body);
  await expect(field(win, "Slug").locator("input")).toHaveValue("say-which-files-a-change-touches");
  await modal(win).locator("textarea").press("Meta+Enter");
  const rel = "brain/memory/feedback/say-which-files-a-change-touches.md";
  created.push(rel);
  // With no title or description typed, both come from the body.
  await expect.poll(onDisk(rel)).toBe(memoryFile("feedback", body, body));
  // memoryWriter writes the memory file first, then the index: wait for the index too.
  await expect.poll(onDisk("MEMORY.md")).toBe(appendUnderHeading(pristine("MEMORY.md"), "## Feedback", `- [${body}](${rel}) — ${body}`));
});

test("a body typed key by key leaves the description (and so the title) at its first character: a HUD finding, kept as it behaves", async () => {
  const { win } = app();
  await deck(win, "/project").click();
  await expect(field(win, "Type").locator("select")).toHaveValue("projects");
  await modal(win).locator("textarea").pressSequentially("Harbor app ships offline tiles");
  await expect(field(win, "Slug").locator("input")).toHaveValue("harbor-app-ships-offline-tiles");
  await modal(win).locator("button.mod-cta", { hasText: "Capture" }).click();
  const rel = "brain/memory/projects/harbor-app-ships-offline-tiles.md";
  created.push(rel);
  // CaptureModal sets the description from the body only while it is empty, i.e. on the first keystroke.
  await expect.poll(onDisk(rel)).toBe(memoryFile("projects", "H", "Harbor app ships offline tiles"));
  // memoryWriter writes the memory file first, then the index: wait for the index too.
  await expect.poll(onDisk("MEMORY.md")).toBe(appendUnderHeading(pristine("MEMORY.md"), "## Project", `- [H](${rel}) — H`));
});

test("a type whose folder is missing gets the folder created, then the memory", async () => {
  const { win } = app();
  const parked = path.join(FX.root, "user-memories-parked");
  fs.renameSync(FX.v("brain/memory/user"), parked);
  try {
    await command(win, "agentic-os:quick-capture");
    await field(win, "Type").locator("select").selectOption("user");
    await modal(win).locator("textarea").fill("Works night shifts on Thursdays.");
    await field(win, "Title").locator("input").fill("Night shifts");
    await modal(win).locator("button.mod-cta", { hasText: "Capture" }).click();
    await expect.poll(onDisk("brain/memory/user/night-shifts.md")).toBe(memoryFile("user", "Night shifts", "Works night shifts on Thursdays."));
    expect(fs.readdirSync(FX.v("brain/memory/user"))).toEqual(["night-shifts.md"]);
  } finally {
    fs.rmSync(FX.v("brain/memory/user"), { recursive: true, force: true });
    fs.renameSync(parked, FX.v("brain/memory/user"));
  }
});

test("a typed slug that climbs out of brain/memory is refused: nothing is written and the form says why", async () => {
  const h = app();
  const { win } = h;
  await command(win, "agentic-os:quick-capture");
  await field(win, "Slug").locator("input").fill("../../../escaped");
  await modal(win).locator("textarea").fill("This should never leave brain/memory.");
  await modal(win).locator("button.mod-cta", { hasText: "Capture" }).click();
  await expect(win.locator(".notice-container")).toContainText("Capture failed: UniDeX: write brain/memory/feedback/../../../escaped.md refused");
  expect(fs.existsSync(FX.v("escaped.md"))).toBe(false);
  expect(onDisk("MEMORY.md")()).toBe(pristine("MEMORY.md"));
  expect(await guardWrites(h)).toEqual(["write brain/memory/feedback/../../../escaped.md"]);
  await modal(win).locator("button", { hasText: "Cancel" }).click();
  await win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});

test("/remember appends to SESSION.md: a plain note under Things to Remember, a typed one under Promote (P7)", async () => {
  const { win } = app();
  const today = localDay(new Date());
  const notes = ["The chart vendor prefers email", "feedback: ask before re-running the full fixture"];
  let want = pristine("brain/_index/SESSION.md");
  for (const note of notes) {
    await deck(win, "/remember").click();
    await modal(win).locator("textarea").fill(note);
    await modal(win).locator("button.mod-cta", { hasText: "Remember" }).click();
    want = appendRemember(want, note, today);
    await expect.poll(onDisk("brain/_index/SESSION.md")).toBe(want);
    await expect(modal(win)).toHaveCount(0);
  }
  await expect(win.locator(".notice-container")).toContainText("✓ SESSION.md · Things to Remember");
  await expect(win.locator(".notice-container")).toContainText("✓ SESSION.md · Promote to Memory on Close");
  expect(want).toContain("- The chart vendor prefers email");
});

test("/remember with no SESSION.md creates it", async () => {
  const { win } = app();
  fs.rmSync(FX.v("brain/_index/SESSION.md"));
  await deck(win, "/remember").click();
  await modal(win).locator("textarea").fill("Start from a clean session file");
  await modal(win).locator("button.mod-cta", { hasText: "Remember" }).click();
  await expect.poll(onDisk("brain/_index/SESSION.md")).toBe(appendRemember(null, "Start from a clean session file", localDay(new Date())));
});

test("/pattern appends to an existing area's file, and a new area gets its file and a MEMORY.md line (P8)", async () => {
  const { win } = app();
  const today = localDay(new Date());
  const first = { title: "Read the whole trace first", body: "When a test fails, read the whole stack trace before changing code.", today };
  await deck(win, "/pattern").click();
  await field(win, "Title").locator("input").fill(first.title);
  await modal(win).locator("textarea").fill(first.body);
  await modal(win).locator("button.mod-cta", { hasText: "Save pattern" }).click();
  await expect.poll(onDisk("brain/patterns/debugging.md")).toBe(appendPattern(pristine("brain/patterns/debugging.md"), first));
  expect(onDisk("MEMORY.md")()).toBe(pristine("MEMORY.md"));

  const second = { title: "Parsers stay pure", body: "Keep parsers free of IO so the tests need no fixtures.", today };
  await deck(win, "/pattern").click();
  await field(win, "Area").locator("select").selectOption("architecture");
  await field(win, "Title").locator("input").fill(second.title);
  await modal(win).locator("textarea").fill(second.body);
  await modal(win).locator("button.mod-cta", { hasText: "Save pattern" }).click();
  created.push("brain/patterns/architecture.md");
  await expect.poll(onDisk("brain/patterns/architecture.md")).toBe(newPatternFile("architecture", second));
  await expect.poll(onDisk("MEMORY.md")).toBe(addPatternIndexEntry(pristine("MEMORY.md"), "architecture"));
  await expect(win.locator(".notice-container")).toContainText("✓ brain/patterns/architecture.md");
});

test("with only Capture on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
