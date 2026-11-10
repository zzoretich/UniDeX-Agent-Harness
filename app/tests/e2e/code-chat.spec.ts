import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, appEnv, command, content, expectNoErrors, openTab, useApp } from "./harness";

// The Code tab's chat view (spec 2026-11-09-code-chat C1, C3, C5, C13; rulings R3, R28, R32): an agent terminal opens in a
// chat drawn from the cache its follower writes; ⌘J flips the middle to the same live PTY and back, nothing restarts; a
// shell has no chat and no switch; a Claude Code terminal's status line copy shows under the composer, the hint when there
// is none; with the Code chat surface off an agent terminal opens in its terminal and the switch says so.
//
// A shell stands in for the agent (the fixture's CLIs exit at once): made with host claude (or codex) and a terminal key,
// it carries AOS_TERMINAL while the surface is on, so main follows it as an agent terminal. Its conversation is named by an
// id with no transcript, so the follower finds nothing to write and the fixture cache below is what the chat reads.

const KEY = "aaaaaaaa-0000-4000-8000-000000000001";
const KEY2 = "bbbbbbbb-0000-4000-8000-000000000002";
const SID = "cccccccc-0000-4000-8000-000000000003";
const SID2 = "dddddddd-0000-4000-8000-000000000004";
const C = (win: Page) => content(win);
const t = "2026-11-09T10:00:00.000Z";

