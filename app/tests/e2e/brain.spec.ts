// Brain (app-smoke: Brain; the Memory items of Spaces / Memory / Runs). The Memory tab became the Brain hub (spec
// 2026-10-11-brain-hub): the rail button and the palette command, the header with its five modes as a tablist, their
// counts, ⌘F and the search that opens Library; Review's batches by session (THIS WEEK, EARLIER folded), a batch's header
// and cards with the near-duplicate's flag, the comparison (M), ↑↓ and ⏎, the queues (Drafts, Duplicates, Older than 30d)
// and "Mark everything before …"; Library's kinds, facets (Use from the usage log), reader (Edit, ⧉ into the split pane's
// Memory inspector, IN BRAIN.MD AS) and context (USE, LINKED FROM, NEARBY, HISTORY); Bootstrap (the budgets, BRAIN.md by
// section, looks shipped, the left-out projects, SESSION.md, MEMORY.md, the recall preview read only); Map (Communities,
// Around a memory, Every node, the empty states); Health (the tiles, duplicates, hygiene, dead weight); the rail badge; an
// agenticos:// link. Read-only: with the brain surface off a Keep, a fix's preview and the recall preview are refused and
// nothing changes. The writes themselves (Review's and Library's verbs, Bootstrap's Unpin and Mark complete, each hygiene
// fix, Health's Not duplicates and Archive the N shipped…, the recall preview's hits) are in brain-writes.spec.ts, and a
// Codex-only machine's Brain and a vault with no usage log yet in variants.spec.ts.

import { expect, test, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  FX, badge, closeNotes, command, content, expected, guardWrites, notePath, openTab, rail, readVaultJson, useApp,
} from "./harness";
import { BRAIN_OFF_TEXT, batchMeta, batchWhen, brainMdLine, defaultMarkBefore, shortDay } from "../../../obsidian-plugin/src/data/brainModel";

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
/** What Health's fixes and the duplicates queue act on (its tab badge): the pairs and every hygiene finding a fix takes,
 *  but descriptions only MEMORY.md has (every new memory starts that way: listed in Hygiene, never badged). */
