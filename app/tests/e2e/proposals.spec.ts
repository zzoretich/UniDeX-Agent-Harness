// Proposals (app-smoke: Proposals): pending proposals with lint, the expanded detail, rendered
// proposal pages, BACKLOG and HISTORY from the ledger, the live badge, and the Review button's terminal session.
// Deciding a proposal is the flag-closer skill's job, never the tab's.

import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, appEnv, badge, closeNotes, content, expected, noteBody, notePath, openTab, terminalText, useApp } from "./harness";

const app = useApp();
const P = () => content(app().win);
const row = (slug: string) => P().locator(".aos-pr-row", { has: app().win.locator(".aos-rt-name > div", { hasText: new RegExp(`^${slug}$`) }) });

test.beforeEach(async () => { await openTab(app().win, "proposals"); });

test("head, review button and the 28-day rates line (matching ledger.js summary)", async () => {
  const e = expected().proposals;
  await expect(P().locator(".aos-rt-count")).toHaveText(`${e.pending.length} pending · ${e.backlog.length} in backlog`);
  const review = P().locator(".aos-rt-actions button");
  await expect(review).toHaveText("Review in Claude ❯_");
  await expect(review).toHaveAttribute("title", 'Opens a terminal in Code, in the vault, running: claude "review persona flags"');
  const pct = (r: number | null | undefined) => (r == null ? "n/a" : `${Math.round(r * 100)}%`);
  await expect(P().locator(".aos-pr-rates")).toHaveText(`last 28 d · approval ${pct(e.ledger?.approvalRate)} · accept ${pct(e.ledger?.acceptRate)}`);
});

test("PENDING: slug, target, kind and surface pills, age and lint; no auto-apply streak", async () => {
  const { win } = app();
  await expect(badge(win, "proposals")).toHaveText("3");
  const trim = row("trim-playbook");
  await expect(trim.locator(".aos-rt-slug")).toHaveText("persona/PLAYBOOK.md");
  await expect(trim.locator(".aos-pill")).toHaveText(["self"]);
  await expect(trim.locator(".aos-pill").first()).toHaveClass(/aos-pill-cyan/);
  await expect(trim.locator(".aos-pr-age")).toHaveText("5d");
  await expect(trim.locator(".aos-pr-streak")).toHaveCount(0); // spec 2026-10-24-persona-learning-loop-design D1
  const sitrep = row("todo-in-sitrep");
  await expect(sitrep.locator(".aos-pill")).toHaveText(["product", "hud"]);
  await expect(sitrep.locator(".aos-pill").first()).toHaveClass(/aos-pill-green/);
  const loose = row("no-surface");
  await expect(loose.locator(".aos-pr-lint")).toHaveText("⚠ 3");
  await expect(loose.locator(".aos-pr-lint")).toHaveAttribute("title", /missing recheck recipe\nmissing premise table\nproduct proposal names no surface/);
  await expect(loose.locator(".aos-pr-streak")).toHaveCount(0);
});

test("a row expands to the decision, recipe, What / Why / Risk as Markdown and the premise table", async () => {
  await row("trim-playbook").click();
  const d = P().locator(".aos-pr-detail");
  await expect(d.locator(".aos-pr-meta > div").first()).toHaveText("needs: approve / reject");
  await expect(d.locator(".aos-pr-meta code")).toHaveText("grep -q 'Old heading' persona/PLAYBOOK.md");
  await expect(d.locator(".aos-pr-meta")).not.toContainText("auto-apply"); // spec 2026-10-24-persona-learning-loop-design D1
  await expect(d.locator(".aos-pr-md h4")).toHaveText(["What", "Why", "Risk"]);
  await expect(d.locator(".aos-pr-md code").first()).toHaveText("## Old heading");
  await expect(d.locator(".aos-pr-premises .aos-rt-subhead")).toHaveText("PREMISES · 1 verified / 1 assumed");
  await expect(d.locator(".aos-pr-premise .aos-pill")).toHaveText(["VERIFIED", "ASSUMED"]);
  await expect(row("trim-playbook").locator(".aos-pr-caret")).toHaveText("▾");
  await row("trim-playbook").click();
  await expect(P().locator(".aos-pr-detail")).toHaveCount(0);
  await row("todo-in-sitrep").click();
  await expect(P().locator(".aos-pr-detail .aos-pr-meta > div").first()).toHaveText("needs: accept → backlog / dismiss");
  await row("todo-in-sitrep").click();
});

