// Pulse with its write surface on (AOS_APP_WRITE=pulse): the Fix Queue's runtime re-runs (the uncosted-sessions
// backfill, the brain rebuild); the cost anchor; and the deck's /scan and /reflect-week (app-smoke P5, P6). The Fix
// Queue and the deck run runtime scripts; the tests check what those scripts leave behind. Pulse writes no memory: the
// Brain tab acts on memories through the brain surface's verbs (brain-hub D14, D15), so the old trail's keep, edit and
// revert are gone, and so are the surface's writes to brain/memory, MEMORY.md and the trail.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { closePulse, content, FX, guardWrites, openTab, pulseArea, readVaultJson, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "pulse" } });

const read = (rel: string): string | null => (fs.existsSync(FX.v(rel)) ? fs.readFileSync(FX.v(rel), "utf8") : null);

const fixCard = (win: Page, title: string | RegExp) => win.locator(".aos-pulse-fixq .aos-pulse-fix", { has: win.locator(".aos-pulse-fix-title", { hasText: title }) });
const deck = (win: Page, name: string) => content(win).locator(".aos-deck-btn", { hasText: new RegExp(`^${name.replace("/", "\\/")}\\b`) });

test.beforeEach(async () => { await closePulse(app().win); await openTab(app().win, "pulse"); });

test.afterEach(async () => {
  // Every write in this file is Pulse's own, and every spawn it made ran.
  expect(await guardWrites(app())).toEqual([]);
  expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
});

test("Pulse is the one surface on: the status bar names it and what it may touch, its spawns only (no memory writes)", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Pulse");
  await expect(mode).toHaveAttribute("title", /^Pulse: auto-cost\.js, heartbeat-writer\.js, graph-build\.js, build-brain-md\.js, map-workspace\.js, cost-budget\.js, sdk\/reflect-week\.js, persona\/briefing\.js\n/);
});

test("Fix Queue: the uncosted-sessions card runs the auto-cost backfill, which costs them, and the card goes", async () => {
  const { win } = app();
  await pulseArea(app().win, "health");
  const card = fixCard(win, "2 session(s) missing cost");
  await expect(card.locator("a")).toHaveText("▶ run auto-cost.js --backfill");
  const costs = read("brain/_index/agent-runs/costs.jsonl") ?? "";
  await card.locator("a").click();
  await expect(win.locator(".notice-container")).toContainText("▶ auto-cost.js --backfill");
  await expect.poll(() => (read("brain/_index/agent-runs/costs.jsonl") ?? "").length, { timeout: 30_000 }).toBeGreaterThan(costs.length);
  await expect(card).toHaveCount(0, { timeout: 15_000 });
});

test("Fix Queue: the stale-artifacts card rebuilds the brain artifacts with build-brain-md.js", async () => {
  const { win } = app();
  await pulseArea(app().win, "health");
  const card = fixCard(win, /^\d+ stale artifact\(s\)$/);
  await expect(card.locator("a")).toHaveText("▶ run build-brain-md.js");
  const brain = FX.v("brain/_index/BRAIN.md");
  const mtime = fs.statSync(brain).mtimeMs;
  await card.locator("a").click();
  await expect(win.locator(".notice-container")).toContainText("▶ build-brain-md.js");
  await expect.poll(() => fs.statSync(brain).mtimeMs, { timeout: 30_000 }).toBeGreaterThan(mtime);
});

test("Fix Queue: re-anchor asks for the billed figure, refuses a bad one, and cost-budget.js stamps the anchor", async () => {
  const { win } = app();
  await pulseArea(app().win, "health");
  const card = fixCard(win, "Cost tracking not yet anchored");
  expect(read("brain/_index/cost-budget.json")).toBeNull();
  await card.locator("a", { hasText: "▶ re-anchor…" }).click();
  const modal = win.locator(".modal");
  await expect(modal.locator("h3")).toHaveText("Re-anchor cost budget");
  const input = modal.locator(".setting-item input[type=text]");
  const anchor = modal.locator("button.mod-cta", { hasText: "Anchor" });
  // A negative or unreadable figure keeps the dialog open and runs nothing.
  for (const bad of ["-5", "lots"]) {
    await input.fill(bad);
    await anchor.click();
    await expect(modal).toBeVisible();
  }
  await input.fill("42.50");
  await anchor.click();
  await expect(modal).toHaveCount(0);
  await expect(win.locator(".notice-container")).toContainText("▶ cost-budget.js --anchor 42.5");
  const month = new Date().toISOString().slice(0, 7);
  await expect.poll(() => (read("brain/_index/cost-budget.json") ?? "").length, { timeout: 30_000 }).toBeGreaterThan(0);
  const budget = readVaultJson<Record<string, unknown>>("brain/_index/cost-budget.json");
  expect(JSON.stringify(budget)).toContain(month);
  expect(JSON.stringify(budget)).toContain("42.5");
  await expect(card).toHaveCount(0, { timeout: 15_000 });
});

test("deck /scan runs scan-vault.js and reports its summary (P5)", async () => {
  const { win } = app();
  const snapshot = FX.v("brain/_index/snapshot.json");
  const mtime = fs.statSync(snapshot).mtimeMs;
  await deck(win, "/scan").click();
  await expect(win.locator(".notice-container")).toContainText("▶ /scan");
  await expect(win.locator(".notice-container")).toContainText(/✓ \/scan: scanned \d+ folders/, { timeout: 30_000 });
  expect(fs.statSync(snapshot).mtimeMs).toBeGreaterThan(mtime);
});

test("deck /reflect-week runs reflect-week.js --local; with no provider it reports why and writes no reflection (P6)", async () => {
  const { win } = app();
  const dir = FX.v("brain/reflections");
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  await deck(win, "/reflect-week").click();
  await expect(win.locator(".notice-container")).toContainText("▶ /reflect-week");
  await expect(win.locator(".notice-container")).toContainText("✗ /reflect-week: [reflect] no model provider for the reasoner", { timeout: 30_000 });
  expect(fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []).toEqual(before);
});

test("with only Pulse on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