const healthFindings = (): number => {
  const h = B().hygiene;
  return B().dups.length + (h.sources.session ?? 0) + (h.sources["in-session"] ?? 0) + (h.sources.wrap ?? 0) + h.oldType.length
    + h.unindexed.length + h.misfiled.length + h.brokenIndex.length + h.leftoverDrafts.length;
};
/** How many times sessions used a memory in the last 7 days (brain-hub.json usage d7, from the fixture's usage log). */
const weekUses = (rel: string): number => readVaultJson<{ usage: { paths: Record<string, { d7: number }> } }>("brain/_index/brain-hub.json").usage.paths[rel]?.d7 ?? 0;
/** The vault's token estimate (text-budget.js): characters / 4, rounded up. */
const tokensOf = (s: string): number => Math.ceil(s.length / 4);
/** MEMORY.md's non-blank lines (Bootstrap's index card and Health's tile count these). */
const lineCount = (s: string): number => s.split(/\r?\n/).filter((l) => l.trim()).length;
/** A memory's H1, as BRAIN.md and the hub title it. */
const titleOf = (rel: string): string => /^#[ \t]+(.+?)[ \t]*$/m.exec(read(rel).replace(/^---\n[\s\S]*?\n---\n/, ""))![1];
/** BRAIN.md's bullets under `## <heading>`, each as the page shows it ("Title — description"), with its raw line. */
const brainBullets = (heading: string): Array<{ text: string; line: string }> => {
  const body = new RegExp(`\\n## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(`\n${read("brain/_index/BRAIN.md")}`)![1];
  return body.split("\n").filter((l) => l.startsWith("- **")).map((l) => ({ text: l.replace(/^- \*\*(.+?)\*\* — /, "$1 — "), line: l }));
};
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

test("the header: Brain, the store in one line, and the five modes as a tablist with Review's, Library's, Bootstrap's and Health's counts", async () => {
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
  // Review: what waits (amber); Library: the live store; Bootstrap: BRAIN.md against its budget (under 100%, so plain);
  // Health: what its fixes and the duplicates queue can act on (amber); Map none.
  const src = sources();
  const pct = Math.round((src.tokens / src.budget) * 100);
  expect(pct).toBeLessThan(100);
  expect(B().unreviewed.length).toBeGreaterThan(0);
  await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveText(String(B().unreviewed.length));
  await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveClass(/is-warn/);
  await expect(modeTab("review")).toHaveAttribute("aria-label", `Review, ${B().unreviewed.length}`);
  await expect(modeTab("library").locator(".aos-brain-modebadge")).toHaveText(String(live().length));
  await expect(modeTab("library").locator(".aos-brain-modebadge")).not.toHaveClass(/is-warn/);
  await expect(modeTab("bootstrap").locator(".aos-brain-modebadge")).toHaveText(`${pct}%`);
  await expect(modeTab("bootstrap").locator(".aos-brain-modebadge")).not.toHaveClass(/is-warn/);
  await expect(modeTab("health").locator(".aos-brain-modebadge")).toHaveText(String(healthFindings()));
  await expect(modeTab("health").locator(".aos-brain-modebadge")).toHaveClass(/is-warn/);
  await expect(modeTab("health")).toHaveAttribute("aria-label", `Health, ${healthFindings()}`);
  await expect(modeTab("map").locator(".aos-brain-modebadge")).toHaveClass(/is-empty/);
  await expect(modeTab("map")).toHaveAttribute("aria-label", "Map");
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
    await expect(head.locator(".aos-brain-rv-lede")).toHaveText("3 left to review. 2 look new, 1 looks like one you already have.");
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

  test("M opens the comparison, by key and by button: this one beside the one it looks like, with Merge into one…, Keep the older one, Keep both and Open both; ↑↓ move the selection, ⏎ opens it in Library", async () => {
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
    // Each box says which is the older, by the rule Keep the older one keeps with, and the day each was written (D7).
    expect(localTime(writtenAt(dupB))).toBeLessThan(localTime(writtenAt(dupA)));
    await expect(boxes.nth(0)).toHaveAttribute("data-path", dupA);
    await expect(boxes.nth(0)).toHaveAttribute("data-age", "newer");
    await expect(boxes.nth(0).locator(".aos-brain-label")).toHaveText("THIS ONE · NEWER");
    await expect(boxes.nth(0).locator(".aos-brain-rv-boxtext")).toHaveText(indexDesc(dupA));
    await expect(boxes.nth(0).locator(".aos-brain-rv-boxmeta")).toHaveText(`feedback/prefer-small-diffs-in-reviews.md · ${shortDay(writtenAt(dupA), new Date())}`);
    await expect(boxes.nth(1)).toHaveAttribute("data-path", dupB);
    await expect(boxes.nth(1)).toHaveAttribute("data-age", "older");
    await expect(boxes.nth(1).locator(".aos-brain-rv-boxlabel")).toHaveText(`LOOKS LIKE · OLDER${score} similar`);
    await expect(boxes.nth(1).locator(".aos-brain-rv-boxtitle")).toHaveText("Prefer small diffs");
    await expect(boxes.nth(1).locator(".aos-brain-rv-boxtext")).toHaveText(indexDesc(dupB));
    // The older one was recalled this week (the usage log, D8): the box says so; the new one has no use yet.
    expect(weekUses(dupB)).toBe(1);
    await expect(boxes.nth(1).locator(".aos-brain-rv-boxmeta")).toHaveText(`feedback · ${shortDay(writtenAt(dupB), new Date())} · used 1× this week`);
    // Merge into one… first (brain-ai A1: the Merge dialog, which writes nothing until its draft is approved).
    await expect(card(dupA).locator(".aos-brain-rv-cmpacts button")).toHaveText(["Merge into one…", "Keep the older one", "Keep both", "Open both"]);
    await expect(card(dupA).locator('.aos-brain-rv-cmpacts button[data-act="mergeone"]')).toHaveAttribute("title", "Draft one memory from the two; nothing is written until you approve it");
    await expect(card(dupA).locator('.aos-brain-rv-cmpacts button[data-act="keepolder"]')).toHaveAttribute("title", "Keeps “Prefer small diffs”; this one is marked superseded by it");
    await win.keyboard.press("m");
    await expect(cmp).toHaveCount(0);
    await expect(card(dupA)).not.toHaveClass(/is-open/);
    // The Merge button does the same; on a card with no look-alike it is off, so M there does nothing.
    await card(dupA).locator('button[data-act="merge"]').click();
    await expect(card(dupA).locator(".aos-brain-rv-compare")).toHaveCount(1);
    await card(dupA).locator('button[data-act="merge"]').click();
    await expect(card(dupA).locator(".aos-brain-rv-compare")).toHaveCount(0);

    // The keys act on the card the keyboard is in: Tab onto another card's buttons and that card is the selected one.
    await card(dupA).locator(".aos-brain-rv-sum").click();
    await card(b.paths[2]).locator('button[data-act="edit"]').focus();
    await expect(card(b.paths[2])).toHaveAttribute("aria-current", "true");
    await expect(card(dupA)).not.toHaveAttribute("aria-current", "true");

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
    // Today's draft, and the one approved three days ago and left behind (Health's drafts fix removes it), by name.
    const slug = B().drafts[0];
    expect(B().drafts).toEqual(["name-layers-after-their-data", B().leftover]);
    const draftRel = `brain/memory/feedback/_drafts/${slug}.md`;
    const leftRel = `brain/memory/feedback/_drafts/${B().leftover}.md`;
    await expect(C().locator('.aos-brain-rv-list [role="listbox"][aria-label="Feedback drafts"] [role="option"]')).toHaveText([
      `Name layers after their data${shortDay(fmKey(draftRel, "created"), now)}`, `Show units on every axis${shortDay(fmKey(leftRel, "created"), now)}`,
    ]);
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
    await expect(boxes.nth(0).locator(".aos-brain-rv-boxmeta")).toHaveText(`feedback/prefer-small-diffs.md · created ${shortDay(fmKey(older, "created"), now)} · reviewed · used ${weekUses(older)}× this week`);
    expect(weekUses(newer)).toBe(0);
    await expect(boxes.nth(1).locator(".aos-brain-rv-boxmeta")).toHaveText(`feedback/prefer-small-diffs-in-reviews.md · created ${shortDay(fmKey(newer, "created"), now)} · to review · not used this week`);
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

  test("the kinds with their counts, every live memory sorted by use with its count, and the facets: Status › archived shows the archived memory, Type, Source and Use narrow", async () => {
    const counts = B().counts;
    await expect(C().locator(".aos-lib-kinds")).toHaveAttribute("role", "group");
    await expect(C().locator(".aos-lib-kinds button span:first-child")).toHaveText(["Memories", "Drafts", "Patterns", "Reflections"]);
    await expect(C().locator(".aos-lib-kinds .aos-brain-chipn")).toHaveText([live().length, B().drafts.length, counts.patterns, counts.reflections].map(String));
    await expect(kind("memories")).toHaveAttribute("aria-label", `Memories, ${live().length}`);
    await expect(C().locator(".aos-lib-count")).toHaveText(`${live().length} MATCHES`);
    // Sessions on both hosts logged their use (D8): sorted by use, each row with its 30 days' count or "unused", and the
    // Use facet shown (with no log it is hidden: variants › before any session logs a memory use).
    await expect(C().locator(".aos-lib-sort")).toHaveText("sorted by use");
    await expect(C().locator(".aos-lib-list")).toHaveAttribute("role", "listbox");
    expect((await paths(libRows())).sort()).toEqual([...live()].sort());
    const d30 = readVaultJson<{ usage: { paths: Record<string, { d30: number }> } }>("brain/_index/brain-hub.json").usage.paths;
    const uses = await libRows().evaluateAll((els) => els.map((e) => [e.getAttribute("data-path")!, e.querySelector(".aos-lib-use")?.textContent ?? ""]));
    expect(uses.map(([, l]) => l)).toEqual(uses.map(([p]) => (B().usage.never.includes(p) ? "unused" : `${d30[p].d30}×`)));
    const byUse = uses.map(([p]) => d30[p]?.d30 ?? 0);
    expect(byUse).toEqual([...byUse].sort((a, b) => b - a));
    for (const [key, text] of [["type", "Type: any"], ["status", "Status: live"], ["source", "Source: any"], ["use", "Use: any"]]) await expect(facetText(key)).toHaveText(text);
    // One row is selected: the memory Library showed last (an earlier test's), wherever use sorts it.
    await expect(C().locator('.aos-lib-list button.aos-lib-row[aria-selected="true"]')).toHaveCount(1);
    // Use › unused: exactly the memories no session injected, recalled or read in 30 days.
    await facet("Use").selectOption("unused");
    await expect(facetText("use")).toHaveText("Use: unused");
    expect((await paths(libRows())).sort()).toEqual([...B().usage.never].sort());
    await facet("Use").selectOption("any");
    await expect(libRows()).toHaveCount(live().length);

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
    // The tokens are the section's (D10): with other memories in it, the line says so.
    expect(src.sections.active.paths.length).toBeGreaterThan(1);
    await expect(inBrain.locator(".aos-lib-inbrainline")).toHaveText(`Active context · one of ${src.sections.active.paths.length} memories, ${src.sections.active.tokens} tokens together · every session, both hosts`);
    expect(brainMdLine({ tokens: src.sections.active.tokens, count: src.sections.active.paths.length })).toBe(`one of ${src.sections.active.paths.length} memories, ${src.sections.active.tokens} tokens together · every session, both hosts`);
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
    // The panes fold on the hub's own width (D2; 1100 and 760 px windows less the 56 px rail): halved by the split, the
    // reader keeps a readable width rather than what two fixed panes leave it.
    const hubWidth = await C().locator(".aos-brain").evaluate((el) => el.getBoundingClientRect().width);
    await expect(C().locator(".aos-lib-split")).toHaveCSS("flex-direction", hubWidth <= 1044 ? "column" : "row");
    expect(await reader().evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(Math.min(hubWidth, 380) - 2);
    await closeNotes(win);
    expect(read(rel)).toBe(pristine(rel));
  });

  test("the context: USE from the log, LINKED FROM with MEMORY.md as an index, NEARBY the near-duplicate with its score (by words), HISTORY the trail's written and kept with the path", async () => {
    const now = new Date();
    const [newer, older] = B().duplicate;
    await libRow(older).click();
    await expect(reader().locator("h2")).toHaveText("Prefer small diffs");
    // A Claude Code session's recall hit two days ago (D8): its counts, how it was reached, the host and the last use.
    const u = readVaultJson<{ usage: { since: string; paths: Record<string, { d7: number; d30: number; recalled: number; claude: number; codex: number; last: string }> } }>("brain/_index/brain-hub.json").usage;
    expect(u.paths[older]).toMatchObject({ d7: 1, d30: 1, recalled: 1, claude: 1, codex: 0 });
    await expect(csec("use").locator(".aos-lib-chead")).toHaveText("USE · LAST 30 DAYS");
    await expect(csec("use").locator(".aos-lib-stat")).toHaveText(["1uses in 30 days", "1this week"]);
    await expect(csec("use").locator(".aos-lib-cline")).toHaveText([`recalled 1 since ${shortDay(u.since, now)}`, "claude 1", `Last used ${shortDay(u.paths[older].last, now)}`]);
    await expect(csec("use").locator(".aos-lib-cnote")).toHaveCount(0);
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

// ── Bootstrap (D17, D18) ─────────────────────────────────────────────

const bs = () => C().locator(".aos-brain-bootstrap");
const budget = (k: string) => bs().locator(`[data-budget="${k}"]`);
const bsSec = (k: string) => bs().locator(`section[data-section="${k}"]`);
const bsRows = (k: string) => bsSec(k).locator(".aos-brain-bs-row");
const SESSION = "brain/_index/SESSION.md";
const WAKE = "brain/_index/recall-wake.md";
const DAY = 24 * 3600 * 1000;
/** The index card's "about N tokens" (brainBootstrap.ts tokensAbout). */
const tokensAbout = (t: number): string => (t < 1000 ? `about ${pl(t, "token")}` : t < 10_000 ? `about ${(t / 1000).toFixed(1)}k tokens` : `about ${Math.round(t / 1000)}k tokens`);
/** What the recall preview may never write (D9, D18): recall's index and wake file, the usage log and its rollup. */
const RECALL_FILES = ["brain/_index/recall-index.json", WAKE, "brain/_index/memory-usage.jsonl", "brain/_index/memory-usage-rollup.json", "brain/_index/embed-index.json"];
const snapshot = (rels: readonly string[]): Record<string, string | null> => Object.fromEntries(rels.map((r) => [r, fs.existsSync(FX.v(r)) ? read(r) : null]));

test.describe("Bootstrap", () => {
  test.beforeEach(async () => { await brain("bootstrap"); });

  test("the budgets as progressbars: BRAIN.md full with two projects left out (amber, said in words), SESSION.md against its 400 tokens, recall-wake.md's three hits", async () => {
    const src = B().sources;
    const left = src.sections.active.omitted.length;
    // The fixture fills BRAIN.md (a long profile, more quick links), so the two oldest active projects give way.
    expect(left).toBe(2);
    expect(src.tokens).toBeLessThanOrEqual(src.budget);
    await expect(bs()).toHaveAttribute("aria-label", "Bootstrap");
    await expect(bs().locator("section.aos-brain-bs-main")).toHaveAttribute("aria-label", "BRAIN.md");
    await expect(bs().locator("aside.aos-brain-bs-side")).toHaveAttribute("aria-label", "Steer");
    await expect(bs().locator("h2.aos-brain-h2")).toHaveText("What every new session starts with");
    await expect(bs().locator(".aos-brain-bs-sub")).toHaveText("Injected on the first prompt in Claude Code and Codex");
    await expect(bs().locator('[role="list"][aria-label="Budgets"] [role="listitem"][data-budget]')).toHaveCount(3);
    const session = read(SESSION);
    const wake = read(WAKE);
    const hits = (wake.match(/^- `[^`\n]+` \([^)\n]*\)/gm) ?? []).length;
    expect(hits).toBe(3);
    const want = [
      { key: "brain", name: "BRAIN.md", value: `${src.tokens} / ${src.budget} tokens`, now: src.tokens, max: src.budget, note: `Full: ${left} older active projects left out`, warn: true },
      { key: "session", name: "SESSION.md", value: `${tokensOf(session)} / 400 tokens`, now: tokensOf(session), max: 400, note: "Working memory, reset at each wrap", warn: false },
      { key: "wake", name: "recall-wake.md", value: `${hits} of 3 hits · ${tokensOf(wake)} tokens`, now: hits, max: 3, note: "Recalled at session end; the next first prompt carries it", warn: false },
    ];
    for (const w of want) {
      const card = budget(w.key);
      await expect(card.locator(".aos-brain-bs-bname")).toHaveText(w.name);
      await expect(card.locator(".aos-brain-bs-bval")).toHaveText(w.value);
      await expect(card.locator(".aos-brain-bs-bnote")).toHaveText(w.note);
      const bar = card.getByRole("progressbar");
      await expect(bar).toHaveAttribute("aria-label", `${w.name} against its budget`);
      await expect(bar).toHaveAttribute("aria-valuemin", "0");
      await expect(bar).toHaveAttribute("aria-valuemax", String(w.max));
      await expect(bar).toHaveAttribute("aria-valuenow", String(w.now));
      await expect(bar).toHaveAttribute("aria-valuetext", `${w.value}. ${w.note}`);
      if (w.warn) await expect(card).toHaveClass(/is-warn/);
      else await expect(card).not.toHaveClass(/is-warn/);
    }
  });

  test("BRAIN.md by section with each one's tokens: Who you are (Open), Critical rules (Unpin), Active context (Mark complete; released is flagged, merged is not), Quick links and Last Session; + Pin a memory… opens Library", async () => {
    const s = B().sources.sections;
    const names: Array<[string, string]> = [["who", "Who you are"], ["rules", "Critical rules"], ["active", "Active context"], ["links", "Quick links"], ["lastSession", "Last Session"]];
    expect(await bs().locator("section[data-section]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-section"), e.getAttribute("aria-label")]))).toEqual(names);
    await expect(bs().locator("section[data-section] h3")).toHaveText(names.map(([, n]) => n));
    const tok = (k: string) => bsSec(k).locator(".aos-brain-bs-tok");
    await expect(tok("who")).toHaveText(pl(s.who.tokens, "token"));
    await expect(tok("rules")).toHaveText(pl(s.rules.tokens, "token"));
    await expect(tok("active")).toHaveText(`${pl(s.active.tokens, "token")} · ${s.active.paths.length} shown · ${s.active.omitted.length} left out`);
    await expect(tok("links")).toHaveText(pl(s.links.tokens, "token"));
    await expect(tok("lastSession")).toHaveText(pl(s.lastSession.tokens, "token"));
    // Who you are: profile.md's first paragraph, cut for the row; Open shows it in Library.
    const profile = s.who.paths[0];
    const para = /\n# Profile\n\n([^\n]+)\n/.exec(read(profile))![1];
    await expect(bsRows("who")).toHaveCount(1);
    await expect(bsRows("who")).toHaveAttribute("data-path", profile);
    await expect(bsRows("who").locator(".aos-brain-bs-rtitle")).toHaveText("Profile");
    await expect(bsRows("who").locator(".aos-brain-bs-rdesc")).toHaveText(new RegExp(`^ — ${para.slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await expect(bsRows("who").locator("button")).toHaveAttribute("aria-label", "Open: Profile");
    // Critical rules: the pinned memories as BRAIN.md lists them, each with Unpin.
    expect(s.rules.paths).toContain(B().pinned);
    expect(await paths(bsRows("rules"))).toEqual(s.rules.paths);
    await expect(bsRows("rules").locator(".aos-brain-bs-rtext")).toHaveText(brainBullets("Critical rules").map((b) => b.text));
    expect(await bsRows("rules").locator("button").evaluateAll((els) => els.map((e) => [e.getAttribute("data-act"), e.textContent, e.getAttribute("aria-label")])))
      .toEqual(s.rules.paths.map((p) => ["unpin", "Unpin", `Unpin: ${titleOf(p)}`]));
    // Active context: the projects BRAIN.md shows, newest first, each with Mark complete. "released" in an index line looks
    // shipped; a project whose line only says a PR merged does not (D17).
    expect(await paths(bsRows("active"))).toEqual(s.active.paths);
    await expect(bsRows("active").locator(".aos-brain-bs-rtext")).toHaveText(brainBullets("Active context").map((b) => b.text));
    expect(await bsRows("active").locator("button").evaluateAll((els) => els.map((e) => [e.getAttribute("data-act"), e.getAttribute("aria-label")])))
      .toEqual(s.active.paths.map((p) => ["complete", `Mark complete: ${titleOf(p)}`]));
    const flagged = bsSec("active").locator('.aos-brain-bs-row[data-shipped="true"]');
    expect(await paths(flagged)).toEqual([B().shipped.released]);
    await expect(flagged.locator(".aos-brain-bs-flag")).toHaveText("looks shipped · released");
    expect(s.active.paths).toContain(B().merged);
    expect(indexDesc(B().merged)).toMatch(/\bmerged\b/);
    await expect(bsSec("active").locator(`.aos-brain-bs-row[data-path="${B().merged}"] .aos-brain-bs-flag`)).toHaveCount(0);
    await expect(bsSec("lastSession").locator(".aos-brain-bs-more")).toHaveText("Written every few turns by the session hooks; the hub does not edit it.");
    // + Pin a memory… opens Library, to pin from the reader.
    await expect(bsSec("rules").locator('button[data-act="pin-more"]')).toHaveText("+ Pin a memory…");
    await bsSec("rules").locator('button[data-act="pin-more"]').click();
    await expect(modeTab("library")).toHaveAttribute("aria-selected", "true");
  });

  test("looks shipped (D17): the lede counts 2 of the 7 active projects and the tokens marking them complete frees; Review the 2… shows only those, the left-out one too; Mark the 2 complete… asks first, and Cancel changes nothing", async () => {
    const s = B().sources.sections.active;
    const all = s.paths.length + s.omitted.length;
    const shipped = [B().shipped.released, B().shipped.version];
    // The runtime's suggestion (brain-hub.json) and the page's agree: a full version in the title, "released" in a line.
    expect(B().looksShipped).toEqual([{ path: B().shipped.version, why: "1.2.0" }, { path: B().shipped.released, why: "released" }]);
    expect(s.paths).toContain(B().shipped.released);
    expect(s.omitted).toContain(B().shipped.version);
    // What marking them complete frees: the line BRAIN.md shows now (the left-out one takes no room), its characters / 4.
    const line = brainBullets("Active context").find((b) => b.text.startsWith(`${titleOf(B().shipped.released)} — `))!.line;
    const lede = bs().locator('[data-bs="lede"]');
    await expect(lede.locator(".aos-brain-bs-ledetext")).toHaveText(`2 of the ${all} active projects look shipped. Marking them complete frees about ${Math.ceil((line.length + 1) / 4)} tokens of BRAIN.md for work that is live.`);
    const review = lede.locator('button[data-act="review-shipped"]');
    await expect(review).toHaveText("Review the 2…");
    const chip = (f: string) => bsSec("active").locator(`button[data-filter="${f}"]`);
    await expect(bsSec("active").locator('[role="group"][aria-label="Show in Active context"] button')).toHaveText([`All${all}`, "Looks shipped2"]);
    await expect(chip("all")).toHaveAttribute("aria-pressed", "true");
    await review.click();
    await expect(chip("shipped")).toHaveAttribute("aria-pressed", "true");
    await expect(chip("shipped")).toBeFocused();
    await expect(chip("all")).toHaveAttribute("aria-pressed", "false");
    // BRAIN.md's first, then the one its budget left out, each flagged with what made it look shipped.
    const rows = bsSec("active").locator('[aria-label="Active projects that look shipped"] .aos-brain-bs-row');
    expect(await paths(rows)).toEqual(shipped);
    await expect(rows.locator(".aos-brain-bs-flag")).toHaveText(["looks shipped · released", "looks shipped · 1.2.0"]);
    await expect(rows.nth(0).locator(".aos-brain-bs-rnote")).toHaveCount(0);
    await expect(rows.nth(1).locator(".aos-brain-bs-rnote")).toHaveText("left out");
    await expect(rows.locator("button")).toHaveText(["Mark complete", "Mark complete"]);
    await expect(bsSec("active").locator(".aos-brain-bs-more")).toHaveText("Suggestions only: each names a version, “shipped”, “released” or “superseded”. Check before you mark one complete.");
    // Mark the 2 complete… asks first (spec §6); Cancel marks nothing and runs nothing.
    const tree = memoryTree(FX.vault);
    await clearGuard();
    const bulk = bsSec("active").locator('button[data-act="complete-shipped"]');
    await expect(bulk).toHaveText("Mark the 2 complete…");
    await bulk.click();
    const modal = app().win.locator(".modal", { hasText: "Mark 2 projects complete?" });
    await expect(modal.locator("h3")).toHaveText("Mark 2 projects complete?");
    await expect(modal.locator("p")).toHaveText(`Sets status/complete on “${titleOf(shipped[0])}” and “${titleOf(shipped[1])}”. They leave Active context and BRAIN.md is rebuilt. Nothing is archived or deleted, and Library's Status sets one back.`);
    await expect(modal.locator("button")).toHaveText(["Cancel", "Mark 2 complete"]);
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(modal).toHaveCount(0);
    expect(memoryTree(FX.vault)).toEqual(tree);
    expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
    await chip("all").click();
    await expect(bsRows("active")).toHaveCount(s.paths.length);
  });

  test("the projects BRAIN.md's budget left out: …and 2 older active projects that no longer fit; Show them lists each, left out and with Mark complete; Hide them", async () => {
    const s = B().sources.sections.active;
    for (const p of s.omitted) expect(read("brain/_index/BRAIN.md")).not.toContain(`- **${titleOf(p)}** —`);
    const toggle = bsSec("active").locator('button[data-act="left-out"]');
    await expect(bsSec("active").locator(".aos-brain-bs-more")).toHaveText(`…and ${s.omitted.length} older active projects that no longer fit.Show them`);
    await expect(toggle).toHaveText("Show them");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const list = bsSec("active").locator('[role="list"][aria-label="Left out of BRAIN.md"]');
    await expect(list).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveText("Hide them");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const rows = list.locator(".aos-brain-bs-row");
    expect(await paths(rows)).toEqual(s.omitted);
    await expect(rows.locator(".aos-brain-bs-rtitle")).toHaveText(s.omitted.map(titleOf));
    await expect(rows.locator(".aos-brain-bs-rnote")).toHaveText(s.omitted.map(() => "left out"));
    await expect(rows.locator(".aos-brain-bs-flag")).toHaveText(["looks shipped · 1.2.0"]);
    await expect(rows.locator("button")).toHaveText(s.omitted.map(() => "Mark complete"));
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(list).toHaveCount(0);
  });

  test("SESSION.md's card: the lines to remember, the #promote one tagged, and the runtime's not-wrapped line read as Not wrapped yet · /wrap promotes the tagged lines; Open opens SESSION.md", async () => {
    const { win } = app();
    // As auto-wrap.js writeWrapStatus leaves it when no provider wrapped the session.
    expect(read(SESSION)).toMatch(/^## Wrap Status\n+- Session [0-9a-f-]+ not wrapped \(provider: none\) — run \/wrap\.$/m);
    const card = bs().locator('[data-bs="session"]');
    await expect(card).toHaveAttribute("aria-label", "SESSION.md, working memory");
    await expect(card.locator("h3")).toHaveText("SESSION.MD · WORKING MEMORY");
    const lines = card.locator("li.aos-brain-bs-line");
    const remember = /^## Things to Remember\n\n((?:- .*\n)+)/m.exec(read(SESSION))![1].trim().split("\n").map((l) => l.replace(/^- /, "").replace(/\s*#promote\b/, "").trim());
    await expect(lines.locator(".aos-brain-bs-ltext")).toHaveText(remember);
    expect(await lines.evaluateAll((els) => els.map((e) => e.getAttribute("data-promote")))).toEqual(["true", "false"]);
    await expect(lines.locator(".aos-brain-bs-ptag")).toHaveText(["#promote"]);
    const wrap = card.locator(".aos-brain-bs-wrap");
    await expect(wrap).toHaveText("Not wrapped yet · /wrap promotes the tagged lines");
    await expect(wrap).toHaveAttribute("data-wrapped", "false");
    await expect(wrap).toHaveClass(/is-warn/);
    await card.locator('button[data-act="open-session"]').click();
    await expect(notePath(win)).toHaveText(SESSION);
    await closeNotes(win);
    expect(read(SESSION)).toBe(pristine(SESSION));
  });

  test("MEMORY.md's card: its size, about N tokens and its lines, the index's findings in words; Fix in Health → lands on Hygiene with its heading focused", async () => {
    const raw = read("MEMORY.md");
    const card = bs().locator('[data-bs="index"]');
    await expect(card).toHaveAttribute("aria-label", "MEMORY.md, the index");
    await expect(card.locator("h3")).toHaveText("MEMORY.MD · THE INDEX");
    await expect(card.locator(".aos-brain-bs-size")).toHaveText(`${(Buffer.byteLength(raw) / 1024).toFixed(1)} KB · ${tokensAbout(tokensOf(raw))} · ${pl(lineCount(raw), "line")}`);
    const h = B().hygiene;
    expect([h.misfiled, h.unindexed, h.brokenIndex]).toEqual([[B().misfiled], [B().unindexed], [B().broken]]);
    await expect(card.locator(".aos-brain-bs-note")).toHaveText("Agents read it through tools, never at start-up. 1 line sits under the wrong heading. 1 memory has no line in it. 1 line points at a missing file.");
    await expect(card.locator(".aos-brain-bs-finding")).toHaveText(["1 line sits under the wrong heading.", "1 memory has no line in it.", "1 line points at a missing file."]);
    const fix = card.locator('button[data-act="fix-in-health"]');
    await expect(fix).toHaveText("Fix in Health →");
    await fix.click();
    await expect(modeTab("health")).toHaveAttribute("aria-selected", "true");
    await expect(C().locator("h2#aos-brain-hl-hygiene")).toBeFocused();
    await expect(C().locator('section[data-anchor="hygiene"]')).toBeInViewport();
  });

  test("the recall preview, read only: an empty prompt asks for one and runs nothing; with the brain surface off a preview says why, and recall's index, recall-wake.md and the usage log stay as they were", async () => {
    const h = app();
    const card = bs().locator('[data-bs="recall"]');
    await expect(card).toHaveAttribute("aria-label", "Recall preview");
    await expect(card.locator("h3")).toHaveText("RECALL PREVIEW");
    const input = card.getByRole("textbox", { name: "Prompt to preview" });
    const go = card.locator('button[data-act="recall"]');
    await expect(go).toHaveAttribute("aria-label", "Preview recall");
    const out = card.locator(".aos-brain-bs-hits");
    await expect(out).toHaveAttribute("data-state", "idle");
    await expect(out).toHaveText("Type a prompt, then ⏎ or Preview.");
    const before = snapshot(RECALL_FILES);
    await clearGuard();
    await input.fill("   ");
    await input.press("Enter");
    await expect(out).toHaveText("Type a prompt first.");
    await expect(out).toHaveAttribute("data-state", "idle");
    await expect(input).toBeFocused();
    expect((await h.guard()).filter((e) => e.kind === "spawn")).toEqual([]);
    await input.fill(B().recall.hit);
    await go.click();
    await expect(out).toHaveAttribute("data-state", "error");
    await expect(out).toHaveText("Recall did not run: Brain's write surface is off in this app: run aos recall in a terminal instead");
    // Main refused exactly the preview's argv: the typed text as one query, --limit and --json (never --warm).
    const refused = (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(new RegExp(`sdk/recall-cli\\.js ${B().recall.hit} --limit 8 --json$`));
    expect(snapshot(RECALL_FILES)).toEqual(before);
    await input.press("Escape");
    await expect(input).toHaveValue("");
    await expect(out).toHaveText("Type a prompt, then ⏎ or Preview.");
    await clearGuard();
  });
});

