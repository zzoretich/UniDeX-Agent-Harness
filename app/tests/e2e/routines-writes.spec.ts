// Routines with its write surface on (AOS_APP_WRITE=routines), the rows of app-smoke: Routines. The drawer's
// create, save and delete, the on/off link, "Write anyway" on a guarded duty, ▶ run now, and apply schedules. Each
// write is compared byte for byte with what the HUD's own serializer (data/routines.ts) produces. After every write the
// tab runs `aos routines sync` by itself: the tests follow it through the fixture's plist folder, the stubbed
// launchctl's log and routines.json's sync record. Each test undoes its change through the tab, as the live check does.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { routineFromFile, routineToFile, type Routine, type RoutinesState } from "../../../obsidian-plugin/src/data/routines";
import { FX, content, drawer, guardWrites, openTab, readVaultJson, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "routines" } });

const C = (win: Page) => content(win);
const row = (win: Page, slug: string) => C(win).locator(".aos-rt-row", { has: win.locator(".aos-rt-slug", { hasText: new RegExp(`^${slug}( · guarded)?$`) }) });
const act = (win: Page, slug: string, label: string) => row(win, slug).locator(".aos-rt-rowactions a", { hasText: label });
const field = (win: Page, label: RegExp) => drawer(win).locator(".aos-rt-field", { hasText: label });
const button = (win: Page, label: string) => drawer(win).locator(".aos-capture-actions button", { hasText: label });
const modal = (win: Page) => win.locator(".modal");

const file = (slug: string) => FX.v(`brain/routines/${slug}.md`);
const onDisk = (slug: string): string | null => (fs.existsSync(file(slug)) ? fs.readFileSync(file(slug), "utf8") : null);
const pristine = (slug: string) => fs.readFileSync(path.join(FX.pristine, "vault", "brain", "routines", `${slug}.md`), "utf8");
/** What the HUD writes for the pristine routine with `change` applied (setRoutineEnabled and writeRoutine both serialize through routineToFile). */
function written(slug: string, change: Partial<Routine> = {}): string {
  const { errors, ...rest } = routineFromFile(slug, pristine(slug));
  void errors;
  return routineToFile({ ...rest, ...change });
}

const AGENTS = path.join(FX.home, "Library", "LaunchAgents");
const plist = (slug: string) => path.join(AGENTS, `com.agenticos.${slug}.plist`);
const plistText = (slug: string): string | null => (fs.existsSync(plist(slug)) ? fs.readFileSync(plist(slug), "utf8") : null);
/** Every com.agenticos plist in the fixture home, by file name. */
function plists(dir = AGENTS): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.startsWith("com.agenticos.")).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
}
const pristinePlists = () => plists(path.join(FX.pristine, "home", "Library", "LaunchAgents"));

const state = () => readVaultJson<RoutinesState>("brain/_index/routines.json");
const pristineState = () => JSON.parse(fs.readFileSync(path.join(FX.pristine, "vault", "brain", "_index", "routines.json"), "utf8")) as RoutinesState;
/** Waits for the `aos routines sync` the tab started: it records syncedAt last, after every plist and launchctl call. */
async function synced(before: string | null): Promise<void> {
  await expect.poll(() => state().syncedAt, { timeout: 30_000 }).not.toBe(before);
}

// The fixture's launchctl is a stub that appends "launchctl <args>" to a log (scripts/make-fixture-vault.mjs).
const STUB_LOG = (JSON.parse(fs.readFileSync(path.join(FX.root, "env.json"), "utf8")) as Record<string, string>).AOS_FIXTURE_STUB_LOG;
const logSize = () => (fs.existsSync(STUB_LOG) ? fs.statSync(STUB_LOG).size : 0);
const launchctlSince = (from: number): string[] =>
  (fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG).subarray(from).toString("utf8") : "").split("\n").filter((l) => l.startsWith("launchctl "));
// The jobs the stub has loaded, one label per line: load adds, unload removes, `launchctl list <label>` asks.
const LAUNCHD = (JSON.parse(fs.readFileSync(path.join(FX.root, "env.json"), "utf8")) as Record<string, string>).AOS_FIXTURE_LAUNCHD;
const loadedJobs = (): string[] => (fs.existsSync(LAUNCHD) ? fs.readFileSync(LAUNCHD, "utf8").split("\n").filter(Boolean) : []);

const ROUTINES = () => fs.readdirSync(FX.v("brain/routines")).filter((f) => f.endsWith(".md") && f !== "README.md").sort();

test.beforeEach(async () => {
  const { win } = app();
  await openTab(win, "routines");
  await expect(C(win).locator(".aos-rt-banner")).toHaveCount(0);
  await expect(modal(win)).toHaveCount(0);
});

