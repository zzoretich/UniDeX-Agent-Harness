import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, REPO, USER_DATA, appEnv, badge, command, content, emulateViewport, expectNoErrors, openTab, rail, terminalText, useApp } from "./harness";

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
    await expect(chat(win).locator(".aos-tc-chip:visible")).toHaveText(["+ attach", "@ file", "/ commands", "Snippets", "Host default"]);
    await expect(chat(win).locator(".aos-tc-modelwrap .aos-hm-trigger")).toContainText("fixture-model");
    await expect(chat(win).locator(".aos-cc-stop")).toBeVisible();
  });

  test("an agent terminal that opens in its chat has the size the terminal view gives it, within a column; flipping never resizes it again (C1, R51)", async () => {
    const { win } = app();
    const size = () => win.evaluate((i) => {
      const s = (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { dimensions: { cols: number; rows: number } } | undefined } } } }).aosHost.plugin.terminalPool.get(i);
      return s?.dimensions ?? null;
    }, agent);
    // Run alone (--grep) the first test has not started the agent: start it here.
    if (!agent) {
      writeCache(KEY, conversation(SID, FX.v("workspaces/harbor-map/src/tide.ts")));
      await openTab(win, "term");
      agent = await startAgent(win, { host: "claude", terminalKey: KEY, sessionId: SID, label: "Tide parser" });
    }
    await expect(chat(win)).toBeVisible();
    // The size once it has stopped moving: the refit runs from a ResizeObserver, a frame after the layout.
    const settled = async () => {
      let last = "";
      let same = 0;
      await expect.poll(async () => {
        const now = JSON.stringify(await size());
        same = now === last ? same + 1 : 0;
        last = now;
        return same;
      }, { intervals: [100] }).toBeGreaterThanOrEqual(4);
      return (await size())!;
    };
    const resizes = () => win.evaluate(() => (window as unknown as { __resizes: string[] }).__resizes.splice(0));
    // Classic always-visible scrollbars, as on CI's macOS runners (this Mac's overlay ones take no width). Added here and
    // removed below, so no other test sees it.
    const style = await win.addStyleTag({ content: "::-webkit-scrollbar { width: 15px; height: 15px; } ::-webkit-scrollbar-thumb { background: #888; border-radius: 6px; }" });
    try {
      // Every size the panel gives the agent's PTY, read and cleared by resizes(); the session's own resize is put back below.
      await win.evaluate((i) => {
        const s = (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { resize(c: number, r: number): void } } } } }).aosHost.plugin.terminalPool.get(i);
        const w = window as unknown as { __resizes: string[]; __resizeOrig?: (c: number, r: number) => void };
        w.__resizes = [];
        w.__resizeOrig = s.resize;
        const orig = s.resize.bind(s);
        s.resize = (c: number, r: number) => { w.__resizes.push(`${c}x${r}`); orig(c, r); };
      }, agent);
      // A 1x screen, as CI's: xterm's cell width is the rounded canvas over the columns it has, so the chat's fit and the
      // terminal view's can land a column apart. 1480 x 920 first, whatever the screen (CI's runners are 1024 px wide),
      // then a few widths near it, then heights where the composer's share of the stage ends part-way through a line (the
      // rows must still match: R52). Each size has its own emulation, cleared before the next (a second session's clear
      // would drop the first's override).
      const sizes = [[1480, 920], [1469, 920], [1472, 920], [1475, 920], [1478, 920], [1480, 900], [1480, 914], [1480, 931]];
      for (const [w, h] of sizes) {
        const at = `${w} x ${h}`;
        const r = await emulateViewport(win, { width: w, height: h, scale: 1 });
        try {
          // Not the 80 x 24 a terminal starts at: fitted to the stage the chat lies over (at 1480 x 920, before any flip).
          await expect.poll(async () => (await size())?.cols ?? 0).toBeGreaterThan(80);
          const chatSize = await settled();
          expect(chatSize.rows, at).toBeGreaterThan(24);
          await resizes();
          // The first flip: a column at most, the same rows.
          await win.keyboard.press("Meta+j");
          await expect(body(win)).toBeVisible();
          const termSize = await settled();
          const moved = `${at}: ${JSON.stringify(chatSize)} then ${JSON.stringify(termSize)}`;
          expect(Math.abs(termSize.cols - chatSize.cols), moved).toBeLessThanOrEqual(1);
          expect(termSize.rows, moved).toBe(chatSize.rows);
          await resizes();
          // Then back, again and back: the PTY is never resized.
          for (const shown of [chat, body, chat]) {
            await win.keyboard.press("Meta+j");
            await expect(shown(win)).toBeVisible();
            expect(await settled(), at).toEqual(termSize);
          }
          expect(await resizes(), at).toEqual([]);
        } finally {
          await r();
        }
      }
    } finally {
      await style.evaluate((n) => (n as Element).remove());
      await win.evaluate((i) => {
        const s = (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { resize?: unknown } } } } }).aosHost.plugin.terminalPool.get(i);
        const w = window as unknown as { __resizeOrig?: unknown };
        if (w.__resizeOrig) s.resize = w.__resizeOrig;
        delete w.__resizeOrig;
      }, agent);
    }
  });

  test("at 960x600 an agent's chat keeps its composer whole: the send button and every chip inside the window, nothing scrolls", async () => {
    const { win } = app();
    if (!agent) {
      writeCache(KEY, conversation(SID, FX.v("workspaces/harbor-map/src/tide.ts")));
      await openTab(win, "term");
      agent = await startAgent(win, { host: "claude", terminalKey: KEY, sessionId: SID, label: "Tide parser" });
    }
    await select(win, agent);
    await expect(chat(win)).toBeVisible();
    const restore = await emulateViewport(win, { width: 960, height: 600, scale: 1 });
    try {
      const layout = () => win.evaluate(() => {
        const inside = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
        };
        const c = document.querySelector(".aos-wb-content") as HTMLElement;
        const scrolled: string[] = [];
        for (let el: HTMLElement | null = c; el; el = el.parentElement) {
          if (el.scrollHeight > el.clientHeight + 1 || el.scrollTop > 0) scrolled.push(`${el.className} ${el.scrollHeight}>${el.clientHeight}`);
        }
        const tc = document.querySelector(".aos-cc .aos-tc:not(.is-hidden)");
        const send = tc?.querySelector(".aos-tc-send");
        const chips = Array.from(tc?.querySelectorAll(".aos-tc-chip") ?? []).filter((e) => (e as HTMLElement).offsetParent !== null);
        return { scrolled, send: send ? inside(send) : null, chips: chips.map((e) => `${e.textContent}:${inside(e)}`), box: tc ? inside(tc) : null };
      });
      await expect.poll(async () => (await layout()).scrolled).toEqual([]);
      const l = await layout();
      expect(l.box).toBe(true);
      expect(l.send, JSON.stringify(l)).toBe(true);
      expect(l.chips.length).toBeGreaterThan(0);
      expect(l.chips.filter((c) => !c.endsWith(":true"))).toEqual([]);
    } finally {
      await restore();
    }
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
    // A model from the custom id field: a new terminal resumes the same conversation on it, and the old one is gone. A
    // draft in the composer goes with it (I1).
    const draft = "and now with the other model";
    await chat(win).locator(".aos-tc-input").fill(draft);
    await model.click();
    await chat(win).locator("[data-hm-key='custom']").click();
    await chat(win).locator("[data-hm-key='custom-input']").fill("sonnet");
    await chat(win).locator("[data-hm-key='custom-use']").click();
    await expect.poll(async () => (await selected()) !== old).toBe(true);
    const second = (await selected()) ?? "";
    expect(await ids()).not.toContain(old);
    expect((await metaOf(second))?.sessionId).toBe(sid);
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toMatch(new RegExp(`\\[fixture claude stub\\] .*--model sonnet .*--resume ${sid}`));
    await expect(C(win).locator(".aos-tc-input")).toHaveValue(draft);
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
    // Its composer stays under the terminal, with no + attach, / commands, access or model.
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

  /** WorkbenchView.runInTerm as an app button calls it; the new terminal's pool id. */
  const runInTerm = (win: Page, command: string, o: object): Promise<string> => win.evaluate(({ c, o }) => {
    type W = { aosHost: { app: { workspace: { getLeavesOfType(t: string): Array<{ view: { runInTerm(c: string, o: object): boolean } }> } }; plugin: { terminalPool: { selectedId(): string } } } };
    const h = (window as unknown as W).aosHost;
    h.app.workspace.getLeavesOfType("agentic-os-workbench")[0].view.runInTerm(c, o);
    return h.plugin.terminalPool.selectedId();
  }, { c: command, o });
  const poolInfo = (win: Page, id: string) => win.evaluate((i) => {
    const s = (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { isExited: boolean; exitCode: number | null; agentEnded: boolean } | undefined } } } }).aosHost.plugin.terminalPool.get(i);
    return s ? { exited: s.isExited, code: s.exitCode, agentEnded: s.agentEnded } : null;
  }, id);

  test("an agent an app button starts is exec'ed: when it exits the terminal ends with it, and the chat has no composer to type into a shell (R40)", async () => {
    const { win } = app();
    await openTab(win, "term");
    const id = await runInTerm(win, 'claude "review persona flags"', { host: "claude", origin: "Proposals" });
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("[fixture claude stub] review persona flags");
    // The fixture's claude stub exits at once; before the fix zsh was back in the same PTY and the terminal went on.
    await expect.poll(async () => (await poolInfo(win, id))?.exited, { timeout: 10_000 }).toBe(true);
    await expect(C(win).locator(".aos-term-tab-active .aos-term-tab-exited, .aos-term-tab-exited.aos-term-tab-active")).toHaveCount(1);
    await expect(C(win).locator(".aos-term-endbar")).toBeVisible();
    await expect(C(win).locator(".aos-tc-input:visible")).toHaveCount(0);
  });

  test("a login command run in the agent's name is not a conversation: its terminal view, no switch (R40)", async () => {
    const { win } = app();
    await openTab(win, "term");
    const login = await runInTerm(win, "codex mcp login fixture-server", { host: "codex", origin: "Connectors", chat: false });
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("mcp login fixture-server");
    await expect(body(win)).toBeVisible();
    await expect(C(win).locator(".aos-cv")).toHaveCount(0);
    await expect(chat(win)).toBeHidden();
    expect((await poolInfo(win, login))?.agentEnded).toBe(false);
    // Not a conversation, so no images either: its composer has no + attach (C7).
    await expect(C(win).locator(".aos-term-main > .aos-tc")).toBeVisible();
    await expect(C(win).locator(".aos-term-main > .aos-tc .aos-tc-chip", { hasText: "@ file" })).toBeVisible();
    await expect(C(win).locator(".aos-term-main > .aos-tc .aos-tc-attach")).toBeHidden();
  });
});