// ── Map (D19) ────────────────────────────────────────────────────────

const mapEl = () => C().locator("section.aos-brain-map");
const mapView = (v: string) => mapEl().locator(`button.aos-brain-mapview[data-map-view="${v}"]`);
const bubble = (id: string) => mapEl().locator(`button.aos-brain-bubble[data-community="${id}"]`);
const mapRows = () => mapEl().locator(".aos-brain-maplist button.aos-brain-maprow");
const mapCard = () => mapEl().locator("aside.aos-brain-mapcard");
/** A community as the page counts it: its members (live in the fixture), those waiting for review, those used this week. */
const community = (id: string) => {
  const c = B().map.communities.find((x) => x.id === id)!;
  return { ...c, n: c.paths.length, unreviewed: c.paths.filter((p) => B().unreviewed.includes(p)).length, week: c.paths.filter((p) => B().usage.used.includes(p)).length };
};
async function showMap(v: string): Promise<void> {
  await mapView(v).click();
  await expect(mapEl()).toHaveAttribute("data-view", v);
  await expect(mapView(v)).toHaveAttribute("aria-selected", "true");
}

test.describe("Map", () => {
  test.beforeEach(async () => { await brain("map"); });

  test("Communities: graphify's communities of 3 or more memories as bubbles sized by their memories, named by their most-linked memory, the unreviewed share in words; the list with counts; the footer's graph, hubs, smaller groups and unlinked", async () => {
    const M = B().map;
    // The scan kept the graph although graphify is not installed here (graph-build reports "graphify missing").
    expect(fs.existsSync(FX.v("brain/graphify-out/graph.json"))).toBe(true);
    expect(M.state).toBe("ok");
    expect(M.communities.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(M.smaller).toEqual({ communities: 2, memories: 4 });
    await showMap("communities");
    await expect(mapEl()).toHaveAttribute("aria-label", "Map");
    await expect(mapEl().locator('[role="tablist"][aria-label="Map views"] [role="tab"]')).toHaveText(["Communities", "Around a memory", "Every node"]);
    expect(await mapEl().locator('[role="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("tabindex")))).toEqual(["0", "-1", "-1"]);
    await expect(mapEl().locator("h2.aos-brain-maph2")).toHaveText("Communities");
    await expect(mapEl().locator(".aos-brain-mapmeta")).toHaveText(/^from graphify · [23]h ago$/);
    const views = M.communities.map((c) => community(c.id));
    // Each bubble names its community in words: its memories and how many wait for review (the ring's word, D23).
    expect(await mapEl().locator("button.aos-brain-bubble").evaluateAll((els) => els.map((e) => [e.getAttribute("data-community"), e.getAttribute("aria-label")])))
      .toEqual(views.map((c) => [c.id, `${c.name}, ${pl(c.n, "memory", "memories")}, ${c.unreviewed} unreviewed`]));
    await expect(mapEl().locator(".aos-brain-bubblename")).toHaveText(views.map((c) => c.name));
    await expect(mapEl().locator(".aos-brain-bubblecap")).toHaveText(views.map((c) => (c.unreviewed ? `${c.n} · ${c.unreviewed} unreviewed` : String(c.n))));
    const discs = await mapEl().locator(".aos-brain-bubbledisc").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    expect(discs[0]).toBeGreaterThan(discs[2]);   // 7 memories against 4
    await expect(bubble("c1")).toHaveAttribute("aria-current", "true");
    await expect(mapEl().locator(".aos-brain-maplegend")).toHaveText("Size = memories · ring = unreviewed share");
    // The list beside them, largest first, with their counts; the selected one first.
    await expect(mapEl().locator(".aos-brain-maplist")).toHaveAttribute("aria-label", "Communities");
    expect(await mapRows().evaluateAll((els) => els.map((e) => e.getAttribute("data-community")))).toEqual(views.map((c) => c.id));
    await expect(mapRows().locator(".aos-brain-maprowname")).toHaveText(views.map((c) => c.name));
    await expect(mapRows().locator(".aos-brain-maprown")).toHaveText(views.map((c) => String(c.n)));
    await expect(mapRows().first()).toHaveAttribute("aria-selected", "true");
    await expect(mapEl().locator(".aos-brain-mapfoot p")).toHaveText([
      `${M.graph.communities} communities · ${M.graph.nodes} nodes · ${M.graph.edges} links in graphify's graph.`,
      "Index hubs left out: MEMORY.md.",
      `${M.smaller.communities} smaller groups (under ${M.mapMin} memories) hold ${M.smaller.memories} memories.`,
      `${pl(M.unlinked, "memory links", "memories link")} to no other.`,
      "Names come from each community's most-linked memory.",
    ]);
    // ↓ moves the selection through the list, the bubble with it.
    await mapRows().first().focus();
    await app().win.keyboard.press("ArrowDown");
    await expect(mapRows().nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(mapRows().nth(1)).toBeFocused();
    await expect(bubble(views[1].id)).toHaveAttribute("aria-current", "true");
    await bubble(views[0].id).click();
    await expect(mapRows().first()).toHaveAttribute("aria-selected", "true");
  });

  test("a community's card: N memories · N unreviewed · N used this week; MEMBERS most linked first, each unreviewed or used; LINKED COMMUNITIES with their links, one of which shows it; a member opens in Library", async () => {
    const now = new Date();
    const d7 = readVaultJson<{ usage: { paths: Record<string, { d7: number }> } }>("brain/_index/brain-hub.json").usage.paths;
    const c = community("c1");
    await bubble("c1").click();
    await expect(mapCard()).toHaveAttribute("aria-label", c.name);
    await expect(mapCard().locator("h2.aos-brain-mapcardtitle")).toHaveText(c.name);
    await expect(mapCard().locator(".aos-brain-mapcardline")).toHaveText(`${pl(c.n, "memory", "memories")} · ${c.unreviewed} unreviewed · ${c.week} used this week`);
    await expect(mapCard().locator("h3.aos-brain-label")).toHaveText(["Members", "Linked communities"]);
    const members = mapCard().locator("button.aos-brain-mapmember");
    expect(await paths(members)).toEqual(c.paths);
    await expect(members.locator(".aos-brain-mapmembername")).toHaveText(c.paths.map(titleOf));
    for (const p of c.paths) {
      const row = mapCard().locator(`button.aos-brain-mapmember[data-path="${p}"]`);
      const used = d7[p]?.d7 ?? 0;
      await expect(row.locator(".aos-brain-mapmemberun")).toHaveCount(B().unreviewed.includes(p) ? 1 : 0);
      await expect(row.locator(".aos-brain-mapmembernote")).toHaveText(used > 0 ? `${used}× used` : shortDay(writtenAt(p), now));
      if (used > 0) await expect(row.locator(".aos-brain-mapmembernote")).toHaveClass(/is-used/);
    }
    // Linked: the kept communities its members link to, the most links first.
    const linked = B().map.links.filter((l) => l.a === c.id || l.b === c.id).map((l) => ({ id: l.a === c.id ? l.b : l.a, n: l.n })).sort((x, y) => y.n - x.n);
    expect(linked.length).toBe(2);
    const chips = mapCard().locator("button.aos-brain-maplink");
    expect(await chips.evaluateAll((els) => els.map((e) => [e.getAttribute("data-community"), e.getAttribute("aria-label")])))
      .toEqual(linked.map((l) => [l.id, `${community(l.id).name}, ${pl(l.n, "link")}`]));
    await expect(chips).toHaveText(linked.map((l) => `${community(l.id).name}${l.n}`));
    await chips.first().click();
    await expect(bubble(linked[0].id)).toHaveAttribute("aria-current", "true");
    await expect(mapCard().locator("h2.aos-brain-mapcardtitle")).toHaveText(community(linked[0].id).name);
    await expect(mapEl().locator(`.aos-brain-maprow[data-community="${linked[0].id}"]`)).toBeFocused();
    const member = community(linked[0].id).paths[0];
    await mapCard().locator(`button.aos-brain-mapmember[data-path="${member}"]`).click();
    await expect(modeTab("library")).toHaveAttribute("aria-selected", "true");
    await expect(libRow(member)).toHaveAttribute("aria-selected", "true");
    await expect(reader().locator("h2")).toHaveText(titleOf(member));
  });

  test("Around a memory: the picker lists the map's memories most linked first and finds one; its neighbours, as the map lists them, round it and open Library; the card names its community", async () => {
    const M = B().map;
    await showMap("around");
    await expect(mapEl().locator("h2.aos-brain-maph2")).toHaveText("Memories");
    const inMap = Object.keys(M.memories);
    await expect(mapEl().locator(".aos-brain-mapmeta")).toHaveText(`${inMap.length} in the map`);
    const picks = inMap.map((p) => ({ p, d: M.memories[p].degree, t: titleOf(p) })).sort((a, b) => b.d - a.d || a.t.localeCompare(b.t) || (a.p < b.p ? -1 : 1));
    expect(await paths(mapRows())).toEqual(picks.map((x) => x.p));
    await expect(mapRows().locator(".aos-brain-maprown")).toHaveText(picks.map((x) => String(x.d)));
    const top = picks[0].p;
    await mapRows().first().click();
    await expect(mapEl().locator("button.aos-brain-arcentre")).toHaveAttribute("data-path", top);
    await expect(mapEl().locator("button.aos-brain-arcentre")).toHaveAttribute("aria-label", `${titleOf(top)}: open in Library`);
    const nb = M.memories[top].neighbours;
    const nodes = mapEl().locator("button.aos-brain-arnode");
    expect(await paths(nodes)).toEqual(nb.map((x) => x.path));
    expect(await nodes.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(nb.map((x) => `${titleOf(x.path)}, ${pl(x.n, "link")}: open in Library`));
    await expect(mapEl().locator(".aos-brain-maplegend")).toHaveText("Line weight = links between the two");
    // The card: its type and links, its community, its neighbours with theirs (none for a smaller group's).
    const names = new Map(M.communities.map((c) => [c.id, c.name]));
    await expect(mapCard().locator("h2.aos-brain-mapcardtitle")).toHaveText(titleOf(top));
    await expect(mapCard().locator(".aos-brain-mapcardline")).toHaveText(`projects · linked to ${M.memories[top].degree}`);
    await expect(mapCard().locator("button.aos-brain-mapincomm")).toHaveText(`In ${names.get(M.memories[top].community!)}`);
    const rows = mapCard().locator("button.aos-brain-mapmember");
    expect(await paths(rows)).toEqual(nb.map((x) => x.path));
    await expect(rows.locator(".aos-brain-mapmembername")).toHaveText(nb.map((x) => {
      const c = M.memories[x.path]?.community;
      return `${titleOf(x.path)}${c && names.has(c) ? ` · ${names.get(c)}` : ""}`;
    }));
    await expect(rows.locator(".aos-brain-mapmembernote")).toHaveText(nb.map((x) => pl(x.n, "link")));
    // Find narrows the picker; a row centres that memory. A memory in a smaller group has no community to show.
    const find = mapEl().getByRole("searchbox", { name: "Find a memory in the map" });
    const datum = "brain/memory/reference/chart-datum.md";
    await find.fill("datum");
    expect(await paths(mapRows())).toEqual([datum]);
    await mapRows().first().click();
    await expect(mapEl().locator("button.aos-brain-arcentre")).toHaveAttribute("data-path", datum);
    expect(await paths(nodes)).toEqual(M.memories[datum].neighbours.map((x) => x.path));
    expect(M.memories[datum].community).toBeNull();
    await expect(mapCard().locator("button.aos-brain-mapincomm")).toHaveCount(0);
    await find.press("Escape");
    await expect(find).toHaveValue("");
    await expect(mapRows()).toHaveCount(inMap.length);
    const n0 = M.memories[datum].neighbours[0].path;
    await mapEl().locator(`button.aos-brain-arnode[data-path="${n0}"]`).click();
    await expect(modeTab("library")).toHaveAttribute("aria-selected", "true");
    await expect(libRow(n0)).toHaveAttribute("aria-selected", "true");
    await brain("map");
    await showMap("communities");
  });

  test("Every node: memory nodes only, the map's live memories, linked by their neighbours (MapMode.graph); its counts; the unreviewed ones marked and named in the legend; a node opens in Library", async () => {
    const { win } = app();
    const M = B().map;
    await showMap("every");
    await expect(mapEl().locator("aside.aos-brain-mapleft")).toBeHidden();
    await expect(mapCard()).toBeHidden();
    // The graph on screen, read through the tab (MapMode.graph is public for this).
    const graph = () => win.evaluate(() => {
      const w = window as unknown as { aosHost: { app: { workspace: { getLeavesOfType(t: string): Array<{ view: { getTab(id: string): { modes: { map?: { graph: { nodes: Array<{ id: string; kind: string; path: string }>; edges: Array<{ from: string; to: string }> } | null } } } } }> } } } };
      const g = w.aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0].view.getTab("memory").modes.map?.graph;
      return g ? { nodes: g.nodes.map((n) => ({ id: n.id, kind: n.kind, path: n.path })), edges: g.edges.map((e) => [e.from, e.to].join("\n")) } : null;
    });
    await expect.poll(async () => (await graph()) !== null).toBe(true);
    const g = (await graph())!;
    const want = Object.keys(M.memories).filter((p) => live().includes(p)).sort();
    expect(g.nodes.map((n) => n.id)).toEqual(want);
    expect(g.nodes.every((n) => n.kind === "memory" && n.path === n.id)).toBe(true);
    const pairs = new Set<string>();
    for (const p of want) for (const nb of M.memories[p].neighbours) if (nb.path !== p && want.includes(nb.path)) pairs.add([p, nb.path].sort().join("\n"));
    expect([...g.edges].sort()).toEqual([...pairs].sort());
    const stats = `${want.length} memories · ${pairs.size} links`;
    await expect(mapEl().locator(".aos-brain-mapstats")).toHaveText(stats);
    await expect(mapEl().locator("svg.aos-brain-mapsvg")).toHaveAttribute("aria-label", `Every node: ${stats}`);
    const drawn = mapEl().locator("svg.aos-brain-mapsvg g.aos-brain-mapnode");
    await expect(drawn).toHaveCount(want.length);
    expect(await drawn.evaluateAll((els) => els.filter((e) => e.classList.contains("is-unreviewed")).map((e) => e.getAttribute("data-id")).sort()))
      .toEqual(want.filter((p) => B().unreviewed.includes(p)).sort());
    await expect(mapEl().locator(".aos-brain-maplegend")).toHaveText("unreviewed");
    await expect(mapEl().locator(".aos-brain-maphint")).toHaveText("Click a memory to open it in Library · drag to pin · ⌘-click to unpin");
    await expect(mapEl().locator("button.aos-brain-mapresettle")).toHaveText("Resettle");
    // A click on a node shows it in Library (the sim keeps moving, so the click goes to the node itself).
    const tide = "brain/memory/reference/tide-api-notes.md";
    await mapEl().locator(`g.aos-brain-mapnode[data-id="${tide}"]`).dispatchEvent("click");
    await expect(modeTab("library")).toHaveAttribute("aria-selected", "true");
    await expect(libRow(tide)).toHaveAttribute("aria-selected", "true");
    await expect(reader().locator("h2")).toHaveText("Tide API notes");
    await brain("map");
    await showMap("communities");
  });

  test("the empty states: graph off in agenticos.json (or a map the scan wrote off) names aos graph on; no brain-map.json says the next scan writes it; the map back, it draws again, and the page never rebuilds it read only", async () => {
    const { win } = app();
    const cfgFile = path.join(FX.claude, "agenticos.json");
    const cfgWas = fs.readFileSync(cfgFile, "utf8");
    const MAP = "brain/_index/brain-map.json";
    const mapWas = read(MAP);
    const none = mapEl().locator(".aos-brain-mapnone");
    const offText = "The graph is off. aos graph on builds it, and the next scan draws the map from it.";
    await clearGuard();
    try {
      // graph.enabled false wins over the map an earlier scan left: the tab reads the config each time it is shown.
      const cfg = JSON.parse(cfgWas) as { graph: Record<string, unknown> };
      cfg.graph = { ...cfg.graph, enabled: false };
      fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
      await openTab(win, "pulse");
      await brain("map");
      await expect(none).toHaveAttribute("data-state", "off");
      await expect(none).toHaveAttribute("role", "status");
      await expect(none.locator(".aos-brain-mapnonetext")).toHaveText(offText);
      await expect(none.locator("code")).toHaveText("aos graph on");
      await expect(mapEl()).toHaveClass(/is-empty/);
      await expect(mapEl().locator('[role="tablist"]')).toHaveCount(0);
      fs.writeFileSync(cfgFile, cfgWas);
      await openTab(win, "pulse");
      await brain("map");
      await expect(mapEl().locator("button.aos-brain-bubble")).toHaveCount(B().map.communities.length);
      // The map the scan writes with the graph off (lib/brain-map.js emptyMap), read within seconds of its write.
      const { emptyMap } = createRequire(__filename)(FX.v("brain/scripts/lib/brain-map.js")) as { emptyMap(state: string, o: { mapMin: number }): unknown };
      fs.writeFileSync(FX.v(MAP), `${JSON.stringify(emptyMap("off", { mapMin: B().map.mapMin }))}\n`);
      await expect(none).toHaveAttribute("data-state", "off", { timeout: 10_000 });
      await expect(none.locator(".aos-brain-mapnonetext")).toHaveText(offText);
      // No brain-map.json at all (before the first scan that writes one).
      fs.rmSync(FX.v(MAP));
      await expect(none).toHaveAttribute("data-state", "missing", { timeout: 10_000 });
      await expect(none.locator(".aos-brain-mapnonetext")).toHaveText("No map yet: the next scan writes it.");
      await expect(none.locator("code")).toHaveCount(0);
      fs.writeFileSync(FX.v(MAP), mapWas);
      await expect(mapEl().locator("button.aos-brain-bubble")).toHaveCount(B().map.communities.length, { timeout: 10_000 });
      await expect(mapEl()).not.toHaveClass(/is-empty/);
    } finally {
      fs.writeFileSync(cfgFile, cfgWas);
      if (!fs.existsSync(FX.v(MAP)) || read(MAP) !== mapWas) fs.writeFileSync(FX.v(MAP), mapWas);
    }
    expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
  });
});

// ── Health (D20) ─────────────────────────────────────────────────────

const hl = () => C().locator(".aos-brain-health");
const tile = (k: string) => hl().locator(`[data-tile="${k}"]`);
const fixBtn = (k: string) => hl().locator(`[data-hl-key="fix:${k}"]`);

test.describe("Health", () => {
  test.beforeEach(async () => { await brain("health"); });

  test("six tiles, each value with its state in words (D23): duplicate pairs, unreviewed with its share, never used in 30 days, BRAIN.md against its budget, MEMORY.md's tokens and lines, broken links with the unindexed and misfiled", async () => {
    const src = B().sources;
    const raw = read("MEMORY.md");
    const h = B().hygiene;
    expect(tokensOf(raw)).toBeLessThan(1000);
    const over = src.tokens > src.budget;
    const full = !over && src.sections.active.omitted.length > 0;
    const want: Array<[string, string, string, string, string, string]> = [
      ["duplicates", String(B().dups.length), "Duplicate pairs", "to compare", B().clusters.length ? pl(B().clusters.length, "cluster") : "no clusters", "warn"],
      ["unreviewed", String(B().unreviewed.length), "Unreviewed", "to review", `${Math.round((B().unreviewed.length / live().length) * 100)}% of all memories`, "warn"],
      ["unused", String(B().usage.never.length), "Never used", "", "in 30 days", "plain"],
      // From the raw numbers, as Bootstrap's bar: over its budget, else full when projects were left out, else within it.
      ["brainmd", `${Math.round((src.tokens / src.budget) * 100)}%`, "BRAIN.md", over ? "over budget" : full ? "full" : "within budget", `${src.tokens} of ${src.budget} tokens`, over || full ? "warn" : "ok"],
      ["memorymd", String(tokensOf(raw)), "MEMORY.md", "", `tokens · ${lineCount(raw)} lines`, "plain"],
      ["broken", String(h.brokenIndex.length), "Broken links", "to fix", `${h.unindexed.length} unindexed · ${h.misfiled.length} misfiled`, "warn"],
    ];
    await expect(hl()).toHaveAttribute("aria-label", "Health");
    await expect(hl().locator('[role="list"][aria-label="Health at a glance"] [role="listitem"]')).toHaveCount(6);
    expect(await hl().locator("[data-tile]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tile")))).toEqual(want.map((w) => w[0]));
    for (const [k, value, label, word, note, tone] of want) {
      await expect(tile(k).locator(".aos-brain-hl-tv")).toHaveText(value);
      await expect(tile(k).locator(".aos-brain-hl-tk > span").first()).toHaveText(label);
      if (word) await expect(tile(k).locator(".aos-brain-hl-tw")).toHaveText(word);
      else await expect(tile(k).locator(".aos-brain-hl-tw")).toHaveCount(0);
      await expect(tile(k).locator(".aos-brain-hl-tn")).toHaveText(note);
      await expect(tile(k)).toHaveAttribute("data-tone", tone);
    }
  });

  test("Duplicates and clusters: the pair with its score and type, Compare landing on Review's Duplicates queue; the approved draft left behind offers the drafts fix; Rescan", async () => {
    const hub = readVaultJson<{ builtAt: string }>("brain/_index/brain-hub.json");
    const card = hl().locator('section[data-anchor="duplicates"]');
    await expect(card.locator("h2")).toHaveText("Duplicates and clusters");
    await expect(card.locator(".aos-brain-hl-csub")).toHaveText(`title and text similarity, no model · scanned ${batchWhen(hub.builtAt, new Date())}`);
    await expect(card.locator('[data-hl-key="rescan"]')).toHaveText("Rescan");
    const [newer, older] = B().duplicate;
    const d = B().dups[0];
    const pair = card.locator(".aos-brain-hl-pair");
    await expect(pair).toHaveCount(B().dups.length);
    await expect(pair).toHaveAttribute("data-pair", [d.a, d.b].sort().join("|"));
    await expect(pair.locator(".aos-brain-hl-score")).toHaveText(d.score.toFixed(2));
    await expect(pair.locator(".aos-brain-hl-t1")).toHaveText(titleOf(d.a));
    await expect(pair.locator(".aos-brain-hl-t2")).toHaveText(`${titleOf(d.b)} · feedback`);
    expect(await pair.locator("button").evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("aria-label")]))).toEqual([
      ["Compare", `Compare “${titleOf(d.a)}” and “${titleOf(d.b)}” in Review`], ["Merge with AI…", `Merge with AI: “${titleOf(d.a)}” and “${titleOf(d.b)}”`],
      ["Not duplicates", `Not duplicates: “${titleOf(d.a)}” and “${titleOf(d.b)}”`],
    ]);
    // The approved rule's draft, still in _drafts (its memory is live and pinned): the drafts fix removes it.
    expect(fmKey(B().pinned, "source")).toBe("feedback-autoloop");
    const draft = card.locator(".aos-brain-hl-draft");
    await expect(draft).toHaveAttribute("data-draft", B().leftover);
    await expect(draft).toHaveAttribute("data-path", `brain/memory/feedback/_drafts/${B().leftover}.md`);
    await expect(draft.locator(".aos-brain-hl-leftover")).toHaveText("draft");
    await expect(draft.locator(".aos-brain-hl-t1")).toHaveText(titleOf(B().pinned));
    await expect(draft.locator(".aos-brain-hl-t2")).toHaveText("The same rule (slug and title), still in feedback/_drafts after it was approved");
    await expect(draft.locator('button[data-act="fix"][data-fix="drafts"]')).toHaveText("Remove the draft…");
    await expect(card.locator(".aos-brain-hl-cluster")).toHaveCount(B().clusters.length);
    // Compare lands on Review's Duplicates queue on that very pair (ReviewMode.test.ts picks the second of two), as an
    // older and a newer box.
    await pair.locator('button[data-act="compare"]').click();
    await expect(modeTab("review")).toHaveAttribute("aria-selected", "true");
    await expect(queue("duplicates")).toHaveAttribute("aria-pressed", "true");
    await expect(main().locator("h2")).toHaveText("Duplicates");
    await expect(main().locator(".aos-brain-rv-pair")).toHaveAttribute("data-a", d.a);
    await expect(main().locator(".aos-brain-rv-pair")).toHaveAttribute("data-b", d.b);
    expect(await paths(main().locator(".aos-brain-rv-pair .aos-brain-rv-box"))).toEqual([older, newer]);
    await showQueue("session");
  });

  test("Hygiene: a row per fix, each with its finding in words, its count and a button that previews first", async () => {
    const h = B().hygiene;
    expect([h.sources.session, h.sources["in-session"], h.oldType, h.leftoverDrafts]).toEqual([1, 1, [B().oldType], [B().leftover]]);
    const card = hl().locator('section[data-anchor="hygiene"]');
    await expect(card.locator("h2")).toHaveText("Hygiene");
    await expect(card.locator(".aos-brain-hl-csub")).toHaveText("one click, no model, with a preview first");
    const n = h.noDescription.length;
    const want: Array<[string, number, string, string]> = [
      ["sources", 2, "2 memories carry an old source label (session, in-session) where /wrap writes manual-wrap", "Normalise 2…"],
      ["types", 1, "1 memory uses an old type: shape", "Fix 1…"],
      ["descriptions", n, `${n} memories keep their description only in MEMORY.md, none in their own frontmatter`, "Copy from MEMORY.md…"],
      ["index", 3, "1 memory is not in MEMORY.md; 1 line sits under the wrong heading; 1 line points at a missing file", "Fix 3…"],
      ["drafts", 1, "1 approved draft is still in feedback/_drafts", "Remove the draft…"],
    ];
    const rows = card.locator(".aos-brain-hl-hyg");
    expect(await rows.evaluateAll((els) => els.map((e) => [e.getAttribute("data-fix"), Number(e.getAttribute("data-count"))]))).toEqual(want.map((w) => [w[0], w[1]]));
    await expect(rows.locator(".aos-brain-hl-hygtext")).toHaveText(want.map((w) => w[2]));
    await expect(rows.locator("button")).toHaveText(want.map((w) => w[3]));
    expect(await rows.locator("button").evaluateAll((els) => els.map((e) => [e.getAttribute("data-act"), e.getAttribute("data-fix"), e.getAttribute("aria-disabled")]))).toEqual(want.map((w) => ["fix", w[0], null]));
    await expect(card.locator(".aos-brain-hl-hyg.is-clean")).toHaveCount(0);
  });

  test("Dead weight: used, quiet and never in 30 days as a bar named in words; Archive the 1 shipped… asks first and Cancel archives nothing; Review the 12 opens Library on exactly those", async () => {
    const u = B().usage;
    const card = hl().locator('section[data-anchor="deadweight"]');
    await expect(card.locator("h2")).toHaveText("Dead weight");
    await expect(card.locator(".aos-brain-hl-csub")).toHaveText("never injected, recalled or read in 30 days");
    await expect(card.locator(".aos-brain-hl-cbody")).toHaveAttribute("data-state", "ready");
    // The log began 44 days ago, longer than memory.neverUsedDays: the counts show.
    expect(Date.now() - Date.parse(u.since)).toBeGreaterThan(30 * DAY);
    const bar = card.locator(".aos-brain-hl-bar");
    await expect(bar).toHaveAttribute("role", "img");
    await expect(bar).toHaveAttribute("aria-label", `used ${u.used.length}, quiet ${u.quiet.length}, never ${u.never.length}`);
    await expect(card.locator("[data-bucket]")).toHaveText([`used ${u.used.length}`, `quiet ${u.quiet.length}`, `never ${u.never.length}`]);
    await expect(card.locator(".aos-brain-hl-help")).toHaveText("Used: in the last 7 days. Quiet: not since, but in the last 30. Never: not in 30 days.");
    // Never used and looks shipped: the project BRAIN.md left out, so no session was given it.
    expect(u.never.filter((p) => B().looksShipped.some((s) => s.path === p))).toEqual([B().shipped.version]);
    await expect(card.locator(".aos-brain-hl-dwtext")).toHaveText(`${u.never.length} memories nobody used in the last 30 days. 1 of them is a project note for shipped work.`);
    const tree = memoryTree(FX.vault);
    await clearGuard();
    const archive = card.locator('[data-hl-key="dw:archive"]');
    await expect(archive).toHaveText("Archive the 1 shipped…");
    await archive.click();
    const modal = app().win.locator(".modal", { hasText: "Archive 1 shipped project?" });
    await expect(modal.locator("h3")).toHaveText("Archive 1 shipped project?");
    await expect(modal.locator("p")).toHaveText("Archives the project note nobody used in the last 30 days that is complete or looks shipped. They leave recall, the MOCs and BRAIN.md. Nothing is deleted: Restore in Library puts each one back.");
    await expect(modal.locator("button")).toHaveText(["Cancel", "Archive 1"]);
    await modal.locator("button", { hasText: "Cancel" }).click();
    await expect(modal).toHaveCount(0);
    expect(memoryTree(FX.vault)).toEqual(tree);
    expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
    await expect(archive).toBeFocused();
    // Review the 12: Library on the unused, exactly those, the first selected with the keyboard.
    const review = card.locator('[data-hl-key="dw:review"]');
    await expect(review).toHaveText(`Review the ${u.never.length}`);
    await expect(review).toHaveAttribute("aria-label", `Review the ${u.never.length} in Library`);
    await review.click();
    await expect(modeTab("library")).toHaveAttribute("aria-selected", "true");
    await expect(facet("Use")).toHaveValue("unused");
    await expect(facetText("use")).toHaveText("Use: unused");
    await expect(C().locator('.aos-lib-facet[data-facet="use"]')).toHaveClass(/is-set/);
    for (const [key, text] of [["type", "Type: any"], ["status", "Status: live"], ["source", "Source: any"]]) await expect(facetText(key)).toHaveText(text);
    await expect(C().locator(".aos-lib-count")).toHaveText(`${u.never.length} MATCHES`);
    expect((await paths(libRows())).sort()).toEqual([...u.never].sort());
    await expect(libRows().locator(".aos-lib-use")).toHaveText(u.never.map(() => "unused"));
    await expect(libRows().first()).toHaveAttribute("aria-selected", "true");
    await expect(libRows().first()).toBeFocused();
    await facet("Use").selectOption("any");
    await expect(libRows()).toHaveCount(live().length);
  });

  test("with the brain surface off, a fix is refused at its preview: the Notice says why, no dialog opens, the button is back, and nothing changes", async () => {
    const h = app();
    const tree = memoryTree(FX.vault);
    const index = read("MEMORY.md");
    await clearGuard();
    const n = h.notices.length;
    await fixBtn("sources").click();
    await expect.poll(() => h.notices.slice(n)).toEqual([`Normalise source labels: ${BRAIN_OFF_TEXT}`]);
    await expect(h.win.locator(".modal.mod-brain-fix")).toHaveCount(0);
    // Main refused the dry run itself: nothing was listed, so nothing could be confirmed.
    const refused = (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what.replace(/^.*\/cli\/aos\.js /, ""));
    expect(refused).toEqual(["memory fix sources --dry-run --json"]);
    await expect(fixBtn("sources")).toHaveText("Normalise 2…");
    await expect(fixBtn("sources")).not.toHaveAttribute("aria-disabled", "true");
    expect(memoryTree(FX.vault)).toEqual(tree);
    expect(read("MEMORY.md")).toBe(index);
    expect(read(TRAIL)).toBe(pristine(TRAIL));
    await clearGuard();
  });
});

