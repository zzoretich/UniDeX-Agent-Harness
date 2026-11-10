import { expect, test } from "@playwright/test";
import { FX, closeNotes, command, content, notePath, openTab, resizeHud, terminalText, useApp } from "./harness";

// The Term deck (spec 2026-10-08-term-agent-deck T1): terminals grouped by where they run, the selected one's header,
// and the Term keys. Read-only: shells start in the vault and Claude Code in an existing workspace, so nothing is written.

const app = useApp();
const C = () => content(app().win);
const selected = () => app().win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null } } } }).aosHost.plugin.terminalPool.selectedId());

test("Spaces' Resume in Code types `claude --resume <id>` in the workspace's place; its group sits above the vault's, and the header names the place and the host (T1, spaces-redesign D7)", async () => {
  const { win } = app();
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  await openTab(win, "spaces");
  await C().locator('.aos-spc-row[data-workspace="harbor-map"]').click();
  await expect(C().locator(".aos-spc-h1")).toHaveText("harbor-map");
  const resume = C().locator(".aos-spc-split button.aos-spc-primary").first();
  await expect(resume).toHaveText("Resume in Code");
  await resume.click();
  await expect(win.locator(".aos-wb-railbtn[data-tab='term']")).toHaveClass(/is-active/);
  // The fixture's claude stub echoes its arguments: the last thread's id, by --resume. D7's build check (Claude Code
  // 2.1.296, 2026-10-10) found a thread started in another folder resumes from the workspace's, so it starts there.
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toMatch(/\[fixture claude stub\] --resume c1a0de00-0000-4000-8000-000000000001/);
  const s = await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { cwd: string; meta: { host: string; origin: string | null; sessionId: string | null; place: { workspace?: string } | null } } | undefined } } } }).aosHost.plugin.terminalPool;
    const t = p.get(p.selectedId() ?? "");
    return t ? { cwd: t.cwd, host: t.meta.host, origin: t.meta.origin, sessionId: t.meta.sessionId, workspace: t.meta.place?.workspace ?? null } : null;
  });
  expect(s).toEqual({ cwd: FX.v("workspaces/harbor-map"), host: "claude", origin: "Spaces", sessionId: "c1a0de00-0000-4000-8000-000000000001", workspace: "harbor-map" });
  const groups = C().locator(".aos-tl-group");
  await expect(groups.first()).toHaveAttribute("data-group", "ws:harbor-map");
  await expect(C().locator(".aos-tl-group[data-group='other']")).toHaveCount(1);
  await expect(C().locator(".aos-tl-row.aos-term-tab-active .aos-tl-origin")).toHaveText("from Spaces");
  await expect(C().locator(".aos-term-head .aos-term-place")).toContainText("harbor-map");
  await expect(C().locator(".aos-term-head .aos-term-chip").first()).toContainText("Claude Code");
  // The workspace's group links back to Spaces on it (D12): select only, nothing starts.
  const count = await win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { list(): unknown[] } } } }).aosHost.plugin.terminalPool.list().length);
  await C().locator(".aos-tl-group[data-group='ws:harbor-map'] .aos-tl-openws").click();
  await expect(win.locator(".aos-wb-railbtn[data-tab='spaces']")).toHaveClass(/is-active/);
  await expect(C().locator('.aos-spc-row[data-workspace="harbor-map"]')).toHaveAttribute("aria-selected", "true");
  expect(await win.evaluate(() => (window as unknown as { aosHost: { plugin: { terminalPool: { list(): unknown[] } } } }).aosHost.plugin.terminalPool.list().length)).toBe(count);
});