// Approval cards, Needs you and Codex's status line (C4, C5, C10; Task 12). Each agent terminal's raw stream feeds a headless
// screen; the TUI's prompt on it is the chat's card, its row's Needs you and the rail badge's count, and Codex's footer
// rows are its status line. The stand-in agent here is a fake process attached as the terminal's agent, in the page: what
// the test emits is what its TUI printed (real captured screens, hud/src/data/fixtures/screens), what the terminal writes
// to it is kept. Nothing ever flips the view by itself.

const SCREENS = path.join(REPO, "..", "hud", "src", "data", "fixtures", "screens");
const screenFile = (name: string) => fs.readFileSync(path.join(SCREENS, name), "utf8");
/** A rendered fixture screen as a stream that draws it from the top (the captures kept the raw stream of two only). */
const drawn = (name: string) => `\u001b[H\u001b[2J${screenFile(`${name}.txt`).split("\n").join("\r\n")}`;
/** What a fake agent received and printed, in order, with when (the page's Date.now()). */
type FakeLog = Array<{ at: number; write?: string; print?: string }>;
type FakeW = { aosHost: { plugin: { terminalPool: { create(o: object): { id: string; dimensions: object; attachAgent(p: unknown, size: object): void; resize(c: number, r: number): void }; select(id: string): void; get(id: string): { resize(c: number, r: number): void; write(d: string): void } | undefined; remove(id: string): void }; codeFeeds: { screened(id: string): boolean } } }; __fakes?: Record<string, { emit(d: string): void; exit(code: number): void; writes: string[]; log: FakeLog }> };
/**
 * A terminal whose agent is a fake process in the page, selected; its pool id. With `menu`, the fake answers a line it
 * receives that starts with "/menu" (pastes' markers left out) by printing `menu` `menuDelay` ms later (150 by default),
 * as a TUI opens a picker in answer to a command. With `images`, it answers a bracketed paste that holds only an image's
 * path (quoted or not) by printing "[Image #N] " 300 ms later, as Claude Code inserts a pasted image once it has read it
 * (R70); with `imagePrompt` as well, it prints that screen 100 ms after such a paste instead (a dialog that takes the
 * input and eats the paste: D1). Its `log` keeps what it received and printed, in order, with when.
 */
