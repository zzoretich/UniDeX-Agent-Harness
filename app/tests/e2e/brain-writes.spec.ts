// Brain with its write surface on (AOS_APP_WRITE=brain; spec 2026-10-11-brain-hub D13, D14): every action is one
// `aos memory` verb the brain surface admits, run by the vault's own runtime (lib/memory-ops.js), and the page writes no
// file itself. Review's K (one memory), ⇧K (the batch's new ones, never the flagged one), A (archive, D5) and P (pin and
// unpin, with BRAIN.md rebuilt), M's Keep the older one (supersede, D7) and Keep both (not duplicates, D11), a draft's
// Approve (Review) and Reject… (Library, after asking), Library's Set status and Restore, and Mark everything before
// (D3); a memory changed on disk after the page read it is refused (`set --expect`, D17); brain-hub.json follows an
// action. Each test checks what the runtime left on disk against the fixture's pristine copy, and puts back what it
// changed, so the tests stay independent.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { FX, closeNotes, content, expected, guardWrites, openTab, readVaultJson, useApp } from "./harness";
import { shortDay } from "../../../obsidian-plugin/src/data/brainModel";

const app = useApp({ env: { AOS_APP_WRITE: "brain" } });
const C = () => content(app().win);
const B = () => expected().brain;

// ── the files ────────────────────────────────────────────────────────

const TRAIL = "brain/_index/promote-log.jsonl";
const HUB = "brain/_index/brain-hub.json";
const NOTDUP = "brain/_index/memory-notdup.json";
const BRAIN_MD = "brain/_index/BRAIN.md";
const read = (rel: string): string | null => (fs.existsSync(FX.v(rel)) ? fs.readFileSync(FX.v(rel), "utf8") : null);
const pristinePath = (rel: string) => path.join(FX.pristine, "vault", rel);
const pristine = (rel: string): string => fs.readFileSync(pristinePath(rel), "utf8");
/** The trail rows appended since the fixture was made. */
const trailAdded = (): Array<Record<string, unknown>> => read(TRAIL)!.slice(pristine(TRAIL).length).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const hub = () => readVaultJson<{ builtAt: string; batches: Array<{ key: string; paths: string[] }>; dups: Array<{ a: string; b: string }> }>(HUB);
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
 *  the hub's caches and the feedback metrics. */
const INDEX_FILES = [TRAIL, HUB, NOTDUP, BRAIN_MD, "brain/_index/brain-sources.json", "brain/_index/feedback-metrics.jsonl",
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
});

test("Brain is the one surface on: the status bar names it and its commands, the verbs and the hub's rebuild", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Brain");
  await expect(mode).toHaveAttribute("title", /^Brain: cli\/aos\.js, brain-hub\.js\n/);
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
  await expect(main().locator(".aos-brain-rv-lede")).toHaveText("Wrote 1 memory. It looks new.");
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
  await win.keyboard.press("Shift+K");
  for (const p of fresh) await expect.poll(() => read(p)).toBe(pristine(p).replace("reviewed: false\n", "reviewed: true\n"));
  await expect.poll(() => trailAdded().map((r) => [r.action, r.path])).toEqual(fresh.map((p) => ["kept", p]));
  expect(read(flagged)).toBe(before.flagged);
  expect(read("MEMORY.md")).toBe(before.index);
  // Only the flagged card is left, still selected; nothing new is left to keep.
  await expect(main().locator("article.aos-brain-rv-card")).toHaveCount(1);
  await expect(card(flagged)).toHaveAttribute("aria-current", "true");
  await expect(main().locator(".aos-brain-rv-lede")).toHaveText("Wrote 1 memory. It looks like one you already have.");
  const keepNew = main().locator("button.aos-brain-rv-keepnew");
  await expect(keepNew).toHaveText("Keep the 0 new⇧K");
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
  expect(readVaultJson<{ sections: { rules: { paths: string[] } } }>("brain/_index/brain-sources.json").sections.rules.paths).toContain(rel);
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
  await expect(queue("drafts").locator(".aos-brain-chipn")).toHaveText("0");
  await expect(main().locator(".aos-brain-empty")).toHaveText("No feedback drafts.");
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
  await expect(reader()).toHaveText("No feedback drafts wait for approval.");
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

// ── helpers that read the fixture ────────────────────────────────────

function byKeyOf(key: string) { return B().batches.find((b) => b.key === key)!; }
/** A frontmatter key's value, or null. */
function fmLine(text: string, key: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const m = fm ? new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(fm[1]) : null;
  return m ? m[1] : null;
}
