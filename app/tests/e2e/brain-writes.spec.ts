// Brain with its write surface on (AOS_APP_WRITE=brain; spec 2026-10-11-brain-hub D13, D14): every action is one
// `aos memory` verb (or the recall preview's sdk/recall-cli.js) the brain surface admits, run by the vault's own runtime,
// and the page writes no file itself. Review's K (one memory), ⇧K (the batch's new ones, never the flagged one), A
// (archive, D5) and P (pin and unpin, with BRAIN.md rebuilt), M's Keep the older one (supersede, D7) and Keep both (not
// duplicates, D11), a draft's Approve (Review) and Reject… (Library, after asking), Library's Set status and Restore, and
// Mark everything before (D3); a memory changed on disk after the page read it is refused (`set --expect`, D17);
// brain-hub.json follows an action. Bootstrap's Unpin, Mark complete and Mark the N complete… (D17) and the recall
// preview's hits, which write nothing (D18, D9); each Health fix through its dry run and FixModal (D20, spec §6), one
// whose cache was behind, Not duplicates and Archive the N shipped…. Each test checks what the runtime left on disk
// against the fixture's pristine copy, and puts back what it changed, so the tests stay independent.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { FX, appEnv, closeNotes, content, expected, guardWrites, openTab, readVaultJson, useApp, type ExpectedBrain, type ExpectedFix, type ExpectedFixChange, type ExpectedSources } from "./harness";
import { shortDay } from "../../../hud/src/data/brainModel";

const app = useApp({ env: { AOS_APP_WRITE: "brain" } });
const C = () => content(app().win);
const B = () => expected().brain;

// ── the files ────────────────────────────────────────────────────────

const TRAIL = "brain/_index/promote-log.jsonl";
const HUB = "brain/_index/brain-hub.json";
const NOTDUP = "brain/_index/memory-notdup.json";
const BRAIN_MD = "brain/_index/BRAIN.md";
const MAP = "brain/_index/brain-map.json";
const read = (rel: string): string | null => (fs.existsSync(FX.v(rel)) ? fs.readFileSync(FX.v(rel), "utf8") : null);
const pristinePath = (rel: string) => path.join(FX.pristine, "vault", rel);
const pristine = (rel: string): string => fs.readFileSync(pristinePath(rel), "utf8");
/** The trail rows appended since the fixture was made. */
const trailAdded = (): Array<Record<string, unknown>> => read(TRAIL)!.slice(pristine(TRAIL).length).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const hub = () => readVaultJson<{ builtAt: string; batches: Array<{ key: string; paths: string[] }>; dups: Array<{ a: string; b: string }> }>(HUB);
const pl = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** MEMORY.md's description for a memory, as the fixture has it (`- [Title](path) — description`). */
const indexDesc = (rel: string): string => new RegExp(`^- \\[[^\\]]*\\]\\(${rel.replace(/[.]/g, "\\.")}\\) — (.*)$`, "m").exec(pristine("MEMORY.md"))![1];
/** MEMORY.md's line for a memory, with its line end. */
const indexLine = (rel: string): string => new RegExp(`^- \\[[^\\]]*\\]\\(${rel.replace(/[.]/g, "\\.")}\\) — .*\\n`, "m").exec(pristine("MEMORY.md"))![0];

/** Every file under `dir` (relative to the vault), recursively. */
function files(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    if (!fs.existsSync(path.join(root, rel))) return;
    for (const n of fs.readdirSync(path.join(root, rel))) {
      const r = `${rel}/${n}`;
      if (fs.statSync(path.join(root, r)).isDirectory()) walk(r); else out.push(r);
    }
  };
  walk(dir);
  return out.sort();
}
const memoryTree = (): Record<string, string> => Object.fromEntries(files(FX.vault, "brain/memory").map((r) => [r, read(r)!]));
const pristineTree = (): Record<string, string> => Object.fromEntries(files(path.join(FX.pristine, "vault"), "brain/memory").map((r) => [r, pristine(r)]));

/** What a verb and its rebuilds may change: the memory store, MEMORY.md, the trail, BRAIN.md and its sources, the MOCs,
 *  the hub's two caches (brain-hub.json and brain-map.json) and the feedback metrics. */
const INDEX_FILES = [TRAIL, HUB, NOTDUP, BRAIN_MD, MAP, "brain/_index/brain-sources.json", "brain/_index/feedback-metrics.jsonl",
  "brain/_index/MOC-patterns.md", "brain/_index/MOC-projects.md", "brain/_index/MOC-reference.md"];

/** Puts one file back as the fixture had it (or removes it when the fixture had none), only when it differs. */
function restore(rel: string): void {
  const want = fs.existsSync(pristinePath(rel)) ? pristine(rel) : null;
  if (read(rel) === want) return;
  if (want === null) fs.rmSync(FX.v(rel), { force: true });
  else { fs.mkdirSync(path.dirname(FX.v(rel)), { recursive: true }); fs.writeFileSync(FX.v(rel), want); }
}

const run = promisify(execFile);
/** The runtime the page started for an action: the verb, the BRAIN.md and brain-hub.json rebuilds, a draft's script. */
async function runtimeBusy(): Promise<string[]> {
  const { stdout } = await run("ps", ["-Aww", "-o", "command="], { maxBuffer: 64 << 20 });
  return stdout.split("\n").filter((c) => c.includes(FX.vault) && /brain-hub\.js|build-brain-md\.js|cli\/aos\.js memory|feedback-apply\.js/.test(c));
}
/** Waits until nothing the page started still runs (twice in a row: brain-hub.js may run once more after an action). */
async function idle(): Promise<void> {
  for (let quiet = 0, until = Date.now() + 30_000; quiet < 2;) {
    if (Date.now() > until) throw new Error(`the runtime is still busy:\n${(await runtimeBusy()).join("\n")}`);
    quiet = (await runtimeBusy()).length ? 0 : quiet + 1;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Puts the brain back as the fixture had it, once the runtime the last test started has finished. */
async function resetBrain(): Promise<void> {
  await idle();
  const want = new Set(files(path.join(FX.pristine, "vault"), "brain/memory"));
  for (const rel of files(FX.vault, "brain/memory")) if (!want.has(rel)) fs.rmSync(FX.v(rel), { force: true });
  for (const rel of [...want, "MEMORY.md", ...INDEX_FILES]) restore(rel);
}

// ── the page ─────────────────────────────────────────────────────────

const modeTab = (m: string) => C().locator(`.aos-brain-modes [role="tab"][data-mode="${m}"]`);
const queue = (q: string) => C().locator(`.aos-brain-rv-queues button.aos-brain-chip[data-queue="${q}"]`);
const batchRow = (key: string) => C().locator(`.aos-brain-rv-left button.aos-brain-rv-batch[data-key="${key}"]`);
const main = () => C().locator(".aos-brain-rv-main");
const card = (rel: string) => main().locator(`article.aos-brain-rv-card[data-path="${rel}"]`);
const libRow = (rel: string) => C().locator(`.aos-lib-list button.aos-lib-row[data-path="${rel}"]`);
const reader = () => C().locator("section.aos-lib-reader");
const notices = (win: Page) => win.locator(".notice-container");
const batchOf = (rel: string) => B().batches.find((b) => b.paths.includes(rel))!;

async function mode(m: string): Promise<void> {
  await modeTab(m).click();
  await expect(modeTab(m)).toHaveAttribute("aria-selected", "true");
  await expect(C().locator(".aos-brain-body")).toHaveAttribute("data-mode", m);
}
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
}
/** Selects a card and gives it the keyboard (a click on its summary, not on a button). A card whose verb just ran stays
 *  hidden until the files say so or ten seconds pass (ReviewMode GONE_MS), so one the last test acted on may take that. */
async function focusCard(rel: string): Promise<Locator> {
  await expect(card(rel)).toBeVisible({ timeout: 15_000 });
  await card(rel).locator(".aos-brain-rv-sum").click();
  await expect(card(rel)).toHaveAttribute("aria-current", "true");
  await expect(card(rel)).toBeFocused();
  return card(rel);
}
/** Waits until brain-hub.json was built again after `was` (the page rebuilds it after each action, D12). */
async function hubRebuilt(was: string): Promise<void> {
  await expect.poll(() => hub().builtAt, { timeout: 30_000 }).not.toBe(was);
}
/**
 * Review has redrawn from the files as they are after an action: the header's Review count (from the batches, never
 * from what the page hides while a verb runs) is drawn in the same render as Review. Review lets go of a card it hid
 * after a verb only when it redraws from files that no longer list it, so a test waits for this before it leaves Review;
 * else the card could stay hidden when the files are put back for the next test.
 */
async function reviewSees(waiting: number): Promise<void> {
  await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveText(String(waiting));
}

test.beforeEach(async () => {
  await brain("review");
  await showQueue("session");
});

test.afterEach(async () => {
  const h = app();
  // Every write in this file is the runtime's, through a verb the brain surface admits: the page wrote nothing itself,
  // and main refused no spawn.
  expect(await guardWrites(h)).toEqual([]);
  expect((await h.guard()).filter((e) => e.kind === "spawn")).toEqual([]);
  await closeNotes(h.win);
  await resetBrain();
  // The page follows the files back: the store is the fixture's again.
  await brain("review");
  await reviewSees(B().unreviewed.length);
  await expect(modeTab("library").locator(".aos-brain-modebadge")).toHaveText(String(B().memories.length - B().archived.length));
  // And Health counts what the files list: a pair dismissed on this page shows again once memory-notdup.json is put back.
  await expect(modeTab("health").locator(".aos-brain-modebadge")).toHaveText(String(healthCount()));
});

test("Brain is the one surface on: the status bar names it and its commands, the verbs, the recall preview, the hub's rebuild and BRAIN.md's", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Brain");
  await expect(mode).toHaveAttribute("title", /^Brain: cli\/aos\.js, sdk\/recall-cli\.js, brain-hub\.js, build-brain-md\.js\n/);
});