const fakeAgent = (win: Page, meta: Meta, o: { menu?: string; menuDelay?: number; images?: boolean; imagePrompt?: string } = {}): Promise<string> => win.evaluate(({ m, menu, menuDelay, images, imagePrompt }) => {
  const w = window as unknown as FakeW;
  const pool = w.aosHost.plugin.terminalPool;
  const t = pool.create({ deferred: true, cols: 120, rows: 40, meta: m });
  const data: Array<(d: string) => void> = [];
  const exits: Array<(e: { exitCode: number }) => void> = [];
  const writes: string[] = [];
  const log: FakeLog = [];
  const emit = (d: string) => { log.push({ at: Date.now(), print: d }); for (const cb of data) cb(d); };
  let line = "";
  let stream = "";
  let shown = 0;
  const fake = {
    pid: 0, resize: () => {}, kill: () => {},
    write: (d: string) => {
      writes.push(d);
      log.push({ at: Date.now(), write: d });
      if (images) {
        stream += d;
        for (let m2 = /\u001b\[200~([\s\S]*?)\u001b\[201~/.exec(stream); m2; m2 = /\u001b\[200~([\s\S]*?)\u001b\[201~/.exec(stream)) {
          if (/^"?\/[^"\r\n]*\.(png|jpe?g|gif|webp)"?$/.test(m2[1])) {
            if (imagePrompt !== undefined) setTimeout(() => emit(imagePrompt), 100);
            else { const n = ++shown; setTimeout(() => emit(`[Image #${n}] `), 300); }
          }
          stream = stream.slice(m2.index + m2[0].length);
        }
      }
      if (menu === undefined) return;
      line += d.replace(/\u001b\[20[01]~/g, "");
      for (let cr = line.indexOf("\r"); cr >= 0; cr = line.indexOf("\r")) {
        if (line.startsWith("/menu")) setTimeout(() => emit(menu), menuDelay);
        line = line.slice(cr + 1);
      }
    },
    onData: (cb: (d: string) => void) => { data.push(cb); }, onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); },
  };
  t.attachAgent(fake, t.dimensions);
  (w.__fakes ??= {})[t.id] = { emit, exit: (code: number) => { for (const cb of exits) cb({ exitCode: code }); }, writes, log };
  pool.select(t.id);
  return t.id;
}, { m: meta, menu: o.menu, menuDelay: o.menuDelay ?? 150, images: o.images ?? false, imagePrompt: o.imagePrompt });
/**
 * Hands a fake agent's chat the events a follower would read (the fake has no follower), through CodeFeeds' internals:
 * `entries` (the terminal's Entry, whose `events` are the buffer), `compute` (works the chat out again) and `notify`
 * (tells the panel). A rename there is a fix here only.
 */
const feedEvents = (win: Page, id: string, events: object[]): Promise<void> => win.evaluate(({ i, ev }) => {
  type F = { entries: Map<string, { events: unknown[] }>; compute(e: unknown): void; notify(id: string): void };
  const f = (window as unknown as { aosHost: { plugin: { codeFeeds: F } } }).aosHost.plugin.codeFeeds;
  const e = f.entries.get(i);
  if (!e) throw new Error("no feed");
  e.events = ev;
  f.compute(e);
  f.notify(i);
}, { i: id, ev: events });
/** Two frames: the visible terminal's fit (the frame after a selection or a view flip) has run. */
const frames = (win: Page): Promise<void> => win.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
/** The fake's TUI prints `d`; the captures are 120×40, so the terminal is sized so first (after the visible terminal's
 *  own fit, two frames after the selection, which sizes it to the stage). */
const replay = async (win: Page, id: string, d: string): Promise<void> => {
  await frames(win);
  await win.evaluate(({ i, d }) => {
    const w = window as unknown as FakeW;
    w.aosHost.plugin.terminalPool.get(i)?.resize(120, 40);
    w.__fakes?.[i].emit(d);
  }, { i: id, d });
};
/** What the terminal wrote to the fake since the last call. */
const written = (win: Page, id: string): Promise<string[]> => win.evaluate((i) => (window as unknown as FakeW).__fakes?.[i].writes.splice(0) ?? [], id);
const removeTerminal = (win: Page, id: string) => win.evaluate((i) => (window as unknown as FakeW).aosHost.plugin.terminalPool.remove(i), id);

test.describe("approval cards, Needs you and the Codex status line (C4, C5, C10)", () => {
  test.describe.configure({ mode: "serial" });
  const app = useApp({ env: { AOS_APP_WRITE: "code" } });
  const card = (win: Page) => chat(win).locator(".aos-cc-card .aos-cc-gate");

  test("an approval on the agent's screen is a card with the TUI's own question, command and choices; Yes writes 1 and nothing else; the view stays (C4)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-000000000021", sessionId: "a1a1a1a1-0000-4000-8000-000000000022", label: "Approval" });
    await expect(chat(win)).toBeVisible();
    await replay(win, id, screenFile("claude-2.1.318-bash.ansi"));
    await expect(card(win).locator(".aos-cc-gatetitle")).toHaveText("Do you want to proceed?");
    await expect(card(win).locator(".aos-cc-gatedetail")).toHaveText("touch hi.txt");
    // Claude Code 2.1.318 draws four numbered choices (an earlier version drew Yes, Yes and don't ask again, No).
    const choices = card(win).locator("button.aos-cc-choice");
    await expect(choices.locator("span:first-child")).toHaveText(["Yes", "Yes, and always allow access to /work/demo from this project", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    await expect(choices.locator(".aos-cc-choicekey")).toHaveText(["1", "2", "3", "4"]);
    await expect(card(win).locator("button.aos-cc-jump")).toHaveText("Answer in the terminal ⌘J");
    // The card came up; the view did not move.
    await expect(sw(win).locator("button[aria-pressed='true']")).toHaveText("Chat");
    await expect(body(win)).toBeHidden();
    // What the visible terminal answered to the stream's own queries is not the card's.
    await written(win, id);
    await choices.first().click();
    expect(await written(win, id)).toEqual(["1"]);
    // One answer per prompt: the buttons wait for the TUI to move on, and a second click writes nothing.
    await expect(choices.first()).toBeDisabled();
    await choices.first().click({ force: true });
    expect(await written(win, id)).toEqual([]);
    // The TUI moved on: the card goes.
    await win.evaluate(({ i, d }) => (window as unknown as FakeW).__fakes?.[i].emit(d), { i: id, d: drawn("claude-2.1.318-idle") });
    await expect(chat(win).locator(".aos-cc-card")).not.toHaveClass(/is-on/);
    await expect(sw(win).locator("button[aria-pressed='true']")).toHaveText("Chat");
    await removeTerminal(win, id);
    expectNoErrors(h);
  });

  test("with a card up the composer's Send (button and ⏎) writes nothing and keeps the draft; after the card clears it sends (R49)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-000000000029", sessionId: "a1a1a1a1-0000-4000-8000-00000000002a", label: "Composer under a card" });
    await expect(chat(win)).toBeVisible();
    await replay(win, id, screenFile("claude-2.1.318-bash.ansi"));
    await expect(card(win).locator(".aos-cc-gatetitle")).toHaveText("Do you want to proceed?");
    const input = C(win).locator(".aos-tc-input:visible");
    const note = C(win).locator(".aos-tc-note:visible");
    await written(win, id);
    await input.fill("hello there");
    await C(win).locator(".aos-tc-send:visible").click();
    await expect(note).toHaveText("Answer the card above first · Terminal ⌘J");
    await input.press("Enter");
    expect(await written(win, id)).toEqual([]);
    await expect(input).toHaveValue("hello there");
    // The note follows the view's words: the terminal's prompt there, the card above back in the chat.
    await win.keyboard.press("Meta+j");
    await expect(body(win)).toBeVisible();
    await expect(note).toHaveText("Answer the prompt in the terminal first");
    // The terminal view's fit lands (on a slow machine it always has by now) and moves the PTY to the stage's size (the
    // note under its composer takes a row); this TUI never redraws for it.
    await frames(win);
    await win.keyboard.press("Meta+j");
    await expect(chat(win)).toBeVisible();
    // The screen poll (every POLL_MS while a card is up) reads the screen before the TUI drew at that size, as a slow
    // machine's does before the next step: the frame the TUI drew is still its prompt, so the card and the note stay.
    await win.evaluate(() => (window as unknown as { aosHost: { plugin: { codeFeeds: { poll(): void } } } }).aosHost.plugin.codeFeeds.poll());
    await expect(card(win).locator(".aos-cc-gatetitle")).toHaveText("Do you want to proceed?");
    await expect(note).toHaveText("Answer the card above first · Terminal ⌘J");
    // The TUI moved on: the note goes with the card, before anything is sent, and Send works again.
    await win.evaluate(({ i, d }) => (window as unknown as FakeW).__fakes?.[i].emit(d), { i: id, d: drawn("claude-2.1.318-idle") });
    await expect(chat(win).locator(".aos-cc-card")).not.toHaveClass(/is-on/);
    await expect(note).toHaveCount(0);
    await expect(input).toHaveValue("hello there");
    await input.press("Enter");
    // Within SEND_QUIET_MS of the terminal's last input (R62) Send waits that long before it reads the screen and goes.
    let sent = "";
    await expect.poll(async () => (sent += (await written(win, id)).join(""))).toContain("hello there");
    await expect(input).toHaveValue("");
    await expect(note).toHaveCount(0);
    await removeTerminal(win, id);
    expectNoErrors(h);
  });

  // The prompt /menu opens comes 150 ms after it (R62: within SEND_QUIET_MS), or 900 ms after it (R69: past SEND_QUIET_MS,
  // as Codex's first /model did live; a Send after a slash command waits up to SLASH_SETTLE_MS for it).
  for (const [delay, n] of [[150, "2b"], [900, "3a"]] as const) {
    test(`R62, R69: a draft sent right after /menu stays, held by the prompt /menu opens ${delay} ms later, and nothing of it reaches that prompt`, async () => {
      const h = app();
      const { win } = h;
      await openTab(win, "term");
      // The fake opens a numbered prompt (a captured Claude Code approval) `delay` ms after it receives a line starting /menu.
      const key = `a1a1a1a1-0000-4000-8000-0000000000${n}`;
      const sid = `a1a1a1a1-0000-4000-8000-0000000000${n === "2b" ? "2c" : "3b"}`;
      const id = await fakeAgent(win, { host: "claude", terminalKey: key, sessionId: sid, label: "Composer after a command" }, { menu: screenFile("claude-2.1.318-bash.ansi"), menuDelay: delay });
      await expect(chat(win)).toBeVisible();
      await replay(win, id, drawn("claude-2.1.318-idle"));
      const input = C(win).locator(".aos-tc-input:visible");
      const note = C(win).locator(".aos-tc-note:visible");
      let log = "";
      const take = async () => (log += (await written(win, id)).join(""));
      await take();
      log = "";
      // /menu goes (nothing is up), then at once a draft and ⏎, before the prompt /menu opens is on the screen.
      await input.fill("/menu");
      await C(win).locator(".aos-tc-send:visible").click();
      await expect(input).toHaveValue("");
      await input.fill("z");
      await input.press("Enter");
      // The draft waited for the TUI, found its prompt, and stayed.
      await expect(card(win).locator(".aos-cc-gatetitle")).toHaveText("Do you want to proceed?");
      await expect(note).toHaveText("Answer the card above first · Terminal ⌘J");
      await expect(input).toHaveValue("z");
      await win.waitForTimeout(800);
      await take();
      // What the fake received: /menu and its one ⏎; never the draft's text nor a second ⏎ (the visible terminal's
      // replies to the stream's queries hold neither).
      expect(log).toContain("/menu");
      expect(log, JSON.stringify(log)).not.toContain("z");
      expect(log.split("\r").length - 1, JSON.stringify(log)).toBe(1);
      await removeTerminal(win, id);
      expectNoErrors(h);
    });
  }

  test("C1: an agent that ends while Send waits takes nothing of the draft with it: the login shell that takes its terminal over runs none of it, and the draft leaves the shell's box (R73)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-00000000003c", sessionId: "a1a1a1a1-0000-4000-8000-00000000003d", label: "Ends while Send waits" });
    await expect(chat(win)).toBeVisible();
    await replay(win, id, drawn("claude-2.1.318-idle"));
    // Its terminal view, whose composer is not kept away when the agent ends (it becomes the shell's).
    await win.keyboard.press("Meta+j");
    await expect(body(win)).toBeVisible();
    const input = C(win).locator(".aos-term-main > .aos-tc .aos-tc-input");
    const draft = "echo leaked-$((6*7))";
    await input.fill(draft);
    // Input a moment ago (a key typed in the terminal): Send waits SEND_QUIET_MS, and the agent ends meanwhile.
    await win.evaluate((i) => (window as unknown as FakeW).aosHost.plugin.terminalPool.get(i)?.write(" "), id);
    await input.press("Enter");
    await win.evaluate((i) => (window as unknown as FakeW).__fakes?.[i].exit(0), id);
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("This is your shell, in the same folder.");
    await win.waitForTimeout(1500);
    expect(await terminalText(win)).not.toContain("leaked-42");
    // R73: the draft written for the agent leaves what is now the shell's composer (one more ⏎ would run it there), and
    // the note says the agent ended instead of inviting another Send.
    await expect(input).toHaveValue("");
    await expect(C(win).locator(".aos-term-main > .aos-tc .aos-tc-note")).toHaveText("Claude Code ended before this was sent");
    expect((await written(win, id)).join("")).not.toContain("leaked");
    await removeTerminal(win, id);
    expectNoErrors(h);
  });

  test("I2: an agent that ends while Send waits and another terminal shows: back on it, the shell's box is empty and the shell ran nothing (R73)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const other = await fakeAgent(win, { host: "codex", terminalKey: "a1a1a1a1-0000-4000-8000-00000000004c", sessionId: "a1a1a1a1-0000-4000-8000-00000000004d", label: "Shown meanwhile" });
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-00000000004e", sessionId: "a1a1a1a1-0000-4000-8000-00000000004f", label: "Ends unseen" });
    await expect(C(win).locator(".aos-term-headtitle")).toHaveText("Ends unseen");
    await replay(win, id, drawn("claude-2.1.318-idle"));
    await win.keyboard.press("Meta+j");
    await expect(body(win)).toBeVisible();
    const input = C(win).locator(".aos-term-main > .aos-tc .aos-tc-input");
    const draft = "echo leaked-$((6*7))";
    await input.fill(draft);
    // Send waits SEND_QUIET_MS after the last input; meanwhile the other terminal is selected and this agent ends.
    await win.evaluate((i) => (window as unknown as FakeW).aosHost.plugin.terminalPool.get(i)?.write(" "), id);
    await input.press("Enter");
    await win.evaluate(({ i, o }) => {
      const w = window as unknown as FakeW;
      w.aosHost.plugin.terminalPool.select(o);
      w.__fakes?.[i].exit(0);
    }, { i: id, o: other });
    await expect(C(win).locator(".aos-term-headtitle")).toHaveText("Shown meanwhile");
    await expect.poll(() => win.evaluate((i) => (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { agentEnded: boolean } | undefined } } } }).aosHost.plugin.terminalPool.get(i)?.agentEnded ?? null, id), { timeout: 10_000 }).toBe(true);
    await win.waitForTimeout(1500);
    // Back on it, in its terminal view: the agent's draft did not come back into what is now the shell's composer.
    await select(win, id);
    await expect(body(win)).toBeVisible();
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("This is your shell, in the same folder.");
    await expect(input).toHaveAttribute("placeholder", "Write a command…");
    await expect(input).toHaveValue("");
    await win.waitForTimeout(500);
    expect(await terminalText(win)).not.toContain("leaked-42");
    expect((await written(win, id)).join("")).not.toContain("leaked");
    expect((await written(win, other)).join("")).not.toContain("leaked");
    await removeTerminal(win, id);
    await removeTerminal(win, other);
    expectNoErrors(h);
  });

  test("a card that comes under the fold of a long chat is scrolled into view, and a long choice wraps inside it, never wider than the card", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const sid = "a1a1a1a1-0000-4000-8000-00000000002e";
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-00000000002d", sessionId: sid, label: "Long chat, long choice" });
    await expect(chat(win)).toBeVisible();
    const restore = await emulateViewport(win, { width: 960, height: 600, scale: 1 });
    try {
      // A long conversation, shown at its end. The fake has no follower, so its feed is handed the events one would read.
      const events: object[] = [{ t, kind: "session", id: sid, model: "fixture-model", turn: 0 }];
      for (let n = 1; n <= 30; n++) {
        events.push({ t, kind: "prompt", text: `Question ${n} about the tide tables`, turn: n }, { t, kind: "text", text: `Answer ${n}: the readings are in.`, turn: n },
          { t, kind: "done", ok: true, usd: null, estimated: false, model: "fixture-model", turn: n });
      }
      await feedEvents(win, id, events);
      await expect(chat(win).locator(".aos-ss-prompt")).toHaveCount(30);
      // The TUI asks, a long path in its second choice; the card comes after the last row, below what shows.
      const long = "/work/demo/workspaces/harbor-map/src/tide-tables/station-format/readings-2026-11";
      const screen = screenFile("claude-2.1.318-bash.txt").replace("access to /work/demo", `access to ${long}`);
      await replay(win, id, `\u001b[H\u001b[2J${screen.split("\n").join("\r\n")}`);
      const gate = card(win);
      await expect(gate.locator(".aos-cc-gatetitle")).toHaveText("Do you want to proceed?");
      const second = gate.locator("button.aos-cc-choice").nth(1);
      await expect(second.locator(".aos-cc-choicelabel")).toHaveText(`Yes, and always allow access to ${long} from this project`);
      // In view: wholly, or from its top when it is taller than the chat (the scroll is smooth: wait for it to land).
      const scroll = chat(win).locator(".aos-cc-scroll");
      await expect.poll(async () => {
        const [c, s] = [await gate.boundingBox(), await scroll.boundingBox()];
        if (!c || !s) return false;
        return c.y >= s.y - 1 && (c.y + c.height <= s.y + s.height + 1 || Math.abs(c.y - s.y) <= 1);
      }).toBe(true);
      // The long choice wraps inside the card: no button wider than it, nothing overflowing it.
      const fit = await gate.evaluate((g) => {
        const box = g.getBoundingClientRect();
        return { overflow: g.scrollWidth > g.clientWidth, outside: Array.from(g.querySelectorAll("button.aos-cc-choice")).filter((b) => b.getBoundingClientRect().right > box.right + 0.5).length };
      });
      expect(fit).toEqual({ overflow: false, outside: 0 });
      expect((await second.boundingBox())?.height ?? 0, "on more than one line").toBeGreaterThan(32);
    } finally {
      await restore();
    }
    await removeTerminal(win, id);
    expectNoErrors(h);
  });

  test("the top bar's Started … · Change note keeps to one line in a narrow window, ellipsized, and the bar keeps its height", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-00000000002f", sessionId: "a1a1a1a1-0000-4000-8000-000000000030", label: "Started note" });
    await expect(chat(win)).toBeVisible();
    // Narrow enough that the note cannot show whole beside the bar's own items, wide enough that some of it shows.
    const restore = await emulateViewport(win, { width: 1100, height: 700, scale: 1 });
    try {
      const header = C(win).locator(".aos-term-main > .aos-term-header");
      const before = (await header.boundingBox())?.height ?? 0;
      const text = "Started Claude Code in workspaces/harbor-map/src/tide-tables/station-format, the folder its last conversation ran in";
      await win.evaluate(({ i, text }) => {
        const p = (window as unknown as { aosHost: { plugin: { terminalPool: { trigger(name: string, ...a: unknown[]): void } } } }).aosHost.plugin.terminalPool;
        p.trigger("session-launched", { id: i, text, why: "default", host: "claude" });
      }, { i: id, text });
      const note = C(win).locator(".aos-term-started");
      await expect(note.locator(".aos-term-started-text")).toHaveText(text);
      await expect(note).toHaveAttribute("title", text);
      await expect(note.locator(".aos-term-started-change")).toBeVisible();
      const m = await note.evaluate((n) => {
        const s = n.querySelector(".aos-term-started-text") as HTMLElement;
        const b = n.querySelector(".aos-term-started-change") as HTMLElement;
        return { height: n.getBoundingClientRect().height, shown: s.clientWidth, cut: s.scrollWidth > s.clientWidth, change: b.getBoundingClientRect().right <= n.getBoundingClientRect().right + 0.5 };
      });
      expect(m.height, "one line").toBeLessThanOrEqual(30);
      expect(m.cut, "ellipsized").toBe(true);
      expect(m.shown, "some of it shows").toBeGreaterThan(40);
      expect(m.change, "Change whole").toBe(true);
      expect((await header.boundingBox())?.height).toBe(before);
    } finally {
      await restore();
    }
    await removeTerminal(win, id);
    expectNoErrors(h);
  });

  test("a /model dialog is a Needs you on its row, in the footer and on the rail, and the waiting card in its chat; nothing flips the view (C4, C10)", async () => {
    const { win } = app();
    await openTab(win, "term");
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-000000000023", sessionId: "a1a1a1a1-0000-4000-8000-000000000024", label: "Model picker" });
    await expect(chat(win)).toBeVisible();
    // In its terminal view when the dialog comes up.
    expect(await command(win, "agentic-os:toggle-code-view")).toBe(true);
    await expect(body(win)).toBeVisible();
    const sub = C(win).locator(`.aos-tl-row[data-session="${id}"] .aos-tl-sub`);
    await expect(sub).not.toContainText("Needs you");
    await expect(badge(win, "term")).toHaveText("");
    await replay(win, id, drawn("claude-2.1.318-model"));
    await expect(sub).toContainText("Needs you");
    await expect(sub).toHaveClass(/is-needs/);
    await expect(C(win).locator(`.aos-tl-row[data-session="${id}"] .aos-tl-glyph`)).toHaveClass(/is-needs/);
    await expect(C(win).locator(".aos-tl-needs")).toHaveText("1 need you");
    await expect(badge(win, "term")).toHaveText("1");
    // Still its terminal: the card waits in the chat.
    await expect(body(win)).toBeVisible();
    await expect(chat(win)).toBeHidden();
    expect(await command(win, "agentic-os:toggle-code-view")).toBe(true);
    await expect(chat(win)).toBeVisible();
    const waiting = chat(win).locator(".aos-cc-gate.is-waiting");
    await expect(waiting.locator(".aos-cc-gatetitle")).toHaveText("Waiting on you in the terminal");
    await expect(waiting.locator("button.aos-cc-choice")).toHaveCount(0);
    await waiting.locator("button.aos-cc-jump", { hasText: "Answer in the terminal ⌘J" }).click();
    await expect(body(win)).toBeVisible();
    // The badge counts Needs you wherever you are.
    await openTab(win, "pulse");
    await expect(badge(win, "term")).toHaveText("1");
    await win.evaluate(({ i, d }) => (window as unknown as FakeW).__fakes?.[i].emit(d), { i: id, d: drawn("claude-2.1.318-idle") });
    await expect(badge(win, "term")).toHaveText("");
    await openTab(win, "term");
    await expect(sub).not.toContainText("Needs you");
    // Closed with a dialog up: the count drops with it.
    await win.evaluate(({ i, d }) => (window as unknown as FakeW).__fakes?.[i].emit(d), { i: id, d: drawn("claude-2.1.318-model") });
    await expect(badge(win, "term")).toHaveText("1");
    await removeTerminal(win, id);
    await expect(badge(win, "term")).toHaveText("");
  });

  test("an agent that ends with its prompt up takes the card with it: nothing on the login shell's screen is the agent's to answer (R39)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-000000000027", sessionId: "a1a1a1a1-0000-4000-8000-000000000028", label: "Ending with a prompt" });
    await expect(chat(win)).toBeVisible();
    await replay(win, id, screenFile("claude-2.1.318-bash.ansi"));
    await expect(card(win).locator(".aos-cc-gatetitle")).toHaveText("Do you want to proceed?");
    const sub = C(win).locator(`.aos-tl-row[data-session="${id}"] .aos-tl-sub`);
    await expect(sub).toContainText("Needs you");
    await expect(badge(win, "term")).toHaveText("1");
    // The agent exits and the login shell takes its terminal over (D18).
    await win.evaluate((i) => (window as unknown as FakeW).__fakes?.[i].exit(0), id);
    await expect(chat(win).locator(".aos-cc-ended")).toHaveText("Claude Code ended · Terminal ⌘J");
    await expect(chat(win).locator(".aos-cc-card")).not.toHaveClass(/is-on/);
    await expect(chat(win).locator("button.aos-cc-choice")).toHaveCount(0);
    await expect(sub).not.toContainText("Needs you");
    await expect(badge(win, "term")).toHaveText("");
    expect(await win.evaluate((i) => (window as unknown as FakeW).aosHost.plugin.codeFeeds.screened(i), id)).toBe(false);
    expect(await written(win, id)).not.toContain("1");
    await removeTerminal(win, id);
    expectNoErrors(h);
  });

  test("a Codex terminal's footer is its status line under the composer, colours kept; the hint before there is one (C5)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const id = await fakeAgent(win, { host: "codex", terminalKey: "a1a1a1a1-0000-4000-8000-000000000025", sessionId: "a1a1a1a1-0000-4000-8000-000000000026", label: "Codex footer" });
    await expect(chat(win)).toBeVisible();
    const status = chat(win).locator(".aos-cc-status");
    await expect(status).toHaveText("Status line in the terminal ⌘J");
    await replay(win, id, screenFile("codex-0.167.0-idle.ansi"));
    const lines = status.locator(".aos-cc-statusline");
    await expect(lines).toHaveCount(2);
    await expect(lines.first()).toHaveText("GPT-6-Luna low · Context 0% used · weekly limit ok");
    await expect(lines.nth(1)).toHaveText(/^← for agents · \? for shortcuts\s+⚠ 1 warning · f2 to view$/);
    await expect(status.locator("span", { hasText: "GPT-6-Luna low" })).toHaveAttribute("style", /color: rgb\(/);
    await expect(chat(win).locator(".aos-cc-card")).not.toHaveClass(/is-on/);
    await removeTerminal(win, id);
    expectNoErrors(h);
  });
});

