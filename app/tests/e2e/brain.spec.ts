// Brain (app-smoke: Brain; the Memory items of Spaces / Memory / Runs). The Memory tab became the Brain hub (spec
// 2026-10-11-brain-hub, PR 2): the rail button and the palette command, the header with its five modes as a tablist,
// their counts, ⌘F and the search that opens Library; Review's batches by session (THIS WEEK, EARLIER folded), a batch's
// header and cards with the near-duplicate's flag, the comparison (M), ↑↓ and ⏎, the queues (Drafts, Duplicates,
// Older than 30d) and "Mark everything before …"; Library's kinds, facets, reader (Edit, ⧉ into the split pane's Memory
// inspector, IN BRAIN.MD AS) and context (LINKED FROM, NEARBY, HISTORY); Map's force view ("Every node"); the Bootstrap
// and Health stand-ins; the rail badge; an agenticos:// link. Read-only: with the brain surface off a Keep is refused and
// nothing changes. The writes themselves (keep, the batch, archive and restore, pin, keep the older one, keep both, a
// draft's approve and reject, status, Mark everything before) are in brain-writes.spec.ts, and a Codex-only machine's
// Brain in variants.spec.ts.

import { expect, test, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FX, badge, closeNotes, command, content, expected, guardWrites, notePath, openTab, rail, readVaultJson, useApp,
} from "./harness";
import { BRAIN_OFF_TEXT, batchMeta, batchWhen, defaultMarkBefore, shortDay } from "../../../obsidian-plugin/src/data/brainModel";

const app = useApp();
const C = () => content(app().win);
const B = () => expected().brain;

// ── the fixture, read as the hub reads it ────────────────────────────

interface Sources { budget: number; tokens: number; sections: Record<"who" | "rules" | "active", { paths: string[]; tokens: number }> }
const sources = () => readVaultJson<Sources>("brain/_index/brain-sources.json");
const TRAIL = "brain/_index/promote-log.jsonl";
interface TrailRow { ts: string; action: string; type: string; slug: string; path?: string }
const trail = (): TrailRow[] => fs.readFileSync(FX.v(TRAIL), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TrailRow);
const read = (rel: string): string => fs.readFileSync(FX.v(rel), "utf8");
const pristine = (rel: string): string => fs.readFileSync(path.join(FX.pristine, "vault", rel), "utf8");
/** A frontmatter key's value, as lib/memory-ops.js getKey reads it. */
const fmKey = (rel: string, key: string): string | null => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(read(rel));
  const m = fm ? new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(fm[1]) : null;
  return m ? m[1] : null;
};
/** MEMORY.md's description for a memory (`- [Title](path) — description`). */
const indexDesc = (rel: string): string => new RegExp(`^- \\[[^\\]]*\\]\\(${rel.replace(/[.]/g, "\\.")}\\) — (.*)$`, "m").exec(read("MEMORY.md"))![1];
/** When a memory was written: the trail's `written` row, else its `created:` day (brainModel.ts writtenAt). */
const writtenAt = (rel: string): string => {
  const [, type, slug] = /^brain\/memory\/([^/]+)\/(.+)\.md$/.exec(rel)!;
  const rows = trail().filter((r) => r.action === "written" && r.type === type && r.slug === slug).map((r) => r.ts).sort();
  return rows.pop() ?? fmKey(rel, "created") ?? "";
};
const localTime = (s: string): number => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
/** Every file under brain/memory (the drafts included), with its text: what a read-only action must leave as it was. */
function memoryTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const n of fs.readdirSync(path.join(root, rel))) {
      const r = `${rel}/${n}`;
      if (fs.statSync(path.join(root, r)).isDirectory()) walk(r); else out[r] = fs.readFileSync(path.join(root, r), "utf8");
    }
  };
  walk("brain/memory");
  return out;
}
const live = () => B().memories.filter((p) => !B().archived.includes(p));
const pl = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const thisWeek = () => B().batches.filter((b) => localTime(b.at) >= Date.now() - 7 * 24 * 3600 * 1000);
const earlier = () => B().batches.filter((b) => !thisWeek().includes(b));
const byKey = (key: string) => B().batches.find((b) => b.key === key)!;

// ── locators ─────────────────────────────────────────────────────────

const modeTab = (m: string) => C().locator(`.aos-brain-modes [role="tab"][data-mode="${m}"]`);
const body = () => C().locator(".aos-brain-body");
const search = () => C().locator("input.aos-brain-searchinput");
const queue = (q: string) => C().locator(`.aos-brain-rv-queues button.aos-brain-chip[data-queue="${q}"]`);
const batchRow = (key: string) => C().locator(`.aos-brain-rv-left button.aos-brain-rv-batch[data-key="${key}"]`);
const main = () => C().locator(".aos-brain-rv-main");
const card = (rel: string) => main().locator(`article.aos-brain-rv-card[data-path="${rel}"]`);
const libRow = (rel: string) => C().locator(`.aos-lib-list button.aos-lib-row[data-path="${rel}"]`);
const libRows = () => C().locator(".aos-lib-list button.aos-lib-row");
const reader = () => C().locator("section.aos-lib-reader");
const context = () => C().locator("aside.aos-lib-context");
const csec = (key: string) => context().locator(`section.aos-lib-csec[data-section="${key}"]`);
const kind = (k: string) => C().locator(`.aos-lib-kinds button.aos-lib-kind[data-kind="${k}"]`);
/** A Library facet: its native select under the dashed chip (transparent, so selectOption, not a click). */
const facet = (name: string) => C().locator(`.aos-lib-facets select.aos-lib-oversel[aria-label="${name}"]`);
const facetText = (key: string) => C().locator(`.aos-lib-facet[data-facet="${key}"] .aos-lib-facettext`);
const paths = (rows: Locator) => rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-path")!));

/** Shows a mode with its tab and waits until its body is drawn. */
async function mode(m: string): Promise<void> {
  await modeTab(m).click();
  await expect(modeTab(m)).toHaveAttribute("aria-selected", "true");
  await expect(body()).toHaveAttribute("data-mode", m);
}
/** Opens Brain on a mode (the tab keeps the last mode it showed). */
async function brain(m: string): Promise<void> {
  await openTab(app().win, "memory");
  await mode(m);
}
async function showQueue(q: string): Promise<void> {
  await queue(q).click();
  await expect(queue(q)).toHaveAttribute("aria-pressed", "true");
}
async function pickBatch(key: string): Promise<void> {
  await showQueue("session");
  await batchRow(key).click();
  await expect(batchRow(key)).toHaveAttribute("aria-selected", "true");
  await expect(main().locator("h2.aos-brain-h2")).toHaveText(byKey(key).title);
}
async function libraryShow(k: string): Promise<void> {
  await kind(k).click();
  await expect(kind(k)).toHaveAttribute("aria-pressed", "true");
}
/** Clears the guard's log, so a test's refusals are its own. */
const clearGuard = () => app().win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });

test.afterEach(async () => {
  // The page reads the brain and writes nothing itself: every action is an `aos memory` verb (refused here).
  expect(await guardWrites(app())).toEqual([]);
});

// ── the tab ──────────────────────────────────────────────────────────