test("proposal pages: a rendered page opens in the browser; a proposal filed after the scan says it will appear", async () => {
  const h = app();
  await row("trim-playbook").click();
  const link = P().locator(".aos-pr-detail .aos-pr-open a", { hasText: "Open the proposal in browser" });
  await expect(link).toBeVisible();
  const page = expected().proposals.pages.find((p) => p.endsWith("-trim-playbook.html"));
  expect(page).toBeTruthy();
  await link.click();
  await expect.poll(async () => (await h.opened()).map((o) => `${o.fn} ${o.arg}`)).toContain(`openPath ${path.join(FX.vault, "brain/_index/proposals", page!)}`);
  await row("trim-playbook").click();
  await row("no-surface").click();
  await expect(P().locator(".aos-pr-detail .aos-pr-open")).toHaveText("The proposal's HTML page appears after the next scan.");
  await row("no-surface").click();
});

test("Open file opens the proposal note in a new tab", async () => {
  const { win } = app();
  await row("todo-in-sitrep").click();
  await P().locator(".aos-pr-detail a", { hasText: "Open file" }).click();
  const name = expected().proposals.pending.find((p) => p.slug === "todo-in-sitrep")!.name;
  await expect(notePath(win)).toHaveText(`persona/proposals/${name}`);
  await expect(noteBody(win)).toContainText("List the to-dos due today in the morning sitrep.");
  await closeNotes(win);
  await row("todo-in-sitrep").click();
});

test("group heads collapse and expand", async () => {
  const head = P().locator(".aos-pr-grouphead", { hasText: "PENDING" });
  await expect(head).toHaveText("▾ PENDING (3)");
  await head.click();
  await expect(P().locator(".aos-pr-grouphead", { hasText: "PENDING" })).toHaveText("▸ PENDING (3)");
  await expect(row("trim-playbook")).toHaveCount(0);
  await P().locator(".aos-pr-grouphead", { hasText: "PENDING" }).click();
  await expect(row("trim-playbook")).toHaveCount(1);
});

test("BACKLOG lists persona/backlog.md newest first and opens an entry's body", async () => {
  const { win } = app();
  const e = expected().proposals.backlog;
  const head = P().locator(".aos-pr-grouphead", { hasText: "BACKLOG" });
  await expect(head).toHaveText(`▾ BACKLOG (${e.length})`);
  const table = head.locator("xpath=following-sibling::div[1]");
  await expect(table.locator(".aos-rt-name > div:first-child")).toHaveText([...e].reverse().map((b) => b.slug));
  await expect(table.locator(".aos-pr-age").first()).toHaveText(/^accepted \d{4}-\d{2}-\d{2} by user$/);
  await table.locator(".aos-pr-row").first().click();
  // The entry opens in the reading pane beside the groups (UniDeX D4).
  const reader = P().locator(".aos-pr-reader");
  await expect(reader.locator(".aos-pr-md")).toContainText("A legend for chart symbols.");
  // Its proposal was filed, rendered and accepted: the page outlives the file, so the entry still links it.
  const page = reader.locator(".aos-rt-rowactions a", { hasText: "Open the proposal in browser" });
  await expect(page).toHaveAttribute("title", /brain\/_index\/proposals\/\d{4}-\d{2}-\d{2}-chart-legend\.html$/);
  await reader.locator("a", { hasText: "Open backlog" }).click();
  await expect(notePath(win)).toHaveText("persona/backlog.md");
  await closeNotes(win);
  await table.locator(".aos-pr-row").first().click();
});