// The composer's images (C7, C13): paste, drop and + attach each add a chip with its thumbnail and ×; main saves the image
// into the app's own data folder at once (code:save-image) and names the path; Send pastes each path as a bracketed paste
// of its own, which the TUI attaches as an image (R63), then the text, through the same guarded Send (a card holds it). A
// refused image says why under the box. The stand-in agent is the fake process above, so what Send writes is what the TUI
// would read.

/** A real 2×2 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPQiDoBRAwQCgAhpgUpG+5kRAAAAABJRU5ErkJggg==";
/** GIF bytes: a header is enough for main's check. */
const GIF = Buffer.from("GIF89a\u0002\u0000\u0002\u0000", "latin1").toString("base64");
type Pasted = { name: string; type: string; b64: string };
/** Dispatches what a paste (or a drop on the box) of these files would; whether the page took it (preventDefault). */
const deliver = (win: Page, kind: "paste" | "drop", files: Pasted[]): Promise<boolean> => content(win).locator(".aos-tc-input:visible").evaluate((input, { kind, files }) => {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
  if (kind === "paste") return !input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  const box = input.closest(".aos-tc-box") as HTMLElement;
  box.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
  return !box.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
}, { kind, files });
/** The paths in what Send wrote: quoted (the app's data folder has spaces), under code-images/<yyyy-mm>/<uuid>.<ext>. */
const imagePath = (ext: string) => new RegExp(`"(${USER_DATA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/code-images/\\d{4}-\\d{2}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${ext})"`);