test("an agent that ends shows Done, and Restart starts it again in the same place (T1)", async () => {
  const { win } = app();
  await openTab(win, "term");
  // The fixture's claude stub echoes and exits 0, so the exec'd agent ends at once.
  const row = C().locator(".aos-tl-row.aos-term-tab-active");
  await expect(row.locator(".aos-tl-end")).toHaveText("✓ Done", { timeout: 10_000 });
  // A terminal that knows its conversation (here the thread Spaces resumed) offers Resume by that id, not the latest.
  await expect(C().locator(".aos-term-endbar button")).toHaveText(["Restart", "Resume", "Open a shell here"]);
  await expect(C().locator(".aos-term-endbar button", { hasText: /^Resume$/ })).toHaveAttribute("title", "Resume this conversation (c1a0de00…)");
  const before = await C().locator(".aos-tl-row").count();
  await C().locator(".aos-term-endbar button", { hasText: "Restart" }).click();
  await expect(C().locator(".aos-tl-row")).toHaveCount(before + 1);
  await expect(C().locator(".aos-tl-group[data-group='ws:harbor-map'] ~ .aos-tl-row.aos-term-tab-active")).toHaveCount(1);
});

test("the selection survives a tab switch; ⇧⌘[ and ⇧⌘] walk the list; ⇧⌘W closes a shell at once (T1)", async () => {
  const { win } = app();
  await openTab(win, "term");
  const first = await selected();
  await openTab(win, "pulse");
  await openTab(win, "term");
  expect(await selected()).toBe(first);
  await expect(C().locator(".aos-tl-row.aos-term-tab-active")).toHaveAttribute("data-session", first ?? "");
  expect(await command(win, "agentic-os:term-next")).toBe(true);
  const next = await selected();
  expect(next).not.toBe(first);
  expect(await command(win, "agentic-os:term-previous")).toBe(true);
  expect(await selected()).toBe(first);
  // Select the vault shell and close it: a shell needs no confirmation.
  await C().locator(".aos-tl-group[data-group='other'] ~ .aos-tl-row[data-host='shell']").first().click();
  const shells = await C().locator(".aos-tl-row[data-host='shell']").count();
  expect(await command(win, "agentic-os:term-close")).toBe(true);
  await expect(C().locator(".aos-tl-row[data-host='shell']")).toHaveCount(shells - 1);
});

test("Clear ended removes the agents that ended; the filter narrows the list", async () => {
  const { win } = app();
  await openTab(win, "term");
  await C().locator(".aos-tl-filter").fill("zzz-nothing");
  await expect(C().locator(".aos-tl-empty")).toHaveText("No session matches.");
  await C().locator(".aos-tl-filter").fill("");
  await expect(C().locator(".aos-tl-clear")).toBeVisible({ timeout: 10_000 });
  await C().locator(".aos-tl-clear").click();
  await expect(C().locator(".aos-tl-end")).toHaveCount(0);
  expect(FX.v("workspaces/harbor-map")).toContain("harbor-map");
});

test("the composer sits under every running terminal, a shell too: ⌘L focuses it and Enter runs what was written (T12)", async () => {
  const { win } = app();
  await openTab(win, "term");
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  await expect(C().locator(".aos-tc")).not.toHaveClass(/is-hidden/);
  await expect(C().locator(".aos-tc-input")).toHaveAttribute("placeholder", "Write a command…");
  await expect(C().locator(".aos-tc-hint")).not.toContainText("/ commands");
  expect(await command(win, "agentic-os:term-composer")).toBe(true);
  await expect(C().locator(".aos-tc-input")).toBeFocused();
  await C().locator(".aos-tc-input").fill("echo composer-$((6*7))");
  await win.keyboard.press("Enter");
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("composer-42");
  await expect(C().locator(".aos-tc-input")).toHaveValue("");
  // An agent's composer names it and offers its / commands.
  await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { setMeta(m: object): void } | undefined } } } }).aosHost.plugin.terminalPool;
    p.get(p.selectedId() ?? "")?.setMeta({ host: "claude" });
  });
  await C().locator(".aos-tl-row.aos-term-tab-active").click();
  await expect(C().locator(".aos-tc-input")).toHaveAttribute("placeholder", "Write to Claude Code…");
});

