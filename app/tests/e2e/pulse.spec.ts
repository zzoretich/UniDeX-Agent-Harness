// Pulse (app-smoke: Pulse, Review readiness): pipeline LEDs from the runtime's ledger, the persona-named briefing,
// COST and HEALTH rows, the Fix Queue, the command deck, the Brain tile and area (they summarise, and their numbers jump
// into the Brain tab, which acts: brain-hub D15), the SYSTEM drawer and the embedded terminal. With the Pulse surface
// off, a Fix Queue run is refused. The writes themselves (the Fix Queue runs, re-anchor, /scan, /reflect-week) are in
// pulse-writes.spec.ts.

import { expect, test, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { FX, badge, closeNotes, closePulse, content, drawer, expected, guardWrites, noteBody, notePath, openTab, pulseArea, rail, readVaultJson, resizeHud, useApp } from "./harness";

const app = useApp();

// ── the Brain tile (brain-hub D15, D16) ──

interface TrailRow { ts: string; action: string; slug: string; type: string; title?: string }
type WrittenState = "written" | "kept" | "archived" | "superseded" | "gone";

const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const vaultText = (rel: string): string | null => (fs.existsSync(FX.v(rel)) ? fs.readFileSync(FX.v(rel), "utf8") : null);
const memoryFile = (r: TrailRow): string => `brain/memory/${r.type}/${r.slug}.md`;
const stateOf = (text: string | null): WrittenState => {
  if (text === null) return "gone";
  const status = /^tags:.*\bstatus\/(archived|superseded)\b/m.exec(text);
  if (status) return status[1] as WrittenState;
  return /^reviewed: false$/m.test(text) ? "written" : "kept";
};

/**
 * What the Brain tile and area show, read from the fixture's files as data/pulseFacts.ts, views/pulse/model.ts and
 * data/brainModel.ts read them: today's `written` trail rows (one per memory, newest first) and the state of each file,
 * brain-hub.json's unreviewed count, the feedback drafts, BRAIN.md against its budget (brain-sources.json), and the
 * memories written after `marker` (when Review was last open) that still wait: the rail badge's count.
 */
function brainNumbers(marker: string | null) {
  const trail = (vaultText("brain/_index/promote-log.jsonl") ?? "").split("\n").flatMap((l): TrailRow[] => { try { return l.trim() ? [JSON.parse(l) as TrailRow] : []; } catch { return []; } });
  const today = new Map<string, TrailRow>();
  for (const r of trail) if (r.action === "written" && r.slug && localDay(new Date(r.ts)) === localDay(new Date())) { today.delete(memoryFile(r)); today.set(memoryFile(r), r); }
  const written = [...today.values()].reverse().map((r) => ({ path: memoryFile(r), title: r.title || r.slug, state: stateOf(vaultText(memoryFile(r))) }));
  const after = new Set(trail.filter((r) => r.action === "written" && r.slug && marker !== null && Date.parse(r.ts) > Date.parse(marker)).map(memoryFile));
  const hub = vaultText("brain/_index/brain-hub.json");
  const hubDoc = hub ? (JSON.parse(hub) as { schema?: number; counts?: { unreviewed?: unknown }; batches?: Array<{ paths?: string[] }> }) : null;
  // brain-hub.json lags the files: today's memories that still wait and that no batch of it holds count too (D12).
  const inHub = new Set((hubDoc?.batches ?? []).flatMap((b) => b.paths ?? []));
  const unseen = written.filter((w) => w.state === "written" && !inHub.has(w.path)).length;
  const sources = vaultText("brain/_index/brain-sources.json");
  const src = sources ? (JSON.parse(sources) as { schema?: number; budget?: number; tokens?: number }) : null;
  const drafts = fs.existsSync(FX.v("brain/memory/feedback/_drafts")) ? fs.readdirSync(FX.v("brain/memory/feedback/_drafts")).filter((f) => f.endsWith(".md")).length : 0;
  return {
    written,
    pending: written.filter((w) => w.state === "written").length,
    since: [...after].filter((p) => stateOf(vaultText(p)) === "written").length,
    toReview: hubDoc?.schema === 1 ? (typeof hubDoc.counts?.unreviewed === "number" ? hubDoc.counts.unreviewed : 0) + unseen : null,
    drafts,
    pct: src?.schema === 1 && typeof src.budget === "number" && src.budget > 0 && typeof src.tokens === "number" ? Math.round((src.tokens / src.budget) * 100) : null,
  };
}

/** When Review was last open on this machine (the plugin's brainReviewSeenAt, brain-hub D16). */
const reviewSeenAt = (win: Page): Promise<string | null> =>
  win.evaluate(() => (window as unknown as { aosHost: { plugin: { settings: { brainReviewSeenAt: string | null } } } }).aosHost.plugin.settings.brainReviewSeenAt);

const brainTile = (win: Page): Locator => content(win).locator('.aos-pulse-tile[data-area="memory"]');
const brainMode = (win: Page, mode: string): Locator => content(win).locator(`.aos-brain-modes .aos-brain-mode[data-mode="${mode}"]`);

/** The Brain tile is a card whose numbers jump into the Brain tab: its head opens the popup, as Needs you's does. */
async function brainArea(win: Page): Promise<Locator> {
  const modal = win.locator(".modal.mod-pulse");
  if (await modal.count()) return pulseArea(win, "memory");
  await brainTile(win).locator(".aos-pulse-tile-headbtn").click();
  await expect(modal.locator(".aos-pp-navbtn.is-on")).toHaveAttribute("data-area", "memory");
  return modal;
}

/** The Brain tab is showing `mode`, reached from Pulse (the rail id stays "memory", D16). */
async function expectBrain(win: Page, mode: string): Promise<void> {
  await expect(win.locator(".modal.mod-pulse")).toHaveCount(0);
  await expect(rail(win, "memory")).toHaveClass(/is-active/);
  await expect(brainMode(win, mode)).toHaveAttribute("aria-selected", "true");
  await expect(content(win).locator(".aos-brain-body")).toHaveAttribute("data-mode", mode);
}

interface Snapshot { health: { issues: Array<{ severity: string; area: string }> } }
interface Ledger { pipelines: Record<string, { lastRun: { status: string; reason?: string | null } | null }> }

test.beforeEach(async () => { await closePulse(app().win); await openTab(app().win, "pulse"); });

test("LEDs: every manifest pipeline; never-ran and disabled stages are gray with the reason on hover; nothing red", async () => {
  const { win } = app();
  await pulseArea(win, "health");
  const strip = win.locator(".aos-pulse-strip .aos-pulse-chip");
  const labels = (await strip.allTextContents()).map((t) => t.trim());
  for (const short of ["SCAN", "WRAP", "COST", "BACKFILL", "STAFF", "MAP", "AWRAP", "BRAIN", "EMBED", "GRAPH", "SEM"]) {
    expect(labels.some((l) => l.startsWith(`${short} `)), `LED ${short}`).toBe(true);
  }
  // Ledger rows beyond the manifest (the routine runs) get a chip of their own.
  const ledger = readVaultJson<Ledger>("brain/_index/pipelines.json");
  for (const name of Object.keys(ledger.pipelines).filter((n) => n.startsWith("routine:"))) {
    expect(labels).toContainEqual(expect.stringMatching(new RegExp(`^${name.toUpperCase()} `)));
  }
  expect(labels).toContain("EMBED off");
  const embed = win.locator(".aos-pulse-strip .aos-pulse-chip", { hasText: "EMBED off" });
  await expect(embed).toHaveClass(/is-neutral/);
  await expect(embed).toHaveAttribute("title", /embed-vault: disabled — no-embed/);
  await expect(win.locator(".aos-pulse-strip .aos-pulse-chip", { hasText: "GRAPH off" })).toHaveAttribute("title", /graphify missing/);
  const wrap = win.locator(".aos-pulse-strip .aos-pulse-chip", { hasText: /^WRAP/ });
  await expect(wrap).toHaveClass(/is-neutral/);
  await expect(wrap).toHaveAttribute("title", "session-summary: no recorded runs yet");
  await expect(win.locator(".aos-pulse-strip .aos-pulse-chip", { hasText: /^SCAN ok/ })).toHaveClass(/is-ok/);
  await expect(win.locator(".aos-pulse-strip .aos-pulse-chip.is-failed, .aos-pulse-strip .aos-pulse-chip.is-died")).toHaveCount(0);
});

test("briefing row is labelled with the persona's name from persona/IDENTITY.md", async () => {
  const { win } = app();
  await expect(win.locator(".aos-pulse-briefing .aos-briefing-label")).toHaveText(expected().persona);
  // No briefing.json in the fixture: the paragraph is composed from the facts, and each phrase opens what it names.
  await expect(win.locator(".aos-pulse-band-src")).toHaveText("Chief of Staff · composed from the facts");
  await expect(win.locator(".aos-pulse-briefing .aos-briefing-text")).toContainText(/^Good (morning|afternoon|evening)\./);
  const chip = win.locator(".aos-briefing-text .aos-pulse-ent").first();
  const area = await chip.getAttribute("data-area");
  await chip.click();
  await expect(win.locator(".modal.mod-pulse .aos-pp-navbtn.is-on")).toHaveAttribute("data-area", area!);
  await closePulse(win);
  // The fixture's vault has the briefing routine (vault-template seeds it): the band offers ↻, not "Turn on".
  await expect(win.locator(".aos-pulse-iconbtn[aria-label='Write the briefing now']")).toBeVisible();
  await expect(win.locator(".aos-pulse-turnon")).toHaveCount(0);
  // The band's two buttons, one per top item, never read alike (meta.test.ts: two of a kind name their items).
  const acts = win.locator(".aos-pulse-band-side .aos-pulse-act");
  await expect(acts).toHaveCount(2);
  const [first, second] = await acts.allTextContents();
  expect(first).not.toBe(second);
});

test("COST row (cost on, a $175 budget) and HEALTH row counts", async () => {
  const { win } = app();
  await pulseArea(win, "health");
  const cost = win.locator(".aos-pulse-row", { has: win.locator(".aos-pulse-rowlabel", { hasText: /^COST$/ }) });
  await expect(cost).toContainText(/\$[\d.]+ this month · [\d.]+% of \$175\.00/);
  const issues = readVaultJson<Snapshot>("brain/_index/snapshot.json").health.issues;
  const errs = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warn").length;
  const health = win.locator(".aos-pulse-row", { has: win.locator(".aos-pulse-rowlabel", { hasText: /^HEALTH$/ }) });
  await expect(health).toContainText(`${errs} err · ${warns} warn`);
  await expect(health.locator("span").nth(1)).toHaveClass(errs ? /aos-text-rose/ : /aos-text-amber/);
});

test("Fix Queue: health errors, stale artifacts, the cost anchor and the uncosted sessions, errors first", async () => {
  const { win } = app();
  await pulseArea(win, "health");
  const issues = readVaultJson<Snapshot>("brain/_index/snapshot.json").health.issues;
  const errs = issues.filter((i) => i.severity === "error").length;
  const stale = issues.filter((i) => i.area === "artifacts").length;
  const cards = win.locator(".aos-pulse-fixq .aos-pulse-fix");
  const titles = (await cards.locator(".aos-pulse-fix-title").allTextContents()).map((t) => t.trim());
  const want = [
    ...(errs ? [`${errs} health error(s)`] : []),
    ...(stale ? [`${stale} stale artifact(s)`] : []),
    "Cost tracking not yet anchored",
    "2 session(s) missing cost",
  ];
  expect(titles).toEqual(want);
  await expect(win.locator(".aos-pulse-fixq-title")).toHaveText(`Fix queue (${want.length})`);
  await expect(cards.first()).toHaveClass(/is-error/);
  await expect(cards.filter({ hasText: "2 session(s) missing cost" }).locator("a")).toHaveText("▶ run auto-cost.js --backfill");
  await expect(cards.filter({ hasText: "Cost tracking not yet anchored" }).locator("a")).toHaveText("▶ re-anchor…");
});

test("Fix Queue: ▸ open on the health card opens brain/_index/health.md", async () => {
  const { win } = app();
  await pulseArea(win, "health");
  await win.locator(".aos-pulse-fix", { hasText: "health error(s)" }).locator("a", { hasText: "▸ open" }).click();
  await expect(win.locator(".aos-host-tab.is-active .aos-host-tab-title")).toHaveText("health");
  await expect(notePath(win)).toHaveText("brain/_index/health.md");
  await expect(noteBody(win)).toContainText("CLAUDE.md is missing");
  await closeNotes(win);
});

test("command deck lists the registry commands with their kind and description", async () => {
  const { win } = app();
  const deck = win.locator(".aos-pulse-deck");
  await expect(deck.locator(".aos-deck-label")).toHaveText("Commands");
  const names = (await deck.locator(".aos-deck-btn").allTextContents()).map((t) => t.trim());
  expect(names).toEqual(expect.arrayContaining(["/scan", "/reflect-week", "/remember", "/pattern", "/wrap", "/ask-brain"]));
  await expect(deck.locator(".aos-deck-btn", { hasText: "/scan" })).toHaveAttribute("title", /· /);
});

test("command deck: /brain opens BRAIN.md; /remember and /pattern open their forms, and Cancel writes nothing", async () => {
  const h = app();
  const { win } = h;
  const writes = await guardWrites(h);
  const deck = win.locator(".aos-pulse-deck");
  await deck.locator(".aos-deck-btn", { hasText: "/brain" }).click();
  await expect(notePath(win)).toHaveText("brain/_index/BRAIN.md");
  await closeNotes(win);
  await deck.locator(".aos-deck-btn", { hasText: "/remember" }).click();
  const modal = win.locator(".modal");
  await expect(modal.locator("h2")).toHaveText("Remember");
  await expect(modal.locator("textarea")).toHaveAttribute("placeholder", "A note for this session's working memory…");
  await modal.locator("button", { hasText: "Cancel" }).click();
  await expect(win.locator(".modal")).toHaveCount(0);
  await deck.locator(".aos-deck-btn", { hasText: "/pattern" }).click();
  await expect(win.locator(".modal .modal-content")).toContainText(/area/i);
  await win.keyboard.press("Escape");
  await expect(win.locator(".modal")).toHaveCount(0);
  // ⌘⇧M: the plugin's own hotkey for Quick Capture, dispatched by the host.
  await win.keyboard.press("Meta+Shift+M");
  await expect(win.locator(".modal .modal-content")).toContainText("Quick Capture");
  await win.keyboard.press("Escape");
  expect(await guardWrites(h)).toEqual(writes);
});

test("the Brain tile: today and since you looked, the three numbers that jump, and a way into Review; no keep, edit or revert", async () => {
  const { win } = app();
  const marker = await reviewSeenAt(win);
  await openTab(win, "pulse");   // drawn again with that marker
  const b = brainNumbers(marker);
  // The fixture writes memories today, a feedback draft, and both caches (scan-vault, build-brain-md): none of this is vacuous.
  expect(b.written.length).toBeGreaterThan(0);
  expect(b.pending).toBeGreaterThan(0);
  expect(b.drafts).toBeGreaterThan(0);
  expect(b.toReview).not.toBeNull();
  expect(b.pct).not.toBeNull();
  const tile = brainTile(win);
  await expect(tile).toHaveClass(/is-card/);
  await expect(tile.locator(".aos-pulse-tile-label")).toHaveText("Brain");
  await expect(tile.locator(".aos-pulse-tile-headbtn")).toHaveAttribute("aria-label", "Brain: open");
  await expect(tile.locator(".aos-pulse-big-n")).toHaveText(String(b.written.length));
  await expect(tile.locator(".aos-pulse-big-label")).toHaveText(`today · ${b.since} since you looked`);
  const link = (id: string) => tile.locator(`[data-brain-link="${id}"]`);
  await expect(tile.locator(".aos-pulse-brainlinks [data-brain-link]")).toHaveCount(3);
  await expect(link("review").locator(".aos-pulse-brainlink-n")).toHaveText(String(b.toReview));
  await expect(link("review").locator(".aos-pulse-brainlink-k")).toHaveText("to review →");
  await expect(link("review")).toHaveClass(b.toReview ? /is-warn/ : /is-off/);
  await expect(link("drafts").locator(".aos-pulse-brainlink-n")).toHaveText(String(b.drafts));
  await expect(link("drafts").locator(".aos-pulse-brainlink-k")).toHaveText(`${b.drafts === 1 ? "draft" : "drafts"} →`);
  await expect(link("drafts")).toHaveClass(/is-gate/);
  await expect(link("bootstrap").locator(".aos-pulse-brainlink-n")).toHaveText(`${b.pct}%`);
  await expect(link("bootstrap").locator(".aos-pulse-brainlink-k")).toHaveText("BRAIN.md →");
  await expect(link("bootstrap")).toHaveClass(b.pct! >= 100 ? /is-warn/ : /is-off/);
  await expect(link("today")).toHaveText(`Review today’s ${b.pending} in Brain →`);
  // A card, not a button: no button holds another, and nothing on it keeps, edits or reverts (brain-hub D6).
  expect(await tile.evaluate((el) => el.tagName)).toBe("DIV");
  await expect(tile.locator("button button")).toHaveCount(0);
  await expect(tile.locator("button, a").filter({ hasText: /^(keep|edit|revert)$/i })).toHaveCount(0);
});

test("the Brain tile's numbers open the Brain tab: to review and Review today's on Review, drafts on its Drafts queue, BRAIN.md on Bootstrap; nothing is written", async () => {
  const h = app();
  const { win } = h;
  const writes = await guardWrites(h);
  for (const [id, mode] of [["review", "review"], ["drafts", "review"], ["bootstrap", "bootstrap"], ["today", "review"]] as const) {
    await openTab(win, "pulse");
    await brainTile(win).locator(`[data-brain-link="${id}"]`).click();
    await expectBrain(win, mode);
    // The Drafts queue is the one Review shows pressed (its queue chips mark the open queue).
    if (id === "drafts") await expect(content(win).locator('button.aos-brain-chip[data-queue="drafts"]')).toHaveAttribute("aria-pressed", "true");
  }
  // Review was open: the tile and the rail badge count from then (D16), so what was written before reads zero.
  await openTab(win, "pulse");
  const b = brainNumbers(await reviewSeenAt(win));
  await expect(brainTile(win).locator(".aos-pulse-big-label")).toHaveText(`today · ${b.since} since you looked`);
  if (!b.since) await expect(badge(win, "memory")).toHaveText("");
  expect(await guardWrites(h)).toEqual(writes);
});

test("the Brain area: the numbers as rows that jump, then today's writes read only, each opening in Library; no keep, edit or revert", async () => {
  const h = app();
  const { win } = h;
  const writes = await guardWrites(h);
  const b = brainNumbers(await reviewSeenAt(win));
  const modal = await brainArea(win);
  await expect(modal.locator(".aos-pp-title")).toHaveText("Brain");
  await expect(modal.locator(".aos-pp-head .aos-pp-btn", { hasText: "Open the Brain tab" })).toBeVisible();
  await expect(modal.locator('.aos-pp-navbtn[data-area="memory"] .aos-pp-navlabel')).toHaveText("Brain");
  await expect(modal.locator('.aos-pp-navbtn[data-area="memory"] .aos-pp-navcount')).toHaveText(String(b.toReview));
  const sum = (id: string) => modal.locator(`.aos-pp-row[data-brain-link="${id}"]`);
  await expect(sum("review").locator(".aos-pp-rowtitle")).toHaveText(`${b.toReview} to review`);
  await expect(sum("review").locator("button")).toHaveText(["Review →"]);
  await expect(sum("drafts").locator(".aos-pp-rowtitle")).toHaveText(`${b.drafts} feedback ${b.drafts === 1 ? "draft" : "drafts"}`);
  await expect(sum("drafts").locator("button")).toHaveText(["Review →"]);
  await expect(sum("bootstrap").locator(".aos-pp-rowtitle")).toHaveText(`BRAIN.md ${b.pct}% of its budget`);
  await expect(sum("bootstrap").locator("button")).toHaveText(["Open →"]);
  // Written today: newest first, one row per memory, its state as its file is now; only Open → on each.
  await expect(modal.locator(".aos-pp-section")).toHaveText("Written today");
  const rows = modal.locator(".aos-pp-row[data-memory]");
  await expect(rows).toHaveCount(b.written.length);
  expect(await rows.evaluateAll((els) => els.map((e) => [e.getAttribute("data-memory"), e.getAttribute("data-state")]))).toEqual(b.written.map((w) => [w.path, w.state]));
  await expect(rows.locator(".aos-pp-rowtitle")).toHaveText(b.written.map((w) => w.title));
  await expect(rows.locator("button")).toHaveText(b.written.filter((w) => w.state !== "gone").map(() => "Open →"));
  await expect(modal.locator("button, a").filter({ hasText: /^(keep|edit|revert)$/i })).toHaveCount(0);
  await expect(modal.locator(".aos-trail")).toHaveCount(0);
  // Open → shows that memory in Library, selected.
  const first = b.written.find((w) => w.state !== "gone")!;
  const title = /^#[ \t]+(.+?)[ \t]*$/m.exec(vaultText(first.path)!.replace(/^---\n[\s\S]*?\n---\n/, ""))![1];
  await modal.locator(`.aos-pp-row[data-memory="${first.path}"]`).locator("button", { hasText: "Open →" }).click();
  await expectBrain(win, "library");
  const row = content(win).locator(`button.aos-lib-row[role="option"][data-path="${first.path}"]`);
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(row.locator(".aos-lib-rowtitle")).toHaveText(title);
  // The summary rows land as the tile's numbers do.
  for (const [id, mode] of [["review", "review"], ["drafts", "review"], ["bootstrap", "bootstrap"]] as const) {
    await openTab(win, "pulse");
    await (await brainArea(win)).locator(`.aos-pp-row[data-brain-link="${id}"] button`).click();
    await expectBrain(win, mode);
  }
  await openTab(win, "pulse");
  expect(await guardWrites(h)).toEqual(writes);
});

test("Needs you and Decisions: the memories to review and the feedback drafts jump into Brain's Review, not into a terminal", async () => {
  const { win } = app();
  const go = async (area: string, row: RegExp): Promise<void> => {
    await openTab(win, "pulse");
    const modal = await pulseArea(win, area);
    await modal.locator(".aos-pp-row", { hasText: row }).locator("button", { hasText: "Review →" }).click();
    await expectBrain(win, "review");
    await expect(rail(win, "term")).not.toHaveClass(/is-active/);
  };
  await go("needs", /written today, not yet reviewed/);
  await go("needs", /feedback drafts? waiting for review/);
  await go("proposals", /feedback rule drafts?/);
  await openTab(win, "pulse");
});

test("SYSTEM drawer: inventory counts and lists, the DISK donut and the COST DETAIL sparkline as SVG", async () => {
  const { win } = app();
  await pulseArea(win, "health");
  await win.locator(".aos-pulse-row a", { hasText: "SYSTEM ▸" }).click();
  const d = drawer(win);
  await expect(d).toHaveClass(/is-open/);
  await expect(d.locator(".aos-wb-drawertitle")).toHaveText("System");
  const inv = d.locator(".aos-panel", { hasText: "INVENTORY" });
  await expect(inv.locator(".aos-inv-strip .aos-pill")).toHaveText(["0 agents", "0 skills", "1 commands", "0 hooks"]);
  await inv.locator(".aos-inv-tab", { hasText: "commands (1)" }).click();
  await expect(inv.locator(".aos-inv-table .aos-inv-name")).toHaveText(["/standup-lite"]);
  await inv.locator(".aos-inv-input").fill("zzz");
  await expect(inv.locator(".aos-inv-table")).toContainText("no matches");
  // DISK: a donut built from SVG nodes (no innerHTML) and a legend.
  const disk = d.locator(".aos-panel", { hasText: "DISK" });
  await expect(disk.locator(".aos-disk-chart svg")).toHaveCount(1);
  expect(await disk.locator(".aos-disk-chart svg *").count()).toBeGreaterThan(1);
  expect(await disk.locator(".aos-disk-legend-row").count()).toBeGreaterThan(1);
  // COST DETAIL: tiles, the budget bar and a sparkline SVG.
  const cost = d.locator(".aos-panel", { hasText: "COST DETAIL" });
  await expect(cost.locator(".aos-panel-title")).toContainText("/$175");
  await expect(cost.locator(".aos-tile-label")).toHaveText(["this month", "budget", "remaining", "projected"]);
  await expect(cost.locator(".aos-trend-spark svg")).toHaveCount(1);
  await expect(cost.locator(".aos-budget-note")).toContainText("(no anchor set)");
  await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  await expect(d).not.toHaveClass(/is-open/);
});

test("Pulse has no terminal: terminals live in the Code tab", async () => {
  const { win } = app();
  await openTab(win, "pulse");
  await expect(content(win)).toContainText("Needs you");
  await expect(content(win).locator(".xterm, .aos-term, .aos-term-collapsed")).toHaveCount(0);
});

test("listener leak: switching Pulse → Brain → Pulse → Code → Pulse does not add terminal-pool listeners", async () => {
  const { win } = app();
  // Obsidian keeps them in Events._; the compat Events keeps them in _handlers.
  const count = () => win.evaluate(() => {
    const pool = (window as unknown as { aosHost: { plugin: { terminalPool: { _handlers: Map<string, unknown[]> } } } }).aosHost.plugin.terminalPool;
    return pool._handlers.get("session-add")?.length ?? 0;
  });
  const cycle = async () => { for (const t of ["memory", "pulse", "term", "pulse"]) await openTab(win, t); };
  await cycle();
  const once = await count();
  for (let i = 0; i < 4; i++) await cycle();
  expect(await count()).toBe(once);
  expect(once).toBeLessThanOrEqual(1);   // the Term tab's panel, kept for its next visit (Pulse has none)
  await expect(content(win)).toContainText("Needs you");
  await expect(rail(win, "pulse")).toHaveClass(/is-active/);
});

test("with the Pulse surface off, a Fix Queue run is refused: the costs stay as they were", async () => {
  const h = app();
  const costs = FX.v("brain/_index/agent-runs/costs.jsonl");
  const before = fs.existsSync(costs) ? fs.readFileSync(costs, "utf8") : null;
  await pulseArea(h.win, "health");
  await h.win.locator(".aos-pulse-fixq .aos-pulse-fix", { hasText: "session(s) missing cost" }).locator("a").click();
  await expect(h.win.locator(".notice-container")).toContainText("spawn failed: brain/scripts/auto-cost.js");
  await expect.poll(async () => (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what)).toEqual([expect.stringMatching(/\/auto-cost\.js --backfill$/)]);
  expect(fs.existsSync(costs) ? fs.readFileSync(costs, "utf8") : null).toEqual(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});

test("the cockpit: Pulse follows Notifications on the rail and is Home; ten tiles; the badge counts what needs you; no scrollbar at 960×600", async () => {
  const h = app();
  const { win } = h;
  const ids = await win.locator(".aos-wb-railtabs .aos-wb-railbtn").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
  // Notifications heads the rail and Pulse comes next (spec 2026-10-09-rail-sections-code D1); Home stays Pulse (D4).
  expect(ids.slice(0, 3)).toEqual(["notifications", "pulse", "term"]);
  await openTab(win, "todo");
  await win.locator(".aos-wb-mark").click();
  await expect(rail(win, "pulse")).toHaveClass(/is-active/);
  await expect(content(win).locator(".aos-pulse-grid > .aos-pulse-tile")).toHaveCount(10);
  const needs = await content(win).locator(".aos-pulse-tile[data-area='needs'] .aos-pulse-pill").textContent();
  await expect(win.locator('.aos-wb-railbtn[data-tab="pulse"] .aos-wb-railbadge')).toHaveText(needs!.trim());
  const noScroll = () => win.evaluate(() => { const c = document.querySelector(".aos-wb-content") as HTMLElement; return c.scrollHeight <= c.clientHeight; });
  expect(await noScroll()).toBe(true);
  await resizeHud(h.app, { width: 960, height: 600 });
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(960);
  await expect.poll(noScroll).toBe(true);
  // Every tile keeps its headline; rows that do not fit become "+N more".
  await expect(content(win).locator(".aos-pulse-tile .aos-pulse-tile-label")).toHaveCount(10);
  await expect(content(win).locator(".aos-pulse-more:not(.is-empty)").first()).toHaveText(/^\+\d+ more/);
  await resizeHud(h.app, { width: 1480, height: 920 });
});

test("the tiles refit when the band grows after they were fitted: no row is cut at a list's foot", async () => {
  const { win } = app();
  const cut = () => win.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".aos-pulse-cockpit .aos-pulse-list")).flatMap((list) =>
    (Array.from(list.children) as HTMLElement[]).filter((r) => r.style.display !== "none" && r.offsetTop + r.offsetHeight > list.clientHeight + 1).map((r) => r.textContent)));
  await expect.poll(cut).toEqual([]);
  // A paragraph that wraps once more, or a font that loads late, makes the band taller while the pane keeps its size.
  const band = win.locator(".aos-pulse-cockpit .aos-pulse-band");
  await band.evaluate((el) => { (el as HTMLElement).style.paddingBottom = "120px"; });
  await expect.poll(cut).toEqual([]);
  await band.evaluate((el) => { (el as HTMLElement).style.paddingBottom = ""; });
  await expect.poll(cut).toEqual([]);
});