test("K keeps one memory: reviewed: true and nothing else in the file, a kept row in the trail, MEMORY.md as it was; the card leaves, the next is selected, and brain-hub.json follows", async () => {
  const { win } = app();
  const rel = "brain/memory/projects/depth-contours-layer.md";
  const b = batchOf(rel);
  expect(b.paths).toEqual([rel, "brain/memory/user/depths-in-metres.md"]);
  const builtAt = hub().builtAt;
  await pickBatch(b.key);
  await focusCard(rel);
  await win.keyboard.press("k");
  await expect.poll(() => read(rel)).toBe(pristine(rel).replace("reviewed: false\n", "reviewed: true\n"));
  await expect(card(rel)).toHaveCount(0);
  await expect(card(b.paths[1])).toHaveAttribute("aria-current", "true");
  await expect(card(b.paths[1])).toBeFocused();
  await expect(main().locator(".aos-brain-rv-lede")).toHaveText("1 left to review. It looks new.");
  // lib/memory-ops.js appendTrail's row: the memory's session, slug, type, title and path.
  await expect.poll(() => trailAdded().length).toBe(1);
  expect(trailAdded()[0]).toEqual({ ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), session: B().sessions.codex, action: "kept", slug: "depth-contours-layer", type: "projects", title: "Depth contours layer", path: rel });
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  // The hub's cache is rebuilt from the files: the batch keeps only what still waits.
  await hubRebuilt(builtAt);
  expect(hub().batches.find((x) => x.key === b.key)?.paths).toEqual([b.paths[1]]);
  expect(hub().batches.flatMap((x) => x.paths)).not.toContain(rel);
  await reviewSees(B().unreviewed.length - 1);
});

test("⇧K keeps the batch's new memories in one call and leaves the one that looks known", async () => {
  const { win } = app();
  const b = byKeyOf(B().sessions.claude);
  const [flagged] = B().duplicate;
  const fresh = b.paths.filter((p) => p !== flagged);
  expect(fresh).toHaveLength(2);
  const before = { flagged: read(flagged), index: read("MEMORY.md") };
  await pickBatch(b.key);
  await expect(main().locator("button.aos-brain-rv-keepnew")).toHaveText("Keep the 2 new⇧K");
  await focusCard(flagged);
  // ⇧K from the button itself: it turns off ("Nothing new to keep"), so the keyboard goes to the card that is left, never
  // to the page.
  await main().locator("button.aos-brain-rv-keepnew").focus();
  await win.keyboard.press("Shift+K");
  for (const p of fresh) await expect.poll(() => read(p)).toBe(pristine(p).replace("reviewed: false\n", "reviewed: true\n"));
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path])).toEqual(fresh.map((p) => ["kept", p]));
  expect(read(flagged)).toBe(before.flagged);
  expect(read("MEMORY.md")).toBe(before.index);
  // Only the flagged card is left, still selected; nothing new is left to keep.
  await expect(main().locator("article.aos-brain-rv-card")).toHaveCount(1);
  await expect(card(flagged)).toHaveAttribute("aria-current", "true");
  await expect(card(flagged)).toBeFocused();
  await expect(main().locator(".aos-brain-rv-lede")).toHaveText("1 left to review. It looks like one you already have.");
  const keepNew = main().locator("button.aos-brain-rv-keepnew");
  await expect(keepNew).toHaveText("Nothing new to keep⇧K");
  await expect(keepNew).toBeDisabled();
  await expect(keepNew).toHaveAttribute("title", "Every memory here looks like one you already have");
  await expect(batchRow(b.key).locator(".aos-brain-rv-rmeta > span:nth-child(2)")).toHaveText("1 new");
  await reviewSees(B().unreviewed.length - 2);
  await idle();
});

test("A archives one (D5): status/archived, archived: and status_before, its description kept, its MEMORY.md line gone; Library's Status: archived shows it, and Restore puts the status and the line back", async () => {
  const { win } = app();
  const rel = "brain/memory/user/depths-in-metres.md";
  const desc = "metres with one decimal; feet only when asked";
  expect(indexLine(rel)).toBe(`- [Depths in metres](${rel}) — ${desc}\n`);
  await pickBatch(batchOf(rel).key);
  await focusCard(rel);
  await win.keyboard.press("a");
  await expect.poll(() => fmLine(read(rel)!, "archived")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const day = fmLine(read(rel)!, "archived")!;
  // Only these lines change: the status tag in place; the description (copied from MEMORY.md), status_before and
  // archived appended (memory-ops.js retire). Nothing is deleted (D6).
  expect(read(rel)).toBe(pristine(rel)
    .replace("tags: [memory/user, status/active]\n", "tags: [memory/user, status/archived]\n")
    .replace("reviewed: false\n---", `reviewed: false\ndescription: ${desc}\nstatus_before: active\narchived: ${day}\n---`));
  await expect.poll(() => read("MEMORY.md")).toBe(pristine("MEMORY.md").replace(indexLine(rel), ""));
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path])).toEqual([["archived", rel]]);
  await expect(card(rel)).toHaveCount(0);
  await reviewSees(B().unreviewed.length - 1);
  await idle();

  // Library › Status: archived lists it beside the fixture's archived memory; Restore puts it back.
  await mode("library");
  await C().locator('.aos-lib-facets select[aria-label="Status"]').selectOption("archived");
  await expect(libRow(rel)).toHaveCount(1);
  await expect(libRow(B().archived[0])).toHaveCount(1);
  await libRow(rel).click();
  await expect(reader().locator("h2")).toHaveText("Depths in metres");
  await expect(reader().locator(".aos-lib-rtitle .aos-brain-pill")).toHaveText(`Archived ${shortDay(day, new Date())}`);
  await expect(reader().locator(".aos-lib-meta > span").nth(1)).toHaveText("status archived");
  await reader().locator('button[data-action="restore"]').click();
  // The status before and the index line come back; the description it was given stays (it is the memory's own now).
  await expect.poll(() => read(rel)).toBe(pristine(rel).replace("reviewed: false\n---", `reviewed: false\ndescription: ${desc}\n---`));
  await expect.poll(() => read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path])).toEqual([["archived", rel], ["restored", rel]]);
  await expect(reader().locator(".aos-lib-meta > span").nth(1)).toHaveText("status active");
  await expect(reader().locator('button[data-action="archive"]')).toHaveText("Archive");
  await expect(libRow(rel)).toHaveCount(0);   // the facet still reads archived; the reader keeps the one you chose
  await C().locator('.aos-lib-facets select[aria-label="Status"]').selectOption("live");
  await expect(libRow(rel)).toHaveCount(1);
});