// ── the rail badge and links ─────────────────────────────────────────

test("the rail badge counts memories written since Review was last open (D16): a new unreviewed memory reads 1 within seconds, a link to another mode leaves it, Review clears it, and one written while Review shows is not badged", async () => {
  const { win } = app();
  const rel = "brain/memory/reference/buoy-battery-swap.md";
  const rel2 = "brain/memory/reference/buoy-light-check.md";
  const trailWas = read(TRAIL);
  // Brain was last left on Review, so the rail opens it there.
  await brain("review");
  await openTab(win, "pulse");
  await expect(badge(win, "memory")).toHaveClass(/is-empty/);
  await expect(badge(win, "memory")).toHaveText("");
  try {
    // A memory auto-wrap writes, as lib/memory-writer.js does, and its trail row (lib/promote-log.js appendTrail).
    const write = (path: string, slug: string, title: string) => {
      const at = new Date();
      const d = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
      fs.writeFileSync(FX.v(path), `---\ntype: memory\ntags: [memory/reference, status/active]\ncreated: ${d}\nupdated: ${d}\nsource: auto-wrap\nsession: ${B().sessions.claude}\nreviewed: false\n---\n\n# ${title}\n\nCheck the buoy every ninety days.\n`);
      fs.appendFileSync(FX.v(TRAIL), `${JSON.stringify({ ts: at.toISOString(), session: B().sessions.claude, action: "written", slug, type: "reference", title })}\n`);
    };
    write(rel, "buoy-battery-swap", "Buoy battery swap");
    await expect(badge(win, "memory")).toHaveText("1", { timeout: 10_000 });
    await expect(badge(win, "memory")).not.toHaveClass(/is-empty/);
    await expect(rail(win, "pulse")).toHaveClass(/is-active/);
    // A link from Pulse into another mode (BRAIN.md's % opens Bootstrap) shows Brain without Review: the badge stays.
    await C().locator('.aos-pulse-tile[data-area="memory"] [data-brain-link="bootstrap"]').click();
    await expect(modeTab("bootstrap")).toHaveAttribute("aria-selected", "true");
    await expect(badge(win, "memory")).toHaveText("1");
    // Review shown: the badge counts from now, so it clears; the memory waits in Review.
    await mode("review");
    await expect(badge(win, "memory")).toHaveText("");
    await expect(badge(win, "memory")).toHaveClass(/is-empty/);
    await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveText(String(B().unreviewed.length + 1));
    // One written while Review is on screen shows there and is not badged, then or after leaving by the rail.
    write(rel2, "buoy-light-check", "Buoy light check");
    await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveText(String(B().unreviewed.length + 2));
    await expect(badge(win, "memory")).toHaveText("");
    await openTab(win, "pulse");
    await expect(badge(win, "memory")).toHaveText("");
    await openTab(win, "memory");
  } finally {
    fs.rmSync(FX.v(rel), { force: true });
    fs.rmSync(FX.v(rel2), { force: true });
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