test("the popup: a tile opens its area, the list switches areas without closing, ↑↓ walk it, Esc closes", async () => {
  const { win } = app();
  const modal = await pulseArea(win, "notifications");
  await expect(modal.locator(".aos-pp-title")).toHaveText("Notifications");
  await expect(modal.locator(".aos-pp-navbtn")).toHaveCount(10);
  await modal.locator('.aos-pp-navbtn[data-area="routines"]').click();
  await expect(modal.locator(".aos-pp-title")).toHaveText("Routines");
  await expect(modal.locator(".aos-pp-row").first()).toBeVisible();
  await modal.locator(".aos-pp-navbtn.is-on").press("ArrowDown");
  await expect(modal.locator(".aos-pp-title")).toHaveText("Spend");
  await win.keyboard.press("Escape");
  await expect(win.locator(".modal.mod-pulse")).toHaveCount(0);
});

test("Workspaces: the tile and the popup list the visible workspaces only, as many rows as the count (spaces-redesign D22)", async () => {
  const { win } = app();
  const snap = readVaultJson<{ workspaces: Array<{ name: string; hidden?: boolean }> }>("brain/_index/snapshot.json");
  const visible = snap.workspaces.filter((w) => !w.hidden).map((w) => w.name).sort();
  expect(snap.workspaces.filter((w) => w.hidden).map((w) => w.name)).toEqual(expect.arrayContaining(["_spikes", "_archive/pier-repairs"]));
  const tile = content(win).locator(".aos-pulse-tile[data-area='workspaces']");
  await expect(tile.locator(".aos-pulse-tile-head .aos-pulse-clip")).toHaveText(new RegExp(`^${visible.length} · `));
  // Rows past the tile's height are hidden by fit(), not removed, so every row is still counted here.
  await expect(tile.locator(".aos-pulse-li")).toHaveCount(visible.length);
  expect((await tile.locator(".aos-pulse-li-title").allTextContents()).sort()).toEqual(visible);
  const modal = await pulseArea(win, "workspaces");
  await expect(modal.locator(".aos-pp-sub")).toHaveText(new RegExp(`^${visible.length} workspaces · `));
  expect((await modal.locator(".aos-pp-list .aos-pp-rowtitle").allTextContents()).sort()).toEqual(visible);
  await closePulse(win);
});

test("a decision jumps: Review → on a proposal opens its review in a terminal in Code", async () => {
  const { win } = app();
  const modal = await pulseArea(win, "proposals");
  await modal.locator(".aos-pp-row", { hasText: "proposal" }).first().locator("button", { hasText: "Review →" }).click();
  await expect(win.locator(".modal.mod-pulse")).toHaveCount(0);
  await expect(rail(win, "term")).toHaveClass(/is-active/);
  await openTab(win, "pulse");
});
