// Spaces with its write surface on (AOS_APP_WRITE=spaces). PR 2's runtime scripts: Files' Describe N new (for files the
// map has not described, and for a workspace with no map yet), ↻ per file, and the read's ↻ (spec
// 2026-10-09-spaces-redesign D9, D33). PR 3's actions (D13–D18, D35): New space per template, Adopt into and Link as code
// folder from the outside list, Hide and Unhide, Pin and the status menu, Archive and Restore, Rename, and the Draft
// dialog, each one named `aos workspace` verb through the spaces surface (D28, D29), every move after its confirmation
// (§6); + to-do and Link to-dos… through the To-Do surface's writer, off while that surface cannot write TODO.md. The
// tab writes nothing itself. The fixture's provider is `none`, so no model is ever called: Describe and the read's ↻
// take the runtime's heuristic path, ↻ per file is off and says why, and the Draft test points the runtime at the chat
// stand-in (harness installChatStubs) for its one call. Clone from GitHub reaches no network: the app's git rewrites the
// GitHub URL to a repository this spec makes on disk and allows only the file transport. Then `spaces,todo` for the
// to-do helpers.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FX, appEnv, chatReply, claudeCalls, content, expectNoErrors, guardWrites, installChatStubs, openTab, providerState, rail,
  readVaultJson, terminalText, useApp, type AppHandle,
} from "./harness";

interface MapFile { path: string; desc: string | null; descAt: string | null; descSource: string | null; status: string }
interface WorkspaceMap { workspace: string; files: MapFile[]; pending: number }
interface Insight { text: string | null; status: string; model: string | null; generatedAt: string | null }

const mapFile = (name: string) => FX.v(`brain/_index/workspace-maps/${name}.json`);
const readMap = (name: string): WorkspaceMap | null => (fs.existsSync(mapFile(name)) ? JSON.parse(fs.readFileSync(mapFile(name), "utf8")) as WorkspaceMap : null);
const pristineMap = (name: string) => JSON.parse(fs.readFileSync(path.join(FX.pristine, "vault", "brain", "_index", "workspace-maps", `${name}.json`), "utf8")) as WorkspaceMap;
const insight = (name: string) => readVaultJson<{ workspaces: Array<{ name: string; insight: Insight }> }>("brain/_index/snapshot.json").workspaces.find((w) => w.name === name)!.insight;
const fileMapRun = () => readVaultJson<{ pipelines: Record<string, { lastRun: { status: string; error?: string | null; startedAt: string } | null }> }>("brain/_index/pipelines.json").pipelines["file-map"]?.lastRun ?? null;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── locators ─────────────────────────────────────────────────────────

const C = (win: Page) => content(win);
const list = (win: Page) => C(win).locator(".aos-spc-list");
const centre = (win: Page) => C(win).locator(".aos-spc-centre");
const right = (win: Page) => C(win).locator(".aos-spc-right");
const head = (win: Page) => centre(win).locator(".aos-spc-head");
const row = (win: Page, name: string) => list(win).locator(`.aos-spc-row[data-workspace="${name}"]`);
const group = (win: Page, label: string) => list(win).locator(".aos-spc-ghead", { has: win.locator(".aos-spc-glabel", { hasText: new RegExp(`^${label}$`) }) });
/** A row inside the PINNED group's list. */
const pinnedRow = (win: Page, name: string) => list(win).locator(`#aos-spc-group-pinned .aos-spc-row[data-workspace="${name}"]`);
const tab = (win: Page, view: "Overview" | "Files") => centre(win).locator(".aos-spc-tab", { hasText: view });
const menu = (win: Page) => C(win).locator(".aos-spc-pop[role='menu']");
const menuItem = (win: Page, key: string) => menu(win).locator(`.aos-spc-popitem[data-key="${key}"]`);
const notices = (win: Page) => win.locator(".notice-container");
/** A Spaces dialog by its class (mod-spc-new, mod-spc-confirm, mod-spc-draft, mod-spc-todo, mod-spc-linktodos). */
const dialog = (win: Page, cls: string) => win.locator(`.modal.${cls}`);
const todoGroup = (win: Page) => right(win).locator(".aos-spc-linked .aos-spc-lgroup.is-todo");

/** Shows archived and _ folders in the list when they are not shown yet. */
async function showHidden(win: Page): Promise<void> {
  const t = list(win).locator("button.aos-spc-hiddenbtn");
  if (/^Show /.test((await t.textContent()) ?? "")) await t.click();
  await expect(t).toHaveText("Hide archived and _ folders");
}
async function hideHidden(win: Page): Promise<void> {
  const t = list(win).locator("button.aos-spc-hiddenbtn");
  if ((await t.count()) && /^Hide /.test((await t.textContent()) ?? "")) await t.click();
}

/** Selects a workspace in the list (opening a folded group first) and shows `view`; `title` is the dossier's heading. */
async function pick(win: Page, name: string, o: { view?: "Overview" | "Files"; title?: string } = {}): Promise<void> {
  if (!(await row(win, name).count())) {
    for (const label of ["IDLE", "ARCHIVED AND _ FOLDERS"]) {
      const g = group(win, label);
      if ((await g.count()) && (await g.getAttribute("aria-expanded")) === "false") await g.click();
    }
  }
  await row(win, name).click();
  await expect(row(win, name)).toHaveAttribute("aria-selected", "true");
  await expect(centre(win).locator(".aos-spc-h1")).toHaveText(o.title ?? name);
  const view = o.view ?? "Overview";
  if ((await tab(win, view).getAttribute("aria-selected")) !== "true") await tab(win, view).click();
  await expect(tab(win, view)).toHaveAttribute("aria-selected", "true");
}
/** The PR 2 helper: a workspace and a view. */
const openWorkspace = (win: Page, name: string, view: "Overview" | "Files") => pick(win, name, { view });

const treeRow = (win: Page, label: string) => centre(win).locator(".aos-spc-tree .aos-spc-trow", { has: win.locator(".aos-spc-tlabel", { hasText: new RegExp(`^${label.replace(/[.]/g, "\\.")}$`) }) });
const mapline = (win: Page) => centre(win).locator(".aos-spc-mapline");
const describe = (win: Page) => centre(win).locator("button.aos-spc-describe");

/** Opens More ⋯ on the dossier and chooses `key` (rename, pin, status, link, draft, copy, reveal, archive, restore). */
async function more(win: Page, key: string): Promise<void> {
  await head(win).locator("button[data-spc-key='more']").click();
  await expect(menu(win)).toBeVisible();
  await menuItem(win, key).click();
}

/** Opens the outside list and returns the row of the folder shown as `label` (~/… under the fixture's HOME). */
async function outsideRow(win: Page, label: string): Promise<Locator> {
  if (!(await centre(win).locator(".aos-spc-h1", { hasText: /^Outside workspaces$/ }).count())) await list(win).locator("button.aos-spc-outbtn").click();
  await expect(centre(win).locator(".aos-spc-h1")).toHaveText("Outside workspaces");
  return centre(win).locator("tbody tr", { has: win.locator(".aos-spc-outname", { hasText: new RegExp(`^${esc(label)}$`) }) });
}

/** The confirmation of a move (§6): its title, from → to, the plan's lines and the notes whose tag flips. */
async function expectPlan(win: Page, o: { title: string; from: string; to: string; items?: Array<string | RegExp>; notes?: string[] }): Promise<Locator> {
  const d = dialog(win, "mod-spc-confirm");
  await expect(d).toHaveAttribute("role", "alertdialog");
  await expect(d.locator(".aos-spc-dlgtitle")).toHaveText(o.title);
  await expect(d.locator(".aos-spc-movefrom")).toHaveText(o.from);
  await expect(d.locator(".aos-spc-moveto")).toHaveText(o.to);
  if (o.items) await expect(d.locator(".aos-spc-plan > .aos-spc-planlist > li")).toHaveText(o.items);
  if (o.notes) await expect(d.locator(".aos-spc-plannotes li")).toHaveText(o.notes);
  else await expect(d.locator(".aos-spc-plannotes")).toHaveCount(0);
  return d;
}

