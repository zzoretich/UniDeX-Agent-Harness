// Variants of the fixture, each its own app: a vault with no persona, to-dos, notifications or teams (empty states);
// session costing off; a provider on record (the Chat tab); a Codex-only machine (every "run in a session" button
// names Codex, and Brain's modes need no host); telemetry off; and a vault before any session logged a memory use (Brain's
// Library, Health and Map without a usage log). Each variant edits the restored copy before launch, the way the runtime
// or the user would leave it.

import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, RAIL_SECTIONS, appEnv, badge, claudeCalls, codexCalls, command, content, drawer, expected, guardWrites, installChatStubs, openTab, rail, terminalText, useApp, closePulse, pulseArea } from "./harness";
import { SURFACES } from "../../src/shared/surfaces";

const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};
const agenticos = path.join(FX.claude, "agenticos.json");
/** Runs the vault's `aos` launcher as a user at a terminal would (no AOS_HEADLESS), in the fixture's environment. */
const aos = (...args: string[]) => {
  const r = spawnSync("/bin/sh", [FX.v("brain/scripts/bin/aos"), ...args], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`aos ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
};

test.describe("an empty vault: no persona, to-dos, notifications or teams", () => {
  const app = useApp({
    prepare: () => {
      // The fixture's feedback draft (the Brain hub's, brain-hub D3) goes too: the status line counts drafts as a segment.
      for (const rel of ["persona", "TODO.md", "brain/notifications", "brain/_index/persona-heartbeat.json", "brain/memory/feedback/_drafts"]) fs.rmSync(FX.v(rel), { recursive: true, force: true });
      // The last session was wrapped: its not-wrapped line goes from SESSION.md as auto-wrap.js clearWrapStatus removes it
      // (the status line counts it as a segment).
      const session = FX.v("brain/_index/SESSION.md");
      fs.writeFileSync(session, fs.readFileSync(session, "utf8").replace(/## Wrap Status[\s\S]*?(?=\n## |$)/, "").replace(/\n{3,}/g, "\n\n"));
      // The runtime's own status-line refresh, so the model matches the emptied vault.
      const r = spawnSync(process.execPath, [FX.v("brain/scripts/statusline.js"), "refresh"], { env: appEnv(), encoding: "utf8" });
      if (r.status !== 0) throw new Error(`statusline refresh failed: ${r.stderr}`);
    },
  });

  test("badges are hidden and the status bar reads all clear", async () => {
    const { win } = app();
    for (const id of ["todo", "proposals", "notifications", "agent-teams"]) await expect(badge(win, id)).toHaveClass(/is-empty/);
    await expect(win.locator(".aos-host-status .aos-statusbar")).toContainText("· all clear");
  });

  test("Pulse: with no persona the band reads Briefing, offers no Turn on, and composes the paragraph", async () => {
    const { win } = app();
    await openTab(win, "pulse");
    await expect(win.locator(".aos-briefing-label")).toHaveText("Briefing");
    await expect(win.locator(".aos-pulse-turnon")).toHaveCount(0);
    await expect(win.locator(".aos-briefing-text")).toContainText(/^Good (morning|afternoon|evening)\./);
  });

  test("To-Do: nothing open, with the /todo hint", async () => {
    const { win } = app();
    await openTab(win, "todo");
    await expect(content(win).locator(".aos-rt-count")).toHaveText("0 open · 0 overdue · 0 today");
    await expect(content(win).locator(".aos-inv-row")).toHaveText("Nothing open — add one above, or run /todo <text> in a session.");
  });

  test("Proposals: only the 'isn't set up' line", async () => {
    const { win } = app();
    await openTab(win, "proposals");
    await expect(content(win).locator(".aos-rt-note")).toHaveText("The Chief of Staff isn't set up — run `aos persona` to create it.");
    await expect(content(win).locator(".aos-pr-grouphead")).toHaveCount(0);
  });

  test("Notifications: no notifications yet, with the /notifications hint", async () => {
    const { win } = app();
    await openTab(win, "notifications");
    await expect(content(win).locator(".aos-inv-row")).toHaveText("No notifications yet. Agents post with `aos notify post` — see /notifications.");
    await expect(content(win).locator(".aos-rt-actions button")).toHaveCount(0);
  });

  test("Agent Teams: no teams yet, the Seed button and the /team hint", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    const empty = content(win).locator(".aos-at-empty");
    await expect(empty.locator(".aos-at-emptytitle")).toHaveText("No teams yet");
    await expect(empty.locator("button.mod-cta")).toHaveText("Seed the example team");
    await expect(empty.locator(".aos-at-emptyacts .aos-dim")).toContainText("It lands in persona/teams/example/.");
    await expect(empty.locator(".aos-at-emptyacts .aos-dim")).toContainText("In a session: /team.");
  });

  test("sidebar: no heartbeat pill on a vault whose watchdog never ran", async () => {
    const { win } = app();
    await command(win, "agentic-os:open-sidebar-hud");
    await expect(win.locator(".aos-host-right .aos-sb-status .aos-pill").first()).toBeVisible();
    await expect(win.locator(".aos-host-right .aos-sb-status .aos-pill", { hasText: "♥" })).toHaveCount(0);
  });
});

test.describe("session costing off", () => {
  const app = useApp({ prepare: () => editJson(agenticos, (j) => { j.cost = { ...(j.cost ?? {}), enabled: false }; }) });

  test("Pulse: no COST row and no anchor or backfill cards; the health card stays", async () => {
    const { win } = app();
    await openTab(win, "pulse");
    await pulseArea(win, "health");
    await expect(win.locator(".aos-pulse-rowlabel", { hasText: /^HEALTH$/ })).toBeVisible();
    await expect(win.locator(".aos-pulse-rowlabel", { hasText: /^COST$/ })).toHaveCount(0);
    const titles = win.locator(".aos-pulse-fixq .aos-pulse-fix-title");
    await expect(titles.filter({ hasText: "health error(s)" })).toHaveCount(1);
    await expect(titles.filter({ hasText: "not yet anchored" })).toHaveCount(0);
    await expect(titles.filter({ hasText: "missing cost" })).toHaveCount(0);
    await closePulse(win);
  });

  test("SYSTEM drawer: no COST DETAIL panel", async () => {
    const { win } = app();
    await openTab(win, "pulse");
    await pulseArea(win, "health");
    await win.locator(".aos-pulse-row a", { hasText: "SYSTEM ▸" }).click();
    await expect(drawer(win).locator(".aos-panel-title", { hasText: "DISK" })).toBeVisible();
    await expect(drawer(win).locator(".aos-panel-title", { hasText: "COST DETAIL" })).toHaveCount(0);
    await drawer(win).locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
  });

  test("Settings: the Session costing switch is off", async () => {
    const { win } = app();
    await openTab(win, "settings");
    await expect(content(win).locator(".aos-st-master .aos-st-switch", { hasText: "Session costing" })).not.toHaveClass(/is-on/);
  });
});

test.describe("a provider on record", () => {
  // What the scripts publish in provider-state.json once a provider resolves; the HUD only reads it.
  const state = (name: string, loggedIn: boolean) => () => editJson(FX.v("brain/_index/provider-state.json"), (j) => {
    j.name = name; j.reason = "fixture"; j.claude = { loggedIn };
  });
  // The chat stubs only prove that no CLI runs: Chat's surface is off here.
  const app = useApp({ prepare: () => { installChatStubs(); state("claude", true)(); } });

  test("Pulse is Home with a provider too; Sessions closes the first section, after Code; the mark returns to Pulse", async () => {
    const { win } = app();
    const ids = await win.locator(".aos-wb-railtabs .aos-wb-railbtn").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
    expect(ids.slice(0, 4)).toEqual(["notifications", "pulse", "term", "chat"]);
    // All fourteen buttons and the two lines, Sessions included (spec 2026-10-09-rail-sections-code D1, D5).
    const seq = await win.locator(".aos-wb-railtabs > *").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab ?? (e.classList.contains("aos-wb-railsep") ? "|" : "?")));
    expect(seq).toEqual(RAIL_SECTIONS.map((s) => s.join(",")).join(",|,").split(","));
    await expect(win.locator(".aos-wb-railsep[role='separator']")).toHaveCount(2);
    await expect(rail(win, "pulse")).toHaveClass(/is-active/);
    await openTab(win, "chat");
    await win.locator(".aos-wb-mark").click();
    await expect(rail(win, "pulse")).toHaveClass(/is-active/);
  });

  test("Vault chat under claude names the reasoner and its cap; a local provider reads local ask.js", async () => {
    const { win } = app();
    await openTab(win, "chat");
    await expect(content(win).locator(".aos-asst-head .aos-title")).toHaveText("Vault");
    // Claude Code is the ready host: the menu's Default is the configured reasoner.
    await expect(content(win).locator(".aos-asst-mode")).toHaveText(" · Claude Code (claude-opus-5, capped)");
    await expect(content(win).locator("textarea.aos-asst-input")).toHaveAttribute("placeholder", "Ask about your notes…");
    await expect(content(win).locator(".aos-asst-actions button")).toHaveText("Send (⌘↵)");
    await expect(content(win).locator('.aos-asst-tools .aos-am[data-access="read"] .aos-am-trigger.is-fixed')).toHaveText("Read only");
    await expect(content(win).locator('.aos-asst-tools .aos-hm[data-mode="vault"] .aos-hm-chiphost')).toHaveText("Claude Code");
    state("ollama", false)();
    await openTab(win, "pulse");
    await openTab(win, "chat");
    await expect(content(win).locator(".aos-asst-mode")).toHaveText(" · local ask.js");
    state("codex", false)();
    await openTab(win, "pulse");
    await openTab(win, "chat");
    await expect(content(win).locator(".aos-asst-mode")).toHaveText(" · codex via ask.js (reasoner caps)");
  });

  test("Chat surface off: a question is refused on either route; the tab says why, nothing is logged or billed, no CLI runs", async () => {
    const h = app();
    const chatLog = FX.v("brain/_index/agentic-os-chat.jsonl");
    const ledger = FX.v("brain/_index/provider-spend.jsonl");
    const ledger0 = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : null;
    const send = async (q: string) => {
      await content(h.win).locator("textarea.aos-asst-input").fill(q);
      await content(h.win).locator(".aos-asst-actions button", { hasText: "Send (⌘↵)" }).click();
    };
    const lastError = () => content(h.win).locator(".aos-asst-turn-assistant:not(.aos-asst-live) .aos-text-rose").last();

    // Claude: recall and `claude -p` are refused, and the refusal is the turn's error.
    state("claude", true)();
    await openTab(h.win, "pulse");
    await openTab(h.win, "chat");
    await send("Refused on the Claude route?");
    await expect(lastError()).toContainText("UniDeX: ");
    await expect(lastError()).toContainText("claude -p");
    // The local route: ask.js is refused.
    state("ollama", false)();
    await openTab(h.win, "pulse");
    await openTab(h.win, "chat");
    await expect(content(h.win).locator(".aos-asst-mode")).toHaveText(" · local ask.js");
    await send("Refused on the local route?");
    await expect(lastError()).toContainText("brain/scripts/sdk/ask.js --local Refused on the local route? refused; no write surface that allows it is on");

    const spawns = (await h.guard()).filter((e) => e.kind === "spawn").map((e) => e.what);
    expect(spawns).toHaveLength(3);
    expect(spawns[0]).toMatch(/recall-cli\.js Refused on the Claude route\?$/);
    expect(spawns[1]).toMatch(/claude -p /);
    expect(spawns[2]).toMatch(/brain\/scripts\/sdk\/ask\.js --local Refused on the local route\?$/);
    // Each question and each answer tried to reach the chat log.
    expect(await guardWrites(h)).toEqual(Array(4).fill("write brain/_index/agentic-os-chat.jsonl"));
    expect(fs.existsSync(chatLog)).toBe(false);
    expect(fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8") : null).toBe(ledger0);
    expect(claudeCalls()).toEqual([]);
    expect(codexCalls()).toEqual([]);
    await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
  });
});

test.describe("a Codex-only machine", () => {
  const app = useApp({
    prepare: () => {
      editJson(agenticos, (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = true; });
      aos("routines", "hosts", "--refresh");   // the Codex section: this machine has no Codex automations database
      // What the provider probe leaves on such a machine: Codex, logged in, so Sessions is on the rail.
      editJson(FX.v("brain/_index/provider-state.json"), (j) => {
        j.name = "codex"; j.reason = "fixture"; j.codex = { ...(j.codex ?? {}), loggedIn: true, checkedAt: new Date().toISOString() };
      });
      // The unwrapped session's line as auto-wrap.js writeWrapStatus writes it on this machine: Codex's own wrap skill.
      const r = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(FX.v("brain/scripts/auto-wrap.js"))}).writeWrapStatus("5e55a0a0-0000-4000-8000-00000000000a", "none")`], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
      if (r.status !== 0) throw new Error(`writeWrapStatus failed: ${r.stderr}`);
    },
  });

  test("Proposals: Review in Codex ❯_ runs the flag-closer skill through codex", async () => {
    const { win } = app();
    await openTab(win, "proposals");
    const review = content(win).locator(".aos-rt-actions button");
    await expect(review).toHaveText("Review in Codex ❯_");
    await expect(review).toHaveAttribute("title", "Opens a terminal in Code, in the vault, running: codex '$agenticos:persona-flag-closer'");
    await review.click();
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture codex stub] $agenticos:persona-flag-closer");
  });

  test("Pulse: Review → on a proposal runs the same flag-closer skill through codex", async () => {
    const { win } = app();
    // The Proposals test's session is still in the pool: count the stub's lines rather than look for one.
    const runs = async () => (await terminalText(win)).split("[fixture codex stub] $agenticos:persona-flag-closer").length - 1;
    const before = await runs();
    await openTab(win, "pulse");
    const modal = await pulseArea(win, "proposals");
    await modal.locator(".aos-pp-row", { hasText: "proposal" }).first().locator("button", { hasText: "Review →" }).click();
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    await expect.poll(runs, { timeout: 10_000 }).toBeGreaterThan(before);
  });

  test("Notifications: the ask buttons open Codex sessions", async () => {
    const { win } = app();
    await openTab(win, "notifications");
    await content(win).locator(".aos-nt-chip", { hasText: /^All$/ }).click();
    await content(win).locator(".aos-nt-row", { hasText: "The Morning Edition" }).click();
    await expect(content(win).locator(".aos-nt-actions button", { hasText: "Deep dive" })).toHaveAttribute("title", "Opens a Codex session in the vault running: codex '$agenticos:ask-brain tide tables'");
  });

  test("Agent Teams: Redirect runs the lead through codex", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    const redirect = content(win).locator(".aos-at-needs .aos-at-gate", { hasText: "harbor-01" }).locator("button", { hasText: "Redirect" });
    await expect(redirect).toHaveText("Redirect ❯_");
    await expect(redirect).toHaveAttribute("title", /in Codex/);
  });

  test("Routines: the Codex section names why it is empty, with its age", async () => {
    const { win } = app();
    await openTab(win, "routines");
    await expect(content(win).locator(".aos-rt-asof")).toContainText(/codex as of \d+[smhd] ago/);
    await expect(content(win).locator(".aos-inv-row", { hasText: /^codex: / })).toContainText("no Codex automations database");
  });

  test("Settings: the Claude rows are dimmed and the Codex rows are not", async () => {
    const { win } = app();
    await openTab(win, "settings");
    const row = (key: string) => content(win).locator(".aos-st-row", { has: win.locator(".aos-st-key", { hasText: new RegExp(`^${key.replace(/\./g, "\\.")}$`) }) });
    await expect(row("claude.model")).toHaveClass(/is-dim/);
    await expect(row("claude.model").locator(".aos-st-hostnote")).toHaveText("Claude Code is off on this machine; `aos init --host both` turns it on");
    await expect(row("codex.model")).not.toHaveClass(/is-dim/);
  });

  test("Sessions: the host and model menu offers Codex alone, Claude Code a disabled button off on this Mac; Vault asks Codex", async () => {
    const { win } = app();
    await openTab(win, "chat");
    // Vault: Codex is the one host ready for a question, so the chip reads Codex; until it is picked, a question takes
    // today's route (ask.js on the codex provider, with its fallback), and the header says so.
    await expect(content(win).locator(".aos-asst-mode")).toHaveText(" · codex via ask.js (reasoner caps)");
    await expect(content(win).locator('.aos-asst-tools .aos-hm[data-mode="vault"] .aos-hm-chiphost')).toHaveText("Codex");
    await content(win).locator(".aos-ss-newbtn").click();
    const menu = content(win).locator('.aos-ss-toolbar .aos-hm[data-mode="new"]');
    const chip = menu.locator(".aos-hm-trigger");
    await expect(chip).toHaveAttribute("data-host", "codex");
    await expect(chip.locator(".aos-hm-chiphost")).toHaveText("Codex");
    await chip.click();
    const claude = menu.locator('.aos-hm-pop .aos-hm-host[data-host="claude"]');
    await expect(claude).toBeDisabled();
    await expect(claude).toHaveAttribute("title", "Claude Code is off on this machine");
    // `--host claude` would turn Codex off, so with Codex on the line names `--host both`.
    await expect(menu.locator('.aos-hm-offline[data-host="claude"]')).toHaveText("Claude Code is off on this Mac: aos init --host both turns it on");
    await expect(menu.locator('.aos-hm-host[data-host="codex"]')).toHaveAttribute("aria-pressed", "true");
    await menu.locator(".aos-hm-search").press("Escape");
    await expect(menu.locator(".aos-hm-pop")).toHaveCount(0);
    // Without the Sessions surface nothing runs here; sessions.spec's Codex-only machine runs a Codex turn.
    await expect(content(win).locator(".aos-ss-list .aos-ss-note")).toHaveText("Workspace sessions are unavailable: the Sessions surface is off.");
  });

  test("Spaces: Resume follows the thread's host: a Claude Code thread's is off with how to turn it on, a Codex thread's types `codex resume` in ws:<name>; no New Claude Code session row (spaces-redesign D7, D31)", async () => {
    const { win } = app();
    await openTab(win, "spaces");
    const C = content(win);
    await C.locator('.aos-spc-row[data-workspace="harbor-map"]').click();
    await expect(C.locator(".aos-spc-h1")).toHaveText("harbor-map");
    const head = C.locator(".aos-spc-head");
    const off = "Claude Code is off on this machine: run aos init --host claude";
    // The last thread is Claude Code's: Resume in Code is off and says how to turn the host on (never the other host,
    // which cannot read the transcript).
    const go = head.locator(".aos-spc-split button.aos-spc-primary").first();
    await expect(go).toHaveText("Resume in Code");
    await expect(go).toBeDisabled();
    await expect(go).toHaveAttribute("title", off);
    await expect(C.locator(".aos-spc-pickval[data-row='last'] .aos-spc-why")).toHaveText(off);
    // The menu lists only the hosts that are on: Codex's New row, no Claude Code one; Sessions is on (Codex is the
    // provider), and a thread started in a terminal resumes in Code, not there (D32).
    await head.locator("button.aos-spc-caret").click();
    const pop = C.locator(".aos-spc-pop");
    await expect(pop.locator(".aos-spc-poplabel")).toHaveText(["New Codex session", "Terminal here", "Open last thread in Sessions"]);
    await expect(pop.locator(".aos-spc-popitem[data-key='new:codex']")).not.toHaveAttribute("aria-disabled", "true");
    await expect(pop.locator(".aos-spc-popitem[data-key='sessions'] .aos-spc-popdetail")).toHaveText("Started in a terminal: resume it in Code");
    await win.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);
    // History: the Claude Code thread's Resume is off with the same words; a Codex thread's resumes in the workspace.
    const hist = C.locator(".aos-spc-history");
    const claudeRow = hist.locator(".aos-spc-hrow", { hasText: "Tide parser in the chart view" });
    await expect(claudeRow.locator("button.aos-spc-hresume")).toBeDisabled();
    await expect(claudeRow.locator(".aos-spc-why")).toHaveText(off);
    const codexRow = hist.locator(".aos-spc-hrow", { hasText: "Sketch the depth contours layer for the chart view" });
    const resume = codexRow.locator("button.aos-spc-hresume");
    await expect(resume).toBeEnabled();
    await expect(resume).toHaveAttribute("title", "Resumes in workspaces/harbor-map");
    await resume.click();
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    // D7 for Codex (codex-cli 0.162.0): `-C <folder>` names the terminal's folder, so Codex resumes there without asking
    // which folder to use. The fixture's codex stub echoes what it was given.
    const dir = FX.v("workspaces/harbor-map");
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain(`[fixture codex stub] resume -C ${dir} 0199a1b2-0000-4000-8000-000000000001`);
    const s = await win.evaluate(() => {
      const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { cwd: string; meta: { host: string; sessionId: string | null; place: { workspace?: string } | null } } | undefined } } } }).aosHost.plugin.terminalPool;
      const t = p.get(p.selectedId() ?? "");
      return t ? { cwd: t.cwd, host: t.meta.host, sessionId: t.meta.sessionId, workspace: t.meta.place?.workspace ?? null } : null;
    });
    expect(s).toEqual({ cwd: dir, host: "codex", sessionId: "0199a1b2-0000-4000-8000-000000000001", workspace: "harbor-map" });
    // The active row sits under ws:harbor-map's head (TermList draws heads and rows as flat siblings): its nearest head.
    expect(await win.evaluate(() => {
      let n = document.querySelector(".aos-tl-row.aos-term-tab-active")?.previousElementSibling ?? null;
      while (n && !n.matches(".aos-tl-group")) n = n.previousElementSibling;
      return n?.getAttribute("data-group") ?? null;
    })).toBe("ws:harbor-map");
    // The stub echoes and exits, so the row ends: a terminal that knows its thread resumes that same thread by its id
    // (not `codex resume --last`), with `-C <folder>` again (TM6, CX16).
    const endbar = content(win).locator(".aos-term-endbar button");
    await expect(endbar).toHaveText(["Restart", "Resume", "Open a shell here"], { timeout: 10_000 });
    const again = content(win).locator(".aos-term-endbar button", { hasText: /^Resume$/ });
    await expect(again).toHaveAttribute("title", "Resume this conversation (0199a1b2…)");
    const line = `[fixture codex stub] resume -C ${dir} 0199a1b2-0000-4000-8000-000000000001`;
    const times = async () => (await terminalText(win)).split(line).length - 1;
    const was = await times();
    await again.click();
    await expect.poll(times, { timeout: 10_000 }).toBeGreaterThan(was);
  });

  test("Brain: Review shows the Codex session's batch beside Claude Code's, titled as Sessions titles the thread; nothing in the hub needs a host, and Library opens a memory (brain-hub §5)", async () => {
    const { win } = app();
    const C = content(win);
    const b = expected().brain;
    const modeTab = (m: string) => C.locator(`.aos-brain-modes [role="tab"][data-mode="${m}"]`);
    const batch = (key: string) => C.locator(`.aos-brain-rv-left button.aos-brain-rv-batch[data-key="${key}"]`);
    await openTab(win, "memory");
    await modeTab("review").click();
    await expect(modeTab("review")).toHaveAttribute("aria-selected", "true");
    // The Codex thread has no name in Codex's session index, so its batch takes its first prompt, as Sessions does; the
    // runtime read both hosts' sessions though only Codex is on.
    const codex = b.batches.find((x) => x.key === b.sessions.codex)!;
    expect(codex).toMatchObject({ host: "codex", title: "Sketch the depth contours layer for the chart view" });
    await expect(batch(codex.key).locator(".aos-brain-rv-rtitle")).toHaveText(codex.title);
    await expect(batch(codex.key).locator(".aos-brain-rv-rmeta > .aos-brain-mono")).toHaveText("codex");
    await expect(batch(codex.key).locator(".aos-brain-dot")).toHaveClass(/is-codex/);
    await expect(batch(b.sessions.claude).locator(".aos-brain-rv-rmeta > .aos-brain-mono")).toHaveText("claude");
    await expect(batch(b.sessions.claude).locator(".aos-brain-dot")).toHaveClass(/is-claude/);
    await batch(codex.key).click();
    const main = C.locator(".aos-brain-rv-main");
    await expect(main.locator("h2")).toHaveText(codex.title);
    await expect(main.locator(".aos-brain-rv-meta")).toHaveText(new RegExp(`^codex · today \\d{2}:\\d{2} · session ${codex.key.slice(0, 8)}$`));
    expect(await main.locator("article.aos-brain-rv-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")))).toEqual(codex.paths);
    await expect(main.locator("button.aos-brain-rv-keepnew")).toBeEnabled();
    // No mode offers a host: no host menu, no ❯_ button, nothing that names Claude Code or Codex as a choice.
    for (const m of ["review", "library", "bootstrap", "map", "health"]) {
      await modeTab(m).click();
      await expect(C.locator(".aos-brain-body")).toHaveAttribute("data-mode", m);
      await expect(C.locator(".aos-brain [data-host], .aos-brain .aos-hm")).toHaveCount(0);
      await expect(C.locator(".aos-brain button").filter({ hasText: /❯_|Claude Code|Codex/ })).toHaveCount(0);
    }
    // Library opens the Codex session's memory in the reader.
    const rel = codex.paths[1];
    await modeTab("library").click();
    await C.locator(`.aos-lib-list button.aos-lib-row[data-path="${rel}"]`).click();
    await expect(C.locator("section.aos-lib-reader")).toHaveAttribute("data-path", rel);
    await expect(C.locator("section.aos-lib-reader h2")).toHaveText("Depths in metres");
    await expect(C.locator("section.aos-lib-reader .aos-lib-meta > span").nth(3)).toHaveText(`auto-wrap · session ${codex.key.slice(0, 8)}`);
    await expect(C.locator("section.aos-lib-reader .aos-lib-md")).toContainText("Show depths in metres with one decimal place.");
    await modeTab("review").click();
  });

  test("Brain › Bootstrap on Codex: BRAIN.md's budgets and sections, what Codex's first prompt starts with; Unpin, Mark complete, Mark the 2 complete… and the recall preview offered; SESSION.md's not-wrapped line names $agenticos:wrap", async () => {
    const { win } = app();
    const C = content(win);
    const b = expected().brain;
    await openTab(win, "memory");
    await C.locator('.aos-brain-modes [role="tab"][data-mode="bootstrap"]').click();
    const bs = C.locator(".aos-brain-bootstrap");
    await expect(bs.locator(".aos-brain-bs-sub")).toHaveText("Injected on the first prompt in Claude Code and Codex");
    await expect(bs.locator('[data-budget="brain"] [role="progressbar"]')).toHaveAttribute("aria-valuenow", String(b.sources.tokens));
    await expect(bs.locator('section[data-section="rules"] button[data-act="unpin"]')).toHaveCount(b.sources.sections.rules.paths.length);
    await expect(bs.locator('section[data-section="active"] button[data-act="complete"]')).toHaveCount(b.sources.sections.active.paths.length);
    await expect(bs.locator('button[data-act="complete-shipped"]')).toHaveText("Mark the 2 complete…");
    for (const sel of ['button[data-act="unpin"]', 'button[data-act="complete"]', 'button[data-act="complete-shipped"]', 'button[data-act="recall"]']) await expect(bs.locator(sel).first()).toBeEnabled();
    await expect(bs.locator('[data-bs="recall"]').getByRole("textbox", { name: "Prompt to preview" })).toBeEditable();
    // The runtime wrote Codex's wrap command into SESSION.md on this machine; the card reads it from there.
    expect(fs.readFileSync(FX.v("brain/_index/SESSION.md"), "utf8")).toMatch(/not wrapped \(provider: none\) — run \$agenticos:wrap\.$/m);
    await expect(bs.locator(".aos-brain-bs-wrap")).toHaveText("Not wrapped yet · $agenticos:wrap promotes the tagged lines");
  });

  test("Brain › Map on Codex: graphify's communities, a community's card and Around a memory draw as on any machine, and nothing in them names a host", async () => {
    const { win } = app();
    const C = content(win);
    const m = expected().brain.map;
    await openTab(win, "memory");
    await C.locator('.aos-brain-modes [role="tab"][data-mode="map"]').click();
    const map = C.locator("section.aos-brain-map");
    await map.locator('button.aos-brain-mapview[data-map-view="communities"]').click();
    expect(await map.locator("button.aos-brain-bubble").evaluateAll((els) => els.map((e) => e.getAttribute("data-community")))).toEqual(m.communities.map((c) => c.id));
    await map.locator(`button.aos-brain-bubble[data-community="${m.communities[0].id}"]`).click();
    await expect(map.locator("aside.aos-brain-mapcard h2")).toHaveText(m.communities[0].name);
    await expect(map.locator("aside.aos-brain-mapcard button.aos-brain-mapmember")).toHaveCount(m.communities[0].paths.length);
    await map.locator('button.aos-brain-mapview[data-map-view="around"]').click();
    await expect(map.locator("button.aos-brain-arcentre")).toHaveCount(1);
    await expect(map.locator("button").filter({ hasText: /❯_|Claude Code|Codex/ })).toHaveCount(0);
    await map.locator('button.aos-brain-mapview[data-map-view="communities"]').click();
  });

  test("Brain › Health on Codex: the six tiles, the duplicate pair, each hygiene fix and Dead weight's two actions offered, none naming a host", async () => {
    const { win } = app();
    const C = content(win);
    const b = expected().brain;
    await openTab(win, "memory");
    await C.locator('.aos-brain-modes [role="tab"][data-mode="health"]').click();
    const hl = C.locator(".aos-brain-health");
    await expect(hl.locator("[data-tile]")).toHaveCount(6);
    await expect(hl.locator('[data-tile="unused"] .aos-brain-hl-tv')).toHaveText(String(b.usage.never.length));
    await expect(hl.locator(".aos-brain-hl-pair button")).toHaveText(["Compare", "Not duplicates"]);
    expect(await hl.locator('.aos-brain-hl-hyg button[data-act="fix"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-fix")))).toEqual(["sources", "types", "descriptions", "index", "drafts"]);
    for (const k of ["sources", "types", "descriptions", "index", "drafts"]) await expect(hl.locator(`[data-hl-key="fix:${k}"]`)).toBeEnabled();
    await expect(hl.locator('[data-hl-key="dw:review"]')).toHaveText(`Review the ${b.usage.never.length}`);
    await expect(hl.locator('[data-hl-key="dw:archive"]')).toHaveText("Archive the 1 shipped…");
    await expect(hl.locator("button").filter({ hasText: /❯_|Claude Code|Codex/ })).toHaveCount(0);
    await C.locator('.aos-brain-modes [role="tab"][data-mode="review"]').click();
  });
});