/** A follower's cache as the runtime writes it: one session event per line, then the conversation. */
function writeCache(key: string, events: object[]): void {
  const file = FX.v(`brain/_index/code/${key}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

/** A conversation: a turn that edited a file, then a turn still running. */
function conversation(id: string, file: string): object[] {
  return [
    { t, kind: "session", id, model: "fixture-model", turn: 0 },
    { t, kind: "prompt", text: "Make the tide parser read the new station format", turn: 1 },
    { t, kind: "text", text: "I'll update the parser first.", turn: 1 },
    { t, kind: "tool", id: "tu1", name: "Edit", toolKind: "edit", filePath: file, summary: "{\"old_string\":\"a\",\"new_string\":\"b\"}", turn: 1 },
    { t, kind: "tool_result", id: "tu1", ok: true, summary: "The file was updated.", turn: 1 },
    { t, kind: "done", ok: true, usd: null, estimated: false, model: "fixture-model", turn: 1 },
    { t, kind: "prompt", text: "Now run the tests", turn: 2 },
  ];
}

type Meta = { host: "claude" | "codex"; terminalKey: string; sessionId: string; label?: string };
/** Starts the stand-in agent terminal and selects it; its pool id. */
const startAgent = (win: Page, meta: Meta): Promise<string> => win.evaluate((m) => {
  const p = (window as unknown as { aosHost: { plugin: { terminalPool: { create(o: object): { id: string }; select(id: string): void } } } }).aosHost.plugin.terminalPool;
  const s = p.create({ meta: m });
  p.select(s.id);
  return s.id;
}, meta);
const select = (win: Page, id: string) => win.evaluate((i) => (window as unknown as { aosHost: { plugin: { terminalPool: { select(id: string): void } } } }).aosHost.plugin.terminalPool.select(i), id);
/** The terminal's process id, as main started it. */
const pidOf = (win: Page, id: string) => win.evaluate((i) => {
  const s = (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): unknown } } } }).aosHost.plugin.terminalPool.get(i) as { pty?: { pid?: number } } | undefined;
  return s?.pty?.pid ?? null;
}, id);

const chat = (win: Page) => C(win).locator(".aos-cc");
const body = (win: Page) => C(win).locator(".aos-term-body");
const sw = (win: Page) => C(win).locator(".aos-cv");

test.describe("the Code chat surface on", () => {
  test.describe.configure({ mode: "serial" });
  const app = useApp({ env: { AOS_APP_WRITE: "code" } });
  let agent = "";

  test("an agent terminal opens in its chat: your prompt as a bubble, the edit as a tool row that opens; the top bar names it (C1)", async () => {
    const { win } = app();
    writeCache(KEY, conversation(SID, FX.v("workspaces/harbor-map/src/tide.ts")));
    await openTab(win, "term");
    agent = await startAgent(win, { host: "claude", terminalKey: KEY, sessionId: SID, label: "Tide parser" });
    await expect(chat(win)).toBeVisible();
    await expect(body(win)).toBeHidden();
    await expect(chat(win).locator(".aos-ss-prompt .aos-ss-bubble").first()).toHaveText("Make the tide parser read the new station format");
    const edit = chat(win).locator(".aos-ss-tool[data-kind='edit']");
    await expect(edit).toHaveCount(1);
    await expect(edit.locator(".aos-ss-target")).toHaveText("(workspaces/harbor-map/src/tide.ts)");
    await edit.locator(".aos-ss-toolline").click();
    await expect(edit.locator(".aos-ss-toolbody")).toBeVisible();
    await expect(edit.locator(".aos-ss-toolline")).toHaveAttribute("aria-expanded", "true");
    // The top bar: the title, the place, "Host · Model" from the conversation, and the switch on Chat.
    await expect(C(win).locator(".aos-term-headtitle")).toHaveText("Tide parser");
    await expect(C(win).locator(".aos-term-head .aos-term-place")).toContainText("Vault");
    await expect(C(win).locator(".aos-term-head .aos-term-chip").first()).toHaveText("Claude Code · fixture-model");
    await expect(sw(win)).toBeVisible();
    await expect(sw(win)).toHaveAttribute("data-tour", "code-view");
    await expect(sw(win).locator("button[aria-pressed='true']")).toHaveText("Chat");
    // The composer sits in the chat's column with its chips; the second turn still runs, so Stop is offered.
    await expect(chat(win).locator(".aos-tc")).toBeVisible();
    // No access was chosen for this terminal, so no access chip; the model is the conversation's.
    await expect(chat(win).locator(".aos-tc-chip:visible")).toHaveText(["@ file", "/ commands", "Snippets", "fixture-model"]);
    await expect(chat(win).locator(".aos-cc-stop")).toBeVisible();
  });

  test("Stop writes Esc to the agent's terminal while its turn runs", async () => {
    const { win } = app();
    await win.evaluate((i) => {
      const s = (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { write(d: string): void } } } } }).aosHost.plugin.terminalPool.get(i);
      const w = (window as unknown as { __writes: string[] });
      w.__writes = [];
      const orig = s.write.bind(s);
      s.write = (d: string) => { w.__writes.push(d); orig(d); };
    }, agent);
    await chat(win).locator(".aos-cc-stop").click();
    expect(await win.evaluate(() => (window as unknown as { __writes: string[] }).__writes)).toEqual(["\u001b"]);
  });

  test("⌘J shows the same terminal, its process unchanged; the choice is remembered; ⌘J again restores the chat (C1)", async () => {
    const { win } = app();
    const pid = await pidOf(win, agent);
    expect(pid).toBeGreaterThan(0);
    await win.keyboard.press("Meta+j");
    await expect(body(win)).toBeVisible();
    await expect(chat(win)).toBeHidden();
    await expect(sw(win).locator("button[aria-pressed='true']")).toContainText("Terminal");
    expect(await pidOf(win, agent)).toBe(pid);
    // The composer is back under the terminal, as before.
    await expect(C(win).locator(".aos-term-main > .aos-tc")).toBeVisible();
    // Another terminal and back: still the terminal.
    expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
    await expect(sw(win)).toHaveCount(0);
    await select(win, agent);
    await expect(body(win)).toBeVisible();
    await expect(chat(win)).toBeHidden();
    expect(await command(win, "agentic-os:toggle-code-view")).toBe(true);
    await expect(chat(win)).toBeVisible();
    await expect(chat(win).locator(".aos-ss-prompt .aos-ss-bubble").first()).toHaveText("Make the tide parser read the new station format");
    expect(await pidOf(win, agent)).toBe(pid);
  });

  test("a shell has no chat and no switch (C3)", async () => {
    const { win } = app();
    expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
    await expect(body(win)).toBeVisible();
    await expect(chat(win)).toBeHidden();
    await expect(sw(win)).toHaveCount(0);
    // Its composer stays under the terminal, with no / commands, access or model.
    await expect(C(win).locator(".aos-term-main > .aos-tc .aos-tc-chip:visible")).toHaveText(["@ file", "Snippets"]);
    // ⌘J leaves a shell as it is.
    await win.keyboard.press("Meta+j");
    await expect(body(win)).toBeVisible();
    await expect(chat(win)).toBeHidden();
  });

  test("the tour's Chat or terminal step finds the switch", async () => {
    const { win } = app();
    await select(win, agent);
    await expect(sw(win)).toBeVisible();
    const r = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { tour: { probe(id: string, ms: number): Promise<Array<{ ref: string; status: string }>> } } } }).aosHost.plugin.tour.probe("code", 10_000));
    expect(r.find((x) => x.ref === "code.chat-view")?.status).toBe("found");
  });

  test("the status line: the hint while there is no copy; the copy's three rows, colours and links when there is; a link opens its tab (C5, R3, R32)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    await select(win, agent);
    const status = chat(win).locator(".aos-cc-status");
    await expect(status).toHaveText("Status line in the terminal ⌘J");
    const file = FX.v(`brain/_index/statusline/${KEY}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ansi = "\u001b[2mfixture-model │ Vault\u001b[0m \u001b[35m⎇ main\u001b[0m\n"
      + "\u001b[32m████░░░░░░ 41%\u001b[0m \u001b[2m│ $1.42\u001b[0m\n"
      + "\u001b]8;;agenticos://workbench?tab=todo\u0007\u001b[33m2 to-dos\u001b[0m\u001b]8;;\u0007 \u001b[2m│ 3 drafts\u001b[0m\n";
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), session_id: SID, transcript_path: null, ansi }));
    await expect(status.locator(".aos-cc-statusline")).toHaveCount(3);
    await expect(status.locator(".aos-cc-statusline").nth(1)).toHaveText("████░░░░░░ 41% │ $1.42");
    await expect(status.locator("span", { hasText: "████░░░░░░ 41%" })).toHaveAttribute("style", /--udx-term-green/);
    const link = status.locator("a", { hasText: "2 to-dos" });
    await expect(link).toHaveAttribute("href", "agenticos://workbench?tab=todo");
    const url = win.url();
    await link.click();
    await expect(win.locator(".aos-wb-railbtn[data-tab='todo']")).toHaveClass(/is-active/);
    expect(win.url()).toBe(url);
    // Gone again: the hint.
    fs.rmSync(file);
    await openTab(win, "term");
    await select(win, agent);
    await expect(chat(win).locator(".aos-cc-status")).toHaveText("Status line in the terminal ⌘J");
    expectNoErrors(h);
  });

  test("a long chat opens at its end, and so does a terminal you come back to", async () => {
    const { win } = app();
    const key = "eeeeeeee-0000-4000-8000-000000000005";
    const events: object[] = [{ t, kind: "session", id: "ffffffff-0000-4000-8000-000000000006", model: null, turn: 0 }];
    for (let i = 1; i <= 40; i++) events.push({ t, kind: "prompt", text: `Question ${i}`, turn: i }, { t, kind: "text", text: `Answer ${i}`, turn: i }, { t, kind: "done", ok: true, turn: i });
    writeCache(key, events);
    // From a shell, where the chat is hidden, to an agent terminal whose chat came in meanwhile (started elsewhere).
    expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
    await expect(chat(win)).toBeHidden();
    const shellId = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null } } } }).aosHost.plugin.terminalPool.selectedId());
    const long = await win.evaluate((k) => {
      const p = (window as unknown as { aosHost: { plugin: { terminalPool: { create(o: object): { id: string } } } } }).aosHost.plugin.terminalPool;
      return p.create({ meta: { host: "claude", terminalKey: k, sessionId: "ffffffff-0000-4000-8000-000000000006" } }).id;
    }, key);
    await expect.poll(() => win.evaluate((i) => (window as unknown as { aosHost: { plugin: { codeFeeds: { get(id: string): { state: { rows: unknown[] } } | null } } } }).aosHost.plugin.codeFeeds.get(i)?.state.rows.length ?? 0, long)).toBe(120);
    await select(win, long);
    const last = chat(win).locator(".aos-ss-bubble", { hasText: /^Question 40$/ });
    await expect(last).toBeInViewport();
    // Away to the shell and back.
    await select(win, shellId ?? "");
    await expect(chat(win)).toBeHidden();
    await select(win, long);
    await expect(last).toBeInViewport();
    // Another agent's chat and back.
    await select(win, agent);
    await expect(chat(win).locator(".aos-ss-bubble").first()).toHaveText("Make the tide parser read the new station format");
    await select(win, long);
    await expect(last).toBeInViewport();
  });
});