/** The terminal Code has selected: its folder, host and place, and the group its row sits under (`ws:<workspace>`). */
async function activeTerminal(win: Page): Promise<{ cwd: string; host: string; workspace: string | null; group: string | null } | null> {
  return win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { cwd: string; meta: { host: string; place: { workspace?: string } | null } } | undefined } } } }).aosHost.plugin.terminalPool;
    const t = p.get(p.selectedId() ?? "");
    // TermList draws heads and rows as flat siblings: the active row's nearest head before it.
    let n = document.querySelector(".aos-tl-row.aos-term-tab-active")?.previousElementSibling ?? null;
    while (n && !n.matches(".aos-tl-group")) n = n.previousElementSibling;
    return t ? { cwd: t.cwd, host: t.meta.host, workspace: t.meta.place?.workspace ?? null, group: n?.getAttribute("data-group") ?? null } : null;
  });
}
const count = (text: string, needle: string) => text.split(needle).length - 1;
/** A line as the terminals show it with every space and line break taken out: the shell's echo of a typed line wraps
 *  at the terminal's width. */
const squash = (s: string) => s.replace(/\s+/g, "");
const typed = (win: Page) => async () => squash(await terminalText(win));

// ── what main spawns, and the vault's tree ───────────────────────────

/**
 * Records every child main spawns from here on (ProcService and the Sessions turns go through node:child_process), so a
 * test can count the `aos` verbs the page ran: a Cancel must run none (§6). Installed once per app.
 */
async function trackSpawns(h: AppHandle): Promise<void> {
  await h.app.evaluate(() => {
    const g = globalThis as unknown as { __aosSpawns?: string[][] };
    if (g.__aosSpawns) return;
    g.__aosSpawns = [];
    const cp = process.getBuiltinModule("node:child_process") as typeof import("node:child_process");
    const spawn = cp.spawn;
    (cp as unknown as { spawn: (...a: unknown[]) => unknown }).spawn = function (this: unknown, ...a: unknown[]) {
      g.__aosSpawns!.push([String(a[0]), ...(Array.isArray(a[1]) ? (a[1] as unknown[]).map(String) : [])]);
      return (spawn as unknown as (...b: unknown[]) => unknown).apply(this, a);
    };
  });
}
/** The `aos` runs main spawned so far, each as its argv from the verb on (`workspace new tide-clock --pin --json`). */
async function aosRuns(h: AppHandle): Promise<string[][]> {
  const all = await h.app.evaluate(() => (globalThis as unknown as { __aosSpawns?: string[][] }).__aosSpawns ?? []);
  return all.filter((a) => /\/cli\/aos\.js$/.test(a[1] ?? "")).map((a) => a.slice(2));
}
const verbLines = async (h: AppHandle) => (await aosRuns(h)).map((a) => a.join(" "));

/**
 * The parts of the vault a verb may change (§6), as `path content-hash` lines: every file under workspaces/ (a
 * repository's .git as one entry), the project notes, the Sessions threads, TODO.md and the hidden list; the maps by
 * name only, since a background scan may rewrite a map in place but never moves one.
 */
function vaultTree(): string[] {
  const out: string[] = [];
  const walk = (rel: string, hash: boolean): void => {
    const abs = FX.v(rel);
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) { out.push(`${rel} -> ${fs.readlinkSync(abs)}`); return; }
    if (st.isDirectory()) {
      out.push(`${rel}/`);
      for (const n of fs.readdirSync(abs).sort()) { if (n === ".git") out.push(`${rel}/.git/`); else walk(`${rel}/${n}`, hash); }
      return;
    }
    out.push(hash ? `${rel} ${createHash("sha1").update(fs.readFileSync(abs)).digest("hex")}` : rel);
  };
  for (const rel of ["workspaces", "brain/memory/projects", "brain/_index/sessions", "TODO.md", "brain/_index/workspaces-hidden.json"]) walk(rel, true);
  walk("brain/_index/workspace-maps", false);
  return out;
}
const manifest = (name: string) => { try { return fs.readFileSync(FX.v(`workspaces/${name}/workspace.md`), "utf8"); } catch { return null; } };

// ── the fixture additions: outside folders on disk, and the repository a clone fetches ──

/** A Codex rollout as Codex writes it (sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl), started in `cwd` `ms` ago. */
function rollout(id: string, cwd: string, ms: number, prompt: string): void {
  const d = new Date(Date.now() - ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const file = path.join(FX.home, ".codex", "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()), `rollout-${d.toISOString().slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`);
  const rec = (t: Date, type: string, payload: unknown) => JSON.stringify({ timestamp: t.toISOString(), type, payload });
  const t1 = new Date(d.getTime() + 2000);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${[
    rec(d, "session_meta", { id, cwd, timestamp: d.toISOString(), originator: "codex_cli_rs", source: "cli" }),
    rec(t1, "turn_context", { cwd, approval_policy: "on-request", sandbox_policy: { mode: "workspace-write" }, model: "gpt-5-codex", effort: "medium" }),
    rec(t1, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }),
  ].join("\n")}\n`);
  fs.utimesSync(file, t1, t1);
}

/** Two folders on disk outside the vault where a Codex session ran: one named like a workspace (Adopt into
 *  kelp-watch), one like none (the pickers). */
const KELP_DIR = path.join(FX.home, "code", "kelp-watch");
const SCRIPTS_DIR = path.join(FX.home, "code", "tide-scripts");

/** The repository Clone from GitHub fetches instead of github.com (the app's git rewrites the URL; CLONE_ENV). */
const CLONE_SRC = path.join(FX.root, "clone-src", "harbor-tiles");
const CLONE_URL = "https://github.com/example/harbor-tiles";
const CLONE_README = "# Harbor Tiles\n\nChart tiles for the harbor viewer, cut to 256 px.\n";
/** The app's environment for the clone: its git (the terminal's and the runtime's) maps the GitHub URL onto CLONE_SRC
 *  and allows the file transport only, so nothing here can reach the network. */
const CLONE_ENV = {
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${CLONE_SRC}.insteadOf`, GIT_CONFIG_VALUE_0: CLONE_URL, GIT_ALLOW_PROTOCOL: "file",
};

function makeCloneSource(): void {
  fs.rmSync(CLONE_SRC, { recursive: true, force: true });
  fs.mkdirSync(CLONE_SRC, { recursive: true });
  fs.writeFileSync(path.join(CLONE_SRC, "README.md"), CLONE_README);
  // An identity and a date set here, and no system or user git config read, so no address sits anywhere.
  const env = { ...process.env, HOME: FX.home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "" };
  const git = (...a: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...a], { cwd: CLONE_SRC, env, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "Cut the first tiles");
}

/** The runtime's scan, as the app's background refresh runs it: the snapshot then lists the folders added here. */
function rescan(): void {
  const r = spawnSync(process.execPath, [FX.v("brain/scripts/scan-vault.js"), "--quiet"], { cwd: FX.vault, env: appEnv(), encoding: "utf8", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`scan-vault.js exited ${r.status}: ${r.stderr}`);
}

function prepareActions(): void {
  fs.mkdirSync(KELP_DIR, { recursive: true });
  fs.writeFileSync(path.join(KELP_DIR, "counts.csv"), "site,count\nnorth,12\n");
  rollout("0199a1b2-0000-4000-8000-0000000000a1", KELP_DIR, 26 * 3_600_000, "Tally the kelp counts from the north site");
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCRIPTS_DIR, "fetch.sh"), "#!/bin/sh\necho tides\n");
  rollout("0199a1b2-0000-4000-8000-0000000000a2", SCRIPTS_DIR, 50 * 3_600_000, "Write a script that fetches the tide tables");
  makeCloneSource();
  rescan();
}

// ── the Spaces surface on ────────────────────────────────────────────