test("P pins through set --expect (D17): pin: true, BRAIN.md rebuilt naming it under Critical rules; P again unpins and the file is as it was", async () => {
  const { win } = app();
  const rel = "brain/memory/reference/release-checklist.md";
  const b = batchOf(rel);
  const bullet = "- **Release checklist** — tag, build, smoke-test, publish";
  expect(read(BRAIN_MD)).not.toContain(bullet);
  let builtAt = hub().builtAt;
  await pickBatch(b.key);
  await focusCard(rel);
  await win.keyboard.press("p");
  await expect(card(rel).locator(".aos-brain-rv-pinned")).toHaveText("pinned");
  await expect(card(rel).locator('button[data-act="pin"]')).toHaveAttribute("aria-label", "Unpin (P)");
  await expect.poll(() => read(rel)).toBe(pristine(rel).replace("reviewed: false\n---", "reviewed: false\npin: true\n---"));
  await expect.poll(() => read(BRAIN_MD)).toContain(bullet);
  // build-brain-md writes BRAIN.md, then brain-sources.json: polled too, or a loaded machine reads it between the two.
  await expect.poll(() => readVaultJson<{ sections: { rules: { paths: string[] } } }>("brain/_index/brain-sources.json").sections.rules.paths).toContain(rel);
  // The verb is done once the page rebuilds the hub after it (one action at a time: P waits for the first).
  await hubRebuilt(builtAt);
  builtAt = hub().builtAt;
  await expect(card(rel)).toBeFocused();
  await win.keyboard.press("p");
  await expect(card(rel).locator('button[data-act="pin"]')).toHaveAttribute("aria-label", "Pin to BRAIN.md (P)");
  await expect.poll(() => read(rel)).toBe(pristine(rel));
  await expect.poll(() => read(BRAIN_MD)).not.toContain(bullet);
  await expect(card(rel).locator(".aos-brain-rv-pinned")).toHaveCount(0);
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path, r.fields])).toEqual([["set", rel, ["pin"]], ["set", rel, ["pin"]]]);
  // Still waiting for review: pinning is not keeping.
  expect(read(rel)).toContain("reviewed: false\n");
  await hubRebuilt(builtAt);
});

test("M › Keep the older one supersedes the newer (D7): status/superseded with superseded_by the older, its MEMORY.md line gone, and it leaves review", async () => {
  const { win } = app();
  const [newer, older] = B().duplicate;
  const b = byKeyOf(B().sessions.claude);
  await pickBatch(b.key);
  await focusCard(newer);
  await win.keyboard.press("m");
  const acts = card(newer).locator(".aos-brain-rv-cmpacts");
  await acts.locator("button", { hasText: "Keep the older one" }).click();
  await expect.poll(() => fmLine(read(newer)!, "superseded_by")).toBe(older);
  expect(read(newer)).toBe(pristine(newer)
    .replace("tags: [memory/feedback, status/active]\n", "tags: [memory/feedback, status/superseded]\n")
    .replace("reviewed: false\n---", `reviewed: false\ndescription: one reviewable change per sitting\nstatus_before: active\nsuperseded_by: ${older}\n---`));
  // The older one is not touched: it was never waiting for review.
  expect(read(older)).toBe(pristine(older));
  await expect.poll(() => read("MEMORY.md")).toBe(pristine("MEMORY.md").replace(indexLine(newer), ""));
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path, r.by])).toEqual([["superseded", newer, older]]);
  await expect(card(newer)).toHaveCount(0);
  await expect(batchRow(b.key).locator(".aos-brain-pill")).toHaveCount(0);
  await expect(batchRow(b.key).locator(".aos-brain-rv-rmeta > span:nth-child(2)")).toHaveText("2 new");
  await expect(queue("duplicates").locator(".aos-brain-chipn")).toHaveText("0");
  await reviewSees(B().unreviewed.length - 1);
  // Library shows where it went: Superseded by Prefer small diffs →.
  await mode("library");
  await C().locator('.aos-lib-facets select[aria-label="Status"]').selectOption("superseded");
  await libRow(newer).click();
  await expect(reader().locator("button.aos-lib-superby")).toHaveText("Superseded by Prefer small diffs →");
  await reader().locator("button.aos-lib-superby").click();
  await expect(reader().locator("h2")).toHaveText("Prefer small diffs");
  await C().locator('.aos-lib-facets select[aria-label="Status"]').selectOption("live");
  await idle();
});

test("M › Keep both: memory-notdup.json records the pair (D11), the new one is kept, and the flag goes from the page and the rebuilt hub", async () => {
  const { win } = app();
  const [newer, older] = B().duplicate;
  const builtAt = hub().builtAt;
  expect(read(NOTDUP)).toBeNull();
  await pickBatch(byKeyOf(B().sessions.claude).key);
  await focusCard(newer);
  await win.keyboard.press("m");
  await card(newer).locator(".aos-brain-rv-cmpacts button", { hasText: "Keep both" }).click();
  await expect.poll(() => read(NOTDUP)).toBe(`${JSON.stringify({ schema: 1, pairs: [[newer, older].sort()] }, null, 2)}\n`);
  await expect.poll(() => read(newer)).toBe(pristine(newer).replace("reviewed: false\n", "reviewed: true\n"));
  expect(read(older)).toBe(pristine(older));
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  await expect(card(newer)).toHaveCount(0);
  await expect(queue("duplicates").locator(".aos-brain-chipn")).toHaveText("0");
  await reviewSees(B().unreviewed.length - 1);
  // The scan's cache drops a pair the vault says is not one (brain-hub.js reads memory-notdup.json).
  await hubRebuilt(builtAt);
  await expect.poll(() => hub().dups).toEqual([]);
  await mode("library");
  await libRow(older).click();
  await expect(C().locator('aside.aos-lib-context section[data-section="nearby"] .aos-lib-cnote')).toHaveText("Nothing scores close to this one.");
});

test("Keep both's pair shows again once the files list it again, even when no rebuilt brain-hub.json dropped it in between: Health's badge counts it", async () => {
  const { win } = app();
  const [newer, older] = B().duplicate;
  // The rebuild the action starts waits until the files are put back, so no brain-hub.json without the pair is ever on
  // disk for the page to read (on a slow machine, the page's read of that one can land after the files are put back).
  const script = FX.v("brain/scripts/brain-hub.js");
  const gate = path.join(FX.root, "brain-hub.gate");
  const real = fs.readFileSync(script, "utf8");
  fs.rmSync(gate, { force: true });
  const gated = real.replace(/^'use strict';\n/, `'use strict';\n{ const s = new Int32Array(new SharedArrayBuffer(4)); for (const t = Date.now() + 20000; !require('fs').existsSync(${JSON.stringify(gate)}) && Date.now() < t;) Atomics.wait(s, 0, 0, 50); }\n`);
  expect(gated).not.toBe(real);
  fs.writeFileSync(script, gated);
  try {
    const builtAt = hub().builtAt;
    await pickBatch(byKeyOf(B().sessions.claude).key);
    await focusCard(newer);
    await win.keyboard.press("m");
    await card(newer).locator(".aos-brain-rv-cmpacts button", { hasText: "Keep both" }).click();
    await expect.poll(() => read(NOTDUP)).not.toBeNull();
    await expect.poll(() => read(newer)).toBe(pristine(newer).replace("reviewed: false\n", "reviewed: true\n"));
    await expect(queue("duplicates").locator(".aos-brain-chipn")).toHaveText("0");
    await reviewSees(B().unreviewed.length - 1);
    // The vault no longer says they are not duplicates (memory-notdup.json gone), and the memory waits for review again.
    for (const rel of [NOTDUP, newer]) restore(rel);
    await reviewSees(B().unreviewed.length);
    fs.writeFileSync(gate, "");
    await hubRebuilt(builtAt);
    await idle();
    expect(hub().dups.map((d) => [d.a, d.b].sort())).toEqual([[newer, older].sort()]);
  } finally {
    fs.writeFileSync(script, real);
    fs.rmSync(gate, { force: true });
  }
  await brain("health");
  await expect(modeTab("health").locator(".aos-brain-modebadge")).toHaveText(String(healthCount()));
  await expect(C().locator(".aos-brain-health .aos-brain-hl-pair")).toHaveAttribute("data-pair", [newer, older].sort().join("|"));
  await mode("review");
  await expect(queue("duplicates").locator(".aos-brain-chipn")).toHaveText("1");
});