test.describe("the composer's images (C7, C13)", () => {
  test.describe.configure({ mode: "serial" });
  const app = useApp({ env: { AOS_APP_WRITE: "code" } });
  const shots = (win: Page) => C(win).locator(".aos-tc-shot:visible");
  const input = (win: Page) => C(win).locator(".aos-tc-input:visible");
  const note = (win: Page) => C(win).locator(".aos-tc-note:visible");
  /** Everything the terminal writes to the fake from now until `want` matches it. */
  const writesUntil = async (win: Page, id: string, want: RegExp): Promise<string> => {
    let got = "";
    await expect.poll(async () => (got += (await written(win, id)).join(""))).toMatch(want);
    return got;
  };

  test("pasting a PNG makes a chip with its thumbnail; Send pastes the saved image's path as a paste of its own, then the text once the TUI shows the image; a card holds it", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    // The fake prints "[Image #N]" 300 ms after a paste of only an image's path, as Claude Code inserts it once read (R70).
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-000000000031", sessionId: "a1a1a1a1-0000-4000-8000-000000000032", label: "Images" }, { images: true });
    await expect(chat(win)).toBeVisible();
    await replay(win, id, drawn("claude-2.1.318-idle"));
    expect(await deliver(win, "paste", [{ name: "image.png", type: "image/png", b64: PNG }])).toBe(true);
    await expect(shots(win)).toHaveCount(1);
    await expect(shots(win).locator("img.aos-tc-thumb")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(shots(win).locator("button.aos-tc-shotx")).toHaveAttribute("aria-label", "Remove image.png");
    // Saved by main as soon as it was pasted: the chip is no longer waiting.
    await expect(shots(win)).not.toHaveClass(/is-saving/);
    // A card is up: Send (⏎) writes nothing and keeps the text and the chip (R49 holds for images too).
    await replay(win, id, screenFile("claude-2.1.318-bash.ansi"));
    await expect(chat(win).locator(".aos-cc-card .aos-cc-gate .aos-cc-gatetitle")).toHaveText("Do you want to proceed?");
    await input(win).fill("look at this");
    await written(win, id);
    await input(win).press("Enter");
    await expect(note(win)).toHaveText("Answer the card above first · Terminal ⌘J");
    expect(await written(win, id)).toEqual([]);
    await expect(shots(win)).toHaveCount(1);
    await expect(input(win)).toHaveValue("look at this");
    // The TUI moved on: Send pastes the quoted path alone (what the TUI attaches as an image), then the text, then Enter.
    await win.evaluate(({ i, d }) => (window as unknown as FakeW).__fakes?.[i].emit(d), { i: id, d: drawn("claude-2.1.318-idle") });
    await expect(chat(win).locator(".aos-cc-card")).not.toHaveClass(/is-on/);
    // What the terminal answered to the stream's own queries is not Send's.
    await written(win, id);
    const from = await win.evaluate((i) => (window as unknown as FakeW).__fakes?.[i].log.length ?? 0, id);
    await input(win).press("Enter");
    const sent = await writesUntil(win, id, /\r$/);
    // The text after the image starts with a space (D4): Claude Code's placeholder has none after it.
    const m = new RegExp(`^\u001b\\[200~${imagePath("png").source}\u001b\\[201~\u001b\\[200~ look at this\u001b\\[201~\r$`).exec(sent);
    expect(m, sent).not.toBeNull();
    // In this order (R70): the image's paste, then its placeholder on the screen, and only then the text's paste and ⏎.
    const log = (await win.evaluate((i) => (window as unknown as FakeW).__fakes?.[i].log ?? [], id)).slice(from);
    const at = (pred: (e: { write?: string; print?: string }) => boolean) => log.findIndex(pred);
    const pathAt = at((e) => !!e.write && /code-images/.test(e.write));
    const shownAt = at((e) => e.print === "[Image #1] ");
    const textAt = at((e) => e.write === " look at this");
    expect([pathAt >= 0, shownAt > pathAt, textAt > shownAt], JSON.stringify(log)).toEqual([true, true, true]);
    expect(log[textAt].at - log[shownAt].at).toBeGreaterThanOrEqual(0);
    // The file is where the path says, in the app's data folder, with the bytes pasted.
    expect(fs.readFileSync(m![1]).equals(Buffer.from(PNG, "base64"))).toBe(true);
    await expect(shots(win)).toHaveCount(0);
    await expect(input(win)).toHaveValue("");
    await removeTerminal(win, id);
    expectNoErrors(h);
  });

  test("a drop and + attach add chips too; × takes one away; an image alone sends its path; a refused image says why and makes no chip", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const id = await fakeAgent(win, { host: "codex", terminalKey: "a1a1a1a1-0000-4000-8000-000000000033", sessionId: "a1a1a1a1-0000-4000-8000-000000000034", label: "Images by drop" }, { images: true });
    await expect(chat(win)).toBeVisible();
    // The TUI's own stream: it turns bracketed paste on, as Codex does.
    await replay(win, id, screenFile("codex-0.167.0-idle.ansi"));
    // A drop on the box.
    expect(await deliver(win, "drop", [{ name: "drop.gif", type: "image/gif", b64: GIF }])).toBe(true);
    await expect(shots(win)).toHaveCount(1);
    // + attach opens the picker; picking files adds them.
    const attach = chat(win).locator(".aos-tc-attach button.aos-tc-chip");
    await expect(attach).toHaveText("+ attach");
    await chat(win).locator(".aos-tc-attach input.aos-tc-picker").setInputFiles([{ name: "picked.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") }]);
    await expect(shots(win)).toHaveCount(2);
    await expect(shots(win).nth(1)).toHaveAttribute("title", "picked.png");
    await expect(C(win).locator(".aos-tc-shot.is-saving")).toHaveCount(0);
    // × takes the dropped one away.
    await shots(win).first().locator("button.aos-tc-shotx").click();
    await expect(shots(win)).toHaveCount(1);
    await expect(shots(win).first()).toHaveAttribute("title", "picked.png");
    // An image alone (no text) sends its path.
    await written(win, id);
    await input(win).press("Enter");
    const sent = await writesUntil(win, id, /\r$/);
    expect(sent, JSON.stringify(sent)).toMatch(new RegExp(`^\u001b\\[200~${imagePath("png").source}\u001b\\[201~\r$`));
    await expect(shots(win)).toHaveCount(0);
    // Refused: a type the composer does not take (said before anything is sent to main), and a PNG whose content is a
    // GIF (main's own check). Neither leaves a chip; each says why under the box.
    expect(await deliver(win, "paste", [{ name: "scan.tiff", type: "image/tiff", b64: PNG }])).toBe(true);
    await expect(note(win)).toHaveText("Image not added: only PNG, JPEG, GIF or WebP images");
    await expect(shots(win)).toHaveCount(0);
    expect(await deliver(win, "paste", [{ name: "fake.png", type: "image/png", b64: GIF }])).toBe(true);
    await expect(note(win)).toHaveText("Image not added: its content is GIF, not PNG");
    await expect(shots(win)).toHaveCount(0);
    // A paste of plain text is still the textarea's own.
    expect(await input(win).evaluate((el) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "words");
      return !el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    })).toBe(false);
    expect(await written(win, id)).toEqual([]);
    await removeTerminal(win, id);
    expectNoErrors(h);
  });

  test("a shell takes no image: no + attach, and a pasted image is not a chip", async () => {
    const { win } = app();
    await openTab(win, "term");
    expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
    await expect(body(win)).toBeVisible();
    await expect(C(win).locator(".aos-term-main > .aos-tc .aos-tc-attach")).toBeHidden();
    expect(await deliver(win, "paste", [{ name: "image.png", type: "image/png", b64: PNG }])).toBe(false);
    await expect(shots(win)).toHaveCount(0);
  });

  test("D1: a prompt that comes up while Send waits for its image gets no ⏎: the text never goes, it comes back to the box, and the note says why", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    // After the image's paste the fake draws a numbered prompt (a captured Claude Code approval) instead of the placeholder.
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-00000000003e", sessionId: "a1a1a1a1-0000-4000-8000-00000000003f", label: "Prompt during the image wait" }, { images: true, imagePrompt: screenFile("claude-2.1.318-bash.ansi") });
    await expect(chat(win)).toBeVisible();
    // The TUI's idle screen, with bracketed paste on (as Claude Code turns it on).
    await replay(win, id, `\u001b[?2004h${drawn("claude-2.1.318-idle")}`);
    expect(await deliver(win, "paste", [{ name: "image.png", type: "image/png", b64: PNG }])).toBe(true);
    await expect(C(win).locator(".aos-tc-shot.is-saving")).toHaveCount(0);
    await expect(shots(win)).toHaveCount(1);
    await input(win).fill("look at this");
    await written(win, id);
    const from = await win.evaluate((i) => (window as unknown as FakeW).__fakes?.[i].log.length ?? 0, id);
    await input(win).press("Enter");
    await expect(chat(win).locator(".aos-cc-card .aos-cc-gate .aos-cc-gatetitle")).toHaveText("Do you want to proceed?");
    await expect(note(win)).toHaveText("Answer the card above first · Terminal ⌘J");
    await expect(input(win)).toHaveValue("look at this");
    await win.waitForTimeout(500);
    // What the fake received after ⏎: the image's paste only; never the text, never a ⏎ (beside the visible terminal's
    // replies to the stream's queries, which hold neither).
    const got = (await win.evaluate((i) => (window as unknown as FakeW).__fakes?.[i].log ?? [], id)).slice(from).map((e) => e.write ?? "").join("");
    expect(got, JSON.stringify(got)).toMatch(/code-images/);
    expect(got, JSON.stringify(got)).not.toContain("look at this");
    expect(got, JSON.stringify(got)).not.toContain("\r");
    await removeTerminal(win, id);
    expectNoErrors(h);
  });

  test("D5: a draft belongs to its terminal: switching to another shows that one's (empty), and back shows the first's again", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const a = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-000000000040", sessionId: "a1a1a1a1-0000-4000-8000-000000000041", label: "Draft A" });
    await expect(chat(win)).toBeVisible();
    await input(win).fill("for Claude only");
    const b = await fakeAgent(win, { host: "codex", terminalKey: "a1a1a1a1-0000-4000-8000-000000000042", sessionId: "a1a1a1a1-0000-4000-8000-000000000043", label: "Draft B" });
    await expect(C(win).locator(".aos-term-headtitle")).toHaveText("Draft B");
    await expect(input(win)).toHaveValue("");
    await input(win).fill("for Codex");
    await select(win, a);
    await expect(C(win).locator(".aos-term-headtitle")).toHaveText("Draft A");
    await expect(input(win)).toHaveValue("for Claude only");
    await select(win, b);
    await expect(input(win)).toHaveValue("for Codex");
    // Nothing of either went anywhere.
    expect((await written(win, a)).join("")).not.toContain("for ");
    expect((await written(win, b)).join("")).not.toContain("for ");
    await removeTerminal(win, b);
    await removeTerminal(win, a);
    expectNoErrors(h);
  });

  // The last two in this app: main's code:save-image is replaced by one the test answers by hand, so an image stays
  // "saving" as long as the test wants.
  test("⏎ while an image saves sends once it is saved, only if the draft is unchanged; a bare errno reads as words; 8 images at most (R60)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-000000000035", sessionId: "a1a1a1a1-0000-4000-8000-000000000036", label: "Images held" }, { images: true });
    await expect(chat(win)).toBeVisible();
    // The TUI turns bracketed paste on.
    await win.evaluate((i) => (window as unknown as FakeW).__fakes?.[i].emit("\u001b[?2004h"), id);
    await h.app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __saves: Array<(r: unknown) => void> };
      g.__saves = [];
      ipcMain.removeHandler("code:save-image");
      ipcMain.handle("code:save-image", () => new Promise((r) => { g.__saves.push(r); }));
    });
    const answer = (r: object) => h.app.evaluate((_e, a) => (globalThis as unknown as { __saves: Array<(r: unknown) => void> }).__saves.shift()?.(a), r);
    const saving = () => C(win).locator(".aos-tc-shot.is-saving:visible");
    // ⏎ while it saves, then the draft changes before the save lands: nothing is sent, the new draft stays.
    expect(await deliver(win, "paste", [{ name: "one.png", type: "image/png", b64: PNG }])).toBe(true);
    await expect(saving()).toHaveCount(1);
    await input(win).fill("first try");
    await written(win, id);
    await input(win).press("Enter");
    await input(win).fill("changed my mind");
    await answer({ ok: true, data: { path: "/work/demo/one.png" } });
    await expect(saving()).toHaveCount(0);
    await win.waitForTimeout(500);
    expect(await written(win, id)).toEqual([]);
    await expect(input(win)).toHaveValue("changed my mind");
    await expect(shots(win)).toHaveCount(1);
    // Unchanged while it saves: the ⏎ sends once the save lands.
    expect(await deliver(win, "paste", [{ name: "two.png", type: "image/png", b64: PNG }])).toBe(true);
    await input(win).press("Enter");
    await expect(saving()).toHaveCount(1);
    await answer({ ok: true, data: { path: "/work/demo/two.png" } });
    // Each path a paste of its own, in the order the images came, then the text.
    expect(await writesUntil(win, id, /\r$/)).toBe("\u001b[200~/work/demo/one.png\u001b[201~\u001b[200~/work/demo/two.png\u001b[201~\u001b[200~ changed my mind\u001b[201~\r");
    await expect(shots(win)).toHaveCount(0);
    // Main's fs code alone reads as words.
    expect(await deliver(win, "paste", [{ name: "three.png", type: "image/png", b64: PNG }])).toBe(true);
    await expect(saving()).toHaveCount(1);
    await answer({ ok: false, error: "EEXIST", code: "EEXIST" });
    await expect(note(win)).toHaveText("Image not added: it could not be saved: try again");
    await expect(shots(win)).toHaveCount(0);
    // Nine at once: eight chips, and the ninth says why.
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `shot-${i + 1}.png`, type: "image/png", b64: PNG }));
    expect(await deliver(win, "paste", nine)).toBe(true);
    await expect(shots(win)).toHaveCount(8);
    await expect(note(win)).toHaveText("Image not added: 8 images at most in one message");
    await removeTerminal(win, id);
    expectNoErrors(h);
  });

  test("I2: an agent that ends while ⏎ waits for an image to save sends nothing: the draft leaves the shell's box and the note says the agent ended (R73)", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const id = await fakeAgent(win, { host: "claude", terminalKey: "a1a1a1a1-0000-4000-8000-000000000050", sessionId: "a1a1a1a1-0000-4000-8000-000000000051", label: "Ends while saving" }, { images: true });
    await expect(chat(win)).toBeVisible();
    await win.evaluate((i) => (window as unknown as FakeW).__fakes?.[i].emit("\u001b[?2004h"), id);
    // Its terminal view, whose composer becomes the shell's when the agent ends.
    await win.keyboard.press("Meta+j");
    await expect(body(win)).toBeVisible();
    await h.app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __saves: Array<(r: unknown) => void> };
      g.__saves = [];
      ipcMain.removeHandler("code:save-image");
      ipcMain.handle("code:save-image", () => new Promise((r) => { g.__saves.push(r); }));
    });
    const answer = (r: object) => h.app.evaluate((_e, a) => (globalThis as unknown as { __saves: Array<(r: unknown) => void> }).__saves.shift()?.(a), r);
    const box = C(win).locator(".aos-term-main > .aos-tc .aos-tc-input");
    expect(await deliver(win, "paste", [{ name: "one.png", type: "image/png", b64: PNG }])).toBe(true);
    await expect(C(win).locator(".aos-tc-shot.is-saving:visible")).toHaveCount(1);
    const draft = "echo leaked-$((6*7))";
    await box.fill(draft);
    await written(win, id);
    await box.press("Enter");
    await win.evaluate((i) => (window as unknown as FakeW).__fakes?.[i].exit(0), id);
    await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("This is your shell, in the same folder.");
    await answer({ ok: true, data: { path: "/work/demo/one.png" } });
    await expect(C(win).locator(".aos-term-main > .aos-tc .aos-tc-note")).toHaveText("Claude Code ended before this was sent");
    await expect(box).toHaveValue("");
    await win.waitForTimeout(500);
    expect(await terminalText(win)).not.toContain("leaked-42");
    expect((await written(win, id)).join("")).not.toContain("leaked");
    await removeTerminal(win, id);
    expectNoErrors(h);
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