test("⌘F finds in the selected terminal: a count, Enter and ⇧Enter step, Escape closes and clears; ⌘F reopens", async () => {
  const { win } = app();
  await openTab(win, "term");
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  // Two matches in the output and none in the typed line: only the shell works out $((6*7)).
  await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { write(d: string): void } | undefined } } } }).aosHost.plugin.terminalPool;
    p.get(p.selectedId() ?? "")?.write("echo find-$((6*7))-me; echo find-$((6*7))-me\r");
  });
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("find-42-me");
  const bar = C().locator(".aos-tf");
  const count = bar.locator(".aos-tf-count");
  await expect(bar).toBeHidden();
  expect(await command(win, "agentic-os:term-find")).toBe(true);
  await expect(bar.locator(".aos-tf-input")).toBeFocused();
  await bar.locator(".aos-tf-input").fill("find-42-me");
  await expect(count).toHaveText("1 of 2");
  await expect(C().locator(".xterm-find-active-result-decoration")).toHaveCount(1);
  await win.keyboard.press("Enter");
  await expect(count).toHaveText("2 of 2");
  await win.keyboard.press("Shift+Enter");
  await expect(count).toHaveText("1 of 2");
  await bar.locator(".aos-tf-input").fill("zzz-nowhere");
  await expect(count).toHaveText("No results");
  await bar.locator(".aos-tf-input").fill("find-42-me");
  await expect(count).toHaveText("1 of 2");
  // Escape closes the bar, clears the highlights and gives the keys back to the terminal.
  await win.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect(C().locator(".xterm-find-result-decoration")).toHaveCount(0);
  await expect(C().locator(".aos-term-xterm:visible .xterm-helper-textarea")).toBeFocused();
  // The real key, from inside the terminal: the bar comes back with the last words selected and found again.
  await win.keyboard.press("Meta+f");
  await expect(bar.locator(".aos-tf-input")).toBeFocused();
  await expect(count).toHaveText("1 of 2");
  await win.keyboard.press("Escape");
  await expect(bar).toBeHidden();
});

test("the New menu stays open while you switch its host, by Tab or by a click, and keeps the typing in its filter", async () => {
  const { win } = app();
  await openTab(win, "term");
  const pop = C().locator(".aos-ntm-pop");
  const active = () => C().locator(".aos-ntm-pop .aos-ntm-host.is-active");
  await C().locator(".aos-ntm-caret").click();
  await expect(pop).toHaveCount(1);
  await expect(C().locator(".aos-ntm-filter")).toBeFocused();
  const first = (await active().innerText()).trim();
  await win.keyboard.press("Tab");
  await expect(pop).toHaveCount(1);
  await expect(active()).not.toHaveText(first);
  await expect(C().locator(".aos-ntm-filter")).toBeFocused();
  await C().locator(".aos-ntm-pop .aos-ntm-host", { hasText: first }).click();
  await expect(pop).toHaveCount(1);
  await expect(active()).toHaveText(first);
  await win.keyboard.type("harbor");
  await expect(C().locator(".aos-ntm-filter")).toHaveValue("harbor");
  await win.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});

test("⇧⏎ in a Claude Code terminal sends one line feed and nothing after it (T12)", async () => {
  const { win } = app();
  await openTab(win, "term");
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  // A shell stands in for Claude Code (the fixture's agent stubs exit at once): it prints the raw bytes it reads. Its
  // prompt comes first, since a shell drops what was typed before it.
  type S = { setMeta(m: object): void; write(d: string): void; getScrollback(): string };
  const sel = () => win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): S | undefined } } } }).aosHost.plugin.terminalPool;
    return p.get(p.selectedId() ?? "")?.getScrollback() ?? "";
  });
  await expect.poll(async () => /[%$#] ?$/.test((await sel()).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trimEnd()), { timeout: 10_000 }).toBe(true);
  await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): S | undefined } } } }).aosHost.plugin.terminalPool;
    const s = p.get(p.selectedId() ?? "");
    s?.setMeta({ host: "claude" });
    s?.write("stty raw -echo; printf 'REA%sDY'; dd bs=1 count=2 2>/dev/null | od -An -c; stty sane\r");
  });
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toContain("READY");
  await win.evaluate(() => (document.querySelector(".aos-term-xterm:not([style*=none]) .xterm-helper-textarea") as HTMLElement | null)?.focus());
  await win.keyboard.press("Shift+Enter");
  await win.keyboard.type("x");
  // od prints the two bytes: a line feed, then the x. Before the fix the keypress after it sent a carriage return.
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).toMatch(/\\n\s+x/);
  expect(await terminalText(win)).not.toMatch(/\\n\s+\\r/);
});