test.describe("a Codex-only machine, the Spaces surface on", () => {
  const app = useApp({
    env: { AOS_APP_WRITE: "spaces" },
    prepare: () => {
      editJson(agenticos, (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = true; });
      editJson(FX.v("brain/_index/provider-state.json"), (j) => {
        j.name = "codex"; j.reason = "fixture"; j.codex = { ...(j.codex ?? {}), loggedIn: true, checkedAt: new Date().toISOString() };
      });
    },
  });

  test("New space: Blank folder starts Codex in ws:<slug>; Open with offers no Claude Code (spaces-redesign D15, host parity)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "spaces");
    const C = content(win);
    await C.locator(".aos-spc-list button.aos-spc-newbtn").click();
    const d = win.locator(".modal.mod-spc-new");
    await expect(d.locator(".aos-spc-dlgtitle")).toHaveText("New space");
    // Claude Code is off on this machine: no option at all; Codex, the host ⌘T starts, is picked.
    await expect(d.locator(".aos-spc-hostopt")).toHaveText(["Codex", "Terminal"]);
    await expect(d.locator(".aos-spc-hostopt[data-host='codex'] input")).toBeChecked();
    await d.locator("input[data-spc-field='name']").fill("Kelp Lab");
    await expect(d.locator(".aos-spc-dlgnote")).toHaveText("Pinned, then opened in Code with Codex.");
    await d.locator("button.aos-spc-confirm", { hasText: "Create space" }).click();
    await expect(d).toHaveCount(0);
    const dir = FX.v("workspaces/kelp-lab");
    expect(fs.readFileSync(path.join(dir, "workspace.md"), "utf8")).toMatch(/^pinned: true$/m);
    for (const f of ["README.md", "CLAUDE.md", "AGENTS.md"]) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    await expect(rail(win, "term")).toHaveClass(/is-active/);
    // The fixture's stub `codex` echoes what the line gave it; never a `claude` line.
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture codex stub]");
    expect(await terminalText(win)).not.toContain("[fixture claude stub]");
    const s = await win.evaluate(() => {
      const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { cwd: string; meta: { host: string; place: { workspace?: string } | null } } | undefined } } } }).aosHost.plugin.terminalPool;
      const t = p.get(p.selectedId() ?? "");
      return t ? { cwd: t.cwd, host: t.meta.host, workspace: t.meta.place?.workspace ?? null } : null;
    });
    expect(s).toEqual({ cwd: dir, host: "codex", workspace: "kelp-lab" });
    expect(await win.evaluate(() => {
      let n = document.querySelector(".aos-tl-row.aos-term-tab-active")?.previousElementSibling ?? null;
      while (n && !n.matches(".aos-tl-group")) n = n.previousElementSibling;
      return n?.getAttribute("data-group") ?? null;
    })).toBe("ws:kelp-lab");
    // Back in Spaces it is selected, pinned at the top.
    await openTab(win, "spaces");
    await expect(C.locator('.aos-spc-row[data-workspace="kelp-lab"]')).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await expect(C.locator(".aos-spc-list .aos-spc-ghead .aos-spc-glabel").first()).toHaveText("PINNED");
    expect((await h.guard()).filter((e) => e.kind !== "read")).toEqual([]);
  });
});