test("a draft's Approve (Review) files it into brain/memory/feedback and the draft goes; Reject… (Library) asks first, then removes the draft and writes no memory", async () => {
  const { win } = app();
  const slug = B().drafts[0];
  const draft = `brain/memory/feedback/_drafts/${slug}.md`;
  const filed = `brain/memory/feedback/${slug}.md`;
  expect(read(filed)).toBeNull();
  await showQueue("drafts");
  await main().locator(`article.aos-brain-rv-draft[data-slug="${slug}"] button[data-act="approve"]`).click();
  await expect.poll(() => read(draft)).toBeNull();
  await expect.poll(() => read(filed)).not.toBeNull();
  // As lib/memory-writer.js files it: the draft's title, body and session, from the feedback loop, waiting for review.
  const text = read(filed)!;
  expect(text).toMatch(/^---\ntype: memory\ntags: \[memory\/feedback, status\/active\]\ncreated: \d{4}-\d{2}-\d{2}\nupdated: \d{4}-\d{2}-\d{2}\nsource: feedback-autoloop\nsession: [0-9a-f-]+\nreviewed: false\n---\n\n# Name layers after their data\n\nCall a chart layer by what it draws/);
  expect(fmLine(text, "session")).toBe(B().sessions.claude);
  await expect.poll(() => read("MEMORY.md")).toContain(`- [Name layers after their data](${filed}) — Name a chart layer after the data it draws, never after its file\n`);
  await expect(notices(win)).toContainText("Approved: “Name layers after their data” is a feedback memory now.");
  // The draft left behind after an earlier approval (Health's drafts fix) is the one that waits now.
  expect(B().drafts).toEqual([slug, B().leftover]);
  await expect(queue("drafts").locator(".aos-brain-chipn")).toHaveText("1");
  const left = main().locator(`article.aos-brain-rv-draft[data-slug="${B().leftover}"]`);
  await expect(main().locator("article.aos-brain-rv-draft")).toHaveCount(1);
  await expect(left).toHaveAttribute("aria-current", "true");
  // The approved draft took its Approve button with it: the keyboard lands on what the queue says now, not on the page.
  await expect.poll(() => win.evaluate(() => document.activeElement?.closest("article.aos-brain-rv-draft")?.getAttribute("data-slug") ?? null)).toBe(B().leftover);
  // Filed, the rule waits for review like any memory a session wrote.
  await reviewSees(B().unreviewed.length + 1);
  await idle();
  // Back to the fixture's draft, then Reject… from Library's reader.
  await resetBrain();
  await brain("library");
  await C().locator('.aos-lib-kinds button[data-kind="drafts"]').click();
  await expect(reader()).toHaveAttribute("data-path", draft);
  await reader().locator('button[data-action="reject"]').click();
  const confirm = win.locator(".modal", { hasText: "Reject “Name layers after their data”?" });
  await expect(confirm).toContainText("Removes this draft, and the rule is never drafted again. No memory changes.");
  await confirm.locator("button", { hasText: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  expect(read(draft)).toBe(pristine(draft));
  await reader().locator('button[data-action="reject"]').click();
  await confirm.locator("button", { hasText: /^Reject$/ }).click();
  await expect.poll(() => read(draft)).toBeNull();
  expect(read(filed)).toBeNull();
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  // feedback-drafts.js rejectDraft's trail row: the slug is never drafted again.
  await expect.poll(() => trailAdded().map((r) => [r.action, r.slug, r.type])).toEqual([["reverted", slug, "feedback"]]);
  // The other draft is what Library's Drafts shows now.
  await expect(reader()).toHaveAttribute("data-path", `brain/memory/feedback/_drafts/${B().leftover}.md`);
  await expect(C().locator(".aos-lib-list button.aos-lib-row")).toHaveCount(1);
  await C().locator('.aos-lib-kinds button[data-kind="memories"]').click();
});

test("Library's Set status → complete writes status/complete through set --expect, and BRAIN.md's Active context lets the project go", async () => {
  const rel = "brain/memory/projects/harbor-map.md";
  const sources = () => readVaultJson<{ sections: { active: { paths: string[] } } }>("brain/_index/brain-sources.json");
  expect(sources().sections.active.paths).toContain(rel);
  await mode("library");
  await libRow(rel).click();
  await expect(reader().locator("h2")).toHaveText("Harbor Map");
  await reader().locator('select[aria-label="Set status"]').selectOption("complete");
  await expect.poll(() => read(rel)).toBe(pristine(rel).replace("tags: [memory/projects, status/active]\n", "tags: [memory/projects, status/complete]\n"));
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path, r.fields])).toEqual([["set", rel, ["status"]]]);
  await expect.poll(() => sources().sections.active.paths).not.toContain(rel);
  await expect(reader().locator(".aos-lib-meta > span").nth(1)).toHaveText("status complete");
  await expect(reader().locator('select[aria-label="Set status"]')).toHaveValue("complete");
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  await idle();
});

test("Mark everything before <day> reviewed keeps exactly the memories written before that day, and nothing else changes", async () => {
  const { win } = app();
  const [datum] = B().older;
  await win.locator("button.aos-brain-rv-markbtn").click();
  const modal = win.locator(".modal", { has: win.locator(".aos-brain-markmodal") });
  await modal.locator("button.aos-brain-markok", { hasText: "Mark 1 reviewed" }).click();
  await expect(modal).toHaveCount(0);
  await expect.poll(() => read(datum)).toBe(pristine(datum).replace("reviewed: false\n", "reviewed: true\n"));
  const want = pristineTree();
  want[datum] = read(datum)!;
  expect(memoryTree()).toEqual(want);
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path])).toEqual([["kept", datum]]);
  await expect(notices(win)).toContainText("Marked 1 memory reviewed.");
  await expect(queue("older").locator(".aos-brain-chipn")).toHaveText("0");
  // Nothing written before that day is left, so the button goes.
  await expect(win.locator("button.aos-brain-rv-markbtn")).toHaveCount(0);
  await reviewSees(B().unreviewed.length - 1);
  await idle();
});

test("a memory changed on disk after the page read it is refused on P (set --expect): the Notice says so, and the file keeps the outside change", async () => {
  const h = app();
  const { win } = h;
  const rel = "brain/memory/reference/release-checklist.md";
  await pickBatch(batchOf(rel).key);
  await focusCard(rel);
  // The page reads a file again a moment after the vault reports a change; hold that read, so P runs on what the page
  // read before the change, as it would between an outside write and the next read.
  const hold = (on: boolean) => win.evaluate((stop) => {
    const tab = (window as unknown as { aosHost: { app: { workspace: { getLeavesOfType(t: string): Array<{ view: { getTab(id: string): Record<string, unknown> } }> } } } })
      .aosHost.app.workspace.getLeavesOfType("agentic-os-workbench")[0].view.getTab("memory");
    if (stop) tab.schedule = () => undefined;
    else { delete tab.schedule; (tab as unknown as { schedule(ms: number): void }).schedule(0); }
  }, on);
  const outside = pristine(rel).replace("then publish the notes.", "then publish the notes and the release page.");
  await hold(true);
  try {
    fs.writeFileSync(FX.v(rel), outside);
    const n = h.notices.length;
    await win.keyboard.press("p");
    await expect.poll(() => h.notices.slice(n)).toEqual([`Pin: ${rel} changed since it was read: read it again`]);
    await expect(card(rel).locator('button[data-act="pin"]')).toHaveAttribute("aria-label", "Pin to BRAIN.md (P)");
    await expect(card(rel).locator(".aos-brain-rv-pinned")).toHaveCount(0);
  } finally {
    await hold(false);
  }
  expect(read(rel)).toBe(outside);
  expect(read(TRAIL)).toBe(pristine(TRAIL));
  expect(read(BRAIN_MD)).toBe(pristine(BRAIN_MD));
  // Read again, P works on the file as it is now.
  await expect(card(rel)).toBeVisible();
});

