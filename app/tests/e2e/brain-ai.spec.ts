// Brain's AI helpers with the brain surface on (AOS_APP_WRITE=brain; spec 2026-10-12-brain-hub-ai A1–A14, brain-hub D21,
// D22): Merge with AI from Review's M (the by-hand draft and the estimate first, Draft with AI through the runtime's
// provider chain, Save merged writing the oldest over and superseding the other, one MEMORY.md line, the trail, a
// record), the same dialog from Health's duplicate row under provider `none` (why, Draft with AI off, Save by hand),
// Undo merge from Library after a merge made in a terminal, the Consolidation sweep in Health (its cards: Retitle and
// Archive after asking, Dismiss for good) and Consolidate with AI on a Health cluster and on a Map community (a sweep
// scoped to those memories, its cards under the group). The model is the chat stand-in (harness installChatStubs): a
// fake `claude` on the runtime's recorded path that answers a canned `--output-format json` result with
// `structured_output` and `total_cost_usd`, reached only through the vault's own runtime (provider.js), never the page.
// Every test puts back what it changed (the store, MEMORY.md, the trail, the caches, the sweep file, the merge records,
// the provider's state and ledger, both configs), so the tests stay independent.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  FX, appEnv, chatReply, claudeCalls, closeNotes, content, expected, guardWrites, installChatStubs, openTab, providerState, readVaultJson, useApp,
} from "./harness";
import { shortDay, usdText } from "../../../hud/src/data/brainModel";
import { scopePaths } from "../../../hud/src/data/brainSweep";

const app = useApp({ env: { AOS_APP_WRITE: "brain" } });
const C = () => content(app().win);
const B = () => expected().brain;

// A model call and a hub rebuild per test, each waited for: more than the default minute.
test.describe.configure({ timeout: 180_000 });

// ── the files ────────────────────────────────────────────────────────