// The Diff and Files panes (C8) need no write surface: this run has none on. code:git names the terminal; main reads git in
// the folder that terminal started in, only for a vault workspace (or a workspace's linked code folder).
test.describe("the Diff and Files panes, whichever write surfaces are on (C8)", () => {
  test.describe.configure({ mode: "serial" });
  const app = useApp();
  /** A shell in `cwd`, selected; its pool id. */
  const startShell = (win: Page, cwd: string): Promise<string> => win.evaluate((dir) => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { create(o: object): { id: string }; select(id: string): void } } } }).aosHost.plugin.terminalPool;
    const s = p.create({ cwd: dir, meta: { host: "shell" } });
    p.select(s.id);
    return s.id;
  }, cwd);
  const panes = (win: Page) => C(win).locator(".aos-term-panes");
  const pane = (win: Page) => C(win).locator(".aos-cdp");
  let inRepo = "";

  test("a workspace that is a repository: ⎇ branch and +n −n in the top bar; Diff lists its changes and shows one's diff; Files opens the workspace", async () => {
    const h = app();
    const { win } = h;
    const dir = FX.v("workspaces/kelp-watch");
    const git = (...a: string[]) => {
      const r = spawnSync("git", ["-c", `user.email=${["test", "example.invalid"].join("@")}`, "-c", "user.name=Test", ...a], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    };
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, "notes.md"), "kelp\nurchins\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Start the survey notes");
    fs.writeFileSync(path.join(dir, "notes.md"), "kelp forest\nurchins\notters\n");
    fs.writeFileSync(path.join(dir, "sightings.csv"), "date,count\n");
    await openTab(win, "term");
    inRepo = await startShell(win, dir);
    await expect(C(win).locator(".aos-term-head .aos-term-place .aos-term-branch")).toHaveText("⎇ main");
    // Closed by default; the counts are every changed file's against HEAD.
    await expect(pane(win)).toBeHidden();
    await expect(panes(win).locator(".aos-cdp-total")).toHaveText("+3 −1");
    await panes(win).locator(".aos-cdp-btn.is-diff").click();
    await expect(pane(win)).toBeVisible();
    await expect(panes(win).locator(".aos-cdp-btn.is-diff")).toHaveAttribute("aria-pressed", "true");
    await expect(pane(win).locator(".aos-cdp-branch")).toHaveText("⎇ main");
    await expect(pane(win).locator(".aos-cdp-file")).toHaveCount(2);
    await expect(pane(win).locator(".aos-cdp-file[data-path='notes.md'] .aos-cdp-counts")).toHaveText("+2 −1");
    await expect(pane(win).locator(".aos-cdp-file[data-path='sightings.csv'] .aos-cdp-change")).toHaveText("new");
    await pane(win).locator(".aos-cdp-file[data-path='notes.md']").click();
    await expect(pane(win).locator(".aos-cdp-diffpath")).toHaveText("notes.md");
    await expect(pane(win).locator(".aos-ss-diffline.is-add")).toHaveText(["+kelp forest", "+otters"]);
    await expect(pane(win).locator(".aos-ss-diffline.is-del")).toHaveText(["-kelp"]);
    // A change made meanwhile shows on Refresh.
    fs.writeFileSync(path.join(dir, "sightings.csv"), "date,count\n2026-11-09,4\n");
    await pane(win).locator(".aos-cdp-icon.is-refresh").click();
    await expect(pane(win).locator(".aos-cdp-file[data-path='sightings.csv'] .aos-cdp-counts")).toHaveText("+2 −0");
    await pane(win).locator(".aos-cdp-icon.is-close").click();
    await expect(pane(win)).toBeHidden();
    // Files: the Files tab at the workspace's folder.
    await panes(win).locator(".aos-cdp-btn.is-files").click();
    await expect(rail(win, "files")).toHaveClass(/is-active/);
    await expect(C(win).locator('.aos-fx-crumb.is-last[data-path="workspaces/kelp-watch"]')).toBeVisible();
    expectNoErrors(h);
  });

  test("a terminal at the vault root has no Diff or Files button, no branch and no counts", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    const root = await startShell(win, FX.vault);
    await expect(C(win).locator(".aos-term-head .aos-term-place")).toContainText("Vault");
    // The status is read when a terminal is selected: the repository's terminal shows its Diff again (reads work in this
    // run), then this one is selected again and its read (a refusal, which runs no git) is given the time to land.
    await select(win, inRepo);
    await expect(panes(win).locator(".aos-cdp-btn.is-diff")).toBeVisible();
    await select(win, root);
    await expect(C(win).locator(".aos-term-head .aos-term-place")).toContainText("Vault");
    await win.waitForTimeout(500);
    await expect(panes(win).locator(".aos-cdp-btn.is-diff")).toHaveCount(0);
    await expect(panes(win).locator(".aos-cdp-btn.is-files")).toHaveCount(0);
    await expect(panes(win).locator(".aos-cdp-total")).toHaveCount(0);
    await expect(C(win).locator(".aos-term-head .aos-term-branch")).toHaveCount(0);
    await expect(pane(win)).toBeHidden();
    // main refuses it too, whatever the page would ask.
    const r = await win.evaluate(async () => {
      const w = window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { ptyId: string | null } | undefined; selectedId(): string | null } } }; aos: { code: { git(r: object): Promise<{ ok: boolean; code?: string }> } } };
      const s = w.aosHost.plugin.terminalPool.get(w.aosHost.plugin.terminalPool.selectedId() ?? "");
      return w.aos.code.git({ pty: s?.ptyId ?? "none", op: "status" });
    });
    expect(r).toMatchObject({ ok: false, code: "EROFS" });
    expectNoErrors(h);
  });

  test("a status that changes while the agent works keeps the Diff pane's place: the list's and the diff's scroll and the focused file", async () => {
    const h = app();
    const { win } = h;
    const dir = FX.v("workspaces/kelp-watch");
    const logs = Array.from({ length: 40 }, (_, i) => `log-${String(i).padStart(2, "0")}.md`);
    const notes = fs.readFileSync(path.join(dir, "notes.md"), "utf8");
    try {
      // Enough for both to scroll: forty new files and a long edit.
      for (const f of logs) fs.writeFileSync(path.join(dir, f), "entry\n");
      fs.writeFileSync(path.join(dir, "notes.md"), `${Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")}\n`);
      await openTab(win, "term");
      await select(win, inRepo);
      await panes(win).locator(".aos-cdp-btn.is-diff").click();
      await expect(pane(win).locator(".aos-cdp-file")).toHaveCount(42);
      await pane(win).locator(".aos-cdp-file[data-path='notes.md']").click();
      await expect(pane(win).locator(".aos-ss-diffline.is-add")).toHaveCount(300);
      // The diff's lines scroll in its own box (.aos-ss-diff) inside the diff area.
      const place = () => pane(win).evaluate((p) => ({
        files: Math.round((p.querySelector(".aos-cdp-files") as HTMLElement).scrollTop),
        diff: Math.round((p.querySelector(".aos-cdp-diff .aos-ss-diff") as HTMLElement).scrollTop),
        focus: (document.activeElement as HTMLElement | null)?.dataset.path ?? null,
      }));
      await pane(win).evaluate((p) => {
        (p.querySelector(".aos-cdp-files") as HTMLElement).scrollTop = 120;
        (p.querySelector(".aos-cdp-diff .aos-ss-diff") as HTMLElement).scrollTop = 600;
        (p.querySelector(".aos-cdp-file[data-path='log-30.md']") as HTMLElement).focus();
      });
      const before = await place();
      expect(before.files).toBeGreaterThan(0);
      expect(before.diff).toBeGreaterThan(0);
      expect(before.focus).toBe("log-30.md");
      // Another file changes and the terminal prints: the status is read again once its output settles.
      fs.writeFileSync(path.join(dir, "log-05.md"), "entry\nmore\nlines\n");
      await win.evaluate((i) => (window as unknown as { aosHost: { plugin: { terminalPool: { get(id: string): { write(d: string): void } } } } }).aosHost.plugin.terminalPool.get(i).write("echo\r"), inRepo);
      await expect(pane(win).locator(".aos-cdp-file[data-path='log-05.md'] .aos-cdp-counts")).toHaveText("+3 −0", { timeout: 15_000 });
      // The diff shown is read again with the status (and is the same text): give it the time to land.
      await win.waitForTimeout(1000);
      expect(await place()).toEqual(before);
      await pane(win).locator(".aos-cdp-icon.is-close").click();
      expectNoErrors(h);
    } finally {
      for (const f of logs) fs.rmSync(path.join(dir, f), { force: true });
      fs.writeFileSync(path.join(dir, "notes.md"), notes);
    }
  });

  test("with Diff and a Computer pane open the terminal keeps 480 px and the panes give way, at 1280 and 1470 px", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "term");
    await select(win, inRepo);
    await panes(win).locator(".aos-cdp-btn.is-diff").click();
    await expect(pane(win)).toBeVisible();
    // This run has the Computer surface off (its pane drawn collapsed): a stand-in open pane of its default 440 px, docked
    // where the real one docks, after the Diff pane.
    await pane(win).evaluate((p) => {
      const cp = document.createElement("aside");
      cp.className = "aos-cp";
      cp.dataset.standin = "1";
      cp.style.width = "440px";
      p.after(cp);
    });
    try {
      for (const width of [1280, 1470]) {
        const restore = await emulateViewport(win, { width, height: 800, scale: 1 });
        try {
          const m = await C(win).evaluate((c) => {
            const w = (sel: string) => Math.round((c.querySelector(sel) as HTMLElement).getBoundingClientRect().width);
            const right = Math.max(...Array.from(c.children).map((e) => e.getBoundingClientRect().right));
            return { main: w(".aos-term-main"), diff: w(".aos-cdp"), cp: w(".aos-cp[data-standin]"), right, inner: window.innerWidth, scroll: c.scrollWidth - c.clientWidth };
          });
          const at = `${width}: ${JSON.stringify(m)}`;
          expect(m.main, at).toBeGreaterThanOrEqual(480);
          expect(m.diff, at).toBeGreaterThan(0);
          expect(m.cp, at).toBeGreaterThan(0);
          expect(m.right, at).toBeLessThanOrEqual(m.inner);
          expect(m.scroll, at).toBe(0);
        } finally {
          await restore();
        }
      }
    } finally {
      await C(win).evaluate((c) => c.querySelector(".aos-cp[data-standin]")?.remove());
      await pane(win).locator(".aos-cdp-icon.is-close").click();
    }
    expectNoErrors(h);
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
    // composer has no access or model chip (M1). code:save-image is the surface's too (C13): no + attach either.
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