test.describe("both hosts", () => {
  // Both hosts on and ready: every host button is on.
  const app = useApp({
    prepare: () => {
      editJson(agenticos, (j) => { j.hosts.claude.enabled = true; j.hosts.codex.enabled = true; });
      editJson(FX.v("brain/_index/provider-state.json"), (j) => { j.codex = { ...(j.codex ?? {}), loggedIn: true, checkedAt: new Date().toISOString() }; });
    },
  });

  test("Spaces: with both hosts ready the menu's New rows are both on, and every thread's Resume is on, in the workspace's place (spaces-redesign D7, D31)", async () => {
    const { win } = app();
    await openTab(win, "spaces");
    const C = content(win);
    await C.locator('.aos-spc-row[data-workspace="harbor-map"]').click();
    await expect(C.locator(".aos-spc-h1")).toHaveText("harbor-map");
    const head = C.locator(".aos-spc-head");
    await expect(head.locator(".aos-spc-split button.aos-spc-primary").first()).toBeEnabled();
    await head.locator("button.aos-spc-caret").click();
    const pop = C.locator(".aos-spc-pop");
    await expect(pop.locator(".aos-spc-poplabel")).toHaveText(["New Claude Code session", "New Codex session", "Terminal here", "Open last thread in Sessions"]);
    for (const key of ["new:claude", "new:codex", "terminal"]) await expect(pop.locator(`.aos-spc-popitem[data-key='${key}']`)).not.toHaveAttribute("aria-disabled", "true");
    await win.keyboard.press("Escape");
    const rows = C.locator(".aos-spc-history .aos-spc-hrow");
    const resume = rows.locator("button.aos-spc-hresume");
    await expect(resume).toHaveCount(4);
    for (const i of [0, 1, 2, 3]) await expect(resume.nth(i)).toBeEnabled();
    await expect(C.locator(".aos-spc-history .aos-spc-why")).toHaveCount(0);
    // A Codex thread resumes in the workspace's place like a Claude Code one (D7).
    await expect(rows.filter({ hasText: "Sketch the depth contours layer for the chart view" }).locator("button.aos-spc-hresume")).toHaveAttribute("title", "Resumes in workspaces/harbor-map");
    await expect(resume.nth(0)).toHaveAttribute("title", "Resumes in workspaces/harbor-map");
  });

  test("Notifications: one ask button per host", async () => {
    const { win } = app();
    await openTab(win, "notifications");
    await content(win).locator(".aos-nt-row", { hasText: "The Morning Edition" }).click();
    await expect(content(win).locator(".aos-nt-actions").first().locator("button", { hasText: "Deep dive" })).toHaveText(["Deep dive ❯_ claude", "Deep dive ❯_ codex"]);
  });

  test("Agent Teams: one Redirect button per host", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    const gate = content(win).locator(".aos-at-needs .aos-at-gate", { hasText: "harbor-01" });
    await expect(gate.locator("button", { hasText: "Redirect" })).toHaveText(["Redirect ❯_ claude", "Redirect ❯_ codex"]);
  });

  test("Settings: nothing is dimmed", async () => {
    const { win } = app();
    await openTab(win, "settings");
    await expect(content(win).locator(".aos-rt-count")).not.toHaveText("loading…");
    await expect(content(win).locator(".aos-st-row")).not.toHaveCount(0);
    await expect(content(win).locator(".aos-st-row.is-dim")).toHaveCount(0);
  });
});