test.afterEach(async () => {
  const { win } = app();
  // Every write in this file is the Routines surface's own, and so is every spawn the tab made.
  expect(await guardWrites(app())).toEqual([]);
  expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
  if (await drawer(win).evaluate((d) => d.classList.contains("is-open"))) await drawer(win).locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
});

test("Routines is the one surface on: the status bar names it and what it may touch", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Routines");
  await expect(mode).toHaveAttribute("title", /^Routines: brain\/routines\/\*\.md, cli\/aos\.js, routines\/run-routine\.js\n/);
});

test("off → on writes enabled: true and the sync installs and loads its plist; on → off removes it again (RT4)", async () => {
  const { win } = app();
  const total = ROUTINES().length;
  const others = () => Object.fromEntries(Object.entries(plists()).filter(([f]) => f !== "com.agenticos.weekly-digest.plist"));
  expect(plistText("weekly-digest")).toBeNull();
  let before = state().syncedAt;
  let from = logSize();

  await act(win, "weekly-digest", "off").click();
  await expect.poll(() => onDisk("weekly-digest")).toBe(written("weekly-digest", { enabled: true }));
  await expect(win.locator(".notice-container")).toContainText("weekly-digest: enabled");
  await expect(win.locator(".notice-container")).toContainText("▶ aos.js routines sync");
  await synced(before);
  expect(plistText("weekly-digest")).toContain("<key>Weekday</key><integer>5</integer><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer>");
  expect(launchctlSince(from)).toEqual(expect.arrayContaining([`launchctl unload ${plist("weekly-digest")}`, `launchctl load ${plist("weekly-digest")}`]));
  expect(state().synced["weekly-digest"]).toBe("prompt|0 17 * * 5|on");
  // The sync re-renders every other schedule, byte for byte as before: the live check relies on this.
  expect(others()).toEqual(pristinePlists());
  await expect(row(win, "weekly-digest")).not.toHaveClass(/is-off/);
  await expect(row(win, "weekly-digest").locator(".aos-rt-next")).toHaveText(/^Fri \d{2}-\d{2} 17:00$/);
  await expect(act(win, "weekly-digest", "on")).toBeVisible();
  await expect(C(win).locator(".aos-rt-count")).toHaveText(`${total} on · ${total} total`);

  before = state().syncedAt;
  from = logSize();
  await act(win, "weekly-digest", "on").click();
  // Back to enabled: false. Not the fixture's bytes: the HUD's serializer puts a blank line after the frontmatter,
  // which the seeded file (like every routine `aos init` seeds) does not have.
  await expect.poll(() => onDisk("weekly-digest")).toBe(written("weekly-digest"));
  expect(written("weekly-digest")).toBe(pristine("weekly-digest").replace("---\nSummarise", "---\n\nSummarise"));
  await expect(win.locator(".notice-container")).toContainText("weekly-digest: disabled");
  await synced(before);
  expect(plistText("weekly-digest")).toBeNull();
  const calls = launchctlSince(from);
  expect(calls.at(-1)).toBe(`launchctl unload ${plist("weekly-digest")}`);
  expect(calls).not.toContain(`launchctl load ${plist("weekly-digest")}`);
  expect(state().synced).toEqual(pristineState().synced);
  expect(plists()).toEqual(pristinePlists());
  await expect(row(win, "weekly-digest")).toHaveClass(/is-off/);
  await expect(C(win).locator(".aos-rt-count")).toHaveText(`${total - 1} on · ${total} total`);
});

