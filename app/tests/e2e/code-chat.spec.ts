import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, appEnv, command, content, expectNoErrors, openTab, terminalText, useApp } from "./harness";

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

const chat = (win: Page) => C(win).locator(".aos-cc:not(.is-readonly)");
const past = (win: Page) => C(win).locator(".aos-cc.is-readonly");
const body = (win: Page) => C(win).locator(".aos-term-body");
const sw = (win: Page) => C(win).locator(".aos-cv");
/** Holds back the pool's session-update events until the returned function runs: what moves then moved without one. */
const holdUpdates = async (win: Page): Promise<() => Promise<void>> => {
  await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { trigger(name: string, ...a: unknown[]): void } } } }).aosHost.plugin.terminalPool;
    const orig = p.trigger.bind(p);
    const w = window as unknown as { __release?: () => void };
    p.trigger = (name: string, ...a: unknown[]) => { if (name !== "session-update") orig(name, ...a); };
    w.__release = () => { p.trigger = orig; };
  });
  return async () => { await win.evaluate(() => (window as unknown as { __release?: () => void }).__release?.()); };
};
const appendCache = (key: string, events: object[]) => fs.appendFileSync(FX.v(`brain/_index/code/${key}.jsonl`), events.map((e) => `${JSON.stringify(e)}\n`).join(""));

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
    // No access was chosen for this terminal (Host default); the model is the conversation's, in the model menu's chip.
    await expect(chat(win).locator(".aos-tc-chip:visible")).toHaveText(["@ file", "/ commands", "Snippets", "Host default"]);
    await expect(chat(win).locator(".aos-tc-modelwrap .aos-hm-trigger")).toContainText("fixture-model");
    await expect(chat(win).locator(".aos-cc-stop")).toBeVisible();
  });

  test("an agent terminal that opens in its chat has the size the terminal view gives it, before any flip (C1)", async () => {
    const { win } = app();
    const size = () => win.evaluate((i) => {
      const s = (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { dimensions: { cols: number; rows: number } } | undefined } } } }).aosHost.plugin.terminalPool.get(i);
      return s?.dimensions ?? null;
    }, agent);
    await expect(chat(win)).toBeVisible();
    const before = await size();
    // Not the 80 x 24 a terminal starts at: fitted to the stage the chat lies over.
    expect(before!.cols).toBeGreaterThan(80);
    expect(before!.rows).toBeGreaterThan(24);
    await win.keyboard.press("Meta+j");
    await expect(body(win)).toBeVisible();
    // Give a refit its frames: the flip itself must not resize the PTY.
    await win.waitForTimeout(500);
    expect(await size()).toEqual(before);
    await win.keyboard.press("Meta+j");
    await expect(chat(win)).toBeVisible();
    expect(await size()).toEqual(before);
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

  test("the access and model chips restart the same conversation with the pick; they wait while a turn is open (C12)", async () => {
    const { win } = app();
    const sid = "abababab-0000-4000-8000-000000000008";
    const key = "abababab-0000-4000-8000-000000000009";
    const pool = <T>(f: string, arg?: unknown) => win.evaluate(({ f, arg }) => {
      const p = (window as unknown as { aosHost: { plugin: { terminalPool: Record<string, (a?: unknown) => unknown> } } }).aosHost.plugin.terminalPool;
      return p[f](arg);
    }, { f, arg }) as Promise<T>;
    const ids = async () => (await pool<Array<{ id: string }>>("list")).map((x) => x.id);
    const selected = () => pool<string | null>("selectedId");
    const metaOf = (id: string) => win.evaluate((i) => {
      const p = (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { meta: { terminalKey: string; sessionId: string | null; access: string | null } } | undefined } } } }).aosHost.plugin.terminalPool;
      return p.get(i)?.meta ?? null;
    }, id);
    const model = chat(win).locator(".aos-tc-modelwrap .aos-hm-trigger");
    const access = chat(win).locator(".aos-tc-access");
    // The conversation of the first test has a turn open: both chips wait, and say why.
    await select(win, agent);
    await expect(model).toBeDisabled();
    await expect(access).toBeDisabled();
    await expect(access).toHaveAttribute("title", /Wait for the turn to finish/);
    // Each chip's name says what it sets, and the reason it waits is read with it, not only on hover (M5).
    await expect(access).toHaveAttribute("aria-disabled", "true");
    await expect(access).toHaveAttribute("aria-label", "Access: Host default");
    await expect(model).toHaveAttribute("aria-label", "Model: Claude Code · fixture-model");
    const why = (await access.getAttribute("aria-describedby")) ?? "";
    expect(why).not.toBe("");
    await expect(model).toHaveAttribute("aria-describedby", why);
    await expect(chat(win).locator(`[id="${why}"]`)).toHaveText("Wait for the turn to finish, then change it");
    // A conversation with its turn closed.
    const done = conversation(sid, FX.v("workspaces/harbor-map/src/tide.ts")).slice(0, 6);
    writeCache(key, done);
    const old = await startAgent(win, { host: "claude", terminalKey: key, sessionId: sid, label: "Tide chart" });
    await expect(chat(win)).toBeVisible();
    await expect(model).toBeEnabled();
    await expect(access).toBeEnabled();
    await expect(model).not.toHaveAttribute("aria-describedby", /./);
    // Choosing the current access does nothing.
    const count = (await ids()).length;
    await access.click();
    await chat(win).locator("button[data-access='host']").click();
    await win.waitForTimeout(300);
    expect((await ids()).length).toBe(count);
    expect(await selected()).toBe(old);
    // A model from the custom id field: a new terminal resumes the same conversation on it, and the old one is gone.
    await model.click();
    await chat(win).locator("[data-hm-key='custom']").click();
    await chat(win).locator("[data-hm-key='custom-input']").fill("sonnet");
    await chat(win).locator("[data-hm-key='custom-use']").click();
    await expect.poll(async () => (await selected()) !== old).toBe(true);
    const second = (await selected()) ?? "";
    expect(await ids()).not.toContain(old);
    expect((await metaOf(second))?.sessionId).toBe(sid);
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toMatch(new RegExp(`\\[fixture claude stub\\] .*--model sonnet .*--resume ${sid}`));
    // The access chip: another conversation (the fixture's agent exits at once, so the restarted one cannot be picked on again).
    const sid2 = "abababab-0000-4000-8000-00000000000a";
    const key2 = "abababab-0000-4000-8000-00000000000b";
    writeCache(key2, conversation(sid2, FX.v("workspaces/harbor-map/src/tide.ts")).slice(0, 6).map((e) => ({ ...e, model: "sonnet" })));
    const old2 = await startAgent(win, { host: "claude", terminalKey: key2, sessionId: sid2, label: "Tide chart 2" });
    await expect(access).toBeEnabled();
    await access.click();
    await chat(win).locator("button[data-access='read']").click();
    await expect.poll(async () => (await selected()) !== old2).toBe(true);
    expect(await ids()).not.toContain(old2);
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toMatch(new RegExp(`--model sonnet --permission-mode plan --resume ${sid2}`));
  });

  test("the top bar and the model chip name a transcript's full model id; picking that model again restarts nothing (M4)", async () => {
    const { win } = app();
    const key = "babababa-0000-4000-8000-000000000014";
    const sid = "babababa-0000-4000-8000-000000000015";
    writeCache(key, conversation(sid, FX.v("workspaces/harbor-map/src/tide.ts")).slice(0, 6).map((e) => ("model" in e ? { ...e, model: "claude-opus-5-5-20261101" } : e)));
    await openTab(win, "term");
    const id = await startAgent(win, { host: "claude", terminalKey: key, sessionId: sid, label: "Full id" });
    const model = chat(win).locator(".aos-tc-modelwrap .aos-hm-trigger");
    await expect(C(win).locator(".aos-term-head .aos-term-chip").first()).toHaveText("Claude Code · Opus 5.5");
    await expect(model).toContainText("Opus 5.5");
    await expect(model).toBeEnabled();
    const count = () => win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { list(): unknown[] } } } }).aosHost.plugin.terminalPool.list().length);
    const before = await count();
    // The catalog's opus alias is that model (its family; the fixture's aliases carry no version).
    await model.click();
    await chat(win).locator(".aos-hm-model[data-model='opus']").click();
    await win.waitForTimeout(300);
    expect(await count()).toBe(before);
    expect(await win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null } } } }).aosHost.plugin.terminalPool.selectedId())).toBe(id);
    await expect(model).toContainText("Opus 5.5");
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

  test("a chat that moves in a terminal you are not looking at updates its row in the sidebar, with no other change (I2)", async () => {
    const { win } = app();
    const key = "adadadad-0000-4000-8000-00000000000e";
    const sid = "adadadad-0000-4000-8000-00000000000f";
    writeCache(key, conversation(sid, FX.v("workspaces/harbor-map/src/tide.ts")).slice(0, 6));
    await openTab(win, "term");
    const other = await startAgent(win, { host: "claude", terminalKey: key, sessionId: sid, label: "Chart legend" });
    const sub = C(win).locator(`.aos-tl-row[data-session="${other}"] .aos-tl-sub`);
    await expect(sub).toContainText("Idle");
    // Another terminal is selected: this row's chat is not the one on screen.
    expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
    await expect(C(win).locator(`.aos-tl-row[data-session="${other}"]`)).toHaveAttribute("aria-selected", "false");
    const release = await holdUpdates(win);
    try {
      appendCache(key, [{ t, kind: "prompt", text: "Now the chart legend", turn: 2 }]);
      await expect(sub).toContainText("Working");
    } finally { await release(); }
  });

  test("a chat with nothing yet says so, and so does one whose follower can't tell the conversation; each line's Terminal ⌘J flips to the terminal (TM14)", async () => {
    const { win } = app();
    await openTab(win, "term");
    const key = "bcbcbcbc-0000-4000-8000-000000000016";
    fs.rmSync(FX.v(`brain/_index/code/${key}.jsonl`), { force: true });
    await startAgent(win, { host: "claude", terminalKey: key, sessionId: "bcbcbcbc-0000-4000-8000-000000000017", label: "Nothing yet" });
    const note = chat(win).locator(".aos-cc-note");
    await expect(note).toHaveText("No chat for this session yet · Terminal ⌘J");
    await note.locator("button.aos-cc-jump").click();
    await expect(body(win)).toBeVisible();
    await expect(sw(win).locator("button[aria-pressed='true']")).toContainText("Terminal");
    // The follower writes this line when two Codex terminals in one folder can't be told apart (C2a).
    const key2 = "bcbcbcbc-0000-4000-8000-000000000018";
    writeCache(key2, [{ t, kind: "error", message: "Can't tell which conversation · Terminal ⌘J", turn: 0 }]);
    await startAgent(win, { host: "codex", terminalKey: key2, sessionId: "bcbcbcbc-0000-4000-8000-000000000019", label: "Two in one folder" });
    await expect(note).toHaveText("Can't tell which conversation · Terminal ⌘J");
    await note.locator("button.aos-cc-jump").click();
    await expect(body(win)).toBeVisible();
  });

  test("a busy terminal's updates redraw neither its chat, its switch nor an open model menu; a status line change keeps your selection (I3)", async () => {
    const { win } = app();
    const key = "afafafaf-0000-4000-8000-000000000012";
    const sid = "afafafaf-0000-4000-8000-000000000013";
    writeCache(key, conversation(sid, FX.v("workspaces/harbor-map/src/tide.ts")).slice(0, 6));
    await openTab(win, "term");
    const id = await startAgent(win, { host: "claude", terminalKey: key, sessionId: sid, label: "Busy agent" });
    const bubble = chat(win).locator(".aos-ss-prompt .aos-ss-bubble").first();
    await expect(bubble).toHaveText("Make the tide parser read the new station format");
    await expect(chat(win).locator(".aos-tc-modelwrap .aos-hm-trigger")).toBeEnabled();
    // Marks on what must survive: the bubble, the switch's focused button, and the open model menu's search.
    await chat(win).locator(".aos-tc-modelwrap .aos-hm-trigger").click();
    await chat(win).locator(".aos-hm-search").fill("son");
    await win.evaluate(() => {
      const w = window as unknown as Record<string, Element | null>;
      w.__bubble = document.querySelector(".aos-wb-content .aos-cc:not(.is-readonly) .aos-ss-bubble");
      w.__search = document.querySelector(".aos-wb-content .aos-hm-search");
    });
    // An animated title: every frame is a session-update.
    const frames = (n: number) => win.evaluate(({ i, n }) => {
      const s = (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { setTitle(t: string): void } } } } }).aosHost.plugin.terminalPool.get(i);
      for (let k = 0; k < n; k++) s.setTitle(`${k % 2 ? "⠋" : "⠙"} Busy agent`);
    }, { i: id, n });
    await frames(10);
    await expect(C(win).locator(".aos-term-headtitle")).toHaveText("⠋ Busy agent");
    const same = () => win.evaluate(() => {
      const w = window as unknown as Record<string, Element | null>;
      return {
        bubble: w.__bubble === document.querySelector(".aos-wb-content .aos-cc:not(.is-readonly) .aos-ss-bubble"),
        search: w.__search === document.querySelector(".aos-wb-content .aos-hm-search") && document.activeElement === w.__search,
      };
    });
    expect(await same()).toEqual({ bubble: true, search: true });
    await win.keyboard.press("Escape");
    // The switch keeps the keyboard's focus through more frames.
    await sw(win).locator("button[aria-pressed='true']").focus();
    await frames(10);
    await expect(sw(win).locator("button[aria-pressed='true']")).toBeFocused();
    // Select the bubble's text; a status line copy arrives (a feed change that leaves the chat as it was).
    await win.evaluate(() => {
      const el = (window as unknown as Record<string, Element>).__bubble;
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    });
    const file = FX.v(`brain/_index/statusline/${key}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), session_id: sid, transcript_path: null, ansi: "fixture-model │ Vault\n" }));
    await expect(chat(win).locator(".aos-cc-statusline")).toHaveCount(1);
    expect(await win.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("Make the tide parser read the new station format");
    expect((await same()).bubble).toBe(true);
    fs.rmSync(file);
  });

  test("an agent that exits hands its terminal to the login shell: the chat says so and takes no typing; the terminal's composer is a shell's (R39)", async () => {
    const { win } = app();
    const key = "acacacac-0000-4000-8000-00000000000c";
    const sid = "acacacac-0000-4000-8000-00000000000d";
    // Its last turn never closed: before the fix the chat kept Working and Stop, and its composer typed into zsh.
    writeCache(key, conversation(sid, FX.v("workspaces/harbor-map/src/tide.ts")));
    await openTab(win, "term");
    const id = await win.evaluate(({ k, s }) => {
      type Sess = { id: string; shell: string; cwd: string; dimensions: { cols: number; rows: number }; meta: object; attachAgent(p: unknown, size: object): void; write(d: string): void };
      const p = (window as unknown as { aosHost: { plugin: { terminalPool: { create(o: object): Sess; select(id: string): void } } } }).aosHost.plugin.terminalPool;
      const t = p.create({ deferred: true, meta: { host: "claude", terminalKey: k, sessionId: s, label: "Ending agent" } });
      p.select(t.id);
      // A process attached as the terminal's agent (what main starts for a Code launch, D18; the page may spawn only the
      // login shell), which execs the fixture's claude stub: it prints its line and exits, and the login shell takes over.
      const spawn = (Object.getPrototypeOf(t) as { spawnShell(this: unknown): unknown }).spawnShell;
      t.attachAgent(spawn.call({ shell: t.shell, cwd: t.cwd, env: undefined, size: t.dimensions, meta: t.meta }), t.dimensions);
      t.write("exec claude\r");
      return t.id;
    }, { k: key, s: sid });
    await expect.poll(() => win.evaluate((i) => (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { agentEnded: boolean } | undefined } } } }).aosHost.plugin.terminalPool.get(i)?.agentEnded ?? null, id), { timeout: 10_000 }).toBe(true);
    // The chat keeps its history, says the agent ended, and offers the terminal; no Working, no Stop, no composer.
    await expect(chat(win)).toBeVisible();
    await expect(chat(win).locator(".aos-ss-prompt .aos-ss-bubble").first()).toHaveText("Make the tide parser read the new station format");
    await expect(chat(win).locator(".aos-cc-ended")).toHaveText("Claude Code ended · Terminal ⌘J");
    await expect(chat(win).locator(".aos-cc-stop")).toHaveCount(0);
    await expect(chat(win).locator(".aos-cc-workingtext")).toHaveCount(0);
    await expect(C(win).locator(".aos-tc-input:visible")).toHaveCount(0);
    // Nothing typed while the chat shows reaches the shell: ⌘L finds no composer, and keys go nowhere.
    await win.evaluate((i) => {
      const s = (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { write(d: string): void } } } } }).aosHost.plugin.terminalPool.get(i);
      const w = (window as unknown as { __shellWrites: string[] });
      w.__shellWrites = [];
      const orig = s.write.bind(s);
      s.write = (d: string) => { w.__shellWrites.push(d); orig(d); };
    }, id);
    expect(await command(win, "agentic-os:term-composer")).toBe(true);
    await win.keyboard.type("echo leaked");
    await win.keyboard.press("Enter");
    await win.waitForTimeout(300);
    expect(await win.evaluate(() => (window as unknown as { __shellWrites: string[] }).__shellWrites)).toEqual([]);
    // Its button flips to the terminal, where the composer is a shell's: "Write a command…", no / commands, model or access.
    await chat(win).locator(".aos-cc-ended .aos-cc-jump").click();
    await expect(body(win)).toBeVisible();
    const composer = C(win).locator(".aos-term-main > .aos-tc");
    await expect(composer.locator(".aos-tc-input")).toHaveAttribute("placeholder", "Write a command…");
    await expect(composer.locator(".aos-tc-chip:visible")).toHaveText(["@ file", "Snippets"]);
    await expect(composer.locator(".aos-tc-modelwrap")).toBeHidden();
    await composer.locator(".aos-tc-input").fill("echo ended-$((6*7))");
    await composer.locator(".aos-tc-input").press("Enter");
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("ended-42");
  });
});

// The sidebar (C6): the fixture vault's session index lists real past conversations (its claude transcripts are in the
// fixture home), so `code.view` runs the real runtime on them. History rows sit under their place, newest activity first;
// one opens read-only with Resume; Resume types the resume line in a new terminal.
test.describe("the Code sidebar lists recent conversations (C6)", () => {
  test.describe.configure({ mode: "serial" });
  const app = useApp({ env: { AOS_APP_WRITE: "code" } });
  const TIDE = "c1a0de00-0000-4000-8000-000000000001";
  const row = (win: Page, id: string) => C(win).locator(`.aos-tl-past[data-history="claude:${id}"]`);

  test("past conversations of the last 14 days sit in their group, with Host · age; the footer counts and links to History", async () => {
    const { win } = app();
    await openTab(win, "term");
    await expect(C(win).locator(".aos-tl-filter")).toHaveAttribute("placeholder", "Search sessions");
    await expect(C(win).locator(".aos-ntm-name")).toHaveText("New session");
    await expect(C(win).locator(".aos-ntm-sub")).toContainText("Claude Code ·");
    // Its hover names the host once, then where it starts.
    await expect(C(win).locator(".aos-ntm-main")).toHaveAttribute("title", /^Start Claude Code in [^·]+ \(⌘T\)/);
    const tide = row(win, TIDE);
    await expect(tide).toBeVisible();
    await expect(tide.locator(".aos-tl-title")).toHaveText("Tide parser in the chart view");
    await expect(tide.locator(".aos-tl-sub")).toHaveText(/^Claude Code · \d+[mhd]$|^Claude Code · now$/);
    // Under its workspace's head (the heads and rows are flat siblings), the head carrying Open workspace.
    expect(await tide.evaluate((el) => {
      let n = el.previousElementSibling;
      while (n && !n.matches(".aos-tl-group")) n = n.previousElementSibling;
      return n?.getAttribute("data-group") ?? null;
    })).toBe("ws:harbor-map");
    // A conversation in the vault root or a folder outside the workspaces is in Other folders.
    await expect(C(win).locator(".aos-tl-group[data-group='other'] .aos-tl-grouplabel")).toHaveText("Other folders");
    // Other folders is no place to start in: its + starts in the vault, and says so.
    await expect(C(win).locator(".aos-tl-group[data-group='other'] .aos-tl-plus:not(.aos-tl-openws)")).toHaveAttribute("aria-label", "New terminal in the vault");
    await expect(C(win).locator(".aos-tl-foot .aos-tl-count")).toHaveText(/^\d+ open · \d+ need you$/);
    await C(win).locator(".aos-tl-filter").fill("tide parser");
    await expect(C(win).locator(".aos-tl-past")).toHaveCount(1);
    await C(win).locator(".aos-tl-filter").fill("codex");
    await expect(C(win).locator(".aos-tl-past").first()).toHaveAttribute("data-host", "codex");
    // A workspace's name finds its conversations too (I6).
    await C(win).locator(".aos-tl-filter").fill("harbor-map");
    await expect(tide).toBeVisible();
    await expect(C(win).locator(".aos-tl-group")).toHaveCount(1);
    await C(win).locator(".aos-tl-filter").fill("");
  });

  test("a past row opens read-only: the conversation, no composer, no Stop, no view switch; Resume starts the resume line in a new terminal", async () => {
    const { win } = app();
    await openTab(win, "term");
    await row(win, TIDE).click();
    await expect(past(win)).toBeVisible();
    await expect(row(win, TIDE)).toHaveAttribute("aria-selected", "true");
    await expect(C(win).locator(".aos-term-headtitle")).toHaveText("Tide parser in the chart view");
    await expect(C(win).locator(".aos-term-head .aos-term-chip").first()).toContainText("Claude Code");
    await expect(past(win).locator(".aos-ss-prompt .aos-ss-bubble").first()).toBeVisible({ timeout: 15_000 });
    await expect(past(win).locator(".aos-tc, .aos-cc-stop, .aos-cc-status")).toHaveCount(0);
    await expect(C(win).locator(".aos-cv-btn")).toHaveCount(0);
    // The composer is one element kept in the frame (hidden for a past conversation), not inside the read-only chat, so
    // look for a visible one anywhere in the Code view.
    await expect(C(win).locator(".aos-tc:visible, .aos-tc-input:visible")).toHaveCount(0);
    const resume = C(win).locator("button.aos-cv-resume");
    await expect(resume).toHaveText("Resume");
    await expect(resume).toHaveAttribute("title", /Resumes in workspaces\/harbor-map/);
    const before = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { list(): unknown[] } } } }).aosHost.plugin.terminalPool.list().length);
    // ⇧⌘W closes terminals: a past conversation is not one, and the terminal hidden under it stays.
    expect(await command(win, "agentic-os:term-close")).toBe(true);
    await win.waitForTimeout(200);
    expect(await win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { list(): unknown[] } } } }).aosHost.plugin.terminalPool.list().length)).toBe(before);
    await expect(past(win)).toBeVisible();
    await resume.click();
    await expect.poll(async () => win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { list(): unknown[] } } } }).aosHost.plugin.terminalPool.list().length)).toBe(before + 1);
    // The new terminal is selected, so the read-only chat is gone; it ran the resume line (the fixture's claude stub echoes it).
    await expect(past(win)).toBeHidden();
    await expect(C(win).locator(".aos-tl-row.aos-term-tab-active")).toHaveCount(1);
    await expect.poll(async () => win.evaluate(() => {
      const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { meta: { sessionId: string | null; host: string } } | undefined } } } }).aosHost.plugin.terminalPool;
      const t = p.get(p.selectedId() ?? "");
      return t ? `${t.meta.host}:${t.meta.sessionId}` : null;
    })).toBe(`claude:${TIDE}`);
    // The open terminal is that conversation now, so the index row is not listed twice.
    await expect(row(win, TIDE)).toHaveCount(0);
    // And the resume line really ran (the fixture's claude stub echoes its arguments).
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toMatch(new RegExp(`\\[fixture claude stub\\] .*--resume ${TIDE}`));
  });

  test("a terminal closed here stays listed across a tab switch, opens read-only, and is listed once when the index has it (C6)", async () => {
    const { win } = app();
    const mine = "c1a0de00-0000-4000-8000-0000000000aa";
    await openTab(win, "term");
    const closedRow = C(win).locator(`.aos-tl-past[data-history="closed:claude:${mine}"]`);
    const id = await startAgent(win, { host: "claude", terminalKey: KEY2, sessionId: mine });
    await expect(C(win).locator(`.aos-tl-row[data-session="${id}"]`)).toHaveCount(1);
    // What the close confirmation does on Close, with the Code tab showing.
    await win.evaluate((i) => (window as unknown as { aosHost: { plugin: { terminalPool: { remove(id: string): void } } } }).aosHost.plugin.terminalPool.remove(i), id);
    await expect(closedRow).toBeVisible();
    // Away from the Code tab and back: the panel is rebuilt, the record is not lost.
    await openTab(win, "pulse");
    await openTab(win, "term");
    await expect(closedRow).toBeVisible();
    await expect(closedRow.locator(".aos-tl-sub")).toContainText("Closed");
    await closedRow.click();
    await expect(past(win)).toBeVisible();
    await expect(C(win).locator(".aos-tc:visible, .aos-tc-input:visible")).toHaveCount(0);
    // The index lists it now: one row (the index's), not two.
    const idx = FX.v("brain/_index/session-index.json");
    const j = JSON.parse(fs.readFileSync(idx, "utf8")) as { files: Record<string, unknown> };
    j.files["spaces-harbor-map/closed-here.jsonl"] = { host: "claude", head: { id: mine, kind: "interactive", startCwd: FX.v("workspaces/harbor-map"), startedAt: new Date().toISOString(), firstPrompt: "Closed here, then indexed" }, lastAt: new Date().toISOString() };
    fs.writeFileSync(idx, JSON.stringify(j));
    await openTab(win, "pulse");
    await openTab(win, "term");
    await expect(C(win).locator(`.aos-tl-past[data-history$=":${mine}"]`)).toHaveCount(1, { timeout: 10_000 });
    await expect(closedRow).toHaveCount(0);
    await expect(row(win, mine).locator(".aos-tl-title")).toHaveText("Closed here, then indexed");
  });

  test("a Codex terminal that knew its conversation only from its chat stays listed when closed, and opens read-only (I2, C6)", async () => {
    const { win } = app();
    const key = "aeaeaeae-0000-4000-8000-000000000010";
    const thread = "aeaeaeae-0000-4000-8000-000000000011";
    writeCache(key, conversation(thread, FX.v("workspaces/harbor-map/src/tide.ts")).slice(0, 6));
    await openTab(win, "term");
    // A new Codex terminal: its launch names no conversation; only its chat's session line does.
    const id = await win.evaluate((k) => {
      const p = (window as unknown as { aosHost: { plugin: { terminalPool: { create(o: object): { id: string }; select(id: string): void } } } }).aosHost.plugin.terminalPool;
      const s = p.create({ meta: { host: "codex", terminalKey: k, label: "Codex thread" } });
      p.select(s.id);
      return s.id;
    }, key);
    await expect.poll(() => win.evaluate((i) => (window as unknown as { aosHost: { plugin: { codeFeeds: { get(id: string): { state: { sessionId: string | null } } | null } } } }).aosHost.plugin.codeFeeds.get(i)?.state.sessionId ?? null, id)).toBe(thread);
    await win.evaluate((i) => (window as unknown as { aosHost: { plugin: { terminalPool: { remove(id: string): void } } } }).aosHost.plugin.terminalPool.remove(i), id);
    const closedRow = C(win).locator(`.aos-tl-past[data-history="closed:codex:${thread}"]`);
    await expect(closedRow).toBeVisible();
    await expect(closedRow.locator(".aos-tl-sub")).toContainText("Codex · Closed");
    await closedRow.click();
    await expect(past(win)).toBeVisible();
    await expect(C(win).locator(".aos-term-head .aos-term-chip").first()).toContainText("Codex · Past conversation");
    await expect(C(win).locator(".aos-tc:visible, .aos-tc-input:visible")).toHaveCount(0);
  });

  test("a conversation with no transcript says why in the read-only chat (the runtime's reason, not an exit code)", async () => {
    const { win } = app();
    const gone = "c1a0de00-0000-4000-8000-0000000000ff";
    // The index names it; its transcript file does not exist.
    const idx = FX.v("brain/_index/session-index.json");
    const j = JSON.parse(fs.readFileSync(idx, "utf8")) as { files: Record<string, unknown> };
    j.files["spaces-reef-survey/gone.jsonl"] = { host: "claude", head: { id: gone, kind: "interactive", startCwd: FX.v("workspaces/reef-survey"), startedAt: new Date().toISOString(), firstPrompt: "A chat whose file is gone" }, lastAt: new Date().toISOString() };
    fs.writeFileSync(idx, JSON.stringify(j));
    await openTab(win, "pulse");
    await openTab(win, "term");
    await expect(row(win, gone)).toBeVisible({ timeout: 10_000 });
    await row(win, gone).click();
    await expect(past(win).locator(".aos-cc-note")).toHaveText("no transcript found", { timeout: 15_000 });
  });

  test("All history opens Sessions on History", async () => {
    const { win } = app();
    await openTab(win, "term");
    await C(win).locator(".aos-tl-allhistory").click();
    await expect(win.locator(".aos-wb-railbtn[data-tab='chat']")).toHaveClass(/is-active/);
    await expect(C(win).locator(".aos-ss-hresume").first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("the Code chat surface off (a run whose AOS_APP_WRITE leaves it out)", () => {
  const app = useApp();

  test("an agent terminal opens in its terminal, and the switch says the chat view is off (C13)", async () => {
    const h = app();
    const { win } = h;
    writeCache(KEY, conversation(SID, FX.v("workspaces/harbor-map/src/tide.ts")));
    await openTab(win, "term");
    const id = await startAgent(win, { host: "claude", terminalKey: KEY, sessionId: SID });
    await expect(body(win)).toBeVisible();
    await expect(chat(win)).toBeHidden();
    await expect(sw(win)).toHaveText("Chat view is off · Settings");
    // No chat says whether a turn runs: its row reads Running, not Idle; and there is no conversation to restart, so the
    // composer has no access or model chip (M1).
    await expect(C(win).locator(`.aos-tl-row[data-session="${id}"] .aos-tl-sub`)).toHaveText(/^Claude Code · Running · /);
    await expect(C(win).locator(".aos-term-main > .aos-tc .aos-tc-chip:visible")).toHaveText(["@ file", "/ commands", "Snippets"]);
    await expect(C(win).locator(".aos-term-main > .aos-tc .aos-tc-modelwrap")).toBeHidden();
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