test.describe("both hosts, Codex not logged in", () => {
  const app = useApp({
    prepare: () => {
      editJson(agenticos, (j) => { j.hosts.claude.enabled = true; j.hosts.codex.enabled = true; });
      // Codex is on but not logged in on this machine (the provider probe's cache): its launches are off with why.
      editJson(FX.v("brain/_index/provider-state.json"), (j) => { j.codex = { loggedIn: false, checkedAt: new Date().toISOString() }; });
    },
  });

  test("Spaces: the menu offers both hosts, the one not logged in off with why; its threads' Resume is off too, the other host's on (spaces-redesign D31)", async () => {
    const { win } = app();
    await openTab(win, "spaces");
    const C = content(win);
    await C.locator('.aos-spc-row[data-workspace="harbor-map"]').click();
    await expect(C.locator(".aos-spc-h1")).toHaveText("harbor-map");
    const head = C.locator(".aos-spc-head");
    await expect(head.locator(".aos-spc-split button.aos-spc-primary").first()).toBeEnabled();   // its last thread is Claude Code's
    await head.locator("button.aos-spc-caret").click();
    const pop = C.locator(".aos-spc-pop");
    await expect(pop.locator(".aos-spc-poplabel")).toHaveText(["New Claude Code session", "New Codex session", "Terminal here", "Open last thread in Sessions"]);
    await expect(pop.locator(".aos-spc-popitem[data-key='new:claude']")).not.toHaveAttribute("aria-disabled", "true");
    await expect(pop.locator(".aos-spc-popitem[data-key='new:codex']")).toHaveAttribute("aria-disabled", "true");
    await expect(pop.locator(".aos-spc-popitem[data-key='new:codex'] .aos-spc-popdetail")).toHaveText("Codex is not logged in");
    await win.keyboard.press("Escape");
    const rows = C.locator(".aos-spc-history .aos-spc-hrow");
    await expect(rows.locator("button.aos-spc-hresume")).toHaveCount(4);
    await expect(rows.nth(0).locator("button.aos-spc-hresume")).toBeEnabled();   // Claude Code's
    for (const i of [1, 2, 3]) {
      await expect(rows.nth(i).locator("button.aos-spc-hresume")).toBeDisabled();
      await expect(rows.nth(i).locator("button.aos-spc-hresume")).toHaveAttribute("title", "Codex is not logged in");
    }
    // Said once, under the first row it turns off.
    await expect(C.locator(".aos-spc-history .aos-spc-why")).toHaveText(["Codex is not logged in"]);
  });
});