test("+ new creates a command routine the runtime schedules; delete asks first, and Delete removes the file and its plist (RT2)", async () => {
  const { win } = app();
  const total = ROUTINES().length;
  await C(win).locator(".aos-rt-actions button", { hasText: "+ new" }).click();
  await field(win, /^name/).locator("input").fill("Tide check");
  // The slug follows the name while the slug box is empty.
  await expect(field(win, /^slug/).locator("input")).toHaveValue("tide-check");
  await field(win, /^kind/).locator("select").selectOption("command");
  await field(win, /^schedule \(cron/).locator("input").fill("30 6 * * 1-5");
  await drawer(win).locator("textarea.aos-rt-argv").fill("/usr/bin/true\n--tide\n");
  await field(win, /^timeout seconds/).locator("input").fill("60");
  await field(win, /^tags/).locator("input").fill("harbor, check");
  await drawer(win).locator("textarea.aos-rt-body").fill("Checks the tide tables before the morning run.");
  const before = state().syncedAt;
  const from = logSize();
  await button(win, "create").click();

  const want = routineToFile({
    slug: "tide-check", schema: 1, name: "Tide check", kind: "command", schedule: "30 6 * * 1-5", enabled: true,
    argv: ["/usr/bin/true", "--tide"], timeoutSec: 60, tags: ["harbor", "check"], body: "Checks the tide tables before the morning run.",
  });
  expect(want).toBe('---\nschema: 1\nname: Tide check\nkind: command\nschedule: "30 6 * * 1-5"\nenabled: true\nargv: ["/usr/bin/true", "--tide"]\ntimeoutSec: 60\ntags: [harbor, check]\n---\n\nChecks the tide tables before the morning run.\n');
  await expect.poll(() => onDisk("tide-check")).toBe(want);
  await expect(win.locator(".notice-container")).toContainText("✓ tide-check.md");
  await expect(drawer(win)).not.toHaveClass(/is-open/);
  await synced(before);
  // The runtime read the file the HUD wrote: one calendar entry per weekday.
  expect(plistText("tide-check")?.match(/<key>Hour<\/key><integer>6<\/integer><key>Minute<\/key><integer>30<\/integer>/g)).toHaveLength(5);
  expect(launchctlSince(from)).toContain(`launchctl load ${plist("tide-check")}`);
  expect(state().synced["tide-check"]).toBe("command|30 6 * * 1-5|on");
  await expect(row(win, "tide-check").locator(".aos-rt-cadence")).toHaveText("Weekdays at 06:30");
  await expect(row(win, "tide-check").locator(".aos-pill")).toHaveText("command");
  await expect(row(win, "tide-check").locator(".aos-pulse-chip")).toHaveText("ok");
  await expect(C(win).locator(".aos-rt-count")).toHaveText(`${total} on · ${total + 1} total`);

  // Delete asks first; Cancel keeps everything.
  await act(win, "tide-check", "✎").click();
  await button(win, "delete").click();
  await expect(modal(win).locator("h3")).toHaveText("Delete routine");
  await expect(modal(win).locator("p")).toHaveText("Delete brain/routines/tide-check.md? Its schedule is removed on the next apply.");
  await modal(win).locator("button", { hasText: "Cancel" }).click();
  await expect(modal(win)).toHaveCount(0);
  expect(onDisk("tide-check")).toBe(want);
  await expect(drawer(win)).toHaveClass(/is-open/);

  const again = state().syncedAt;
  const from2 = logSize();
  await button(win, "delete").click();
  await modal(win).locator("button.mod-cta", { hasText: "Delete" }).click();
  await expect.poll(() => onDisk("tide-check")).toBeNull();
  await expect(win.locator(".notice-container")).toContainText("deleted tide-check");
  await expect(drawer(win)).not.toHaveClass(/is-open/);
  await synced(again);
  expect(plistText("tide-check")).toBeNull();
  expect(launchctlSince(from2).at(-1)).toBe(`launchctl unload ${plist("tide-check")}`);
  expect(state().synced).toEqual(pristineState().synced);
  expect(plists()).toEqual(pristinePlists());
  await expect(row(win, "tide-check")).toHaveCount(0);
  await expect(C(win).locator(".aos-rt-count")).toHaveText(`${total - 1} on · ${total} total`);
});

test("create refuses a bad slug, a slug that exists and an invalid routine, and writes nothing", async () => {
  const { win } = app();
  const listing = ROUTINES();
  const before = state().syncedAt;
  await C(win).locator(".aos-rt-actions button", { hasText: "+ new" }).click();
  const slug = field(win, /^slug/).locator("input");
  const errors = drawer(win).locator(".aos-rt-errors");
  await slug.fill("X");
  await button(win, "create").click();
  await expect(errors).toHaveText('slug must be 2-41 chars of a-z, 0-9 and "-"');
  await slug.fill("nightly-scan");
  await field(win, /^name/).locator("input").fill("Another scan");
  await drawer(win).locator("textarea.aos-rt-body").fill("x");
  await button(win, "create").click();
  await expect(errors).toHaveText("routine already exists: brain/routines/nightly-scan.md");
  // A prompt routine with no prompt: the HUD's validation, which mirrors the runtime's.
  await slug.fill("empty-prompt");
  await drawer(win).locator("textarea.aos-rt-body").fill("");
  await button(win, "create").click();
  await expect(errors).toHaveText("invalid routine: a prompt routine needs a body");
  expect(ROUTINES()).toEqual(listing);
  expect(onDisk("nightly-scan")).toBe(pristine("nightly-scan"));
  expect(state().syncedAt).toBe(before);
});

test("a name typed key by key leaves the slug at its first letter, so create refuses it (upstream)", async () => {
  const { win } = app();
  await C(win).locator(".aos-rt-actions button", { hasText: "+ new" }).click();
  // RoutinesTab derives the slug from the name only while the slug box is empty, which holds for the first key only.
  await field(win, /^name/).locator("input").pressSequentially("Tide check");
  await expect(field(win, /^slug/).locator("input")).toHaveValue("t");
  await drawer(win).locator("textarea.aos-rt-body").fill("x");
  await button(win, "create").click();
  await expect(drawer(win).locator(".aos-rt-errors")).toHaveText('slug must be 2-41 chars of a-z, 0-9 and "-"');
  expect(onDisk("t")).toBeNull();
});

test("save rewrites an edited routine and the sync moves its schedule; saving it back restores the plist byte for byte", async () => {
  const { win } = app();
  const original = plistText("nightly-scan");
  let before = state().syncedAt;
  await act(win, "nightly-scan", "✎").click();
  await expect(drawer(win).locator(".aos-wb-drawertitle")).toHaveText("Edit nightly-scan");
  await expect(field(win, /^slug/).locator("input")).toBeDisabled();
  await field(win, /^schedule \(cron/).locator("input").fill("45 3 * * *");
  await field(win, /^timeout seconds/).locator("input").fill("600");
  await button(win, "save").click();
  await expect.poll(() => onDisk("nightly-scan")).toBe(written("nightly-scan", { schedule: "45 3 * * *", timeoutSec: 600 }));
  await expect(win.locator(".notice-container")).toContainText("✓ nightly-scan.md");
  await synced(before);
  expect(plistText("nightly-scan")).toContain("<dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>45</integer></dict>");
  expect(state().synced["nightly-scan"]).toBe("command|45 3 * * *|on");
  await expect(row(win, "nightly-scan").locator(".aos-rt-cadence")).toHaveText("Every day at 03:45");

  before = state().syncedAt;
  await act(win, "nightly-scan", "✎").click();
  await field(win, /^schedule \(cron/).locator("input").fill("15 2 * * *");
  await field(win, /^timeout seconds/).locator("input").fill("300");
  await button(win, "save").click();
  await expect.poll(() => onDisk("nightly-scan")).toBe(written("nightly-scan"));
  await synced(before);
  expect(plistText("nightly-scan")).toBe(original);
  expect(state().synced).toEqual(pristineState().synced);
  await expect(row(win, "nightly-scan").locator(".aos-rt-cadence")).toHaveText("Every day at 02:15");
});

test("saving a disabled routine that stays disabled writes the file and runs no sync", async () => {
  const { win } = app();
  const before = state().syncedAt;
  const from = logSize();
  const syncs = () => app().notices.filter((n) => n.includes("aos.js routines sync")).length;
  const started = syncs();
  await act(win, "weekly-digest", "✎").click();
  await drawer(win).locator("textarea.aos-rt-body").fill("Summarise the week's sessions in three bullets.");
  await button(win, "save").click();
  await expect.poll(() => onDisk("weekly-digest")).toBe(written("weekly-digest", { body: "Summarise the week's sessions in three bullets." }));
  await expect(win.locator(".notice-container")).toContainText("✓ weekly-digest.md");
  await expect(drawer(win)).not.toHaveClass(/is-open/);

  await act(win, "weekly-digest", "✎").click();
  await drawer(win).locator("textarea.aos-rt-body").fill("Summarise the week's sessions in five bullets.");
  await button(win, "save").click();
  await expect.poll(() => onDisk("weekly-digest")).toBe(written("weekly-digest"));
  await expect(drawer(win)).not.toHaveClass(/is-open/);
  // RoutinesTab.save syncs unless the routine was off and stays off. It would start the sync right after its refresh;
  // give that a moment, then check that no sync started and none ran.
  await win.waitForTimeout(1500);
  expect(syncs()).toBe(started);
  expect(state().syncedAt).toBe(before);
  expect(launchctlSince(from)).toEqual([]);
});

test("a guarded duty's schedule change asks first; Write anyway writes it and the sync applies it (RT3)", async () => {
  const { win } = app();
  const original = plistText("monitor");
  let before = state().syncedAt;
  const edit = async (schedule: string) => {
    await act(win, "monitor", "✎").click();
    await field(win, /^schedule \(cron/).locator("input").fill(schedule);
    await button(win, "save").click();
    await expect(modal(win).locator("h3")).toHaveText("Guarded routine");
    await modal(win).locator("button.mod-cta", { hasText: "Write anyway" }).click();
    await expect(modal(win)).toHaveCount(0);
  };
  await edit("0 14 * * *");
  await expect.poll(() => onDisk("monitor")).toBe(written("monitor", { schedule: "0 14 * * *" }));
  await synced(before);
  expect(plistText("monitor")).toContain("<dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>0</integer></dict>");
  expect(state().synced.monitor).toBe("duty|0 14 * * *|on");
  await expect(row(win, "monitor").locator(".aos-rt-cadence")).toHaveText("Every day at 14:00");

  before = state().syncedAt;
  await edit("0 13 * * *");
  await expect.poll(() => onDisk("monitor")).toBe(written("monitor"));
  await synced(before);
  expect(plistText("monitor")).toBe(original);
  expect(state().synced).toEqual(pristineState().synced);
});

test("a schedule changed underneath shows the banner; apply now and apply schedules run the sync (RT2)", async () => {
  const { win } = app();
  const original = plistText("nightly-scan");
  // Another editor (Obsidian, the other HUD) changes the file: the schedules are now out of date.
  fs.writeFileSync(file("nightly-scan"), pristine("nightly-scan").replace('schedule: "15 2 * * *"', 'schedule: "20 2 * * *"'));
  const banner = C(win).locator(".aos-rt-banner");
  await expect(banner).toHaveText("schedules out of date (nightly-scan) — apply now");
  await expect(row(win, "nightly-scan").locator(".aos-pulse-chip")).toHaveText("stale");
  let before = state().syncedAt;
  await banner.locator("a", { hasText: "apply now" }).click();
  await synced(before);
  await expect(banner).toHaveCount(0);
  expect(plistText("nightly-scan")).toContain("<dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>20</integer></dict>");
  await expect(row(win, "nightly-scan").locator(".aos-pulse-chip")).toHaveText("ok");

  fs.writeFileSync(file("nightly-scan"), pristine("nightly-scan"));
  await expect(banner).toHaveText("schedules out of date (nightly-scan) — apply now");
  // In the runtime's file-name order (reflect-daily.md before reflect.md).
  const enabled = Object.keys(pristineState().synced).sort((a, b) => (`${a}.md` < `${b}.md` ? -1 : 1));
  // One other job is not loaded (unloaded by hand, or not loaded since a login), its plist unchanged.
  const idle = enabled.find((x) => x !== "nightly-scan") as string;
  expect(loadedJobs()).toContain(`com.agenticos.${idle}`);
  fs.writeFileSync(LAUNCHD, `${loadedJobs().filter((l) => l !== `com.agenticos.${idle}`).join("\n")}\n`);
  before = state().syncedAt;
  const from = logSize();
  await C(win).locator(".aos-rt-actions button", { hasText: "apply schedules" }).click();
  await synced(before);
  await expect(banner).toHaveCount(0);
  expect(plistText("nightly-scan")).toBe(original);
  expect(plists()).toEqual(pristinePlists());
  // The plist that changed, and the job that was not loaded, are unloaded and loaded again; every other enabled routine,
  // unchanged and loaded, is only asked about and left alone: a sync never stops a routine that is running.
  const calls = launchctlSince(from);
  const redone = enabled.filter((x) => x === "nightly-scan" || x === idle);
  expect(calls.filter((l) => /^launchctl (un)?load /.test(l))).toEqual(redone.flatMap((x) => [`launchctl unload ${plist(x)}`, `launchctl load ${plist(x)}`]));
  for (const x of enabled.filter((y) => !redone.includes(y))) expect(calls).toContain(`launchctl list com.agenticos.${x}`);
  expect(loadedJobs()).toEqual(expect.arrayContaining(enabled.map((x) => `com.agenticos.${x}`)));
});

test("▶ runs a command routine now: run-routine.js records a manual run and the row shows it (RT5)", async () => {
  const { win } = app();
  const was = state().routines["nightly-scan"]?.lastRunAt ?? null;
  await act(win, "nightly-scan", "▶").click();
  await expect(win.locator(".notice-container")).toContainText("▶ run-routine.js nightly-scan --manual");
  await expect.poll(() => state().routines["nightly-scan"]?.lastRunAt ?? null, { timeout: 60_000 }).not.toBe(was);
  expect(state().routines["nightly-scan"]).toMatchObject({ lastExit: 0, lastTrigger: "manual", lastError: null });
  await expect(row(win, "nightly-scan").locator(".aos-rt-last")).toHaveText(/^\d+s ago · exit 0$/);
  await expect(row(win, "nightly-scan").locator(".aos-rt-last")).toHaveAttribute("title", "trigger: manual");
  // Running is not a write: the file and the schedules stay as they were.
  expect(onDisk("nightly-scan")).toBe(pristine("nightly-scan"));
});

test("with only Routines on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
