// Spaces and Runs (app-smoke: Spaces / Runs). Spaces is the three-pane dossier (spec 2026-10-09-spaces-redesign, PR 2):
// the list grouped by status with its search, the hidden toggle and the outside list; the dossier's header, pick-up
// card, Overview and Files; History and Linked; links into it; dark. Then the runs list, its drawer, pop-out, agents
// roster and live tail. With the Spaces surface off, the read's ↻ and Describe N new are refused; with it on they run in
// spaces-writes.spec.ts, and Resume in Code in term-deck.spec.ts and variants.spec.ts. The Memory tab became the Brain
// hub: brain.spec.ts.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, closeNotes, content, drawer, emulateViewport, notePath, openTab, pulseArea, rail, readVaultJson, useApp } from "./harness";

const app = useApp();
const C = () => content(app().win);

interface SessionRow { id: string; title: string | null; titleSource: string | null; host: string; kind: string; resumable: boolean }
interface WS {
  name: string; hidden?: boolean; summary: string | null; status?: string; summaryTemplate?: boolean; pinned?: boolean;
  statusOverride?: string | null; statusSource?: string;
  git?: { kind: string; branch?: string | null; head?: string | null; dirty?: number; remotes?: string[] } | null;
  commits?: { hash: string; subject: string }[];
  sessions?: { claude: number; codex: number; recent?: SessionRow[] };
  insight: { status: string; model?: string | null; text?: string | null };
}
const snapshot = () => readVaultJson<{ workspaces: WS[] }>("brain/_index/snapshot.json");
const entry = (name: string) => snapshot().workspaces.find((w) => w.name === name)!;

// ── Spaces ───────────────────────────────────────────────────────────

const L = () => C().locator(".aos-spc-list");
const M = () => C().locator(".aos-spc-centre");
const R = () => C().locator(".aos-spc-right");
const row = (name: string) => L().locator(`.aos-spc-row[data-workspace="${name}"]`);
const names = () => L().locator(".aos-spc-row .aos-spc-rowname");
const group = (label: string) => L().locator(".aos-spc-ghead", { has: app().win.locator(".aos-spc-glabel", { hasText: new RegExp(`^${label}$`) }) });
const pickRow = (key: string) => M().locator(`.aos-spc-pickup .aos-spc-pickval[data-row="${key}"]`);
const tab = (view: "Overview" | "Files") => M().locator(".aos-spc-tab", { hasText: view });
const section = (label: string) => M().locator(`#aos-spc-viewpanel .aos-spc-sec[aria-label="${label}"]`);
const tree = () => M().locator(".aos-spc-tree");
const treeRow = (label: string) => tree().locator(".aos-spc-trow", { has: app().win.locator(".aos-spc-tlabel", { hasText: new RegExp(`^${label.replace(/[.]/g, "\\.")}$`) }) });
const menu = () => C().locator(".aos-spc-pop[role='menu']");
const guardLog = () => app().win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
/** The terminals in the pool, by the workspace of their place ("" for none). */
const terminals = () => app().win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { list(): Array<{ meta: { place?: { workspace?: string } | null } }> } } } })
  .aosHost.plugin.terminalPool.list().map((s) => s.meta.place?.workspace ?? ""));

/** Selects a workspace (opening its folded group first) and shows `view` in the centre. */
async function pick(name: string, view: "Overview" | "Files" = "Overview", title = name): Promise<void> {
  if (!(await row(name).count())) {
    for (const label of ["IDLE", "ARCHIVED AND _ FOLDERS"]) {
      const g = group(label);
      if ((await g.count()) && (await g.getAttribute("aria-expanded")) === "false") await g.click();
    }
  }
  await row(name).click();
  await expect(row(name)).toHaveAttribute("aria-selected", "true");
  await expect(M().locator(".aos-spc-h1")).toHaveText(title);
  if ((await tab(view).getAttribute("aria-selected")) !== "true") await tab(view).click();
  await expect(tab(view)).toHaveAttribute("aria-selected", "true");
}

/** Files a test adds to a workspace for the Files tree (removed again by the caller): an image the map skips and a
 *  note it has not described yet. */
function addReefFiles(): () => void {
  const png = FX.v("workspaces/reef-survey/dive-photo.png");
  const md = FX.v("workspaces/reef-survey/south-reef.md");
  // A PNG signature and a few bytes: binary by its sniff, skipped by the map by its type.
  fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]), Buffer.alloc(1200)]));
  fs.writeFileSync(md, "# South reef\n\nTransects 4 to 9, counted on the second dive.\n");
  return () => { fs.rmSync(png, { force: true }); fs.rmSync(md, { force: true }); };
}