test.describe("the Code chat surface off (a run whose AOS_APP_WRITE leaves it out)", () => {
  const app = useApp();

  test("an agent terminal opens in its terminal, and the switch says the chat view is off (C13)", async () => {
    const h = app();
    const { win } = h;
    writeCache(KEY, conversation(SID, FX.v("workspaces/harbor-map/src/tide.ts")));
    await openTab(win, "term");
    await startAgent(win, { host: "claude", terminalKey: KEY, sessionId: SID });
    await expect(body(win)).toBeVisible();
    await expect(chat(win)).toBeHidden();
    await expect(sw(win)).toHaveText("Chat view is off · Settings");
    await expect(sw(win)).toHaveAttribute("data-tour", "code-view");
    await win.keyboard.press("Meta+j");
    await expect(body(win)).toBeVisible();
    await expect(chat(win)).toBeHidden();
    expectNoErrors(h);
  });
});

const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};
const aos = (...args: string[]) => {
  const r = spawnSync("/bin/sh", [FX.v("brain/scripts/bin/aos"), ...args], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`aos ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
};

test.describe("a Codex-only machine, the Code chat surface on (variants.spec.ts's)", () => {
  const app = useApp({
    env: { AOS_APP_WRITE: "code" },
    prepare: () => {
      editJson(path.join(FX.claude, "agenticos.json"), (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = true; });
      aos("routines", "hosts", "--refresh");
      editJson(FX.v("brain/_index/provider-state.json"), (j) => {
        j.name = "codex"; j.reason = "fixture"; j.codex = { ...(j.codex ?? {}), loggedIn: true, checkedAt: new Date().toISOString() };
      });
    },
  });

  test("Code draws without errors, and a Codex terminal opens in its chat with the status line hint (host parity)", async () => {
    const h = app();
    const { win } = h;
    writeCache(KEY2, conversation(SID2, FX.v("workspaces/harbor-map/src/tide.ts")));
    await openTab(win, "term");
    await startAgent(win, { host: "codex", terminalKey: KEY2, sessionId: SID2 });
    await expect(chat(win)).toBeVisible();
    await expect(chat(win).locator(".aos-ss-prompt .aos-ss-bubble").first()).toHaveText("Make the tide parser read the new station format");
    await expect(C(win).locator(".aos-term-head .aos-term-chip").first()).toHaveText("Codex · fixture-model");
    await expect(chat(win).locator(".aos-cc-status")).toHaveText("Status line in the terminal ⌘J");
    await expect(chat(win).locator(".aos-tc-chip", { hasText: "/ commands" })).toBeVisible();
    expectNoErrors(h);
  });
});