const TRAIL = "brain/_index/promote-log.jsonl";
const HUB = "brain/_index/brain-hub.json";
const SWEEP = "brain/_index/memory-sweep.json";
const MERGES = "brain/_index/memory-merges";
const STATE = "brain/_index/provider-state.json";
const SPEND = "brain/_index/provider-spend.jsonl";
const VAULT_CFG = "brain/config.json";
const AGENTICOS = path.join(FX.claude, "agenticos.json");
const read = (rel: string): string | null => (fs.existsSync(FX.v(rel)) ? fs.readFileSync(FX.v(rel), "utf8") : null);
const pristinePath = (rel: string) => path.join(FX.pristine, "vault", rel);
const pristine = (rel: string): string => fs.readFileSync(pristinePath(rel), "utf8");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
/** The trail rows appended since the fixture was made. */
const trailAdded = (): Array<Record<string, unknown>> => read(TRAIL)!.slice(pristine(TRAIL).length).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const hub = () => readVaultJson<{ builtAt: string; dups: Array<{ a: string; b: string }>; clusters: Array<{ paths: string[]; label: string }> }>(HUB);
/** MEMORY.md's line for a memory as the fixture has it, without its line end. */
const indexLine = (rel: string): string => pristine("MEMORY.md").split("\n").find((l) => l.includes(`](${rel})`))!;
/** The spend ledger's rows (brain/_index/provider-spend.jsonl), none before a call. */
const spendRows = (): Array<Record<string, unknown>> => (read(SPEND) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
/** The merge records (brain/_index/memory-merges/<id>.json). */
const records = (): Array<Record<string, any>> => (fs.existsSync(FX.v(MERGES)) ? fs.readdirSync(FX.v(MERGES)).sort().map((f) => JSON.parse(read(`${MERGES}/${f}`)!) as Record<string, any>) : []);
const sweepFile = () => JSON.parse(read(SWEEP)!) as { schema: number; runs: Array<Record<string, any>>; suggestions: Array<Record<string, any>> };
/** The day `updated:` takes from a merge (memory-merge.js dayOf: the UTC day). */
const utcDay = () => new Date().toISOString().slice(0, 10);

/** Every file under `dir` (relative to `root`), recursively. */
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

/** What a verb, a sweep, a model call and the rebuilds may change: the store's index files, the caches, the sweep file,
 *  the provider's state and ledger, and the vault's own config (a cluster test lowers memory.clusterMin). */
const INDEX_FILES = [TRAIL, HUB, SWEEP, STATE, SPEND, VAULT_CFG, "brain/_index/BRAIN.md", "brain/_index/brain-map.json", "brain/_index/brain-sources.json",
  "brain/_index/memory-notdup.json", "brain/_index/feedback-metrics.jsonl", "brain/_index/MOC-patterns.md", "brain/_index/MOC-projects.md", "brain/_index/MOC-reference.md"];

/** Puts one file back as the fixture had it (or removes it when the fixture had none), only when it differs. */
function restore(rel: string): void {
  const want = fs.existsSync(pristinePath(rel)) ? pristine(rel) : null;
  if (read(rel) === want) return;
  if (want === null) fs.rmSync(FX.v(rel), { force: true });
  else { fs.mkdirSync(path.dirname(FX.v(rel)), { recursive: true }); fs.writeFileSync(FX.v(rel), want); }
}

const run = promisify(execFile);
/** The runtime the page started for an action: a verb (a model call included), the BRAIN.md and brain-hub.json rebuilds. */
async function runtimeBusy(): Promise<string[]> {
  const { stdout } = await run("ps", ["-Aww", "-o", "command="], { maxBuffer: 64 << 20 });
  return stdout.split("\n").filter((c) => c.includes(FX.vault) && /brain-hub\.js|build-brain-md\.js|cli\/aos\.js memory/.test(c));
}
/** Waits until nothing the page started still runs (twice in a row: brain-hub.js may run once more after an action). */
async function idle(): Promise<void> {
  for (let quiet = 0, until = Date.now() + 30_000; quiet < 2;) {
    if (Date.now() > until) throw new Error(`the runtime is still busy:\n${(await runtimeBusy()).join("\n")}`);
    quiet = (await runtimeBusy()).length ? 0 : quiet + 1;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Puts the brain, its caches and both configs back as the fixture had them, once the runtime has finished. */
async function resetBrain(): Promise<void> {
  await idle();
  chatReply(null);
  const want = new Set(files(path.join(FX.pristine, "vault"), "brain/memory"));
  for (const rel of files(FX.vault, "brain/memory")) if (!want.has(rel)) fs.rmSync(FX.v(rel), { force: true });
  for (const rel of [...want, "MEMORY.md", ...INDEX_FILES]) restore(rel);
  fs.rmSync(FX.v(MERGES), { recursive: true, force: true });
  const cfg = fs.readFileSync(path.join(FX.pristine, "home", ".claude", "agenticos.json"), "utf8");
  if (fs.readFileSync(AGENTICOS, "utf8") !== cfg) fs.writeFileSync(AGENTICOS, cfg);
}

/** `aos <args>` as a user types it in a terminal or a session (no AOS_HEADLESS), in the fixture's environment: its JSON. */
function aos<T>(...args: string[]): T {
  const r = spawnSync("/bin/sh", [FX.v("brain/scripts/bin/aos"), ...args], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`aos ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

/**
 * The model for a test: the chat stand-ins on the runtime's recorded paths, `provider: claude` in agenticos.json, its
 * login fresh in provider-state.json, and the next answer `reply` as headless Claude's `--output-format json` prints it
 * with `--json-schema` (the reply in `structured_output`, the cost in `total_cost_usd`). resetBrain puts all of it back.
 */
function useClaude(reply: unknown, usd: number): void {
  installChatStubs();
  const j = JSON.parse(fs.readFileSync(AGENTICOS, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(AGENTICOS, `${JSON.stringify({ ...j, provider: "claude" }, null, 2)}\n`);
  providerState("claude", { claude: true, codex: false });
  chatReply({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(reply), structured_output: reply, total_cost_usd: usd, usage: { input_tokens: 900, output_tokens: 240 } }) });
}

interface Estimate { available: boolean; reason: string | null; provider: string; model: string | null; tokensIn: number; tokensOut: number; usd: number; cap: unknown }
interface MergeEstimate { winner: string; baseHashes: string[]; byHand: { title: string; description: string; body: string }; estimate: Estimate }

// ── the page ─────────────────────────────────────────────────────────

const modeTab = (m: string) => C().locator(`.aos-brain-modes [role="tab"][data-mode="${m}"]`);
const queue = (q: string) => C().locator(`.aos-brain-rv-queues button.aos-brain-chip[data-queue="${q}"]`);
const batchRow = (key: string) => C().locator(`.aos-brain-rv-left button.aos-brain-rv-batch[data-key="${key}"]`);
const main = () => C().locator(".aos-brain-rv-main");
const card = (rel: string) => main().locator(`article.aos-brain-rv-card[data-path="${rel}"]`);
const libRow = (rel: string) => C().locator(`.aos-lib-list button.aos-lib-row[data-path="${rel}"]`);
const context = () => C().locator("aside.aos-lib-context");
const hl = () => C().locator(".aos-brain-health");
const sweepCard = () => hl().locator('section[data-anchor="sweep"]');
const swCard = (scope: Locator, kind: string) => scope.locator(`.aos-brain-sw-card[data-kind="${kind}"]`);
const mergeModal = (win: Page) => win.locator(".modal.mod-brain-merge");
const confirmModal = (win: Page, title: string) => win.locator(".modal", { has: win.locator(".aos-confirm-modal h3", { hasText: title }) });
const notices = (win: Page) => win.locator(".notice-container");
const mapEl = () => C().locator("section.aos-brain-map");

async function mode(m: string): Promise<void> {
  await modeTab(m).click();
  await expect(modeTab(m)).toHaveAttribute("aria-selected", "true");
  await expect(C().locator(".aos-brain-body")).toHaveAttribute("data-mode", m);
}
async function brain(m: string): Promise<void> {
  await openTab(app().win, "memory");
  await mode(m);
}
async function pickBatch(key: string): Promise<void> {
  await queue("session").click();
  await expect(queue("session")).toHaveAttribute("aria-pressed", "true");
  await batchRow(key).click();
  await expect(batchRow(key)).toHaveAttribute("aria-selected", "true");
}
/** Selects a card and gives it the keyboard (a click on its summary, not on a button). */
async function focusCard(rel: string): Promise<void> {
  await expect(card(rel)).toBeVisible({ timeout: 15_000 });
  await card(rel).locator(".aos-brain-rv-sum").click();
  await expect(card(rel)).toHaveAttribute("aria-current", "true");
  await expect(card(rel)).toBeFocused();
}
async function hubRebuilt(was: string): Promise<void> {
  await expect.poll(() => hub().builtAt, { timeout: 30_000 }).not.toBe(was);
}
async function reviewSees(waiting: number): Promise<void> {
  await expect(modeTab("review").locator(".aos-brain-modebadge")).toHaveText(String(waiting));
}
const batchOf = (rel: string) => B().batches.find((b) => b.paths.includes(rel))!;
/** A frontmatter key's value, or null. */
function fmLine(text: string, key: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const m = fm ? new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(fm[1]) : null;
  return m ? m[1] : null;
}
/** The file's H1. */
const titleOf = (rel: string): string => /^#[ \t]+(.+?)[ \t]*$/m.exec((read(rel) ?? pristine(rel)).replace(/^---\n[\s\S]*?\n---\n/, ""))![1];

test.beforeEach(async () => {
  await brain("review");
});

test.afterEach(async () => {
  const h = app();
  // Every write is the runtime's, through a verb the brain surface admits (the model call the runtime's own): the page
  // wrote nothing itself, and main refused no spawn.
  expect(await guardWrites(h)).toEqual([]);
  expect((await h.guard()).filter((e) => e.kind === "spawn")).toEqual([]);
  await closeNotes(h.win);
  await resetBrain();
  await brain("review");
  await reviewSees(B().unreviewed.length);
});

// ── Merge with AI (D21; A1, A4, A5, A8, A9) ─────────────────────────

/** The merged memory's fields the stand-in drafts: a title and a description YAML has to quote, a body with a link. */
const DRAFT = {
  title: "Small diffs: one sitting each",
  description: "Keep each change small enough to review in one sitting: refactors apart from behaviour",
  body: "Keep each change small enough to review in one sitting.\n\n**Why:** a large diff hid a regression in [[Harbor Map]], and another in the parser review.\n\n**How to apply:** split refactors from behaviour changes; one commit each.",
};

test("Review's M › Merge into one…: the sources, the by-hand draft and what a draft costs; Draft with AI fills the fields and says who drafted it and for how much; Save merged writes the oldest over, supersedes the other, leaves one MEMORY.md line, the trail's rows and a record", async () => {
  const h = app();
  const { win } = h;
  const [newer, older] = B().duplicate;
  useClaude(DRAFT, 0.0042);
  // What the runtime says one call would cost, asked as a terminal would (the dialog asks the same verb).
  const est = aos<MergeEstimate>("memory", "merge-draft", newer, older, "--estimate", "--json");
  expect(est.winner).toBe(older);
  expect(est.estimate).toMatchObject({ available: true, provider: "claude", model: "haiku" });
  const b = batchOf(newer);
  await pickBatch(b.key);
  await focusCard(newer);
  await win.keyboard.press("m");
  const acts = card(newer).locator(".aos-brain-rv-cmpacts");
  await expect(acts.locator("button")).toHaveText(["Merge into one…", "Keep the older one", "Keep both", "Open both"]);
  await expect(acts.locator(".aos-brain-rv-hint")).toHaveText("Merge drafts one memory from the two; you approve it before anything is written. Keep the older one marks the newer superseded by it; Restore undoes it.");
  await acts.locator('button[data-act="mergeone"]').click();

  // The dialog: labelled, the sources oldest first (the one written over keeps its path), the by-hand draft (A4).
  const d = mergeModal(win);
  await expect(d).toHaveAttribute("role", "dialog");
  await expect(d).toHaveAttribute("aria-modal", "true");
  await expect(d.locator(`[id="${await d.getAttribute("aria-labelledby")}"]`)).toHaveText("Merge 2 memories into one");
  await expect(d.locator(".aos-brain-mg-sub")).toHaveText("Edit the draft on the right, or draft it with AI. Nothing is written until you save.");
  const now = new Date();
  const src = d.locator("article.aos-brain-mg-src");
  expect(await src.evaluateAll((els) => els.map((e) => [e.getAttribute("data-path"), e.classList.contains("is-winner")]))).toEqual([[older, true], [newer, false]]);
  await expect(src.locator(".aos-brain-mg-srctitle")).toHaveText([titleOf(older), titleOf(newer)]);
  await expect(src.nth(0).locator(".aos-brain-pill")).toHaveText("keeps its path");
  await expect(src.locator(".aos-brain-mg-srcmeta")).toHaveText([
    `feedback/prefer-small-diffs.md · created ${shortDay(fmLine(pristine(older), "created"), now)}`,
    `feedback/prefer-small-diffs-in-reviews.md · created ${shortDay(fmLine(pristine(newer), "created"), now)} · auto-wrap`,
  ]);
  await expect(src.nth(1).locator(".aos-brain-mg-srcbody")).toContainText("a large diff hid a regression in the parser review");
  const title = d.locator('input[data-field="title"]');
  const desc = d.locator('input[data-field="description"]');
  const body = d.locator('textarea[data-field="body"]');
  await expect(title).toHaveValue(est.byHand.title);
  await expect(desc).toHaveValue(est.byHand.description);
  await expect(body).toHaveValue(est.byHand.body);
  expect(est.byHand.body).toContain("## From Prefer small diffs in reviews");
  await expect(title).toBeFocused();
  await expect(d.locator(".aos-brain-mg-target")).toHaveText("feedback/prefer-small-diffs.md · keeps the older slug's links");
  await expect(d.locator(".aos-brain-mg-willlist li")).toHaveText([
    "write the merged text into feedback/prefer-small-diffs.md, mark it reviewed",
    "mark the other one superseded by it",
    "replace their MEMORY.md lines with one",
    "log it, so Undo merge works for 30 days",
  ]);
  // What one call would cost, before it is made (A5): the runtime's estimate, named by its model and host.
  const ai = d.locator('button[data-act="draft"]');
  await expect(d.locator(".aos-brain-mg-est")).toHaveText(`about ${usdText(est.estimate.usd)} · haiku · Claude`);
  await expect(ai).toHaveText("Draft with AI");
  await expect(ai).toBeEnabled();
  expect(claudeCalls()).toEqual([]);

  // Draft with AI: one call through the runtime's chain, its fields in the draft, who drafted it and what it cost.
  await ai.click();
  await expect(title).toHaveValue(DRAFT.title, { timeout: 30_000 });
  await expect(desc).toHaveValue(DRAFT.description);
  await expect(body).toHaveValue(DRAFT.body);
  await expect(d.locator(".aos-brain-mg-spend")).toHaveText("drafted by haiku · Claude · $0.0042 · today $0.0042 of $0.50");
  await expect(d.locator(".aos-brain-mg-spend")).toHaveAttribute("data-tone", "ai");
  await expect(ai).toHaveText("Redraft");
  const calls = claudeCalls();
  expect(calls).toHaveLength(1);
  const argv = calls[0].argv;
  // The hook chain's recipe (A7): claude.model, the per-call cap, the strict schema, headless and outside any session.
  expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
  expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.05");
  expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1])).toEqual({ type: "object", additionalProperties: false, required: ["title", "description", "body"], properties: { title: { type: "string" }, description: { type: "string" }, body: { type: "string" } } });
  expect(calls[0].env).toEqual({ AOS_HEADLESS: "1", CLAUDECODE: null });
  // The prompt: one block per source, oldest first, each with its path, type and day.
  const prompt = argv[argv.indexOf("-p") + 1];
  const at = (rel: string) => prompt.indexOf(`=== ${rel} (feedback, created ${fmLine(pristine(rel), "created")}) ===`);
  expect(at(older)).toBeGreaterThan(-1);
  expect(at(newer)).toBeGreaterThan(at(older));
  // The spend ledger's row: the hook family's merge feature, Claude's own cost.
  expect(spendRows().map((r) => [r.feature, r.provider, r.model, r.usd])).toEqual([["memory-merge", "claude", "haiku", 0.0042]]);
  // Nothing is written by a draft.
  expect(read(older)).toBe(pristine(older));
  expect(read(newer)).toBe(pristine(newer));
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md"));

  // Save merged (A9): `merge … --expect <each source's hash>`.
  const builtAt = hub().builtAt;
  await d.locator('button[data-act="save"]').click();
  await expect(d).toHaveCount(0, { timeout: 30_000 });
  await expect(notices(win)).toContainText(`Merged 2 memories into “${DRAFT.title}”. Undo merge is in Library for 30 days.`);
  // The oldest keeps its path and frontmatter, its title, description and body the merged ones, reviewed, updated today.
  const merged = pristine(older).replace(/^updated: .*$/m, `updated: ${utcDay()}`)
    .replace(/\n---\n[\s\S]*$/, `\ndescription: "${DRAFT.description}"\nreviewed: true\n---\n\n# ${DRAFT.title}\n\n${DRAFT.body}\n`);
  await expect.poll(() => read(older)).toBe(merged);
  // The other is superseded by it as Keep the older one supersedes (D7): its description kept, its status before.
  expect(read(newer)).toBe(pristine(newer)
    .replace("tags: [memory/feedback, status/active]\n", "tags: [memory/feedback, status/superseded]\n")
    .replace("reviewed: false\n---", `reviewed: false\ndescription: one reviewable change per sitting\nstatus_before: active\nsuperseded_by: ${older}\n---`));
  // MEMORY.md: one line for the two, in the oldest's place, with the merged title and description.
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md")
    .replace(`${indexLine(older)}\n`, `- [${DRAFT.title}](${older}) — ${DRAFT.description}\n`)
    .replace(`${indexLine(newer)}\n`, ""));
  // The record (A2), written first: the oldest's text and line before, every source's hash, the other's text before and
  // the hash written over it, MEMORY.md's text before and its hash after, not undone.
  const recs = records();
  expect(recs).toHaveLength(1);
  const rec = recs[0];
  expect(rec).toEqual({
    schema: 1, id: expect.stringMatching(/^\d{8}-\d{6}-[0-9a-f]{8}$/), at: expect.any(String), winner: older,
    before: { text: pristine(older), hash: sha(pristine(older)), line: indexLine(older) }, after: { hash: sha(merged) },
    sources: [
      { path: newer, hash: sha(pristine(newer)), before: { text: pristine(newer), hash: sha(pristine(newer)) }, after: { hash: sha(read(newer)!) } },
      { path: older, hash: sha(pristine(older)) },
    ],
    index: { before: { text: pristine("MEMORY.md"), hash: sha(pristine("MEMORY.md")) }, after: { hash: sha(read("MEMORY.md")!) } },
    undoneAt: null,
  });
  // The trail: merged on the oldest, superseded on the other, both naming the record.
  expect(trailAdded().map((r) => ({ ...r, ts: undefined }))).toEqual([
    { ts: undefined, session: null, action: "merged", slug: "prefer-small-diffs", type: "feedback", title: DRAFT.title, path: older, from: [newer], record: rec.id, hash: sha(merged) },
    { ts: undefined, session: B().sessions.claude, action: "superseded", slug: "prefer-small-diffs-in-reviews", type: "feedback", title: titleOf(newer), path: newer, by: older, record: rec.id },
  ]);
  // Review lets both go, and the pair with them; the hub is rebuilt from the files.
  await expect(card(newer)).toHaveCount(0);
  await expect(queue("duplicates").locator(".aos-brain-chipn")).toHaveText("0");
  await reviewSees(B().unreviewed.length - 1);
  await hubRebuilt(builtAt);
  await expect.poll(() => hub().dups).toEqual([]);
  expect(claudeCalls()).toHaveLength(1);
});

test("Health's Merge with AI… under provider none: the dialog says why, Draft with AI is off; the by-hand draft, edited, saves through the same merge and no model is called", async () => {
  const h = app();
  const { win } = h;
  const [newer, older] = B().duplicate;
  // The stand-ins are on the recorded paths, so a call would be seen; the fixture's provider stays none.
  installChatStubs();
  const est = aos<MergeEstimate>("memory", "merge-draft", newer, older, "--estimate", "--json");
  expect(est.estimate).toMatchObject({ available: false, reason: "forced", provider: "none" });
  await mode("health");
  const pair = hl().locator(".aos-brain-hl-pair");
  await expect(pair).toHaveAttribute("data-pair", [newer, older].sort().join("|"));
  const names = `“${titleOf(newer)}” and “${titleOf(older)}”`;
  expect(await pair.locator("button").evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("aria-label")]))).toEqual([
    ["Compare", `Compare ${names} in Review`], ["Merge with AI…", `Merge with AI: ${names}`], ["Not duplicates", `Not duplicates: ${names}`],
  ]);
  const open = pair.locator('button[data-act="merge"]');
  await open.click();
  const d = mergeModal(win);
  await expect(d.locator(".aos-brain-mg-title")).toHaveText("Merge 2 memories into one");
  // While its dialog is open the row's button says so and waits.
  await expect(open).toHaveText("Merging…");
  await expect(open).toHaveAttribute("aria-disabled", "true");
  // No model (A4): why, Draft with AI off, the draft to finish by hand.
  const ai = d.locator('button[data-act="draft"]');
  await expect(d.locator(".aos-brain-mg-est")).toHaveText("No model provider is set up. Combine them by hand below.");
  await expect(d.locator(".aos-brain-mg-est")).toHaveClass(/is-off/);
  await expect(ai).toBeDisabled();
  const title = d.locator('input[data-field="title"]');
  await expect(title).toHaveValue(est.byHand.title);
  await expect(d.locator('input[data-field="description"]')).toHaveValue(est.byHand.description);
  await expect(d.locator('textarea[data-field="body"]')).toHaveValue(est.byHand.body);
  // Save is off while a field the merge needs is empty, and says why.
  const save = d.locator('button[data-act="save"]');
  await title.fill("");
  await expect(save).toBeDisabled();
  await expect(d.locator(".aos-brain-mg-problem")).toHaveText("The merged memory needs a title.");
  const TITLE = "Prefer small diffs, one sitting each";
  await title.fill(TITLE);
  await expect(d.locator(".aos-brain-mg-problem")).toHaveText("");
  await save.click();
  await expect(d).toHaveCount(0, { timeout: 30_000 });
  await expect(notices(win)).toContainText(`Merged 2 memories into “${TITLE}”. Undo merge is in Library for 30 days.`);
  // The by-hand draft as Save sent it: the oldest's description and body, then the other's under "From <title>".
  const merged = pristine(older).replace(/^updated: .*$/m, `updated: ${utcDay()}`)
    .replace(/\n---\n[\s\S]*$/, `\ndescription: ${est.byHand.description}\nreviewed: true\n---\n\n# ${TITLE}\n\n${est.byHand.body}\n`);
  await expect.poll(() => read(older)).toBe(merged);
  expect(fmLine(read(newer)!, "superseded_by")).toBe(older);
  expect(read("MEMORY.md")).toBe(pristine("MEMORY.md")
    .replace(`${indexLine(older)}\n`, `- [${TITLE}](${older}) — ${est.byHand.description}\n`)
    .replace(`${indexLine(newer)}\n`, ""));
  expect(trailAdded().map((r) => [r.action, r.path])).toEqual([["merged", older], ["superseded", newer]]);
  expect(records()).toHaveLength(1);
  // No model was asked and nothing was billed.
  expect(claudeCalls()).toEqual([]);
  expect(read(SPEND)).toBeNull();
  // The pair leaves Health once the files are read again.
  await expect(pair).toHaveCount(0, { timeout: 30_000 });
});