// ── Bootstrap (D17, D18) ─────────────────────────────────────────────

const bs = () => C().locator(".aos-brain-bootstrap");
const bsSec = (k: string) => bs().locator(`section[data-section="${k}"]`);
const sources = () => readVaultJson<ExpectedSources>("brain/_index/brain-sources.json");
/** The file's H1 (BRAIN.md and the hub title a memory by it). */
const titleOf = (rel: string): string => /^#[ \t]+(.+?)[ \t]*$/m.exec((read(rel) ?? pristine(rel)).replace(/^---\n[\s\S]*?\n---\n/, ""))![1];

test("Bootstrap's Unpin (D17): set --expect with the hash the page read takes pin: true off the rule and nothing else, BRAIN.md's Critical rules let it go, a set row; the row leaves", async () => {
  const rel = B().pinned;
  expect(sources().sections.rules.paths).toContain(rel);
  expect(read(BRAIN_MD)).toContain(`- **${titleOf(rel)}** —`);
  await brain("bootstrap");
  const row = bsSec("rules").locator(`.aos-brain-bs-row[data-path="${rel}"]`);
  await row.locator('button[data-act="unpin"]').click();
  await expect.poll(() => read(rel)).toBe(pristine(rel).replace("pin: true\n", ""));
  await expect.poll(() => sources().sections.rules.paths).not.toContain(rel);
  expect(read(BRAIN_MD)).not.toContain(`- **${titleOf(rel)}** —`);
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path, r.fields])).toEqual([["set", rel, ["pin"]]]);
  await expect(row).toHaveCount(0);
  await expect(bsSec("rules").locator(".aos-brain-bs-row")).toHaveCount(B().sources.sections.rules.paths.length - 1);
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  await idle();
});

test("Bootstrap's Mark complete on one project: status/complete through set --expect, BRAIN.md rebuilt without it and the room it freed goes to the projects left out; a set row", async () => {
  const rel = B().merged;
  const before = B().sources.sections.active;
  expect(before.paths).toContain(rel);
  await brain("bootstrap");
  const row = bsSec("active").locator(`.aos-brain-bs-row[data-path="${rel}"]`);
  await expect(row.locator('button[data-act="complete"]')).toHaveAttribute("aria-label", `Mark complete: ${titleOf(rel)}`);
  await row.locator('button[data-act="complete"]').click();
  await expect.poll(() => read(rel)).toBe(pristine(rel).replace("tags: [memory/projects, status/active]\n", "tags: [memory/projects, status/complete]\n"));
  await expect.poll(() => sources().sections.active.paths).not.toContain(rel);
  // Every other active project is still there, shown or left out (one fewer line leaves more room).
  const after = sources().sections.active;
  expect([...after.paths, ...after.omitted].sort()).toEqual([...before.paths, ...before.omitted].filter((p) => p !== rel).sort());
  expect(after.omitted.length).toBeLessThanOrEqual(before.omitted.length);
  expect(read(BRAIN_MD)).not.toContain(`- **${titleOf(rel)}** —`);
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path, r.fields])).toEqual([["set", rel, ["status"]]]);
  await expect(row).toHaveCount(0);
  await expect(bsSec("active").locator(".aos-brain-bs-row")).toHaveCount(after.paths.length);
  await idle();
});

test("Mark the 2 complete… asks first, then marks each project that looks shipped complete in turn (set --expect), says so, and BRAIN.md and the lede let them go", async () => {
  const { win } = app();
  const shipped = [B().shipped.released, B().shipped.version];
  await brain("bootstrap");
  await bsSec("active").locator('button[data-act="complete-shipped"]').click();
  const modal = win.locator(".modal", { hasText: "Mark 2 projects complete?" });
  await modal.locator("button", { hasText: "Mark 2 complete" }).click();
  await expect(modal).toHaveCount(0);
  for (const p of shipped) await expect.poll(() => read(p)).toBe(pristine(p).replace("tags: [memory/projects, status/active]\n", "tags: [memory/projects, status/complete]\n"));
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path, r.fields])).toEqual(shipped.map((p) => ["set", p, ["status"]]));
  await expect(notices(win)).toContainText("Marked 2 projects complete.");
  await expect.poll(() => { const a = sources().sections.active; return [...a.paths, ...a.omitted].filter((p) => shipped.includes(p)); }).toEqual([]);
  for (const p of shipped) expect(read(BRAIN_MD)).not.toContain(`- **${titleOf(p)}** —`);
  // Nothing looks shipped any more: no lede, no filter, every row back.
  await expect(bs().locator('[data-bs="lede"]')).toHaveCount(0);
  await expect(bsSec("active").locator('button[data-filter="shipped"]')).toHaveCount(0);
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  await idle();
});

const WAKE = "brain/_index/recall-wake.md";
/** The recall preview may write none of these (D9, D18): recall's index and wake file, the usage log and its rollup. */
const RECALL_FILES = ["brain/_index/recall-index.json", WAKE, "brain/_index/memory-usage.jsonl", "brain/_index/memory-usage-rollup.json", "brain/_index/embed-index.json"];
const snapshot = (rels: readonly string[]): Record<string, string | null> => Object.fromEntries(rels.map((r) => [r, read(r)]));
/** brainBootstrap.ts scoreText: three significant figures. */
const scoreText = (n: number): string => String(Number(n.toPrecision(3)));