test.describe("telemetry off", () => {
  const app = useApp({
    prepare: () => {
      editJson(agenticos, (j) => { j.telemetry = { ...(j.telemetry ?? {}), enabled: false }; });
      fs.rmSync(FX.v("brain/_index/agent-runs/live"), { recursive: true, force: true });
    },
  });

  test("no agent-runs/live is created and no reconcile runs on load; Runs still reads runs.jsonl", async () => {
    const h = app();
    await openTab(h.win, "runs");
    await expect(content(h.win).locator(".aos-runs-row")).not.toHaveCount(0);
    await h.win.waitForTimeout(1000);
    expect(fs.existsSync(FX.v("brain/_index/agent-runs/live"))).toBe(false);
    const log = await h.guard();
    expect(log.filter((e) => e.kind === "write" && e.what.includes("agent-runs/live"))).toEqual([]);
    // The reconcile spawn is the only script-only spawn on load (the guard shortens its path to "…").
    expect(log.filter((e) => e.kind === "spawn" && (/reconcile-sessions\.js/.test(e.what) || /…$/.test(e.what)))).toEqual([]);
  });

  test("Brain: Health's Never used tile reads off and Dead weight gives the reason instead of counts (D8, D20); Library's USE says telemetry is off", async () => {
    const { win } = app();
    const C = content(win);
    await openTab(win, "memory");
    await C.locator('.aos-brain-modes [role="tab"][data-mode="health"]').click();
    const t = C.locator('.aos-brain-health [data-tile="unused"]');
    await expect(t.locator(".aos-brain-hl-tv")).toHaveText("–");
    await expect(t.locator(".aos-brain-hl-tw")).toHaveText("off");
    await expect(t.locator(".aos-brain-hl-tn")).toHaveText("telemetry is off");
    await expect(t).toHaveAttribute("data-tone", "off");
    const body = C.locator('.aos-brain-health section[data-anchor="deadweight"] .aos-brain-hl-cbody');
    await expect(body).toHaveAttribute("data-state", "off");
    await expect(body).toHaveText("telemetry.enabled is off, so nothing is logged. Turn it on (aos config set telemetry.enabled true) to see what sessions use.");
    await expect(C.locator('.aos-brain-health [data-hl-key^="dw:"]')).toHaveCount(0);
    await C.locator('.aos-brain-modes [role="tab"][data-mode="library"]').click();
    await C.locator(`.aos-lib-list button.aos-lib-row[data-path="${expected().brain.duplicate[1]}"]`).click();
    await expect(C.locator('aside.aos-lib-context section[data-section="use"] .aos-lib-cnote')).toHaveText("Telemetry is off in this vault, so no use is logged (Settings, telemetry.enabled).");
  });
});