test.describe("the Spaces surface on", () => {
  const app = useApp({ env: { AOS_APP_WRITE: "spaces", ...CLONE_ENV }, prepare: prepareActions });

  test.beforeEach(async () => {
    await trackSpawns(app());
    await openTab(app().win, "spaces");
  });

  test.afterEach(async () => {
    // The tab writes nothing itself, and every spawn it made ran.
    expect(await guardWrites(app())).toEqual([]);
    expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
    expectNoErrors(app());
  });

  test("Spaces is the one surface on: the status bar names it and what it may run (its scripts and the aos workspace verbs)", async () => {
    const { win } = app();
    const mode = win.locator(".aos-host-status .aos-host-mode");
    await expect(mode).toHaveText("WRITES: Spaces");
    await expect(mode).toHaveAttribute("title", /^Spaces: map-workspace\.js, regen-workspace-insight\.js, cli\/aos\.js\n/);
  });

  test("Describe N new describes the files the map has not (heuristically under `none`), and the Files tree catches up", async () => {
    const { win } = app();
    // A map as a budget-limited run leaves it: one file not described yet.
    const map = pristineMap("harbor-map");
    const tides = map.files.find((f) => f.path === "src/tides.js")!;
    Object.assign(tides, { desc: null, descAt: null, descSource: null, status: "new" });
    map.pending = 1;
    fs.writeFileSync(mapFile("harbor-map"), `${JSON.stringify(map, null, 2)}\n`);

    await openWorkspace(win, "harbor-map", "Files");
    await expect(tab(win, "Files").locator(".aos-spc-badge")).toHaveText("1 undescribed");
    await expect(mapline(win)).toHaveText(/^4 of 5 described · /);
    // The folder carries the NEW of what is under it; the file its own, with its empty description (D9, D19: NEW info).
    await expect(treeRow(win, "src").locator(".aos-spc-badge")).toHaveText("NEW");
    await treeRow(win, "src").click();
    await expect(treeRow(win, "tides.js").locator(".aos-spc-badge")).toHaveText("NEW");
    await expect(treeRow(win, "tides.js").locator(".aos-spc-badge")).toHaveClass(/is-new/);
    await expect(treeRow(win, "tides.js").locator(".aos-spc-tdesc")).toHaveText("Not described yet");
    await expect(describe(win)).toHaveText("Describe 1 new");
    await expect(describe(win)).toHaveAttribute("title", "Describes the new files within the scan's budgets, with the heuristic: no model provider is set up");
    await describe(win).click();
    await expect(notices(win)).toContainText("▶ map-workspace.js harbor-map");

    await expect.poll(() => readMap("harbor-map")?.pending, { timeout: 30_000 }).toBe(0);
    const r = readMap("harbor-map")!.files.find((f) => f.path === "src/tides.js")!;
    // The heuristic description is the one the fixture's own scan wrote.
    const want = pristineMap("harbor-map").files.find((f) => f.path === "src/tides.js")!;
    expect(r).toMatchObject({ desc: want.desc, descSource: "heuristic", status: "fresh" });
    await expect(mapline(win)).toHaveText(/^5 of 5 described · /);
    await expect(treeRow(win, "tides.js").locator(".aos-spc-tdesc")).toHaveText(want.desc!);
    await expect(centre(win).locator(".aos-spc-tree .aos-spc-badge")).toHaveCount(0);
    await expect(describe(win)).toHaveText("Nothing new");
    await expect(describe(win)).toBeDisabled();
    await expect(tab(win, "Files").locator(".aos-spc-badge")).toHaveCount(0);
  });

  test("a workspace with no map yet offers Map now; its files are NEW until it runs, and it writes the map", async () => {
    const { win } = app();
    fs.rmSync(mapFile("field-notes"));
    await openWorkspace(win, "field-notes", "Files");
    await expect(mapline(win)).toHaveText("No map yet: run a scan, or map this workspace now. Map now");
    // The live listing still shows the folder: a file the map has not seen is NEW, and the one Describe counts.
    await expect(treeRow(win, "README.md").locator(".aos-spc-badge")).toHaveText("NEW");
    await expect(treeRow(win, "README.md").locator(".aos-spc-tdesc")).toHaveText("Not described yet");
    await expect(describe(win)).toHaveText("Describe 1 new");
    await mapline(win).locator("button", { hasText: "Map now" }).click();
    await expect(notices(win)).toContainText("▶ map-workspace.js field-notes");
    await expect.poll(() => readMap("field-notes")?.pending, { timeout: 30_000 }).toBe(0);
    const want = pristineMap("field-notes").files.map((f) => ({ path: f.path, desc: f.desc, descSource: f.descSource }));
    expect(readMap("field-notes")!.files.map((f) => ({ path: f.path, desc: f.desc, descSource: f.descSource }))).toEqual(want);
    await expect(mapline(win)).toHaveText(/^1 of 1 described · /);
    await expect(treeRow(win, "README.md").locator(".aos-spc-tdesc")).toHaveText(want[0].desc!);
    await expect(treeRow(win, "README.md").locator(".aos-spc-badge")).toHaveCount(0);
  });

  test("↻ per file is off under `none` and says why (D33): in the tree and in the preview, and nothing runs", async () => {
    const { win } = app();
    await openWorkspace(win, "harbor-map", "Files");
    const re = treeRow(win, "README.md").locator("button.aos-spc-redesc");
    await expect(re).toBeDisabled();
    await expect(re).toHaveAttribute("title", "Needs a model provider");
    await treeRow(win, "README.md").click();
    const prev = C(win).locator(".aos-spc-right .aos-spc-preview");
    await expect(prev.locator(".aos-spc-prevname")).toHaveText("README.md");
    await expect(prev.locator("button.aos-spc-redesc")).toBeDisabled();
    await expect(prev.locator(".aos-spc-prevdesc .aos-spc-why")).toHaveText("Needs a model provider");
  });

  test("with a provider on record ↻ describes one file: map-workspace.js --file runs, and the runtime's forced `none` stops it before any model call", async () => {
    const { win } = app();
    const stateFile = FX.v("brain/_index/provider-state.json");
    const state = fs.readFileSync(stateFile, "utf8");
    const before = fs.readFileSync(mapFile("harbor-map"), "utf8");
    const was = fileMapRun()?.startedAt ?? null;
    try {
      // What the HUD reads to decide (D33); the runtime decides again from the vault's own config, forced to `none` here.
      fs.writeFileSync(stateFile, `${JSON.stringify({ ...JSON.parse(state), name: "ollama", reason: "fixture" }, null, 2)}\n`);
      await openTab(win, "pulse");
      await openTab(win, "spaces");
      await openWorkspace(win, "harbor-map", "Files");
      const r = treeRow(win, "README.md");
      const re = r.locator("button.aos-spc-redesc");
      await expect(re).toBeEnabled();
      await expect(re).toHaveAttribute("title", "Describe README.md again");
      await r.hover();
      await re.click();
      await expect(notices(win)).toContainText("▶ map-workspace.js harbor-map --file README.md");
      // The ledger writes lastRun twice (lib/pipeline-report.js): at the start, status "running" with the new startedAt, then
      // the outcome. Wait for a run that started after the click AND ended: reading at the first write saw "running".
      // spaces-redesign D33: the one-file call goes through the provider as feature `file-map`, so under the fixture's
      // `aos init --provider none` it stops before any model call and says so.
      await expect.poll(() => { const l = fileMapRun(); return l && l.startedAt !== was && l.status !== "running" ? l : null; }, { timeout: 30_000 })
        .toMatchObject({ status: "error", error: "no model provider to describe README.md (forced)" });
      expect(fs.readFileSync(mapFile("harbor-map"), "utf8")).toBe(before);
    } finally {
      fs.writeFileSync(stateFile, state);
    }
  });

  test("↻ on the read regenerates the insight (heuristic under `none`), and the pick-up card's read shows it", async () => {
    const { win } = app();
    await openWorkspace(win, "harbor-map", "Overview");
    const was = insight("harbor-map").generatedAt;
    const read = centre(win).locator(".aos-spc-pickval[data-row='read']");
    await read.locator("button.aos-spc-regen").click();
    await expect(notices(win)).toContainText("Regenerating insight for harbor-map…");
    await expect.poll(() => insight("harbor-map").generatedAt, { timeout: 30_000 }).not.toBe(was);
    expect(insight("harbor-map")).toMatchObject({ status: "ok", model: "heuristic" });
    await expect(read.locator(".aos-spc-readtext")).toHaveText(insight("harbor-map").text!);
    await expect(read.locator(".aos-spc-readsrc")).toHaveText(/^heuristic · (now|\d+m)$/);
  });

  test("with only Spaces on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
    const h = app();
    const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
    await openTab(h.win, "todo");
    await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
    await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
    expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
    await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
  });

  // ── PR 3: the actions ──

  test("+ to-do and Link to-dos… are off with \"Needs the To-Do surface's writes\" while that surface cannot write TODO.md (D35), and TODO.md stays byte for byte", async () => {
    const h = app();
    // Spawns since the app started include other tests' (one app per describe): count from here.
    const runs0 = (await aosRuns(h)).length;
    const before = fs.readFileSync(FX.v("TODO.md"));
    await pick(h.win, "harbor-map");
    const g = todoGroup(h.win);
    // The heading stays at zero (only the number is hidden), so the helpers are always where they belong.
    await expect(g.locator(".aos-spc-lhead .aos-spc-lname")).toHaveText("To-do");
    await expect(g.locator(".aos-spc-lhead .aos-spc-mono")).toHaveCount(0);
    for (const b of [g.locator("button.aos-spc-ladd"), g.locator("button.aos-spc-llink")]) {
      await expect(b).toBeDisabled();
      await expect(b).toHaveAttribute("title", "Needs the To-Do surface's writes");
    }
    await expect(g.locator("button.aos-spc-ladd")).toHaveText("+ to-do");
    await expect(g.locator("button.aos-spc-llink")).toHaveText("Link to-dos…");
    // A disabled button's title is not read out: the reason is on the page too.
    await expect(g.locator(".aos-spc-lwhy")).toHaveText("Needs the To-Do surface's writes");
    await expect(dialog(h.win, "mod-spc-todo")).toHaveCount(0);
    expect(fs.readFileSync(FX.v("TODO.md")).equals(before)).toBe(true);
    expect((await aosRuns(h)).slice(runs0)).toEqual([]);
  });

  test("every confirmation names what moves and where (the threads, the notes whose tag flips); its Cancel spawns nothing and leaves the tree as it was", async () => {
    const h = app();
    const { win } = h;
    const runs = (await aosRuns(h)).length;
    const tree = vaultTree();

    // Archive: from → to, the map, the project note whose status/ tag flips (harbor-map's, linked by its slug; spaces-redesign D17).
    await pick(win, "harbor-map");
    await more(win, "archive");
    let d = await expectPlan(win, {
      title: "Archive harbor-map?", from: "workspaces/harbor-map", to: "workspaces/_archive/harbor-map",
      items: [
        "Moves workspaces/harbor-map to workspaces/_archive/harbor-map",
        "Moves its file map to brain/_index/workspace-maps/_archive/",
        "Marks its project memory archived: status/active becomes status/archived in 1 note",
        /^Keeps its (\d+ sessions?|sessions) and (its )?git history attached$/,
      ],
      notes: ["Harbor Map"],
    });
    await expect(d.locator(".aos-spc-dlgnote")).toHaveText("Restore it any time: show archived and _ folders, then More › Restore…");
    await expect(d.locator("button.aos-spc-confirm")).toHaveText("Archive");
    // It opens on Cancel (a stray Enter never starts the move), names the plan for a screen reader, and gives the
    // keyboard back to More when it closes.
    await expect(d.locator("button.aos-spc-cancel")).toBeFocused();
    expect(await d.evaluate((m) => !!document.getElementById(m.getAttribute("aria-describedby") ?? "")?.classList.contains("aos-spc-plan"))).toBe(true);
    await d.locator("button.aos-spc-cancel").click();
    await expect(d).toHaveCount(0);
    await expect(head(win).locator("button[data-spc-key='more']")).toBeFocused();

    // Rename: the new name, typed; what moves follows it; Escape cancels.
    await more(win, "rename");
    d = dialog(win, "mod-spc-confirm");
    const input = d.locator("input[data-spc-field='rename']");
    await expect(input).toHaveValue("harbor-map");
    await expect(d.locator(".aos-spc-fhint")).toHaveText("That is its name now");
    await expect(d.locator("button.aos-spc-confirm")).toBeDisabled();
    await input.fill("Harbor Chart");
    await expectPlan(win, {
      title: "Rename harbor-map", from: "workspaces/harbor-map", to: "workspaces/harbor-chart",
      items: ["Moves workspaces/harbor-map to workspaces/harbor-chart", "Moves its file map", "Records workspaces/harbor-map under aliases:, so its past sessions, to-dos and notes still count here"],
    });
    await expect(d.locator(".aos-spc-fhint")).toHaveText("workspaces/harbor-chart");
    // Claude Code resumes a thread from another folder (spaces-redesign D7's build check), so there is no "may not resume" warning.
    await expect(d.locator(".aos-spc-planwarn")).toHaveCount(0);
    await expect(d.locator("button.aos-spc-confirm")).toBeEnabled();
    await input.press("Escape");
    await expect(d).toHaveCount(0);

    // Restore: the fixture's archived workspace, back to workspaces/<n>; a click outside cancels.
    await showHidden(win);
    await pick(win, "_archive/pier-repairs", { title: "pier-repairs" });
    await more(win, "restore");
    d = await expectPlan(win, {
      title: "Restore pier-repairs?", from: "workspaces/_archive/pier-repairs", to: "workspaces/pier-repairs",
      items: [
        "Moves workspaces/_archive/pier-repairs back to workspaces/pier-repairs",
        "Moves its file map back to brain/_index/workspace-maps/",
        "No project note names it by workspace: or slug, so no tag changes",
      ],
    });
    await win.locator(".modal-container .modal-bg").click({ position: { x: 4, y: 4 } });
    await expect(d).toHaveCount(0);
    await hideHidden(win);

    // Adopt: a vanished folder whose name matches no workspace picks the workspace first; the ✕ cancels.
    const sketches = await outsideRow(win, "~/sketches");
    await sketches.locator("button.aos-spc-adoptbtn").click();
    await expect(menu(win).locator(".aos-spc-poplabel")).toHaveText(["Adopt into a workspace…", "Link as code folder of…", "Hide"]);
    await expect(menuItem(win, "link")).toHaveAttribute("aria-disabled", "true");
    await expect(menuItem(win, "link").locator(".aos-spc-popdetail")).toHaveText("The folder no longer exists");
    await menuItem(win, "adopt").click();
    const picker = win.locator(".modal.prompt");
    // The folder and the action as a line of their own and the input's name, never only a placeholder.
    await expect(picker.locator(".aos-spc-pickhead")).toHaveText("Adopt ~/sketches into…");
    await expect(picker.locator("input.prompt-input")).toHaveAttribute("aria-label", "Adopt ~/sketches into…");
    await expect(picker.locator("input.prompt-input")).toHaveAttribute("placeholder", "Type a workspace name");
    await picker.locator("input.prompt-input").fill("harbor");
    await picker.locator(".suggestion-item", { hasText: /^harbor-map$/ }).click();
    d = await expectPlan(win, {
      title: "Adopt ~/sketches into harbor-map?", from: "~/sketches", to: "harbor-map (alias)",
      items: ["Records ~/sketches under harbor-map's aliases: in its workspace.md", "Moves nothing: the folder stays where it is", "Its 1 session counts toward harbor-map after the next scan"],
    });
    await expect(d.locator(".aos-spc-dlgnote")).toHaveText("Adopting from Spaces never moves a folder: aos workspace adopt without --into, in a terminal, still does.");
    await d.locator(".modal-close-button").click();
    await expect(d).toHaveCount(0);
    await centre(win).locator("button[data-spc-key='outside-close']").click();

    // Nothing ran and nothing moved.
    expect((await aosRuns(h)).length).toBe(runs);
    expect(vaultTree()).toEqual(tree);
  });

  test("New space: Blank folder runs `aos workspace new <slug> --pin`, writes the stubs pinned, and starts the chosen host in ws:<slug>", async () => {
    const h = app();
    const { win } = h;
    const stubs = count(await terminalText(win), "[fixture claude stub]");
    await list(win).locator("button.aos-spc-newbtn").click();
    const d = dialog(win, "mod-spc-new");
    await expect(d.locator(".aos-spc-dlgtitle")).toHaveText("New space");
    const name = d.locator("input[data-spc-field='name']");
    await expect(name).toBeFocused();
    // Blank folder is the default; Open with lists the hosts that are on (Codex is off here) and Terminal, on ⌘T's host.
    await expect(d.locator(".aos-spc-choice[data-template='blank'] input")).toBeChecked();
    await expect(d.locator(".aos-spc-hostopt")).toHaveText(["Claude Code", "Terminal"]);
    await expect(d.locator(".aos-spc-hostopt[data-host='claude'] input")).toBeChecked();
    await expect(d.locator(".aos-spc-clonefield")).toHaveClass(/is-hidden/);
    await name.fill("Tide Clock");
    await expect(d.locator("[data-spc-field='where']")).toHaveText(FX.v("workspaces/tide-clock"));
    await expect(d.locator(".aos-spc-dlgnote")).toHaveText("Pinned, then opened in Code with Claude Code.");
    await d.locator("button.aos-spc-confirm", { hasText: "Create space" }).click();
    await expect(d).toHaveCount(0);

    expect(await verbLines(h)).toContain("workspace new tide-clock --pin --json");
    const dir = FX.v("workspaces/tide-clock");
    for (const f of ["README.md", "CLAUDE.md", "AGENTS.md"]) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    expect(manifest("tide-clock")).toMatch(/^pinned: true$/m);
    // Code, in the new workspace's group, with the host's line typed (the fixture's stub `claude` echoes it).
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    await expect.poll(async () => count(await terminalText(win), "[fixture claude stub]"), { timeout: 10_000 }).toBeGreaterThan(stubs);
    expect(await activeTerminal(win)).toEqual({ cwd: dir, host: "claude", workspace: "tide-clock", group: "ws:tide-clock" });
    // Back in Spaces it is selected, pinned at the top.
    await openTab(win, "spaces");
    await expect(row(win, "tide-clock")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(list(win).locator(".aos-spc-ghead .aos-spc-glabel").first()).toHaveText("PINNED");
    await expect(pinnedRow(win, "tide-clock")).toHaveCount(1);
  });

  test("New space: Code repo adds --git, and the line typed in its terminal carries the git init guard", async () => {
    const h = app();
    const { win } = h;
    await list(win).locator("button.aos-spc-newbtn").click();
    const d = dialog(win, "mod-spc-new");
    await d.locator("input[data-spc-field='name']").fill("chart-diff");
    await d.locator(".aos-spc-choice[data-template='code'] input").check();
    await expect(d.locator(".aos-spc-dlgnote")).toHaveText("Pinned, then opened in Code with Claude Code after git init.");
    await d.locator("button.aos-spc-confirm").click();
    await expect(d).toHaveCount(0);
    expect(await verbLines(h)).toContain("workspace new chart-diff --git --pin --json");
    const dir = FX.v("workspaces/chart-diff");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);   // the runtime's `git init`
    expect(manifest("chart-diff")).toMatch(/^pinned: true$/m);
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    // `--git` made the repository; the typed guard is a no-op then, and covers a runtime that leaves it to the terminal.
    await expect.poll(typed(win), { timeout: 10_000 }).toContain(squash("[ -e .git ] || git init -q;"));
    await expect.poll(() => activeTerminal(win)).toEqual({ cwd: dir, host: "claude", workspace: "chart-diff", group: "ws:chart-diff" });
  });

  test("New space: Clone from GitHub types the clone line in a shell (no network), and Start <host> here waits for the line to end", async () => {
    const h = app();
    const { win } = h;
    await list(win).locator("button.aos-spc-newbtn").click();
    const d = dialog(win, "mod-spc-new");
    await d.locator("input[data-spc-field='name']").fill("Harbor Tiles");
    await d.locator(".aos-spc-choice[data-template='clone'] input").check();
    await expect(d.locator(".aos-spc-clonefield")).not.toHaveClass(/is-hidden/);
    const url = d.locator("input[data-spc-field='url']");
    const ok = d.locator("button.aos-spc-confirm");
    await expect(ok).toHaveText("Create and clone");
    await expect(ok).toBeDisabled();
    // The URL rule (spaces-redesign D15): a GitHub repository only, never another host, a `..` or an option-shaped value.
    for (const bad of ["https://gitlab.com/example/harbor-tiles", "https://github.com/example/..", "--upload-pack=touch x", "ext::sh -c touch% x"]) {
      await url.fill(bad);
      await expect(d.locator(".aos-spc-clonefield .aos-spc-fhint")).toHaveText("A GitHub repository: https://github.com/<owner>/<repo>, or its SSH form ending in .git");
      await expect(ok).toBeDisabled();
    }
    await url.fill(CLONE_URL);
    await expect(d.locator(".aos-spc-clonefield .aos-spc-fhint")).toHaveText("Cloned in a Code terminal you can see; nothing runs in the background.");
    await expect(d.locator(".aos-spc-dlgnote")).toHaveText("No agent starts in a fresh clone: when the clone line ends, the dossier offers Start Claude Code here.");
    const agents = count(await terminalText(win), "[fixture claude stub]");
    await ok.click();
    await expect(d).toHaveCount(0);
    // An empty, unpinned folder first; then the line in a visible shell, the URL quoted, the slug the runtime answered.
    expect(await verbLines(h)).toContain("workspace new harbor-tiles --empty --json");
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    await expect.poll(typed(win), { timeout: 10_000 }).toContain(squash(`git clone -- '${CLONE_URL}' . && aos workspace stubs harbor-tiles --pin`));
    expect((await activeTerminal(win))?.host).toBe("shell");
    // The app's git fetched the repository made on disk, and the line's last step wrote the stubs and the pin.
    const dir = FX.v("workspaces/harbor-tiles");
    await expect.poll(() => manifest("harbor-tiles"), { timeout: 30_000 }).toMatch(/^pinned: true$/m);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe(CLONE_README);   // the clone's, kept
    for (const f of ["CLAUDE.md", "AGENTS.md"]) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
    // No agent started on its own in the fresh clone (spaces-redesign D15).
    expect(count(await terminalText(win), "[fixture claude stub]")).toBe(agents);

    await openTab(win, "spaces");
    await expect(row(win, "harbor-tiles")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    const card = head(win).locator(".aos-spc-clone");
    await expect(card.locator(".aos-spc-clonetext")).toHaveText(`Cloned ${CLONE_URL} into harbor-tiles.`);
    const start = card.locator("button[data-spc-key='clone-start']");
    await expect(start).toHaveText("Start Claude Code here");
    await expect(start).toBeEnabled();
    await start.click();
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    await expect.poll(async () => count(await terminalText(win), "[fixture claude stub]"), { timeout: 10_000 }).toBeGreaterThan(agents);
    expect(await activeTerminal(win)).toEqual({ cwd: dir, host: "claude", workspace: "harbor-tiles", group: "ws:harbor-tiles" });
    await openTab(win, "spaces");
    await expect(head(win).locator(".aos-spc-clone")).toHaveCount(0);   // started: the card is gone
  });

  test("Adopt into records an alias and moves nothing, and the rescan credits the folder to the workspace (D16)", async () => {
    const h = app();
    const { win } = h;
    const r = await outsideRow(win, "~/code/kelp-watch");
    await expect(r.locator(".aos-spc-outmatch button")).toHaveText("kelp-watch");
    await expect(r.locator(".aos-spc-outhosts")).toHaveText("codex 1");
    await r.locator("button.aos-spc-adoptbtn").click();
    await expect(menu(win).locator(".aos-spc-poplabel")).toHaveText(["Adopt into kelp-watch", "Link as code folder of kelp-watch", "Hide"]);
    await expect(menuItem(win, "adopt").locator(".aos-spc-popdetail")).toHaveText("Records this folder as an alias: its sessions count there; nothing moves");
    await menuItem(win, "adopt").click();
    const d = await expectPlan(win, {
      title: "Adopt ~/code/kelp-watch into kelp-watch?", from: "~/code/kelp-watch", to: "kelp-watch (alias)",
      items: ["Records ~/code/kelp-watch under kelp-watch's aliases: in its workspace.md", "Moves nothing: the folder stays where it is", "Its 1 session counts toward kelp-watch after the next scan"],
    });
    await d.locator("button.aos-spc-confirm", { hasText: "Adopt" }).click();
    await expect(d).toHaveCount(0);
    await expect(notices(win)).toContainText("~/code/kelp-watch is now an alias of kelp-watch: its sessions count there after the scan");
    expect(await verbLines(h)).toContain(`workspace adopt ${KELP_DIR} --into kelp-watch --json`);
    // An alias in workspace.md; the folder and its file where they were.
    expect(manifest("kelp-watch")).toMatch(/^aliases:\n\s+- "?~\/code\/kelp-watch"?$/m);
    expect(fs.readFileSync(path.join(KELP_DIR, "counts.csv"), "utf8")).toBe("site,count\nnorth,12\n");
    // The rescan: the folder leaves the outside list, and its session counts for kelp-watch.
    await expect(r).toHaveCount(0, { timeout: 30_000 });
    await pick(win, "kelp-watch");
    await expect(row(win, "kelp-watch").locator(".aos-spc-hostcount")).toHaveText("codex 1");
  });

  test("Link as code folder of… picks the workspace for a folder that matches none, and sets repo: through aos workspace set (D24)", async () => {
    const h = app();
    const { win } = h;
    const before = manifest("reef-survey");
    const r = await outsideRow(win, "~/code/tide-scripts");
    await expect(r.locator(".aos-spc-outmatch")).toHaveText("—");
    await r.locator("button.aos-spc-adoptbtn").click();
    await expect(menu(win).locator(".aos-spc-poplabel")).toHaveText(["Adopt into a workspace…", "Link as code folder of…", "Hide"]);
    await menuItem(win, "link").click();
    const picker = win.locator(".modal.prompt");
    await expect(picker.locator(".aos-spc-pickhead")).toHaveText("Link ~/code/tide-scripts as the code folder of…");
    await expect(picker.locator("input.prompt-input")).toHaveAttribute("aria-label", "Link ~/code/tide-scripts as the code folder of…");
    // A workspace that is a repository of its own takes no code folder: buoy-log is not offered.
    await expect(picker.locator(".suggestion-item", { hasText: /^reef-survey$/ })).toHaveCount(1);
    await expect(picker.locator(".suggestion-item", { hasText: /^buoy-log$/ })).toHaveCount(0);
    await picker.locator("input.prompt-input").fill("reef");
    await picker.locator(".suggestion-item", { hasText: /^reef-survey$/ }).click();
    await expect(notices(win)).toContainText("reef-survey's code folder is ~/code/tide-scripts: terminals there start in it");
    // Compare-and-set on the file as it was: no workspace.md yet, so --expect none.
    const expectHash = before === null ? "none" : createHash("sha256").update(before).digest("hex");
    expect(await verbLines(h)).toContain(`workspace set reef-survey --set {"repo":"~/code/tide-scripts"} --expect ${expectHash} --json`);
    expect(manifest("reef-survey")).toMatch(/^repo: "?~\/code\/tide-scripts"?$/m);
    expect(fs.existsSync(path.join(SCRIPTS_DIR, "fetch.sh"))).toBe(true);
    await pick(win, "reef-survey");
    await expect(head(win).locator(".aos-spc-metacode")).toHaveText("code → ~/code/tide-scripts");
  });

  test("Hide, then Unhide: the folder leaves the outside list into HIDDEN (n), and comes back", async () => {
    const h = app();
    const { win } = h;
    const hidden = FX.v("brain/_index/workspaces-hidden.json");
    const r = await outsideRow(win, "/opt/sample/sandbox");
    await expect(r).toHaveClass(/is-gone/);
    await r.locator("button.aos-spc-adoptbtn").click();
    await menuItem(win, "hide").click();
    await expect(notices(win)).toContainText("/opt/sample/sandbox is hidden: Unhide under Hidden brings it back");
    expect(await verbLines(h)).toContain("workspace hide /opt/sample/sandbox --json");
    await expect(r).toHaveCount(0, { timeout: 30_000 });
    const hid = centre(win).locator(".aos-spc-hiddenlist");
    await expect(hid.locator(".aos-spc-h3")).toHaveText("HIDDEN (1)");
    await expect(hid.locator(".aos-spc-hidrow .aos-spc-outname")).toHaveText(["/opt/sample/sandbox"]);
    expect(fs.readFileSync(hidden, "utf8")).toContain("/opt/sample/sandbox");
    await hid.locator("button", { hasText: "Unhide" }).click();
    await expect(centre(win).locator(".aos-spc-hiddenlist")).toHaveCount(0);
    expect(await verbLines(h)).toContain("workspace unhide /opt/sample/sandbox --json");
    await expect(await outsideRow(win, "/opt/sample/sandbox")).toHaveCount(1, { timeout: 30_000 });
    expect(fs.existsSync(hidden) ? fs.readFileSync(hidden, "utf8") : "").not.toContain("/opt/sample/sandbox");
    await centre(win).locator("button[data-spc-key='outside-close']").click();
  });

  test("Pin and the status menu write only their key in workspace.md; a pinned workspace leads the list, a paused one sits in IDLE with its word (D18)", async () => {
    const h = app();
    const { win } = h;
    await pick(win, "harbor-map");
    const original = manifest("harbor-map")!;
    const lines = (s: string | null) => (s ?? "").split("\n");
    const pill = head(win).locator("button[data-spc-key='status']");
    await expect(pill).toHaveAttribute("aria-haspopup", "menu");
    await expect(pill.locator(".aos-spc-pillword")).toHaveText("active");   // set in workspace.md
    await pill.click();
    await expect(menu(win).locator(".aos-spc-poplabel")).toHaveText(["Automatic", "Active ✓", "Paused", "Done"]);
    await expect(menu(win).locator(".aos-spc-popitem[role='menuitemradio']")).toHaveCount(4);
    await expect(menuItem(win, "status:active")).toHaveAttribute("aria-checked", "true");
    await menuItem(win, "status:paused").click();
    await expect(notices(win)).toContainText("harbor-map is paused");
    await expect.poll(() => manifest("harbor-map")).toMatch(/^status: paused$/m);
    // Only the status line changed: the other keys and the body stay as written.
    expect(lines(manifest("harbor-map")).filter((l) => !/^status:/.test(l))).toEqual(lines(original).filter((l) => !/^status:/.test(l)));
    await expect(head(win).locator(".aos-spc-pillword")).toHaveText("paused");
    await expect(group(win, "IDLE")).toHaveAttribute("aria-expanded", "true");
    await expect(row(win, "harbor-map").locator(".aos-spc-statustag")).toHaveText("paused");

    // Automatic removes the key: the scan's word comes back, marked auto.
    await head(win).locator("button[data-spc-key='status']").click();
    await menuItem(win, "status:auto").click();
    await expect(notices(win)).toContainText("harbor-map's status is automatic again");
    await expect.poll(() => manifest("harbor-map")).not.toMatch(/^status:/m);
    expect(lines(manifest("harbor-map"))).toEqual(lines(original).filter((l) => !/^status:/.test(l)));
    await expect(head(win).locator(".aos-spc-pillauto")).toHaveText("· auto");

    // Pin: `pinned: true`, the row under PINNED at the top; again, and it goes back to its status group.
    const pin = head(win).locator("button[data-spc-key='pin']");
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    const unpinned = manifest("harbor-map");
    await pin.click();
    await expect(notices(win)).toContainText("harbor-map is pinned");
    await expect.poll(() => manifest("harbor-map")).toMatch(/^pinned: true$/m);
    expect(lines(manifest("harbor-map")).filter((l) => !/^pinned:/.test(l))).toEqual(lines(unpinned));
    await expect(head(win).locator("button[data-spc-key='pin']")).toHaveAttribute("aria-pressed", "true");
    // PINNED leads the list (the New space tests' pinned workspaces may be there too).
    await expect(list(win).locator(".aos-spc-ghead .aos-spc-glabel").first()).toHaveText("PINNED");
    await expect(pinnedRow(win, "harbor-map")).toHaveCount(1);
    await head(win).locator("button[data-spc-key='pin']").click();
    await expect(notices(win)).toContainText("harbor-map is unpinned");
    await expect.poll(() => manifest("harbor-map")).not.toMatch(/^pinned: true$/m);
    await expect(head(win).locator("button[data-spc-key='pin']")).toHaveAttribute("aria-pressed", "false");
    await expect(pinnedRow(win, "harbor-map")).toHaveCount(0, { timeout: 30_000 });
    await expect(row(win, "harbor-map")).toHaveCount(1);
    const sets = (await aosRuns(h)).filter((a) => a[0] === "workspace" && a[1] === "set" && a[2] === "harbor-map").map((a) => a[4]);
    expect(sets).toEqual(['{"status":"paused"}', '{"status":""}', '{"pinned":true}', '{"pinned":false}']);
  });

  test("Archive, then Restore: the folder, its map and archived: move to workspaces/_archive/ and back; the entry shows under archived and _ folders (D17)", async () => {
    const h = app();
    const { win } = h;
    await pick(win, "buoy-log");
    await more(win, "archive");
    const d = await expectPlan(win, {
      title: "Archive buoy-log?", from: "workspaces/buoy-log", to: "workspaces/_archive/buoy-log",
      items: [
        "Moves workspaces/buoy-log to workspaces/_archive/buoy-log",
        "Moves its file map to brain/_index/workspace-maps/_archive/",
        "No project note names it by workspace: or slug, so no tag changes",
        /^Keeps its (\d+ sessions?|sessions) and (its )?git history attached$/,
      ],
    });
    await d.locator("button.aos-spc-confirm", { hasText: "Archive" }).click();
    await expect(d).toHaveCount(0);
    await expect(notices(win)).toContainText("Archived buoy-log: Show archived and _ folders lists it, and More › Restore… brings it back");
    expect(await verbLines(h)).toContain("workspace archive buoy-log --json");
    expect(fs.existsSync(FX.v("workspaces/buoy-log"))).toBe(false);
    expect(fs.existsSync(FX.v("workspaces/_archive/buoy-log/src/buoys.js"))).toBe(true);
    expect(fs.existsSync(FX.v("workspaces/_archive/buoy-log/.git"))).toBe(true);
    expect(manifest("_archive/buoy-log")).toMatch(/^archived: "?\d{4}-\d{2}-\d{2}"?$/m);
    expect(fs.existsSync(mapFile("buoy-log"))).toBe(false);
    expect(fs.existsSync(FX.v("brain/_index/workspace-maps/_archive/buoy-log.json"))).toBe(true);
    await expect(row(win, "buoy-log")).toHaveCount(0, { timeout: 30_000 });

    // Under "Show archived and _ folders": read only, but for Copy path, Reveal in Finder and Restore….
    await showHidden(win);
    await pick(win, "_archive/buoy-log", { title: "buoy-log" });
    await expect(head(win).locator(".aos-spc-tag")).toHaveText("archived");
    await head(win).locator("button[data-spc-key='more']").click();
    await expect(menu(win).locator(".aos-spc-poplabel")).toHaveText(["Copy path", "Reveal in Finder", "Restore…"]);
    await menuItem(win, "restore").click();
    const r = await expectPlan(win, {
      title: "Restore buoy-log?", from: "workspaces/_archive/buoy-log", to: "workspaces/buoy-log",
      items: ["Moves workspaces/_archive/buoy-log back to workspaces/buoy-log", "Moves its file map back to brain/_index/workspace-maps/", "No project note names it by workspace: or slug, so no tag changes"],
    });
    await r.locator("button.aos-spc-confirm", { hasText: "Restore" }).click();
    await expect(r).toHaveCount(0);
    await expect(notices(win)).toContainText("Restored buoy-log");
    expect(await verbLines(h)).toContain("workspace restore buoy-log --json");
    expect(fs.existsSync(FX.v("workspaces/_archive/buoy-log"))).toBe(false);
    expect(fs.existsSync(FX.v("workspaces/buoy-log/src/buoys.js"))).toBe(true);
    expect(manifest("buoy-log") ?? "").not.toMatch(/^archived:/m);
    expect(fs.existsSync(mapFile("buoy-log"))).toBe(true);
    await expect(row(win, "buoy-log")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(head(win).locator(".aos-spc-tag")).toHaveCount(0);
    await hideHidden(win);
  });

  test("Rename moves the folder and its map, records the old path under aliases:, and the list follows the new name (D17)", async () => {
    const h = app();
    const { win } = h;
    await pick(win, "field-notes");
    await more(win, "rename");
    const d = dialog(win, "mod-spc-confirm");
    const input = d.locator("input[data-spc-field='rename']");
    // A name an archived workspace holds, or one in use, is refused before anything runs.
    await input.fill("pier repairs");
    await expect(d.locator(".aos-spc-fhint")).toHaveText("An archived workspace holds pier-repairs: pick another name");
    await expect(d.locator("button.aos-spc-confirm")).toBeDisabled();
    await input.fill("harbor-map");
    await expect(d.locator(".aos-spc-fhint")).toHaveText("workspaces/harbor-map already exists: pick another name");
    await input.fill("Field Journal");
    await expectPlan(win, {
      title: "Rename field-notes", from: "workspaces/field-notes", to: "workspaces/field-journal",
      items: ["Moves workspaces/field-notes to workspaces/field-journal", "Moves its file map", "Records workspaces/field-notes under aliases:, so its past sessions, to-dos and notes still count here"],
    });
    await d.locator("button.aos-spc-confirm", { hasText: "Rename" }).click();
    await expect(d).toHaveCount(0);
    await expect(notices(win)).toContainText("Renamed field-notes to field-journal");
    expect(await verbLines(h)).toContain("workspace rename field-notes field-journal --json");
    expect(fs.existsSync(FX.v("workspaces/field-notes"))).toBe(false);
    expect(fs.readFileSync(FX.v("workspaces/field-journal/README.md"), "utf8")).toContain("# Field Notes");
    expect(manifest("field-journal")).toMatch(/^aliases:\n\s+- "?workspaces\/field-notes"?$/m);
    expect(fs.existsSync(mapFile("field-notes"))).toBe(false);
    expect(fs.existsSync(mapFile("field-journal"))).toBe(true);
    await expect(row(win, "field-journal")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(row(win, "field-notes")).toHaveCount(0);
    await expect(centre(win).locator(".aos-spc-h1")).toHaveText("field-journal");
  });

  test("Draft: one call to the provider on the click; Cancel and Draft again write nothing, a workspace.md changed meanwhile is refused, Save writes only the changed keys (D13, D14)", async () => {
    const h = app();
    const { win } = h;
    // The runtime's provider is the chat stand-in for this test: `provider: claude`, its login fresh in the state cache,
    // and an answer in the draft's strict shape. Put back after, so nothing else here meets a model.
    const agenticos = path.join(FX.claude, "agenticos.json");
    const stateFile = FX.v("brain/_index/provider-state.json");
    const saved = { agenticos: fs.readFileSync(agenticos, "utf8"), state: fs.readFileSync(stateFile, "utf8") };
    const DRAFT = {
      summary: "An offline harbor chart viewer, its tide overlay wired into the chart view.",
      objectives: ["Parse the sample tide tables", "Cache chart tiles for offline use"],
      next: "Cache the chart tiles for offline use",
    };
    const EDITED = "An offline harbor chart viewer, the tide overlay in review.";
    try {
      installChatStubs();
      const j = JSON.parse(fs.readFileSync(agenticos, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(agenticos, `${JSON.stringify({ ...j, provider: "claude" }, null, 2)}\n`);
      providerState("claude", { claude: true, codex: false });
      chatReply({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(DRAFT), structured_output: DRAFT, total_cost_usd: 0.0123, usage: { input_tokens: 321, output_tokens: 45 } }) });

      await pick(win, "harbor-map");
      const original = manifest("harbor-map")!;
      const sets = async () => (await aosRuns(h)).filter((a) => a[1] === "set" && a[2] === "harbor-map" && !a.includes("--dry-run"));
      const sets0 = (await sets()).length;
      await more(win, "draft");
      const d = dialog(win, "mod-spc-draft");
      await expect(d.locator(".aos-spc-dlgtitle")).toHaveText("Draft workspace.md for harbor-map");
      const summary = d.locator("textarea[data-spc-field='summary']");
      await expect(summary).toHaveValue(DRAFT.summary, { timeout: 30_000 });
      // The dialog took the keyboard (Cancel while it drafted), and the form takes it when it arrives.
      await expect(summary).toBeFocused();
      // The three buttons stay one group on one line at the right of the footer.
      const tops = await d.locator(".aos-spc-dlgacts button").evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
      expect(tops).toHaveLength(3);
      expect(new Set(tops).size).toBe(1);
      // One call, with the strict schema, through the vault's provider; the model is never asked for a status.
      expect(claudeCalls()).toHaveLength(1);
      expect(claudeCalls()[0].argv).toContain("--json-schema");
      await expect(d.locator("textarea[data-spc-field='next']")).toHaveValue(DRAFT.next);
      await expect(d.locator("input[data-spc-field='objective-0']")).toHaveValue(DRAFT.objectives[0]);
      await expect(d.locator("select[data-spc-field='status']")).toHaveValue("auto");
      await expect(d.locator("select[data-spc-field='status'] option:checked")).toHaveText("auto (not written)");
      await expect(d.locator(".aos-spc-who .aos-spc-badge")).toHaveText("AI");
      await expect(d.locator(".aos-spc-who .aos-spc-whotext")).toHaveText("Drafted by haiku · Claude");
      await expect(d.locator(".aos-spc-sources .aos-spc-chip")).toContainText(["workspace.md", "PLAN.md", "README.md"]);
      // The exact file Save would write, from `set … --dry-run`: the changed summary and next added, the body kept.
      const pre = d.locator("[data-spc-preview]");
      await expect(pre.locator(".aos-spc-pline.is-added")).toHaveCount(2, { timeout: 30_000 });
      await expect(pre.locator(".aos-spc-pline.is-added")).toContainText([DRAFT.summary, DRAFT.next]);
      await expect(pre).toContainText("# Harbor Map");
      await d.locator("button.aos-spc-cancel").click();
      await expect(d).toHaveCount(0);
      expect(manifest("harbor-map")).toBe(original);

      // Draft again asks once more and writes nothing either.
      await more(win, "draft");
      await expect(summary).toHaveValue(DRAFT.summary, { timeout: 30_000 });
      await d.locator("button.aos-spc-again").click();
      await expect.poll(() => claudeCalls().length, { timeout: 30_000 }).toBe(3);
      await expect(summary).toHaveValue(DRAFT.summary, { timeout: 30_000 });
      expect(manifest("harbor-map")).toBe(original);
      expect((await sets()).length).toBe(sets0);

      // A workspace.md changed after the draft read it: Save refuses rather than write over it.
      const byHand = `${original}\nA line added by hand.\n`;
      fs.writeFileSync(FX.v("workspaces/harbor-map/workspace.md"), byHand);
      await summary.fill(EDITED);
      await d.locator("button.aos-spc-confirm", { hasText: "Save workspace.md" }).click();
      await expect(d.locator(".aos-spc-dlgerr")).toHaveText("workspace.md changed: draft again");
      expect(manifest("harbor-map")).toBe(byHand);

      // Draft again reads the file as it is now; Save then sends only the keys that changed (summary, next), no status.
      await d.locator("button.aos-spc-again").click();
      await expect.poll(() => claudeCalls().length, { timeout: 30_000 }).toBe(4);
      await expect(summary).toHaveValue(DRAFT.summary, { timeout: 30_000 });
      await summary.fill(EDITED);
      await d.locator("button.aos-spc-confirm", { hasText: "Save workspace.md" }).click();
      await expect(d).toHaveCount(0, { timeout: 30_000 });
      await expect(notices(win)).toContainText("Saved workspaces/harbor-map/workspace.md");
      const last = (await sets()).slice(sets0);
      expect(last.map((a) => JSON.parse(a[4]))).toEqual([{ summary: EDITED, next: DRAFT.next }, { summary: EDITED, next: DRAFT.next }]);
      const after = manifest("harbor-map")!;
      expect(after).toMatch(new RegExp(`^summary: "?${esc(EDITED)}"?$`, "m"));
      expect(after).toMatch(new RegExp(`^next: "?${esc(DRAFT.next)}"?$`, "m"));
      // The objectives it did not change, the status line, the body and the hand-written line stay as they were.
      for (const l of byHand.split("\n").filter((x) => x && !/^(summary|next):/.test(x))) expect(after.split("\n")).toContain(l);
      expect(claudeCalls()).toHaveLength(4);
    } finally {
      chatReply(null);
      fs.writeFileSync(agenticos, saved.agenticos);
      fs.writeFileSync(stateFile, saved.state);
    }
  });
});

// ── the Spaces and To-Do surfaces on ─────────────────────────────────

/** A to-do with no #ws/ tag that names buoy-log ("buoy log", spaces-redesign D35), as a user writes one. */
const BUOY_TODO = "Export the buoy log as CSV";

test.describe("the Spaces and To-Do surfaces on", () => {
  const app = useApp({
    env: { AOS_APP_WRITE: "spaces,todo" },
    prepare: () => {
      const file = FX.v("TODO.md");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("## Open\n\n", `## Open\n\n- [ ] ${BUOY_TODO}\n`));
    },
  });

  test.beforeEach(async () => {
    await trackSpawns(app());
    await openTab(app().win, "spaces");
  });
  test.afterEach(async () => {
    // As in the spaces describe: no write and no spawn that main refused.
    expect(await guardWrites(app())).toEqual([]);
    expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
    expectNoErrors(app());
  });

  test("with the To-Do surface on, the To-do heading and Link to-dos… show at a zero count, and + to-do writes a tagged line", async () => {
    const h = app();
    const { win } = h;
    const runs0 = (await aosRuns(h)).length;
    await pick(win, "buoy-log");
    const g = todoGroup(win);
    await expect(g.locator(".aos-spc-lhead .aos-spc-lname")).toHaveText("To-do");
    await expect(g.locator(".aos-spc-lhead .aos-spc-mono")).toHaveCount(0);   // no count before any tag
    await expect(g.locator(".aos-spc-litem")).toHaveCount(0);
    await expect(g.locator("button.aos-spc-llink")).toBeEnabled();
    await expect(g.locator("button.aos-spc-llink")).toHaveAttribute("title", "Untagged to-dos that name buoy-log: tag them in one click");
    await expect(g.locator(".aos-spc-lwhy")).toHaveCount(0);
    const add = g.locator("button.aos-spc-ladd");
    await expect(add).toBeEnabled();
    await expect(add).toHaveAttribute("title", "A to-do in TODO.md tagged #ws/buoy-log");
    await add.click();
    const d = dialog(win, "mod-spc-todo");
    await expect(d.locator(".aos-spc-dlgtitle")).toHaveText("New to-do for buoy-log");
    const input = d.locator("input[data-spc-field='todo']");
    await expect(input).toBeFocused();
    await expect(d.locator("button.aos-spc-confirm")).toBeDisabled();
    await input.fill("Add the CSV header row");
    await expect(d.locator(".aos-spc-fhint")).toHaveText("- [ ] Add the CSV header row #ws/buoy-log");
    await d.locator("button.aos-spc-confirm", { hasText: "Add to-do" }).click();
    await expect(d).toHaveCount(0);
    await expect.poll(() => fs.readFileSync(FX.v("TODO.md"), "utf8")).toContain("- [ ] Add the CSV header row #ws/buoy-log\n");
    // The To-Do surface's writer wrote it; no Spaces verb ran.
    expect((await aosRuns(h)).slice(runs0)).toEqual([]);
    await expect(g.locator(".aos-spc-lhead .aos-spc-mono")).toHaveText("1");
    await expect(g.locator(".aos-spc-litem .aos-spc-ltext")).toHaveText(["Add the CSV header row"]);
    await expect(g.locator(".aos-spc-litem .aos-spc-lhow")).toHaveText(["tagged #ws/buoy-log"]);
  });

  test("Link to-dos… tags a fixture to-do that names the workspace, which then shows under To-do; nothing is tagged without the click", async () => {
    const h = app();
    const { win } = h;
    const runs0 = (await aosRuns(h)).length;
    await pick(win, "buoy-log");
    const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
    const g = todoGroup(win);
    const shown = await g.locator(".aos-spc-litem").count();
    await g.locator("button.aos-spc-llink").click();
    const d = dialog(win, "mod-spc-linktodos");
    await expect(d.locator(".aos-spc-dlgtitle")).toHaveText("Link to-dos to buoy-log");
    // Only the untagged to-do that names it: one already tagged is not offered, nor one naming another workspace.
    await expect(d.locator(".aos-spc-sugrow .aos-spc-sugline")).toHaveText([BUOY_TODO]);
    await expect(d.locator(".aos-spc-sugrow .aos-spc-lhow")).toHaveText(["names “buoy log”"]);
    // Opening the list wrote nothing.
    expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
    const link = d.locator("button.aos-spc-suglink");
    await link.click();
    await expect(link).toHaveText("Linked");
    await expect(d.locator(".aos-spc-sugrow")).toHaveClass(/is-linked/);
    await expect.poll(() => fs.readFileSync(FX.v("TODO.md"), "utf8")).toContain(`- [ ] ${BUOY_TODO} #ws/buoy-log\n`);
    expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).not.toContain(`- [ ] ${BUOY_TODO}\n`);
    await d.locator("button.aos-spc-cancel", { hasText: "Done" }).click();
    await expect(d).toHaveCount(0);
    expect((await aosRuns(h)).slice(runs0)).toEqual([]);
    await expect(g.locator(".aos-spc-litem")).toHaveCount(shown + 1);
    await expect(g.locator(".aos-spc-litem .aos-spc-ltext")).toContainText([BUOY_TODO]);
    await expect(g.locator(".aos-spc-lhead .aos-spc-mono")).toHaveText(String(shown + 1));
  });
});