test("links an app prints in a terminal open: an agenticos:// note in the Workbench, a tab link on its tab (T12)", async () => {
  const { win } = app();
  await openTab(win, "term");
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  const scrollback = () => win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { getScrollback(): string } | undefined } } } }).aosHost.plugin.terminalPool;
    return p.get(p.selectedId() ?? "")?.getScrollback() ?? "";
  });
  await expect.poll(async () => /[%$#] ?$/.test((await scrollback()).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trimEnd()), { timeout: 10_000 }).toBe(true);
  // OSC 8 links, as Claude Code's status line prints them (the labels are put together by printf, so only the output
  // carries them whole).
  await win.evaluate(() => {
    const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { write(d: string): void } | undefined } } } }).aosHost.plugin.terminalPool;
    p.get(p.selectedId() ?? "")?.write("printf '\\033]8;;agenticos://note?file=workspaces/harbor-map/PLAN.md\\007OPEN-%s\\033]8;;\\007\\n' PLAN; printf '\\033]8;;agenticos://workbench?tab=todo\\007OPEN-%s\\033]8;;\\007\\n' TODO\r");
  });
  const label = (t: string) => C().locator(".aos-term-xterm:visible .xterm-rows span", { hasText: t }).last();
  await expect(label("OPEN-PLAN")).toBeVisible({ timeout: 10_000 });
  await label("OPEN-PLAN").hover();
  await label("OPEN-PLAN").click();
  await expect(notePath(win)).toContainText("PLAN.md", { timeout: 10_000 });
  await closeNotes(win);
  await openTab(win, "term");
  await label("OPEN-TODO").hover();
  await label("OPEN-TODO").click();
  await expect(win.locator(".aos-wb-railbtn[data-tab='todo']")).toHaveClass(/is-active/, { timeout: 10_000 });
});

test("opening Code defers nothing that takes the focus: the list filter keeps its typing, however late the page's frames run", async () => {
  const { win } = app();
  await openTab(win, "pulse");
  // fill() is a focus and a select-all, then the typing. Hold this page's animation frames, as a loaded runner can, and
  // run them in between: a terminal focus the panel deferred to one would take the typing into the shell.
  await win.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const held: FrameRequestCallback[] = [];
    w.__heldRaf = held;
    w.__raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => { held.push(cb); return 0; };
  });
  const filter = C().locator(".aos-tl-filter");
  try {
    await openTab(win, "term");
    await filter.focus();
    await filter.selectText();
    await win.evaluate(() => { for (const f of ((window as unknown as Record<string, unknown>).__heldRaf as FrameRequestCallback[]).splice(0)) f(performance.now()); });
    await win.keyboard.insertText("zzz-nothing");
    await expect(filter).toHaveValue("zzz-nothing");
  } finally {
    await win.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      window.requestAnimationFrame = w.__raf as typeof window.requestAnimationFrame;
      for (const f of (w.__heldRaf as FrameRequestCallback[]).splice(0)) f(performance.now());
      delete w.__raf;
      delete w.__heldRaf;
    });
  }
  await expect(C().locator(".aos-tl-empty")).toHaveText("No session matches.");
  await filter.fill("");
});