test.describe("Spaces", () => {
  test.beforeEach(async () => { await openTab(app().win, "spaces"); });

  test("the list: the snapshot's visible workspaces grouped ACTIVE, STALLED and IDLE (folded), each row with its status, git, hosts, age and next step", async () => {
    const snap = snapshot();
    // spaces-redesign D22: `_` folders and _archive/ children stay in the snapshot, hidden; _worktrees is no entry at all.
    expect(snap.workspaces.filter((w) => w.hidden).map((w) => w.name).sort()).toEqual(["_archive/pier-repairs", "_spikes"]);
    // The fixture's PR 1 workspaces, as literal outcomes (D11, D23, D24): a repository of its own with one commit two days
    // ago and one dirty file is active; a dated handoff with nothing for 12 days is stalled; the bare stubs are a
    // template summary with nothing planned. The Codex thread named in session_index.jsonl takes that title.
    const by = Object.fromEntries(snap.workspaces.map((w) => [w.name, w]));
    expect(by["buoy-log"].git).toMatchObject({ kind: "repo", branch: "main", dirty: 1, remotes: [] });
    expect(by["buoy-log"].status).toBe("active");
    expect(by["reef-survey"].status).toBe("stalled");
    expect([by["kelp-watch"].summaryTemplate, by["kelp-watch"].status]).toEqual([true, "idle"]);
    expect(by["harbor-map"].sessions?.recent).toContainEqual(expect.objectContaining({ title: "Chart tile cache sizes", titleSource: "index", host: "codex" }));

    const visible = snap.workspaces.filter((w) => !w.hidden).map((w) => w.name);
    await expect(L().locator(".aos-spc-h2")).toHaveText("Spaces");
    await expect(L().locator(".aos-spc-listtop .aos-spc-count")).toHaveText(String(visible.length));
    // D4: groups in order, empty ones left out; IDLE starts folded (its rows are not drawn); the first row is selected.
    const heads = L().locator(".aos-spc-ghead");
    await expect(heads.locator(".aos-spc-glabel")).toHaveText(["ACTIVE", "STALLED", "IDLE"]);
    await expect(heads.locator(".aos-spc-gcount")).toHaveText(["2", "1", "2"]);
    await expect(group("IDLE")).toHaveAttribute("aria-expanded", "false");
    await expect(names()).toHaveText(["harbor-map", "buoy-log", "reef-survey"]);
    await expect(row("harbor-map")).toHaveAttribute("aria-selected", "true");
    await expect(M().locator(".aos-spc-h1")).toHaveText("harbor-map");
    await group("IDLE").click();
    await expect(group("IDLE")).toHaveAttribute("aria-expanded", "true");
    // In the runtime's order inside a group: newest activity first (kelp-watch's stubs came after field-notes' README).
    await expect(names()).toHaveText(["harbor-map", "buoy-log", "reef-survey", "kelp-watch", "field-notes"]);
    expect((await names().allTextContents()).sort()).toEqual([...visible].sort());

    // A row: the status dot with its words (D19), git, the hosts with sessions, the age, the next step (D4).
    const harbor = row("harbor-map");
    await expect(harbor.locator(".aos-spc-rowtop .aos-spc-dot")).toHaveAttribute("aria-label", "active, set in workspace.md");
    await expect(harbor.locator(".aos-spc-rowtop .aos-spc-dot")).toHaveClass(/is-ok/);
    await expect(harbor.locator(".aos-spc-git")).toHaveText("no git");
    // The Claude Code transcript under harbor-map's real slug counts (D20: the cwd read inside it); its four Codex
    // rollouts count as three, the exec one included, since the thread_spawn subagent folds into its parent (D25).
    // The fixture is Claude Code only (hosts.codex.enabled false), and Codex's threads count all the same: a host that
    // is off still has its sessions read (spec §4's matrix, D31: they show with Resume off).
    await expect(harbor.locator(".aos-spc-hostcount")).toHaveText(["claude 1", "codex 3"]);
    expect(await harbor.locator(".aos-spc-hostcount .aos-spc-hostdot").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(["Claude Code", "Codex"]);
    // The counts name their window (D34) where the row has no room for it.
    await expect(harbor.locator(".aos-spc-hostcount").first()).toHaveAttribute("title", /^Sessions in the last 30 days, both hosts: Claude Code 1, Codex 3/);
    await expect(harbor.locator(".aos-spc-age")).toHaveText(/^\d+h$/);   // its Claude Code session, three hours old
    await expect(harbor.locator(".aos-spc-rownext")).toHaveText("Next: Wire the tide parser into the chart view");

    const buoy = row("buoy-log");
    await expect(buoy.locator(".aos-spc-rowtop .aos-spc-dot")).toHaveAttribute("aria-label", "active, worked out from sessions and commits");
    await expect(buoy.locator(".aos-spc-git")).toHaveText("main · 1 changed · no remote");
    await expect(buoy.locator(".aos-spc-git")).toHaveClass(/is-warn/);   // dirty
    await expect(buoy.locator(".aos-spc-hostcount")).toHaveCount(0);
    await expect(buoy.locator(".aos-spc-age")).toHaveText("2d");          // its commit
    await expect(buoy.locator(".aos-spc-rownext")).toHaveText("Next: Add a CSV export");

    const reef = row("reef-survey");
    await expect(reef.locator(".aos-spc-rowtop .aos-spc-dot")).toHaveClass(/is-warn/);
    await expect(reef.locator(".aos-spc-rowtop .aos-spc-dot")).toHaveAttribute("aria-label", "stalled, worked out from sessions and commits");
    await expect(reef.locator(".aos-spc-age")).toHaveText(/^1[12]d$/);
    await expect(reef.locator(".aos-spc-age")).toHaveClass(/is-warn/);   // a stalled row's age is tinted
    await expect(reef.locator(".aos-spc-hostcount")).toHaveText(["claude 1"]);
    await expect(reef.locator(".aos-spc-rownext")).toHaveText("Next: Enter the south reef counts");

    // Idle dots are hollow; a row with no next step and no handoff has no line at all.
    await expect(row("kelp-watch").locator(".aos-spc-rowtop .aos-spc-dot")).toHaveClass(/is-off/);
    await expect(row("kelp-watch").locator(".aos-spc-rowtop .aos-spc-dot")).toHaveClass(/is-hollow/);
    await expect(row("kelp-watch").locator(".aos-spc-rowline")).toHaveCount(0);
    await expect(row("field-notes").locator(".aos-spc-rownext")).toHaveText("Next: Pick a sync format");
    await expect(L().locator(".aos-spc-live")).toHaveCount(0);   // nothing runs in a workspace yet (D26)
    // One Tab stop for the rows (the listbox pattern): the selected row; the age reads in words to assistive technology.
    expect(await L().locator(".aos-spc-row").evaluateAll((els) => els.map((e) => e.getAttribute("tabindex")))).toEqual(["0", "-1", "-1", "-1", "-1"]);
    await expect(harbor.locator(".aos-spc-age")).toHaveAttribute("aria-hidden", "true");
    await expect(harbor.locator(".aos-spc-rowtop .aos-spc-sr")).toHaveText(/^last active \d+h ago$/);
    await group("IDLE").click();
    await expect(names()).toHaveText(["harbor-map", "buoy-log", "reef-survey"]);
  });

  test("search filters by name, branch and next step, opening every group; Escape clears it and keeps the focus", async () => {
    const { win } = app();
    const q = L().locator("input.aos-spc-q");
    await expect(q).toHaveAttribute("placeholder", "Filter by name, branch, next step…");
    await q.click();
    await win.keyboard.type("main");                     // buoy-log's branch
    await expect(names()).toHaveText(["buoy-log"]);
    await expect(L().locator(".aos-spc-ghead .aos-spc-glabel")).toHaveText(["ACTIVE"]);
    await expect(q).toBeFocused();
    await q.fill("south reef");                          // reef-survey's next step, from its handoff
    await expect(names()).toHaveText(["reef-survey"]);
    await q.fill("sync format");                         // field-notes' next step: IDLE opens for a typed filter
    await expect(names()).toHaveText(["field-notes"]);
    await expect(group("IDLE")).toHaveAttribute("aria-expanded", "true");
    await q.fill("HARBOR map");                          // case-insensitive, every word
    await expect(names()).toHaveText(["harbor-map"]);
    await q.fill("zz-no-such-space");
    await expect(L().locator(".aos-spc-listbody .aos-spc-empty")).toHaveText("Nothing matches “zz-no-such-space”.");
    await q.press("Escape");
    await expect(q).toHaveValue("");
    await expect(q).toBeFocused();
    await expect(names()).toHaveText(["harbor-map", "buoy-log", "reef-survey"]);
  });

  test("the hidden toggle shows archived and _ folders in a group of their own; one is read only, and hiding them moves the selection off it", async () => {
    const toggle = L().locator(".aos-spc-hiddenbtn");
    await expect(toggle).toHaveText("Show archived and _ folders (2)");
    // The label says what a click does next, so it is not also a pressed toggle.
    expect(await toggle.getAttribute("aria-pressed")).toBeNull();
    await expect(row("_spikes")).toHaveCount(0);
    await toggle.click();
    await expect(L().locator(".aos-spc-hiddenbtn")).toHaveText("Hide archived and _ folders");
    await expect(group("ARCHIVED AND _ FOLDERS")).toHaveAttribute("aria-expanded", "true");
    await expect(row("_archive/pier-repairs").locator(".aos-spc-rowname")).toHaveText("pier-repairs");
    await expect(row("_archive/pier-repairs").locator(".aos-spc-tag")).toHaveText("archived");
    await expect(row("_spikes").locator(".aos-spc-tag")).toHaveText("_ folder");

    await pick("_spikes");
    const head = M().locator(".aos-spc-head");
    await expect(head.locator(".aos-spc-titlebar .aos-spc-tag")).toHaveText("_ folder");
    // Nothing starts in a hidden folder, and the scan neither maps nor reads it: each control says why (D22, D33).
    const why = "Archived and _ folders start no terminal: open it in Code from its folder";
    await expect(head.locator("button.aos-spc-primary").first()).toHaveText("Start in Code");
    await expect(head.locator("button.aos-spc-primary").first()).toBeDisabled();
    await expect(head.locator("button.aos-spc-primary").first()).toHaveAttribute("title", why);
    await expect(head.locator("button.aos-spc-btn", { hasText: "Terminal" })).toBeDisabled();
    // Every row of the split menu is off here too, so its caret is; the reason shows in words, once, under the actions.
    const caret = head.locator("button.aos-spc-caret");
    await expect(caret).toBeDisabled();
    await expect(caret).toHaveAttribute("title", why);
    await expect(head.locator(".aos-spc-actwhy")).toHaveText([why]);
    // The off pair reads as one outlined control: both halves the plain button's background, neither faded.
    const halves = await head.locator(".aos-spc-split > button").evaluateAll((els) => els.map((e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.opacity]; }));
    expect(halves[0]).toEqual(halves[1]);
    expect(halves[0][1]).toBe("1");
    await expect(pickRow("last")).toHaveText("No session yet: start one from Resume's menu");
    await expect(pickRow("read").locator(".aos-spc-readtext")).toHaveText("No insight yet");
    await expect(pickRow("read").locator("button.aos-spc-regen")).toBeDisabled();
    await expect(pickRow("read").locator("button.aos-spc-regen")).toHaveAttribute("title", "Archived and _ folders are not mapped");

    await L().locator(".aos-spc-hiddenbtn").click();
    await expect(L().locator(".aos-spc-hiddenbtn")).toHaveText("Show archived and _ folders (2)");
    await expect(row("_spikes")).toHaveCount(0);
    await expect(row("harbor-map")).toHaveAttribute("aria-selected", "true");
    await expect(M().locator(".aos-spc-h1")).toHaveText("harbor-map");
  });

  test("Outside workspaces (n) opens the outside list in the centre: each folder's sessions per host, age, match and git, and its Adopt… menu, which moves nothing", async () => {
    const { win } = app();
    const out = L().locator(".aos-spc-outbtn");
    // Every session the Spaces fixture added lands in a workspace (or folds into one), so these are the hub's three.
    await expect(out.locator(".aos-spc-outlabel")).toHaveText("Outside workspaces (3)");
    await out.click();
    await expect(L().locator(".aos-spc-outbtn")).toHaveAttribute("aria-pressed", "true");
    await expect(M().locator(".aos-spc-h1")).toHaveText("Outside workspaces");
    await expect(M().locator(".aos-spc-titlebar .aos-spc-count")).toHaveText("3");
    await expect(M().locator(".aos-spc-lede")).toHaveText("Folders where Claude Code or Codex sessions ran in the last 30 days, outside every workspace. Nothing here moves a folder.");
    // None of the three folders is on disk (the /opt/sample ones never were, ~/sketches is gone), so all three are under
    // Vanished, newest first, and a line says so where the table of folders on disk would be (no bare header row); a
    // folder under HOME is ~-shortened, its full path in the title.
    await expect(M().locator(".aos-spc-outside")).toHaveCount(1);
    await expect(M().locator(".aos-spc-body > .aos-spc-emptyval")).toHaveText("None of these folders is still on disk.");
    const vanished = M().locator(".aos-spc-outside", { has: win.locator("h3", { hasText: /^VANISHED \(3\)$/ }) });
    const rows = vanished.locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(M().locator("tbody tr")).toHaveCount(3);
    await expect(rows.locator(".aos-spc-outname")).toHaveText(["/opt/sample/scratchpad", "/opt/sample/sandbox", "~/sketches"]);
    await expect(rows.locator(".aos-spc-outpath .aos-spc-tag")).toHaveText(["gone", "gone", "gone"]);
    await expect(rows.nth(2).locator(".aos-spc-outpath")).toHaveAttribute("title", path.join(FX.home, "sketches"));
    await expect(rows.locator(".aos-spc-outhosts")).toHaveText(["claude 2", "codex 1", "codex 1"]);
    await expect(rows.locator(".aos-spc-outage")).toHaveText([/^\d+h$/, /^[23]d$/, /^[56]d$/]);
    await expect(rows.locator(".aos-spc-outmatch")).toHaveText(["—", "—", "—"]);
    await expect(rows.locator(".aos-spc-outgit")).toHaveText(["—", "—", "—"]);
    // Each row's Adopt… opens a menu (spaces-redesign D16): Adopt into, Link as code folder, Hide. Nothing on the list moves a folder, and
    // today's `aos workspace adopt` hint is gone. A gone folder cannot be a code folder, and says so.
    await expect(M().locator(".aos-spc-ledenote")).toHaveText("Adopt… records a folder as an alias of a workspace, so its sessions count there, or links it as a workspace's code folder; Hide takes it off this list.");
    await expect(rows.locator("button.aos-spc-adoptbtn")).toHaveText(["Adopt…", "Adopt…", "Adopt…"]);
    await expect(M().locator("button", { hasText: /move/i })).toHaveCount(0);
    await expect(M()).not.toContainText("aos workspace adopt");
    const adopt = rows.nth(2).locator("button.aos-spc-adoptbtn");
    await expect(adopt).toHaveAttribute("aria-haspopup", "menu");
    await expect(adopt).toHaveAttribute("aria-label", "Adopt, link or hide ~/sketches");
    await adopt.click();
    await expect(menu().locator(".aos-spc-poplabel")).toHaveText(["Adopt into a workspace…", "Link as code folder of…", "Hide"]);
    await expect(menu().locator(".aos-spc-popitem[data-key='link']")).toHaveAttribute("aria-disabled", "true");
    await expect(menu().locator(".aos-spc-popitem[data-key='link'] .aos-spc-popdetail")).toHaveText("The folder no longer exists");
    await win.keyboard.press("Escape");
    await expect(menu()).toHaveCount(0);
    await expect(adopt).toBeFocused();
    await expect(R()).toBeEmpty();
    // Back keeps the keyboard's place: the focus lands on the footer button that opened the list.
    await M().locator("button", { hasText: "Back to harbor-map" }).click();
    await expect(M().locator(".aos-spc-h1")).toHaveText("harbor-map");
    await expect(L().locator(".aos-spc-outbtn")).toHaveAttribute("aria-pressed", "false");
    await expect(L().locator(".aos-spc-outbtn")).toBeFocused();
  });

  test("the outside list's folders on disk: the git column and a Matches link that opens the workspace (D21)", async () => {
    const { win } = app();
    // A folder on disk outside the vault with harbor-map's name, a repository with two worktrees, as the scan records it.
    const file = FX.v("brain/_index/snapshot.json");
    const original = fs.readFileSync(file, "utf8");
    const snap = JSON.parse(original) as { hostSessions: { outsideWorkspaces: Array<Record<string, unknown>> } };
    const cwd = path.join(FX.home, "code", "harbor-map");
    snap.hostSessions.outsideWorkspaces.unshift({
      cwd, claude: 1, codex: 0, total: 1, lastAt: new Date(Date.now() - 3_600_000).toISOString(), exists: true,
      match: "harbor-map", git: { root: cwd, branch: "main" }, worktrees: 2,
    });
    try {
      fs.writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
      await pick("buoy-log");
      const out = L().locator(".aos-spc-outbtn");
      await expect(out.locator(".aos-spc-outlabel")).toHaveText("Outside workspaces (4)");
      await out.click();
      await expect(M().locator(".aos-spc-titlebar .aos-spc-count")).toHaveText("4");
      await expect(M().locator(".aos-spc-body > .aos-spc-emptyval")).toHaveCount(0);
      const folders = M().locator(".aos-spc-outside[aria-label='Folders']");
      const row1 = folders.locator("tbody tr");
      await expect(row1).toHaveCount(1);
      await expect(row1.locator(".aos-spc-outname")).toHaveText("~/code/harbor-map");
      await expect(row1.locator(".aos-spc-outpath .aos-spc-tag")).toHaveCount(0);
      await expect(row1).not.toHaveClass(/is-gone/);
      await expect(row1.locator(".aos-spc-outhosts")).toHaveText("claude 1");
      await expect(row1.locator(".aos-spc-outage")).toHaveText(/^(1h|\d+m)$/);
      await expect(row1.locator(".aos-spc-outgit")).toHaveText("git · main · 2 worktrees");
      await expect(row1.locator(".aos-spc-outgit")).toHaveAttribute("title", "~/code/harbor-map");   // the repository's root
      await expect(M().locator(".aos-spc-outside", { has: win.locator("h3", { hasText: /^VANISHED \(3\)$/ }) }).locator("tbody tr")).toHaveCount(3);
      // The Matches link leaves the list and selects the workspace with that name; the focus lands on its title.
      const match = row1.locator(".aos-spc-outmatch button.aos-spc-linkbtn");
      await expect(match).toHaveText("harbor-map");
      await match.click();
      await expect(row("harbor-map")).toHaveAttribute("aria-selected", "true");
      await expect(M().locator(".aos-spc-h1")).toHaveText("harbor-map");
      await expect(M().locator(".aos-spc-h1")).toBeFocused();
      await expect(L().locator(".aos-spc-outbtn")).toHaveAttribute("aria-pressed", "false");
      await expect(R().locator(".aos-spc-history")).toHaveCount(1);
    } finally {
      fs.writeFileSync(file, original);
    }
    await expect(L().locator(".aos-spc-outbtn .aos-spc-outlabel")).toHaveText("Outside workspaces (3)");
  });

  test("+ New opens New space (D15): the name as the folder it makes and why not, the templates and Open with; Cancel makes nothing and starts nothing", async () => {
    const { win } = app();
    const before = (await terminals()).filter(Boolean);
    const nb = L().locator("button.aos-spc-newbtn");
    await expect(nb).toHaveText("New");
    await expect(nb).toHaveAttribute("title", "New space: a blank folder, a code repo or a clone from GitHub");
    await nb.click();
    const d = win.locator(".modal.mod-spc-new");
    await expect(d.locator(".aos-spc-dlgtitle")).toHaveText("New space");
    const name = d.locator("input[data-spc-field='name']");
    await expect(name).toBeFocused();
    await expect(d.locator(".aos-spc-choicename")).toHaveText(["Blank folder", "Code repo", "Clone from GitHub"]);
    // Open with: the hosts that are on (Claude Code; Codex is off on this machine) and Terminal, starting on ⌘T's.
    await expect(d.locator(".aos-spc-hostopt")).toHaveText(["Claude Code", "Terminal"]);
    await expect(d.locator(".aos-spc-hostopt[data-host='claude'] input")).toBeChecked();
    const ok = d.locator("button.aos-spc-confirm");
    await expect(ok).toBeDisabled();
    // The name is checked as typed: one in use, and one an archived workspace holds.
    const where = d.locator("[data-spc-field='where']");
    await name.fill("harbor map");
    await expect(where).toHaveText("workspaces/harbor-map already exists: pick it in the list");
    await expect(ok).toBeDisabled();
    await name.fill("Pier Repairs");
    await expect(where).toHaveText("An archived workspace holds pier-repairs: restore it instead");
    await name.fill("Tide Clock");
    await expect(where).toHaveText(FX.v("workspaces/tide-clock"));
    await expect(ok).toBeEnabled();
    await d.locator("button.aos-spc-cancel").click();
    await expect(d).toHaveCount(0);
    expect(fs.existsSync(FX.v("workspaces/tide-clock"))).toBe(false);
    expect((await terminals()).filter(Boolean)).toEqual(before);
    await expect(rail(win, "spaces")).toHaveClass(/is-active/);
  });

  test("the header: name, status pill, the meta line, and Resume in Code with its menu, Terminal, Finder and More", async () => {
    const h = app();
    await pick("buoy-log");
    const head = M().locator(".aos-spc-head");
    const pill = head.locator(".aos-spc-pill");
    await expect(pill).toHaveClass(/is-ok/);
    await expect(pill.locator(".aos-spc-pillword")).toHaveText("active");
    await expect(pill.locator(".aos-spc-pillauto")).toHaveText("· auto");   // worked out from sessions and commits
    await expect(head.locator(".aos-spc-pin")).toHaveCount(0);
    const metaPath = head.locator(".aos-spc-metapath");
    const metaGit = head.locator(".aos-spc-metagit");
    await expect(metaPath).toHaveText(FX.v("workspaces/buoy-log"));   // the vault is not under the fixture's HOME
    await expect(metaGit).toHaveText(`main · 1 changed · ${entry("buoy-log").git!.head} · no remote`);
    // Only the parts that carry a state are coloured (D19): dirty warn, no remote off; the branch and hash stay muted.
    await expect(metaGit.locator(".is-warn")).toHaveText("1 changed");
    await expect(metaGit.locator(".is-off")).toHaveText("no remote");
    await expect(metaGit).not.toHaveClass(/is-warn/);
    // No session yet: the split button starts one on the first ready host (Claude Code; Codex is off here).
    const go = head.locator(".aos-spc-split button.aos-spc-primary").first();
    await expect(go).toHaveText("Start in Code");
    await expect(go).toHaveAttribute("title", "No session yet: start a new Claude Code session in a Code terminal");

    await pick("harbor-map");
    await expect(pill.locator(".aos-spc-pillword")).toHaveText("active");
    await expect(pill.locator(".aos-spc-pillauto")).toHaveCount(0);       // set in workspace.md
    await expect(metaPath).toHaveText(FX.v("workspaces/harbor-map"));
    await expect(metaGit).toHaveText("no git");
    await expect(head.locator(".aos-spc-metacode")).toHaveCount(0);
    await expect(go).toHaveText("Resume in Code");
    await expect(go).toBeEnabled();
    await expect(go).toHaveAttribute("title", "Resume the last Claude Code thread in a Code terminal. Resumes in workspaces/harbor-map");
    // The actions sit together on the left (D5), not spread across the row.
    const acts = head.locator(".aos-spc-actions > button");
    await expect(acts.filter({ hasText: /\S/ })).toHaveText(["Terminal", "Finder"]);
    await expect(head.getByRole("button", { name: "More actions" })).toBeVisible();
    await expect(head.locator(".aos-spc-actwhy")).toHaveCount(0);   // nothing here is off
    const boxes = await Promise.all([head.locator(".aos-spc-split"), ...(await acts.all())].map((b) => b.boundingBox()));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x - (boxes[i - 1]!.x + boxes[i - 1]!.width)).toBeLessThan(24);

    // The split menu (D5, D31, D32): a New row per host that is on (no Codex row: it is off on this machine), Terminal
    // here, and Open last thread in Sessions, off with why. role=menu, the focus on its first row, Escape gives it back.
    const caret = head.locator("button.aos-spc-caret");
    await expect(caret).toHaveAttribute("aria-haspopup", "menu");
    await caret.click();
    await expect(caret).toHaveAttribute("aria-expanded", "true");
    const items = menu().locator(".aos-spc-popitem");
    await expect(items.locator(".aos-spc-poplabel")).toHaveText(["New Claude Code session", "Terminal here", "Open last thread in Sessions"]);
    await expect(items.nth(0)).toBeFocused();
    await expect(items.nth(2)).toHaveAttribute("aria-disabled", "true");
    await expect(items.nth(2).locator(".aos-spc-popdetail")).toHaveText("Sessions is hidden: set up a model provider to use it");
    await h.win.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    // The keyboard's row has a ring of its own, not only the hover tint.
    expect(await items.nth(1).evaluate((e) => [getComputedStyle(e).outlineStyle, getComputedStyle(e).outlineWidth])).toEqual(["solid", "2px"]);
    await h.win.keyboard.press("Escape");
    await expect(menu()).toHaveCount(0);
    await expect(caret).toBeFocused();
    await expect(caret).toHaveAttribute("aria-expanded", "false");
    // Tab closes it too, and the focus goes back to the caret, so the next Tab continues from there.
    await caret.click();
    await expect(items.nth(0)).toBeFocused();
    await h.win.keyboard.press("Tab");
    await expect(menu()).toHaveCount(0);
    await expect(caret).toBeFocused();

    // More ⋯ (spaces-redesign D5; PR 3's actions, D15–D18): Rename…, Pin, Set status…, Link code folder…, Draft workspace.md, Copy
    // path, Reveal in Finder, then Archive… apart. The status pill opens the status menu.
    await expect(pill).toHaveAttribute("aria-haspopup", "menu");
    await head.locator("button[aria-label='More actions']").click();
    await expect(menu().locator(".aos-spc-poplabel")).toHaveText(["Rename…", "Pin", "Set status…", "Link code folder…", "Draft workspace.md", "Copy path", "Reveal in Finder", "Archive…"]);
    await expect(menu().locator(".aos-spc-popsep")).toHaveCount(1);
    await expect(menu().locator(".aos-spc-popitem[data-key='link'] .aos-spc-popdetail")).toHaveText("Terminals here start in that folder");
    await expect(menu().locator(".aos-spc-popitem[data-key='draft'] .aos-spc-popdetail")).toHaveText("A summary, objectives and next step to review; nothing is saved until you press Save");
    const opened = (await h.opened()).length;
    const before = await terminals();
    await menu().locator(".aos-spc-popitem", { hasText: "Reveal in Finder" }).click();
    await expect(menu()).toHaveCount(0);
    await expect(head.locator("button[aria-label='More actions']")).toBeFocused();   // not dropped to the page
    // Finder opens the workspace folder (D5); the app records what it hands the OS instead of opening it.
    await head.locator("button.aos-spc-btn", { hasText: "Finder" }).click();
    await expect.poll(async () => (await h.opened()).slice(opened).map((o) => `${o.fn} ${o.arg}`).sort())
      .toEqual([`openPath ${FX.v("workspaces/harbor-map")}`, `showItemInFolder ${FX.v("workspaces/harbor-map")}`]);
    expect(await terminals()).toEqual(before);
    // Start in Code on a workspace with no session yet: the host ⌘T would start, in the workspace's place, from Spaces.
    await pick("buoy-log");
    await go.click();
    await expect(rail(h.win, "term")).toHaveClass(/is-active/);
    await expect.poll(() => h.win.evaluate(() => {
      const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { cwd: string; meta: { host: string; origin: string | null; place: { workspace?: string } | null } } | undefined } } } }).aosHost.plugin.terminalPool;
      const t = p.get(p.selectedId() ?? "");
      return t ? { cwd: t.cwd, host: t.meta.host, origin: t.meta.origin, workspace: t.meta.place?.workspace ?? null } : null;
    })).toEqual({ cwd: FX.v("workspaces/buoy-log"), host: "claude", origin: "Spaces", workspace: "buoy-log" });
  });

  test("pick up: last, now, next and read, each with its source, the resume line as a hint, and each row's empty state", async () => {
    await pick("harbor-map");
    await expect(M().locator(".aos-spc-pickhead .aos-spc-label")).toHaveText("PICK UP");
    await expect(M().locator(".aos-spc-pickup .aos-spc-pickkey")).toHaveText(["last", "now", "next", "read"]);
    // last: the newest interactive thread (the headless Codex exec run six hours ago shows only in History, D6).
    const last = pickRow("last");
    await expect(last.locator(".aos-spc-who")).toHaveText("claude");
    // Inline, so the age and title follow on the same line (the Draft footer's rule is scoped to the dialog).
    expect(await last.locator(".aos-spc-who").evaluate((el) => getComputedStyle(el).display)).toBe("inline-flex");
    await expect(last.locator(".aos-spc-who .aos-spc-hostdot")).toHaveAttribute("aria-label", "Claude Code");
    await expect(last).toContainText(/claude · \d+h — “Tide parser in the chart view”/);
    // The hint is the line Resume types (launchLine: the configured binary), and where it resumes (D7).
    await expect(last.locator(".aos-spc-hint .aos-spc-mono")).toHaveText("↳ claude --resume c1a0de00-0000-4000-8000-000000000001");
    await expect(last.locator(".aos-spc-hinttext")).toHaveText("Resumes in workspaces/harbor-map");
    await expect(pickRow("now")).toHaveText("No Now line in a handoff");
    await expect(pickRow("next").locator(".aos-spc-next")).toHaveText("Wire the tide parser into the chart view");
    await expect(pickRow("next").locator(".aos-spc-src")).toHaveText("from workspace.md");
    const ins = entry("harbor-map").insight;
    await expect(pickRow("read").locator(".aos-spc-readtext")).toHaveText(ins.text!);
    await expect(pickRow("read").locator(".aos-spc-readsrc")).toHaveText(/^heuristic · (now|\d+[mh])$/);
    // Under provider `none` the read's ↻ stays on: the runtime writes a heuristic read, and the button says so.
    await expect(pickRow("read").locator("button.aos-spc-regen")).toBeEnabled();
    await expect(pickRow("read").locator("button.aos-spc-regen")).toHaveAttribute("title", "Regenerate the read. No model provider is set up: ↻ writes a heuristic read");

    // A dated handoff: its Now line, and the card names it once, in its head; the next step names its section.
    await pick("reef-survey");
    await expect(M().locator(".aos-spc-pickhead .aos-spc-src")).toHaveText("from HANDOFF-reef-survey.md › Now");
    await expect(pickRow("now")).toHaveText("The coral counts for the north reef are entered; the south reef is half done.");
    await expect(pickRow("next").locator(".aos-spc-next")).toHaveText("Enter the south reef counts");
    await expect(pickRow("next").locator(".aos-spc-src")).toHaveText("from HANDOFF-reef-survey.md › Next");
    await expect(last).toContainText(/claude · 1[12]d — “Enter the north reef coral counts from the dive log”/);

    // The bare stubs: each row's empty state, and the split button starts a session instead of resuming one.
    await pick("kelp-watch");
    await expect(M().locator(".aos-spc-pickhead .aos-spc-src")).toHaveCount(0);
    await expect(pickRow("last")).toHaveText("No session yet: start one from Resume's menu");
    await expect(pickRow("now")).toHaveText("No Now line in a handoff");
    await expect(pickRow("next")).toHaveText("No next step in HANDOFF, STATUS or PLAN");
    await expect(pickRow("read").locator(".aos-spc-readtext")).toHaveText(entry("kelp-watch").insight.text!);
    await expect(M().locator(".aos-spc-split button.aos-spc-primary").first()).toHaveText("Start in Code");
  });

  test("Overview: Summary with its source, Objectives with n of m and a progress bar, Documents with their notes; a document opens as a note", async () => {
    const { win } = app();
    await pick("harbor-map");
    await expect(tab("Overview")).toHaveAttribute("aria-selected", "true");
    await expect(tab("Files")).toHaveAttribute("aria-selected", "false");
    await expect(tab("Files").locator(".aos-spc-tabcount")).toHaveText("5");   // the map's files
    await expect(section("Summary").locator(".aos-spc-h3")).toHaveText("SUMMARY");
    await expect(section("Summary").locator(".aos-spc-sechead .aos-spc-src")).toHaveText("workspace.md");
    await expect(section("Summary").locator(".aos-spc-summary")).toHaveText("An offline harbor chart viewer with tide overlays.");
    await expect(section("Objectives").locator(".aos-spc-objcount")).toHaveText("0 of 2");
    const bar = section("Objectives").locator("[role='progressbar']");
    await expect(bar).toHaveAttribute("aria-valuenow", "0");
    await expect(bar).toHaveAttribute("aria-valuetext", "0 of 2 done");
    await expect(section("Objectives").locator(".aos-spc-objtext")).toHaveText(["Parse the sample tide tables", "Cache chart tiles for offline use"]);
    await expect(section("Objectives").locator(".aos-spc-obj.is-done")).toHaveCount(0);
    const docs = section("Documents").locator(".aos-spc-docrow");
    await expect(docs.locator(".aos-spc-docname")).toHaveText(["PLAN.md", "README.md"]);
    await expect(docs.locator(".aos-spc-docnote")).toHaveText(["Wire the tide parser into the chart view", "An offline harbor chart viewer."]);
    await expect(docs.locator(".aos-spc-docage")).toHaveText([/^(now|\d+[mh])$/, /^(now|\d+[mh])$/]);
    // Typographic sections, not boxed panels (D8): no panel chrome inside the Overview.
    await expect(M().locator("#aos-spc-viewpanel .aos-panel")).toHaveCount(0);

    await pick("reef-survey");
    await expect(section("Summary").locator(".aos-spc-sechead .aos-spc-src")).toHaveText("guessed from the folder");
    await expect(section("Objectives")).toContainText("No objectives yet: list them in workspace.md.");
    await expect(section("Documents").locator(".aos-spc-docname")).toHaveText(["HANDOFF-reef-survey.md", "README.md"]);
    await expect(section("Documents").locator(".aos-spc-docnote").first()).toHaveText("The coral counts for the north reef are entered; the south reef is half done.");
    await pick("kelp-watch");
    await expect(section("Summary")).toContainText("No summary yet: add one to workspace.md or the README.");

    await pick("harbor-map");
    await section("Documents").locator(".aos-spc-docrow", { hasText: "README.md" }).click();
    await expect(notePath(win)).toHaveText("workspaces/harbor-map/README.md");
    await closeNotes(win);
  });

  test("Files: one tree with the map's descriptions inline, folders that open, filters by path or description, All · New · Changed, and the preview", async () => {
    const h = app();
    await pick("harbor-map", "Files");
    const panel = M().locator("#aos-spc-viewpanel");
    await expect(panel).toHaveAttribute("aria-label", "Files");
    await expect(C().locator(".aos-spc-main")).toHaveClass(/is-files/);
    await expect(panel.locator(".aos-spc-mapline")).toHaveText(/^5 of 5 described · last described (just now|\d+[mhd] ago) · 5 by the heuristic$/);
    await expect(tree().locator(".aos-spc-trow .aos-spc-tlabel")).toHaveText(["src", "PLAN.md", "README.md", "workspace.md"]);
    await expect(tree().locator(".aos-spc-trow .aos-spc-tdesc")).toHaveText(["", "Plan", "Harbor Map", "Harbor Map"]);
    await expect(treeRow("src")).toHaveAttribute("aria-expanded", "false");
    await expect(treeRow("src").locator(".aos-spc-tend")).toHaveText("2");
    await expect(tree().locator(".aos-spc-badge")).toHaveCount(0);   // every file described and unchanged
    // Under provider `none` ↻ per file is off and says why (D33); Describe N new has nothing to describe.
    await expect(treeRow("README.md").locator("button.aos-spc-redesc")).toBeDisabled();
    await expect(treeRow("README.md").locator("button.aos-spc-redesc")).toHaveAttribute("title", "Needs a model provider");
    // Nothing new: a quiet, off button that says so (the inverse fill is for when there is work).
    await expect(panel.locator("button.aos-spc-describe")).toHaveText("Nothing new");
    await expect(panel.locator("button.aos-spc-describe")).toBeDisabled();
    await expect(panel.locator("button.aos-spc-describe")).not.toHaveClass(/aos-spc-primary/);
    const seg = panel.locator(".aos-spc-seg .aos-spc-segbtn");
    await expect(seg).toHaveText(["All", "New", "Changed"]);
    await expect(seg.nth(0)).toHaveAttribute("aria-pressed", "true");

    await treeRow("src").click();
    await expect(treeRow("src")).toHaveAttribute("aria-expanded", "true");
    await expect(tree().locator(".aos-spc-trow .aos-spc-tlabel")).toHaveText(["src", "tides.js", "tiles.js", "PLAN.md", "README.md", "workspace.md"]);
    await expect(treeRow("tides.js")).toHaveAttribute("aria-level", "2");
    await expect(treeRow("tides.js").locator(".aos-spc-tdesc")).toHaveText("Parses the sample tide tables.");
    // A folder closes again from the keyboard (Left), and opens with Right.
    await treeRow("src").focus();
    await h.win.keyboard.press("ArrowLeft");
    await expect(treeRow("src")).toHaveAttribute("aria-expanded", "false");
    await treeRow("src").focus();
    await h.win.keyboard.press("ArrowRight");
    await expect(treeRow("src")).toHaveAttribute("aria-expanded", "true");

    // The filter matches a path or a description, and opens the folders holding a match.
    const q = panel.locator("input.aos-spc-q");
    await expect(q).toHaveAttribute("placeholder", "Filter by path or description…");
    await q.fill("sample tide");
    await expect(tree().locator(".aos-spc-trow .aos-spc-tlabel")).toHaveText(["src", "tides.js"]);
    await q.fill("tiles.js");
    await expect(tree().locator(".aos-spc-trow .aos-spc-tlabel")).toHaveText(["src", "tiles.js"]);
    await expect(q).toBeFocused();
    await q.fill("");
    await seg.nth(1).click();
    await expect(seg.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(tree().locator(".aos-spc-empty")).toHaveText("No file matches.");
    await seg.nth(0).click();

    // The preview takes the right pane while Files is open (D9): name, description with ↻ (off, and why), Open, Copy path,
    // Reveal in Finder, and the head of the file.
    await treeRow("tides.js").click();
    await expect(treeRow("tides.js")).toHaveAttribute("aria-selected", "true");
    const prev = R().locator(".aos-spc-preview");
    await expect(prev.locator(".aos-spc-prevname")).toHaveText("src/tides.js");
    await expect(prev.locator(".aos-spc-prevtop .aos-spc-badge")).toHaveCount(0);
    await expect(prev.locator(".aos-spc-prevdesctext")).toHaveText("Parses the sample tide tables.");
    await expect(prev.locator("button.aos-spc-redesc")).toBeDisabled();
    await expect(prev.locator(".aos-spc-prevdesc .aos-spc-why")).toHaveText("Needs a model provider");
    await expect(prev.locator(".aos-spc-prevacts button")).toHaveText(["Open", "Copy path", "Reveal in Finder"]);
    await expect(prev.locator(".aos-spc-pre")).toContainText("export function parseTides");
    await expect(R().locator(".aos-spc-history")).toHaveCount(0);
    const opened = (await h.opened()).length;
    await prev.locator("button", { hasText: "Reveal in Finder" }).click();
    await expect.poll(async () => (await h.opened()).slice(opened).map((o) => `${o.fn} ${o.arg}`)).toEqual([`showItemInFolder ${FX.v("workspaces/harbor-map/src/tides.js")}`]);

    // The live listing joined with the map: an image the map skips reads "not mapped" with no badge and no ↻; a note
    // the map has not seen is NEW, "Not described yet", and the one file Describe N new counts.
    const cleanup = addReefFiles();
    try {
      await pick("reef-survey", "Files");
      await expect(treeRow("dive-photo.png").locator(".aos-spc-tdesc")).toHaveText("not mapped");
      await expect(treeRow("dive-photo.png").locator(".aos-spc-tdesc")).toHaveAttribute("title", "Not mapped: an image, media, archive or binary type");
      await expect(treeRow("dive-photo.png").locator(".aos-spc-badge")).toHaveCount(0);
      await expect(treeRow("dive-photo.png").locator("button.aos-spc-redesc")).toHaveCount(0);
      await expect(treeRow("south-reef.md").locator(".aos-spc-tdesc")).toHaveText("Not described yet");
      await expect(treeRow("south-reef.md").locator(".aos-spc-badge")).toHaveText("NEW");
      await expect(treeRow("south-reef.md").locator(".aos-spc-badge")).toHaveClass(/is-new/);
      const describe = M().locator("button.aos-spc-describe");
      await expect(describe).toHaveText("Describe 1 new");
      await expect(describe).toBeEnabled();
      await expect(describe).toHaveAttribute("title", "Describes the new files within the scan's budgets, with the heuristic: no model provider is set up");
      await seg.nth(1).click();
      await expect(tree().locator(".aos-spc-trow .aos-spc-tlabel")).toHaveText(["south-reef.md"]);
      await seg.nth(2).click();
      await expect(tree().locator(".aos-spc-empty")).toHaveText("No file matches.");
      await seg.nth(0).click();
      await treeRow("dive-photo.png").click();
      await expect(prev.locator(".aos-spc-prevdesctext")).toHaveText("not mapped");
      await expect(prev.locator(".aos-spc-prevbody")).toHaveText("Binary file, 1 KB.");
    } finally { cleanup(); }
    await expect(tree().locator(".aos-spc-trow", { hasText: "south-reef.md" })).toHaveCount(0);
    await tab("Overview").click();
    await expect(R().locator(".aos-spc-history")).toHaveCount(1);
  });

  test("the preview keeps the reader's place: a to-do change leaves it alone, and a map change redraws it at the same scroll (D9)", async () => {
    const long = FX.v("workspaces/reef-survey/transects.txt");
    fs.writeFileSync(long, `${Array.from({ length: 400 }, (_, i) => `transect ${i + 1}: 12 m, 4 colonies`).join("\n")}\n`);
    const todo = FX.v("TODO.md");
    const todoWas = fs.readFileSync(todo, "utf8");
    const mapFile = FX.v("brain/_index/workspace-maps/reef-survey.json");
    const mapWas = fs.readFileSync(mapFile, "utf8");
    // The preview scrolls in the right pane, which sits beside the dossier only above 1100 px: wider than CI's screen.
    const undo = await emulateViewport(app().win, { width: 1480, height: 920 });
    try {
      await pick("reef-survey", "Files");
      await treeRow("transects.txt").click();
      const pre = R().locator(".aos-spc-preview .aos-spc-pre");
      await expect(pre).toContainText("transect 400:");
      await R().evaluate((el) => { el.scrollTop = 600; });
      await pre.evaluate((el) => { (el as HTMLElement).dataset.mark = "1"; });
      // A to-do tagged for the workspace changes the list's counts, not the preview: the same element, the same place.
      fs.writeFileSync(todo, todoWas.replace("## Open\n\n", "## Open\n\n- [ ] Recount transect 7 #ws/reef-survey\n"));
      await expect(row("reef-survey").locator(".aos-spc-rowcount")).toHaveText(["☐ 1"]);
      await expect(pre).toHaveAttribute("data-mark", "1");
      expect(await R().evaluate((el) => el.scrollTop)).toBe(600);
      // The map is the preview's to show: it is redrawn from the last read at once, so no "Reading…" and the same scroll.
      fs.writeFileSync(mapFile, `${mapWas}\n`);
      await expect(pre).not.toHaveAttribute("data-mark", "1");
      await expect(R().locator(".aos-spc-prevbody > .aos-spc-empty")).toHaveCount(0);
      expect(await R().evaluate((el) => el.scrollTop)).toBe(600);
    } finally {
      await undo();
      fs.writeFileSync(todo, todoWas);
      fs.writeFileSync(mapFile, mapWas);
      fs.rmSync(long, { force: true });
    }
    await expect(row("reef-survey").locator(".aos-spc-rowcount")).toHaveCount(0);
    await tab("Overview").click();
  });

  test("History: sessions and commits newest first with All · Sessions · Commits; Resume per thread, off with the reason for a host that is off", async () => {
    await pick("harbor-map");
    const hist = R().locator(".aos-spc-history");
    await expect(hist.locator(".aos-spc-h3")).toHaveText("HISTORY");
    const seg = hist.locator(".aos-spc-segbtn");
    await expect(seg).toHaveText(["All", "Sessions", "Commits"]);
    const rows = hist.locator(".aos-spc-hrow");
    await expect(rows.locator(".aos-spc-htitle")).toHaveText([
      "Tide parser in the chart view", "List the chart tiles missing a zoom level", "Sketch the depth contours layer for the chart view", "Chart tile cache sizes",
    ]);
    await expect(rows.locator(".aos-spc-hmeta")).toHaveText([/^claude · \d+h$/, /^codex · \d+h · headless$/, /^codex · 1d$/, /^codex · [23]d$/]);
    expect(await rows.locator(".aos-spc-hostdot").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(["Claude Code", "Codex", "Codex", "Codex"]);
    // The Claude Code thread resumes here; Codex is off on this machine, so its threads' Resume is off and says why (D31).
    const resume = rows.locator("button.aos-spc-hresume");
    await expect(resume).toHaveText(["Resume", "Resume", "Resume", "Resume"]);
    await expect(resume.nth(0)).toBeEnabled();
    await expect(resume.nth(0)).toHaveAttribute("title", "Resumes in workspaces/harbor-map");
    await expect(resume.nth(0)).toHaveAttribute("aria-label", "Resume “Tide parser in the chart view” in Code");
    for (const i of [1, 2, 3]) await expect(resume.nth(i)).toBeDisabled();
    // The reason shows once, under the first row it turns off; each button keeps it in its title.
    await expect(hist.locator(".aos-spc-why")).toHaveText(["Codex is off on this machine: run aos hosts add codex"]);
    await expect(rows.nth(1).locator(".aos-spc-why .aos-spc-mono")).toHaveText("aos hosts add codex");
    for (const i of [1, 2, 3]) await expect(resume.nth(i)).toHaveAttribute("title", "Codex is off on this machine: run aos hosts add codex");
    await seg.nth(2).click();
    await expect(seg.nth(2)).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(0);
    await expect(hist.locator(".aos-spc-emptyval")).toHaveText("No git here: link a code folder to see its commits.");
    await seg.nth(1).click();
    await expect(rows).toHaveCount(4);
    // No app thread here, and Sessions is hidden without a provider: no "All n in Sessions →".
    await expect(hist.locator(".aos-spc-more")).toHaveCount(0);

    // A workspace's own repository: its commit with the short hash, under Commits and All.
    // The filter stays as picked from one workspace to the next.
    await pick("buoy-log");
    await expect(seg.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(hist.locator(".aos-spc-emptyval")).toHaveText("No Claude Code or Codex sessions here yet.");
    await seg.nth(2).click();
    const commit = entry("buoy-log").commits![0];
    await expect(rows.locator(".aos-spc-htitle")).toHaveText([commit.subject]);
    await expect(rows.locator(".aos-spc-hmeta")).toHaveText([new RegExp(`^${commit.hash} · 2d$`)]);
    await expect(rows.locator(".aos-spc-commitmark")).toHaveAttribute("aria-label", "Commit");
    await seg.nth(0).click();
    await expect(rows).toHaveCount(1);
    await expect(hist.locator(".aos-spc-emptyval")).toHaveText("No Claude Code or Codex sessions here yet.");
    await expect(rows.locator("button.aos-spc-hresume")).toHaveCount(0);
  });

  test("Linked: to-dos tagged #ws/<slug>, proposals naming the workspace and memory notes, each saying how it links; zero counts hidden", async () => {
    const { win } = app();
    await pick("harbor-map");
    const linked = R().locator(".aos-spc-linked");
    await expect(linked.locator(".aos-spc-h3")).toHaveText("LINKED");
    // harbor-map's project note links by its slug; no to-do or proposal names it. The To-do heading stays at zero, its
    // number hidden, for + to-do and Link to-dos… (spaces-redesign D35); an empty Proposal group is not drawn.
    await expect(linked.locator(".aos-spc-lhead .aos-spc-lname")).toHaveText(["To-do", "Memory"]);
    await expect(linked.locator(".aos-spc-lhead .aos-spc-mono")).toHaveText(["1"]);
    await expect(linked.locator(".aos-spc-litem .aos-spc-ltext")).toHaveText(["Harbor Map"]);
    await expect(linked.locator(".aos-spc-litem .aos-spc-lhow")).toHaveText(["named harbor-map"]);
    await expect(row("harbor-map").locator(".aos-spc-rowcount")).toHaveCount(0);
    // A memory note opens in the app's editor.
    await linked.locator(".aos-spc-litem.is-memory").click();
    await expect(notePath(win)).toHaveText("brain/memory/projects/harbor-map.md");
    await closeNotes(win);
    await pick("buoy-log");
    await expect(linked.locator(".aos-spc-emptyval")).toHaveText("Nothing links to this space: no to-dos, proposals or memory notes name it.");

    // A to-do tagged for reef-survey and a proposal whose target is one of its files (D27), read live: the row's counts
    // and the Linked pane follow the files without a rescan.
    const todo = FX.v("TODO.md");
    const proposal = FX.v("persona/proposals/2026-10-10-reef-transects.md");
    const before = fs.readFileSync(todo, "utf8");
    try {
      fs.writeFileSync(todo, before.replace("## Open\n\n", "## Open\n\n- [ ] Count the south reef transects #ws/reef-survey\n"));
      fs.writeFileSync(proposal, "---\nslug: reef-transects\nfiled: 2026-10-10\ntarget: workspaces/reef-survey/HANDOFF-reef-survey.md\n---\n# Count the reef transects\n\n## What\nAdd the transect counts to the handoff.\n");
      await pick("reef-survey");
      await expect(row("reef-survey").locator(".aos-spc-rowcount")).toHaveText(["☐ 1", "◇ 1"]);
      // The glyphs are hidden from the row's name; words stand in for them.
      await expect(row("reef-survey").locator(".aos-spc-rowline .aos-spc-sr")).toHaveText(["1 open to-do tagged for this workspace", "1 pending proposal about this workspace"]);
      await expect(linked.locator(".aos-spc-lhead .aos-spc-lname")).toHaveText(["To-do", "Proposal"]);
      await expect(linked.locator(".aos-spc-lhead .aos-spc-mono")).toHaveText(["1", "1"]);
      const items = linked.locator(".aos-spc-litem");
      await expect(items.locator(".aos-spc-ltext")).toHaveText(["Count the south reef transects", "reef-transects"]);
      await expect(items.locator(".aos-spc-lhow")).toHaveText(["tagged #ws/reef-survey", "its target names workspaces/reef-survey"]);
      await expect(items.nth(1).locator(".aos-spc-ltag")).toHaveText("pending");
      await items.nth(0).click();
      await expect(rail(win, "todo")).toHaveClass(/is-active/);
      await openTab(win, "spaces");
    } finally {
      fs.writeFileSync(todo, before);
      fs.rmSync(proposal, { force: true });
    }
    await expect(row("reef-survey").locator(".aos-spc-rowcount")).toHaveCount(0);
    await expect(linked.locator(".aos-spc-emptyval")).toHaveText("Nothing links to this space: no to-dos, proposals or memory notes name it.");

    // The footer (D10, D32): Threads in Sessions is off without a provider, and says why; Terminals in Code opens Code
    // on this workspace's group, which only selects.
    const foot = R().locator(".aos-spc-rightfoot");
    await expect(foot.locator("button", { hasText: "Threads in Sessions →" })).toBeDisabled();
    await expect(foot.locator(".aos-spc-why")).toHaveText("Sessions is hidden: set up a model provider to use it");
    await foot.locator("button", { hasText: "Terminals in Code →" }).click();
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    await expect(C().locator(".aos-tl-scope")).toHaveClass(/is-on/);
    await expect(C().locator(".aos-tl-scope .aos-tl-scopetext")).toHaveText("Showing reef-survey only");
    // An empty Code tab opens a shell in the vault, as always (T13); nothing starts in the workspace.
    expect(await terminals()).not.toContain("reef-survey");
    await C().locator(".aos-tl-scope .aos-tl-scopeall").click();
    await expect(C().locator(".aos-tl-scope")).not.toHaveClass(/is-on/);
  });

  test("an agenticos://workbench link selects a workspace, a pane and a thread, and does nothing else (D12)", async () => {
    const h = app();
    const link = (q: string) => h.app.evaluate((_e, url) => { (globalThis as unknown as { __aosMain: { openLink(u: string): void } }).__aosMain.openLink(url); }, `agenticos://workbench?${q}`);
    await openTab(h.win, "pulse");
    await guardLog();
    const opened = (await h.opened()).length;
    const before = await terminals();
    // Extra parameters and a bad thread are dropped: the link selects reef-survey's Files, and starts nothing.
    await link("tab=spaces&workspace=reef-survey&pane=files&thread=not-a-thread&resume=1&run=draft");
    await expect(rail(h.win, "spaces")).toHaveClass(/is-active/);
    await expect(row("reef-survey")).toHaveAttribute("aria-selected", "true");
    await expect(tab("Files")).toHaveAttribute("aria-selected", "true");
    // A thread in History: the right pane marks it.
    await link("tab=spaces&workspace=harbor-map&pane=history&thread=c1a0de00-0000-4000-8000-000000000001");
    await expect(row("harbor-map")).toHaveAttribute("aria-selected", "true");
    await expect(tab("Overview")).toHaveAttribute("aria-selected", "true");
    await expect(R().locator(".aos-spc-hrow.is-target .aos-spc-htitle")).toHaveText("Tide parser in the chart view");
    // A name the snapshot does not hold is ignored: Spaces stays where it was. Links are handled in order, so once the
    // good link after it has shown its pane, the bad one has been handled.
    await link("tab=spaces&workspace=..%2F..%2Fetc");
    await link("tab=spaces&workspace=harbor-map&pane=linked");
    await expect(R().locator("#aos-spc-linked-h")).toBeFocused();
    await expect(row("harbor-map")).toHaveAttribute("aria-selected", "true");
    // The marked thread is said in words and to assistive technology, not by its tint alone.
    await link("tab=spaces&workspace=harbor-map&pane=history&thread=c1a0de00-0000-4000-8000-000000000001");
    await expect(R().locator(".aos-spc-hrow.is-target")).toHaveAttribute("aria-current", "true");
    await expect(R().locator(".aos-spc-hrow.is-target .aos-spc-targettag")).toHaveText("linked");
    expect(await terminals()).toEqual(before);
    expect((await h.opened()).length).toBe(opened);
    expect((await h.guard()).filter((e) => e.kind === "spawn")).toEqual([]);
  });

  test("Pulse's workspace rows open Spaces on their workspace (D12)", async () => {
    const { win } = app();
    await openTab(win, "pulse");
    const modal = await pulseArea(win, "workspaces");
    await modal.locator(".aos-pp-row", { has: win.locator(".aos-pp-rowtitle", { hasText: /^reef-survey$/ }) }).locator("button", { hasText: "Open →" }).click();
    await expect(win.locator(".modal.mod-pulse")).toHaveCount(0);
    await expect(rail(win, "spaces")).toHaveClass(/is-active/);
    await expect(row("reef-survey")).toHaveAttribute("aria-selected", "true");
    await expect(M().locator(".aos-spc-h1")).toHaveText("reef-survey");
  });

  test("a pinned workspace leads the list under PINNED with the pin mark; paused sits in IDLE with its pill; a vault-tracked folder offers Link code folder", async () => {
    const h = app();
    const file = FX.v("brain/_index/snapshot.json");
    const original = fs.readFileSync(file, "utf8");
    const snap = JSON.parse(original) as { workspaces: WS[] };
    const by = (n: string) => snap.workspaces.find((w) => w.name === n)!;
    Object.assign(by("buoy-log"), { pinned: true });
    Object.assign(by("field-notes"), { status: "paused", statusOverride: "paused", statusSource: "manifest", git: { kind: "vault" } });
    try {
      fs.writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
      await expect(L().locator(".aos-spc-ghead .aos-spc-glabel")).toHaveText(["PINNED", "ACTIVE", "STALLED", "IDLE"]);
      await expect(group("PINNED").locator(".aos-spc-gcount")).toHaveText("1");
      await pick("buoy-log");
      await expect(names().first()).toHaveText("buoy-log");
      await expect(M().locator(".aos-spc-titlebar .aos-spc-pin")).toHaveAttribute("aria-label", "Pinned");
      await pick("field-notes");
      await expect(row("field-notes").locator(".aos-spc-rowtop .aos-spc-dot")).toHaveAttribute("aria-label", "paused, set in workspace.md");
      await expect(row("field-notes").locator(".aos-spc-rowtop .aos-spc-dot")).toHaveClass(/is-hollow/);
      // In IDLE with its word (D4), so it does not rest on the dot's colour; buoy-log, active under PINNED, needs none.
      await expect(row("field-notes").locator(".aos-spc-statustag")).toHaveText("paused");
      await expect(row("buoy-log").locator(".aos-spc-statustag")).toHaveCount(0);
      const pill = M().locator(".aos-spc-pill");
      await expect(pill).toHaveClass(/is-paused/);
      await expect(pill.locator(".aos-spc-pillword")).toHaveText("paused");
      // A chosen pause is muted, not stalled's amber fill: the hollow amber dot is its only colour (D19).
      expect(await pill.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(await h.win.evaluate(() => {
        const d = document.createElement("div"); d.style.backgroundColor = "var(--udx-off-bg)"; document.body.appendChild(d);
        const c = getComputedStyle(d).backgroundColor; d.remove(); return c;
      }));
      await expect(pill.locator(".aos-spc-dot")).toHaveClass(/is-warn/);
      await expect(pill.locator(".aos-spc-pillauto")).toHaveCount(0);
      await expect(M().locator(".aos-spc-titlebar .aos-spc-pin")).toHaveCount(0);
      await expect(M().locator(".aos-spc-metavault")).toHaveText("tracked by the vault · Link code folder…");
      await expect(M().locator(".aos-spc-metavault button")).toHaveText("Link code folder…");
    } finally {
      fs.writeFileSync(file, original);
    }
    await expect(L().locator(".aos-spc-ghead .aos-spc-glabel")).toHaveText(["ACTIVE", "STALLED", "IDLE"]);
    await pick("harbor-map");
  });

  test("dark: the panes take the dark tokens, and colour marks only state (a stalled pill and age, the muted empty states)", async () => {
    const h = app();
    type Main = { __aosMain: { theme(): { source: string }; setTheme(s: string): void } };
    const was = await h.app.evaluate(() => (globalThis as unknown as Main).__aosMain.theme().source);
    const setTheme = (s: string) => h.app.evaluate((_e, v) => { (globalThis as unknown as Main).__aosMain.setTheme(v); }, s);
    // What the selected workspace draws, each next to the colour its token resolves to in the current theme.
    const colours = () => h.win.evaluate(() => {
      const token = (v: string, prop: "color" | "backgroundColor") => {
        const d = document.createElement("div");
        d.style[prop] = `var(${v})`;
        document.body.appendChild(d);
        const c = getComputedStyle(d)[prop];
        d.remove();
        return c;
      };
      const css = (sel: string, prop: "color" | "backgroundColor") => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
      return {
        page: [css(".aos-spc", "backgroundColor"), token("--udx-bg", "backgroundColor")],
        list: [css(".aos-spc-list", "backgroundColor"), token("--udx-surface", "backgroundColor")],
        pillDot: [css(".aos-spc-pill .aos-spc-dot", "backgroundColor"), token("--udx-warn-dot", "backgroundColor")],
        pillText: [css(".aos-spc-pill", "color"), token("--udx-warn", "color")],
        age: [css(".aos-spc-row.is-selected .aos-spc-age", "color"), token("--udx-warn", "color")],
        empty: [css(".aos-spc-pickval[data-row='now'] .aos-spc-emptyval", "color"), token("--udx-text-3", "color")],
        title: [css(".aos-spc-h1", "color"), token("--udx-text", "color")],
      };
    });
    try {
      await setTheme("light");
      await expect(h.win.locator("body")).toHaveClass(/theme-light/);
      // reef-survey: stalled, and its handoff has a Now line; kelp-watch's empty Now is checked below.
      await pick("reef-survey");
      const light = await colours();
      // Light draws from the tokens too (D19: tokens only, in both themes).
      for (const [k, [drawn, want]] of Object.entries(light)) if (k !== "empty") expect(drawn, `light ${k}`).toBe(want);
      await setTheme("dark");
      await expect(h.win.locator("body")).toHaveClass(/theme-dark/);
      const dark = await colours();
      // reef-survey's Now line is its handoff's, so its empty-state colour is checked on kelp-watch below.
      for (const [k, [drawn, want]] of Object.entries(dark)) if (k !== "empty") expect(drawn, k).toBe(want);
      expect(dark.page[0]).not.toBe(light.page[0]);
      expect(dark.title[0]).not.toBe(light.title[0]);
      await pick("kelp-watch");
      const empties = await colours();
      expect(empties.empty[0]).toBe(empties.empty[1]);
      expect(empties.title[0]).toBe(empties.title[1]);
      // An idle workspace carries no state colour: its pill is the muted off one.
      await expect(M().locator(".aos-spc-pill")).toHaveClass(/is-off/);
    } finally {
      await setTheme(was);
    }
    await pick("harbor-map");
  });

  test("with the Spaces surface off, the read's ↻ and Describe N new are refused; ↻ per file stays off under `none`", async () => {
    const h = app();
    const map = fs.readFileSync(FX.v("brain/_index/workspace-maps/reef-survey.json"), "utf8");
    const insightOf = () => JSON.stringify(entry("harbor-map").insight);
    const insight = insightOf();
    await guardLog();
    await pick("harbor-map");
    const notices = h.notices.length;
    await pickRow("read").locator("button.aos-spc-regen").click();
    await expect.poll(async () => (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what)).toEqual([expect.stringMatching(/\/regen-workspace-insight\.js harbor-map$/)]);
    // The regen spawn has no completion handler: a refusal (or a failed run) reaches the console only.
    await h.win.waitForTimeout(500);
    expect(h.notices.slice(notices)).toEqual(["Regenerating insight for harbor-map…"]);
    const cleanup = addReefFiles();
    try {
      await pick("reef-survey", "Files");
      await expect(treeRow("README.md").locator("button.aos-spc-redesc")).toBeDisabled();
      await M().locator("button.aos-spc-describe", { hasText: "Describe 1 new" }).click();
      await expect(h.win.locator(".notice-container")).toContainText("spawn failed: brain/scripts/map-workspace.js");
      expect((await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what)[1]).toMatch(/\/map-workspace\.js reef-survey$/);
    } finally { cleanup(); }
    expect(fs.readFileSync(FX.v("brain/_index/workspace-maps/reef-survey.json"), "utf8")).toBe(map);
    expect(insightOf()).toBe(insight);
    await tab("Overview").click();
    await guardLog();
  });

  test("with the surface off, the actions are refused and nothing changes: Pin, status, Archive, Rename, New space, Draft and Hide each say why", async () => {
    const h = app();
    const { win } = h;
    const OFF = "Spaces' write surface is off in this app: run the aos workspace command in a terminal instead";
    const listing = (rel: string) => fs.readdirSync(FX.v(rel)).sort();
    const hiddenFile = FX.v("brain/_index/workspaces-hidden.json");
    const hidden = () => (fs.existsSync(hiddenFile) ? fs.readFileSync(hiddenFile, "utf8") : null);
    const before = { manifest: fs.readFileSync(FX.v("workspaces/harbor-map/workspace.md"), "utf8"), workspaces: listing("workspaces"), archive: listing("workspaces/_archive"), hidden: hidden() };
    await guardLog();
    await pick("harbor-map");
    const head = M().locator(".aos-spc-head");
    const notices = win.locator(".notice-container");
    // Pin and the status menu: one `aos workspace set` each, refused by main; the Notice says what to do instead.
    await head.locator("button[data-spc-key='pin']").click();
    await expect(notices).toContainText(`Pin: ${OFF}`);
    await head.locator("button[data-spc-key='status']").click();
    await menu().locator(".aos-spc-popitem[data-key='status:paused']").click();
    await expect(notices).toContainText(`Status not set: ${OFF}`);
    // A move: the confirmation opens, and its button answers in the dialog.
    const confirm = win.locator(".modal.mod-spc-confirm");
    await head.locator("button[aria-label='More actions']").click();
    await menu().locator(".aos-spc-popitem[data-key='archive']").click();
    await confirm.locator("button.aos-spc-confirm").click();
    await expect(confirm.locator(".aos-spc-dlgerr")).toHaveText(OFF);
    await confirm.locator("button.aos-spc-cancel").click();
    await head.locator("button[aria-label='More actions']").click();
    await menu().locator(".aos-spc-popitem[data-key='rename']").click();
    await confirm.locator("input[data-spc-field='rename']").fill("harbor-chart");
    await confirm.locator("button.aos-spc-confirm").click();
    await expect(confirm.locator(".aos-spc-dlgerr")).toHaveText(OFF);
    await confirm.locator("button.aos-spc-cancel").click();
    await expect(confirm).toHaveCount(0);
    // New space and Draft say it in their dialogs.
    await L().locator("button.aos-spc-newbtn").click();
    const nw = win.locator(".modal.mod-spc-new");
    await nw.locator("input[data-spc-field='name']").fill("Tide Clock");
    await nw.locator("button.aos-spc-confirm").click();
    await expect(nw.locator(".aos-spc-dlgerr")).toHaveText(OFF);
    await nw.locator("button.aos-spc-cancel").click();
    await head.locator("button[aria-label='More actions']").click();
    await menu().locator(".aos-spc-popitem[data-key='draft']").click();
    const draft = win.locator(".modal.mod-spc-draft");
    await expect(draft.locator(".aos-spc-dlgerr")).toHaveText(OFF);
    await expect(draft.locator(".aos-spc-emptyval")).toHaveText("No draft this time.");
    await expect(draft.locator("button.aos-spc-confirm")).toBeDisabled();
    await draft.locator("button.aos-spc-cancel").click();
    // The outside list's Hide.
    await L().locator(".aos-spc-outbtn").click();
    await M().locator("tbody tr", { has: win.locator(".aos-spc-outname", { hasText: /^\/opt\/sample\/sandbox$/ }) }).locator("button.aos-spc-adoptbtn").click();
    await menu().locator(".aos-spc-popitem[data-key='hide']").click();
    await expect(notices).toContainText(`Not hidden: ${OFF}`);
    await M().locator("button[data-spc-key='outside-close']").click();
    // Every refusal was a named verb main would not spawn; nothing on disk moved or changed.
    const refused = (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what.replace(/^.*\/cli\/aos\.js /, ""));
    expect(refused).toEqual([
      expect.stringMatching(/^workspace set harbor-map --set \{"pinned":true\} --expect [0-9a-f]{64} --json$/),
      expect.stringMatching(/^workspace set harbor-map --set \{"status":"paused"\} --expect [0-9a-f]{64} --json$/),
      "workspace archive harbor-map --json",
      "workspace rename harbor-map harbor-chart --json",
      "workspace new tide-clock --pin --json",
      "workspace draft harbor-map --json",
      "workspace hide /opt/sample/sandbox --json",
    ]);
    expect(fs.readFileSync(FX.v("workspaces/harbor-map/workspace.md"), "utf8")).toBe(before.manifest);
    expect(listing("workspaces")).toEqual(before.workspaces);
    expect(listing("workspaces/_archive")).toEqual(before.archive);
    expect(hidden()).toBe(before.hidden);
    await guardLog();
  });
});

// ── Runs ─────────────────────────────────────────────────────────────

test.describe("Runs", () => {
  test.beforeEach(async () => { await openTab(app().win, "runs"); });

  const runsRows = () => fs.readFileSync(FX.v("brain/_index/agent-runs/runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; script: string; started_at: string });

  test("lists runs.jsonl newest first with id, script, duration, cost and age", async () => {
    const rows = runsRows().slice().reverse();
    await expect(C().locator(".aos-runs-row .aos-runs-script")).toHaveText(rows.map((r) => r.script));
    await expect(C().locator(".aos-runs-row .aos-runs-id")).toHaveText(rows.map((r) => r.id.slice(-10)));
    const costed = C().locator(".aos-runs-row", { hasText: "0000000001" });
    await expect(costed).toContainText("$1.250");   // the costs.jsonl record laid over the session
    await expect(costed).toContainText("40m00s");
  });

  test("the filter narrows by id, script or status", async () => {
    await C().locator("input.aos-runs-filter").fill("error");
    await expect(C().locator(".aos-runs-row .aos-runs-script")).toHaveText(["standup"]);
    await C().locator("input.aos-runs-filter").fill("session");
    await expect(C().locator(".aos-runs-row")).toHaveCount(runsRows().filter((r) => r.script === "session").length);
    await C().locator("input.aos-runs-filter").fill("");
  });

  test("a run opens its detail drawer: status, stats, error, prompt, timeline, raw JSON", async () => {
    const { win } = app();
    await C().locator(".aos-runs-row", { hasText: "standup" }).click();
    const d = drawer(win);
    await expect(d.locator(".aos-wb-drawertitle")).toHaveText("run andup-cccc");
    await expect(d.locator(".aos-ri-status")).toHaveText("error");
    await expect(d.locator(".aos-ri-status")).toHaveClass(/aos-text-rose/);
    await expect(d.locator(".aos-ri-stat-l")).toHaveText(["duration", "cost", "turns", "tools", "subagents"]);
    await expect(d.locator(".aos-ri-error")).toHaveText("no provider: set one with aos provider");
    await expect(d.locator(".aos-ri-section-head")).toContainText([/PROMPT/, /REPLY/, "TIMELINE · 3 events", /RAW JSON/]);
    await d.locator(".aos-ri-collapse-head", { hasText: "PROMPT" }).click();
    await expect(d.locator(".aos-ri-collapse-body")).toHaveText("Standup");
    await expect(d.locator(".aos-ri-evt-type")).toHaveText(["tool_use(1) · Read", "tool_result(1)", "tool_use(1) · Bash"]);
    await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  });

  test("a session run from the telemetry hook shows its tools and subagents", async () => {
    const { win } = app();
    await C().locator(".aos-runs-row", { hasText: "000000000a" }).click();
    const d = drawer(win);
    await expect(d.locator(".aos-ri-script")).toHaveText("session");
    await expect(d.locator(".aos-ri-stat", { hasText: "tools" }).locator(".aos-ri-stat-v")).toHaveText("3");
    await expect(d.locator(".aos-ri-section-head", { hasText: "SUBAGENTS" })).toHaveText("SUBAGENTS · 1");
    await expect(d.locator(".aos-ri-subagent")).toHaveText("field-researcher");
    await d.locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  });

  test("the run inspector pops out into the split pane", async () => {
    const { win } = app();
    await C().locator(".aos-runs-row", { hasText: "reflect-week" }).click();
    await drawer(win).locator(".aos-wb-draweractions a[aria-label='Open in split']").click();
    const leaf = win.locator(".aos-host-pane.is-split .workspace-leaf-content[data-type='agentic-os-run-inspector']");
    await expect(leaf).toContainText("Run inspector");
    await expect(leaf).toContainText("reflect-week");
    await expect(leaf).toContainText("TIMELINE · 3 events");
    await leaf.getByText("▸ REPLY").click();
    await expect(leaf).toContainText("Three themes: tides, tiles, tests.");
    await closeNotes(win);
  });

  test("⌬ agents: the staff roster from brain/agents heartbeats", async () => {
    await C().locator(".aos-runs-chip", { hasText: "⌬ agents" }).click();
    const staff = fs.readdirSync(FX.v("brain/agents")).filter((d) => fs.existsSync(FX.v(`brain/agents/${d}/heartbeat.json`))).sort();
    await expect(C().locator(".aos-staff-header .aos-title")).toHaveText("Staff roster");
    await expect(C().locator(".aos-staff-card .aos-staff-name")).toHaveText(staff);
    await expect(C().locator(".aos-staff-header .aos-dim")).toContainText(`${staff.length} agents · live tail`);
    await C().locator("input.aos-runs-filter").fill("team-");
    await expect(C().locator(".aos-staff-card .aos-staff-name")).toHaveText(staff.filter((s) => s.startsWith("team-")));
    await C().locator("input.aos-runs-filter").fill("");
    await C().locator(".aos-runs-chip", { hasText: "≣ runs" }).click();
  });

  test("a line appended to runs.jsonl shows within a second", async () => {
    const t = new Date(Date.now() - 5000).toISOString();
    const row = { id: "probe-live-zzzz", script: "probe", started_at: t, ended_at: new Date().toISOString(), duration_ms: 5000, cost_usd: 0, turns: 1, status: "ok" };
    fs.appendFileSync(FX.v("brain/_index/agent-runs/runs.jsonl"), `${JSON.stringify(row)}\n`);
    await expect(C().locator(".aos-runs-row").first().locator(".aos-runs-script")).toHaveText("probe", { timeout: 2000 });
  });
});