test.describe("before any session logs a memory use", () => {
  // The usage log is gone (as on a vault before its first session after `aos upgrade`), and the scan's cache rebuilt
  // from it by the runtime's own brain-hub.js.
  const app = useApp({
    prepare: () => {
      fs.rmSync(FX.v("brain/_index/memory-usage.jsonl"), { force: true });
      const r = spawnSync(process.execPath, [FX.v("brain/scripts/brain-hub.js")], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
      if (r.status !== 0) throw new Error(`brain-hub.js failed: ${r.stderr}`);
      if (JSON.parse(fs.readFileSync(FX.v("brain/_index/brain-hub.json"), "utf8")).usage.since !== null) throw new Error("brain-hub.json still counts use");
    },
  });

  test("Brain › Library: newest first with no Use facet, and USE says the log starts with the next session (D8)", async () => {
    const { win } = app();
    const C = content(win);
    const b = expected().brain;
    await openTab(win, "memory");
    await C.locator('.aos-brain-modes [role="tab"][data-mode="library"]').click();
    await expect(C.locator(".aos-lib-sort")).toHaveText("newest first");
    await expect(C.locator('.aos-lib-facet[data-facet="use"]')).toBeHidden();
    await expect(C.locator(".aos-lib-list .aos-lib-use")).toHaveCount(0);
    await C.locator(`.aos-lib-list button.aos-lib-row[data-path="${b.duplicate[1]}"]`).click();
    await expect(C.locator('aside.aos-lib-context section[data-section="use"] .aos-lib-cnote')).toHaveText("No usage yet: the log starts with the next session.");
  });

  test("Brain › Health and Map: Never used and Dead weight are collecting (no counts, nothing to review or archive), and a community's card leaves out its week's use", async () => {
    const { win } = app();
    const C = content(win);
    const m = expected().brain.map;
    await openTab(win, "memory");
    await C.locator('.aos-brain-modes [role="tab"][data-mode="health"]').click();
    const t = C.locator('.aos-brain-health [data-tile="unused"]');
    await expect(t.locator(".aos-brain-hl-tv")).toHaveText("–");
    await expect(t.locator(".aos-brain-hl-tw")).toHaveText("collecting");
    await expect(t.locator(".aos-brain-hl-tn")).toHaveText("nothing logged yet");
    const body = C.locator('.aos-brain-health section[data-anchor="deadweight"] .aos-brain-hl-cbody');
    await expect(body).toHaveAttribute("data-state", "collecting");
    await expect(body).toHaveText("Collecting: nothing is logged yet. The counts show once the log holds 30 days.");
    await expect(C.locator('.aos-brain-health [data-hl-key^="dw:"]')).toHaveCount(0);
    await C.locator('.aos-brain-modes [role="tab"][data-mode="map"]').click();
    const c = m.communities[0];
    const unreviewed = c.paths.filter((p) => expected().brain.unreviewed.includes(p)).length;
    await C.locator(`section.aos-brain-map button.aos-brain-bubble[data-community="${c.id}"]`).click();
    await expect(C.locator("section.aos-brain-map .aos-brain-mapcardline")).toHaveText(`${c.paths.length} memories · ${unreviewed} unreviewed`);
    await expect(C.locator("section.aos-brain-map .aos-brain-mapmembernote.is-used")).toHaveCount(0);
  });
});

test.describe("a data.json from 0.17 or earlier", () => {
  // The app keeps the plugin's data.json in its own userData (never the vault): write an old one there before launch.
  const old = { costEnabled: true, telemetryEnabled: true, statusBarEnabled: true, liveTailPollMs: 1500 };
  const dirs = [
    path.join(FX.home, "Library", "Application Support", "AgenticOS Workbench (dev)", "plugins"),
    path.join(FX.home, "Library", "Application Support", "AgenticOS Workbench (e2e)", "plugins"),
  ];
  const app = useApp({ prepare: () => { for (const d of dirs) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "agentic-os.json"), `${JSON.stringify(old, null, 2)}\n`); } } });

  test("loses costEnabled and telemetryEnabled on the first load; the other keys are kept", async () => {
    const { win } = app();
    const userData = await win.evaluate(() => (window as unknown as { aosHost: { info: { userData: string } } }).aosHost.info.userData);
    const file = path.join(userData, "plugins", "agentic-os.json");
    await expect.poll(() => { try { return Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return []; } }).not.toContain("costEnabled");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(saved).not.toHaveProperty("telemetryEnabled");
    expect(saved.liveTailPollMs).toBe(1500);
    const settings = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { settings: Record<string, unknown> } } }).aosHost.plugin.settings);
    expect(settings).not.toHaveProperty("costEnabled");
    expect(settings.liveTailPollMs).toBe(1500);
  });
});