test("Undo merge (A2): after a merge made in a terminal, Library's history reads merged 1 into this with Undo merge; confirmed, the oldest's text, the other memory and their MEMORY.md lines come back, the record is marked undone, and the button goes", async () => {
  const { win } = app();
  const [newer, older] = B().duplicate;
  // As a user runs it in a terminal or a session, on either host: the draft's hashes, then the merge pinned to them.
  const est = aos<MergeEstimate>("memory", "merge-draft", newer, older, "--estimate", "--json");
  const into = { title: "Small diffs, one sitting", description: "one reviewable change per sitting, refactors apart", body: "Keep each change reviewable in one sitting; split refactors from behaviour changes." };
  const done = aos<{ path: string; superseded: string[]; record: string; hash: string }>("memory", "merge", newer, older, "--into", JSON.stringify(into), "--expect", est.baseHashes.join(","), "--json");
  expect(done).toMatchObject({ path: older, superseded: [newer], hash: sha(read(older)!) });
  // A merge from outside reaches the page: the other one is superseded, the oldest reads as merged.
  await mode("library");
  await libRow(older).click();
  await expect(C().locator("section.aos-lib-reader h2")).toHaveText(into.title);
  const hist = context().locator('section[data-section="history"]');
  await expect(hist.locator(".aos-lib-cline")).toContainText("merged 1 into this");
  const undo = hist.locator('button[data-action="unmerge"]');
  await expect(undo).toHaveText("Undo merge");
  await expect(hist.locator(".aos-brain-undomerge .aos-lib-cnote")).toHaveText("30 days left to undo it");
  // It asks first; Cancel changes nothing.
  await undo.click();
  const ask = confirmModal(win, `Undo the merge into “${into.title}”?`);
  await expect(ask.locator("p")).toHaveText("Puts back the text this memory had before the merge and restores the memory merged into it, with their MEMORY.md lines. Refused if this memory changed since the merge.");
  await expect(ask.locator("button")).toHaveText(["Cancel", "Undo merge"]);
  await ask.locator("button", { hasText: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  expect(records()[0].undoneAt).toBeNull();
  await undo.click();
  await ask.locator("button", { hasText: "Undo merge" }).click();
  await expect(notices(win)).toContainText("Merge undone: 1 memory restored.");
  // Nothing changed since the merge, so everything comes back byte for byte (A2): the oldest, the other (without the
  // description the merge gave it) and MEMORY.md, every line in its place.
  await expect.poll(() => read(older)).toBe(pristine(older));
  await expect.poll(() => read(newer)).toBe(pristine(newer));
  await expect.poll(() => read("MEMORY.md")).toBe(pristine("MEMORY.md"));
  const rec = records()[0];
  expect(rec.id).toBe(done.record);
  expect(rec.undoneAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  expect(trailAdded().map((r) => [r.action, r.path, r.record, r.restored ?? null])).toEqual([
    ["merged", older, done.record, null], ["superseded", newer, done.record, null], ["unmerged", older, done.record, [newer]], ["restored", newer, done.record, null],
  ]);
  // Undone, it cannot be undone again: the history says so and the button goes.
  await expect(hist.locator(".aos-lib-cline")).toContainText("merge undone");
  await expect(undo).toHaveCount(0);
  await expect(C().locator("section.aos-lib-reader h2")).toHaveText(titleOf(older));
});

// ── the Consolidation sweep (D22; A3, A5, A6, A10, A11) ─────────────

const VIEWER = "brain/memory/projects/chart-viewer-1.2.0.md";
const HOURS = "brain/memory/user/working-hours.md";
const SPIKE = "brain/memory/projects/wind-overlay-spike.md";
const RETITLE = { title: "Deep work before noon", description: "Mornings for deep work, reviews after lunch, no Friday meetings" };

test("Health's Consolidation sweep: the estimate before, Run a sweep through the runtime, its four cards; Retitle and Archive apply after asking, a Merge card's Review opens the Merge dialog, Dismiss hides one for good in memory-sweep.json", async () => {
  const { win } = app();
  const [newer, older] = B().duplicate;
  const reply = {
    suggestions: [
      { kind: "merge", paths: [newer, older], title: "Prefer small diffs", description: "", why: "Both say keep each change small enough to review in one sitting." },
      { kind: "archive", paths: [VIEWER], title: "", description: "", why: "Version 1.2.0 shipped; the note only points at its release notes." },
      { kind: "retitle", paths: [HOURS], title: RETITLE.title, description: RETITLE.description, why: "The title names the topic, not the rule it holds." },
      { kind: "archive", paths: [SPIKE], title: "", description: "", why: "A parked spike with nothing left to do." },
    ],
  };
  useClaude(reply, 0.0187);
  const est = aos<{ scope: unknown; considered: number; of: number; estimate: Estimate }>("memory", "sweep", "--estimate", "--json");
  expect(est.estimate).toMatchObject({ available: true, provider: "claude", model: "haiku" });
  expect(est.considered).toBe(est.of);
  await mode("health");
  const card = sweepCard();
  await expect(card.locator("h2")).toHaveText("Consolidation sweep");
  await expect(card.locator(".aos-brain-hl-csub")).toHaveText("No sweep yet");
  const line = card.locator(".aos-brain-sw-est");
  await expect(line).toHaveAttribute("data-est", "ready");
  await expect(line).toHaveText(`about ${usdText(est.estimate.usd)} · haiku · Claude · today $0.00 of $5.00`);
  await expect(card.locator(".aos-brain-sw-empty")).toHaveText("A sweep reads each memory's title, description and first lines, and suggests merges, archives and retitles. Nothing changes until you apply one.");
  const runBtn = card.locator('[data-hl-key="sweep:run"]');
  await expect(runBtn).toHaveText("Run a sweep");
  await runBtn.click();
  await expect(notices(win)).toContainText("Sweep: 4 suggestions · swept by haiku · Claude · $0.02", { timeout: 30_000 });
  // One call on the background model under the reasoner's caps (A6): claude.model, no --effort, reasoner.perCallUsd.
  const calls = claudeCalls();
  expect(calls).toHaveLength(1);
  const argv = calls[0].argv;
  expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
  expect(argv).not.toContain("--effort");
  expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.5");
  expect(argv).toContain("--json-schema");
  // The input (A11): one line per live memory, the hub's pair as a hint.
  const prompt = argv[argv.indexOf("-p") + 1];
  expect(prompt).toContain(`MEMORIES (${est.of} of ${est.of})`);
  expect(prompt).toContain(`${newer} ${older} ${B().dups[0].score}`);
  expect(spendRows().map((r) => [r.feature, r.provider, r.usd])).toEqual([["reason:memory-sweep", "claude", 0.0187]]);
  // memory-sweep.json: the run and its four cards, each with the hashes it saw.
  const f = sweepFile();
  expect(f.runs).toHaveLength(1);
  expect(f.runs[0]).toMatchObject({ scope: null, provider: "claude", model: "haiku", usd: 0.0187, estimated: false, considered: est.of, of: est.of, suggestions: 4 });
  const id = (kind: string, paths: string[]) => sha(`${kind}\n${[...paths].sort().join("\n")}`).slice(0, 12);
  expect(f.suggestions.map((c) => [c.id, c.kind, c.paths, c.hashes, c.state, c.scope])).toEqual([
    [id("merge", [newer, older]), "merge", [newer, older], [sha(pristine(newer)), sha(pristine(older))], "open", null],
    [id("archive", [VIEWER]), "archive", [VIEWER], [sha(pristine(VIEWER))], "open", null],
    [id("retitle", [HOURS]), "retitle", [HOURS], [sha(pristine(HOURS))], "open", null],
    [id("archive", [SPIKE]), "archive", [SPIKE], [sha(pristine(SPIKE))], "open", null],
  ]);
  // The cards, under the whole brain: each kind as a word, what it does, its memories' titles and why.
  const group = card.locator('section.aos-brain-sw-group[data-scope="all"]');
  await expect(group.locator("h3")).toHaveText("Whole brain · 4");
  await expect(card.locator(".aos-brain-hl-csub")).toHaveText("last run today · 4 suggestions · 4 open");
  const cards = group.locator(".aos-brain-sw-card");
  expect(await cards.evaluateAll((els) => els.map((e) => [e.getAttribute("data-kind"), e.getAttribute("data-sweep-id"), e.getAttribute("data-sweep-state")]))).toEqual([
    ["merge", id("merge", [newer, older]), "open"], ["archive", id("archive", [VIEWER]), "open"], ["retitle", id("retitle", [HOURS]), "open"], ["archive", id("archive", [SPIKE]), "open"],
  ]);
  await expect(cards.locator(".aos-brain-sw-kind")).toHaveText(["Merge", "Archive", "Retitle", "Archive"]);
  await expect(cards.locator(".aos-brain-sw-what")).toHaveText(["2 into “Prefer small diffs”", "1 memory", `“${titleOf(HOURS)}” to “${RETITLE.title}”`, "1 memory"]);
  await expect(cards.nth(0).locator(".aos-brain-sw-title")).toHaveText([titleOf(newer), titleOf(older)]);
  await expect(cards.locator(".aos-brain-sw-why")).toHaveText(reply.suggestions.map((s) => s.why));
  await expect(cards.nth(2).locator('[data-sweep-act="review"]')).toHaveAttribute("aria-label", `Review: Retitle “${titleOf(HOURS)}” to “${RETITLE.title}”`);
  // Today's reasoner spend follows the run.
  await expect(line).toHaveText(`about ${usdText(est.estimate.usd)} · haiku · Claude · today $0.02 of $5.00`);

  // Retitle asks first (A10), then `set` with the new title and description: the H1 and the MEMORY.md line change, the
  // slug stays.
  await swCard(group, "retitle").locator('[data-sweep-act="review"]').click();
  const ask = confirmModal(win, `Retitle '${titleOf(HOURS)}' to '${RETITLE.title}'?`);
  await expect(ask.locator("p")).toHaveText(`The heading and its MEMORY.md line change; the file name stays, so links keep working. The description becomes “${RETITLE.description}”. The sweep's reason: ${reply.suggestions[2].why}`);
  await ask.locator("button", { hasText: "Retitle" }).click();
  await expect.poll(() => read(HOURS)).toBe(pristine(HOURS)
    .replace(/\n---\n/, `\ndescription: ${RETITLE.description}\n---\n`).replace(/^# Working Hours$/m, `# ${RETITLE.title}`));
  await expect.poll(() => read("MEMORY.md")).toBe(pristine("MEMORY.md").replace(indexLine(HOURS), `- [${RETITLE.title}](${HOURS}) — ${RETITLE.description}`));
  await expect(swCard(group, "retitle")).toHaveCount(0);

  // Archive asks first, then archives as A does (D5).
  const viewer = group.locator(`.aos-brain-sw-card[data-sweep-id="${id("archive", [VIEWER])}"]`);
  await viewer.locator('[data-sweep-act="review"]').click();
  const arch = confirmModal(win, "Archive 1 memory?");
  await expect(arch.locator("p")).toHaveText(`Archives “${titleOf(VIEWER)}”. It leaves recall, the MOCs and BRAIN.md. Nothing is deleted: Restore in Library puts it back. The sweep's reason: ${reply.suggestions[1].why}`);
  await arch.locator("button", { hasText: /^Archive$/ }).click();
  await expect.poll(() => fmLine(read(VIEWER) ?? "", "archived")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(fmLine(read(VIEWER)!, "status_before")).toBe("active");
  await expect(notices(win)).toContainText("Archived 1 memory. Restore in Library puts it back.");
  await expect.poll(() => read("MEMORY.md")!.includes(`](${VIEWER})`)).toBe(false);
  await expect(viewer).toHaveCount(0);

  // A Merge card's Review is the Merge dialog on its memories (A10); Cancel writes nothing and the card stays.
  await swCard(group, "merge").locator('[data-sweep-act="review"]').click();
  const d = mergeModal(win);
  await expect(d.locator(".aos-brain-mg-title")).toHaveText("Merge 2 memories into one");
  await expect(d.locator("article.aos-brain-mg-src.is-winner")).toHaveAttribute("data-path", older);
  await expect(d.locator(".aos-brain-mg-est")).toContainText("· haiku · Claude");
  await expect(swCard(group, "merge").locator('[data-sweep-act="review"]')).toHaveText("Merging…");
  await d.locator('button[data-act="cancel"]').click();
  await expect(d).toHaveCount(0);
  await expect(swCard(group, "merge").locator('[data-sweep-act="review"]')).toHaveText("Review…");

  // Dismiss hides a card for good: memory-sweep.json says so, and the card goes.
  const spike = group.locator(`.aos-brain-sw-card[data-sweep-id="${id("archive", [SPIKE])}"]`);
  await spike.locator('[data-sweep-act="dismiss"]').click();
  await expect.poll(() => sweepFile().suggestions.map((c) => [c.kind, c.paths[0], c.state])).toEqual([
    ["merge", newer, "open"], ["archive", VIEWER, "open"], ["retitle", HOURS, "open"], ["archive", SPIKE, "dismissed"],
  ]);
  await expect(spike).toHaveCount(0);
  await expect(group.locator(".aos-brain-sw-card")).toHaveCount(1);
  await expect(group.locator("h3")).toHaveText("Whole brain · 1");
  await expect(card.locator(".aos-brain-hl-csub")).toHaveText("last run today · 4 suggestions · 1 open");
  // The merge's and the dismissed card's memories are untouched; the trail has the retitle's set and the archive.
  for (const p of [newer, older, SPIKE]) expect(read(p)).toBe(pristine(p));
  expect(trailAdded().map((r) => [r.action, r.path, r.fields ?? null])).toEqual([["set", HOURS, ["title", "description"]], ["archived", VIEWER, null]]);
  expect(claudeCalls()).toHaveLength(1);
});

test("Consolidate with AI… on a Health cluster (A3): asks with the scoped estimate, sweeps only its memories, and its card shows under the row; the card's Review opens the Merge dialog on its two", async () => {
  const { win } = app();
  const [newer, older] = B().duplicate;
  // A cluster as the scan finds one: with memory.clusterMin at 2 the duplicate pair is one, and Rescan rebuilds the hub.
  const cfg = JSON.parse(read(VAULT_CFG)!) as { memory: Record<string, unknown> };
  cfg.memory.clusterMin = 2;
  fs.writeFileSync(FX.v(VAULT_CFG), `${JSON.stringify(cfg, null, 2)}\n`);
  const reply = { suggestions: [{ kind: "merge", paths: [older, newer], title: "Prefer small diffs", description: "", why: "The newer one repeats the older with the review named." }] };
  useClaude(reply, 0.0061);
  await mode("health");
  const builtAt = hub().builtAt;
  await hl().locator('[data-hl-key="rescan"]').click();
  await hubRebuilt(builtAt);
  const paths = [newer, older].sort();
  expect(hub().clusters).toEqual([{ paths, label: "diffs prefer small" }]);
  const row = hl().locator(`.aos-brain-hl-cluster[data-cluster="${paths.join("|")}"]`);
  await expect(row.locator(".aos-brain-hl-t1")).toHaveText("diffs prefer small");
  const go = row.locator('button[data-act="consolidate"]');
  await expect(go).toHaveText("Consolidate with AI…");
  await expect(go).toHaveAttribute("aria-label", "Consolidate “diffs prefer small” with AI");
  // The scope the row sends: its memories, the first leading (A3).
  const est = aos<{ considered: number; of: number; estimate: Estimate }>("memory", "sweep", ...paths, "--estimate", "--json");
  expect([est.considered, est.of]).toEqual([2, 2]);
  await go.click();
  const ask = confirmModal(win, "Consolidate “diffs prefer small” with AI?");
  await expect(ask.locator("p")).toHaveText(`A model reads these 2 memories and suggests merges, archives and retitles; nothing changes until you apply one. Cost: about ${usdText(est.estimate.usd)} · haiku · Claude, today $0.00 of $5.00.`);
  await ask.locator("button", { hasText: "Run the sweep" }).click();
  await expect(notices(win)).toContainText("Sweep of “diffs prefer small”: 1 suggestion · swept by haiku · Claude · $0.0061", { timeout: 30_000 });
  const calls = claudeCalls();
  expect(calls).toHaveLength(1);
  const prompt = calls[0].argv[calls[0].argv.indexOf("-p") + 1];
  // Only the cluster's memories go, with the cluster as a hint (A11).
  expect(prompt).toContain("MEMORIES (2 of 2)");
  expect(prompt).toContain(paths.join(" "));
  expect(prompt).not.toContain("brain/memory/projects/harbor-map.md");
  const f = sweepFile();
  expect(f.runs[0]).toMatchObject({ scope: { paths }, considered: 2, of: 2, suggestions: 1, usd: 0.0061 });
  const scope = sha([...paths].sort().join("\n")).slice(0, 12);
  expect(f.suggestions.map((c) => [c.kind, c.paths, c.scope])).toEqual([["merge", [older, newer], scope]]);
  // Its card under the row, not again in the Consolidation sweep card, which names the run's group.
  const under = hl().locator(`[data-cluster-cards="${paths.join("|")}"]`);
  await expect(under.locator(".aos-brain-sw-line")).toHaveText("last run today · 1 suggestion · 1 open");
  await expect(under.locator(".aos-brain-sw-card .aos-brain-sw-what")).toHaveText("2 into “Prefer small diffs”");
  await expect(sweepCard().locator(".aos-brain-sw-group")).toHaveCount(0);
  await expect(sweepCard().locator(".aos-brain-hl-csub")).toHaveText("last run today on “diffs prefer small” · 1 suggestion · 1 open");
  await expect(sweepCard().locator(".aos-brain-sw-empty")).toHaveText("The open suggestions for a cluster show under its row.");
  // A merge card's Review is the Merge dialog on its memories (A10); Cancel writes nothing and the card stays.
  await under.locator('.aos-brain-sw-card [data-sweep-act="review"]').click();
  const d = mergeModal(win);
  await expect(d.locator(".aos-brain-mg-title")).toHaveText("Merge 2 memories into one");
  await expect(d.locator("article.aos-brain-mg-src.is-winner")).toHaveAttribute("data-path", older);
  await expect(d.locator(".aos-brain-mg-est")).toContainText("· haiku · Claude");
  await d.locator('button[data-act="cancel"]').click();
  await expect(d).toHaveCount(0);
  await expect(under.locator(".aos-brain-sw-card")).toHaveCount(1);
  expect(read(older)).toBe(pristine(older));
  expect(read(newer)).toBe(pristine(newer));
  expect(claudeCalls()).toHaveLength(1);
});

test("Consolidate with AI… on a Map community (A3): the lead and its most linked members swept, the card in the community's panel and, named after it, in Health's sweep card", async () => {
  const { win } = app();
  const c = B().map.communities.find((x) => x.lead === B().duplicate[1])!;
  const sent = scopePaths(c.lead, c.paths, (p) => B().map.memories[p]?.degree ?? 0);
  expect(sent.cut).toBe(0);
  const CONFIRM = "brain/memory/feedback/confirm-before-deleting.md";
  expect(sent.paths).toContain(CONFIRM);
  const reply = { suggestions: [{ kind: "retitle", paths: [CONFIRM], title: "List first, then wait for a yes", description: "", why: "The title names the rule's two steps." }] };
  useClaude(reply, 0.0093);
  const est = aos<{ considered: number; of: number; estimate: Estimate }>("memory", "sweep", ...sent.paths, "--estimate", "--json");
  await mode("map");
  await mapEl().locator('button.aos-brain-mapview[data-map-view="communities"]').click();
  await mapEl().locator(`button.aos-brain-bubble[data-community="${c.id}"]`).click();
  const panel = mapEl().locator("aside.aos-brain-mapcard");
  await expect(panel.locator("h2.aos-brain-mapcardtitle")).toHaveText(c.name);
  const go = panel.locator('button[data-act="consolidate"]');
  await expect(go).toHaveText("Consolidate with AI…");
  await go.click();
  const ask = confirmModal(win, `Consolidate “${c.name}” with AI?`);
  await expect(ask.locator("p")).toHaveText(`A model reads these ${sent.paths.length} memories and suggests merges, archives and retitles; nothing changes until you apply one. Cost: about ${usdText(est.estimate.usd)} · haiku · Claude, today $0.00 of $5.00.`);
  await ask.locator("button", { hasText: "Run the sweep" }).click();
  await expect(notices(win)).toContainText(`Sweep of “${c.name}”: 1 suggestion · swept by haiku · Claude · $0.0093`, { timeout: 30_000 });
  const prompt = claudeCalls()[0].argv[claudeCalls()[0].argv.indexOf("-p") + 1];
  expect(prompt).toContain(`MEMORIES (${sent.paths.length} of ${sent.paths.length})`);
  for (const p of sent.paths) expect(prompt).toContain(`${p} |`);
  expect(prompt).not.toContain("brain/memory/projects/harbor-map.md |");
  expect(sweepFile().runs[0].scope).toEqual({ paths: sent.paths });
  // The community's panel shows its scope's card.
  const sec = panel.locator("section.aos-brain-sw-mapsec");
  await expect(sec.locator(".aos-brain-sw-line")).toHaveText("last run today · 1 suggestion · 1 open");
  await expect(sec.locator(".aos-brain-sw-card")).toHaveAttribute("data-kind", "retitle");
  await expect(sec.locator(".aos-brain-sw-what")).toHaveText(`“${titleOf(CONFIRM)}” to “List first, then wait for a yes”`);
  // Health's sweep card lists it under the community's name (no cluster row claims it).
  await mode("health");
  const scope = sha([...sent.paths].sort().join("\n")).slice(0, 12);
  const group = sweepCard().locator(`section.aos-brain-sw-group[data-scope="${scope}"]`);
  await expect(group.locator("h3")).toHaveText(`${c.name} · 1`);
  await expect(sweepCard().locator(".aos-brain-hl-csub")).toHaveText(`last run today on “${c.name}” · 1 suggestion · 1 open`);
  // Dismissed there, it leaves the Map's panel too.
  await group.locator('[data-sweep-act="dismiss"]').click();
  await expect.poll(() => sweepFile().suggestions.map((x) => x.state)).toEqual(["dismissed"]);
  await mode("map");
  await expect(mapEl().locator("aside.aos-brain-mapcard section.aos-brain-sw-mapsec .aos-brain-sw-card")).toHaveCount(0);
  await expect(mapEl().locator("aside.aos-brain-mapcard section.aos-brain-sw-mapsec .aos-brain-sw-empty")).toHaveText("Nothing open: every suggestion was applied or dismissed.");
  expect(read(CONFIRM)).toBe(pristine(CONFIRM));
});

// A card applied once, then undone, and suggested again by a later run (A10: a card's id is its kind and paths): the
// page hides a card whose action went through by its id and run (views/brain/SweepCards.ts), so the later run's card,
// open under another run, shows again.
test("a sweep card applied, undone and suggested again by a later run shows again", async () => {
  const { win } = app();
  const [newer, older] = B().duplicate;
  const merge = { kind: "merge", paths: [newer, older], title: "Prefer small diffs", description: "", why: "Both say keep each change small enough to review in one sitting." };
  useClaude({ suggestions: [merge] }, 0.0187);
  await mode("health");
  const card = sweepCard();
  await card.locator('[data-hl-key="sweep:run"]').click();
  const group = card.locator('section.aos-brain-sw-group[data-scope="all"]');
  await expect(swCard(group, "merge")).toHaveCount(1, { timeout: 30_000 });
  // Applied: the Merge dialog from the card, saved by hand (the stand-in answers the sweep's shape, not a draft's).
  await swCard(group, "merge").locator('[data-sweep-act="review"]').click();
  const d = mergeModal(win);
  await expect(d.locator('input[data-field="title"]')).toHaveValue(titleOf(older));
  await d.locator('button[data-act="save"]').click();
  await expect(d).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => fmLine(read(newer)!, "superseded_by")).toBe(older);
  await expect(swCard(group, "merge")).toHaveCount(0);
  // Undone from Library: both memories live again.
  await idle();
  await mode("library");
  await libRow(older).click();
  await context().locator('section[data-section="history"] button[data-action="unmerge"]').click();
  await confirmModal(win, `Undo the merge into “${titleOf(older)}”?`).locator("button", { hasText: "Undo merge" }).click();
  await expect.poll(() => read(older)).toBe(pristine(older));
  await expect.poll(() => read(newer)).toBe(pristine(newer));
  await idle();
  // A later run suggests the same merge again: a new card in memory-sweep.json, open, and it shows.
  await mode("health");
  await card.locator('[data-hl-key="sweep:run"]').click();
  await expect.poll(() => sweepFile().runs.length, { timeout: 30_000 }).toBe(2);
  expect(sweepFile().suggestions.map((c) => [c.kind, c.state, c.run])).toEqual([["merge", "open", sweepFile().runs[0].id]]);
  await expect(swCard(group, "merge")).toHaveCount(1);
});