test("HISTORY: ledger outcomes newest first, no filed rows, marked ✓ ✗ ◇ –", async () => {
  const head = P().locator(".aos-pr-grouphead", { hasText: "HISTORY" });
  const table = head.locator("xpath=following-sibling::div[1]");
  await expect(table.locator(".aos-pr-event")).toHaveText(["accepted", "verified", "dismissed", "accepted", "rejected", "approved", "rejected"]);
  await expect(table.locator(".aos-pr-mark")).toHaveText(["◇", "✓", "–", "◇", "✗", "✓", "✗"]);
  await expect(table.locator(".aos-rt-name")).toHaveText(["chart-legend", "quiet-hooks", "tile-preview", "weekly-digest-idea", "loud-wrap", "quiet-hooks", "ancient-idea"]);
  await expect(table.locator(".aos-pr-row", { hasText: "loud-wrap" })).toHaveAttribute("title", "too noisy");
  // A slug whose page exists links it from its history row.
  await expect(table.locator(".aos-pr-row", { hasText: "chart-legend" }).locator(".aos-pr-pagelink")).toHaveText("page ↗");
  await expect(table.locator(".aos-pr-pagelink")).toHaveCount(1);
});

test("proposal-html.js run in the vault: within a second the new proposal's row opens its page", async () => {
  const name = expected().proposals.pending.find((p) => p.slug === "no-surface")!.name;
  await row("no-surface").click();
  await expect(P().locator(".aos-pr-detail .aos-pr-open")).toHaveText("The proposal's HTML page appears after the next scan.");
  // What the next scan (or a hand run) does: the runtime renders the page and links it from the Markdown.
  const r = spawnSync(process.execPath, [FX.v("brain/scripts/persona/proposal-html.js"), "--root", FX.vault], { env: appEnv(), encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout.trim().split("\n").pop()!).rendered).toContain(name);
  await expect(P().locator(".aos-pr-detail .aos-pr-open a")).toHaveText("Open the proposal in browser", { timeout: 2000 });
  expect(fs.readFileSync(FX.v(`persona/proposals/${name}`), "utf8")).toMatch(/\*\*\[Open the proposal in browser\]\(file:\/\/.*\.html\)\*\*/);
  await row("no-surface").click();
});

test("badge: a proposal copied in shows within a second with another tab active, and goes when deleted", async () => {
  const { win } = app();
  await openTab(win, "spaces");
  const src = FX.v(`persona/proposals/${expected().proposals.pending[1].name}`);
  const copy = FX.v("persona/proposals/2026-01-01-demo.md");
  fs.copyFileSync(src, copy);
  await expect(badge(win, "proposals")).toHaveText("4", { timeout: 2000 });
  fs.rmSync(copy);
  await expect(badge(win, "proposals")).toHaveText("3", { timeout: 2000 });
});

test("Review in Claude ❯_ opens Code with a new session in the vault running the review", async () => {
  const { win } = app();
  const sessions = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { list(): unknown[] } } } }).aosHost.plugin.terminalPool.list().length);
  await P().locator(".aos-rt-actions button", { hasText: "Review in Claude" }).click();
  await expect(win.locator(".aos-wb-railbtn[data-tab='term']")).toHaveClass(/is-active/);
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture claude stub] review persona flags");
  const after = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { list(): Array<{ id: string }> } } } }).aosHost.plugin.terminalPool.list().map((s) => s.id));
  expect(after.length).toBe(sessions + 1);
  // The new session is the one on screen.
  await expect(win.locator(".aos-wb-content .aos-term-tab.aos-term-tab-active")).toHaveAttribute("data-session", after[after.length - 1]);
  // It is a Claude Code row, started from Proposals (spec 2026-10-08-term-agent-deck).
  await expect(win.locator(".aos-wb-content .aos-term-tab.aos-term-tab-active")).toHaveAttribute("data-host", "claude");
  await expect(win.locator(".aos-wb-content .aos-tl-group[data-group='vault']")).toHaveCount(1);
  await expect(win.locator(".aos-wb-content .aos-term-tab.aos-term-tab-active .aos-tl-origin")).toHaveText("from Proposals");
});