test.describe("a runtime that predates aos config (before 0.17)", () => {
  // The vault's CLI without config-cmd.js: `aos config list` fails with "Cannot find module".
  const app = useApp({ prepare: () => fs.rmSync(FX.v("brain/scripts/cli/config-cmd.js")) });

  test("Settings asks for aos upgrade with a button; the WORKBENCH rows still work", async () => {
    const { win } = app();
    await openTab(win, "settings");
    const failure = content(win).locator(".aos-st-failure");
    await expect(failure).toContainText("This vault's runtime has no `aos config` yet: run `aos upgrade` to control every setting from here.");
    await expect(failure.locator("button")).toHaveText("❯_ aos upgrade");
    await expect(content(win).locator(".aos-st-master")).toHaveCount(0);
    await expect(content(win).locator(".aos-st-plugin .setting-item-name", { hasText: "Vault root" })).toBeVisible();
  });
});

test.describe("no teams yet, with the Agent Teams surface on", () => {
  const app = useApp({ env: { AOS_APP_WRITE: "teams" }, prepare: () => fs.rmSync(FX.v("persona/teams"), { recursive: true, force: true }) });

  test("Seed the example team runs aos team init, which writes the example team (AT1)", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    await expect(content(win).locator(".aos-at-emptytitle")).toHaveText("No teams yet");
    await content(win).locator("button.mod-cta", { hasText: "Seed the example team" }).click();
    await expect(win.locator(".notice-container")).toContainText("seeded persona/teams/example/ from the example team");
    await expect.poll(() => fs.existsSync(FX.v("persona/teams/example/TEAM.md"))).toBe(true);
    // One team: no chip bar, the team's own section.
    await expect(content(win).locator(".aos-rt-count")).toHaveText("0 gates waiting · 1 team");
    await expect(content(win).getByRole("region", { name: "Example team" })).toContainText("lead Lead · 3 members · 0 open");
    expect((await app().guard()).map((e) => `${e.kind} ${e.what}`)).toEqual([]);
  });
});