test("the rail button reads Brain with its id still memory, and the palette's Open Workbench: Brain opens it (D16)", async () => {
  const { win } = app();
  const btn = rail(win, "memory");
  await expect(btn).toHaveAttribute("aria-label", "Brain");
  await expect(btn).toHaveAttribute("title", "Brain");
  await expect(btn.locator(".aos-wb-raillabel")).toHaveText("Brain");
  await expect(btn.locator(".aos-wb-railicon")).toHaveAttribute("data-icon", "brain");
  const cmds = await win.evaluate(() => (window as unknown as { aosHost: { app: { commands: { list(): Array<{ id: string; name: string }> } } } })
    .aosHost.app.commands.list().map((c) => ({ id: c.id, name: c.name })));
  expect(cmds.find((c) => c.id === "agentic-os:open-workbench-memory")?.name).toBe("Open Workbench: Brain");
  expect(cmds.filter((c) => /Memory/.test(c.name) && c.id.startsWith("agentic-os:open-workbench"))).toEqual([]);
  await openTab(win, "pulse");
  expect(await command(win, "agentic-os:open-workbench-memory")).toBe(true);
  await expect(btn).toHaveClass(/is-active/);
  await expect(C().locator("h1.aos-brain-h1")).toHaveText("Brain");
});

test("the header: Brain, the store in one line, and the five modes as a tablist with Review's, Library's and Bootstrap's counts", async () => {
  await brain("review");
  const counts = B().counts;
  await expect(C().locator("h1.aos-brain-h1")).toHaveText("Brain");
  // Live memories (the archived one is not), patterns and reflections, then what landed a day over two weeks.
  await expect(C().locator(".aos-brain-stats")).toHaveText(new RegExp(`^${pl(live().length, "memory", "memories")} · ${pl(counts.patterns, "pattern")} · ${pl(counts.reflections, "reflection")}( · \\+\\d+ a day)?$`));
  const strip = C().locator(".aos-brain-modes");
  await expect(strip).toHaveAttribute("role", "tablist");
  await expect(strip).toHaveAttribute("aria-label", "Brain modes");
  await expect(strip.locator('[role="tab"] .aos-brain-modelabel')).toHaveText(["Review", "Library", "Bootstrap", "Map", "Health"]);
  expect(await strip.locator('[role="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-selected")))).toEqual(["true", "false", "false", "false", "false"]);
  // One Tab stop: the selected mode.
  expect(await strip.locator('[role="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("tabindex")))).toEqual(["0", "-1", "-1", "-1", "-1"]);
  // Review: what waits (amber); Library: the live store; Bootstrap: BRAIN.md against its budget; Map and Health none.
  const src = sources();
  const pct = Math.round((src.tokens / src.budget) * 100);
  expect(B().unreviewed.length).toBeGreaterThan(0);
  await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveText(String(B().unreviewed.length));
  await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveClass(/is-warn/);
  await expect(modeTab("review")).toHaveAttribute("aria-label", `Review, ${B().unreviewed.length}`);
  await expect(modeTab("library").locator(".aos-brain-modebadge")).toHaveText(String(live().length));
  await expect(modeTab("library").locator(".aos-brain-modebadge")).not.toHaveClass(/is-warn/);
  await expect(modeTab("bootstrap").locator(".aos-brain-modebadge")).toHaveText(`${pct}%`);
  for (const m of ["map", "health"]) {
    await expect(modeTab(m).locator(".aos-brain-modebadge")).toHaveClass(/is-empty/);
    await expect(modeTab(m)).toHaveAttribute("aria-label", m === "map" ? "Map" : "Health");
  }
  await expect(search()).toHaveAttribute("placeholder", "Search titles and bodies…");
  await expect(C().locator("button.aos-brain-capture")).toHaveAttribute("aria-label", "Quick Capture");
});

test("←/→ move between the modes and show them; ⌘F focuses the search, and typing opens Library, filters it and keeps the focus", async () => {
  const { win } = app();
  await brain("review");
  await modeTab("review").focus();
  await win.keyboard.press("ArrowRight");
  await expect(modeTab("library")).toHaveAttribute("aria-selected", "true");
  await expect(modeTab("library")).toBeFocused();
  await expect(body()).toHaveAttribute("data-mode", "library");
  await win.keyboard.press("ArrowLeft");
  await expect(modeTab("review")).toHaveAttribute("aria-selected", "true");
  // It wraps: ← from the first is the last; End and Home jump.
  await win.keyboard.press("ArrowLeft");
  await expect(modeTab("health")).toHaveAttribute("aria-selected", "true");
  await expect(body()).toHaveAttribute("data-mode", "health");
  await win.keyboard.press("Home");
  await expect(modeTab("review")).toHaveAttribute("aria-selected", "true");
  await expect(modeTab("review")).toBeFocused();

  await win.keyboard.press("Meta+f");
  await expect(search()).toBeFocused();
  await win.keyboard.type("datum");
  await expect(modeTab("library")).toHaveAttribute("aria-selected", "true");
  await expect(body()).toHaveAttribute("data-mode", "library");
  expect(await paths(libRows())).toEqual(["brain/memory/reference/chart-datum.md"]);
  await expect(C().locator(".aos-lib-count")).toHaveText("1 MATCH");
  await expect(search()).toBeFocused();
  // Every word, over titles and bodies: "five digits" is in two memories' bodies, "string" in one of them.
  await search().fill("five digits string");
  expect(await paths(libRows())).toEqual(["brain/memory/reference/station-id-format.md"]);
  await search().fill("zz-nothing-matches");
  await expect(C().locator(".aos-lib-count")).toHaveText("0 MATCHES");
  await expect(reader()).toHaveText("No memories match.");
  await search().press("Escape");
  await expect(search()).toHaveValue("");
  await expect(search()).toBeFocused();
  await expect(libRows()).toHaveCount(live().length);
  await mode("review");
});

// ── Review ───────────────────────────────────────────────────────────

test.describe("Review", () => {
  test.beforeEach(async () => { await brain("review"); await showQueue("session"); });

  test("By session: this week's batches newest first, each with its title, host and dot, count, known pill and lead; the 45-day one folded under EARLIER", async () => {
    const now = new Date();
    const week = thisWeek();
    // The fixture: today's Claude Code session (titled by its transcript), today's Codex wrap of yesterday's thread
    // (titled by its first prompt, as Sessions does), the trail's sample session; the pruned one is 45 days old.
    expect(week.map((b) => b.host)).toEqual(["claude", "claude", "codex"]);
    expect(earlier().map((b) => b.key)).toEqual([B().sessions.pruned]);
    const list = C().locator(".aos-brain-rv-list");
    await expect(list.locator(".aos-brain-rv-group").first()).toHaveText(`THIS WEEK${pl(week.reduce((n, b) => n + b.paths.length, 0), "memory", "memories")} · ${pl(week.length, "session")}`);
    const rows = list.locator('[role="listbox"][aria-label="This week\'s sessions"] button.aos-brain-rv-batch');
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-key")))).toEqual(week.map((b) => b.key));
    await expect(rows.locator(".aos-brain-rv-rtitle")).toHaveText(week.map((b) => b.title));
    await expect(rows.locator(".aos-brain-rv-when")).toHaveText(week.map((b) => batchWhen(b.at, now)));
    await expect(rows.locator(".aos-brain-rv-rmeta > .aos-brain-mono")).toHaveText(week.map((b) => b.host ?? "wrap"));
    expect(await rows.locator(".aos-brain-dot").evaluateAll((els) => els.map((e) => e.className))).toEqual(week.map((b) => `aos-brain-dot is-${b.host}`));
    await expect(rows.locator(".aos-brain-rv-rmeta > span:nth-child(2)")).toHaveText(week.map((b) => `${b.paths.length} new`));
    // The Claude Code session wrote the near-duplicate: one of its memories looks known (D11); the others none.
    const claude = batchRow(B().sessions.claude);
    await expect(claude.locator(".aos-brain-pill.is-warn")).toHaveText("1 looks known");
    await expect(rows.locator(".aos-brain-pill")).toHaveCount(1);
    // The lead: the first memory's title, since many sessions share one name.
    await expect(rows.locator(".aos-brain-rv-lead")).toHaveText(week.map((b) => b.lead!));
    await expect(rows.first()).toHaveAttribute("aria-selected", "true");
    await expect(rows.first()).toHaveAttribute("tabindex", "0");

    // EARLIER: folded, its rows not drawn until it opens.
    const fold = list.locator("button.aos-brain-rv-fold");
    const old = earlier()[0];
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(fold).toHaveText(`EARLIER${pl(old.paths.length, "memory", "memories")} · 1 session`);
    await expect(batchRow(old.key)).toHaveCount(0);
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    // Its transcript is gone, so the hub names it by its id and day; no host wrote it that the index knows: "wrap".
    await expect(batchRow(old.key).locator(".aos-brain-rv-rtitle")).toHaveText(`Session ${old.key.slice(0, 8)} · ${old.at}`);
    await expect(batchRow(old.key).locator(".aos-brain-rv-rmeta > .aos-brain-mono")).toHaveText("wrap");
    await expect(batchRow(old.key).locator(".aos-brain-dot")).toHaveClass("aos-brain-dot");
    await expect(batchRow(old.key).locator(".aos-brain-rv-when")).toHaveText(shortDay(old.at, now));
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(batchRow(old.key)).toHaveCount(0);
  });

  test("a batch: its header (title, meta, lede, Keep the N new with ⇧K) and its cards with their type, title, summary and actions; the near-duplicate is flagged", async () => {
    const b = byKey(B().sessions.claude);
    const [dupA, dupB] = B().duplicate;
    const score = B().dups.find((d) => [d.a, d.b].sort().join() === [dupA, dupB].sort().join())!.score;
    await pickBatch(b.key);
    const head = main().locator("header.aos-brain-rv-head");
    await expect(main()).toHaveAttribute("aria-label", b.title);
    await expect(head.locator(".aos-brain-rv-meta")).toHaveText(batchMeta({ host: b.host, at: b.at, session: b.session }, new Date()));
    await expect(head.locator(".aos-brain-rv-meta")).toHaveText(/^claude · today \d{2}:\d{2} · session c1a0de00$/);
    await expect(head.locator(".aos-brain-rv-lede")).toHaveText("Wrote 3 memories. 2 look new, 1 looks like one you already have.");
    const keepNew = head.locator("button.aos-brain-rv-keepnew");
    await expect(keepNew).toHaveText("Keep the 2 new⇧K");
    await expect(keepNew.locator("kbd")).toHaveText("⇧K");
    await expect(keepNew).toHaveAttribute("aria-keyshortcuts", "Shift+K");
    await expect(keepNew).toBeEnabled();

    // The cards, oldest written first: the batch's paths.
    const cards = main().locator("article.aos-brain-rv-card");
    expect(await paths(cards)).toEqual(b.paths);
    await expect(cards.locator(".aos-brain-type")).toHaveText(b.paths.map((p) => p.split("/")[2]));
    await expect(cards.locator(".aos-brain-rv-ctitle")).toHaveText(["Prefer small diffs in reviews", "Chart overlay refresh", "Station id format"]);
    await expect(cards.locator(".aos-brain-rv-sum")).toHaveText(b.paths.map(indexDesc));
    // The flag names the memory it looks like and the score (D11); only the near-duplicate has one, and only it can merge.
    await expect(cards.locator(".aos-brain-rv-flag")).toHaveCount(1);
    await expect(card(dupA).locator(".aos-brain-rv-flag")).toHaveText(`looks like Prefer small diffs · ${score.toFixed(2)}`);
    for (const p of b.paths) {
      const acts = card(p).locator(".aos-brain-rv-acts button");
      expect(await acts.evaluateAll((els) => els.map((e) => [e.getAttribute("data-act"), e.getAttribute("aria-label"), e.getAttribute("aria-keyshortcuts")]))).toEqual([
        ["keep", "Keep (K)", "K"], ["edit", "Edit (E)", "E"], ["merge", "Merge (M)", "M"], ["archive", "Archive (A)", "A"],
        ["pin", "Pin to BRAIN.md (P)", "P"], ["open", "Open in Library (⏎)", "Enter"],
      ]);
      if (p === dupA) await expect(card(p).locator('button[data-act="merge"]')).toBeEnabled();
      else {
        await expect(card(p).locator('button[data-act="merge"]')).toBeDisabled();
        await expect(card(p).locator('button[data-act="merge"]')).toHaveAttribute("title", "Nothing looks like this one");
      }
    }
    await expect(cards.first()).toHaveAttribute("aria-current", "true");
    // More batch actions: Keep all and Archive all, as a menu; Escape closes it and gives the focus back.
    const more = head.locator("button.aos-brain-rv-more");
    await expect(more).toHaveAttribute("aria-haspopup", "menu");
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(head.locator('[role="menu"] [role="menuitem"]')).toHaveText(["Keep all 3", "Archive all 3…"]);
    await expect(head.locator('[role="menuitem"]').first()).toBeFocused();
    await app().win.keyboard.press("Escape");
    await expect(head.locator('[role="menu"]')).toHaveCount(0);
    await expect(more).toBeFocused();
    await expect(main().locator("footer.aos-brain-rv-keys > span")).toHaveText(["↑↓ move", "K keep", "E edit", "M merge", "A archive", "P pin", "⇧K keep the batch", "⏎ open in Library"]);
  });

  test("M opens the comparison, by key and by button: this one beside the one it looks like, with Keep the older one, Keep both and Open both; ↑↓ move the selection, ⏎ opens it in Library", async () => {
    const { win } = app();
    const b = byKey(B().sessions.claude);
    const [dupA, dupB] = B().duplicate;
    const score = B().dups[0].score.toFixed(2);
    await pickBatch(b.key);
    // A click on a card (not on a button) selects it and takes the keyboard.
    await card(dupA).locator(".aos-brain-rv-sum").click();
    await expect(card(dupA)).toHaveAttribute("aria-current", "true");
    await expect(card(dupA)).toBeFocused();
    await win.keyboard.press("m");
    const cmp = card(dupA).locator(".aos-brain-rv-compare");
    await expect(card(dupA)).toHaveClass(/is-open/);
    await expect(card(dupA).locator('button[data-act="merge"]')).toHaveAttribute("aria-expanded", "true");
    const boxes = cmp.locator(".aos-brain-rv-box");
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(0).locator(".aos-brain-label")).toHaveText("THIS ONE · NEW");
    await expect(boxes.nth(0).locator(".aos-brain-rv-boxtext")).toHaveText(indexDesc(dupA));
    await expect(boxes.nth(0).locator(".aos-brain-rv-boxmeta")).toHaveText("feedback/prefer-small-diffs-in-reviews.md");
    await expect(boxes.nth(1)).toHaveAttribute("data-path", dupB);
    await expect(boxes.nth(1).locator(".aos-brain-rv-boxlabel")).toHaveText(`LOOKS LIKE${score} similar`);
    await expect(boxes.nth(1).locator(".aos-brain-rv-boxtitle")).toHaveText("Prefer small diffs");
    await expect(boxes.nth(1).locator(".aos-brain-rv-boxtext")).toHaveText(indexDesc(dupB));
    await expect(boxes.nth(1).locator(".aos-brain-rv-boxmeta")).toHaveText(`feedback · ${shortDay(fmKey(dupB, "created"), new Date())}`);
    await expect(card(dupA).locator(".aos-brain-rv-cmpacts button")).toHaveText(["Keep the older one", "Keep both", "Open both"]);
    await win.keyboard.press("m");
    await expect(cmp).toHaveCount(0);
    await expect(card(dupA)).not.toHaveClass(/is-open/);
    // The Merge button does the same; on a card with no look-alike it is off, so M there does nothing.
    await card(dupA).locator('button[data-act="merge"]').click();
    await expect(card(dupA).locator(".aos-brain-rv-compare")).toHaveCount(1);
    await card(dupA).locator('button[data-act="merge"]').click();
    await expect(card(dupA).locator(".aos-brain-rv-compare")).toHaveCount(0);

    // ↑↓ move the selection through the cards, the keyboard with it; it stops at either end.
    await card(dupA).locator(".aos-brain-rv-sum").click();
    await win.keyboard.press("ArrowDown");
    await expect(card(b.paths[1])).toHaveAttribute("aria-current", "true");
    await expect(card(b.paths[1])).toBeFocused();
    await expect(card(dupA)).not.toHaveAttribute("aria-current", "true");
    await win.keyboard.press("m");
    await expect(main().locator(".aos-brain-rv-compare")).toHaveCount(0);
    await win.keyboard.press("ArrowDown");
    await win.keyboard.press("ArrowDown");
    await expect(card(b.paths[2])).toHaveAttribute("aria-current", "true");
    await win.keyboard.press("ArrowUp");
    await expect(card(b.paths[1])).toHaveAttribute("aria-current", "true");
    await expect(card(b.paths[1])).toBeFocused();
    // ⏎ opens the selected card in Library, selected there.
    await win.keyboard.press("Enter");
    await expect(modeTab("library")).toHaveAttribute("aria-selected", "true");
    await expect(libRow(b.paths[1])).toHaveAttribute("aria-selected", "true");
    await expect(reader().locator("h2")).toHaveText("Chart overlay refresh");
    // Edit opens the file and changes nothing by itself (D4).
    await brain("review");
    await card(b.paths[1]).locator('button[data-act="edit"]').click();
    await expect(notePath(win)).toHaveText(b.paths[1]);
    await closeNotes(win);
    expect(read(b.paths[1])).toBe(pristine(b.paths[1]));
  });

  test("the queues and their counts: Drafts with the draft's Approve, Reject… and Edit; Duplicates as an older and a newer box; Older than 30d with the 45-day memory", async () => {
    const now = new Date();
    const chips = C().locator(".aos-brain-rv-queues button.aos-brain-chip");
    await expect(C().locator(".aos-brain-rv-queues")).toHaveAttribute("role", "group");
    await expect(chips.locator("span:first-child")).toHaveText(["By session", "Drafts", "Duplicates", "Older than 30d"]);
    await expect(chips.locator(".aos-brain-chipn")).toHaveText([B().unreviewed.length, B().drafts.length, B().dups.length, B().older.length].map(String));
    expect(B().older).toEqual(["brain/memory/reference/chart-datum.md"]);

    await showQueue("drafts");
    const slug = B().drafts[0];
    const draftRel = `brain/memory/feedback/_drafts/${slug}.md`;
    await expect(C().locator('.aos-brain-rv-list [role="listbox"][aria-label="Feedback drafts"] [role="option"]')).toHaveText(`Name layers after their data${shortDay(fmKey(draftRel, "created"), now)}`);
    await expect(main().locator("h2")).toHaveText("Feedback drafts");
    const d = main().locator(`article.aos-brain-rv-draft[data-slug="${slug}"]`);
    await expect(d).toHaveAttribute("aria-current", "true");
    await expect(d.locator(".aos-brain-type")).toHaveText("feedback");
    await expect(d.locator(".aos-brain-rv-ctitle")).toHaveText("Name layers after their data");
    await expect(d.locator(".aos-brain-rv-sum")).toHaveText(fmKey(draftRel, "description")!);
    await expect(d.locator(".aos-brain-rv-dmeta")).toHaveText(`${shortDay(fmKey(draftRel, "created"), now)} · session ${B().sessions.claude.slice(0, 8)}`);
    await expect(d.locator(".aos-brain-rv-dacts button")).toHaveText(["Approve", "Reject…", "Edit"]);
    // Reject… asks first; Cancel leaves the draft where it is.
    await d.locator('button[data-act="reject"]').click();
    const confirm = app().win.locator(".modal", { hasText: "Reject “Name layers after their data”?" });
    await expect(confirm).toContainText("Removes this draft, and the rule is never drafted again. No memory changes.");
    await confirm.locator("button", { hasText: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(fs.existsSync(FX.v(draftRel))).toBe(true);

    await showQueue("duplicates");
    const [newer, older] = B().duplicate;
    const pair = C().locator('.aos-brain-rv-list [role="listbox"][aria-label="Duplicate pairs"] [role="option"]');
    await expect(pair).toHaveCount(1);
    await expect(pair.locator(".aos-brain-rv-rtitle")).toHaveText("Prefer small diffs in reviews · Prefer small diffs");
    await expect(pair.locator(".aos-brain-rv-when")).toHaveText(B().dups[0].score.toFixed(2));
    await expect(main().locator("h2")).toHaveText("Duplicates");
    await expect(main().locator(".aos-brain-rv-dupscore .aos-brain-pill")).toHaveText(`${B().dups[0].score.toFixed(2)} similar`);
    const boxes = main().locator(".aos-brain-rv-pair .aos-brain-rv-box");
    expect(await paths(boxes)).toEqual([older, newer]);
    await expect(boxes.locator(".aos-brain-label")).toHaveText(["OLDER", "NEWER"]);
    await expect(boxes.locator(".aos-brain-rv-boxtitle")).toHaveText(["Prefer small diffs", "Prefer small diffs in reviews"]);
    await expect(boxes.nth(0).locator(".aos-brain-rv-boxmeta")).toHaveText(`feedback/prefer-small-diffs.md · created ${shortDay(fmKey(older, "created"), now)} · reviewed`);
    await expect(boxes.nth(1).locator(".aos-brain-rv-boxmeta")).toHaveText(`feedback/prefer-small-diffs-in-reviews.md · created ${shortDay(fmKey(newer, "created"), now)} · to review`);
    await expect(main().locator(".aos-brain-rv-cmpacts button")).toHaveText(["Keep the older one", "Keep the newer one", "Not duplicates", "Open both"]);

    await showQueue("older");
    const datum = B().older[0];
    const month = new Date(localTime(writtenAt(datum)));
    const label = `${month.toLocaleString("en-US", { month: "long" })} ${month.getFullYear()}`;
    await expect(C().locator(".aos-brain-rv-list .aos-brain-rv-group")).toHaveText(`${label.toUpperCase()}1 memory`);
    await expect(C().locator(`.aos-brain-rv-list [role="listbox"][aria-label="${label}"] [role="option"] .aos-brain-rv-rtitle`)).toHaveText("Chart datum");
    await expect(C().locator('.aos-brain-rv-list [role="option"] .aos-brain-dot')).toHaveAttribute("aria-label", "reference");
    await expect(main().locator("h2")).toHaveText("Older than 30 days");
    await expect(main().locator(".aos-brain-rv-lede")).toHaveText("1 memory written more than 30 days ago waits for review.");
    await expect(main().locator('header button[data-act]')).toHaveText(["Keep all 1", "Archive all 1…"]);
    expect(await paths(main().locator("article.aos-brain-rv-card"))).toEqual(B().older);
    await expect(card(datum).locator(".aos-brain-rv-cdate")).toHaveText(shortDay(writtenAt(datum), now));
    await expect(main().locator("footer.aos-brain-rv-keys > span")).toHaveText(["↑↓ move", "K keep", "E edit", "M merge", "A archive", "P pin", "⏎ open in Library"]);
    await showQueue("session");
  });

  test("Mark everything before <day> reviewed… counts what it would keep, live as the day changes; Cancel keeps nothing", async () => {
    const { win } = app();
    const h = app();
    const now = new Date();
    const day = defaultMarkBefore(now);
    const before = (d: string) => B().unreviewed.filter((p) => localTime(writtenAt(p)) < localTime(d));
    // The 45-day memory predates the 1st of this month (of last month in a month's first week); everything else is today's.
    expect(before(day)).toEqual(B().older);
    const tree = memoryTree(FX.vault);
    await clearGuard();
    const btn = C().locator("button.aos-brain-rv-markbtn");
    await expect(btn).toHaveText(`Mark everything before ${shortDay(day, now)} reviewed…`);
    await btn.click();
    const modal = win.locator(".modal", { has: win.locator(".aos-brain-markmodal") });
    await expect(modal.locator("h3")).toHaveText("Mark everything before a day reviewed");
    const input = modal.locator("input.aos-brain-markday");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(day);
    const line = modal.locator(".aos-brain-markline");
    const ok = modal.locator("button.aos-brain-markok");
    await expect(line).toHaveText(`Marks 1 memory written before ${shortDay(day, now)} reviewed. Nothing is deleted.`);
    await expect(ok).toHaveText("Mark 1 reviewed");
    await expect(ok).toBeEnabled();
    // A day before the oldest one: nothing to mark, and the button is off.
    const early = new Date(localTime(writtenAt(B().older[0])) - 24 * 3600 * 1000);
    const earlyDay = `${early.getFullYear()}-${String(early.getMonth() + 1).padStart(2, "0")}-${String(early.getDate()).padStart(2, "0")}`;
    await input.fill(earlyDay);
    await expect(line).toHaveText(`Nothing written before ${shortDay(earlyDay, now)} waits for review.`);
    await expect(ok).toHaveText("Mark 0 reviewed");
    await expect(ok).toBeDisabled();
    await input.fill(day);
    await expect(ok).toHaveText("Mark 1 reviewed");
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(modal).toHaveCount(0);
    expect(memoryTree(FX.vault)).toEqual(tree);
    expect((await h.guard()).filter((e) => e.kind === "spawn")).toEqual([]);
  });

  test("with the brain surface off, K is refused: a Notice says why, the memory and the trail stay byte for byte, and the card comes back", async () => {
    const h = app();
    const { win } = h;
    const b = byKey(B().sessions.claude);
    const rel = b.paths[1];
    await pickBatch(b.key);
    await clearGuard();
    const notices = h.notices.length;
    await card(rel).locator(".aos-brain-rv-sum").click();
    await win.keyboard.press("k");
    await expect.poll(() => h.notices.slice(notices)).toEqual([`Keep: ${BRAIN_OFF_TEXT}`]);
    await expect(win.locator(".notice-container")).toContainText(`Keep: ${BRAIN_OFF_TEXT}`);
    // Main refused the one verb the key ran; nothing else was spawned.
    const refused = (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what.replace(/^.*\/cli\/aos\.js /, ""));
    expect(refused).toEqual([`memory keep ${rel} --json`]);
    // The card left while the verb ran and is back, still selected, with the keyboard.
    await expect(card(rel)).toHaveAttribute("aria-current", "true");
    await expect(main().locator("article.aos-brain-rv-card")).toHaveCount(b.paths.length);
    expect(read(rel)).toBe(pristine(rel));
    expect(read(TRAIL)).toBe(pristine(TRAIL));
    await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveText(String(B().unreviewed.length));
    await clearGuard();
  });
});

// ── Library ──────────────────────────────────────────────────────────

test.describe("Library", () => {
  test.beforeEach(async () => { await brain("library"); await libraryShow("memories"); });

  test("the kinds with their counts, every live memory newest first, and the facets: Status › archived shows the archived memory, Type and Source narrow", async () => {
    const counts = B().counts;
    await expect(C().locator(".aos-lib-kinds")).toHaveAttribute("role", "group");
    await expect(C().locator(".aos-lib-kinds button span:first-child")).toHaveText(["Memories", "Drafts", "Patterns", "Reflections"]);
    await expect(C().locator(".aos-lib-kinds .aos-brain-chipn")).toHaveText([live().length, B().drafts.length, counts.patterns, counts.reflections].map(String));
    await expect(kind("memories")).toHaveAttribute("aria-label", `Memories, ${live().length}`);
    await expect(C().locator(".aos-lib-count")).toHaveText(`${live().length} MATCHES`);
    // No usage log yet (telemetry is on, but no session ran since): newest first, and the Use facet hidden (D8).
    await expect(C().locator(".aos-lib-sort")).toHaveText("newest first");
    await expect(C().locator('.aos-lib-facet[data-facet="use"]')).toBeHidden();
    await expect(C().locator(".aos-lib-list")).toHaveAttribute("role", "listbox");
    expect((await paths(libRows())).sort()).toEqual([...live()].sort());
    for (const [key, text] of [["type", "Type: any"], ["status", "Status: live"], ["source", "Source: any"]]) await expect(facetText(key)).toHaveText(text);
    await expect(libRows().first()).toHaveAttribute("aria-selected", "true");

    // Status › archived: the archived memory, tagged, and the reader offers Restore instead of Pin, Keep and Archive.
    expect(B().archived).toEqual(["brain/memory/projects/survey-boat-booking.md"]);
    await facet("Status").selectOption("archived");
    await expect(facetText("status")).toHaveText("Status: archived");
    await expect(C().locator('.aos-lib-facet[data-facet="status"]')).toHaveClass(/is-set/);
    expect(await paths(libRows())).toEqual(B().archived);
    await expect(libRow(B().archived[0]).locator(".aos-lib-rowtag")).toHaveText("archived");
    await libRow(B().archived[0]).click();
    await expect(libRow(B().archived[0])).toHaveAttribute("aria-selected", "true");
    await expect(reader().locator("h2")).toHaveText("Survey boat booking");
    await expect(reader().locator(".aos-lib-rtitle .aos-brain-pill")).toHaveText(`Archived ${shortDay(fmKey(B().archived[0], "archived"), new Date())}`);
    expect(await reader().locator(".aos-lib-actions [data-action]").evaluateAll((els) => els.map((e) => e.getAttribute("data-action")))).toEqual(["edit", "restore", "popout"]);
    await facet("Status").selectOption("live");

    // Type narrows to one folder; Source to what auto-wrap wrote.
    await facet("Type").selectOption("user");
    await expect(facetText("type")).toHaveText("Type: user");
    expect((await paths(libRows())).sort()).toEqual(live().filter((p) => p.startsWith("brain/memory/user/")).sort());
    await facet("Type").selectOption("any");
    await facet("Source").selectOption("auto-wrap");
    expect((await paths(libRows())).sort()).toEqual(live().filter((p) => fmKey(p, "source") === "auto-wrap").sort());
    await facet("Source").selectOption("any");
    await expect(libRows()).toHaveCount(live().length);

    // The other kinds: no facets; a kind with nothing in it says so in the reader.
    await libraryShow("drafts");
    await expect(C().locator(".aos-lib-facets")).toBeHidden();
    expect(await paths(libRows())).toEqual(B().drafts.map((s) => `brain/memory/feedback/_drafts/${s}.md`));
    await libraryShow("patterns");
    expect(await paths(libRows())).toEqual(["brain/patterns/debugging.md"]);
    await libraryShow("reflections");
    await expect(libRows()).toHaveCount(0);
    await expect(reader()).toHaveText("No reflections yet.");
  });

  test("a row opens the reader: title, meta, the rendered body and the actions; IN BRAIN.MD AS for a memory BRAIN.md carries; Edit opens the note and ⧉ the Memory inspector in the split pane", async () => {
    const { win } = app();
    const rel = "brain/memory/projects/chart-overlay-refresh.md";
    const now = new Date();
    await libRow(rel).click();
    await expect(libRow(rel)).toHaveAttribute("aria-selected", "true");
    await expect(reader()).toHaveAttribute("data-path", rel);
    await expect(reader().locator("h2")).toHaveText("Chart overlay refresh");
    await expect(reader().locator(".aos-lib-meta > span")).toHaveText([
      "projects", "status active", `updated ${shortDay(fmKey(rel, "updated"), now)}`, `auto-wrap · session ${B().sessions.claude.slice(0, 8)}`, "to review",
    ]);
    await expect(reader().locator(".aos-lib-meta .aos-lib-warn")).toHaveText("to review");
    // The body as markdown, without the title it repeats.
    await expect(reader().locator(".aos-lib-md p")).toHaveText("The water-level overlay redraws once per six-minute reading, not on every pan or zoom; the chart view keeps the last frame until the next reading lands.");
    await expect(reader().locator(".aos-lib-md h1")).toHaveCount(0);
    const acts = reader().locator(".aos-lib-actions");
    await expect(acts).toHaveAttribute("role", "toolbar");
    expect(await acts.locator("[data-action]").evaluateAll((els) => els.map((e) => e.getAttribute("data-action")))).toEqual(["edit", "pin", "status", "keep", "archive", "popout"]);
    await expect(acts.locator("button.aos-brain-btn")).toHaveText(["Edit", "Pin", "Keep", "Archive"]);
    await expect(acts.locator('select[aria-label="Set status"] option')).toHaveText(["active", "complete", "paused"]);
    await expect(acts.locator('select[aria-label="Set status"]')).toHaveValue("active");
    await expect(acts.locator("button.aos-lib-popout")).toHaveAttribute("aria-label", "Open in split");
    // It is one of BRAIN.md's active projects (brain-sources.json): the section and its tokens.
    const src = sources();
    expect(src.sections.active.paths).toContain(rel);
    const inBrain = reader().locator(".aos-lib-inbrain");
    await expect(inBrain).toHaveAttribute("data-section", "active");
    await expect(inBrain.locator(".aos-brain-label")).toHaveText("IN BRAIN.MD AS");
    await expect(inBrain.locator(".aos-lib-inbrainline")).toHaveText(`Active context · ${src.sections.active.tokens} tokens · every session, both hosts`);
    // A memory BRAIN.md does not carry has no such box.
    await libRow("brain/memory/reference/tide-api-notes.md").click();
    await expect(reader().locator("h2")).toHaveText("Tide API notes");
    await expect(reader().locator(".aos-lib-inbrain")).toHaveCount(0);

    // Edit opens the file in the note pane and writes nothing (D4).
    await libRow(rel).click();
    await acts.locator('button[data-action="edit"]').click();
    await expect(notePath(win)).toHaveText(rel);
    await closeNotes(win);
    // Shown again after the note, Library draws its list again (it once kept the last mount's and stayed empty).
    await brain("library");
    await expect(libRows()).toHaveCount(live().length);
    await expect(C().locator(".aos-lib-count")).toHaveText(`${live().length} MATCHES`);
    // ⧉ pops it out into the split pane's Memory inspector (kept from the Memory tab, D23).
    await libRow(rel).click();
    await reader().locator("button.aos-lib-popout").click();
    const split = win.locator(".aos-host-pane.is-split");
    await expect(split).not.toHaveClass(/is-empty/);
    await expect(split.locator(".workspace-leaf-content[data-type='agentic-os-memory-inspector']")).toContainText("The water-level overlay redraws once per six-minute reading");
    await expect(win.locator(".aos-host-tab.is-split")).toHaveCount(1);
    await closeNotes(win);
    expect(read(rel)).toBe(pristine(rel));
  });

  test("the context: LINKED FROM with MEMORY.md as an index, NEARBY the near-duplicate with its score (by words), HISTORY the trail's written and kept with the path", async () => {
    const now = new Date();
    const [newer, older] = B().duplicate;
    await libRow(older).click();
    await expect(reader().locator("h2")).toHaveText("Prefer small diffs");
    // No usage log yet: the Use section says when it starts.
    await expect(csec("use").locator(".aos-lib-chead")).toHaveText("USE · LAST 30 DAYS");
    await expect(csec("use").locator(".aos-lib-cnote")).toHaveText("No usage yet: the log starts with the next session.");
    const links = csec("links");
    await expect(links.locator(".aos-lib-chead > span").first()).toHaveText("LINKED FROM");
    const index = links.locator('button.aos-lib-clink[data-path="MEMORY.md"]');
    await expect(index.locator(".aos-lib-clinkt")).toHaveText("MEMORY.md");
    await expect(index.locator(".aos-lib-ckind")).toHaveText("index");
    await expect(links.locator(".aos-lib-csub")).toHaveText(String(await links.locator("button.aos-lib-clink").count()));
    // No embeddings in the fixture (no Ollama): Nearby scores by words, and says so (D11).
    const near = csec("nearby");
    await expect(near.locator(".aos-lib-chead")).toHaveText("NEARBYby words");
    const pair = near.locator("button.aos-lib-clink");
    expect(await paths(pair)).toEqual([newer]);
    await expect(pair.locator(".aos-lib-clinkt")).toHaveText("Prefer small diffs in reviews");
    await expect(pair.locator(".aos-lib-score")).toHaveText(B().dups[0].score.toFixed(2));
    await expect(pair.locator(".aos-lib-score")).toHaveClass(/is-close/);
    await expect(csec("history").locator(".aos-lib-cline")).toHaveText(`Created ${shortDay(fmKey(older, "created"), now)}`);
    await expect(csec("history").locator(".aos-lib-cpath")).toHaveText(older);
    // A Nearby row opens that memory here.
    await pair.click();
    await expect(libRow(newer)).toHaveAttribute("aria-selected", "true");
    await expect(reader().locator("h2")).toHaveText("Prefer small diffs in reviews");
    await expect(csec("nearby").locator("button.aos-lib-clink")).toHaveAttribute("data-path", older);

    // Tide API notes: auto-wrap wrote it today and it was kept (the trail), so History reads both.
    const tide = "brain/memory/reference/tide-api-notes.md";
    const rows = trail().filter((r) => r.slug === "tide-api-notes");
    expect(rows.map((r) => r.action)).toEqual(["written", "kept"]);
    await libRow(tide).click();
    await expect(csec("history").locator(".aos-lib-cline")).toHaveText(`Written by auto-wrap ${shortDay(rows[0].ts, now)} · kept ${shortDay(rows[1].ts, now)}`);
    await expect(csec("history").locator(".aos-lib-cpath")).toHaveText(tide);
    await expect(csec("links").locator('button.aos-lib-clink[data-path="MEMORY.md"] .aos-lib-ckind')).toHaveText("index");
    // A link that is not a memory, draft, pattern or reflection opens in the note pane.
    await csec("links").locator('button.aos-lib-clink[data-path="MEMORY.md"]').click();
    await expect(notePath(app().win)).toHaveText("MEMORY.md");
    await closeNotes(app().win);
  });

  test("a draft and a pattern open in the reader too: the draft with Approve, Reject… and Edit, the pattern with Edit and ⧉", async () => {
    const now = new Date();
    await libraryShow("drafts");
    const slug = B().drafts[0];
    const draftRel = `brain/memory/feedback/_drafts/${slug}.md`;
    await expect(reader()).toHaveAttribute("data-kind", "drafts");
    await expect(reader()).toHaveAttribute("data-path", draftRel);
    await expect(reader().locator("h2")).toHaveText("Name layers after their data");
    await expect(reader().locator(".aos-lib-meta > span")).toHaveText(["feedback draft", `created ${shortDay(fmKey(draftRel, "created"), now)}`, `session ${B().sessions.claude.slice(0, 8)}`]);
    await expect(reader().locator(".aos-lib-actions button")).toHaveText(["Approve", "Reject…", "Edit"]);
    await expect(reader().locator(".aos-lib-md")).toContainText("Call a chart layer by what it draws");
    await expect(csec("history").locator(".aos-lib-cline")).toHaveText(`Drafted ${shortDay(fmKey(draftRel, "created"), now)} · session ${B().sessions.claude.slice(0, 8)}`);
    await expect(csec("use")).toHaveCount(0);   // a draft never reaches an agent through recall

    await libraryShow("patterns");
    const pattern = "brain/patterns/debugging.md";
    await expect(reader()).toHaveAttribute("data-kind", "patterns");
    await expect(reader()).toHaveAttribute("data-path", pattern);
    await expect(reader().locator("h2")).toHaveText("Debugging Patterns");
    await expect(reader().locator(".aos-lib-meta > span").first()).toHaveText("pattern");
    expect(await reader().locator(".aos-lib-actions [data-action]").evaluateAll((els) => els.map((e) => e.getAttribute("data-action")))).toEqual(["edit", "popout"]);
    await expect(reader().locator(".aos-lib-md h3")).toHaveText(["Bisect before theorising", "Read the log you have"]);
    await expect(csec("use")).toHaveCount(1);
    await libraryShow("memories");
  });
});

// ── Map, Bootstrap, Health ───────────────────────────────────────────

test("Map › Every node: the four kind chips, the counts, today's and yesterday's daily notes as session nodes; a chip hides its kind, a memory node opens in Library", async () => {
  const { win } = app();
  await brain("map");
  const map = C().locator("section.aos-brain-map");
  await expect(map).toHaveAttribute("aria-label", "Every node");
  await expect(map.locator("h2")).toHaveText("Every node");
  const chips = map.locator(".aos-cortex-chips button.aos-cortex-chip");
  await expect(chips).toHaveText(["memory", "pattern", "session", "agent"]);
  for (const c of await chips.all()) await expect(c).toHaveAttribute("aria-pressed", "true");
  // The graph on screen, read through the tab (MapMode.graph is public for this).
  const nodes = () => win.evaluate(() => {
    const w = window as unknown as { aosHost: { app: { workspace: { getLeavesOfType(t: string): Array<{ view: { getTab(id: string): { modes: { map?: { graph: { nodes: Array<{ kind: string; path: string }>; edges: unknown[] } | null } } } } }> } } } };
    const g = w.aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0].view.getTab("memory").modes.map?.graph;
    return g ? { nodes: g.nodes.map((n) => `${n.kind}:${n.path}`), edges: g.edges.length } : null;
  });
  await expect.poll(async () => (await nodes()) !== null).toBe(true);
  const g = (await nodes())!;
  await expect(map.locator(".aos-cortex-stats")).toHaveText(`${g.nodes.length} nodes · ${g.edges} edges`);
  const sessions = g.nodes.filter((k) => k.startsWith("session:"));
  expect(sessions).toHaveLength(2);   // today's and yesterday's daily notes
  expect(sessions.some((k) => k.endsWith(`/${expected().today}.md`))).toBe(true);
  // Every memory file is a node (the archived one too: the force view draws what is on disk).
  for (const p of B().memories) expect(g.nodes).toContain(`memory:${p}`);
  const drawn = map.locator("svg.aos-cortex-svg g.aos-cortex-node");
  await expect.poll(() => drawn.count()).toBe(g.nodes.length);
  const session = chips.filter({ hasText: "session" });
  await session.click();
  await expect(session).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => drawn.count()).toBe(g.nodes.length - sessions.length);
  await expect(map.locator('g.aos-cortex-node[data-kind="session"]')).toHaveCount(0);
  await session.click();
  await expect.poll(() => drawn.count()).toBe(g.nodes.length);
  // A click on a memory node shows it in Library (the sim keeps moving, so the click goes to the node itself).
  const tide = "brain/memory/reference/tide-api-notes.md";
  await map.locator(`g.aos-cortex-node[data-id="${tide}"]`).dispatchEvent("click");
  await expect(modeTab("library")).toHaveAttribute("aria-selected", "true");
  await expect(libRow(tide)).toHaveAttribute("aria-selected", "true");
  await expect(reader().locator("h2")).toHaveText("Tide API notes");
});

test("Bootstrap (until PR 3): BRAIN.md's tokens against its budget as a progressbar, its sections with their memories and tokens, and nothing that looks shipped", async () => {
  await brain("bootstrap");
  const src = sources();
  const pct = Math.round((src.tokens / src.budget) * 100);
  const page = C().locator(".aos-brain-standin");
  await expect(page).toHaveAttribute("aria-label", "Bootstrap");
  await expect(page.locator("h2.aos-brain-h2")).toHaveText("What every session starts with");
  await expect(page.locator(".aos-brain-budgetval")).toHaveText(`${src.tokens} / ${src.budget} tokens`);
  const bar = page.locator('[role="progressbar"]');
  await expect(bar).toHaveAttribute("aria-label", "BRAIN.md against its budget");
  await expect(bar).toHaveAttribute("aria-valuemin", "0");
  await expect(bar).toHaveAttribute("aria-valuemax", String(src.budget));
  await expect(bar).toHaveAttribute("aria-valuenow", String(src.tokens));
  await expect(bar).toHaveAttribute("aria-valuetext", `${pct}% of the budget`);
  await expect(bar).not.toHaveClass(/is-warn/);
  const rows = page.locator(".aos-brain-sisec").first().locator(".aos-brain-sirow");
  await expect(rows.locator(".aos-brain-sititle")).toHaveText(["Who you are", "Critical rules", "Active context"]);
  await expect(rows.locator("span:nth-child(2)")).toHaveText((["who", "rules", "active"] as const).map((k) => pl(src.sections[k].paths.length, "memory", "memories")));
  await expect(rows.locator("span:nth-child(3)")).toHaveText((["who", "rules", "active"] as const).map((k) => `${src.sections[k].tokens} tokens`));
  expect(readVaultJson<{ shipped: unknown[] }>("brain/_index/brain-hub.json").shipped).toEqual([]);
  await expect(page.locator(".aos-brain-sisec").nth(1)).toContainText("LOOKS SHIPPED");
  await expect(page.locator(".aos-brain-sisec").nth(1).locator(".aos-brain-empty")).toHaveText("No active project looks shipped.");
});

test("Health (until PR 3): the store's tiles, the hygiene counts, and duplicate pairs → opens Review on the Duplicates queue", async () => {
  await brain("health");
  const page = C().locator(".aos-brain-standin");
  await expect(page).toHaveAttribute("aria-label", "Health");
  const tiles = page.locator(".aos-brain-tiles .aos-brain-tile");
  const hub = readVaultJson<{ clusters: unknown[] }>("brain/_index/brain-hub.json");
  await expect(tiles.locator(".aos-brain-tilen")).toHaveText([live().length, B().unreviewed.length, B().drafts.length, B().dups.length, hub.clusters.length, B().archived.length].map(String));
  await expect(tiles.locator(".aos-brain-dim")).toHaveText(["live memories →", "to review →", "feedback drafts →", "duplicate pairs →", "clusters", "archived or superseded"]);
  // The four with an arrow are buttons; the other two are plain tiles.
  expect(await tiles.evaluateAll((els) => els.map((e) => e.tagName))).toEqual(["BUTTON", "BUTTON", "BUTTON", "BUTTON", "DIV", "DIV"]);
  await expect(page.locator(".aos-brain-sihead", { hasText: "HYGIENE" })).toContainText("as of the last scan");
  await expect(page.locator(".aos-brain-silist .aos-brain-sirow")).toHaveCount(6);
  await tiles.filter({ hasText: "duplicate pairs →" }).click();
  await expect(modeTab("review")).toHaveAttribute("aria-selected", "true");
  await expect(queue("duplicates")).toHaveAttribute("aria-pressed", "true");
  await expect(main().locator("h2")).toHaveText("Duplicates");
  await showQueue("session");
});

// ── the rail badge and links ─────────────────────────────────────────

test("the rail badge counts memories written since Review was last open (D16): a new unreviewed memory reads 1 within seconds, and opening Brain on Review clears it", async () => {
  const { win } = app();
  const rel = "brain/memory/reference/buoy-battery-swap.md";
  const trailWas = read(TRAIL);
  // Brain was last left on Review, so the rail opens it there.
  await brain("review");
  await openTab(win, "pulse");
  await expect(badge(win, "memory")).toHaveClass(/is-empty/);
  await expect(badge(win, "memory")).toHaveText("");
  try {
    // A memory auto-wrap writes, as lib/memory-writer.js does, and its trail row (lib/promote-log.js appendTrail).
    const at = new Date();
    const d = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    fs.writeFileSync(FX.v(rel), `---\ntype: memory\ntags: [memory/reference, status/active]\ncreated: ${d}\nupdated: ${d}\nsource: auto-wrap\nsession: ${B().sessions.claude}\nreviewed: false\n---\n\n# Buoy battery swap\n\nSwap the buoy batteries every ninety days.\n`);
    fs.appendFileSync(FX.v(TRAIL), `${JSON.stringify({ ts: at.toISOString(), session: B().sessions.claude, action: "written", slug: "buoy-battery-swap", type: "reference", title: "Buoy battery swap" })}\n`);
    await expect(badge(win, "memory")).toHaveText("1", { timeout: 10_000 });
    await expect(badge(win, "memory")).not.toHaveClass(/is-empty/);
    await expect(rail(win, "pulse")).toHaveClass(/is-active/);
    // Opening Brain on Review: the badge counts from now, so it clears; the memory waits in Review.
    await openTab(win, "memory");
    await expect(modeTab("review")).toHaveAttribute("aria-selected", "true");
    await expect(badge(win, "memory")).toHaveText("");
    await expect(badge(win, "memory")).toHaveClass(/is-empty/);
    await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveText(String(B().unreviewed.length + 1));
  } finally {
    fs.rmSync(FX.v(rel), { force: true });
    fs.writeFileSync(FX.v(TRAIL), trailWas);
  }
  await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveText(String(B().unreviewed.length));
  await openTab(win, "pulse");
  await expect(badge(win, "memory")).toHaveText("");
});

test("an agenticos://workbench?tab=memory link opens Brain, and does nothing else", async () => {
  const h = app();
  const link = (q: string) => h.app.evaluate((_e, url) => { (globalThis as unknown as { __aosMain: { openLink(u: string): void } }).__aosMain.openLink(url); }, `agenticos://workbench?${q}`);
  await openTab(h.win, "pulse");
  await clearGuard();
  const opened = (await h.opened()).length;
  const tree = memoryTree(FX.vault);
  await link("tab=memory");
  await expect(rail(h.win, "memory")).toHaveClass(/is-active/);
  await expect(C().locator("h1.aos-brain-h1")).toHaveText("Brain");
  await expect(body()).not.toBeEmpty();
  expect((await h.opened()).length).toBe(opened);
  expect((await h.guard()).filter((e) => e.kind === "spawn")).toEqual([]);
  expect(memoryTree(FX.vault)).toEqual(tree);
});