test("the recall preview runs recall-cli.js on the typed text (D18): the hits as the runtime ranks them, each with its title, kind, score, age and stale; nothing is written, no usage row either (D9); a prompt nothing matches says so; a memory opens in Library", async () => {
  const h = app();
  const q = B().recall.hit;
  const want = B().recallHits[q];
  expect(want.length).toBeGreaterThan(2);
  expect(want.some((x) => x.stale)).toBe(true);
  await brain("bootstrap");
  const card = bs().locator('[data-bs="recall"]');
  const input = card.getByRole("textbox", { name: "Prompt to preview" });
  const out = card.locator(".aos-brain-bs-hits");
  const before = { files: snapshot([...RECALL_FILES, ...INDEX_FILES, "MEMORY.md"]), tree: memoryTree() };
  await input.fill(q);
  await input.press("Enter");
  await expect(out).toHaveAttribute("data-state", "results");
  await expect(out).toHaveAttribute("aria-busy", "false");
  await expect(out.locator("ol.aos-brain-bs-hitlist")).toHaveAttribute("aria-label", `Recall for “${q}”`);
  const hits = out.locator("ol.aos-brain-bs-hitlist > li > .aos-brain-bs-hit");
  expect(await hits.evaluateAll((els) => els.map((e) => e.getAttribute("data-path")))).toEqual(want.map((x) => x.path));
  // As the page names each: a memory by its title and type, a pattern, a daily note, or another note by its file name.
  const kindOf = (p: string): { title: string; kind: string } => {
    const m = /^brain\/memory\/(user|feedback|projects|reference)\/([a-z0-9][a-z0-9.-]*)\.md$/.exec(p);
    if (m) return { title: titleOf(p), kind: m[1] };
    const name = path.basename(p, ".md");
    return { title: name, kind: p.startsWith("brain/patterns/") ? "pattern" : /^\d{4}-\d{2}-\d{2}$/.test(name) ? "daily note" : "note" };
  };
  const age = (flag: string) => /(\d+d)\s*$/.exec(flag)?.[1] ?? "";
  await expect(hits.locator(".aos-brain-bs-htitle")).toHaveText(want.map((x) => kindOf(x.path).title));
  await expect(hits.locator(".aos-brain-bs-hkind")).toHaveText(want.map((x) => kindOf(x.path).kind));
  await expect(hits.locator(".aos-brain-bs-score")).toHaveText(want.map((x) => scoreText(x.score)));
  await expect(hits.locator(".aos-brain-bs-age")).toHaveText(want.map((x) => age(x.flag)));
  expect(await hits.evaluateAll((els) => els.map((e) => e.querySelector(".aos-brain-pill")?.textContent ?? ""))).toEqual(want.map((x) => (x.stale ? "stale" : "")));
  expect(await hits.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(want.map((x) => {
    const k = kindOf(x.path);
    const where = /^brain\/memory\/[a-z]+\/[a-z0-9]/.test(x.path) ? "open in Library" : "open in the editor";
    return `${k.title}, ${k.kind}, score ${scoreText(x.score)}${age(x.flag) ? `, ${age(x.flag)} old` : ""}${x.stale ? ", stale" : ""}: ${where}`;
  }));
  // It wrote nothing: not recall's index or recall-wake.md, not a usage row (the preview is not a session), no memory.
  expect(snapshot([...RECALL_FILES, ...INDEX_FILES, "MEMORY.md"])).toEqual(before.files);
  expect(memoryTree()).toEqual(before.tree);
  // A prompt nothing in the store matches.
  await input.fill(B().recall.none);
  await card.locator('button[data-act="recall"]').click();
  await expect(out).toHaveAttribute("data-state", "empty");
  await expect(out).toHaveText(`Nothing recalled for “${B().recall.none}”.`);
  expect(B().recallHits[B().recall.none]).toEqual([]);
  // Back to the hits; the stale memory opens in Library, selected.
  await input.fill(q);
  await input.press("Enter");
  await expect(out).toHaveAttribute("data-state", "results");
  const stale = want.find((x) => x.stale)!.path;
  await out.locator(`.aos-brain-bs-hit[data-path="${stale}"]`).click();
  await expect(modeTab("library")).toHaveAttribute("aria-selected", "true");
  await expect(libRow(stale)).toHaveAttribute("aria-selected", "true");
  await expect(reader().locator("h2")).toHaveText(titleOf(stale));
  expect(snapshot([...RECALL_FILES, ...INDEX_FILES, "MEMORY.md"])).toEqual(before.files);
  expect((await h.guard()).filter((e) => e.kind === "spawn")).toEqual([]);
});

// ── Health's fixes (D20, spec §6) ────────────────────────────────────

type FixKind = "sources" | "types" | "descriptions" | "index" | "drafts";
const fixBtn = (k: FixKind) => C().locator(`.aos-brain-health [data-hl-key="fix:${k}"]`);
const hygRow = (k: FixKind) => C().locator(`.aos-brain-health .aos-brain-hl-hyg[data-fix="${k}"]`);
const fixModal = (win: Page) => win.locator(".modal.mod-brain-fix .aos-brain-fixmodal");
/** The file a change writes: MEMORY.md for an index change, else its own path (brainHealth.ts changeFile). */
const fileOf = (c: ExpectedFixChange): string => (c.action.startsWith("index-") ? "MEMORY.md" : c.path);
const LABEL: Record<FixKind, string> = { sources: "Normalise source labels", types: "Fix old types", descriptions: "Copy descriptions", index: "Fix MEMORY.md", drafts: "Remove leftover drafts" };
const ROW_LABEL: Record<string, string> = {
  source: "source", type: "type", tags: "tags", description: "description", "index-add": "add line", "index-move": "move line", "index-remove": "remove line", "draft-remove": "remove draft",
};
/** A change's label in FixModal: an index line out says why (brainHealth.ts REMOVE_WHY). */
const REMOVE_WHY: Record<string, string> = { missing: "missing file", retired: "archived or superseded", duplicate: "second copy" };
const rowLabel = (c: ExpectedFixChange): string => (c.action === "index-remove" && c.reason ? `${ROW_LABEL[c.action]} · ${REMOVE_WHY[c.reason]}` : ROW_LABEL[c.action]);
/** "projects/alpha.md", "_drafts/beta.md", "MEMORY.md": a file as the Notice names it (brainHealth.ts shortFile). */
const shortFile = (p: string): string => p.replace(/^brain\/memory\/feedback\/_drafts\//, "_drafts/").replace(/^brain\/memory\//, "");
/** Health's badge as the rebuilt brain-hub.json gives it: the duplicate pairs and every hygiene finding a fix takes, but
 *  descriptions only MEMORY.md has (listed in Hygiene, never badged: every new memory starts that way). */
const healthCount = (): number => {
  const hb = readVaultJson<{ dups: unknown[]; hygiene: ExpectedBrain["hygiene"] }>(HUB);
  const y = hb.hygiene;
  return hb.dups.length + (y.sources.session ?? 0) + (y.sources["in-session"] ?? 0) + (y.sources.wrap ?? 0) + y.oldType.length
    + y.unindexed.length + y.misfiled.length + y.brokenIndex.length + y.leftoverDrafts.length;
};
/** Lines removed from and added to a file since the fixture (a multiset difference: a line that only moved is in neither). */
function lineDiff(rel: string): { removed: string[]; added: string[] } {
  const left = new Map<string, number>();
  for (const l of (fs.existsSync(pristinePath(rel)) ? pristine(rel) : "").split("\n")) left.set(l, (left.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of (read(rel) ?? "").split("\n")) { const n = left.get(l) ?? 0; if (n) left.set(l, n - 1); else added.push(l); }
  return { removed: [...left].flatMap(([l, n]) => Array<string>(n).fill(l)).filter((l) => l !== ""), added };
}
/** A frontmatter value as YAML reads it: a double-quoted one unquoted (memory-ops yamlValue quotes only when needed). */
const yamlText = (v: string): string => (v.startsWith('"') ? (JSON.parse(v) as string) : v);
/** `aos memory fix <kind> --dry-run --json` run as a user would in a terminal, from either host's session. */
const fixDryRun = (kind: FixKind): ExpectedFix => {
  const r = spawnSync("/bin/sh", [FX.v("brain/scripts/bin/aos"), "memory", "fix", kind, "--dry-run", "--json"], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`aos memory fix ${kind} --dry-run exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as ExpectedFix;
};

/**
 * One fix through Health, as a person runs it: the button's dry run (it writes nothing) listed in FixModal, then its
 * confirm. Checks the dialog against the runtime's own dry run, the files against exactly those changes (every other
 * memory, draft and MEMORY.md byte for byte), one `fixed` trail row per changed memory or draft (and one MEMORY.md row per
 * memory whose lines go) with each field's before and after, the Notice, the row and the tab's badge after the rebuild,
 * and a second dry run that finds nothing. `cancelFirst` opens the dialog once and cancels it first, which must write
 * nothing.
 */
async function runFix(kind: FixKind, button: string, confirm: string, check: (dry: ExpectedFix) => void, { cancelFirst = false } = {}): Promise<void> {
  const { win } = app();
  const dry = B().fixes[kind];
  expect(dry.changes.length).toBeGreaterThan(0);
  const files = [...new Set(dry.changes.map(fileOf))];
  await brain("health");
  const badgeWas = Number(await modeTab("health").locator(".aos-brain-modebadge").textContent());
  const builtAt = hub().builtAt;
  await expect(fixBtn(kind)).toHaveText(button);
  for (let round = 0; round < (cancelFirst ? 2 : 1); round++) {
    await fixBtn(kind).click();
    const modal = fixModal(win);
    await expect(modal).toHaveAttribute("data-fix", kind);
    // While its dialog is open the button says so, and every fix button waits.
    await expect(fixBtn(kind)).toHaveText("Checking…");
    await expect(fixBtn(kind)).toHaveAttribute("aria-busy", "true");
    await expect(C().locator('.aos-brain-health [data-act="fix"]:not([aria-disabled="true"])')).toHaveCount(0);
    await expect(modal.locator(".aos-brain-fixcount")).toHaveText(`${pl(dry.changes.length, "change")} in ${pl(files.length, "file")}`);
    expect(await modal.locator(".aos-brain-fixfile").evaluateAll((els) => els.map((e) => e.getAttribute("data-file")))).toEqual(files);
    const rows = modal.locator(".aos-brain-fixrow");
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-action")))).toEqual(dry.changes.map((c) => c.action));
    await expect(rows.locator(".aos-brain-fixlabel")).toHaveText(dry.changes.map(rowLabel));
    for (const [i, c] of dry.changes.entries()) {
      if (c.before !== null) await expect(rows.nth(i).locator(".aos-brain-fixbefore")).toHaveText(c.before);
      if (c.after !== null) await expect(rows.nth(i).locator(".aos-brain-fixafter")).toHaveText(c.after);
    }
    await expect(modal.locator(".aos-brain-fixmore")).toHaveCount(0);
    await expect(modal.locator(".aos-brain-fixnote")).toHaveText(`There is no undo: each change goes into the trail with its before and after.${kind === "types" || kind === "index" ? " BRAIN.md is rebuilt after." : ""}`);
    await expect(modal.locator("button")).toHaveText(["Cancel", confirm]);
    await expect(modal.locator(".aos-brain-fixcancel")).toBeFocused();
    // The dry run wrote nothing.
    expect(memoryTree()).toEqual(pristineTree());
    expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));
    expect(trailAdded()).toEqual([]);
    if (cancelFirst && round === 0) {
      await modal.locator(".aos-brain-fixcancel").click();
      await expect(modal).toHaveCount(0);
      await expect(fixBtn(kind)).toHaveText(button);
      await expect(fixBtn(kind)).toBeFocused();
      continue;
    }
    await modal.locator(".aos-brain-fixok").click();
    await expect(modal).toHaveCount(0);
  }
  // The files change exactly as the dry run listed, and nothing else in the store does.
  await expect.poll(() => trailAdded().length).toBeGreaterThan(0);
  for (const f of files) await expect.poll(() => read(f) !== (fs.existsSync(pristinePath(f)) ? pristine(f) : null)).toBe(true);
  check(dry);
  const others = Object.fromEntries(Object.entries(pristineTree()).filter(([r]) => !files.includes(r)));
  expect(Object.fromEntries(Object.entries(memoryTree()).filter(([r]) => !files.includes(r)))).toEqual(others);
  if (!files.includes("MEMORY.md")) expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  // One `fixed` row per memory or draft (an index line out is MEMORY.md's own row), each field with its before and after.
  const byPath = new Map<string, ExpectedFixChange[]>();
  for (const c of dry.changes) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
  await expect.poll(() => trailAdded().length).toBe(byPath.size);
  const rows = trailAdded().map((r) => ({ action: r.action, kind: r.kind, path: r.path, changes: r.changes }));
  expect(rows.sort((a, b) => String(a.path).localeCompare(String(b.path)))).toEqual([...byPath].sort(([a], [b]) => a.localeCompare(b)).map(([p, cs]) => ({
    action: "fixed", kind, path: p, changes: cs.map((c) => ({ field: c.action, before: c.before, after: c.after, ...(c.reason ? { reason: c.reason } : {}) })),
  })));
  // The Notice names the files; the cache is rebuilt from them, so the row reads clean and the badge drops.
  const names = files.slice(0, 3).map(shortFile);
  const named = files.length > 3 ? `${names.join(", ")} and ${files.length - 3} more` : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  await expect(notices(win)).toContainText(`${LABEL[kind]}: changed ${pl(dry.files, "file")} (${named}).`);
  await hubRebuilt(builtAt);
  await expect(hygRow(kind)).toHaveAttribute("data-count", "0");
  await expect(hygRow(kind)).toHaveClass(/is-clean/);
  await expect(hygRow(kind).locator(".aos-brain-hl-clean")).toHaveText("clean");
  await expect(fixBtn(kind)).toHaveCount(0);
  await expect(modeTab("health").locator(".aos-brain-modebadge")).toHaveText(String(healthCount()));
  // Descriptions only MEMORY.md has are listed, never badged (healthCount): that fix leaves the badge as it was.
  if (kind === "descriptions") expect(healthCount()).toBe(badgeWas);
  else expect(healthCount()).toBeLessThan(badgeWas);
  // Run again, from a terminal or a session on either host: nothing left to do.
  expect(fixDryRun(kind).changes).toEqual([]);
  await idle();
}

test("fix sources: the dry run lists each old label in FixModal; confirmed, source: manual-wrap replaces it and nothing else, a fixed row per memory, the row clean and the badge down", async () => {
  const legacy = Object.entries(B().legacy).map(([label, rel]) => ({ label, rel }));
  await runFix("sources", "Normalise 2…", "Normalise 2", (dry) => {
    expect(dry.changes.map((c) => [c.path, c.before, c.after]).sort()).toEqual(legacy.map((x) => [x.rel, x.label, "manual-wrap"]).sort());
    for (const x of legacy) expect(lineDiff(x.rel)).toEqual({ removed: [`source: ${x.label}`], added: ["source: manual-wrap"] });
  });
});

test("fix types: a host's auto-memory shape gets type: memory and the tag its folder means, name and description kept; BRAIN.md rebuilt", async () => {
  await runFix("types", "Fix 1…", "Fix 1", (dry) => {
    expect(dry.changes).toEqual([
      { path: B().oldType, action: "type", before: "reference", after: "memory" },
      { path: B().oldType, action: "tags", before: null, after: "[memory/reference]" },
    ]);
    expect(lineDiff(B().oldType)).toEqual({ removed: ["type: reference"], added: ["type: memory", "tags: [memory/reference]"] });
    expect(read(B().oldType)).toContain("name: Navigation light colours\ndescription: red to port, green to starboard, white masthead\ntype: memory\ntags: [memory/reference]\n---");
  });
  expect(read(BRAIN_MD)).not.toBe(pristine(BRAIN_MD));
});

test("fix descriptions: Cancel on FixModal writes nothing; confirmed, each memory gets its MEMORY.md line's description as one line of its own (quoted only where YAML needs it)", async () => {
  await runFix("descriptions", "Copy from MEMORY.md…", `Copy ${B().fixes.descriptions.files}`, (dry) => {
    expect(dry.changes.map((c) => c.path).sort()).toEqual([...B().hygiene.noDescription].sort());
    for (const c of dry.changes) {
      expect(c.after).toBe(indexDesc(c.path));
      const d = lineDiff(c.path);
      expect(d.removed).toEqual([]);
      expect(d.added).toHaveLength(1);
      expect(d.added[0]).toMatch(/^description: /);
      expect(yamlText(d.added[0].slice("description: ".length))).toBe(c.after);
    }
  }, { cancelFirst: true });
});

test("fix index: one MEMORY.md write removes the line to a missing file, moves the misfiled line under its type's heading and adds the missing one; BRAIN.md rebuilt", async () => {
  await runFix("index", "Fix 3…", "Fix MEMORY.md", (dry) => {
    const broken = pristine("MEMORY.md").split("\n").find((l) => l.includes(`](${B().broken})`))!;
    const added = dry.changes.find((c) => c.action === "index-add")!;
    expect(dry.changes).toEqual([
      { path: "MEMORY.md", action: "index-remove", before: broken, after: null, reason: "missing" },
      { path: B().misfiled, action: "index-move", before: "Reference", after: "Feedback (how to work)" },
      { path: B().unindexed, action: "index-add", before: null, after: added.after },
    ]);
    expect(added.after).toMatch(new RegExp(`^- \\[${titleOf(B().unindexed)}\\]\\(${B().unindexed.replace(/\./g, "\\.")}\\) — \\S`));
    // The moved line keeps its text; only the broken one goes and the missing one comes.
    expect(lineDiff("MEMORY.md")).toEqual({ removed: [broken], added: [added.after!] });
    const headingOf = (rel: string): string | null => {
      let h: string | null = null;
      for (const l of read("MEMORY.md")!.split("\n")) { if (l.startsWith("## ")) h = l.slice(3); else if (l.includes(`](${rel})`)) return h; }
      return null;
    };
    expect(headingOf(B().misfiled)).toBe("Feedback (how to work)");
    expect(headingOf(B().unindexed)).toBe("Reference");
    expect(fs.existsSync(FX.v(B().broken))).toBe(false);
  });
});

test("fix drafts: the approved draft left in feedback/_drafts goes (spec §6's one delete), its live rule untouched; the Duplicates card's draft row goes with it", async () => {
  const draft = `brain/memory/feedback/_drafts/${B().leftover}.md`;
  await runFix("drafts", "Remove the draft…", "Remove 1", (dry) => {
    expect(dry.changes).toEqual([{ path: draft, action: "draft-remove", before: titleOf(B().pinned), after: null }]);
    expect(read(draft)).toBeNull();
    expect(read(B().pinned)).toBe(pristine(B().pinned));
  });
  await expect(C().locator(".aos-brain-health .aos-brain-hl-draft")).toHaveCount(0);
  // The trail row carries the rule's slug, so Library's History of the live rule shows it as "fixed (drafts)".
  expect(trailAdded()[0]).toMatchObject({ slug: B().leftover, type: "feedback", kind: "drafts" });
});

test("a fix whose files change while its dialog is open (another session's write) changes nothing: the runtime refuses the preview's hash, the Notice says so, Health rescans", async () => {
  const { win } = app();
  const late = "brain/memory/feedback/written-meanwhile.md";
  await brain("health");
  await expect(fixBtn("sources")).toHaveText("Normalise 2…");
  await fixBtn("sources").click();
  const modal = fixModal(win);
  await expect(modal.locator(".aos-brain-fixok")).toHaveText("Normalise 2");
  // FixModal is announced as a dialog named by its title and described by what it changes and the no-undo note.
  const frame = win.locator(".modal.mod-brain-fix");
  await expect(frame).toHaveAttribute("role", "alertdialog");
  await expect(frame).toHaveAttribute("aria-modal", "true");
  const titleId = await frame.getAttribute("aria-labelledby");
  await expect(frame.locator(`[id="${titleId}"]`)).toHaveText("Normalise source labels?");
  const [ledeId, noteId] = (await frame.getAttribute("aria-describedby"))!.split(" ");
  await expect(frame.locator(`[id="${ledeId}"]`)).toHaveClass(/aos-brain-fixlede/);
  await expect(frame.locator(`[id="${noteId}"]`)).toHaveClass(/aos-brain-fixnote/);
  // While the dialog is open, a session writes one more memory under an old label.
  fs.writeFileSync(FX.v(late), "---\ntype: memory\ntags: [memory/feedback, status/active]\ncreated: 2026-10-11\nsource: session\nreviewed: true\n---\n\n# Written meanwhile\n\nA rule a session wrote while the dialog was open.\n");
  const tree = memoryTree();
  await modal.locator(".aos-brain-fixok").click();
  await expect(notices(win)).toContainText("Normalise source labels: the files changed since it was read");
  // Nothing was fixed: not the two the dialog listed, not the one written meanwhile; no trail row.
  expect(memoryTree()).toEqual(tree);
  expect(trailAdded()).toEqual([]);
  await idle();
});

test("a fix whose dry run finds nothing (brain-hub.json behind the files): no dialog, the Notice says so, and the rescan it starts brings the row to clean", async () => {
  const h = app();
  const { win } = h;
  // The files fixed from a terminal (aos memory fix sources) while the hub's cache still lists them.
  const r = spawnSync("/bin/sh", [FX.v("brain/scripts/bin/aos"), "memory", "fix", "sources", "--json"], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(read(HUB)).toBe(pristine(HUB));
  await brain("health");
  await expect(fixBtn("sources")).toHaveText("Normalise 2…");
  const builtAt = hub().builtAt;
  const n = h.notices.length;
  await fixBtn("sources").click();
  await expect.poll(() => h.notices.slice(n)).toEqual(["Normalise source labels: nothing to fix. brain-hub.json was behind the files; rescanning in the background."]);
  await expect(fixModal(win)).toHaveCount(0);
  await hubRebuilt(builtAt);
  await expect(hygRow("sources")).toHaveAttribute("data-count", "0");
  await expect(hygRow("sources")).toHaveClass(/is-clean/);
  await idle();
});

// ── Health: Not duplicates, Archive the N shipped… ──────────────────

test("Health's Not duplicates records the pair in memory-notdup.json (D11): the row leaves once that is saved, and after the rebuild the tile reads none found and Review's Duplicates queue is empty", async () => {
  const [newer, older] = B().duplicate;
  const builtAt = hub().builtAt;
  await brain("health");
  // M › Keep both dismissed this pair on this page earlier; the files put back list it again, so it shows again (the page
  // hides a pair as memory-notdup.json says, not by what it dismissed).
  const pair = C().locator(".aos-brain-health .aos-brain-hl-pair");
  await expect(pair).toHaveAttribute("data-pair", [newer, older].sort().join("|"));
  await pair.locator('button[data-act="notdup"]').click();
  await expect.poll(() => read(NOTDUP)).toBe(`${JSON.stringify({ schema: 1, pairs: [[newer, older].sort()] }, null, 2)}\n`);
  await expect(pair).toHaveCount(0);
  expect(read(newer)).toBe(pristine(newer));
  expect(read(older)).toBe(pristine(older));
  await hubRebuilt(builtAt);
  await expect.poll(() => hub().dups).toEqual([]);
  const t = C().locator('.aos-brain-health [data-tile="duplicates"]');
  await expect(t.locator(".aos-brain-hl-tv")).toHaveText("0");
  await expect(t.locator(".aos-brain-hl-tw")).toHaveText("none found");
  await expect(t).toHaveAttribute("data-tone", "ok");
  await mode("review");
  await expect(queue("duplicates").locator(".aos-brain-chipn")).toHaveText("0");
  await idle();
});

test("Archive the 1 shipped… (Dead weight) asks first, then archives the never-used project that looks shipped as A does (D5): status/archived, its MEMORY.md line gone, an archived row; the Notice names the way back", async () => {
  const { win } = app();
  const rel = B().shipped.version;
  expect(B().usage.never).toContain(rel);
  const line = new RegExp(`^- \\[[^\\]]*\\]\\(${rel.replace(/[.]/g, "\\.")}\\) — (.*)\\n`, "m").exec(pristine("MEMORY.md"))!;
  await brain("health");
  await C().locator('.aos-brain-health [data-hl-key="dw:archive"]').click();
  const modal = win.locator(".modal", { hasText: "Archive 1 shipped project?" });
  await modal.locator("button", { hasText: "Archive 1" }).click();
  await expect.poll(() => fmLine(read(rel) ?? "", "archived")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const day = fmLine(read(rel)!, "archived")!;
  expect(read(rel)).toBe(pristine(rel)
    .replace("tags: [memory/projects, status/active]\n", "tags: [memory/projects, status/archived]\n")
    .replace(/\n---\n/, `\ndescription: ${line[1]}\nstatus_before: active\narchived: ${day}\n---\n`));
  await expect.poll(() => read("MEMORY.md")).toBe(pristine("MEMORY.md").replace(line[0], ""));
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path])).toEqual([["archived", rel]]);
  await expect(notices(win)).toContainText("Archived 1 project note. Restore in Library puts each one back.");
  await idle();
});

// ── helpers that read the fixture ────────────────────────────────────

function byKeyOf(key: string) { return B().batches.find((b) => b.key === key)!; }
/** A frontmatter key's value, or null. */
function fmLine(text: string, key: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const m = fm ? new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(fm[1]) : null;
  return m ? m[1] : null;
}