test("Code fits its pane: no page scroll at 1480×920 or 960×600, the composer whole and twice its 1.5.0 height; a wheel scrolls the terminal only (spec 2026-10-09 D8, D9)", async () => {
  const h = app();
  const { win } = h;
  await openTab(win, "term");
  expect(await command(win, "agentic-os:new-terminal-shell")).toBe(true);
  await expect(C().locator(".aos-tc-input")).toBeVisible();
  // Every element from the content area up that overflows or has scrolled: 1.5.0 had two (.aos-wb-body and
  // .view-content, 50px each), with the composer's foot under the window's edge.
  const layout = () => win.evaluate(() => {
    const c = document.querySelector(".aos-wb-content") as HTMLElement;
    const scrolled: string[] = [];
    for (let el: HTMLElement | null = c; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1 || el.scrollTop > 0) scrolled.push(`${el.className} ${el.scrollHeight}>${el.clientHeight}`);
    }
    const rect = (sel: string) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
    return {
      scrolled, bottom: rect(".aos-wb-content").bottom, box: rect(".aos-tc-box"), foot: rect(".aos-tl-foot").bottom, term: rect(".aos-term-body").height,
      font: getComputedStyle(document.querySelector(".aos-tc-input") as HTMLElement).fontSize,
    };
  });
  try {
    for (const size of [{ width: 1480, height: 920 }, { width: 960, height: 600 }]) {
      await resizeHud(h.app, size);
      await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(size.width);
      await expect.poll(async () => (await layout()).scrolled).toEqual([]);
      const l = await layout();
      expect(l.box.bottom).toBeLessThanOrEqual(l.bottom);
      expect(l.foot).toBeLessThanOrEqual(l.bottom);
      expect(l.box.height).toBeGreaterThanOrEqual(2 * 96);
      expect(l.font).toBe("15px");
      expect(l.term).toBeGreaterThan(200);
    }
    // Scrollback in the terminal: the wheel moves xterm's viewport, and the page stays put. Type only once xterm fits the
    // 960×600 pane: its refit runs from a ResizeObserver, in a frame a loaded runner can deliver after the typing, and a
    // refit that lands while seq's output is on its way leaves zsh's end-of-line mark, sized for the old width, on a row
    // of its own ("400", "%", the prompt).
    const fitted = () => C().locator(".aos-term-xterm:visible").evaluate((el) => {
      const screen = el.querySelector(".xterm-screen");
      if (!screen) return false;
      const box = el.getBoundingClientRect();
      const s = screen.getBoundingClientRect();
      return s.width <= box.width && s.height <= box.height;
    });
    await expect.poll(fitted).toBe(true);
    await win.evaluate(() => {
      const p = (window as unknown as { aosHost: { plugin: { terminalPool: { selectedId(): string | null; get(id: string): { write(d: string): void } | undefined } } } }).aosHost.plugin.terminalPool;
      p.get(p.selectedId() ?? "")?.write("seq 1 400\r");
    });
    // Wait for what xterm drew, not the bytes: seq's last line and the next prompt (the echoed command cannot match),
    // then for the viewport to read the same twice, so the rest of the output cannot scroll it after `before` is read.
    const rows = () => C().locator(".aos-term-xterm:visible .xterm-rows").evaluate((el) => Array.from(el.children).map((r) => (r.textContent ?? "").trimEnd()).join("\n"));
    await expect.poll(rows, { timeout: 10_000 }).toMatch(/^400\nfixture %$/m);
    const viewport = C().locator(".aos-term-xterm:visible .xterm-viewport");
    let before = -1;
    await expect.poll(async () => { const t = await viewport.evaluate((el) => el.scrollTop); const same = t > 0 && t === before; before = t; return same; }).toBe(true);
    const body = (await C().locator(".aos-term-body").boundingBox())!;
    await win.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
    await win.mouse.wheel(0, -600);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThan(before);
    expect((await layout()).scrolled).toEqual([]);
  } finally {
    await resizeHud(h.app, { width: 1480, height: 920 });
  }
});