test.describe("a vault whose HUD ran in Obsidian first", () => {
  const obsidianData = FX.v(".obsidian/plugins/agentic-os/data.json");
  const saved = { autoOpenSidebarOnStart: true, terminalEmbedHeight: 621, statusBarEnabled: true };
  const appData = path.join(FX.home, "Library", "Application Support", "AgenticOS Workbench (e2e)", "plugins", "agentic-os.json");
  const app = useApp({
    prepare: () => {
      fs.mkdirSync(path.dirname(obsidianData), { recursive: true });
      fs.writeFileSync(obsidianData, `${JSON.stringify(saved, null, 2)}\n`);
      fs.rmSync(appData, { force: true });
    },
  });

  test("the app starts with Obsidian's plugin settings (the SidebarHUD opens), never writes them, and saves its own copy", async () => {
    const { win } = app();
    await expect(win.locator(".aos-host-right .aos-sb-status")).toBeVisible();
    const before = fs.readFileSync(obsidianData, "utf8");
    // Copied at first start, before any setting changes, so the old plugin folder can go (docs/migrating-to-1.0.md). The
    // Brain badge's first count then records when Review was last open (brain-hub D16) and saves the settings, which
    // keeps the HUD's own keys only: terminalEmbedHeight, one it no longer has, goes; every setting stays.
    const copy = () => JSON.parse(fs.readFileSync(appData, "utf8")) as Record<string, unknown>;
    await expect.poll(() => typeof copy().brainReviewSeenAt).toBe("string");
    expect(copy()).toMatchObject({ autoOpenSidebarOnStart: saved.autoOpenSidebarOnStart, statusBarEnabled: saved.statusBarEnabled });
    expect(copy()).not.toHaveProperty("terminalEmbedHeight");
    expect(await command(win, "host:settings")).toBe(true);
    const pane = win.locator(".modal.mod-settings .vertical-tab-content-container");
    const toggle = pane.locator(".setting-item", { has: win.locator(".setting-item-name", { hasText: /^Auto-open sidebar on start$/ }) }).locator(".checkbox-container");
    await expect(toggle).toHaveClass(/is-enabled/);
    await toggle.click();
    await expect.poll(() => (fs.existsSync(appData) ? (JSON.parse(fs.readFileSync(appData, "utf8")) as { autoOpenSidebarOnStart?: boolean }).autoOpenSidebarOnStart : undefined)).toBe(false);
    expect(fs.readFileSync(obsidianData, "utf8")).toBe(before);
    await win.keyboard.press("Escape");
  });
});

test.describe("the app's own default: every verified surface writes", () => {
  // Every other spec runs read-only or with the surfaces it names (AOS_APP_WRITE); this one runs as a user's app does.
  const app = useApp({ env: { AOS_APP_WRITE: undefined } });

  test("every verified surface is on, with no write-mode item and no Write Access menu", async () => {
    const h = app();
    const info = await h.win.evaluate(() => (window as unknown as { aosHost: { info: { writeSurfaces: string[]; writeSource: string } } }).aosHost.info);
    expect(info).toMatchObject({ writeSource: "default", writeSurfaces: SURFACES.filter((s) => s.verified).map((s) => s.id) });
    await expect(h.win.locator(".aos-host-status .aos-host-mode")).toBeHidden();
    const first = await h.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items[0].submenu!.items.map((i) => i.label));
    expect(first).not.toContain("Write Access");
    // A To-Do tick writes with nothing switched on anywhere.
    await openTab(h.win, "todo");
    await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
    await expect.poll(() => fs.readFileSync(FX.v("TODO.md"), "utf8")).toContain("- [x] Call the chart vendor");
  });
});
